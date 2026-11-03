import React from 'react';
import Image from 'next/image';
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


type MetaCreativeAssetView = {
  kind?: string;
  imageUrl?: string | null;
  thumbnailUrl?: string | null;
  videoId?: string | null;
  title?: string | null;
  description?: string | null;
  primaryText?: string | null;
  destinationUrl?: string | null;
};

type MetaCreativeSnapshotView = {
  status?: string;
  captureTiming?: string;
  adId?: string;
  adName?: string;
  campaignId?: string;
  campaignName?: string;
  adsetId?: string;
  adsetName?: string;
  creativeId?: string;
  creativeName?: string;
  format?: string;
  primaryText?: string;
  headlines: string[];
  descriptions: string[];
  ctaType?: string;
  destinationUrl?: string;
  previewUrl?: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  videoId?: string;
  carouselAssets: MetaCreativeAssetView[];
  imageAssets: MetaCreativeAssetView[];
  videoAssets: MetaCreativeAssetView[];
};

function asMetaRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function metaString(value: unknown, maxLength = 4000): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function safeMetaImageUrl(value: unknown): string | undefined {
  const raw = metaString(value, 2048);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const allowed =
      host === 'fbcdn.net' || host.endsWith('.fbcdn.net') ||
      host === 'fbsbx.com' || host.endsWith('.fbsbx.com') ||
      host === 'facebook.com' || host.endsWith('.facebook.com');
    if (url.protocol !== 'https:' || !allowed || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function safeMetaDestination(value: unknown): string | undefined {
  const raw = metaString(value, 2048);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function safeMetaPreview(value: unknown): string | undefined {
  const raw = metaString(value, 2048);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !(host === 'facebook.com' || host.endsWith('.facebook.com')) || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function readMetaCreativeSnapshot(adsContextData: unknown): MetaCreativeSnapshotView | null {
  const context = asMetaRecord(adsContextData);
  const raw = asMetaRecord(context?.creative_snapshot);
  if (!raw) return null;

  const readAssets = (value: unknown): MetaCreativeAssetView[] => {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 10).map((item) => {
      const asset = asMetaRecord(item) || {};
      return {
        kind: metaString(asset.kind, 20),
        imageUrl: safeMetaImageUrl(asset.imageUrl) || null,
        thumbnailUrl: safeMetaImageUrl(asset.thumbnailUrl) || null,
        videoId: metaString(asset.videoId, 128) || null,
        title: metaString(asset.title, 500) || null,
        description: metaString(asset.description, 1000) || null,
        primaryText: metaString(asset.primaryText, 2000) || null,
        destinationUrl: safeMetaDestination(asset.destinationUrl) || null,
      };
    }).filter((asset) => Boolean(asset.imageUrl || asset.thumbnailUrl || asset.videoId || asset.title || asset.description));
  };

  const readList = (value: unknown): string[] => Array.isArray(value)
    ? value.slice(0, 8).map((item) => metaString(item, 3000)).filter((item): item is string => Boolean(item))
    : [];

  return {
    status: metaString(raw.status, 40),
    captureTiming: metaString(raw.captureTiming, 40),
    adId: metaString(raw.adId, 128),
    adName: metaString(raw.adName, 500),
    campaignId: metaString(raw.campaignId, 128),
    campaignName: metaString(raw.campaignName, 500),
    adsetId: metaString(raw.adsetId, 128),
    adsetName: metaString(raw.adsetName, 500),
    creativeId: metaString(raw.creativeId, 128),
    creativeName: metaString(raw.creativeName, 500),
    format: metaString(raw.format, 40),
    primaryText: metaString(raw.primaryText, 5000),
    headlines: readList(raw.headlines),
    descriptions: readList(raw.descriptions),
    ctaType: metaString(raw.ctaType, 100),
    destinationUrl: safeMetaDestination(raw.destinationUrl),
    previewUrl: safeMetaPreview(raw.previewUrl),
    imageUrl: safeMetaImageUrl(raw.imageUrl),
    thumbnailUrl: safeMetaImageUrl(raw.thumbnailUrl),
    videoId: metaString(raw.videoId, 128),
    carouselAssets: readAssets(raw.carouselAssets),
    imageAssets: readAssets(raw.imageAssets),
    videoAssets: readAssets(raw.videoAssets),
  };
}


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
      meta_campaign_id: string | null;
      campaign_name_snapshot: string | null;
      meta_ad_set_id: string | null;
      ad_set_name_snapshot: string | null;
      meta_ad_id: string | null;
      ad_name_snapshot: string | null;
      form_name_snapshot: string | null;
      ads_context_data: unknown;
      attribution_status: string;
      attribution_method: string;
      normalized_phone_match_status: string | null;
      is_duplicate_phone: boolean | null;
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
        meta_campaign_id: string | null;
        campaign_name_snapshot: string | null;
        meta_ad_set_id: string | null;
        ad_set_name_snapshot: string | null;
        meta_ad_id: string | null;
        ad_name_snapshot: string | null;
        form_name_snapshot: string | null;
        ads_context_data: unknown;
        attribution_status: string;
        attribution_method: string;
        normalized_phone_match_status: string | null;
        is_duplicate_phone: boolean | null;
        occurred_at: string;
      }> = [];

      try {
        const { data: tpRows } = await supabase
          .from('lead_attribution_touchpoints')
          .select('id, touchpoint_type, channel, page_name, meta_campaign_id, campaign_name_snapshot, meta_ad_set_id, ad_set_name_snapshot, meta_ad_id, ad_name_snapshot, form_name_snapshot, ads_context_data, attribution_status, attribution_method, normalized_phone_match_status, is_duplicate_phone, occurred_at')
          .eq('customer_id', id)
          .eq('company_id', actor.companyId)
          .order('occurred_at', { ascending: true });

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

  // Nguồn khách hàng & Lịch sử đăng ký: tổng hợp các lượt Lead Meta của khách.
  // Touchpoints are ordered chronologically (oldest first) at query time.
  const allTouchpoints = customerData.touchpoints || [];
  const metaLeadTouchpoints = allTouchpoints.filter((tp) => tp.channel === 'FACEBOOK_LEAD_ADS');
  const hasDuplicatePhoneLead = allTouchpoints.some((tp) => tp.is_duplicate_phone === true);
  const distinctCampaignCount = new Set(
    metaLeadTouchpoints
      .map((tp) => tp.meta_campaign_id || tp.campaign_name_snapshot)
      .filter(Boolean)
  ).size;
  const firstSubmission = metaLeadTouchpoints[0] ?? null;
  const latestSubmission = metaLeadTouchpoints[metaLeadTouchpoints.length - 1] ?? null;
  const CHANNEL_LABELS: Record<string, string> = {
    FACEBOOK_LEAD_ADS: 'Facebook Ads',
    FACEBOOK_MESSENGER: 'Messenger',
    WEBSITE: 'Website',
    ZALO: 'Zalo',
    HOTLINE: 'Hotline',
    OTHER: 'Khác',
  };

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

              {metaLeadTouchpoints.length > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-[var(--text-secondary)]">Trạng thái Lead:</span>
                  <Badge variant={hasDuplicatePhoneLead ? 'warning' : 'success'} size="xs">
                    {hasDuplicatePhoneLead
                      ? 'Đã có hồ sơ - Lead trùng số điện thoại'
                      : 'Đã có hồ sơ - Lead mới'}
                  </Badge>
                </div>
              )}
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
          {/* Nguồn khách hàng & Lịch sử đăng ký (Lead Attribution & Duplicate Phone History) */}
          <Card className="p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <CardTitle>Nguồn khách hàng &amp; Lịch sử đăng ký</CardTitle>
              <Badge
                variant={
                  customerData.attribution_status === 'ATTRIBUTED'
                    ? 'success'
                    : customerData.attribution_status === 'INFERRED' || customerData.attribution_status === 'PENDING_SYNC'
                      ? 'info'
                      : 'neutral'
                }
                size="xs"
              >
                {customerData.attribution_status || 'UNATTRIBUTED'}
              </Badge>
            </div>

            {metaLeadTouchpoints.length > 0 && (
              <div className="p-2.5 rounded-lg bg-[var(--surface-secondary)] border border-[var(--border-subtle)] space-y-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-[var(--text-secondary)]">Tổng số lượt Lead Meta:</span>
                  <span className="font-semibold text-[var(--text-primary)]">{metaLeadTouchpoints.length}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[var(--text-secondary)]">Chiến dịch khác biệt:</span>
                  <span className="font-semibold text-[var(--text-primary)]">{distinctCampaignCount}</span>
                </div>
                {firstSubmission && (
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--text-secondary)]">Đây là Lead đầu tiên:</span>
                    <span className="font-mono text-[var(--text-secondary)]">
                      {new Date(firstSubmission.occurred_at).toLocaleDateString('vi-VN')}
                      {firstSubmission.campaign_name_snapshot ? ` • ${firstSubmission.campaign_name_snapshot}` : ''}
                    </span>
                  </div>
                )}
                {latestSubmission && (
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--text-secondary)]">Đây là Lead gần nhất:</span>
                    <span className="font-mono text-[var(--text-secondary)]">
                      {new Date(latestSubmission.occurred_at).toLocaleDateString('vi-VN')}
                      {latestSubmission.campaign_name_snapshot ? ` • ${latestSubmission.campaign_name_snapshot}` : ''}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Lịch sử đăng ký (chronological) */}
            <div className="space-y-1.5 pt-1 border-t border-[var(--border-subtle)]">
              <div className="text-[11px] font-semibold text-text-secondary">
                Lịch sử đăng ký ({allTouchpoints.length})
              </div>
              {allTouchpoints.length > 0 ? (
                <div className="space-y-1.5 max-h-72 overflow-y-auto">
                  {allTouchpoints.map((tp) => {
                    const rowStatus = tp.is_duplicate_phone === true
                      ? { label: 'Lead trùng SĐT', variant: 'warning' as const }
                      : tp.touchpoint_type === 'FIRST_TOUCH'
                        ? (tp.attribution_status === 'PENDING_SYNC'
                          ? { label: 'Lead mới - Chờ chiến dịch', variant: 'info' as const }
                          : { label: 'Lead đầu tiên', variant: 'success' as const })
                        : (tp.channel === 'FACEBOOK_LEAD_ADS'
                          ? { label: 'Lead trùng SĐT', variant: 'warning' as const }
                          : { label: 'Tương tác gần nhất', variant: 'neutral' as const });
                    const campaignLabel =
                      tp.campaign_name_snapshot
                      || (tp.attribution_status === 'PENDING_SYNC' ? 'Chờ đồng bộ chiến dịch' : '—');
                    const hasMetaAdAttribution = tp.channel === 'FACEBOOK_LEAD_ADS'
                      || (tp.channel === 'FACEBOOK_MESSENGER' && Boolean(tp.meta_ad_id));
                    const creativeSnapshot = hasMetaAdAttribution
                      ? readMetaCreativeSnapshot(tp.ads_context_data)
                      : null;
                    const creativeMedia: Array<{ url: string; alt: string }> = [];
                    if (creativeSnapshot?.imageUrl) creativeMedia.push({
                      url: creativeSnapshot.imageUrl,
                      alt: creativeSnapshot.format === 'VIDEO' ? 'Thumbnail video quảng cáo' : 'Ảnh quảng cáo',
                    });
                    if (creativeSnapshot?.thumbnailUrl && creativeSnapshot.thumbnailUrl !== creativeSnapshot.imageUrl) {
                      creativeMedia.push({ url: creativeSnapshot.thumbnailUrl, alt: 'Thumbnail quảng cáo' });
                    }
                    for (const asset of [
                      ...(creativeSnapshot?.carouselAssets || []),
                      ...(creativeSnapshot?.imageAssets || []),
                      ...(creativeSnapshot?.videoAssets || []),
                    ]) {
                      const url = asset.imageUrl || asset.thumbnailUrl;
                      if (url && !creativeMedia.some((item) => item.url === url)) {
                        creativeMedia.push({ url, alt: asset.title || 'Tài sản quảng cáo Meta' });
                      }
                    }
                    return (
                      <div
                        key={tp.id}
                        className="p-2 rounded bg-[var(--surface-primary)] border border-[var(--border-subtle)] text-[11px] space-y-1"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="font-mono text-[10px] text-text-tertiary shrink-0">
                              {new Date(tp.occurred_at).toLocaleDateString('vi-VN')}
                            </span>
                            <span className="font-semibold text-text-primary truncate">
                              {CHANNEL_LABELS[tp.channel] || tp.channel}
                            </span>
                          </div>
                          <Badge variant={rowStatus.variant} size="xs">
                            {rowStatus.label}
                          </Badge>
                        </div>
                        <div className="text-text-secondary">
                          Chiến dịch: {campaignLabel}
                        </div>
                        {(tp.ad_name_snapshot || tp.form_name_snapshot) && (
                          <div className="text-[10px] text-text-tertiary">
                            {tp.ad_name_snapshot ? <span>Quảng cáo: {tp.ad_name_snapshot}</span> : null}
                            {tp.ad_name_snapshot && tp.form_name_snapshot ? ' • ' : null}
                            {tp.form_name_snapshot ? <span>Form: {tp.form_name_snapshot}</span> : null}
                          </div>
                        )}
                        {tp.page_name && (
                          <div className="text-[10px] text-text-tertiary">Trang: {tp.page_name}</div>
                        )}
                        {hasMetaAdAttribution && (
                          <div className="mt-2 pt-2 border-t border-[var(--border-subtle)] space-y-2">
                            <div className="font-semibold text-text-primary">Mẫu quảng cáo thực tế</div>
                            {creativeSnapshot?.status === 'PENDING_SYNC' ? (
                              <div className="text-[10px] text-amber-700">
                                Đang chờ đồng bộ nội dung quảng cáo từ Meta. Lead và nguồn đăng ký vẫn được lưu bình thường.
                              </div>
                            ) : creativeSnapshot?.status === 'UNAVAILABLE' ? (
                              <div className="text-[10px] text-text-tertiary">
                                Meta hiện không cung cấp được nội dung hoặc tài sản của quảng cáo này. Kiểm tra quyền ads_read hoặc trạng thái quảng cáo.
                              </div>
                            ) : creativeSnapshot ? (
                              <>
                                <div className="text-[10px] text-text-secondary space-y-0.5">
                                  <div>
                                    Campaign: {creativeSnapshot.campaignName || campaignLabel}
                                    <span className="ml-1 font-mono text-[9px] text-text-tertiary">({creativeSnapshot.campaignId || tp.meta_campaign_id || '—'})</span>
                                  </div>
                                  <div>
                                    Ad Set: {creativeSnapshot.adsetName || tp.ad_set_name_snapshot || 'Chưa có dữ liệu'}
                                    <span className="ml-1 font-mono text-[9px] text-text-tertiary">({creativeSnapshot.adsetId || tp.meta_ad_set_id || '—'})</span>
                                  </div>
                                  <div>
                                    Ad: {creativeSnapshot.adName || tp.ad_name_snapshot || 'Chưa có dữ liệu'}
                                    <span className="ml-1 font-mono text-[9px] text-text-tertiary">({creativeSnapshot.adId || tp.meta_ad_id || '—'})</span>
                                  </div>
                                  {creativeSnapshot.creativeName && <div>Creative: {creativeSnapshot.creativeName}</div>}
                                  {creativeSnapshot.creativeId && <div>Creative ID: <span className="font-mono">{creativeSnapshot.creativeId}</span></div>}
                                  {creativeSnapshot.format && creativeSnapshot.format !== 'UNKNOWN' && <div>Định dạng: {creativeSnapshot.format}</div>}
                                </div>
                                {creativeMedia.length > 0 && (
                                  <div className="grid grid-cols-2 gap-2">
                                    {creativeMedia.slice(0, 4).map((asset) => (
                                      <div key={asset.url} className="overflow-hidden rounded border border-[var(--border-subtle)] bg-[var(--surface-secondary)]">
                                        <Image
                                          src={asset.url}
                                          alt={asset.alt}
                                          width={640}
                                          height={360}
                                          unoptimized
                                          className="h-24 w-full object-cover"
                                        />
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {creativeSnapshot.primaryText && (
                                  <div className="text-[10px] text-text-secondary whitespace-pre-wrap">
                                    <span className="font-semibold">Nội dung:</span> {creativeSnapshot.primaryText}
                                  </div>
                                )}
                                {creativeSnapshot.headlines.length > 0 && (
                                  <div className="text-[10px] text-text-secondary">
                                    <span className="font-semibold">Tiêu đề:</span> {creativeSnapshot.headlines.join(' • ')}
                                  </div>
                                )}
                                {creativeSnapshot.descriptions.length > 0 && (
                                  <div className="text-[10px] text-text-secondary">
                                    <span className="font-semibold">Mô tả:</span> {creativeSnapshot.descriptions.join(' • ')}
                                  </div>
                                )}
                                {creativeSnapshot.ctaType && (
                                  <div className="text-[10px] text-text-secondary">CTA: {creativeSnapshot.ctaType}</div>
                                )}
                                {creativeSnapshot.destinationUrl && (
                                  <a
                                    href={creativeSnapshot.destinationUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-block text-[10px] text-[var(--accent)] underline"
                                  >
                                    Mở trang đích quảng cáo
                                  </a>
                                )}
                                {creativeSnapshot.previewUrl && (
                                  <a
                                    href={creativeSnapshot.previewUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-block text-[10px] text-[var(--accent)] underline ml-3"
                                  >
                                    Mở bản xem trước quảng cáo Meta
                                  </a>
                                )}
                                {creativeSnapshot.videoId && (
                                  <div className="text-[10px] text-text-tertiary">Video ID: <span className="font-mono">{creativeSnapshot.videoId}</span></div>
                                )}
                                {creativeSnapshot.captureTiming === 'BACKFILL' && (
                                  <div className="text-[10px] text-amber-700">
                                    Nội dung được đồng bộ sau thời điểm Lead; có thể là phiên bản quảng cáo hiện tại, không phải bằng chứng chắc chắn về phiên bản lịch sử.
                                  </div>
                                )}
                                {creativeSnapshot.status === 'PARTIAL' && (
                                  <div className="text-[10px] text-text-tertiary">Meta chỉ trả về một phần thông tin creative.</div>
                                )}
                              </>
                            ) : (
                              <div className="text-[10px] text-text-tertiary">
                                Chưa có bản chụp creative cho Lead này.
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-[11px] text-[var(--text-tertiary)] py-1 text-center">
                  Chưa có lịch sử đăng ký qua quảng cáo.
                </div>
              )}
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
