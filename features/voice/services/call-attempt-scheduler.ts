import 'server-only';
import { createAdminClient } from '../../../lib/supabase/admin';
import { ServerAuthError } from '../../../lib/server-auth/errors';

const RETRY_DELAY_ATTEMPT_2_MS = 2.5 * 60 * 60 * 1000;
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;

export function calculateRetryScheduledAt(now: Date, attemptNo: 2 | 3): string {
  if (attemptNo === 2) return new Date(now.getTime() + RETRY_DELAY_ATTEMPT_2_MS).toISOString();
  const vietnamNow = new Date(now.getTime() + VIETNAM_OFFSET_MS);
  return new Date(Date.UTC(
    vietnamNow.getUTCFullYear(), vietnamNow.getUTCMonth(), vietnamNow.getUTCDate() + 1,
    2, 0, 0, 0
  )).toISOString();
}

/** Atomically creates attempt 1, moves stage and appends an AI stage-history row. */
export async function createContactCycleAndFirstAttempt(
  customerId: string,
  companyId: string
): Promise<{ contactCycleId: string; attemptId: string }> {
  const contactCycleId = crypto.randomUUID();
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('start_voice_contact_cycle', {
    p_company_id: companyId,
    p_customer_id: customerId,
    p_contact_cycle_id: contactCycleId,
    p_scheduled_at: new Date().toISOString(),
  });
  if (error || !data) {
    throw new ServerAuthError('Không thể tạo lịch gọi.', 409, 'INTERNAL_ERROR');
  }
  return { contactCycleId, attemptId: data as string };
}

/** Atomically completes an attempt and schedules/stages the next transition when required. */
export async function markAttemptResult(
  attemptId: string,
  companyId: string,
  result: 'NO_ANSWER' | 'BUSY' | 'ANSWERED' | 'FAILED' | 'CANCELLED',
  callId?: string
): Promise<{ nextAttemptId: string | null }> {
  const admin = createAdminClient();
  const { data: attempt, error: readError } = await admin.from('call_attempts')
    .select('attempt_no, result').eq('company_id', companyId).eq('id', attemptId).maybeSingle();
  if (readError || !attempt) {
    throw new ServerAuthError('Không tìm thấy lịch gọi.', 404, 'RESOURCE_NOT_FOUND');
  }
  if (attempt.result !== 'PENDING') return { nextAttemptId: null };

  const nextScheduledAt = result !== 'ANSWERED' && result !== 'CANCELLED' && attempt.attempt_no < 3
    ? calculateRetryScheduledAt(new Date(), (attempt.attempt_no + 1) as 2 | 3)
    : null;
  const { data, error } = await admin.rpc('complete_voice_attempt_transition', {
    p_company_id: companyId,
    p_attempt_id: attemptId,
    p_result: result,
    p_call_id: callId || null,
    p_next_scheduled_at: nextScheduledAt,
  });
  if (error) throw new ServerAuthError('Lỗi ghi kết quả gọi.', 500, 'INTERNAL_ERROR');
  return { nextAttemptId: (data as string | null) || null };
}

export async function cancelPendingAttemptsInCycle(
  customerId: string,
  companyId: string,
  contactCycleId: string
): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin.from('call_attempts')
    .update({ result: 'CANCELLED', called_at: new Date().toISOString() })
    .eq('customer_id', customerId).eq('company_id', companyId)
    .eq('contact_cycle_id', contactCycleId).eq('result', 'PENDING')
    .is('called_at', null).is('call_id', null).select('id');
  if (error) throw new ServerAuthError('Lỗi hủy lịch gọi.', 500, 'INTERNAL_ERROR');
  return data?.length || 0;
}

export interface PendingAttemptRow {
  id: string;
  company_id: string;
  customer_id: string;
  contact_cycle_id: string;
  attempt_no: number;
}

export async function getPendingDueAttempts(limit = 50): Promise<PendingAttemptRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from('call_attempts')
    .select('id, company_id, customer_id, contact_cycle_id, attempt_no')
    .eq('result', 'PENDING').is('called_at', null).is('call_id', null)
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true }).limit(limit);
  if (error) throw new ServerAuthError('Lỗi truy vấn lịch gọi đến hạn.', 500, 'INTERNAL_ERROR');
  return (data || []) as PendingAttemptRow[];
}
