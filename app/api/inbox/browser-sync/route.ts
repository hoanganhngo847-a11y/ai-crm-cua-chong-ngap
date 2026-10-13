import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { InboxService, DEFAULT_INBOX_COMPANY_ID } from '@/features/inbox/services/inbox.service';

export const runtime = 'nodejs';

function secureCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * POST /api/inbox/browser-sync
 * Server-to-server Ingestion Endpoint cho Playwright Worker (facebook_browser).
 * 
 * Tiêu chí bảo mật & vận hành (Phase 2A):
 * 1. Chỉ nhận server-to-server qua secret header x-worker-secret hoặc Authorization: Bearer <secret>.
 * 2. Cưỡng chế HTTPS trong môi trường production.
 * 3. Tuyệt đối không log secret, cookie hay token.
 * 4. Kiểm tra chiều tin nhắn: chỉ nhận INBOUND.
 * 5. Tận dụng kiến trúc InboxService.addInboundMessage sẵn có với L2 Durable Idempotency.
 */
export async function POST(request: NextRequest) {
  try {
    // 1. Production HTTPS enforcement
    if (process.env.NODE_ENV === 'production') {
      const proto = request.headers.get('x-forwarded-proto') || '';
      if (proto !== 'https' && !request.url.startsWith('https://')) {
        return NextResponse.json(
          { success: false, error: 'HTTPS_REQUIRED', message: 'Endpoint yêu cầu kết nối bảo mật HTTPS trong production.' },
          { status: 403 }
        );
      }
    }

    // 2. Secret Authentication (Fail-Closed)
    const configuredSecret = process.env.FB_WORKER_SECRET;
    if (!configuredSecret || !configuredSecret.trim()) {
      return NextResponse.json(
        { success: false, error: 'CONFIGURATION_ERROR', message: 'FB_WORKER_SECRET chưa được cấu hình trên máy chủ.' },
        { status: 500 }
      );
    }

    const providedSecret =
      request.headers.get('x-worker-secret') ||
      request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
      '';

    if (!providedSecret || !secureCompare(providedSecret, configuredSecret)) {
      return NextResponse.json(
        { success: false, error: 'UNAUTHORIZED', message: 'Xác thực server-to-server thất bại.' },
        { status: 401 }
      );
    }

    // 3. Payload Parsing & Validation
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { success: false, error: 'INVALID_PAYLOAD', message: 'Body request phải là JSON hợp lệ.' },
        { status: 400 }
      );
    }

    const {
      page_id,
      page_name,
      sender_name,
      customer_fb_id,
      external_conversation_id,
      external_message_id,
      content,
      timestamp,
      direction,
      company_id: clientCompanyId
    } = body;

    // Strict Inbound validation
    if (direction !== 'inbound') {
      return NextResponse.json(
        { success: false, error: 'INVALID_DIRECTION', message: 'Endpoint browser-sync chỉ tiếp nhận tin nhắn inbound từ khách hàng.' },
        { status: 400 }
      );
    }

    if (!content || typeof content !== 'string' || !content.trim()) {
      return NextResponse.json(
        { success: false, error: 'EMPTY_CONTENT', message: 'Nội dung tin nhắn không được để trống.' },
        { status: 400 }
      );
    }

    if (!external_conversation_id || typeof external_conversation_id !== 'string') {
      return NextResponse.json(
        { success: false, error: 'MISSING_THREAD_ID', message: 'Thiếu external_conversation_id định danh thread.' },
        { status: 400 }
      );
    }

    if (!external_message_id || typeof external_message_id !== 'string') {
      return NextResponse.json(
        { success: false, error: 'MISSING_MESSAGE_ID', message: 'Thiếu external_message_id fingerprint chống trùng lặp.' },
        { status: 400 }
      );
    }

    const companyId = process.env.FB_SYNC_COMPANY_ID || clientCompanyId || DEFAULT_INBOX_COMPANY_ID;

    // 4. Ingest via InboxService
    const result = await InboxService.addInboundMessage({
      channel: 'facebook',
      company_id: companyId,
      senderName: sender_name || 'Khách hàng Facebook',
      externalUserId: customer_fb_id || external_conversation_id,
      externalConversationId: external_conversation_id,
      externalRef: external_message_id,
      externalMessageId: external_message_id,
      content: content.trim(),
      rawContent: content.trim(),
      timestamp: timestamp || new Date().toISOString(),
      metadata: {
        provider: 'facebook_browser',
        page_id: page_id || 'unknown',
        page_name: page_name || 'Trang Facebook',
        customer_fb_id: customer_fb_id || null,
        source: 'meta_business_suite_browser',
        ...(body.metadata && typeof body.metadata === 'object' ? body.metadata : {})
      }
    });

    return NextResponse.json({
      success: true,
      conversation_id: result.conversationId,
      interaction_id: result.interactionId,
      customer_id: result.customerId,
      is_duplicate: result.isDuplicate,
      is_new_conversation: result.isNewConversation
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Lỗi nội bộ hệ thống';
    return NextResponse.json(
      { success: false, error: 'INTERNAL_ERROR', message },
      { status: 500 }
    );
  }
}
