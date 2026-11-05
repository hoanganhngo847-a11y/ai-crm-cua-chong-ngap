#!/usr/bin/env python3
"""Manual production backup and network-isolated restore. No production mutations."""
import argparse
import json
import os
import re
import tarfile
import time
import urllib.request

from common import (ADMIN, IMAGE, LIMITATIONS, PROJECT, TENANT, Failure, checksums,
                    db_environment, digest, extract_archive, load_json, now, require,
                    run, verify_checksums, workspace, write_json)
from inventory import ident, inventory, role_inventory
from storage import Storage, export_storage, same_objects, verify_storage


def source_query(conn):
    def query(sql):
        return conn.execute(sql).fetchall()
    return query


def connect(env):
    import psycopg
    from psycopg.rows import dict_row
    try:
        return psycopg.connect(host=env['PGHOST'], port=env['PGPORT'], user=env['PGUSER'],
            password=env['PGPASSWORD'], dbname=env['PGDATABASE'], sslmode=env['PGSSLMODE'],
            sslrootcert=env['PGSSLROOTCERT'], connect_timeout=20, options=env['PGOPTIONS'],
            application_name='crm-production-backup-readonly', row_factory=dict_row)
    except psycopg.OperationalError:
        raise Failure('DATABASE_CONNECTION_OR_CREDENTIAL_UNAVAILABLE','BLOCKED') from None


def docker_client(command, args, root, env):
    names = ['PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE','PGSSLMODE',
             'PGSSLROOTCERT','PGCONNECT_TIMEOUT','PGOPTIONS','PGAPPNAME']
    cmd = ['docker','run','--rm','--network','host','--user',f'{os.getuid()}:{os.getgid()}',
           '--volume',f'{root}:/backup']
    for name in names:
        cmd += ['--env', name]
    cmd += ['--entrypoint', command, IMAGE, *args]
    return run(cmd, env=env, timeout=2400)


def snapshot_storage(query):
    buckets = query('SELECT to_jsonb(b) AS value FROM storage.buckets b ORDER BY id')
    objects, last = {}, None
    while True:
        where = '' if last is None else "WHERE (bucket_id,name,id::text) > (" + ','.join(
            "'" + s.replace("'", "''") + "'" for s in last) + ')'
        # Keyset pagination stays inside the same exported snapshot.
        page = query(f"""SELECT id::text,bucket_id,name,metadata,version,updated_at::text
          FROM storage.objects {where} ORDER BY bucket_id,name,id::text LIMIT 1000""")
        for item in page:
            key = (item['bucket_id'], item['name'])
            if key in objects:
                raise Failure('DUPLICATE_STORAGE_DATABASE_PATH', 'PARTIAL')
            objects[key] = item
        if len(page) < 1000:
            break
        last = tuple(page[-1][key] for key in ('bucket_id','name','id'))
    return [b['value'] for b in buckets], objects


def summary(report):
    # Only aggregate facts and fixed codes leave the encrypted archive in plaintext.
    allowed = ['status','project_ref','tenant','started_at_utc','finished_at_utc','postgres_version',
               'database_export_complete','snapshot_consistency','counts','storage','encryption',
               'restore_status','error_code','missing_components','artifact_sha256','retention_days']
    return {key: report[key] for key in allowed if key in report}


def base_report():
    return {'status':'BLOCKED','project_ref':PROJECT,'tenant':TENANT,'started_at_utc':now(),
            'database_export_complete':False,'restore_status':'BLOCKED','encryption':'NOT_RUN',
            'missing_components':LIMITATIONS,'retention_days':14}


def backup(root):
    payload = root / 'production-backup'
    for name in ['database','storage/files','configuration','verification','edge-functions']:
        (payload / name).mkdir(parents=True, exist_ok=True, mode=0o700)
    report = base_report()
    try:
        require(['SUPABASE_DB_URL','SUPABASE_SERVICE_ROLE_KEY','BACKUP_AGE_RECIPIENT'])
        env = db_environment(os.environ['SUPABASE_DB_URL'])
        # Reject invalid recipient before any customer bytes are exported.
        run(['age','--encrypt','--recipient',os.environ['BACKUP_AGE_RECIPIENT']], input_bytes=b'preflight')
        run(['docker','pull',IMAGE], timeout=600)
        version = docker_client('pg_dump',['--version'],root,env).decode()
        if not re.search(r'\b17\.11\b',version):
            raise Failure('PG_DUMP_VERSION_NOT_17_11','BLOCKED')
        import psycopg
        with connect(env) as conn:
            conn.isolation_level = psycopg.IsolationLevel.REPEATABLE_READ
            conn.read_only = True
            conn.execute("SET LOCAL search_path = pg_catalog")
            conn.execute("SET LOCAL TIME ZONE 'UTC'")
            conn.execute("SET LOCAL idle_in_transaction_session_timeout = '45min'")
            if conn.execute('SHOW transaction_read_only').fetchone()['transaction_read_only'] != 'on':
                raise Failure('SOURCE_NOT_READ_ONLY','BLOCKED')
            query = source_query(conn)
            snapshot = query('SELECT pg_export_snapshot() AS snapshot')[0]['snapshot']
            baseline = inventory(query)
            if baseline['postgres']['version_num'] != 170011:
                raise Failure('SOURCE_VERSION_NOT_17_11','BLOCKED')
            if any(x['kind'] in ('f','m') for x in baseline['catalog']['relations']):
                raise Failure('FOREIGN_OR_MATERIALIZED_RELATION_REQUIRES_REVIEW','PARTIAL')
            roles = role_inventory(query)
            if any(r['rolname'] == ADMIN for r in roles['roles']):
                raise Failure('RESTORE_BOOTSTRAP_ROLE_COLLISION','BLOCKED')
            write_json(payload/'configuration/baseline.json',baseline)
            write_json(payload/'configuration/roles.json',roles)
            write_json(payload/'configuration/extensions.json',baseline['extensions'])
            counts = {f"{x['schema']}.{x['name']}":x['count'] for x in baseline['tables']}
            required = ['supabase_migrations.schema_migrations','public.customers',
                        'public.interactions','private.customer_private_contacts']
            if any(name not in counts for name in required):
                raise Failure('CRM_REQUIRED_RELATION_MISSING','BLOCKED')
            report['postgres_version'] = baseline['postgres']['version']
            report['counts'] = dict(zip(['migrations','customers','interactions','private_contacts'],
                                       [counts[name] for name in required]))
            report['counts']['tenant'] = {
                'customers':baseline['tenant_counts']['public.customers'],
                'interactions':baseline['tenant_counts']['public.interactions'],
                'private_contacts':baseline['tenant_counts']['private.customer_private_contacts']}
            buckets, objects = snapshot_storage(query)
            report['storage'] = {'buckets':len(buckets),'objects':len(objects),
                                 'declared_bytes':sum((x.get('metadata') or {}).get('size',0) for x in objects.values()),
                                 'files_succeeded':0,'files_failed':0,'files_unattempted':len(objects),
                                 'downloaded_bytes':0}
            write_json(payload/'storage/database-objects.json',list(objects.values()))
            docker_client('pg_dumpall',['--roles-only','--no-role-passwords','--no-password',
                          '--file=/backup/production-backup/database/roles.sql'],root,env)
            common = ['--no-password','--lock-wait-timeout=10s','--format=custom','--snapshot='+snapshot]
            docker_client('pg_dump',[*common,'--schema-only',
                          '--file=/backup/production-backup/database/schema.dump'],root,env)
            tables = [f"{ident(t['schema'])}.{ident(t['name'])}" for t in baseline['tables']]
            tables += [f"{ident(t['schema'])}.{ident(t['name'])}" for t in baseline['sequences']]
            args = [*common,'--data-only','--file=/backup/production-backup/database/data.dump']
            # Explicit relations include extension-owned data, auth/private/storage and migration history.
            for table in tables:
                args += ['--table',table]
            docker_client('pg_dump',args,root,env)
            for name in ['roles.sql','schema.dump','data.dump']:
                if (payload/'database'/name).stat().st_size == 0:
                    raise Failure('EMPTY_DATABASE_EXPORT')
            # All client connections have default_transaction_read_only=on.
            report['database_export_complete'] = True
            report['snapshot_consistency'] = 'SHARED_EXPORTED_REPEATABLE_READ_SNAPSHOT'
        # The exported snapshot is released only after both dumps are complete.
        stats = export_storage(payload/'storage',buckets,objects,Storage(os.environ['SUPABASE_SERVICE_ROLE_KEY']))
        report['storage'] = stats
        with connect(env) as fresh:
            q = source_query(fresh)
            fresh.execute("SET LOCAL TIME ZONE 'UTC'")
            buckets_after, objects_after = snapshot_storage(q)
            if buckets != buckets_after or not same_objects(objects,objects_after):
                raise Failure('STORAGE_METADATA_CHANGED_DURING_EXPORT','PARTIAL')
            if roles != role_inventory(q):
                raise Failure('ROLES_CHANGED_DURING_EXPORT','PARTIAL')
            for seq in baseline['sequences']:
                state = q(f"SELECT last_value,is_called FROM {ident(seq['schema'])}.{ident(seq['name'])}")[0]
                if state != seq['state']:
                    raise Failure('SEQUENCE_CHANGED_DURING_EXPORT','PARTIAL')
        verify_storage(payload/'storage')
        report.update(status='PARTIAL',error_code='PLATFORM_COMPONENTS_AND_RESTORE_NOT_VERIFIED')
    except Failure as error:
        report.update(status=error.status,error_code=error.code)
        raise
    except Exception as error:
        if getattr(error,'sqlstate',None) in ('42501','28P01','28000'):
            report.update(status='BLOCKED',error_code='DATABASE_READ_ACCESS_DENIED')
            raise Failure('DATABASE_READ_ACCESS_DENIED','BLOCKED') from None
        report.update(status='FAIL',error_code='BACKUP_EXECUTION_ERROR_REDACTED')
        raise Failure('BACKUP_EXECUTION_ERROR_REDACTED') from None
    finally:
        report['finished_at_utc'] = now()
        manifest = payload/'storage/objects-manifest.json'
        if manifest.exists():
            entries = load_json(manifest)
            good = [x for x in entries if x['status'] == 'EXPORTED']
            report.setdefault('storage',{}).update(files_succeeded=len(good),files_failed=len(entries)-len(good),
                                 files_unattempted=0,downloaded_bytes=sum(x['bytes'] for x in good))
        report['files'] = [{'path':p.relative_to(payload).as_posix(),'bytes':p.stat().st_size,
                            'sha256':digest(p)} for p in sorted(payload.rglob('*')) if p.is_file()]
        write_json(payload/'backup-report.json',report)
        write_json(payload/'restore-report.json',{'status':'BLOCKED','reason':'NOT_RUN',
                   'project_ref':PROJECT,'timestamp_utc':now(),'missing_components':LIMITATIONS})
        (root/'publish').mkdir(exist_ok=True)
        write_json(root/'publish/backup-report.json',summary(report))


def seal(root):
    require(['BACKUP_AGE_RECIPIENT'])
    payload, publish = root/'production-backup', root/'publish'
    report = load_json(payload/'backup-report.json')
    keys = root/'keys'
    keys.mkdir(mode=0o700,exist_ok=True)
    key = keys/'ephemeral-test-identity.txt'
    try:
        run(['age-keygen','--output',str(key)])
        key.chmod(0o600)
        recipient = run(['age-keygen','--y',str(key)]).decode().strip()
        report['encryption'] = 'ARCHIVE_BEFORE_ENCRYPTION_SEE_DETACHED_REPORT'
        write_json(payload/'backup-report.json',report)
        checksums(payload)
        verify_checksums(payload)
        archive = root/'bundle.tar.gz'
        with tarfile.open(archive,'w:gz') as t:
            t.add(payload,arcname='production-backup')
        encrypted = publish/'production-backup.tar.gz.age'
        run(['age','--encrypt','--recipient',os.environ['BACKUP_AGE_RECIPIENT'],
             '--recipient',recipient,'--output',str(encrypted),str(archive)])
        check = root/'decrypt-self-test.tar.gz'
        run(['age','--decrypt','--identity',str(key),'--output',str(check),str(encrypted)])
        if digest(check) != digest(archive):
            raise Failure('AGE_SELF_TEST_MISMATCH')
        report['encryption'] = 'AGE_ENCRYPTED_EPHEMERAL_ROUNDTRIP_VERIFIED'
        report['artifact_sha256'] = digest(encrypted)
        # The detached summary records completed encryption without a recursive archive hash.
        write_json(publish/'backup-report.json',summary(report))
        checksums(publish)
    finally:
        key.unlink(missing_ok=True)


def container_name():
    run_id = os.environ.get('GITHUB_RUN_ID','local')
    attempt = os.environ.get('GITHUB_RUN_ATTEMPT','1')
    if not re.fullmatch(r'[0-9]+|local',run_id) or not re.fullmatch(r'[0-9]+',attempt):
        raise Failure('INVALID_RUN_ID')
    return f'crm-backup-restore-{run_id}-{attempt}'


def start_restore():
    name = container_name()
    # Bypass image bootstrap/migrations; init an empty cluster with a distinct admin.
    script = ('initdb -D /tmp/rehearsal -U '+ADMIN+' --auth-local=trust --auth-host=reject '
              '--encoding=UTF8 --locale=C >/tmp/initdb.log 2>&1; '
              'exec postgres -D /tmp/rehearsal -k /tmp -c listen_addresses= '
              '-c shared_preload_libraries=pg_cron,pg_stat_statements '
              '-c cron.database_name=postgres -c cron.launch_active_jobs=off '
              '-c logging_collector=off -c log_statement=none -c log_min_error_statement=panic')
    run(['docker','run','--detach','--name',name,'--network','none','--user','postgres',
         '--cap-drop','ALL','--security-opt','no-new-privileges','--entrypoint','sh',
         IMAGE,'-ceu',script],timeout=120)
    for _ in range(60):
        try:
            run(['docker','exec',name,'pg_isready','-h','/tmp','-U',ADMIN],timeout=5)
            return name
        except Failure:
            time.sleep(1)
    raise Failure('ISOLATED_POSTGRES_NOT_READY','BLOCKED')


def restore_query(name):
    def query(sql):
        wrapped = "SET search_path=pg_catalog; SET TIME ZONE 'UTC'; "
        wrapped += "SELECT coalesce(jsonb_agg(row_to_json(q)),'[]'::jsonb) FROM ("+sql.strip()+') q;'
        output = run(['docker','exec','--user','postgres','-i',name,'psql','-X','-qAt',
                      '-h','/tmp','-U',ADMIN,'-d','postgres','--set=ON_ERROR_STOP=1'],
                     input_bytes=wrapped.encode())
        return json.loads(output)
    return query


def restore(root):
    report = base_report()
    report['restore_status'] = 'BLOCKED'
    try:
        # Production credentials must never be available to this code path.
        if os.environ.get('SUPABASE_DB_URL') or os.environ.get('SUPABASE_SERVICE_ROLE_KEY'):
            raise Failure('PRODUCTION_CREDENTIAL_PRESENT_IN_RESTORE','BLOCKED')
        require(['BACKUP_AGE_IDENTITY'])
        incoming = root/'incoming'
        verify_checksums(incoming)
        encrypted = incoming/'production-backup.tar.gz.age'
        if not encrypted.is_file():
            raise Failure('ENCRYPTED_ARCHIVE_MISSING')
        # This is an aggregate summary, never executable metadata.
        backup_summary = load_json(incoming/'backup-report.json')
        if (backup_summary.get('project_ref') != PROJECT
                or not backup_summary.get('database_export_complete')
                or backup_summary.get('encryption') != 'AGE_ENCRYPTED_EPHEMERAL_ROUNDTRIP_VERIFIED'
                or backup_summary.get('artifact_sha256') != digest(encrypted)):
            raise Failure('BACKUP_NOT_ELIGIBLE_FOR_REHEARSAL')
        key = root/'restore-identity.txt'
        key.write_text(os.environ.pop('BACKUP_AGE_IDENTITY'))
        key.chmod(0o600)
        archive = root/'decrypted.tar.gz'
        try:
            run(['age','--decrypt','--identity',str(key),'--output',str(archive),str(encrypted)])
        finally:
            key.unlink(missing_ok=True)
        payload = extract_archive(archive,root/'extracted')
        baseline = load_json(payload/'configuration/baseline.json')
        expected_roles = load_json(payload/'configuration/roles.json')
        original = load_json(payload/'backup-report.json')
        if not original.get('database_export_complete'):
            raise Failure('DATABASE_BACKUP_INCOMPLETE')
        run(['docker','pull',IMAGE],timeout=600)
        name = start_restore()
        query = restore_query(name)
        if query("SELECT current_setting('server_version_num')::int AS version")[0]['version'] != 170011:
            raise Failure('RESTORE_VERSION_NOT_17_11','BLOCKED')
        available = query('SELECT name,version FROM pg_available_extension_versions')
        supported = {(r['name'],r['version']) for r in available}
        if any((x['name'],x['version']) not in supported for x in baseline['extensions']):
            raise Failure('REQUIRED_EXTENSION_VERSION_UNAVAILABLE','BLOCKED')
        # Copying into the egress-disabled container uses Docker, never a TCP port.
        run(['docker','cp',str(payload/'database'),name+':/tmp/backup-database'])
        run(['docker','exec','--user','root',name,'chmod','-R','a+rX','/tmp/backup-database'])
        psql = ['docker','exec','--user','postgres','-i',name,'psql','-X','-q',
                '-h','/tmp','-U',ADMIN,'-d','postgres','--set=ON_ERROR_STOP=1']
        run([*psql,'--single-transaction','--file=/tmp/backup-database/roles.sql'])
        client = ['docker','exec','--user','postgres',name,'pg_restore','--exit-on-error',
                  '--single-transaction','--host=/tmp','--username='+ADMIN,'--dbname=postgres']
        run([*client,'/tmp/backup-database/schema.dump'])
        # Disables user triggers only on the isolated target to preserve original encrypted rows.
        restore_env = os.environ.copy()
        restore_env['PGOPTIONS'] = '-c session_replication_role=replica'
        run(['docker','exec','--env','PGOPTIONS','--user','postgres',name,'pg_restore',
             '--exit-on-error','--single-transaction','--host=/tmp','--username='+ADMIN,
             '--dbname=postgres','/tmp/backup-database/data.dump'],env=restore_env)
        actual = inventory(query)
        if actual != baseline:
            # Keep the sensitive mismatch details encrypted/on the disposable runner only.
            write_json(root/'restore-actual-inventory.json',actual)
            raise Failure('RESTORE_INVENTORY_OR_RECORD_FINGERPRINT_MISMATCH')
        actual_roles = role_inventory(query)
        actual_roles['roles'] = [r for r in actual_roles['roles'] if r['rolname'] != ADMIN]
        if actual_roles != expected_roles:
            raise Failure('RESTORE_ROLE_OR_MEMBERSHIP_MISMATCH')
        storage = verify_storage(payload/'storage')
        counts = original['counts']
        expected_storage = original['storage']
        if storage['objects_verified'] != expected_storage['objects'] or storage['bytes_verified'] != expected_storage['downloaded_bytes']:
            raise Failure('RESTORED_STORAGE_TOTALS_MISMATCH')
        report.update(status='PARTIAL',restore_status='PASS',postgres_version=actual['postgres']['version'],
                      database_export_complete=True,counts=counts,storage=expected_storage,
                      encryption='AGE_OWNER_IDENTITY_DECRYPTION_VERIFIED',
                      error_code='FULL_SUPABASE_SERVICE_RECOVERY_NOT_VERIFIED',
                      verification={'tables':len(actual['tables']),'catalog_sha256':actual['catalog_sha256'],
                                    'critical_row_fingerprints':'MATCH','roles_and_memberships':'MATCH',
                                    'storage':storage,'roles_exit_code':0,'schema_exit_code':0,'data_exit_code':0})
    except Failure as error:
        report.update(status=error.status,restore_status=error.status,error_code=error.code)
        raise
    except Exception:
        report.update(status='FAIL',restore_status='FAIL',error_code='RESTORE_EXECUTION_ERROR_REDACTED')
        raise Failure('RESTORE_EXECUTION_ERROR_REDACTED') from None
    finally:
        report['finished_at_utc'] = now()
        publish = root/'restore-publish'
        publish.mkdir(exist_ok=True)
        # Only fixed codes, aggregate counts and catalog digest; never raw SQL/errors/rows.
        write_json(publish/'restore-report.json',report)
        checksums(publish)
        try:
            run(['docker','rm','--force',container_name()],timeout=60)
        except Failure:
            pass


def check_source(root):
    require(['GH_TOKEN','GITHUB_REPOSITORY','SOURCE_RUN_ID','SOURCE_RUN_ATTEMPT'])
    run_id, attempt = os.environ['SOURCE_RUN_ID'],os.environ['SOURCE_RUN_ATTEMPT']
    if not re.fullmatch('[1-9][0-9]*',run_id) or not re.fullmatch('[1-9][0-9]*',attempt):
        raise Failure('INVALID_SOURCE_RUN_INPUT','BLOCKED')
    repo = os.environ['GITHUB_REPOSITORY']
    if repo != 'hoanganhngo847-a11y/ai-crm-cua-chong-ngap':
        raise Failure('INVALID_REPOSITORY','BLOCKED')

    def get(path):
        request = urllib.request.Request('https://api.github.com/repos/'+repo+path,
            headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json'})
        with urllib.request.urlopen(request,timeout=30) as response:
            return json.load(response)

    source = get('/actions/runs/'+run_id+'/attempts/'+attempt)
    if (source.get('event') != 'workflow_dispatch' or source.get('head_branch') != 'main'
            or source.get('status') != 'completed' or source.get('conclusion') != 'success'
            or source.get('head_repository',{}).get('full_name') != repo
            or source.get('path','').split('@')[0] != '.github/workflows/supabase-production-backup.yml'):
        raise Failure('UNTRUSTED_SOURCE_WORKFLOW_RUN','BLOCKED')
    # An immutable artifact name binds source run AND attempt; download action verifies its digest.
    write_json(root/'source-provenance.json',{'run_id':run_id,'attempt':attempt,
                                            'head_sha':source['head_sha'],'checked_at_utc':now()})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command',choices=['backup','seal','restore','check-source'])
    args = parser.parse_args()
    os.umask(0o077)
    try:
        root = workspace()
        {'backup':backup,'seal':seal,'restore':restore,'check-source':check_source}[args.command](root)
    except Failure as error:
        print(f'::error::{error.status}: {error.code}')
        return 1
    except Exception:
        print('::error::FAIL: EXECUTION_ERROR_REDACTED')
        return 1
    print('Completed '+args.command+'; inspect sanitized reports for verification scope.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
