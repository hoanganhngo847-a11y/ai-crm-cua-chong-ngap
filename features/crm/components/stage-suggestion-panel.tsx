'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { StatusBadge } from '../../../components/ui/status-badge';
import {
  CUSTOMER_STAGE_LABELS,
  type CustomerStageSuggestion,
} from '../types/customer.types';

interface StageSuggestionPanelProps {
  customerId: string;
  userRole?: string | null;
}

function formatDate(value: string | null): string {
  if (!value) return 'Không rõ thời điểm';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function stageLabel(stage: string | null | undefined): string {
  if (!stage) return 'Chưa xác định';
  return CUSTOMER_STAGE_LABELS[stage] || stage;
}

const VERIFICATION_LABELS: Record<CustomerStageSuggestion['verification_status'], string> = {
  PENDING: 'Chờ xác minh',
  ACCEPTED: 'Đã chấp nhận',
  REJECTED: 'Đã từ chối',
  NOT_REQUIRED: 'Không cần xác minh',
};

export default function StageSuggestionPanel({
  customerId,
  userRole,
}: StageSuggestionPanelProps) {
  const router = useRouter();
  const isBossAdmin = userRole === 'BOSS_ADMIN';
  const canVerify = userRole === 'BOSS_ADMIN' || userRole === 'SALE';

  const [suggestions, setSuggestions] = useState<CustomerStageSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    id: string;
    decision: 'ACCEPTED' | 'REJECTED';
    targetStage: string | null;
  } | null>(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [actionMessage, setActionMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/customers/${customerId}/stage-suggestions?limit=5`, {
        cache: 'no-store',
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'Không thể tải đề xuất giai đoạn.');
      }
      setSuggestions((json.data || []) as CustomerStageSuggestion[]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Đã có lỗi xảy ra.');
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => {
    let isMounted = true;
    const run = async () => {
      if (isMounted) await load();
    };
    void run();
    return () => {
      isMounted = false;
    };
  }, [load]);

  const openDecision = (
    suggestion: CustomerStageSuggestion,
    decision: 'ACCEPTED' | 'REJECTED'
  ) => {
    setActionMessage(null);
    setNote('');
    setPending({
      id: suggestion.id,
      decision,
      targetStage: suggestion.stage_suggestion,
    });
  };

  const submitDecision = async () => {
    if (!pending) return;
    if (
      pending.decision === 'ACCEPTED' &&
      pending.targetStage === 'contract_signed' &&
      note.trim().length < 10
    ) {
      setActionMessage({
        type: 'error',
        text: 'Để chấp nhận trạng thái Đã ký hợp đồng, cần ghi rõ bằng chứng hợp đồng đã ký (ít nhất 10 ký tự).',
      });
      return;
    }

    setSubmitting(true);
    setActionMessage(null);
    try {
      const res = await fetch(
        `/api/customers/${customerId}/stage-suggestions/${pending.id}/verify`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision: pending.decision,
            note: note.trim() || undefined,
          }),
        }
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'Không thể xác minh đề xuất.');
      }

      setActionMessage({
        type: 'success',
        text:
          pending.decision === 'ACCEPTED'
            ? 'Đã chấp nhận đề xuất và cập nhật giai đoạn chính thức.'
            : 'Đã từ chối đề xuất. Giai đoạn chính thức không thay đổi.',
      });
      setPending(null);
      setNote('');
      await load();
      router.refresh();
    } catch (err: unknown) {
      setActionMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Lỗi không xác định.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-indigo-600" />
            <span>Đề xuất giai đoạn từ AI</span>
            <Badge variant="ai" size="sm">
              Chỉ gợi ý
            </Badge>
          </CardTitle>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">
            AI không tự đổi giai đoạn. Nhân viên phải xác minh trước khi áp dụng.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => void load()}
          disabled={loading}
          leftIcon={<RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />}
        >
          Làm mới
        </Button>
      </CardHeader>

      <CardContent className="space-y-3">
        {loading && suggestions.length === 0 ? (
          <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)] py-4">
            <Loader2 className="w-4 h-4 animate-spin" />
            Đang tải đề xuất giai đoạn...
          </div>
        ) : error ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <div>{error}</div>
              <button
                type="button"
                onClick={() => void load()}
                className="mt-1 underline font-medium"
              >
                Thử lại
              </button>
            </div>
          </div>
        ) : suggestions.length === 0 ? (
          <p className="py-4 text-xs text-[var(--text-tertiary)]">
            Chưa có đề xuất nào. Hệ thống sẽ tạo đề xuất sau khi phân tích hội thoại, cuộc gọi
            hoặc ghi chú mới.
          </p>
        ) : (
          suggestions.map((suggestion) => {
            const isExpanded = expandedId === suggestion.id;
            const isPending = suggestion.verification_status === 'PENDING';
            const isContract = suggestion.stage_suggestion === 'contract_signed';
            const confidencePercent = Math.round((suggestion.confidence || 0) * 100);

            return (
              <div
                key={suggestion.id}
                className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-primary)] p-3"
              >
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] text-[var(--text-tertiary)]">Đề xuất:</span>
                      {suggestion.stage_suggestion ? (
                        <StatusBadge status={suggestion.stage_suggestion} size="xs" />
                      ) : (
                        <Badge variant="neutral" size="xs">
                          Không đủ căn cứ
                        </Badge>
                      )}
                      <span className="text-[11px] text-[var(--text-tertiary)]">Hiện tại:</span>
                      <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                        {stageLabel(suggestion.current_stage)}
                      </span>
                      <Badge
                        variant={isPending ? 'warning' : suggestion.verification_status === 'ACCEPTED' ? 'success' : 'neutral'}
                        size="xs"
                      >
                        {VERIFICATION_LABELS[suggestion.verification_status]}
                      </Badge>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap text-[11px] text-[var(--text-secondary)]">
                      <span>Độ tin cậy: {confidencePercent}%</span>
                      <span>•</span>
                      <span>{formatDate(suggestion.created_at)}</span>
                      {suggestion.classifier_version && (
                        <>
                          <span>•</span>
                          <span className="font-mono">{suggestion.classifier_version}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setExpandedId(isExpanded ? null : suggestion.id)}
                    className="inline-flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] shrink-0"
                  >
                    {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    {isExpanded ? 'Thu gọn' : 'Chi tiết'}
                  </button>
                </div>

                <p className="mt-2 text-xs text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">
                  {suggestion.summary || 'Chưa có tóm tắt.'}
                </p>

                {isExpanded && (
                  <div className="mt-3 space-y-3 pt-3 border-t border-[var(--border-subtle)]">
                    {suggestion.reason && (
                      <div>
                        <div className="text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">
                          Lý do
                        </div>
                        <p className="text-xs text-[var(--text-secondary)] mt-0.5 leading-relaxed">
                          {suggestion.reason}
                        </p>
                      </div>
                    )}

                    <div>
                      <div className="text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">
                        Bằng chứng
                      </div>
                      {suggestion.evidence_items.length === 0 ? (
                        <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                          {suggestion.evidence || 'Chưa có trích dẫn trực tiếp.'}
                        </p>
                      ) : (
                        <ul className="mt-1 space-y-1.5">
                          {suggestion.evidence_items.map((item, index) => (
                            <li
                              key={`${suggestion.id}-evidence-${index}`}
                              className="rounded-md bg-[var(--surface-secondary)] border border-[var(--border-subtle)] p-2 text-xs"
                            >
                              <p className="text-[var(--text-primary)] leading-relaxed">
                                &ldquo;{item.quote}&rdquo;
                              </p>
                              <div className="mt-1 flex items-center gap-2 flex-wrap text-[10px] text-[var(--text-tertiary)]">
                                <span className="font-mono">{item.source}</span>
                                <span>•</span>
                                <span>{item.speaker}</span>
                                <span>•</span>
                                <span>{formatDate(item.occurredAt)}</span>
                                {item.signal && (
                                  <>
                                    <span>•</span>
                                    <span className="font-mono">{item.signal}</span>
                                  </>
                                )}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    {suggestion.objections.length > 0 && (
                      <div>
                        <div className="text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">
                          Phản đối / rào cản
                        </div>
                        <ul className="mt-1 list-disc pl-4 space-y-0.5 text-xs text-[var(--text-secondary)]">
                          {suggestion.objections.map((objection, index) => (
                            <li key={`${suggestion.id}-objection-${index}`}>{objection}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {suggestion.next_action && (
                      <div>
                        <div className="text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">
                          Hành động tiếp theo
                        </div>
                        <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                          {suggestion.next_action}
                        </p>
                      </div>
                    )}

                    {isContract && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-[11px] text-amber-800 flex items-start gap-2">
                        <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        <span>
                          Đã ký hợp đồng là thay đổi rủi ro cao. Chỉ BOSS_ADMIN được chấp nhận và
                          phải ghi rõ bằng chứng hợp đồng thực tế.
                        </span>
                      </div>
                    )}

                    {suggestion.verification_note && (
                      <div className="text-[11px] text-[var(--text-secondary)]">
                        Ghi chú xác minh: {suggestion.verification_note}
                      </div>
                    )}
                  </div>
                )}

                {isPending && canVerify && (
                  <div className="mt-3 flex items-center gap-2 flex-wrap">
                    <Button
                      type="button"
                      variant="primary"
                      size="xs"
                      leftIcon={<CheckCircle2 className="w-3 h-3" />}
                      disabled={isContract && !isBossAdmin}
                      onClick={() => openDecision(suggestion, 'ACCEPTED')}
                      title={
                        isContract && !isBossAdmin
                          ? 'Chỉ BOSS_ADMIN được chấp nhận Đã ký hợp đồng'
                          : undefined
                      }
                    >
                      Chấp nhận
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      leftIcon={<XCircle className="w-3 h-3" />}
                      onClick={() => openDecision(suggestion, 'REJECTED')}
                    >
                      Từ chối
                    </Button>
                  </div>
                )}

                {pending?.id === suggestion.id && (
                  <div className="mt-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-3 space-y-2">
                    <div className="text-xs font-medium text-[var(--text-primary)]">
                      {pending.decision === 'ACCEPTED'
                        ? `Xác nhận chuyển sang ${stageLabel(pending.targetStage)}`
                        : 'Từ chối đề xuất này'}
                    </div>
                    <textarea
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      rows={2}
                      placeholder={
                        pending.decision === 'ACCEPTED'
                          ? 'Ghi chú xác minh (bắt buộc với Đã ký hợp đồng)...'
                          : 'Lý do từ chối (tùy chọn)...'
                      }
                      className="w-full p-2.5 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] rounded-md focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                    />
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => {
                          setPending(null);
                          setNote('');
                        }}
                      >
                        Hủy
                      </Button>
                      <Button
                        type="button"
                        variant="primary"
                        size="xs"
                        isLoading={submitting}
                        onClick={() => void submitDecision()}
                      >
                        Xác nhận
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}

        {actionMessage && (
          <div
            className={`rounded-lg border p-3 text-xs ${
              actionMessage.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : 'bg-rose-50 border-rose-200 text-rose-800'
            }`}
          >
            {actionMessage.text}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
