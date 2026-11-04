/**
 * Runtime boundary for the Meta Ads selective release.
 *
 * The package builder only creates SQL. This module validates the exact
 * connection, checks PostgreSQL on that connection, executes once, and probes
 * through a fresh psql process before deciding whether the release committed.
 *
 * Hosted execution is blocked until backup/restore evidence and explicit
 * Project Owner approval are supplied by the operator.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHmac, timingSafeEqual, verify } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import {
  buildSelectiveExecutorPackage,
  evaluateReleaseProbe,
  PROBE_RELEASE_SQL,
  TARGET_STAGING_PROJECT,
  verifyPostgresServerVersion,
  verifyTargetProjectConnection,
} from './selective-executor';

export const SERVER_VERSION_QUERY =
  "SELECT current_setting('server_version') || chr(9) || current_setting('server_version_num');";

export interface PsqlConnectionConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  sslMode: string;
  projectRef: string;
  isLocalTest: boolean;
  sanitizedConnectionInfo: string;
}

export interface PsqlRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type PsqlMode = 'query' | 'script';
export type PsqlRunner = (
  connection: PsqlConnectionConfig,
  sql: string,
  mode: PsqlMode
) => PsqlRunResult;

export interface OwnerApprovalPayload {
  projectRef: string;
  releaseId: string;
  sourceCommit: string;
  snapshotCommit: string;
  migrationHashes: Record<string, string>;
  releasePackageDigest: string;
  backupManifestDigest: string;
  backupEvidenceDigest: string;
  approvedWriteGroups: string[];
  issuedAt: string;
  expiresAt: string;
  approvalReference: string;
}

export interface SignedApprovalArtifact {
  format: 'crm-owner-approval/v1';
  payload: OwnerApprovalPayload;
  algorithm: 'ed25519' | 'rsa-sha256';
  signature: string;
}

export const TRUSTED_OWNER_ROOT_PUB_PATH = path.resolve(__dirname, 'trusted-owner-root.pub');

export function loadTrustedOwnerRootPublicKey(customPath?: string): string {
  const rootPath =
    customPath ||
    process.env.META_ADS_TRUSTED_OWNER_ROOT_PUBKEY_PATH ||
    TRUSTED_OWNER_ROOT_PUB_PATH;
  if (!fs.existsSync(rootPath)) {
    throw new Error(
      `HOSTED_EXECUTION_BLOCKED: Trusted owner root public key file not found at ${rootPath}`
    );
  }
  return fs.readFileSync(rootPath, 'utf8').trim();
}

export function canonicalizeApprovalPayload(payload: OwnerApprovalPayload): string {
  const sortObject = (obj: unknown): unknown => {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(sortObject);
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      sorted[key] = sortObject((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  };
  return JSON.stringify(sortObject(payload));
}

export function verifyArtifactSignature(params: {
  payloadCanonicalString: string;
  algorithm: 'ed25519' | 'rsa-sha256';
  signature: string;
  trustedPublicKeyPem: string;
}): boolean {
  const { payloadCanonicalString, algorithm, signature, trustedPublicKeyPem } = params;
  if (!payloadCanonicalString || !algorithm || !signature || !trustedPublicKeyPem) {
    return false;
  }

  try {
    const isHex = /^[0-9a-fA-F]+$/.test(signature) && signature.length % 2 === 0;
    const sigBuffer = Buffer.from(signature, isHex ? 'hex' : 'base64');
    const dataBuffer = Buffer.from(payloadCanonicalString, 'utf8');

    if (algorithm === 'ed25519') {
      return verify(null, dataBuffer, trustedPublicKeyPem, sigBuffer);
    } else if (algorithm === 'rsa-sha256') {
      return verify('sha256', dataBuffer, trustedPublicKeyPem, sigBuffer);
    }
    return false;
  } catch {
    return false;
  }
}

export function verifySignedApprovalArtifact(params: {
  artifact: unknown;
  trustedRootPublicKey: string;
  expectedProjectRef: string;
  expectedReleaseId: string;
  expectedReleasePackageDigest?: string;
  expectedMigrationHashes?: Record<string, string>;
  currentTime?: Date;
}): { valid: boolean; reason?: string } {
  const {
    artifact,
    trustedRootPublicKey,
    expectedProjectRef,
    expectedReleaseId,
    expectedReleasePackageDigest,
    expectedMigrationHashes,
    currentTime,
  } = params;

  if (typeof artifact !== 'object' || artifact === null) {
    return { valid: false, reason: 'Artifact must be a JSON object' };
  }
  const art = artifact as Partial<SignedApprovalArtifact>;

  if (art.format !== 'crm-owner-approval/v1') {
    return {
      valid: false,
      reason: `Invalid artifact format: expected 'crm-owner-approval/v1', got '${art.format}'`,
    };
  }

  if (art.algorithm !== 'ed25519' && art.algorithm !== 'rsa-sha256') {
    return {
      valid: false,
      reason: `Unsupported signing algorithm: '${art.algorithm}' (must be 'ed25519' or 'rsa-sha256')`,
    };
  }

  if (typeof art.signature !== 'string' || art.signature.trim().length === 0) {
    return { valid: false, reason: 'Artifact missing signature string' };
  }

  const payload = art.payload;
  if (typeof payload !== 'object' || payload === null) {
    return { valid: false, reason: 'Artifact payload must be an object' };
  }

  if (payload.projectRef !== expectedProjectRef) {
    return {
      valid: false,
      reason: `Target project mismatch in approval: expected '${expectedProjectRef}', got '${payload.projectRef}'`,
    };
  }

  if (payload.releaseId !== expectedReleaseId) {
    return {
      valid: false,
      reason: `Release ID mismatch in approval: expected '${expectedReleaseId}', got '${payload.releaseId}'`,
    };
  }

  const now = currentTime || new Date();
  const expiresAt = new Date(payload.expiresAt);
  if (isNaN(expiresAt.getTime()) || now > expiresAt) {
    return {
      valid: false,
      reason: `Approval artifact has expired (expired at ${payload.expiresAt}, current ${now.toISOString()})`,
    };
  }
  const issuedAt = new Date(payload.issuedAt);
  if (isNaN(issuedAt.getTime()) || issuedAt > now) {
    return {
      valid: false,
      reason: `Approval artifact issued in the future (issued at ${payload.issuedAt}, current ${now.toISOString()})`,
    };
  }

  if (!Array.isArray(payload.approvedWriteGroups) || payload.approvedWriteGroups.length === 0) {
    return { valid: false, reason: 'Approval missing approvedWriteGroups array' };
  }

  if (!payload.sourceCommit || typeof payload.sourceCommit !== 'string' || !payload.snapshotCommit || typeof payload.snapshotCommit !== 'string') {
    return { valid: false, reason: 'Approval missing sourceCommit or snapshotCommit' };
  }

  if (!payload.backupManifestDigest || !payload.backupEvidenceDigest) {
    return { valid: false, reason: 'Approval missing backupManifestDigest or backupEvidenceDigest' };
  }

  if (expectedReleasePackageDigest && payload.releasePackageDigest !== expectedReleasePackageDigest) {
    return {
      valid: false,
      reason: `Release package digest mismatch: expected '${expectedReleasePackageDigest}', got '${payload.releasePackageDigest}'`,
    };
  }

  if (expectedMigrationHashes) {
    if (!payload.migrationHashes || typeof payload.migrationHashes !== 'object') {
      return { valid: false, reason: 'Approval missing migrationHashes dictionary' };
    }
    for (const [file, hash] of Object.entries(expectedMigrationHashes)) {
      if (payload.migrationHashes[file] !== hash) {
        return {
          valid: false,
          reason: `Migration hash mismatch for '${file}': expected '${hash}', got '${payload.migrationHashes[file]}'`,
        };
      }
    }
  }

  const canonicalString = canonicalizeApprovalPayload(payload as OwnerApprovalPayload);
  const isValidSig = verifyArtifactSignature({
    payloadCanonicalString: canonicalString,
    algorithm: art.algorithm,
    signature: art.signature,
    trustedPublicKeyPem: trustedRootPublicKey,
  });

  if (!isValidSig) {
    return {
      valid: false,
      reason: 'Cryptographic signature verification failed against trusted owner root',
    };
  }

  return { valid: true };
}

export interface HostedExecutionApproval {
  backupRestoreVerified: boolean;
  ownerApproved: boolean;
  reference: string;
  signature?: string;
  secretOrPublicKey?: string;
}

export function computeOwnerApprovalHmac(params: {
  projectRef: string;
  releaseId: string;
  reference: string;
  secret: string;
}): string {
  const message = `${params.projectRef}:${params.releaseId}:${params.reference.trim()}`;
  return createHmac('sha256', params.secret).update(message, 'utf8').digest('hex');
}

export function verifyOwnerApprovalSignature(params: {
  projectRef: string;
  releaseId: string;
  reference: string;
  signature: string;
  secretOrPublicKey: string;
}): boolean {
  const { projectRef, releaseId, reference, signature, secretOrPublicKey } = params;
  if (!signature || !secretOrPublicKey || !projectRef || !releaseId || !reference) {
    return false;
  }
  const message = `${projectRef}:${releaseId}:${reference.trim()}`;

  // Check if secretOrPublicKey is a PEM public key
  if (secretOrPublicKey.includes('BEGIN PUBLIC KEY') || secretOrPublicKey.includes('BEGIN RSA PUBLIC KEY')) {
    try {
      const sigBuffer = Buffer.from(signature, /^[0-9a-fA-F]+$/.test(signature) ? 'hex' : 'base64');
      return verify(null, Buffer.from(message, 'utf8'), secretOrPublicKey, sigBuffer);
    } catch {
      return false;
    }
  }

  // Otherwise treat as symmetric HMAC secret
  try {
    const expected = createHmac('sha256', secretOrPublicKey).update(message, 'utf8').digest('hex');
    const sigNorm = signature.trim().toLowerCase();
    if (sigNorm.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(Buffer.from(sigNorm, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export interface ExecuteSelectiveReleaseOptions {
  connectionString: string;
  releaseId?: string;
  allowLocalTest?: boolean;
  approvalArtifact?: SignedApprovalArtifact;
  approvalArtifactPath?: string;
  trustedRootPublicKey?: string;
  hostedApproval?: HostedExecutionApproval;
  psqlPath?: string;
  runPsql?: PsqlRunner;
}

export type SelectiveRuntimeStatus =
  | 'COMMITTED_VERIFIED'
  | 'COMMITTED_AFTER_ACK_LOSS'
  | 'UNCOMMITTED_CLEAN'
  | 'HALT_AND_INVESTIGATE'
  | 'PROBE_UNAVAILABLE';

export interface SelectiveRuntimeResult {
  status: SelectiveRuntimeStatus;
  releaseId: string;
  targetProjectRef: string;
  serverVersion: string;
  executionExitCode: number | null;
  executionDiagnostic: string | null;
  recovery: ReturnType<typeof evaluateReleaseProbe> | null;
  diagnostic: string;
}

function parseAndVerifyConnection(
  connectionString: string,
  allowLocalTest: boolean
): PsqlConnectionConfig {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('TARGET_VERIFICATION_FAILED: Invalid PostgreSQL connection URL. Credentials were not logged.');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('TARGET_VERIFICATION_FAILED: Only postgres:// or postgresql:// connection URLs are accepted.');
  }

  let username: string;
  let password: string;
  let database: string;
  try {
    username = decodeURIComponent(parsed.username).toLowerCase();
    password = decodeURIComponent(parsed.password);
    database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  } catch {
    throw new Error('TARGET_VERIFICATION_FAILED: Invalid URL encoding. Credentials were not logged.');
  }

  if (!username || !password || !database) {
    throw new Error('TARGET_VERIFICATION_FAILED: Username, password, and database are required in the connection URL.');
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal']);
  const isLocalTest = localHosts.has(host);

  if (isLocalTest) {
    if (!allowLocalTest) {
      throw new Error('TARGET_PROJECT_MISMATCH: Local database connections require explicit allowLocalTest opt-in.');
    }
    const verified = verifyTargetProjectConnection(connectionString, {
      allowLocalTest: true,
      expectedProjectRef: TARGET_STAGING_PROJECT,
    });
    return {
      host,
      port: Number(parsed.port || 5432),
      username,
      password,
      database,
      sslMode: (parsed.searchParams.get('sslmode') || 'disable').toLowerCase(),
      projectRef: TARGET_STAGING_PROJECT,
      isLocalTest: true,
      sanitizedConnectionInfo: verified.sanitizedConnectionInfo,
    };
  }

  const directMatch = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/);
  const poolerHostMatches = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(host);
  const poolerUserMatch = username.match(/^postgres\.([a-z0-9]+)$/);

  let detectedProjectRef: string | null = null;
  if (directMatch && username === 'postgres') {
    detectedProjectRef = directMatch[1];
  } else if (poolerHostMatches && poolerUserMatch) {
    detectedProjectRef = poolerUserMatch[1];
  }

  if (!detectedProjectRef) {
    throw new Error(
      'TARGET_VERIFICATION_FAILED: Connection must use the expected Supabase direct host/user or Supabase pooler host/user format.'
    );
  }

  if (detectedProjectRef !== TARGET_STAGING_PROJECT) {
    throw new Error(
      'TARGET_PROJECT_MISMATCH: Connection project ref does not match the approved Staging project ' +
        TARGET_STAGING_PROJECT +
        '.'
    );
  }

  const sslMode = (parsed.searchParams.get('sslmode') || 'require').toLowerCase();
  if (!['require', 'verify-ca', 'verify-full'].includes(sslMode)) {
    throw new Error('TARGET_VERIFICATION_FAILED: Hosted Supabase connections must require TLS.');
  }

  const verified = verifyTargetProjectConnection(connectionString, {
    expectedProjectRef: TARGET_STAGING_PROJECT,
  });

  return {
    host,
    port: Number(parsed.port || 5432),
    username,
    password,
    database,
    sslMode,
    projectRef: verified.projectRef,
    isLocalTest: false,
    sanitizedConnectionInfo: verified.sanitizedConnectionInfo,
  };
}

function redactDiagnostic(value: string, connection: PsqlConnectionConfig): string {
  let result = value || '';
  if (connection.password) result = result.replaceAll(connection.password, '[REDACTED]');
  return result.slice(0, 2000);
}

export const runPsql: PsqlRunner = (connection, sql, mode) => {
  const binary = process.env.PSQL_BIN || 'psql';
  const args = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-A', '-t'];

  if (mode === 'query') args.push('-c', sql);
  else args.push('-f', '-');

  const env = {
    ...process.env,
    PGHOST: connection.host,
    PGPORT: String(connection.port),
    PGUSER: connection.username,
    PGPASSWORD: connection.password,
    PGDATABASE: connection.database,
    PGSSLMODE: connection.sslMode,
    PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT || '10',
    PGAPPNAME: 'meta-ads-selective-release',
  };

  const result = spawnSync(binary, args, {
    input: mode === 'script' ? sql : undefined,
    encoding: 'utf8',
    env,
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });

  return {
    exitCode: result.status,
    stdout: result.stdout || '',
    stderr: redactDiagnostic(
      result.error ? result.error.message : result.stderr || '',
      connection
    ),
  };
};

function safeRun(
  runner: PsqlRunner,
  connection: PsqlConnectionConfig,
  sql: string,
  mode: PsqlMode
): PsqlRunResult {
  try {
    const result = runner(connection, sql, mode);
    return {
      exitCode: result.exitCode,
      stdout: result.stdout || '',
      stderr: redactDiagnostic(result.stderr || '', connection),
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: redactDiagnostic(error instanceof Error ? error.message : String(error), connection),
    };
  }
}

function parseServerVersion(output: string): { version: string; versionNum: number } {
  const line = output.trim().split(/\r?\n/).filter(Boolean).at(-1);
  const parts = line?.split('\t') ?? [];
  const version = parts[0]?.trim();
  const versionNum = Number(parts[1]?.trim());
  if (!version || !Number.isInteger(versionNum) || versionNum <= 0) {
    throw new Error('DATABASE_PREFLIGHT_FAILED: Could not parse PostgreSQL server version from the verified connection.');
  }
  return { version, versionNum };
}

function parseProbe(output: string): Parameters<typeof evaluateReleaseProbe>[0] {
  const line = output.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error('Release probe returned no result.');
  const value = JSON.parse(line) as Parameters<typeof evaluateReleaseProbe>[0];
  if (
    typeof value.registry_table_exists !== 'boolean' ||
    !('release_record' in value) ||
    !('meta_tables_count' in value) ||
    !('canonical_ledger_count' in value) ||
    typeof value.fence_trigger_exists !== 'boolean'
  ) {
    throw new Error('Release probe returned an incomplete result.');
  }
  return value;
}

export function executeSelectiveRelease(
  options: ExecuteSelectiveReleaseOptions
): SelectiveRuntimeResult {
  const connection = parseAndVerifyConnection(
    options.connectionString,
    options.allowLocalTest === true
  );

  const releaseId = options.releaseId ?? 'meta-ads-20261031-r1';
  const approval = options.hostedApproval;
  const approvalReference = approval?.reference;
  const signature = approval?.signature || process.env.META_ADS_OWNER_APPROVAL_SIGNATURE;
  const secretOrKey =
    approval?.secretOrPublicKey ||
    process.env.META_ADS_OWNER_APPROVAL_SECRET ||
    process.env.META_ADS_OWNER_PUBLIC_KEY;

  if (!connection.isLocalTest) {
    let artifact: SignedApprovalArtifact | null = options.approvalArtifact || null;
    if (!artifact) {
      const artifactPath =
        options.approvalArtifactPath || process.env.META_ADS_APPROVAL_ARTIFACT_PATH;
      if (artifactPath) {
        if (!fs.existsSync(artifactPath)) {
          throw new Error(
            `HOSTED_EXECUTION_BLOCKED: Approval artifact file not found at ${artifactPath}`
          );
        }
        try {
          artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        } catch (e) {
          throw new Error(
            `HOSTED_EXECUTION_BLOCKED: Malformed approval artifact JSON: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
    }

    if (artifact) {
      const pack = buildSelectiveExecutorPackage({
        targetProjectRef: TARGET_STAGING_PROJECT,
        releaseId,
      });

      const expectedMigrationHashes: Record<string, string> = {};
      for (const src of pack.sources) {
        expectedMigrationHashes[src.file] = src.sha256;
      }

      const trustedRoot =
        options.trustedRootPublicKey || loadTrustedOwnerRootPublicKey();

      const verification = verifySignedApprovalArtifact({
        artifact,
        trustedRootPublicKey: trustedRoot,
        expectedProjectRef: connection.projectRef,
        expectedReleaseId: releaseId,
        expectedReleasePackageDigest: pack.bundleSha256,
        expectedMigrationHashes,
      });

      if (!verification.valid) {
        throw new Error(
          `HOSTED_EXECUTION_BLOCKED: ${verification.reason || 'Cryptographic owner approval signature verification failed'}`
        );
      }
    } else {
      if (
        !(
          approval?.backupRestoreVerified === true &&
          approval.ownerApproved === true &&
          typeof approvalReference === 'string' &&
          approvalReference.trim().length > 0
        )
      ) {
        throw new Error(
          'HOSTED_EXECUTION_BLOCKED: A verified physical backup/restore rehearsal and explicit Project Owner approval reference are required.'
        );
      }

      if (!signature || !secretOrKey) {
        throw new Error(
          'HOSTED_EXECUTION_BLOCKED: Cryptographic owner approval signature and verification key/secret are required.'
        );
      }
      const isSignatureValid = verifyOwnerApprovalSignature({
        projectRef: connection.projectRef,
        releaseId,
        reference: approvalReference!.trim(),
        signature,
        secretOrPublicKey: secretOrKey,
      });
      if (!isSignatureValid) {
        throw new Error(
          'HOSTED_EXECUTION_BLOCKED: Cryptographic owner approval signature verification failed for target project ' +
            connection.projectRef +
            '.'
        );
      }
    }
  }

  const runner = options.runPsql ?? runPsql;
  const versionResult = safeRun(runner, connection, SERVER_VERSION_QUERY, 'query');
  if (versionResult.exitCode !== 0) {
    throw new Error(
      'DATABASE_PREFLIGHT_FAILED: Could not verify PostgreSQL version on ' +
        connection.sanitizedConnectionInfo +
        '. ' +
        versionResult.stderr
    );
  }

  const server = parseServerVersion(versionResult.stdout);
  verifyPostgresServerVersion(server.version, server.versionNum);

  const pack = buildSelectiveExecutorPackage({
    targetProjectRef: TARGET_STAGING_PROJECT,
    releaseId,
  });

  // Never retry automatically. A fresh connection probes the authoritative DB
  // state after both success and failure, including a lost COMMIT acknowledgement.
  const execution = safeRun(runner, connection, pack.sql, 'script');
  const probe = safeRun(runner, connection, PROBE_RELEASE_SQL(releaseId), 'query');

  if (probe.exitCode !== 0) {
    return {
      status: 'PROBE_UNAVAILABLE',
      releaseId,
      targetProjectRef: TARGET_STAGING_PROJECT,
      serverVersion: server.version,
      executionExitCode: execution.exitCode,
      executionDiagnostic: execution.stderr || null,
      recovery: null,
      diagnostic:
        'The execution result is unknown and the recovery probe could not connect. Do not rerun; restore connectivity and investigate. ' +
        probe.stderr,
    };
  }

  let recovery: ReturnType<typeof evaluateReleaseProbe>;
  try {
    recovery = evaluateReleaseProbe(parseProbe(probe.stdout), releaseId, pack.bundleSha256);
  } catch (error) {
    return {
      status: 'PROBE_UNAVAILABLE',
      releaseId,
      targetProjectRef: TARGET_STAGING_PROJECT,
      serverVersion: server.version,
      executionExitCode: execution.exitCode,
      executionDiagnostic: execution.stderr || null,
      recovery: null,
      diagnostic:
        'The recovery probe result could not be validated. Do not rerun; investigate the database state. ' +
        redactDiagnostic(error instanceof Error ? error.message : String(error), connection),
    };
  }

  if (recovery.status === 'COMMITTED_VERIFIED') {
    const ackLost = execution.exitCode !== 0;
    return {
      status: ackLost ? 'COMMITTED_AFTER_ACK_LOSS' : 'COMMITTED_VERIFIED',
      releaseId,
      targetProjectRef: TARGET_STAGING_PROJECT,
      serverVersion: server.version,
      executionExitCode: execution.exitCode,
      executionDiagnostic: execution.stderr || null,
      recovery,
      diagnostic: ackLost
        ? 'The database committed and the fresh-session probe verified the release. The client acknowledgement was lost; do not rerun.'
        : 'The database committed and the fresh-session probe verified the release.',
    };
  }

  if (recovery.status === 'UNCOMMITTED_CLEAN' && execution.exitCode !== 0) {
    return {
      status: 'UNCOMMITTED_CLEAN',
      releaseId,
      targetProjectRef: TARGET_STAGING_PROJECT,
      serverVersion: server.version,
      executionExitCode: execution.exitCode,
      executionDiagnostic: execution.stderr || null,
      recovery,
      diagnostic:
        'The release did not commit and the database is clean. No automatic retry was attempted; an operator may retry only after reviewing the execution error.',
    };
  }

  return {
    status: 'HALT_AND_INVESTIGATE',
    releaseId,
    targetProjectRef: TARGET_STAGING_PROJECT,
    serverVersion: server.version,
    executionExitCode: execution.exitCode,
    executionDiagnostic: execution.stderr || null,
    recovery,
    diagnostic:
      'Execution and recovery evidence are inconsistent. Rerunning is blocked; investigate and restore from a verified backup if required.',
  };
}

export interface CliArgs {
  approvalArtifactPath?: string;
  trustedRootPath?: string;
  releaseId?: string;
  allowLocalTest?: boolean;
  backupRestoreVerified?: boolean;
  ownerApproved?: boolean;
  approvalReference?: string;
  ownerSignature?: string;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--connection-string' || arg.startsWith('--connection-string=')) {
      throw new Error(
        'INSECURE_ARGUMENT: Passing database connection string via CLI argument is forbidden to prevent credential leakage. Set META_ADS_DATABASE_URL environment variable.'
      );
    }
    if (arg === '--owner-secret' || arg.startsWith('--owner-secret=')) {
      throw new Error(
        'INSECURE_ARGUMENT: Passing owner secret via CLI argument is forbidden. Use a signed approval artifact verified against the pinned owner root.'
      );
    }
    if (arg === '--owner-public-key' || arg.startsWith('--owner-public-key=')) {
      throw new Error(
        'INSECURE_ARGUMENT: Overriding the owner public key via CLI argument is forbidden. The owner trust root is pinned and independent.'
      );
    }
    if (arg === '--approval-artifact' && i + 1 < argv.length) {
      args.approvalArtifactPath = argv[++i];
    } else if (arg.startsWith('--approval-artifact=')) {
      args.approvalArtifactPath = arg.slice('--approval-artifact='.length);
    } else if (arg === '--trusted-root' && i + 1 < argv.length) {
      args.trustedRootPath = argv[++i];
    } else if (arg.startsWith('--trusted-root=')) {
      args.trustedRootPath = arg.slice('--trusted-root='.length);
    } else if (arg === '--release-id' && i + 1 < argv.length) {
      args.releaseId = argv[++i];
    } else if (arg.startsWith('--release-id=')) {
      args.releaseId = arg.slice('--release-id='.length);
    } else if (arg === '--allow-local-test') {
      args.allowLocalTest = true;
    } else if (arg === '--backup-restore-verified') {
      args.backupRestoreVerified = true;
    } else if (arg === '--owner-approved') {
      args.ownerApproved = true;
    } else if (arg === '--owner-approval-reference' && i + 1 < argv.length) {
      args.approvalReference = argv[++i];
    } else if (arg.startsWith('--owner-approval-reference=')) {
      args.approvalReference = arg.slice('--owner-approval-reference='.length);
    } else if (arg === '--owner-signature' && i + 1 < argv.length) {
      args.ownerSignature = argv[++i];
    } else if (arg.startsWith('--owner-signature=')) {
      args.ownerSignature = arg.slice('--owner-signature='.length);
    }
  }
  return args;
}

function runCli(): void {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  const connectionString = process.env.META_ADS_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'META_ADS_DATABASE_URL environment variable is required. Database connection URL is never passed via CLI arguments to prevent secret leakage in process lists.'
    );
  }

  const allowLocalTest = cliArgs.allowLocalTest ?? (process.env.META_ADS_ALLOW_LOCAL_TEST === '1');
  const backupRestoreVerified = cliArgs.backupRestoreVerified ?? (process.env.META_ADS_BACKUP_RESTORE_VERIFIED === '1');
  const ownerApproved = cliArgs.ownerApproved ?? (process.env.META_ADS_OWNER_APPROVED === '1');
  const reference = cliArgs.approvalReference || process.env.META_ADS_OWNER_APPROVAL_REFERENCE || '';
  const signature = cliArgs.ownerSignature || process.env.META_ADS_OWNER_APPROVAL_SIGNATURE;
  const secretOrPublicKey =
    process.env.META_ADS_OWNER_APPROVAL_SECRET ||
    process.env.META_ADS_OWNER_PUBLIC_KEY;

  let trustedRootPublicKey: string | undefined;
  if (cliArgs.trustedRootPath) {
    trustedRootPublicKey = loadTrustedOwnerRootPublicKey(cliArgs.trustedRootPath);
  }

  const result = executeSelectiveRelease({
    connectionString,
    releaseId: cliArgs.releaseId || process.env.META_ADS_RELEASE_ID,
    allowLocalTest,
    approvalArtifactPath: cliArgs.approvalArtifactPath,
    trustedRootPublicKey,
    hostedApproval: {
      backupRestoreVerified,
      ownerApproved,
      reference,
      signature,
      secretOrPublicKey,
    },
  });

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (
    result.status !== 'COMMITTED_VERIFIED' &&
    result.status !== 'COMMITTED_AFTER_ACK_LOSS'
  ) {
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('selective-runtime.ts')) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Selective release failed.');
    process.exitCode = 1;
  }
}
