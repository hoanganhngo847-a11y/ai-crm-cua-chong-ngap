import * as crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../../lib/supabase/admin';
import type { InboxChannel } from '../types/inbox.types';
import type {
  OmnichannelWebhookPayload,
  NormalizedIngressEvent,
  IngressProcessResult,
  WebhookVerificationResult,
  ProviderWebhookAdapter,
} from '../types/webhook.types';
import { InboxService } from './inbox.service';

declare module '../types/webhook.types' {
  interface IngressProcessResult {
    company_id?: string;
  }
}

export type IngressOptions = {
  client?: SupabaseClient;
};

export interface DurableInteractionMatch {
  id: string;
  conversation_id: string;
  customer_id: string;
  customer_name?: string;
  channel?: InboxChannel;
}

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================================
// Idempotency & Deduplication Cache
// Tuân thủ SUPABASE_RLS_DESIGN.md (Mục 21: Chống ghi trùng & Replay Protection)
// ============================================================================
const processedEventIds = new Set<string>();
const processedResults = new Map<string, IngressProcessResult>();
const MAX_CACHE_SIZE = 10000;



// ============================================================================
// ADAPTER 3: SYSTEM / INTERNAL NORMALIZED ADAPTER
// Chuyên biệt cho các sự kiện nội bộ đã được tiền chuẩn hóa hoặc qua pipeline
// ============================================================================

export function verifySystemSignature(
  _rawBody: string,
  signature: string | null | undefined,
  secret: string | null | undefined
): WebhookVerificationResult {
  if (!secret || !secret.trim()) {
    return { valid: false, reason: 'Chưa cấu hình System secret trên máy chủ' };
  }
  if (!signature || !signature.trim()) {
    return { valid: false, reason: 'Thiếu header xác thực hệ thống' };
  }
  const cleanSig = signature.trim();
  const cleanSecret = secret.trim();
  if (cleanSig.length !== cleanSecret.length) {
    return { valid: false, reason: 'Chữ ký hệ thống không hợp lệ' };
  }
  const isValid = crypto.timingSafeEqual(Buffer.from(cleanSig), Buffer.from(cleanSecret));
  return { valid: isValid, reason: isValid ? undefined : 'Xác thực hệ thống thất bại' };
}

export interface SystemWebhookPayload {
  provider?: 'SYSTEM' | 'FACEBOOK' | 'ZALO';
  company_id?: string;
  external_user_id?: string;
  sender_name?: string;
  sender_phone?: string;
  sender?: { id?: string; name?: string; phone?: string };
  message_id?: string;
  content?: string;
  message?: { id?: string; text?: string };
  timestamp?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export function parseSystemWebhookToNormalized(
  body: Record<string, unknown>,
  resolvedCompanyId: string
): NormalizedIngressEvent {
  const payload = body as unknown as SystemWebhookPayload;
  return {
    provider: payload.provider || 'SYSTEM',
    company_id: resolvedCompanyId.trim(),
    external_user_id: payload.external_user_id || payload.sender?.id || 'system_user',
    sender_name: payload.sender_name || payload.sender?.name,
    sender_phone: payload.sender_phone || payload.sender?.phone,
    message_id: payload.message_id || payload.message?.id || `sys-${Date.now()}`,
    content: (payload.content || payload.message?.text || '').trim(),
    timestamp: payload.timestamp || new Date().toISOString(),
    metadata: payload.metadata,
  };
}

export const SystemAdapter: ProviderWebhookAdapter<Record<string, unknown>> = {
  provider: 'SYSTEM',
  verifySignature: verifySystemSignature,
  deriveTenant: (body: Record<string, unknown> | string) =>
    typeof body === 'object' && body !== null && typeof body.company_id === 'string'
      ? body.company_id
      : null,
  parseToNormalized: parseSystemWebhookToNormalized,
};



/**
 * Kiểm tra tính trùng lặp sự kiện (Idempotency) theo namespaced key
 */
export function isDuplicateEvent(
  keyOrEventId: string,
  companyId?: string,
  provider: 'FACEBOOK' | 'ZALO' | 'SYSTEM' = 'FACEBOOK'
): boolean {
  if (companyId) {
    const namespacedKey = `${provider}:${companyId.trim()}:${keyOrEventId.trim()}`;
    return processedEventIds.has(namespacedKey);
  }
  return processedEventIds.has(keyOrEventId);
}

/**
 * L2 Durable Check: Kiểm tra sự tồn tại bền vững của interaction tại Database
 * dựa trên (company_id, channel, external_ref = message_id) tuân thủ
 * ràng buộc UNIQUE uq_interactions_company_channel_ext_ref trong Foundation.
 *
 * Đảm bảo khi restart process (RAM cache rỗng), tin nhắn cũ vẫn được nhận diện là trùng lặp.
 */
export async function findExistingInteractionDurable(
  companyId: string,
  channel: InboxChannel,
  messageId: string,
  client?: SupabaseClient
): Promise<DurableInteractionMatch | null> {
  const cleanCompanyId = companyId.trim();
  const cleanMsgId = messageId.trim();
  const dbChannel = channel === 'zalo' ? 'ZALO' : 'FACEBOOK';

  // 1. Kiểm tra CSDL qua Supabase Client
  let adminClient = client;
  if (!adminClient) {
    try {
      adminClient = createAdminClient();
    } catch {
      adminClient = undefined;
    }
  }

  if (adminClient) {
    try {
      // 1a. Tra cứu theo (company_id, channel, external_ref) - Tận dụng index UNIQUE uq_interactions_company_channel_ext_ref
      const { data: byExtRef, error: errExtRef } = await adminClient
        .from('interactions')
        .select('id, conversation_id, customer_id, channel, external_ref')
        .eq('company_id', cleanCompanyId)
        .eq('channel', dbChannel)
        .eq('external_ref', cleanMsgId)
        .maybeSingle();

      if (!errExtRef && byExtRef) {
        return {
          id: byExtRef.id,
          conversation_id: byExtRef.conversation_id,
          customer_id: byExtRef.customer_id,
          channel,
        };
      }

      // 1b. Nếu messageId là UUID hợp lệ, tra cứu theo id của bảng interactions
      if (UUID_REGEX.test(cleanMsgId)) {
        const { data: byId, error: errId } = await adminClient
          .from('interactions')
          .select('id, conversation_id, customer_id, channel, external_ref')
          .eq('company_id', cleanCompanyId)
          .eq('channel', dbChannel)
          .eq('id', cleanMsgId)
          .maybeSingle();

        if (!errId && byId) {
          return {
            id: byId.id,
            conversation_id: byId.conversation_id,
            customer_id: byId.customer_id,
            channel,
          };
        }
      }

    } catch {
      // Bỏ qua lỗi kết nối CSDL và tiếp tục kiểm tra fallback
    }
  }

  // 2. Tra cứu bền vững trong chế độ DEMO_MODE (bảo toàn qua các lần xóa L1 RAM cache)
  if (process.env.DEMO_MODE === 'true') {
    try {
      const conversations = await InboxService.getConversations(cleanCompanyId);
      for (const conv of conversations) {
        if (conv.channel === channel) {
          const messages = await InboxService.getMessagesByConversationId(
            cleanCompanyId,
            conv.id,
            'BOSS_ADMIN'
          );
          const matched = messages.find((m) => m.id === cleanMsgId);
          if (matched) {
            return {
              id: matched.id,
              conversation_id: conv.id,
              customer_id: conv.customer_id,
              customer_name: conv.customer_name,
              channel,
            };
          }
        }
      }
    } catch {
      // Bỏ qua lỗi trong demo store lookup
    }
  }

  return null;
}

/**
 * Kiểm tra tính trùng lặp sự kiện bất đồng bộ phối hợp L1 Cache và L2 Database Lookup
 */
export async function isDuplicateEventAsync(
  keyOrEventId: string,
  companyId: string,
  provider: 'FACEBOOK' | 'ZALO' | 'SYSTEM' = 'FACEBOOK',
  client?: SupabaseClient
): Promise<boolean> {
  const namespacedKey = `${provider}:${companyId.trim()}:${keyOrEventId.trim()}`;
  if (processedEventIds.has(namespacedKey)) {
    return true;
  }
  const channel: InboxChannel = provider === 'ZALO' ? 'zalo' : 'facebook';
  const match = await findExistingInteractionDurable(companyId, channel, keyOrEventId, client);
  return match !== null;
}

// ============================================================================
// CORE INGESTION ENGINE (Trách nhiệm kiến trúc của Member 2)
// Quản lý: Normalized Ingress Contract, Idempotency, Ingest-time Sanitization, Tenant Isolation
// ============================================================================

/**
 * Chuẩn hóa Hợp đồng Tiếp nhận (Normalized Ingress Contract do Member 2 sở hữu).
 * Tiếp nhận NormalizedIngressEvent hợp lệ từ các Adapter (Member 3 Zalo / Member 4 Facebook).
 */
export async function ingestNormalizedEvent(
  event: NormalizedIngressEvent,
  optionsOrClient?: IngressOptions | SupabaseClient
): Promise<IngressProcessResult> {
  if (!event) {
    return {
      success: false,
      error: 'Thiếu dữ liệu sự kiện NormalizedIngressEvent.',
    };
  }

  const passedClient: SupabaseClient | undefined =
    optionsOrClient && 'from' in optionsOrClient
      ? (optionsOrClient as SupabaseClient)
      : (optionsOrClient as IngressOptions)?.client;

  // Kiểm tra cụ thể cho kênh FACEBOOK và ZALO (Lỗi P0 số 3: Tenant Authority)
  const eventRecord = event as unknown as Record<string, unknown>;
  const eventChannel = (
    (typeof eventRecord.channel === 'string' ? eventRecord.channel : '') ||
    event.provider ||
    ''
  ).toUpperCase();
  if (eventChannel === 'FACEBOOK' || eventChannel === 'ZALO') {
    if (!event.company_id || typeof event.company_id !== 'string' || !event.company_id.trim()) {
      return {
        success: false,
        error: 'MISSING_COMPANY_ID',
      };
    }
  }

  // Khẳng định company_id không được phép để trống và phải là UUID hợp lệ (Fail-Closed)
  // Tuyệt đối không tự suy đoán hoặc fallback về DEFAULT_COMPANY_ID
  if (!event.company_id || typeof event.company_id !== 'string' || !event.company_id.trim()) {
    return {
      success: false,
      error: 'MISSING_COMPANY_ID',
    };
  }

  const cleanCompanyId = event.company_id.trim();
  if (!UUID_REGEX.test(cleanCompanyId)) {
    return {
      success: false,
      error: 'MISSING_COMPANY_ID',
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

  const channel: InboxChannel = event.provider === 'ZALO' ? 'zalo' : 'facebook';

  // Lỗi P0 số 5: Tạo Namespaced Idempotency Key chống đụng độ giữa các tenant
  const idempotencyKey = `${event.provider}:${cleanCompanyId}:${event.message_id.trim()}`;

  // ============================================================================
  // TẦNG 1 (L1 CACHE): Kiểm tra nhanh qua in-memory cache
  // ============================================================================
  if (isDuplicateEvent(idempotencyKey)) {
    const cached = processedResults.get(idempotencyKey);
    if (cached) {
      // Bảo vệ Tenant Isolation trong kết quả Duplicate:
      // Tuyệt đối không trả về conversation_id hay customer_id thuộc tenant khác
      if (cached.company_id && cached.company_id !== cleanCompanyId) {
        return {
          success: true,
          duplicate: true,
          message_id: event.message_id,
          company_id: cleanCompanyId,
          channel,
        };
      }

      return {
        ...cached,
        duplicate: true,
        company_id: cleanCompanyId,
      };
    }
    return {
      success: true,
      duplicate: true,
      message_id: event.message_id,
      company_id: cleanCompanyId,
      channel,
    };
  }

  // ============================================================================
  // TẦNG 2 (L2 DURABLE DB CHECK): Kiểm tra bền vững tại CSDL nếu L1 Cache Miss
  // Tuân thủ Lỗi P0 số 2: Chuyển Idempotency sang Database Durable Invariant.
  // Khi restart process / RAM rỗng, sự kiện trùng lặp vẫn được phát hiện qua CSDL.
  // ============================================================================
  const durableMatch = await findExistingInteractionDurable(
    cleanCompanyId,
    channel,
    event.message_id,
    passedClient
  );

  if (durableMatch) {
    const durableResult: IngressProcessResult = {
      success: true,
      duplicate: true,
      conversation_id: durableMatch.conversation_id,
      message_id: event.message_id,
      customer_id: durableMatch.customer_id,
      customer_name: durableMatch.customer_name,
      channel,
      company_id: cleanCompanyId,
    };

    // Cập nhật ngược lại vào L1 cache để tối ưu hóa hiệu năng đọc cho các lần gọi tiếp theo
    if (processedEventIds.size >= MAX_CACHE_SIZE) {
      const firstKey = processedEventIds.values().next().value;
      if (firstKey) {
        processedEventIds.delete(firstKey);
        processedResults.delete(firstKey);
      }
    }
    processedEventIds.add(idempotencyKey);
    processedResults.set(idempotencyKey, durableResult);

    return durableResult;
  }

  try {
    // Ingress Sanitization: Làm sạch ngay tại thời điểm tiếp nhận (Zero-Phone Security Zone)
    const rawContent = event.content.trim();

    // Thêm tin nhắn và cập nhật/tạo mới cuộc hội thoại với đúng company_id (tự động phân tách raw/sanitized)
    // Lưu externalMessageId vào CSDL (external_ref và source_metadata) để phục vụ L2 Durable Idempotency
    let result;
    try {
      result = await InboxService.addInboundMessage({
        channel,
        senderId: event.external_user_id,
        company_id: cleanCompanyId,
        senderName: event.sender_name,
        senderPhone: event.sender_phone,
        content: rawContent,
        timestamp: event.timestamp || new Date().toISOString(),
        externalMessageId: event.message_id,
      }, passedClient);
    } catch (insertErr: unknown) {
      // Xử lý xung đột ghi đồng thời (Concurrent Race Condition) vi phạm UNIQUE index uq_interactions_company_channel_ext_ref
      const errObj = insertErr as { message?: string; code?: string } | undefined;
      const errMsg = String(errObj?.message || '');
      if (
        errMsg.includes('uq_interactions_company_channel_ext_ref') ||
        errMsg.includes('duplicate key') ||
        errMsg.includes('unique constraint') ||
        errObj?.code === '23505'
      ) {
        const concurrentMatch = await findExistingInteractionDurable(
          cleanCompanyId,
          channel,
          event.message_id,
          passedClient
        );
        if (concurrentMatch) {
          const concurrentResult: IngressProcessResult = {
            success: true,
            duplicate: true,
            conversation_id: concurrentMatch.conversation_id,
            message_id: event.message_id,
            customer_id: concurrentMatch.customer_id,
            customer_name: concurrentMatch.customer_name,
            channel,
            company_id: cleanCompanyId,
          };
          processedEventIds.add(idempotencyKey);
          processedResults.set(idempotencyKey, concurrentResult);
          return concurrentResult;
        }
      }
      throw insertErr;
    }

    const processResult: IngressProcessResult = {
      success: true,
      duplicate: false,
      conversation_id: result.conversation.id,
      message_id: result.message.id,
      customer_id: result.conversation.customer_id,
      customer_name: result.conversation.customer_name,
      channel,
      is_new_conversation: result.isNewConversation,
      company_id: cleanCompanyId,
    };

    // Lưu vào bộ nhớ cache Idempotent theo namespaced idempotencyKey
    if (processedEventIds.size >= MAX_CACHE_SIZE) {
      const firstKey = processedEventIds.values().next().value;
      if (firstKey) {
        processedEventIds.delete(firstKey);
        processedResults.delete(firstKey);
      }
    }

    processedEventIds.add(idempotencyKey);
    processedResults.set(idempotencyKey, processResult);

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
 * Wrapper tương thích cho OmnichannelWebhookPayload
 */
export async function processInboundWebhook(
  payload: OmnichannelWebhookPayload,
  optionsOrClient?: IngressOptions | SupabaseClient
): Promise<IngressProcessResult> {
  if (!payload || !payload.event_id) {
    return {
      success: false,
      error: 'Thiếu event_id trong payload webhook.',
    };
  }

  if (!payload.company_id || typeof payload.company_id !== 'string' || !payload.company_id.trim()) {
    return {
      success: false,
      error: 'MISSING_COMPANY_ID',
    };
  }

  const provider: 'FACEBOOK' | 'ZALO' | 'SYSTEM' =
    payload.channel === 'zalo' ? 'ZALO' : 'FACEBOOK';

  return ingestNormalizedEvent({
    provider,
    company_id: payload.company_id.trim(),
    external_user_id: payload.sender?.id || 'anon_user',
    sender_name: payload.sender?.name,
    sender_phone: payload.sender?.phone,
    message_id: payload.message?.id || payload.event_id,
    content: payload.message?.text || '',
    timestamp: payload.message?.timestamp || new Date().toISOString(),
    metadata: payload.metadata,
  }, optionsOrClient);
}

/**
 * Helper dọn dẹp cache cho kiểm thử tự động
 */
export function resetIngressCache(): void {
  processedEventIds.clear();
  processedResults.clear();
}

export const InboxIngressService = {
  // Core Ingestion Engine (Member 2 Authority)
  ingestNormalizedEvent,
  isDuplicateEvent,
  isDuplicateEventAsync,
  findExistingInteractionDurable,
  processInboundWebhook,
  resetIngressCache,

  // System Internal Adapter
  SystemAdapter,
  verifySystemSignature,
  parseSystemWebhookToNormalized,
};
