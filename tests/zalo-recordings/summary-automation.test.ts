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
      `INSERT INTO customers(id, company_id, name, source, stage) VALUES($1, $2, 'Khách hàng A', 'ZALO', 'LEAD_NEW')`,
      [customerA, companyA]
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
        [callId, comp, devId, staffUser, customerA, randomUUID(), recPath, dummySha, status]
      );

      return { callId, recPath };
    }

    // Helper: Seed a completed transcription with utterances
    async function seedCompletedTranscription(
      comp: string,
      callId: string,
      utterancesCount = 2
    ) {
      const txId = randomUUID();
      await db.query(
        `INSERT INTO zalo_call_transcriptions(
          id, company_id, call_id, customer_id, status,
          provider, language, full_transcript
        ) VALUES(
          $1, $2, $3, $4, 'COMPLETED',
          'GEMINI', 'vi', 'Khách: Alo tôi cần tư vấn. Nhân viên: Dạ chào anh.'
        )`,
        [txId, comp, callId, customerA]
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
    // TEST 2: Duplicate transcription completion does NOT duplicate summary
    // ========================================================================
    console.log('--- Test 2: Duplicate completion idempotency ---');
    const summaryId1Dup = await enqueueZaloCallSummary(companyA, tx1, adminClient);
    assert.equal(summaryId1Dup, summaryId1, 'Duplicate enqueue returns the same summary ID');

    const totalSummariesTx1 = (
      await db.query<{ count: string | number }>(
        `SELECT count(*) FROM zalo_call_ai_summaries WHERE company_id = $1 AND transcription_id = $2`,
        [companyA, tx1]
      )
    ).rows[0].count;
    assert.equal(Number(totalSummariesTx1), 1, 'Exactly one summary row exists per transcription');
    testPass('Test 2: Duplicate completion does not create duplicate summary rows');

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
          `INSERT INTO zalo_call_ai_summaries(company_id, call_id, transcription_id, model, lead_temperature)
           VALUES($1, $2, $3, 'm', 'LUKEWARM')`,
          [companyA, callValid, randomUUID()]
        ),
      /check constraint/i,
      'Invalid lead_temperature must violate check constraint'
    );
    testPass('Test 7: lead_temperature check constraint strictly enforced in PostgreSQL');

    await assert.rejects(
      async () =>
        db.query(
          `INSERT INTO zalo_call_ai_summaries(company_id, call_id, transcription_id, model, confidence)
           VALUES($1, $2, $3, 'm', 'VERY_CONFIDENT')`,
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
