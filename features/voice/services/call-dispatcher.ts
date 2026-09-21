import 'server-only';
import { createAdminClient } from '../../../lib/supabase/admin';
import { ServerAuthError } from '../../../lib/server-auth/errors';
import { resolveVoiceCallProvider } from '../providers/provider-factory';
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
  const callProvider = resolveVoiceCallProvider(provider);

  // ── 1. Load attempt ──────────────────────────────────────────────────────
  const { data: attempt, error: attemptError } = await adminClient
    .from('call_attempts')
    .select('id, company_id, customer_id, contact_cycle_id, attempt_no, result, called_at, call_id')
    .eq('id', attemptId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (attemptError || !attempt) {
    throw new ServerAuthError('Không tìm thấy lịch gọi.', 404, 'RESOURCE_NOT_FOUND');
  }

  if (attempt.result !== 'PENDING') {
    // Idempotent — đã được dispatch rồi (webhook race condition)
    throw new ServerAuthError(
      `Attempt ${attemptId} không còn PENDING (result=${attempt.result}).`,
      409,
      'INTERNAL_ERROR'
    );
  }


  if (attempt.called_at || attempt.call_id) {
    throw new ServerAuthError('Lịch gọi đã được xử lý.', 409, 'INTERNAL_ERROR');
  }

  // Claim before accessing the phone or invoking the provider. Only one worker wins.
  const { data: claim } = await adminClient
    .from('call_attempts')
    .update({ called_at: new Date().toISOString() })
    .eq('id', attemptId)
    .eq('company_id', companyId)
    .eq('result', 'PENDING')
    .is('called_at', null)
    .select('id')
    .maybeSingle();
  if (!claim) throw new ServerAuthError('Lịch gọi đang được xử lý.', 409, 'INTERNAL_ERROR');

  const customerId = attempt.customer_id;

  // ── 2. Resolve raw phone (private schema, server memory only) ───────────
  let rawPhone: string;
  try {
    const { data: phoneData, error: phoneError } = await adminClient.rpc(
      'get_customer_private_contact',
      {
        p_company_id: companyId,
        p_customer_id: customerId,
      }
    );

    if (phoneError || !phoneData || phoneData.length === 0) {
      // Fallback: direct private schema query
      const { data: directData, error: directError } = await adminClient
        .schema('private')
        .from('customer_private_contacts')
        .select('raw_phone')
        .eq('company_id', companyId)
        .eq('customer_id', customerId)
        .maybeSingle();

      if (directError || !directData?.raw_phone) {
        throw new ServerAuthError(
          'Không tìm thấy thông tin liên hệ khách hàng.',
          404,
          'RESOURCE_NOT_FOUND'
        );
      }
      rawPhone = directData.raw_phone as string;
    } else {
      // RPC trả array
      const row = Array.isArray(phoneData) ? phoneData[0] : phoneData;
      rawPhone = (row as { raw_phone: string }).raw_phone;
    }
  } catch (err) {
    await markAttemptResult(attemptId, companyId, 'FAILED');
    if (err instanceof ServerAuthError) throw err;
    // Không leak bất kỳ thông tin nào từ private schema
    throw new ServerAuthError(
      'Lỗi truy xuất thông tin liên hệ.',
      500,
      'INTERNAL_ERROR'
    );
  }

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
    await adminClient.from('call_attempts').update({ called_at: null })
      .eq('id', attemptId).eq('company_id', companyId).eq('result', 'PENDING');
    throw new ServerAuthError('Lỗi khởi tạo hồ sơ cuộc gọi.', 500, 'INTERNAL_ERROR');
  }

  const callId = callRecord.id as string;

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
    await adminClient.from('calls').update({ status: 'FAILED' }).eq('id', callId);
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
    await adminClient.from('calls').update({ status: 'FAILED' }).eq('id', callId);

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
    .eq('id', callId);

  // ── 7. UPDATE call_attempts ───────────────────────────────────────────────
  await adminClient
    .from('call_attempts')
    .update({
      call_id: callId,
    })
    .eq('id', attemptId);

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
