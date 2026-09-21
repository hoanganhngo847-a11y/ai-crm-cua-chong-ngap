import 'server-only';
import { createAdminClient } from '../../../lib/supabase/admin';
import { ServerAuthError } from '../../../lib/server-auth/errors';

// ---------------------------------------------------------------------------
// Types nội bộ
// ---------------------------------------------------------------------------

/** Delay tính bằng milliseconds cho lần gọi 2 (2.5 giờ) */
const RETRY_DELAY_ATTEMPT_2_MS = 2.5 * 60 * 60 * 1000;
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Deterministic schedule independent of the server's local timezone. */
export function calculateRetryScheduledAt(now: Date, attemptNo: 2 | 3): string {
  if (attemptNo === 2) return new Date(now.getTime() + RETRY_DELAY_ATTEMPT_2_MS).toISOString();
  const vietnamNow = new Date(now.getTime() + VIETNAM_OFFSET_MS);
  return new Date(Date.UTC(
    vietnamNow.getUTCFullYear(),
    vietnamNow.getUTCMonth(),
    vietnamNow.getUTCDate() + 1,
    2, 0, 0, 0
  )).toISOString();
}

/**
 * Stage customers tương ứng với từng attempt.
 * Frozen theo DATA_CONTRACT §10 và customers.stage CHECK constraint.
 */
const ATTEMPT_STAGE_MAP: Record<1 | 2 | 3, string> = {
  1: 'CONTACT_CYCLE_1',
  2: 'CONTACT_CYCLE_2',
  3: 'CONTACT_CYCLE_3',
};

// ---------------------------------------------------------------------------
// Tạo chu kỳ gọi mới (attempt 1)
// ---------------------------------------------------------------------------

/**
 * Tạo một chu kỳ liên hệ mới và lên lịch attempt đầu tiên ngay lập tức.
 *
 * Quy tắc (PROJECT_MASTER §4):
 * - Mỗi chu kỳ có contact_cycle_id UUID riêng.
 * - Attempt 1 được lên lịch ngay (scheduled_at = now()).
 * - Unique constraint uq_call_attempts_cycle_attempt bảo vệ trùng attempt_no.
 * - Cập nhật customers.stage = 'CONTACT_CYCLE_1' + ghi customer_stage_histories.
 * - Chỉ dùng cho khách để số từ kênh khác (KHÔNG phải inbound Hotline).
 *
 * @returns contactCycleId và attemptId để dispatcher dùng ngay.
 */
export async function createContactCycleAndFirstAttempt(
  customerId: string,
  companyId: string
): Promise<{ contactCycleId: string; attemptId: string }> {
  const adminClient = createAdminClient();

  // Lấy stage hiện tại trước khi update
  const { data: customer, error: customerError } = await adminClient
    .from('customers')
    .select('id, stage')
    .eq('id', customerId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (customerError || !customer) {
    throw new ServerAuthError(
      'Không tìm thấy khách hàng để tạo chu kỳ gọi.',
      404,
      'RESOURCE_NOT_FOUND'
    );
  }

  const contactCycleId = crypto.randomUUID();
  const scheduledAt = new Date().toISOString();

  // Insert attempt 1
  const { data: attempt, error: attemptError } = await adminClient
    .from('call_attempts')
    .insert({
      company_id: companyId,
      customer_id: customerId,
      contact_cycle_id: contactCycleId,
      attempt_no: 1,
      scheduled_at: scheduledAt,
      result: 'PENDING',
    })
    .select('id')
    .single();

  if (attemptError || !attempt) {
    // Có thể là lỗi unique constraint nếu chu kỳ này đã tồn tại
    throw new ServerAuthError(
      `Không thể tạo lịch gọi: ${attemptError?.message || 'Lỗi không xác định'}`,
      409,
      'INTERNAL_ERROR'
    );
  }

  // Cập nhật stage khách
  const fromStage = customer.stage;
  const toStage = ATTEMPT_STAGE_MAP[1];

  const { error: stageError } = await adminClient
    .from('customers')
    .update({ stage: toStage, updated_at: new Date().toISOString() })
    .eq('id', customerId)
    .eq('company_id', companyId);

  if (stageError) {
    console.error('[call-attempt-scheduler] Lỗi cập nhật stage khách:', stageError.message);
    // Không throw — attempt đã được tạo, tiếp tục
  }

  // Ghi customer_stage_histories
  await adminClient.from('customer_stage_histories').insert({
    company_id: companyId,
    customer_id: customerId,
    from_stage: fromStage,
    to_stage: toStage,
    reason: `CONTACT_CYCLE_STARTED:${contactCycleId}`,
  });

  return { contactCycleId, attemptId: attempt.id };
}

// ---------------------------------------------------------------------------
// Lên lịch attempt tiếp theo (2 hoặc 3)
// ---------------------------------------------------------------------------

/**
 * Tạo attempt tiếp theo sau khi attempt trước không nghe máy.
 *
 * Thời điểm gọi:
 * - Attempt 2: +2.5 giờ kể từ now()
 * - Attempt 3: ngày hôm sau lúc 09:00 (Asia/Ho_Chi_Minh)
 *
 * @param attemptNo  Số thứ tự của attempt MỚI sắp tạo (2 hoặc 3).
 */
export async function scheduleRetryAttempt(
  customerId: string,
  companyId: string,
  contactCycleId: string,
  attemptNo: 2 | 3
): Promise<{ attemptId: string }> {
  const adminClient = createAdminClient();

  const scheduledAt = calculateRetryScheduledAt(new Date(), attemptNo);

  const { data: attempt, error } = await adminClient
    .from('call_attempts')
    .insert({
      company_id: companyId,
      customer_id: customerId,
      contact_cycle_id: contactCycleId,
      attempt_no: attemptNo,
      scheduled_at: scheduledAt,
      result: 'PENDING',
    })
    .select('id')
    .single();

  if (error || !attempt) {
    throw new ServerAuthError(
      `Không thể tạo lịch gọi lại (attempt ${attemptNo}): ${error?.message || 'Lỗi không xác định'}`,
      409,
      'INTERNAL_ERROR'
    );
  }

  // Cập nhật stage khách theo attempt
  const toStage = ATTEMPT_STAGE_MAP[attemptNo];
  await adminClient
    .from('customers')
    .update({ stage: toStage, updated_at: new Date().toISOString() })
    .eq('id', customerId)
    .eq('company_id', companyId);

  return { attemptId: attempt.id };
}

// ---------------------------------------------------------------------------
// Ghi kết quả attempt
// ---------------------------------------------------------------------------

/**
 * Cập nhật kết quả của một lần thử gọi.
 *
 * Sau khi ghi kết quả:
 * - Nếu result ≠ ANSWERED và attempt_no = 3 → markCustomerUnreachable.
 * - Nếu result = NO_ANSWER | BUSY và attempt_no < 3 → scheduleRetryAttempt.
 * - Nếu result = ANSWERED → dừng chu kỳ (không tạo attempt tiếp).
 *
 * @returns nextAttemptId nếu đã lên lịch attempt tiếp theo, null nếu không.
 */
export async function markAttemptResult(
  attemptId: string,
  companyId: string,
  result: 'NO_ANSWER' | 'BUSY' | 'ANSWERED' | 'FAILED' | 'CANCELLED',
  callId?: string
): Promise<{ nextAttemptId: string | null }> {
  const adminClient = createAdminClient();

  // Load attempt để lấy attempt_no, contact_cycle_id, customer_id
  const { data: attempt, error: loadError } = await adminClient
    .from('call_attempts')
    .select('id, attempt_no, contact_cycle_id, customer_id, company_id, result')
    .eq('id', attemptId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (loadError || !attempt) {
    throw new ServerAuthError('Không tìm thấy lịch gọi.', 404, 'RESOURCE_NOT_FOUND');
  }

  if (attempt.result !== 'PENDING') {
    // Idempotent — đã được xử lý rồi
    return { nextAttemptId: null };
  }

  // Ghi kết quả
  const { data: updatedRows, error: updateError } = await adminClient
    .from('call_attempts')
    .update({
      result,
      called_at: new Date().toISOString(),
      ...(callId ? { call_id: callId } : {}),
    })
    .eq('id', attemptId)
    .eq('company_id', companyId)
    .eq('result', 'PENDING') // Optimistic lock — chỉ update nếu vẫn PENDING
    .select('id');

  if (updateError) {
    throw new ServerAuthError(
      `Lỗi ghi kết quả gọi: ${updateError.message}`,
      500,
      'INTERNAL_ERROR'
    );
  }

  if (!updatedRows || updatedRows.length === 0) {
    return { nextAttemptId: null };
  }

  const attemptNo = attempt.attempt_no as 1 | 2 | 3;

  // ANSWERED → kết thúc chu kỳ
  if (result === 'ANSWERED') {
    return { nextAttemptId: null };
  }

  // CANCELLED → không gọi tiếp
  if (result === 'CANCELLED') {
    return { nextAttemptId: null };
  }

  // NO_ANSWER / BUSY / FAILED — kiểm tra còn attempt không
  if (attemptNo < 3) {
    const nextAttemptNo = (attemptNo + 1) as 2 | 3;
    const { attemptId: nextAttemptId } = await scheduleRetryAttempt(
      attempt.customer_id,
      attempt.company_id,
      attempt.contact_cycle_id,
      nextAttemptNo
    );
    return { nextAttemptId };
  }

  // Attempt 3 thất bại → UNREACHABLE
  await markCustomerUnreachable(attempt.customer_id, attempt.company_id, attempt.contact_cycle_id);
  return { nextAttemptId: null };
}

// ---------------------------------------------------------------------------
// Đánh dấu khách không liên lạc được
// ---------------------------------------------------------------------------

/**
 * Đặt customers.stage = 'UNREACHABLE' và ghi lịch sử.
 *
 * PROJECT_MASTER §4: Không xóa khách sau 3 lần gọi không thành công.
 * Hồ sơ vẫn được giữ để chăm sóc sau này.
 */
export async function markCustomerUnreachable(
  customerId: string,
  companyId: string,
  contactCycleId: string
): Promise<void> {
  const adminClient = createAdminClient();

  // Lấy stage hiện tại
  const { data: customer } = await adminClient
    .from('customers')
    .select('stage')
    .eq('id', customerId)
    .eq('company_id', companyId)
    .maybeSingle();

  const fromStage = customer?.stage || 'CONTACT_CYCLE_3';

  // Cập nhật stage
  await adminClient
    .from('customers')
    .update({ stage: 'UNREACHABLE', updated_at: new Date().toISOString() })
    .eq('id', customerId)
    .eq('company_id', companyId);

  // Ghi lịch sử stage
  await adminClient.from('customer_stage_histories').insert({
    company_id: companyId,
    customer_id: customerId,
    from_stage: fromStage,
    to_stage: 'UNREACHABLE',
    reason: `NO_ANSWER_3_ATTEMPTS:${contactCycleId}`,
  });

  console.log(
    `[call-attempt-scheduler] Customer ${customerId} marked UNREACHABLE ` +
      `after 3 failed attempts in cycle ${contactCycleId}`
  );
}

// ---------------------------------------------------------------------------
// Hủy các attempt đang chờ trong một chu kỳ
// ---------------------------------------------------------------------------

/**
 * Hủy tất cả attempt còn PENDING trong chu kỳ.
 * Dùng khi khách đã được liên lạc qua kênh khác.
 */
export async function cancelPendingAttemptsInCycle(
  customerId: string,
  companyId: string,
  contactCycleId: string
): Promise<number> {
  const adminClient = createAdminClient();

  const { data, error } = await adminClient
    .from('call_attempts')
    .update({ result: 'CANCELLED', called_at: new Date().toISOString() })
    .eq('customer_id', customerId)
    .eq('company_id', companyId)
    .eq('contact_cycle_id', contactCycleId)
    .eq('result', 'PENDING')
    .is('called_at', null)
    .is('call_id', null)
    .select('id');

  if (error) {
    throw new ServerAuthError(
      `Lỗi hủy lịch gọi: ${error.message}`,
      500,
      'INTERNAL_ERROR'
    );
  }

  return data?.length || 0;
}

// ---------------------------------------------------------------------------
// Lấy danh sách attempt đến hạn (dùng bởi cron job)
// ---------------------------------------------------------------------------

export interface PendingAttemptRow {
  id: string;
  company_id: string;
  customer_id: string;
  contact_cycle_id: string;
  attempt_no: number;
}

/**
 * Trả về các attempt đến hạn cần gọi.
 * Index idx_call_attempts_scheduler (company_id, result, scheduled_at) WHERE result='PENDING'
 * đã tối ưu query này.
 */
export async function getPendingDueAttempts(limit = 50): Promise<PendingAttemptRow[]> {
  const adminClient = createAdminClient();

  const { data, error } = await adminClient
    .from('call_attempts')
    .select('id, company_id, customer_id, contact_cycle_id, attempt_no')
    .eq('result', 'PENDING')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw new ServerAuthError(
      `Lỗi truy vấn lịch gọi đến hạn: ${error.message}`,
      500,
      'INTERNAL_ERROR'
    );
  }

  return (data || []) as PendingAttemptRow[];
}
