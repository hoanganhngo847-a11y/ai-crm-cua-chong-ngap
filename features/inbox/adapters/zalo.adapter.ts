/**
 * ZALO OFFICIAL ACCOUNT (OA) WEBHOOK ADAPTER
 * 
 * ============================================================================
 * ARCHITECTURAL OWNERSHIP: MEMBER 3 (Zalo OA Integration Specialist)
 * ============================================================================
 * 
 * Trách nhiệm của Member 3:
 * 1. Giải mã Zalo Official Account Webhook Envelope (oa_id, event_name, sender, message).
 * 2. Xác thực chữ ký số HMAC-SHA256 (x-zalo-signature hoặc mac) chuẩn Zalo Developer Platform.
 * 3. Phân giải Tenant (company_id) an toàn từ Zalo OA ID (Fail-Closed).
 * 4. Chuyển đổi payload sang hợp đồng dữ liệu chuẩn NormalizedIngressEvent để bàn giao
 *    cho Core Ingestion Engine của Member 2.
 */

import * as crypto from 'crypto';
import type {
  NormalizedIngressEvent,
  WebhookVerificationResult,
  ZaloWebhookEnvelope,
  ProviderWebhookAdapter,
} from '../types/webhook.types';

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

/**
 * Zalo Adapter bàn giao cho Member 3
 */
export const ZaloAdapter: ProviderWebhookAdapter<ZaloWebhookEnvelope> = {
  provider: 'ZALO',
  verifySignature: verifyZaloSignature,
  deriveTenant: deriveZaloTenant,
  parseToNormalized: parseZaloWebhookToNormalized,
};

export default ZaloAdapter;
