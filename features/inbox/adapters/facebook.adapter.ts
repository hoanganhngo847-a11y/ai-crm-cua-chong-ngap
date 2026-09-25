/**
 * FACEBOOK MESSENGER REFERENCE ADAPTER PORT
 * 
 * ============================================================================
 * ARCHITECTURAL OWNERSHIP & CONTRACT BOUNDARY
 * ============================================================================
 * - Member 2: Sở hữu Ingress Engine, Webhook Gateway Dispatcher và ProviderAdapterPort Interface.
 * - Member 4: Sở hữu Facebook Messenger Integration và cài đặt chính thức của FacebookAdapter.
 * 
 * File này định nghĩa Reference Adapter Port cho Facebook Messenger Ingress,
 * đóng vai trò contract stub để compile và test ở TV2; implementation chính thức
 * thuộc quyền sở hữu của Member 4 khi tích hợp vào nhánh main.
 * 
 * Thực thi nghiêm ngặt theo đúng ProviderAdapterPort<FacebookWebhookEnvelope>.
 */

import * as crypto from 'crypto';
import {
  type NormalizedIngressEvent,
  type WebhookVerificationResult,
  type FacebookWebhookEnvelope,
  type ProviderAdapterPort,
  ProviderAdapterRegistry,
  INGRESS_PROVIDERS,
} from '../types/webhook.types';

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

interface AdapterError extends Error {
  code: string;
  status: number;
}

function createAdapterError(message: string, code: string, status: number): AdapterError {
  const err = new Error(message) as AdapterError;
  err.code = code;
  err.status = status;
  return err;
}

/**
 * Trích xuất và chuyển đổi Facebook Webhook Envelope sang NormalizedIngressEvent
 */
export function parseFacebookWebhookToNormalized(
  body: Record<string, unknown>,
  resolvedCompanyId: string
): NormalizedIngressEvent {
  const fb = body as FacebookWebhookEnvelope;
  const entry = fb.entry?.[0];
  const messaging = entry?.messaging?.[0];

  const externalUserId =
    messaging?.sender?.id ||
    (typeof fb.external_user_id === 'string' ? fb.external_user_id : undefined) ||
    (fb.sender as { id?: string } | undefined)?.id ||
    'fb-anon-user';
  const messageId =
    messaging?.message?.mid ||
    (typeof fb.message_id === 'string' ? fb.message_id : undefined) ||
    (fb.message as { id?: string } | undefined)?.id ||
    `fb-msg-${Date.now()}`;
  const content =
    messaging?.message?.text ||
    (typeof fb.content === 'string' ? fb.content : undefined) ||
    (fb.message as { text?: string } | undefined)?.text ||
    '(Tin nhắn hình ảnh/tệp)';
  const senderName =
    (typeof fb.sender_name === 'string' ? fb.sender_name : undefined) ||
    (fb.sender as { name?: string } | undefined)?.name ||
    messaging?.sender?.name ||
    'Khách hàng Facebook';
  const senderPhone =
    (typeof fb.sender_phone === 'string' ? fb.sender_phone : undefined) ||
    (fb.sender as { phone?: string } | undefined)?.phone;

  let timestamp = new Date().toISOString();
  if (messaging?.timestamp) {
    timestamp = new Date(messaging.timestamp).toISOString();
  } else if (typeof fb.timestamp === 'string' || typeof fb.timestamp === 'number') {
    timestamp = new Date(fb.timestamp).toISOString();
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
    metadata: (fb.metadata as Record<string, unknown> | undefined) || { entry_id: entry?.id },
  };
}

/**
 * Facebook Reference Adapter Port bàn giao cho Member 4
 */
export const FacebookAdapter: ProviderAdapterPort<FacebookWebhookEnvelope> = {
  provider: INGRESS_PROVIDERS.FACEBOOK,
  verifySignature: async (rawPayload: string, headers: Record<string, string>): Promise<WebhookVerificationResult> => {
    const signature =
      headers['x-hub-signature-256'] ||
      headers['X-Hub-Signature-256'] ||
      headers['x-hub-signature'] ||
      null;
    const secret = process.env.FACEBOOK_APP_SECRET || process.env.FB_APP_SECRET;
    return verifyFacebookSignature(rawPayload, signature, secret);
  },
  deriveTenant: async (envelope: FacebookWebhookEnvelope | string): Promise<string> => {
    let cleanId: string | null = null;
    if (typeof envelope === 'string') {
      cleanId = envelope.trim();
    } else if (envelope && typeof envelope === 'object') {
      const fb = envelope as FacebookWebhookEnvelope;
      cleanId =
        fb.page_id ||
        fb.recipient?.id ||
        fb.entry?.[0]?.messaging?.[0]?.recipient?.id ||
        fb.entry?.[0]?.id ||
        (fb.metadata as { page_id?: string; entry_id?: string } | undefined)?.page_id ||
        (fb.metadata as { page_id?: string; entry_id?: string } | undefined)?.entry_id ||
        (typeof fb.external_id === 'string' ? fb.external_id : null) ||
        null;
      if (cleanId) cleanId = String(cleanId).trim();
    }

    if (!cleanId) {
      throw createAdapterError(
        'Không tìm thấy Facebook Page ID hợp lệ trong payload webhook (Fail-Closed).',
        'INVALID_TENANT_DERIVATION',
        400
      );
    }

    const companyId = deriveFacebookTenant(cleanId);
    if (!companyId) {
      throw createAdapterError(
        `Facebook Page ID "${cleanId}" chưa được cấu hình liên kết với bất kỳ tổ chức (tenant) nào trên hệ thống (Fail-Closed).`,
        'TENANT_NOT_CONFIGURED',
        403
      );
    }

    return companyId;
  },
  parseToNormalized: async (
    envelope: FacebookWebhookEnvelope | Record<string, unknown>,
    companyId: string
  ): Promise<NormalizedIngressEvent[]> => {
    const fb = envelope as FacebookWebhookEnvelope;
    if (Array.isArray(fb.entry)) {
      const events: NormalizedIngressEvent[] = [];
      for (const entry of fb.entry) {
        if (Array.isArray(entry.messaging) && entry.messaging.length > 0) {
          for (const msg of entry.messaging) {
            events.push(parseFacebookWebhookToNormalized({ entry: [{ ...entry, messaging: [msg] }] }, companyId));
          }
        }
      }
      if (events.length > 0) return events;
    }
    return [parseFacebookWebhookToNormalized(envelope as Record<string, unknown>, companyId)];
  },
};

// Đăng ký FacebookAdapter vào ProviderAdapterRegistry
ProviderAdapterRegistry.register(INGRESS_PROVIDERS.FACEBOOK, FacebookAdapter);

export default FacebookAdapter;
