import * as crypto from 'crypto';
import type { InboxChannel } from '../types/inbox.types';
import type {
  OmnichannelWebhookPayload,
  NormalizedIngressEvent,
  IngressProcessResult,
  WebhookVerificationResult,
} from '../types/webhook.types';
import { InboxService } from './inbox.service';

// ============================================================================
// Idempotency & Deduplication Cache
// Tuân thủ SUPABASE_RLS_DESIGN.md (Mục 21: Chống ghi trùng & Replay Protection)
// ============================================================================
const processedEventIds = new Set<string>();
const processedResults = new Map<string, IngressProcessResult>();
const MAX_CACHE_SIZE = 10000;

/**
 * 1. Xác thực chữ ký mật mã Webhook (HMAC-SHA256) từ đối tác ngoại vi (Facebook Messenger / Zalo OA).
 *
 * Nguyên tắc Fail-Closed (P0):
 * - Thiếu Secret: Lập tức từ chối, TUYỆT ĐỐI KHÔNG bypass hoặc fallback dev secret.
 * - Thiếu Signature Header: Lập tức từ chối.
 * - Sai chữ ký: Lập tức từ chối.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string | null | undefined,
  channel: InboxChannel
): WebhookVerificationResult {
  // Fail-closed: Thiếu secret trong env phải từ chối ngay lập tức, không bypass
  if (!secret || !secret.trim()) {
    return {
      valid: false,
      reason: 'Chưa cấu hình Webhook secret trên hệ thống (Configuration Error)',
    };
  }

  // Fail-closed: Thiếu header chữ ký
  if (!signature || !signature.trim()) {
    return {
      valid: false,
      reason: 'Thiếu header chữ ký số xác thực (Missing Signature Header)',
    };
  }

  try {
    let expectedSignature = '';

    if (channel === 'facebook') {
      // Facebook x-hub-signature-256 format: sha256=<hex_hash>
      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(rawBody);
      expectedSignature = 'sha256=' + hmac.digest('hex');

      const cleanSig = signature.trim();
      const sigBuffer = Buffer.from(cleanSig);
      const expectedBuffer = Buffer.from(expectedSignature);

      if (sigBuffer.length !== expectedBuffer.length) {
        return { valid: false, reason: 'Độ dài chữ ký Facebook không hợp lệ' };
      }

      const isValid = crypto.timingSafeEqual(sigBuffer, expectedBuffer);
      return { valid: isValid, reason: isValid ? undefined : 'Chữ ký số Facebook không khớp' };
    } else if (channel === 'zalo') {
      // Zalo OA webhook signature format: HMAC-SHA256 hex (hoặc sha256=<hex>)
      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(rawBody);
      expectedSignature = hmac.digest('hex');

      const cleanSig = signature.trim().replace(/^sha256=/, '');
      const sigBuffer = Buffer.from(cleanSig);
      const expectedBuffer = Buffer.from(expectedSignature);

      if (sigBuffer.length !== expectedBuffer.length) {
        return { valid: false, reason: 'Độ dài chữ ký Zalo không hợp lệ' };
      }

      const isValid = crypto.timingSafeEqual(sigBuffer, expectedBuffer);
      return { valid: isValid, reason: isValid ? undefined : 'Chữ ký số Zalo không khớp' };
    }

    return { valid: false, reason: 'Kênh không hỗ trợ xác thực chữ ký số' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Lỗi xác thực chữ ký số';
    return { valid: false, reason: msg };
  }
}

/**
 * 2. Kiểm tra tính trùng lặp sự kiện (Idempotency)
 */
export function isDuplicateEvent(eventId: string): boolean {
  return processedEventIds.has(eventId);
}

/**
 * 3. Chuẩn hóa Hợp đồng Tiếp nhận (Normalized Ingress Contract do Thành viên 2 sở hữu)
 * Cho phép Thành viên 3 (Zalo OA) & Thành viên 4 (Facebook Messenger) trực tiếp tái sử dụng.
 */
export async function ingestNormalizedEvent(
  event: NormalizedIngressEvent
): Promise<IngressProcessResult> {
  if (!event) {
    return {
      success: false,
      error: 'Thiếu dữ liệu sự kiện NormalizedIngressEvent.',
    };
  }

  // Bắt buộc kiểm tra tenant isolation
  if (!event.company_id || !event.company_id.trim()) {
    return {
      success: false,
      error: 'Thiếu trường company_id bắt buộc (Strict Tenant Isolation).',
    };
  }

  if (!event.message_id || !event.message_id.trim()) {
    return {
      success: false,
      error: 'Thiếu trường message_id bắt buộc.',
    };
  }

  if (!event.external_user_id || !event.external_user_id.trim()) {
    return {
      success: false,
      error: 'Thiếu trường external_user_id bắt buộc.',
    };
  }

  if (!event.content || !event.content.trim()) {
    return {
      success: false,
      error: 'Thiếu nội dung tin nhắn content.',
    };
  }

  // Chống ghi trùng lặp (Idempotency) theo message_id
  if (isDuplicateEvent(event.message_id)) {
    const cached = processedResults.get(event.message_id);
    if (cached) {
      return {
        ...cached,
        duplicate: true,
      };
    }
    return {
      success: true,
      duplicate: true,
      message_id: event.message_id,
    };
  }

  const channel: InboxChannel = event.provider === 'ZALO' ? 'zalo' : 'facebook';

  try {
    // Thêm tin nhắn và cập nhật/tạo mới cuộc hội thoại với đúng company_id
    const result = await InboxService.addInboundMessage({
      channel,
      senderId: event.external_user_id,
      company_id: event.company_id,
      senderName: event.sender_name,
      senderPhone: event.sender_phone,
      content: event.content,
      timestamp: event.timestamp || new Date().toISOString(),
      externalMessageId: event.message_id,
    });

    const processResult: IngressProcessResult = {
      success: true,
      duplicate: false,
      conversation_id: result.conversation.id,
      message_id: result.message.id,
      customer_id: result.conversation.customer_id,
      customer_name: result.conversation.customer_name,
      channel,
      is_new_conversation: result.isNewConversation,
    };

    // Lưu vào bộ nhớ cache Idempotent
    if (processedEventIds.size >= MAX_CACHE_SIZE) {
      const firstKey = processedEventIds.values().next().value;
      if (firstKey) {
        processedEventIds.delete(firstKey);
        processedResults.delete(firstKey);
      }
    }

    processedEventIds.add(event.message_id);
    processedResults.set(event.message_id, processResult);

    return processResult;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Lỗi xử lý sự kiện tin nhắn.';
    return {
      success: false,
      error: message,
    };
  }
}

/**
 * 4. Wrapper tương thích ngược cho OmnichannelWebhookPayload
 */
export async function processInboundWebhook(
  payload: OmnichannelWebhookPayload
): Promise<IngressProcessResult> {
  if (!payload || !payload.event_id) {
    return {
      success: false,
      error: 'Thiếu event_id trong payload webhook.',
    };
  }

  const provider: 'FACEBOOK' | 'ZALO' | 'SYSTEM' =
    payload.channel === 'zalo' ? 'ZALO' : 'FACEBOOK';

  return ingestNormalizedEvent({
    provider,
    company_id: payload.company_id || InboxService.DEFAULT_INBOX_COMPANY_ID,
    external_user_id: payload.sender?.id || 'anon_user',
    sender_name: payload.sender?.name,
    sender_phone: payload.sender?.phone,
    message_id: payload.message?.id || payload.event_id,
    content: payload.message?.text || '',
    timestamp: payload.message?.timestamp || new Date().toISOString(),
    metadata: payload.metadata,
  });
}

/**
 * Helper dọn dẹp cache cho kiểm thử tự động
 */
export function resetIngressCache(): void {
  processedEventIds.clear();
  processedResults.clear();
}

export const InboxIngressService = {
  verifyWebhookSignature,
  isDuplicateEvent,
  ingestNormalizedEvent,
  processInboundWebhook,
  resetIngressCache,
};
