'use client';

import { useOptimistic, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Plus } from 'lucide-react';
import { setCustomerOutreachChannel } from '../../app/actions/customer-dossier';
import {
  canToggleOutreach,
  formatOutreachDate,
  OUTREACH_CHANNEL_LABELS,
  type OutreachChannel,
  type OutreachSource,
  type OutreachState,
} from './outreach';

export interface Customer360OutreachCellProps {
  customerId: string;
  channel: OutreachChannel;
  name: string | null;
  at: string | null;
  source: OutreachSource;
  variant?: 'compact' | 'detail';
}

const brandClasses: Record<OutreachChannel, string> = {
  FACEBOOK: 'border-blue-200 bg-blue-50 text-blue-700',
  ZALO: 'border-cyan-200 bg-cyan-50 text-cyan-700',
};

const brandDots: Record<OutreachChannel, string> = {
  FACEBOOK: 'bg-blue-500',
  ZALO: 'bg-cyan-500',
};

const sourceLabels: Record<Exclude<OutreachSource, null>, string> = {
  AUTO: 'Tự động',
  MANUAL: 'Thủ công',
};

/**
 * One channel of the Customer 360 list/dossier. The cell always shows the name
 * the customer uses on that channel, so a sale can tell the Facebook person and
 * the Zalo person apart even when the phone number was collected on Facebook.
 */
export function Customer360OutreachCell({
  customerId,
  channel,
  name,
  at,
  source,
  variant = 'compact',
}: Customer360OutreachCellProps) {
  const router = useRouter();
  const [error, setError] = useState(false);
  const [isPending, startTransition] = useTransition();

  const label = OUTREACH_CHANNEL_LABELS[channel];
  const serverState: OutreachState = at
    ? { reached: true, at, source: source ?? 'MANUAL' }
    : { reached: false, at: null, source: null };
  // Optimistic feedback during the server round-trip; React drops it when the
  // transition finishes, and refreshed server data stays authoritative.
  const [state, applyOptimistic] = useOptimistic(
    serverState,
    (_current: OutreachState, next: { at: string | null; source: OutreachSource }) =>
      next.at
        ? { reached: true, at: next.at, source: next.source ?? 'MANUAL' }
        : { reached: false, at: null, source: null }
  );
  const toggleable = canToggleOutreach(state);
  const date = formatOutreachDate(state.at);
  const sourceLabel = state.source ? sourceLabels[state.source] : null;

  const title = !state.reached
    ? `Bấm để đánh dấu đã tiếp cận qua ${label}`
    : state.source === 'AUTO'
      ? `Tự động ghi nhận từ tin nhắn/cuộc gọi ${label}. Không thể bỏ đánh dấu.`
      : `Đã đánh dấu thủ công. Bấm để bỏ đánh dấu.`;

  function toggle() {
    if (!toggleable || isPending) return;
    setError(false);
    const nextContacted = !state.reached;
    startTransition(async () => {
      applyOptimistic({
        at: nextContacted ? new Date().toISOString() : null,
        source: 'MANUAL',
      });
      try {
        const result = await setCustomerOutreachChannel({
          customerId,
          channel,
          contacted: nextContacted,
        });
        if (!result.ok) {
          setError(true);
          return;
        }
        router.refresh();
      } catch {
        setError(true);
      }
    });
  }

  const statusButton = (
    <button
      type="button"
      onClick={toggle}
      disabled={!toggleable || isPending}
      aria-pressed={state.reached}
      aria-label={title}
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
        state.reached
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : 'border-[var(--border-subtle)] bg-[var(--surface-secondary)] text-[var(--text-tertiary)]'
      } ${toggleable && !isPending ? 'cursor-pointer hover:border-[var(--accent)]' : 'cursor-default'} ${
        isPending ? 'opacity-70' : ''
      }`}
    >
      {isPending ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : state.reached ? (
        <Check className="h-3 w-3" />
      ) : (
        <Plus className="h-3 w-3" />
      )}
      <span>{state.reached ? 'Đã tiếp cận' : 'Chưa tiếp cận'}</span>
    </button>
  );

  if (variant === 'detail') {
    return (
      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-mono font-semibold uppercase tracking-wide ${brandClasses[channel]}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${brandDots[channel]}`} />
            {label}
          </span>
          {statusButton}
        </div>
        <div
          className="mt-1.5 truncate text-xs font-medium text-[var(--text-primary)]"
          title={name || undefined}
        >
          {name || <span className="italic text-[var(--text-tertiary)]">Chưa có tên trên {label}</span>}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--text-tertiary)]">
          <span>{date ? `Tiếp cận: ${date}` : 'Chưa ghi nhận tiếp cận'}</span>
          {sourceLabel && (
            <>
              <span aria-hidden="true">·</span>
              <span title={state.source === 'AUTO' ? 'Ghi nhận từ tin nhắn/cuộc gọi của hệ thống' : 'Sale đánh dấu thủ công'}>
                {sourceLabel}
              </span>
            </>
          )}
        </div>
        {error && (
          <div role="alert" className="mt-1 text-[10px] text-[var(--danger)]">
            Không lưu được, thử lại.
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <div
        className="truncate text-[11px] font-medium text-[var(--text-primary)]"
        title={name || undefined}
      >
        {name || <span className="italic text-[var(--text-tertiary)]">Chưa có tên</span>}
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        {statusButton}
        {sourceLabel && (
          <span
            className="text-[9px] uppercase tracking-wide text-[var(--text-tertiary)]"
            title={state.source === 'AUTO' ? 'Ghi nhận từ tin nhắn/cuộc gọi của hệ thống' : 'Sale đánh dấu thủ công'}
          >
            {sourceLabel}
          </span>
        )}
      </div>
      {date && <div className="mt-0.5 text-[10px] text-[var(--text-tertiary)]">{date}</div>}
      {error && (
        <div role="alert" className="mt-0.5 text-[10px] text-[var(--danger)]">
          Lỗi, thử lại
        </div>
      )}
    </div>
  );
}
