'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  createSurveyAppointmentAction,
  getActiveCompanyTechniciansAction,
} from '../../../app/(dashboard)/surveys/actions';

interface ScheduleSurveyModalProps {
  isOpen: boolean;
  onClose: () => void;
  customerId: string;
  customerName: string;
  defaultAddress?: string;
  onSuccess?: () => void;
}

interface TechnicianOption {
  id: string;
  full_name: string;
}

function getTomorrowDefault(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const yyyy = tomorrow.getFullYear();
  const mm = String(tomorrow.getMonth() + 1).padStart(2, '0');
  const dd = String(tomorrow.getDate()).padStart(2, '0');
  const hh = String(tomorrow.getHours()).padStart(2, '0');
  const min = String(tomorrow.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

export default function ScheduleSurveyModal({
  isOpen,
  onClose,
  customerId,
  customerName,
  defaultAddress = '',
  onSuccess,
}: ScheduleSurveyModalProps) {
  const [address, setAddress] = useState(defaultAddress);
  const [appointmentDate, setAppointmentDate] = useState(getTomorrowDefault);
  const [assigneeId, setAssigneeId] = useState('');
  const [technicians, setTechnicians] = useState<TechnicianOption[]>([]);
  const [loadingTechs, setLoadingTechs] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const fetchTechnicians = useCallback(async () => {
    setLoadingTechs(true);
    try {
      const res = await getActiveCompanyTechniciansAction();
      if (res.success && res.technicians) {
        setTechnicians(res.technicians);
        setAssigneeId((prev) => prev || (res.technicians && res.technicians.length > 0 ? res.technicians[0].id : ''));
      } else {
        setErrorMsg(res.message || 'Không thể tải danh sách kỹ thuật viên.');
      }
    } catch {
      setErrorMsg('Lỗi khi tải danh sách kỹ thuật viên.');
    } finally {
      setLoadingTechs(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    const load = async () => {
      if (isMounted && isOpen) {
        await fetchTechnicians();
      }
    };
    void load();
    return () => {
      isMounted = false;
    };
  }, [isOpen, fetchTechnicians]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!address.trim()) {
      setErrorMsg('Vui lòng nhập địa chỉ khảo sát.');
      return;
    }
    if (!appointmentDate) {
      setErrorMsg('Vui lòng chọn thời gian khảo sát.');
      return;
    }
    if (!assigneeId) {
      setErrorMsg('Vui lòng chọn kỹ thuật viên phụ trách.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await createSurveyAppointmentAction({
        customerId,
        assigneeId,
        address: address.trim(),
        appointmentDate: new Date(appointmentDate).toISOString(),
      });

      if (res.success) {
        setSuccessMsg(res.message || 'Đã tạo lịch khảo sát thành công.');
        setTimeout(() => {
          if (onSuccess) onSuccess();
          onClose();
        }, 1200);
      } else {
        setErrorMsg(res.message || 'Không thể tạo lịch khảo sát.');
      }
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Đã xảy ra lỗi khi tạo lịch khảo sát.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in">
      <div className="bg-slate-900 border border-slate-700/80 w-full max-w-lg rounded-2xl p-6 shadow-2xl space-y-5 text-white">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-blue-500/20 text-blue-400 border border-blue-500/30 flex items-center justify-center">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
            </div>
            <div>
              <h2 className="text-base font-bold text-white">Lên Lịch Khảo Sát Hiện Trường</h2>
              <p className="text-xs text-slate-400">Khách hàng: <strong className="text-white">{customerName}</strong></p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Notifications */}
        {errorMsg && (
          <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-800/80 text-rose-300 text-xs flex items-center gap-2">
            <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>{errorMsg}</span>
          </div>
        )}
        {successMsg && (
          <div className="p-3 rounded-xl bg-emerald-950/60 border border-emerald-800/80 text-emerald-300 text-xs flex items-center gap-2">
            <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span>{successMsg}</span>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          {/* Thời gian khảo sát */}
          <div>
            <label className="block text-slate-300 font-semibold mb-1">
              Thời gian khảo sát <span className="text-rose-400">*</span>
            </label>
            <input
              type="datetime-local"
              required
              value={appointmentDate}
              onChange={(e) => setAppointmentDate(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3.5 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            />
          </div>

          {/* Địa chỉ khảo sát */}
          <div>
            <label className="block text-slate-300 font-semibold mb-1">
              Địa chỉ công trình / hiện trường <span className="text-rose-400">*</span>
            </label>
            <textarea
              required
              rows={2}
              placeholder="Nhập địa chỉ khảo sát thực tế (số nhà, đường, quận/huyện...)"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3.5 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 resize-none"
            />
          </div>

          {/* Chọn Kỹ thuật viên */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-slate-300 font-semibold">
                Kỹ thuật viên phụ trách <span className="text-rose-400">*</span>
              </label>
              <span className="text-[10px] text-slate-500 font-mono">Zero-phone privacy</span>
            </div>
            {loadingTechs ? (
              <div className="h-10 bg-slate-950/60 border border-slate-800 rounded-xl animate-pulse flex items-center px-3 text-slate-500">
                Đang tải danh sách kỹ thuật viên...
              </div>
            ) : technicians.length === 0 ? (
              <div className="p-3 bg-amber-950/30 border border-amber-800/40 rounded-xl text-amber-300">
                Không tìm thấy kỹ thuật viên nào đang hoạt động trong doanh nghiệp. Vui lòng thêm thành viên vai trò TECHNICIAN trước.
              </div>
            ) : (
              <select
                required
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3.5 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              >
                {technicians.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.full_name}
                  </option>
                ))}
              </select>
            )}
            <p className="text-[10px] text-slate-500 mt-1">
              Kỹ thuật viên chỉ nhận địa chỉ công trình và số đo; tuyệt đối không hiển thị số điện thoại khách hàng.
            </p>
          </div>

          {/* Buttons */}
          <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium transition"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={submitting || technicians.length === 0}
              className="px-5 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-semibold shadow-lg shadow-blue-500/20 disabled:opacity-50 transition active:scale-95 flex items-center gap-2"
            >
              {submitting ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Đang tạo lịch...</span>
                </>
              ) : (
                <span>Tạo lịch khảo sát</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
