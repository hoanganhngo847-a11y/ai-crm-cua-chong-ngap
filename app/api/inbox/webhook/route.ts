import { NextRequest, NextResponse } from 'next/server';
import {
  InboxIngressService,
  verifySystemSignature,
  parseSystemWebhookToNormalized,
  UUID_REGEX,
} from '@/features/inbox/services/inbox-ingress.service';
import { FacebookAdapter } from '@/features/inbox/adapters/facebook.adapter';
import { ZaloAdapter } from '@/features/inbox/adapters/zalo.adapter';
import {
  type IngressProvider,
  type ProviderAdapterPort,
  type IngressProcessResult,
  ProviderAdapterRegistry,
  INGRESS_PROVIDERS,
} from '../../../../features/inbox/types/webhook.types';

interface RouteError extends Error {
  code?: string;
  status?: number;
}

// Reference Adapter Port cho kênh nội bộ SYSTEM
const systemAdapterPort: ProviderAdapterPort = {
  provider: INGRESS_PROVIDERS.SYSTEM,
  verifySignature: async (rawPayload: string, headers: Record<string, string>) => {
    const signature =
      headers['x-webhook-secret'] ||
      headers['x-system-signature'] ||
      headers['X-Webhook-Secret'] ||
      headers['X-System-Signature'] ||
      null;
    const secret = process.env.INBOX_WEBHOOK_SECRET || process.env.SYSTEM_WEBHOOK_SECRET;
    return verifySystemSignature(rawPayload, signature, secret);
  },
  deriveTenant: async (body: unknown) => {
    const payload = body as { company_id?: string } | undefined;
    const companyId = payload?.company_id;
    if (!companyId || typeof companyId !== 'string' || !companyId.trim()) {
      const err = new Error('Thiếu định danh công ty (company_id) trong sự kiện nội bộ SYSTEM (Fail-Closed).') as RouteError;
      err.code = 'MISSING_COMPANY_ID';
      err.status = 400;
      throw err;
    }
    return companyId.trim();
  },
  parseToNormalized: async (body: unknown, resolvedCompanyId: string) => {
    return [parseSystemWebhookToNormalized(body as Record<string, unknown>, resolvedCompanyId)];
  },
};

// Đảm bảo các reference adapter ports được đăng ký vào Registry
ProviderAdapterRegistry.register(INGRESS_PROVIDERS.FACEBOOK, FacebookAdapter);
ProviderAdapterRegistry.register(INGRESS_PROVIDERS.ZALO, ZaloAdapter);
ProviderAdapterRegistry.register(INGRESS_PROVIDERS.SYSTEM, systemAdapterPort);

/**
 * GET /api/inbox/webhook
 * Xác thực Webhook Challenge Handshake (Facebook Messenger & Zalo OA).
 *
 * Nguyên tắc Fail-Closed (P0):
 * - Thiếu biến môi trường verify token / secret: Trả về HTTP 500 CONFIGURATION_ERROR.
 *   TUYỆT ĐỐI KHÔNG dùng hard-coded token fallback.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // 1. Facebook Webhook Verification Challenge
  const hubMode = searchParams.get('hub.mode');
  const hubChallenge = searchParams.get('hub.challenge');
  const hubVerifyToken = searchParams.get('hub.verify_token');

  if (hubMode === 'subscribe' && hubChallenge) {
    const fbVerifyToken = process.env.FACEBOOK_VERIFY_TOKEN || process.env.FB_VERIFY_TOKEN;

    // Fail-Closed: Thiếu cấu hình token trên máy chủ
    if (!fbVerifyToken || !fbVerifyToken.trim()) {
      return NextResponse.json(
        {
          success: false,
          error: 'CONFIGURATION_ERROR',
          message: 'Chưa cấu hình FACEBOOK_VERIFY_TOKEN trên máy chủ (Fail-Closed).',
        },
        { status: 500 }
      );
    }

    if (hubVerifyToken === fbVerifyToken) {
      return new NextResponse(hubChallenge, { status: 200 });
    }

    return NextResponse.json(
      { success: false, error: 'FORBIDDEN', message: 'Mã xác thực token không hợp lệ.' },
      { status: 403 }
    );
  }

  // 2. Zalo OA Webhook Verification Challenge
  const zaloChallenge = searchParams.get('challenge');
  if (zaloChallenge) {
    const zaloSecret = process.env.ZALO_APP_SECRET || process.env.ZALO_WEBHOOK_SECRET;

    // Fail-Closed: Thiếu cấu hình Zalo secret trên máy chủ
    if (!zaloSecret || !zaloSecret.trim()) {
      return NextResponse.json(
        {
          success: false,
          error: 'CONFIGURATION_ERROR',
          message: 'Chưa cấu hình ZALO_APP_SECRET trên máy chủ (Fail-Closed).',
        },
        { status: 500 }
      );
    }

    return new NextResponse(zaloChallenge, { status: 200 });
  }

  // 3. Health check status
  return NextResponse.json({
    success: true,
    service: 'Omnichannel Webhook Ingress (Phase 3 Ready)',
    status: 'ACTIVE',
    supported_channels: ['zalo', 'facebook', 'system'],
  });
}

/**
 * POST /api/inbox/webhook
 * Tiếp nhận tin nhắn webhook từ đối tác ngoại vi (Facebook Messenger / Zalo OA / System).
 *
 * Đóng vai trò Gateway Dispatcher (Lỗi P1 - Mục 15):
 * 1. Nhận diện Provider (Facebook / Zalo / System) và chọn Adapter tương ứng.
 * 2. Gọi Adapter xác thực chữ ký số HMAC-SHA256 (Fail-Closed).
 * 3. Gọi Adapter phân giải Tenant an toàn từ Page ID / OA ID (Fail-Closed).
 * 4. Gọi Adapter chuẩn hóa Envelope thành NormalizedIngressEvent.
 * 5. Đẩy sang Core Ingestion Engine (InboxIngressService.ingestNormalizedEvent) do Member 2 chủ quản.
 */
export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    if (!rawBody || !rawBody.trim()) {
      return NextResponse.json(
        { success: false, error: 'EMPTY_BODY', message: 'Nội dung webhook không được để trống.' },
        { status: 400 }
      );
    }

    // 1. Phân tích cú pháp JSON
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { success: false, error: 'INVALID_JSON', message: 'Định dạng JSON không hợp lệ.' },
        { status: 400 }
      );
    }

    // 2. Xác định Provider & Chọn Adapter từ ProviderAdapterRegistry (Gateway Dispatcher Pattern)
    const channelHeader = request.headers.get('x-channel')?.toUpperCase();
    const fbSignature = request.headers.get('x-hub-signature-256');
    const zaloSignature = request.headers.get('x-zalo-signature') || request.headers.get('mac');
    const systemToken = request.headers.get('x-webhook-secret') || request.headers.get('x-system-signature');

    let provider: IngressProvider | null = null;
    if (
      fbSignature ||
      channelHeader === 'FACEBOOK' ||
      body.provider === 'FACEBOOK' ||
      (body.object === 'page' && Array.isArray(body.entry))
    ) {
      provider = INGRESS_PROVIDERS.FACEBOOK;
    } else if (
      zaloSignature ||
      channelHeader === 'ZALO' ||
      body.provider === 'ZALO' ||
      body.oa_id ||
      body.event_name
    ) {
      provider = INGRESS_PROVIDERS.ZALO;
    } else if (
      channelHeader === 'SYSTEM' ||
      body.provider === 'SYSTEM' ||
      systemToken
    ) {
      provider = INGRESS_PROVIDERS.SYSTEM;
    } else {
      return NextResponse.json(
        {
          success: false,
          error: 'INVALID_PROVIDER',
          message: 'Kênh webhook không hợp lệ hoặc không được hỗ trợ.',
        },
        { status: 400 }
      );
    }

    const adapter = ProviderAdapterRegistry.get(provider);
    if (!adapter) {
      return NextResponse.json(
        {
          success: false,
          error: 'ADAPTER_NOT_REGISTERED',
          message: `Chưa đăng ký ProviderAdapter cho kênh ${provider}.`,
        },
        { status: 500 }
      );
    }

    // 3. Chuẩn bị headers cho adapter
    const headersRecord: Record<string, string> = {};
    request.headers.forEach((val, key) => {
      headersRecord[key.toLowerCase()] = val;
    });

    // 4. Fail-Closed: Xác thực chữ ký số HMAC-SHA256 qua Adapter
    const verification = await adapter.verifySignature(rawBody, headersRecord);
    if (!verification.valid) {
      if (
        verification.reason?.includes('Configuration Error') ||
        verification.reason?.includes('chưa được cấu hình') ||
        verification.reason?.includes('Chưa cấu hình')
      ) {
        return NextResponse.json(
          {
            success: false,
            error: 'CONFIGURATION_ERROR',
            message: verification.reason,
          },
          { status: 500 }
        );
      }
      return NextResponse.json(
        {
          success: false,
          error: 'UNAUTHORIZED',
          message: verification.reason || 'Chữ ký số Webhook không hợp lệ.',
        },
        { status: 401 }
      );
    }

    // 5. Fail-Closed: Phân giải Tenant an toàn qua Adapter
    let companyId: string;
    try {
      companyId = await adapter.deriveTenant(body);
    } catch (err: unknown) {
      const errorObj = err as RouteError | undefined;
      if (errorObj?.code === 'INVALID_TENANT_DERIVATION') {
        return NextResponse.json(
          {
            success: false,
            error: 'INVALID_TENANT_DERIVATION',
            message: errorObj.message,
          },
          { status: errorObj.status || 400 }
        );
      }
      if (errorObj?.code === 'TENANT_NOT_CONFIGURED') {
        return NextResponse.json(
          {
            success: false,
            error: 'TENANT_NOT_CONFIGURED',
            message: errorObj.message,
          },
          { status: errorObj.status || 403 }
        );
      }
      if (errorObj?.code === 'MISSING_COMPANY_ID') {
        return NextResponse.json(
          {
            success: false,
            error: 'MISSING_COMPANY_ID',
            message: errorObj.message,
          },
          { status: errorObj.status || 400 }
        );
      }
      return NextResponse.json(
        {
          success: false,
          error: errorObj?.code || 'TENANT_DERIVATION_FAILED',
          message: errorObj?.message || 'Lỗi phân giải tenant.',
        },
        { status: errorObj?.status || 400 }
      );
    }

    // 6. Kiểm tra định dạng UUID an toàn cho company_id đã resolve (ngăn chặn bypass / injection)
    if (!companyId || !UUID_REGEX.test(companyId)) {
      return NextResponse.json(
        {
          success: false,
          error: 'UNKNOWN_TENANT_OR_INTEGRATION_ACCOUNT',
          message: 'Định danh tenant (company_id) không hợp lệ (Bắt buộc phải là UUID).',
        },
        { status: 400 }
      );
    }

    // 7. Chuyển hóa sang NormalizedIngressEvent[] qua Adapter
    const normalizedEvents = await adapter.parseToNormalized(body, companyId);
    if (!Array.isArray(normalizedEvents) || normalizedEvents.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'INVALID_PAYLOAD',
          message: 'Không tìm thấy sự kiện tin nhắn hợp lệ trong payload webhook.',
        },
        { status: 400 }
      );
    }

    for (const evt of normalizedEvents) {
      if (!evt.content || !evt.content.trim()) {
        return NextResponse.json(
          {
            success: false,
            error: 'INVALID_PAYLOAD',
            message: 'Nội dung tin nhắn không được để trống.',
          },
          { status: 400 }
        );
      }
    }

    // 8. Đẩy vào Core Ingestion Engine của Member 2
    let lastResult: IngressProcessResult | null = null;
    for (const event of normalizedEvents) {
      lastResult = await InboxIngressService.ingestNormalizedEvent(event);
      if (!lastResult.success) {
        return NextResponse.json(
          { success: false, error: 'PROCESSING_FAILED', message: lastResult.error },
          { status: 422 }
        );
      }
    }

    return NextResponse.json(
      {
        success: true,
        data: lastResult,
        message: lastResult?.duplicate
          ? 'Sự kiện đã được xử lý trước đó (Idempotent OK).'
          : 'Tiếp nhận tin nhắn đa kênh thành công.',
      },
      { status: lastResult?.duplicate ? 200 : 201 }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Lỗi máy chủ khi xử lý Webhook.';
    return NextResponse.json({ success: false, error: 'INTERNAL_ERROR', message }, { status: 500 });
  }
}
