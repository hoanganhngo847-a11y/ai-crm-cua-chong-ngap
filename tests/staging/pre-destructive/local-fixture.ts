import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inspectTransactionEnvelope, sqlSha256 } from '../../../scripts/meta-ads/ledger-readiness';

// Deliberately no remote connection string, credentials, generic container or
// production executor. Only new, namespaced databases on this local test stack.
const project=readFileSync('supabase/config.toml','utf8').match(/^project_id\s*=\s*"([\w-]+)"/m)?.[1];
export const CONTAINER = process.env.CRM_PREFLIGHT_LOCAL_CONTAINER || `supabase_db_${project}`;
if(!/^supabase_db_[\w-]+$/.test(CONTAINER))throw new Error('LOCAL_SUPABASE_CONTAINER_ONLY');
const prefix = `crm_preflight_${randomUUID().replaceAll('-', '')}`;
export const fixtureDatabase = (suffix: 'source' | 'restore' | 'ledger' | 'cli') => `${prefix}_${suffix}`;
export function assertFixtureDatabase(db: string) {
  if (!/^crm_preflight_[a-f0-9]{32}_(source|restore|ledger|cli)$/.test(db)) throw new Error('SYNTHETIC_LOCAL_DATABASE_ONLY');
}
export function sql(db: string, query: string): string {
  assertFixtureDatabase(db);
  return execFileSync('docker', ['exec','-i',CONTAINER,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',db], {
    input: query, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['pipe','pipe','pipe'], timeout: 90_000,
  }).trim();
}
export function createFixtureDatabase(db: string) {
  assertFixtureDatabase(db);
  execFileSync('docker',['exec',CONTAINER,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres','-c',`CREATE DATABASE ${db};`], { stdio: ['ignore','pipe','pipe'] });
}
export function dropFixtureDatabase(db: string) {
  assertFixtureDatabase(db);
  execFileSync('docker',['exec',CONTAINER,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres','-c',`DROP DATABASE ${db} WITH (FORCE);`],{stdio:['ignore','pipe','pipe']});
}
export function sqlAsync(db: string, query: string): Promise<string> {
  assertFixtureDatabase(db);
  return new Promise((resolve,reject) => {
    const p=spawn('docker',['exec','-i',CONTAINER,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],{timeout:90_000});
    let output='',error=''; p.stdout.on('data',c=>output+=c);p.stderr.on('data',c=>error+=c);p.on('error',reject);
    p.on('close',code=>code===0?resolve(output.trim()):reject(new Error(error)));
    p.stdin.end(query);
  });
}
export function dumpFixture(db: string): Buffer {
  assertFixtureDatabase(db);
  return execFileSync('docker',['exec',CONTAINER,'pg_dump','-Fc','--no-owner','-U','postgres','-d',db],{maxBuffer:32*1024*1024,stdio:['ignore','pipe','pipe']});
}
export function restoreFixture(db: string, archive: Buffer) {
  assertFixtureDatabase(db);
  // No --clean, DROP, reset, repair or production target. Target was just created.
  execFileSync('docker',['exec','-i',CONTAINER,'pg_restore','--exit-on-error','--single-transaction','--no-owner','-U','postgres','-d',db],{input:archive,maxBuffer:32*1024*1024,stdio:['pipe','pipe','pipe']});
}
export const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function setupFixtureLedger(db: string) {
  sql(db,`CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,statements text[],name text);
    CREATE SCHEMA rehearsal_private;
    REVOKE ALL ON SCHEMA rehearsal_private FROM PUBLIC,anon,authenticated;
    CREATE TABLE rehearsal_private.source_mapping(canonical_version text PRIMARY KEY,ledger_version text UNIQUE NOT NULL,
      name text NOT NULL,source_sha256 text NOT NULL,statement_count integer NOT NULL,synthetic boolean NOT NULL CHECK(synthetic));`);
}
export async function applySyntheticMigration(db: string, input: {canonical: string; ledger: string; name: string; sql: string; expectedHash: string; predecessor: string|null}) {
  assertFixtureDatabase(db);
  if (!input.name.startsWith('synthetic_') || !/^\d{14}$/.test(input.canonical) || !/^\d{14}$/.test(input.ledger)) throw new Error('SYNTHETIC_MIGRATION_ONLY');
  if (sqlSha256(input.sql)!==input.expectedHash) throw new Error('SOURCE_HASH_MISMATCH');
  const envelope=inspectTransactionEnvelope(input.sql);
  if (envelope.mode==='REJECT' || envelope.destructive) throw new Error('UNSUPPORTED_TRANSACTION_OR_DESTRUCTIVE_SQL');
  if (envelope.statements.some(s=>! /^(BEGIN\b|COMMIT\b|START TRANSACTION\b|CREATE TABLE\b|CREATE INDEX\b|INSERT\b|UPDATE\b|SELECT\b|ALTER TABLE\b)/.test(s.head))) throw new Error('SYNTHETIC_STATEMENT_NOT_ALLOWLISTED');
  const {canonical,ledger,name,expectedHash}=input;
  const guard=`SET LOCAL application_name=${quote('synthetic_migration_'+canonical)};
    SELECT pg_advisory_xact_lock(61706339);
    DO $guard$ BEGIN
      IF EXISTS(SELECT 1 FROM rehearsal_private.source_mapping m FULL JOIN supabase_migrations.schema_migrations h ON h.version=m.ledger_version
        WHERE m.canonical_version IS NULL OR h.version IS NULL OR m.name IS DISTINCT FROM h.name
          OR m.source_sha256 IS DISTINCT FROM encode(sha256(convert_to(array_to_string(h.statements,E'\\n'),'UTF8')),'hex')) THEN RAISE EXCEPTION 'LEDGER_MAPPING_INCONSISTENT'; END IF;
      IF EXISTS(SELECT 1 FROM rehearsal_private.source_mapping WHERE canonical_version=${quote(canonical)} AND source_sha256<>${quote(expectedHash)}) THEN RAISE EXCEPTION 'LEDGER_HASH_CONFLICT'; END IF;
      IF EXISTS(SELECT 1 FROM rehearsal_private.source_mapping WHERE canonical_version=${quote(canonical)} AND (ledger_version<>${quote(ledger)} OR name<>${quote(name)})) THEN RAISE EXCEPTION 'LEDGER_IDENTITY_CONFLICT'; END IF;
      IF EXISTS(SELECT 1 FROM rehearsal_private.source_mapping WHERE canonical_version=${quote(canonical)}) THEN RAISE EXCEPTION 'ALREADY_APPLIED'; END IF;
      IF EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version=${quote(ledger)}) THEN RAISE EXCEPTION 'LEDGER_VERSION_COLLISION'; END IF;
      IF (SELECT max(canonical_version) FROM rehearsal_private.source_mapping) IS DISTINCT FROM ${input.predecessor===null?'NULL::text':quote(input.predecessor)} THEN RAISE EXCEPTION 'PREDECESSOR_MISMATCH'; END IF;
    END $guard$;`;
  const record=`INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES(${quote(ledger)},${quote(name)},ARRAY[${quote(input.sql)}]);
    INSERT INTO rehearsal_private.source_mapping VALUES(${quote(canonical)},${quote(ledger)},${quote(name)},${quote(expectedHash)},${envelope.statements.length},true);`;
  // Every original statement is kept byte-for-byte. Instrumentation is inserted
  // after original BEGIN/before original COMMIT, or an outer transaction is added.
  let script: string;
  if(envelope.mode==='OUTER') {
    const first=envelope.statements[0],last=envelope.statements.at(-1)!;
    script=input.sql.slice(0,first.end)+'\n'+guard+'\n'+input.sql.slice(first.end,last.start)+'\n'+record+'\n'+input.sql.slice(last.start);
  } else script='BEGIN;\n'+guard+'\n'+input.sql+'\n'+record+'\nCOMMIT;';
  try { await sqlAsync(db,script);return 'APPLIED' as const; }
  catch(error) { if(error instanceof Error && error.message.includes('ALREADY_APPLIED'))return 'ALREADY_APPLIED' as const;throw error; }
}
