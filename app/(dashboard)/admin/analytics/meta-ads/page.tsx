import 'server-only';

import React from 'react';
import Link from 'next/link';
import { getActorContext } from '@/lib/auth/context';
import { verifyActorForCompany } from '@/lib/server-auth/authorize';
import { createAdminClient } from '@/lib/supabase/admin';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/data-table';
import {
  Megaphone,
  TrendingUp,
  Users,
  DollarSign,
  Eye,
  RefreshCw,
  Info,
  Calendar,
} from 'lucide-react';

interface CampaignReportRow {
  campaign_id?: string;
  campaign_name?: string;
  campaign_status?: string;
  spend?: number;
  impressions?: number;
  clicks?: number;
  ctr?: number;
  meta_leads?: number;
  crm_leads?: number;
  attributed_leads?: number;
  cpl?: number;
}

interface MetaAdsReportPageProps {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatNumber(num: number): string {
  return new Intl.NumberFormat('vi-VN').format(num);
}

export default async function MetaAdsReportPage(props: MetaAdsReportPageProps) {
  const actor = await getActorContext();
  if (!actor?.companyId) {
    return (
      <div className="p-8 text-center bg-rose-50 border border-rose-200 rounded-xl text-rose-800">
        Chưa xác định danh tính phiên làm việc.
      </div>
    );
  }

  await verifyActorForCompany(actor.companyId, {
    allowedRoles: ['BOSS_ADMIN', 'SALE'],
  });

  const resolvedParams = props.searchParams ? await props.searchParams : {};
  const range = typeof resolvedParams.range === 'string' ? resolvedParams.range : '30d';

  const now = new Date();
  let fromDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (range === 'today') {
    fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (range === '7d') {
    fromDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (range === '90d') {
    fromDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  }

  const from = fromDate.toISOString();
  const to = now.toISOString();

  const supabase = createAdminClient();

  // Fetch report data via database RPC
  const { data: reportData, error: reportError } = await supabase.rpc('get_meta_ads_performance_report', {
    p_company: actor.companyId,
    p_from: from,
    p_to: to,
  });

  if (reportError) {
    console.error('Failed to get meta ads performance report:', reportError);
  }

  const overview = reportData?.overview || {
    spend: 0,
    impressions: 0,
    clicks: 0,
    ctr: 0,
    meta_leads: 0,
    crm_leads: 0,
    attributed_leads: 0,
    qualified_leads: 0,
    cpl: 0,
    cost_per_qualified: 0,
  };

  const campaigns = (reportData?.campaigns || []) as CampaignReportRow[];

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Báo cáo & Thống kê', href: '/admin/analytics' },
          { label: 'Báo cáo Meta Ads' },
        ]}
        title="Báo cáo Hiệu quả Quảng cáo Meta Ads"
        description="Theo dõi chi phí quảng cáo, lượt hiển thị, click, số lead Meta báo cáo đối chiếu với số lead thực tế và CPL trong CRM."
        primaryAction={
          <div className="flex items-center gap-2">
            <Link
              href="/admin/facebook"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border-subtle bg-surface-primary hover:bg-surface-hover text-text-primary text-xs font-medium transition shadow-xs"
            >
              <Megaphone className="w-3.5 h-3.5 text-accent" />
              <span>Quản lý kết nối Meta Ads</span>
            </Link>
          </div>
        }
      />

      {/* Date Range Selector */}
      <div className="flex items-center justify-between gap-3 flex-wrap bg-surface-primary p-3 rounded-xl border border-border-subtle">
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <Calendar className="w-4 h-4 text-text-tertiary" />
          <span>Khoảng thời gian:</span>
          <div className="flex items-center gap-1">
            <Link
              href="/admin/analytics/meta-ads?range=today"
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${
                range === 'today'
                  ? 'bg-accent text-white'
                  : 'bg-surface-secondary text-text-secondary hover:text-text-primary'
              }`}
            >
              Hôm nay
            </Link>
            <Link
              href="/admin/analytics/meta-ads?range=7d"
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${
                range === '7d'
                  ? 'bg-accent text-white'
                  : 'bg-surface-secondary text-text-secondary hover:text-text-primary'
              }`}
            >
              7 ngày qua
            </Link>
            <Link
              href="/admin/analytics/meta-ads?range=30d"
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${
                range === '30d'
                  ? 'bg-accent text-white'
                  : 'bg-surface-secondary text-text-secondary hover:text-text-primary'
              }`}
            >
              30 ngày qua
            </Link>
            <Link
              href="/admin/analytics/meta-ads?range=90d"
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${
                range === '90d'
                  ? 'bg-accent text-white'
                  : 'bg-surface-secondary text-text-secondary hover:text-text-primary'
              }`}
            >
              90 ngày qua
            </Link>
          </div>
        </div>

        <form action="/api/admin/meta-ads/sync" method="post">
          <Button type="submit" variant="outline" size="sm" leftIcon={<RefreshCw className="w-3.5 h-3.5" />}>
            Đồng bộ dữ liệu mới nhất
          </Button>
        </form>
      </div>

      {/* Key Metric Highlights Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Ad Spend */}
        <Card className="p-5 space-y-2">
          <div className="flex items-center justify-between text-xs text-text-tertiary">
            <span>Chi phí quảng cáo (Spend)</span>
            <DollarSign className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="text-2xl font-bold text-text-primary font-mono">
            {formatCurrency(Number(overview.spend || 0))}
          </div>
          <p className="text-[11px] text-text-secondary">
            Tổng chi phí Meta Marketing API ghi nhận trong kỳ.
          </p>
        </Card>

        {/* Impressions, Clicks, CTR */}
        <Card className="p-5 space-y-2">
          <div className="flex items-center justify-between text-xs text-text-tertiary">
            <span>Hiển thị &amp; Click (CTR)</span>
            <Eye className="w-4 h-4 text-blue-600" />
          </div>
          <div className="text-2xl font-bold text-text-primary font-mono">
            {overview.ctr}%
          </div>
          <div className="text-[11px] text-text-secondary flex items-center gap-2">
            <span>👁 {formatNumber(Number(overview.impressions || 0))} lượt xem</span>
            <span>•</span>
            <span>🖱 {formatNumber(Number(overview.clicks || 0))} click</span>
          </div>
        </Card>

        {/* Leads: Meta vs CRM */}
        <Card className="p-5 space-y-2">
          <div className="flex items-center justify-between text-xs text-text-tertiary">
            <span>Leads CRM tiếp nhận / Meta</span>
            <Users className="w-4 h-4 text-indigo-600" />
          </div>
          <div className="text-2xl font-bold text-text-primary font-mono flex items-baseline gap-2">
            <span>{overview.crm_leads}</span>
            <span className="text-xs text-text-tertiary font-normal">
              (Meta báo: {overview.meta_leads})
            </span>
          </div>
          <div className="text-[11px] text-text-secondary flex items-center gap-2">
            <span className="text-emerald-700 font-medium">
              🎯 {overview.attributed_leads} lead có attribution
            </span>
          </div>
        </Card>

        {/* Cost Per Lead (CPL) */}
        <Card className="p-5 space-y-2">
          <div className="flex items-center justify-between text-xs text-text-tertiary">
            <span>Chi phí / Lead (CPL)</span>
            <TrendingUp className="w-4 h-4 text-amber-600" />
          </div>
          <div className="text-2xl font-bold text-text-primary font-mono">
            {Number(overview.cpl) > 0 ? formatCurrency(Number(overview.cpl)) : '0 ₫'}
          </div>
          <p className="text-[11px] text-text-secondary">
            {overview.qualified_leads > 0
              ? `Chi phí / Lead đủ điều kiện: ${formatCurrency(Number(overview.cost_per_qualified))}`
              : 'Chưa có lead chuyển đổi sang giai đoạn tiềm năng'}
          </p>
        </Card>
      </div>

      {/* Metric Definitions & Attribution Transparency Alert */}
      <Card className="p-4 bg-surface-secondary border-border-subtle text-xs text-text-secondary space-y-1.5">
        <div className="flex items-center gap-2 font-semibold text-text-primary">
          <Info className="w-4 h-4 text-accent" />
          <span>Quy tắc đối soát dữ liệu &amp; Minh bạch chỉ số</span>
        </div>
        <ul className="list-disc list-inside space-y-1 text-[11px] text-text-secondary leading-relaxed pl-1">
          <li>
            <strong>Leads Meta báo cáo:</strong> Dữ liệu từ bảng báo cáo Meta Insights dựa trên số lượt người dùng nhấn gửi Instant Form hoặc gửi tin nhắn quảng cáo.
          </li>
          <li>
            <strong>Leads CRM tiếp nhận:</strong> Số lượt lead thực tế mà hệ thống CRM đã giải mã webhook, lưu bản ghi tương tác và liên kết khách hàng.
          </li>
          <li>
            <strong>Leads được Attribution:</strong> Số lead có định danh chiến dịch/quảng cáo được xác minh trực tiếp từ leadgen payload hoặc referral Click-to-Messenger. Nguồn không có ad metadata được ghi nhận là <code>UNATTRIBUTED</code>, tuyệt đối không suy đoán từ Page ID.
          </li>
          <li>
            <strong>Cost Per Lead (CPL):</strong> Tính bằng <code>Tổng chi phí ÷ Số lead được attribution chính xác</code>. Khi chưa có lead hợp lệ, chỉ số giữ mức 0 thay vì chia cho 0.
          </li>
        </ul>
      </Card>

      {/* Campaign Breakdown Table */}
      <Card className="overflow-hidden space-y-4 p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-text-primary">Hiệu quả từng Chiến dịch (Campaigns)</h3>
            <p className="text-xs text-text-secondary mt-0.5">
              Phân bổ chi phí, lượt xem, click và số lead ghi nhận thực tế theo từng chiến dịch quảng cáo Meta.
            </p>
          </div>
          <Badge variant="neutral">
            {campaigns.length} Chiến dịch
          </Badge>
        </div>

        {campaigns.length === 0 ? (
          <div className="text-center py-10 border border-dashed border-border-subtle rounded-lg text-xs text-text-secondary space-y-2">
            <div>Chưa có dữ liệu chiến dịch quảng cáo nào trong khoảng thời gian đã chọn.</div>
            <p className="text-[11px] text-text-tertiary">
              Vào trang &ldquo;Quản lý kết nối Meta Ads&rdquo; để kiểm tra trạng thái tài khoản quảng cáo và đồng bộ dữ liệu.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Chiến dịch</TableHead>
                  <TableHead>Trạng thái</TableHead>
                  <TableHead className="text-right">Chi phí</TableHead>
                  <TableHead className="text-right">Hiển thị</TableHead>
                  <TableHead className="text-right">Clicks</TableHead>
                  <TableHead className="text-right">CTR</TableHead>
                  <TableHead className="text-right">Leads Meta</TableHead>
                  <TableHead className="text-right">Leads CRM</TableHead>
                  <TableHead className="text-right">Attributed</TableHead>
                  <TableHead className="text-right">CPL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((c, idx: number) => (
                  <TableRow key={String(c.campaign_id || idx)}>
                    <TableCell>
                      <div className="font-semibold text-xs text-text-primary truncate max-w-xs">
                        {c.campaign_name || 'Chiến dịch không tên'}
                      </div>
                      <div className="font-mono text-[10px] text-text-tertiary">
                        {c.campaign_id || ''}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={c.campaign_status === 'ACTIVE' ? 'success' : 'neutral'}
                        size="xs"
                      >
                        {c.campaign_status || 'PAUSED'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs font-semibold">
                      {formatCurrency(Number(c.spend || 0))}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatNumber(Number(c.impressions || 0))}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatNumber(Number(c.clicks || 0))}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {c.ctr ?? 0}%
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-text-tertiary">
                      {c.meta_leads ?? 0}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs font-medium text-text-primary">
                      {c.crm_leads ?? 0}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs font-semibold text-emerald-700">
                      {c.attributed_leads ?? 0}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs font-semibold text-accent">
                      {Number(c.cpl) > 0 ? formatCurrency(Number(c.cpl)) : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}
