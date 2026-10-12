import { CONFIG } from './config.js';
import { log } from './logger.js';

export async function syncInboundMessageToCRM({
  pageId,
  pageName,
  senderName,
  customerFbId,
  externalConversationId,
  externalMessageId,
  content,
  timestamp
}) {
  if (!CONFIG.FB_WORKER_SECRET) {
    log.error('Chưa cấu hình FB_WORKER_SECRET trong fb-inbox-worker/.env. Không thể gửi dữ liệu về CRM.');
    return { success: false, error: 'MISSING_SECRET' };
  }

  const payload = {
    page_id: pageId,
    page_name: pageName,
    sender_name: senderName,
    customer_fb_id: customerFbId,
    external_conversation_id: externalConversationId,
    external_message_id: externalMessageId,
    content,
    timestamp,
    direction: 'inbound',
    company_id: CONFIG.CRM_COMPANY_ID
  };

  try {
    const res = await fetch(CONFIG.CRM_SYNC_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-worker-secret': CONFIG.FB_WORKER_SECRET
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      log.warn(`CRM Sync Endpoint trả về lỗi HTTP ${res.status}: ${data.message || data.error || 'Unknown error'}`);
      return { success: false, status: res.status, error: data.error };
    }

    return {
      success: true,
      isDuplicate: Boolean(data.is_duplicate),
      isNewConversation: Boolean(data.is_new_conversation),
      conversationId: data.conversation_id,
      interactionId: data.interaction_id
    };
  } catch (err) {
    log.warn(`Không thể kết nối tới CRM (${CONFIG.CRM_SYNC_ENDPOINT}): ${err.message}`);
    return { success: false, error: err.message };
  }
}
