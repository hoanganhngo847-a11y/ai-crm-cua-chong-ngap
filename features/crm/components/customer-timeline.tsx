'use client';

import React, { useState } from 'react';
import type { CustomerTimelineEvent } from '../../inbox/types/inbox.types';
import {
  Phone,
  ClipboardList,
  RefreshCw,
  FileText,
  MessageSquare,
  Wrench,
  Bot,
} from 'lucide-react';

interface CustomerTimelineProps {
  events: CustomerTimelineEvent[];
  loading?: boolean;
  emptyMessage?: string;
}

export default function CustomerTimeline({
  events,
  loading = false,
  emptyMessage = 'Chưa có sự kiện nào được ghi nhận trong dòng thời gian.',
}: CustomerTimelineProps) {
  const [filterType, setFilterType] = useState<string>('ALL');

  if (loading) {
    return (
      <div className="p-8 text-center space-y-3">
        <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-xs text-[var(--text-tertiary)]">Đang nạp dòng thời gian khách hàng...</p>
      </div>
    );
  }

  const filteredEvents = events.filter((evt) => {
    if (filterType === 'ALL') return true;
    return evt.type === filterType;
  });

  const formatDateTime = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      return new Intl.DateTimeFormat('vi-VN', {
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }).format(d);
    } catch {
      return dateStr;
    }
  };

  const renderEventIcon = (type: CustomerTimelineEvent['type'], _channel?: string) => {
    switch (type) {
      case 'CALL':
        return (
          <div className="w-8 h-8 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-600 flex items-center justify-center shrink-0 shadow-xs">
            <Phone className="w-3.5 h-3.5" />
          </div>
        );
      case 'SURVEY':
        return (
          <div className="w-8 h-8 rounded-lg bg-amber-50 border border-amber-200 text-amber-600 flex items-center justify-center shrink-0 shadow-xs">
            <ClipboardList className="w-3.5 h-3.5" />
          </div>
        );
      case 'STAGE_CHANGE':
        return (
          <div className="w-8 h-8 rounded-lg bg-indigo-50 border border-indigo-200 text-indigo-600 flex items-center justify-center shrink-0 shadow-xs">
            <RefreshCw className="w-3.5 h-3.5" />
          </div>
        );
      case 'NOTE':
        return (
          <div className="w-8 h-8 rounded-lg bg-slate-50 border border-slate-200 text-slate-600 flex items-center justify-center shrink-0 shadow-xs">
            <FileText className="w-3.5 h-3.5" />
          </div>
        );
      case 'MESSAGE':
      default:
        return (
          <div className="w-8 h-8 rounded-lg bg-blue-50 border border-blue-200 text-blue-600 flex items-center justify-center shrink-0 shadow-xs">
            <MessageSquare className="w-3.5 h-3.5" />
          </div>
        );
    }
  };

  const renderActorBadge = (actorType: CustomerTimelineEvent['actor_type'], actorName?: string) => {
    switch (actorType) {
      case 'customer':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            {actorName || 'Khách hàng'}
          </span>
        );
      case 'sale':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
            {actorName || 'Chuyên viên Sale'}
          </span>
        );
      case 'ai':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-50 text-purple-700 border border-purple-200">
            <Bot className="w-3 h-3 text-purple-600" />
            {actorName || 'AI Trợ lý'}
          </span>
        );
      case 'technician':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
            <Wrench className="w-3 h-3 text-amber-600" />
            {actorName || 'Kỹ thuật viên'}
          </span>
        );
      case 'system':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[var(--surface-secondary)] text-[var(--text-secondary)] border border-[var(--border-subtle)]">
            Hệ thống
          </span>
        );
    }
  };

  return (
    <div className="space-y-4">
      {/* Bộ lọc loại sự kiện */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[var(--border-subtle)] select-none">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-[var(--text-primary)]">
            Dòng sự kiện ({filteredEvents.length})
          </span>
        </div>

        <div className="flex items-center gap-1 flex-wrap">
          {[
            { id: 'ALL', label: 'Tất cả' },
            { id: 'MESSAGE', label: 'Tin nhắn' },
            { id: 'CALL', label: 'Cuộc gọi' },
            { id: 'SURVEY', label: 'Khảo sát' },
            { id: 'STAGE_CHANGE', label: 'Trạng thái' },
            { id: 'NOTE', label: 'Ghi chú' },
          ].map((btn) => (
            <button
              key={btn.id}
              onClick={() => setFilterType(btn.id)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition cursor-pointer ${
                filterType === btn.id
                  ? 'bg-[var(--accent)] text-white shadow-xs'
                  : 'bg-[var(--surface-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] border border-[var(--border-subtle)]'
              }`}
            >
              {btn.label}
            </button>
          ))}
        </div>
      </div>

      {/* Danh sách sự kiện timeline */}
      {filteredEvents.length === 0 ? (
        <div className="py-12 text-center text-xs text-[var(--text-tertiary)]">
          {emptyMessage}
        </div>
      ) : (
        <div className="relative pl-6 space-y-4 before:absolute before:left-3 before:top-2 before:bottom-2 before:w-px before:bg-[var(--border-subtle)]">
          {filteredEvents.map((event) => (
            <div key={event.id} className="relative group">
              <div className="absolute -left-6 top-1">
                {renderEventIcon(event.type, event.channel)}
              </div>

              <div className="p-3.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-primary)] hover:border-[var(--border-strong)] transition-all shadow-xs">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-[var(--text-primary)]">
                      {event.title}
                    </span>
                    {renderActorBadge(event.actor_type, event.actor_name)}
                  </div>
                  <time className="font-mono text-[11px] text-[var(--text-tertiary)]">
                    {formatDateTime(event.timestamp)}
                  </time>
                </div>

                <p className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">
                  {event.description}
                </p>

                {event.metadata && (
                  <div className="mt-2 pt-2 border-t border-[var(--border-subtle)] text-[11px] text-[var(--text-tertiary)] font-mono">
                    {event.channel && <span>Kênh: {event.channel.toUpperCase()} </span>}
                    {event.metadata.call_duration_seconds !== undefined && (
                      <span>• Thời lượng: {String(event.metadata.call_duration_seconds)}s </span>
                    )}
                    {Boolean(event.metadata.survey_result) && (
                      <span>• Kết quả: {String(event.metadata.survey_result)} </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
