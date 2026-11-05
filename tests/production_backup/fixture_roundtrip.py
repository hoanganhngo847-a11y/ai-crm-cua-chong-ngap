"""Real SQL/age rehearsal on synthetic data only; no Production access or secrets."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch
from urllib.parse import unquote

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0,str(REPO/'scripts/production_backup'))
import main  # noqa: E402
from common import IMAGE, TENANT, Failure, digest, load_json, run  # noqa: E402
from storage import Storage  # noqa: E402

SOURCE = 'crm-backup-synthetic-source'
FILES = {'company/nested/a.mp4':b'synthetic-audio-a',
         'company/nested/b.mp4':b'synthetic-audio-b',
         'company/công-ty/empty.mp4':b''}


def synthetic_run(args, *, env=None, input_bytes=None, timeout=1800):
    """Synthetic fixture diagnostics are safe; production run() always redacts."""
    r = subprocess.run(args,env=env,input=input_bytes,capture_output=True,timeout=timeout,check=False)
    if r.returncode:
        print('SYNTHETIC TEST COMMAND FAILED:',args[0],file=sys.stderr)
        print(r.stderr.decode(errors='replace')[:12000],file=sys.stderr)
        raise Failure('SYNTHETIC_PROCESS_EXIT_NONZERO')
    return r.stdout


def execute(sql):
    return synthetic_run(['docker','exec','-i',SOURCE,'psql','-X','-q','-h','/tmp','-U','fixture_admin',
                          '-d','postgres','--set=ON_ERROR_STOP=1'],input_bytes=sql.encode())


def main_test():
    if os.environ.get('SUPABASE_DB_URL') or os.environ.get('SUPABASE_SERVICE_ROLE_KEY') or os.environ.get('BACKUP_AGE_IDENTITY'):
        raise RuntimeError('Fixture refuses Production credentials')
    parent = Path(os.environ.get('RUNNER_TEMP',tempfile.gettempdir()))
    root = Path(tempfile.mkdtemp(prefix='crm-backup-fixture-',dir=parent))
    owner = root/'synthetic-owner.txt'
    try:
        synthetic_run(['docker','pull',IMAGE],timeout=600)
        script = ('initdb -D /tmp/source -U fixture_admin --auth=trust --encoding=UTF8 --locale=C '
                  '>/tmp/initdb.log 2>&1; exec postgres -D /tmp/source -k /tmp '
                  '-c listen_addresses=* -c shared_preload_libraries=pg_cron,pg_stat_statements,pg_net '
                  '-c cron.database_name=postgres -c cron.launch_active_jobs=off -c pg_net.database_name=template1')
        synthetic_run(['docker','run','--detach','--name',SOURCE,'--user','postgres',
                       '--publish','127.0.0.1:55432:5432','--entrypoint','sh',IMAGE,'-ceu',script])
        for _ in range(90):
            try:
                run(['docker','exec',SOURCE,'pg_isready','-h','/tmp','-U','fixture_admin'],timeout=5)
                break
            except Failure:
                time.sleep(1)
        else:
            raise RuntimeError('Synthetic database not ready')
        execute(f"""
          CREATE ROLE anon NOLOGIN;
          CREATE ROLE authenticated NOLOGIN;
          GRANT anon TO authenticated;
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
          CREATE TABLE auth.users(id uuid PRIMARY KEY,encrypted_password text);
          CREATE TABLE public.customers(id uuid PRIMARY KEY,company_id uuid NOT NULL,name text);
          CREATE INDEX customer_company_idx ON public.customers(company_id);
          CREATE TABLE public.interactions(id uuid PRIMARY KEY,company_id uuid NOT NULL,
            customer_id uuid REFERENCES public.customers(id),content text);
          CREATE TABLE private.customer_private_contacts(id uuid PRIMARY KEY,company_id uuid NOT NULL,
            customer_id uuid REFERENCES public.customers(id),private_value text);
          CREATE TABLE public.identities(id uuid PRIMARY KEY,customer_id uuid REFERENCES public.customers(id));
          CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]);
          CREATE SEQUENCE public.fixture_sequence START 42;
          SELECT nextval('public.fixture_sequence');
          CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,type text DEFAULT 'STANDARD',public bool DEFAULT false);
          CREATE TABLE storage.objects(id uuid PRIMARY KEY,bucket_id text REFERENCES storage.buckets(id),
            name text,metadata jsonb,version text,updated_at timestamptz DEFAULT '2026-01-01T00:00:00Z');
          ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
          CREATE POLICY tenant_policy ON public.customers TO authenticated USING(company_id='{TENANT}');
          GRANT USAGE ON SCHEMA public TO authenticated;
          GRANT SELECT ON public.customers TO authenticated;
          CREATE FUNCTION public.synthetic_trigger() RETURNS trigger LANGUAGE plpgsql AS
            $$ BEGIN RETURN NEW; END; $$;
          CREATE TRIGGER synthetic_insert BEFORE INSERT ON public.customers
            FOR EACH ROW EXECUTE FUNCTION public.synthetic_trigger();
          INSERT INTO auth.users VALUES ('00000000-0000-0000-0000-000000000001','SYNTHETIC_HASH');
          INSERT INTO public.customers VALUES ('00000000-0000-0000-0000-000000000002','{TENANT}','SYNTHETIC CUSTOMER');
          INSERT INTO public.interactions VALUES ('00000000-0000-0000-0000-000000000003','{TENANT}',
            '00000000-0000-0000-0000-000000000002','SYNTHETIC MESSAGE');
          INSERT INTO private.customer_private_contacts VALUES ('00000000-0000-0000-0000-000000000004','{TENANT}',
            '00000000-0000-0000-0000-000000000002','SYNTHETIC PRIVATE VALUE');
          INSERT INTO public.identities VALUES ('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000002');
          INSERT INTO supabase_migrations.schema_migrations VALUES ('20260101000000','synthetic',ARRAY['SYNTHETIC DDL']);
          INSERT INTO storage.buckets(id,name) VALUES ('private-bucket','private-bucket'),('empty-private-bucket','empty-private-bucket');
        """)
        for i,(name,data) in enumerate(FILES.items(),10):
            md = json.dumps({'size':len(data),'eTag':hashlib.md5(data,usedforsecurity=False).hexdigest()})
            execute("INSERT INTO storage.objects(id,bucket_id,name,metadata,version) VALUES "
                    f"('00000000-0000-0000-0000-{i:012d}','private-bucket','{name}','{md}','v1');")
        run(['age-keygen','-o',str(owner)])
        recipient = run(['age-keygen','-y',str(owner)]).decode().strip()
        env = os.environ.copy()
        env.update(PGHOST='127.0.0.1',PGPORT='55432',PGUSER='fixture_admin',PGPASSWORD='synthetic',
                   PGDATABASE='postgres',PGSSLMODE='disable',PGSSLROOTCERT='/etc/ssl/certs/ca-certificates.crt',
                   PGCONNECT_TIMEOUT='10',PGOPTIONS='-c default_transaction_read_only=on',PGAPPNAME='synthetic')

        class SyntheticStorage(Storage):
            def enumerate(self,buckets):
                with main.connect(env) as c:
                    return main.snapshot_storage(main.source_query(c))[1]

            def request(self,path,payload=None,destination=None):
                name = unquote(path.split('/private-bucket/',1)[1])
                data = FILES[name]
                Path(destination).write_bytes(data)
                return {'bytes':len(data),'sha256':digest(destination)}

        with patch.dict(os.environ,{'SUPABASE_DB_URL':'synthetic-only','SUPABASE_SERVICE_ROLE_KEY':'synthetic-only',
                                    'BACKUP_AGE_RECIPIENT':recipient}), \
             patch.object(main,'db_environment',return_value=env), \
             patch.object(main,'Storage',SyntheticStorage),patch.object(main,'run',side_effect=synthetic_run):
            main.backup(root)
            main.seal(root)
        published = load_json(root/'publish/backup-report.json')
        assert published['database_export_complete']
        assert published['storage']['files_succeeded'] == len(FILES)
        assert published['status'] == 'PARTIAL'  # Explicit platform gaps, never false PASS.
        rehearsal = root/'rehearsal'
        rehearsal.mkdir()
        shutil.copytree(root/'publish',rehearsal/'incoming')
        with patch.dict(os.environ,{'BACKUP_AGE_IDENTITY':owner.read_text()}), \
             patch.object(main,'run',side_effect=synthetic_run):
            main.restore(rehearsal)
        restored = load_json(rehearsal/'restore-publish/restore-report.json')
        assert restored['restore_status'] == 'PASS',restored
        assert restored['status'] == 'PARTIAL'
        assert restored['counts']['customers'] == 1
        assert restored['verification']['storage']['objects_verified'] == len(FILES)
        print('SYNTHETIC PASS: PostgreSQL 17.11 dump/restore, roles, schema/catalog, tenant counts, '
              'private row fingerprints, extension data, age owner decryption and Storage checksums.')
    finally:
        for container in [SOURCE,main.container_name()]:
            try:
                run(['docker','rm','--force',container],timeout=60)
            except Failure:
                pass
        shutil.rmtree(root)


if __name__ == '__main__':
    main_test()
