'use server';

import { createClient } from '../../lib/supabase/server';
import { getActorContext } from '../../lib/auth/context';
import { requireActiveMember } from '../../lib/auth/context';
import { ServerAuthError } from '../../lib/server-auth/errors';
import {
  createContactCycleAndFirstAttempt,
  cancelPendingAttemptsInCycle,
} from '../../features/voice/services/call-attempt-scheduler';
import { dispatchAiOutboundCall } from '../../features/voice/services/call-dispatcher';
import {
  getCallHistoryForCustomer,
  getCompanyCallHistory,
  getContactCycleStatus,
  searchCustomersForCall,
} from '../../features/voice/services/call-history';
import type {
  ScheduleCallCycleParams,
  CallHistoryFilters,
  CancelCallCycleParams,
  CustomerSearchParams,
  CallHistoryPageDTO,
  ContactCycleStatusDTO,
  CustomerSearchPageDTO,
} from '../../shared/contracts/voice';

// ==============================================================================
// EXPORTED 'use server' ACTIONS — Browser boundary
// Serializable business identifiers only. NO phone, NO company_id from client.
// ==============================================================================

/**
 * Lấy companyId từ session server-side — không bao giờ trust client.
 */
async function resolveCompanyId(): Promise<{ companyId: string; client: Awaited<ReturnType<typeof createClient>> }> {
  const client = await createClient();
  const actor = await getActorContext(undefined, client);

  if (!actor || actor.profileStatus !== 'ACTIVE') {
    throw new ServerAuthError('Phiên làm việc không hợp lệ. Vui lòng đăng nhập lại.', 401, 'UNAUTHENTICATED');
  }

  if (!actor.companyId || actor.membershipStatus !== 'ACTIVE') {
    throw new ServerAuthError('Bạn chưa có tư cách thành viên hoạt động.', 403, 'MEMBERSHIP_INACTIVE');
  }

  return { companyId: actor.companyId, client };
}

/**
 * Bắt đầu chu kỳ gọi outbound 3 lần cho khách.
 *
 * Quy tắc:
 * - Chỉ BOSS_ADMIN và SALE được gọi.
 * - Dispatch ngay attempt 1.
 * - KHÔNG tạo cycle cho cuộc gọi Hotline inbound.
 */
export async function scheduleOutboundCallCycleAction(
  params: ScheduleCallCycleParams
): Promise<{ success: boolean; cycleId?: string; callId?: string; error?: string }> {
  try {
    const { companyId, client } = await resolveCompanyId();
    const actor = await requireActiveMember(companyId, client);

    if (actor.role === 'TECHNICIAN') {
      return { success: false, error: 'Kỹ thuật viên không có quyền tạo lịch gọi khách.' };
    }

    const { contactCycleId, attemptId } = await createContactCycleAndFirstAttempt(
      params.customerId,
      companyId
    );

    // Dispatch ngay attempt 1
    const { callId } = await dispatchAiOutboundCall(attemptId, companyId);

    return { success: true, cycleId: contactCycleId, callId };
  } catch (err) {
    const error = err as Error;
    return {
      success: false,
      error: error instanceof ServerAuthError ? error.message : 'Không thể tạo lịch gọi.',
    };
  }
}

/**
 * Lấy lịch sử cuộc gọi theo khách.
 *
 * BOSS_ADMIN: đầy đủ kể cả hasRecording.
 * SALE: không có recording/transcript info.
 */
export async function getCallHistoryAction(params: {
  customerId: string;
  page?: number;
  pageSize?: number;
}): Promise<{ success: boolean; data?: CallHistoryPageDTO; error?: string }> {
  try {
    const { companyId, client } = await resolveCompanyId();

    const data = await getCallHistoryForCustomer(
      params.customerId,
      companyId,
      client,
      params.page || 1,
      params.pageSize || 20
    );

    return { success: true, data };
  } catch (err) {
    const error = err as Error;
    return {
      success: false,
      error: error instanceof ServerAuthError ? error.message : 'Không thể tải lịch sử cuộc gọi.',
    };
  }
}

/**
 * Lấy lịch sử cuộc gọi toàn công ty với filter.
 */
export async function getCompanyCallHistoryAction(
  filters: CallHistoryFilters = {}
): Promise<{ success: boolean; data?: CallHistoryPageDTO; error?: string }> {
  try {
    const { companyId, client } = await resolveCompanyId();

    const data = await getCompanyCallHistory(companyId, client, filters);
    return { success: true, data };
  } catch (err) {
    const error = err as Error;
    return {
      success: false,
      error: error instanceof ServerAuthError ? error.message : 'Không thể tải lịch sử cuộc gọi.',
    };
  }
}

/**
 * Trạng thái chu kỳ gọi hiện tại của một khách.
 */
export async function getContactCycleStatusAction(params: {
  customerId: string;
}): Promise<{ success: boolean; data?: ContactCycleStatusDTO; error?: string }> {
  try {
    const { companyId, client } = await resolveCompanyId();

    const data = await getContactCycleStatus(params.customerId, companyId, client);
    return { success: true, data };
  } catch (err) {
    const error = err as Error;
    return {
      success: false,
      error: error instanceof ServerAuthError ? error.message : 'Không thể tải trạng thái chu kỳ gọi.',
    };
  }
}

/**
 * Hủy các attempt đang chờ trong một chu kỳ.
 */
export async function cancelCallCycleAction(
  params: CancelCallCycleParams
): Promise<{ success: boolean; cancelledCount?: number; error?: string }> {
  try {
    const { companyId, client } = await resolveCompanyId();
    const actor = await requireActiveMember(companyId, client);

    if (actor.role === 'TECHNICIAN') {
      return { success: false, error: 'Kỹ thuật viên không có quyền hủy lịch gọi.' };
    }

    const count = await cancelPendingAttemptsInCycle(
      params.customerId,
      companyId,
      params.contactCycleId
    );

    return { success: true, cancelledCount: count };
  } catch (err) {
    const error = err as Error;
    return {
      success: false,
      error: error instanceof ServerAuthError ? error.message : 'Không thể hủy lịch gọi.',
    };
  }
}

/**
 * Tìm kiếm khách theo tên hoặc mã KH để gọi.
 * Kết quả không bao gồm số điện thoại.
 */
export async function searchCustomersForCallAction(
  params: CustomerSearchParams
): Promise<{ success: boolean; data?: CustomerSearchPageDTO; error?: string }> {
  try {
    const { companyId, client } = await resolveCompanyId();
    const actor = await requireActiveMember(companyId, client);

    if (actor.role === 'TECHNICIAN') {
      return { success: false, error: 'Kỹ thuật viên không có quyền tìm khách để gọi.' };
    }

    if (!params.query || params.query.trim().length < 2) {
      return { success: false, error: 'Nhập ít nhất 2 ký tự để tìm kiếm.' };
    }

    const data = await searchCustomersForCall(
      companyId,
      params.query.trim(),
      client,
      params.page || 1,
      params.pageSize || 10
    );

    return { success: true, data };
  } catch (err) {
    const error = err as Error;
    return {
      success: false,
      error: error instanceof ServerAuthError ? error.message : 'Không thể tìm kiếm khách hàng.',
    };
  }
}
