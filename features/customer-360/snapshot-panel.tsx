import React from 'react';
import type { DossierSnapshot } from './contracts';
import { actionLabels } from './contracts';
import { Sparkles, CheckCircle2, ArrowRight } from 'lucide-react';
import { Badge } from '../../components/ui/badge';

export function SnapshotPanel({ snapshot }: { snapshot: DossierSnapshot | null }) {
  if (!snapshot) {
    return (
      <div className="py-8 text-center text-xs text-[var(--text-tertiary)] bg-[var(--surface-secondary)] rounded-xl border border-dashed border-[var(--border-subtle)]">
        Chưa có phân tích AI. Dữ kiện chưa xác định sẽ được để trống cho đến khi có cuộc gọi hoặc tin nhắn mới.
      </div>
    );
  }

  const sections: [string, DossierSnapshot['intent'], string][] = [
    ['Nhu cầu cốt lõi', snapshot.intent, 'text-blue-700 bg-blue-50 border-blue-200'],
    ['Điểm quan tâm', snapshot.interests, 'text-indigo-700 bg-indigo-50 border-indigo-200'],
    ['Vấn đề & Nỗi đau (Pain points)', snapshot.painPoints, 'text-amber-700 bg-amber-50 border-amber-200'],
    ['Rào cản / Băn khoăn (Objections)', snapshot.objections, 'text-rose-700 bg-rose-50 border-rose-200'],
    ['Tín hiệu tích cực', snapshot.positiveSignals, 'text-emerald-700 bg-emerald-50 border-emerald-200'],
    ['Rủi ro tiềm ẩn (Risk flags)', snapshot.riskFlags, 'text-red-700 bg-red-50 border-red-200'],
    ['Cam kết của khách', snapshot.customerCommitments, 'text-slate-700 bg-slate-50 border-slate-200'],
    ['Cam kết của Sale', snapshot.salesCommitments, 'text-teal-700 bg-teal-50 border-teal-200'],
  ];

  const confidencePercent = Math.round(snapshot.confidence * 100);

  return (
    <div className="space-y-5">
      {/* Current Situation Box */}
      <div className="p-4 rounded-xl border border-[var(--ai-border)] bg-[var(--ai-surface)]/40">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--ai)] uppercase tracking-wider font-mono">
            <Sparkles className="w-3.5 h-3.5" />
            <span>Tình trạng hiện tại</span>
          </div>
          <Badge variant="ai" size="xs">
            Độ tin cậy: {confidencePercent}%
          </Badge>
        </div>
        <p className="text-sm font-medium text-[var(--text-primary)] leading-relaxed">
          {snapshot.currentSituation?.text || 'Chưa xác định'}
        </p>
        {snapshot.summary?.text && (
          <p className="mt-2 text-xs text-[var(--text-secondary)] leading-relaxed border-t border-[var(--ai-border)]/50 pt-2">
            {snapshot.summary.text}
          </p>
        )}
      </div>

      {/* Structured Multi-Column Insights Grid */}
      <div className="grid gap-3.5 sm:grid-cols-2">
        {sections.map(([title, values, _colorClass]) => (
          <div
            key={title}
            className="p-3.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-primary)] shadow-xs flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-xs font-semibold text-[var(--text-primary)]">
                  {title}
                </span>
                <span className="text-[10px] font-mono text-[var(--text-tertiary)]">
                  ({values.length})
                </span>
              </div>

              {values.length > 0 ? (
                <ul className="space-y-1.5 text-xs text-[var(--text-secondary)]">
                  {values.map((v, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--text-tertiary)] mt-1.5 shrink-0" />
                      <span className="leading-relaxed">{v.text}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-[var(--text-tertiary)] italic">
                  Chưa ghi nhận bằng chứng
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Recommended Next Actions */}
      <div className="p-4 rounded-xl border border-[var(--accent-border)] bg-[var(--accent-soft)]/50">
        <div className="flex items-center gap-2 mb-2">
          <ArrowRight className="w-4 h-4 text-[var(--accent)]" />
          <h4 className="text-xs font-semibold text-[var(--accent)] uppercase tracking-wider font-mono">
            Hành động tiếp theo được đề xuất
          </h4>
        </div>

        {snapshot.nextActions.length > 0 ? (
          <ul className="space-y-1.5 text-xs text-[var(--text-primary)] font-medium">
            {snapshot.nextActions.map((a, i) => (
              <li key={i} className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                <span>{actionLabels[a.action] || a.action}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-[var(--text-secondary)] italic">
            Chưa có đề xuất tiếp theo
          </p>
        )}
        <p className="mt-2.5 text-[11px] text-[var(--text-tertiary)]">
          Lưu ý: Mọi đề xuất AI cần chuyên viên Sale phụ trách xem xét và xác nhận trước khi thực hiện.
        </p>
      </div>

      {/* Evidence & Confidence Footer */}
      <div className="flex items-center justify-between text-xs text-[var(--text-tertiary)] pt-1 border-t border-[var(--border-subtle)]">
        <span>
          Được trích xuất từ {snapshot.evidence.length} bằng chứng hội thoại/ghi âm thực tế.
        </span>
        <a
          href="#timeline"
          className="text-[var(--accent)] hover:underline font-medium"
        >
          Xem bằng chứng chi tiết ↓
        </a>
      </div>
    </div>
  );
}
