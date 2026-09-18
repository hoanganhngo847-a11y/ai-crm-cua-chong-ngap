import { NextRequest, NextResponse } from 'next/server';
import { getActorContext } from '../../../../../lib/auth/context';
import { createAdminClient } from '../../../../../lib/supabase/admin';
import { APPLICATION_ROLES } from '../../../../../shared/constants/roles';
import { CustomerService } from '../../../../../features/crm/services/customer.service';
import { STAGE_ACTOR_TYPES } from '../../../../../features/crm/types/customer.types';
import type { ActorContext } from '../../../../../shared/contracts/auth';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface StageRouteContext {
  params: Promise<{ id: string }>;
  actor?: ActorContext | null;
  adminClient?: SupabaseClient;
}

/**
 * PATCH /api/customers/[id]/stage
 * Cập nhật giai đoạn khách hàng và tự động lưu vết lịch sử (customer_stage_histories).
 *
 * Phân quyền:
 * - SALE và BOSS_ADMIN: Được phép cập nhật giai đoạn.
 * - TECHNICIAN: Bị từ chối (403 Forbidden).
 * - Chưa đăng nhập: 401 Unauthorized.
 */
export async function PATCH(request: NextRequest, context: StageRouteContext) {
  try {
    const actor = context?.actor !== undefined ? context.actor : await getActorContext();

    if (!actor || actor.profileStatus !== 'ACTIVE') {
      return NextResponse.json(
        { success: false, error: 'UNAUTHORIZED', message: 'Yêu cầu đăng nhập để thực hiện thao tác.' },
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
          message: 'Kỹ thuật viên không có quyền thay đổi trạng thái khách hàng CRM.',
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

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { success: false, error: 'INVALID_PAYLOAD', message: 'Dữ liệu yêu cầu không hợp lệ.' },
        { status: 400 }
      );
    }

    const { stage, note, source_ref } = body;
    if (!stage || typeof stage !== 'string') {
      return NextResponse.json(
        { success: false, error: 'MISSING_FIELD', message: 'Trạng thái mới (stage) là bắt buộc.' },
        { status: 400 }
      );
    }

    const adminClient = context?.adminClient || createAdminClient();

    const result = await CustomerService.updateStage(
      {
        customerId,
        newStage: stage,
        actorType: STAGE_ACTOR_TYPES.USER,
        note: note ? String(note).trim() : undefined,
        userId: actor.userId,
        companyId: actor.companyId,
        sourceRef: source_ref ? String(source_ref).trim() : undefined,
      },
      adminClient
    );

    // Lấy thông tin liên hệ để làm sạch theo vai trò
    let rawPhone = '';
    try {
      const { data: contactRow } = await adminClient
        .schema('private')
        .from('customer_private_contacts')
        .select('raw_phone, normalized_phone')
        .eq('customer_id', customerId)
        .maybeSingle();

      if (contactRow) {
        rawPhone = contactRow.raw_phone || contactRow.normalized_phone || '';
      }
    } catch {}

    const sanitized = CustomerService.sanitizeForRole(
      {
        customer: result.customer,
        contact: rawPhone ? { raw_phone: rawPhone, normalized_phone: rawPhone } : null,
      },
      actor.role
    );

    return NextResponse.json({
      success: true,
      data: sanitized,
      history: result.history,
      message: `Chuyển giai đoạn khách hàng sang [${result.customer.stage}] thành công.`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Lỗi máy chủ khi cập nhật trạng thái.';
    return NextResponse.json({ success: false, error: 'INTERNAL_ERROR', message }, { status: 500 });
  }
}
