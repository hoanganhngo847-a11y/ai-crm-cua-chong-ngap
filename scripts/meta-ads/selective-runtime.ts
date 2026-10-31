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
import { spawnSync } from 'node:child_process';
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

export interface HostedExecutionApproval {
  backupRestoreVerified: boolean;
  ownerApproved: boolean;
  reference: string;
}

export interface ExecuteSelectiveReleaseOptions {
  connectionString: string;
  releaseId?: string;
  allowLocalTest?: boolean;
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

  const approvalReference = options.hostedApproval?.reference;
  if (
    !connection.isLocalTest &&
    !(
      options.hostedApproval?.backupRestoreVerified === true &&
      options.hostedApproval.ownerApproved === true &&
      typeof approvalReference === 'string' &&
      approvalReference.trim().length > 0
    )
  ) {
    throw new Error(
      'HOSTED_EXECUTION_BLOCKED: A verified physical backup/restore rehearsal and explicit Project Owner approval reference are required.'
    );
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

  const releaseId = options.releaseId ?? 'meta-ads-20261031-r1';
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

function runCli(): void {
  const connectionString = process.env.META_ADS_DATABASE_URL;
  if (!connectionString) {
    throw new Error('META_ADS_DATABASE_URL is required. The value is never printed.');
  }

  const result = executeSelectiveRelease({
    connectionString,
    allowLocalTest: process.env.META_ADS_ALLOW_LOCAL_TEST === '1',
    hostedApproval: {
      backupRestoreVerified: process.env.META_ADS_BACKUP_RESTORE_VERIFIED === '1',
      ownerApproved: process.env.META_ADS_OWNER_APPROVED === '1',
      reference: process.env.META_ADS_OWNER_APPROVAL_REFERENCE || '',
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
