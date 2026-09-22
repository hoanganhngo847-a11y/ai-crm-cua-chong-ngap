import 'server-only';
import { createAdminClient } from '../../../lib/supabase/admin';
import { ServerAuthError } from '../../../lib/server-auth/errors';
import { resolveVoiceCallProviderForCompany } from '../providers/provider-factory';
import type { CallProvider } from '../../../shared/contracts/sensitive';
import { markAttemptResult } from './call-attempt-scheduler';

// ---------------------------------------------------------------------------
// Types nội bộ
// ---------------------------------------------------------------------------

/** Kết quả dispatch — safe, không có phone */
export interface DispatchResult {
  callId: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Core dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch một cuộc gọi AI outbound cho một attempt cụ thể.
 *
 * Luồng bắt buộc (theo Foundation HANDOFF §3):
 * 1. Load attempt → xác nhận còn PENDING
 * 2. Resolve raw phone qua private RPC (chỉ trong bộ nhớ server)
 * 3. INSERT calls (INITIATED) — durable record trước khi gọi provider
 * 4. INSERT audit_logs (INITIATE_AI_OUTBOUND_CALL) — FAIL CLOSED nếu lỗi
 * 5. Gọi AI provider → nhận providerCallId
 * 6. UPDATE calls (RINGING, provider_call_id)
 * 7. UPDATE call_attempts (called_at, call_id)
 * 8. INSERT interactions (CALL_EVENT, NOT_REQUIRED, AI)
 * 9. Return { callId, status } — KHÔNG trả phone hay providerCallId
 *
 * SECURITY:
 * - raw phone KHÔNG bao giờ ra khỏi hàm này.
 * - Provider errors bị bắt và normalize thành generic error.
 * - Audit fail → FAIL CLOSED (call marked FAILED, throw).
 *
 * @param provider  Provider inject — dùng trong tests. Production: auto-resolved.
 */
export async function dispatchAiOutboundCall(
  attemptId: string,
  companyId: string,
  provider?: CallProvider
): Promise<DispatchResult> {
  const adminClient = createAdminClient();
  const callProvider = await resolveVoiceCallProviderForCompany(companyId, provider);

  // A single bounded RPC validates tenant+attempt, reads only that phone and claims the attempt.
  const { data: claimData, error: claimError } = await adminClient.rpc('claim_voice_attempt_phone', {
    p_company_id: companyId,
    p_attempt_id: attemptId,
  });
  const attempt = (Array.isArray(claimData) ? claimData[0] : claimData) as {
    customer_id: string;
    contact_cycle_id: string;
    attempt_no: number;
    raw_phone: string;
  } | null;
  if (claimError || !attempt?.raw_phone) {
    throw new ServerAuthError('Lịch gọi không hợp lệ hoặc không có liên hệ.', 409, 'INTERNAL_ERROR');
  }
  const customerId = attempt.customer_id;
  const rawPhone = attempt.raw_phone;

  // ── 3. INSERT calls (INITIATED) — durable record trước khi gọi ──────────
  const providerDbValue = (['MANUAL', 'STRINGEE', 'VIETTEL', 'TWILIO', 'VINFON'] as const).includes(
    callProvider.name as 'MANUAL' | 'STRINGEE' | 'VIETTEL' | 'TWILIO' | 'VINFON'
  )
    ? callProvider.name
    : 'MANUAL';

  const { data: callRecord, error: callError } = await adminClient
    .from('calls')
    .insert({
      company_id: companyId,
      customer_id: customerId,
      direction: 'OUTBOUND',
      agent_type: 'AI',
      provider: providerDbValue,
      started_at: new Date().toISOString(),
      status: 'INITIATED',
      transcript_status: 'PENDING',
    })
    .select('id')
    .single();

  if (callError || !callRecord) {
    await adminClient.rpc('release_voice_attempt_claim', {
      p_company_id: companyId, p_attempt_id: attemptId,
    });
    throw new ServerAuthError('Lỗi khởi tạo hồ sơ cuộc gọi.', 500, 'INTERNAL_ERROR');
  }

  const callId = callRecord.id as string;

  const { error: bindError } = await adminClient.rpc('bind_voice_attempt_call', {
    p_company_id: companyId, p_attempt_id: attemptId, p_call_id: callId,
  });
  if (bindError) {
    await adminClient.from('calls').update({ status: 'FAILED' })
      .eq('id', callId).eq('company_id', companyId);
    await adminClient.rpc('release_voice_attempt_claim', {
      p_company_id: companyId, p_attempt_id: attemptId,
    });
    throw new ServerAuthError('Lỗi liên kết lịch gọi.', 500, 'INTERNAL_ERROR');
  }

  // ── 4. MANDATORY AUDIT — FAIL CLOSED ────────────────────────────────────
  const { error: auditError } = await adminClient.from('audit_logs').insert({
    company_id: companyId,
    user_id: null, // AI Worker — không phải human actor
    action: 'INITIATE_AI_OUTBOUND_CALL',
    resource_type: 'CALL',
    resource_id: callId,
    customer_id: customerId,
    result: 'SUCCESS',
    metadata: {
      call_id: callId,
      attempt_id: attemptId,
      attempt_no: attempt.attempt_no,
      contact_cycle_id: attempt.contact_cycle_id,
      // SECURITY: KHÔNG log raw_phone, normalized_phone
    },
  });

  if (auditError) {
    // FAIL CLOSED — đánh dấu call FAILED và không gọi provider
    await adminClient.from('calls').update({ status: 'FAILED' })
      .eq('id', callId).eq('company_id', companyId);
    await markAttemptResult(attemptId, companyId, 'FAILED', callId);
    throw new ServerAuthError(
      'Lỗi ghi nhận kiểm toán bắt buộc. Cuộc gọi bị từ chối.',
      500,
      'AUDIT_WRITE_FAILED'
    );
  }

  // ── 5. Gọi AI provider ───────────────────────────────────────────────────
  let providerResult: { providerCallId: string; status: string };

  try {
    providerResult = await callProvider.initiateCall({
      fromStaffUserId: 'AI_WORKER',
      targetRawPhone: rawPhone,
      customerId,
      companyId,
    });
  } catch {
    // CRITICAL SECURITY: KHÔNG bao giờ log hoặc expose _err.message
    // (có thể chứa raw phone hoặc provider credentials)
    await adminClient.from('calls').update({ status: 'FAILED' })
      .eq('id', callId).eq('company_id', companyId);

    await markAttemptResult(attemptId, companyId, 'FAILED', callId);

    throw new ServerAuthError(
      'Không thể thực hiện cuộc gọi qua tổng đài.',
      502,
      'CALL_PROVIDER_FAILURE'
    );
  }

  // ── 6. UPDATE calls (RINGING) ────────────────────────────────────────────
  await adminClient
    .from('calls')
    .update({
      provider_call_id: providerResult.providerCallId,
      status: 'RINGING',
    })
    .eq('id', callId).eq('company_id', companyId);

  // ── 8. INSERT interactions (CALL_EVENT, non-textual system event) ─────────
  await adminClient.from('interactions').insert({
    company_id: companyId,
    customer_id: customerId,
    conversation_id: null,
    channel: 'AI_VOICE',
    type: 'CALL_EVENT',
    direction: 'OUTBOUND',
    sanitized_content: null,
    sanitization_status: 'NOT_REQUIRED',
    actor_type: 'AI',
    actor_user_id: null,
  });

  // ── 9. Return safe result — KHÔNG trả phone hay providerCallId ────────────
  return {
    callId,
    status: 'CALLING',
  };
}
