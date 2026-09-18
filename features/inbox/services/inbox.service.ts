import type {
  Conversation,
  ConversationFilter,
  CustomerTimelineEvent,
  InboxChannel,
  InboxMessage,
  SendMessageInput,
} from '../types/inbox.types';
import { sanitizePhoneInText } from '../../crm/utils/phone-sanitizer';
import { maskPhone } from '../../crm/services/customer.service';
import { APPLICATION_ROLES } from '../../../shared/constants/roles';

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
  callerRole?: string | null
): Promise<Conversation[]> {
  if (!companyId) {
    throw new Error('companyId là bắt buộc khi truy vấn danh sách hội thoại.');
  }

  // Tenant Isolation: Lọc nghiêm ngặt chỉ lấy các cuộc hội thoại thuộc companyId của caller
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

  // Sắp xếp thời gian tin nhắn mới nhất lên đầu
  list.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  // Zero-Phone Sanitization: Nếu là SALE, che số điện thoại và che số trong last_message
  if (callerRole === APPLICATION_ROLES.SALE) {
    list = list.map((c) => ({
      ...c,
      customer_phone: maskPhone(c.customer_phone),
      last_message: sanitizePhoneInText(c.last_message),
    }));
  }

  return list;
}

/**
 * 2. Lấy chi tiết một cuộc hội thoại theo ID (Bắt buộc companyId - Resource Authorization)
 */
export async function getConversationById(
  companyId: string,
  id: string,
  callerRole?: string | null
): Promise<Conversation | null> {
  if (!companyId || !id) {
    return null;
  }
  // Resource Authorization: Chỉ trả về nếu cuộc hội thoại khớp companyId
  const found = conversationsStore.find((c) => c.id === id && c.company_id === companyId);
  if (!found) {
    return null;
  }

  // Zero-Phone Sanitization: Nếu là SALE, che số điện thoại và che số trong last_message
  if (callerRole === APPLICATION_ROLES.SALE) {
    return {
      ...found,
      customer_phone: maskPhone(found.customer_phone),
      last_message: sanitizePhoneInText(found.last_message),
    };
  }

  return { ...found };
}

/**
 * 3. Lấy toàn bộ tin nhắn thuộc một cuộc hội thoại (Resource Authorization & 404 Fail-Closed)
 */
export async function getMessagesByConversationId(
  companyId: string,
  conversationId: string,
  callerRole?: string | null
): Promise<InboxMessage[]> {
  if (!companyId) {
    const err = new Error('companyId là bắt buộc khi lấy tin nhắn.');
    (err as any).status = 400;
    (err as any).code = 'BAD_REQUEST';
    throw err;
  }
  if (!conversationId) {
    const err = new Error('conversationId là bắt buộc khi lấy tin nhắn.');
    (err as any).status = 400;
    (err as any).code = 'BAD_REQUEST';
    throw err;
  }

  // Resource Authorization: Kiểm tra cuộc hội thoại có đúng thuộc companyId của caller hay không
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

  // Đánh dấu đã đọc khi xem tin nhắn
  if (conv.unread_count > 0) {
    conv.unread_count = 0;
  }

  // Sắp xếp tăng dần theo thời gian để hiển thị từ cũ đến mới
  const sorted = [...messages].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  // Zero-Phone Sanitization: Nếu là SALE, làm sạch số điện thoại xuất hiện trong message.content
  // Chỉ có BOSS_ADMIN mới được nhận nguyên văn nội dung tin nhắn gốc.
  if (callerRole === APPLICATION_ROLES.SALE) {
    return sorted.map((m) => ({
      ...m,
      content: sanitizePhoneInText(m.content),
    }));
  }

  return sorted;
}

/**
 * 4. Gửi tin nhắn phản hồi từ Sale (Resource Authorization & 404 Fail-Closed)
 */
export async function sendMessage(
  input: SendMessageInput,
  callerCompanyId?: string
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

  // Resource Authorization: Cuộc hội thoại phải thuộc quyền sở hữu của companyId
  const conv = conversationsStore.find(
    (c) => c.id === conversation_id && c.company_id === companyId
  );
  if (!conv) {
    const notFoundErr = new Error('Không tìm thấy cuộc hội thoại hoặc không thuộc quyền quản lý của tổ chức.');
    (notFoundErr as any).status = 404;
    (notFoundErr as any).code = 'NOT_FOUND';
    throw notFoundErr;
  }

  const newMessage: InboxMessage = {
    id: `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    company_id: companyId,
    conversation_id,
    customer_id: conv.customer_id,
    channel: conv.channel,
    sender_type,
    sender_name: sender_name || (sender_type === 'sale' ? 'Chuyên viên Sale' : 'Khách hàng'),
    content: content.trim(),
    created_at: new Date().toISOString(),
    direction: sender_type === 'customer' ? 'inbound' : 'outbound',
  };

  // Lưu tin nhắn vào store
  if (!messagesStore[conversation_id]) {
    messagesStore[conversation_id] = [];
  }
  messagesStore[conversation_id].push(newMessage);

  // Cập nhật thông tin hội thoại
  conv.last_message = newMessage.content;
  conv.updated_at = newMessage.created_at;
  conv.last_message_at = newMessage.created_at;

  return newMessage;
}

/**
 * 5. Lấy dòng thời gian tương tác tổng hợp (Customer 360 Timeline - Bắt buộc companyId)
 */
export async function getCustomerTimeline(
  customerId: string,
  companyId: string,
  callerRole?: string | null
): Promise<CustomerTimelineEvent[]> {
  if (!companyId) {
    throw new Error('companyId là bắt buộc khi lấy dòng thời gian khách hàng.');
  }

  const events: CustomerTimelineEvent[] = [];

  // Lấy các cuộc hội thoại thuộc khách hàng này VÀ thuộc đúng companyId
  const allowedConvIds = new Set(
    conversationsStore
      .filter((c) => c.company_id === companyId && c.customer_id === customerId)
      .map((c) => c.id)
  );

  // Chỉ lấy tin nhắn từ các cuộc hội thoại thuộc companyId này
  for (const convId of allowedConvIds) {
    const msgs = messagesStore[convId] || [];
    for (const m of msgs) {
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
        description: m.content,
        timestamp: m.created_at,
        actor_type: m.sender_type,
        actor_name: m.sender_name,
      });
    }
  }

  // Bổ sung các sự kiện nghiệp vụ mẫu trong hành trình khách hàng (chỉ khi cùng companyId mặc định)
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

    // Thêm sự kiện khởi tạo khách hàng ban đầu
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

  // Sắp xếp thời gian giảm dần (mới nhất lên đầu)
  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // Zero-Phone Sanitization: Nếu là SALE, che số điện thoại trong description và title
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
}): Promise<{ conversation: Conversation; message: InboxMessage; isNewConversation: boolean }> {
  const companyId = params.company_id || DEFAULT_INBOX_COMPANY_ID;
  const timestamp = params.timestamp || new Date().toISOString();
  let isNewConversation = false;

  // Tìm cuộc hội thoại tương ứng trong đúng companyId
  let conversation = conversationsStore.find(
    (c) =>
      c.company_id === companyId &&
      c.channel === params.channel &&
      (c.customer_id === params.customerId ||
        c.customer_id === params.senderId ||
        (params.senderPhone && c.customer_phone === params.senderPhone))
  );

  if (!conversation) {
    // Tạo mới cuộc hội thoại
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
    // Cập nhật hội thoại đã tồn tại
    conversation.last_message = params.content;
    conversation.last_message_at = timestamp;
    conversation.unread_count = (conversation.unread_count || 0) + 1;
    conversation.status = 'PENDING_SALE';
    conversation.updated_at = timestamp;
  }

  // Tạo tin nhắn mới
  const newMessage: InboxMessage = {
    id: params.externalMessageId || `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    company_id: companyId,
    conversation_id: conversation.id,
    customer_id: conversation.customer_id,
    channel: params.channel,
    sender_type: 'customer',
    sender_name: params.senderName || conversation.customer_name,
    content: params.content,
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
