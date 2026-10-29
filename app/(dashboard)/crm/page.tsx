import React from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getActorContext } from '../../../lib/auth/context';
import { APPLICATION_ROLES } from '../../../shared/constants/roles';
import { createAdminClient } from '../../../lib/supabase/admin';
import { CustomerService } from '../../../features/crm/services/customer.service';
import {
  CANONICAL_STAGE_LIST,
  PIPELINE_STAGE_GROUPS,
  type CanonicalCustomerStage,
} from '../../../features/crm/types/customer.types';
import {
  Users,
  Flame,
  AlertCircle,
  PhoneCall,
  Inbox,
  ArrowRight,
  Sparkles,
  ChevronRight,
  TrendingUp,
  CheckCircle2,
  KanbanSquare,
} from 'lucide-react';
import { PageHeader } from '../../../components/ui/page-header';
import { Metric } from '../../../components/ui/metric';
import { Card, CardHeader, CardTitle, CardContent } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { StatusBadge } from '../../../components/ui/status-badge';
import { Avatar } from '../../../components/ui/avatar';
import { EmptyState } from '../../../components/ui/empty-state';
import {
  PhoneRevealProvider,
  SecurePhoneRow,
} from '../../../features/crm/components/secure-phone-reveal';

export const metadata = {
  title: 'CRM Tổng quan | AI CRM Cửa Chống Ngập',
  description: 'Trung tâm điều hành kinh doanh và quản lý quan hệ khách hàng',
};

export default async function CrmDashboardPage() {
  const actor = await getActorContext();

  if (!actor || actor.profileStatus !== 'ACTIVE') {
    redirect('/login');
  }

  // Chặn Kỹ thuật viên (Chỉ BOSS_ADMIN và SALE được truy cập CRM)
  if (actor.role !== APPLICATION_ROLES.BOSS_ADMIN && actor.role !== APPLICATION_ROLES.SALE) {
    return (
      <EmptyState
        type="permission"
        title="Truy cập bị từ chối"
        description="Khu vực CRM bán hàng chỉ dành cho Chuyên viên Kinh doanh và Quản trị viên."
        action={{
          label: 'Về trang Hiện trường',
          href: '/field',
        }}
      />
    );
  }

  const db = createAdminClient();
  const companyId = actor.companyId!;

  // Fail-closed metric results: do NOT silently fallback DB errors to 0
  type MetricResult<T> = {
    status: 'success' | 'error';
    value: T;
  };

  const parseCountResult = (
    result: PromiseSettledResult<{ count: number | null; error: unknown }>,
    metricName: string
  ): MetricResult<number | null> => {
    if (result.status === 'fulfilled' && !result.value.error && typeof result.value.count === 'number') {
      return { status: 'success', value: result.value.count };
    }
    const errorDetails =
      result.status === 'rejected' ? result.reason : (result.value as { error: unknown })?.error;
    console.error(`[CRM Dashboard] Lỗi truy vấn ${metricName}:`, errorDetails);
    return { status: 'error', value: null };
  };

  const [
    urgentRes,
    totalRes,
    awarenessRes,
    interestedRes,
    deepResearchRes,
    lowPotentialRes,
    highPotentialRes,
    contractSignedRes,
    ordersRes,
  ] = await Promise.allSettled([
    CustomerService.getUrgentClosingCustomers(companyId, 6, actor.role),
    db.from('customers').select('id', { count: 'exact', head: true }).eq('company_id', companyId),
    db
      .from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .in('stage', [...PIPELINE_STAGE_GROUPS.AWARENESS]),
    db
      .from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .in('stage', [...PIPELINE_STAGE_GROUPS.INTERESTED]),
    db
      .from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .in('stage', [...PIPELINE_STAGE_GROUPS.DEEP_RESEARCH]),
    db
      .from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .in('stage', [...PIPELINE_STAGE_GROUPS.LOW_POTENTIAL]),
    db
      .from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .in('stage', [...PIPELINE_STAGE_GROUPS.HIGH_POTENTIAL]),
    db
      .from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .in('stage', [...PIPELINE_STAGE_GROUPS.CONTRACT_SIGNED]),
    db.from('orders').select('id', { count: 'exact', head: true }).eq('company_id', companyId),
  ]);

  let urgentCustomersResult: MetricResult<
    Awaited<ReturnType<typeof CustomerService.getUrgentClosingCustomers>>
  >;
  if (urgentRes.status === 'fulfilled') {
    urgentCustomersResult = { status: 'success', value: urgentRes.value };
  } else {
    console.error('[CRM Dashboard] Lỗi truy vấn urgent customers:', urgentRes.reason);
    urgentCustomersResult = { status: 'error', value: [] };
  }

  const totalCustomers = parseCountResult(totalRes, 'totalCustomers');
  const totalOrders = parseCountResult(ordersRes, 'totalOrders');
  const stageCountResults: Record<CanonicalCustomerStage, MetricResult<number | null>> = {
    awareness: parseCountResult(awarenessRes, 'awarenessCount'),
    interested: parseCountResult(interestedRes, 'interestedCount'),
    deep_research: parseCountResult(deepResearchRes, 'deepResearchCount'),
    low_potential: parseCountResult(lowPotentialRes, 'lowPotentialCount'),
    high_potential: parseCountResult(highPotentialRes, 'highPotentialCount'),
    contract_signed: parseCountResult(contractSignedRes, 'contractSignedCount'),
  };
  const highPotentialCount = stageCountResults.high_potential;

  const STAGE_COLORS: Record<CanonicalCustomerStage, string> = {
    awareness: 'bg-sky-500',
    interested: 'bg-cyan-500',
    deep_research: 'bg-indigo-500',
    low_potential: 'bg-slate-400',
    high_potential: 'bg-amber-500',
    contract_signed: 'bg-emerald-500',
  };

  // Sáu giai đoạn canonical; mỗi nhóm đã bao gồm giá trị legacy tương ứng.
  const pipelineStages = CANONICAL_STAGE_LIST.map((stage) => ({
    stage: stage.value,
    label: stage.label,
    description: stage.description,
    result: stageCountResults[stage.value],
    color: STAGE_COLORS[stage.value],
  }));

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        title="CRM Khách Hàng & Bán Hàng"
        description="Theo dõi hoạt động khách hàng, luồng đàm phán và các tác vụ cần xử lý ngay trong ngày."
        primaryAction={
          <Link href="/customers/dossier">
            <Button variant="primary" size="sm" rightIcon={<ArrowRight className="w-3.5 h-3.5" />}>
              Hồ sơ Khách hàng 360
            </Button>
          </Link>
        }
        secondaryActions={
          <div className="flex items-center gap-2">
            <Link href="/crm/pipeline">
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<KanbanSquare className="w-3.5 h-3.5" />}
              >
                Phễu Kanban
              </Button>
            </Link>
            <Link href="/inbox">
              <Button variant="secondary" size="sm" leftIcon={<Inbox className="w-3.5 h-3.5" />}>
                Mở Hộp thư
              </Button>
            </Link>
          </div>
        }
      />

      {/* Top 4 Meaningful Operational Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Metric
          label="Tổng hồ sơ khách hàng"
          value={totalCustomers.status === 'success' ? totalCustomers.value : '—'}
          icon={<Users className="w-4 h-4 text-blue-600" />}
          subtitle={
            totalCustomers.status === 'success' ? (
              'Đang quản lý trong công ty'
            ) : (
              <span className="text-amber-600 font-normal">Không tải được</span>
            )
          }
        />
        <Metric
          label="Cơ hội cần chốt gấp"
          value={
            urgentCustomersResult.status === 'success'
              ? urgentCustomersResult.value.length
              : '—'
          }
          icon={<Flame className="w-4 h-4 text-rose-600" />}
          subtitle={
            urgentCustomersResult.status === 'success' ? (
              'Ưu tiên gọi & phản hồi hôm nay'
            ) : (
              <span className="text-amber-600 font-normal">Không tải được</span>
            )
          }
          trend={
            urgentCustomersResult.status === 'success' &&
            urgentCustomersResult.value.length > 0
              ? { value: 'Cần chú ý', isPositive: false }
              : undefined
          }
        />
        <Metric
          label="Có tiềm năng / cần chốt"
          value={highPotentialCount.status === 'success' ? highPotentialCount.value : '—'}
          icon={<TrendingUp className="w-4 h-4 text-amber-600" />}
          subtitle={
            highPotentialCount.status === 'success' ? (
              'Khách hàng đang ở giai đoạn Có tiềm năng'
            ) : (
              <span className="text-amber-600 font-normal">Không tải được</span>
            )
          }
        />
        <Metric
          label="Tổng đơn hàng"
          value={totalOrders.status === 'success' ? totalOrders.value : '—'}
          icon={<CheckCircle2 className="w-4 h-4 text-emerald-600" />}
          subtitle={
            totalOrders.status === 'success' ? (
              'Đơn hàng đã phát sinh'
            ) : (
              <span className="text-amber-600 font-normal">Không tải được</span>
            )
          }
        />
      </div>

      {/* Main Workspace Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column (2 Cols): Urgent Work Queue & Attention Items */}
        <div className="lg:col-span-2 space-y-6">
          <PhoneRevealProvider>
          <Card>
            <CardHeader className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-500" />
                  <span>Danh sách khách hàng cần chú ý gấp</span>
                </CardTitle>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  Khách hàng có lịch hẹn khảo sát, quá hạn liên hệ hoặc đang chờ chốt giá.
                </p>
              </div>
              <Link href="/customers/dossier?overdue=1">
                <Button variant="ghost" size="xs" rightIcon={<ChevronRight className="w-3 h-3" />}>
                  Xem tất cả
                </Button>
              </Link>
            </CardHeader>

            <CardContent className="p-0">
              {urgentCustomersResult.status === 'error' ? (
                <div className="p-8 text-center text-xs text-[var(--text-tertiary)]">
                  <AlertCircle className="w-8 h-8 mx-auto mb-2 text-amber-500 opacity-80" />
                  Không thể tải danh sách khách hàng cần chú ý lúc này.
                </div>
              ) : urgentCustomersResult.value.length === 0 ? (
                <div className="p-8 text-center text-xs text-[var(--text-tertiary)]">
                  <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-emerald-500 opacity-80" />
                  Không có khách hàng nào quá hạn hoặc cần xử lý gấp tại thời điểm này.
                </div>
              ) : (
                <div className="divide-y divide-[var(--border-subtle)]">
                  {urgentCustomersResult.value.map((cust) => (
                    <div
                      key={cust.id}
                      className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-[var(--surface-hover)] transition-colors"
                    >
                      <div className="flex items-start gap-3 min-w-0">
                        <Avatar name={cust.name} size="md" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Link
                              href={`/customers/${cust.id}/dossier`}
                              className="text-xs font-semibold text-[var(--text-primary)] hover:text-[var(--accent)] truncate"
                            >
                              {cust.name}
                            </Link>
                            <span className="text-[10px] font-mono text-[var(--text-tertiary)]">
                              {cust.customer_code}
                            </span>
                          </div>

                          <div className="flex items-center gap-2 mt-1 text-[11px] text-[var(--text-secondary)]">
                            <StatusBadge status={cust.stage} size="xs" />
                            <span>•</span>
                            <span>Nguồn: {cust.source || 'Trực tiếp'}</span>
                            {cust.phone && (
                              <>
                                <span>•</span>
                                <SecurePhoneRow customerId={cust.id} maskedPhone={cust.phone} />
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                        <Link href={`/calls/${cust.id}`}>
                          <Button variant="secondary" size="xs" leftIcon={<PhoneCall className="w-3 h-3 text-emerald-600" />}>
                            Gọi điện
                          </Button>
                        </Link>
                        <Link href={`/customers/${cust.id}/dossier`}>
                          <Button variant="primary" size="xs" rightIcon={<ChevronRight className="w-3 h-3" />}>
                            Chi tiết 360
                          </Button>
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          </PhoneRevealProvider>

          {/* Sales Pipeline Distribution Summary */}
          <Card>
            <CardHeader className="flex items-center justify-between">
              <div>
                <CardTitle>Tổng quan phễu bán hàng (6 giai đoạn)</CardTitle>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  Tỉ lệ là tỉ trọng phân bố trên tổng khách hàng, không phải tỉ lệ chuyển đổi.
                </p>
              </div>
              <Link href="/crm/pipeline">
                <Button variant="ghost" size="xs" rightIcon={<ChevronRight className="w-3 h-3" />}>
                  Mở Kanban &amp; Funnel
                </Button>
              </Link>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {pipelineStages.map((stg, i) => {
                  const isOk = stg.result.status === 'success' && stg.result.value !== null;
                  const countVal = isOk ? stg.result.value : '—';
                  const percentage =
                    isOk &&
                    totalCustomers.status === 'success' &&
                    totalCustomers.value &&
                    totalCustomers.value > 0
                      ? Math.min(
                          100,
                          Math.round(((stg.result.value as number) / totalCustomers.value) * 100)
                        )
                      : 0;

                  return (
                    <div key={i} className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-[var(--text-secondary)] font-medium">
                          {stg.label}
                        </span>
                        <div className="flex items-center gap-2">
                          {!isOk && (
                            <span className="text-[10px] text-amber-600 font-normal">
                              Không tải được
                            </span>
                          )}
                          <span className="font-semibold font-mono text-[var(--text-primary)]">
                            {countVal}
                          </span>
                        </div>
                      </div>
                      <div className="w-full h-2 bg-[var(--surface-secondary)] rounded-full overflow-hidden border border-[var(--border-subtle)]">
                        <div
                          className={`h-full ${stg.color} rounded-full transition-all duration-300`}
                          style={{
                            width: `${percentage}%`,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Column: AI Assistant & Quick Hub */}
        <div className="space-y-6">
          {/* AI Customer 360 Hub Promotion */}
          <div className="p-5 rounded-xl border border-[var(--ai-border)] bg-gradient-to-br from-[var(--ai-surface)] to-[var(--surface-primary)] shadow-xs space-y-3">
            <div className="flex items-center gap-2 text-indigo-700">
              <Sparkles className="w-4 h-4 shrink-0" />
              <span className="text-xs font-semibold uppercase tracking-wider font-mono">
                AI Customer 360 & Dossier
              </span>
            </div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              Hồ sơ khách hàng thông minh
            </h3>
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              Tự động trích xuất nhu cầu, độ tin cậy, pain points và tín hiệu mua hàng từ hội thoại đa kênh &amp; cuộc gọi Zalo.
            </p>
            <div className="pt-1">
              <Link href="/customers/dossier">
                <Button variant="primary" size="sm" className="w-full" rightIcon={<ArrowRight className="w-3.5 h-3.5" />}>
                  Truy cập Customer 360
                </Button>
              </Link>
            </div>
          </div>

          {/* Quick Actions Card */}
          <Card>
            <CardHeader>
              <CardTitle>Lối tắt thao tác nhanh</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 p-3">
              <Link
                href="/crm/pipeline"
                className="flex items-center justify-between p-2.5 rounded-lg hover:bg-[var(--surface-hover)] transition-colors group text-xs text-[var(--text-primary)]"
              >
                <div className="flex items-center gap-2.5">
                  <KanbanSquare className="w-4 h-4 text-sky-600" />
                  <span className="font-medium group-hover:text-[var(--accent)]">Phễu Kanban &amp; Funnel</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
              </Link>

              <Link
                href="/inbox"
                className="flex items-center justify-between p-2.5 rounded-lg hover:bg-[var(--surface-hover)] transition-colors group text-xs text-[var(--text-primary)]"
              >
                <div className="flex items-center gap-2.5">
                  <Inbox className="w-4 h-4 text-indigo-600" />
                  <span className="font-medium group-hover:text-[var(--accent)]">Hộp thư tin nhắn đa kênh</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
              </Link>

              <Link
                href="/calls"
                className="flex items-center justify-between p-2.5 rounded-lg hover:bg-[var(--surface-hover)] transition-colors group text-xs text-[var(--text-primary)]"
              >
                <div className="flex items-center gap-2.5">
                  <PhoneCall className="w-4 h-4 text-emerald-600" />
                  <span className="font-medium group-hover:text-[var(--accent)]">Lịch sử cuộc gọi &amp; Ghi âm</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
              </Link>

              {actor.role === 'BOSS_ADMIN' && (
                <Link
                  href="/admin/ai"
                  className="flex items-center justify-between p-2.5 rounded-lg hover:bg-[var(--surface-hover)] transition-colors group text-xs text-[var(--text-primary)]"
                >
                  <div className="flex items-center gap-2.5">
                    <Sparkles className="w-4 h-4 text-rose-600" />
                    <span className="font-medium group-hover:text-[var(--accent)]">AI Control Center &amp; Health</span>
                  </div>
                  <ChevronRight className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
                </Link>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
