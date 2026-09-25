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
 * Trích xuất và chuyển đổi Zalo OA Webhook Envelope sang NormalizedIngressEvent
 */
export function parseZaloWebhookToNormalized(
  body: Record<string, unknown>,
  resolvedCompanyId: string
): NormalizedIngressEvent {
  const zalo = body as ZaloWebhookEnvelope;
  const externalUserId =
    zalo.sender?.id ||
    (typeof zalo.user_id_by_app === 'string' ? zalo.user_id_by_app : undefined) ||
    (typeof zalo.external_user_id === 'string' ? zalo.external_user_id : undefined) ||
    'zalo-anon-user';
  const messageId =
    zalo.message?.msg_id ||
    (typeof zalo.msg_id === 'string' ? zalo.msg_id : undefined) ||
    (typeof zalo.message_id === 'string' ? zalo.message_id : undefined) ||
    `zalo-msg-${Date.now()}`;
  const content =
    zalo.message?.text ||
    (typeof zalo.content === 'string' ? zalo.content : undefined) ||
    '(Tin nhắn Zalo)';
  const senderName =
    zalo.sender?.name ||
    (typeof zalo.sender_name === 'string' ? zalo.sender_name : undefined) ||
    'Khách hàng Zalo';
  const senderPhone =
    zalo.sender?.phone ||
    (typeof zalo.sender_phone === 'string' ? zalo.sender_phone : undefined);

  let timestamp = new Date().toISOString();
  if (typeof zalo.timestamp === 'string' || typeof zalo.timestamp === 'number') {
    timestamp = new Date(zalo.timestamp).toISOString();
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
    metadata: (zalo.metadata as Record<string, unknown> | undefined) || {
      event_name: zalo.event_name,
      oa_id: zalo.oa_id,
    },
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
      const zalo = envelope as ZaloWebhookEnvelope;
      cleanId =
        zalo.oa_id ||
        zalo.recipient?.id ||
        (zalo.metadata as { oa_id?: string } | undefined)?.oa_id ||
        (typeof zalo.external_id === 'string' ? zalo.external_id : null) ||
        null;
      if (cleanId) cleanId = String(cleanId).trim();
    }

    if (!cleanId) {
      throw createAdapterError(
        'Không tìm thấy Zalo OA ID hợp lệ trong payload webhook (Fail-Closed).',
        'INVALID_TENANT_DERIVATION',
        400
      );
    }

    const companyId = deriveZaloTenant(cleanId);
    if (!companyId) {
      throw createAdapterError(
        `Zalo OA ID "${cleanId}" chưa được cấu hình liên kết với bất kỳ tổ chức (tenant) nào trên hệ thống (Fail-Closed).`,
        'TENANT_NOT_CONFIGURED',
        403
      );
    }

    return companyId;
  },
  parseToNormalized: async (
    envelope: ZaloWebhookEnvelope | Record<string, unknown>,
    companyId: string
  ): Promise<NormalizedIngressEvent[]> => {
    return [parseZaloWebhookToNormalized(envelope as Record<string, unknown>, companyId)];
  },
};

// Đăng ký ZaloAdapter vào ProviderAdapterRegistry
ProviderAdapterRegistry.register(INGRESS_PROVIDERS.ZALO, ZaloAdapter);

export default ZaloAdapter;
