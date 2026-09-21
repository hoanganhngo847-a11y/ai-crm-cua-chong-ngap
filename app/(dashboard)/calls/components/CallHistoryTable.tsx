'use client';

import React, { useState, useTransition } from 'react';
import type { CallHistoryItemDTO, CallHistoryFilters } from '../../../../shared/contracts/voice';
import { getAuthorizedSignedUrlAction } from '../../../actions/sensitive';

interface Props {
  initialItems: CallHistoryItemDTO[];
  total: number;
  currentPage: number;
  pageSize: number;
  isBossAdmin: boolean;
  onPageChange?: (page: number) => void;
  onFilterChange?: (filters: CallHistoryFilters) => void;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  INITIATED: { label: 'Đang khởi tạo', color: 'text-blue-400' },
  RINGING: { label: 'Đang đổ chuông', color: 'text-yellow-400' },
  CONNECTED: { label: 'Đang nói', color: 'text-emerald-400' },
  NO_ANSWER: { label: 'Không nghe', color: 'text-red-400' },
  BUSY: { label: 'Máy bận', color: 'text-orange-400' },
  FAILED: { label: 'Lỗi', color: 'text-red-500' },
  COMPLETED: { label: 'Hoàn thành', color: 'text-emerald-300' },
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '–';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function RecordingButton({ callId }: { callId: string }) {
  const [isPending, startTransition] = useTransition();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleGetRecording = () => {
    startTransition(async () => {
      setError(null);
      const result = await getAuthorizedSignedUrlAction({
        category: 'RECORDING',
        resourceId: callId,
      });

      if (result.success && result.data) {
        setUrl(result.data.signedUrl);
        // Mở trong tab mới
        window.open(result.data.signedUrl, '_blank', 'noopener,noreferrer');
      } else {
        setError(result.error || result.message || 'Không thể tải ghi âm.');
      }
    });
  };

  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-blue-400 hover:underline"
      >
        🎵 Nghe lại
      </a>
    );
  }

  return (
    <div>
      <button
        onClick={handleGetRecording}
        disabled={isPending}
        className="text-xs text-slate-400 hover:text-blue-400 transition"
      >
        {isPending ? '⏳' : '🎵 Xem ghi âm'}
      </button>
      {error && <div className="text-xs text-red-400 mt-0.5">{error}</div>}
    </div>
  );
}

/**
 * Bảng lịch sử cuộc gọi — phân tầng theo role.
 *
 * BOSS_ADMIN: thấy cột Ghi âm + Transcript status.
 * SALE: không thấy những cột này.
 */
export default function CallHistoryTable({
  initialItems,
  total,
  currentPage,
  pageSize,
  isBossAdmin,
  onPageChange,
}: Props) {
  const totalPages = Math.ceil(total / pageSize);

  if (initialItems.length === 0) {
    return (
      <div className="text-center py-12 text-slate-500">
        <div className="text-4xl mb-3">📞</div>
        <p>Chưa có cuộc gọi nào.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Bảng */}
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-400 text-xs uppercase tracking-wider bg-slate-900/60">
              <th className="px-4 py-3">Thời gian</th>
              <th className="px-4 py-3">Khách hàng</th>
              <th className="px-4 py-3">Hướng</th>
              <th className="px-4 py-3">Loại</th>
              <th className="px-4 py-3">Trạng thái</th>
              <th className="px-4 py-3">Thời lượng</th>
              {isBossAdmin && <th className="px-4 py-3">Ghi âm</th>}
              {isBossAdmin && <th className="px-4 py-3">Transcript</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {initialItems.map((call) => {
              const status = STATUS_LABELS[call.status] || { label: call.status, color: 'text-slate-400' };

              return (
                <tr key={call.id} className="hover:bg-slate-900/40 transition">
                  <td className="px-4 py-3 text-slate-300 text-xs whitespace-nowrap">
                    {formatTime(call.startedAt)}
                  </td>

                  <td className="px-4 py-3">
                    <div className="font-medium text-white">{call.customerName}</div>
                    <div className="text-xs text-slate-500 font-mono">{call.customerCode}</div>
                  </td>

                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
                        call.direction === 'INBOUND'
                          ? 'bg-blue-900/40 text-blue-400'
                          : 'bg-purple-900/40 text-purple-400'
                      }`}
                    >
                      {call.direction === 'INBOUND' ? '↙ Vào' : '↗ Ra'}
                    </span>
                  </td>

                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
                        call.agentType === 'AI'
                          ? 'bg-indigo-900/40 text-indigo-400'
                          : 'bg-slate-800 text-slate-300'
                      }`}
                    >
                      {call.agentType === 'AI' ? '🤖 AI' : '👤 Sale'}
                    </span>
                  </td>

                  <td className={`px-4 py-3 text-xs font-medium ${status.color}`}>
                    {status.label}
                  </td>

                  <td className="px-4 py-3 text-slate-400 text-xs tabular-nums">
                    {formatDuration(call.durationSeconds)}
                  </td>

                  {isBossAdmin && (
                    <td className="px-4 py-3">
                      {call.hasRecording ? (
                        <RecordingButton callId={call.id} />
                      ) : (
                        <span className="text-xs text-slate-600">–</span>
                      )}
                    </td>
                  )}

                  {isBossAdmin && (
                    <td className="px-4 py-3 text-xs">
                      {call.transcriptStatus === 'COMPLETED' ? (
                        <a
                          href={`/calls/${call.customerId}#transcript-${call.id}`}
                          className="text-blue-400 hover:underline"
                        >
                          Xem
                        </a>
                      ) : call.transcriptStatus === 'PENDING' ? (
                        <span className="text-yellow-600">Đang xử lý</span>
                      ) : call.transcriptStatus === 'PROCESSING' ? (
                        <span className="text-blue-600 animate-pulse">Processing...</span>
                      ) : call.transcriptStatus === 'FAILED' ? (
                        <span className="text-red-600">Lỗi</span>
                      ) : (
                        <span className="text-slate-600">–</span>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Phân trang */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-slate-400">
          <span>
            Hiển thị {(currentPage - 1) * pageSize + 1}–
            {Math.min(currentPage * pageSize, total)} / {total} cuộc gọi
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => onPageChange?.(currentPage - 1)}
              disabled={currentPage <= 1}
              className="px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              ←
            </button>
            <span className="px-3 py-1">
              {currentPage} / {totalPages}
            </span>
            <button
              onClick={() => onPageChange?.(currentPage + 1)}
              disabled={currentPage >= totalPages}
              className="px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
