/**
 * Runtime-boundary tests for the Meta Ads selective release.
 *
 * Database scenarios use disposable local PostgreSQL databases only.
 * The lost-ack scenario commits the real SQL package, then injects an
 * ECONNRESET-style client error before the runner returns to the executor.
 * A fresh psql session must discover the committed release and prevent rerun.
 * This is deterministic acknowledgement-loss fault injection, not a
 * physical TCP packet-drop test.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { PLATFORM_STUBS } from '../zalo/helpers/pglite-supabase';
import { inspectTransactionEnvelope } from '../../scripts/meta-ads/ledger-readiness';
import {
  executeSelectiveRelease,
  SERVER_VERSION_QUERY,
  computeOwnerApprovalHmac,
  verifyOwnerApprovalSignature,
  parseCliArgs,
} from '../../scripts/meta-ads/selective-runtime';
import type { PsqlConnectionConfig, PsqlRunner } from '../../scripts/meta-ads/selective-runtime';
import { TARGET_STAGING_PROJECT } from '../../scripts/meta-ads/selective-executor';

const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id\s*=\s*"([\w-]+)"/m)?.[1];
assert.ok(project);
const container = 'supabase_db_' + project;
const migrationFiles = readdirSync('supabase/migrations').filter((file) => file.endsWith('.sql')).sort();
const historical = JSON.parse(
  readFileSync('docs/evidence/meta-ads-safe-deployment/staging-metadata.json', 'utf8')
).data[0].snapshot;

function runSql(database: string, sql: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', container, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database],
    {
      input: sql,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
    }
  ).trim();
}

const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";

function createPrefixDatabase(database: string): void {
  runSql('postgres', 'CREATE DATABASE ' + database + ';');
  runSql(database, PLATFORM_STUBS.replace(/CREATE ROLE[^;]+;/g, ''));
  runSql(
    database,
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;' +
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon,authenticated,service_role;' +
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon,authenticated,service_role;'
  );

  for (const file of migrationFiles.slice(0, 21)) {
    const sql = readFileSync('supabase/migrations/' + file, 'utf8');
    const envelope = inspectTransactionEnvelope(sql);
    runSql(database, envelope.mode === 'NONE' ? 'BEGIN;\n' + sql + '\nCOMMIT;' : sql);
  }

  runSql(
    database,
    'CREATE SCHEMA supabase_migrations;' +
      'CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY, name text, statements text[]);'
  );

  for (const [index, file] of migrationFiles.slice(0, 21).entries()) {
    const recorded = historical.migration_history[index];
    const sql = readFileSync('supabase/migrations/' + file, 'utf8');
    runSql(
      database,
      'INSERT INTO supabase_migrations.schema_migrations VALUES(' +
        quote(recorded.version) +
        ', ' +
        quote(recorded.name) +
        ', ARRAY[' +
        quote(sql) +
        ']);'
    );
  }
}

const localConnection = (database: string) =>
  'postgresql://postgres:postgres@127.0.0.1:5432/' + database + '?sslmode=disable';

function versionResult(version = '17.11', versionNum = 170011) {
  return { exitCode: 0, stdout: version + '\t' + versionNum, stderr: '' };
}

test('Selective runtime validates the connection and recovers a lost COMMIT acknowledgement', async (t) => {
  const prefix = 'crm_runtime_' + randomUUID().replaceAll('-', '');
  const databases: string[] = [];
  const createDb = (suffix: string) => {
    const database = prefix + '_' + suffix;
    databases.push(database);
    createPrefixDatabase(database);
    return database;
  };

  try {
    await t.test('1. Rejects wrong project, host spoofing, and local access without opt-in', () => {
      let calls = 0;
      const unusedRunner: PsqlRunner = () => {
        calls++;
        return versionResult();
      };

      assert.throws(
        () =>
          executeSelectiveRelease({
            connectionString:
              'postgresql://postgres:secret@db.wrongproject.supabase.co:5432/postgres?sslmode=require',
            hostedApproval: {
              backupRestoreVerified: true,
              ownerApproved: true,
              reference: 'owner-approved-backup-restore-2026-10-31',
            },
            runPsql: unusedRunner,
          }),
        /TARGET_PROJECT_MISMATCH/
      );

      assert.throws(
        () =>
          executeSelectiveRelease({
            connectionString:
              'postgresql://postgres.' +
              TARGET_STAGING_PROJECT +
              ':secret@attacker.example.com:6543/postgres?sslmode=require',
            hostedApproval: {
              backupRestoreVerified: true,
              ownerApproved: true,
              reference: 'owner-approved-backup-restore-2026-10-31',
            },
            runPsql: unusedRunner,
          }),
        /TARGET_VERIFICATION_FAILED/
      );

      assert.throws(
        () =>
          executeSelectiveRelease({
            connectionString:
              'postgresql://postgres.' +
              TARGET_STAGING_PROJECT +
              ':secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require',
            runPsql: unusedRunner,
          }),
        /HOSTED_EXECUTION_BLOCKED/
      );

      assert.throws(
        () =>
          executeSelectiveRelease({
            connectionString: 'postgresql://postgres:secret@localhost:5432/postgres?sslmode=disable',
            runPsql: unusedRunner,
          }),
        /TARGET_PROJECT_MISMATCH/
      );
      assert.equal(calls, 0, 'No query may run after failed target validation or hosted approval');
    });

    await t.test('2. Hosted execution remains blocked without backup/restore proof and owner approval', () => {
      let calls = 0;
      const unusedRunner: PsqlRunner = () => {
        calls++;
        return versionResult();
      };
      assert.throws(
        () =>
          executeSelectiveRelease({
            connectionString:
              'postgresql://postgres:secret@db.' +
              TARGET_STAGING_PROJECT +
              '.supabase.co:5432/postgres?sslmode=require',
            runPsql: unusedRunner,
          }),
        /HOSTED_EXECUTION_BLOCKED/
      );
      assert.equal(calls, 0, 'Hosted approval must be checked before opening a database connection');

      // Rejects even when boolean ownerApproved is true, if signature is missing
      assert.throws(
        () =>
          executeSelectiveRelease({
            connectionString:
              'postgresql://postgres:secret@db.' +
              TARGET_STAGING_PROJECT +
              '.supabase.co:5432/postgres?sslmode=require',
            hostedApproval: {
              backupRestoreVerified: true,
              ownerApproved: true,
              reference: 'ref-without-signature',
            },
            runPsql: unusedRunner,
          }),
        /HOSTED_EXECUTION_BLOCKED.*signature and verification key/
      );

      // Rejects forged signature
      assert.throws(
        () =>
          executeSelectiveRelease({
            connectionString:
              'postgresql://postgres:secret@db.' +
              TARGET_STAGING_PROJECT +
              '.supabase.co:5432/postgres?sslmode=require',
            hostedApproval: {
              backupRestoreVerified: true,
              ownerApproved: true,
              reference: 'ref-forged',
              signature: '0'.repeat(64),
              secretOrPublicKey: 'trusted_secret',
            },
            runPsql: unusedRunner,
          }),
        /HOSTED_EXECUTION_BLOCKED.*Cryptographic owner approval signature verification failed/
      );

      // Genuine cryptographic signature allows passing the approval barrier to reach the runner
      const releaseId = 'test-release-sig-01';
      const reference = 'ref-genuine-owner-approval-01';
      const secret = 'super_secret_owner_signing_key_12345';
      const genuineSig = computeOwnerApprovalHmac({
        projectRef: TARGET_STAGING_PROJECT,
        releaseId,
        reference,
        secret,
      });

      let runnerCalled = false;
      const preflightRunner: PsqlRunner = () => {
        runnerCalled = true;
        return versionResult('17.11', 170011);
      };

      // Throws because mock runner doesn't handle the full script, but proves approval barrier was passed!
      try {
        executeSelectiveRelease({
          connectionString:
            'postgresql://postgres:secret@db.' +
            TARGET_STAGING_PROJECT +
            '.supabase.co:5432/postgres?sslmode=require',
          releaseId,
          hostedApproval: {
            backupRestoreVerified: true,
            ownerApproved: true,
            reference,
            signature: genuineSig,
            secretOrPublicKey: secret,
          },
          runPsql: preflightRunner,
        });
      } catch {
        // Expected because mock runner is minimal
      }
      assert.equal(runnerCalled, true, 'Genuine signature passed approval barrier and reached database preflight');
    });

    await t.test('2b. Cryptographic signature and CLI args parsing utilities', () => {
      // 1. Signature binding tests
      const secret = 'test_secret_key';
      const projectRef = TARGET_STAGING_PROJECT;
      const releaseId = 'rel-123';
      const reference = 'runbook-v12-rehearsal-001';

      const sig = computeOwnerApprovalHmac({ projectRef, releaseId, reference, secret });
      assert.ok(sig && sig.length === 64, 'HMAC-SHA256 generates 64-char hex string');

      // Matches
      assert.equal(verifyOwnerApprovalSignature({ projectRef, releaseId, reference, signature: sig, secretOrPublicKey: secret }), true);

      // Wrong releaseId fails
      assert.equal(verifyOwnerApprovalSignature({ projectRef, releaseId: 'wrong-rel', reference, signature: sig, secretOrPublicKey: secret }), false);

      // Wrong reference fails
      assert.equal(verifyOwnerApprovalSignature({ projectRef, releaseId, reference: 'tampered-ref', signature: sig, secretOrPublicKey: secret }), false);

      // Wrong projectRef fails
      assert.equal(verifyOwnerApprovalSignature({ projectRef: 'other_proj', releaseId, reference, signature: sig, secretOrPublicKey: secret }), false);

      // Wrong secret fails
      assert.equal(verifyOwnerApprovalSignature({ projectRef, releaseId, reference, signature: sig, secretOrPublicKey: 'wrong_secret' }), false);

      // 2. CLI arguments parser tests
      const parsed = parseCliArgs([
        '--connection-string=postgresql://user:pass@localhost:5432/db',
        '--allow-local-test',
        '--owner-approved',
        '--backup-restore-verified',
        '--owner-approval-reference', 'test-ref-001',
        '--owner-signature', sig,
        '--owner-secret', secret,
        '--release-id=custom-rel-99',
      ]);

      assert.equal(parsed.connectionString, 'postgresql://user:pass@localhost:5432/db');
      assert.equal(parsed.allowLocalTest, true);
      assert.equal(parsed.ownerApproved, true);
      assert.equal(parsed.backupRestoreVerified, true);
      assert.equal(parsed.approvalReference, 'test-ref-001');
      assert.equal(parsed.ownerSignature, sig);
      assert.equal(parsed.ownerSecret, secret);
      assert.equal(parsed.releaseId, 'custom-rel-99');
    });

    await t.test('3. PostgreSQL 16 is rejected before the release SQL is sent', () => {
      let calls = 0;
      const runner: PsqlRunner = (_connection, sql) => {
        calls++;
        assert.equal(sql, SERVER_VERSION_QUERY);
        return versionResult('16.9', 160009);
      };
      assert.throws(
        () =>
          executeSelectiveRelease({
            connectionString: localConnection('postgres'),
            allowLocalTest: true,
            runPsql: runner,
          }),
        /POSTGRES_VERSION_INCOMPATIBLE/
      );
      assert.equal(calls, 1, 'Only the version query may run against an incompatible server');
    });

    await t.test('4. Executes against local PG17 and verifies commit through a fresh probe', () => {
      const database = createDb('success');
      const connectionString = localConnection(database);
      const calls: string[] = [];
      const runner: PsqlRunner = (connection, sql, mode) => {
        assert.equal(connection.host, '127.0.0.1');
        assert.equal(connection.projectRef, TARGET_STAGING_PROJECT);
        calls.push(mode + ':' + (sql === SERVER_VERSION_QUERY ? 'version' : sql.includes('DO $probe$') ? 'probe' : 'release'));
        if (sql === SERVER_VERSION_QUERY) return versionResult();
        return { exitCode: 0, stdout: runSql(database, sql), stderr: '' };
      };

      const result = executeSelectiveRelease({
        connectionString,
        allowLocalTest: true,
        releaseId: 'runtime-success-' + randomUUID(),
        runPsql: runner,
      });

      assert.equal(result.status, 'COMMITTED_VERIFIED');
      assert.equal(result.recovery?.status, 'COMMITTED_VERIFIED');
      assert.deepEqual(calls, ['query:version', 'script:release', 'query:probe']);
      assert.equal(runSql(database, 'SELECT count(*) FROM supabase_migrations.schema_migrations;'), '21');
    });

    await t.test('5. Lost COMMIT acknowledgement is recovered as committed and is never retried', () => {
      const database = createDb('ack_lost');
      const connectionString = localConnection(database);
      const releaseId = 'runtime-ack-lost-' + randomUUID();
      let scriptCalls = 0;
      const runner: PsqlRunner = (connection: PsqlConnectionConfig, sql, mode) => {
        assert.equal(connection.database, database);
        if (sql === SERVER_VERSION_QUERY) return versionResult();
        if (mode === 'script') {
          scriptCalls++;
          runSql(database, sql);
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'ECONNRESET: simulated loss of connection after COMMIT acknowledgement was sent',
          };
        }
        return { exitCode: 0, stdout: runSql(database, sql), stderr: '' };
      };

      const result = executeSelectiveRelease({
        connectionString,
        allowLocalTest: true,
        releaseId,
        runPsql: runner,
      });

      assert.equal(scriptCalls, 1, 'Executor must never retry after an uncertain COMMIT');
      assert.equal(result.status, 'COMMITTED_AFTER_ACK_LOSS');
      assert.equal(result.recovery?.recommendation, 'DO_NOT_RERUN');
      assert.equal(
        runSql(
          database,
          'SELECT count(*) FROM private.selective_feature_releases WHERE release_id = ' + quote(releaseId) + ';'
        ),
        '1'
      );
      assert.equal(runSql(database, 'SELECT count(*) FROM supabase_migrations.schema_migrations;'), '21');
    });

    await t.test('6. Pre-commit disconnect probes a clean database and does not retry automatically', () => {
      const database = createDb('before_commit');
      const connectionString = localConnection(database);
      let scriptCalls = 0;
      const runner: PsqlRunner = (_connection, sql, mode) => {
        if (sql === SERVER_VERSION_QUERY) return versionResult();
        if (mode === 'script') {
          scriptCalls++;
          return { exitCode: 1, stdout: '', stderr: 'ECONNRESET before transaction reached PostgreSQL' };
        }
        return { exitCode: 0, stdout: runSql(database, sql), stderr: '' };
      };

      const result = executeSelectiveRelease({
        connectionString,
        allowLocalTest: true,
        releaseId: 'runtime-before-commit-' + randomUUID(),
        runPsql: runner,
      });

      assert.equal(scriptCalls, 1);
      assert.equal(result.status, 'UNCOMMITTED_CLEAN');
      assert.equal(result.recovery?.recommendation, 'SAFE_TO_EXECUTE');
      assert.equal(runSql(database, "SELECT to_regclass('public.meta_ad_accounts') IS NULL;"), 't');
      assert.equal(runSql(database, 'SELECT count(*) FROM supabase_migrations.schema_migrations;'), '21');
    });
  } finally {
    for (const database of databases) {
      try {
        runSql('postgres', 'DROP DATABASE IF EXISTS ' + database + ' WITH (FORCE);');
      } catch {
        // Disposable test cleanup only.
      }
    }
  }
});
