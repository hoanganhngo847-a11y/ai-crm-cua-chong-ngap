import 'server-only';
import { createAdminClient } from '../../../lib/supabase/admin';
import { ServerAuthError } from '../../../lib/server-auth/errors';
import { resolveVoiceCallProviderForCompany } from '../providers/provider-factory';
import type { CallProvider } from '../../../shared/contracts/sensitive';

// ---------------------------------------------------------------------------
// Types nội bộ
// ---------------------------------------------------------------------------

/** Kết quả dispatch — safe, không có phone */
export interface DispatchResult {
  callId: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Core dispatcher with atomic state machine
// ---------------------------------------------------------------------------

/**
 * Dispatch một cuộc gọi AI outbound cho một attempt cụ thể với state machine bền vững.
 *
 * State machine:
 * PENDING_DISPATCH -> DISPATCHING -> PROVIDER_ACCEPTED -> ACTIVE -> COMPLETED / FAILED
 *                                 \-> RECONCILIATION_REQUIRED
 *
 * INVARIANTS:
 * 1. Durable dispatch command / idempotency record được tạo trước khi gọi tổng đài.
 * 2. Nếu tổng đài đã accept nhưng DB finalize lỗi: lưu trạng thái RECONCILIATION_REQUIRED.
 * 3. Khi retry logical dispatch: không được gọi tổng đài lần thứ 2 nếu tổng đài trước đó đã accept.
 * 4. Giao dịch finalize được thực thi atomically bằng DB RPC: bind provider_call_id,
 *    update calls, update call_attempts, persist interaction, transition command to ACTIVE.
 * 5. raw phone KHÔNG bao giờ log hay trả ra ngoài hàm này.
 *
 * @param attemptId      ID của call attempt cần dispatch
 * @param companyId      ID của công ty sở hữu
 * @param provider       Provider override (cho tests/stubs)
 * @param idempotencyKey Key chống trùng lặp logic
 */
export async function dispatchAiOutboundCall(
  attemptId: string,
  companyId: string,
  provider?: CallProvider,
  idempotencyKey?: string
): Promise<DispatchResult> {
  const adminClient = createAdminClient();
  const callProvider = await resolveVoiceCallProviderForCompany(companyId, provider);

  const providerDbValue = (['MANUAL', 'STRINGEE', 'VIETTEL', 'TWILIO', 'VINFON'] as const).includes(
    callProvider.name as 'MANUAL' | 'STRINGEE' | 'VIETTEL' | 'TWILIO' | 'VINFON'
  )
    ? callProvider.name
    : 'MANUAL';

  const dispatchKey = idempotencyKey || `dispatch_${companyId}_${attemptId}`;

  // ── 1. PREPARE ATOMIC DISPATCH ───────────────────────────────────────────
  const { data: prepData, error: prepError } = await adminClient.rpc('prepare_voice_dispatch_atomic', {
    p_company_id: companyId,
    p_attempt_id: attemptId,
    p_idempotency_key: dispatchKey,
    p_provider: providerDbValue,
  });

  if (prepError || !prepData) {
    const msg = prepError?.message || '';
    if (msg.includes('VOICE_DISPATCH_IN_PROGRESS')) {
      throw new ServerAuthError('Cuộc gọi đang được xử lý bởi tiến trình khác.', 409, 'INTERNAL_ERROR');
    }
    throw new ServerAuthError('Lịch gọi không hợp lệ hoặc không có liên hệ.', 409, 'INTERNAL_ERROR');
  }

  const prepRow = (Array.isArray(prepData) ? prepData[0] : prepData) as {
    call_id: string;
    customer_id: string;
    raw_phone: string | null;
    provider_call_id: string | null;
    dispatch_status: string;
    is_reconciliation: boolean;
  } | null;

  if (!prepRow) {
    throw new ServerAuthError('Lỗi khởi tạo hồ sơ cuộc gọi.', 500, 'INTERNAL_ERROR');
  }

  const callId = prepRow.call_id;
  const customerId = prepRow.customer_id;

  // ── 2. RECONCILIATION PATH ───────────────────────────────────────────────
  // Nếu cuộc gọi trước đó đã được tổng đài chấp nhận (hoặc cần đối soát),
  // KHÔNG gọi lại tổng đài! Tiến hành hoàn tất liên kết DB.
  if (prepRow.is_reconciliation && prepRow.provider_call_id) {
    const { error: finError } = await adminClient.rpc('finalize_voice_dispatch_atomic', {
      p_company_id: companyId,
      p_attempt_id: attemptId,
      p_call_id: callId,
      p_provider_call_id: prepRow.provider_call_id,
    });

    if (finError) {
      await adminClient.rpc('mark_voice_dispatch_reconciliation_required_atomic', {
        p_company_id: companyId,
        p_attempt_id: attemptId,
        p_call_id: callId,
        p_error: finError.message,
      });
      throw new ServerAuthError(
        'Lỗi hoàn tất liên kết cuộc gọi sau xác nhận từ tổng đài.',
        500,
        'INTERNAL_ERROR'
      );
    }

    return {
      callId,
      status: 'CALLING',
    };
  }

  const rawPhone = prepRow.raw_phone;
  if (!rawPhone) {
    throw new ServerAuthError('Không tìm thấy số điện thoại liên hệ.', 409, 'INTERNAL_ERROR');
  }

  // ── 3. GỌI PROVIDER ──────────────────────────────────────────────────────
  let providerResult: { providerCallId: string; status: string };

  try {
    providerResult = await callProvider.initiateCall({
      fromStaffUserId: 'AI_WORKER',
      targetRawPhone: rawPhone,
      customerId,
      companyId,
    });
  } catch {
    // SECURITY: Không bao giờ leak chi tiết provider error ra ngoài
    await adminClient.rpc('fail_voice_dispatch_atomic', {
      p_company_id: companyId,
      p_attempt_id: attemptId,
      p_call_id: callId,
      p_error: 'CALL_PROVIDER_FAILURE',
    });

    throw new ServerAuthError(
      'Không thể thực hiện cuộc gọi qua tổng đài.',
      502,
      'CALL_PROVIDER_FAILURE'
    );
  }

  // ── 4. RECORD PROVIDER ACCEPTED ATOMICALLY ──────────────────────────────
  // Đảm bảo provider_call_id được persist bền vững trước khi finalize
  await adminClient.rpc('record_voice_provider_accepted_atomic', {
    p_company_id: companyId,
    p_attempt_id: attemptId,
    p_call_id: callId,
    p_provider_call_id: providerResult.providerCallId,
  });

  // ── 5. FINALIZE DISPATCH ATOMICALLY ─────────────────────────────────────
  const { error: finError } = await adminClient.rpc('finalize_voice_dispatch_atomic', {
    p_company_id: companyId,
    p_attempt_id: attemptId,
    p_call_id: callId,
    p_provider_call_id: providerResult.providerCallId,
  });

  if (finError) {
    // Provider đã tạo cuộc gọi thật nhưng DB finalize thất bại:
    // Đánh dấu RECONCILIATION_REQUIRED để retry không gọi lại khách
    await adminClient.rpc('mark_voice_dispatch_reconciliation_required_atomic', {
      p_company_id: companyId,
      p_attempt_id: attemptId,
      p_call_id: callId,
      p_error: finError.message,
    });

    throw new ServerAuthError(
      'Lỗi ghi nhận hoàn tất cuộc gọi sau xác nhận từ tổng đài.',
      500,
      'INTERNAL_ERROR'
    );
  }

  return {
    callId,
    status: 'CALLING',
  };
}
