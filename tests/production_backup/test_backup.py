import hashlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tarfile
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'scripts/production_backup'))
import main  # noqa: E402
import r2  # noqa: E402
from common import IMAGE, PROJECT, Failure, checksums, db_environment, extract_archive, run, verify_checksums  # noqa: E402
from r2_fixture import local_r2  # noqa: E402

STAMP = '2026-11-08T00:00:00+00:00'
CIPHERTEXT = r2.AGE_MAGIC + b'synthetic bytes for the R2 transport contract'
TOC = """; archive listing
1; 1262 5 DATABASE - postgres fixture_admin
2; 0 0 DATABASE PROPERTIES - postgres fixture_admin
3; 0 0 ACL - DATABASE postgres fixture_admin
4; 0 0 COMMENT - DATABASE postgres fixture_admin
5; 1259 10 TABLE public customers fixture_admin
6; 0 0 ACL public TABLE customers fixture_admin
"""


class BackupTest(unittest.TestCase):
    def setUp(self):
        self.scratch = TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.ciphertext = self.root / 'test.age'
        self.ciphertext.write_bytes(CIPHERTEXT)
        self.receipt = dict(format=1, scope='db-only', export_status='complete', source='synthetic',
                            project_ref='synthetic-fixture', image=IMAGE,
                            snapshot_utc=STAMP, recipient_sha256='0' * 64, key=r2.new_key('synthetic'),
                            bytes=len(CIPHERTEXT), sha256=hashlib.sha256(CIPHERTEXT).hexdigest())
        self.r2 = r2.R2('a' * 32, 'b' * 64)
        self.object_path = f"/{r2.BUCKET}/{self.receipt['key']}"

    def test_production_uri_strict_and_env_does_not_inherit_libpq_overrides(self):
        ca = self.root / 'test-ca.pem'
        ca.touch()
        direct = f'postgresql://postgres:fake@db.{PROJECT}.supabase.co:5432/postgres?sslmode=disable'
        with patch.dict(os.environ, {'PGHOSTADDR': '192.0.2.1', 'PGSERVICE': 'invalid'}):
            env = db_environment(direct, ca)
        self.assertEqual(env['PGSSLMODE'], 'verify-full')
        self.assertIn('default_transaction_read_only=on', env['PGOPTIONS'])
        self.assertIn('row_security=off', env['PGOPTIONS'])
        self.assertNotIn('PGHOSTADDR', env)
        self.assertNotIn('PGSERVICE', env)
        with self.assertRaisesRegex(Failure, 'INVALID_PRODUCTION_DB_TARGET'):
            db_environment(direct.replace(':5432/', ':6543/'), ca)
        with self.assertRaisesRegex(Failure, 'INVALID_PRODUCTION_DB_TARGET'):
            db_environment(direct.replace(PROJECT, 'wrong'), ca)

    def test_failed_export_never_creates_receipt_or_sealed_bundle(self):
        def partial_export(payload, *_):
            (payload / 'partial.dump').write_bytes(b'synthetic partial')
            raise Failure('SEQUENCE_DRIFT', 'BLOCKED')

        with patch.object(main, 'private_scratch', return_value=self.root), \
                patch.object(main, 'run'), patch.object(main, 'export_database', side_effect=partial_export):
            with self.assertRaisesRegex(Failure, 'SEQUENCE_DRIFT'):
                main.export_archive(self.root, 'synthetic', 'age1' + 'a' * 58, 'age', None, None, 'test')
        self.assertEqual(list(self.root.iterdir()), [self.ciphertext])

    def test_database_toc_only_selects_database_definition_properties_and_acl(self):
        selected = main.database_toc(TOC)
        self.assertEqual(selected.splitlines(), TOC.splitlines()[1:5])
        with self.assertRaisesRegex(Failure, 'SCHEMA_ARCHIVE_DATABASE_TOC_MISSING'):
            main.database_toc(TOC.replace('postgres fixture_admin', 'otherdb fixture_admin'))

    def test_production_and_synthetic_prefixes_cannot_mix(self):
        for replacement in (r2.new_key('production'), '../file', self.receipt['key'].replace('17.11', '17x11')):
            with self.subTest(key=replacement), self.assertRaisesRegex(Failure, 'INVALID_RECEIPT'):
                r2.validate_receipt({**self.receipt, 'key': replacement})

    def test_publish_readback_independent_download_and_no_overwrite(self):
        with local_r2() as service:
            self.assertEqual(self.r2.publish(self.ciphertext, self.receipt), 'PUBLISHED')
            output = self.root / 'download.age'
            self.r2.readback(self.receipt, output)
            self.assertEqual(output.read_bytes(), CIPHERTEXT)
            with self.assertRaises(FileExistsError):
                self.r2.readback(self.receipt, output)
            self.assertEqual(output.read_bytes(), CIPHERTEXT)
            self.assertEqual(self.r2.publish(self.ciphertext, self.receipt), 'RECONCILED')
            self.assertEqual(service.objects[self.object_path], CIPHERTEXT)
            self.assertEqual([method for method, _ in service.requests], ['PUT', 'GET', 'GET', 'PUT', 'GET'])

    def test_lost_put_after_commit_verifies_without_retry(self):
        with local_r2() as service:
            service.drop_after_commit = True
            self.assertEqual(self.r2.publish(self.ciphertext, self.receipt), 'RECONCILED')
            self.assertEqual(service.requests, [('PUT', self.object_path), ('GET', self.object_path)])

    def test_lost_put_without_commit_blocks_without_retry(self):
        with local_r2() as service:
            service.drop_before_commit = True
            with self.assertRaisesRegex(Failure, 'R2_PUT_OUTCOME_UNCERTAIN_OBJECT_NOT_VISIBLE'):
                self.r2.publish(self.ciphertext, self.receipt)
            self.assertEqual(service.requests, [('PUT', self.object_path), ('GET', self.object_path)])
            self.assertFalse(service.objects)

    def test_existing_object_with_wrong_hash_is_never_replaced(self):
        with local_r2() as service:
            service.objects[self.object_path] = b'X' * len(CIPHERTEXT)
            with self.assertRaisesRegex(Failure, 'R2_OBJECT_SHA256_MISMATCH'):
                self.r2.publish(self.ciphertext, self.receipt)
            self.assertEqual(service.objects[self.object_path], b'X' * len(CIPHERTEXT))
            self.assertEqual(service.requests, [('PUT', self.object_path), ('GET', self.object_path)])

    def test_wrong_local_hash_never_sends_request(self):
        with local_r2() as service:
            with self.assertRaisesRegex(Failure, 'LOCAL_CIPHERTEXT_SHA256_MISMATCH'):
                self.r2.publish(self.ciphertext, {**self.receipt, 'sha256': '1' * 64})
            self.assertFalse(service.requests)

    def test_incomplete_receipt_never_sends_request(self):
        with local_r2() as service:
            with self.assertRaisesRegex(Failure, 'INVALID_RECEIPT'):
                self.r2.publish(self.ciphertext, {**self.receipt, 'export_status': 'partial'})
            self.assertFalse(service.requests)

    def test_lifecycle_absence_is_not_pass_and_download_is_cleaned(self):
        with local_r2() as service:
            service.lifecycle = False
            service.objects[self.object_path] = CIPHERTEXT
            output = self.root / 'download.age'
            with self.assertRaisesRegex(Failure, 'R2_LIFECYCLE_NOT_VERIFIED'):
                self.r2.readback(self.receipt, output)
            self.assertFalse(output.exists())

    def test_archive_checksums_and_safe_extraction(self):
        bundle = self.root / 'production-backup'
        bundle.mkdir()
        (bundle / 'data').write_bytes(b'synthetic plain')
        checksums(bundle)
        archive = self.root / 'bundle.tgz'
        with tarfile.open(archive, 'w:gz') as tar:
            tar.add(bundle, arcname=bundle.name)
        restored = extract_archive(archive, self.root / 'safe')
        self.assertEqual((restored / 'data').read_bytes(), b'synthetic plain')
        (restored / 'data').write_bytes(b'tampered')
        with self.assertRaisesRegex(Failure, 'CHECKSUM_MISMATCH'):
            verify_checksums(restored)

    def test_tar_traversal_and_symlinks_rejected(self):
        for index, (name, kind) in enumerate([('production-backup/../escape', tarfile.REGTYPE),
                                               ('production-backup/unsafe', tarfile.SYMTYPE)]):
            archive = self.root / f'bad-{index}.tgz'
            with tarfile.open(archive, 'w:gz') as tar:
                member = tarfile.TarInfo(name)
                member.type = kind
                member.linkname = '/tmp/escape'
                tar.addfile(member, io.BytesIO())
            with self.subTest(name=name), self.assertRaises(Failure):
                extract_archive(archive, self.root / f'extract-{index}')

    def test_tool_error_does_not_expose_stderr(self):
        with patch('common.subprocess.run', return_value=subprocess.CompletedProcess(
                [], 1, b'', b'password=synthetic-secret Authorization: synthetic-signature')):
            with self.assertRaisesRegex(Failure, '^PROCESS_EXIT_NONZERO$'):
                run(['fixture-tool'])

    def test_workflows_allow_synthetic_only_and_never_publish_artifacts(self):
        directory = REPO / '.github/workflows'
        manual = (directory / 'supabase-production-backup.yml').read_text()
        ci = (directory / 'supabase-backup-ci.yml').read_text()
        self.assertIn('workflow_dispatch:', manual)
        self.assertIn('uses: ./.github/workflows/supabase-backup-ci.yml', manual)
        self.assertIn('workflow_call:', ci)
        self.assertIn('run: python tests/production_backup/fixture_roundtrip.py', ci)
        for forbidden in ('upload-artifact', 'download-artifact', 'secrets.', 'secrets: inherit',
                          'SUPABASE_DB_URL', '--live-r2', 'db push', 'apply_migration'):
            self.assertNotIn(forbidden, manual + ci)
        runner = (REPO / 'scripts/production_backup/main.py').read_text()
        self.assertIn('GITHUB_ACTIONS_OPERATION_DISABLED', runner)
        self.assertIn("'--network', 'none'", runner)
        self.assertNotIn("'--publish'", runner)


if __name__ == '__main__':
    unittest.main()
