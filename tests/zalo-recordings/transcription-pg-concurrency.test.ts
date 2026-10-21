/**
 * Native PostgreSQL Concurrency & Targeted Claim Proof Test Suite
 *
 * Verifies real multi-connection PostgreSQL 17 concurrency behaviors:
 * 1. Two separate worker connections targeting the same due ID -> exactly 1 claim
 * 2. Bulk worker vs targeted worker concurrency race -> single owner, no double claim
 * 3. Held row lock on PENDING target returns 0 promptly without statement_timeout
 * 4. Held row lock on EXPIRED PROCESSING target returns 0 promptly without statement_timeout
 * 5. Fresh token fences stale completion: reclaimed lease prevents stale worker from completing
 * 6. Targeted claim leaves unrelated PENDING and expired rows byte-for-byte unchanged
 * 7. attempts=10 expired lease bounds counter at 10 without check constraint exception; idempotent FAILED state
 * 8. NULL or mismatched p_company returns 0 rows without touching records
 *
 * Strict Isolation & Determinism Guarantees:
 * - Fail-closed localhost host guard
 * - Uniquely created, ephemeral database per test run (isolated from local stack and shared DB)
 * - Safe execFileSync/spawn argument arrays with finite timeouts and strict exit code propagation
 * - Deterministic lock-ready barrier (interactive child psql) replacing sleep races
 * - Dropping the ephemeral database handles all cleanup; no global audit trigger disabling
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PLATFORM_STUBS } from '../zalo/helpers/pglite-supabase';

// ----------------------------------------------------------------------------
// Fail-Closed Localhost Environment Guard
// ----------------------------------------------------------------------------
const testUrl = process.env.ZALO_RECORDING_TEST_URL || 'http://127.0.0.1:54321';
const parsedUrl = new URL(testUrl);
if (!['127.0.0.1', 'localhost'].includes(parsedUrl.hostname)) {
  throw new Error(
    `[FAIL-CLOSED] Localhost database required. Refusing to run against ${parsedUrl.hostname}`
  );
}

function getDeterministicPostgresContainer(): string {
  let projectId = 'ai-crm-cua-chong-ngap';
  try {
    const configPath = path.resolve(__dirname, '../../supabase/config.toml');
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      const match = content.match(/project_id\s*=\s*["']([^"']+)["']/);
      if (match?.[1]) {
        projectId = match[1].trim();
      }
    }
  } catch {}

  const expectedContainer = process.env.SUPABASE_DB_CONTAINER || `supabase_db_${projectId}`;
  if (!/^[a-zA-Z0-9_.-]+$/.test(expectedContainer)) {
    throw new Error(`[FAIL-CLOSED] Invalid container name format: "${expectedContainer}"`);
  }

  try {
    const isRunning = execFileSync(
      'docker',
      ['inspect', '-f', '{{.State.Running}}', expectedContainer],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }
    ).trim();

    if (isRunning !== 'true') {
      throw new Error(`Container "${expectedContainer}" is not running.`);
    }
    return expectedContainer;
  } catch (err: any) {
    throw new Error(
      `[FAIL-CLOSED] Failed to resolve deterministic Supabase DB container "${expectedContainer}": ${err?.message || err}`
    );
  }
}

function verifyRequiredRoles(container: string): void {
  const requiredRoles = [
    'anon',
    'authenticated',
    'service_role',
    'supabase_auth_admin',
    'authenticator',
  ];
  const sql = "SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'supabase_auth_admin', 'authenticator');";
  const out = execFileSync(
    'docker',
    ['exec', '-i', container, 'psql', '-t', '-A', '-U', 'postgres', '-d', 'postgres', '-c', sql],
    { encoding: 'utf8', timeout: 5000 }
  );
  const foundRoles = new Set(
    out
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean)
  );
  const missing = requiredRoles.filter((r) => !foundRoles.has(r));
  if (missing.length > 0) {
    throw new Error(`[FAIL-CLOSED] Required cluster roles missing from Supabase container: ${missing.join(', ')}`);
  }
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number;
  durationMs: number;
}

function spawnPsql(
  container: string,
  dbName: string,
  sql: string,
  timeoutMs = 15000
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(
      'docker',
      ['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', dbName],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`spawnPsql timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code === null) {
          resolve({ stdout, stderr, code: -1, durationMs: Date.now() - start });
        } else {
          resolve({ stdout, stderr, code, durationMs: Date.now() - start });
        }
      }
    });

    child.stdin.write(sql);
    child.stdin.end();
  });
}

function execPsqlSync(container: string, dbName: string, sql: string, timeoutMs = 25000): string {
  return execFileSync(
    'docker',
    ['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', dbName],
    { input: sql, encoding: 'utf8', timeout: timeoutMs }
  );
}

function queryJsonSync<T = any>(container: string, dbName: string, sql: string, timeoutMs = 10000): T {
  const cleanSql = sql.trim().replace(/;+$/, '');
  const jsonSql = `SELECT coalesce(json_agg(t), '[]'::json)::text FROM (${cleanSql}) t;`;
  const out = execFileSync(
    'docker',
    ['exec', '-i', container, 'psql', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', dbName],
    { input: jsonSql, encoding: 'utf8', timeout: timeoutMs }
  ).trim();
  return JSON.parse(out);
}

interface InteractiveLockSession {
  awaitLockReady: () => Promise<void>;
  release: () => Promise<void>;
  dispose: () => void;
}

function startInteractiveLockSession(
  container: string,
  dbName: string,
  txId: string,
  marker: string
): InteractiveLockSession {
  const child = spawn(
    'docker',
    ['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', dbName],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );

  let stdout = '';
  let stderr = '';
  let lockReadyResolved = false;
  let resolveReady!: () => void;
  let rejectReady!: (err: any) => void;

  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const timer = setTimeout(() => {
    if (!lockReadyResolved) {
      lockReadyResolved = true;
      child.kill('SIGKILL');
      rejectReady(new Error(`Timed out waiting for lock marker "${marker}". Stderr: ${stderr}`));
    }
  }, 10000);

  child.on('error', (err) => {
    clearTimeout(timer);
    if (!lockReadyResolved) {
      lockReadyResolved = true;
      rejectReady(err);
    }
  });

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    if (!lockReadyResolved && stdout.includes(marker)) {
      lockReadyResolved = true;
      clearTimeout(timer);
      resolveReady();
    }
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const lockAcquireSql = `
    BEGIN;
    SELECT '${marker}' AS lock_status, id FROM public.zalo_call_transcriptions WHERE id = '${txId}' FOR UPDATE;
  `;
  child.stdin.write(lockAcquireSql);

  let released = false;
  return {
    awaitLockReady: () => readyPromise,
    release: () => {
      if (released) return Promise.resolve();
      released = true;
      return new Promise<void>((resolve, reject) => {
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Interactive lock session exited with code ${code}: ${stderr}`));
        });
        child.stdin.write('\nCOMMIT;\n');
        child.stdin.end();
      });
    },
    dispose: () => {
      if (!child.killed) {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
    },
  };
}

let passCount = 0;
function testPass(msg: string) {
  console.log(`[PASS] ${msg}`);
  passCount++;
}

async function runPgConcurrencyTestSuite() {
  console.log('================================================================');
  console.log('STARTING NATIVE POSTGRESQL CONCURRENCY TEST SUITE (EPHEMERAL DB)');
  console.log('================================================================\n');

  const container = getDeterministicPostgresContainer();
  verifyRequiredRoles(container);

  // Generate randomized, unique ephemeral database name
  const randomSuffix = randomBytes(8).toString('hex');
  const dbName = `zalo_test_eph_${Date.now()}_${randomSuffix}`;
  if (!/^[a-zA-Z0-9_]{1,63}$/.test(dbName)) {
    throw new Error(`Invalid ephemeral DB name: "${dbName}"`);
  }

  const activeSessions: InteractiveLockSession[] = [];
  let dbCreated = false;

  try {
    // 1. Create empty ephemeral database
    console.log(`[pg-concurrency] Bootstrapping ephemeral database "${dbName}" on container "${container}"...`);
    execFileSync(
      'docker',
      ['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', `CREATE DATABASE ${dbName};`],
      { encoding: 'utf8', timeout: 10000 }
    );
    dbCreated = true;

    // 2. Apply platform stubs (with CREATE ROLE lines omitted)
    const platformStubsNoRoles = PLATFORM_STUBS
      .split('\n')
      .filter((line) => !line.trim().startsWith('CREATE ROLE'))
      .join('\n');
    execPsqlSync(container, dbName, platformStubsNoRoles);

    // 3. Apply ALL repo migrations in sorted order
    const migrationsDir = path.resolve(__dirname, '../../supabase/migrations');
    const migrationFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of migrationFiles) {
      const migrationSql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      execPsqlSync(container, dbName, migrationSql, 25000);
    }
    console.log(`[pg-concurrency] Ephemeral database "${dbName}" initialized successfully with all migrations.`);

    // Generate randomized company & device fixtures
    const companyA = randomUUID();
    const companyB = randomUUID();
    const deviceA = randomUUID();
    const deviceHash = randomBytes(32).toString('hex');

    function createReadyJob(
      companyId: string,
      options?: {
        status?: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
        attempts?: number;
        maxAttempts?: number;
        leaseExpiresAtSql?: string;
        nextRunAtSql?: string;
        recordingStatus?: 'READY' | 'UPLOADING';
        recordingPath?: string;
      }
    ): { callId: string; txId: string } {
      const callId = randomUUID();
      const txId = randomUUID();
      const status = options?.status || 'PENDING';
      const attempts = options?.attempts ?? 0;
      const maxAttempts = options?.maxAttempts ?? 3;
      const recStatus = options?.recordingStatus || 'READY';
      const recPath = options?.recordingPath !== undefined ? options.recordingPath : `${companyId}/${callId}.mp4`;
      const leaseSql = options?.leaseExpiresAtSql || 'NULL';
      const nextRunSql = options?.nextRunAtSql || 'now()';
      const lockTokenSql = status === 'PROCESSING' ? 'gen_random_uuid()' : 'NULL';

      const insertSql = `
        INSERT INTO public.zalo_personal_calls (
          id, company_id, device_id, local_call_id, zalo_account_key, direction,
          remote_display_name, remote_display_name_normalized, identity_confidence,
          started_at, ended_at, duration_seconds, agent_version, audio_validation,
          recording_status, recording_path, recording_mime, recording_bytes,
          recording_sha256, payload_fingerprint, upload_lease, upload_lease_until,
          transcript_status
        ) VALUES (
          '${callId}', '${companyId}', '${deviceA}', gen_random_uuid(), gen_random_uuid(), 'INBOUND',
          'Customer Test', 'customer test', 'MEDIUM',
          now() - interval '10 seconds', now(), 10, '1.0.0', '{"channel_layout": "stereo"}'::jsonb,
          '${recStatus}', '${recPath}', 'audio/mp4', 1024,
          '${randomBytes(32).toString('hex')}', '${randomBytes(32).toString('hex')}', gen_random_uuid(), now() + interval '1 hour',
          '${status}'
        );

        INSERT INTO public.zalo_call_transcriptions (
          id, company_id, call_id, status, provider, language, raw_channel_layout,
          attempts, max_attempts, next_run_at, lease_expires_at, lock_token
        ) VALUES (
          '${txId}', '${companyId}', '${callId}', '${status}', 'OPENAI', 'vi', 'stereo',
          ${attempts}, ${maxAttempts}, ${nextRunSql}, ${leaseSql}, ${lockTokenSql}
        );
      `;
      execPsqlSync(container, dbName, insertSql);
      return { callId, txId };
    }

    // Setup test companies and device
    execPsqlSync(
      container,
      dbName,
      `
      INSERT INTO public.companies (id, name) VALUES
        ('${companyA}', 'Native PG Concurrency A'),
        ('${companyB}', 'Native PG Concurrency B');
      INSERT INTO public.zalo_recording_devices (id, company_id, device_name, device_key_hash) VALUES
        ('${deviceA}', '${companyA}', 'Native Test Device', '${deviceHash}');
      `
    );

    // ========================================================================
    // TEST 1: Two parallel workers target the same due ID -> exactly 1 claim
    // ========================================================================
    const job1 = createReadyJob(companyA);
    const worker1Sql = `SELECT count(*) FROM public.zalo_claim_transcription_job('${companyA}'::uuid, '${job1.txId}'::uuid, 'worker_1', 300);`;
    const worker2Sql = `SELECT count(*) FROM public.zalo_claim_transcription_job('${companyA}'::uuid, '${job1.txId}'::uuid, 'worker_2', 300);`;

    const [w1Res, w2Res] = await Promise.all([
      spawnPsql(container, dbName, worker1Sql),
      spawnPsql(container, dbName, worker2Sql),
    ]);

    assert.equal(w1Res.code, 0, `Worker 1 failed: ${w1Res.stderr}`);
    assert.equal(w2Res.code, 0, `Worker 2 failed: ${w2Res.stderr}`);

    const w1Count = Number.parseInt(w1Res.stdout.match(/\n\s*(\d+)\s*\n/)?.[1] || '0', 10);
    const w2Count = Number.parseInt(w2Res.stdout.match(/\n\s*(\d+)\s*\n/)?.[1] || '0', 10);
    assert.equal(w1Count + w2Count, 1, `Exactly one worker must claim the job. W1=${w1Count}, W2=${w2Count}`);

    const job1Rows = queryJsonSync(
      container,
      dbName,
      `SELECT status, locked_by FROM public.zalo_call_transcriptions WHERE id = '${job1.txId}'`
    );
    assert.equal(job1Rows[0].status, 'PROCESSING');
    assert.ok(['worker_1', 'worker_2'].includes(job1Rows[0].locked_by));
    testPass('1: Real 2-worker race on same due ID claims exactly once across separate DB connections');

    // ========================================================================
    // TEST 2: Bulk worker vs targeted worker race -> exactly one owner
    // ========================================================================
    const job2 = createReadyJob(companyA);
    const bulkSql = `SELECT count(*) FROM public.zalo_claim_transcription_jobs(1, 'worker_bulk', 300) WHERE id = '${job2.txId}';`;
    const targetSql = `SELECT count(*) FROM public.zalo_claim_transcription_job('${companyA}'::uuid, '${job2.txId}'::uuid, 'worker_target', 300);`;

    const [bulkRes, targetRes] = await Promise.all([
      spawnPsql(container, dbName, bulkSql),
      spawnPsql(container, dbName, targetSql),
    ]);

    assert.equal(bulkRes.code, 0, bulkRes.stderr);
    assert.equal(targetRes.code, 0, targetRes.stderr);

    const bulkCount = Number.parseInt(bulkRes.stdout.match(/\n\s*(\d+)\s*\n/)?.[1] || '0', 10);
    const targetCount = Number.parseInt(targetRes.stdout.match(/\n\s*(\d+)\s*\n/)?.[1] || '0', 10);
    assert.equal(
      bulkCount + targetCount,
      1,
      `Bulk vs target race must result in exactly 1 claim. Bulk=${bulkCount}, Target=${targetCount}`
    );
    testPass('2: Bulk vs targeted worker race results in exactly one owner, no duplicate or deadlock');

    // ========================================================================
    // TEST 3: Held row lock on PENDING target returns 0 promptly with statement_timeout=750ms
    // (Explicit lock-ready barrier replacing sleep races)
    // ========================================================================
    const job3 = createReadyJob(companyA);
    const lock3Session = startInteractiveLockSession(container, dbName, job3.txId, 'PENDING_LOCK_ACQUIRED');
    activeSessions.push(lock3Session);

    try {
      await lock3Session.awaitLockReady();

      // Connection 2 sets statement_timeout='750ms' and attempts claim while lock is held
      const trySql = `SET statement_timeout = '750ms'; SELECT count(*) FROM public.zalo_claim_transcription_job('${companyA}'::uuid, '${job3.txId}'::uuid);`;
      const p2Res = await spawnPsql(container, dbName, trySql);

      assert.equal(p2Res.code, 0, `Connection 2 must not fail or time out: ${p2Res.stderr}`);
      assert.ok(
        !p2Res.stderr.includes('statement timeout') && !p2Res.stdout.includes('statement timeout'),
        'Must not hit statement timeout'
      );
      const p2Count = Number.parseInt(p2Res.stdout.match(/\n\s*(\d+)\s*\n/)?.[1] || '0', 10);
      assert.equal(p2Count, 0, 'Connection 2 must skip locked PENDING row and return 0');

      await lock3Session.release();
      testPass('3: Held PENDING lock returns 0 promptly without statement timeout (explicit barrier verified)');
    } finally {
      lock3Session.dispose();
    }

    // ========================================================================
    // TEST 4: Held row lock on EXPIRED PROCESSING target returns 0 promptly under 750ms
    // ========================================================================
    const job4 = createReadyJob(companyA, {
      status: 'PROCESSING',
      leaseExpiresAtSql: "now() - interval '10 seconds'",
      attempts: 1,
      maxAttempts: 3,
    });

    const lock4Session = startInteractiveLockSession(container, dbName, job4.txId, 'EXPIRED_LOCK_ACQUIRED');
    activeSessions.push(lock4Session);

    try {
      await lock4Session.awaitLockReady();

      const tryProcSql = `SET statement_timeout = '750ms'; SELECT count(*) FROM public.zalo_claim_transcription_job('${companyA}'::uuid, '${job4.txId}'::uuid);`;
      const procP2Res = await spawnPsql(container, dbName, tryProcSql);

      assert.equal(procP2Res.code, 0, `Connection 2 must not time out on expired processing lock: ${procP2Res.stderr}`);
      assert.ok(
        !procP2Res.stderr.includes('statement timeout') && !procP2Res.stdout.includes('statement timeout'),
        'Must not hit statement timeout'
      );
      const procP2Count = Number.parseInt(procP2Res.stdout.match(/\n\s*(\d+)\s*\n/)?.[1] || '0', 10);
      assert.equal(procP2Count, 0, 'Connection 2 must skip locked EXPIRED PROCESSING row and return 0');

      await lock4Session.release();
      testPass('4: Held EXPIRED PROCESSING lock returns 0 promptly without statement timeout (explicit barrier verified)');
    } finally {
      lock4Session.dispose();
    }

    // ========================================================================
    // TEST 5: Fresh token fences stale completion: expired lease reclaim generates fresh fencing token
    // ========================================================================
    const job5 = createReadyJob(companyA);
    // Claim 1
    const claim1Data = queryJsonSync(
      container,
      dbName,
      `SELECT * FROM public.zalo_claim_transcription_job('${companyA}'::uuid, '${job5.txId}'::uuid, 'worker_first', 300);`
    );
    assert.equal(claim1Data.length, 1);
    const token1 = claim1Data[0].lock_token;

    // Simulate lease expiration
    execPsqlSync(
      container,
      dbName,
      `UPDATE public.zalo_call_transcriptions SET lease_expires_at = now() - interval '5 seconds' WHERE id = '${job5.txId}';`
    );

    // Reclaim & claim by Worker 2
    const claim2Data = queryJsonSync(
      container,
      dbName,
      `SELECT * FROM public.zalo_claim_transcription_job('${companyA}'::uuid, '${job5.txId}'::uuid, 'worker_second', 300);`
    );
    assert.equal(claim2Data.length, 1);
    const token2 = claim2Data[0].lock_token;
    assert.notEqual(token1, token2, 'Reclaimed job must receive fresh lock token');

    // Worker 1 attempts to complete with stale token1 -> fails with TRANSCRIPTION_LOCK_LOST
    const staleCompleteRes = await spawnPsql(
      container,
      dbName,
      `SELECT public.zalo_complete_transcription('${companyA}'::uuid, '${job5.txId}'::uuid, '${token1}'::uuid, 'Stale text', '[]'::jsonb);`
    );
    assert.ok(
      staleCompleteRes.stderr.includes('TRANSCRIPTION_LOCK_LOST') ||
        staleCompleteRes.stdout.includes('TRANSCRIPTION_LOCK_LOST'),
      'Stale token completion must be fenced with TRANSCRIPTION_LOCK_LOST'
    );

    // Worker 2 completes with fresh token2 -> succeeds
    const freshCompleteRes = await spawnPsql(
      container,
      dbName,
      `SELECT public.zalo_complete_transcription('${companyA}'::uuid, '${job5.txId}'::uuid, '${token2}'::uuid, 'Valid text', '[]'::jsonb);`
    );
    assert.equal(freshCompleteRes.code, 0, freshCompleteRes.stderr);

    const job5Final = queryJsonSync(
      container,
      dbName,
      `SELECT status, full_transcript FROM public.zalo_call_transcriptions WHERE id = '${job5.txId}'`
    );
    assert.equal(job5Final[0].status, 'COMPLETED');
    assert.equal(job5Final[0].full_transcript, 'Valid text');
    testPass('5: Fresh token fences stale completion: expired lease reclaim generates fresh fencing token');

    // ========================================================================
    // TEST 6: Targeted call leaves unrelated PENDING AND expired rows byte-for-byte unchanged
    // ========================================================================
    const targetJob = createReadyJob(companyA);
    const unrelatedPending = createReadyJob(companyA);
    const unrelatedExpired = createReadyJob(companyA, {
      status: 'PROCESSING',
      leaseExpiresAtSql: "now() - interval '30 seconds'",
      attempts: 1,
      maxAttempts: 3,
    });

    const getSnapshotSql = `
      SELECT id, status, attempts, max_attempts, next_run_at, lease_expires_at, lock_token, updated_at
      FROM public.zalo_call_transcriptions
      WHERE id IN ('${unrelatedPending.txId}', '${unrelatedExpired.txId}')
      ORDER BY id;
    `;
    const snapshotBefore = queryJsonSync(container, dbName, getSnapshotSql);

    // Run targeted claim on targetJob
    const targetedRes = queryJsonSync(
      container,
      dbName,
      `SELECT * FROM public.zalo_claim_transcription_job('${companyA}'::uuid, '${targetJob.txId}'::uuid);`
    );
    assert.equal(targetedRes.length, 1);

    const snapshotAfter = queryJsonSync(container, dbName, getSnapshotSql);
    assert.deepEqual(
      snapshotAfter,
      snapshotBefore,
      'Unrelated PENDING and expired rows must remain 100% byte-for-byte unchanged'
    );
    testPass('6: Targeted claim leaves unrelated PENDING and expired rows strictly unchanged');

    // ========================================================================
    // TEST 7: attempts=10 expired bounds counter at 10 without constraint exception; idempotent FAILED
    // ========================================================================
    const max10Job = createReadyJob(companyA, {
      status: 'PROCESSING',
      leaseExpiresAtSql: "now() - interval '10 seconds'",
      attempts: 10,
      maxAttempts: 10,
    });

    const claim10Data = queryJsonSync(
      container,
      dbName,
      `SELECT * FROM public.zalo_claim_transcription_job('${companyA}'::uuid, '${max10Job.txId}'::uuid);`
    );
    assert.equal(claim10Data.length, 0, 'Exhausted lease target must return 0 claimed');

    const max10Check = queryJsonSync(
      container,
      dbName,
      `SELECT status, attempts, error_code, updated_at FROM public.zalo_call_transcriptions WHERE id = '${max10Job.txId}'`
    );
    assert.equal(max10Check[0].status, 'FAILED');
    assert.equal(max10Check[0].attempts, 10, 'Attempts must remain bounded at 10 without constraint violation');
    assert.equal(max10Check[0].error_code, 'EXPIRED_LEASE_MAX_ATTEMPTS');

    const call10Check = queryJsonSync(
      container,
      dbName,
      `SELECT transcript_status FROM public.zalo_personal_calls WHERE id = '${max10Job.callId}'`
    );
    assert.equal(call10Check[0].transcript_status, 'FAILED', 'Call transcript_status must be FAILED');

    // Subsequent targeted call on FAILED job must return 0 and NOT mutate updated_at
    const claimFailedAgain = queryJsonSync(
      container,
      dbName,
      `SELECT * FROM public.zalo_claim_transcription_job('${companyA}'::uuid, '${max10Job.txId}'::uuid);`
    );
    assert.equal(claimFailedAgain.length, 0);

    const max10After = queryJsonSync(
      container,
      dbName,
      `SELECT updated_at FROM public.zalo_call_transcriptions WHERE id = '${max10Job.txId}'`
    );
    assert.equal(max10After[0].updated_at, max10Check[0].updated_at, 'Subsequent claim must not mutate FAILED row');
    testPass('7: attempts=10 bounds counter at 10 without constraint exception; idempotent FAILED state');

    // ========================================================================
    // TEST 8: NULL or mismatched p_company returns 0
    // ========================================================================
    const job8 = createReadyJob(companyA);
    const nullCompData = queryJsonSync(
      container,
      dbName,
      `SELECT * FROM public.zalo_claim_transcription_job(NULL, '${job8.txId}'::uuid);`
    );
    assert.equal(nullCompData.length, 0, 'NULL company must return 0');

    const mismatchCompData = queryJsonSync(
      container,
      dbName,
      `SELECT * FROM public.zalo_claim_transcription_job('${companyB}'::uuid, '${job8.txId}'::uuid);`
    );
    assert.equal(mismatchCompData.length, 0, 'Mismatched company must return 0');

    const job8Check = queryJsonSync(
      container,
      dbName,
      `SELECT status, attempts FROM public.zalo_call_transcriptions WHERE id = '${job8.txId}'`
    );
    assert.equal(job8Check[0].status, 'PENDING');
    assert.equal(job8Check[0].attempts, 0);
    testPass('8: NULL or mismatched p_company returns 0; row remains PENDING and unmutated');

    console.log('\n================================================================');
    console.log(`ALL NATIVE POSTGRESQL CONCURRENCY TESTS PASSED: ${passCount} PASSED, 0 FAILED`);
    console.log('================================================================\n');
  } finally {
    // 1. Ensure all active interactive sessions are disposed
    for (const session of activeSessions) {
      try {
        session.dispose();
      } catch {}
    }

    // 2. Drop uniquely created ephemeral DB after all child connections terminate
    if (dbCreated) {
      try {
        execFileSync(
          'docker',
          [
            'exec',
            '-i',
            container,
            'psql',
            '-U',
            'postgres',
            '-d',
            'postgres',
            '-c',
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();`,
          ],
          { timeout: 5000 }
        );
      } catch {}

      // Keep test pass contingent on cleanup success; do NOT swallow error if drop fails
      execFileSync(
        'docker',
        [
          'exec',
          '-i',
          container,
          'psql',
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          'postgres',
          '-d',
          'postgres',
          '-c',
          `DROP DATABASE IF EXISTS ${dbName};`,
        ],
        { timeout: 10000 }
      );
      console.log(`[pg-concurrency] Cleanup completed: ephemeral database "${dbName}" dropped cleanly.`);
    }
  }
}

runPgConcurrencyTestSuite().catch((err) => {
  console.error('\n❌ NATIVE POSTGRESQL CONCURRENCY TEST SUITE FAILED:', err);
  process.exit(1);
});
