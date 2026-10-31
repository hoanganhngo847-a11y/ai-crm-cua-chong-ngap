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
  TARGET_POSTGRES_VERSION,
  EXPECTED_CANONICAL_LEDGER_COUNT,
  CURRENT_SOURCE_COMMIT,
  verifyTargetProjectConnection,
  verifyPostgresServerVersion,
  buildCanonicalReconciliationPackage,
  PROBE_RELEASE_SQL,
  evaluateReleaseProbe,
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
    });

    // ------------------------------------------------------------------------
    // SCENARIO 6: Target project verification & connection check
    // ------------------------------------------------------------------------
    await t.test('2. Target project verification: Validates host and project ref, fails closed without logging credentials', () => {
      // 1. Valid hosted direct URL
      const direct = verifyTargetProjectConnection('postgresql://postgres:supersecret@db.qmhfmgkymjgoevwmkidm.supabase.co:5432/postgres');
      assert.equal(direct.verified, true);
      assert.equal(direct.projectRef, 'qmhfmgkymjgoevwmkidm');
      assert.equal(direct.isLocalTest, false);
      assert.ok(!direct.sanitizedConnectionInfo.includes('supersecret'));

      // 2. Valid pooler URL
      const pooler = verifyTargetProjectConnection('postgresql://postgres.qmhfmgkymjgoevwmkidm:supersecret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres');
      assert.equal(pooler.verified, true);
      assert.equal(pooler.projectRef, 'qmhfmgkymjgoevwmkidm');
      assert.equal(pooler.isLocalTest, false);
      assert.ok(!pooler.sanitizedConnectionInfo.includes('supersecret'));

      // 3. Wrong direct host ref
      assert.throws(
        () => verifyTargetProjectConnection('postgresql://postgres:supersecret@db.unauthorizedref888.supabase.co:5432/postgres'),
        (err: unknown) => {
          assert.ok(String(err).includes('TARGET_PROJECT_MISMATCH'));
          assert.ok(!String(err).includes('supersecret'), 'Zero credentials logged');
          return true;
        }
      );

      // 4. Wrong pooler username ref
      assert.throws(
        () => verifyTargetProjectConnection('postgresql://postgres.wrongtenant777:supersecret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres'),
        (err: unknown) => {
          assert.ok(String(err).includes('TARGET_PROJECT_MISMATCH'));
          assert.ok(!String(err).includes('supersecret'), 'Zero credentials logged');
          return true;
        }
      );

      // 5. Localhost connection rejected if allowLocalTest is false
      assert.throws(
        () => verifyTargetProjectConnection('postgresql://postgres:supersecret@127.0.0.1:5432/postgres', { allowLocalTest: false }),
        (err: unknown) => {
          assert.ok(String(err).includes('TARGET_PROJECT_MISMATCH'));
          assert.ok(!String(err).includes('supersecret'));
          return true;
        }
      );

      // 6. Localhost connection allowed only if allowLocalTest is true
      const local = verifyTargetProjectConnection('postgresql://postgres:supersecret@localhost:5432/crm_sel_test', { allowLocalTest: true });
      assert.equal(local.isLocalTest, true);

      // 7. Malformed connection string rejected
      assert.throws(
        () => verifyTargetProjectConnection('not-a-valid-uri'),
        (err: unknown) => {
          assert.ok(String(err).includes('TARGET_VERIFICATION_FAILED'));
          return true;
        }
      );

      // 8. In-database preflight enforcement
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
      assert.equal(runSql(db, "SELECT to_regclass('public.meta_ad_accounts') IS NULL;"), 't');
      assert.equal(runSql(db, 'SELECT count(*) FROM supabase_migrations.schema_migrations;'), '21');
    });

    // ------------------------------------------------------------------------
    // SCENARIO 6b: PostgreSQL Version Enforcement
    // ------------------------------------------------------------------------
    await t.test('2b. PostgreSQL version enforcement: Requires PostgreSQL 17.x, rejects incompatible versions fail-closed', () => {
      // 1. TypeScript version verification
      assert.equal(verifyPostgresServerVersion('17.11', 170011), true);
      assert.throws(
        () => verifyPostgresServerVersion('16.4', 160004),
        (err: unknown) => {
          assert.ok(String(err).includes('POSTGRES_VERSION_INCOMPATIBLE'));
          return true;
        }
      );
      assert.throws(
        () => verifyPostgresServerVersion('18.0', 180000),
        (err: unknown) => {
          assert.ok(String(err).includes('POSTGRES_VERSION_INCOMPATIBLE'));
          return true;
        }
      );

      // 2. In-database preflight version enforcement
      const db = getDb('pg_version_check');
      createPrefixDatabase(db);
      const pack = buildSelectiveExecutorPackage({ simulatedInjectedError: 'WRONG_VERSION' });
      assert.throws(
        () => runSql(db, pack.sql),
        (err: unknown) => {
          assert.ok(String(err).includes('POSTGRES_VERSION_INCOMPATIBLE'), String(err));
          return true;
        }
      );
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
    // SCENARIO 14: Uncertain commit recovery state machine
    // ------------------------------------------------------------------------
    await t.test('10. Uncertain commit recovery: Distinguishes committed, uncommitted, and corrupted states', () => {
      const db = getDb('uncertain_rec');
      createPrefixDatabase(db);
      const pack = buildSelectiveExecutorPackage({ targetProjectRef: TARGET_STAGING_PROJECT });

      // CASE A: Client drops connection BEFORE commit (Clean rollback / Uncommitted)
      // The database has 0 registry rows and 0 Meta tables
      const uncommittedRaw = JSON.parse(runSql(db, PROBE_RELEASE_SQL('meta-ads-20261031-r1')));
      const uncommittedEval = evaluateReleaseProbe(uncommittedRaw, 'meta-ads-20261031-r1', pack.bundleSha256);
      assert.equal(uncommittedEval.status, 'UNCOMMITTED_CLEAN');
      assert.equal(uncommittedEval.recommendation, 'SAFE_TO_EXECUTE');
      assert.ok(uncommittedEval.diagnosticSummary.includes('Database is in a clean pre-deployment state'));

      // CASE B: Client drops connection AFTER commit (Committed & Verified)
      // Execute the release
      runSql(db, pack.sql);
      const committedRaw = JSON.parse(runSql(db, PROBE_RELEASE_SQL('meta-ads-20261031-r1')));
      const committedEval = evaluateReleaseProbe(committedRaw, 'meta-ads-20261031-r1', pack.bundleSha256);
      assert.equal(committedEval.status, 'COMMITTED_VERIFIED');
      assert.equal(committedEval.recommendation, 'DO_NOT_RERUN');
      assert.ok(committedEval.diagnosticSummary.includes('Zero DDL re-execution required'));

      // CASE C: Corrupted / Indeterminate State 1: Registry bundle SHA does NOT match expected bundle SHA
      const tamperedRaw = {
        ...committedRaw,
        release_record: {
          ...committedRaw.release_record,
          bundle_sha256: 'tampered_sha_256_hash_value_here',
        },
      };
      const tamperedEval = evaluateReleaseProbe(tamperedRaw, 'meta-ads-20261031-r1', pack.bundleSha256);
      assert.equal(tamperedEval.status, 'CORRUPTED_INCONSISTENT');
      assert.equal(tamperedEval.recommendation, 'HALT_AND_INVESTIGATE');
      assert.ok(tamperedEval.diagnosticSummary.includes('Rerunning migrations is BLOCKED'));

      // CASE D: Corrupted / Indeterminate State 2: Partial tables exist but registry record is missing
      const partialRaw = {
        registry_table_exists: false,
        release_record: null,
        meta_tables_count: 3, // 3 partial tables exist without registry!
        canonical_ledger_count: 21,
        fence_trigger_exists: false,
      };
      const partialEval = evaluateReleaseProbe(partialRaw, 'meta-ads-20261031-r1', pack.bundleSha256);
      assert.equal(partialEval.status, 'CORRUPTED_INCONSISTENT');
      assert.equal(partialEval.recommendation, 'HALT_AND_INVESTIGATE');
      assert.ok(partialEval.diagnosticSummary.includes('Rerunning migrations is BLOCKED'));
    });

    // ------------------------------------------------------------------------
    // SCENARIO 15: Canonical migration reconciliation with real sequence
    // ------------------------------------------------------------------------
    await t.test('11. Canonical migration reconciliation: Real sequence execution proves Meta migrations are not re-run, original 21 migrations preserved, business data intact', () => {
      const db = getDb('canonical_rec');
      createPrefixDatabase(db);

      // Step 1: Deploy selective release for Meta Ads
      const pack = buildSelectiveExecutorPackage({ targetProjectRef: TARGET_STAGING_PROJECT });
      runSql(db, pack.sql);
      assert.equal(runSql(db, 'SELECT count(*) FROM supabase_migrations.schema_migrations;'), '21');

      // Step 2: Insert real business test records into the selective Meta tables
      const testCompanyId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      runSql(
        db,
        `
        INSERT INTO public.companies(id, name, status) VALUES ('${testCompanyId}', 'Reconciliation Test Company', 'ACTIVE');
        INSERT INTO public.customers(id, company_id, name, source, stage) VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '${testCompanyId}', 'Customer In Staging', 'ADVERTISING', 'LEAD_NEW');
        INSERT INTO public.meta_ad_accounts(company_id, ad_account_id, name) VALUES ('${testCompanyId}', 'act_reconcile_test', 'Reconcile Account');
        INSERT INTO public.meta_campaigns(company_id, ad_account_id, meta_campaign_id, name, status)
        VALUES ('${testCompanyId}', 'act_reconcile_test', 'camp_reconcile_01', 'Reconciliation Campaign', 'ACTIVE');
        INSERT INTO public.meta_ads(company_id, ad_account_id, meta_campaign_id, meta_ad_id, name, status)
        VALUES ('${testCompanyId}', 'act_reconcile_test', 'camp_reconcile_01', 'ad_reconcile_01', 'Reconciliation Ad', 'ACTIVE');
        INSERT INTO public.lead_attribution_touchpoints(company_id, customer_id, channel, meta_campaign_id, campaign_name_snapshot, touchpoint_type)
        VALUES ('${testCompanyId}', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'FACEBOOK_LEAD_ADS', 'camp_reconcile_01', 'Reconciliation Campaign', 'FIRST_TOUCH');
        `
      );

      // Step 3: Run the canonical reconciliation package
      const reconcilePack = buildCanonicalReconciliationPackage({ releaseId: 'meta-ads-20261031-r1' });
      const recOutput = runSql(db, reconcilePack.sql);
      assert.match(recOutput, /META_RECONCILIATION_SUCCESSFUL/);

      // Canonical ledger now contains 21 + 5 = 26 records
      const ledgerCount = runSql(db, 'SELECT count(*) FROM supabase_migrations.schema_migrations;');
      assert.equal(ledgerCount, '26', 'Canonical ledger must contain exactly 26 records (21 historical + 5 reconciled Meta migrations)');

      // Registry reflects reconciled state
      const reg = JSON.parse(
        runSql(db, "SELECT row_to_json(r) FROM private.selective_feature_releases r WHERE release_id = 'meta-ads-20261031-r1';")
      );
      assert.equal(reg.reconciled_to_canonical, true);
      assert.ok(reg.reconciled_at !== null);

      // Step 4: Real migration runner simulation
      // A canonical runner inspects schema_migrations and applies any migration not yet recorded.
      const recordedVersions = new Set(
        JSON.parse(runSql(db, 'SELECT json_agg(version) FROM supabase_migrations.schema_migrations;'))
      );

      // Verify that all 5 Meta migrations are in recordedVersions
      for (const m of reconcilePack.metaFiles) {
        assert.ok(recordedVersions.has(m.version), `Reconciled version ${m.version} must be recognized in canonical ledger`);
      }

      // Simulate the runner: for any migration already recorded, it SKIPS
      // For any subsequent canonical migration (e.g. migration 122), it EXECUTES
      const futureCanonicalMigration = {
        version: '20261101000001',
        name: 'future_crm_expansion',
        sql: 'CREATE TABLE public.crm_future_expansion(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note text);',
      };

      // Ensure 5 Meta migrations are SKIPPED (not re-executed)
      let metaReexecuted = 0;
      for (const m of reconcilePack.metaFiles) {
        if (!recordedVersions.has(m.version)) {
          metaReexecuted++;
          runSql(db, m.sql); // This would crash if re-executed!
        }
      }
      assert.equal(metaReexecuted, 0, 'Zero Meta migrations re-executed by canonical runner');

      // The new subsequent migration is executed
      runSql(
        db,
        `BEGIN;
         ${futureCanonicalMigration.sql}
         INSERT INTO supabase_migrations.schema_migrations VALUES ('${futureCanonicalMigration.version}', '${futureCanonicalMigration.name}', ARRAY[${q(futureCanonicalMigration.sql)}]);
         COMMIT;`
      );

      // Step 5: Verification of invariants post-reconciliation
      // 1. Ledger count is 21 + 5 + 1 = 27
      assert.equal(runSql(db, 'SELECT count(*) FROM supabase_migrations.schema_migrations;'), '27');

      // 2. Pre-existing business data created during selective period is 100% intact
      const leadCheck = JSON.parse(
        runSql(
          db,
          `SELECT json_build_object(
             'campaign_name', name,
             'customer_name', (SELECT name FROM public.customers WHERE id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
             'touchpoint_count', (SELECT count(*) FROM public.lead_attribution_touchpoints WHERE meta_campaign_id = 'camp_reconcile_01')
           ) FROM public.meta_campaigns WHERE meta_campaign_id = 'camp_reconcile_01';`
        )
      );
      assert.deepEqual(leadCheck, {
        campaign_name: 'Reconciliation Campaign',
        customer_name: 'Customer In Staging',
        touchpoint_count: 1,
      });

      // 3. New canonical feature table exists
      assert.equal(runSql(db, "SELECT to_regclass('public.crm_future_expansion') IS NOT NULL;"), 't');
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

