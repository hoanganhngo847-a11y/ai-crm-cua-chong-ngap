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
import { randomUUID, generateKeyPairSync, sign, createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PLATFORM_STUBS } from '../zalo/helpers/pglite-supabase';
import { inspectTransactionEnvelope } from '../../scripts/meta-ads/ledger-readiness';
import {
  executeSelectiveRelease,
  SERVER_VERSION_QUERY,
  parseCliArgs,
  canonicalizeApprovalPayload,
  verifyArtifactSignature,
  verifySignedApprovalArtifact,
  loadTrustedOwnerRootPublicKey,
  TRUSTED_OWNER_ROOT_PUB_PATH,
  computePublicKeyFingerprint,
  EXPECTED_OWNER_ROOT_FINGERPRINT,
} from '../../scripts/meta-ads/selective-runtime';
import type {
  PsqlConnectionConfig,
  PsqlRunner,
  SignedApprovalArtifact,
  OwnerApprovalPayload,
} from '../../scripts/meta-ads/selective-runtime';
import {
  TARGET_STAGING_PROJECT,
  PINNED_SOURCE_HASHES,
  buildSelectiveExecutorPackage,
} from '../../scripts/meta-ads/selective-executor';

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
        () => executeSelectiveRelease({
          connectionString: 'postgresql://postgres:secret@db.wrongproject.supabase.co:5432/postgres?sslmode=require',
          runPsql: unusedRunner,
        }),
        /TARGET_PROJECT_MISMATCH/
      );
      assert.throws(
        () => executeSelectiveRelease({
          connectionString: 'postgresql://postgres.' + TARGET_STAGING_PROJECT + ':secret@attacker.example.com:6543/postgres?sslmode=require',
          runPsql: unusedRunner,
        }),
        /TARGET_VERIFICATION_FAILED/
      );
      assert.throws(
        () => executeSelectiveRelease({
          connectionString: 'postgresql://postgres.' + TARGET_STAGING_PROJECT + ':secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require',
          runPsql: unusedRunner,
        }),
        /HOSTED_EXECUTION_BLOCKED/
      );
      assert.throws(
        () => executeSelectiveRelease({
          connectionString: 'postgresql://postgres:secret@localhost:5432/postgres?sslmode=disable',
          runPsql: unusedRunner,
        }),
        /TARGET_PROJECT_MISMATCH/
      );
      assert.equal(calls, 0, 'No query may run after failed target validation or hosted approval');
    });

    await t.test('2. Hosted execution remains blocked without signed approval and physical evidence', () => {
      let calls = 0;
      const unusedRunner: PsqlRunner = () => {
        calls++;
        return versionResult();
      };
      const hostedConn =
        'postgresql://postgres:secret@db.' +
        TARGET_STAGING_PROJECT +
        '.supabase.co:5432/postgres?sslmode=require';

      assert.throws(
        () => executeSelectiveRelease({ connectionString: hostedConn, runPsql: unusedRunner }),
        /HOSTED_EXECUTION_BLOCKED: A cryptographically signed approval artifact \(crm-owner-approval\/v1\) is strictly required for hosted execution\./
      );

      // Legacy boolean flags are ignored and cannot satisfy the signed artifact barrier.
      assert.throws(
        () => executeSelectiveRelease(({
          connectionString: hostedConn,
          ownerApproved: true,
          backupRestoreVerified: true,
          runPsql: unusedRunner,
        } as any)),
        /HOSTED_EXECUTION_BLOCKED: A cryptographically signed approval artifact/
      );

      const fakeArtifact: SignedApprovalArtifact = {
        format: 'crm-owner-approval/v1',
        payload: {
          projectRef: TARGET_STAGING_PROJECT,
          releaseId: 'rel-test-01',
          sourceCommit: '0d21bb89b97cdcd1b82f08a72149e68f87b8ae2f',
          snapshotCommit: 'e51a5989143582af0885ba5ee26644a68b388995',
          migrationHashes: PINNED_SOURCE_HASHES,
          releasePackageDigest: '0'.repeat(64),
          backupManifestDigest: '1'.repeat(64),
          backupEvidenceDigest: '2'.repeat(64),
          approvedWriteGroups: ['META_ADS_LEAD_ATTRIBUTION'],
          issuedAt: new Date(Date.now() - 60_000).toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          approvalReference: 'ref-forged',
        },
        algorithm: 'ed25519',
        signature: '0'.repeat(128),
      };

      assert.throws(
        () => executeSelectiveRelease({
          connectionString: hostedConn,
          approvalArtifact: fakeArtifact,
          runPsql: unusedRunner,
        }),
        /HOSTED_EXECUTION_BLOCKED: Actual verified backup manifest/
      );

      const tmpManifest = join(tmpdir(), `test-manifest-${randomUUID()}.json`);
      writeFileSync(tmpManifest, '{"test": 1}');
      try {
        assert.throws(
          () => executeSelectiveRelease({
            connectionString: hostedConn,
            approvalArtifact: fakeArtifact,
            backupManifestPath: tmpManifest,
            runPsql: unusedRunner,
          }),
          /HOSTED_EXECUTION_BLOCKED: Actual verified backup\/restore evidence/
        );
      } finally {
        try { unlinkSync(tmpManifest); } catch {}
      }

      const otherKeypair = generateKeyPairSync('ed25519');
      const otherPubPem = otherKeypair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const tmpEv = join(tmpdir(), `test-ev-${randomUUID()}.json`);
      const tmpMf = join(tmpdir(), `test-mf-${randomUUID()}.json`);
      writeFileSync(tmpEv, '{"test": 2}');
      writeFileSync(tmpMf, '{"test": 1}');
      try {
        assert.throws(
          () => executeSelectiveRelease({
            connectionString: hostedConn,
            approvalArtifact: fakeArtifact,
            backupManifestPath: tmpMf,
            backupEvidencePath: tmpEv,
            trustedRootPublicKey: otherPubPem,
            runPsql: unusedRunner,
          }),
          /HOSTED_EXECUTION_BLOCKED: Overriding the trusted owner root public key is forbidden in hosted execution\./
        );
      } finally {
        try { unlinkSync(tmpEv); } catch {}
        try { unlinkSync(tmpMf); } catch {}
      }
      assert.equal(calls, 0, 'No query may run after failed target validation or hosted approval');
    });

    await t.test('2b. CLI args parsing rejects legacy and secret-bearing arguments', () => {
      assert.throws(() => parseCliArgs(['--connection-string=postgresql://user:pass@localhost:5432/db']), /INSECURE_ARGUMENT.*connection string.*forbidden/);
      assert.throws(() => parseCliArgs(['--owner-secret=my_secret']), /INSECURE_ARGUMENT.*owner secret.*forbidden/);
      assert.throws(() => parseCliArgs(['--owner-public-key=key']), /INSECURE_ARGUMENT.*owner public key.*forbidden/);
      assert.throws(() => parseCliArgs(['--trusted-root=/tmp/root.pub']), /INSECURE_ARGUMENT.*trusted root public key.*forbidden/);
      assert.throws(() => parseCliArgs(['--owner-approved']), /LEGACY_ARGUMENT_FORBIDDEN/);
      assert.throws(() => parseCliArgs(['--backup-restore-verified']), /LEGACY_ARGUMENT_FORBIDDEN/);
      assert.throws(() => parseCliArgs(['--owner-approval-reference=test-ref']), /LEGACY_ARGUMENT_FORBIDDEN/);
      assert.throws(() => parseCliArgs(['--owner-signature=sig']), /LEGACY_ARGUMENT_FORBIDDEN/);
      const parsed = parseCliArgs([
        '--approval-artifact', '/tmp/approval.json',
        '--backup-manifest', '/tmp/manifest.json',
        '--backup-evidence', '/tmp/evidence.json',
        '--allow-local-test',
        '--release-id=custom-rel-99',
      ]);
      assert.equal(parsed.approvalArtifactPath, '/tmp/approval.json');
      assert.equal(parsed.backupManifestPath, '/tmp/manifest.json');
      assert.equal(parsed.backupEvidencePath, '/tmp/evidence.json');
      assert.equal(parsed.allowLocalTest, true);
      assert.equal(parsed.releaseId, 'custom-rel-99');
    });

    await t.test('2c. Finding 3 regression: Signed Approval Artifact cryptographic verification, independent trust root, and evidence binding', () => {
      // Generate trusted root keypair
      const trustedKeypair = generateKeyPairSync('ed25519');
      const trustedPubPem = trustedKeypair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const trustedPrivPem = trustedKeypair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

      // Generate operator untrusted keypair
      const operatorKeypair = generateKeyPairSync('ed25519');
      const operatorPrivPem = operatorKeypair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

      const pkgDigest = createHash('sha256').update('test-release-package-sql-bytes').digest('hex');
      const now = new Date();
      const manifestBytes = Buffer.from(JSON.stringify({
        format: 'crm-staging-backup-manifest/v1',
        backupId: 'bk-001',
        source: {
          projectRef: TARGET_STAGING_PROJECT,
          environment: 'staging',
          auditBaselineCommit: '0d21bb89b97cdcd1b82f08a72149e68f87b8ae2f',
          snapshotCommit: 'e51a5989143582af0885ba5ee26644a68b388995',
          commitFullSha: '69d16c3769adf9276c68139261b740246ea6820e',
          serverVersion: '17.11',
          dumpToolVersion: '17.11',
        },
        artifacts: [{ path: 'db/app.dump.aesgcm', kind: 'pg_dump_custom' }],
      }));
      const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');
      const evidenceBytes = Buffer.from(JSON.stringify({
        format: 'crm-staging-backup-restore-evidence/v1',
        backupId: 'bk-001',
        projectRef: TARGET_STAGING_PROJECT,
        sourceEnvironment: 'staging',
        status: 'PASSED',
        backupStatus: 'PASSED',
        restoreStatus: 'PASSED',
        backupManifestDigest: manifestDigest,
        restoreTarget: { type: 'disposable-isolated', identity: 'crm-restore-rehearsal-local-001' },
        startedAt: new Date(now.getTime() - 60_000).toISOString(),
        completedAt: now.toISOString(),
      }));
      const evidenceDigest = createHash('sha256').update(evidenceBytes).digest('hex');

      const tmpManifestPath = join(tmpdir(), `test-manifest-${randomUUID()}.json`);
      const tmpEvidencePath = join(tmpdir(), `test-evidence-${randomUUID()}.json`);
      writeFileSync(tmpManifestPath, manifestBytes);
      writeFileSync(tmpEvidencePath, evidenceBytes);

      const basePayload: OwnerApprovalPayload = {
        projectRef: TARGET_STAGING_PROJECT,
        releaseId: 'test-release-01',
        sourceCommit: '0d21bb89b97cdcd1b82f08a72149e68f87b8ae2f',
        snapshotCommit: 'e51a5989143582af0885ba5ee26644a68b388995',
        migrationHashes: { ...PINNED_SOURCE_HASHES },
        releasePackageDigest: pkgDigest,
        backupManifestDigest: manifestDigest,
        backupEvidenceDigest: evidenceDigest,
        approvedWriteGroups: ['META_ADS_LEAD_ATTRIBUTION'],
        issuedAt: new Date(now.getTime() - 60_000).toISOString(),
        expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
        approvalReference: 'ref-owner-approved-runbook-v12-001',
      };

      const signArtifact = (payload: OwnerApprovalPayload, privPem: string): SignedApprovalArtifact => {
        const canonical = canonicalizeApprovalPayload(payload);
        const sig = sign(null, Buffer.from(canonical, 'utf8'), privPem).toString('hex');
        return {
          format: 'crm-owner-approval/v1',
          payload,
          algorithm: 'ed25519',
          signature: sig,
        };
      };

      try {
        // 1. Valid artifact from trusted signer with actual manifest & evidence files passes
        const validArtifact = signArtifact(basePayload, trustedPrivPem);
        const resValid = verifySignedApprovalArtifact({
          artifact: validArtifact,
          trustedRootPublicKey: trustedPubPem,
          expectedProjectRef: TARGET_STAGING_PROJECT,
          expectedReleaseId: 'test-release-01',
          expectedSourceCommit: '0d21bb89b97cdcd1b82f08a72149e68f87b8ae2f',
          expectedSnapshotCommit: 'e51a5989143582af0885ba5ee26644a68b388995',
          expectedReleasePackageDigest: pkgDigest,
          backupManifestPath: tmpManifestPath,
          backupEvidencePath: tmpEvidencePath,
          expectedMigrationHashes: PINNED_SOURCE_HASHES,
        });
        assert.equal(resValid.valid, true);

        // 2. Dummy / placeholder digest fails closed
        const dummyDigestPayload: OwnerApprovalPayload = {
          ...basePayload,
          backupManifestDigest: 'sha256-dummy-manifest-digest-12345',
        };
        const dummyArtifact = signArtifact(dummyDigestPayload, trustedPrivPem);
        const resDummy = verifySignedApprovalArtifact({
          artifact: dummyArtifact,
          trustedRootPublicKey: trustedPubPem,
          expectedProjectRef: TARGET_STAGING_PROJECT,
          expectedReleaseId: 'test-release-01',
        });
        assert.equal(resDummy.valid, false);
        assert.match(resDummy.reason!, /placeholder|Invalid/);

        // 3. Source commit mismatch fails closed
        const resSourceMismatch = verifySignedApprovalArtifact({
          artifact: validArtifact,
          trustedRootPublicKey: trustedPubPem,
          expectedProjectRef: TARGET_STAGING_PROJECT,
          expectedReleaseId: 'test-release-01',
          expectedSourceCommit: '1111111111111111111111111111111111111111',
        });
        assert.equal(resSourceMismatch.valid, false);
        assert.match(resSourceMismatch.reason!, /Source commit mismatch/);

        // 4. Snapshot commit mismatch fails closed
        const resSnapshotMismatch = verifySignedApprovalArtifact({
          artifact: validArtifact,
          trustedRootPublicKey: trustedPubPem,
          expectedProjectRef: TARGET_STAGING_PROJECT,
          expectedReleaseId: 'test-release-01',
          expectedSnapshotCommit: '2222222222222222222222222222222222222222',
        });
        assert.equal(resSnapshotMismatch.valid, false);
        assert.match(resSnapshotMismatch.reason!, /Snapshot commit mismatch/);

        // 5. Operator-generated untrusted keypair fails verification
        const operatorArtifact = signArtifact(basePayload, operatorPrivPem);
        const resOperator = verifySignedApprovalArtifact({
          artifact: operatorArtifact,
          trustedRootPublicKey: trustedPubPem,
          expectedProjectRef: TARGET_STAGING_PROJECT,
          expectedReleaseId: 'test-release-01',
          backupManifestPath: tmpManifestPath,
          backupEvidencePath: tmpEvidencePath,
        });
        assert.equal(resOperator.valid, false);
        assert.match(resOperator.reason!, /Cryptographic signature verification failed/);

        // 6. Tampered signature fails
        const tamperedSigArtifact: SignedApprovalArtifact = {
          ...validArtifact,
          signature: '0'.repeat(128),
        };
        const resTamperedSig = verifySignedApprovalArtifact({
          artifact: tamperedSigArtifact,
          trustedRootPublicKey: trustedPubPem,
          expectedProjectRef: TARGET_STAGING_PROJECT,
          expectedReleaseId: 'test-release-01',
          backupManifestPath: tmpManifestPath,
          backupEvidencePath: tmpEvidencePath,
        });
        assert.equal(resTamperedSig.valid, false);

        // 7. Tampered manifest file (content changed) fails closed
        const tamperedManifestPath = join(tmpdir(), `tampered-mf-${randomUUID()}.json`);
        writeFileSync(tamperedManifestPath, '{"tampered": true}');
        try {
          const resTamperedMf = verifySignedApprovalArtifact({
            artifact: validArtifact,
            trustedRootPublicKey: trustedPubPem,
            expectedProjectRef: TARGET_STAGING_PROJECT,
            expectedReleaseId: 'test-release-01',
            backupManifestPath: tamperedManifestPath,
            backupEvidencePath: tmpEvidencePath,
          });
          assert.equal(resTamperedMf.valid, false);
          assert.match(resTamperedMf.reason!, /Backup manifest digest mismatch/);
        } finally {
          try { unlinkSync(tamperedManifestPath); } catch {}
        }

        // 8. Tampered evidence file (content changed) fails closed
        const tamperedEvidencePath = join(tmpdir(), `tampered-ev-${randomUUID()}.json`);
        writeFileSync(tamperedEvidencePath, '{"tampered": true}');
        try {
          const resTamperedEv = verifySignedApprovalArtifact({
            artifact: validArtifact,
            trustedRootPublicKey: trustedPubPem,
            expectedProjectRef: TARGET_STAGING_PROJECT,
            expectedReleaseId: 'test-release-01',
            backupManifestPath: tmpManifestPath,
            backupEvidencePath: tamperedEvidencePath,
          });
          assert.equal(resTamperedEv.valid, false);
          assert.match(resTamperedEv.reason!, /Backup evidence digest mismatch/);
        } finally {
          try { unlinkSync(tamperedEvidencePath); } catch {}
        }

        // 9. Missing manifest file fails closed
        const resMissingMf = verifySignedApprovalArtifact({
          artifact: validArtifact,
          trustedRootPublicKey: trustedPubPem,
          expectedProjectRef: TARGET_STAGING_PROJECT,
          expectedReleaseId: 'test-release-01',
          backupManifestPath: '/non/existent/path/to/manifest.json',
        });
        assert.equal(resMissingMf.valid, false);
        assert.match(resMissingMf.reason!, /Backup manifest file not found/);

        // 10. Missing evidence file fails closed
        const resMissingEv = verifySignedApprovalArtifact({
          artifact: validArtifact,
          trustedRootPublicKey: trustedPubPem,
          expectedProjectRef: TARGET_STAGING_PROJECT,
          expectedReleaseId: 'test-release-01',
          backupManifestPath: tmpManifestPath,
          backupEvidencePath: '/non/existent/path/to/evidence.json',
        });
        assert.equal(resMissingEv.valid, false);
        assert.match(resMissingEv.reason!, /Backup evidence file not found/);

        // 11. Tampered migration hash fails closed
        const badHashesPayload = {
          ...basePayload,
          migrationHashes: {
            ...PINNED_SOURCE_HASHES,
            '20261030090000_meta_ads_lead_attribution.sql': 'f'.repeat(64),
          },
        };
        const badHashesArtifact = signArtifact(badHashesPayload, trustedPrivPem);
        const resBadHash = verifySignedApprovalArtifact({
          artifact: badHashesArtifact,
          trustedRootPublicKey: trustedPubPem,
          expectedProjectRef: TARGET_STAGING_PROJECT,
          expectedReleaseId: 'test-release-01',
          expectedMigrationHashes: PINNED_SOURCE_HASHES,
          backupManifestPath: tmpManifestPath,
          backupEvidencePath: tmpEvidencePath,
        });
        assert.equal(resBadHash.valid, false);
        assert.match(resBadHash.reason!, /Migration hash mismatch/);

        // 11b. Invalid migration hash format fails closed
        const invalidHashFormatPayload = {
          ...basePayload,
          migrationHashes: {
            ...PINNED_SOURCE_HASHES,
            '20261030090000_meta_ads_lead_attribution.sql': 'non_hex_placeholder',
          },
        };
        const invalidHashArtifact = signArtifact(invalidHashFormatPayload, trustedPrivPem);
        const resInvalidHash = verifySignedApprovalArtifact({
          artifact: invalidHashArtifact,
          trustedRootPublicKey: trustedPubPem,
          expectedProjectRef: TARGET_STAGING_PROJECT,
          expectedReleaseId: 'test-release-01',
          expectedMigrationHashes: PINNED_SOURCE_HASHES,
          backupManifestPath: tmpManifestPath,
          backupEvidencePath: tmpEvidencePath,
        });
        assert.equal(resInvalidHash.valid, false);
        assert.match(resInvalidHash.reason!, /Invalid migration hash format/);

        // 12. Pinned trusted root public key file exists and matches fingerprint
        const pinnedKey = loadTrustedOwnerRootPublicKey();
        assert.ok(pinnedKey.includes('BEGIN PUBLIC KEY'));
        const fp = computePublicKeyFingerprint(pinnedKey);
        assert.equal(fp, EXPECTED_OWNER_ROOT_FINGERPRINT);

        // 13. Any other public key fingerprint does not match the pinned trust root
        const randomKeypair = generateKeyPairSync('ed25519');
        const randomPubPem = randomKeypair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
        const randomFp = computePublicKeyFingerprint(randomPubPem);
        assert.notEqual(randomFp, EXPECTED_OWNER_ROOT_FINGERPRINT);
        assert.equal(computePublicKeyFingerprint('not_a_valid_pem'), '');

        // 14. RSA-SHA256 signature verification works
        const rsaKeypair = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const rsaPubPem = rsaKeypair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
        const rsaPrivPem = rsaKeypair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
        const rsaCanonical = canonicalizeApprovalPayload(basePayload);
        const rsaSig = sign('sha256', Buffer.from(rsaCanonical, 'utf8'), rsaPrivPem).toString('hex');
        const rsaArtifact: SignedApprovalArtifact = {
          format: 'crm-owner-approval/v1',
          payload: basePayload,
          algorithm: 'rsa-sha256',
          signature: rsaSig,
        };
        const resRsa = verifySignedApprovalArtifact({
          artifact: rsaArtifact,
          trustedRootPublicKey: rsaPubPem,
          expectedProjectRef: TARGET_STAGING_PROJECT,
          expectedReleaseId: 'test-release-01',
          backupManifestPath: tmpManifestPath,
          backupEvidencePath: tmpEvidencePath,
        });
        assert.equal(resRsa.valid, true);
        const digestOnly = verifySignedApprovalArtifact({
          artifact: validArtifact,
          trustedRootPublicKey: trustedPubPem,
          expectedProjectRef: TARGET_STAGING_PROJECT,
          expectedReleaseId: 'test-release-01',
        });
        assert.equal(digestOnly.valid, false);
        assert.match(digestOnly.reason!, /Actual Backup manifest file path is required/);

        const extraMigrationArtifact = signArtifact({
          ...basePayload,
          migrationHashes: { ...PINNED_SOURCE_HASHES, 'unexpected.sql': 'a'.repeat(64) },
        }, trustedPrivPem);
        const extraMigration = verifySignedApprovalArtifact({
          artifact: extraMigrationArtifact,
          trustedRootPublicKey: trustedPubPem,
          expectedProjectRef: TARGET_STAGING_PROJECT,
          expectedReleaseId: 'test-release-01',
          backupManifestPath: tmpManifestPath,
          backupEvidencePath: tmpEvidencePath,
          expectedMigrationHashes: PINNED_SOURCE_HASHES,
        });
        assert.equal(extraMigration.valid, false);
        assert.match(extraMigration.reason!, /exactly match the release package migration set/);

        const extraGroupArtifact = signArtifact({
          ...basePayload,
          approvedWriteGroups: ['META_ADS_LEAD_ATTRIBUTION', 'UNAPPROVED_GROUP'],
        }, trustedPrivPem);
        const extraGroup = verifySignedApprovalArtifact({
          artifact: extraGroupArtifact,
          trustedRootPublicKey: trustedPubPem,
          expectedProjectRef: TARGET_STAGING_PROJECT,
          expectedReleaseId: 'test-release-01',
          backupManifestPath: tmpManifestPath,
          backupEvidencePath: tmpEvidencePath,
        });
        assert.equal(extraGroup.valid, false);
        assert.match(extraGroup.reason!, /approvedWriteGroups.*exactly matching/);

      } finally {
        try { unlinkSync(tmpManifestPath); } catch {}
        try { unlinkSync(tmpEvidencePath); } catch {}
      }
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
