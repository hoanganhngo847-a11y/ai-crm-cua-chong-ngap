'use server';

import { requireBossAdmin } from '../../lib/auth/context';
import { authorizeCustomerAccess } from '../../lib/server-auth/resource-access';
import { resolveBrowserBusinessTest } from '../../features/voice/services/browser-business-test';
import { createAdminClient } from '../../lib/supabase/admin';
import { createClient } from '../../lib/supabase/server';
import { getActorContext } from '../../lib/auth/context';
import { requireActiveMember } from '../../lib/auth/context';
import { ServerAuthError } from '../../lib/server-auth/errors';
import {
  createContactCycleAndFirstAttempt,
  cancelPendingAttemptsInCycle,
} from '../../features/voice/services/call-attempt-scheduler';
import { dispatchAiOutboundCall } from '../../features/voice/services/call-dispatcher';
import { resolveVoiceCallProviderForCompany } from '../../features/voice/providers/provider-factory';
import { executeClickToCall } from '../../lib/sensitive/click-to-call';
import type { ClickToCallParams } from '../../shared/contracts/sensitive';
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

/** Production sale call adapter; keeps Foundation execution unchanged and injects tenant provider config. */
export async function callCustomerViaVoiceAction(
  params: ClickToCallParams
): Promise<{ success: boolean; data?: { callId: string; status: string }; error?: string }> {
  try {
    const { companyId, client } = await resolveCompanyId();
    const actor = await requireActiveMember(companyId, client);
    if (actor.role === 'TECHNICIAN') {
      return { success: false, error: 'Kỹ thuật viên không có quyền gọi khách.' };
    }
    const { customer } = await authorizeCustomerAccess(params.customerId, 'CLICK_TO_CALL', client);
    if (customer.company_id !== companyId) throw new ServerAuthError('Không tìm thấy khách hàng.', 404, 'RESOURCE_NOT_FOUND');
    const provider = await resolveVoiceCallProviderForCompany(companyId);
    const result = await executeClickToCall(params, provider, client);
    return { success: true, data: { callId: result.callId, status: result.status } };
  } catch (err) {
    return {
      success: false,
      error: err instanceof ServerAuthError ? err.message : 'Không thể thực hiện cuộc gọi.',
    };
  }
}

/** Restricted test adapter into the same customer-authorized Sale business flow. No PSTN provider is invoked. */
export async function prepareBrowserBusinessCallAction(params: { customerId: string; requestId: string }): Promise<{
  success: boolean; data?: { callId: string; status: string }; error?: string;
}> {
  try {
    if (!params || !/^[0-9a-f-]{36}$/i.test(params.requestId)) throw new Error('INVALID_REQUEST');
    const { companyId, client } = await resolveCompanyId();
    const actor = await requireBossAdmin(companyId, {}, client);
    const { customer } = await authorizeCustomerAccess(params.customerId, 'CLICK_TO_CALL', client);
    if (customer.company_id !== companyId) throw new Error('CUSTOMER_SCOPE');
    const test = await resolveBrowserBusinessTest(companyId, actor.userId, customer.id);
    const result = await executeClickToCall({ customerId: customer.id }, undefined, client, {
      integrationId: test.integrationId, from: test.A, to: test.B, requestId: params.requestId,
    });
    return { success: true, data: { callId: result.callId, status: result.status } };
  } catch (error) {
    return { success: false, error: error instanceof ServerAuthError ? error.message : 'Không thể tạo cuộc gọi test nghiệp vụ.' };
  }
}

/** Clean up a prepared test call only when the SDK rejected before canonical provider binding. */
export async function cancelPreparedBrowserBusinessCallAction(params: { callId: string }): Promise<void> {
  const { companyId, client } = await resolveCompanyId();
  const actor = await requireBossAdmin(companyId, {}, client);
  const admin = createAdminClient();
  const { data: call } = await admin.from('calls').select('id, customer_id')
    .eq('id', params.callId).eq('company_id', companyId).eq('initiated_by', actor.userId)
    .eq('status', 'INITIATED').eq('provider_call_id', `crm_${params.callId}`).maybeSingle();
  if (!call) return;
  await resolveBrowserBusinessTest(companyId, actor.userId, call.customer_id);
  const { data: session } = await admin.from('voice_browser_call_sessions').select('call_id').eq('call_id', call.id).maybeSingle();
  if (!session) return;
  await admin.rpc('apply_voice_call_status_atomic', {
    p_company_id: companyId, p_provider: 'STRINGEE', p_provider_call_id: `crm_${call.id}`,
    p_new_status: 'FAILED', p_event_idempotency_key: `browser_dispatch_failed_${call.id}`,
  });
}
