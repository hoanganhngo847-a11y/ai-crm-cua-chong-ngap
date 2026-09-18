import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServerClient } from '../../../../../lib/supabase/server';
import { createAdminClient } from '../../../../../lib/supabase/admin';
import { APPLICATION_ROLES } from '../../../../../shared/constants/roles';
import { CustomerService } from '../../../../../features/crm/services/customer.service';
import { STAGE_ACTOR_TYPES } from '../../../../../features/crm/types/customer.types';
import type { ActorContext } from '../../../../../shared/contracts/auth';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveCustomerPrivateContactForTrustedOperation } from '../../../../../lib/sensitive/customer-contact';
import { CONTACT_ACCESS_PURPOSES } from '../../../../../shared/contracts/sensitive';
import { ServerAuthError } from '../../../../../lib/server-auth/errors';

export interface StageRouteContext {
  params: Promise<{ id: string }>;
  actor?: ActorContext | null;
  supabaseClient?: SupabaseClient;
  adminClient?: SupabaseClient;
}

/**
 * PATCH /api/customers/[id]/stage
 * Cập nhật giai đoạn khách hàng và tự động lưu vết lịch sử (customer_stage_histories).
 *
 * Khóa lỗ hổng Cross-Tenant (P0):
 * 1. Xác thực người dùng bằng Supabase server client (getUser). Chặn 401 nếu chưa đăng nhập.
 * 2. Lấy thông tin membership của user trong bảng 'members'/'company_members' (chỉ chấp nhận status = 'ACTIVE').
 * 3. Derive company_id trực tiếp từ membership của user. Tuyệt đối KHÔNG tin và KHÔNG nhận company_id từ client body/headers.
 * 4. Kiểm tra RBAC: Chặn vai trò 'TECHNICIAN' (trả 403 Forbidden). Chỉ cho phép 'SALE' và 'BOSS_ADMIN'.
 */
export async function PATCH(request: NextRequest, context: StageRouteContext) {
  try {
    let userId: string;
    let companyId: string;
    let userRole: string;
    let supabase: SupabaseClient | undefined = context?.supabaseClient;

    if (context?.actor !== undefined) {
      const actor = context.actor;
      if (!actor || actor.profileStatus !== 'ACTIVE') {
        return NextResponse.json(
          { success: false, error: 'UNAUTHORIZED', message: 'Yêu cầu đăng nhập để thực hiện thao tác.' },
          { status: 401 }
        );
      }

      if (!actor.companyId || actor.membershipStatus !== 'ACTIVE' || !actor.role) {
        return NextResponse.json(
          { success: false, error: 'FORBIDDEN', message: 'Tài khoản không thuộc tổ chức hợp lệ hoặc chưa kích hoạt.' },
          { status: 403 }
        );
      }

      userId = actor.userId;
      companyId = actor.companyId;
      userRole = actor.role;
    } else {
      // 1. Xác thực người dùng bằng Supabase server client (getUser). Chặn 401 nếu chưa đăng nhập.
      supabase = context?.supabaseClient || (await createServerClient());
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser();

      if (authError || !user) {
        return NextResponse.json(
          { success: false, error: 'UNAUTHORIZED', message: 'Yêu cầu đăng nhập để thực hiện thao tác.' },
          { status: 401 }
        );
      }

      userId = user.id;

      // 2. Lấy thông tin membership của user trong bảng 'company_members' (hoặc 'members') với status = 'ACTIVE'
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
        return NextResponse.json(
          { success: false, error: 'FORBIDDEN', message: 'Tài khoản không có membership hoạt động trong tổ chức.' },
          { status: 403 }
        );
      }

      // 3. Derive company_id trực tiếp từ membership của user. Tuyệt đối KHÔNG tin và KHÔNG nhận company_id từ client body/headers.
      companyId = memberRecord.company_id;
      userRole = memberRecord.role;
    }

    // 4. Kiểm tra RBAC: Chặn vai trò 'TECHNICIAN' (trả 403 Forbidden). Chỉ cho phép 'SALE' và 'BOSS_ADMIN'.
    if (userRole === APPLICATION_ROLES.TECHNICIAN) {
      return NextResponse.json(
        {
          success: false,
          error: 'ROLE_FORBIDDEN',
          message: 'Kỹ thuật viên không có quyền thay đổi trạng thái khách hàng CRM.',
        },
        { status: 403 }
      );
    }

    if (userRole !== APPLICATION_ROLES.SALE && userRole !== APPLICATION_ROLES.BOSS_ADMIN) {
      return NextResponse.json(
        {
          success: false,
          error: 'ROLE_FORBIDDEN',
          message: 'Chỉ nhân viên SALE hoặc BOSS_ADMIN mới có quyền thay đổi trạng thái khách hàng.',
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

    // Call CustomerService.updateStage with mandatory companyId derived directly from server context
    const result = await CustomerService.updateStage(
      {
        customerId,
        companyId, // DERIVED DIRECTLY FROM SERVER CONTEXT
        newStage: stage,
        actorType: STAGE_ACTOR_TYPES.USER,
        note: note ? String(note).trim() : undefined,
        userId,
        actorId: userId,
        sourceRef: source_ref ? String(source_ref).trim() : undefined,
      },
      adminClient
    );

    // Xử lý thông tin liên hệ và bảo vệ Zero-Phone cho SALE
    let contactData: { raw_phone: string; normalized_phone: string } | null = null;

    if (userRole === APPLICATION_ROLES.BOSS_ADMIN) {
      try {
        const contact = await resolveCustomerPrivateContactForTrustedOperation(
          customerId,
          CONTACT_ACCESS_PURPOSES.PRIVILEGED_ADMIN_OPERATION,
          {
            reason: 'Cập nhật giai đoạn khách hàng và xem thông tin liên hệ (BOSS_ADMIN)',
            overrideAdminClient: adminClient,
            client: supabase,
          }
        );
        contactData = {
          raw_phone: contact.rawPhone,
          normalized_phone: contact.normalizedPhone,
        };
      } catch (err: unknown) {
        if (err instanceof ServerAuthError) {
          if (err.code === 'RESOURCE_NOT_FOUND') {
            contactData = null;
          } else if (err.code === 'AUDIT_WRITE_FAILED') {
            // FAIL CLOSED: Lỗi ghi nhận kiểm toán bắt buộc, từ chối trả về thông tin nhạy cảm
            return NextResponse.json(
              {
                success: false,
                error: 'AUDIT_WRITE_FAILED',
                message: 'Lỗi ghi nhận kiểm toán bắt buộc. Thao tác bị từ chối.',
              },
              { status: 500 }
            );
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }
    }
    // Đối với vai trò SALE: Tuân thủ Zero-Phone, contactData = null, không gọi primitive sensitive

    const sanitized = CustomerService.sanitizeForRole(
      {
        customer: result.customer,
        contact: contactData,
      },
      userRole
    );

    return NextResponse.json({
      success: true,
      data: sanitized,
      history: result.history,
      message: `Chuyển giai đoạn khách hàng sang [${result.customer.stage}] thành công.`,
    });
  } catch (err: unknown) {
    const errorObj = err as any;
    if (errorObj?.status === 404 || errorObj?.code === 'NOT_FOUND') {
      return NextResponse.json(
        {
          success: false,
          error: 'NOT_FOUND',
          message: errorObj.message || 'Khách hàng không tồn tại hoặc không thuộc quyền quản lý của tổ chức.',
        },
        { status: 404 }
      );
    }
    if (errorObj?.status === 403 || errorObj?.code === 'FORBIDDEN') {
      return NextResponse.json(
        { success: false, error: 'FORBIDDEN', message: errorObj.message || 'Không có quyền truy cập.' },
        { status: 403 }
      );
    }
    const message = err instanceof Error ? err.message : 'Lỗi máy chủ khi cập nhật trạng thái.';
    return NextResponse.json({ success: false, error: 'INTERNAL_ERROR', message }, { status: 500 });
  }
}
