'use client';

import React, { useState } from 'react';
import {
  MessageSquare,
  Phone,
  FileText,
  Bot,
  ArrowRightCircle,
  UserCheck,
  Calendar,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

export type TimelineEventType =
  | 'MESSAGE'
  | 'CALL'
  | 'NOTE'
  | 'AI_UPDATE'
  | 'STAGE_CHANGE'
  | 'HANDOVER'
  | 'APPOINTMENT';

export interface TimelineItem {
  id: string;
  type: TimelineEventType;
  title: React.ReactNode;
  actor?: string;
  channel?: string;
  timestamp: string;
  summary?: React.ReactNode;
  details?: React.ReactNode;
  status?: string;
}

export interface TimelineProps {
  items: TimelineItem[];
  className?: string;
}

export const Timeline: React.FC<TimelineProps> = ({ items, className = '' }) => {
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const getEventIcon = (type: TimelineEventType) => {
    switch (type) {
      case 'MESSAGE':
        return <MessageSquare className="w-3.5 h-3.5 text-blue-600" />;
      case 'CALL':
        return <Phone className="w-3.5 h-3.5 text-emerald-600" />;
      case 'NOTE':
        return <FileText className="w-3.5 h-3.5 text-slate-600" />;
      case 'AI_UPDATE':
        return <Bot className="w-3.5 h-3.5 text-indigo-600" />;
      case 'STAGE_CHANGE':
        return <ArrowRightCircle className="w-3.5 h-3.5 text-amber-600" />;
      case 'HANDOVER':
        return <UserCheck className="w-3.5 h-3.5 text-orange-600" />;
      case 'APPOINTMENT':
        return <Calendar className="w-3.5 h-3.5 text-purple-600" />;
      default:
        return <FileText className="w-3.5 h-3.5 text-slate-600" />;
    }
  };

  const getEventBg = (type: TimelineEventType) => {
    switch (type) {
      case 'MESSAGE':
        return 'bg-blue-50 border-blue-200';
      case 'CALL':
        return 'bg-emerald-50 border-emerald-200';
      case 'NOTE':
        return 'bg-slate-50 border-slate-200';
      case 'AI_UPDATE':
        return 'bg-indigo-50 border-indigo-200';
      case 'STAGE_CHANGE':
        return 'bg-amber-50 border-amber-200';
      case 'HANDOVER':
        return 'bg-orange-50 border-orange-200';
      case 'APPOINTMENT':
        return 'bg-purple-50 border-purple-200';
      default:
        return 'bg-slate-50 border-slate-200';
    }
  };

  if (!items || items.length === 0) {
    return (
      <div className="text-center py-8 text-xs text-[var(--text-tertiary)]">
        Chưa có sự kiện nào trong dòng thời gian.
      </div>
    );
  }

  return (
    <div className={`relative pl-6 space-y-4 before:absolute before:left-3 before:top-2 before:bottom-2 before:w-px before:bg-[var(--border-subtle)] ${className}`}>
      {items.map((item) => {
        const isExpanded = !!expandedIds[item.id];
        const hasDetails = !!item.details;

        return (
          <div key={item.id} className="relative group">
            {/* Event Dot */}
            <div
              className={`absolute -left-6 top-1.5 w-6 h-6 rounded-full border flex items-center justify-center shrink-0 ${getEventBg(
                item.type
              )} shadow-xs`}
            >
              {getEventIcon(item.type)}
            </div>

            {/* Event Card */}
            <div className="bg-[var(--surface-primary)] border border-[var(--border-subtle)] rounded-lg p-3 shadow-xs hover:border-[var(--border-strong)] transition-all">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-[var(--text-primary)]">
                    {item.title}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-[11px] text-[var(--text-secondary)]">
                    {item.actor && <span>{item.actor}</span>}
                    {item.channel && (
                      <span className="px-1.5 py-0.2 rounded bg-[var(--surface-secondary)] text-[var(--text-tertiary)] font-mono text-[10px]">
                        {item.channel}
                      </span>
                    )}
                  </div>
                </div>

                <div className="text-[11px] font-mono text-[var(--text-tertiary)] shrink-0">
                  {item.timestamp}
                </div>
              </div>

              {item.summary && (
                <div className="mt-2 text-xs text-[var(--text-secondary)] leading-relaxed">
                  {item.summary}
                </div>
              )}

              {hasDetails && (
                <div className="mt-2 pt-2 border-t border-[var(--border-subtle)]">
                  <button
                    type="button"
                    onClick={() => toggleExpand(item.id)}
                    className="flex items-center gap-1 text-[11px] font-medium text-[var(--accent)] hover:underline cursor-pointer"
                  >
                    <span>{isExpanded ? 'Thu gọn chi tiết' : 'Xem chi tiết'}</span>
                    {isExpanded ? (
                      <ChevronUp className="w-3 h-3" />
                    ) : (
                      <ChevronDown className="w-3 h-3" />
                    )}
                  </button>

                  {isExpanded && (
                    <div className="mt-2 p-2.5 bg-[var(--surface-secondary)] rounded border border-[var(--border-subtle)] text-xs text-[var(--text-primary)]">
                      {item.details}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
