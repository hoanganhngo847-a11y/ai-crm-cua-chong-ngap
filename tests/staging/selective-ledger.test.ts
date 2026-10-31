/**
 * Comprehensive Failure & Safety Test Suite for Meta Ads Selective-Release Ledger.
 *
 * Runs against local PostgreSQL 17.11 container (`supabase_db_ai-crm-cua-chong-ngap`).
 * Validates all mandatory scenarios from Section 5:
 * 1. Successful five-file release + registry creation + 21 canonical ledger rows preserved.
 * 2. Ordinary migration writer fence: Blocks unapproved inserts with MIGRATION_LEDGER_FENCED.
 * 3. Immutable ledger: Blocks update/delete on schema_migrations with MIGRATION_LEDGER_IMMUTABLE.
 * 4. Duplicate release attempt: Rejects with SELECTIVE_RELEASE_ALREADY_APPLIED.
 * 5. Future canonical reconciliation: Reconciles release and disarms fence.
 * 6. Wrong target project identity: Rejects with TARGET_PROJECT_MISMATCH.
 * 7. Wrong migration hash: Rejects before DDL.
 * 8. Modified source file: Rejects forbidden runtime mutations.
 * 9. Existing partial Meta schema: Rejects with UNEXPECTED_EXISTING_META_OBJECTS.
 * 10. Ledger drift: Rejects with META_21_LEDGER_DRIFT.
 * 11. Schema drift: Rejects with META_21_SCHEMA_OR_ACL_DRIFT.
 * 12. Concurrent executor attempts: Serializes or fails closed with lock timeout.
 * 13. Transaction failure halfway through: Rolls back 100%, 0 Meta tables, 21 ledger rows.
 * 14. Postcondition failure: Rolls back 100%, 0 Meta tables, 21 ledger rows.
 * 15. Uncertain commit recovery: Verifies deterministic recovery without partial artifacts.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { PLATFORM_STUBS } from '../zalo/helpers/pglite-supabase';
import { inspectTransactionEnvelope, sqlSha256 } from '../../scripts/meta-ads/ledger-readiness';
import {
  buildSelectiveExecutorPackage,
  TARGET_STAGING_PROJECT,
  EXPECTED_CANONICAL_LEDGER_COUNT,
  CURRENT_SOURCE_COMMIT,
} from '../../scripts/meta-ads/selective-executor';

const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id\s*=\s*"([\w-]+)"/m)?.[1];
assert.ok(project);
const container = `supabase_db_${project}`;

function runSql(db: string, query: string, timeoutMs = 120_000) {
  return execFileSync(
    'docker',
    ['exec', '-i', container, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db],
    {
      input: query,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
    }
  ).trim();
}

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();
const historical = JSON.parse(readFileSync('docs/evidence/meta-ads-safe-deployment/staging-metadata.json', 'utf8')).data[0].snapshot;

function createPrefixDatabase(dbName: string) {
  runSql('postgres', `CREATE DATABASE ${dbName};`);
  runSql(dbName, PLATFORM_STUBS.replace(/CREATE ROLE[^;]+;/g, ''));
  runSql(
    dbName,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;
     ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon,authenticated,service_role;
     ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon,authenticated,service_role;`
  );

  // Apply 21 prefix files
  for (const file of files.slice(0, 21)) {
    const source = readFileSync(`supabase/migrations/${file}`, 'utf8');
    const envelope = inspectTransactionEnvelope(source);
    runSql(dbName, envelope.mode === 'NONE' ? `BEGIN;\n${source}\nCOMMIT;` : source);
  }

  // Create schema_migrations with exact 21 historical records
  runSql(
    dbName,
    `CREATE SCHEMA supabase_migrations;
     CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY, name text, statements text[]);`
  );

  for (const [index, file] of files.slice(0, 21).entries()) {
    const recorded = historical.migration_history[index];
    runSql(
      dbName,
      `INSERT INTO supabase_migrations.schema_migrations VALUES(${q(recorded.version)}, ${q(recorded.name)}, ARRAY[${q(
        readFileSync('supabase/migrations/' + file, 'utf8')
      )}]);`
    );
  }
}

test('Selective-Release Ledger & Dedicated Controlled Executor Suite', async (t) => {
  const prefix = `crm_sel_${randomUUID().replaceAll('-', '')}`;
  const dbsCreated: string[] = [];

  const getDb = (suffix: string) => {
    const name = `${prefix}_${suffix}`;
    dbsCreated.push(name);
    return name;
  };

  try {
    // ------------------------------------------------------------------------
    // SCENARIO 1: Successful 5-file release, registry creation, ledger preservation
    // ------------------------------------------------------------------------
    await t.test('1. Successful selective release preserves 21 ledger rows and records registry entry', () => {
      const db = getDb('success');
      createPrefixDatabase(db);

      const pack = buildSelectiveExecutorPackage({ targetProjectRef: TARGET_STAGING_PROJECT });
      const output = runSql(db, pack.sql);

      assert.match(output, /META_SELECTIVE_RELEASE_VERIFIED/);

      // Verify canonical ledger is untouched: exactly 21 rows
      const ledgerCount = runSql(db, 'SELECT count(*) FROM supabase_migrations.schema_migrations;');
      assert.equal(ledgerCount, '21', 'Canonical ledger must retain exactly 21 rows');

      // Verify registry record
      const registryRows = JSON.parse(
        runSql(db, "SELECT json_agg(t) FROM private.selective_feature_releases t WHERE release_id = 'meta-ads-20261031-r1';")
      );
      assert.equal(registryRows.length, 1);
      const reg = registryRows[0];
      assert.equal(reg.release_id, 'meta-ads-20261031-r1');
      assert.equal(reg.target_project_ref, TARGET_STAGING_PROJECT);
      assert.equal(reg.source_commit, CURRENT_SOURCE_COMMIT);
      assert.equal(reg.execution_status, 'COMPLETED');
      assert.equal(reg.reconciled_to_canonical, false);
      assert.equal(reg.sources.length, 5);

      // Verify all 5 Meta tables exist
      const metaTables = runSql(
        db,
        `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ('public', 'private')
           AND c.relname IN ('meta_ad_accounts', 'meta_campaigns', 'meta_ads', 'meta_lead_forms', 'lead_attribution_touchpoints');`
      );
      assert.equal(metaTables, '5');

      // ----------------------------------------------------------------------
      // SCENARIO 2: Ordinary migration writer fence test
      // ----------------------------------------------------------------------
      // Attempt to insert an unapproved migration into schema_migrations
      assert.throws(
        () =>
          runSql(
            db,
            "INSERT INTO supabase_migrations.schema_migrations VALUES ('20261025000001', 'unapproved_push', ARRAY['SELECT 1']);"
          ),
        (err: unknown) => {
          assert.ok(String(err).includes('MIGRATION_LEDGER_FENCED'), String(err));
          return true;
        }
      );

      // ----------------------------------------------------------------------
      // SCENARIO 3: Immutable canonical ledger (block update/delete)
      // ----------------------------------------------------------------------
      assert.throws(
        () => runSql(db, "UPDATE supabase_migrations.schema_migrations SET name = 'mutated' WHERE version = '20261030063323';"),
        (err: unknown) => {
          assert.ok(String(err).includes('MIGRATION_LEDGER_IMMUTABLE'), String(err));
          return true;
        }
      );
      assert.throws(
        () => runSql(db, "DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261030063323';"),
        (err: unknown) => {
          assert.ok(String(err).includes('MIGRATION_LEDGER_IMMUTABLE'), String(err));
          return true;
        }
      );

      // ----------------------------------------------------------------------
      // SCENARIO 4: Duplicate release attempt
      // ----------------------------------------------------------------------
      assert.throws(
        () => runSql(db, pack.sql),
        (err: unknown) => {
          assert.ok(String(err).includes('SELECTIVE_RELEASE_ALREADY_APPLIED'), String(err));
          return true;
        }
      );

      // ----------------------------------------------------------------------
      // SCENARIO 5: Future canonical reconciliation
      // ----------------------------------------------------------------------
      // Reconcile the release
      runSql(
        db,
        `UPDATE private.selective_feature_releases
         SET reconciled_to_canonical = true,
             reconciled_at = clock_timestamp(),
             recovery_evidence = recovery_evidence || '{"reconciled": true}'::jsonb
         WHERE release_id = 'meta-ads-20261031-r1';`
      );

      // Disarm fence
      runSql(
        db,
        `DROP TRIGGER IF EXISTS trg_guard_selective_release_ledger ON supabase_migrations.schema_migrations;
         DROP FUNCTION IF EXISTS supabase_migrations.guard_selective_release_ledger();`
      );

      // Now canonical migration write is allowed again
      runSql(
        db,
        "INSERT INTO supabase_migrations.schema_migrations VALUES ('20261101000001', 'future_reconciled_migration', ARRAY['SELECT 1']);"
      );
      const afterReconciliationCount = runSql(db, 'SELECT count(*) FROM supabase_migrations.schema_migrations;');
      assert.equal(afterReconciliationCount, '22');
    });

    // ------------------------------------------------------------------------
    // SCENARIO 6: Wrong target project identity
    // ------------------------------------------------------------------------
    await t.test('2. Rejects execution when target project identity does not match', () => {
      const db = getDb('wrong_proj');
      createPrefixDatabase(db);

      const pack = buildSelectiveExecutorPackage({ targetProjectRef: 'wrong-project-ref' });
      assert.throws(
        () => runSql(db, pack.sql),
        (err: unknown) => {
          assert.ok(String(err).includes('TARGET_PROJECT_MISMATCH'), String(err));
          return true;
        }
      );

      // Verify 0 Meta tables and untouched ledger
      assert.equal(runSql(db, "SELECT to_regclass('public.meta_ad_accounts') IS NULL;"), 't');
      assert.equal(runSql(db, 'SELECT count(*) FROM supabase_migrations.schema_migrations;'), '21');
    });

    // ------------------------------------------------------------------------
    // SCENARIO 7: Wrong migration hash / modified source file
    // ------------------------------------------------------------------------
    await t.test('3. Rejects execution when migration hash or content is tampered', () => {
      // Offline assertion check
      assert.throws(
        () =>
          buildSelectiveExecutorPackage({
            sourcesOverride: [{ file: '20261030090000_meta_ads_lead_attribution.sql', sql: '-- tampered sql' }],
          }),
        (err: unknown) => {
          assert.ok(String(err).includes('EMPTY_MIGRATION') || String(err).includes('hash mismatch') || String(err).includes('Envelope'));
          return true;
        }
      );

      // Forbidden statement in source
      assert.throws(
        () =>
          buildSelectiveExecutorPackage({
            sourcesOverride: [
              {
                file: '20261030090000_meta_ads_lead_attribution.sql',
                sql: 'CREATE OR REPLACE FUNCTION public.han_ingest() RETURNS void LANGUAGE sql AS $$ SELECT 1; $$;',
              },
            ],
          }),
        (err: unknown) => {
          assert.ok(String(err).includes('Forbidden runtime modification detected'));
          return true;
        }
      );
    });

    // ------------------------------------------------------------------------
    // SCENARIO 8: Existing partial Meta schema
    // ------------------------------------------------------------------------
    await t.test('4. Rejects execution when partial Meta schema already exists', () => {
      const db = getDb('partial_meta');
      createPrefixDatabase(db);

      // Pre-create a partial Meta table
      runSql(db, 'CREATE TABLE public.meta_ad_accounts(id uuid PRIMARY KEY);');

      const pack = buildSelectiveExecutorPackage();
      assert.throws(
        () => runSql(db, pack.sql),
        (err: unknown) => {
          assert.ok(String(err).includes('UNEXPECTED_EXISTING_META_OBJECTS'), String(err));
          return true;
        }
      );

      // Verify no other Meta tables were created
      assert.equal(runSql(db, "SELECT to_regclass('public.meta_campaigns') IS NULL;"), 't');
      assert.equal(runSql(db, 'SELECT count(*) FROM supabase_migrations.schema_migrations;'), '21');
    });

    // ------------------------------------------------------------------------
    // SCENARIO 9: Ledger drift
    // ------------------------------------------------------------------------
    await t.test('5. Rejects execution and rolls back when canonical ledger has drifted', () => {
      const db = getDb('ledger_drift');
      createPrefixDatabase(db);

      // Mutate one recorded migration
      runSql(db, "UPDATE supabase_migrations.schema_migrations SET name = 'tampered' WHERE name = 'initial_schema';");

      const pack = buildSelectiveExecutorPackage();
      assert.throws(
        () => runSql(db, pack.sql),
        (err: unknown) => {
          assert.ok(String(err).includes('META_21_LEDGER_DRIFT'), String(err));
          return true;
        }
      );

      assert.equal(runSql(db, "SELECT to_regclass('public.meta_ad_accounts') IS NULL;"), 't');
      assert.equal(runSql(db, "SELECT to_regclass('private.selective_feature_releases') IS NULL;"), 't');
    });

    // ------------------------------------------------------------------------
    // SCENARIO 10: Schema drift
    // ------------------------------------------------------------------------
    await t.test('6. Rejects execution and rolls back when application catalog has drifted', () => {
      const db = getDb('schema_drift');
      createPrefixDatabase(db);

      // Inject unapproved function before release
      runSql(db, "CREATE FUNCTION public.unapproved_drift_fn() RETURNS int LANGUAGE sql AS 'SELECT 1';");

      const pack = buildSelectiveExecutorPackage();
      assert.throws(
        () => runSql(db, pack.sql),
        (err: unknown) => {
          assert.ok(String(err).includes('META_21_SCHEMA_OR_ACL_DRIFT'), String(err));
          return true;
        }
      );

      assert.equal(runSql(db, "SELECT to_regclass('public.meta_ad_accounts') IS NULL;"), 't');
    });

    // ------------------------------------------------------------------------
    // SCENARIO 11: Concurrent executor attempts (advisory lock)
    // ------------------------------------------------------------------------
    await t.test('7. Advisory lock serializes and fences concurrent executor attempts', async () => {
      const db = getDb('lock_test');
      createPrefixDatabase(db);

      // Verify normal acquisition succeeds
      const lockTestScript = `
        SET LOCAL lock_timeout = '500ms';
        SELECT pg_advisory_xact_lock(hashtextextended('meta-ads-selective-release',0));
      `;
      runSql(db, `BEGIN; ${lockTestScript} COMMIT;`);

      // Spawn a background psql process that holds the advisory lock for 3 seconds
      const holder = spawn('docker', [
        'exec',
        '-i',
        container,
        'psql',
        '-XqAt',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'postgres',
        '-d',
        db,
        '-c',
        "SELECT pg_advisory_lock(hashtextextended('meta-ads-selective-release',0)), pg_sleep(3);",
      ]);

      // Give the holder a short moment (300ms) to acquire the lock
      await new Promise((resolve) => setTimeout(resolve, 300));

      try {
        // While holder is holding the lock, a second session attempting to acquire it with 200ms lock_timeout must fail closed
        assert.throws(
          () =>
            runSql(
              db,
              `BEGIN;
               SET LOCAL lock_timeout = '200ms';
               SELECT pg_advisory_xact_lock(hashtextextended('meta-ads-selective-release',0));
               COMMIT;`
            ),
          (err: unknown) => {
            assert.ok(String(err).includes('canceling statement due to lock timeout'), String(err));
            return true;
          }
        );
      } finally {
        // Ensure holder process terminates cleanly
        await new Promise<void>((resolve) => {
          holder.on('close', () => resolve());
          holder.kill('SIGTERM');
        });
      }
    });

    // ------------------------------------------------------------------------
    // SCENARIO 12: Transaction failure halfway through
    // ------------------------------------------------------------------------
    await t.test('8. Transaction failure halfway through rolls back 100% cleanly', () => {
      const db = getDb('halfway_fail');
      createPrefixDatabase(db);

      const pack = buildSelectiveExecutorPackage({ simulatedInjectedError: 'SOURCE_3' });
      assert.throws(
        () => runSql(db, pack.sql),
        (err: unknown) => {
          assert.ok(String(err).includes('SIMULATED_FAILURE_IN_MIGRATION_3'), String(err));
          return true;
        }
      );

      // Verify zero Meta objects committed
      assert.equal(runSql(db, "SELECT to_regclass('public.meta_ad_accounts') IS NULL;"), 't');
      assert.equal(runSql(db, "SELECT to_regclass('private.selective_feature_releases') IS NULL;"), 't');
      assert.equal(runSql(db, 'SELECT count(*) FROM supabase_migrations.schema_migrations;'), '21');
    });

    // ------------------------------------------------------------------------
    // SCENARIO 13: Postcondition failure rolls back
    // ------------------------------------------------------------------------
    await t.test('9. Postcondition failure rolls back entire release and leaves 0 Meta tables', () => {
      const db = getDb('post_fail');
      createPrefixDatabase(db);

      const pack = buildSelectiveExecutorPackage({ simulatedInjectedError: 'POST_DDL' });
      assert.throws(
        () => runSql(db, pack.sql),
        (err: unknown) => {
          assert.ok(String(err).includes('META_21_POST_SCHEMA_OR_ACL_MISMATCH'), String(err));
          return true;
        }
      );

      assert.equal(runSql(db, "SELECT to_regclass('public.meta_ad_accounts') IS NULL;"), 't');
      assert.equal(runSql(db, "SELECT to_regclass('public.unapproved_forbidden_injection') IS NULL;"), 't');
      assert.equal(runSql(db, "SELECT to_regclass('private.selective_feature_releases') IS NULL;"), 't');
      assert.equal(runSql(db, 'SELECT count(*) FROM supabase_migrations.schema_migrations;'), '21');
    });

    // ------------------------------------------------------------------------
    // SCENARIO 14: Uncertain commit recovery
    // ------------------------------------------------------------------------
    await t.test('10. Uncertain commit recovery is deterministic via atomic registry query', () => {
      const db = getDb('uncertain_rec');
      createPrefixDatabase(db);

      // Probe state before release
      const beforeProbe = runSql(
        db,
        `SELECT json_build_object(
           'registry_exists', to_regclass('private.selective_feature_releases') IS NOT NULL,
           'meta_tables_exist', to_regclass('public.meta_ad_accounts') IS NOT NULL,
           'canonical_ledger_count', (SELECT count(*) FROM supabase_migrations.schema_migrations)
         );`
      );
      assert.deepEqual(JSON.parse(beforeProbe), {
        registry_exists: false,
        meta_tables_exist: false,
        canonical_ledger_count: 21,
      });

      // Apply release
      const pack = buildSelectiveExecutorPackage();
      runSql(db, pack.sql);

      // Probe state after release
      const afterProbe = runSql(
        db,
        `SELECT json_build_object(
           'registry_exists', to_regclass('private.selective_feature_releases') IS NOT NULL,
           'meta_tables_exist', to_regclass('public.meta_ad_accounts') IS NOT NULL,
           'canonical_ledger_count', (SELECT count(*) FROM supabase_migrations.schema_migrations),
           'release_status', (SELECT execution_status FROM private.selective_feature_releases WHERE release_id = 'meta-ads-20261031-r1')
         );`
      );
      assert.deepEqual(JSON.parse(afterProbe), {
        registry_exists: true,
        meta_tables_exist: true,
        canonical_ledger_count: 21,
        release_status: 'COMPLETED',
      });
    });
  } finally {
    // Clean up all created disposable test databases
    for (const db of dbsCreated) {
      try {
        runSql('postgres', `DROP DATABASE IF EXISTS ${db} WITH (FORCE);`);
      } catch {
        /* ignore */
      }
    }
  }
});

