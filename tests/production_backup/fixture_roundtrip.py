"""Same PostgreSQL, age, PUT/GET, and restore path with a disposable fixture."""
import argparse
from contextlib import contextmanager
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory, gettempdir
import time
from unittest.mock import patch
from uuid import uuid4

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'scripts/production_backup'))
import main  # noqa: E402
from common import IMAGE, PROCESS_ENV, Failure, private_scratch, protect_process, run, verified_age  # noqa: E402
from r2 import R2  # noqa: E402
from r2_fixture import local_r2  # noqa: E402

TENANT = '00000000-0000-0000-0000-000000000101'
OTHER = '00000000-0000-0000-0000-000000000102'
ADMIN = 'fixture_admin'

FIXTURE_SQL = f"""
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated LOGIN PASSWORD 'synthetic-password-never-exported' VALID UNTIL '2035-01-01T00:00:00Z';
GRANT anon TO authenticated WITH ADMIN OPTION;
REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE postgres TO authenticated;
ALTER DATABASE postgres SET work_mem TO '7MB';
ALTER DATABASE postgres CONNECTION LIMIT 30;
ALTER ROLE authenticated IN DATABASE postgres SET statement_timeout TO '3s';
ALTER ROLE authenticated SET application_name TO 'synthetic role setting';

CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION pg_trgm WITH SCHEMA public;
CREATE EXTENSION pg_stat_statements WITH SCHEMA extensions;
CREATE EXTENSION pg_cron;
CREATE EXTENSION pg_net;
CREATE EXTENSION supabase_vault;
INSERT INTO net.http_request_queue(method,url,headers,timeout_milliseconds)
  VALUES ('GET','https://example.invalid/synthetic-never-execute','{{}}'::jsonb,100);
INSERT INTO net._http_response(id,content,created) VALUES (4242,'SYNTHETIC_RESPONSE','2000-01-01');
CREATE SCHEMA auth;
CREATE SCHEMA private;
CREATE SCHEMA storage;
CREATE SCHEMA supabase_migrations;
CREATE TABLE auth.users(id uuid PRIMARY KEY, encrypted_password text);
CREATE TABLE public.customers(id uuid PRIMARY KEY, company_id uuid NOT NULL, name text);
CREATE INDEX customer_company_idx ON public.customers(company_id);
CREATE TABLE public.interactions(id uuid PRIMARY KEY, company_id uuid NOT NULL,
  customer_id uuid REFERENCES public.customers(id), content text);
CREATE TABLE private.customer_private_contacts(id uuid PRIMARY KEY, company_id uuid NOT NULL,
  customer_id uuid REFERENCES public.customers(id), private_value text);
CREATE TABLE public.identities(id uuid PRIMARY KEY, customer_id uuid REFERENCES public.customers(id));
CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY, name text, statements text[]);
CREATE SEQUENCE public.fixture_sequence START 42;
SELECT nextval('public.fixture_sequence');
SELECT lo_from_bytea(4242, convert_to('SYNTHETIC LARGE OBJECT PAYLOAD','UTF8'));
GRANT SELECT ON LARGE OBJECT 4242 TO authenticated;
CREATE TABLE storage.buckets(id text PRIMARY KEY, name text, public bool DEFAULT false);
CREATE TABLE storage.objects(id uuid PRIMARY KEY, bucket_id text REFERENCES storage.buckets(id), name text);
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_policy ON public.customers TO authenticated
  USING (company_id::text = current_setting('app.company_id', true));
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT (id,company_id,name) ON public.customers TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA private GRANT SELECT ON TABLES TO anon;
CREATE FUNCTION public.synthetic_trigger() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN RETURN NEW; END; $$;
CREATE TRIGGER synthetic_insert BEFORE INSERT ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.synthetic_trigger();
INSERT INTO auth.users VALUES ('00000000-0000-0000-0000-000000000001','SYNTHETIC_HASH');
INSERT INTO public.customers VALUES ('00000000-0000-0000-0000-000000000002','{TENANT}','SYNTHETIC CUSTOMER'),
  ('00000000-0000-0000-0000-000000000006','{OTHER}','SYNTHETIC OTHER TENANT');
INSERT INTO public.interactions VALUES ('00000000-0000-0000-0000-000000000003','{TENANT}',
  '00000000-0000-0000-0000-000000000002','SYNTHETIC MESSAGE');
INSERT INTO private.customer_private_contacts VALUES ('00000000-0000-0000-0000-000000000004','{TENANT}',
  '00000000-0000-0000-0000-000000000002','SYNTHETIC PRIVATE VALUE');
INSERT INTO public.identities VALUES ('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000002');
INSERT INTO supabase_migrations.schema_migrations VALUES ('20260101000000','synthetic',ARRAY['SYNTHETIC DDL']);
INSERT INTO storage.buckets VALUES ('synthetic-private-bucket','synthetic-private-bucket',false);
INSERT INTO storage.objects VALUES ('00000000-0000-0000-0000-000000000007','synthetic-private-bucket','synthetic.txt');
"""


def synthetic_run(args, *, env=None, input_bytes=None, timeout=1800):
    # Only fixture data enters these commands. Useful diagnostics for the CI fixture.
    result = subprocess.run(args, env=PROCESS_ENV | (env or {}), input=input_bytes,
                            capture_output=True, timeout=timeout, check=False)
    if result.returncode:
        print('SYNTHETIC TOOL FAILED:', Path(args[0]).name, file=sys.stderr)
        print(result.stderr.decode(errors='replace')[:6000], file=sys.stderr)
        raise Failure('SYNTHETIC_TOOL_FAILED')
    return result.stdout


@contextmanager
def fixture_source():
    main.check_local_docker()
    run_id = uuid4().hex
    name = 'crm-backup-fixture-' + run_id
    password = uuid4().hex
    script = ('umask 077; printf "%s\\n" "$1" >/tmp/fixture-password; '
              'initdb -D /tmp/fixture-source -U fixture_admin --auth-local=trust '
              '--auth-host=scram-sha-256 --pwfile=/tmp/fixture-password --encoding=UTF8 '
              '--locale=C --locale-provider=icu --icu-locale=en-US '
              '--lc-collate=en_US.UTF-8 --lc-ctype=en_US.UTF-8 >/tmp/initdb.log 2>&1; '
              'printf "%s\\n" "host postgres fixture_admin all scram-sha-256" >>/tmp/fixture-source/pg_hba.conf; '
              'exec postgres -D /tmp/fixture-source -k /tmp -c listen_addresses=* '
              '-c shared_preload_libraries=pg_cron,pg_stat_statements,pg_net '
              '-c cron.database_name=postgres -c cron.launch_active_jobs=off -c pg_net.database_name=template1')
    try:
        container = synthetic_run(['docker', 'run', '--detach', '--pull=never', '--name', name,
                                   '--label', 'crm.fixture=' + run_id, '--publish', '127.0.0.1::5432',
                                   '--user', 'postgres', '--entrypoint', 'sh',
                                   IMAGE, '-ceu', script, 'fixture', password]).decode().strip()
        for _ in range(60):
            try:
                run(['docker', 'exec', container, 'pg_isready', '-h', '/tmp', '-U', ADMIN], timeout=5)
                break
            except Failure:
                time.sleep(1)
        else:
            raise Failure('SYNTHETIC_SOURCE_NOT_READY')
        endpoint = synthetic_run(['docker', 'port', container, '5432/tcp']).decode().strip()
        match = re.fullmatch(r'127\.0\.0\.1:(\d+)', endpoint)
        if not match:
            raise Failure('SYNTHETIC_SOURCE_NOT_LOOPBACK')
        env = dict(PGHOST='127.0.0.1', PGPORT=match[1], PGUSER=ADMIN, PGPASSWORD=password,
                   PGSSLMODE='disable', PGOPTIONS='-c default_transaction_read_only=on -c row_security=off')
        synthetic_run(main.psql(container, ADMIN, 'postgres'), input_bytes=FIXTURE_SQL.encode())
        remote_files = {}

        def client(tool, args):
            remote_args = []
            output = None
            for arg in args:
                if arg.startswith('--file='):
                    output = arg.removeprefix('--file=')
                    remote_files[output] = f'/tmp/fixture-export-{len(remote_files)}'
                    remote_args.append('--file=' + remote_files[output])
                else:
                    remote_args.append(remote_files.get(arg, arg))
            result = synthetic_run(['docker', 'exec', '--user', 'postgres', container, 'env',
                                    'PGHOST=/tmp', 'PGUSER=' + ADMIN, 'PGDATABASE=postgres',
                                    'PGOPTIONS=-c default_transaction_read_only=on -c row_security=off',
                                    tool, *remote_args])
            if output is not None:
                synthetic_run(['docker', 'cp', container + ':' + remote_files[output], output])
                Path(output).chmod(0o600)
            return result

        def open_source():
            try:
                return main.connect(env)
            except Failure:
                logs = subprocess.run(['docker', 'logs', '--tail=12', container], env=PROCESS_ENV,
                                      capture_output=True, timeout=10, check=False)
                detail = (logs.stdout + logs.stderr).decode(errors='replace').replace(password, '[fixture-password]')
                print(detail[:6000], file=sys.stderr)
                raise

        yield open_source, client
    finally:
        try:
            label = run(['docker', 'inspect', '--format', '{{index .Config.Labels "crm.fixture"}}', name], timeout=10)
            if label.decode().strip() == run_id:
                run(['docker', 'rm', '--force', name], timeout=60)
        except Failure:
            pass


def verify_fixture(container, admin):
    query = main.restore_query(container, admin, 'postgres')
    assert query("SELECT rolpassword IS NULL AS password_omitted FROM pg_authid WHERE rolname='authenticated'") == [
        {'password_omitted': True},
    ]
    assert query("""SELECT current_setting('work_mem') AS work_mem,
        has_database_privilege('authenticated','postgres','CONNECT') AS can_connect,
        has_database_privilege('anon','postgres','CONNECT') AS anon_can_connect""") == [
        {'work_mem': '7MB', 'can_connect': True, 'anon_can_connect': False},
    ]
    sql = f"""BEGIN;
    SET LOCAL ROLE authenticated;
    SET LOCAL app.company_id = '{TENANT}';
    SELECT count(*) FROM public.customers WHERE company_id IN ('{TENANT}','{OTHER}');
    SELECT count(*) FROM public.customers WHERE company_id = '{OTHER}';
    ROLLBACK;
    """
    assert synthetic_run([*main.psql(container, admin, 'postgres'), '-At'], input_bytes=sql.encode()).splitlines() == [
        b'1', b'0',
    ]
    assert query('SELECT count(*) AS count FROM supabase_migrations.schema_migrations') == [{'count': 1}]


def fixture_roundtrip(args):
    prohibited = ('SUPABASE_DB_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'BACKUP_AGE_IDENTITY')
    if any(os.environ.get(key) for key in prohibited):
        raise Failure('SYNTHETIC_RUN_REFUSES_PRODUCTION_CREDENTIALS', 'BLOCKED')
    if args.live_r2 and (os.environ.get('GITHUB_ACTIONS', '').lower() == 'true'
                         or not (args.scratch and args.age_dir and args.age_sha256 and args.age_keygen_sha256)):
        raise Failure('LIVE_SMOKE_REQUIRES_OWNER_SCRATCH_AND_PINNED_AGE', 'BLOCKED')
    age = args.age_dir / 'age' if args.age_dir else Path(shutil.which('age') or 'age')
    age_keygen = args.age_dir / 'age-keygen' if args.age_dir else Path(shutil.which('age-keygen') or 'age-keygen')
    if args.age_sha256:
        age = verified_age(age, args.age_sha256)
    if args.age_keygen_sha256:
        age_keygen = verified_age(age_keygen, args.age_keygen_sha256)
    parent = private_scratch(args.scratch) if args.scratch else Path(os.environ.get('RUNNER_TEMP', gettempdir()))
    with TemporaryDirectory(prefix='crm-backup-synthetic-', dir=parent) as temporary:
        scratch = private_scratch(temporary)
        identity = scratch / 'synthetic.agekey'
        run([age_keygen, '--output', identity])
        recipient = run([age_keygen, '--y', identity]).decode().strip()
        with patch.object(main, 'run', side_effect=synthetic_run):
            with fixture_source() as (open_source, client):
                sealed, receipt = main.export_archive(scratch, 'synthetic', recipient, age, open_source, client, ADMIN)
            print('Export PASS. Age encryption PASS.', flush=True)
            print('Synthetic object key', receipt['key'], 'SHA-256', receipt['sha256'], flush=True)
            ciphertext = sealed / 'backup.tar.gz.age'
            if args.live_r2:
                r2 = R2.prompt()
                outcome = r2.publish(ciphertext, receipt)
                restore_verified = main.restore_from_r2(scratch, receipt, age, identity, r2, verify_fixture)
            else:
                with local_r2() as server:
                    server.drop_after_commit = True
                    r2 = R2('a' * 32, 'b' * 64)
                    outcome = r2.publish(ciphertext, receipt)
                    assert outcome == 'RECONCILED'
                    assert [method for method, _ in server.requests] == ['PUT', 'GET']
                    restore_verified = main.restore_from_r2(scratch, receipt, age, identity, r2, verify_fixture)
            print(outcome, 'Download PASS. SHA-256 PASS. Lifecycle header PASS.', flush=True)
            print('Age decrypt PASS. PostgreSQL 17.11 DB-only restore PASS.', restore_verified)
            print('Cloudflare R2 smoke PASS.' if args.live_r2 else 'Loopback S3 fixture PASS.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live-r2', action='store_true')
    parser.add_argument('--scratch', type=Path)
    parser.add_argument('--age-dir', type=Path)
    parser.add_argument('--age-sha256')
    parser.add_argument('--age-keygen-sha256')
    protect_process()
    try:
        fixture_roundtrip(parser.parse_args())
    except Failure as error:
        print(error.status, error.code, file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print('BLOCKED INTERRUPTED_CHECK_SYNTHETIC_OBJECT_KEY', file=sys.stderr)
        sys.exit(1)
