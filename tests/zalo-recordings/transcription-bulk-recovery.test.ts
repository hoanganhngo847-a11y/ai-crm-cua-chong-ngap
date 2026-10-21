/**
 * Standalone Integration Tests: Zalo Transcription Bulk Lease Recovery & Claiming
 *
 * Verifies:
 * 1. Expired processing job with attempts=2 and max=3 becomes FAILED (both transcription
 *    and call row), not stuck PENDING.
 * 2. Attempts=10/max=10 expired job does not overflow check constraint (attempts <= 10).
 * 3. Following due job is still claimed even if expired terminal candidate is scanned first.
 * 4. Active leases (unexpired) stay untouched and are not claimed or mutated.
 * 5. Unrelated (COMPLETED, future-scheduled) jobs remain untouched.
 * 6. Bulk RPC parameter clamping (null -> 10, <=0 -> 1, >50 -> 50) and tenant-linked READY filtering.
 * 7. Service-role only execution; anon and authenticated denied (42501).
 * 8. Stale lock_token cannot complete a reclaimed/terminalized job (fails with TRANSCRIPTION_LOCK_LOST).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sha256 } from '../../features/zalo-recordings/metadata';
import { uploadRecording } from '../../features/zalo-recordings/upload';
import { createPgliteSupabase } from '../zalo/helpers/pglite-supabase';
import { audioFixture, metadataFixture, uploadRequest } from './fixture';

let passCount = 0;
function testPass(msg: string) {
  console.log(`[PASS] ${msg}`);
  passCount++;
}

async function runBulkRecoveryTestSuite() {
  console.log('================================================================');
  console.log('STARTING ZALO BULK TRANSCRIPTION LEASE RECOVERY TEST SUITE');
  console.log('================================================================\n');

  const harness = await createPgliteSupabase();
  const db = harness.db;

  try {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const bossA = randomUUID();
    const saleA = randomUUID();
    const bossB = randomUUID();
    const deviceA = randomUUID();
    const secretA = 's'.repeat(44);

    // 1. Seed generic tenant companies & users
    await db.query(`INSERT INTO companies(id, name) VALUES($1, 'Company Alpha'), ($2, 'Company Beta')`, [companyA, companyB]);
    for (const [id, role, comp] of [
      [bossA, 'BOSS_ADMIN', companyA],
      [saleA, 'SALE', companyA],
      [bossB, 'BOSS_ADMIN', companyB],
    ]) {
      await db.query(`INSERT INTO auth.users(id) VALUES($1)`, [id]);
      await db.query(`INSERT INTO user_profiles(id, full_name) VALUES($1, 'User') ON CONFLICT(id) DO NOTHING`, [id]);
      await db.query(`INSERT INTO company_members(company_id, user_id, role, status) VALUES($1, $2, $3, 'ACTIVE')`, [comp, id, role]);
    }

    // Register capture device
    const devRes = await harness.client.rpc('zalo_manage_device', {
      p_company: companyA,
      p_actor: bossA,
      p_device: deviceA,
      p_name: 'Alpha Capture Device',
      p_hash: sha256(secretA),
      p_staff: saleA,
    });
    assert.ifError(devRes.error);

    // Setup in-memory mock storage
    const storageObjects = new Map<string, Buffer>();
    const adminClient = Object.assign(harness.client, {
      storage: {
        from: (bucket: string) => ({
          upload: async (path: string, body: Buffer) => {
            if (storageObjects.has(path)) return { error: { message: 'exists' } };
            storageObjects.set(path, body);
            await db.query(
              `INSERT INTO storage.objects(bucket_id, name, metadata) VALUES($1, $2, $3)`,
              [bucket, path, JSON.stringify({ size: body.length })]
            );
            return { error: null };
          },
          download: async (path: string) => {
            if (!storageObjects.has(path)) return { data: null, error: { message: 'Object not found' } };
            return { data: new Blob([new Uint8Array(storageObjects.get(path)!)]), error: null };
          },
        }),
      },
    }) as unknown as SupabaseClient;

    const audioBytes = audioFixture();

    async function createReadyTranscription(title: string): Promise<{ callId: string; txId: string }> {
      const meta = metadataFixture(deviceA, title);
      const res = await uploadRecording(uploadRequest(meta, audioBytes, secretA), adminClient);
      assert.equal(res.duplicate, false);
      const callId = res.call_id;
      const txRow = (await db.query<{ id: string }>(
        `SELECT id FROM zalo_call_transcriptions WHERE call_id = $1`,
        [callId]
      )).rows[0];
      return { callId, txId: txRow.id };
    }

    // ==========================================================================
    // Test 1: Expired lease at attempts=2 / max=3 transitions to FAILED
    // ==========================================================================
    console.log('--- Test 1: Expired lease with attempts=2 / max=3 becomes FAILED ---');
    const job1 = await createReadyTranscription('Call Expired Exhausted');
    const oldToken1 = randomUUID();

    await db.query(
      `UPDATE zalo_call_transcriptions
       SET status = 'PROCESSING',
           attempts = 2,
           max_attempts = 3,
           lease_expires_at = now() - interval '15 seconds',
           next_run_at = now() - interval '30 seconds',
           locked_by = 'crashed_worker',
           lock_token = $2
       WHERE id = $1`,
      [job1.txId, oldToken1]
    );

    // Call bulk claim RPC
    const claimRes1 = await adminClient.rpc('zalo_claim_transcription_jobs', {
      p_limit: 10,
      p_locked_by: 'bulk_recovery_worker',
      p_lease_seconds: 300,
    });
    assert.ifError(claimRes1.error);

    // Check transcription row: must be FAILED, attempts=3, error_code=EXPIRED_LEASE_MAX_ATTEMPTS
    const txRow1 = (await db.query<{ status: string; attempts: number; error_code: string; lock_token: string | null }>(
      `SELECT status, attempts, error_code, lock_token FROM zalo_call_transcriptions WHERE id = $1`,
      [job1.txId]
    )).rows[0];
    assert.equal(txRow1.status, 'FAILED', 'Expired job at max attempts must be marked FAILED, not PENDING');
    assert.equal(txRow1.attempts, 3, 'Attempts must increment to 3');
    assert.equal(txRow1.error_code, 'EXPIRED_LEASE_MAX_ATTEMPTS');
    assert.equal(txRow1.lock_token, null, 'Lock token must be cleared');

    // Check call row: must be FAILED
    const callRow1 = (await db.query<{ transcript_status: string }>(
      `SELECT transcript_status FROM zalo_personal_calls WHERE id = $1`,
      [job1.callId]
    )).rows[0];
    assert.equal(callRow1.transcript_status, 'FAILED', 'Call transcript_status must be FAILED');
    testPass('Test 1: Expired attempts=2/max=3 becomes FAILED and call FAILED, not stuck in PENDING');

    // ==========================================================================
    // Test 2: attempts=10 / max=10 does not overflow check constraint
    // ==========================================================================
    console.log('\n--- Test 2: attempts=10 / max=10 bounds without check overflow ---');
    const job2 = await createReadyTranscription('Call Max Bounds 10');

    await db.query(
      `UPDATE zalo_call_transcriptions
       SET status = 'PROCESSING',
           attempts = 10,
           max_attempts = 10,
           lease_expires_at = now() - interval '10 seconds',
           next_run_at = now() - interval '20 seconds',
           locked_by = 'crashed_worker_10',
           lock_token = gen_random_uuid()
       WHERE id = $1`,
      [job2.txId]
    );

    const claimRes2 = await adminClient.rpc('zalo_claim_transcription_jobs', {
      p_limit: 5,
      p_locked_by: 'bulk_recovery_worker',
    });
    assert.ifError(claimRes2.error);

    const txRow2 = (await db.query<{ status: string; attempts: number; error_code: string }>(
      `SELECT status, attempts, error_code FROM zalo_call_transcriptions WHERE id = $1`,
      [job2.txId]
    )).rows[0];
    assert.equal(txRow2.status, 'FAILED');
    assert.equal(txRow2.attempts, 10, 'Attempts must be capped at 10 without exceeding check constraint');
    assert.equal(txRow2.error_code, 'EXPIRED_LEASE_MAX_ATTEMPTS');
    testPass('Test 2: attempts=10/max=10 terminates cleanly without constraint overflow');

    // ==========================================================================
    // Test 3: Following due job is still claimed even if expired terminal is first
    // ==========================================================================
    console.log('\n--- Test 3: Following due job claimed even when expired terminal is first ---');
    const jobTerminal = await createReadyTranscription('Terminal Expired Candidate');
    const jobEligible = await createReadyTranscription('Eligible Candidate');

    // Make jobTerminal expired with attempts 2/3 and older next_run_at
    await db.query(
      `UPDATE zalo_call_transcriptions
       SET status = 'PROCESSING',
           attempts = 2,
           max_attempts = 3,
           lease_expires_at = now() - interval '20 seconds',
           next_run_at = now() - interval '60 seconds',
           locked_by = 'prior_worker',
           lock_token = gen_random_uuid()
       WHERE id = $1`,
      [jobTerminal.txId]
    );

    // jobEligible is PENDING, due now
    await db.query(
      `UPDATE zalo_call_transcriptions
       SET status = 'PENDING',
           attempts = 0,
           max_attempts = 3,
           next_run_at = now() - interval '5 seconds'
       WHERE id = $1`,
      [jobEligible.txId]
    );

    // Request limit=1: terminal candidate processed first (0 claims), then eligible is claimed (1 claim)
    const claimRes3 = await adminClient.rpc('zalo_claim_transcription_jobs', {
      p_limit: 1,
      p_locked_by: 'worker_following',
      p_lease_seconds: 120,
    });
    assert.ifError(claimRes3.error);
    const claimedRows3 = (claimRes3.data || []) as { id: string; lock_token: string }[];
    assert.equal(claimedRows3.length, 1, 'Must claim exactly 1 eligible job');
    assert.equal(claimedRows3[0].id, jobEligible.txId, 'Claimed job must be the eligible job');

    // Verify terminal candidate was finalized to FAILED
    const termRow = (await db.query<{ status: string }>(
      `SELECT status FROM zalo_call_transcriptions WHERE id = $1`,
      [jobTerminal.txId]
    )).rows[0];
    assert.equal(termRow.status, 'FAILED');
    testPass('Test 3: Following eligible job is claimed even when expired terminal candidate is scanned first');

    // ==========================================================================
    // Test 4: Active unexpired lease stays untouched
    // ==========================================================================
    console.log('\n--- Test 4: Active unexpired lease stays untouched ---');
    const jobActive = await createReadyTranscription('Active Lease Job');
    const activeToken = randomUUID();

    await db.query(
      `UPDATE zalo_call_transcriptions
       SET status = 'PROCESSING',
           attempts = 1,
           max_attempts = 3,
           lease_expires_at = now() + interval '300 seconds',
           locked_by = 'active_worker',
           lock_token = $2
       WHERE id = $1`,
      [jobActive.txId, activeToken]
    );

    const claimRes4 = await adminClient.rpc('zalo_claim_transcription_jobs', {
      p_limit: 10,
      p_locked_by: 'another_worker',
    });
    assert.ifError(claimRes4.error);

    const activeRow = (await db.query<{ status: string; attempts: number; lock_token: string; locked_by: string }>(
      `SELECT status, attempts, lock_token, locked_by FROM zalo_call_transcriptions WHERE id = $1`,
      [jobActive.txId]
    )).rows[0];
    assert.equal(activeRow.status, 'PROCESSING');
    assert.equal(activeRow.attempts, 1);
    assert.equal(activeRow.lock_token, activeToken, 'Lock token must not be changed');
    assert.equal(activeRow.locked_by, 'active_worker', 'Locked by must not be changed');
    testPass('Test 4: Active unexpired lease remains untouched and cannot be stolen');

    // ==========================================================================
    // Test 5: Unrelated completed / future rows remain unchanged
    // ==========================================================================
    console.log('\n--- Test 5: Unrelated COMPLETED and future rows remain unchanged ---');
    const jobCompleted = await createReadyTranscription('Completed Call');
    const jobFuture = await createReadyTranscription('Future Scheduled Call');

    await db.query(
      `UPDATE zalo_call_transcriptions
       SET status = 'COMPLETED', completed_at = now(), full_transcript = 'Transcript text'
       WHERE id = $1`,
      [jobCompleted.txId]
    );
    await db.query(
      `UPDATE zalo_call_transcriptions
       SET status = 'PENDING', next_run_at = now() + interval '2 hours'
       WHERE id = $1`,
      [jobFuture.txId]
    );

    const claimRes5 = await adminClient.rpc('zalo_claim_transcription_jobs', {
      p_limit: 10,
    });
    assert.ifError(claimRes5.error);
    const claimedIds5 = ((claimRes5.data || []) as { id: string }[]).map((r) => r.id);
    assert.ok(!claimedIds5.includes(jobCompleted.txId), 'Completed job must not be claimed');
    assert.ok(!claimedIds5.includes(jobFuture.txId), 'Future job must not be claimed');

    const compRow = (await db.query<{ status: string }>(
      `SELECT status FROM zalo_call_transcriptions WHERE id = $1`,
      [jobCompleted.txId]
    )).rows[0];
    assert.equal(compRow.status, 'COMPLETED');
    testPass('Test 5: Completed and future-scheduled rows remain unchanged');

    // ==========================================================================
    // Test 6: Bulk RPC cap & tenant-linked READY filtering
    // ==========================================================================
    console.log('\n--- Test 6: Limit clamping and tenant-linked READY filtering ---');
    const jobNonReady = await createReadyTranscription('Non Ready Call');
    await db.query(
      `UPDATE zalo_personal_calls SET recording_status = 'UPLOADING' WHERE id = $1`,
      [jobNonReady.callId]
    );

    const jobEmptyPath = await createReadyTranscription('Empty Path Call');
    await db.query(
      `UPDATE zalo_personal_calls SET recording_path = '' WHERE id = $1`,
      [jobEmptyPath.callId]
    );

    const claimFilterRes = await adminClient.rpc('zalo_claim_transcription_jobs', {
      p_limit: 10,
    });
    assert.ifError(claimFilterRes.error);
    const filterClaimedIds = ((claimFilterRes.data || []) as { id: string }[]).map((r) => r.id);
    assert.ok(!filterClaimedIds.includes(jobNonReady.txId), 'Non-READY call must be filtered out');
    assert.ok(!filterClaimedIds.includes(jobEmptyPath.txId), 'Empty recording_path call must be filtered out');

    // Clamp tests: p_limit null defaults to 10, p_limit 0 clamps to 1, p_limit 999 clamps to 50
    // Test null limit
    const nullLimitRes = await adminClient.rpc('zalo_claim_transcription_jobs', {
      p_limit: null as any,
    });
    assert.ifError(nullLimitRes.error);

    // Test zero limit clamps to 1
    const zeroLimitRes = await adminClient.rpc('zalo_claim_transcription_jobs', {
      p_limit: 0,
    });
    assert.ifError(zeroLimitRes.error);

    // Test huge limit clamps to at most 50
    const hugeLimitRes = await adminClient.rpc('zalo_claim_transcription_jobs', {
      p_limit: 9999,
    });
    assert.ifError(hugeLimitRes.error);
    assert.ok(((hugeLimitRes.data || []) as unknown[]).length <= 50, 'Claimed rows must not exceed cap of 50');
    testPass('Test 6: Limit clamped to [1, 50] (null -> 10) and non-READY/empty path filtered out');

    // ==========================================================================
    // Test 7: Security & ACL: anon / authenticated denied, service_role allowed
    // ==========================================================================
    console.log('\n--- Test 7: Security & ACL: anon and authenticated denied ---');

    await db.query(`BEGIN`);
    let anonError: any;
    try {
      await db.query(`SET LOCAL ROLE anon`);
      await db.query(`SELECT * FROM public.zalo_claim_transcription_jobs(10)`);
    } catch (err) {
      anonError = err;
    } finally {
      await db.query(`ROLLBACK`);
    }
    assert.ok(anonError, 'Role anon must be denied execution on zalo_claim_transcription_jobs');
    assert.equal(anonError.code, '42501', 'Must fail with 42501 permission denied for anon');

    await db.query(`BEGIN`);
    let authError: any;
    try {
      await db.query(`SET LOCAL ROLE authenticated`);
      await db.query(`SELECT * FROM public.zalo_claim_transcription_jobs(10)`);
    } catch (err) {
      authError = err;
    } finally {
      await db.query(`ROLLBACK`);
    }
    assert.ok(authError, 'Role authenticated must be denied execution on zalo_claim_transcription_jobs');
    assert.equal(authError.code, '42501', 'Must fail with 42501 permission denied for authenticated');

    testPass('Test 7: Service-role only execution; anon and authenticated denied with 42501');

    // ==========================================================================
    // Test 8: Stale lock_token cannot complete a reclaimed / finalized job
    // ==========================================================================
    console.log('\n--- Test 8: Stale lock token cannot complete reclaimed job ---');
    const jobReclaim = await createReadyTranscription('Stale Token Test Call');
    const staleLockToken = randomUUID();

    // Set job in PROCESSING with expired lease and stale token
    await db.query(
      `UPDATE zalo_call_transcriptions
       SET status = 'PROCESSING',
           attempts = 1,
           max_attempts = 3,
           lease_expires_at = now() - interval '10 seconds',
           lock_token = $2
       WHERE id = $1`,
      [jobReclaim.txId, staleLockToken]
    );

    // Bulk claim reclaims the expired job with a fresh token
    const reclaimRes = await adminClient.rpc('zalo_claim_transcription_jobs', {
      p_limit: 1,
      p_locked_by: 'new_worker',
      p_lease_seconds: 300,
    });
    assert.ifError(reclaimRes.error);
    const reclaimedJobs = (reclaimRes.data || []) as { id: string; lock_token: string }[];
    assert.equal(reclaimedJobs.length, 1);
    const freshLockToken = reclaimedJobs[0].lock_token;
    assert.notEqual(freshLockToken, staleLockToken, 'Fresh lock token must differ from stale token');

    // Worker with stale token attempts to complete: MUST FAIL with TRANSCRIPTION_LOCK_LOST
    const completeStaleRes = await adminClient.rpc('zalo_complete_transcription', {
      p_company: companyA,
      p_transcription_id: jobReclaim.txId,
      p_lock_token: staleLockToken,
      p_full_transcript: 'Stale attempt transcript',
      p_utterances: [],
    });
    assert.ok(completeStaleRes.error, 'Completion with stale lock token must fail');
    assert.ok(
      completeStaleRes.error.message.includes('TRANSCRIPTION_LOCK_LOST'),
      `Error must be TRANSCRIPTION_LOCK_LOST, got: ${completeStaleRes.error.message}`
    );

    // Worker with fresh token can complete successfully
    const completeFreshRes = await adminClient.rpc('zalo_complete_transcription', {
      p_company: companyA,
      p_transcription_id: jobReclaim.txId,
      p_lock_token: freshLockToken,
      p_full_transcript: 'Fresh attempt transcript',
      p_utterances: [],
    });
    assert.ifError(completeFreshRes.error);

    const finalTx = (await db.query<{ status: string }>(
      `SELECT status FROM zalo_call_transcriptions WHERE id = $1`,
      [jobReclaim.txId]
    )).rows[0];
    assert.equal(finalTx.status, 'COMPLETED');
    testPass('Test 8: Stale lock token cannot complete job; fresh lock token succeeds');

    console.log('\n================================================================');
    console.log(`ALL ${passCount} BULK RECOVERY TESTS PASSED SUCCESSFULLY!`);
    console.log('================================================================');
  } finally {
    await harness.close();
  }
}

runBulkRecoveryTestSuite().catch((err) => {
  console.error('\n[FATAL TEST FAILURE]:', err);
  process.exit(1);
});
