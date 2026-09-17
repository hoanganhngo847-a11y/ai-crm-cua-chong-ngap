import { NextRequest, NextResponse } from 'next/server';
import { getActorContext } from '../../../lib/auth/context';
import { createAdminClient } from '../../../lib/supabase/admin';
import { APPLICATION_ROLES } from '../../../shared/constants/roles';
import { CustomerService } from '../../../features/crm/services/customer.service';
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
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '20', 10), 1), 100);
    const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);

    const adminClient = context?.adminClient || createAdminClient();

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
      query = query.eq('stage', stage);
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

    const customerList = (customers as Customer[]) || [];
    if (customerList.length === 0) {
      return NextResponse.json({
        success: true,
        data: [],
        pagination: {
          total: count || 0,
          limit,
          offset,
        },
      });
    }

    const customerIds = customerList.map((c) => c.id);

    // 2. Nạp thông tin liên hệ từ schema private (Chỉ thực hiện ở Trusted Server)
    const contactMap = new Map<
      string,
      { raw_phone: string; normalized_phone: string; is_verified: boolean }
    >();

    try {
      const { data: contacts } = await adminClient
        .schema('private')
        .from('customer_private_contacts')
        .select('customer_id, raw_phone, normalized_phone, is_verified')
        .eq('company_id', actor.companyId)
        .in('customer_id', customerIds);

      if (contacts) {
        for (const c of contacts) {
          contactMap.set(c.customer_id, {
            raw_phone: c.raw_phone,
            normalized_phone: c.normalized_phone,
            is_verified: c.is_verified,
          });
        }
      }
    } catch {
      // Trường hợp schema private không thể truy cập qua direct PostgREST, fallback query qua identity hoặc RPC
    }

    // 3. Nạp danh sách identities đa kênh
    const identityMap = new Map<string, Identity[]>();
    const { data: identities } = await adminClient
      .from('identities')
      .select('*')
      .eq('company_id', actor.companyId)
      .in('customer_id', customerIds);

    if (identities) {
      for (const id of identities as Identity[]) {
        const list = identityMap.get(id.customer_id) || [];
        list.push(id);
        identityMap.set(id.customer_id, list);
      }
    }

    // 4. Áp dụng sanitizeForRole: Tự động che số nếu là SALE, mở số nếu là BOSS_ADMIN
    const sanitizedCustomers = customerList.map((customer) => {
      const customerBundle: CustomerWithContact = {
        customer,
        contact: contactMap.get(customer.id) || null,
        identities: identityMap.get(customer.id) || [],
      };

      return CustomerService.sanitizeForRole(customerBundle, actor.role);
    });

    // 5. GHI NHẬN KIỂM TOÁN (AUDIT LOG): Bắt buộc khi vai trò là BOSS_ADMIN xem số điện thoại thật
    if (actor.role === APPLICATION_ROLES.BOSS_ADMIN && customerIds.length > 0) {
      try {
        await adminClient.from('audit_logs').insert({
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
      } catch (auditErr) {
        console.error('Lỗi khi ghi audit log truy cập số điện thoại:', auditErr);
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

    // GHI NHẬN KIỂM TOÁN (AUDIT LOG): Bắt buộc khi vai trò là BOSS_ADMIN xem số điện thoại thật
    if (actor.role === APPLICATION_ROLES.BOSS_ADMIN) {
      try {
        await adminClient.from('audit_logs').insert({
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
      } catch (auditErr) {
        console.error('Lỗi khi ghi audit log trong POST /api/customers:', auditErr);
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
