'use client';

import React from 'react';
import type { CallAttemptDTO } from '../../../../shared/contracts/voice';

interface Props {
  attempts: CallAttemptDTO[];
}

const RESULT_LABELS: Record<string, { label: string; color: string; icon: string }> = {
  PENDING: { label: 'Chờ gọi', color: 'text-yellow-400 border-yellow-700/50 bg-yellow-950/30', icon: '⏳' },
  ANSWERED: { label: 'Nghe máy', color: 'text-emerald-400 border-emerald-700/50 bg-emerald-950/30', icon: '✅' },
  NO_ANSWER: { label: 'Không nghe', color: 'text-red-400 border-red-800/50 bg-red-950/30', icon: '📵' },
  BUSY: { label: 'Máy bận', color: 'text-orange-400 border-orange-800/50 bg-orange-950/30', icon: '📵' },
  FAILED: { label: 'Lỗi gọi', color: 'text-red-500 border-red-800/50 bg-red-950/40', icon: '✗' },
  CANCELLED: { label: 'Đã hủy', color: 'text-slate-500 border-slate-700/50 bg-slate-800/30', icon: '–' },
};

function formatTime(iso: string | null): string {
  if (!iso) return '–';
  return new Date(iso).toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const ATTEMPT_LABELS: Record<number, { title: string; when: string }> = {
  1: { title: 'Lần 1', when: 'Gọi ngay' },
  2: { title: 'Lần 2', when: 'Sau 2–3 giờ' },
  3: { title: 'Lần 3', when: 'Ngày hôm sau (09:00)' },
};

/**
 * Timeline hiển thị 3 lần thử gọi trong một chu kỳ liên hệ.
 * Không hiển thị số điện thoại.
 */
export default function CallAttemptTimeline({ attempts }: Props) {
  if (attempts.length === 0) {
    return (
      <div className="text-sm text-slate-500 italic py-2">
        Chưa có chu kỳ gọi nào.
      </div>
    );
  }

  // Sắp xếp theo attempt_no
  const sorted = [...attempts].sort((a, b) => a.attemptNo - b.attemptNo);

  return (
    <div className="space-y-2">
      <div className="text-xs text-slate-500 font-medium uppercase tracking-wider mb-3">
        Chu kỳ liên hệ — quy tắc 3 lần
      </div>

      <div className="flex flex-col gap-2">
        {sorted.map((attempt, idx) => {
          const info = RESULT_LABELS[attempt.result] || RESULT_LABELS['PENDING'];
          const label = ATTEMPT_LABELS[attempt.attemptNo];

          return (
            <div key={attempt.id} className="flex items-start gap-3">
              {/* Connector line */}
              <div className="flex flex-col items-center">
                <div
                  className={`
                    w-8 h-8 rounded-full border flex items-center justify-center text-sm font-bold flex-shrink-0
                    ${info.color}
                  `}
                >
                  {attempt.attemptNo}
                </div>
                {idx < sorted.length - 1 && (
                  <div className="w-px h-4 bg-slate-700 mt-1" />
                )}
              </div>

              {/* Content */}
              <div className={`flex-1 p-3 rounded-lg border text-sm ${info.color}`}>
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <span>{info.icon}</span>
                    <span className="font-semibold">{label?.title} — {info.label}</span>
                  </div>
                  <span className="text-xs opacity-70">{label?.when}</span>
                </div>

                <div className="mt-1 text-xs opacity-80 space-y-0.5">
                  {attempt.scheduledAt && (
                    <div>
                      <span className="opacity-60">Lên lịch: </span>
                      {formatTime(attempt.scheduledAt)}
                    </div>
                  )}
                  {attempt.calledAt && (
                    <div>
                      <span className="opacity-60">Gọi lúc: </span>
                      {formatTime(attempt.calledAt)}
                    </div>
                  )}
                  {attempt.callId && (
                    <div className="font-mono">
                      <span className="opacity-60">Call ID: </span>
                      <span className="opacity-70">{attempt.callId}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Kết luận chu kỳ */}
      {sorted.length === 3 && sorted.every((a) => a.result !== 'PENDING') && (
        <div className="mt-3 p-3 bg-slate-800/60 border border-slate-700/50 rounded-lg text-xs text-slate-400">
          {sorted.some((a) => a.result === 'ANSWERED') ? (
            <span className="text-emerald-400">✅ Khách đã nghe máy trong chu kỳ này.</span>
          ) : (
            <span className="text-red-400">
              📵 Đã gọi đủ 3 lần, khách không nghe máy.{' '}
              Trạng thái khách đã được cập nhật thành <strong>KHÔNG LIÊN LẠC ĐƯỢC</strong>.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
