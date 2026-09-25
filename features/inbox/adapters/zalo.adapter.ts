/**
 * ZALO OFFICIAL ACCOUNT (OA) REFERENCE ADAPTER PORT
 *
 * ============================================================================
 * ARCHITECTURAL OWNERSHIP & CONTRACT BOUNDARY
 * ============================================================================
 * - Member 2: Sở hữu Ingress Engine, Webhook Gateway Dispatcher và ProviderAdapterPort Interface.
 * - Member 3: Sở hữu Zalo OA Integration và cài đặt chính thức của ZaloAdapter.
 *
 * File này định nghĩa Reference Adapter Port cho Zalo OA Ingress,
 * đóng vai trò contract stub để compile và test ở TV2; implementation chính thức
 * thuộc quyền sở hữu của Member 3 khi tích hợp vào nhánh main.
 *
 * Thực thi nghiêm ngặt theo đúng ProviderAdapterPort<ZaloWebhookEnvelope>.
 */

import * as crypto from 'crypto';
import {
  type NormalizedIngressEvent,
  type WebhookVerificationResult,
  type ZaloWebhookEnvelope,
  type ProviderAdapterPort,
  ProviderAdapterRegistry,
  INGRESS_PROVIDERS,
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
 * Zalo Reference Adapter Port bàn giao cho Member 3
 */
export const ZaloAdapter: ProviderAdapterPort<ZaloWebhookEnvelope> = {
  provider: INGRESS_PROVIDERS.ZALO,
  verifySignature: async (rawPayload: string, headers: Record<string, string>): Promise<WebhookVerificationResult> => {
    const signature =
      headers['x-zalo-signature'] ||
      headers['X-Zalo-Signature'] ||
      headers['mac'] ||
      headers['MAC'] ||
      null;
    const secret = process.env.ZALO_APP_SECRET || process.env.ZALO_WEBHOOK_SECRET;
    return verifyZaloSignature(rawPayload, signature, secret);
  },
  deriveTenant: async (envelope: ZaloWebhookEnvelope | string): Promise<string> => {
    let cleanId: string | null = null;
    if (typeof envelope === 'string') {
      cleanId = envelope.trim();
    } else if (envelope && typeof envelope === 'object') {
      cleanId =
        envelope.oa_id ||
        envelope.recipient?.id ||
        envelope.metadata?.oa_id ||
        envelope.external_id ||
        null;
      if (cleanId) cleanId = String(cleanId).trim();
    }

    if (!cleanId) {
      const err = new Error('Không tìm thấy Zalo OA ID hợp lệ trong payload webhook (Fail-Closed).');
      (err as any).code = 'INVALID_TENANT_DERIVATION';
      (err as any).status = 400;
      throw err;
    }

    const companyId = deriveZaloTenant(cleanId);
    if (!companyId) {
      const err = new Error(`Zalo OA ID "${cleanId}" chưa được cấu hình liên kết với bất kỳ tổ chức (tenant) nào trên hệ thống (Fail-Closed).`);
      (err as any).code = 'TENANT_NOT_CONFIGURED';
      (err as any).status = 403;
      throw err;
    }

    return companyId;
  },
  parseToNormalized: async (
    envelope: ZaloWebhookEnvelope | any,
    companyId: string
  ): Promise<NormalizedIngressEvent[]> => {
    return [parseZaloWebhookToNormalized(envelope, companyId)];
  },
};

// Đăng ký ZaloAdapter vào ProviderAdapterRegistry
ProviderAdapterRegistry.register(INGRESS_PROVIDERS.ZALO, ZaloAdapter);

export default ZaloAdapter;
