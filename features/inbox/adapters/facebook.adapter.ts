/**
 * FACEBOOK MESSENGER WEBHOOK ADAPTER
 * 
 * ============================================================================
 * ARCHITECTURAL OWNERSHIP: MEMBER 4 (Facebook Messenger Integration Specialist)
 * ============================================================================
 * 
 * Trách nhiệm của Member 4:
 * 1. Giải mã Facebook Messenger Webhook Envelope (entry, messaging, recipient, sender).
 * 2. Xác thực chữ ký số HMAC-SHA256 (x-hub-signature-256) chuẩn Meta Graph API.
 * 3. Phân giải Tenant (company_id) an toàn từ Facebook Page ID (Fail-Closed).
 * 4. Chuyển đổi payload sang hợp đồng dữ liệu chuẩn NormalizedIngressEvent để bàn giao
 *    cho Core Ingestion Engine của Member 2.
 */

import * as crypto from 'crypto';
import type {
  NormalizedIngressEvent,
  WebhookVerificationResult,
  FacebookWebhookEnvelope,
  ProviderWebhookAdapter,
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

/**
 * Facebook Adapter bàn giao cho Member 4
 */
export const FacebookAdapter: ProviderWebhookAdapter<FacebookWebhookEnvelope> = {
  provider: 'FACEBOOK',
  verifySignature: verifyFacebookSignature,
  deriveTenant: deriveFacebookTenant,
  parseToNormalized: parseFacebookWebhookToNormalized,
};

export default FacebookAdapter;
