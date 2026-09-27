import 'server-only';

import React from 'react';
import { redirect } from 'next/navigation';
import { getActorContext, requireBossAdmin, AuthError } from '../../../../lib/auth/context';
import { createClient } from '../../../../lib/supabase/server';
import {
  fetchCompanyAnalyticsDailySeries,
  fetchCompanyAnalyticsOverview,
} from '../../../../features/analytics/services/analytics-store';
import {
  getPresetRanges,
  resolveDateRange,
} from '../../../../features/analytics/utils/date-range';
import { AnalyticsHeader } from '../../../../features/analytics/components/analytics-header';
import { KpiHighlights } from '../../../../features/analytics/components/kpi-highlights';
import { FinanceSnapshotCard } from '../../../../features/analytics/components/finance-snapshot-card';
import { SlaPerformanceCard } from '../../../../features/analytics/components/sla-performance-card';
import { CustomerPipelineCard } from '../../../../features/analytics/components/customer-pipeline-card';
import { SalesAndOperationsCard } from '../../../../features/analytics/components/sales-and-operations-card';
import { DailySeriesCard } from '../../../../features/analytics/components/daily-series-card';

interface AnalyticsPageProps {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function AnalyticsPage(props: AnalyticsPageProps) {
  // 1. Resolve Actor Context server-side
  const actor = await getActorContext();

  if (!actor || !actor.companyId) {
    return (
      <div className="p-8 text-center bg-red-950/40 border border-red-800 rounded-xl">
        <h2 className="text-xl font-bold text-red-400 mb-2">Truy cập bị từ chối</h2>
        <p className="text-slate-300 text-sm">Chưa xác định danh tính hoặc tổ chức của phiên làm việc.</p>
      </div>
    );
  }

  // 2. Strict Security Gate: Require BOSS_ADMIN with MFA AAL2
  // Derive companyId exclusively from server-side actor. Do NOT trust ?companyId=...
  const companyId = actor.companyId;

  try {
    await requireBossAdmin(companyId, { requireAal2: true });
  } catch (err: unknown) {
    if (err instanceof AuthError && err.code === 'MFA_REQUIRED') {
      if (!actor.isMfaEnrolled) {
        redirect('/admin/mfa/enroll');
      } else {
        redirect('/admin/mfa/verify');
      }
    }

    return (
      <div className="p-8 text-center bg-red-950/40 border border-red-800 rounded-xl">
        <h2 className="text-xl font-bold text-red-400 mb-2">Quyền truy cập Quản trị viên</h2>
        <p className="text-slate-300 text-sm">
          Chỉ Quản trị viên cấp cao (BOSS_ADMIN) của tổ chức mới có quyền xem báo cáo thống kê này.
        </p>
      </div>
    );
  }

  // 3. Resolve Date Query Parameters (Strict Calendar UTC & Safe Fallback)
  const resolvedParams = props.searchParams ? await props.searchParams : {};
  const rawFrom = typeof resolvedParams.from === 'string' ? resolvedParams.from : null;
  const rawTo = typeof resolvedParams.to === 'string' ? resolvedParams.to : null;

  const dateRange = resolveDateRange(rawFrom, rawTo);
  const presets = getPresetRanges();

  // 4. Create Authenticated User-Session Supabase Client (No service role!)
  const supabase = await createClient();

  // 5. Fetch Company-Wide Analytics Overview & Daily Series
  let overview;
  let dailySeries;

  try {
    [overview, dailySeries] = await Promise.all([
      fetchCompanyAnalyticsOverview(supabase, {
        companyId,
        from: dateRange.rpcFrom,
        to: dateRange.rpcTo,
      }),
      fetchCompanyAnalyticsDailySeries(supabase, {
        companyId,
        from: dateRange.rpcFrom,
        to: dateRange.rpcTo,
      }),
    ]);
  } catch (error: unknown) {
    console.error('[Analytics] Failed to fetch company analytics data:', error);
    return (
      <div className="space-y-6">
        <AnalyticsHeader
          actorEmail={actor.email}
          actorRole={actor.role || 'BOSS_ADMIN'}
          actorAal={actor.aal}
          companyId={companyId}
          range={dateRange}
          presets={presets}
        />
        <div className="p-6 bg-red-950/30 border border-red-800/80 rounded-xl text-center space-y-2">
          <div className="text-base font-semibold text-red-400">
            Không thể tải dữ liệu báo cáo thống kê
          </div>
          <p className="text-xs text-slate-400 max-w-xl mx-auto">
            Hệ thống tạm thời không thể tải dữ liệu báo cáo thống kê vào lúc này. Vui lòng thử lại sau hoặc liên hệ bộ phận hỗ trợ kỹ thuật.
          </p>
        </div>
      </div>
    );
  }

  // 6. Render Management Dashboard UI
  return (
    <div className="space-y-6">
      {/* Header, Filters & Timezone notice */}
      <AnalyticsHeader
        actorEmail={actor.email}
        actorRole={actor.role || 'BOSS_ADMIN'}
        actorAal={actor.aal}
        companyId={companyId}
        range={dateRange}
        presets={presets}
      />

      {/* KPI Highlights (Period) */}
      <KpiHighlights overview={overview} />

      {/* Finance Snapshot ("As of Now" / Tức thời) */}
      <FinanceSnapshotCard snapshot={overview.financeSnapshot} />

      {/* SLA 5-Minute Compliance Performance */}
      <SlaPerformanceCard sla={overview.responseSla} />

      {/* Customer Sources & Pipeline (Snapshot distribution vs Period transitions) */}
      <CustomerPipelineCard
        newCustomers={overview.customers.newCustomers}
        bySource={overview.customers.bySource}
        currentStageDistribution={overview.currentStageDistribution}
        stageTransitions={overview.stageTransitions}
      />

      {/* Sales, Call Center, Surveys, Care */}
      <SalesAndOperationsCard
        orders={overview.orders}
        calls={overview.calls}
        surveys={overview.surveys}
        care={overview.care}
      />

      {/* Chronological Daily Activity Series */}
      <DailySeriesCard series={dailySeries} />
    </div>
  );
}
