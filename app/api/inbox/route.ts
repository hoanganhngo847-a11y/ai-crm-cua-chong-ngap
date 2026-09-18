import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServerClient } from '../../../lib/supabase/server';
import { APPLICATION_ROLES } from '../../../shared/constants/roles';
import { InboxService } from '../../../features/inbox/services/inbox.service';
import { maskPhone } from '../../../features/crm/services/customer.service';
import { sanitizePhoneInText } from '../../../features/crm/utils/phone-sanitizer';
import type { InboxChannel } from '../../../features/inbox/types/inbox.types';
import type { ActorContext } from '../../../shared/contracts/auth';
import type { SupabaseClient } from '@supabase/supabase-js';

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

/**
 * Xác thực và phân giải danh tính actor có membership ACTIVE:
 * 1. Xác thực người dùng bằng Supabase server client (getUser). Chặn 401 nếu chưa đăng nhập.
 * 2. Lấy company_id từ bản ghi membership (company_members/members với status = 'ACTIVE') của user đang đăng nhập.
 *    Tuyệt đối KHÔNG tin company_id từ query param hay body client gửi lên.
 * 3. Kiểm tra RBAC: Chặn vai trò TECHNICIAN (trả 403 FORBIDDEN). Chỉ SALE và BOSS_ADMIN mới được truy cập Inbox.
 */
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
    // 1. Xác thực người dùng bằng Supabase server client (getUser). Chặn 401 nếu chưa đăng nhập.
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

    // 2. Lấy thông tin membership của user trong bảng 'company_members' hoặc 'members' với status = 'ACTIVE'
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
      if (mData) {
        memberRecord = mData;
      }
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

  // 3. Kiểm tra RBAC: Chặn vai trò TECHNICIAN (trả 403 FORBIDDEN). Chỉ SALE và BOSS_ADMIN mới được truy cập Inbox.
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

/**
 * GET /api/inbox
 * Lấy danh sách cuộc hội thoại hoặc tin nhắn chi tiết theo conversation_id.
 *
 * Phân quyền & Tenant Isolation (Lỗi P0 - Việc 4):
 * - Xác thực Supabase server client (getUser), chặn 401 nếu chưa đăng nhập.
 * - Lấy company_id từ membership ACTIVE của user, chặn đứng cross-tenant.
 * - RBAC: Chỉ BOSS_ADMIN và SALE được phép. TECHNICIAN bị từ chối (403).
 * - Truyền companyId vào tất cả các lời gọi InboxService.
 * - Trả 404 NOT_FOUND nếu conversationId không tồn tại hoặc không thuộc quyền sở hữu của tenant.
 */
export async function GET(request: NextRequest, context?: InboxRouteContext) {
  try {
    const authResult = await resolveInboxActor(context);
    if (authResult.errorResponse) {
      return authResult.errorResponse;
    }
    const { companyId, role } = authResult.actor!;

    const { searchParams } = new URL(request.url);
    const conversationId = searchParams.get('conversation_id')?.trim();
    const channel = (searchParams.get('channel')?.trim() || 'all') as InboxChannel | 'all';
    const search = searchParams.get('search')?.trim() || '';

    // Nếu có conversation_id: Lấy chi tiết cuộc trò chuyện và danh sách tin nhắn
    if (conversationId) {
      // Resource Authorization: getConversationById lọc nghiêm ngặt theo companyId
      const conversation = await InboxService.getConversationById(companyId, conversationId, role);
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

      // Lấy tin nhắn (bảo vệ tài nguyên, fail-closed 404 nếu sai tenant & làm sạch Zero-Phone cho SALE)
      let messages;
      try {
        messages = await InboxService.getMessagesByConversationId(companyId, conversationId, role);
      } catch (err: any) {
        if (err?.status === 404 || err?.code === 'NOT_FOUND') {
          return NextResponse.json(
            {
              success: false,
              error: 'NOT_FOUND',
              message: err.message || 'Cuộc hội thoại không tồn tại hoặc không thuộc quyền quản lý của tổ chức.',
            },
            { status: 404 }
          );
        }
        throw err;
      }

      // Áp dụng Zero-Phone Invariant cho SALE
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

      return NextResponse.json({
        success: true,
        data: {
          conversation: sanitizedConv,
          messages,
        },
      });
    }

    // Nếu không có conversation_id: Lấy danh sách toàn bộ cuộc hội thoại thuộc companyId
    const conversations = await InboxService.getConversations(
      companyId,
      {
        channel,
        search,
      },
      role
    );

    // Áp dụng bảo vệ số điện thoại và làm sạch tin nhắn cuối cho danh sách
    const sanitizedConversations = conversations.map((c) => ({
      ...c,
      customer_phone:
        role === APPLICATION_ROLES.SALE && c.customer_phone
          ? maskPhone(c.customer_phone)
          : c.customer_phone,
      last_message:
        role === APPLICATION_ROLES.SALE
          ? sanitizePhoneInText(c.last_message)
          : c.last_message,
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
 * Phân quyền & Tenant Isolation (Lỗi P0 - Việc 4):
 * - Xác thực Supabase server client (getUser), chặn 401 nếu chưa đăng nhập.
 * - Lấy company_id từ membership ACTIVE của user. Tuyệt đối KHÔNG tin company_id từ body client gửi lên.
 * - RBAC: Chỉ SALE và BOSS_ADMIN được phép gửi. TECHNICIAN bị từ chối (403).
 * - Kiểm tra conversationId thuộc quyền sở hữu của caller companyId. Nếu không khớp ném 404 NOT_FOUND.
 */
export async function POST(request: NextRequest, context?: InboxRouteContext) {
  try {
    const authResult = await resolveInboxActor(context);
    if (authResult.errorResponse) {
      return authResult.errorResponse;
    }
    const { companyId } = authResult.actor!;

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

    // Resource Authorization & Tenant Isolation:
    // Tuyệt đối sử dụng companyId được giải mã từ session membership, không lấy từ client body.
    try {
      const newMessage = await InboxService.sendMessage(
        {
          conversation_id,
          company_id: companyId,
          content: content.trim(),
          sender_type: 'sale',
        },
        companyId
      );

      return NextResponse.json(
        {
          success: true,
          data: newMessage,
          message: 'Gửi tin nhắn phản hồi thành công.',
        },
        { status: 201 }
      );
    } catch (sendErr: any) {
      if (sendErr?.status === 404 || sendErr?.code === 'NOT_FOUND') {
        return NextResponse.json(
          {
            success: false,
            error: 'NOT_FOUND',
            message: sendErr.message || 'Không tìm thấy cuộc hội thoại hoặc không thuộc quyền quản lý của tổ chức.',
          },
          { status: 404 }
        );
      }
      if (sendErr?.status === 400 || sendErr?.code === 'BAD_REQUEST') {
        return NextResponse.json(
          { success: false, error: 'BAD_REQUEST', message: sendErr.message },
          { status: 400 }
        );
      }
      throw sendErr;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Lỗi máy chủ khi gửi tin nhắn.';
    return NextResponse.json({ success: false, error: 'INTERNAL_ERROR', message }, { status: 500 });
  }
}
