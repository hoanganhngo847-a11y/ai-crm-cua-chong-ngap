import 'server-only';
import { createAdminClient } from '../../../lib/supabase/admin';
import { requireActiveMember } from '../../../lib/auth/context';
import { ServerAuthError } from '../../../lib/server-auth/errors';
import { APPLICATION_ROLES } from '../../../shared/constants/roles';
import type {
  CallHistoryItemDTO,
  CallHistoryPageDTO,
  CallAttemptDTO,
  ContactCycleStatusDTO,
  CallHistoryFilters,
  CustomerSearchResultDTO,
  CustomerSearchPageDTO,
} from '../../../shared/contracts/voice';
import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Types nội bộ từ DB
// ---------------------------------------------------------------------------

interface CallRow {
  id: string;
  company_id: string;
  customer_id: string;
  direction: string;
  agent_type: string;
  provider: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  recording_ref: string | null;
  transcript_status: string;
  created_at: string;
}

interface CustomerRow {
  id: string;
  company_id: string;
  customer_code: string;
  name: string;
  stage: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function calcDurationSeconds(startedAt: string, endedAt: string | null): number | null {
  if (!endedAt) return null;
  const diff = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  return Math.round(diff / 1000);
}

function toCallHistoryDTO(
  call: CallRow,
  customer: Pick<CustomerRow, 'name' | 'customer_code'>,
  isBossAdmin: boolean
): CallHistoryItemDTO {
  return {
    id: call.id,
    customerId: call.customer_id,
    customerName: customer.name,
    customerCode: customer.customer_code,
    direction: call.direction as 'INBOUND' | 'OUTBOUND',
    agentType: call.agent_type as 'AI' | 'SALE',
    status: call.status as CallHistoryItemDTO['status'],
    startedAt: call.started_at,
    endedAt: call.ended_at,
    durationSeconds: calcDurationSeconds(call.started_at, call.ended_at),
    // BOSS_ADMIN only — SALE nhận null
    hasRecording: isBossAdmin ? call.recording_ref !== null : null,
    transcriptStatus: isBossAdmin
      ? (call.transcript_status as CallHistoryItemDTO['transcriptStatus'])
      : null,
  };
}

// ---------------------------------------------------------------------------
// Lịch sử cuộc gọi theo khách
// ---------------------------------------------------------------------------

/**
 * SALE xem lịch sử cuộc gọi theo khách.
 *
 * Query interactions (CALL_EVENT) kết hợp calls để lấy metadata.
 * Không trả recording_ref hay transcript_status.
 */
async function getCallHistoryForSale(
  customerId: string,
  companyId: string,
  page: number,
  pageSize: number,
  userClient: SupabaseClient
): Promise<CallHistoryPageDTO> {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  // SALE dùng user client — RLS sẽ filter đúng company
  const { data: calls, error, count } = await userClient
    .from('calls')
    .select('id, customer_id, direction, agent_type, status, started_at, ended_at', {
      count: 'exact',
    })
    .eq('customer_id', customerId)
    .eq('company_id', companyId)
    .order('started_at', { ascending: false })
    .range(from, to);

  if (error) {
    throw new ServerAuthError('Lỗi truy vấn lịch sử cuộc gọi.', 500, 'INTERNAL_ERROR');
  }

  // Lấy thông tin khách (tên + mã) — không có phone
  const { data: customer } = await userClient
    .from('customers')
    .select('name, customer_code')
    .eq('id', customerId)
    .eq('company_id', companyId)
    .maybeSingle();

  const customerInfo = customer || { name: 'Khách hàng', customer_code: '' };

  const items: CallHistoryItemDTO[] = (calls || []).map((call) => ({
    id: call.id,
    customerId: call.customer_id,
    customerName: customerInfo.name,
    customerCode: customerInfo.customer_code,
    direction: call.direction as 'INBOUND' | 'OUTBOUND',
    agentType: call.agent_type as 'AI' | 'SALE',
    status: call.status as CallHistoryItemDTO['status'],
    startedAt: call.started_at,
    endedAt: call.ended_at,
    durationSeconds: calcDurationSeconds(call.started_at, call.ended_at),
    hasRecording: null, // SALE không xem
    transcriptStatus: null, // SALE không xem
  }));

  return { items, total: count || 0, page, pageSize };
}

/**
 * BOSS_ADMIN xem lịch sử cuộc gọi theo khách — đầy đủ kể cả recording_ref flag.
 */
async function getCallHistoryForBossAdmin(
  customerId: string,
  companyId: string,
  page: number,
  pageSize: number
): Promise<CallHistoryPageDTO> {
  const adminClient = createAdminClient();
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data: calls, error, count } = await adminClient
    .from('calls')
    .select(
      'id, customer_id, direction, agent_type, provider, status, started_at, ended_at, recording_ref, transcript_status',
      { count: 'exact' }
    )
    .eq('customer_id', customerId)
    .eq('company_id', companyId)
    .order('started_at', { ascending: false })
    .range(from, to);

  if (error) {
    throw new ServerAuthError('Lỗi truy vấn lịch sử cuộc gọi.', 500, 'INTERNAL_ERROR');
  }

  // Lấy thông tin khách
  const { data: customer } = await adminClient
    .from('customers')
    .select('name, customer_code')
    .eq('id', customerId)
    .eq('company_id', companyId)
    .maybeSingle();

  const customerInfo = customer || { name: 'Khách hàng', customer_code: '' };

  const items = (calls || []).map((call) =>
    toCallHistoryDTO(call as unknown as CallRow, customerInfo, true)
  );

  return { items, total: count || 0, page, pageSize };
}

// ---------------------------------------------------------------------------
// Public: lấy lịch sử theo khách (router theo role)
// ---------------------------------------------------------------------------

/**
 * Trả lịch sử cuộc gọi theo customerId — phân tầng quyền theo role.
 * caller phải đã được xác thực (truyền vào client).
 */
export async function getCallHistoryForCustomer(
  customerId: string,
  companyId: string,
  userClient: SupabaseClient,
  page = 1,
  pageSize = 20
): Promise<CallHistoryPageDTO> {
  const actor = await requireActiveMember(companyId, userClient);

  if (actor.role === APPLICATION_ROLES.BOSS_ADMIN) {
    return getCallHistoryForBossAdmin(customerId, companyId, page, pageSize);
  }

  if (actor.role === APPLICATION_ROLES.SALE) {
    return getCallHistoryForSale(customerId, companyId, page, pageSize, userClient);
  }

  throw new ServerAuthError('Bạn không có quyền xem lịch sử cuộc gọi.', 403, 'ROLE_FORBIDDEN');
}

// ---------------------------------------------------------------------------
// Lịch sử toàn công ty
// ---------------------------------------------------------------------------

/**
 * Lịch sử cuộc gọi toàn công ty với filter — phân tầng quyền.
 */
export async function getCompanyCallHistory(
  companyId: string,
  userClient: SupabaseClient,
  filters: CallHistoryFilters = {}
): Promise<CallHistoryPageDTO> {
  const actor = await requireActiveMember(companyId, userClient);
  const isBossAdmin = actor.role === APPLICATION_ROLES.BOSS_ADMIN;

  if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
    throw new ServerAuthError('Bạn không có quyền xem lịch sử cuộc gọi.', 403, 'ROLE_FORBIDDEN');
  }

  const adminClient = createAdminClient();
  const page = filters.page || 1;
  const pageSize = Math.min(filters.pageSize || 20, 100);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  // Build query — dùng adminClient để lấy recording_ref nếu BOSS_ADMIN
  const fields = isBossAdmin
    ? 'id, customer_id, direction, agent_type, provider, status, started_at, ended_at, recording_ref, transcript_status'
    : 'id, customer_id, direction, agent_type, status, started_at, ended_at';

  let query = adminClient
    .from('calls')
    .select(`${fields}, customers!inner(name, customer_code)`, { count: 'exact' })
    .eq('company_id', companyId)
    .order('started_at', { ascending: false })
    .range(from, to);

  if (filters.customerId) query = query.eq('customer_id', filters.customerId);
  if (filters.agentType) query = query.eq('agent_type', filters.agentType);
  if (filters.direction) query = query.eq('direction', filters.direction);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.dateFrom) query = query.gte('started_at', filters.dateFrom);
  if (filters.dateTo) query = query.lte('started_at', filters.dateTo);

  const { data: rows, error, count } = await query;

  if (error) {
    throw new ServerAuthError('Lỗi truy vấn lịch sử cuộc gọi.', 500, 'INTERNAL_ERROR');
  }

  type RowWithCustomer = CallRow & { customers: { name: string; customer_code: string } };

  const items: CallHistoryItemDTO[] = (rows || []).map((row) => {
    const r = row as unknown as RowWithCustomer;
    return toCallHistoryDTO(r, r.customers, isBossAdmin);
  });

  return { items, total: count || 0, page, pageSize };
}

// ---------------------------------------------------------------------------
// Trạng thái chu kỳ liên hệ
// ---------------------------------------------------------------------------

/**
 * Trả trạng thái chu kỳ gọi hiện tại của khách — safe, không có phone.
 */
export async function getContactCycleStatus(
  customerId: string,
  companyId: string,
  userClient: SupabaseClient
): Promise<ContactCycleStatusDTO> {
  const actor = await requireActiveMember(companyId, userClient);

  if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
    throw new ServerAuthError('Bạn không có quyền xem chu kỳ gọi.', 403, 'ROLE_FORBIDDEN');
  }

  const adminClient = createAdminClient();

  // Lấy stage hiện tại
  const { data: customer } = await adminClient
    .from('customers')
    .select('stage')
    .eq('id', customerId)
    .eq('company_id', companyId)
    .maybeSingle();

  // Lấy cycle gần nhất (contact_cycle_id mới nhất)
  const { data: attempts } = await adminClient
    .from('call_attempts')
    .select('id, contact_cycle_id, attempt_no, scheduled_at, called_at, result, call_id')
    .eq('customer_id', customerId)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(10);

  if (!attempts || attempts.length === 0) {
    return {
      contactCycleId: null,
      currentAttemptNo: null,
      isCycleComplete: false,
      attempts: [],
      customerStage: customer?.stage || 'LEAD_NEW',
    };
  }

  // Nhóm theo cycle gần nhất
  const latestCycleId = (attempts[0] as { contact_cycle_id: string }).contact_cycle_id;
  const cycleAttempts = attempts.filter(
    (a) => (a as { contact_cycle_id: string }).contact_cycle_id === latestCycleId
  );

  const dtos: CallAttemptDTO[] = cycleAttempts.map((a) => ({
    id: a.id as string,
    contactCycleId: (a as { contact_cycle_id: string }).contact_cycle_id,
    attemptNo: a.attempt_no as 1 | 2 | 3,
    scheduledAt: a.scheduled_at as string,
    calledAt: a.called_at as string | null,
    result: a.result as CallAttemptDTO['result'],
    callId: a.call_id as string | null,
  }));

  // Chu kỳ hoàn thành khi không còn PENDING nào
  const hasPending = dtos.some((d) => d.result === 'PENDING');
  const maxAttempt = Math.max(...dtos.map((d) => d.attemptNo));

  return {
    contactCycleId: latestCycleId,
    currentAttemptNo: maxAttempt,
    isCycleComplete: !hasPending,
    attempts: dtos,
    customerStage: customer?.stage || 'LEAD_NEW',
  };
}

// ---------------------------------------------------------------------------
// Tìm kiếm khách để gọi (dùng cho nút GỌI KHÁCH)
// ---------------------------------------------------------------------------

/**
 * Tìm khách theo tên hoặc customer_code.
 * SALE chỉ thấy tên + mã, không thấy phone.
 */
export async function searchCustomersForCall(
  companyId: string,
  query: string,
  userClient: SupabaseClient,
  page = 1,
  pageSize = 10
): Promise<CustomerSearchPageDTO> {
  const actor = await requireActiveMember(companyId, userClient);

  if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
    throw new ServerAuthError('Bạn không có quyền tìm khách để gọi.', 403, 'ROLE_FORBIDDEN');
  }

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  // PostgREST `.or()` has its own filter grammar. Keep user text out of that grammar.
  const safeQuery = query.replace(/[%_(),.\\"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (safeQuery.length < 2) return { items: [], total: 0 };

  // Tìm theo tên hoặc customer_code (ilike = case-insensitive)
  const { data, error, count } = await userClient
    .from('customers')
    .select('id, customer_code, name, stage, source', { count: 'exact' })
    .eq('company_id', companyId)
    .or(`name.ilike.%${safeQuery}%,customer_code.ilike.%${safeQuery}%`)
    .order('name', { ascending: true })
    .range(from, to);

  if (error) {
    throw new ServerAuthError('Lỗi tìm kiếm khách hàng.', 500, 'INTERNAL_ERROR');
  }

  const items: CustomerSearchResultDTO[] = (data || []).map((c) => ({
    id: c.id as string,
    customerCode: c.customer_code as string,
    name: c.name as string,
    stage: c.stage as string,
    source: c.source as string,
  }));

  return { items, total: count || 0 };
}
