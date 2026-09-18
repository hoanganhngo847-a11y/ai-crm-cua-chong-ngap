import { NextRequest, NextResponse } from 'next/server';
import { InboxIngressService } from '../../../../features/inbox/services/inbox-ingress.service';
import type {
  NormalizedIngressEvent,
  IngressProvider,
} from '../../../../features/inbox/types/webhook.types';
import type { InboxChannel } from '../../../../features/inbox/types/inbox.types';

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
 * Kiểm soát bảo mật Fail-Closed & Normalized Ingress Contract (Lỗi P0 & P1 - Việc 6):
 * 1. Kiểm tra cấu hình Secret trong env. Nếu thiếu lập tức trả về HTTP 500 CONFIGURATION_ERROR.
 * 2. Kiểm tra header chữ ký số xác thực. Nếu thiếu lập tức trả về HTTP 401 UNAUTHORIZED.
 * 3. So khớp chữ ký HMAC-SHA256. Nếu sai lệch lập tức trả về HTTP 401 UNAUTHORIZED.
 * 4. Bắt buộc có tenant `company_id`. Nếu thiếu lập tức trả về HTTP 400 BAD REQUEST.
 * 5. Chuẩn hóa payload thành NormalizedIngressEvent và đẩy vào ingestNormalizedEvent.
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

    // 2. Xác định Provider
    const channelHeader = request.headers.get('x-channel')?.toUpperCase();
    const fbSignature = request.headers.get('x-hub-signature-256');
    const zaloSignature = request.headers.get('x-zalo-signature') || request.headers.get('mac');
    const systemToken = request.headers.get('x-webhook-secret') || request.headers.get('x-system-signature');

    let provider: IngressProvider | null = null;
    let signature: string | null = null;
    let secret: string | undefined = undefined;

    if (
      fbSignature ||
      channelHeader === 'FACEBOOK' ||
      body.provider === 'FACEBOOK' ||
      (body.object === 'page' && Array.isArray(body.entry))
    ) {
      provider = 'FACEBOOK';
      signature = fbSignature;
      secret = process.env.FACEBOOK_APP_SECRET || process.env.FB_APP_SECRET;
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
    } else if (
      channelHeader === 'SYSTEM' ||
      body.provider === 'SYSTEM' ||
      systemToken
    ) {
      provider = 'SYSTEM';
      signature = systemToken;
      secret = process.env.INBOX_WEBHOOK_SECRET || process.env.SYSTEM_WEBHOOK_SECRET;
    }

    if (!provider) {
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

    // 5. Fail-Closed: Xác thực chữ ký số HMAC-SHA256
    const channelType: InboxChannel = provider === 'ZALO' ? 'zalo' : 'facebook';
    const verification = InboxIngressService.verifyWebhookSignature(
      rawBody,
      signature,
      secret,
      channelType
    );

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

    // 6. Xác định và kiểm tra tenant isolation (company_id)
    const { searchParams } = new URL(request.url);
    const companyId =
      body.company_id ||
      request.headers.get('x-company-id') ||
      searchParams.get('company_id');

    if (!companyId || typeof companyId !== 'string' || !companyId.trim()) {
      return NextResponse.json(
        {
          success: false,
          error: 'MISSING_COMPANY_ID',
          message: 'Thiếu định danh công ty (company_id) trong sự kiện Webhook (Tenant Isolation).',
        },
        { status: 400 }
      );
    }

    // 7. Chuyển hóa sang NormalizedIngressEvent (Hợp đồng tiếp nhận Thành viên 2)
    let externalUserId: string = '';
    let messageId: string = '';
    let content: string = '';
    let senderName: string | undefined = undefined;
    let senderPhone: string | undefined = undefined;
    let timestamp: string = new Date().toISOString();

    if (body.provider && body.message_id && body.external_user_id) {
      // Đã theo chuẩn NormalizedIngressEvent
      externalUserId = body.external_user_id;
      messageId = body.message_id;
      content = body.content || '';
      senderName = body.sender_name;
      senderPhone = body.sender_phone;
      timestamp = body.timestamp || timestamp;
    } else if (body.object === 'page' && Array.isArray(body.entry)) {
      // Envelope Facebook Messenger
      const entry = body.entry[0];
      const messaging = entry?.messaging?.[0];
      externalUserId = messaging?.sender?.id || 'fb-anon-user';
      messageId = messaging?.message?.mid || `fb-msg-${Date.now()}`;
      content = messaging?.message?.text || '(Tin nhắn hình ảnh/tệp)';
      senderName = 'Khách hàng Facebook';
      timestamp = messaging?.timestamp
        ? new Date(messaging.timestamp).toISOString()
        : timestamp;
    } else if (body.event_name || body.oa_id) {
      // Envelope Zalo OA
      externalUserId = body.sender?.id || body.user_id_by_app || 'zalo-anon-user';
      messageId = body.message?.msg_id || body.msg_id || `zalo-msg-${Date.now()}`;
      content = body.message?.text || '(Tin nhắn Zalo)';
      senderName = body.sender?.name || 'Khách hàng Zalo';
      senderPhone = body.sender?.phone;
      timestamp = body.timestamp ? new Date(body.timestamp).toISOString() : timestamp;
    } else {
      // Payload tiêu chuẩn khác
      externalUserId = body.sender?.id || body.external_user_id || `user-${Date.now()}`;
      messageId = body.message?.id || body.message_id || `msg-${Date.now()}`;
      content = body.message?.text || body.content || '';
      senderName = body.sender?.name || body.sender_name;
      senderPhone = body.sender?.phone || body.sender_phone;
      timestamp = body.timestamp || timestamp;
    }

    if (!content.trim()) {
      return NextResponse.json(
        {
          success: false,
          error: 'INVALID_PAYLOAD',
          message: 'Nội dung tin nhắn không được để trống.',
        },
        { status: 400 }
      );
    }

    const normalizedEvent: NormalizedIngressEvent = {
      provider,
      company_id: companyId.trim(),
      external_user_id: externalUserId,
      sender_name: senderName,
      sender_phone: senderPhone,
      message_id: messageId,
      content: content.trim(),
      timestamp,
      metadata: body.metadata,
    };

    // 8. Đẩy vào Service xử lý theo Normalized Contract
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
