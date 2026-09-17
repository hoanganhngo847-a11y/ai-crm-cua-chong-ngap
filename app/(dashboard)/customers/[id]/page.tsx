import React from 'react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getActorContext } from '../../../../lib/auth/context';
import { createAdminClient } from '../../../../lib/supabase/admin';
import { APPLICATION_ROLES } from '../../../../shared/constants/roles';
import { CustomerService, maskPhone } from '../../../../features/crm/services/customer.service';
import { InboxService } from '../../../../features/inbox/services/inbox.service';
import CustomerTimeline from '../../../../features/crm/components/customer-timeline';
import type { CustomerTimelineEvent } from '../../../../features/inbox/types/inbox.types';

export const metadata = {
  title: 'Hồ sơ khách hàng 360 | AI CRM Cửa Chống Ngập',
  description: 'Hồ sơ chi tiết 360 độ và dòng thời gian hành trình khách hàng',
};

interface CustomerDetailPageProps {
  params: Promise<{ id: string }>;
}

// Dữ liệu mock mở rộng cho Customer 360 của 4 khách hàng mẫu giai đoạn 2
const MOCK_PROFILES_360: Record<
  string,
  {
    id: string;
    customer_code: string;
    name: string;
    phone: string;
    source: string;
    stage: string;
    created_at: string;
    project_specs: {
      width_m: number;
      height_m: number;
      address: string;
      flood_depth: string;
      product_line: string;
      estimated_price?: string;
    };
    identities: Array<{ channel: string; external_id: string; verified: boolean }>;
  }
> = {
  'cust-1': {
    id: 'cust-1',
    customer_code: 'KH-000001',
    name: 'Anh Hoàng Nam',
    phone: '0912345612',
    source: 'FACEBOOK',
    stage: 'PRICE_OFFERED',
    created_at: '2026-09-16T08:00:00Z',
    project_specs: {
      width_m: 2.5,
      height_m: 0.6,
      address: 'Mặt phố Thái Hà, Đống Đa, Hà Nội',
      flood_depth: '40 - 50 cm khi mưa ngập diện rộng',
      product_line: 'Cửa chống ngập tháo lắp hợp kim nhôm 6063-T5',
      estimated_price: '9.500.000 đ',
    },
    identities: [
      { channel: 'FACEBOOK', external_id: 'fb-user-nam-hoang-99', verified: true },
      { channel: 'PHONE', external_id: 'HMAC_SHA256_0912345612', verified: true },
      { channel: 'ZALO', external_id: 'zalo-0912345612', verified: false },
    ],
  },
  'cust-2': {
    id: 'cust-2',
    customer_code: 'KH-000002',
    name: 'Chị Mai Phương',
    phone: '0934567890',
    source: 'ZALO',
    stage: 'SURVEY_SCHEDULED',
    created_at: '2026-09-16T14:20:00Z',
    project_specs: {
      width_m: 3.2,
      height_m: 0.7,
      address: 'Khu biệt thự Hoa Phượng, KĐT Nam An Khánh, Hoài Đức',
      flood_depth: 'Dốc hầm xe ngập ngược từ hệ thống thoát nước chung',
      product_line: 'Cửa chống ngập bản nâng hạ thủy lực tự động',
      estimated_price: 'Đang chờ khảo sát hiện trường',
    },
    identities: [
      { channel: 'ZALO', external_id: 'zalo-user-mai-phuong-88', verified: true },
      { channel: 'PHONE', external_id: 'HMAC_SHA256_0934567890', verified: true },
    ],
  },
  'cust-3': {
    id: 'cust-3',
    customer_code: 'KH-000003',
    name: 'Bác Quốc Tuấn',
    phone: '0987654321',
    source: 'FACEBOOK',
    stage: 'WARRANTY_ACTIVE',
    created_at: '2026-09-15T11:00:00Z',
    project_specs: {
      width_m: 1.8,
      height_m: 0.5,
      address: 'Ngõ 66 Triều Khúc, Thanh Xuân, Hà Nội',
      flood_depth: 'Nước tràn từ ngõ vào phòng khách',
      product_line: 'Cửa chống ngập dạng cuốn inox 304 tiêu chuẩn',
      estimated_price: 'Đã hoàn thành - Bảo hành 24 tháng',
    },
    identities: [
      { channel: 'FACEBOOK', external_id: 'fb-user-tuan-quoc-77', verified: true },
      { channel: 'PHONE', external_id: 'HMAC_SHA256_0987654321', verified: true },
    ],
  },
  'cust-4': {
    id: 'cust-4',
    customer_code: 'KH-000004',
    name: 'Anh Trọng Hiếu',
    phone: '0977889900',
    source: 'ZALO',
    stage: 'DEPOSIT_CONFIRMED',
    created_at: '2026-09-14T09:10:00Z',
    project_specs: {
      width_m: 2.2,
      height_m: 0.6,
      address: 'Đường Nguyễn Văn Cừ, Long Biên, Hà Nội',
      flood_depth: 'Ngập sân và bậc tam cấp vào nhà',
      product_line: 'Cửa chống ngập tháo lắp hợp kim nhôm định hình',
      estimated_price: 'Đã đặt cọc 5.000.000 đ (Đơn DH-000004)',
    },
    identities: [
      { channel: 'ZALO', external_id: 'zalo-user-hieu-nguyen-66', verified: true },
      { channel: 'PHONE', external_id: 'HMAC_SHA256_0977889900', verified: true },
    ],
  },
};

export default async function CustomerDetailPage({ params }: CustomerDetailPageProps) {
  const actor = await getActorContext();

  if (!actor || actor.profileStatus !== 'ACTIVE') {
    redirect('/login');
  }

  // Kỹ thuật viên không có quyền xem thông tin hồ sơ 360 của khách hàng tổng
  if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
    return (
      <div className="p-8 max-w-xl mx-auto text-center space-y-4">
        <div className="w-16 h-16 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-400 flex items-center justify-center mx-auto">
          <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-white">Truy Cập Bị Từ Chối</h2>
        <p className="text-sm text-slate-400">
          Kỹ thuật viên không có quyền truy cập trang Hồ sơ khách hàng 360. Vui lòng chuyển sang{' '}
          <a href="/field" className="text-blue-400 underline hover:text-blue-300">
            Hiện trường & Khảo sát
          </a>
          .
        </p>
      </div>
    );
  }

  const { id } = await params;
  const adminClient = createAdminClient();

  // 1. Tìm thông tin khách hàng từ mock store hoặc database
  let customerData: {
    id: string;
    customer_code: string;
    name: string;
    phone: string;
    source: string;
    stage: string;
    created_at: string;
    project_specs?: {
      width_m: number;
      height_m: number;
      address: string;
      flood_depth: string;
      product_line: string;
      estimated_price?: string;
    };
    identities?: Array<{ channel: string; external_id: string; verified: boolean }>;
  } | null = null;

  if (MOCK_PROFILES_360[id]) {
    customerData = { ...MOCK_PROFILES_360[id] };
  } else {
    // Truy vấn Supabase nếu là ID thật
    try {
      const { data: dbCustomer } = await adminClient
        .from('customers')
        .select('*')
        .eq('company_id', actor.companyId)
        .eq('id', id)
        .maybeSingle();

      if (dbCustomer) {
        let rawPhone = '';
        try {
          const { data: contactRow } = await adminClient
            .schema('private')
            .from('customer_private_contacts')
            .select('raw_phone, normalized_phone')
            .eq('customer_id', id)
            .maybeSingle();

          if (contactRow) {
            rawPhone = contactRow.raw_phone || contactRow.normalized_phone || '';
          }
        } catch {
          // Schema private query fallback
        }

        const { data: identities } = await adminClient
          .from('identities')
          .select('channel, external_id, verified')
          .eq('customer_id', id);

        customerData = {
          id: dbCustomer.id,
          customer_code: dbCustomer.customer_code,
          name: dbCustomer.name,
          phone: rawPhone,
          source: dbCustomer.source,
          stage: dbCustomer.stage,
          created_at: dbCustomer.created_at,
          identities: identities || [],
        };
      }
    } catch {
      // Database query error handled below
    }
  }

  if (!customerData) {
    notFound();
  }

  // 2. Quy tắc bảo mật Zero-Phone Exposure:
  // - Nếu SALE: che số bắt buộc qua maskPhone (09******12)
  // - Nếu BOSS_ADMIN: xem số thật & ghi Audit Log VIEW_RAW_PHONE
  const isBossAdmin = actor.role === APPLICATION_ROLES.BOSS_ADMIN;
  const displayPhone = isBossAdmin ? customerData.phone : maskPhone(customerData.phone);

  if (isBossAdmin && customerData.phone) {
    try {
      await adminClient.from('audit_logs').insert({
        company_id: actor.companyId,
        actor_id: actor.userId,
        action: 'VIEW_RAW_PHONE',
        resource_type: 'CUSTOMER',
        resource_id: customerData.id,
        metadata: {
          source: 'CUSTOMER_360_PAGE',
          accessed_at: new Date().toISOString(),
          customer_code: customerData.customer_code,
          user_email: actor.email,
        },
      });
    } catch {
      // Audit log non-blocking on failure
    }
  }

  // 3. Lấy dòng thời gian sự kiện khách hàng
  const timelineEvents: CustomerTimelineEvent[] = await InboxService.getCustomerTimeline(
    customerData.id
  );

  // Nếu trong database có lịch sử stage changes, bổ sung vào timeline
  try {
    const { data: stageHistories } = await adminClient
      .from('customer_stage_histories')
      .select('*')
      .eq('customer_id', customerData.id)
      .order('created_at', { ascending: false });

    if (stageHistories && stageHistories.length > 0) {
      for (const sh of stageHistories) {
        if (!timelineEvents.some((e) => e.id === sh.id)) {
          timelineEvents.push({
            id: sh.id,
            customer_id: customerData.id,
            type: 'STAGE_CHANGE',
            title: `Chuyển trạng thái sang: ${sh.to_stage}`,
            description: sh.reason || 'Cập nhật tiến trình khách hàng từ hệ thống CRM.',
            timestamp: sh.created_at,
            actor_type: (sh.actor_type?.toLowerCase() as CustomerTimelineEvent['actor_type']) || 'system',
          });
        }
      }
      timelineEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    }
  } catch {
    // Database query fallback
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Top Header & Breadcrumb */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-400 mb-1">
            <Link href="/customers" className="hover:text-blue-400 transition">
              Khách hàng
            </Link>
            <span>/</span>
            <span className="text-slate-200 font-medium">Hồ sơ 360</span>
            <span>/</span>
            <span className="font-mono text-blue-400">{customerData.customer_code}</span>
          </div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-white">{customerData.name}</h1>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20">
              {customerData.stage}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/customers"
            className="px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-300 hover:text-white transition flex items-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            <span>Danh sách</span>
          </Link>

          <Link
            href={`/inbox?customer_id=${customerData.id}`}
            className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white shadow-lg shadow-blue-600/20 transition flex items-center gap-1.5 active:scale-95"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
            <span>Mở Hộp thư Chat</span>
          </Link>
        </div>
      </div>

      {/* Main Grid: 2 Columns */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* ================================================================== */}
        {/* CỘT TRÁI (4 cols): Thông tin khách hàng, Kỹ thuật & Danh tính      */}
        {/* ================================================================== */}
        <div className="lg:col-span-4 space-y-6">
          {/* Card: Thông tin cơ bản */}
          <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center text-white font-bold text-lg shadow-lg shadow-blue-600/20">
                {customerData.name.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <h3 className="font-bold text-white text-base">{customerData.name}</h3>
                <div className="font-mono text-xs text-slate-400">{customerData.customer_code}</div>
              </div>
            </div>

            <div className="pt-2 border-t border-slate-800 space-y-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Số điện thoại:</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono font-bold text-amber-300">
                    {displayPhone || 'Chưa cập nhật'}
                  </span>
                  {isBossAdmin ? (
                    <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 text-[10px] font-mono border border-emerald-500/20">
                      RAW
                    </span>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 text-[10px] font-mono border border-slate-700">
                      MASKED
                    </span>
                  )}
                </div>
              </div>

              {/* Bảo mật Zero-Phone: Click-to-Call */}
              <div className="p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-slate-300">Tổng đài Click-to-Call:</span>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 text-emerald-300 text-[11px] font-semibold transition"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                    </svg>
                    <span>Gọi bảo mật</span>
                  </button>
                </div>
                <p className="text-[10px] text-slate-500 leading-tight">
                  Số điện thoại được gọi qua tổng đài mã hóa, không lộ số thật cho tài khoản Sale.
                </p>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-slate-400">Nguồn ban đầu:</span>
                <span className="font-semibold text-white uppercase">{customerData.source}</span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-slate-400">Ngày tiếp nhận:</span>
                <span className="font-mono text-slate-300">
                  {new Date(customerData.created_at).toLocaleDateString('vi-VN')}
                </span>
              </div>
            </div>
          </div>

          {/* Card: Thông số kỹ thuật công trình cửa chống ngập */}
          {customerData.project_specs && (
            <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-400 flex items-center justify-center">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                  </svg>
                </div>
                <h4 className="font-bold text-white text-xs uppercase tracking-wider">
                  Thông số công trình
                </h4>
              </div>

              <div className="space-y-2.5 text-xs text-slate-300">
                <div className="flex justify-between py-1 border-b border-slate-800/80">
                  <span className="text-slate-400">Khẩu độ cửa:</span>
                  <span className="font-bold text-emerald-400">
                    {customerData.project_specs.width_m} m
                  </span>
                </div>

                <div className="flex justify-between py-1 border-b border-slate-800/80">
                  <span className="text-slate-400">Chiều cao chắn ngập:</span>
                  <span className="font-bold text-emerald-400">
                    {customerData.project_specs.height_m} m
                  </span>
                </div>

                <div className="py-1 border-b border-slate-800/80 space-y-1">
                  <span className="text-slate-400 block">Hiện trạng ngập:</span>
                  <span className="text-slate-200 block bg-slate-950/40 p-2 rounded-lg border border-slate-800/40">
                    {customerData.project_specs.flood_depth}
                  </span>
                </div>

                <div className="py-1 border-b border-slate-800/80 space-y-1">
                  <span className="text-slate-400 block">Địa chỉ thi công:</span>
                  <span className="text-slate-200 block bg-slate-950/40 p-2 rounded-lg border border-slate-800/40">
                    {customerData.project_specs.address}
                  </span>
                </div>

                <div className="py-1 space-y-1">
                  <span className="text-slate-400 block">Giải pháp đề xuất:</span>
                  <span className="text-blue-300 font-medium block">
                    {customerData.project_specs.product_line}
                  </span>
                  {customerData.project_specs.estimated_price && (
                    <span className="text-emerald-400 font-mono font-bold block pt-1">
                      {customerData.project_specs.estimated_price}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Card: Danh tính đa kênh (Identities) */}
          <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
            <h4 className="font-bold text-white text-xs uppercase tracking-wider">
              Danh tính đa kênh (Identities)
            </h4>

            <div className="space-y-2">
              {customerData.identities && customerData.identities.length > 0 ? (
                customerData.identities.map((idItem, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded font-mono font-semibold text-[10px] bg-slate-800 text-blue-400 border border-slate-700">
                        {idItem.channel}
                      </span>
                      <span className="font-mono text-slate-300 text-[11px] truncate max-w-[140px]">
                        {idItem.external_id}
                      </span>
                    </div>

                    <span
                      className={`text-[10px] font-medium ${
                        idItem.verified ? 'text-emerald-400' : 'text-slate-500'
                      }`}
                    >
                      {idItem.verified ? 'Đã xác thực' : 'Chưa xác thực'}
                    </span>
                  </div>
                ))
              ) : (
                <div className="text-xs text-slate-500 py-2 text-center">
                  Chưa có danh tính liên kết bổ sung.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ================================================================== */}
        {/* CỘT PHẢI (8 cols): Dòng thời gian hành trình khách hàng             */}
        {/* ================================================================== */}
        <div className="lg:col-span-8 p-6 rounded-2xl bg-slate-900 border border-slate-800 space-y-6">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div>
              <h3 className="font-bold text-white text-base">Hành trình khách hàng (Customer Timeline)</h3>
              <p className="text-xs text-slate-400">
                Toàn bộ tương tác đa kênh, cuộc gọi, khảo sát và thay đổi trạng thái theo thời gian.
              </p>
            </div>
          </div>

          <CustomerTimeline events={timelineEvents} />
        </div>
      </div>
    </div>
  );
}
