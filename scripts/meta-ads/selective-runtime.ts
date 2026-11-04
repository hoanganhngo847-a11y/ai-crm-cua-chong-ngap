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
import { createHash, createPublicKey, verify } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import {
  buildSelectiveExecutorPackage,
  evaluateReleaseProbe,
  PROBE_RELEASE_SQL,
  TARGET_STAGING_PROJECT,
  verifyPostgresServerVersion,
  verifyTargetProjectConnection,
  CURRENT_SOURCE_COMMIT,
  PINNED_SOURCE_HASHES,
  SELECTIVE_RELEASE_APPROVED_WRITE_GROUPS,
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
export const EXPECTED_OWNER_ROOT_FINGERPRINT =
  '4a06943d7db2e99d822e5f315344789cc16e9409ec96838a9e889ac2f2f404ce';
export const AUDIT_BASELINE_COMMIT = '0d21bb89b97cdcd1b82f08a72149e68f87b8ae2f';
export const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i;
export const GIT_COMMIT_SHA_REGEX = /^[0-9a-f]{40}$/i;

export function computePublicKeyFingerprint(pem: string): string {
  try {
    const pubKey = createPublicKey(pem.trim());
    const spkiDer = pubKey.export({ type: 'spki', format: 'der' });
    return createHash('sha256').update(spkiDer).digest('hex');
  } catch {
    return '';
  }
}

export function loadTrustedOwnerRootPublicKey(): string {
  if (!fs.existsSync(TRUSTED_OWNER_ROOT_PUB_PATH)) {
    throw new Error(
      `HOSTED_EXECUTION_BLOCKED: Trusted owner root public key file not found at ${TRUSTED_OWNER_ROOT_PUB_PATH}`
    );
  }
  const pem = fs.readFileSync(TRUSTED_OWNER_ROOT_PUB_PATH, 'utf8').trim();
  const fp = computePublicKeyFingerprint(pem);
  if (fp !== EXPECTED_OWNER_ROOT_FINGERPRINT) {
    throw new Error(
      `HOSTED_EXECUTION_BLOCKED: Trusted owner root public key fingerprint mismatch. Expected ${EXPECTED_OWNER_ROOT_FINGERPRINT}, found ${fp || 'INVALID_KEY'}`
    );
  }
  return pem;
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

export interface VerifySignedApprovalArtifactParams {
  artifact: unknown;
  trustedRootPublicKey: string;
  expectedProjectRef: string;
  expectedReleaseId: string;
  expectedSourceCommit?: string;
  expectedSnapshotCommit?: string;
  expectedReleasePackageDigest?: string;
  expectedMigrationHashes?: Record<string, string>;
  expectedApprovedWriteGroups?: readonly string[];
  backupManifestPath?: string;
  backupEvidencePath?: string;
  currentTime?: Date;
}

function readEvidenceFile(filePath: string | undefined, label: string): { bytes?: Buffer; reason?: string } {
  if (typeof filePath !== 'string' || !filePath.trim()) return { reason: `Actual ${label} file path is required` };
  let fd: number | undefined;
  try {
    const pathStat = fs.lstatSync(filePath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) return { reason: `${label} must be a regular, non-symlink file` };
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    if (!fs.fstatSync(fd).isFile()) return { reason: `${label} is not a regular file` };
    return { bytes: fs.readFileSync(fd) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { reason: `${label} file not found at ${filePath}` };
    return { reason: `${label} file could not be read: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function parseEvidenceJson(bytes: Buffer, label: string): { value?: Record<string, any>; reason?: string } {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { reason: `${label} must contain one JSON object` };
    return { value: value as Record<string, any> };
  } catch {
    return { reason: `${label} must contain valid JSON` };
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

export function verifySignedApprovalArtifact(
  params: VerifySignedApprovalArtifactParams
): { valid: boolean; reason?: string } {
  const {
    artifact,
    trustedRootPublicKey,
    expectedProjectRef,
    expectedReleaseId,
    expectedSourceCommit,
    expectedSnapshotCommit,
    expectedReleasePackageDigest,
    expectedMigrationHashes,
    expectedApprovedWriteGroups,
    backupManifestPath,
    backupEvidencePath,
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

  const expectedGroups = [...(expectedApprovedWriteGroups ?? SELECTIVE_RELEASE_APPROVED_WRITE_GROUPS)];
  const actualGroups = payload.approvedWriteGroups;
  if (
    !Array.isArray(actualGroups) ||
    actualGroups.length === 0 ||
    actualGroups.some((group) => !isNonEmptyString(group)) ||
    new Set(actualGroups).size !== actualGroups.length ||
    expectedGroups.length === 0 ||
    expectedGroups.some((group) => !isNonEmptyString(group)) ||
    new Set(expectedGroups).size !== expectedGroups.length ||
    JSON.stringify([...actualGroups].sort()) !== JSON.stringify([...expectedGroups].sort())
  ) {
    return { valid: false, reason: 'Approval approvedWriteGroups must be a unique string set exactly matching the release package' };
  }

  // Commit provenance validation
  if (
    !payload.sourceCommit ||
    typeof payload.sourceCommit !== 'string' ||
    !GIT_COMMIT_SHA_REGEX.test(payload.sourceCommit)
  ) {
    return {
      valid: false,
      reason: 'Invalid or missing sourceCommit: expected 40-character git commit SHA',
    };
  }
  if (expectedSourceCommit && payload.sourceCommit !== expectedSourceCommit) {
    return {
      valid: false,
      reason: `Source commit mismatch: expected '${expectedSourceCommit}', got '${payload.sourceCommit}'`,
    };
  }

  if (
    !payload.snapshotCommit ||
    typeof payload.snapshotCommit !== 'string' ||
    !GIT_COMMIT_SHA_REGEX.test(payload.snapshotCommit)
  ) {
    return {
      valid: false,
      reason: 'Invalid or missing snapshotCommit: expected 40-character git commit SHA',
    };
  }
  if (expectedSnapshotCommit && payload.snapshotCommit !== expectedSnapshotCommit) {
    return {
      valid: false,
      reason: `Snapshot commit mismatch: expected '${expectedSnapshotCommit}', got '${payload.snapshotCommit}'`,
    };
  }

  // Release package digest validation
  if (
    !payload.releasePackageDigest ||
    typeof payload.releasePackageDigest !== 'string' ||
    !SHA256_HEX_REGEX.test(payload.releasePackageDigest)
  ) {
    return {
      valid: false,
      reason: `Invalid or placeholder releasePackageDigest: expected 64-character hex SHA-256 string, got '${payload.releasePackageDigest}'`,
    };
  }
  if (expectedReleasePackageDigest && payload.releasePackageDigest !== expectedReleasePackageDigest) {
    return {
      valid: false,
      reason: `Release package digest mismatch: expected '${expectedReleasePackageDigest}', got '${payload.releasePackageDigest}'`,
    };
  }

  // Backup manifest digest validation
  if (
    !payload.backupManifestDigest ||
    typeof payload.backupManifestDigest !== 'string' ||
    !SHA256_HEX_REGEX.test(payload.backupManifestDigest)
  ) {
    return {
      valid: false,
      reason: `Invalid or placeholder backupManifestDigest: expected 64-character hex SHA-256 string, got '${payload.backupManifestDigest}'`,
    };
  }
  const manifestRead = readEvidenceFile(backupManifestPath, 'Backup manifest');
  if (!manifestRead.bytes) return { valid: false, reason: manifestRead.reason };
  const manifestDigest = createHash('sha256').update(manifestRead.bytes).digest('hex');
  if (manifestDigest !== payload.backupManifestDigest.toLowerCase()) {
    return { valid: false, reason: `Backup manifest digest mismatch: computed '${manifestDigest}' from file, approval payload specified '${payload.backupManifestDigest}'` };
  }
  const manifestParsed = parseEvidenceJson(manifestRead.bytes, 'Backup manifest');
  if (!manifestParsed.value) return { valid: false, reason: manifestParsed.reason };
  const manifest = manifestParsed.value;
  const manifestSource = manifest.source;
  if (
    manifest.format !== 'crm-staging-backup-manifest/v1' ||
    !isNonEmptyString(manifest.backupId) ||
    !manifestSource || typeof manifestSource !== 'object' ||
    manifestSource.projectRef !== expectedProjectRef ||
    manifestSource.environment !== 'staging' ||
    manifestSource.auditBaselineCommit !== payload.sourceCommit ||
    manifestSource.snapshotCommit !== payload.snapshotCommit ||
    typeof manifestSource.commitFullSha !== 'string' ||
    !GIT_COMMIT_SHA_REGEX.test(manifestSource.commitFullSha) ||
    !isNonEmptyString(manifestSource.serverVersion) ||
    !isNonEmptyString(manifestSource.dumpToolVersion) ||
    !Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0 ||
    manifest.artifacts.some((entry: any) => !entry || typeof entry !== 'object' || !isNonEmptyString(entry.path) || !isNonEmptyString(entry.kind))
  ) {
    return { valid: false, reason: 'Backup manifest schema or staging provenance is invalid' };
  }

  // Backup evidence digest validation
  if (
    !payload.backupEvidenceDigest ||
    typeof payload.backupEvidenceDigest !== 'string' ||
    !SHA256_HEX_REGEX.test(payload.backupEvidenceDigest)
  ) {
    return {
      valid: false,
      reason: `Invalid or placeholder backupEvidenceDigest: expected 64-character hex SHA-256 string, got '${payload.backupEvidenceDigest}'`,
    };
  }
  const evidenceRead = readEvidenceFile(backupEvidencePath, 'Backup/restore evidence');
  if (!evidenceRead.bytes) return { valid: false, reason: evidenceRead.reason };
  const evidenceDigest = createHash('sha256').update(evidenceRead.bytes).digest('hex');
  if (evidenceDigest !== payload.backupEvidenceDigest.toLowerCase()) {
    return { valid: false, reason: `Backup evidence digest mismatch: computed '${evidenceDigest}' from file, approval payload specified '${payload.backupEvidenceDigest}'` };
  }
  const evidenceParsed = parseEvidenceJson(evidenceRead.bytes, 'Backup/restore evidence');
  if (!evidenceParsed.value) return { valid: false, reason: evidenceParsed.reason };
  const evidence = evidenceParsed.value;
  const startedAt = isValidTimestamp(evidence.startedAt) ? Date.parse(evidence.startedAt) : NaN;
  const completedAt = isValidTimestamp(evidence.completedAt) ? Date.parse(evidence.completedAt) : NaN;
  if (
    evidence.format !== 'crm-staging-backup-restore-evidence/v1' ||
    evidence.backupId !== manifest.backupId ||
    evidence.projectRef !== expectedProjectRef ||
    evidence.sourceEnvironment !== 'staging' ||
    evidence.backupManifestDigest !== manifestDigest ||
    evidence.backupStatus !== 'PASSED' || evidence.restoreStatus !== 'PASSED' || evidence.status !== 'PASSED' ||
    !evidence.restoreTarget || typeof evidence.restoreTarget !== 'object' ||
    evidence.restoreTarget.type !== 'disposable-isolated' || !isNonEmptyString(evidence.restoreTarget.identity) ||
    !Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt
  ) {
    return { valid: false, reason: 'Backup/restore evidence schema, success status, target, project, or timestamps are invalid' };
  }

  // Migration hashes must be an exact key/value set for this release package.
  if (!payload.migrationHashes || typeof payload.migrationHashes !== 'object' || Array.isArray(payload.migrationHashes)) {
    return { valid: false, reason: 'Approval missing migrationHashes dictionary' };
  }
  const expectedHashes = expectedMigrationHashes ?? PINNED_SOURCE_HASHES;
  const actualMigrationFiles = Object.keys(payload.migrationHashes).sort();
  const expectedMigrationFiles = Object.keys(expectedHashes).sort();
  if (JSON.stringify(actualMigrationFiles) !== JSON.stringify(expectedMigrationFiles)) {
    return { valid: false, reason: 'Approval migrationHashes keys must exactly match the release package migration set' };
  }
  for (const file of expectedMigrationFiles) {
    const hash = payload.migrationHashes[file];
    if (typeof hash !== 'string' || !SHA256_HEX_REGEX.test(hash)) {
      return { valid: false, reason: `Invalid migration hash format for '${file}': expected 64-character hex SHA-256, got '${hash}'` };
    }
    if (hash.toLowerCase() !== expectedHashes[file].toLowerCase()) {
      return { valid: false, reason: `Migration hash mismatch for '${file}': expected '${expectedHashes[file]}', got '${hash}'` };
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

export interface ExecuteSelectiveReleaseOptions {
  connectionString: string;
  releaseId?: string;
  allowLocalTest?: boolean;
  approvalArtifact?: SignedApprovalArtifact;
  approvalArtifactPath?: string;
  backupManifestPath?: string;
  backupEvidencePath?: string;
  trustedRootPublicKey?: string;
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

    if (!artifact) {
      throw new Error(
        'HOSTED_EXECUTION_BLOCKED: A cryptographically signed approval artifact (crm-owner-approval/v1) is strictly required for hosted execution.'
      );
    }

    // Pinned owner root cannot be overridden in hosted execution
    const trustedRoot = loadTrustedOwnerRootPublicKey();
    if (options.trustedRootPublicKey) {
      const callerFp = computePublicKeyFingerprint(options.trustedRootPublicKey);
      if (callerFp !== EXPECTED_OWNER_ROOT_FINGERPRINT) {
        throw new Error(
          'HOSTED_EXECUTION_BLOCKED: Overriding the trusted owner root public key is forbidden in hosted execution.'
        );
      }
    }

    const pack = buildSelectiveExecutorPackage({
      targetProjectRef: TARGET_STAGING_PROJECT,
      releaseId,
    });

    const expectedMigrationHashes: Record<string, string> = {};
    for (const src of pack.sources) {
      expectedMigrationHashes[src.file] = src.sha256;
    }

    const backupManifestPath =
      options.backupManifestPath || process.env.META_ADS_BACKUP_MANIFEST_PATH;
    const backupEvidencePath =
      options.backupEvidencePath || process.env.META_ADS_BACKUP_EVIDENCE_PATH;
    if (!backupManifestPath) {
      throw new Error('HOSTED_EXECUTION_BLOCKED: Actual verified backup manifest file is required; digest-only inputs are forbidden.');
    }
    if (!backupEvidencePath) {
      throw new Error('HOSTED_EXECUTION_BLOCKED: Actual verified backup/restore evidence file is required; digest-only inputs are forbidden.');
    }

    const verification = verifySignedApprovalArtifact({
      artifact,
      trustedRootPublicKey: trustedRoot,
      expectedProjectRef: connection.projectRef,
      expectedReleaseId: releaseId,
      expectedSourceCommit: AUDIT_BASELINE_COMMIT,
      expectedSnapshotCommit: CURRENT_SOURCE_COMMIT,
      expectedReleasePackageDigest: pack.bundleSha256,
      expectedMigrationHashes,
      expectedApprovedWriteGroups: pack.approvedWriteGroups,
      backupManifestPath,
      backupEvidencePath,
    });

    if (!verification.valid) {
      throw new Error(
        `HOSTED_EXECUTION_BLOCKED: ${verification.reason || 'Cryptographic owner approval signature verification failed'}`
      );
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
  backupManifestPath?: string;
  backupEvidencePath?: string;
  releaseId?: string;
  allowLocalTest?: boolean;
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
    if (arg === '--trusted-root' || arg.startsWith('--trusted-root=')) {
      throw new Error(
        'INSECURE_ARGUMENT: Overriding the trusted root public key via CLI argument is forbidden. The owner trust root is pinned and immutable.'
      );
    }
    if (
      arg === '--owner-approved' ||
      arg === '--backup-restore-verified' ||
      arg === '--owner-approval-reference' ||
      arg.startsWith('--owner-approval-reference=') ||
      arg === '--owner-signature' ||
      arg.startsWith('--owner-signature=')
    ) {
      throw new Error(
        'LEGACY_ARGUMENT_FORBIDDEN: Legacy boolean approval flags and text references are forbidden. Hosted execution requires a signed approval artifact (--approval-artifact=<path>).'
      );
    }
    if (arg === '--approval-artifact' && i + 1 < argv.length) {
      args.approvalArtifactPath = argv[++i];
    } else if (arg.startsWith('--approval-artifact=')) {
      args.approvalArtifactPath = arg.slice('--approval-artifact='.length);
    } else if (arg === '--backup-manifest' && i + 1 < argv.length) {
      args.backupManifestPath = argv[++i];
    } else if (arg.startsWith('--backup-manifest=')) {
      args.backupManifestPath = arg.slice('--backup-manifest='.length);
    } else if (arg === '--backup-evidence' && i + 1 < argv.length) {
      args.backupEvidencePath = argv[++i];
    } else if (arg.startsWith('--backup-evidence=')) {
      args.backupEvidencePath = arg.slice('--backup-evidence='.length);
    } else if (arg === '--release-id' && i + 1 < argv.length) {
      args.releaseId = argv[++i];
    } else if (arg.startsWith('--release-id=')) {
      args.releaseId = arg.slice('--release-id='.length);
    } else if (arg === '--allow-local-test') {
      args.allowLocalTest = true;
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

  const result = executeSelectiveRelease({
    connectionString,
    releaseId: cliArgs.releaseId || process.env.META_ADS_RELEASE_ID,
    allowLocalTest,
    approvalArtifactPath:
      cliArgs.approvalArtifactPath || process.env.META_ADS_APPROVAL_ARTIFACT_PATH,
    backupManifestPath:
      cliArgs.backupManifestPath || process.env.META_ADS_BACKUP_MANIFEST_PATH,
    backupEvidencePath:
      cliArgs.backupEvidencePath || process.env.META_ADS_BACKUP_EVIDENCE_PATH,
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
