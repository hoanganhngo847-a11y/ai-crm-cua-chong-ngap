import { NextRequest, NextResponse } from 'next/server';
import { getActorContext } from '../../../lib/auth/context';
import { APPLICATION_ROLES } from '../../../shared/constants/roles';
import { InboxService } from '../../../features/inbox/services/inbox.service';
import { maskPhone } from '../../../features/crm/services/customer.service';
import type { InboxChannel } from '../../../features/inbox/types/inbox.types';
import type { ActorContext } from '../../../shared/contracts/auth';

export interface InboxRouteContext {
  params?: Promise<Record<string, string | string[]>>;
  actor?: ActorContext | null;
}

/**
 * GET /api/inbox
 * Lấy danh sách cuộc hội thoại hoặc tin nhắn chi tiết theo conversation_id.
 *
 * Phân quyền:
 * - BOSS_ADMIN và SALE được phép truy cập.
 * - TECHNICIAN bị từ chối (403 Forbidden).
 */
export async function GET(request: NextRequest, context?: InboxRouteContext) {
  try {
    const actor = context?.actor !== undefined ? context.actor : await getActorContext();

    if (!actor || actor.profileStatus !== 'ACTIVE') {
      return NextResponse.json(
        { success: false, error: 'UNAUTHORIZED', message: 'Yêu cầu đăng nhập để truy cập hộp thư.' },
        { status: 401 }
      );
    }

    if (!actor.companyId || actor.membershipStatus !== 'ACTIVE' || !actor.role) {
      return NextResponse.json(
        { success: false, error: 'FORBIDDEN', message: 'Tài khoản không thuộc tổ chức hợp lệ.' },
        { status: 403 }
      );
    }

    if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
      return NextResponse.json(
        {
          success: false,
          error: 'ROLE_FORBIDDEN',
          message: 'Kỹ thuật viên không có quyền truy cập Hộp thư tích hợp.',
        },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const conversationId = searchParams.get('conversation_id')?.trim();
    const channel = (searchParams.get('channel')?.trim() || 'all') as InboxChannel | 'all';
    const search = searchParams.get('search')?.trim() || '';

    // Nếu có conversation_id: Lấy chi tiết cuộc trò chuyện và danh sách tin nhắn
    if (conversationId) {
      const conversation = await InboxService.getConversationById(conversationId);
      if (!conversation) {
        return NextResponse.json(
          { success: false, error: 'NOT_FOUND', message: 'Không tìm thấy cuộc hội thoại.' },
          { status: 404 }
        );
      }

      // Áp dụng Zero-Phone Invariant cho SALE
      const sanitizedConv = {
        ...conversation,
        customer_phone:
          actor.role === APPLICATION_ROLES.SALE && conversation.customer_phone
            ? maskPhone(conversation.customer_phone)
            : conversation.customer_phone,
      };

      const messages = await InboxService.getMessagesByConversationId(conversationId);

      return NextResponse.json({
        success: true,
        data: {
          conversation: sanitizedConv,
          messages,
        },
      });
    }

    // Nếu không có conversation_id: Lấy danh sách toàn bộ cuộc hội thoại
    const conversations = await InboxService.getConversations({
      channel,
      search,
    });

    // Áp dụng bảo vệ số điện thoại cho danh sách
    const sanitizedConversations = conversations.map((c) => ({
      ...c,
      customer_phone:
        actor.role === APPLICATION_ROLES.SALE && c.customer_phone
          ? maskPhone(c.customer_phone)
          : c.customer_phone,
    }));

    return NextResponse.json({
      success: true,
      data: sanitizedConversations,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Lỗi không xác định khi tải hộp thư.';
    return NextResponse.json({ success: false, error: 'INTERNAL_ERROR', message }, { status: 500 });
  }
}

/**
 * POST /api/inbox
 * Gửi tin nhắn phản hồi từ Sale trong Hộp thư tích hợp.
 *
 * Phân quyền:
 * - SALE và BOSS_ADMIN được phép gửi tin nhắn.
 * - TECHNICIAN bị từ chối (403 Forbidden).
 */
export async function POST(request: NextRequest, context?: InboxRouteContext) {
  try {
    const actor = context?.actor !== undefined ? context.actor : await getActorContext();

    if (!actor || actor.profileStatus !== 'ACTIVE') {
      return NextResponse.json(
        { success: false, error: 'UNAUTHORIZED', message: 'Yêu cầu đăng nhập để gửi tin nhắn.' },
        { status: 401 }
      );
    }

    if (!actor.companyId || actor.membershipStatus !== 'ACTIVE' || !actor.role) {
      return NextResponse.json(
        { success: false, error: 'FORBIDDEN', message: 'Tài khoản không thuộc tổ chức hợp lệ.' },
        { status: 403 }
      );
    }

    if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
      return NextResponse.json(
        {
          success: false,
          error: 'ROLE_FORBIDDEN',
          message: 'Kỹ thuật viên không có quyền gửi tin nhắn trong Hộp thư.',
        },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { success: false, error: 'INVALID_PAYLOAD', message: 'Dữ liệu yêu cầu không hợp lệ.' },
        { status: 400 }
      );
    }

    const { conversation_id, content } = body;

    if (!conversation_id || typeof conversation_id !== 'string') {
      return NextResponse.json(
        { success: false, error: 'MISSING_FIELD', message: 'Mã cuộc hội thoại (conversation_id) là bắt buộc.' },
        { status: 400 }
      );
    }

    if (!content || typeof content !== 'string' || !content.trim()) {
      return NextResponse.json(
        { success: false, error: 'MISSING_FIELD', message: 'Nội dung tin nhắn không được để trống.' },
        { status: 400 }
      );
    }

    const newMessage = await InboxService.sendMessage({
      conversation_id,
      content: content.trim(),
      sender_type: 'sale',
    });

    return NextResponse.json(
      {
        success: true,
        data: newMessage,
        message: 'Gửi tin nhắn phản hồi thành công.',
      },
      { status: 201 }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Lỗi máy chủ khi gửi tin nhắn.';
    return NextResponse.json({ success: false, error: 'INTERNAL_ERROR', message }, { status: 500 });
  }
}
