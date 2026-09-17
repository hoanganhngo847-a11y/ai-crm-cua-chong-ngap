import { NextRequest, NextResponse } from 'next/server';
import { InboxIngressService } from '../../../../features/inbox/services/inbox-ingress.service';
import type {
  OmnichannelWebhookPayload,
  WebhookEventType,
} from '../../../../features/inbox/types/webhook.types';
import type { InboxChannel } from '../../../../features/inbox/types/inbox.types';

/**
 * GET /api/inbox/webhook
 * Xác thực Webhook Challenge Handshake (Facebook Messenger & Zalo OA).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // 1. Facebook Webhook Verification Challenge
  const hubMode = searchParams.get('hub.mode');
  const hubChallenge = searchParams.get('hub.challenge');
  const hubVerifyToken = searchParams.get('hub.verify_token');

  const fbVerifyToken =
    process.env.FACEBOOK_VERIFY_TOKEN || process.env.INBOX_WEBHOOK_SECRET || 'cuachongngap_verify_token';

  if (hubMode === 'subscribe' && hubChallenge) {
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
    return new NextResponse(zaloChallenge, { status: 200 });
  }

  // 3. Health check status
  return NextResponse.json({
    success: true,
    service: 'Omnichannel Webhook Ingress (Phase 3 Ready)',
    status: 'ACTIVE',
    supported_channels: ['zalo', 'facebook', 'website'],
  });
}

/**
 * POST /api/inbox/webhook
 * Tiếp nhận tin nhắn webhook từ đối tác ngoại vi (Ngữ cảnh B Service Role).
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

    // 1. Xác định kênh qua header hoặc body
    const channelHeader = request.headers.get('x-channel')?.toLowerCase() as InboxChannel | null;
    const fbSignature = request.headers.get('x-hub-signature-256');
    const zaloSignature = request.headers.get('x-zalo-signature') || request.headers.get('mac');
    const secretToken = request.headers.get('x-webhook-secret');

    let channel: InboxChannel = 'facebook';
    let signature: string | null = null;
    let secret: string | undefined = undefined;

    if (fbSignature || channelHeader === 'facebook') {
      channel = 'facebook';
      signature = fbSignature || secretToken;
      secret = process.env.FACEBOOK_APP_SECRET || process.env.INBOX_WEBHOOK_SECRET;
    } else if (zaloSignature || channelHeader === 'zalo') {
      channel = 'zalo';
      signature = zaloSignature || secretToken;
      secret = process.env.ZALO_WEBHOOK_SECRET || process.env.INBOX_WEBHOOK_SECRET;
    } else {
      channel = channelHeader || 'facebook';
      signature = secretToken;
      secret = process.env.INBOX_WEBHOOK_SECRET;
    }

    // 2. Xác thực chữ ký số mật mã (HMAC-SHA256)
    if (secret && signature) {
      const verification = InboxIngressService.verifyWebhookSignature(
        rawBody,
        signature,
        secret,
        channel
      );

      if (!verification.valid) {
        return NextResponse.json(
          {
            success: false,
            error: 'INVALID_SIGNATURE',
            message: verification.reason || 'Chữ ký số Webhook không hợp lệ.',
          },
          { status: 401 }
        );
      }
    }

    // 3. Phân tích cú pháp payload
    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        { success: false, error: 'INVALID_JSON', message: 'Định dạng JSON không hợp lệ.' },
        { status: 400 }
      );
    }

    // 4. Chuẩn hóa payload thành OmnichannelWebhookPayload
    let normalizedPayload: OmnichannelWebhookPayload;

    if (body.event_id && body.channel && body.sender && body.message) {
      // Đã theo chuẩn OmnichannelWebhookPayload
      normalizedPayload = body as OmnichannelWebhookPayload;
    } else if (body.object === 'page' && Array.isArray(body.entry)) {
      // Định dạng phong bì Facebook Messenger Webhook
      const entry = body.entry[0];
      const messaging = entry?.messaging?.[0];

      normalizedPayload = {
        event_id: messaging?.message?.mid || `fb-evt-${Date.now()}`,
        channel: 'facebook',
        event_type: 'message.created',
        sender: {
          id: messaging?.sender?.id || 'fb-anon-user',
          name: 'Khách hàng Facebook Messenger',
        },
        recipient: {
          id: messaging?.recipient?.id || 'page-id',
        },
        message: {
          id: messaging?.message?.mid || `msg-${Date.now()}`,
          text: messaging?.message?.text || '(Tin nhắn hình ảnh/tệp)',
          timestamp: new Date(messaging?.timestamp || Date.now()).toISOString(),
        },
      };
    } else if (body.event_name || body.oa_id) {
      // Định dạng phong bì Zalo OA Webhook
      normalizedPayload = {
        event_id: body.msg_id || body.event_id || `zalo-evt-${Date.now()}`,
        channel: 'zalo',
        event_type: 'message.created',
        sender: {
          id: body.sender?.id || body.user_id_by_app || 'zalo-anon-user',
          name: body.sender?.name || 'Khách hàng Zalo OA',
          phone: body.sender?.phone,
        },
        recipient: {
          id: body.recipient?.id || body.oa_id || 'oa-id',
        },
        message: {
          id: body.message?.msg_id || body.msg_id || `msg-${Date.now()}`,
          text: body.message?.text || '(Tin nhắn Zalo)',
          timestamp: new Date(body.timestamp || Date.now()).toISOString(),
        },
      };
    } else {
      // Fallback cho payload tùy chỉnh
      normalizedPayload = {
        event_id: body.event_id || `evt-${Date.now()}`,
        channel,
        event_type: (body.event_type as WebhookEventType) || 'message.created',
        sender: {
          id: body.sender_id || body.sender?.id || `user-${Date.now()}`,
          name: body.sender_name || body.sender?.name || 'Khách hàng liên hệ',
          phone: body.sender_phone || body.sender?.phone,
        },
        message: {
          id: body.message_id || body.message?.id || `msg-${Date.now()}`,
          text: body.content || body.message?.text || body.text || '',
          timestamp: body.timestamp || new Date().toISOString(),
        },
      };
    }

    // 5. Chuyển vào Service xử lý
    const result = await InboxIngressService.processInboundWebhook(normalizedPayload);

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
