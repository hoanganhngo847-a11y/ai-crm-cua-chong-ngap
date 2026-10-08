import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServerClient } from '../../../lib/supabase/server';
import { createAdminClient } from '../../../lib/supabase/admin';
import { APPLICATION_ROLES } from '../../../shared/constants/roles';
import { InboxService } from '../../../features/inbox/services/inbox.service';
import { maskPhone } from '../../../features/crm/services/customer.service';
import { sanitizePhoneInText } from '../../../features/crm/utils/phone-sanitizer';
import { sendMessage as sendFacebookMessage } from '../../../features/omnichannel/facebook/server';
import { getConfiguredFacebookPageLabels } from '../../../features/omnichannel/facebook/connect';
import { ChannelError } from '../../../features/omnichannel/facebook/core';
import type { InboxChannel } from '../../../features/inbox/types/inbox.types';
import type { ActorContext } from '../../../shared/contracts/auth';
import type { SupabaseClient } from '@supabase/supabase-js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface InboxRouteContext {
  params?: Promise<Record<string, string | string[]>>;
  actor?: ActorContext | null;
  supabaseClient?: SupabaseClient;
}

interface ResolvedInboxActor {
  userId: string;
  companyId: string;
  role: string;
}

interface PageAwareConversation {
  id: string;
  channel: InboxChannel;
  channel_page_id?: string;
  channel_page_name?: string;
  [key: string]: unknown;
}

async function attachFacebookPageInfo<T extends PageAwareConversation>(
  companyId: string,
  conversations: T[],
  client?: SupabaseClient
): Promise<T[]> {
  const facebookConversations = conversations.filter((item) => item.channel === 'facebook');
  if (facebookConversations.length === 0) return conversations;

  const db = client || createAdminClient();
  const { data, error } = await db
    .from('conversations')
    .select('id, external_conversation_id')
    .eq('company_id', companyId)
    .in(
      'id',
      facebookConversations.map((item) => item.id)
    );

  if (error || !data) return conversations;

  let labels: Record<string, string> = {};
  try {
    labels = await getConfiguredFacebookPageLabels(companyId);
  } catch {
    // Page provenance remains useful even if Meta name lookup is temporarily unavailable.
  }

  const pageByConversation = new Map<string, string>();
  for (const row of data as Array<{ id: string; external_conversation_id?: string | null }>) {
    const externalId = row.external_conversation_id || '';
    const separator = externalId.indexOf(':');
    const pageId = separator > 0 ? externalId.slice(0, separator) : '';
    if (/^\d+$/.test(pageId)) pageByConversation.set(row.id, pageId);
  }

  return conversations.map((conversation) => {
    if (conversation.channel !== 'facebook') return conversation;
    const pageId = pageByConversation.get(conversation.id);
    if (!pageId) return conversation;

    return {
      ...conversation,
      channel_page_id: pageId,
      channel_page_name: labels[pageId] || `Facebook Page ${pageId}`,
    };
  });
}

async function resolveInboxActor(
  context?: InboxRouteContext
): Promise<{ actor?: ResolvedInboxActor; errorResponse?: NextResponse }> {
  let userId: string;
  let companyId: string;
  let userRole: string;

  if (context?.actor !== undefined) {
    const actor = context.actor;
    if (!actor || actor.profileStatus !== 'ACTIVE') {
      return {
        errorResponse: NextResponse.json(
          { success: false, error: 'UNAUTHORIZED', message: 'Yêu cầu đăng nhập để truy cập hộp thư.' },
          { status: 401 }
        ),
      };
    }

    if (!actor.companyId || actor.membershipStatus !== 'ACTIVE' || !actor.role) {
      return {
        errorResponse: NextResponse.json(
          { success: false, error: 'FORBIDDEN', message: 'Tài khoản không thuộc tổ chức hợp lệ hoặc chưa kích hoạt.' },
          { status: 403 }
        ),
      };
    }

    userId = actor.userId;
    companyId = actor.companyId;
    userRole = actor.role;
  } else {
    const supabase = context?.supabaseClient || (await createServerClient());
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return {
        errorResponse: NextResponse.json(
          { success: false, error: 'UNAUTHORIZED', message: 'Yêu cầu đăng nhập để truy cập hộp thư.' },
          { status: 401 }
        ),
      };
    }

    userId = user.id;

    let memberRecord: { company_id: string; role: string; status: string } | null = null;

    const { data: cmData, error: cmError } = await supabase
      .from('company_members')
      .select('company_id, role, status')
      .eq('user_id', user.id)
      .eq('status', 'ACTIVE')
      .maybeSingle();

    if (!cmError && cmData) {
      memberRecord = cmData;
    } else {
      const { data: mData } = await supabase
        .from('members')
        .select('company_id, role, status')
        .eq('user_id', user.id)
        .eq('status', 'ACTIVE')
        .maybeSingle();
      if (mData) memberRecord = mData;
    }

    if (!memberRecord || memberRecord.status !== 'ACTIVE' || !memberRecord.company_id) {
      return {
        errorResponse: NextResponse.json(
          { success: false, error: 'FORBIDDEN', message: 'Tài khoản không có membership hoạt động trong tổ chức.' },
          { status: 403 }
        ),
      };
    }

    companyId = memberRecord.company_id;
    userRole = memberRecord.role;
  }

  if (userRole === APPLICATION_ROLES.TECHNICIAN) {
    return {
      errorResponse: NextResponse.json(
        {
          success: false,
          error: 'ROLE_FORBIDDEN',
          message: 'Kỹ thuật viên không có quyền truy cập Hộp thư tích hợp.',
        },
        { status: 403 }
      ),
    };
  }

  if (userRole !== APPLICATION_ROLES.SALE && userRole !== APPLICATION_ROLES.BOSS_ADMIN) {
    return {
      errorResponse: NextResponse.json(
        {
          success: false,
          error: 'ROLE_FORBIDDEN',
          message: 'Chỉ nhân viên Sale và Quản trị viên mới có quyền thao tác trên Hộp thư tích hợp.',
        },
        { status: 403 }
      ),
    };
  }

  return { actor: { userId, companyId, role: userRole } };
}

export async function GET(request: NextRequest, context?: unknown) {
  try {
    const typedContext = context as InboxRouteContext | undefined;
    const authResult = await resolveInboxActor(typedContext);
    if (authResult.errorResponse) return authResult.errorResponse;

    const { companyId, role, userId } = authResult.actor!;
    const { searchParams } = new URL(request.url);
    const conversationId = searchParams.get('conversation_id')?.trim();
    const channel = (searchParams.get('channel')?.trim() || 'all') as InboxChannel | 'all';
    const search = searchParams.get('search')?.trim() || '';

    if (conversationId) {
      const conversation = await InboxService.getConversationById(
        companyId,
        conversationId,
        role,
        typedContext?.supabaseClient
      );

      if (!conversation) {
        return NextResponse.json(
          {
            success: false,
            error: 'NOT_FOUND',
            message: 'Cuộc hội thoại không tồn tại hoặc không thuộc quyền quản lý của tổ chức.',
          },
          { status: 404 }
        );
      }

      let messages;
      try {
        messages = await InboxService.getMessagesByConversationId(
          companyId,
          conversationId,
          role,
          typedContext?.supabaseClient,
          { userId, actorId: userId }
        );
      } catch (err: unknown) {
        const errorObj = err as { code?: string; status?: number; message?: string } | undefined;
        if (errorObj?.code === 'AUDIT_WRITE_FAILED') {
          return NextResponse.json(
            {
              success: false,
              error: 'AUDIT_WRITE_FAILED',
              message: errorObj.message || 'Lỗi ghi nhận kiểm toán bắt buộc. Thao tác xem nội dung gốc bị từ chối.',
            },
            { status: 500 }
          );
        }
        if (errorObj?.status === 404 || errorObj?.code === 'NOT_FOUND') {
          return NextResponse.json(
            {
              success: false,
              error: 'NOT_FOUND',
              message: errorObj.message || 'Cuộc hội thoại không tồn tại hoặc không thuộc quyền quản lý của tổ chức.',
            },
            { status: 404 }
          );
        }
        throw err;
      }

      const sanitizedConv = {
        ...conversation,
        customer_phone:
          role === APPLICATION_ROLES.SALE && conversation.customer_phone
            ? maskPhone(conversation.customer_phone)
            : conversation.customer_phone,
        last_message:
          role === APPLICATION_ROLES.SALE
            ? sanitizePhoneInText(conversation.last_message)
            : conversation.last_message,
      };
      const [pageAwareConversation] = await attachFacebookPageInfo(
        companyId,
        [sanitizedConv],
        typedContext?.supabaseClient
      );

      return NextResponse.json({
        success: true,
        data: { conversation: pageAwareConversation, messages },
      });
    }

    const conversations = await InboxService.getConversations(
      companyId,
      { channel, search },
      role
    );

    const sanitizedConversations = conversations.map((conversation) => ({
      ...conversation,
      customer_phone:
        role === APPLICATION_ROLES.SALE && conversation.customer_phone
          ? maskPhone(conversation.customer_phone)
          : conversation.customer_phone,
      last_message:
        role === APPLICATION_ROLES.SALE
          ? sanitizePhoneInText(conversation.last_message)
          : conversation.last_message,
    }));
    const pageAwareConversations = await attachFacebookPageInfo(
      companyId,
      sanitizedConversations,
      typedContext?.supabaseClient
    );

    return NextResponse.json({ success: true, data: pageAwareConversations });
  } catch (err: unknown) {
    const errorObj = err as { code?: string; message?: string } | undefined;
    if (errorObj?.code === 'AUDIT_WRITE_FAILED') {
      return NextResponse.json(
        {
          success: false,
          error: 'AUDIT_WRITE_FAILED',
          message: errorObj.message || 'Lỗi ghi nhận kiểm toán bắt buộc. Thao tác xem nội dung gốc bị từ chối.',
        },
        { status: 500 }
      );
    }

    console.error('Inbox GET failed:', err);
    return NextResponse.json(
      { success: false, error: 'DATABASE_ERROR', message: 'Lỗi xử lý dữ liệu trên hệ thống.' },
      { status: 500 }
    );
  }
}

function facebookFailure(status: string) {
  if (status === 'FAILED') {
    return NextResponse.json(
      {
        success: false,
        error: 'FACEBOOK_SEND_FAILED',
        message: 'Facebook từ chối tin nhắn. Tin chưa được gửi đến khách hàng.',
      },
      { status: 502 }
    );
  }

  if (status === 'UNKNOWN') {
    return NextResponse.json(
      {
        success: false,
        error: 'FACEBOOK_SEND_UNCERTAIN',
        message: 'Chưa xác định được Facebook đã nhận tin nhắn hay chưa. Không tự động gửi lại để tránh gửi trùng.',
      },
      { status: 503 }
    );
  }

  return NextResponse.json(
    {
      success: false,
      error: 'FACEBOOK_SEND_IN_PROGRESS',
      message: 'Tin nhắn đang được xử lý. Vui lòng làm mới hội thoại trước khi thử lại.',
    },
    { status: 409 }
  );
}

export async function POST(request: NextRequest, context?: unknown) {
  try {
    const typedContext = context as InboxRouteContext | undefined;
    const authResult = await resolveInboxActor(typedContext);
    if (authResult.errorResponse) return authResult.errorResponse;

    const { companyId, userId, role } = authResult.actor!;
    const body = await request.json().catch(() => null);

    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { success: false, error: 'INVALID_PAYLOAD', message: 'Dữ liệu yêu cầu không hợp lệ.' },
        { status: 400 }
      );
    }

    const { conversation_id, content } = body as Record<string, unknown>;

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

    const rawCommandId =
      request.headers.get('x-client-command-id') ||
      request.headers.get('x-idempotency-key') ||
      (typeof (body as Record<string, unknown>).client_command_id === 'string'
        ? ((body as Record<string, unknown>).client_command_id as string)
        : null) ||
      (typeof (body as Record<string, unknown>).clientCommandId === 'string'
        ? ((body as Record<string, unknown>).clientCommandId as string)
        : null);

    const clientCommandId = rawCommandId ? rawCommandId.trim() : undefined;

    if (!clientCommandId) {
      return NextResponse.json(
        {
          success: false,
          error: 'MISSING_COMMAND_ID',
          message: 'Yêu cầu client_command_id để đảm bảo tính idempotent.',
        },
        { status: 400 }
      );
    }

    if (!UUID_REGEX.test(clientCommandId)) {
      return NextResponse.json(
        {
          success: false,
          error: 'INVALID_COMMAND_ID',
          message: 'client_command_id không hợp lệ (Bắt buộc phải là UUID).',
        },
        { status: 400 }
      );
    }

    const conversation = await InboxService.getConversationById(
      companyId,
      conversation_id,
      role,
      typedContext?.supabaseClient
    );

    if (!conversation) {
      return NextResponse.json(
        {
          success: false,
          error: 'NOT_FOUND',
          message: 'Không tìm thấy cuộc hội thoại hoặc không thuộc quyền quản lý của tổ chức.',
        },
        { status: 404 }
      );
    }

    // Production Facebook conversations must use the canonical provider sender.
    // Injected route contexts are a test seam and keep using the mockable inbox service.
    const hasInjectedTestContext =
      typedContext?.actor !== undefined || typedContext?.supabaseClient !== undefined;

    if (conversation.channel === 'facebook' && !hasInjectedTestContext) {
      try {
        const delivery = await sendFacebookMessage(conversation_id, {
          content: content.trim(),
          request_id: clientCommandId,
        });

        if (delivery.status !== 'SENT') {
          return facebookFailure(delivery.status);
        }

        const messages = await InboxService.getMessagesByConversationId(
          companyId,
          conversation_id,
          role,
          undefined,
          { userId, actorId: userId }
        );
        const latest = messages[messages.length - 1];

        if (!latest) {
          return NextResponse.json(
            {
              success: true,
              data: {
                id: clientCommandId,
                company_id: companyId,
                conversation_id,
                customer_id: conversation.customer_id,
                channel: 'facebook',
                sender_type: 'sale',
                content: sanitizePhoneInText(content.trim()),
                sanitized_content: sanitizePhoneInText(content.trim()),
                sanitization_status: 'SUCCEEDED',
                created_at: new Date().toISOString(),
                direction: 'outbound',
                delivery_status: 'SENT',
                client_command_id: clientCommandId,
                is_duplicate: false,
              },
              message: 'Đã gửi tin nhắn đến khách hàng qua Facebook Messenger.',
            },
            { status: 201 }
          );
        }

        const { raw_content: _rawContent, ...safeData } = latest;
        return NextResponse.json(
          {
            success: true,
            data: {
              ...safeData,
              delivery_status: 'SENT',
              client_command_id: clientCommandId,
              is_duplicate: false,
            },
            message: 'Đã gửi tin nhắn đến khách hàng qua Facebook Messenger.',
          },
          { status: 201 }
        );
      } catch (sendErr: unknown) {
        if (sendErr instanceof ChannelError) {
          return NextResponse.json(
            {
              success: false,
              error: sendErr.code,
              message:
                sendErr.code === 'MESSAGING_WINDOW_CLOSED'
                  ? 'Đã quá cửa sổ phản hồi Messenger cho hội thoại này.'
                  : `Không thể gửi tin nhắn Facebook (${sendErr.code}).`,
            },
            { status: sendErr.status }
          );
        }

        const errorObj = sendErr as { status?: number; code?: string } | undefined;
        if (errorObj?.status && errorObj.status >= 400 && errorObj.status < 600) {
          return NextResponse.json(
            {
              success: false,
              error: errorObj.code || 'FACEBOOK_SEND_ERROR',
              message:
                errorObj.code === 'MFA_REQUIRED'
                  ? 'Cần xác thực MFA/AAL2 trước khi gửi tin nhắn với tài khoản quản trị viên.'
                  : 'Không thể gửi tin nhắn Facebook.',
            },
            { status: errorObj.status }
          );
        }

        throw sendErr;
      }
    }

    try {
      const newMessage = await InboxService.sendMessage(
        {
          conversation_id,
          company_id: companyId,
          content: content.trim(),
          sender_type: 'sale',
          clientCommandId,
          actor_user_id: userId,
        },
        companyId,
        typedContext?.supabaseClient
      );

      const { raw_content: _rawContent, ...safeData } = newMessage;
      const isDuplicate = Boolean(safeData.is_duplicate);

      return NextResponse.json(
        {
          success: true,
          data: {
            ...safeData,
            client_command_id: safeData.client_command_id || clientCommandId,
            delivery_status: safeData.delivery_status || 'PENDING_DISPATCH',
            is_duplicate: isDuplicate,
          },
          message: isDuplicate
            ? 'Lệnh gửi tin nhắn đã được ghi nhận trước đó (Idempotent OK).'
            : 'Tiếp nhận tin nhắn thành công, đang xếp hàng gửi đến khách hàng.',
        },
        { status: isDuplicate ? 200 : 201 }
      );
    } catch (sendErr: unknown) {
      const errorObj = sendErr as { status?: number; code?: string; message?: string } | undefined;
      if (errorObj?.status === 404 || errorObj?.code === 'NOT_FOUND') {
        return NextResponse.json(
          {
            success: false,
            error: 'NOT_FOUND',
            message: errorObj.message || 'Không tìm thấy cuộc hội thoại hoặc không thuộc quyền quản lý của tổ chức.',
          },
          { status: 404 }
        );
      }
      if (errorObj?.status === 400 || errorObj?.code === 'BAD_REQUEST') {
        return NextResponse.json(
          { success: false, error: 'BAD_REQUEST', message: errorObj.message },
          { status: 400 }
        );
      }
      throw sendErr;
    }
  } catch (err: unknown) {
    console.error('Inbox POST failed:', err);
    return NextResponse.json(
      { success: false, error: 'DATABASE_ERROR', message: 'Lỗi xử lý dữ liệu trên hệ thống.' },
      { status: 500 }
    );
  }
}