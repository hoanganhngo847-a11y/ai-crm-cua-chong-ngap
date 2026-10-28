import { NextRequest, NextResponse } from 'next/server';
import { getActorContext } from '../../../../../lib/auth/context';
import { createAdminClient } from '../../../../../lib/supabase/admin';
import { APPLICATION_ROLES } from '../../../../../shared/constants/roles';
import { CustomerService } from '../../../../../features/crm/services/customer.service';
import type { ActorContext } from '../../../../../shared/contracts/auth';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface StageSuggestionsRouteContext {
  params: Promise<{ id: string }>;
  actor?: ActorContext | null;
  adminClient?: SupabaseClient;
}

/**
 * GET /api/customers/[id]/stage-suggestions
 * Danh sách đề xuất giai đoạn của AI cho một khách hàng.
 * Đây chỉ là gợi ý, không thay đổi giai đoạn chính thức.
 */
export async function GET(request: NextRequest, context: StageSuggestionsRouteContext) {
  try {
    const actor = context?.actor !== undefined ? context.actor : await getActorContext();

    if (!actor || actor.profileStatus !== 'ACTIVE') {
      return NextResponse.json(
        { success: false, error: 'UNAUTHORIZED', message: 'Yêu cầu đăng nhập để truy cập.' },
        { status: 401 }
      );
    }

    if (!actor.companyId || actor.membershipStatus !== 'ACTIVE' || !actor.role) {
      return NextResponse.json(
        { success: false, error: 'FORBIDDEN', message: 'Tài khoản không thuộc tổ chức hợp lệ.' },
        { status: 403 }
      );
    }

    if (actor.role !== APPLICATION_ROLES.SALE && actor.role !== APPLICATION_ROLES.BOSS_ADMIN) {
      return NextResponse.json(
        {
          success: false,
          error: 'ROLE_FORBIDDEN',
          message: 'Chỉ nhân viên SALE hoặc BOSS_ADMIN mới có quyền xem đề xuất giai đoạn.',
        },
        { status: 403 }
      );
    }

    const { id: customerId } = await context.params;
    if (!customerId) {
      return NextResponse.json(
        { success: false, error: 'MISSING_PARAM', message: 'Mã khách hàng là bắt buộc.' },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(request.url);
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '10', 10) || 10, 1), 50);

    const adminClient = context?.adminClient || createAdminClient();
    const suggestions = await CustomerService.getStageSuggestions(
      actor.companyId,
      customerId,
      limit,
      adminClient
    );

    return NextResponse.json({ success: true, data: suggestions });
  } catch (err: unknown) {
    console.error('Lỗi API đọc đề xuất giai đoạn:', err);
    return NextResponse.json(
      { success: false, error: 'DATABASE_ERROR', message: 'Lỗi xử lý dữ liệu trên hệ thống.' },
      { status: 500 }
    );
  }
}
