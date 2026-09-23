import { NextRequest, NextResponse } from 'next/server';
import {
  InboxIngressService,
  SystemAdapter,
  UUID_REGEX,
} from '@/features/inbox/services/inbox-ingress.service';
import { FacebookAdapter } from '@/features/inbox/adapters/facebook.adapter';
import { ZaloAdapter } from '@/features/inbox/adapters/zalo.adapter';
import type {
  NormalizedIngressEvent,
  IngressProvider,
  ProviderWebhookAdapter,
} from '../../../../features/inbox/types/webhook.types';

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
    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        { success: false, error: 'INVALID_JSON', message: 'Định dạng JSON không hợp lệ.' },
        { status: 400 }
      );
    }

    // 2. Xác định Provider & Chọn Adapter tương ứng (Gateway Dispatcher Pattern)
    const channelHeader = request.headers.get('x-channel')?.toUpperCase();
    const fbSignature = request.headers.get('x-hub-signature-256');
    const zaloSignature = request.headers.get('x-zalo-signature') || request.headers.get('mac');
    const systemToken = request.headers.get('x-webhook-secret') || request.headers.get('x-system-signature');

    let provider: IngressProvider | null = null;
    let signature: string | null = null;
    let secret: string | undefined = undefined;
    let adapter: ProviderWebhookAdapter;

    if (
      fbSignature ||
      channelHeader === 'FACEBOOK' ||
      body.provider === 'FACEBOOK' ||
      (body.object === 'page' && Array.isArray(body.entry))
    ) {
      provider = 'FACEBOOK';
      signature = fbSignature;
      secret = process.env.FACEBOOK_APP_SECRET || process.env.FB_APP_SECRET;
      adapter = FacebookAdapter;
    } else if (
      zaloSignature ||
      channelHeader === 'ZALO' ||
      body.provider === 'ZALO' ||
      body.oa_id ||
      body.event_name
    ) {
      provider = 'ZALO';
      signature = zaloSignature;
      secret = process.env.ZALO_APP_SECRET || process.env.ZALO_WEBHOOK_SECRET;
      adapter = ZaloAdapter;
    } else if (
      channelHeader === 'SYSTEM' ||
      body.provider === 'SYSTEM' ||
      systemToken
    ) {
      provider = 'SYSTEM';
      signature = systemToken;
      secret = process.env.INBOX_WEBHOOK_SECRET || process.env.SYSTEM_WEBHOOK_SECRET;
      adapter = SystemAdapter;
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

    // 3. Fail-Closed: Kiểm tra cấu hình Secret trên máy chủ
    if (!secret || !secret.trim()) {
      return NextResponse.json(
        {
          success: false,
          error: 'CONFIGURATION_ERROR',
          message: `Webhook secret cho kênh ${provider} chưa được cấu hình trên máy chủ (Fail-Closed).`,
        },
        { status: 500 }
      );
    }

    // 4. Fail-Closed: Kiểm tra Signature Header
    if (!signature || !signature.trim()) {
      return NextResponse.json(
        {
          success: false,
          error: 'UNAUTHORIZED',
          message: `Thiếu header chữ ký số xác thực cho kênh ${provider} (Missing Signature Header).`,
        },
        { status: 401 }
      );
    }

    // 5. Fail-Closed: Xác thực chữ ký số HMAC-SHA256 qua Adapter tương ứng
    const verification = adapter.verifySignature(rawBody, signature, secret);

    if (!verification.valid) {
      return NextResponse.json(
        {
          success: false,
          error: 'UNAUTHORIZED',
          message: verification.reason || 'Chữ ký số Webhook không hợp lệ.',
        },
        { status: 401 }
      );
    }

    // 6. Cơ chế Derive Tenant an toàn qua Adapter (Fail-Closed, chống tự ý khai company_id)
    // Tuân thủ Lỗi P0 số 4:
    // - XÓA BỎ hoàn toàn việc tin cậy trực tiếp các tham số caller tự khai:
    //   KHÔNG đọc `searchParams.get('company_id')`
    //   KHÔNG đọc `request.headers.get('x-company-id')`
    let companyId: string | null = null;

    const isNormalizedEvent = Boolean(
      body &&
        typeof body === 'object' &&
        (body.provider === 'FACEBOOK' || body.provider === 'ZALO' || body.provider === 'SYSTEM') &&
        typeof body.external_user_id === 'string' &&
        body.external_user_id.trim() &&
        typeof body.message_id === 'string' &&
        body.message_id.trim()
    );

    const isRawFacebookEnvelope = Boolean(
      body &&
        typeof body === 'object' &&
        (body.object === 'page' || Array.isArray(body.entry))
    );

    const isRawZaloEnvelope = Boolean(
      body &&
        typeof body === 'object' &&
        (body.event_name || (body.oa_id && !isNormalizedEvent))
    );

    if (isRawFacebookEnvelope) {
      // 6a. Webhook Facebook trực tiếp: Derive Page ID từ recipient.id hoặc entry[0].id qua FacebookAdapter
      const pageId =
        body.entry?.[0]?.id ||
        body.entry?.[0]?.messaging?.[0]?.recipient?.id ||
        body.recipient?.id ||
        body.page_id;

      if (!pageId || typeof pageId !== 'string' || !pageId.trim()) {
        return NextResponse.json(
          {
            success: false,
            error: 'UNKNOWN_TENANT_OR_INTEGRATION_ACCOUNT',
            message: 'Không thể giải mã Facebook Page ID hợp lệ từ payload webhook (Fail-Closed).',
          },
          { status: 400 }
        );
      }

      companyId = FacebookAdapter.deriveTenant(pageId);
      if (!companyId) {
        return NextResponse.json(
          {
            success: false,
            error: 'UNKNOWN_TENANT_OR_INTEGRATION_ACCOUNT',
            message: `Không tìm thấy liên kết tenant cho Facebook Page ID "${pageId}" trong hệ thống (Fail-Closed).`,
          },
          { status: 400 }
        );
      }
    } else if (isRawZaloEnvelope) {
      // 6b. Webhook Zalo trực tiếp: Derive OA ID từ oa_id hoặc recipient.id qua ZaloAdapter
      const oaId = body.oa_id || body.recipient?.id;

      if (!oaId || typeof oaId !== 'string' || !oaId.trim()) {
        return NextResponse.json(
          {
            success: false,
            error: 'UNKNOWN_TENANT_OR_INTEGRATION_ACCOUNT',
            message: 'Không thể giải mã Zalo OA ID hợp lệ từ payload webhook (Fail-Closed).',
          },
          { status: 400 }
        );
      }

      companyId = ZaloAdapter.deriveTenant(oaId);
      if (!companyId) {
        return NextResponse.json(
          {
            success: false,
            error: 'UNKNOWN_TENANT_OR_INTEGRATION_ACCOUNT',
            message: `Không tìm thấy liên kết tenant cho Zalo OA ID "${oaId}" trong hệ thống (Fail-Closed).`,
          },
          { status: 400 }
        );
      }
    } else if (isNormalizedEvent || provider === 'SYSTEM') {
      // 6c. Sự kiện nội bộ chuẩn hóa (Normalized Ingress / System):
      // Chỉ chấp nhận khi đi qua server-side trusted caller hoặc signature nội bộ (đã xác thực HMAC ở Bước 5).
      if (body.recipient?.id || body.page_id) {
        const derived = FacebookAdapter.deriveTenant(body.recipient?.id || body.page_id);
        if (derived) companyId = derived;
      } else if (body.oa_id) {
        const derived = ZaloAdapter.deriveTenant(body.oa_id);
        if (derived) companyId = derived;
      }

      // Nếu chưa derive qua Page/OA ID mapping, sử dụng company_id từ adapter mapping nội bộ
      if (
        !companyId &&
        body.company_id &&
        typeof body.company_id === 'string' &&
        body.company_id.trim()
      ) {
        companyId = body.company_id.trim();
      }

      if (!companyId) {
        return NextResponse.json(
          {
            success: false,
            error: 'MISSING_COMPANY_ID',
            message: 'Thiếu định danh công ty (company_id) trong sự kiện Webhook (Tenant Isolation).',
          },
          { status: 400 }
        );
      }
    } else {
      // 6d. Payload chưa xác định rõ dạng: Thử tìm account ID theo provider qua adapter
      const accountId =
        provider === 'FACEBOOK'
          ? body.recipient?.id || body.page_id || body.entry?.[0]?.id
          : body.oa_id || body.recipient?.id;

      if (accountId && typeof accountId === 'string' && accountId.trim()) {
        companyId = adapter.deriveTenant(accountId);
      }

      if (!companyId) {
        return NextResponse.json(
          {
            success: false,
            error: 'UNKNOWN_TENANT_OR_INTEGRATION_ACCOUNT',
            message:
              'Không thể giải mã hoặc không tìm thấy liên kết tenant cho tài khoản tích hợp (Fail-Closed).',
          },
          { status: 400 }
        );
      }
    }

    // Kiểm tra định dạng UUID an toàn cho company_id đã resolve (ngăn chặn bypass / injection)
    if (!UUID_REGEX.test(companyId)) {
      return NextResponse.json(
        {
          success: false,
          error: 'UNKNOWN_TENANT_OR_INTEGRATION_ACCOUNT',
          message: 'Định danh tenant (company_id) không hợp lệ (Bắt buộc phải là UUID).',
        },
        { status: 400 }
      );
    }

    // 7. Chuyển hóa sang NormalizedIngressEvent qua Adapter tương ứng (Gateway Dispatcher)
    const normalizedEvent = adapter.parseToNormalized(body, companyId);

    if (!normalizedEvent.content || !normalizedEvent.content.trim()) {
      return NextResponse.json(
        {
          success: false,
          error: 'INVALID_PAYLOAD',
          message: 'Nội dung tin nhắn không được để trống.',
        },
        { status: 400 }
      );
    }

    // 8. Đẩy vào Core Ingestion Engine của Member 2
    const result = await InboxIngressService.ingestNormalizedEvent(normalizedEvent);

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: 'PROCESSING_FAILED', message: result.error },
        { status: 422 }
      );
    }

    return NextResponse.json(
      {
        success: true,
        data: result,
        message: result.duplicate
          ? 'Sự kiện đã được xử lý trước đó (Idempotent OK).'
          : 'Tiếp nhận tin nhắn đa kênh thành công.',
      },
      { status: result.duplicate ? 200 : 201 }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Lỗi máy chủ khi xử lý Webhook.';
    return NextResponse.json({ success: false, error: 'INTERNAL_ERROR', message }, { status: 500 });
  }
}
