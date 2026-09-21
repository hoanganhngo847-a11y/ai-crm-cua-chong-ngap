import * as crypto from 'crypto';
import type { InboxChannel } from '../types/inbox.types';
import type {
  OmnichannelWebhookPayload,
  NormalizedIngressEvent,
  IngressProcessResult,
  WebhookVerificationResult,
  FacebookWebhookEnvelope,
  ZaloWebhookEnvelope,
  ProviderWebhookAdapter,
} from '../types/webhook.types';
import { InboxService } from './inbox.service';
import { sanitizePhoneInText } from '../../crm/utils/phone-sanitizer';

declare module '../types/webhook.types' {
  interface IngressProcessResult {
    company_id?: string;
  }
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
// ADAPTER 1: FACEBOOK MESSENGER ADAPTER (Ranh giới bàn giao cho Member 4)
// Chuyên biệt giải mã envelope, xác thực chữ ký HMAC Facebook và derive tenant Page ID
// ============================================================================

/**
 * Xác thực chữ ký số Facebook Messenger (x-hub-signature-256 = sha256=<hex>)
 */
export function verifyFacebookSignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string | null | undefined
): WebhookVerificationResult {
  // Fail-closed: Thiếu secret trong env phải từ chối ngay lập tức, không bypass
  if (!secret || !secret.trim()) {
    return {
      valid: false,
      reason: 'Chưa cấu hình Facebook Webhook secret trên hệ thống (Configuration Error)',
    };
  }

  // Fail-closed: Thiếu header chữ ký
  if (!signature || !signature.trim()) {
    return {
      valid: false,
      reason: 'Thiếu header chữ ký số xác thực Facebook (Missing Signature Header)',
    };
  }

  try {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(rawBody);
    const expectedSignature = 'sha256=' + hmac.digest('hex');

    const cleanSig = signature.trim();
    const sigBuffer = Buffer.from(cleanSig);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (sigBuffer.length !== expectedBuffer.length) {
      return { valid: false, reason: 'Độ dài chữ ký Facebook không hợp lệ' };
    }

    const isValid = crypto.timingSafeEqual(sigBuffer, expectedBuffer);
    return { valid: isValid, reason: isValid ? undefined : 'Chữ ký số Facebook không khớp' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Lỗi xác thực chữ ký Facebook';
    return { valid: false, reason: msg };
  }
}

/**
 * Phân giải tenant (company_id) từ Facebook Page ID
 */
export function deriveFacebookTenant(pageIdOrEnvelope: string | FacebookWebhookEnvelope): string | null {
  let cleanId: string | null = null;

  if (typeof pageIdOrEnvelope === 'string') {
    cleanId = pageIdOrEnvelope.trim();
  } else if (pageIdOrEnvelope && typeof pageIdOrEnvelope === 'object') {
    cleanId =
      pageIdOrEnvelope.entry?.[0]?.id ||
      pageIdOrEnvelope.entry?.[0]?.messaging?.[0]?.recipient?.id ||
      pageIdOrEnvelope.recipient?.id ||
      pageIdOrEnvelope.page_id ||
      null;
    if (cleanId) cleanId = String(cleanId).trim();
  }

  if (!cleanId) return null;

  // 1. Kiểm tra JSON mapping FB_PAGE_TENANT_MAP
  if (process.env.FB_PAGE_TENANT_MAP) {
    try {
      const map = JSON.parse(process.env.FB_PAGE_TENANT_MAP);
      if (map && typeof map === 'object' && map[cleanId]) {
        return String(map[cleanId]).trim();
      }
    } catch {
      // Fail-safe
    }
  }

  // 2. Kiểm tra biến môi trường đơn lẻ FB_PAGE_ID & FB_COMPANY_ID (Xóa bỏ hoàn toàn fallback)
  if (process.env.FB_PAGE_ID && process.env.FB_PAGE_ID.trim() === cleanId) {
    const companyId = process.env.FB_COMPANY_ID;
    if (companyId && companyId.trim()) {
      return companyId.trim();
    }
  }

  return null;
}

/**
 * Trích xuất và chuyển đổi Facebook Webhook Envelope sang NormalizedIngressEvent
 */
export function parseFacebookWebhookToNormalized(
  body: any,
  resolvedCompanyId: string
): NormalizedIngressEvent {
  const entry = body.entry?.[0];
  const messaging = entry?.messaging?.[0];

  const externalUserId =
    messaging?.sender?.id || body.external_user_id || body.sender?.id || 'fb-anon-user';
  const messageId =
    messaging?.message?.mid || body.message_id || body.message?.id || `fb-msg-${Date.now()}`;
  const content =
    messaging?.message?.text || body.content || body.message?.text || '(Tin nhắn hình ảnh/tệp)';
  const senderName =
    body.sender_name || body.sender?.name || messaging?.sender?.name || 'Khách hàng Facebook';
  const senderPhone = body.sender_phone || body.sender?.phone;

  let timestamp = new Date().toISOString();
  if (messaging?.timestamp) {
    timestamp = new Date(messaging.timestamp).toISOString();
  } else if (body.timestamp) {
    timestamp = new Date(body.timestamp).toISOString();
  }

  return {
    provider: 'FACEBOOK',
    company_id: resolvedCompanyId.trim(),
    external_user_id: externalUserId,
    sender_name: senderName,
    sender_phone: senderPhone,
    message_id: messageId,
    content: content.trim(),
    timestamp,
    metadata: body.metadata || { entry_id: entry?.id },
  };
}

export const FacebookAdapter: ProviderWebhookAdapter<FacebookWebhookEnvelope> = {
  provider: 'FACEBOOK',
  verifySignature: verifyFacebookSignature,
  deriveTenant: deriveFacebookTenant,
  parseToNormalized: parseFacebookWebhookToNormalized,
};

// ============================================================================
// ADAPTER 2: ZALO OFFICIAL ACCOUNT ADAPTER (Ranh giới bàn giao cho Member 3)
// Chuyên biệt giải mã envelope, xác thực chữ ký HMAC Zalo và derive tenant OA ID
// ============================================================================

/**
 * Xác thực chữ ký số Zalo OA (x-zalo-signature hoặc mac = HMAC-SHA256 hex)
 */
export function verifyZaloSignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string | null | undefined
): WebhookVerificationResult {
  // Fail-closed: Thiếu secret trong env phải từ chối ngay lập tức
  if (!secret || !secret.trim()) {
    return {
      valid: false,
      reason: 'Chưa cấu hình Zalo Webhook secret trên hệ thống (Configuration Error)',
    };
  }

  // Fail-closed: Thiếu header chữ ký
  if (!signature || !signature.trim()) {
    return {
      valid: false,
      reason: 'Thiếu header chữ ký số xác thực Zalo (Missing Signature Header)',
    };
  }

  try {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(rawBody);
    const expectedSignature = hmac.digest('hex');

    const cleanSig = signature.trim().replace(/^sha256=/, '');
    const sigBuffer = Buffer.from(cleanSig);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (sigBuffer.length !== expectedBuffer.length) {
      return { valid: false, reason: 'Độ dài chữ ký Zalo không hợp lệ' };
    }

    const isValid = crypto.timingSafeEqual(sigBuffer, expectedBuffer);
    return { valid: isValid, reason: isValid ? undefined : 'Chữ ký số Zalo không khớp' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Lỗi xác thực chữ ký Zalo';
    return { valid: false, reason: msg };
  }
}

/**
 * Phân giải tenant (company_id) từ Zalo OA ID
 */
export function deriveZaloTenant(oaIdOrEnvelope: string | ZaloWebhookEnvelope): string | null {
  let cleanId: string | null = null;

  if (typeof oaIdOrEnvelope === 'string') {
    cleanId = oaIdOrEnvelope.trim();
  } else if (oaIdOrEnvelope && typeof oaIdOrEnvelope === 'object') {
    cleanId = oaIdOrEnvelope.oa_id || oaIdOrEnvelope.recipient?.id || null;
    if (cleanId) cleanId = String(cleanId).trim();
  }

  if (!cleanId) return null;

  // 1. Kiểm tra JSON mapping ZALO_OA_TENANT_MAP
  if (process.env.ZALO_OA_TENANT_MAP) {
    try {
      const map = JSON.parse(process.env.ZALO_OA_TENANT_MAP);
      if (map && typeof map === 'object' && map[cleanId]) {
        return String(map[cleanId]).trim();
      }
    } catch {
      // Fail-safe
    }
  }

  // 2. Kiểm tra biến môi trường đơn lẻ ZALO_OA_ID & ZALO_COMPANY_ID (Xóa bỏ hoàn toàn fallback)
  if (process.env.ZALO_OA_ID && process.env.ZALO_OA_ID.trim() === cleanId) {
    const companyId = process.env.ZALO_COMPANY_ID;
    if (companyId && companyId.trim()) {
      return companyId.trim();
    }
  }

  return null;
}

/**
 * Trích xuất và chuyển đổi Zalo OA Webhook Envelope sang NormalizedIngressEvent
 */
export function parseZaloWebhookToNormalized(
  body: any,
  resolvedCompanyId: string
): NormalizedIngressEvent {
  const externalUserId =
    body.sender?.id || body.user_id_by_app || body.external_user_id || 'zalo-anon-user';
  const messageId =
    body.message?.msg_id || body.msg_id || body.message_id || `zalo-msg-${Date.now()}`;
  const content =
    body.message?.text || body.content || '(Tin nhắn Zalo)';
  const senderName =
    body.sender?.name || body.sender_name || 'Khách hàng Zalo';
  const senderPhone = body.sender?.phone || body.sender_phone;

  let timestamp = new Date().toISOString();
  if (body.timestamp) {
    timestamp = new Date(body.timestamp).toISOString();
  }

  return {
    provider: 'ZALO',
    company_id: resolvedCompanyId.trim(),
    external_user_id: externalUserId,
    sender_name: senderName,
    sender_phone: senderPhone,
    message_id: messageId,
    content: content.trim(),
    timestamp,
    metadata: body.metadata || { event_name: body.event_name, oa_id: body.oa_id },
  };
}

export const ZaloAdapter: ProviderWebhookAdapter<ZaloWebhookEnvelope> = {
  provider: 'ZALO',
  verifySignature: verifyZaloSignature,
  deriveTenant: deriveZaloTenant,
  parseToNormalized: parseZaloWebhookToNormalized,
};

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

export function parseSystemWebhookToNormalized(
  body: any,
  resolvedCompanyId: string
): NormalizedIngressEvent {
  return {
    provider: body.provider || 'SYSTEM',
    company_id: resolvedCompanyId.trim(),
    external_user_id: body.external_user_id || body.sender?.id || 'system_user',
    sender_name: body.sender_name || body.sender?.name,
    sender_phone: body.sender_phone || body.sender?.phone,
    message_id: body.message_id || body.message?.id || `sys-${Date.now()}`,
    content: (body.content || body.message?.text || '').trim(),
    timestamp: body.timestamp || new Date().toISOString(),
    metadata: body.metadata,
  };
}

export const SystemAdapter: ProviderWebhookAdapter = {
  provider: 'SYSTEM',
  verifySignature: verifySystemSignature,
  deriveTenant: (body: any) => body.company_id || null,
  parseToNormalized: parseSystemWebhookToNormalized,
};

// ============================================================================
// FACADES FOR BACKWARD COMPATIBILITY
// ============================================================================

/**
 * Facade xác thực chữ ký số webhook tổng hợp
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string | null | undefined,
  channel: InboxChannel
): WebhookVerificationResult {
  if (channel === 'facebook') {
    return verifyFacebookSignature(rawBody, signature, secret);
  } else if (channel === 'zalo') {
    return verifyZaloSignature(rawBody, signature, secret);
  }
  return { valid: false, reason: 'Kênh không hỗ trợ xác thực chữ ký số' };
}

/**
 * Facade ánh xạ tài khoản tích hợp (Facebook Page ID / Zalo OA ID) sang Tenant (company_id)
 */
export function deriveTenantFromIntegrationAccount(
  provider: 'FACEBOOK' | 'ZALO' | 'SYSTEM',
  accountId: string | null | undefined
): string | null {
  if (!accountId || typeof accountId !== 'string' || !accountId.trim()) {
    return null;
  }
  if (provider === 'FACEBOOK') {
    return deriveFacebookTenant(accountId);
  }
  if (provider === 'ZALO') {
    return deriveZaloTenant(accountId);
  }
  return null;
}

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

// ============================================================================
// CORE INGESTION ENGINE (Trách nhiệm kiến trúc của Member 2)
// Quản lý: Normalized Ingress Contract, Idempotency, Ingest-time Sanitization, Tenant Isolation
// ============================================================================

/**
 * Chuẩn hóa Hợp đồng Tiếp nhận (Normalized Ingress Contract do Member 2 sở hữu).
 * Tiếp nhận NormalizedIngressEvent hợp lệ từ các Adapter (Member 3 Zalo / Member 4 Facebook).
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

  // Bắt buộc kiểm tra tenant isolation và định dạng UUID an toàn từ tầng adapter mapping (Fail-Closed)
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

  // Chống ghi trùng lặp (Idempotency) theo namespaced idempotencyKey
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

  try {
    // Ingress Sanitization: Làm sạch ngay tại thời điểm tiếp nhận (Zero-Phone Security Zone)
    const rawContent = event.content.trim();
    const sanitizedContent = sanitizePhoneInText(rawContent);

    // Thêm tin nhắn và cập nhật/tạo mới cuộc hội thoại với đúng company_id (tự động phân tách raw/sanitized)
    const result = await InboxService.addInboundMessage({
      channel,
      senderId: event.external_user_id,
      company_id: cleanCompanyId,
      senderName: event.sender_name,
      senderPhone: event.sender_phone,
      content: rawContent,
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
  payload: OmnichannelWebhookPayload
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
  // Core Ingestion Engine (Member 2 Authority)
  ingestNormalizedEvent,
  isDuplicateEvent,
  processInboundWebhook,
  resetIngressCache,

  // Adapters
  adapters: {
    facebook: FacebookAdapter,
    zalo: ZaloAdapter,
    system: SystemAdapter,
  },
  FacebookAdapter,
  ZaloAdapter,
  SystemAdapter,

  // Facades & Handover Helpers
  verifyFacebookSignature,
  deriveFacebookTenant,
  parseFacebookWebhookToNormalized,
  verifyZaloSignature,
  deriveZaloTenant,
  parseZaloWebhookToNormalized,
  verifyWebhookSignature,
  deriveTenantFromIntegrationAccount,
};
