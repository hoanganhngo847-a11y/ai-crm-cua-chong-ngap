'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  ArrowRight,
  BarChart3,
  ChevronDown,
  KanbanSquare,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { Card } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { EmptyState } from '../../../components/ui/empty-state';
import { StatusBadge } from '../../../components/ui/status-badge';
import { Badge } from '../../../components/ui/badge';
import {
  CANONICAL_STAGE_LIST,
  CUSTOMER_STAGE_LABELS,
  tryToCanonicalStage,
  type CanonicalCustomerStage,
  type CustomerPipelineResponse,
  type CustomerResponse,
} from '../types/customer.types';

interface CustomerPipelineBoardProps {
  userRole?: string | null;
  initialData?: CustomerPipelineResponse | null;
}

const SOURCE_LABELS: Record<string, string> = {
  FACEBOOK: 'Facebook',
  ZALO: 'Zalo',
  ZALO_OA: 'Zalo OA',
  WEBSITE: 'Website',
  HOTLINE: 'Hotline',
  ADVERTISING: 'Quảng cáo',
  MANUAL: 'Nhập thủ công',
};

const STAGE_ACCENTS: Record<CanonicalCustomerStage, string> = {
  awareness: 'border-sky-200 bg-sky-50/60',
  interested: 'border-cyan-200 bg-cyan-50/60',
  deep_research: 'border-indigo-200 bg-indigo-50/60',
  low_potential: 'border-slate-200 bg-slate-50/60',
  high_potential: 'border-amber-200 bg-amber-50/60',
  contract_signed: 'border-emerald-200 bg-emerald-50/60',
};

const FUNNEL_COLORS: Record<CanonicalCustomerStage, string> = {
  awareness: 'bg-sky-500',
  interested: 'bg-cyan-500',
  deep_research: 'bg-indigo-500',
  low_potential: 'bg-slate-400',
  high_potential: 'bg-amber-500',
  contract_signed: 'bg-emerald-500',
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
}

function customerStage(customer: CustomerResponse): CanonicalCustomerStage | null {
  return customer.canonical_stage || tryToCanonicalStage(customer.stage) || null;
}

export default function CustomerPipelineBoard({
  userRole,
  initialData = null,
}: CustomerPipelineBoardProps) {
  const isBossAdmin = userRole === 'BOSS_ADMIN';
  const [view, setView] = useState<'kanban' | 'funnel'>('kanban');
  const [data, setData] = useState<CustomerPipelineResponse | null>(initialData);
  const [loading, setLoading] = useState<boolean>(!initialData);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [stageFilter, setStageFilter] = useState<'' | CanonicalCustomerStage>('');

  const [pendingMove, setPendingMove] = useState<{
    customer: CustomerResponse;
    target: CanonicalCustomerStage;
  } | null>(null);
  const [moveNote, setMoveNote] = useState('');
  const [moveEvidence, setMoveEvidence] = useState('');
  const [confirmContract, setConfirmContract] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveMessage, setMoveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const requestIdRef = useRef(0);

  const fetchPipeline = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (source) params.set('source', source);
      if (fromDate) params.set('from', new Date(`${fromDate}T00:00:00`).toISOString());
      if (toDate) params.set('to', new Date(`${toDate}T23:59:59`).toISOString());
      params.set('limit', '500');

      const res = await fetch(`/api/customers/pipeline?${params.toString()}`, {
        cache: 'no-store',
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'Không thể tải phễu khách hàng.');
      }
      if (requestId === requestIdRef.current) {
        setData(json.data as CustomerPipelineResponse);
      }
    } catch (err: unknown) {
      if (requestId === requestIdRef.current) {
        setError(err instanceof Error ? err.message : 'Đã có lỗi xảy ra.');
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [search, source, fromDate, toDate]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void fetchPipeline();
    }, 250);
    return () => clearTimeout(timer);
  }, [fetchPipeline]);

  const stageCounts = useMemo(() => {
    const map = new Map<CanonicalCustomerStage, { count: number; percentage: number; needsReview: number }>();
    for (const stage of CANONICAL_STAGE_LIST) {
      const entry = data?.stages.find((item) => item.stage === stage.value);
      map.set(stage.value, {
        count: entry?.count || 0,
        percentage: entry?.percentage || 0,
        needsReview: entry?.needs_review_count || 0,
      });
    }
    return map;
  }, [data]);

  const customersByStage = useMemo(() => {
    const map = new Map<CanonicalCustomerStage, CustomerResponse[]>();
    for (const stage of CANONICAL_STAGE_LIST) map.set(stage.value, []);
    for (const customer of data?.customers || []) {
      const stage = customerStage(customer);
      if (!stage) continue;
      map.get(stage)?.push(customer);
    }
    return map;
  }, [data]);

  const visibleStages = useMemo(
    () => (stageFilter ? CANONICAL_STAGE_LIST.filter((stage) => stage.value === stageFilter) : CANONICAL_STAGE_LIST),
    [stageFilter]
  );

  const resetFilters = () => {
    setSearch('');
    setSource('');
    setFromDate('');
    setToDate('');
    setStageFilter('');
  };

  const openMove = (customer: CustomerResponse, target: CanonicalCustomerStage) => {
    setMoveMessage(null);
    setMoveNote('');
    setMoveEvidence('');
    setConfirmContract(false);
    setPendingMove({ customer, target });
  };

  const submitMove = async () => {
    if (!pendingMove) return;
    const { customer, target } = pendingMove;
    const currentStage = customerStage(customer);
    if (!currentStage) {
      setMoveMessage({
        type: 'error',
        text: 'Không xác định được giai đoạn hiện tại. Vui lòng làm mới dữ liệu trước khi chuyển.',
      });
      return;
    }

    if (target === currentStage) {
      setPendingMove(null);
      return;
    }
    if (target === 'contract_signed' && !isBossAdmin) {
      setMoveMessage({
        type: 'error',
        text: 'Chỉ BOSS_ADMIN mới được xác nhận trạng thái Đã ký hợp đồng.',
      });
      return;
    }
    if (target === 'contract_signed' && (!confirmContract || moveNote.trim().length < 10)) {
      setMoveMessage({
        type: 'error',
        text: 'Cần xác nhận thủ công và ghi rõ bằng chứng hợp đồng đã ký (ít nhất 10 ký tự).',
      });
      return;
    }

    setMoving(true);
    setMoveMessage(null);
    try {
      const res = await fetch(`/api/customers/${customer.id}/stage`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stage: target,
          expected_stage: currentStage,
          note: moveNote.trim() || undefined,
          evidence: moveEvidence.trim() || undefined,
          confirm_contract_signed: target === 'contract_signed' ? confirmContract : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        if (res.status === 409) {
          setMoveMessage({
            type: 'error',
            text: 'Khách hàng vừa được người khác cập nhật. Đã tải lại dữ liệu, vui lòng thử lại.',
          });
          setPendingMove(null);
          await fetchPipeline();
          return;
        }
        throw new Error(json.message || 'Không thể chuyển giai đoạn.');
      }

      setMoveMessage({
        type: 'success',
        text: json.changed === false ? 'Khách hàng đã ở giai đoạn này.' : 'Đã chuyển giai đoạn thành công.',
      });
      setPendingMove(null);
      await fetchPipeline();
    } catch (err: unknown) {
      setMoveMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Lỗi không xác định.',
      });
    } finally {
      setMoving(false);
    }
  };

  const totalEligible = data?.eligible_customers || 0;
  const unmapped = data?.unmapped_count || 0;
  const needsReview = data?.needs_review_count || 0;
  const pendingCurrentStage = pendingMove ? customerStage(pendingMove.customer) : null;

  if (loading && !data) {
    return (
      <Card className="p-6 space-y-4">
        <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          <Loader2 className="w-4 h-4 animate-spin" />
          Đang tải phễu khách hàng...
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[...Array(6)].map((_, index) => (
            <div key={index} className="h-24 rounded-xl bg-[var(--surface-secondary)] animate-pulse" />
          ))}
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="p-8">
        <EmptyState
          type="error"
          title="Không thể tải phễu khách hàng"
          description={error}
          onRetry={() => void fetchPipeline()}
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header + view toggle */}
      <Card className="p-4">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[var(--accent)]" />
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                Phễu khách hàng 6 giai đoạn
              </h2>
              <Badge variant="ai" size="sm">
                AI hỗ trợ phân loại
              </Badge>
            </div>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              Kanban và Funnel dùng chung một nguồn dữ liệu. Tỉ lệ hiển thị là tỉ trọng phân bố,
              không phải tỉ lệ chuyển đổi giữa các giai đoạn.
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <div className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-1">
              <button
                type="button"
                onClick={() => setView('kanban')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition ${
                  view === 'kanban'
                    ? 'bg-[var(--surface-primary)] text-[var(--text-primary)] shadow-xs font-semibold'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                <KanbanSquare className="w-3.5 h-3.5" />
                Kanban
              </button>
              <button
                type="button"
                onClick={() => setView('funnel')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition ${
                  view === 'funnel'
                    ? 'bg-[var(--surface-primary)] text-[var(--text-primary)] shadow-xs font-semibold'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                <BarChart3 className="w-3.5 h-3.5" />
                Funnel
              </button>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void fetchPipeline()}
              disabled={loading}
              leftIcon={<RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />}
            >
              Làm mới
            </Button>
          </div>
        </div>

        {/* Filters */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-2.5 mt-4 pt-4 border-t border-[var(--border-subtle)]">
          <div className="relative xl:col-span-2">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-[var(--text-tertiary)] pointer-events-none" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Tìm theo tên hoặc mã khách hàng..."
              className="w-full h-8 pl-8 pr-3 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] rounded-md focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
          </div>
          <select
            value={source}
            onChange={(event) => setSource(event.target.value)}
            className="h-8 px-2.5 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] rounded-md focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
          >
            <option value="">Tất cả nguồn</option>
            {Object.entries(SOURCE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={fromDate}
              onChange={(event) => setFromDate(event.target.value)}
              className="h-8 w-full px-2 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] rounded-md focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              aria-label="Từ ngày"
            />
            <ArrowRight className="w-3 h-3 text-[var(--text-tertiary)] shrink-0" />
            <input
              type="date"
              value={toDate}
              onChange={(event) => setToDate(event.target.value)}
              className="h-8 w-full px-2 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] rounded-md focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              aria-label="Đến ngày"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <select
              value={stageFilter}
              onChange={(event) => setStageFilter(event.target.value as '' | CanonicalCustomerStage)}
              className="h-8 w-full px-2.5 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] rounded-md focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            >
              <option value="">Tất cả giai đoạn</option>
              {CANONICAL_STAGE_LIST.map((stage) => (
                <option key={stage.value} value={stage.value}>
                  {stage.label}
                </option>
              ))}
            </select>
            {(search || source || fromDate || toDate || stageFilter) && (
              <Button type="button" variant="ghost" size="sm" onClick={resetFilters} aria-label="Xóa bộ lọc">
                <X className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        </div>

        {/* Summary */}
        <div className="flex flex-wrap items-center gap-2 mt-3 text-[11px] text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-1">
            <Users className="w-3.5 h-3.5" />
            {totalEligible} khách trong 6 giai đoạn
          </span>
          {unmapped > 0 && (
            <span className="inline-flex items-center gap-1 text-amber-700">
              <AlertCircle className="w-3.5 h-3.5" />
              {unmapped} khách có giai đoạn chưa nhận diện
            </span>
          )}
          {needsReview > 0 && (
            <span className="inline-flex items-center gap-1 text-amber-700">
              <ShieldAlert className="w-3.5 h-3.5" />
              {needsReview} khách cần rà soát giai đoạn cũ
            </span>
          )}
          {data?.truncated && (
            <span className="text-[var(--text-tertiary)]">
              Đang hiển thị {data.customers.length}/{data.total_customers} khách hàng.
            </span>
          )}
        </div>
      </Card>

      {moveMessage && (
        <div
          className={`rounded-lg border p-3 text-xs ${
            moveMessage.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}
        >
          {moveMessage.text}
        </div>
      )}

      {!data || data.total_customers === 0 ? (
        <Card className="p-8">
          <EmptyState
            type="empty"
            title="Chưa có khách hàng trong phễu"
            description="Khách hàng mới sẽ xuất hiện ở giai đoạn Nhận biết. Bạn có thể thêm khách hàng từ danh sách CRM."
            action={{ label: 'Quay lại danh sách khách hàng', href: '/customers' }}
          />
        </Card>
      ) : view === 'kanban' ? (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {visibleStages.map((stage) => {
            const count = stageCounts.get(stage.value);
            const customers = customersByStage.get(stage.value) || [];
            return (
              <div
                key={stage.value}
                className={`w-[290px] shrink-0 rounded-xl border ${STAGE_ACCENTS[stage.value]} flex flex-col`}
              >
                <div className="p-3 border-b border-[var(--border-subtle)]/70">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-xs font-semibold text-[var(--text-primary)]">{stage.label}</div>
                      <div className="text-[10px] text-[var(--text-secondary)] mt-0.5">
                        {stage.description}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-semibold leading-none text-[var(--text-primary)]">
                        {count?.count || 0}
                      </div>
                      <div className="text-[10px] text-[var(--text-secondary)]">
                        {count?.percentage || 0}%
                      </div>
                    </div>
                  </div>
                  {count?.needsReview ? (
                    <div className="mt-2 text-[10px] text-amber-700 inline-flex items-center gap-1">
                      <ShieldAlert className="w-3 h-3" />
                      {count.needsReview} cần rà soát dữ liệu cũ
                    </div>
                  ) : null}
                </div>

                <div className="p-2 space-y-2 min-h-[120px] max-h-[65vh] overflow-y-auto">
                  {customers.length === 0 ? (
                    <div className="text-[11px] text-[var(--text-tertiary)] text-center py-6">
                      Chưa có khách hàng
                    </div>
                  ) : (
                    customers.map((customer) => {
                      const currentStage = customerStage(customer);
                      if (!currentStage) return null;
                      return (
                        <div
                          key={customer.id}
                          className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-primary)] p-2.5 shadow-xs"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <Link
                              href={`/customers/${customer.id}/dossier`}
                              className="text-xs font-semibold text-[var(--text-primary)] hover:text-[var(--accent)] line-clamp-2"
                            >
                              {customer.name}
                            </Link>
                            <StatusBadge status={currentStage} className="shrink-0" />
                          </div>
                          <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-[var(--text-secondary)]">
                            <span className="font-mono">{customer.customer_code}</span>
                            <span>{SOURCE_LABELS[customer.source] || customer.source}</span>
                          </div>
                          {customer.phone && (
                            <div className="mt-1 text-[10px] font-mono text-[var(--text-secondary)]">
                              {customer.phone}
                            </div>
                          )}
                          <div className="mt-1 text-[10px] text-[var(--text-tertiary)]">
                            Cập nhật: {formatDate(customer.updated_at)}
                          </div>

                          <div className="mt-2 flex items-center gap-1.5">
                            <div className="relative flex-1">
                              <select
                                value={currentStage}
                                onChange={(event) =>
                                  openMove(customer, event.target.value as CanonicalCustomerStage)
                                }
                                className="w-full h-7 pl-2 pr-6 text-[10px] bg-[var(--surface-secondary)] text-[var(--text-primary)] border border-[var(--border-subtle)] rounded-md appearance-none focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                                aria-label={`Chuyển giai đoạn cho ${customer.name}`}
                              >
                                {CANONICAL_STAGE_LIST.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                              <ChevronDown className="w-3 h-3 absolute right-1.5 top-2 text-[var(--text-tertiary)] pointer-events-none" />
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Card className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Phân bố theo giai đoạn</h3>
              <p className="text-[11px] text-[var(--text-secondary)]">
                Tổng {totalEligible} khách hàng thuộc 6 giai đoạn. Phần trăm là tỉ trọng phân bố.
              </p>
            </div>
            <BarChart3 className="w-5 h-5 text-[var(--text-tertiary)]" />
          </div>

          <div className="space-y-3">
            {CANONICAL_STAGE_LIST.map((stage) => {
              const count = stageCounts.get(stage.value);
              return (
                <div key={stage.value}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <div className="flex items-center gap-2">
                      <span className={`w-2.5 h-2.5 rounded-full ${FUNNEL_COLORS[stage.value]}`} />
                      <span className="font-medium text-[var(--text-primary)]">{stage.label}</span>
                      <span className="text-[10px] text-[var(--text-tertiary)]">{stage.description}</span>
                    </div>
                    <div className="font-mono text-[var(--text-secondary)]">
                      {count?.count || 0} · {count?.percentage || 0}%
                    </div>
                  </div>
                  <div className="h-2.5 rounded-full bg-[var(--surface-secondary)] overflow-hidden">
                    <div
                      className={`h-full rounded-full ${FUNNEL_COLORS[stage.value]} transition-all duration-500`}
                      style={{ width: `${Math.max(count?.percentage || 0, count?.count ? 2 : 0)}%` }}
                    />
                  </div>
                  {count?.needsReview ? (
                    <div className="mt-1 text-[10px] text-amber-700">
                      {count.needsReview} khách còn dùng mã giai đoạn cũ, cần rà soát.
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-4 border-t border-[var(--border-subtle)]">
            <div className="rounded-lg border border-[var(--border-subtle)] p-3">
              <div className="text-[10px] text-[var(--text-tertiary)]">Tổng khách trong 6 giai đoạn</div>
              <div className="text-xl font-semibold text-[var(--text-primary)]">{totalEligible}</div>
            </div>
            <div className="rounded-lg border border-[var(--border-subtle)] p-3">
              <div className="text-[10px] text-[var(--text-tertiary)]">Chưa nhận diện giai đoạn</div>
              <div className="text-xl font-semibold text-amber-700">{unmapped}</div>
            </div>
            <div className="rounded-lg border border-[var(--border-subtle)] p-3">
              <div className="text-[10px] text-[var(--text-tertiary)]">Cần rà soát dữ liệu cũ</div>
              <div className="text-xl font-semibold text-amber-700">{needsReview}</div>
            </div>
          </div>
        </Card>
      )}

      {/* Move confirmation modal (inline overlay) */}
      {pendingMove && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-[var(--surface-primary)] border border-[var(--border-subtle)] shadow-xl p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                  Chuyển giai đoạn khách hàng
                </h3>
                <p className="text-xs text-[var(--text-secondary)] mt-1">
                  {pendingMove.customer.name} ·{' '}
                  {pendingCurrentStage
                    ? CUSTOMER_STAGE_LABELS[pendingCurrentStage]
                    : 'Chưa rõ giai đoạn'}{' '}
                  → {CUSTOMER_STAGE_LABELS[pendingMove.target]}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPendingMove(null)}
                className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                aria-label="Đóng"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
                  Ghi chú lý do {pendingMove.target === 'contract_signed' ? '(bắt buộc, tối thiểu 10 ký tự)' : '(tùy chọn)'}
                </label>
                <textarea
                  value={moveNote}
                  onChange={(event) => setMoveNote(event.target.value)}
                  rows={3}
                  placeholder="VD: Khách xác nhận phương án và đồng ý tiến hành..."
                  className="w-full p-2.5 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] rounded-md focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
                  Bằng chứng / nguồn (tùy chọn)
                </label>
                <input
                  value={moveEvidence}
                  onChange={(event) => setMoveEvidence(event.target.value)}
                  placeholder="VD: Tin nhắn Zalo ngày 28/10 xác nhận đã ký..."
                  className="w-full h-8 px-2.5 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] rounded-md focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                />
              </div>

              {pendingMove.target === 'contract_signed' && (
                <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                  <input
                    type="checkbox"
                    checked={confirmContract}
                    onChange={(event) => setConfirmContract(event.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    Tôi đã kiểm tra hợp đồng thực tế và xác nhận khách hàng đã ký với doanh nghiệp.
                    Chỉ BOSS_ADMIN được thực hiện thao tác này.
                  </span>
                </label>
              )}

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border-subtle)]">
                <Button type="button" variant="outline" size="sm" onClick={() => setPendingMove(null)}>
                  Hủy
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => void submitMove()}
                  isLoading={moving}
                  disabled={moving || (pendingMove.target === 'contract_signed' && (!confirmContract || moveNote.trim().length < 10))}
                >
                  Xác nhận chuyển
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
