'use client';

import React, { useState } from 'react';
import type { CustomerTimelineEvent } from '../../inbox/types/inbox.types';

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
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-xs text-slate-400">Đang nạp dòng thời gian khách hàng...</p>
      </div>
    );
  }

  const filteredEvents = events.filter((evt) => {
    if (filterType === 'ALL') return true;
    return evt.type === filterType;
  });

  // Helper định dạng ngày giờ Việt Nam
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

  // Helper biểu tượng theo loại sự kiện
  const renderEventIcon = (type: CustomerTimelineEvent['type'], channel?: string) => {
    switch (type) {
      case 'CALL':
        return (
          <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 flex items-center justify-center shadow-lg shadow-emerald-500/10">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
              />
            </svg>
          </div>
        );
      case 'SURVEY':
        return (
          <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400 flex items-center justify-center shadow-lg shadow-amber-500/10">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
              />
            </svg>
          </div>
        );
      case 'STAGE_CHANGE':
        return (
          <div className="w-9 h-9 rounded-xl bg-purple-500/10 border border-purple-500/30 text-purple-400 flex items-center justify-center shadow-lg shadow-purple-500/10">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </div>
        );
      case 'NOTE':
        return (
          <div className="w-9 h-9 rounded-xl bg-slate-500/10 border border-slate-500/30 text-slate-300 flex items-center justify-center">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
          </div>
        );
      case 'MESSAGE':
      default:
        if (channel === 'facebook') {
          return (
            <div className="w-9 h-9 rounded-xl bg-sky-500/10 border border-sky-500/30 text-sky-400 flex items-center justify-center shadow-lg shadow-sky-500/10">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2C6.477 2 2 6.145 2 11.258c0 2.91 1.455 5.518 3.735 7.183v3.559l3.418-1.876c.913.253 1.88.392 2.847.392 5.523 0 10-4.145 10-9.258C22 6.145 17.523 2 12 2zm1.042 12.443l-2.58-2.754-5.033 2.754 5.536-5.877 2.643 2.754 4.97-2.754-5.536 5.877z" />
              </svg>
            </div>
          );
        }
        return (
          <div className="w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/30 text-blue-400 flex items-center justify-center shadow-lg shadow-blue-500/10">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
          </div>
        );
    }
  };

  // Helper hiển thị huy hiệu vai trò tác nhân
  const renderActorBadge = (actorType: CustomerTimelineEvent['actor_type'], actorName?: string) => {
    switch (actorType) {
      case 'customer':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            {actorName || 'Khách hàng'}
          </span>
        );
      case 'sale':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
            {actorName || 'Chuyên viên Sale'}
          </span>
        );
      case 'ai':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-500/10 text-purple-300 border border-purple-500/20">
            <svg className="w-2.5 h-2.5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            {actorName || 'AI Trợ lý'}
          </span>
        );
      case 'technician':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            {actorName || 'Kỹ thuật viên'}
          </span>
        );
      case 'system':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-800 text-slate-400 border border-slate-700">
            Hệ thống
          </span>
        );
    }
  };

  return (
    <div className="space-y-4">
      {/* Bộ lọc loại sự kiện */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Dòng sự kiện ({filteredEvents.length})
          </span>
        </div>

        <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-xl border border-slate-800 text-xs">
          {[
            { key: 'ALL', label: 'Tất cả' },
            { key: 'MESSAGE', label: 'Tin nhắn' },
            { key: 'CALL', label: 'Cuộc gọi' },
            { key: 'SURVEY', label: 'Khảo sát' },
            { key: 'STAGE_CHANGE', label: 'Trạng thái' },
          ].map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setFilterType(tab.key)}
              className={`px-2.5 py-1 rounded-lg font-medium transition ${
                filterType === tab.key
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Danh sách sự kiện trục dọc */}
      {filteredEvents.length === 0 ? (
        <div className="py-12 text-center text-slate-500 text-xs border border-dashed border-slate-800 rounded-2xl">
          {emptyMessage}
        </div>
      ) : (
        <div className="relative pl-6 space-y-6 before:absolute before:left-4 before:top-2 before:bottom-2 before:w-0.5 before:bg-gradient-to-b before:from-blue-500/40 before:via-slate-800 before:to-slate-900">
          {filteredEvents.map((evt) => (
            <div key={evt.id} className="relative group">
              {/* Icon Marker */}
              <div className="absolute -left-6 top-0 transform -translate-x-1/2 transition group-hover:scale-110">
                {renderEventIcon(evt.type, evt.channel)}
              </div>

              {/* Event Content Card */}
              <div className="ml-5 p-4 rounded-2xl bg-slate-900/70 border border-slate-800/80 hover:border-slate-700 transition space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <h5 className="font-semibold text-white text-sm">{evt.title}</h5>
                    {renderActorBadge(evt.actor_type, evt.actor_name)}
                  </div>
                  <time className="text-[11px] font-mono text-slate-400">
                    {formatDateTime(evt.timestamp)}
                  </time>
                </div>

                <p className="text-xs text-slate-300 leading-relaxed bg-slate-950/40 p-3 rounded-xl border border-slate-800/40">
                  {evt.description}
                </p>

                {evt.channel && (
                  <div className="flex items-center gap-1.5 text-[10px] text-slate-500 pt-1">
                    <span>Kênh:</span>
                    <span className="font-medium text-slate-400 uppercase tracking-wide">
                      {evt.channel === 'zalo'
                        ? 'Zalo OA'
                        : evt.channel === 'facebook'
                          ? 'Facebook Messenger'
                          : evt.channel}
                    </span>
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
