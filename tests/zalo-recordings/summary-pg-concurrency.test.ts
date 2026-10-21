/**
 * Native PostgreSQL Concurrency & Targeted Claim Proof Test Suite for Zalo Call AI Summary
 *
 * Verifies real multi-connection PostgreSQL 17 concurrency behaviors:
 * 1. Two separate worker connections targeting the same due summary_id -> exactly 1 claim
 * 2. Bulk worker vs targeted worker concurrency race -> single owner, no double claim
 * 3. Held row lock on PENDING target returns 0 promptly without statement_timeout
 * 4. Held row lock on EXPIRED PROCESSING target returns 0 promptly without statement_timeout
 * 5. Fresh token fences stale completion: reclaimed lease prevents stale worker from completing
 * 6. attempts=10 expired lease bounds counter at 10 without check constraint exception; idempotent FAILED state
 * 7. NULL or mismatched p_company returns 0 rows without touching records
 *
 * Strict Isolation & Determinism Guarantees:
 * - Fail-closed localhost host guard
 * - Uniquely created, ephemeral database per test run (isolated from local stack and shared DB)
 * - Safe execFileSync/spawn argument arrays with finite timeouts
 * - Dropping the ephemeral database handles all cleanup
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PLATFORM_STUBS } from '../zalo/helpers/pglite-supabase';

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
  summaryId: string,
  marker: string
): InteractiveLockSession {
  const child = spawn(
    'docker',
    ['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', dbName],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );

  let buffer = '';
  let readyResolve: (() => void) | null = null;
  let readyReject: ((err: Error) => void) | null = null;

  const onData = (chunk: Buffer) => {
    buffer += chunk.toString();
    if (buffer.includes(marker) && readyResolve) {
      const r = readyResolve;
      readyResolve = null;
      readyReject = null;
      r();
    }
  };

  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('error', (err) => {
    if (readyReject) {
      readyReject(err);
      readyResolve = null;
      readyReject = null;
    }
  });

  const awaitLockReady = () => {
    return new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
      const initialCmd = `BEGIN; SELECT * FROM public.zalo_call_ai_summaries WHERE id = '${summaryId}' FOR UPDATE; SELECT '${marker}' AS barrier;\n`;
      child.stdin.write(initialCmd);
    });
  };

  const release = () => {
    return new Promise<void>((resolve) => {
      child.on('close', () => resolve());
      child.stdin.write('ROLLBACK;\n\\q\n');
      child.stdin.end();
    });
  };

  const dispose = () => {
    try {
      child.kill('SIGKILL');
    } catch {}
  };

  return { awaitLockReady, release, dispose };
}

let passCount = 0;
function testPass(num: number, msg: string) {
  console.log(`[PASS] ${num}: ${msg}`);
  passCount++;
}

async function runPgConcurrencySuite() {
  console.log('================================================================');
  console.log('STARTING NATIVE POSTGRESQL CONCURRENCY SUITE FOR AI SUMMARY');
  console.log('================================================================\n');

  const container = getDeterministicPostgresContainer();
  verifyRequiredRoles(container);

  const ephDbName = `zalo_summary_eph_${Date.now()}_${randomBytes(8).toString('hex')}`;
  console.log(`[pg-concurrency] Bootstrapping ephemeral database "${ephDbName}" on container "${container}"...`);

  execPsqlSync(container, 'postgres', `CREATE DATABASE "${ephDbName}" OWNER postgres;`);

  try {
    const platformStubsNoRoles = PLATFORM_STUBS
      .split('\n')
      .filter((line) => !line.trim().startsWith('CREATE ROLE'))
      .join('\n');
    execPsqlSync(container, ephDbName, platformStubsNoRoles);

    const migrationsDir = path.resolve(__dirname, '../../supabase/migrations');
    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of migrationFiles) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      execPsqlSync(container, ephDbName, sql, 30000);
    }
    console.log(`[pg-concurrency] Ephemeral database "${ephDbName}" initialized with all migrations.\n`);

    const companyA = randomUUID();
    const bossA = randomUUID();
    const saleA = randomUUID();
    const customerA = randomUUID();
    const deviceA = randomUUID();
    const dummyHash = 'c'.repeat(64);

    execPsqlSync(
      container,
      ephDbName,
      `
      INSERT INTO companies(id, name) VALUES ('${companyA}', 'Company A');
      INSERT INTO auth.users(id) VALUES ('${bossA}'), ('${saleA}');
      INSERT INTO user_profiles(id, full_name) VALUES ('${bossA}', 'Boss'), ('${saleA}', 'Sale')
      ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
      INSERT INTO company_members(company_id, user_id, role, status)
      VALUES ('${companyA}', '${bossA}', 'BOSS_ADMIN', 'ACTIVE'),
             ('${companyA}', '${saleA}', 'SALE', 'ACTIVE');
      INSERT INTO customers(id, company_id, name, source, stage)
      VALUES ('${customerA}', '${companyA}', 'Khách Hàng', 'ZALO', 'LEAD_NEW');
      INSERT INTO zalo_recording_devices(id, company_id, staff_user_id, device_name, device_key_hash, active)
      VALUES ('${deviceA}', '${companyA}', '${saleA}', 'Mac Device', '${dummyHash}', true);
      `
    );

    function seedTestCallAndTranscription(name: string): { callId: string; txId: string; sumId: string } {
      const callId = randomUUID();
      const txId = randomUUID();
      const sumId = randomUUID();
      const recPath = `comp_${companyA}/call_${callId}.m4a`;
      const dummySha = 'd'.repeat(64);

      execPsqlSync(
        container,
        ephDbName,
        `
        INSERT INTO zalo_personal_calls(
          id, company_id, device_id, staff_user_id, customer_id, local_call_id,
          zalo_account_key, remote_display_name, remote_display_name_normalized,
          identity_confidence, direction, started_at, ended_at, duration_seconds,
          agent_version, audio_validation, recording_path, recording_bytes,
          recording_sha256, payload_fingerprint, upload_lease, upload_lease_until,
          recording_status, transcript_status, summary_status
        ) VALUES (
          '${callId}', '${companyA}', '${deviceA}', '${saleA}', '${customerA}', gen_random_uuid(),
          gen_random_uuid(), '${name}', 'khach',
          'MEDIUM', 'INBOUND', now(), now() + interval '30 seconds', 30,
          '2.0.0', '{"remote_non_silent":true,"local_non_silent":true}'::jsonb, '${recPath}', 1024,
          '${dummySha}', '${dummySha}', gen_random_uuid(), now() + interval '1 hour',
          'READY', 'COMPLETED', 'PENDING'
        );

        INSERT INTO zalo_call_transcriptions(
          id, company_id, call_id, customer_id, status, provider, language, full_transcript
        ) VALUES (
          '${txId}', '${companyA}', '${callId}', '${customerA}', 'COMPLETED', 'GEMINI', 'vi', 'Khách: Alo.'
        );

        INSERT INTO zalo_call_transcript_utterances(
          id, company_id, transcription_id, call_id, sequence, speaker_role, channel, start_ms, end_ms, text
        ) VALUES (
          gen_random_uuid(), '${companyA}', '${txId}', '${callId}', 1, 'CUSTOMER', 'LEFT', 0, 3000, 'Alo'
        );

        INSERT INTO zalo_call_ai_summaries(
          id, company_id, call_id, transcription_id, status, provider, model, prompt_version, next_run_at
        ) VALUES (
          '${sumId}', '${companyA}', '${callId}', '${txId}', 'PENDING', 'GEMINI', 'gemini-2.5-flash', 'v1', now()
        );
        `
      );
      return { callId, txId, sumId };
    }

    // ------------------------------------------------------------------------
    // TEST 1: Two separate worker connections targeting same summary_id
    // ------------------------------------------------------------------------
    const { sumId: sum1 } = seedTestCallAndTranscription('Test 1 Call');
    const claimSql1 = `SELECT id, lock_token FROM public.zalo_claim_call_summary_job('${companyA}', '${sum1}', 'worker_1', 300);`;
    const claimSql2 = `SELECT id, lock_token FROM public.zalo_claim_call_summary_job('${companyA}', '${sum1}', 'worker_2', 300);`;

    const [res1A, res1B] = await Promise.all([
      spawnPsql(container, ephDbName, claimSql1),
      spawnPsql(container, ephDbName, claimSql2),
    ]);

    assert.equal(res1A.code, 0);
    assert.equal(res1B.code, 0);

    const claimed1A = res1A.stdout.includes(sum1);
    const claimed1B = res1B.stdout.includes(sum1);
    assert.ok(
      (claimed1A && !claimed1B) || (!claimed1A && claimed1B),
      'Exactly ONE worker connection must claim the job, the other must get 0 rows'
    );
    testPass(1, 'Real 2-worker race on same summary_id claims exactly once across separate DB connections');

    // ------------------------------------------------------------------------
    // TEST 2: Bulk worker vs targeted worker race
    // ------------------------------------------------------------------------
    const { sumId: sum2 } = seedTestCallAndTranscription('Test 2 Call');
    const bulkSql = `SELECT id FROM public.zalo_claim_call_summary_jobs(10, 'bulk_worker', 300);`;
    const targetedSql = `SELECT id FROM public.zalo_claim_call_summary_job('${companyA}', '${sum2}', 'targeted_worker', 300);`;

    const [bulkRes, targetedRes] = await Promise.all([
      spawnPsql(container, ephDbName, bulkSql),
      spawnPsql(container, ephDbName, targetedSql),
    ]);

    assert.equal(bulkRes.code, 0);
    assert.equal(targetedRes.code, 0);

    const bulkClaimed = bulkRes.stdout.includes(sum2);
    const targetedClaimed = targetedRes.stdout.includes(sum2);

    assert.ok(
      (bulkClaimed && !targetedClaimed) || (!bulkClaimed && targetedClaimed),
      'Exactly one owner between bulk worker and targeted worker, no duplicate'
    );
    testPass(2, 'Bulk vs targeted worker race results in exactly one owner, no duplicate or deadlock');

    // ------------------------------------------------------------------------
    // TEST 3: Held PENDING lock returns 0 promptly without statement timeout
    // ------------------------------------------------------------------------
    const { sumId: sum3 } = seedTestCallAndTranscription('Test 3 Call');
    const lockSession3 = startInteractiveLockSession(container, ephDbName, sum3, 'LOCKED_READY_3');
    try {
      await lockSession3.awaitLockReady();
      const heldSql = `
        SET statement_timeout = 2000;
        SELECT id FROM public.zalo_claim_call_summary_job('${companyA}', '${sum3}', 'competing_worker', 300);
      `;
      const competingRes = await spawnPsql(container, ephDbName, heldSql, 5000);
      assert.equal(competingRes.code, 0, 'Competing claim must succeed without timeout error');
      assert.ok(!competingRes.stdout.includes(sum3), 'Competing worker must return 0 rows promptly');
    } finally {
      await lockSession3.release();
      lockSession3.dispose();
    }
    testPass(3, 'Held PENDING lock returns 0 promptly without statement timeout (SKIP LOCKED verified)');

    // ------------------------------------------------------------------------
    // TEST 4: Held EXPIRED PROCESSING lock returns 0 promptly without timeout
    // ------------------------------------------------------------------------
    const { sumId: sum4 } = seedTestCallAndTranscription('Test 4 Call');
    execPsqlSync(
      container,
      ephDbName,
      `UPDATE zalo_call_ai_summaries
       SET status = 'PROCESSING', lease_expires_at = now() - interval '10 seconds'
       WHERE id = '${sum4}';`
    );

    const lockSession4 = startInteractiveLockSession(container, ephDbName, sum4, 'LOCKED_READY_4');
    try {
      await lockSession4.awaitLockReady();
      const heldExpiredSql = `
        SET statement_timeout = 2000;
        SELECT id FROM public.zalo_claim_call_summary_job('${companyA}', '${sum4}', 'competing_worker_4', 300);
      `;
      const competingExpiredRes = await spawnPsql(container, ephDbName, heldExpiredSql, 5000);
      assert.equal(competingExpiredRes.code, 0);
      assert.ok(!competingExpiredRes.stdout.includes(sum4));
    } finally {
      await lockSession4.release();
      lockSession4.dispose();
    }
    testPass(4, 'Held EXPIRED PROCESSING lock returns 0 promptly without statement timeout');

    // ------------------------------------------------------------------------
    // TEST 5: Fresh token fences stale completion
    // ------------------------------------------------------------------------
    const { sumId: sum5 } = seedTestCallAndTranscription('Test 5 Call');
    const staleToken = randomUUID();
    execPsqlSync(
      container,
      ephDbName,
      `UPDATE zalo_call_ai_summaries
       SET status = 'PROCESSING', lock_token = '${staleToken}', lease_expires_at = now() - interval '10 seconds'
       WHERE id = '${sum5}';`
    );

    // Fresh claim reclaims expired lease
    const reclaimOut = queryJsonSync<any[]>(
      container,
      ephDbName,
      `SELECT lock_token FROM public.zalo_claim_call_summary_job('${companyA}', '${sum5}', 'fresh_worker', 300);`
    );
    assert.equal(reclaimOut.length, 1);
    const freshToken = reclaimOut[0].lock_token;
    assert.notEqual(freshToken, staleToken);

    // Stale worker completion rejected
    const staleCompleteSql = `
      SELECT public.zalo_complete_call_summary(
        '${companyA}', '${sum5}', '${staleToken}', 'Stale summary text', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
        'WARM', false, null, null, 'HIGH', 'GEMINI', 'gemini-2.5-flash', 'v1'
      );
    `;
    const staleRes = await spawnPsql(container, ephDbName, staleCompleteSql);
    assert.notEqual(staleRes.code, 0);
    assert.ok(staleRes.stderr.includes('SUMMARY_LOCK_LOST'));

    // Fresh worker completion succeeds
    const freshCompleteSql = `
      SELECT public.zalo_complete_call_summary(
        '${companyA}', '${sum5}', '${freshToken}', 'Fresh summary text', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
        'WARM', false, null, null, 'HIGH', 'GEMINI', 'gemini-2.5-flash', 'v1'
      );
    `;
    const freshRes = await spawnPsql(container, ephDbName, freshCompleteSql);
    assert.equal(freshRes.code, 0);
    testPass(5, 'Fresh token fences stale completion: expired lease reclaim generates fresh fencing token');

    // ------------------------------------------------------------------------
    // TEST 6: attempts=10 bounds counter at 10 without check exception
    // ------------------------------------------------------------------------
    const { sumId: sum6 } = seedTestCallAndTranscription('Test 6 Call');
    execPsqlSync(
      container,
      ephDbName,
      `UPDATE zalo_call_ai_summaries
       SET status = 'PROCESSING', attempts = 10, max_attempts = 10, lease_expires_at = now() - interval '5 seconds'
       WHERE id = '${sum6}';`
    );

    const boundClaim = queryJsonSync<any[]>(
      container,
      ephDbName,
      `SELECT id FROM public.zalo_claim_call_summary_job('${companyA}', '${sum6}', 'worker_bound', 300);`
    );
    assert.equal(boundClaim.length, 0);

    const boundRow = queryJsonSync<any[]>(
      container,
      ephDbName,
      `SELECT status, attempts, error_code FROM public.zalo_call_ai_summaries WHERE id = '${sum6}';`
    )[0];
    assert.equal(boundRow.status, 'FAILED');
    assert.equal(boundRow.attempts, 10);
    assert.equal(boundRow.error_code, 'EXPIRED_LEASE_MAX_ATTEMPTS');
    testPass(6, 'attempts=10 bounds counter at 10 without constraint exception; idempotent FAILED state');

    // ------------------------------------------------------------------------
    // TEST 7: NULL or mismatched company returns 0 without mutating records
    // ------------------------------------------------------------------------
    const { sumId: sum7 } = seedTestCallAndTranscription('Test 7 Call');
    const otherCompany = randomUUID();
    const wrongCompClaim = queryJsonSync<any[]>(
      container,
      ephDbName,
      `SELECT id FROM public.zalo_claim_call_summary_job('${otherCompany}', '${sum7}', 'worker_wrong', 300);`
    );
    assert.equal(wrongCompClaim.length, 0);

    const nullCompClaim = queryJsonSync<any[]>(
      container,
      ephDbName,
      `SELECT id FROM public.zalo_claim_call_summary_job(NULL, '${sum7}', 'worker_null', 300);`
    );
    assert.equal(nullCompClaim.length, 0);

    const untouchedRow = queryJsonSync<any[]>(
      container,
      ephDbName,
      `SELECT status, attempts, lock_token FROM public.zalo_call_ai_summaries WHERE id = '${sum7}';`
    )[0];
    assert.equal(untouchedRow.status, 'PENDING');
    assert.equal(untouchedRow.attempts, 0);
    assert.equal(untouchedRow.lock_token, null);
    testPass(7, 'NULL or mismatched p_company returns 0; row remains PENDING and unmutated');

    // ------------------------------------------------------------------------
    // TEST 8: Native PostgreSQL duplicate enqueue idempotency across all 4 states
    // Invariant: parent.summary_status === child.status, child state preserved
    // ------------------------------------------------------------------------
    // 8.1: PENDING
    const { callId: c81, txId: t81, sumId: s81 } = seedTestCallAndTranscription('Test 8.1 PENDING');
    const enq81 = queryJsonSync<any[]>(
      container,
      ephDbName,
      `SELECT public.zalo_enqueue_call_summary('${companyA}', '${t81}', 'GEMINI', 'gemini-2.5-flash') AS id;`
    )[0].id;
    assert.equal(enq81, s81);
    const p81 = queryJsonSync<any[]>(
      container,
      ephDbName,
      `SELECT summary_status FROM public.zalo_personal_calls WHERE id = '${c81}';`
    )[0].summary_status;
    assert.equal(p81, 'PENDING');

    // 8.2: PROCESSING
    const { callId: c82, txId: t82, sumId: s82 } = seedTestCallAndTranscription('Test 8.2 PROCESSING');
    const claim82 = queryJsonSync<any[]>(
      container,
      ephDbName,
      `SELECT id, lock_token FROM public.zalo_claim_call_summary_job('${companyA}', '${s82}', 'worker_82', 300);`
    )[0];
    assert.ok(claim82.lock_token);
    const enq82 = queryJsonSync<any[]>(
      container,
      ephDbName,
      `SELECT public.zalo_enqueue_call_summary('${companyA}', '${t82}', 'GEMINI', 'gemini-2.5-flash') AS id;`
    )[0].id;
    assert.equal(enq82, s82);
    const row82 = queryJsonSync<any[]>(
      container,
      ephDbName,
      `SELECT status, lock_token, locked_by FROM public.zalo_call_ai_summaries WHERE id = '${s82}';`
    )[0];
    assert.equal(row82.status, 'PROCESSING');
    assert.equal(row82.lock_token, claim82.lock_token);
    assert.equal(row82.locked_by, 'worker_82');
    const p82 = queryJsonSync<any[]>(
      container,
      ephDbName,
      `SELECT summary_status FROM public.zalo_personal_calls WHERE id = '${c82}';`
    )[0].summary_status;
    assert.equal(p82, 'PROCESSING', 'Parent summary_status must match child PROCESSING after duplicate enqueue');

    // 8.3: FAILED
    const { callId: c83, txId: t83, sumId: s83 } = seedTestCallAndTranscription('Test 8.3 FAILED');
    const claim83 = queryJsonSync<any[]>(
      container,
      ephDbName,
      `SELECT id, lock_token FROM public.zalo_claim_call_summary_job('${companyA}', '${s83}', 'worker_83', 300);`
    )[0];
    execPsqlSync(
      container,
      ephDbName,
      `SELECT public.zalo_fail_call_summary('${companyA}', '${s83}', '${claim83.lock_token}', 'TEST_FAIL', 'Fail reason', true);`
    );
    const enq83 = queryJsonSync<any[]>(
      container,
      ephDbName,
      `SELECT public.zalo_enqueue_call_summary('${companyA}', '${t83}', 'GEMINI', 'gemini-2.5-flash') AS id;`
    )[0].id;
    assert.equal(enq83, s83);
    const row83 = queryJsonSync<any[]>(
      container,
      ephDbName,
      `SELECT status, attempts, error_code FROM public.zalo_call_ai_summaries WHERE id = '${s83}';`
    )[0];
    assert.equal(row83.status, 'FAILED');
    assert.equal(row83.error_code, 'TEST_FAIL');
    const p83 = queryJsonSync<any[]>(
      container,
      ephDbName,
      `SELECT summary_status FROM public.zalo_personal_calls WHERE id = '${c83}';`
    )[0].summary_status;
    assert.equal(p83, 'FAILED', 'Parent summary_status must match child FAILED after duplicate enqueue');

    // 8.4: COMPLETED
    const { callId: c84, txId: t84, sumId: s84 } = seedTestCallAndTranscription('Test 8.4 COMPLETED');
    const claim84 = queryJsonSync<any[]>(
      container,
      ephDbName,
      `SELECT id, lock_token FROM public.zalo_claim_call_summary_job('${companyA}', '${s84}', 'worker_84', 300);`
    )[0];
    execPsqlSync(
      container,
      ephDbName,
      `SELECT public.zalo_complete_call_summary('${companyA}', '${s84}', '${claim84.lock_token}', 'Test summary', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'WARM', false, NULL, NULL, 'HIGH', 'GEMINI', 'gemini-2.5-flash');`
    );
    const enq84 = queryJsonSync<any[]>(
      container,
      ephDbName,
      `SELECT public.zalo_enqueue_call_summary('${companyA}', '${t84}', 'GEMINI', 'gemini-2.5-flash') AS id;`
    )[0].id;
    assert.equal(enq84, s84);
    const row84 = queryJsonSync<any[]>(
      container,
      ephDbName,
      `SELECT status, summary FROM public.zalo_call_ai_summaries WHERE id = '${s84}';`
    )[0];
    assert.equal(row84.status, 'COMPLETED');
    assert.equal(row84.summary, 'Test summary');
    const p84 = queryJsonSync<any[]>(
      container,
      ephDbName,
      `SELECT summary_status FROM public.zalo_personal_calls WHERE id = '${c84}';`
    )[0].summary_status;
    assert.equal(p84, 'COMPLETED', 'Parent summary_status must match child COMPLETED after duplicate enqueue');
    testPass(8, 'Native PostgreSQL duplicate enqueue is idempotent and maintains parent.summary_status == child.status across PENDING/PROCESSING/FAILED/COMPLETED');

  } finally {
    execPsqlSync(container, 'postgres', `DROP DATABASE IF EXISTS "${ephDbName}" WITH (FORCE);`);
    console.log(`\n[pg-concurrency] Cleanup completed: ephemeral database "${ephDbName}" dropped cleanly.`);
  }

  console.log('================================================================');
  console.log(`ALL NATIVE POSTGRESQL CONCURRENCY TESTS PASSED: ${passCount} PASSED, 0 FAILED`);
  console.log('================================================================\n');
}

runPgConcurrencySuite().catch((err) => {
  console.error('[FAIL] Concurrency proof suite encountered unhandled error:', err);
  process.exit(1);
});
