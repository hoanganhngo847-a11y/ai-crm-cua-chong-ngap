import * as crypto from 'crypto';
import type { InboxChannel } from '../types/inbox.types';
import type {
  OmnichannelWebhookPayload,
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
 * 1. Xác thực chữ ký mật mã Webhook (HMAC-SHA256) từ đối tác ngoại vi
 * (Facebook x-hub-signature-256, Zalo OA mac / x-zalo-signature)
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string | null | undefined,
  channel: InboxChannel
): WebhookVerificationResult {
  // Nếu môi trường chưa cấu hình secret (dev/mock fallback)
  if (!secret) {
    return { valid: true, reason: 'No webhook secret configured (Development Bypass)' };
  }

  if (!signature) {
    return { valid: false, reason: 'Thiếu header chữ ký số xác thực (Missing Signature Header)' };
  }

  try {
    let expectedSignature = '';

    if (channel === 'facebook') {
      // Facebook x-hub-signature-256 format: sha256=<hex_hash>
      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(rawBody);
      expectedSignature = 'sha256=' + hmac.digest('hex');

      // So sánh an toàn thời gian thực chống tấn công timing
      const sigBuffer = Buffer.from(signature);
      const expectedBuffer = Buffer.from(expectedSignature);

      if (sigBuffer.length !== expectedBuffer.length) {
        return { valid: false, reason: 'Độ dài chữ ký Facebook không hợp lệ' };
      }

      const isValid = crypto.timingSafeEqual(sigBuffer, expectedBuffer);
      return { valid: isValid, reason: isValid ? undefined : 'Chữ ký số Facebook không khớp' };
    } else if (channel === 'zalo') {
      // Zalo OA webhook signature format: HMAC-SHA256 hex
      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(rawBody);
      expectedSignature = hmac.digest('hex');

      const sigBuffer = Buffer.from(signature.replace(/^sha256=/, ''));
      const expectedBuffer = Buffer.from(expectedSignature);

      if (sigBuffer.length !== expectedBuffer.length) {
        // Fallback kiểm tra so sánh token trực tiếp nếu gửi dạng secret token
        if (signature === secret) {
          return { valid: true };
        }
        return { valid: false, reason: 'Độ dài chữ ký Zalo không hợp lệ' };
      }

      const isValid = crypto.timingSafeEqual(sigBuffer, expectedBuffer);
      return { valid: isValid, reason: isValid ? undefined : 'Chữ ký số Zalo không khớp' };
    }

    // Kênh mặc định hoặc token so sánh
    if (signature === secret) {
      return { valid: true };
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
 * 3. Xử lý tiếp nhận sự kiện Webhook tin nhắn đa kênh (Ingress Processor)
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

  // Chống ghi trùng lặp (Idempotency)
  if (isDuplicateEvent(payload.event_id)) {
    const cached = processedResults.get(payload.event_id);
    if (cached) {
      return {
        ...cached,
        duplicate: true,
      };
    }
    return {
      success: true,
      duplicate: true,
    };
  }

  if (!payload.sender || !payload.sender.id) {
    return {
      success: false,
      error: 'Thiếu thông tin người gửi (sender.id).',
    };
  }

  if (!payload.message || !payload.message.text) {
    return {
      success: false,
      error: 'Thiếu nội dung tin nhắn (message.text).',
    };
  }

  try {
    // Thêm tin nhắn và cập nhật/tạo mới cuộc hội thoại
    const result = await InboxService.addInboundMessage({
      channel: payload.channel,
      senderId: payload.sender.id,
      senderName: payload.sender.name,
      senderPhone: payload.sender.phone,
      content: payload.message.text,
      timestamp: payload.message.timestamp || new Date().toISOString(),
      externalMessageId: payload.message.id,
      customerId: payload.sender.customer_id,
    });

    const processResult: IngressProcessResult = {
      success: true,
      duplicate: false,
      conversation_id: result.conversation.id,
      message_id: result.message.id,
      customer_id: result.conversation.customer_id,
      customer_name: result.conversation.customer_name,
      channel: payload.channel,
      is_new_conversation: result.isNewConversation,
    };

    // Lưu vào bộ nhớ cache Idempotent
    if (processedEventIds.size >= MAX_CACHE_SIZE) {
      // Dọn dẹp cache cũ nếu đầy
      const firstKey = processedEventIds.values().next().value;
      if (firstKey) {
        processedEventIds.delete(firstKey);
        processedResults.delete(firstKey);
      }
    }

    processedEventIds.add(payload.event_id);
    processedResults.set(payload.event_id, processResult);

    return processResult;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Lỗi xử lý sự kiện tin nhắn.';
    return {
      success: false,
      error: message,
    };
  }
}

export const InboxIngressService = {
  verifyWebhookSignature,
  isDuplicateEvent,
  processInboundWebhook,
};
