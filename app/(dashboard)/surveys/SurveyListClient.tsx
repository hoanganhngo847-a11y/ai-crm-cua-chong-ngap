'use client';

import React, { useState, useMemo, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  acceptSurveyAppointmentAction,
  startSurveyAppointmentAction,
  cancelSurveyAppointmentAction,
} from './actions';
import CalculatePriceFromSurveyButton from '../../../features/pricing/components/calculate-price-from-survey-button';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Calendar,
  Clock,
  MapPin,
  ShieldCheck,
  Search,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  ClipboardEdit,
} from 'lucide-react';

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
  survey_id?: string | null;
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
          className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl shadow-lg border text-sm flex items-center gap-3 transition-all ${
            toastMessage.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}
        >
          {toastMessage.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
          )}
          <span>{toastMessage.text}</span>
        </div>
      )}

      {/* Header & Persona */}
      <PageHeader
        breadcrumbs={[
          { label: 'Khảo sát hiện trường' },
        ]}
        title="Lịch Khảo Sát Hiện Trường"
        description="Quản lý hành trình khảo sát, tiếp nhận công việc và nộp kết quả đo đạc kỹ thuật chính xác."
        primaryAction={
          <div className="flex items-center gap-3">
            <Badge variant="neutral">
              {userRole === 'TECHNICIAN' ? 'Kỹ thuật viên' : userRole}
            </Badge>
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-medium">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
              <span>Zero-Phone PII</span>
            </div>
            <div className="text-right hidden sm:block pl-2 border-l border-border-subtle">
              <div className="text-[11px] text-text-tertiary">Đang đăng nhập</div>
              <div className="text-xs font-semibold text-text-primary">{userName}</div>
            </div>
          </div>
        }
      />

      {/* Metrics Counter Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <button
          type="button"
          onClick={() => setStatusFilter('ALL')}
          className={`text-left p-4 rounded-xl border transition-all ${
            statusFilter === 'ALL'
              ? 'bg-accent-soft border-accent shadow-xs'
              : 'bg-surface-primary border-border-subtle hover:border-border-strong'
          }`}
        >
          <div className="text-xs text-text-secondary font-medium">Tổng lịch hẹn</div>
          <div className="text-2xl font-bold text-text-primary mt-1">{stats.total}</div>
        </button>

        <button
          type="button"
          onClick={() => setStatusFilter('ASSIGNED')}
          className={`text-left p-4 rounded-xl border transition-all ${
            statusFilter === 'ASSIGNED'
              ? 'bg-amber-50 border-amber-300 shadow-xs'
              : 'bg-surface-primary border-border-subtle hover:border-border-strong'
          }`}
        >
          <div className="text-xs text-amber-700 font-medium flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-500" />
            Chờ nhận việc
          </div>
          <div className="text-2xl font-bold text-amber-900 mt-1">{stats.assigned}</div>
        </button>

        <button
          type="button"
          onClick={() => setStatusFilter('IN_PROGRESS')}
          className={`text-left p-4 rounded-xl border transition-all ${
            statusFilter === 'IN_PROGRESS'
              ? 'bg-blue-50 border-blue-300 shadow-xs'
              : 'bg-surface-primary border-border-subtle hover:border-border-strong'
          }`}
        >
          <div className="text-xs text-accent font-medium flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-accent" />
            Đang đo đạc
          </div>
          <div className="text-2xl font-bold text-accent-hover mt-1">{stats.inProgress}</div>
        </button>

        <button
          type="button"
          onClick={() => setStatusFilter('COMPLETED')}
          className={`text-left p-4 rounded-xl border transition-all ${
            statusFilter === 'COMPLETED'
              ? 'bg-emerald-50 border-emerald-300 shadow-xs'
              : 'bg-surface-primary border-border-subtle hover:border-border-strong'
          }`}
        >
          <div className="text-xs text-emerald-700 font-medium flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            Đã hoàn thành
          </div>
          <div className="text-2xl font-bold text-emerald-900 mt-1">{stats.completed}</div>
        </button>
      </div>

      {/* Filter and Search Bar */}
      <Card className="p-4 space-y-3">
        <div className="flex flex-col md:flex-row gap-3">
          {/* Search Box */}
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
            <input
              type="text"
              placeholder="Tìm theo Mã KH (KH-...), Tên khách, hoặc Địa chỉ..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-surface-primary border border-border-subtle rounded-lg pl-9 pr-8 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary text-xs"
              >
                ✕
              </button>
            )}
          </div>

          {/* Quick Date Tabs */}
          <div className="flex items-center gap-1 overflow-x-auto pb-1 md:pb-0">
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
                className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                  dateFilter === tab.id && !customDate
                    ? 'bg-text-primary text-white font-semibold'
                    : 'bg-surface-secondary text-text-secondary hover:text-text-primary hover:bg-surface-hover'
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
              className="px-2.5 py-1.5 bg-surface-secondary border border-border-subtle rounded-md text-xs text-text-primary focus:outline-none focus:border-accent"
              title="Chọn ngày cụ thể"
            />
          </div>
        </div>

        {/* Status Pills */}
        <div className="flex items-center gap-2 overflow-x-auto pt-2 border-t border-border-subtle">
          <span className="text-xs font-medium text-text-tertiary uppercase tracking-wider shrink-0 mr-1">
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
              className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                statusFilter === s.id
                  ? 'bg-accent text-white font-semibold'
                  : 'bg-surface-secondary text-text-secondary hover:text-text-primary hover:bg-surface-hover'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </Card>

      {/* Appointments List */}
      <div className="space-y-4">
        {filteredAppointments.length === 0 ? (
          <Card className="p-12 text-center">
            <EmptyState
              icon={<Calendar className="w-8 h-8 text-text-tertiary" />}
              title="Không tìm thấy lịch hẹn phù hợp"
              description="Thử thay đổi bộ lọc ngày, trạng thái hoặc từ khóa tìm kiếm để xem các lịch hẹn khác."
              action={
                (statusFilter !== 'ALL' || dateFilter !== 'ALL' || searchQuery || customDate) ? {
                  label: 'Đặt lại bộ lọc',
                  onClick: () => {
                    setStatusFilter('ALL');
                    setDateFilter('ALL');
                    setSearchQuery('');
                    setCustomDate('');
                  },
                } : undefined
              }
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredAppointments.map((item) => {
              const isItemLoading = loadingId === item.id && isPending;

              const getBadgeVariant = (st: string): 'neutral' | 'success' | 'warning' | 'danger' | 'info' => {
                switch (st) {
                  case 'COMPLETED':
                    return 'success';
                  case 'IN_PROGRESS':
                    return 'info';
                  case 'ASSIGNED':
                  case 'ACCEPTED':
                    return 'warning';
                  case 'CANCELLED':
                  case 'REJECTED':
                    return 'danger';
                  default:
                    return 'neutral';
                }
              };

              const statusLabels: Record<string, string> = {
                ASSIGNED: 'Chờ nhận việc',
                ACCEPTED: 'Đã nhận việc',
                IN_PROGRESS: 'Đang đến đo đạc',
                COMPLETED: 'Đã hoàn tất đo',
                CANCELLED: 'Đã hủy',
                REJECTED: 'Từ chối',
              };

              return (
                <Card
                  key={item.id}
                  className="p-5 flex flex-col justify-between gap-4 hover:border-border-strong transition-colors"
                >
                  {/* Card Header: Status & Schedule Time */}
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-3">
                      <Badge variant={getBadgeVariant(item.status)}>
                        {statusLabels[item.status] || item.status}
                      </Badge>

                      <div className="flex items-center gap-1.5 text-xs text-text-secondary font-mono">
                        <Clock className="w-3.5 h-3.5 text-accent shrink-0" />
                        <span>{formatDateTime(item.start_time)}</span>
                      </div>
                    </div>

                    {/* Customer Info */}
                    <div className="space-y-2.5 mt-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-full bg-accent-soft text-accent font-semibold text-xs flex items-center justify-center uppercase">
                            {item.customer_name.charAt(0) || 'K'}
                          </div>
                          <span className="font-semibold text-text-primary text-base">
                            {item.customer_name}
                          </span>
                        </div>
                        <span className="px-2 py-0.5 rounded bg-surface-secondary border border-border-subtle text-accent font-mono text-xs font-semibold">
                          {item.customer_code}
                        </span>
                      </div>

                      {/* Address */}
                      <div className="p-2.5 rounded-lg bg-surface-secondary border border-border-subtle flex items-start gap-2 text-text-secondary text-xs leading-relaxed">
                        <MapPin className="w-4 h-4 text-text-tertiary shrink-0 mt-0.5" />
                        <span className="break-words font-medium">{item.address}</span>
                      </div>
                    </div>
                  </div>

                  {/* Card Actions Footer */}
                  <div className="pt-3 border-t border-border-subtle flex items-center justify-between gap-2">
                    <span className="text-[11px] text-text-tertiary font-mono">
                      ID: {item.id.slice(0, 8)}...
                    </span>

                    <div className="flex items-center gap-2">
                      {/* Action 1: Nhận lịch (ASSIGNED -> ACCEPTED) */}
                      {item.status === 'ASSIGNED' && (
                        <>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={isItemLoading}
                            onClick={() => handleCancel(item.id)}
                            className="text-danger hover:text-danger hover:bg-rose-50"
                          >
                            Hủy
                          </Button>
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={isItemLoading}
                            onClick={() => handleAccept(item.id)}
                          >
                            {isItemLoading ? 'Đang xử lý...' : '✓ Nhận lịch'}
                          </Button>
                        </>
                      )}

                      {/* Action 2: Bắt đầu đến đo (ACCEPTED -> IN_PROGRESS -> Form) */}
                      {item.status === 'ACCEPTED' && (
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={isItemLoading}
                          onClick={() => handleStart(item.id)}
                        >
                          {isItemLoading ? 'Đang chuyển hướng...' : 'Bắt đầu đến đo'}
                          <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
                        </Button>
                      )}

                      {/* Action 3: Tiếp tục đo đạc (IN_PROGRESS) */}
                      {item.status === 'IN_PROGRESS' && (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => router.push(`/surveys/${item.id}`)}
                          className="bg-emerald-600 hover:bg-emerald-700 text-white"
                        >
                          <ClipboardEdit className="w-3.5 h-3.5 mr-1.5" />
                          Nhập số đo
                        </Button>
                      )}

                      {/* Action 4: Xem kết quả & Tính giá (COMPLETED) */}
                      {item.status === 'COMPLETED' && (
                        <div className="flex items-center gap-2">
                          {item.survey_id && (userRole === 'BOSS_ADMIN' || userRole === 'SALE') && (
                            <CalculatePriceFromSurveyButton
                              surveyId={item.survey_id}
                              userRole={userRole}
                            />
                          )}
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => router.push(`/surveys/${item.id}`)}
                          >
                            Xem kết quả
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
