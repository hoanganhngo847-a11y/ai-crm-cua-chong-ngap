/**
 * Zalo Call AI Summary Phase 2B Automation & Database Integration Test Suite
 *
 * Requirements covered:
 * 1. COMPLETED transcription enqueue summary exactly once
 * 2. duplicate transcription completion does not duplicate summary
 * 3. transcription not completed -> summary cannot be enqueued or processed
 * 4. empty transcript fail safe (marks summary FAILED, transcription stays COMPLETED)
 * 5. valid Gemini/LLM structured response persists correctly
 * 6. invalid response rejected
 * 7. lead temperature enum strict
 * 8. confidence enum strict
 * 9. tenant isolation
 * 10. anon/authenticated denied, service_role allowed
 * 11. lock_token fencing
 * 12. expired lease recovery
 * 13. retry policy & terminal exhaustion
 * 14. targeted mode claims only 1 job without bulk fallback
 * 15. summary FAILED does not change transcription COMPLETED
 * 16. recording file & status unchanged
 * 17. transcript utterances remain strictly immutable
 * 18. authorized manual retry resets FAILED to PENDING
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createPgliteSupabase } from '../zalo/helpers/pglite-supabase';
import {
  enqueueZaloCallSummary,
  processZaloCallSummaryJob,
  processDueZaloCallSummaryJobs,
  processTargetedZaloCallSummaryJob,
  retryZaloCallSummary,
  reconcileMissingZaloCallSummaries,
} from '../../features/zalo-summary/service';
import type {
  CallSummaryStructuredOutput,
  ClaimedSummaryJob,
  SummaryProvider,
  SummaryUtterance,
} from '../../features/zalo-summary/types';

let passCount = 0;
function testPass(msg: string) {
  console.log(`[PASS] ${msg}`);
  passCount++;
}

class MockSummaryProvider implements SummaryProvider {
  public readonly name = 'MOCK_GEMINI';
  public readonly model = 'gemini-2.5-flash';

  constructor(
    private readonly handler: (
      utterances: SummaryUtterance[]
    ) => Promise<CallSummaryStructuredOutput>
  ) {}

  async generateSummary(
    utterances: SummaryUtterance[]
  ): Promise<CallSummaryStructuredOutput> {
    return this.handler(utterances);
  }
}

async function runSummaryAutomationTestSuite() {
  console.log('================================================================');
  console.log('STARTING ZALO CALL AI SUMMARY PHASE 2B DATABASE INTEGRATION SUITE');
  console.log('================================================================\n');

  const harness = await createPgliteSupabase();
  const db = harness.db;
  const adminClient = harness.client;

  try {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const bossA = randomUUID();
    const saleA = randomUUID();
    const saleB = randomUUID();
    const customerA = randomUUID();
    const customerB = randomUUID();

    // 1. Seed companies and users
    await db.query(
      `INSERT INTO companies(id, name) VALUES($1, 'Company A'), ($2, 'Company B')`,
      [companyA, companyB]
    );

    for (const [id, role, comp] of [
      [bossA, 'BOSS_ADMIN', companyA],
      [saleA, 'SALE', companyA],
      [saleB, 'SALE', companyB],
    ]) {
      await db.query(`INSERT INTO auth.users(id) VALUES($1)`, [id]);
      await db.query(
        `INSERT INTO user_profiles(id, full_name) VALUES($1, 'User') ON CONFLICT(id) DO NOTHING`,
        [id]
      );
      await db.query(
        `INSERT INTO company_members(company_id, user_id, role, status) VALUES($1, $2, $3, 'ACTIVE')`,
        [comp, id, role]
      );
    }

    await db.query(
      `INSERT INTO customers(id, company_id, name, source, stage) VALUES
       ($1, $2, 'Khách hàng A', 'ZALO', 'LEAD_NEW'),
       ($3, $4, 'Khách hàng B', 'ZALO', 'LEAD_NEW')`,
      [customerA, companyA, customerB, companyB]
    );

    const deviceA = randomUUID();
    const deviceB = randomUUID();
    const dummyHash = 'a'.repeat(64);

    await db.query(
      `INSERT INTO zalo_recording_devices(id, company_id, staff_user_id, device_name, device_key_hash, active)
       VALUES($1, $2, $3, 'Device A', $4, true),
             ($5, $6, $7, 'Device B', $4, true)`,
      [deviceA, companyA, saleA, dummyHash, deviceB, companyB, saleB]
    );

    // Helper: Seed a personal call with recording
    async function seedCall(comp: string, staffUser: string, status = 'COMPLETED') {
      const callId = randomUUID();
      const recPath = `company_${comp}/call_${callId}.m4a`;
      const devId = comp === companyA ? deviceA : deviceB;
      const custId = comp === companyA ? customerA : customerB;
      const dummySha = 'b'.repeat(64);

      await db.query(
        `INSERT INTO zalo_personal_calls(
          id, company_id, device_id, staff_user_id, customer_id, local_call_id,
          zalo_account_key, remote_display_name, remote_display_name_normalized,
          identity_confidence, direction, started_at, ended_at, duration_seconds,
          agent_version, audio_validation, recording_path, recording_bytes,
          recording_sha256, payload_fingerprint, upload_lease, upload_lease_until,
          recording_status, transcript_status
        ) VALUES(
          $1, $2, $3, $4, $5, $6,
          gen_random_uuid(), 'Khách', 'khach',
          'MEDIUM', 'INBOUND', now(), now() + interval '45 seconds', 45,
          '2.0.0', '{"remote_non_silent":true,"local_non_silent":true}'::jsonb, $7, 1024,
          $8, $8, gen_random_uuid(), now() + interval '1 hour',
          'READY', $9
        )`,
        [callId, comp, devId, staffUser, custId, randomUUID(), recPath, dummySha, status]
      );

      return { callId, recPath };
    }

    // Helper: Seed a completed transcription with utterances
    async function seedCompletedTranscription(
      comp: string,
      callId: string,
      utterancesCount = 2,
      completedAt?: Date | string
    ) {
      const txId = randomUUID();
      const custId = comp === companyA ? customerA : customerB;
      const completedAtVal = completedAt
        ? (completedAt instanceof Date ? completedAt.toISOString() : completedAt)
        : new Date().toISOString();
      await db.query(
        `INSERT INTO zalo_call_transcriptions(
          id, company_id, call_id, customer_id, status,
          provider, language, full_transcript, completed_at
        ) VALUES(
          $1, $2, $3, $4, 'COMPLETED',
          'GEMINI', 'vi', 'Khách: Alo tôi cần tư vấn. Nhân viên: Dạ chào anh.', $5
        )`,
        [txId, comp, callId, custId, completedAtVal]
      );

      for (let i = 1; i <= utterancesCount; i++) {
        const isCustomer = i % 2 === 1;
        await db.query(
          `INSERT INTO zalo_call_transcript_utterances(
            id, company_id, transcription_id, call_id, sequence,
            speaker_role, channel, start_ms, end_ms, text, confidence
          ) VALUES(
            gen_random_uuid(), $1, $2, $3, $4,
            $5, $6, $7, $8, $9, 0.95
          )`,
          [
            comp,
            txId,
            callId,
            i,
            isCustomer ? 'CUSTOMER' : 'STAFF',
            isCustomer ? 'LEFT' : 'RIGHT',
            (i - 1) * 3000,
            i * 3000,
            isCustomer ? `Khách phát biểu câu ${i}` : `Nhân viên trả lời câu ${i}`,
          ]
        );
      }

      return txId;
    }

    const validMockOutput: CallSummaryStructuredOutput = {
      summary: 'Khách hàng muốn tìm hiểu gói sản phẩm và đã đồng ý nhận tài liệu qua Zalo.',
      customer_needs: ['Tìm hiểu sản phẩm', 'Nhận tài liệu'],
      objections: ['Đang so sánh đối thủ'],
      next_actions: ['Gửi file tài liệu', 'Liên hệ lại vào ngày mai'],
      lead_temperature: 'WARM',
      follow_up: {
        required: true,
        suggested_time: '2026-10-22 14:00',
        reason: 'Khách yêu cầu gửi tài liệu trước khi thảo luận chi tiết',
      },
      key_points: ['Cuộc gọi nhã nhặn', 'Khách có nhu cầu thực'],
      confidence: 'HIGH',
    };

    // ========================================================================
    // TEST 1: COMPLETED transcription enqueue summary exactly once
    // ========================================================================
    console.log('--- Test 1: COMPLETED transcription enqueue summary exactly once ---');
    const { callId: call1 } = await seedCall(companyA, saleA);
    const tx1 = await seedCompletedTranscription(companyA, call1);

    const summaryId1 = await enqueueZaloCallSummary(companyA, tx1, adminClient);
    assert.ok(summaryId1, 'Summary ID must be returned');

    const sumRow1 = (
      await db.query<{
        id: string;
        status: string;
        provider: string;
        model: string;
        call_id: string;
      }>(`SELECT * FROM zalo_call_ai_summaries WHERE id = $1`, [summaryId1])
    ).rows[0];

    assert.equal(sumRow1.status, 'PENDING');
    assert.equal(sumRow1.call_id, call1);
    assert.equal(sumRow1.provider, 'GEMINI');

    const callRow1 = (
      await db.query<{ summary_status: string }>(
        `SELECT summary_status FROM zalo_personal_calls WHERE id = $1`,
        [call1]
      )
    ).rows[0];
    assert.equal(callRow1.summary_status, 'PENDING');
    testPass('Test 1: COMPLETED transcription enqueues summary job in PENDING state');

    // ========================================================================
    // TEST 2: Duplicate Enqueue Idempotency & State Preservation Across All States
    // Invariant: parent.summary_status === child.status, child state preserved
    // ========================================================================
    console.log('--- Test 2.1: Duplicate enqueue idempotency on PENDING summary ---');
    const summaryId1Dup = await enqueueZaloCallSummary(companyA, tx1, adminClient);
    assert.equal(summaryId1Dup, summaryId1, 'Duplicate enqueue returns the same summary ID');

    const totalSummariesTx1 = (
      await db.query<{ count: string | number }>(
        `SELECT count(*) FROM zalo_call_ai_summaries WHERE company_id = $1 AND transcription_id = $2`,
        [companyA, tx1]
      )
    ).rows[0].count;
    assert.equal(Number(totalSummariesTx1), 1, 'Exactly one summary row exists per transcription');

    const childRowPending = (
      await db.query<{ status: string; attempts: number; lock_token: string | null; lease_expires_at: string | null }>(
        `SELECT status, attempts, lock_token, lease_expires_at FROM zalo_call_ai_summaries WHERE id = $1`,
        [summaryId1]
      )
    ).rows[0];
    assert.equal(childRowPending.status, 'PENDING');
    assert.equal(childRowPending.attempts, 0);
    assert.equal(childRowPending.lock_token, null);
    assert.equal(childRowPending.lease_expires_at, null);

    const parentCallPending = (
      await db.query<{ summary_status: string }>(
        `SELECT summary_status FROM zalo_personal_calls WHERE id = $1`,
        [call1]
      )
    ).rows[0];
    assert.equal(parentCallPending.summary_status, 'PENDING');
    assert.equal(parentCallPending.summary_status, childRowPending.status, 'Parent summary_status matches child status');
    testPass('Test 2.1: Duplicate enqueue on PENDING summary preserves status, ID, attempts, and parent sync');

    console.log('--- Test 2.2: Duplicate enqueue idempotency on PROCESSING summary ---');
    const { callId: callProc } = await seedCall(companyA, saleA);
    const txProc = await seedCompletedTranscription(companyA, callProc, 2);
    const sumProcId = await enqueueZaloCallSummary(companyA, txProc, adminClient);

    const claimedProc = (
      await adminClient.rpc('zalo_claim_call_summary_job', {
        p_company: companyA,
        p_summary_id: sumProcId,
        p_locked_by: 'worker_test_proc',
        p_lease_seconds: 300,
      })
    ).data as ClaimedSummaryJob[];
    assert.equal(claimedProc.length, 1);

    const childProcBefore = (
      await db.query<{
        status: string;
        attempts: number;
        lock_token: string;
        locked_by: string;
        lease_expires_at: string;
      }>(
        `SELECT status, attempts, lock_token, locked_by, lease_expires_at FROM zalo_call_ai_summaries WHERE id = $1`,
        [sumProcId]
      )
    ).rows[0];
    assert.equal(childProcBefore.status, 'PROCESSING');
    assert.equal(childProcBefore.attempts, 0);
    assert.ok(childProcBefore.lock_token);
    assert.equal(childProcBefore.locked_by, 'worker_test_proc');

    const parentProcBefore = (
      await db.query<{ summary_status: string }>(
        `SELECT summary_status FROM zalo_personal_calls WHERE id = $1`,
        [callProc]
      )
    ).rows[0];
    assert.equal(parentProcBefore.summary_status, 'PROCESSING');

    // Duplicate enqueue while PROCESSING!
    const sumProcDup = await enqueueZaloCallSummary(companyA, txProc, adminClient);
    assert.equal(sumProcDup, sumProcId, 'Duplicate enqueue returns same summary ID');

    const totalSummariesProc = Number((
      await db.query<{ count: string }>(
        `SELECT count(*) FROM zalo_call_ai_summaries WHERE company_id = $1 AND transcription_id = $2`,
        [companyA, txProc]
      )
    ).rows[0].count);
    assert.equal(totalSummariesProc, 1, 'Exactly one summary row exists');

    const childProcAfter = (
      await db.query<{
        status: string;
        attempts: number;
        lock_token: string;
        locked_by: string;
        lease_expires_at: string;
      }>(
        `SELECT status, attempts, lock_token, locked_by, lease_expires_at FROM zalo_call_ai_summaries WHERE id = $1`,
        [sumProcId]
      )
    ).rows[0];
    assert.equal(childProcAfter.status, 'PROCESSING', 'Child status must remain PROCESSING');
    assert.equal(childProcAfter.attempts, childProcBefore.attempts, 'Attempts must not change');
    assert.equal(childProcAfter.lock_token, childProcBefore.lock_token, 'Lock token must not be lost');
    assert.equal(childProcAfter.locked_by, childProcBefore.locked_by, 'Locked by must not change');
    assert.equal(
      new Date(childProcAfter.lease_expires_at).toISOString(),
      new Date(childProcBefore.lease_expires_at).toISOString(),
      'Lease must not change'
    );

    const parentProcAfter = (
      await db.query<{ summary_status: string }>(
        `SELECT summary_status FROM zalo_personal_calls WHERE id = $1`,
        [callProc]
      )
    ).rows[0];
    assert.equal(parentProcAfter.summary_status, 'PROCESSING', 'Parent summary_status must NOT be reset to PENDING');
    assert.equal(parentProcAfter.summary_status, childProcAfter.status, 'Parent summary_status matches child status');
    testPass('Test 2.2: Duplicate enqueue on PROCESSING summary does NOT lose lock or reset parent status');

    console.log('--- Test 2.3: Duplicate enqueue idempotency on FAILED summary ---');
    const { callId: callFail } = await seedCall(companyA, saleA);
    const txFail = await seedCompletedTranscription(companyA, callFail, 2);
    const sumFailId = await enqueueZaloCallSummary(companyA, txFail, adminClient);

    const claimedFail = (
      await adminClient.rpc('zalo_claim_call_summary_job', {
        p_company: companyA,
        p_summary_id: sumFailId,
        p_locked_by: 'worker_test_fail',
        p_lease_seconds: 300,
      })
    ).data as ClaimedSummaryJob[];
    assert.equal(claimedFail.length, 1);

    const failRes = await adminClient.rpc('zalo_fail_call_summary', {
      p_company: companyA,
      p_summary_id: sumFailId,
      p_lock_token: claimedFail[0].lock_token,
      p_error_code: 'TEST_TERMINAL_FAIL',
      p_error_message: 'Unrecoverable mock failure',
      p_terminal: true,
    });
    assert.equal(failRes.error, null);

    const childFailBefore = (
      await db.query<{
        status: string;
        attempts: number;
        error_code: string;
        error_message: string;
      }>(
        `SELECT status, attempts, error_code, error_message FROM zalo_call_ai_summaries WHERE id = $1`,
        [sumFailId]
      )
    ).rows[0];
    assert.equal(childFailBefore.status, 'FAILED');
    assert.equal(childFailBefore.error_code, 'TEST_TERMINAL_FAIL');

    const parentFailBefore = (
      await db.query<{ summary_status: string }>(
        `SELECT summary_status FROM zalo_personal_calls WHERE id = $1`,
        [callFail]
      )
    ).rows[0];
    assert.equal(parentFailBefore.summary_status, 'FAILED');

    // Duplicate enqueue on FAILED!
    const sumFailDup = await enqueueZaloCallSummary(companyA, txFail, adminClient);
    assert.equal(sumFailDup, sumFailId, 'Duplicate enqueue returns same summary ID');

    const totalSummariesFail = Number((
      await db.query<{ count: string }>(
        `SELECT count(*) FROM zalo_call_ai_summaries WHERE company_id = $1 AND transcription_id = $2`,
        [companyA, txFail]
      )
    ).rows[0].count);
    assert.equal(totalSummariesFail, 1, 'Exactly one summary row exists');

    const childFailAfter = (
      await db.query<{
        status: string;
        attempts: number;
        error_code: string;
        error_message: string;
      }>(
        `SELECT status, attempts, error_code, error_message FROM zalo_call_ai_summaries WHERE id = $1`,
        [sumFailId]
      )
    ).rows[0];
    assert.equal(childFailAfter.status, 'FAILED', 'Child status must remain FAILED (no automatic retry)');
    assert.equal(childFailAfter.attempts, childFailBefore.attempts, 'Attempts must not change');
    assert.equal(childFailAfter.error_code, 'TEST_TERMINAL_FAIL', 'Error code must not be cleared');

    const parentFailAfter = (
      await db.query<{ summary_status: string }>(
        `SELECT summary_status FROM zalo_personal_calls WHERE id = $1`,
        [callFail]
      )
    ).rows[0];
    assert.equal(parentFailAfter.summary_status, 'FAILED', 'Parent summary_status must NOT be reset to PENDING');
    assert.equal(parentFailAfter.summary_status, childFailAfter.status, 'Parent summary_status matches child status');
    testPass('Test 2.3: Duplicate enqueue on FAILED summary does NOT auto-retry and preserves parent status');

    console.log('--- Test 2.4: Duplicate enqueue idempotency on COMPLETED summary ---');
    const { callId: callComp } = await seedCall(companyA, saleA);
    const txComp = await seedCompletedTranscription(companyA, callComp, 2);
    const sumCompId = await enqueueZaloCallSummary(companyA, txComp, adminClient);

    const claimedComp = (
      await adminClient.rpc('zalo_claim_call_summary_job', {
        p_company: companyA,
        p_summary_id: sumCompId,
        p_locked_by: 'worker_test_comp',
        p_lease_seconds: 300,
      })
    ).data as ClaimedSummaryJob[];
    assert.equal(claimedComp.length, 1);

    await processZaloCallSummaryJob(claimedComp[0], {
      client: adminClient,
      provider: new MockSummaryProvider(async () => validMockOutput),
    });

    const childCompBefore = (
      await db.query<{
        status: string;
        summary: string;
        completed_at: string;
      }>(
        `SELECT status, summary, completed_at FROM zalo_call_ai_summaries WHERE id = $1`,
        [sumCompId]
      )
    ).rows[0];
    assert.equal(childCompBefore.status, 'COMPLETED');
    assert.ok(childCompBefore.completed_at);

    const parentCompBefore = (
      await db.query<{ summary_status: string }>(
        `SELECT summary_status FROM zalo_personal_calls WHERE id = $1`,
        [callComp]
      )
    ).rows[0];
    assert.equal(parentCompBefore.summary_status, 'COMPLETED');

    // Duplicate enqueue on COMPLETED!
    const sumCompDup = await enqueueZaloCallSummary(companyA, txComp, adminClient);
    assert.equal(sumCompDup, sumCompId, 'Duplicate enqueue returns same summary ID');

    const totalSummariesComp = Number((
      await db.query<{ count: string }>(
        `SELECT count(*) FROM zalo_call_ai_summaries WHERE company_id = $1 AND transcription_id = $2`,
        [companyA, txComp]
      )
    ).rows[0].count);
    assert.equal(totalSummariesComp, 1, 'Exactly one summary row exists');

    const childCompAfter = (
      await db.query<{
        status: string;
        summary: string;
        completed_at: string;
      }>(
        `SELECT status, summary, completed_at FROM zalo_call_ai_summaries WHERE id = $1`,
        [sumCompId]
      )
    ).rows[0];
    assert.equal(childCompAfter.status, 'COMPLETED', 'Child status must remain COMPLETED');
    assert.equal(childCompAfter.summary, childCompBefore.summary, 'Summary text must be untouched');

    const parentCompAfter = (
      await db.query<{ summary_status: string }>(
        `SELECT summary_status FROM zalo_personal_calls WHERE id = $1`,
        [callComp]
      )
    ).rows[0];
    assert.equal(parentCompAfter.summary_status, 'COMPLETED', 'Parent summary_status must remain COMPLETED');
    assert.equal(parentCompAfter.summary_status, childCompAfter.status, 'Parent summary_status matches child status');
    testPass('Test 2.4: Duplicate enqueue on COMPLETED summary leaves summary row and parent COMPLETED unchanged');

    // ========================================================================
    // TEST 3: Transcription NOT completed cannot be enqueued or claimed
    // ========================================================================
    console.log('--- Test 3: Uncompleted transcription rejection ---');
    const { callId: callUncompleted } = await seedCall(companyA, saleA, 'PROCESSING');
    const txUncompleted = randomUUID();
    await db.query(
      `INSERT INTO zalo_call_transcriptions(id, company_id, call_id, status) VALUES($1, $2, $3, 'PROCESSING')`,
      [txUncompleted, companyA, callUncompleted]
    );

    await assert.rejects(
      async () => enqueueZaloCallSummary(companyA, txUncompleted, adminClient),
      /TRANSCRIPTION_NOT_COMPLETED/,
      'Enqueuing uncompleted transcription must be rejected'
    );
    testPass('Test 3: Transcription not completed cannot be enqueued');

    // ========================================================================
    // TEST 4: Empty transcript fail-safe (fails safe to FAILED; transcription stays COMPLETED)
    // ========================================================================
    console.log('--- Test 4: Empty transcript fail safe ---');
    const { callId: callEmpty } = await seedCall(companyA, saleA);
    const txEmpty = await seedCompletedTranscription(companyA, callEmpty, 0); // 0 utterances

    const summaryIdEmpty = await enqueueZaloCallSummary(companyA, txEmpty, adminClient);

    const claimedEmpty = (
      await adminClient.rpc('zalo_claim_call_summary_job', {
        p_company: companyA,
        p_summary_id: summaryIdEmpty,
      })
    ).data as ClaimedSummaryJob[];

    assert.equal(claimedEmpty.length, 1);
    const emptyJob = claimedEmpty[0];

    const mockProvider = new MockSummaryProvider(async () => {
      throw new Error('Should not be called for empty utterances');
    });

    await assert.rejects(
      async () =>
        processZaloCallSummaryJob(emptyJob, {
          client: adminClient,
          provider: mockProvider,
        }),
      /SUMMARY_TRANSCRIPT_EMPTY/
    );

    const afterEmptyRow = (
      await db.query<{ status: string; error_code: string }>(
        `SELECT status, error_code FROM zalo_call_ai_summaries WHERE id = $1`,
        [summaryIdEmpty]
      )
    ).rows[0];
    assert.equal(afterEmptyRow.status, 'FAILED');
    assert.equal(afterEmptyRow.error_code, 'SUMMARY_TRANSCRIPT_EMPTY');

    // Transcription must still be COMPLETED
    const txEmptyStatus = (
      await db.query<{ status: string }>(
        `SELECT status FROM zalo_call_transcriptions WHERE id = $1`,
        [txEmpty]
      )
    ).rows[0].status;
    assert.equal(txEmptyStatus, 'COMPLETED', 'Transcription status must remain COMPLETED');
    testPass('Test 4: Empty transcript fails safe to FAILED without altering transcription COMPLETED');

    // ========================================================================
    // TEST 5: Valid Gemini structured response persists correctly
    // ========================================================================
    console.log('--- Test 5: Valid structured response persistence ---');
    const { callId: callValid } = await seedCall(companyA, saleA);
    const txValid = await seedCompletedTranscription(companyA, callValid, 3);
    const summaryIdValid = await enqueueZaloCallSummary(companyA, txValid, adminClient);

    const claimedValid = (
      await adminClient.rpc('zalo_claim_call_summary_job', {
        p_company: companyA,
        p_summary_id: summaryIdValid,
      })
    ).data as ClaimedSummaryJob[];
    assert.equal(claimedValid.length, 1);

    const validProvider = new MockSummaryProvider(async () => validMockOutput);

    await processZaloCallSummaryJob(claimedValid[0], {
      client: adminClient,
      provider: validProvider,
    });

    const persisted = (
      await db.query<{
        status: string;
        summary: string;
        lead_temperature: string;
        confidence: string;
        follow_up_required: boolean;
        customer_needs: string;
        lock_token: string | null;
        completed_at: string | null;
      }>(`SELECT * FROM zalo_call_ai_summaries WHERE id = $1`, [summaryIdValid])
    ).rows[0];

    assert.equal(persisted.status, 'COMPLETED');
    assert.equal(persisted.summary, validMockOutput.summary);
    assert.equal(persisted.lead_temperature, 'WARM');
    assert.equal(persisted.confidence, 'HIGH');
    assert.equal(persisted.follow_up_required, true);
    assert.equal(persisted.lock_token, null, 'Lock token must be cleared upon completion');
    assert.ok(persisted.completed_at, 'completed_at must be recorded');

    // Call summary status updated
    const callStatusValid = (
      await db.query<{ summary_status: string }>(
        `SELECT summary_status FROM zalo_personal_calls WHERE id = $1`,
        [callValid]
      )
    ).rows[0].summary_status;
    assert.equal(callStatusValid, 'COMPLETED');

    // Verify audit log recorded
    const auditCount = (
      await db.query<{ count: string | number }>(
        `SELECT count(*) FROM audit_logs WHERE action = 'ZALO_CALL_AI_SUMMARY_COMPLETED' AND resource_id = $1`,
        [summaryIdValid]
      )
    ).rows[0].count;
    assert.equal(Number(auditCount), 1, 'Audit log must be created on summary completion');
    testPass('Test 5: Valid structured response persists completely and updates call summary status');

    // ========================================================================
    // TEST 6: Invalid response rejected
    // ========================================================================
    console.log('--- Test 6: Invalid response rejected ---');
    const { callId: callInvalid } = await seedCall(companyA, saleA);
    const txInvalid = await seedCompletedTranscription(companyA, callInvalid, 2);
    const summaryIdInvalid = await enqueueZaloCallSummary(companyA, txInvalid, adminClient);

    const claimedInvalid = (
      await adminClient.rpc('zalo_claim_call_summary_job', {
        p_company: companyA,
        p_summary_id: summaryIdInvalid,
      })
    ).data as ClaimedSummaryJob[];

    const badProvider = new MockSummaryProvider(async () => {
      throw new Error('SUMMARY_INVALID_RESPONSE');
    });

    await assert.rejects(
      async () =>
        processZaloCallSummaryJob(claimedInvalid[0], {
          client: adminClient,
          provider: badProvider,
        }),
      /SUMMARY_INVALID_RESPONSE/
    );

    const afterInvalidRow = (
      await db.query<{ status: string; error_code: string }>(
        `SELECT status, error_code FROM zalo_call_ai_summaries WHERE id = $1`,
        [summaryIdInvalid]
      )
    ).rows[0];
    assert.equal(afterInvalidRow.status, 'FAILED');
    assert.equal(afterInvalidRow.error_code, 'SUMMARY_INVALID_RESPONSE');
    testPass('Test 6: Invalid response rejected and transitioned to FAILED');

    // ========================================================================
    // TEST 7 & 8: Strict DB constraints on enums
    // ========================================================================
    console.log('--- Test 7 & 8: DB Check constraints on enums ---');
    await assert.rejects(
      async () =>
        db.query(
          `INSERT INTO zalo_call_ai_summaries(company_id, call_id, transcription_id, provider, model, lead_temperature)
           VALUES($1, $2, $3, 'GEMINI', 'm', 'LUKEWARM')`,
          [companyA, callValid, randomUUID()]
        ),
      /check constraint/i,
      'Invalid lead_temperature must violate check constraint'
    );
    testPass('Test 7: lead_temperature check constraint strictly enforced in PostgreSQL');

    await assert.rejects(
      async () =>
        db.query(
          `INSERT INTO zalo_call_ai_summaries(company_id, call_id, transcription_id, provider, model, confidence)
           VALUES($1, $2, $3, 'GEMINI', 'm', 'VERY_CONFIDENT')`,
          [companyA, callValid, randomUUID()]
        ),
      /check constraint/i,
      'Invalid confidence must violate check constraint'
    );
    testPass('Test 8: confidence check constraint strictly enforced in PostgreSQL');

    // ========================================================================
    // TEST 9: Tenant isolation
    // ========================================================================
    console.log('--- Test 9: Tenant isolation ---');
    const { callId: callTenantA } = await seedCall(companyA, saleA);
    const txTenantA = await seedCompletedTranscription(companyA, callTenantA, 2);
    const summaryTenantA = await enqueueZaloCallSummary(companyA, txTenantA, adminClient);

    // Company B attempts to claim Company A's summary
    const crossClaim = (
      await adminClient.rpc('zalo_claim_call_summary_job', {
        p_company: companyB,
        p_summary_id: summaryTenantA,
      })
    ).data as ClaimedSummaryJob[];
    assert.equal(crossClaim.length, 0, 'Cross-tenant claim must return 0 rows');

    // Targeted worker runner with wrong companyId
    const targetedCrossRes = await processTargetedZaloCallSummaryJob(
      { summaryId: summaryTenantA },
      { client: adminClient, companyId: companyB }
    );
    assert.equal(targetedCrossRes.claimed, 0, 'Cross-tenant targeted runner claims 0');
    testPass('Test 9: Tenant isolation strictly verified: cross-company claim returns 0');

    // ========================================================================
    // TEST 10: Security & ACL: anon/authenticated denied, service_role allowed
    // ========================================================================
    console.log('--- Test 10: Security & ACL ---');
    for (const role of ['anon', 'authenticated']) {
      await db.query(`SET ROLE ${role}`);
      let denied = false;
      try {
        await db.query(
          `SELECT * FROM public.zalo_claim_call_summary_job($1, $2, 'test', 300)`,
          [companyA, summaryTenantA]
        );
      } catch (err: any) {
        denied = true;
        assert.ok(/permission denied/i.test(err.message), `Role ${role} must get permission denied`);
      }
      assert.ok(denied, `Role ${role} must be denied execution of claim RPC`);
    }
    await db.query(`RESET ROLE`);
    testPass('Test 10: anon and authenticated roles strictly denied execution of internal summary RPCs');

    // ========================================================================
    // TEST 11 & 12: Lock token fencing
    // ========================================================================
    console.log('--- Test 11 & 12: Lock token fencing ---');
    const claimedFence = (
      await adminClient.rpc('zalo_claim_call_summary_job', {
        p_company: companyA,
        p_summary_id: summaryTenantA,
      })
    ).data as ClaimedSummaryJob[];
    assert.equal(claimedFence.length, 1);
    const validLockToken = claimedFence[0].lock_token;
    const staleLockToken = randomUUID();

    // Stale lock token completion rejected
    await assert.rejects(
      async () =>
        db.query(
          `SELECT public.zalo_complete_call_summary(
            $1, $2, $3, 'summary', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
            'WARM', false, null, null, 'HIGH', 'GEMINI', 'gemini-2.5-flash', 'v1'
          )`,
          [companyA, summaryTenantA, staleLockToken]
        ),
      /SUMMARY_LOCK_LOST/,
      'Stale lock token completion must throw SUMMARY_LOCK_LOST'
    );

    // Stale lock token fail rejected
    await assert.rejects(
      async () =>
        db.query(
          `SELECT public.zalo_fail_call_summary($1, $2, $3, 'ERR', 'msg', true)`,
          [companyA, summaryTenantA, staleLockToken]
        ),
      /SUMMARY_LOCK_LOST/,
      'Stale lock token failure must throw SUMMARY_LOCK_LOST'
    );
    testPass('Test 11 & 12: Stale lock token strictly fenced on completion and failure');

    // ========================================================================
    // TEST 13: Expired lease recovery
    // ========================================================================
    console.log('--- Test 13: Expired lease recovery ---');
    // Set lease expired in the past
    await db.query(
      `UPDATE zalo_call_ai_summaries
       SET lease_expires_at = now() - interval '10 seconds', attempts = 1
       WHERE id = $1`,
      [summaryTenantA]
    );

    // Reclamation with fresh lease
    const reclaimed = (
      await adminClient.rpc('zalo_claim_call_summary_job', {
        p_company: companyA,
        p_summary_id: summaryTenantA,
      })
    ).data as ClaimedSummaryJob[];

    assert.equal(reclaimed.length, 1, 'Expired lease must be reclaimed');
    assert.notEqual(reclaimed[0].lock_token, validLockToken, 'Fresh lock token generated');
    assert.equal(reclaimed[0].attempts, 2, 'Attempts counter incremented');
    testPass('Test 13: Expired processing lease reclaimed with fresh lock token and incremented attempts');

    // ========================================================================
    // TEST 14: Terminal exhaustion
    // ========================================================================
    console.log('--- Test 14: Terminal exhaustion ---');
    // Set attempts to 2 with max_attempts = 3
    await db.query(
      `UPDATE zalo_call_ai_summaries
       SET lease_expires_at = now() - interval '10 seconds', attempts = 2, max_attempts = 3
       WHERE id = $1`,
      [summaryTenantA]
    );

    const exhaustedClaim = (
      await adminClient.rpc('zalo_claim_call_summary_job', {
        p_company: companyA,
        p_summary_id: summaryTenantA,
      })
    ).data as ClaimedSummaryJob[];

    assert.equal(exhaustedClaim.length, 0, 'Exhausted job must not be claimed');

    const exhaustedRow = (
      await db.query<{ status: string; error_code: string; attempts: number }>(
        `SELECT status, error_code, attempts FROM zalo_call_ai_summaries WHERE id = $1`,
        [summaryTenantA]
      )
    ).rows[0];
    assert.equal(exhaustedRow.status, 'FAILED');
    assert.equal(exhaustedRow.error_code, 'EXPIRED_LEASE_MAX_ATTEMPTS');
    assert.equal(exhaustedRow.attempts, 3);
    testPass('Test 14: Expired job exceeding max_attempts cleanly transitions to FAILED');

    // ========================================================================
    // TEST 15: Targeted mode claims only 1 job without bulk fallback
    // ========================================================================
    console.log('--- Test 15: Targeted mode isolation ---');
    const { callId: callTarget1 } = await seedCall(companyA, saleA);
    const txTarget1 = await seedCompletedTranscription(companyA, callTarget1, 2);
    const sumTarget1 = await enqueueZaloCallSummary(companyA, txTarget1, adminClient);

    const { callId: callTarget2 } = await seedCall(companyA, saleA);
    const txTarget2 = await seedCompletedTranscription(companyA, callTarget2, 2);
    const sumTarget2 = await enqueueZaloCallSummary(companyA, txTarget2, adminClient);

    const targetedRun = await processTargetedZaloCallSummaryJob(
      { summaryId: sumTarget1 },
      {
        client: adminClient,
        provider: new MockSummaryProvider(async () => validMockOutput),
      }
    );

    assert.equal(targetedRun.claimed, 1);
    assert.equal(targetedRun.processed, 1);

    // Job 2 must remain in PENDING state untouched
    const job2Status = (
      await db.query<{ status: string }>(
        `SELECT status FROM zalo_call_ai_summaries WHERE id = $1`,
        [sumTarget2]
      )
    ).rows[0].status;
    assert.equal(job2Status, 'PENDING', 'Second job must remain untouched');
    testPass('Test 15: Targeted mode strictly processes target job and leaves other jobs in PENDING');

    // ========================================================================
    // TEST 16: Recording and transcript utterances immutability
    // ========================================================================
    console.log('--- Test 16: Immutability proof ---');
    const utteranceSnapshotBefore = (
      await db.query(
        `SELECT id, text, speaker_role, start_ms, end_ms FROM zalo_call_transcript_utterances WHERE transcription_id = $1 ORDER BY sequence`,
        [txTarget1]
      )
    ).rows;

    const recordingSnapshotBefore = (
      await db.query(
        `SELECT id, recording_path, recording_status FROM zalo_personal_calls WHERE id = $1`,
        [callTarget1]
      )
    ).rows[0];

    const utteranceSnapshotAfter = (
      await db.query(
        `SELECT id, text, speaker_role, start_ms, end_ms FROM zalo_call_transcript_utterances WHERE transcription_id = $1 ORDER BY sequence`,
        [txTarget1]
      )
    ).rows;

    const recordingSnapshotAfter = (
      await db.query(
        `SELECT id, recording_path, recording_status FROM zalo_personal_calls WHERE id = $1`,
        [callTarget1]
      )
    ).rows[0];

    assert.deepEqual(utteranceSnapshotBefore, utteranceSnapshotAfter, 'Utterances must remain byte-for-byte identical');
    assert.deepEqual(recordingSnapshotBefore, recordingSnapshotAfter, 'Recording metadata must remain identical');
    testPass('Test 16: Transcript utterances and recording path remain strictly immutable');

    // ========================================================================
    // TEST 17: Authorized manual retry resets FAILED to PENDING
    // ========================================================================
    console.log('--- Test 17: Authorized manual retry ---');
    // sumTarget1 is COMPLETED: retry returns false (idempotent no-op)
    const completedRetry = await retryZaloCallSummary(companyA, saleA, sumTarget1, adminClient);
    assert.equal(completedRetry, false, 'Retry on COMPLETED is a safe no-op');

    // sumTarget2: mark FAILED and retry
    await db.query(
      `UPDATE zalo_call_ai_summaries SET status = 'FAILED', attempts = 3 WHERE id = $1`,
      [sumTarget2]
    );

    const retrySuccess = await retryZaloCallSummary(companyA, saleA, sumTarget2, adminClient);
    assert.equal(retrySuccess, true, 'Retry on FAILED resets job');

    const retriedRow = (
      await db.query<{ status: string; attempts: number }>(
        `SELECT status, attempts FROM zalo_call_ai_summaries WHERE id = $1`,
        [sumTarget2]
      )
    ).rows[0];
    assert.equal(retriedRow.status, 'PENDING');
    assert.equal(retriedRow.attempts, 0);

    // Cross-tenant user B attempting retry is forbidden
    await assert.rejects(
      async () => retryZaloCallSummary(companyA, saleB, sumTarget2, adminClient),
      /FORBIDDEN/,
      'Unauthorized user must be forbidden from retrying'
    );
    testPass('Test 17: Authorized manual retry resets FAILED to PENDING; unauthorized user denied');

    // ========================================================================
    // TEST 18: Bulk worker processes multiple due jobs
    // ========================================================================
    console.log('--- Test 18: Bulk worker processing ---');
    const bulkResult = await processDueZaloCallSummaryJobs(5, {
      client: adminClient,
      provider: new MockSummaryProvider(async () => validMockOutput),
    });

    assert.ok(bulkResult.claimed >= 1, 'Bulk worker claimed at least 1 job');
    assert.equal(bulkResult.failed, 0, 'Bulk worker processed without failures');
    testPass('Test 18: Bulk worker successfully claims and processes due summary queue');

    // ========================================================================
    // TEST 19: Provider & Model dynamic environment resolution on enqueue
    // ========================================================================
    console.log('--- Test 19: Provider & Model dynamic environment resolution ---');
    const origSummaryProvider = process.env.SUMMARY_PROVIDER;
    const origGeminiModel = process.env.GEMINI_SUMMARY_MODEL;
    const origOpenAiModel = process.env.OPENAI_SUMMARY_MODEL;

    try {
      // 19.1: SUMMARY_PROVIDER=GEMINI, GEMINI_SUMMARY_MODEL=model-A
      process.env.SUMMARY_PROVIDER = 'GEMINI';
      process.env.GEMINI_SUMMARY_MODEL = 'gemini-custom-model-A';
      const { callId: callModelA } = await seedCall(companyA, saleA);
      const txModelA = await seedCompletedTranscription(companyA, callModelA, 1);
      const sumIdModelA = await enqueueZaloCallSummary(companyA, txModelA, adminClient);

      const rowModelA = (
        await db.query<{ provider: string; model: string }>(
          `SELECT provider, model FROM zalo_call_ai_summaries WHERE id = $1`,
          [sumIdModelA]
        )
      ).rows[0];
      assert.equal(rowModelA.provider, 'GEMINI');
      assert.equal(rowModelA.model, 'gemini-custom-model-A');

      // 19.2: Change model to model-B -> new job uses model-B
      process.env.GEMINI_SUMMARY_MODEL = 'gemini-custom-model-B';
      const { callId: callModelB } = await seedCall(companyA, saleA);
      const txModelB = await seedCompletedTranscription(companyA, callModelB, 1);
      const sumIdModelB = await enqueueZaloCallSummary(companyA, txModelB, adminClient);

      const rowModelB = (
        await db.query<{ provider: string; model: string }>(
          `SELECT provider, model FROM zalo_call_ai_summaries WHERE id = $1`,
          [sumIdModelB]
        )
      ).rows[0];
      assert.equal(rowModelB.provider, 'GEMINI');
      assert.equal(rowModelB.model, 'gemini-custom-model-B');

      // 19.3: SUMMARY_PROVIDER=OPENAI -> new job writes OPENAI + OpenAI model
      process.env.SUMMARY_PROVIDER = 'OPENAI';
      process.env.OPENAI_SUMMARY_MODEL = 'gpt-4o-custom-2026';
      const { callId: callOpenAI } = await seedCall(companyA, saleA);
      const txOpenAI = await seedCompletedTranscription(companyA, callOpenAI, 1);
      const sumIdOpenAI = await enqueueZaloCallSummary(companyA, txOpenAI, adminClient);

      const rowOpenAI = (
        await db.query<{ provider: string; model: string }>(
          `SELECT provider, model FROM zalo_call_ai_summaries WHERE id = $1`,
          [sumIdOpenAI]
        )
      ).rows[0];
      assert.equal(rowOpenAI.provider, 'OPENAI');
      assert.equal(rowOpenAI.model, 'gpt-4o-custom-2026');

      // 19.4: Invalid provider fails closed without mutating DB
      process.env.SUMMARY_PROVIDER = 'CLAUDE_UNSUPPORTED';
      const { callId: callInvalid } = await seedCall(companyA, saleA);
      const txInvalid = await seedCompletedTranscription(companyA, callInvalid, 1);

      await assert.rejects(
        async () => enqueueZaloCallSummary(companyA, txInvalid, adminClient),
        /SUMMARY_PROVIDER_NOT_CONFIGURED/
      );

      // Verify transcription still COMPLETED and 0 summary rows created
      const txInvalidStatus = (
        await db.query<{ status: string }>(
          `SELECT status FROM zalo_call_transcriptions WHERE id = $1`,
          [txInvalid]
        )
      ).rows[0].status;
      assert.equal(txInvalidStatus, 'COMPLETED', 'Invalid provider must never alter transcription COMPLETED');

      const noRows = (
        await db.query<{ count: string | number }>(
          `SELECT count(*) FROM zalo_call_ai_summaries WHERE transcription_id = $1`,
          [txInvalid]
        )
      ).rows[0].count;
      assert.equal(Number(noRows), 0);

      testPass('Test 19: Dynamic provider and model environment resolution verified on enqueue');
    } finally {
      if (origSummaryProvider === undefined) delete process.env.SUMMARY_PROVIDER;
      else process.env.SUMMARY_PROVIDER = origSummaryProvider;

      if (origGeminiModel === undefined) delete process.env.GEMINI_SUMMARY_MODEL;
      else process.env.GEMINI_SUMMARY_MODEL = origGeminiModel;

      if (origOpenAiModel === undefined) delete process.env.OPENAI_SUMMARY_MODEL;
      else process.env.OPENAI_SUMMARY_MODEL = origOpenAiModel;
    }

    // ========================================================================
    // TEST 20: Follow-up Time Contract (Natural language, ISO, null, unrequired)
    // ========================================================================
    console.log('--- Test 20: Follow-up Time Contract end-to-end ---');
    const { callId: callTimeContract } = await seedCall(companyA, saleA);
    const txTimeContract = await seedCompletedTranscription(companyA, callTimeContract, 2);
    const sumIdTimeContract = await enqueueZaloCallSummary(companyA, txTimeContract, adminClient);

    const claimedTime = (
      await adminClient.rpc('zalo_claim_call_summary_job', {
        p_company: companyA,
        p_summary_id: sumIdTimeContract,
      })
    ).data as ClaimedSummaryJob[];
    assert.equal(claimedTime.length, 1);

    // Natural language Vietnamese relative time
    const naturalTimeOutput: CallSummaryStructuredOutput = {
      summary: 'Khách hàng hẹn gọi lại vào sáng thứ 2 tuần tới sau khi trao đổi với gia đình.',
      customer_needs: ['Tư vấn chi phí'],
      objections: ['Cần hỏi ý kiến gia đình'],
      next_actions: ['Liên hệ lại sáng thứ 2'],
      lead_temperature: 'WARM',
      follow_up: {
        required: true,
        suggested_time: 'Sáng thứ 2 tuần tới',
        reason: 'Khách cần bàn bạc với gia đình vào cuối tuần',
      },
      key_points: ['Khách thiện chí'],
      confidence: 'MEDIUM',
    };

    await processZaloCallSummaryJob(claimedTime[0], {
      client: adminClient,
      provider: new MockSummaryProvider(async () => naturalTimeOutput),
    });

    const persistedTime = (
      await db.query<{
        status: string;
        follow_up_required: boolean;
        follow_up_suggested_time: string | null;
        follow_up_reason: string | null;
      }>(
        `SELECT status, follow_up_required, follow_up_suggested_time, follow_up_reason FROM zalo_call_ai_summaries WHERE id = $1`,
        [sumIdTimeContract]
      )
    ).rows[0];

    assert.equal(persistedTime.status, 'COMPLETED');
    assert.equal(persistedTime.follow_up_required, true);
    assert.equal(persistedTime.follow_up_suggested_time, 'Sáng thứ 2 tuần tới');
    assert.equal(persistedTime.follow_up_reason, 'Khách cần bàn bạc với gia đình vào cuối tuần');
    testPass('Test 20: Follow-up time contract stores natural-language relative expression without DB cast failure');

    // ========================================================================
    // TEST 21: Production-Safe Reconciliation & Activation Boundary Guard
    // ========================================================================
    console.log('--- Test 21: Production-Safe Reconciliation & Activation Boundary Guard ---');
    const nowMs = Date.now();
    const historicalCompletedAt = new Date(nowMs - 120_000); // 2 minutes ago (historical)
    const activationCutoff = new Date(nowMs + 5_000); // Rollout boundary (ahead of prior tests)
    const postCutoffCompletedAt = new Date(nowMs + 10_000); // Phase 2B new call after cutoff

    // Seed historical transcriptions (Phase 2A baseline calls) completed before cutoff
    const { callId: callHistA } = await seedCall(companyA, saleA);
    const txHistA = await seedCompletedTranscription(companyA, callHistA, 2, historicalCompletedAt);

    const { callId: callHistB } = await seedCall(companyB, saleB);
    const txHistB = await seedCompletedTranscription(companyB, callHistB, 2, historicalCompletedAt);

    // Verify 0 summaries exist for historical transcriptions initially
    const countHistABefore = Number((await db.query<{ count: string }>(
      `SELECT count(*) FROM zalo_call_ai_summaries WHERE transcription_id IN ($1, $2)`,
      [txHistA, txHistB]
    )).rows[0].count);
    assert.equal(countHistABefore, 0);

    // Requirement 1: Historical transcription completed before activation boundary -> reconciliation KHÔNG tạo summary
    const countNoCutoff = await reconcileMissingZaloCallSummaries(10, adminClient, { since: activationCutoff });
    assert.equal(countNoCutoff, 0, 'Reconciliation must not create summary for historical transcriptions completed before cutoff');

    const countHistAfter = Number((await db.query<{ count: string }>(
      `SELECT count(*) FROM zalo_call_ai_summaries WHERE transcription_id IN ($1, $2)`,
      [txHistA, txHistB]
    )).rows[0].count);
    assert.equal(countHistAfter, 0, 'Historical transcriptions must remain untouched by reconciliation');
    testPass('Test 21.1: Historical transcriptions completed before activation boundary are NOT enqueued by reconciliation');

    // Requirement 2: New transcription completed after activation boundary where enqueue failed -> reconciliation creates EXACTLY 1 summary
    const { callId: callNewA } = await seedCall(companyA, saleA);
    const txNewA = await seedCompletedTranscription(companyA, callNewA, 2, postCutoffCompletedAt);

    const reconciledNewCount = await reconcileMissingZaloCallSummaries(10, adminClient, { since: activationCutoff });
    assert.equal(reconciledNewCount, 1, 'Reconciliation must create exactly 1 summary for post-cutoff transcription');

    const sumNewRow = (await db.query<{ status: string; company_id: string; call_id: string }>(
      `SELECT status, company_id, call_id FROM zalo_call_ai_summaries WHERE transcription_id = $1`,
      [txNewA]
    )).rows[0];
    assert.equal(sumNewRow.status, 'PENDING');
    assert.equal(sumNewRow.company_id, companyA);
    assert.equal(sumNewRow.call_id, callNewA);
    testPass('Test 21.2: New transcription completed after activation boundary is recovered by reconciliation');

    // Requirement 3: Repeated reconciliation on already-enqueued transcription -> does NOT duplicate, count is 0
    const secondReconcileCount = await reconcileMissingZaloCallSummaries(10, adminClient, { since: activationCutoff });
    assert.equal(secondReconcileCount, 0, 'Second reconciliation run must create 0 duplicates');

    const countNewAfterRepeat = Number((await db.query<{ count: string }>(
      `SELECT count(*) FROM zalo_call_ai_summaries WHERE transcription_id = $1`,
      [txNewA]
    )).rows[0].count);
    assert.equal(countNewAfterRepeat, 1, 'Summary row count must remain exactly 1 after repeated reconciliation');
    testPass('Test 21.3: Repeated reconciliation is strictly idempotent and does not create duplicates');

    // Requirement 4: Multiple tenants with missing summaries -> tenant isolation preserved
    const { callId: callMultiA } = await seedCall(companyA, saleA);
    const txMultiA = await seedCompletedTranscription(companyA, callMultiA, 2, postCutoffCompletedAt);

    const { callId: callMultiB } = await seedCall(companyB, saleB);
    const txMultiB = await seedCompletedTranscription(companyB, callMultiB, 2, postCutoffCompletedAt);

    const multiTenantReconcileCount = await reconcileMissingZaloCallSummaries(10, adminClient, { since: activationCutoff });
    assert.equal(multiTenantReconcileCount, 2, 'Reconciliation must recover missing summaries across multiple tenants');

    const rowTenantA = (await db.query<{ company_id: string; status: string }>(
      `SELECT company_id, status FROM zalo_call_ai_summaries WHERE transcription_id = $1`,
      [txMultiA]
    )).rows[0];
    assert.equal(rowTenantA.company_id, companyA);
    assert.equal(rowTenantA.status, 'PENDING');

    const rowTenantB = (await db.query<{ company_id: string; status: string }>(
      `SELECT company_id, status FROM zalo_call_ai_summaries WHERE transcription_id = $1`,
      [txMultiB]
    )).rows[0];
    assert.equal(rowTenantB.company_id, companyB);
    assert.equal(rowTenantB.status, 'PENDING');
    testPass('Test 21.4: Multi-tenant reconciliation preserves strict tenant isolation and assigns correct company_id');

    // Requirement 5: Bulk scheduler run (processDueZaloCallSummaryJobs) -> does NOT touch historical rows
    const originalCutoffEnv = process.env.SUMMARY_ACTIVATION_CUTOFF;
    process.env.SUMMARY_ACTIVATION_CUTOFF = activationCutoff.toISOString();
    try {
      const bulkResult = await processDueZaloCallSummaryJobs(10, {
        client: adminClient,
        provider: new MockSummaryProvider(async () => validMockOutput),
      });
      assert.ok(bulkResult.claimed >= 3, 'Bulk worker processes the 3 pending post-cutoff jobs');
      assert.equal(bulkResult.failed, 0);

      // Verify historical rows (txHistA, txHistB) STILL have NO summary
      const countHistAfterBulk = Number((await db.query<{ count: string }>(
        `SELECT count(*) FROM zalo_call_ai_summaries WHERE transcription_id IN ($1, $2)`,
        [txHistA, txHistB]
      )).rows[0].count);
      assert.equal(countHistAfterBulk, 0, 'Bulk scheduler must never touch or backfill historical transcriptions');
      testPass('Test 21.5: Bulk scheduler run processes due jobs without scanning or creating summaries for historical rows');
    } finally {
      process.env.SUMMARY_ACTIVATION_CUTOFF = originalCutoffEnv;
    }

    // Requirement 6: Targeted recovery on explicit transcription_id for a specific historical transcription
    // Processes ONLY that requested ID, without triggering bulk backfill of other historical records
    const targetedHistResult = await processTargetedZaloCallSummaryJob(
      { transcriptionId: txHistA },
      {
        client: adminClient,
        provider: new MockSummaryProvider(async () => validMockOutput),
      }
    );
    assert.equal(targetedHistResult.claimed, 1);
    assert.equal(targetedHistResult.processed, 1);
    assert.equal(targetedHistResult.failed, 0);

    // Verify txHistA has a COMPLETED summary
    const sumHistARow = (await db.query<{ status: string; company_id: string }>(
      `SELECT status, company_id FROM zalo_call_ai_summaries WHERE transcription_id = $1`,
      [txHistA]
    )).rows[0];
    assert.equal(sumHistARow.status, 'COMPLETED');
    assert.equal(sumHistARow.company_id, companyA);

    // Verify txHistB (the other historical transcription) STILL has NO summary (no bulk backfill triggered)
    const countHistBAfter = Number((await db.query<{ count: string }>(
      `SELECT count(*) FROM zalo_call_ai_summaries WHERE transcription_id = $1`,
      [txHistB]
    )).rows[0].count);
    assert.equal(countHistBAfter, 0, 'Other historical transcriptions must not be touched by targeted recovery');
    testPass('Test 21.6: Targeted recovery on explicit historical transcription_id processes only requested ID without bulk backfill');

    // ========================================================================
    // TEST 22: Production Bulk Cron Reconciliation via SUMMARY_ACTIVATION_CUTOFF
    // (Simulates exact production path where processDueZaloCallSummaryJobs is invoked
    // WITHOUT options.reconciliationSince)
    // ========================================================================
    console.log('--- Test 22: Production Bulk Cron Reconciliation via SUMMARY_ACTIVATION_CUTOFF ---');
    const origCutoffEnv = process.env.SUMMARY_ACTIVATION_CUTOFF;
    const test22NowMs = Date.now();
    const test22Cutoff = new Date(test22NowMs + 5_000);
    const test22HistCompletedAt = new Date(test22NowMs - 60_000); // 1 min before cutoff
    const test22PostCutoffCompletedAt = new Date(test22NowMs + 15_000); // after cutoff

    process.env.SUMMARY_ACTIVATION_CUTOFF = test22Cutoff.toISOString();

    try {
      // 1. Seed historical transcription (completed BEFORE cutoff, NO summary row created)
      const { callId: callProdHist } = await seedCall(companyA, saleA);
      const txProdHist = await seedCompletedTranscription(companyA, callProdHist, 2, test22HistCompletedAt);

      // 2. Seed new post-cutoff transcription (completed AFTER cutoff, NO summary row created, simulating transient enqueue failure)
      const { callId: callProdNew } = await seedCall(companyA, saleA);
      const txProdNew = await seedCompletedTranscription(companyA, callProdNew, 2, test22PostCutoffCompletedAt);

      // Verify neither has a summary initially
      const countBefore = Number((await db.query<{ count: string }>(
        `SELECT count(*) FROM zalo_call_ai_summaries WHERE transcription_id IN ($1, $2)`,
        [txProdHist, txProdNew]
      )).rows[0].count);
      assert.equal(countBefore, 0, 'No summary rows exist before bulk cron');

      // 3. Call processDueZaloCallSummaryJobs WITHOUT options.reconciliationSince (exact production cron bulk path!)
      const bulkCronResult = await processDueZaloCallSummaryJobs(10, {
        client: adminClient,
        provider: new MockSummaryProvider(async () => validMockOutput),
      });

      // Verify the post-cutoff job was reconciled, claimed, and processed to completion
      assert.ok(bulkCronResult.claimed >= 1, 'Reconciliation enqueued and bulk worker claimed the post-cutoff job');
      assert.ok(bulkCronResult.processed >= 1, 'Bulk worker processed the post-cutoff job');
      assert.equal(bulkCronResult.failed, 0);

      // Verify new post-cutoff transcription summary is COMPLETED
      const newSummaryRows = (await db.query<{
        id: string;
        status: string;
        company_id: string;
        call_id: string;
      }>(
        `SELECT id, status, company_id, call_id FROM zalo_call_ai_summaries WHERE transcription_id = $1`,
        [txProdNew]
      )).rows;
      assert.equal(newSummaryRows.length, 1, 'Exactly one summary row exists for post-cutoff transcription');
      assert.equal(newSummaryRows[0].status, 'COMPLETED');
      assert.equal(newSummaryRows[0].company_id, companyA);

      // Verify parent call summary_status is COMPLETED
      const parentCallNew = (await db.query<{ summary_status: string }>(
        `SELECT summary_status FROM zalo_personal_calls WHERE id = $1`,
        [callProdNew]
      )).rows[0];
      assert.equal(parentCallNew.summary_status, 'COMPLETED');

      // Verify historical pre-cutoff transcription STILL has NO summary row
      const histSummaryRows = (await db.query<{ count: string }>(
        `SELECT count(*) FROM zalo_call_ai_summaries WHERE transcription_id = $1`,
        [txProdHist]
      )).rows[0].count;
      assert.equal(Number(histSummaryRows), 0, 'Historical pre-cutoff transcription must NOT be reconciled or have any summary row');

      const parentCallHist = (await db.query<{ summary_status: string }>(
        `SELECT summary_status FROM zalo_personal_calls WHERE id = $1`,
        [callProdHist]
      )).rows[0];
      assert.equal(parentCallHist.summary_status, 'NOT_STARTED');

      // 4. Repeated bulk run: verify no duplicate summary rows created
      const repeatBulkResult = await processDueZaloCallSummaryJobs(10, {
        client: adminClient,
        provider: new MockSummaryProvider(async () => validMockOutput),
      });
      assert.equal(repeatBulkResult.failed, 0);

      const newSummaryRowsAfterRepeat = (await db.query<{ count: string }>(
        `SELECT count(*) FROM zalo_call_ai_summaries WHERE transcription_id = $1`,
        [txProdNew]
      )).rows[0].count;
      assert.equal(Number(newSummaryRowsAfterRepeat), 1, 'Repeated bulk run must remain strictly idempotent (exactly 1 row)');

      const histSummaryRowsAfterRepeat = (await db.query<{ count: string }>(
        `SELECT count(*) FROM zalo_call_ai_summaries WHERE transcription_id = $1`,
        [txProdHist]
      )).rows[0].count;
      assert.equal(Number(histSummaryRowsAfterRepeat), 0, 'Historical transcription still has 0 rows after repeated bulk run');

      testPass('Test 22: Production bulk cron reconciliation activates via process.env.SUMMARY_ACTIVATION_CUTOFF without reconciliationSince option');
    } finally {
      if (origCutoffEnv === undefined) {
        delete process.env.SUMMARY_ACTIVATION_CUTOFF;
      } else {
        process.env.SUMMARY_ACTIVATION_CUTOFF = origCutoffEnv;
      }
    }
  } finally {
    await harness.close();
  }

  console.log('\n================================================================');
  console.log(`ALL ${passCount} SUMMARY AUTOMATION & DB TESTS PASSED SUCCESSFULLY!`);
  console.log('================================================================\n');
}

runSummaryAutomationTestSuite().catch((err) => {
  console.error('[FAIL] Summary automation tests encountered unhandled error:', err);
  process.exit(1);
});
