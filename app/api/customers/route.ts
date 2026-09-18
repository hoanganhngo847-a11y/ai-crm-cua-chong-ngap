import { NextRequest, NextResponse } from 'next/server';
import { getActorContext } from '../../../lib/auth/context';
import { createAdminClient } from '../../../lib/supabase/admin';
import { APPLICATION_ROLES } from '../../../shared/constants/roles';
import { CustomerService } from '../../../features/crm/services/customer.service';
import { InboxService } from '../../../features/inbox/services/inbox.service';
import type {
  Customer,
  CustomerSource,
  CustomerStage,
  CustomerWithContact,
  Identity,
  IdentityChannel,
} from '../../../features/crm/types/customer.types';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActorContext } from '../../../shared/contracts/auth';

export interface CustomerRouteContext {
  params?: Promise<Record<string, string | string[]>>;
  actor?: ActorContext | null;
  adminClient?: SupabaseClient;
}

/**
 * GET /api/customers
 * Lấy danh sách khách hàng có lọc, phân trang và tự động che số điện thoại cho SALE.
 *
 * Phân quyền:
 * - BOSS_ADMIN: Được xem danh sách với số điện thoại thật.
 * - SALE: Được xem danh sách với số điện thoại đã che (ví dụ: 09******12).
 * - TECHNICIAN: Bị từ chối truy cập (403 Forbidden).
 */
export async function GET(request: NextRequest, context?: CustomerRouteContext) {
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

    // TECHNICIAN không được phép xem danh bạ / danh sách khách hàng CRM tổng
    if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
      return NextResponse.json(
        {
          success: false,
          error: 'ROLE_FORBIDDEN',
          message: 'Kỹ thuật viên không có quyền truy cập danh sách khách hàng CRM.',
        },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search')?.trim() || '';
    const stage = searchParams.get('stage') as CustomerStage | null;
    const source = searchParams.get('source') as CustomerSource | null;
    const urgentClosing =
      searchParams.get('urgent_closing') === 'true' || searchParams.get('queue') === 'urgent_closing';
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '20', 10), 1), 100);
    const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);

    const adminClient = context?.adminClient || createAdminClient();

    // Lấy danh sách ID khách hàng có tin nhắn phản hồi mới (PENDING_SALE) từ Hộp thư
    const pendingSaleCustomerIds = new Set<string>();
    try {
      const convs = await InboxService.getConversations(actor.companyId);
      for (const c of convs) {
        if (c.status === 'PENDING_SALE' || (c.unread_count && c.unread_count > 0)) {
          pendingSaleCustomerIds.add(c.customer_id);
        }
      }
    } catch {}

    // 1. Truy vấn danh sách khách hàng từ public.customers
    let query = adminClient
      .from('customers')
      .select('*', { count: 'exact' })
      .eq('company_id', actor.companyId);

    if (search) {
      // Tìm theo tên hoặc customer_code
      query = query.or(`name.ilike.%${search}%,customer_code.ilike.%${search}%`);
    }
    if (stage) {
      query = query.eq('stage', CustomerService.toCanonicalStage(stage));
    }
    if (source) {
      query = query.eq('source', source);
    }

    query = query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data: customers, count, error: fetchErr } = await query;

    if (fetchErr) {
      return NextResponse.json(
        { success: false, error: 'DATABASE_ERROR', message: fetchErr.message },
        { status: 500 }
      );
    }

    let customerList = (customers as Customer[]) || [];

    const isDemoMode = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

    // Fallback nạp danh sách khách hàng mẫu giai đoạn 2: Chỉ kích hoạt khi có cờ explicit NEXT_PUBLIC_DEMO_MODE === 'true'
    if (isDemoMode && customerList.length === 0 && !search && !stage && !source) {
      customerList = [
        {
          id: 'cust-1',
          company_id: actor.companyId,
          customer_code: 'KH-000001',
          name: 'Anh Hoàng Nam',
          source: 'FACEBOOK',
          stage: CustomerService.mockCustomerStages['cust-1'] || 'PRICE_OFFERED',
          created_at: '2026-09-16T08:00:00Z',
          updated_at: '2026-09-17T09:30:00Z',
        },
        {
          id: 'cust-2',
          company_id: actor.companyId,
          customer_code: 'KH-000002',
          name: 'Chị Mai Phương',
          source: 'ZALO',
          stage: CustomerService.mockCustomerStages['cust-2'] || 'SURVEY_SCHEDULED',
          created_at: '2026-09-16T14:20:00Z',
          updated_at: '2026-09-17T10:15:00Z',
        },
        {
          id: 'cust-3',
          company_id: actor.companyId,
          customer_code: 'KH-000003',
          name: 'Bác Quốc Tuấn',
          source: 'FACEBOOK',
          stage: CustomerService.mockCustomerStages['cust-3'] || 'WARRANTY_ACTIVE',
          created_at: '2026-09-15T11:00:00Z',
          updated_at: '2026-09-17T08:05:00Z',
        },
        {
          id: 'cust-4',
          company_id: actor.companyId,
          customer_code: 'KH-000004',
          name: 'Anh Trọng Hiếu',
          source: 'ZALO',
          stage: CustomerService.mockCustomerStages['cust-4'] || 'DEPOSIT_CONFIRMED',
          created_at: '2026-09-14T09:10:00Z',
          updated_at: '2026-09-16T16:45:00Z',
        },
      ];
    }

    const customerIds = customerList.map((c) => c.id);

    // 2. Nạp thông tin liên hệ: Tách biệt chặt chẽ theo vai trò (Zero-Phone cho SALE, Trusted RPC cho BOSS_ADMIN)
    const contactMap = new Map<
      string,
      { raw_phone: string; normalized_phone: string; is_verified: boolean }
    >();

    const mockMaskedMap: Record<string, string> = {
      'cust-1': '09******12',
      'cust-2': '09******90',
      'cust-3': '09******21',
      'cust-4': '09******00',
    };

    if (actor.role === APPLICATION_ROLES.BOSS_ADMIN) {
      // Mock contact mapping cho BOSS_ADMIN (chỉ kích hoạt trong demo mode)
      if (isDemoMode) {
        contactMap.set('cust-1', { raw_phone: '0912345612', normalized_phone: '+84912345612', is_verified: true });
        contactMap.set('cust-2', { raw_phone: '0934567890', normalized_phone: '+84934567890', is_verified: true });
        contactMap.set('cust-3', { raw_phone: '0987654321', normalized_phone: '+84987654321', is_verified: true });
        contactMap.set('cust-4', { raw_phone: '0977889900', normalized_phone: '+84977889900', is_verified: true });
      }

      // Đối với ID thật trong database: Sử dụng Trusted RPC của Foundation thay vì chọc trực tiếp vào schema private
      const realDbCustomerIds = customerIds.filter((cid) => !cid.startsWith('cust-'));
      for (const realCid of realDbCustomerIds) {
        try {
          const { data: rpcData, error: rpcErr } = await adminClient.rpc('get_customer_private_contact', {
            p_company_id: actor.companyId,
            p_customer_id: realCid,
          });
          if (rpcErr && !isDemoMode) {
            return NextResponse.json(
              { success: false, error: 'DATABASE_ERROR', message: rpcErr.message },
              { status: 500 }
            );
          }
          if (rpcData && rpcData.length > 0) {
            contactMap.set(realCid, {
              raw_phone: rpcData[0].raw_phone,
              normalized_phone: rpcData[0].normalized_phone,
              is_verified: rpcData[0].is_verified,
            });
          }
        } catch (rpcEx: unknown) {
          if (!isDemoMode) {
            return NextResponse.json(
              { success: false, error: 'DATABASE_ERROR', message: rpcEx instanceof Error ? rpcEx.message : 'RPC_ERROR' },
              { status: 500 }
            );
          }
        }
      }
    }
    // Chú ý: Với vai trò SALE, TUYỆT ĐỐI KHÔNG nạp contactMap với số thật và không gọi sensitive primitive!

    // 3. Nạp danh sách identities đa kênh
    const identityMap = new Map<string, Identity[]>();
    const { data: identities, error: identitiesErr } = await adminClient
      .from('identities')
      .select('*')
      .eq('company_id', actor.companyId)
      .in('customer_id', customerIds);

    if (identitiesErr && !isDemoMode) {
      return NextResponse.json(
        { success: false, error: 'DATABASE_ERROR', message: identitiesErr.message },
        { status: 500 }
      );
    }

    if (identities) {
      for (const id of identities as Identity[]) {
        const list = identityMap.get(id.customer_id) || [];
        list.push(id);
        identityMap.set(id.customer_id, list);
      }
    }

    // 4. Áp dụng sanitizeForRole và đánh giá Hàng chờ "CẦN SALE CHỐT"
    let sanitizedCustomers = customerList.map((customer) => {
      const urgency = CustomerService.evaluateUrgency(customer, pendingSaleCustomerIds);
      const customerBundle: CustomerWithContact = {
        customer,
        contact: contactMap.get(customer.id) || null,
        identities: identityMap.get(customer.id) || [],
      };

      const sanitized = CustomerService.sanitizeForRole(
        customerBundle,
        actor.role,
        urgency.isUrgent ? urgency : undefined
      );

      // Nếu là SALE mà chưa có phone hiển thị và là khách mock trong demo mode, gán số đã mask
      if (isDemoMode && actor.role === APPLICATION_ROLES.SALE && !sanitized.phone && mockMaskedMap[customer.id]) {
        sanitized.phone = mockMaskedMap[customer.id];
      }

      return sanitized;
    });

    // Lọc theo Hàng chờ "CẦN SALE CHỐT" nếu được yêu cầu
    if (urgentClosing) {
      sanitizedCustomers = sanitizedCustomers.filter((c) => Boolean(c.urgency_reason));
    }

    // 5. GHI NHẬN KIỂM TOÁN (AUDIT LOG): Bắt buộc khi vai trò là BOSS_ADMIN xem số điện thoại thật (FAIL-CLOSED)
    if (actor.role === APPLICATION_ROLES.BOSS_ADMIN && customerIds.length > 0) {
      const { error: auditErr } = await adminClient.from('audit_logs').insert({
        company_id: actor.companyId,
        user_id: actor.userId,
        action: 'VIEW_RAW_PHONE',
        resource_type: 'CUSTOMER',
        resource_id: customerIds[0],
        customer_id: customerIds.length === 1 ? customerIds[0] : null,
        result: 'SUCCESS',
        metadata: {
          viewed_count: customerIds.length,
          customer_ids: customerIds,
          purpose: 'CUSTOMER_LIST_VIEW',
          reason: 'Xem danh sách khách hàng kèm số điện thoại thật (BOSS_ADMIN)',
        },
      });

      if (auditErr) {
        console.error('Lỗi khi ghi audit log truy cập số điện thoại:', auditErr);
        // FAIL CLOSED: Dừng ngay lập tức, TUYỆT ĐỐI KHÔNG trả về raw phone nếu audit log thất bại
        return NextResponse.json(
          {
            success: false,
            error: 'AUDIT_WRITE_FAILED',
            message: 'Lỗi ghi nhận kiểm toán bắt buộc. Thao tác xem thông tin bảo mật bị từ chối.',
          },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      success: true,
      data: sanitizedCustomers,
      pagination: {
        total: count || 0,
        limit,
        offset,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Lỗi không xác định khi tải danh sách khách hàng.';
    return NextResponse.json(
      { success: false, error: 'INTERNAL_ERROR', message },
      { status: 500 }
    );
  }
}

/**
 * POST /api/customers
 * Tạo mới hoặc gộp khách hàng theo số điện thoại (findOrCreateByPhone) kèm liên kết đa kênh.
 *
 * Phân quyền:
 * - BOSS_ADMIN và SALE được phép tạo khách hàng.
 * - TECHNICIAN bị từ chối (403 Forbidden).
 */
export async function POST(request: NextRequest, context?: CustomerRouteContext) {
  try {
    const actor = context?.actor !== undefined ? context.actor : await getActorContext();

    if (!actor || actor.profileStatus !== 'ACTIVE') {
      return NextResponse.json(
        { success: false, error: 'UNAUTHORIZED', message: 'Yêu cầu đăng nhập để tạo khách hàng.' },
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
          message: 'Kỹ thuật viên không có quyền tạo khách hàng mới.',
        },
        { status: 403 }
      );
    }

    const adminClient = context?.adminClient || createAdminClient();

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { success: false, error: 'INVALID_PAYLOAD', message: 'Dữ liệu yêu cầu không hợp lệ.' },
        { status: 400 }
      );
    }

    const { name, phone, source, stage, channel, external_id, metadata, verified } = body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json(
        { success: false, error: 'MISSING_FIELD', message: 'Tên khách hàng là bắt buộc.' },
        { status: 400 }
      );
    }

    if (!phone || typeof phone !== 'string' || !phone.trim()) {
      return NextResponse.json(
        { success: false, error: 'MISSING_FIELD', message: 'Số điện thoại là bắt buộc.' },
        { status: 400 }
      );
    }

    // Thực hiện tìm kiếm hoặc tạo mới khách hàng qua CustomerService
    let result;
    try {
      result = await CustomerService.findOrCreateByPhone({
        companyId: actor.companyId,
        phone: phone.trim(),
        name: name.trim(),
        source: source as CustomerSource | undefined,
        stage: stage as CustomerStage | undefined,
        channel: channel as IdentityChannel | undefined,
        externalId: external_id,
        metadata,
        verified: Boolean(verified),
        actorUserId: actor.userId,
      }, context?.adminClient);
    } catch (serviceErr: unknown) {
      const errMsg =
        serviceErr instanceof Error ? serviceErr.message : 'Lỗi xử lý khách hàng theo số điện thoại.';

      if (errMsg.includes('CONFIGURATION_ERROR')) {
        return NextResponse.json(
          { success: false, error: 'CONFIGURATION_ERROR', message: errMsg },
          { status: 500 }
        );
      }

      if (
        errMsg.includes('Lỗi tạo') ||
        errMsg.includes('Lỗi ghi nhận') ||
        errMsg.includes('Lỗi truy vấn') ||
        errMsg.includes('Lỗi kiểm tra') ||
        errMsg.includes('Lỗi liên kết') ||
        errMsg.includes('DATABASE_ERROR')
      ) {
        return NextResponse.json(
          { success: false, error: 'DATABASE_ERROR', message: errMsg },
          { status: 500 }
        );
      }

      return NextResponse.json(
        { success: false, error: 'VALIDATION_FAILED', message: errMsg },
        { status: 400 }
      );
    }

    // Làm sạch dữ liệu theo vai trò của người gọi
    const customerBundle: CustomerWithContact = {
      customer: result.customer,
      contact: result.contact,
      identities: result.identities,
    };

    const sanitizedCustomer = CustomerService.sanitizeForRole(customerBundle, actor.role);

    // GHI NHẬN KIỂM TOÁN (AUDIT LOG): Bắt buộc khi vai trò là BOSS_ADMIN xem số điện thoại thật (FAIL-CLOSED)
    if (actor.role === APPLICATION_ROLES.BOSS_ADMIN) {
      const { error: auditErr } = await adminClient.from('audit_logs').insert({
        company_id: actor.companyId,
        user_id: actor.userId,
        action: 'VIEW_RAW_PHONE',
        resource_type: 'CUSTOMER',
        resource_id: result.customer.id,
        customer_id: result.customer.id,
        result: 'SUCCESS',
        metadata: {
          customer_code: result.customer.customer_code,
          viewed_count: 1,
          customer_ids: [result.customer.id],
          purpose: result.isNew ? 'CUSTOMER_CREATE' : 'CUSTOMER_FIND',
          reason: 'Tạo hoặc tìm khách hàng với số điện thoại thật (BOSS_ADMIN)',
        },
      });

      if (auditErr) {
        console.error('Lỗi khi ghi audit log trong POST /api/customers:', auditErr);
        // FAIL CLOSED: Hủy thao tác ngay lập tức nếu ghi audit log thất bại
        return NextResponse.json(
          {
            success: false,
            error: 'AUDIT_WRITE_FAILED',
            message: 'Lỗi ghi nhận kiểm toán bắt buộc. Thao tác bị từ chối.',
          },
          { status: 500 }
        );
      }
    }

    return NextResponse.json(
      {
        success: true,
        data: sanitizedCustomer,
        is_new: result.isNew,
        message: result.isNew
          ? 'Tạo mới hồ sơ khách hàng thành công.'
          : 'Số điện thoại đã tồn tại. Đã tự động gộp và liên kết danh tính.',
      },
      { status: result.isNew ? 201 : 200 }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Lỗi máy chủ khi tạo khách hàng.';
    return NextResponse.json(
      { success: false, error: 'INTERNAL_ERROR', message },
      { status: 500 }
    );
  }
}
