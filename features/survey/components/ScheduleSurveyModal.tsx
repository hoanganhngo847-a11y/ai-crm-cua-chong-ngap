'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  createSurveyAppointmentAction,
  getActiveCompanyTechniciansAction,
} from '../../../app/(dashboard)/surveys/actions';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { ShieldCheck, AlertCircle, CheckCircle2 } from 'lucide-react';

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
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Lên Lịch Khảo Sát Hiện Trường"
      description={`Khách hàng: ${customerName}`}
      size="md"
    >
      <div className="space-y-4">
        {errorMsg && (
          <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}
        {successMsg && (
          <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{successMsg}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          {/* Thời gian khảo sát */}
          <div>
            <label className="block text-text-secondary font-medium mb-1">
              Thời gian khảo sát <span className="text-danger">*</span>
            </label>
            <input
              type="datetime-local"
              required
              value={appointmentDate}
              onChange={(e) => setAppointmentDate(e.target.value)}
              className="w-full bg-surface-primary border border-border-subtle rounded-lg px-3 py-2 text-text-primary text-xs focus:outline-none focus:border-accent"
            />
          </div>

          {/* Địa chỉ khảo sát */}
          <div>
            <label className="block text-text-secondary font-medium mb-1">
              Địa chỉ công trình / hiện trường <span className="text-danger">*</span>
            </label>
            <textarea
              required
              rows={2}
              placeholder="Nhập địa chỉ khảo sát thực tế (số nhà, đường, quận/huyện...)"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="w-full bg-surface-primary border border-border-subtle rounded-lg px-3 py-2 text-text-primary text-xs focus:outline-none focus:border-accent resize-none"
            />
          </div>

          {/* Chọn Kỹ thuật viên */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-text-secondary font-medium">
                Kỹ thuật viên phụ trách <span className="text-danger">*</span>
              </label>
              <span className="text-[11px] text-text-tertiary flex items-center gap-1 font-mono">
                <ShieldCheck className="w-3 h-3 text-emerald-600" />
                Zero-Phone PII
              </span>
            </div>
            {loadingTechs ? (
              <div className="h-9 bg-surface-secondary border border-border-subtle rounded-lg animate-pulse flex items-center px-3 text-text-tertiary">
                Đang tải danh sách kỹ thuật viên...
              </div>
            ) : technicians.length === 0 ? (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800">
                Không tìm thấy kỹ thuật viên nào đang hoạt động trong doanh nghiệp. Vui lòng thêm thành viên vai trò TECHNICIAN trước.
              </div>
            ) : (
              <select
                required
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
                className="w-full bg-surface-primary border border-border-subtle rounded-lg px-3 py-2 text-text-primary text-xs focus:outline-none focus:border-accent"
              >
                {technicians.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.full_name}
                  </option>
                ))}
              </select>
            )}
            <p className="text-[11px] text-text-tertiary mt-1">
              Kỹ thuật viên chỉ nhận địa chỉ công trình và số đo; tuyệt đối không hiển thị số điện thoại khách hàng.
            </p>
          </div>

          {/* Buttons */}
          <div className="pt-3 border-t border-border-subtle flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onClose}
              disabled={submitting}
            >
              Hủy
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={submitting || technicians.length === 0}
            >
              {submitting ? 'Đang tạo lịch...' : 'Tạo lịch khảo sát'}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
