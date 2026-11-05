import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { PLATFORM_STUBS } from '../zalo/helpers/pglite-supabase';

const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id\s*=\s*"([\w-]+)"/m)?.[1];
assert.ok(project);
const container = process.env.CRM_MIGRATION_TEST_CONTAINER || `supabase_db_${project}`;
assert.match(container, /^supabase_db_[\w-]+$/);
const database = `migration_security_${randomUUID().replaceAll('-', '')}`;
function sql(query: string, db = database) {
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db], {
    input: query, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000,
  }).trim();
}

test('canonical 21-migration prefix and full chain preserve tenant projection and auth trigger after hardening', () => {
  sql(`CREATE DATABASE ${database};`, 'postgres');
  try {
    sql(PLATFORM_STUBS.replace(/CREATE ROLE[^;]+;/g, ''));
    const files = readdirSync('supabase/migrations').filter(f => f.endsWith('.sql')).sort();
    const boundary = files.indexOf('20260928000001_operations_p0_hardening.sql');
    assert.ok(boundary >= 0);
    for (const file of files.slice(0, boundary + 1)) sql(readFileSync(`supabase/migrations/${file}`, 'utf8'));
    assert.equal(sql("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='sales_style_profiles' AND column_name IN ('activated_at','activated_by_user_id','superseded_at','superseded_by_profile_id')"), '4');
    const catalog = readFileSync('scripts/meta-ads/staging-catalog.sql', 'utf8').replace(/;\s*$/, '');
    const prefixCatalog = sql(`SELECT json_agg(t) FROM (${catalog}) t;`);
    assert.deepEqual(JSON.parse(prefixCatalog), JSON.parse(readFileSync('docs/evidence/meta-ads-staging/staging-prefix-catalog.json', 'utf8')));
    // Optional local-only schema evidence; never reads a remote connection string.
    if (process.env.CRM_PREFIX_CATALOG_OUTPUT) {
      writeFileSync(process.env.CRM_PREFIX_CATALOG_OUTPUT, prefixCatalog + '\n');
    }
    assert.equal(sql("SELECT has_function_privilege('anon','public.handle_new_user()','EXECUTE')"), 't');
    const hardening = readFileSync('supabase/migrations/20261030120001_staging_function_security_hardening.sql', 'utf8');
    // The fix also supports the staging prefix. Roll back this local experiment
    // before replaying the original pending chain in its canonical order.
    assert.equal(sql(`BEGIN; ${hardening}
      SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('public','private')
      AND p.prolang IN (SELECT oid FROM pg_language WHERE lanname IN ('sql','plpgsql'))
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
      AND NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) x WHERE x LIKE 'search_path=%');
      SELECT has_function_privilege('anon','public.handle_new_user()','EXECUTE');
      ROLLBACK;`), '0\nf');
    for (const file of files.slice(boundary + 1)) sql(readFileSync(`supabase/migrations/${file}`, 'utf8'));
    assert.equal(sql("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','private') AND p.prolang IN (SELECT oid FROM pg_language WHERE lanname IN ('sql','plpgsql')) AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e') AND NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) x WHERE x LIKE 'search_path=%')"), '0');
    for (const role of ['anon', 'authenticated']) {
      assert.equal(sql(`SELECT has_function_privilege('${role}','public.handle_new_user()','EXECUTE')`), 'f');
      assert.throws(() => sql(`SET ROLE ${role}; SELECT public.handle_new_user();`));
    }
    assert.equal(sql("SELECT has_function_privilege('authenticated','public.is_active_member(uuid)','EXECUTE')"), 't');
    assert.equal(sql("SELECT has_table_privilege('anon','public.safe_staff_directory','SELECT')"), 'f');
    const tenant = randomUUID(), foreign = randomUUID(), actor = randomUUID(), coworker = randomUUID(), outsider = randomUUID();
    // Signup trigger still creates profiles even without caller EXECUTE privileges.
    sql(`GRANT USAGE ON SCHEMA auth TO authenticated;
      GRANT INSERT ON auth.users TO authenticated;
      SET ROLE authenticated;
      INSERT INTO auth.users(id,raw_user_meta_data) VALUES
      ('${actor}','{"full_name":"Actor"}'),('${coworker}','{"full_name":"Coworker"}'),('${outsider}','{"full_name":"Other tenant"}');
      RESET ROLE;
      INSERT INTO public.companies(id,name,status) VALUES ('${tenant}','Tenant','ACTIVE'),('${foreign}','Foreign','ACTIVE');
      INSERT INTO public.company_members(company_id,user_id,role,status) VALUES
      ('${tenant}','${actor}','SALE','ACTIVE'),('${tenant}','${coworker}','BOSS_ADMIN','ACTIVE'),('${foreign}','${outsider}','SALE','ACTIVE');`);
    assert.equal(sql(`SELECT count(*) FROM public.user_profiles WHERE id IN ('${actor}','${coworker}','${outsider}')`), '3');
    const directory = sql(`SET ROLE authenticated; SET request.jwt.claim.sub='${actor}'; SELECT string_agg(display_name,',' ORDER BY display_name) FROM public.safe_staff_directory;`);
    assert.equal(directory, 'Actor,Coworker');
    assert.equal(sql(`SET ROLE authenticated; SET request.jwt.claim.sub='${actor}'; SELECT public.is_active_member('${foreign}')`), 'f');
    assert.equal(sql("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private') AND c.relkind='r' AND NOT c.relrowsecurity"), '0');
    assert.equal(sql("SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private') AND NOT i.indisvalid"), '0');
    assert.equal(sql("SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname IN ('public','private') AND NOT c.convalidated"), '0');
    // Reapplying only the new metadata migration is safe and preserves the view.
    sql(readFileSync('supabase/migrations/20261030120001_staging_function_security_hardening.sql', 'utf8'));
    assert.equal(sql(`SET ROLE authenticated; SET request.jwt.claim.sub='${actor}'; SELECT count(*) FROM public.safe_staff_directory`), '2');
  } finally {
    sql(`DROP DATABASE ${database} WITH (FORCE);`, 'postgres');
  }
});
