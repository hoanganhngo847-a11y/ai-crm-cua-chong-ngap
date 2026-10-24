import React from 'react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getActorContext } from '../../../../lib/auth/context';
import { createClient as createServerClient } from '../../../../lib/supabase/server';
import { APPLICATION_ROLES } from '../../../../shared/constants/roles';
import { maskPhone } from '../../../../features/crm/services/customer.service';
import { InboxService } from '../../../../features/inbox/services/inbox.service';
import CustomerTimeline from '../../../../features/crm/components/customer-timeline';
import CustomerSurveyCard from '../../../../features/crm/components/customer-survey-card';
import ZaloCallButton from '../../calls/components/ZaloCallButton';
import { sanitizePhoneInText } from '../../../../features/crm/utils/phone-sanitizer';
import type { CustomerTimelineEvent } from '../../../../features/inbox/types/inbox.types';
import { resolveCustomerPrivateContactForTrustedOperation } from '../../../../lib/sensitive/customer-contact';
import { CONTACT_ACCESS_PURPOSES } from '../../../../shared/contracts/sensitive';
import { PageHeader } from '../../../../components/ui/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '../../../../components/ui/card';
import { Button } from '../../../../components/ui/button';
import { StatusBadge } from '../../../../components/ui/status-badge';
import { Badge } from '../../../../components/ui/badge';
import { Avatar } from '../../../../components/ui/avatar';
import { EmptyState } from '../../../../components/ui/empty-state';
import {
  PhoneCall,
  MessageSquare,
  ArrowRight,
} from 'lucide-react';

export const metadata = {
  title: 'Hồ sơ khách hàng 360 | AI CRM Cửa Chống Ngập',
  description: 'Hồ sơ chi tiết 360 độ và dòng thời gian hành trình khách hàng',
};

interface CustomerDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function CustomerDetailPage({ params }: CustomerDetailPageProps) {
  const actor = await getActorContext();

  if (!actor || actor.profileStatus !== 'ACTIVE' || !actor.companyId) {
    redirect('/login');
  }

  // Kỹ thuật viên không có quyền xem thông tin hồ sơ 360 của khách hàng tổng
  if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
    return (
      <EmptyState
        type="permission"
        title="Truy Cập Bị Từ Chối"
        description="Kỹ thuật viên không có quyền truy cập trang Hồ sơ khách hàng 360. Vui lòng chuyển sang Hiện trường & Khảo sát."
        action={{
          label: 'Xem Hiện trường & Khảo sát',
          href: '/field',
        }}
      />
    );
  }

  const { id } = await params;
  const supabase = await createServerClient();
  const isBossAdmin = actor.role === APPLICATION_ROLES.BOSS_ADMIN;
  const isDemoMode = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
  let displayPhone = '';

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

  try {
    const { data: dbCustomer, error: dbQueryErr } = await supabase
      .from('customers')
      .select('*')
      .eq('company_id', actor.companyId)
      .eq('id', id)
      .maybeSingle();

    if (dbQueryErr) {
      if (!isDemoMode) {
        throw new Error(`DATABASE_ERROR: Lỗi truy vấn hồ sơ khách hàng: ${dbQueryErr.message}`);
      }
    }

    if (dbCustomer) {
      let rawPhone = '';

      if (isBossAdmin) {
        try {
          const contact = await resolveCustomerPrivateContactForTrustedOperation(
            id,
            CONTACT_ACCESS_PURPOSES.PRIVILEGED_ADMIN_OPERATION,
            {
              reason: 'Xem chi tiết hồ sơ khách hàng tại Customer 360 (BOSS_ADMIN)',
            }
          );
          if (contact && contact.rawPhone) {
            rawPhone = contact.rawPhone;
          }
        } catch (auditErr: unknown) {
          throw auditErr;
        }
      }

      displayPhone = isBossAdmin ? rawPhone || '' : maskPhone(dbCustomer.phone || '');

      let identitiesList: Array<{ channel: string; external_id: string; verified: boolean }> = [];
      try {
        const { data: idRows } = await supabase
          .from('customer_identities')
          .select('channel, external_id, is_verified')
          .eq('customer_id', id)
          .eq('company_id', actor.companyId);

        if (idRows && idRows.length > 0) {
          identitiesList = idRows.map((r) => ({
            channel: r.channel,
            external_id: isBossAdmin ? r.external_id : sanitizePhoneInText(r.external_id),
            verified: Boolean(r.is_verified),
          }));
        }
      } catch (idErr) {
        console.warn('Lỗi khi nạp identities:', idErr);
      }

      customerData = {
        id: dbCustomer.id,
        customer_code: dbCustomer.customer_code,
        name: dbCustomer.name,
        phone: displayPhone,
        source: dbCustomer.source,
        stage: dbCustomer.stage,
        created_at: dbCustomer.created_at,
        identities: identitiesList,
      };
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ServerAuthError') {
      throw err;
    }
    if (!isDemoMode) {
      throw err;
    }
  }

  if (!customerData) {
    notFound();
  }

  // Lấy dòng thời gian tương tác (Inbox Service)
  let timelineEvents: CustomerTimelineEvent[] = [];
  try {
    timelineEvents = await InboxService.getCustomerTimeline(actor.companyId, customerData.id);
  } catch (err) {
    console.error('Lỗi khi nạp timeline:', err);
  }

  // Lấy lịch hẹn khảo sát và bảng tính giá
  let customerAppointments: Array<{
    id: string;
    type: string;
    status: string;
    address: string;
    start_time: string;
    created_at: string;
  }> = [];
  let customerSurveys: Array<{
    id: string;
    appointment_id: string;
    measurements?: {
      clear_width_mm?: number;
      barrier_height_mm?: number;
      anticipated_flood_height_mm?: number;
      gate_type?: string;
      mounting_method?: string;
    };
    completed_at: string;
    created_at?: string;
  }> = [];
  let customerCalculations: Array<{
    id: string;
    survey_id?: string | null;
    amount: number | null;
    status: string;
    missing_fields: string[] | null;
    created_at: string;
  }> = [];

  try {
    const [apptsRes, surveysRes, calcsRes] = await Promise.all([
      supabase
        .from('appointments')
        .select('id, type, status, address, start_time, created_at')
        .eq('customer_id', customerData.id)
        .eq('company_id', actor.companyId)
        .order('start_time', { ascending: false }),
      supabase
        .from('surveys')
        .select('id, appointment_id, measurements, completed_at, created_at')
        .eq('customer_id', customerData.id)
        .eq('company_id', actor.companyId)
        .order('completed_at', { ascending: false }),
      supabase
        .from('price_calculations')
        .select('id, survey_id, amount, status, missing_fields, created_at')
        .eq('customer_id', customerData.id)
        .eq('company_id', actor.companyId)
        .order('created_at', { ascending: false }),
    ]);

    if (apptsRes.data) customerAppointments = apptsRes.data as unknown as typeof customerAppointments;
    if (surveysRes.data) customerSurveys = surveysRes.data as unknown as typeof customerSurveys;
    if (calcsRes.data) customerCalculations = calcsRes.data as unknown as typeof customerCalculations;
  } catch (queryErr) {
    console.warn('[Customer survey/calc query error]:', queryErr);
  }

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <PageHeader
        title={customerData.name}
        description={`Mã khách hàng: ${customerData.customer_code} • Nguồn: ${customerData.source}`}
        breadcrumbs={[
          { label: 'Khách hàng', href: '/customers' },
          { label: 'Hồ sơ 360', href: '/customers/dossier' },
          { label: customerData.customer_code, isCurrent: true },
        ]}
        badge={<StatusBadge status={customerData.stage} size="sm" />}
        primaryAction={
          <Link href={`/customers/${customerData.id}/dossier`}>
            <Button variant="primary" size="sm" rightIcon={<ArrowRight className="w-3.5 h-3.5" />}>
              Mở AI Dossier 360
            </Button>
          </Link>
        }
        secondaryActions={
          <Link href={`/inbox?customer_id=${customerData.id}`}>
            <Button variant="outline" size="sm" leftIcon={<MessageSquare className="w-3.5 h-3.5" />}>
              Hộp thư Chat
            </Button>
          </Link>
        }
      />

      {/* Main Grid: 2 Columns */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column (4 cols): Information, Specs & Identities */}
        <div className="lg:col-span-4 space-y-6">
          <Card className="p-5 space-y-4">
            <div className="flex items-center gap-3">
              <Avatar name={customerData.name} size="md" />
              <div className="min-w-0">
                <h3 className="font-semibold text-[var(--text-primary)] text-sm truncate">
                  {customerData.name}
                </h3>
                <div className="font-mono text-xs text-[var(--text-tertiary)]">
                  {customerData.customer_code}
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-[var(--border-subtle)] space-y-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-[var(--text-secondary)]">Số điện thoại:</span>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono font-medium text-[var(--text-primary)]">
                    {displayPhone || 'Chưa cập nhật'}
                  </span>
                  {isBossAdmin ? (
                    <Badge variant="success" size="xs">
                      RAW
                    </Badge>
                  ) : (
                    <Badge variant="warning" size="xs">
                      MASKED
                    </Badge>
                  )}
                </div>
              </div>

              {/* Click-to-Call */}
              <div className="p-3 rounded-lg bg-[var(--surface-secondary)] border border-[var(--border-subtle)] space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                    Tổng đài Click-to-Call:
                  </span>
                  <Link href={`/calls/${id}`}>
                    <Button variant="secondary" size="xs" leftIcon={<PhoneCall className="w-3 h-3 text-emerald-600" />}>
                      Gọi bảo mật
                    </Button>
                  </Link>
                </div>
                <p className="text-[10px] text-[var(--text-tertiary)] leading-relaxed">
                  Số điện thoại được gọi qua tổng đài mã hóa, không lộ số thật cho Sale.
                </p>
              </div>

              {/* Zalo Personal Call */}
              <div className="p-3 rounded-lg bg-[var(--surface-secondary)] border border-[var(--border-subtle)] space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                    Zalo Personal:
                  </span>
                  <ZaloCallButton
                    customerId={customerData.id}
                    customerName={customerData.name}
                  />
                </div>
                <p className="text-[10px] text-[var(--text-tertiary)] leading-relaxed">
                  Gọi qua Zalo Desktop tự động ghi âm hai chiều.
                </p>
              </div>

              <div className="flex items-center justify-between pt-1">
                <span className="text-[var(--text-secondary)]">Nguồn tiếp nhận:</span>
                <span className="font-medium text-[var(--text-primary)] uppercase">
                  {customerData.source}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-[var(--text-secondary)]">Ngày tiếp nhận:</span>
                <span className="font-mono text-[var(--text-secondary)]">
                  {new Date(customerData.created_at).toLocaleDateString('vi-VN')}
                </span>
              </div>
            </div>
          </Card>

          {/* Survey Card */}
          <CustomerSurveyCard
            customerId={customerData.id}
            customerName={customerData.name}
            customerAddress={customerData.project_specs?.address || ''}
            userRole={actor.role}
            appointments={customerAppointments}
            surveys={customerSurveys}
            calculations={customerCalculations}
          />

          {/* Identities */}
          <Card className="p-5 space-y-3">
            <CardTitle>Danh tính đa kênh (Identities)</CardTitle>

            <div className="space-y-2">
              {customerData.identities && customerData.identities.length > 0 ? (
                customerData.identities.map((idItem, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between p-2 rounded-lg bg-[var(--surface-secondary)] border border-[var(--border-subtle)] text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <span className="px-1.5 py-0.2 rounded font-mono font-medium text-[10px] bg-[var(--surface-primary)] text-[var(--accent)] border border-[var(--border-subtle)]">
                        {idItem.channel}
                      </span>
                      <span className="font-mono text-[var(--text-primary)] text-[11px] truncate max-w-[140px]">
                        {idItem.external_id}
                      </span>
                    </div>

                    <Badge variant={idItem.verified ? 'success' : 'neutral'} size="xs">
                      {idItem.verified ? 'Đã xác thực' : 'Chưa xác thực'}
                    </Badge>
                  </div>
                ))
              ) : (
                <div className="text-xs text-[var(--text-tertiary)] py-2 text-center">
                  Chưa có danh tính liên kết bổ sung.
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Right Column (8 cols): Customer Timeline */}
        <div className="lg:col-span-8">
          <Card className="p-6">
            <CardHeader className="px-0 pt-0">
              <div>
                <CardTitle>Hành trình khách hàng (Customer Timeline)</CardTitle>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  Toàn bộ tương tác đa kênh, cuộc gọi, khảo sát và thay đổi trạng thái theo thời gian.
                </p>
              </div>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <CustomerTimeline events={timelineEvents} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
