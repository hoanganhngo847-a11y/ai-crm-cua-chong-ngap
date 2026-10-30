import React from 'react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getActorContext } from '../../../../lib/auth/context';
import { createClient as createServerClient } from '../../../../lib/supabase/server';
import { APPLICATION_ROLES } from '../../../../shared/constants/roles';
import { maskPhone } from '../../../../features/crm/services/customer.service';
import { InboxService } from '../../../../features/inbox/services/inbox.service';
import CustomerTimeline from '../../../../features/crm/components/customer-timeline';
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
  PhoneRevealProvider,
  SecurePhoneRow,
} from '../../../../features/crm/components/secure-phone-reveal';
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
        description="Kỹ thuật viên không có quyền truy cập trang Hồ sơ khách hàng 360. Khu vực Hiện trường & Khảo sát đã được gỡ khỏi hệ thống."
        action={{
          label: 'Về trang Tài khoản',
          href: '/account',
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
    touchpoints?: Array<{
      id: string;
      touchpoint_type: string;
      channel: string;
      page_name: string | null;
      campaign_name_snapshot: string | null;
      ad_set_name_snapshot: string | null;
      ad_name_snapshot: string | null;
      form_name_snapshot: string | null;
      attribution_status: string;
      attribution_method: string;
      occurred_at: string;
    }>;
    first_campaign_name?: string | null;
    latest_campaign_name?: string | null;
    attribution_status?: string | null;
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

      let touchpointsList: Array<{
        id: string;
        touchpoint_type: string;
        channel: string;
        page_name: string | null;
        campaign_name_snapshot: string | null;
        ad_set_name_snapshot: string | null;
        ad_name_snapshot: string | null;
        form_name_snapshot: string | null;
        attribution_status: string;
        attribution_method: string;
        occurred_at: string;
      }> = [];

      try {
        const { data: tpRows } = await supabase
          .from('lead_attribution_touchpoints')
          .select('id, touchpoint_type, channel, page_name, campaign_name_snapshot, ad_set_name_snapshot, ad_name_snapshot, form_name_snapshot, attribution_status, attribution_method, occurred_at')
          .eq('customer_id', id)
          .eq('company_id', actor.companyId)
          .order('occurred_at', { ascending: false });

        if (tpRows) {
          touchpointsList = tpRows;
        }
      } catch (tpErr) {
        console.warn('Lỗi khi nạp attribution touchpoints:', tpErr);
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
        touchpoints: touchpointsList,
        first_campaign_name: dbCustomer.first_campaign_name,
        latest_campaign_name: dbCustomer.latest_campaign_name,
        attribution_status: dbCustomer.attribution_status,
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
          <PhoneRevealProvider>
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
                  <SecurePhoneRow customerId={customerData.id} maskedPhone={displayPhone} />
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
          {/* Nguồn gốc & Chiến dịch Quảng cáo (Lead Attribution) */}
          <Card className="p-5 space-y-3">
            <div className="flex items-center justify-between">
              <CardTitle>Nguồn Lead &amp; Chiến dịch (Attribution)</CardTitle>
              <Badge
                variant={
                  customerData.attribution_status === 'ATTRIBUTED'
                    ? 'success'
                    : customerData.attribution_status === 'INFERRED'
                      ? 'info'
                      : 'neutral'
                }
                size="xs"
              >
                {customerData.attribution_status || 'UNATTRIBUTED'}
              </Badge>
            </div>

            <div className="space-y-2 text-xs">
              {customerData.first_campaign_name && (
                <div className="p-2.5 rounded-lg bg-[var(--surface-secondary)] border border-[var(--border-subtle)] space-y-1">
                  <div className="text-[10px] uppercase font-semibold text-text-tertiary">
                    First-Touch (Nguồn đầu tiên)
                  </div>
                  <div className="font-semibold text-text-primary text-xs flex items-center gap-1.5">
                    <span>🎯</span>
                    <span>{customerData.first_campaign_name}</span>
                  </div>
                </div>
              )}

              {customerData.latest_campaign_name &&
                customerData.latest_campaign_name !== customerData.first_campaign_name && (
                  <div className="p-2.5 rounded-lg bg-[var(--surface-secondary)] border border-[var(--border-subtle)] space-y-1">
                    <div className="text-[10px] uppercase font-semibold text-text-tertiary">
                      Latest-Touch (Tương tác gần nhất)
                    </div>
                    <div className="font-semibold text-text-primary text-xs flex items-center gap-1.5">
                      <span>🔄</span>
                      <span>{customerData.latest_campaign_name}</span>
                    </div>
                  </div>
                )}

              {/* Touchpoints History */}
              <div className="space-y-1.5 pt-2 border-t border-[var(--border-subtle)]">
                <div className="text-[11px] font-semibold text-text-secondary">
                  Lịch sử điểm chạm ({customerData.touchpoints?.length || 0})
                </div>
                {customerData.touchpoints && customerData.touchpoints.length > 0 ? (
                  <div className="space-y-1.5 max-h-60 overflow-y-auto">
                    {customerData.touchpoints.map((tp) => (
                      <div
                        key={tp.id}
                        className="p-2 rounded bg-[var(--surface-primary)] border border-[var(--border-subtle)] text-[11px] space-y-0.5"
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-semibold text-text-primary">
                            {tp.campaign_name_snapshot || tp.channel}
                          </span>
                          <span className="font-mono text-[10px] text-text-tertiary">
                            {new Date(tp.occurred_at).toLocaleDateString('vi-VN')}
                          </span>
                        </div>
                        {tp.ad_name_snapshot && (
                          <div className="text-text-secondary text-[10px]">
                            Quảng cáo: {tp.ad_name_snapshot}
                          </div>
                        )}
                        {tp.form_name_snapshot && (
                          <div className="text-text-secondary text-[10px]">
                            Form: {tp.form_name_snapshot}
                          </div>
                        )}
                        <div className="flex items-center gap-1 text-[9px] text-text-tertiary">
                          <span>{tp.touchpoint_type}</span>
                          <span>•</span>
                          <span>{tp.attribution_method}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[11px] text-[var(--text-tertiary)] py-1 text-center">
                    Chưa có lịch sử điểm chạm quảng cáo.
                  </div>
                )}
              </div>
            </div>
          </Card>
          </PhoneRevealProvider>
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
