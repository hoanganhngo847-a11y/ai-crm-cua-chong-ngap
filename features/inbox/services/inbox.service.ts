import * as crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../../lib/supabase/admin';
import type {
  Conversation,
  ConversationFilter,
  CustomerTimelineEvent,
  InboxChannel,
  InboxMessage,
  SendMessageInput,
  SenderType,
} from '../types/inbox.types';
import { sanitizePhoneInText } from '../../crm/utils/phone-sanitizer';
import { CustomerService, maskPhone } from '../../crm/services/customer.service';
import { APPLICATION_ROLES } from '../../../shared/constants/roles';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Kiểm tra xem chế độ DEMO_MODE server-only có đang kích hoạt hay không.
 * Cơ chế bảo vệ Production (Lỗi P1 số 7):
 * - Trả về true NẾU VÀ CHỈ NẾU process.env.DEMO_MODE === 'true' VÀ process.env.NODE_ENV !== 'production'.
 * - Luôn cưỡng chế trả về false khi process.env.NODE_ENV === 'production' để ngăn ngừa rò rỉ dữ liệu demo hoặc bypass DB.
 */
export function isDemoModeActive(): boolean {
  if (process.env.NODE_ENV === 'production') {
    return false;
  }
  return process.env.DEMO_MODE === 'true';
}

function isDemoMode(): boolean {
  return isDemoModeActive();
}

function generateUUID(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ============================================================================
// In-Memory Normalized Mock Store for Phase 2
// (Ready for Phase 3 integration with Member 3 Zalo OA & Member 4 Facebook Messenger)
// ============================================================================

export const DEFAULT_INBOX_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

const INITIAL_CONVERSATIONS: Conversation[] = [
  {
    id: 'conv-1',
    company_id: DEFAULT_INBOX_COMPANY_ID,
    customer_id: 'cust-1',
    customer_name: 'Anh Hoàng Nam',
    customer_code: 'KH-000001',
    customer_phone: '0912345612',
    customer_stage: 'PRICE_OFFERED',
    customer_source: 'FACEBOOK',
    channel: 'facebook',
    last_message: 'Dạ em đã gửi báo giá kích thước 2.5m x 0.6m qua Zalo/Email cho anh rồi ạ.',
    last_message_at: '2026-09-17T09:30:00Z',
    unread_count: 0,
    status: 'OPEN',
    updated_at: '2026-09-17T09:30:00Z',
    created_at: '2026-09-16T08:00:00Z',
  },
  {
    id: 'conv-2',
    company_id: DEFAULT_INBOX_COMPANY_ID,
    customer_id: 'cust-2',
    customer_name: 'Chị Mai Phương',
    customer_code: 'KH-000002',
    customer_phone: '0934567890',
    customer_stage: 'SURVEY_SCHEDULED',
    customer_source: 'ZALO',
    channel: 'zalo',
    last_message: 'Mai khoảng 9h sáng thợ có qua khảo sát tại KĐT An Khánh được không em?',
    last_message_at: '2026-09-17T10:15:00Z',
    unread_count: 2,
    status: 'PENDING_SALE',
    updated_at: '2026-09-17T10:15:00Z',
    created_at: '2026-09-16T14:20:00Z',
  },
  {
    id: 'conv-3',
    company_id: DEFAULT_INBOX_COMPANY_ID,
    customer_id: 'cust-3',
    customer_name: 'Bác Quốc Tuấn',
    customer_code: 'KH-000003',
    customer_phone: '0987654321',
    customer_stage: 'WARRANTY_ACTIVE',
    customer_source: 'FACEBOOK',
    channel: 'facebook',
    last_message: 'Dạ chào bác Tuấn! AI ghi nhận yêu cầu bảo trì gioăng đáy của bác. Em đã báo kỹ thuật phụ trách ạ.',
    last_message_at: '2026-09-17T08:05:00Z',
    unread_count: 0,
    status: 'AI_HANDLING',
    updated_at: '2026-09-17T08:05:00Z',
    created_at: '2026-09-15T11:00:00Z',
  },
  {
    id: 'conv-4',
    company_id: DEFAULT_INBOX_COMPANY_ID,
    customer_id: 'cust-4',
    customer_name: 'Anh Trọng Hiếu',
    customer_code: 'KH-000004',
    customer_phone: '0977889900',
    customer_stage: 'DEPOSIT_CONFIRMED',
    customer_source: 'ZALO',
    channel: 'zalo',
    last_message: 'Em đã kiểm tra tài khoản công ty, đơn hàng DH-000004 đã được xác nhận cọc thành công ạ!',
    last_message_at: '2026-09-16T16:45:00Z',
    unread_count: 0,
    status: 'OPEN',
    updated_at: '2026-09-16T16:45:00Z',
    created_at: '2026-09-14T09:10:00Z',
  },
];

const INITIAL_MESSAGES: Record<string, InboxMessage[]> = {
  'conv-1': [
    {
      id: 'msg-1-1',
      company_id: DEFAULT_INBOX_COMPANY_ID,
      conversation_id: 'conv-1',
      customer_id: 'cust-1',
      channel: 'facebook',
      sender_type: 'customer',
      sender_name: 'Anh Hoàng Nam',
      content:
        'Chào shop, nhà tôi ở mặt phố Thái Hà hay bị ngập khoảng 40-50cm khi mưa to. Cửa nhà rộng 2.5m, tôi muốn lắp loại tháo lắp được thì giá khoảng bao nhiêu?',
      created_at: '2026-09-17T09:10:00Z',
      direction: 'inbound',
    },
    {
      id: 'msg-1-2',
      company_id: DEFAULT_INBOX_COMPANY_ID,
      conversation_id: 'conv-1',
      customer_id: 'cust-1',
      channel: 'facebook',
      sender_type: 'ai',
      sender_name: 'AI Trợ lý',
      content:
        'Dạ chào anh Nam! Cửa chống ngập bản tháo lắp hợp kim nhôm 6063-T5 chuyên dụng ngăn nước 99.9%, chịu lực sóng đánh. Với khẩu độ 2.5m x cao 60cm, em đã chuyển thông số cho chuyên viên tư vấn để gửi báo giá chi tiết ngay cho anh ạ.',
      created_at: '2026-09-17T09:11:00Z',
      direction: 'outbound',
    },
    {
      id: 'msg-1-3',
      company_id: DEFAULT_INBOX_COMPANY_ID,
      conversation_id: 'conv-1',
      customer_id: 'cust-1',
      channel: 'facebook',
      sender_type: 'sale',
      sender_name: 'Chuyên viên Sale',
      content:
        'Chào anh Nam, em là chuyên viên tư vấn kỹ thuật. Với kích thước 2.5m x 0.6m, giá trọn gói thi công lắp đặt khoảng 9.500.000đ đã bao gồm khung inox 304 và tấm hợp kim nhôm định hình. Em gửi bản vẽ và báo giá chi tiết để anh tham khảo nhé ạ.',
      created_at: '2026-09-17T09:18:00Z',
      direction: 'outbound',
    },
    {
      id: 'msg-1-4',
      company_id: DEFAULT_INBOX_COMPANY_ID,
      conversation_id: 'conv-1',
      customer_id: 'cust-1',
      channel: 'facebook',
      sender_type: 'customer',
      sender_name: 'Anh Hoàng Nam',
      content: 'Ok em, gửi giúp anh nhé. Có cần thợ qua khảo sát mặt bằng thực tế trước không em?',
      created_at: '2026-09-17T09:25:00Z',
      direction: 'inbound',
    },
    {
      id: 'msg-1-5',
      company_id: DEFAULT_INBOX_COMPANY_ID,
      conversation_id: 'conv-1',
      customer_id: 'cust-1',
      channel: 'facebook',
      sender_type: 'sale',
      sender_name: 'Chuyên viên Sale',
      content:
        'Dạ em đã gửi báo giá kích thước 2.5m x 0.6m qua Zalo/Email cho anh rồi ạ. Bên em có kỹ thuật viên qua khảo sát mặt sàn và đo đạc miễn phí tận nơi ạ.',
      created_at: '2026-09-17T09:30:00Z',
      direction: 'outbound',
    },
  ],

  'conv-2': [
    {
      id: 'msg-2-1',
      company_id: DEFAULT_INBOX_COMPANY_ID,
      conversation_id: 'conv-2',
      customer_id: 'cust-2',
      channel: 'zalo',
      sender_type: 'customer',
      sender_name: 'Chị Mai Phương',
      content:
        'Alo shop, nhà mình ở KĐT Nam An Khánh, tầng hầm để xe dốc sâu nên mưa to nước tràn vào. Cho mình hỏi loại cửa tự động nâng hạ khi có nước.',
      created_at: '2026-09-17T10:00:00Z',
      direction: 'inbound',
    },
    {
      id: 'msg-2-2',
      company_id: DEFAULT_INBOX_COMPANY_ID,
      conversation_id: 'conv-2',
      customer_id: 'cust-2',
      channel: 'zalo',
      sender_type: 'ai',
      sender_name: 'AI Trợ lý',
      content:
        'Dạ chào chị Phương! Hệ thống cửa chống ngập tự động bằng phao cơ thủy lực rất phù hợp cho dốc hầm xe vì tự kích hoạt không cần dùng điện. Chị cho em xin số điện thoại và địa chỉ để kỹ thuật xếp lịch khảo sát thực địa nhé ạ.',
      created_at: '2026-09-17T10:02:00Z',
      direction: 'outbound',
    },
    {
      id: 'msg-2-3',
      company_id: DEFAULT_INBOX_COMPANY_ID,
      conversation_id: 'conv-2',
      customer_id: 'cust-2',
      channel: 'zalo',
      sender_type: 'customer',
      sender_name: 'Chị Mai Phương',
      content: 'Số chị là 0934567890 nhé. Khảo sát có mất phí không em?',
      created_at: '2026-09-17T10:10:00Z',
      direction: 'inbound',
    },
    {
      id: 'msg-2-4',
      company_id: DEFAULT_INBOX_COMPANY_ID,
      conversation_id: 'conv-2',
      customer_id: 'cust-2',
      channel: 'zalo',
      sender_type: 'customer',
      sender_name: 'Chị Mai Phương',
      content: 'Mai khoảng 9h sáng thợ có qua khảo sát tại KĐT An Khánh được không em?',
      created_at: '2026-09-17T10:15:00Z',
      direction: 'inbound',
    },
  ],

  'conv-3': [
    {
      id: 'msg-3-1',
      company_id: DEFAULT_INBOX_COMPANY_ID,
      conversation_id: 'conv-3',
      customer_id: 'cust-3',
      channel: 'facebook',
      sender_type: 'customer',
      sender_name: 'Bác Quốc Tuấn',
      content:
        'Cửa chống ngập nhà tôi lắp năm ngoái ở Triều Khúc, đợt này mưa to ngăn nước rất tốt nhưng thấy gioăng đáy hơi bị mòn. Nhờ công ty qua kiểm tra thay gioăng giúp tôi.',
      created_at: '2026-09-17T08:00:00Z',
      direction: 'inbound',
    },
    {
      id: 'msg-3-2',
      company_id: DEFAULT_INBOX_COMPANY_ID,
      conversation_id: 'conv-3',
      customer_id: 'cust-3',
      channel: 'facebook',
      sender_type: 'ai',
      sender_name: 'AI Trợ lý',
      content:
        'Dạ chào bác Tuấn! AI ghi nhận yêu cầu bảo trì gioăng đáy của bác. Em đã báo kỹ thuật phụ trách ạ.',
      created_at: '2026-09-17T08:05:00Z',
      direction: 'outbound',
    },
  ],

  'conv-4': [
    {
      id: 'msg-4-1',
      company_id: DEFAULT_INBOX_COMPANY_ID,
      conversation_id: 'conv-4',
      customer_id: 'cust-4',
      channel: 'zalo',
      sender_type: 'customer',
      sender_name: 'Anh Trọng Hiếu',
      content: 'Mình vừa chuyển khoản 5 triệu đặt cọc cửa chống ngập tự động rồi nhé. Mã đơn DH-000004.',
      created_at: '2026-09-16T16:30:00Z',
      direction: 'inbound',
    },
    {
      id: 'msg-4-2',
      company_id: DEFAULT_INBOX_COMPANY_ID,
      conversation_id: 'conv-4',
      customer_id: 'cust-4',
      channel: 'zalo',
      sender_type: 'sale',
      sender_name: 'Chuyên viên Sale',
      content:
        'Em đã kiểm tra tài khoản công ty, đơn hàng DH-000004 đã được xác nhận cọc thành công ạ!',
      created_at: '2026-09-16T16:45:00Z',
      direction: 'outbound',
    },
  ],
};

// Mutable in-memory state
let conversationsStore: Conversation[] = [...INITIAL_CONVERSATIONS];
const messagesStore: Record<string, InboxMessage[]> = { ...INITIAL_MESSAGES };

/**
 * 1. Lấy danh sách hội thoại có bộ lọc (Bắt buộc tham số companyId - Strict Tenant Isolation)
 */
export async function getConversations(
  companyId: string,
  filter?: ConversationFilter,
  callerRole?: string | null,
  client?: SupabaseClient
): Promise<Conversation[]> {
  if (!companyId) {
    throw new Error('companyId là bắt buộc khi truy vấn danh sách hội thoại.');
  }

  // 1. Mock store in-memory: chỉ kích hoạt khi có cờ explicit DEMO_MODE === 'true'
  if (isDemoMode()) {
    let list = conversationsStore.filter((c) => c.company_id === companyId);

    if (filter?.channel && filter.channel !== 'all') {
      list = list.filter((c) => c.channel === filter.channel);
    }

    if (filter?.search && filter.search.trim()) {
      const term = filter.search.trim().toLowerCase();
      list = list.filter(
        (c) =>
          c.customer_name.toLowerCase().includes(term) ||
          c.customer_code.toLowerCase().includes(term) ||
          c.last_message.toLowerCase().includes(term)
      );
    }

    if (filter?.unread_only) {
      list = list.filter((c) => c.unread_count > 0);
    }

    if (filter?.status && filter.status !== 'all') {
      list = list.filter((c) => c.status === filter.status);
    }

    list.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

    if (callerRole === APPLICATION_ROLES.SALE) {
      list = list.map((c) => ({
        ...c,
        customer_phone: maskPhone(c.customer_phone),
        last_message: sanitizePhoneInText(c.last_message),
      }));
    }

    return list;
  }

  // 2. Canonical Database Persistence: Truy vấn trực tiếp từ public.conversations và public.interactions
  const adminClient = client || createAdminClient();
  let query = adminClient
    .from('conversations')
    .select(`
      id,
      company_id,
      customer_id,
      channel,
      external_conversation_id,
      last_message_at,
      unread_count,
      status,
      assigned_to,
      created_at,
      updated_at,
      customers (
        id,
        name,
        customer_code,
        stage,
        source
      )
    `)
    .eq('company_id', companyId);

  if (filter?.channel && filter.channel !== 'all') {
    query = query.eq('channel', filter.channel.toUpperCase());
  }

  if (filter?.unread_only) {
    query = query.gt('unread_count', 0);
  }

  if (filter?.status && filter.status !== 'all') {
    query = query.eq('status', filter.status);
  }

  query = query.order('last_message_at', { ascending: false });

  const { data: convRows, error } = await query;
  if (error || !convRows) {
    return [];
  }

  // Lấy tin nhắn cuối cùng (sanitized derivative) cho từng cuộc hội thoại từ public.interactions
  const convIds = convRows.map((c: any) => c.id);
  const latestInteractionMap = new Map<string, { content: string; created_at: string }>();

  if (convIds.length > 0) {
    const { data: interactions } = await adminClient
      .from('interactions')
      .select('conversation_id, sanitized_content, created_at')
      .eq('company_id', companyId)
      .in('conversation_id', convIds)
      .order('created_at', { ascending: false });

    if (interactions) {
      for (const item of interactions) {
        if (!latestInteractionMap.has(item.conversation_id)) {
          latestInteractionMap.set(item.conversation_id, {
            content: item.sanitized_content || '',
            created_at: item.created_at,
          });
        }
      }
    }
  }

  let list: Conversation[] = convRows.map((row: any) => {
    const cust = Array.isArray(row.customers) ? row.customers[0] : row.customers;
    const latestMsg = latestInteractionMap.get(row.id);
    const rawLastMsg = latestMsg?.content || '';
    const lastMsg =
      callerRole === APPLICATION_ROLES.SALE
        ? sanitizePhoneInText(rawLastMsg)
        : rawLastMsg;
    const lastMsgAt = latestMsg?.created_at || row.last_message_at || row.updated_at;

    return {
      id: row.id,
      company_id: row.company_id,
      customer_id: row.customer_id,
      customer_name: cust?.name || 'Khách hàng',
      customer_code: cust?.customer_code || 'KH-000000',
      customer_stage: cust?.stage || 'LEAD_NEW',
      customer_source: cust?.source || row.channel,
      channel: (row.channel || 'facebook').toLowerCase() as InboxChannel,
      last_message: lastMsg,
      last_message_at: lastMsgAt,
      unread_count: row.unread_count || 0,
      status: row.status,
      updated_at: row.updated_at,
      created_at: row.created_at,
    };
  });

  if (filter?.search && filter.search.trim()) {
    const term = filter.search.trim().toLowerCase();
    list = list.filter(
      (c) =>
        c.customer_name.toLowerCase().includes(term) ||
        c.customer_code.toLowerCase().includes(term) ||
        c.last_message.toLowerCase().includes(term)
    );
  }

  return list;
}

/**
 * 2. Lấy chi tiết một cuộc hội thoại theo ID (Bắt buộc companyId - Resource Authorization)
 */
export async function getConversationById(
  companyId: string,
  id: string,
  callerRole?: string | null,
  client?: SupabaseClient
): Promise<Conversation | null> {
  if (!companyId || !id) {
    return null;
  }

  // 1. Mock store in-memory: chỉ kích hoạt khi DEMO_MODE === 'true'
  if (isDemoMode()) {
    const found = conversationsStore.find((c) => c.id === id && c.company_id === companyId);
    if (!found) {
      return null;
    }

    if (callerRole === APPLICATION_ROLES.SALE) {
      return {
        ...found,
        customer_phone: maskPhone(found.customer_phone),
        last_message: sanitizePhoneInText(found.last_message),
      };
    }

    return { ...found };
  }

  // 2. Canonical Database Persistence: Truy vấn trực tiếp từ public.conversations
  const adminClient = client || createAdminClient();
  const { data: row, error } = await adminClient
    .from('conversations')
    .select(`
      id,
      company_id,
      customer_id,
      channel,
      external_conversation_id,
      last_message_at,
      unread_count,
      status,
      assigned_to,
      created_at,
      updated_at,
      customers (
        id,
        name,
        customer_code,
        stage,
        source
      )
    `)
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle();

  if (error || !row) {
    return null;
  }

  // Lấy tin nhắn mới nhất
  const { data: latestInteractions } = await adminClient
    .from('interactions')
    .select('sanitized_content, created_at')
    .eq('company_id', companyId)
    .eq('conversation_id', id)
    .order('created_at', { ascending: false })
    .limit(1);

  const cust = Array.isArray(row.customers) ? row.customers[0] : row.customers;
  const rawLastMsg = latestInteractions?.[0]?.sanitized_content || '';
  const lastMsg =
    callerRole === APPLICATION_ROLES.SALE
      ? sanitizePhoneInText(rawLastMsg)
      : rawLastMsg;
  const lastMsgAt = latestInteractions?.[0]?.created_at || row.last_message_at || row.updated_at;

  return {
    id: row.id,
    company_id: row.company_id,
    customer_id: row.customer_id,
    customer_name: cust?.name || 'Khách hàng',
    customer_code: cust?.customer_code || 'KH-000000',
    customer_stage: cust?.stage || 'LEAD_NEW',
    customer_source: cust?.source || row.channel,
    channel: (row.channel || 'facebook').toLowerCase() as InboxChannel,
    last_message: lastMsg,
    last_message_at: lastMsgAt,
    unread_count: row.unread_count || 0,
    status: row.status,
    updated_at: row.updated_at,
    created_at: row.created_at,
  };
}

export interface GetMessagesOptions {
  userId?: string;
  actorId?: string;
}

/**
 * 3. Lấy toàn bộ tin nhắn thuộc một cuộc hội thoại (Resource Authorization & 404 Fail-Closed)
 */
export async function getMessagesByConversationId(
  companyId: string,
  conversationId: string,
  callerRole?: string | null,
  client?: SupabaseClient,
  options?: GetMessagesOptions
): Promise<InboxMessage[]> {
  if (!companyId || !companyId.trim()) {
    const err = new Error('companyId là bắt buộc khi lấy tin nhắn.');
    (err as any).status = 400;
    (err as any).code = 'BAD_REQUEST';
    throw err;
  }
  if (!conversationId || !conversationId.trim()) {
    const err = new Error('conversationId là bắt buộc khi lấy tin nhắn.');
    (err as any).status = 400;
    (err as any).code = 'BAD_REQUEST';
    throw err;
  }

  // 1. Mock store in-memory: chỉ kích hoạt khi DEMO_MODE === 'true'
  if (isDemoMode()) {
    const conv = conversationsStore.find(
      (c) => c.id === conversationId && c.company_id === companyId
    );
    if (!conv) {
      const notFoundErr = new Error('Cuộc hội thoại không tồn tại hoặc không thuộc quyền quản lý của tổ chức.');
      (notFoundErr as any).status = 404;
      (notFoundErr as any).code = 'NOT_FOUND';
      throw notFoundErr;
    }

    const messages = messagesStore[conversationId] || [];

    if (conv.unread_count > 0) {
      conv.unread_count = 0;
    }

    const sorted = [...messages].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    if (callerRole === APPLICATION_ROLES.BOSS_ADMIN) {
      return sorted.map((m) => {
        const raw = m.raw_content || m.content;
        const sanitized = m.sanitized_content || sanitizePhoneInText(raw);
        const status = m.sanitization_status || (sanitized !== raw ? 'SANITIZED' : 'CLEAN');
        return {
          ...m,
          content: raw,
          sanitized_content: sanitized,
          sanitization_status: status,
          raw_content: raw,
        };
      });
    }

    return sorted.map((m) => {
      const raw = m.raw_content || m.content;
      const sanitized = m.sanitized_content || sanitizePhoneInText(m.content);
      const status = m.sanitization_status || (sanitized !== raw ? 'SANITIZED' : 'CLEAN');
      const { raw_content, ...rest } = m;
      return {
        ...rest,
        content: sanitized,
        sanitized_content: sanitized,
        sanitization_status: status,
      };
    });
  }

  // 2. Canonical Database Persistence: Truy vấn trực tiếp từ public.conversations và public.interactions
  const adminClient = client || createAdminClient();

  // Resource Authorization: Kiểm tra cuộc hội thoại có đúng thuộc companyId của caller hay không
  const { data: conv, error: convError } = await adminClient
    .from('conversations')
    .select('id, company_id, customer_id, channel, unread_count')
    .eq('id', conversationId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (convError || !conv) {
    const notFoundErr = new Error('Cuộc hội thoại không tồn tại hoặc không thuộc quyền quản lý của tổ chức.');
    (notFoundErr as any).status = 404;
    (notFoundErr as any).code = 'NOT_FOUND';
    throw notFoundErr;
  }

  // Đánh dấu đã đọc khi xem tin nhắn
  if (conv.unread_count > 0) {
    await adminClient
      .from('conversations')
      .update({ unread_count: 0 })
      .eq('id', conversationId)
      .eq('company_id', companyId);
  }

  // ZERO-PHONE INVARIANT & PRIVILEGE BOUNDARY:
  // - Với vai trò SALE: Chỉ query/trả về dữ liệu từ public.interactions.sanitized_content.
  //   Tuyệt đối KHÔNG join hay select từ private.interaction_raw_contents.
  // - Chỉ có BOSS_ADMIN mới được tiếp cận nguyên văn nội dung tin nhắn gốc (private.interaction_raw_contents).
  const { data: interactions, error: msgError } = await adminClient
    .from('interactions')
    .select('id, company_id, customer_id, conversation_id, channel, type, direction, sanitized_content, sanitization_status, actor_type, actor_user_id, created_at')
    .eq('conversation_id', conversationId)
    .eq('company_id', companyId)
    .order('created_at', { ascending: true });

  if (msgError || !interactions) {
    return [];
  }

  if (callerRole === APPLICATION_ROLES.BOSS_ADMIN) {
    if (!companyId || !companyId.trim()) {
      const authErr = new Error('Ngữ cảnh tổ chức (companyId) là bắt buộc đối với Quản trị viên khi truy cập tin nhắn.');
      (authErr as any).status = 403;
      (authErr as any).code = 'FORBIDDEN';
      throw authErr;
    }

    const rawMap = new Map<string, string>();
    const interactionIds = interactions.map((i: any) => i.id);

    if (interactionIds.length > 0) {
      let rawRows: any[] | null = null;
      try {
        const { data, error } = await adminClient
          .schema('private')
          .from('interaction_raw_contents')
          .select('interaction_id, company_id, raw_content')
          .in('interaction_id', interactionIds)
          .eq('company_id', companyId);

        if (!error && data) {
          rawRows = data;
        }
      } catch {
        // Direct private schema access might fail if restricted/not exposed
      }

      // Hỗ trợ RPC get_interaction_raw_content nếu schema direct query chưa có kết quả
      if (!rawRows && typeof (adminClient as any).rpc === 'function') {
        try {
          const rpcResults: any[] = [];
          for (const id of interactionIds) {
            const { data: rpcData, error: rpcErr } = await (adminClient as any).rpc(
              'get_interaction_raw_content',
              {
                p_company_id: companyId,
                p_interaction_id: id,
              }
            );
            if (!rpcErr && rpcData && rpcData.length > 0) {
              rpcResults.push(...rpcData);
            }
          }
          if (rpcResults.length > 0) {
            rawRows = rpcResults;
          }
        } catch {
          // RPC fallback
        }
      }

      // FAIL-CLOSED AUDIT TRAIL:
      // Trước khi trả về raw_content từ private.interaction_raw_contents,
      // BẮT BUỘC ghi bản ghi audit log vào public.audit_logs.
      // Nếu thao tác ghi audit log gặp lỗi: Lập tức dừng lại và ném lỗi HTTP 500 AUDIT_WRITE_FAILED,
      // tuyệt đối KHÔNG trả về raw_content ra ngoài response (Fail-Closed).
      if (rawRows && rawRows.length > 0) {
        const actorId = options?.actorId || options?.userId || null;
        const nowIso = new Date().toISOString();

        const auditRecords = rawRows.map((r: any) => ({
          company_id: companyId,
          user_id: actorId,
          actor_id: actorId,
          action: 'VIEW_RAW_INTERACTION',
          resource_type: 'INTERACTION',
          resource_id: r.interaction_id,
          result: 'SUCCESS',
          metadata: {
            conversation_id: conversationId,
            interaction_id: r.interaction_id,
            actor_id: actorId,
          },
          created_at: nowIso,
        }));

        const auditPayload = auditRecords.length === 1 ? auditRecords[0] : auditRecords;
        const { error: auditErr } = await adminClient
          .from('audit_logs')
          .insert(auditPayload);

        if (auditErr) {
          console.error('Lỗi khi ghi audit log truy cập raw interaction:', auditErr);
          const failClosedErr = new Error('Lỗi ghi nhận kiểm toán bắt buộc. Thao tác xem nội dung gốc bị từ chối.');
          (failClosedErr as any).status = 500;
          (failClosedErr as any).code = 'AUDIT_WRITE_FAILED';
          throw failClosedErr;
        }

        for (const r of rawRows) {
          rawMap.set(r.interaction_id, r.raw_content);
        }
      }
    }

    return interactions.map((m: any) => {
      const raw = rawMap.get(m.id) || m.sanitized_content || '';
      const sanitized = m.sanitized_content || sanitizePhoneInText(raw);
      const status = sanitized !== raw ? 'SANITIZED' : 'CLEAN';
      const senderType: SenderType =
        m.actor_type === 'CUSTOMER' ? 'customer' : m.actor_type === 'AI' ? 'ai' : 'sale';

      return {
        id: m.id,
        company_id: m.company_id,
        conversation_id: m.conversation_id,
        customer_id: m.customer_id,
        channel: (m.channel || 'facebook').toLowerCase() as InboxChannel,
        sender_type: senderType,
        content: raw, // BOSS_ADMIN nhận nguyên văn bản gốc
        sanitized_content: sanitized,
        sanitization_status: status,
        raw_content: raw,
        created_at: m.created_at,
        direction: (m.direction || 'INBOUND').toLowerCase() as 'inbound' | 'outbound',
      };
    });
  }

  // Mặc định hoặc SALE: Luôn trả về sanitized derivative, tuyệt đối không lộ raw phone
  return interactions.map((m: any) => {
    const sanitized = m.sanitized_content || '';
    const senderType: SenderType =
      m.actor_type === 'CUSTOMER' ? 'customer' : m.actor_type === 'AI' ? 'ai' : 'sale';

    return {
      id: m.id,
      company_id: m.company_id,
      conversation_id: m.conversation_id,
      customer_id: m.customer_id,
      channel: (m.channel || 'facebook').toLowerCase() as InboxChannel,
      sender_type: senderType,
      content: sanitized, // Mặc định hiển thị sanitized_content
      sanitized_content: sanitized,
      sanitization_status: (m.sanitization_status || 'SUCCEEDED') as any,
      created_at: m.created_at,
      direction: (m.direction || 'INBOUND').toLowerCase() as 'inbound' | 'outbound',
    };
  });
}

/**
 * 4. Gửi tin nhắn phản hồi từ Sale (Resource Authorization & 404 Fail-Closed)
 */
export async function sendMessage(
  input: SendMessageInput,
  callerCompanyId?: string,
  client?: SupabaseClient
): Promise<InboxMessage> {
  const companyId = callerCompanyId || input.company_id;

  if (!companyId) {
    const err = new Error('company_id là bắt buộc khi gửi tin nhắn.');
    (err as any).status = 400;
    (err as any).code = 'BAD_REQUEST';
    throw err;
  }

  const { conversation_id, content, sender_type = 'sale', sender_name } = input;

  if (!conversation_id || !content.trim()) {
    const err = new Error('Nội dung tin nhắn và mã hội thoại là bắt buộc.');
    (err as any).status = 400;
    (err as any).code = 'BAD_REQUEST';
    throw err;
  }

  // 1. Mock store in-memory: chỉ kích hoạt khi DEMO_MODE === 'true'
  if (isDemoMode()) {
    const conv = conversationsStore.find(
      (c) => c.id === conversation_id && c.company_id === companyId
    );
    if (!conv) {
      const notFoundErr = new Error('Không tìm thấy cuộc hội thoại hoặc không thuộc quyền quản lý của tổ chức.');
      (notFoundErr as any).status = 404;
      (notFoundErr as any).code = 'NOT_FOUND';
      throw notFoundErr;
    }

    const rawContent = content.trim();
    const sanitizedContent = sanitizePhoneInText(rawContent);
    const sanitizationStatus: 'CLEAN' | 'SANITIZED' =
      sanitizedContent !== rawContent ? 'SANITIZED' : 'CLEAN';

    const newMessage: InboxMessage = {
      id: `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      company_id: companyId,
      conversation_id,
      customer_id: conv.customer_id,
      channel: conv.channel,
      sender_type,
      sender_name: sender_name || (sender_type === 'sale' ? 'Chuyên viên Sale' : 'Khách hàng'),
      content: sanitizedContent,
      sanitized_content: sanitizedContent,
      sanitization_status: sanitizationStatus,
      raw_content: rawContent,
      created_at: new Date().toISOString(),
      direction: sender_type === 'customer' ? 'inbound' : 'outbound',
    };

    if (!messagesStore[conversation_id]) {
      messagesStore[conversation_id] = [];
    }
    messagesStore[conversation_id].push(newMessage);

    conv.last_message = rawContent;
    conv.updated_at = newMessage.created_at;
    conv.last_message_at = newMessage.created_at;

    return newMessage;
  }

  // 2. Canonical Database Persistence: Lưu vào public.conversations, public.interactions, và private.interaction_raw_contents
  const adminClient = client || createAdminClient();

  // Resource Authorization: Cuộc hội thoại phải thuộc quyền sở hữu của companyId
  const { data: conv, error: convError } = await adminClient
    .from('conversations')
    .select('id, company_id, customer_id, channel')
    .eq('id', conversation_id)
    .eq('company_id', companyId)
    .maybeSingle();

  if (convError || !conv) {
    const notFoundErr = new Error('Không tìm thấy cuộc hội thoại hoặc không thuộc quyền quản lý của tổ chức.');
    (notFoundErr as any).status = 404;
    (notFoundErr as any).code = 'NOT_FOUND';
    throw notFoundErr;
  }

  const rawContent = content.trim();
  const sanitizedContent = sanitizePhoneInText(rawContent);
  const isSanitized = sanitizedContent !== rawContent;
  const sanitizationStatus: 'CLEAN' | 'SANITIZED' = isSanitized ? 'SANITIZED' : 'CLEAN';
  const now = new Date().toISOString();
  const interactionId = generateUUID();

  // Bước 1: Cập nhật last_message_at trong public.conversations
  await adminClient
    .from('conversations')
    .update({
      last_message_at: now,
      updated_at: now,
    })
    .eq('id', conversation_id)
    .eq('company_id', companyId);

  // Bước 2: Lưu bản ghi đã làm sạch vào public.interactions
  const dbChannel = conv.channel.toUpperCase();
  const dbActorType = sender_type === 'ai' ? 'AI' : 'SALE';

  const { error: insertInteractionErr } = await adminClient
    .from('interactions')
    .insert({
      id: interactionId,
      company_id: companyId,
      customer_id: conv.customer_id,
      conversation_id: conv.id,
      channel: dbChannel,
      type: 'MESSAGE',
      direction: 'OUTBOUND',
      sanitized_content: sanitizedContent,
      sanitization_status: 'SUCCEEDED',
      sanitized_at: now,
      sanitizer_version: 'v1',
      actor_type: dbActorType,
      created_at: now,
    });

  if (insertInteractionErr) {
    throw new Error(`Lỗi lưu tương tác: ${insertInteractionErr.message}`);
  }

  // Bước 3: Lưu bản nội dung gốc vào private.interaction_raw_contents qua adminClient/trusted context
  try {
    await adminClient
      .schema('private')
      .from('interaction_raw_contents')
      .insert({
        interaction_id: interactionId,
        company_id: companyId,
        raw_content: rawContent,
        raw_payload: { content: rawContent, sender_name, sender_type },
        source_metadata: { source: 'sale_reply' },
        created_at: now,
      });
  } catch (rawErr) {
    console.warn('[InboxService] Failed to persist raw content in private schema:', rawErr);
  }

  return {
    id: interactionId,
    company_id: companyId,
    conversation_id,
    customer_id: conv.customer_id,
    channel: conv.channel.toLowerCase() as InboxChannel,
    sender_type,
    sender_name: sender_name || (sender_type === 'sale' ? 'Chuyên viên Sale' : 'Khách hàng'),
    content: sanitizedContent,
    sanitized_content: sanitizedContent,
    sanitization_status: sanitizationStatus,
    raw_content: rawContent,
    created_at: now,
    direction: 'outbound',
  };
}

/**
 * 5. Lấy dòng thời gian tương tác tổng hợp (Customer 360 Timeline - Bắt buộc companyId)
 */
export async function getCustomerTimeline(
  customerId: string,
  companyId: string,
  callerRole?: string | null,
  client?: SupabaseClient,
  options?: GetMessagesOptions
): Promise<CustomerTimelineEvent[]> {
  if (!companyId) {
    throw new Error('companyId là bắt buộc khi lấy dòng thời gian khách hàng.');
  }

  // 1. Mock store in-memory: chỉ kích hoạt khi DEMO_MODE === 'true'
  if (isDemoMode()) {
    const events: CustomerTimelineEvent[] = [];

    const allowedConvIds = new Set(
      conversationsStore
        .filter((c) => c.company_id === companyId && c.customer_id === customerId)
        .map((c) => c.id)
    );

    for (const convId of allowedConvIds) {
      const msgs = messagesStore[convId] || [];
      for (const m of msgs) {
        const isBoss = callerRole === APPLICATION_ROLES.BOSS_ADMIN;
        const desc = isBoss
          ? (m.raw_content || m.content)
          : (m.sanitized_content || sanitizePhoneInText(m.content));

        events.push({
          id: m.id,
          company_id: companyId,
          customer_id: customerId,
          type: 'MESSAGE',
          channel: m.channel,
          title:
            m.sender_type === 'customer'
              ? 'Tin nhắn từ khách hàng'
              : m.sender_type === 'ai'
                ? 'AI phản hồi tự động'
                : 'Sale gửi tin nhắn tư vấn',
          description: desc,
          timestamp: m.created_at,
          actor_type: m.sender_type,
          actor_name: m.sender_name,
        });
      }
    }

    if (companyId === DEFAULT_INBOX_COMPANY_ID) {
      if (customerId === 'cust-1') {
        events.push({
          id: 'evt-call-1',
          company_id: companyId,
          customer_id: customerId,
          type: 'CALL',
          channel: 'hotline',
          title: 'Cuộc gọi tư vấn Click-to-Call',
          description: 'Sale thực hiện cuộc gọi bảo mật qua tổng đài Hotline. Khách đồng ý nhận báo giá qua Zalo/Facebook.',
          timestamp: '2026-09-17T09:15:00Z',
          actor_type: 'sale',
          actor_name: 'Chuyên viên Sale',
        });
        events.push({
          id: 'evt-stage-1',
          company_id: companyId,
          customer_id: customerId,
          type: 'STAGE_CHANGE',
          title: 'Chuyển giai đoạn: Đã báo giá',
          description: 'Hệ thống tính giá hoàn tất, chuyển trạng thái từ LEAD_NEW sang PRICE_OFFERED.',
          timestamp: '2026-09-17T09:20:00Z',
          actor_type: 'system',
        });
      } else if (customerId === 'cust-2') {
        events.push({
          id: 'evt-survey-2',
          company_id: companyId,
          customer_id: customerId,
          type: 'SURVEY',
          title: 'Lên lịch hẹn khảo sát hiện trường',
          description: 'Đặt lịch khảo sát dốc hầm KĐT Nam An Khánh cho Kỹ thuật viên (assignee_id: TECH-01).',
          timestamp: '2026-09-17T10:20:00Z',
          actor_type: 'sale',
        });
      } else if (customerId === 'cust-4') {
        events.push({
          id: 'evt-order-4',
          company_id: companyId,
          customer_id: customerId,
          type: 'STAGE_CHANGE',
          title: 'Xác nhận đặt cọc thành công',
          description: 'Khách hàng chuyển khoản 5.000.000đ qua VietQR. Khớp đơn DH-000004 thành công.',
          timestamp: '2026-09-16T16:40:00Z',
          actor_type: 'system',
        });
      }

      events.push({
        id: `evt-init-${customerId}`,
        company_id: companyId,
        customer_id: customerId,
        type: 'STAGE_CHANGE',
        title: 'Tiếp nhận khách hàng mới',
        description: 'Hồ sơ được tạo và lưu trữ trên hệ thống AI CRM với số điện thoại chuẩn hóa E.164.',
        timestamp: '2026-09-16T08:00:00Z',
        actor_type: 'system',
      });
    }

    events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    if (callerRole === APPLICATION_ROLES.SALE) {
      return events.map((e) => ({
        ...e,
        title: sanitizePhoneInText(e.title),
        description: sanitizePhoneInText(e.description),
      }));
    }

    return events;
  }

  // 2. Canonical Database Persistence: Truy vấn trực tiếp từ public.interactions
  const adminClient = client || createAdminClient();

  const { data: interactions, error } = await adminClient
    .from('interactions')
    .select('id, company_id, customer_id, channel, type, direction, sanitized_content, sanitization_status, actor_type, actor_user_id, created_at')
    .eq('company_id', companyId)
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false });

  if (error || !interactions) {
    return [];
  }

  let rawMap = new Map<string, string>();
  if (callerRole === APPLICATION_ROLES.BOSS_ADMIN) {
    const ids = interactions.map((i: any) => i.id);
    if (ids.length > 0) {
      let rawRows: any[] | null = null;
      try {
        const { data, error } = await adminClient
          .schema('private')
          .from('interaction_raw_contents')
          .select('interaction_id, company_id, raw_content')
          .in('interaction_id', ids)
          .eq('company_id', companyId);

        if (!error && data) {
          rawRows = data;
        }
      } catch {
        // Fallback
      }

      if (rawRows && rawRows.length > 0) {
        const actorId = options?.actorId || options?.userId || null;
        const auditRecords = rawRows.map((r: any) => ({
          company_id: companyId,
          user_id: actorId,
          actor_id: actorId,
          action: 'VIEW_RAW_INTERACTION',
          resource_type: 'INTERACTION',
          resource_id: r.interaction_id,
          customer_id: customerId,
          result: 'SUCCESS',
          metadata: {
            customer_id: customerId,
            interaction_id: r.interaction_id,
            actor_id: actorId,
            purpose: 'TIMELINE_VIEW',
          },
          created_at: new Date().toISOString(),
        }));

        const auditPayload = auditRecords.length === 1 ? auditRecords[0] : auditRecords;
        const { error: auditErr } = await adminClient
          .from('audit_logs')
          .insert(auditPayload);

        if (auditErr) {
          console.error('Lỗi khi ghi audit log truy cập raw timeline interaction:', auditErr);
          const failClosedErr = new Error('Lỗi ghi nhận kiểm toán bắt buộc. Thao tác xem nội dung gốc bị từ chối.');
          (failClosedErr as any).status = 500;
          (failClosedErr as any).code = 'AUDIT_WRITE_FAILED';
          throw failClosedErr;
        }

        for (const r of rawRows) {
          rawMap.set(r.interaction_id, r.raw_content);
        }
      }
    }
  }

  const events: CustomerTimelineEvent[] = interactions.map((m: any) => {
    let title = 'Tương tác khách hàng';
    let eventType: 'MESSAGE' | 'CALL' | 'STAGE_CHANGE' | 'SURVEY' | 'NOTE' = 'MESSAGE';

    if (m.type === 'MESSAGE') {
      eventType = 'MESSAGE';
      title =
        m.direction === 'INBOUND'
          ? 'Tin nhắn từ khách hàng'
          : m.actor_type === 'AI'
            ? 'AI phản hồi tự động'
            : 'Sale gửi tin nhắn tư vấn';
    } else if (m.type === 'CALL_EVENT') {
      eventType = 'CALL';
      title = 'Cuộc gọi tư vấn Click-to-Call';
    } else if (m.type === 'NOTE') {
      eventType = 'NOTE';
      title = 'Ghi chú nội bộ';
    } else if (m.type === 'STATUS_EVENT') {
      eventType = 'STAGE_CHANGE';
      title = 'Thay đổi trạng thái';
    } else if (m.type === 'APPOINTMENT_EVENT') {
      eventType = 'SURVEY';
      title = 'Lịch hẹn khảo sát';
    }

    const isBoss = callerRole === APPLICATION_ROLES.BOSS_ADMIN;
    const desc = isBoss
      ? (rawMap.get(m.id) || m.sanitized_content || '')
      : (m.sanitized_content || '');

    return {
      id: m.id,
      company_id: companyId,
      customer_id: customerId,
      type: eventType,
      channel: (m.channel || '').toLowerCase(),
      title,
      description: desc,
      timestamp: m.created_at,
      actor_type: (m.actor_type?.toLowerCase() || 'system') as any,
    };
  });

  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  if (callerRole === APPLICATION_ROLES.SALE) {
    return events.map((e) => ({
      ...e,
      title: sanitizePhoneInText(e.title),
      description: sanitizePhoneInText(e.description),
    }));
  }

  return events;
}

/**
 * 6. Thêm tin nhắn inbound từ khách hàng qua Webhook (Zalo OA / Facebook Messenger)
 */
export async function addInboundMessage(params: {
  channel: InboxChannel;
  senderId: string;
  company_id?: string;
  senderName?: string;
  senderPhone?: string;
  content: string;
  timestamp?: string;
  externalMessageId?: string;
  customerId?: string;
}, client?: SupabaseClient): Promise<{ conversation: Conversation; message: InboxMessage; isNewConversation: boolean }> {
  // Fail-Closed: Bắt buộc phải có company_id hợp lệ, xóa bỏ hoàn toàn fallback DEFAULT_INBOX_COMPANY_ID
  if (
    !params.company_id ||
    typeof params.company_id !== 'string' ||
    !params.company_id.trim() ||
    !UUID_REGEX.test(params.company_id.trim())
  ) {
    throw new Error('company_id là bắt buộc để xử lý tin nhắn và bảo vệ cách ly tenant (Fail-Closed).');
  }
  const companyId = params.company_id.trim();
  const timestamp = params.timestamp || new Date().toISOString();

  // 1. Mock store in-memory: chỉ kích hoạt khi DEMO_MODE === 'true'
  if (isDemoMode()) {
    let isNewConversation = false;

    let conversation = conversationsStore.find(
      (c) =>
        c.company_id === companyId &&
        c.channel === params.channel &&
        (c.customer_id === params.customerId ||
          c.customer_id === params.senderId ||
          (params.senderPhone && c.customer_phone === params.senderPhone))
    );

    if (!conversation) {
      isNewConversation = true;
      const newCustId = params.customerId || `cust-${Date.now()}`;
      const codeNum = conversationsStore.filter((c) => c.company_id === companyId).length + 1;
      const customerCode = `KH-${String(codeNum).padStart(6, '0')}`;

      conversation = {
        id: `conv-${Date.now()}`,
        company_id: companyId,
        customer_id: newCustId,
        customer_name: params.senderName || (params.channel === 'zalo' ? 'Khách hàng Zalo OA' : 'Khách hàng Facebook'),
        customer_code: customerCode,
        customer_phone: params.senderPhone,
        customer_stage: 'LEAD_NEW',
        customer_source: params.channel === 'zalo' ? 'ZALO' : 'FACEBOOK',
        channel: params.channel,
        last_message: params.content,
        last_message_at: timestamp,
        unread_count: 1,
        status: 'PENDING_SALE',
        updated_at: timestamp,
        created_at: timestamp,
      };

      conversationsStore.unshift(conversation);
      messagesStore[conversation.id] = [];
    } else {
      conversation.last_message = params.content;
      conversation.last_message_at = timestamp;
      conversation.unread_count = (conversation.unread_count || 0) + 1;
      conversation.status = 'PENDING_SALE';
      conversation.updated_at = timestamp;
    }

    const rawContent = params.content || '';
    const sanitizedContent = sanitizePhoneInText(rawContent);
    const sanitizationStatus: 'CLEAN' | 'SANITIZED' =
      sanitizedContent !== rawContent ? 'SANITIZED' : 'CLEAN';

    const newMessage: InboxMessage = {
      id: params.externalMessageId || `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      company_id: companyId,
      conversation_id: conversation.id,
      customer_id: conversation.customer_id,
      channel: params.channel,
      sender_type: 'customer',
      sender_name: params.senderName || conversation.customer_name,
      content: sanitizedContent,
      sanitized_content: sanitizedContent,
      sanitization_status: sanitizationStatus,
      raw_content: rawContent,
      created_at: timestamp,
      direction: 'inbound',
    };

    if (!messagesStore[conversation.id]) {
      messagesStore[conversation.id] = [];
    }
    messagesStore[conversation.id].push(newMessage);

    return {
      conversation,
      message: newMessage,
      isNewConversation,
    };
  }

  // 2. Canonical Database Persistence: Lưu vào public.conversations, public.interactions, và private.interaction_raw_contents
  const adminClient = client || createAdminClient();
  const dbChannel = params.channel.toUpperCase();
  const externalConvId = params.senderId;

  const rawContent = params.content || '';
  const sanitizedContent = sanitizePhoneInText(rawContent);
  const isSanitized = sanitizedContent !== rawContent;
  const sanitizationStatus: 'CLEAN' | 'SANITIZED' = isSanitized ? 'SANITIZED' : 'CLEAN';

  let isNewConversation = false;
  let conversationId: string;
  let customerId: string;
  let customerName: string =
    params.senderName || (params.channel === 'zalo' ? 'Khách hàng Zalo OA' : 'Khách hàng Facebook');
  let customerCode: string = 'KH-000001';
  let customerStage: string = 'LEAD_NEW';

  // Tìm cuộc hội thoại tương ứng theo (company_id, channel, external_conversation_id)
  let existingConv: any = null;
  const { data: convByExt } = await adminClient
    .from('conversations')
    .select(`
      id,
      company_id,
      customer_id,
      channel,
      external_conversation_id,
      unread_count,
      status,
      created_at,
      updated_at,
      customers (
        id,
        name,
        customer_code,
        stage,
        source
      )
    `)
    .eq('company_id', companyId)
    .eq('channel', dbChannel)
    .eq('external_conversation_id', externalConvId)
    .maybeSingle();

  existingConv = convByExt;

  if (!existingConv && params.customerId && UUID_REGEX.test(params.customerId)) {
    const { data: convByCust } = await adminClient
      .from('conversations')
      .select(`
        id,
        company_id,
        customer_id,
        channel,
        external_conversation_id,
        unread_count,
        status,
        created_at,
        updated_at,
        customers (
          id,
          name,
          customer_code,
          stage,
          source
        )
      `)
      .eq('company_id', companyId)
      .eq('channel', dbChannel)
      .eq('customer_id', params.customerId)
      .maybeSingle();

    existingConv = convByCust;
  }

  if (existingConv) {
    conversationId = existingConv.id;
    customerId = existingConv.customer_id;
    const cust = Array.isArray(existingConv.customers) ? existingConv.customers[0] : existingConv.customers;
    if (cust) {
      customerName = cust.name || customerName;
      customerCode = cust.customer_code || customerCode;
      customerStage = cust.stage || customerStage;
    }

    // Cập nhật hội thoại đã tồn tại
    await adminClient
      .from('conversations')
      .update({
        last_message_at: timestamp,
        unread_count: (existingConv.unread_count || 0) + 1,
        status: 'PENDING_SALE',
        updated_at: timestamp,
      })
      .eq('id', conversationId)
      .eq('company_id', companyId);
  } else {
    // Tạo mới cuộc hội thoại
    isNewConversation = true;
    conversationId = generateUUID();

    if (params.customerId && UUID_REGEX.test(params.customerId)) {
      customerId = params.customerId;
    } else {
      // Tìm hoặc tạo khách hàng mới
      if (params.senderPhone) {
        try {
          const custResult = await CustomerService.findOrCreateByPhone(
            {
              phone: params.senderPhone,
              name: customerName,
              companyId,
              source: dbChannel as any,
            },
            adminClient
          );
          if (custResult?.customer) {
            customerId = custResult.customer.id;
            customerCode = custResult.customer.customer_code;
            customerName = custResult.customer.name;
            customerStage = custResult.customer.stage;
          }
        } catch {
          // Bỏ qua lỗi tìm khách qua phone
        }
      }

      if (!customerId! || !UUID_REGEX.test(customerId)) {
        const newCustId = generateUUID();
        const { data: createdCust } = await adminClient
          .from('customers')
          .insert({
            id: newCustId,
            company_id: companyId,
            name: customerName,
            source: dbChannel === 'ZALO' ? 'ZALO' : 'FACEBOOK',
            stage: 'LEAD_NEW',
          })
          .select('id, name, customer_code, stage')
          .maybeSingle();

        if (createdCust) {
          customerId = createdCust.id;
          customerName = createdCust.name || customerName;
          customerCode = createdCust.customer_code || customerCode;
          customerStage = createdCust.stage || customerStage;
        } else {
          customerId = newCustId;
        }
      }
    }

    const { error: convInsertErr } = await adminClient
      .from('conversations')
      .insert({
        id: conversationId,
        company_id: companyId,
        customer_id: customerId,
        channel: dbChannel,
        external_conversation_id: externalConvId,
        last_message_at: timestamp,
        unread_count: 1,
        status: 'PENDING_SALE',
        created_at: timestamp,
        updated_at: timestamp,
      });

    if (convInsertErr) {
      throw new Error(`Lỗi khởi tạo cuộc hội thoại: ${convInsertErr.message}`);
    }
  }

  // 2. Lưu bản ghi đã làm sạch vào public.interactions
  const interactionId =
    params.externalMessageId && UUID_REGEX.test(params.externalMessageId)
      ? params.externalMessageId
      : generateUUID();

  const { error: insertInteractionErr } = await adminClient
    .from('interactions')
    .insert({
      id: interactionId,
      company_id: companyId,
      customer_id: customerId,
      conversation_id: conversationId,
      channel: dbChannel,
      type: 'MESSAGE',
      direction: 'INBOUND',
      sanitized_content: sanitizedContent,
      sanitization_status: 'SUCCEEDED',
      sanitized_at: timestamp,
      sanitizer_version: 'v1',
      external_ref: params.externalMessageId || null,
      actor_type: 'CUSTOMER',
      created_at: timestamp,
    });

  if (insertInteractionErr) {
    throw new Error(`Lỗi lưu tương tác: ${insertInteractionErr.message}`);
  }

  // 3. Lưu bản nội dung gốc vào private.interaction_raw_contents qua adminClient/trusted context
  try {
    await adminClient
      .schema('private')
      .from('interaction_raw_contents')
      .insert({
        interaction_id: interactionId,
        company_id: companyId,
        raw_content: rawContent,
        raw_payload: {
          content: rawContent,
          sender_id: params.senderId,
          sender_name: params.senderName,
          sender_phone: params.senderPhone,
        },
        source_metadata: {
          channel: params.channel,
          external_message_id: params.externalMessageId,
        },
        created_at: timestamp,
      });
  } catch (rawErr) {
    console.warn('[InboxService] Failed to persist raw interaction content in private schema:', rawErr);
  }

  const conversation: Conversation = {
    id: conversationId,
    company_id: companyId,
    customer_id: customerId,
    customer_name: customerName,
    customer_code: customerCode,
    customer_phone: params.senderPhone,
    customer_stage: customerStage,
    customer_source: dbChannel,
    channel: params.channel,
    last_message: rawContent,
    last_message_at: timestamp,
    unread_count: isNewConversation ? 1 : (existingConv?.unread_count || 0) + 1,
    status: 'PENDING_SALE',
    updated_at: timestamp,
    created_at: timestamp,
  };

  const newMessage: InboxMessage = {
    id: interactionId,
    company_id: companyId,
    conversation_id: conversationId,
    customer_id: customerId,
    channel: params.channel,
    sender_type: 'customer',
    sender_name: params.senderName || customerName,
    content: sanitizedContent,
    sanitized_content: sanitizedContent,
    sanitization_status: sanitizationStatus,
    raw_content: rawContent,
    created_at: timestamp,
    direction: 'inbound',
  };

  return {
    conversation,
    message: newMessage,
    isNewConversation,
  };
}

/**
 * 7. Cập nhật trạng thái khách hàng đồng bộ trong các hội thoại Inbox
 */
export function updateConversationCustomerStage(
  customerId: string,
  newStage: string,
  companyId?: string
): void {
  for (const c of conversationsStore) {
    if (c.customer_id === customerId && (!companyId || c.company_id === companyId)) {
      c.customer_stage = newStage;
      c.updated_at = new Date().toISOString();
    }
  }
}

/**
 * Helper đặt lại kho lưu trữ phục vụ kiểm thử tự động
 */
export function resetInboxStore(
  initialConvs?: Conversation[],
  initialMsgs?: Record<string, InboxMessage[]>
): void {
  conversationsStore = initialConvs ? [...initialConvs] : [...INITIAL_CONVERSATIONS];
  if (initialMsgs) {
    for (const key of Object.keys(messagesStore)) {
      delete messagesStore[key];
    }
    Object.assign(messagesStore, initialMsgs);
  } else {
    for (const key of Object.keys(messagesStore)) {
      delete messagesStore[key];
    }
    Object.assign(messagesStore, INITIAL_MESSAGES);
  }
}

export const InboxService = {
  isDemoModeActive,
  getConversations,
  getConversationById,
  getMessagesByConversationId,
  sendMessage,
  getCustomerTimeline,
  addInboundMessage,
  updateConversationCustomerStage,
  resetInboxStore,
  sanitizePhoneInText,
  DEFAULT_INBOX_COMPANY_ID,
};
