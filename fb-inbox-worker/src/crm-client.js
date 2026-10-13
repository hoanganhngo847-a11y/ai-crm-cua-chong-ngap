import { CONFIG } from './config.js';
import { log } from './logger.js';

export const CRM_SYNC_TIMEOUT_MS = 4000;

export async function syncInboundMessageToCRM({
  pageId,
  pageName,
  senderName,
  customerFbId,
  externalConversationId,
  externalMessageId,
  content,
  timestamp,
  metadata
} = {}) {
  // 1. Secret validation
  if (!CONFIG.FB_WORKER_SECRET) {
    log.error('Chưa cấu hình FB_WORKER_SECRET trong fb-inbox-worker/.env. Không thể gửi dữ liệu về CRM.');
    return { success: false, error: 'MISSING_SECRET' };
  }

  // 2. Strict identity-critical validation (Fail closed - Section 3)
  const isNonEmptyString = (val) => typeof val === 'string' && val.trim().length > 0;
  if (
    !isNonEmptyString(pageId) ||
    !isNonEmptyString(customerFbId) ||
    !isNonEmptyString(externalConversationId) ||
    !isNonEmptyString(externalMessageId) ||
    !isNonEmptyString(content)
  ) {
    log.warn(
      `[INBOUND CRM] Thiếu identity-critical fields (pageId=${pageId}, customerFbId=${customerFbId}, externalConversationId=${externalConversationId}, externalMessageId=${externalMessageId}). Chặn POST để tránh merge nhầm khách hàng.`
    );
    return { success: false, error: 'INVALID_INBOUND_IDENTITY' };
  }

  const payload = {
    page_id: pageId.trim(),
    page_name: (pageName && typeof pageName === 'string') ? pageName.trim() : 'Trang Facebook',
    sender_name: (senderName && typeof senderName === 'string') ? senderName.trim() : 'Khách hàng Facebook',
    customer_fb_id: customerFbId.trim(),
    external_conversation_id: externalConversationId.trim(),
    external_message_id: externalMessageId.trim(),
    content: content.trim(),
    timestamp,
    direction: 'inbound',
    company_id: CONFIG.CRM_COMPANY_ID,
    metadata: (metadata && typeof metadata === 'object') ? metadata : {}
  };

  // 3. Network call with bounded AbortController timeout (Section 2)
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, CRM_SYNC_TIMEOUT_MS);

  try {
    const res = await fetch(CONFIG.CRM_SYNC_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-worker-secret': CONFIG.FB_WORKER_SECRET
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      log.warn(`CRM Sync Endpoint trả về lỗi HTTP ${res.status}: ${data.message || data.error || 'Unknown error'}`);
      return { success: false, status: res.status, error: data.error || `HTTP_${res.status}` };
    }

    return {
      success: true,
      isDuplicate: Boolean(data.is_duplicate),
      isNewConversation: Boolean(data.is_new_conversation),
      conversationId: data.conversation_id,
      interactionId: data.interaction_id
    };
  } catch (err) {
    if (err.name === 'AbortError' || err.message?.includes('aborted')) {
      log.warn(`CRM Sync Endpoint timeout sau ${CRM_SYNC_TIMEOUT_MS}ms (${CONFIG.CRM_SYNC_ENDPOINT})`);
      return { success: false, error: 'CRM_SYNC_TIMEOUT' };
    }
    log.warn(`Không thể kết nối tới CRM (${CONFIG.CRM_SYNC_ENDPOINT}): ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}
