import io
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import yaml

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'scripts/production_backup'))
from common import (Failure, PROJECT, checksums, db_environment, extract_archive,  # noqa: E402
                    load_json, object_path, run, verify_checksums, write_json)  # noqa: E402
import main  # noqa: E402
import storage  # noqa: E402


class BackupSecurityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def assert_failure(self, callable_):
        with self.assertRaises((Failure, ValueError, FileNotFoundError)):
            callable_()

    def test_production_target_and_tls_are_pinned(self):
        env = db_environment(f'postgresql://postgres.{PROJECT}:fixture@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=disable&host=evil.test')
        self.assertEqual(env['PGHOST'], 'aws-0-ap-southeast-1.pooler.supabase.com')
        self.assertEqual(env['PGSSLMODE'], 'verify-full')
        self.assertIn('default_transaction_read_only=on', env['PGOPTIONS'])
        for value in ['postgresql://postgres:pw@evil.test/postgres',
                      'postgresql://postgres.other:pw@aws-0-ap-southeast-1.pooler.supabase.com/postgres',
                      f'postgresql://postgres:pw@db.{PROJECT}.supabase.co:6543/postgres',
                      f'postgresql://postgres:pw@db.{PROJECT}.supabase.co/notpostgres']:
            self.assert_failure(lambda: db_environment(value))

    def test_paths_reject_traversal_and_control_characters(self):
        for value in ['../x', '/abs', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'a\nx', '']:
            self.assert_failure(lambda: object_path(value))
        self.assertEqual(str(object_path('bucket/công-ty/recording.mp4')), 'bucket/công-ty/recording.mp4')

    def test_checksum_exact_set_and_corruption(self):
        (self.root / 'payload').write_bytes(b'synthetic')
        checksums(self.root)
        verify_checksums(self.root)
        (self.root / 'extra').write_text('unexpected')
        self.assert_failure(lambda: verify_checksums(self.root))
        (self.root / 'extra').unlink()
        (self.root / 'payload').write_bytes(b'corrupted')
        self.assert_failure(lambda: verify_checksums(self.root))

    def test_duplicate_checksum_and_symlink_rejected(self):
        (self.root / 'payload').write_text('synthetic')
        checksums(self.root)
        p = self.root / 'checksums.sha256'
        p.write_text(p.read_text() * 2)
        self.assert_failure(lambda: verify_checksums(self.root))
        (self.root / 'link').symlink_to(self.root / 'payload')
        self.assert_failure(lambda: checksums(self.root))

    def test_archive_traversal_links_and_duplicate_members_rejected(self):
        for case in ['traversal','symlink','duplicate']:
            archive = self.root / (case + '.tgz')
            with tarfile.open(archive,'w:gz') as t:
                item = tarfile.TarInfo('production-backup/../escape' if case=='traversal' else 'production-backup/x')
                if case == 'symlink':
                    item.type, item.linkname = tarfile.SYMTYPE, '/etc/passwd'
                t.addfile(item, io.BytesIO())
                if case == 'duplicate':
                    t.addfile(item, io.BytesIO())
            self.assert_failure(lambda: extract_archive(archive,self.root / 'extracted'))

    def test_duplicate_json_keys_rejected(self):
        p = self.root / 'bad.json'
        p.write_text('{"status":"PASS","status":"FAIL"}')
        self.assert_failure(lambda: load_json(p))

    def test_failed_process_redacts_output(self):
        with self.assertRaises(Failure) as context:
            run([sys.executable,'-c','import sys; print("synthetic-private-value",file=sys.stderr);sys.exit(2)'])
        self.assertNotIn('synthetic-private-value',str(context.exception))

    def test_missing_secrets_reports_blocked_without_export(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(Failure):
                main.backup(self.root)
        report = load_json(self.root / 'publish/backup-report.json')
        self.assertEqual(report['status'], 'BLOCKED')
        self.assertFalse(report['database_export_complete'])
        self.assertFalse((self.root / 'production-backup/database/schema.dump').exists())

    def test_restore_rejects_any_production_credentials(self):
        with patch.dict(os.environ, {'SUPABASE_DB_URL':'synthetic-forbidden'}, clear=True):
            with patch.object(main,'run',return_value=b''):
                with self.assertRaises(Failure):
                    main.restore(self.root)
        report = load_json(self.root / 'restore-publish/restore-report.json')
        self.assertEqual(report['error_code'],'PRODUCTION_CREDENTIAL_PRESENT_IN_RESTORE')

    def test_storage_pagination_includes_private_nested_objects(self):
        client = storage.Storage('synthetic-token')
        seen = []
        def request(path, payload):
            seen.append((payload['prefix'],payload['offset']))
            if payload['prefix'] == '':
                return [{'id':None,'name':'company'}]
            if payload['offset'] == 0:
                return [{'id':'1','name':'a'},{'id':'2','name':'b'}]
            return [{'id':'3','name':'c'}]
        with patch.object(storage,'PAGE_SIZE',2),patch.object(client,'request',side_effect=request):
            result = client.enumerate([{'id':'private-bucket','public':False}])
        self.assertEqual(len(result),3)
        self.assertIn(('company/',2),seen)
        self.assertIn(('private-bucket','company/c'),result)

    def test_storage_duplicate_page_and_unsafe_names_fail(self):
        client = storage.Storage('synthetic')
        for page in [[{'id':'1','name':'a'},{'id':'1','name':'a'}],[{'id':'x','name':'../evil'}]]:
            with patch.object(client,'request',return_value=page):
                self.assert_failure(lambda: client.enumerate([{'id':'private'}]))

    def test_storage_one_failed_download_prevents_success(self):
        expected = {('b','a'):{'id':'1','name':'a','bucket_id':'b','updated_at':'2026-01-01T00:00:00Z','metadata':{'size':1}}}
        client = storage.Storage('synthetic')
        with patch.object(client,'enumerate',return_value=expected),patch.object(client,'request',side_effect=Failure('RETRY_EXHAUSTED','PARTIAL')):
            with self.assertRaises(Failure):
                storage.export_storage(self.root,[{'id':'b'}],expected,client)
        self.assertEqual(load_json(self.root/'objects-manifest.json')[0]['status'],'PARTIAL')

    def test_storage_timestamp_normalization_and_mutation_detection(self):
        a = {'id':'1','updated_at':'2026-01-01 00:00:00+00','metadata':{'size':3,'eTag':'one'}}
        b = {**a,'updated_at':'2026-01-01T00:00:00.000Z'}
        self.assertTrue(storage.same_objects({('b','n'):a},{('b','n'):b}))
        b['metadata'] = {'size':3,'eTag':'changed'}
        self.assertFalse(storage.same_objects({('b','n'):a},{('b','n'):b}))

    def test_publish_summary_does_not_include_payload(self):
        redacted = main.summary({'status':'FAIL','raw_sql':'private','files':[{'path':'private'}],
                                 'error_code':'FIXED_CODE','counts':{'customers':1}})
        self.assertNotIn('raw_sql',redacted)
        self.assertNotIn('files',redacted)

    @unittest.skipUnless(shutil.which('age'),'age required for real encryption test')
    def test_real_age_owner_decryption_wrong_key_and_tamper(self):
        key = self.root / 'owner.txt'
        run(['age-keygen','--output',str(key)])
        recipient = run(['age-keygen','--y',str(key)]).decode().strip()
        payload = self.root/'production-backup'
        payload.mkdir()
        (self.root/'publish').mkdir()
        (payload/'private.txt').write_text('synthetic-private-content')
        write_json(payload/'backup-report.json',main.base_report())
        with patch.dict(os.environ,{'BACKUP_AGE_RECIPIENT':recipient}):
            main.seal(self.root)
        encrypted = self.root/'publish/production-backup.tar.gz.age'
        verify_checksums(self.root/'publish')
        out = self.root/'owner-decrypted.tgz'
        run(['age','-d','-i',str(key),'-o',str(out),str(encrypted)])
        restored = extract_archive(out,self.root/'owner-extracted')
        self.assertEqual((restored/'private.txt').read_text(),'synthetic-private-content')
        self.assertFalse((self.root/'keys/ephemeral-test-identity.txt').exists())
        wrong = self.root/'wrong.txt'
        run(['age-keygen','-o',str(wrong)])
        self.assert_failure(lambda: run(['age','-d','-i',str(wrong),str(encrypted)]))
        encrypted.write_bytes(encrypted.read_bytes()[:-1] + b'X')
        self.assert_failure(lambda: verify_checksums(self.root/'publish'))


class WorkflowContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = yaml.load((REPO/'.github/workflows/supabase-production-backup.yml').read_text(),Loader=yaml.BaseLoader)

    def test_only_manual_main_and_single_global_lock(self):
        self.assertEqual(set(self.workflow['on']),{'workflow_dispatch'})
        self.assertEqual(self.workflow['concurrency']['cancel-in-progress'],'false')
        for job in self.workflow['jobs'].values():
            self.assertIn("github.ref == 'refs/heads/main'",job['if'])
            self.assertIn('timeout-minutes',job)
            self.assertEqual(job['runs-on'],'ubuntu-24.04')

    def test_restore_secret_isolation_and_no_deploy(self):
        restore = self.workflow['jobs']['restore-rehearsal']
        text = json.dumps(restore)
        self.assertNotIn('secrets.SUPABASE',text)
        self.assertEqual(restore['environment'],'backup-rehearsal')
        self.assertIn('secrets.BACKUP_AGE_IDENTITY',text)
        self.assertEqual(self.workflow['permissions'],{'contents':'read'})
        self.assertEqual(restore['permissions'],{'contents':'read','actions':'read'})
        for value in ['db push','apply_migration','render deploy','pull_request_target','secrets: inherit']:
            self.assertNotIn(value,(REPO/'.github/workflows/supabase-production-backup.yml').read_text())

    def test_actions_pinned_cleanup_and_upload_scope(self):
        for job in self.workflow['jobs'].values():
            last = job['steps'][-1]
            self.assertEqual(last['if'],'always()')
            self.assertIn('cleanup.py',last['run'])
            for step in job['steps']:
                if 'uses' in step:
                    self.assertRegex(step['uses'],r'@[0-9a-f]{40}$')
                if 'upload-artifact@' in step.get('uses',''):
                    self.assertIn('publish',step['with']['path'])
                    self.assertNotIn('production-backup/',step['with']['path'])
                    self.assertEqual(step['with']['retention-days'],'14')

    def test_no_shell_execution_or_production_rehearsal_ports(self):
        text = (REPO/'scripts/production_backup/main.py').read_text()
        self.assertNotIn('shell=True',text)
        self.assertIn("'--network','none'",text)
        self.assertNotIn("'--publish'",text)
        self.assertNotIn('DROP ',text)
        self.assertNotIn('ALTER SYSTEM',text)


if __name__ == '__main__':
    unittest.main()
