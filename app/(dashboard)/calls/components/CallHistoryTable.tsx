'use client';

import React, { useState, useTransition } from 'react';
import Link from 'next/link';
import type { CallHistoryItemDTO, CallHistoryFilters } from '../../../../shared/contracts/voice';
import { getAuthorizedSignedUrlAction } from '../../../actions/sensitive';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TablePagination,
} from '../../../../components/ui/data-table';
import { Card } from '../../../../components/ui/card';
import { Button } from '../../../../components/ui/button';
import { StatusBadge } from '../../../../components/ui/status-badge';
import { EmptyState } from '../../../../components/ui/empty-state';
import {
  PhoneIncoming,
  PhoneOutgoing,
  Play,
  FileText,
} from 'lucide-react';

interface Props {
  initialItems: CallHistoryItemDTO[];
  total: number;
  currentPage: number;
  pageSize: number;
  isBossAdmin: boolean;
  onPageChange?: (page: number) => void;
  onFilterChange?: (filters: CallHistoryFilters) => void;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function RecordingButton({ callId }: { callId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleGetRecording = () => {
    startTransition(async () => {
      setError(null);
      const result = await getAuthorizedSignedUrlAction({
        category: 'RECORDING',
        resourceId: callId,
      });

      if (result.success && result.data) {
        setUrl(result.data.signedUrl);
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
        className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline font-medium"
      >
        <Play className="w-3 h-3 fill-current" />
        <span>Nghe lại</span>
      </a>
    );
  }

  return (
    <div>
      <Button
        variant="ghost"
        size="xs"
        onClick={handleGetRecording}
        isLoading={isPending}
        leftIcon={<Play className="w-3 h-3" />}
      >
        Nghe ghi âm
      </Button>
      {error && <div className="text-[10px] text-[var(--danger)] mt-0.5">{error}</div>}
    </div>
  );
}

export default function CallHistoryTable({
  initialItems,
  total,
  currentPage,
  pageSize,
  isBossAdmin,
  onPageChange,
}: Props) {
  const totalPages = Math.ceil(total / pageSize) || 1;

  if (initialItems.length === 0) {
    return (
      <Card className="p-8">
        <EmptyState
          type="empty"
          title="Chưa có cuộc gọi nào"
          description="Lịch sử các cuộc gọi qua tổng đài và Zalo sẽ xuất hiện tại đây."
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-[140px]">Thời gian</TableHead>
            <TableHead className="min-w-[180px]">Khách hàng</TableHead>
            <TableHead className="w-[110px]">Hướng gọi</TableHead>
            <TableHead className="w-[110px]">Loại cuộc gọi</TableHead>
            <TableHead className="min-w-[120px]">Trạng thái</TableHead>
            <TableHead className="w-[90px]" alignRight>
              Thời lượng
            </TableHead>
            {isBossAdmin && <TableHead className="w-[120px]">Ghi âm</TableHead>}
            {isBossAdmin && <TableHead className="w-[110px]">Transcript</TableHead>}
          </TableRow>
        </TableHeader>

        <TableBody>
          {initialItems.map((call) => (
            <TableRow key={call.id}>
              {/* Timestamp */}
              <TableCell>
                <span className="font-mono text-xs text-[var(--text-secondary)]">
                  {formatTime(call.startedAt)}
                </span>
              </TableCell>

              {/* Customer */}
              <TableCell>
                <div className="flex flex-col">
                  <Link
                    href={`/customers/${call.customerId || ''}`}
                    className="font-medium text-[var(--text-primary)] hover:text-[var(--accent)] transition-colors truncate"
                  >
                    {call.customerName || 'Khách vãng lai'}
                  </Link>
                  {call.customerCode && (
                    <span className="text-[11px] font-mono text-[var(--text-tertiary)]">
                      {call.customerCode}
                    </span>
                  )}
                </div>
              </TableCell>

              {/* Direction */}
              <TableCell>
                <span
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                    call.direction === 'INBOUND'
                      ? 'bg-blue-50 text-blue-700 border-blue-200'
                      : 'bg-purple-50 text-purple-700 border-purple-200'
                  }`}
                >
                  {call.direction === 'INBOUND' ? (
                    <>
                      <PhoneIncoming className="w-3 h-3" />
                      <span>Gọi vào</span>
                    </>
                  ) : (
                    <>
                      <PhoneOutgoing className="w-3 h-3" />
                      <span>Gọi ra</span>
                    </>
                  )}
                </span>
              </TableCell>

              {/* Call Type */}
              <TableCell>
                <span className="text-xs text-[var(--text-secondary)]">
                  {call.agentType === 'AI' ? 'AI gọi ra' : 'Sale gọi khách'}
                </span>
              </TableCell>

              {/* Status */}
              <TableCell>
                <StatusBadge status={call.status} size="xs" />
              </TableCell>

              {/* Duration */}
              <TableCell alignRight>
                <span className="font-mono text-xs text-[var(--text-primary)]">
                  {formatDuration(call.durationSeconds)}
                </span>
              </TableCell>

              {/* Recording (Boss only) */}
              {isBossAdmin && (
                <TableCell>
                  {call.hasRecording ? (
                    <RecordingButton callId={call.id} />
                  ) : (
                    <span className="text-[var(--text-tertiary)] text-xs">—</span>
                  )}
                </TableCell>
              )}

              {/* Transcript Status (Boss only) */}
              {isBossAdmin && (
                <TableCell>
                  {call.transcriptStatus === 'COMPLETED' ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 font-medium">
                      <FileText className="w-3 h-3" />
                      <span>Có bản ghi</span>
                    </span>
                  ) : call.transcriptStatus ? (
                    <StatusBadge status={call.transcriptStatus} size="xs" />
                  ) : (
                    <span className="text-[var(--text-tertiary)] text-xs">Chưa có</span>
                  )}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Pagination */}
      <TablePagination
        currentPage={currentPage}
        totalPages={totalPages}
        totalItems={total}
        pageSize={pageSize}
        onPageChange={onPageChange}
      />
    </Card>
  );
}
