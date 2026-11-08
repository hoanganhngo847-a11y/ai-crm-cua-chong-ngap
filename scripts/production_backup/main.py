#!/usr/bin/env python3
"""Owner-operated DB-only export and independent restore. GitHub runs fixtures only."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import shutil
import sys
import tarfile
from tempfile import TemporaryDirectory, mkdtemp
import time
from uuid import uuid4

from common import (GIB, IMAGE, PROJECT, REPO, Failure, age_recipient, checksums, db_environment, digest,
                    extract_archive, load_json, private_scratch, run, verified_age, write_json)
from inventory import database_inventory, ident, inventory, role_inventory
from r2 import R2, SOURCE_PROJECTS, hidden, load_receipt, new_key, validate_receipt

DB_FILES = ('roles.sql', 'schema.dump', 'data.dump', 'extension-data.sql', 'sequence-values.sql')
REQUIRED_TABLES = {('supabase_migrations', 'schema_migrations'), ('public', 'customers'),
                   ('public', 'interactions'), ('private', 'customer_private_contacts')}
PG_VERSION = 170011


def connect(env):
    import psycopg
    from psycopg.rows import dict_row

    # This runner is single-threaded. Prevent libpq from reading inherited
    # service, host-address, authentication, or SSL environment overrides.
    inherited = {name: os.environ.pop(name) for name in list(os.environ) if name.startswith('PG')}
    try:
        return psycopg.connect(host=env['PGHOST'], port=env['PGPORT'], user=env['PGUSER'],
                               password=env['PGPASSWORD'], dbname='postgres', sslmode=env['PGSSLMODE'],
                               sslrootcert=env.get('PGSSLROOTCERT', ''), connect_timeout=20,
                               options=env['PGOPTIONS'], application_name='crm-backup-readonly',
                               row_factory=dict_row)
    except psycopg.OperationalError:
        raise Failure('DATABASE_CONNECTION_OR_CREDENTIAL_UNAVAILABLE', 'BLOCKED') from None
    finally:
        os.environ.update(inherited)


def guarded_source(conn, expected_role):
    import psycopg

    conn.isolation_level = psycopg.IsolationLevel.REPEATABLE_READ
    conn.read_only = True
    conn.execute("SET LOCAL search_path = pg_catalog")
    conn.execute("SET LOCAL TIME ZONE 'UTC'")
    conn.execute("SET LOCAL row_security = off")
    conn.execute("SET LOCAL idle_in_transaction_session_timeout = '45min'")
    state = conn.execute("""SELECT current_user AS role, current_database() AS database,
        pg_is_in_recovery() AS recovery, current_setting('server_version_num')::int AS version,
        current_setting('transaction_read_only') AS read_only,
        current_setting('transaction_isolation') AS isolation,
        current_setting('row_security') AS row_security""").fetchone()
    if state != {'role': expected_role, 'database': 'postgres', 'recovery': False, 'version': PG_VERSION,
                 'read_only': 'on', 'isolation': 'repeatable read', 'row_security': 'off'}:
        raise Failure('SOURCE_SESSION_GUARDS_FAILED', 'BLOCKED')
    return lambda sql: conn.execute(sql).fetchall()


def extension_data_copy(conn, baseline, path):
    # Preserve extension-owned rows which pg_dump may omit even with --table.
    with path.open('xb') as output:
        output.write(b'SET session_replication_role = replica;\n')
        for table in baseline['catalog']['relations']:
            if table['kind'] != 'r' or not table['extension_member']:
                continue
            schema, name = table['schema'], table['name']
            columns = sorted((c for c in baseline['catalog']['columns']
                              if c['schema'] == schema and c['relation'] == name and not c['generated']),
                             key=lambda c: c['position'])
            if not columns:
                raise Failure('EXTENSION_TABLE_WITHOUT_COPY_COLUMNS', 'BLOCKED')
            target = ident(schema) + '.' + ident(name) + ' (' + ','.join(ident(c['name']) for c in columns) + ')'
            output.write(('COPY ' + target + ' FROM stdin;\n').encode())
            with conn.cursor().copy('COPY ' + target + ' TO STDOUT') as copy:
                for block in copy:
                    output.write(block)
            output.write(b'\\.\n\n')


def sequence_data(baseline, path):
    statements = []
    for sequence in baseline['sequences']:
        state = sequence['state']
        if type(state['last_value']) is not int or type(state['is_called']) is not bool:
            raise Failure('INVALID_SEQUENCE_STATE')
        name = ident(sequence['schema']) + '.' + ident(sequence['name'])
        statements.append("SELECT pg_catalog.setval('" + name.replace("'", "''") + "'::regclass,"
                          + str(state['last_value']) + ',' + str(state['is_called']).lower() + ');\n')
    path.write_text(''.join(statements) or '-- No sequences in source.\n')


def database_toc(toc):
    # Use pg_restore's native CREATE/DATABASE PROPERTIES/database ACL handling.
    # PostgreSQL 17.11 emits the entries below for the fixed source DB name.
    entries = re.findall(
        r'(?m)^\d+; \d+ \d+ (?:DATABASE(?: PROPERTIES)? - postgres |'
        r'(?:ACL|COMMENT|SECURITY LABEL) - DATABASE postgres )[^\r\n]+',
        toc,
    )
    if len(re.findall(r'(?m)^\d+; \d+ \d+ DATABASE - ', toc)) != 1 or not any(
        ' DATABASE - postgres ' in entry for entry in entries
    ):
        raise Failure('SCHEMA_ARCHIVE_DATABASE_TOC_MISSING')
    return '\n'.join(entries) + '\n'


def export_database(payload, open_source, client, expected_role):
    db = payload / 'database'
    db.mkdir(mode=0o700)
    for tool in ('pg_dump', 'pg_dumpall', 'pg_restore'):
        if not re.search(rb'\(PostgreSQL\) 17\.11\b', client(tool, ['--version'])):
            raise Failure('POSTGRES_CLIENT_VERSION_NOT_17_11', 'BLOCKED')
    with open_source() as conn:
        query = guarded_source(conn, expected_role)
        source = query("SELECT pg_export_snapshot() AS snapshot, transaction_timestamp()::text AS started")[0]
        baseline = inventory(query)
        relations = baseline['catalog']['relations']
        properties = baseline['database']['properties']
        if (any(rel['kind'] in ('f', 'm') for rel in relations)
                or properties['tablespace'] != 'pg_default' or properties['is_template']
                or not properties['allow_connections']
                or query("SELECT count(*) AS count FROM pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global')")[0]['count']):
            raise Failure('DATABASE_REQUIRES_MANUAL_SCOPE_REVIEW', 'BLOCKED')
        if not REQUIRED_TABLES.issubset((t['schema'], t['name']) for t in baseline['tables']):
            raise Failure('CRM_REQUIRED_RELATION_MISSING', 'BLOCKED')
        roles = role_inventory(query)
        client('pg_dumpall', ['--roles-only', '--no-role-passwords', '--no-password', f'--file={db / "roles.sql"}'])
        options = ['--no-password', '--lock-wait-timeout=10s', '--format=custom', '--snapshot=' + source['snapshot']]
        client('pg_dump', [*options, '--schema-only', f'--file={db / "schema.dump"}'])
        data_options = [*options, '--data-only', '--large-objects', '--strict-names', f'--file={db / "data.dump"}']
        for obj in baseline['tables'] + baseline['sequences']:
            data_options += ['--table', ident(obj['schema']) + '.' + ident(obj['name'])]
        for table in baseline['tables']:
            if table['extension_member']:
                data_options += ['--exclude-table-data', ident(table['schema']) + '.' + ident(table['name'])]
        client('pg_dump', data_options)
        extension_data_copy(conn, baseline, db / 'extension-data.sql')
        sequence_data(baseline, db / 'sequence-values.sql')
        conn.rollback()

    with open_source() as conn:
        query = guarded_source(conn, expected_role)
        if roles != role_inventory(query) or baseline['database'] != database_inventory(query):
            raise Failure('ROLES_OR_DATABASE_CONFIGURATION_DRIFT', 'BLOCKED')
        for seq in baseline['sequences']:
            state = query(f"SELECT last_value,is_called FROM {ident(seq['schema'])}.{ident(seq['name'])}")[0]
            if state != seq['state']:
                raise Failure('SEQUENCE_DRIFT', 'BLOCKED')
        conn.rollback()

    if not all((db / name).is_file() and (db / name).stat().st_size for name in DB_FILES):
        raise Failure('INCOMPLETE_DATABASE_EXPORT')
    database_toc(client('pg_restore', ['--list', str(db / 'schema.dump')]).decode())
    toc = client('pg_restore', ['--list', str(db / 'data.dump')])
    physical_tables = sum(r['kind'] == 'r' and not r['extension_member'] for r in relations)
    if len(re.findall(rb'(?m)^\d+; \d+ \d+ TABLE DATA ', toc)) != physical_tables:
        raise Failure('DATABASE_DATA_TOC_MISMATCH')
    write_json(payload / 'inventory.json', baseline)
    write_json(payload / 'roles.json', roles)
    return datetime.fromisoformat(source['started']).astimezone(timezone.utc).isoformat()


def export_archive(scratch, source, recipient, age, open_source, client, expected_role):
    scratch = private_scratch(scratch)
    recipient = age_recipient(recipient)
    run([age, '--encrypt', '--recipient', recipient], input_bytes=b'backup recipient preflight')
    with TemporaryDirectory(prefix='crm-export-private-', dir=scratch) as temporary:
        plain = Path(temporary)
        payload = plain / 'production-backup'
        payload.mkdir(mode=0o700)
        snapshot_utc = export_database(payload, open_source, client, expected_role)
        receipt = {'format': 1, 'scope': 'db-only', 'export_status': 'complete', 'source': source,
                   'project_ref': SOURCE_PROJECTS[source], 'image': IMAGE, 'snapshot_utc': snapshot_utc,
                   'recipient_sha256': hashlib.sha256((recipient + '\n').encode()).hexdigest(), 'key': new_key(source)}
        write_json(payload / 'export.json', receipt)
        checksums(payload)
        archive = plain / 'backup.tar.gz'
        with tarfile.open(archive, 'x:gz') as tar:
            tar.add(payload, arcname='production-backup')
        ciphertext = plain / 'backup.tar.gz.age'
        run([age, '--encrypt', '--recipient', recipient, '--output', ciphertext, archive])
        receipt.update(bytes=ciphertext.stat().st_size, sha256=digest(ciphertext))
        validate_receipt(receipt)
        # A failed export or failed seal never exposes an upload-ready receipt.
        sealed = Path(mkdtemp(prefix='crm-backup-sealed-', dir=scratch))
        try:
            ciphertext.rename(sealed / ciphertext.name)
            write_json(sealed / 'receipt.json', receipt)
        except BaseException:
            shutil.rmtree(sealed)
            raise
    return sealed, receipt


def check_local_docker():
    endpoint = run(['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']).decode().strip()
    if not endpoint.startswith('unix://'):
        raise Failure('RESTORE_DOCKER_NOT_LOCAL', 'BLOCKED')


@contextmanager
def restore_container(admin):
    check_local_docker()
    script = ('initdb -D /tmp/rehearsal -U "$1" --auth-local=trust --auth-host=reject '
              '--encoding=UTF8 --locale=C >/tmp/initdb.log 2>&1; '
              'exec postgres -D /tmp/rehearsal -k /tmp -c listen_addresses= '
              '-c shared_preload_libraries=pg_cron,pg_stat_statements,pg_net '
              '-c cron.database_name=postgres -c cron.launch_active_jobs=off '
              '-c pg_net.database_name=template1 '
              '-c logging_collector=off -c log_statement=none -c log_min_error_statement=panic')
    run_id = uuid4().hex
    name = f'crm-backup-restore-{run_id}'
    try:
        container = run(['docker', 'run', '--detach', '--pull=never', '--name', name, '--label', 'crm.backup=' + run_id,
                         '--network', 'none', '--user', 'postgres', '--cap-drop', 'ALL',
                         '--security-opt', 'no-new-privileges', '--entrypoint', 'sh',
                         IMAGE, '-ceu', script, 'rehearsal', admin], timeout=120).decode().strip()
        if not re.fullmatch(r'[0-9a-f]{64}', container):
            raise Failure('RESTORE_CONTAINER_ID_INVALID')
        if run(['docker', 'inspect', '--format', '{{.HostConfig.NetworkMode}}', container]).strip() != b'none':
            raise Failure('RESTORE_NETWORK_ISOLATION_FAILED', 'BLOCKED')
        for _ in range(60):
            try:
                run(['docker', 'exec', container, 'pg_isready', '-h', '/tmp', '-U', admin], timeout=5)
                break
            except Failure:
                time.sleep(1)
        else:
            raise Failure('ISOLATED_POSTGRES_NOT_READY', 'BLOCKED')
        capacity = run(['docker', 'exec', container, 'df', '-Pk', '/tmp']).decode().splitlines()[1].split()
        if int(capacity[3]) * 1024 < 5 * GIB:
            raise Failure('RESTORE_DOCKER_DISK_SPACE_INSUFFICIENT', 'BLOCKED')
        yield container
    finally:
        try:
            label = run(['docker', 'inspect', '--format', '{{index .Config.Labels "crm.backup"}}', name], timeout=10)
            if label.decode().strip() == run_id:
                run(['docker', 'rm', '--force', name], timeout=60)
        except Failure:
            pass


def psql(container, admin, database):
    return ['docker', 'exec', '--user', 'postgres', '-i', container, 'psql', '-X', '-q',
            '-h', '/tmp', '-U', admin, '-d', database, '--set=ON_ERROR_STOP=1']


def restore_query(container, admin, database):
    def query(sql):
        wrapped = ("SET search_path=pg_catalog; SET TIME ZONE 'UTC'; SET row_security=off; "
                   "SELECT coalesce(jsonb_agg(row_to_json(q)),'[]'::jsonb) FROM (" + sql.strip() + ') q;')
        return json.loads(run([*psql(container, admin, database), '-At'], input_bytes=wrapped.encode()))
    return query


def verify_restore_guards(query):
    settings = query("""SELECT current_setting('server_version_num')::int AS version,
        current_setting('listen_addresses') AS listen, current_setting('cron.launch_active_jobs') AS cron,
        current_setting('pg_net.database_name') AS net""")[0]
    if settings != {'version': PG_VERSION, 'listen': '', 'cron': 'off', 'net': 'template1'}:
        raise Failure('RESTORE_BACKGROUND_OR_VERSION_GUARD_FAILED', 'BLOCKED')


def restore_payload(payload, work, verify_fixture=None):
    baseline = load_json(payload / 'inventory.json')
    roles = load_json(payload / 'roles.json')
    admin = roles['bootstrap_role']
    bootstrap = next(r for r in roles['roles'] if r['rolname'] == admin)
    if (not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,62}', admin)
            or not bootstrap['rolsuper'] or not bootstrap['rolcanlogin']
            or baseline['database']['properties']['name'] != 'postgres'):
        raise Failure('RESTORE_BOOTSTRAP_REQUIRES_REVIEW', 'BLOCKED')
    database = payload / 'database'
    database.chmod(0o755)
    for name in DB_FILES:
        (database / name).chmod(0o644)
    with restore_container(admin) as container:
        template = restore_query(container, admin, 'template1')
        verify_restore_guards(template)
        available = {(r['name'], r['default_version'])
                     for r in template('SELECT name,default_version FROM pg_available_extensions')}
        if any((x['name'], x['version']) not in available for x in baseline['extensions']):
            raise Failure('REQUIRED_EXTENSION_DEFAULT_VERSION_MISMATCH', 'BLOCKED')
        # The role OID used as cluster bootstrap exists already. Reapply its attributes.
        lines = (database / 'roles.sql').read_text().splitlines(keepends=True)
        create = {f'CREATE ROLE {admin};', f'CREATE ROLE {ident(admin)};'}
        if sum(line.strip() in create for line in lines) != 1:
            raise Failure('BOOTSTRAP_ROLE_CREATE_NOT_UNIQUE')
        roles_sql = ''.join(line for line in lines if line.strip() not in create)
        run([*psql(container, admin, 'template1'), '--single-transaction', '--file=-'],
            input_bytes=roles_sql.encode())
        run(['docker', 'cp', str(database), container + ':/tmp/backup-database'])
        dump_dir = '/tmp/backup-database/'
        schema = dump_dir + 'schema.dump'
        data = dump_dir + 'data.dump'
        pg_restore = ['docker', 'exec', '--user', 'postgres', container, 'pg_restore', '--exit-on-error',
                      '--host=/tmp', '--username=' + admin]
        toc = database_toc(run([*pg_restore, '--list', schema]).decode())
        toc_path = work / 'database.toc'
        toc_path.write_text(toc)
        toc_path.chmod(0o644)
        run(['docker', 'cp', str(toc_path), container + ':/tmp/database.toc'])
        # This replaces only the empty postgres DB of the disposable local container.
        run([*pg_restore, '--create', '--clean', '--if-exists', '--dbname=template1',
             '--use-list=/tmp/database.toc', schema])
        restore = [*pg_restore, '--single-transaction', '--dbname=postgres']
        run([*restore, '--section=pre-data', schema])
        run([*restore, data])
        run([*psql(container, admin, 'postgres'), '--single-transaction',
             '--file=' + dump_dir + 'extension-data.sql', '--file=' + dump_dir + 'sequence-values.sql'])
        run([*restore, '--section=post-data', schema])
        query = restore_query(container, admin, 'postgres')
        verify_restore_guards(query)
        if database_inventory(query) != baseline['database']:
            raise Failure('RESTORE_DATABASE_ACL_SETTINGS_OR_LOCALE_MISMATCH')
        if role_inventory(query) != roles:
            raise Failure('RESTORE_ROLE_OR_MEMBERSHIP_MISMATCH')
        actual = inventory(query)
        if actual != baseline:
            differing = ','.join(sorted(k for k in baseline if actual.get(k) != baseline[k]))
            raise Failure('RESTORE_INVENTORY_MISMATCH_' + differing.upper())
        if verify_fixture is not None:
            verify_fixture(container, admin)
    return {'tables': len(baseline['tables']), 'extensions': len(baseline['extensions']),
            'catalog_sha256': baseline['catalog_sha256']}


def restore_from_r2(scratch, receipt, age, identity, r2, verify_fixture=None):
    scratch = private_scratch(scratch)
    validate_receipt(receipt)
    identity = Path(identity).resolve(strict=True)
    if (identity.is_relative_to(REPO) or not identity.is_file()
            or identity.stat().st_uid != os.getuid() or identity.stat().st_mode & 0o077):
        raise Failure('UNSAFE_AGE_IDENTITY_PATH', 'BLOCKED')
    with TemporaryDirectory(prefix='crm-restore-private-', dir=scratch) as temporary:
        work = Path(temporary)
        ciphertext = work / 'backup.tar.gz.age'
        if shutil.disk_usage(work).free < 2 * receipt['bytes'] + GIB:
            raise Failure('INSUFFICIENT_SPACE_FOR_CIPHERTEXT_AND_ARCHIVE', 'BLOCKED')
        r2.readback(receipt, ciphertext)
        archive = work / 'backup.tar.gz'
        run([age, '--decrypt', '--identity', identity, '--output', archive, ciphertext])
        ciphertext.unlink()
        payload = extract_archive(archive, work / 'extracted')
        metadata = {k: v for k, v in receipt.items() if k not in ('bytes', 'sha256')}
        if load_json(payload / 'export.json') != metadata:
            raise Failure('EXPORTED_BUNDLE_RECEIPT_MISMATCH')
        return restore_payload(payload, work, verify_fixture)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    export = commands.add_parser('export')
    publish = commands.add_parser('publish')
    reconcile = commands.add_parser('reconcile')
    restore = commands.add_parser('restore')
    for command in (export, publish, reconcile, restore):
        command.add_argument('--owner-approved-project')
    for command in (export, restore):
        command.add_argument('--scratch', required=True, type=Path)
        command.add_argument('--age-dir', required=True, type=Path)
        command.add_argument('--age-sha256', required=True)
    for command in (publish, reconcile, restore):
        command.add_argument('--receipt', required=True, type=Path)
    export.add_argument('--recipient', required=True)
    export.add_argument('--pg-bin', required=True, type=Path)
    export.add_argument('--ca-file', required=True, type=Path)
    publish.add_argument('--ciphertext', required=True, type=Path)
    restore.add_argument('--identity', required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    try:
        if os.environ.get('GITHUB_ACTIONS', '').lower() == 'true':
            raise Failure('GITHUB_ACTIONS_OPERATION_DISABLED', 'BLOCKED')
        if args.command == 'export':
            require_project(args.owner_approved_project)
            scratch = private_scratch(args.scratch)
            age = verified_age(args.age_dir / 'age', args.age_sha256)
            recipient = age_recipient(args.recipient)
            env = db_environment(hidden('Production PostgreSQL URL (hidden): '), args.ca_file)
            pg_bin = args.pg_bin.resolve(strict=True)

            def client(tool, options):
                return run([pg_bin / tool, *options], env=env, timeout=2400)

            directory, receipt = export_archive(scratch, 'production', recipient, age,
                                                lambda: connect(env), client, 'postgres')
            print('Export and age encryption PASS. Review the receipt and store a trusted copy before PUT.')
            print(directory)
            print('Object key', receipt['key'])
            return 0

        receipt = load_receipt(args.receipt)
        if receipt['source'] == 'production':
            require_project(args.owner_approved_project)
        if args.command == 'restore':
            scratch = private_scratch(args.scratch)
            age = verified_age(args.age_dir / 'age', args.age_sha256)
            result = restore_from_r2(scratch, receipt, age, args.identity, R2.prompt())
            print('Independent PostgreSQL 17.11 DB-only restore PASS.', json.dumps(result, sort_keys=True))
        elif args.command == 'publish':
            print('Object key', receipt['key'], flush=True)
            outcome = R2.prompt().publish(args.ciphertext, receipt)
            print(outcome, 'Download PASS. SHA-256 PASS. Lifecycle PASS.')
        else:
            R2.prompt().readback(receipt)
            print('Download PASS. SHA-256 PASS. Lifecycle PASS.')
    except Failure as error:
        print(error.status, error.code, file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('BLOCKED INTERRUPTED_CHECK_RECEIPT_BEFORE_PUT', file=sys.stderr)
        return 1
    except Exception:
        print('FAIL BACKUP_OPERATION_ERROR_REDACTED', file=sys.stderr)
        return 1
    return 0


def require_project(value):
    if value != PROJECT:
        raise Failure('OWNER_PROJECT_APPROVAL_REQUIRED', 'BLOCKED')


if __name__ == '__main__':
    sys.exit(main())
