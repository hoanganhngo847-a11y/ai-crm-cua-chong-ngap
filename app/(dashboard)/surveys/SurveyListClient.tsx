'use client';

import React, { useState, useMemo, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  acceptSurveyAppointmentAction,
  startSurveyAppointmentAction,
  cancelSurveyAppointmentAction,
} from './actions';

export interface SurveyAppointmentItem {
  id: string;
  company_id: string;
  customer_id: string;
  customer_name: string;
  customer_code: string;
  address: string;
  start_time: string;
  status: 'ASSIGNED' | 'ACCEPTED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'REJECTED';
  assignee_id: string;
  assignee_name: string;
}

interface Props {
  initialAppointments: SurveyAppointmentItem[];
  currentUserId: string;
  userRole: string;
  userName: string;
}

type DateFilterOption = 'ALL' | 'TODAY' | 'TOMORROW' | 'THIS_WEEK';
type StatusFilterOption = 'ALL' | 'ASSIGNED' | 'ACCEPTED' | 'IN_PROGRESS' | 'COMPLETED';

export default function SurveyListClient({
  initialAppointments,
  userRole,
  userName,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Local state
  const [appointments, setAppointments] = useState<SurveyAppointmentItem[]>(initialAppointments);
  const [statusFilter, setStatusFilter] = useState<StatusFilterOption>('ALL');
  const [dateFilter, setDateFilter] = useState<DateFilterOption>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [customDate, setCustomDate] = useState('');
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<{
    text: string;
    type: 'success' | 'error';
  } | null>(null);

  const showToast = (text: string, type: 'success' | 'error' = 'success') => {
    setToastMessage({ text, type });
    setTimeout(() => setToastMessage(null), 4000);
  };

  // Helper date checker
  const isDateMatching = (startTimeIso: string, filter: DateFilterOption, custom: string) => {
    const itemDate = new Date(startTimeIso);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const itemDay = new Date(itemDate);
    itemDay.setHours(0, 0, 0, 0);

    if (custom) {
      const selected = new Date(custom);
      selected.setHours(0, 0, 0, 0);
      return itemDay.getTime() === selected.getTime();
    }

    if (filter === 'ALL') return true;

    if (filter === 'TODAY') {
      return itemDay.getTime() === today.getTime();
    }

    if (filter === 'TOMORROW') {
      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);
      return itemDay.getTime() === tomorrow.getTime();
    }

    if (filter === 'THIS_WEEK') {
      const startOfWeek = new Date(today);
      startOfWeek.setDate(today.getDate() - today.getDay() + 1); // Monday
      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(startOfWeek.getDate() + 6); // Sunday
      return itemDay >= startOfWeek && itemDay <= endOfWeek;
    }

    return true;
  };

  // Filtered list
  const filteredAppointments = useMemo(() => {
    return appointments.filter((item) => {
      // 1. Status Filter
      if (statusFilter !== 'ALL' && item.status !== statusFilter) {
        return false;
      }

      // 2. Date Filter
      if (!isDateMatching(item.start_time, dateFilter, customDate)) {
        return false;
      }

      // 3. Search Query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchName = item.customer_name.toLowerCase().includes(q);
        const matchCode = item.customer_code.toLowerCase().includes(q);
        const matchAddress = item.address.toLowerCase().includes(q);
        return matchName || matchCode || matchAddress;
      }

      return true;
    });
  }, [appointments, statusFilter, dateFilter, customDate, searchQuery]);

  // Statistics counters
  const stats = useMemo(() => {
    const total = appointments.length;
    const assigned = appointments.filter((a) => a.status === 'ASSIGNED').length;
    const accepted = appointments.filter((a) => a.status === 'ACCEPTED').length;
    const inProgress = appointments.filter((a) => a.status === 'IN_PROGRESS').length;
    const completed = appointments.filter((a) => a.status === 'COMPLETED').length;
    return { total, assigned, accepted, inProgress, completed };
  }, [appointments]);

  // Handle: Nhận việc (ASSIGNED -> ACCEPTED)
  const handleAccept = async (id: string) => {
    setLoadingId(id);
    startTransition(async () => {
      try {
        const res = await acceptSurveyAppointmentAction(id);
        if (res.success) {
          setAppointments((prev) =>
            prev.map((item) => (item.id === id ? { ...item, status: 'ACCEPTED' } : item))
          );
          showToast('Đã nhận lịch khảo sát thành công!', 'success');
        } else {
          showToast(res.message || 'Không thể nhận lịch.', 'error');
        }
      } catch {
        showToast('Lỗi kết nối khi nhận lịch.', 'error');
      } finally {
        setLoadingId(null);
      }
    });
  };

  // Handle: Bắt đầu đến đo (ACCEPTED/ASSIGNED -> IN_PROGRESS -> Redirect)
  const handleStart = async (id: string) => {
    setLoadingId(id);
    startTransition(async () => {
      try {
        const res = await startSurveyAppointmentAction(id);
        if (res.success && res.redirectUrl) {
          setAppointments((prev) =>
            prev.map((item) => (item.id === id ? { ...item, status: 'IN_PROGRESS' } : item))
          );
          showToast('Bắt đầu đo đạc hiện trường. Đang chuyển hướng...', 'success');
          router.push(res.redirectUrl);
        } else {
          showToast(res.message || 'Không thể bắt đầu khảo sát.', 'error');
          setLoadingId(null);
        }
      } catch {
        showToast('Lỗi khi bắt đầu khảo sát.', 'error');
        setLoadingId(null);
      }
    });
  };

  // Handle: Hủy lịch
  const handleCancel = async (id: string) => {
    if (!confirm('Bạn có chắc chắn muốn hủy lịch hẹn khảo sát này?')) return;
    setLoadingId(id);
    startTransition(async () => {
      try {
        const res = await cancelSurveyAppointmentAction(id);
        if (res.success) {
          setAppointments((prev) =>
            prev.map((item) => (item.id === id ? { ...item, status: 'CANCELLED' } : item))
          );
          showToast('Đã hủy lịch khảo sát.', 'success');
        } else {
          showToast(res.message || 'Không thể hủy lịch.', 'error');
        }
      } catch {
        showToast('Lỗi khi hủy lịch.', 'error');
      } finally {
        setLoadingId(null);
      }
    });
  };

  const formatDateTime = (isoString: string) => {
    try {
      const d = new Date(isoString);
      const hours = String(d.getHours()).padStart(2, '0');
      const mins = String(d.getMinutes()).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const year = d.getFullYear();
      return `${hours}:${mins} - ${day}/${month}/${year}`;
    } catch {
      return isoString;
    }
  };

  return (
    <div className="space-y-6 pb-12">
      {/* Toast Notification */}
      {toastMessage && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl shadow-2xl border text-sm flex items-center gap-3 transition-all ${
            toastMessage.type === 'success'
              ? 'bg-emerald-950/90 border-emerald-500/50 text-emerald-200'
              : 'bg-rose-950/90 border-rose-500/50 text-rose-200'
          }`}
        >
          <span>{toastMessage.type === 'success' ? '✓' : '⚠'}</span>
          <span>{toastMessage.text}</span>
        </div>
      )}

      {/* Header & Persona Card */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800/80 pb-5">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl md:text-3xl font-extrabold text-white tracking-tight">
              Lịch Khảo Sát Hiện Trường
            </h1>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/30">
              {userRole === 'TECHNICIAN' ? 'Kỹ thuật viên' : userRole}
            </span>
          </div>
          <p className="text-sm text-slate-400 mt-1">
            Quản lý hành trình khảo sát, tiếp nhận công việc và nộp kết quả đo đạc chính xác.
          </p>
        </div>

        {/* Security & User Badge */}
        <div className="flex items-center gap-3 self-start md:self-auto">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-950/40 border border-emerald-500/30 text-emerald-300 text-xs font-medium">
            <svg
              className="w-4 h-4 text-emerald-400 shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
              />
            </svg>
            <span>Bảo mật PII: Zero-Phone</span>
          </div>
          <div className="text-right hidden sm:block">
            <div className="text-xs text-slate-400">Đang đăng nhập</div>
            <div className="text-sm font-semibold text-slate-200">{userName}</div>
          </div>
        </div>
      </div>

      {/* Metrics Counter Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 md:gap-4">
        <div
          onClick={() => setStatusFilter('ALL')}
          className={`cursor-pointer p-4 rounded-xl border transition-all ${
            statusFilter === 'ALL'
              ? 'bg-slate-800/90 border-blue-500/50 shadow-lg shadow-blue-500/10'
              : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
          }`}
        >
          <div className="text-xs text-slate-400 font-medium">Tổng lịch hẹn</div>
          <div className="text-2xl font-bold text-white mt-1">{stats.total}</div>
        </div>

        <div
          onClick={() => setStatusFilter('ASSIGNED')}
          className={`cursor-pointer p-4 rounded-xl border transition-all ${
            statusFilter === 'ASSIGNED'
              ? 'bg-amber-950/40 border-amber-500/50 shadow-lg shadow-amber-500/10'
              : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
          }`}
        >
          <div className="text-xs text-amber-400 font-medium flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            Chờ nhận việc
          </div>
          <div className="text-2xl font-bold text-amber-300 mt-1">{stats.assigned}</div>
        </div>

        <div
          onClick={() => setStatusFilter('IN_PROGRESS')}
          className={`cursor-pointer p-4 rounded-xl border transition-all ${
            statusFilter === 'IN_PROGRESS'
              ? 'bg-purple-950/40 border-purple-500/50 shadow-lg shadow-purple-500/10'
              : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
          }`}
        >
          <div className="text-xs text-purple-400 font-medium flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
            Đang đo đạc
          </div>
          <div className="text-2xl font-bold text-purple-300 mt-1">{stats.inProgress}</div>
        </div>

        <div
          onClick={() => setStatusFilter('COMPLETED')}
          className={`cursor-pointer p-4 rounded-xl border transition-all ${
            statusFilter === 'COMPLETED'
              ? 'bg-emerald-950/40 border-emerald-500/50 shadow-lg shadow-emerald-500/10'
              : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
          }`}
        >
          <div className="text-xs text-emerald-400 font-medium">Đã hoàn thành</div>
          <div className="text-2xl font-bold text-emerald-300 mt-1">{stats.completed}</div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-2xl space-y-4 shadow-xl">
        {/* Top filter row: Search & Quick Dates */}
        <div className="flex flex-col md:flex-row gap-3">
          {/* Search Box */}
          <div className="relative flex-1">
            <svg
              className="w-5 h-5 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <input
              type="text"
              placeholder="Tìm theo Mã KH (KH-...), Tên khách, hoặc Địa chỉ..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-950/90 border border-slate-700/80 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white text-xs"
              >
                ✕
              </button>
            )}
          </div>

          {/* Quick Date Tabs */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0">
            {(
              [
                { id: 'ALL', label: 'Tất cả ngày' },
                { id: 'TODAY', label: 'Hôm nay' },
                { id: 'TOMORROW', label: 'Ngày mai' },
                { id: 'THIS_WEEK', label: 'Tuần này' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                onClick={() => {
                  setDateFilter(tab.id);
                  setCustomDate('');
                }}
                className={`px-3 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
                  dateFilter === tab.id && !customDate
                    ? 'bg-blue-600 text-white shadow-md shadow-blue-500/20'
                    : 'bg-slate-800/80 text-slate-300 hover:bg-slate-700'
                }`}
              >
                {tab.label}
              </button>
            ))}

            {/* Custom Date Input */}
            <input
              type="date"
              value={customDate}
              onChange={(e) => {
                setCustomDate(e.target.value);
                setDateFilter('ALL');
              }}
              className="px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-blue-500"
              title="Chọn ngày cụ thể"
            />
          </div>
        </div>

        {/* Status Pills */}
        <div className="flex items-center gap-2 overflow-x-auto pt-2 border-t border-slate-800/60">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider shrink-0 mr-1">
            Trạng thái:
          </span>
          {(
            [
              { id: 'ALL', label: 'Tất cả' },
              { id: 'ASSIGNED', label: 'Chờ nhận' },
              { id: 'ACCEPTED', label: 'Đã nhận' },
              { id: 'IN_PROGRESS', label: 'Đang đo' },
              { id: 'COMPLETED', label: 'Đã hoàn thành' },
            ] as const
          ).map((s) => (
            <button
              key={s.id}
              onClick={() => setStatusFilter(s.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
                statusFilter === s.id
                  ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-semibold shadow-sm'
                  : 'bg-slate-800/60 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Appointments List */}
      <div className="space-y-4">
        {filteredAppointments.length === 0 ? (
          <div className="p-12 text-center bg-slate-900/50 border border-slate-800/80 rounded-2xl">
            <div className="w-16 h-16 mx-auto rounded-full bg-slate-800/60 flex items-center justify-center text-slate-500 mb-3">
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
            </div>
            <h3 className="text-base font-semibold text-white">Không tìm thấy lịch hẹn phù hợp</h3>
            <p className="text-sm text-slate-400 mt-1 max-w-sm mx-auto">
              Thử thay đổi bộ lọc ngày, trạng thái hoặc từ khóa tìm kiếm để xem các lịch hẹn khác.
            </p>
            {(statusFilter !== 'ALL' || dateFilter !== 'ALL' || searchQuery || customDate) && (
              <button
                onClick={() => {
                  setStatusFilter('ALL');
                  setDateFilter('ALL');
                  setSearchQuery('');
                  setCustomDate('');
                }}
                className="mt-4 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-blue-400 transition"
              >
                Đặt lại bộ lọc
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredAppointments.map((item) => {
              const isItemLoading = loadingId === item.id && isPending;

              // Color configs based on status
              const statusBadgeConfig = {
                ASSIGNED: {
                  badge: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
                  dot: 'bg-amber-400',
                  label: 'Chờ nhận việc',
                  border: 'hover:border-amber-500/40',
                },
                ACCEPTED: {
                  badge: 'bg-sky-500/10 text-sky-300 border-sky-500/30',
                  dot: 'bg-sky-400',
                  label: 'Đã nhận việc',
                  border: 'hover:border-sky-500/40',
                },
                IN_PROGRESS: {
                  badge: 'bg-purple-500/10 text-purple-300 border-purple-500/30',
                  dot: 'bg-purple-400 animate-ping',
                  label: 'Đang đến đo đạc',
                  border: 'border-purple-500/40 shadow-lg shadow-purple-500/5',
                },
                COMPLETED: {
                  badge: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
                  dot: 'bg-emerald-400',
                  label: 'Đã hoàn tất đo',
                  border: 'hover:border-emerald-500/40',
                },
                CANCELLED: {
                  badge: 'bg-slate-800 text-slate-400 border-slate-700',
                  dot: 'bg-slate-500',
                  label: 'Đã hủy',
                  border: 'opacity-60',
                },
                REJECTED: {
                  badge: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
                  dot: 'bg-rose-400',
                  label: 'Từ chối',
                  border: 'opacity-60',
                },
              }[item.status] || {
                badge: 'bg-slate-800 text-slate-300 border-slate-700',
                dot: 'bg-slate-400',
                label: item.status,
                border: '',
              };

              return (
                <div
                  key={item.id}
                  className={`p-5 rounded-2xl bg-slate-900 border border-slate-800/90 transition-all flex flex-col justify-between gap-4 ${statusBadgeConfig.border}`}
                >
                  {/* Card Header: Status & Schedule Time */}
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-3">
                      {/* Status Tag */}
                      <span
                        className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${statusBadgeConfig.badge}`}
                      >
                        <span className={`w-2 h-2 rounded-full ${statusBadgeConfig.dot}`} />
                        {statusBadgeConfig.label}
                      </span>

                      {/* Scheduled Time */}
                      <div className="flex items-center gap-1.5 text-xs text-slate-300 font-mono font-medium">
                        <svg
                          className="w-4 h-4 text-blue-400 shrink-0"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                          />
                        </svg>
                        <span>{formatDateTime(item.start_time)}</span>
                      </div>
                    </div>

                    {/* Customer Info (PII Safe: Only Name + Code + Address) */}
                    <div className="space-y-2 mt-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center font-bold text-xs text-white uppercase">
                            {item.customer_name.charAt(0) || 'K'}
                          </div>
                          <span className="font-bold text-white text-base">
                            {item.customer_name}
                          </span>
                        </div>
                        <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-blue-400 font-mono text-xs font-semibold">
                          {item.customer_code}
                        </span>
                      </div>

                      {/* Address with Map Icon */}
                      <div className="p-2.5 rounded-xl bg-slate-950/70 border border-slate-800/80 flex items-start gap-2 text-slate-300 text-xs leading-relaxed">
                        <svg
                          className="w-4 h-4 text-rose-400 shrink-0 mt-0.5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                          />
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                          />
                        </svg>
                        <span className="break-words font-medium">{item.address}</span>
                      </div>
                    </div>
                  </div>

                  {/* Card Actions Footer */}
                  <div className="pt-3 border-t border-slate-800/60 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-slate-500 font-mono">
                      ID: {item.id.slice(0, 8)}...
                    </span>

                    <div className="flex items-center gap-2">
                      {/* Action 1: Nhận lịch (ASSIGNED -> ACCEPTED) */}
                      {item.status === 'ASSIGNED' && (
                        <>
                          <button
                            disabled={isItemLoading}
                            onClick={() => handleCancel(item.id)}
                            className="px-3 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-rose-400 hover:bg-slate-800 border border-transparent hover:border-rose-900/30 transition disabled:opacity-50"
                          >
                            Hủy
                          </button>
                          <button
                            disabled={isItemLoading}
                            onClick={() => handleAccept(item.id)}
                            className="px-4 py-2 rounded-xl text-xs font-bold bg-blue-600 hover:bg-blue-500 text-white shadow-md shadow-blue-600/20 transition flex items-center gap-1.5 disabled:opacity-50"
                          >
                            {isItemLoading ? (
                              <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <span>✓</span>
                            )}
                            <span>Nhận lịch</span>
                          </button>
                        </>
                      )}

                      {/* Action 2: Bắt đầu đến đo (ACCEPTED -> IN_PROGRESS -> Form) */}
                      {item.status === 'ACCEPTED' && (
                        <button
                          disabled={isItemLoading}
                          onClick={() => handleStart(item.id)}
                          className="px-4 py-2 rounded-xl text-xs font-bold bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white shadow-md shadow-purple-600/20 transition flex items-center gap-1.5 disabled:opacity-50"
                        >
                          {isItemLoading ? (
                            <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                          ) : (
                            <svg
                              className="w-3.5 h-3.5"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M13 5l7 7-7 7M5 5l7 7-7 7"
                              />
                            </svg>
                          )}
                          <span>Bắt đầu đến đo</span>
                        </button>
                      )}

                      {/* Action 3: Tiếp tục đo đạc (IN_PROGRESS) */}
                      {item.status === 'IN_PROGRESS' && (
                        <button
                          onClick={() => router.push(`/surveys/${item.id}`)}
                          className="px-4 py-2 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white shadow-md shadow-emerald-600/20 transition flex items-center gap-1.5"
                        >
                          <svg
                            className="w-3.5 h-3.5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                            />
                          </svg>
                          <span>Nhập số đo</span>
                        </button>
                      )}

                      {/* Action 4: Xem kết quả (COMPLETED) */}
                      {item.status === 'COMPLETED' && (
                        <button
                          onClick={() => router.push(`/surveys/${item.id}`)}
                          className="px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
                        >
                          Xem kết quả
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
