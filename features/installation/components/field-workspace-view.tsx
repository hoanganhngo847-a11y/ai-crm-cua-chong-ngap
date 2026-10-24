'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  updateInstallationStatusAction,
  uploadInstallationEvidenceAction,
  completeInstallationAction,
  acceptInstallationAppointmentAction,
  startInstallationWorkAction,
} from '../actions';
import type { FieldWorkspaceData } from '../installation-service';
import type { SettableInstallationStatus } from '../types';
import { PRODUCT_UPLOAD_MAX_BYTES } from '@/config/upload-policy';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Wrench, MapPin, FileCheck, Image as ImageIcon, Calendar, CheckCircle2, AlertCircle } from 'lucide-react';

interface FieldWorkspaceViewProps {
  initialData: FieldWorkspaceData;
}

export function FieldWorkspaceView({ initialData }: FieldWorkspaceViewProps) {
  const router = useRouter();
  const [data] = useState<FieldWorkspaceData>(initialData);
  const [activeTab, setActiveTab] = useState<'INSTALLATION' | 'SURVEY'>('INSTALLATION');
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Status transitions map
  const ALLOWED_TRANSITIONS: Record<string, SettableInstallationStatus[]> = {
    SCHEDULED: ['IN_TRANSIT', 'INSTALLING', 'FAILED'],
    IN_TRANSIT: ['INSTALLING', 'FAILED'],
    INSTALLING: ['TESTING', 'HANDOVER_PENDING', 'FAILED'],
    TESTING: ['HANDOVER_PENDING', 'INSTALLING', 'FAILED'],
    HANDOVER_PENDING: ['TESTING', 'INSTALLING', 'FAILED'],
    FAILED: ['SCHEDULED', 'IN_TRANSIT', 'INSTALLING'],
  };

  const STATUS_LABELS: Record<string, string> = {
    SCHEDULED: 'Đã lên lịch',
    IN_TRANSIT: 'Đang di chuyển',
    INSTALLING: 'Đang lắp đặt',
    TESTING: 'Kiểm thử vận hành',
    HANDOVER_PENDING: 'Chờ nghiệm thu',
    COMPLETED: 'Hoàn tất',
    FAILED: 'Thất bại/Tạm dừng',
    ASSIGNED: 'Đã phân công',
    ACCEPTED: 'Đã nhận việc',
    IN_PROGRESS: 'Đang thực hiện',
    CANCELLED: 'Đã hủy',
    REJECTED: 'Từ chối',
  };

  const getStatusVariant = (status: string): 'neutral' | 'success' | 'warning' | 'danger' | 'info' => {
    switch (status) {
      case 'COMPLETED':
        return 'success';
      case 'INSTALLING':
      case 'IN_TRANSIT':
      case 'TESTING':
      case 'IN_PROGRESS':
        return 'info';
      case 'HANDOVER_PENDING':
      case 'ASSIGNED':
      case 'SCHEDULED':
        return 'warning';
      case 'FAILED':
      case 'CANCELLED':
      case 'REJECTED':
        return 'danger';
      default:
        return 'neutral';
    }
  };

  const handleStatusChange = async (installationId: string, nextStatus: SettableInstallationStatus) => {
    setErrorMsg(null);
    setSuccessMsg(null);
    setLoadingId(installationId);
    try {
      const res = await updateInstallationStatusAction(installationId, nextStatus);
      if (!res.success) {
        setErrorMsg(res.error || 'Cập nhật trạng thái thất bại');
      } else {
        setSuccessMsg(`Đã cập nhật trạng thái sang "${STATUS_LABELS[nextStatus] || nextStatus}"`);
        router.refresh();
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Lỗi xử lý';
      setErrorMsg(message);
    } finally {
      setLoadingId(null);
    }
  };

  const handleAcceptAppointment = async (appointmentId: string) => {
    setErrorMsg(null);
    setSuccessMsg(null);
    setLoadingId(appointmentId);
    try {
      const res = await acceptInstallationAppointmentAction({ appointmentId });
      if (!res.success) {
        setErrorMsg(res.error || 'Nhận việc thất bại');
      } else {
        setSuccessMsg('Đã nhận việc thành công! Bạn có thể bắt đầu tác nghiệp thi công.');
        router.refresh();
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Lỗi xử lý';
      setErrorMsg(message);
    } finally {
      setLoadingId(null);
    }
  };

  const handleStartWork = async (installationId: string) => {
    setErrorMsg(null);
    setSuccessMsg(null);
    setLoadingId(installationId);
    try {
      const res = await startInstallationWorkAction({ installationId });
      if (!res.success) {
        setErrorMsg(res.error || 'Bắt đầu công việc thất bại');
      } else {
        setSuccessMsg('Đã bắt đầu công việc lắp đặt.');
        router.refresh();
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Lỗi xử lý';
      setErrorMsg(message);
    } finally {
      setLoadingId(null);
    }
  };

  const handleFileUpload = async (
    installationId: string,
    evidenceType: 'PHOTO' | 'HANDOVER',
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setErrorMsg(null);
    setSuccessMsg(null);

    if (file.size > PRODUCT_UPLOAD_MAX_BYTES) {
      setErrorMsg('Dung lượng tệp không được vượt quá 10MB.');
      return;
    }

    setLoadingId(installationId);

    const formData = new FormData();
    formData.append('installationId', installationId);
    formData.append('evidenceType', evidenceType);
    formData.append('file', file);

    try {
      const res = await uploadInstallationEvidenceAction(formData);
      if (!res.success) {
        setErrorMsg(res.error || 'Tải file chứng từ thất bại');
      } else {
        setSuccessMsg(
          evidenceType === 'PHOTO'
            ? 'Đã tải lên ảnh hiện trường thành công'
            : 'Đã tải lên biên bản nghiệm thu thành công'
        );
        router.refresh();
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Lỗi tải file';
      setErrorMsg(message);
    } finally {
      setLoadingId(null);
      e.target.value = '';
    }
  };

  const handleCompleteHandover = async (installationId: string) => {
    if (!confirm('Xác nhận hoàn tất nghiệm thu và bàn giao đơn hàng? Thao tác này sẽ cập nhật đơn hàng sang COMPLETED.')) {
      return;
    }

    setErrorMsg(null);
    setSuccessMsg(null);
    setLoadingId(installationId);
    try {
      const res = await completeInstallationAction({ installationId });
      if (!res.success) {
        setErrorMsg(res.error || 'Nghiệm thu bàn giao thất bại');
      } else {
        setSuccessMsg('Hoàn tất nghiệm thu và bàn giao thành công! Đơn hàng đã chuyển sang trạng thái COMPLETED.');
        router.refresh();
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Lỗi xử lý';
      setErrorMsg(message);
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Vận hành', href: '/field' },
          { label: 'Hiện trường' },
        ]}
        title="Tác nghiệp Hiện trường"
        description="Quản lý công việc khảo sát, thi công lắp đặt và nghiệm thu bàn giao theo phân công."
        primaryAction={
          <div className="flex items-center gap-3">
            <Badge variant="neutral">
              Vai trò: {data.role}
            </Badge>
            <div className="inline-flex rounded-lg bg-surface-secondary p-1 border border-border-subtle">
              <button
                type="button"
                onClick={() => setActiveTab('INSTALLATION')}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                  activeTab === 'INSTALLATION'
                    ? 'bg-surface-primary text-text-primary shadow-xs font-semibold'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                Lắp đặt ({data.installations.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('SURVEY')}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                  activeTab === 'SURVEY'
                    ? 'bg-surface-primary text-text-primary shadow-xs font-semibold'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                Khảo sát ({data.surveys.length})
              </button>
            </div>
          </div>
        }
      />

      {errorMsg && (
        <div className="p-4 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-sm flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>{errorMsg}</span>
          </div>
          <button onClick={() => setErrorMsg(null)} className="text-xs font-medium text-rose-700 hover:underline">Đóng</button>
        </div>
      )}

      {successMsg && (
        <div className="p-4 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{successMsg}</span>
          </div>
          <button onClick={() => setSuccessMsg(null)} className="text-xs font-medium text-emerald-700 hover:underline">Đóng</button>
        </div>
      )}

      {activeTab === 'INSTALLATION' && (
        <div className="space-y-4">
          {data.installations.length === 0 ? (
            <Card className="p-12 text-center">
              <EmptyState
                icon={<Wrench className="w-8 h-8 text-text-tertiary" />}
                title="Chưa có phân công lắp đặt"
                description="Bạn hiện không có công việc lắp đặt nào đang hoạt động."
              />
            </Card>
          ) : (
            data.installations.map((item) => {
              const allowedTransitions = ALLOWED_TRANSITIONS[item.status] || [];
              const canComplete =
                item.status === 'HANDOVER_PENDING' &&
                item.photos.length > 0 &&
                !!item.handoverRef;
              const isLoading = loadingId === item.id;

              return (
                <Card
                  key={item.id}
                  className="p-5 space-y-4 hover:border-border-strong transition-colors"
                >
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-border-subtle pb-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-text-primary text-base">
                          {item.customerName}
                        </span>
                        <span className="text-xs font-mono text-text-tertiary">
                          ({item.customerCode})
                        </span>
                      </div>
                      <div className="text-xs text-text-secondary mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span>Mã đơn: <strong className="font-mono text-accent">{item.orderCode}</strong></span>
                        <span className="text-border-strong">•</span>
                        <span className="flex items-center gap-1">
                          <MapPin className="w-3 h-3 text-text-tertiary" />
                          {item.address}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {item.appointmentStatus && (
                        <Badge variant={getStatusVariant(item.appointmentStatus)}>
                          Lịch hẹn: {STATUS_LABELS[item.appointmentStatus] || item.appointmentStatus}
                        </Badge>
                      )}
                      <Badge variant={getStatusVariant(item.status)}>
                        {STATUS_LABELS[item.status] || item.status}
                      </Badge>
                    </div>
                  </div>

                  {/* Evidence status */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-surface-secondary p-4 rounded-lg border border-border-subtle">
                    <div>
                      <div className="text-xs font-medium text-text-secondary mb-2 flex items-center justify-between">
                        <span className="flex items-center gap-1.5 font-semibold text-text-primary">
                          <ImageIcon className="w-3.5 h-3.5 text-text-tertiary" />
                          Ảnh hiện trường ({item.photos.length})
                        </span>
                        {item.status !== 'COMPLETED' && (
                          item.appointmentStatus === 'ASSIGNED' ? (
                            <span className="text-[11px] text-amber-700 italic">Cần nhận việc trước khi tải ảnh</span>
                          ) : (
                            <label className="cursor-pointer text-xs font-medium text-accent hover:text-accent-hover">
                              + Tải ảnh mới
                              <input
                                type="file"
                                accept="image/*"
                                className="hidden"
                                disabled={isLoading}
                                onChange={(e) => handleFileUpload(item.id, 'PHOTO', e)}
                              />
                            </label>
                          )
                        )}
                      </div>
                      {item.photos.length === 0 ? (
                        <p className="text-xs text-text-tertiary italic">Chưa có ảnh hiện trường được tải lên.</p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {item.photos.map((p, idx) => (
                            <span
                              key={idx}
                              className="px-2 py-0.5 rounded bg-surface-primary border border-border-subtle text-[11px] font-mono text-text-secondary truncate max-w-[200px]"
                              title={p}
                            >
                              Ảnh #{idx + 1}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="text-xs font-medium text-text-secondary mb-2 flex items-center justify-between">
                        <span className="flex items-center gap-1.5 font-semibold text-text-primary">
                          <FileCheck className="w-3.5 h-3.5 text-text-tertiary" />
                          Biên bản nghiệm thu
                        </span>
                        {item.status !== 'COMPLETED' && (
                          item.appointmentStatus === 'ASSIGNED' ? (
                            <span className="text-[11px] text-amber-700 italic">Cần nhận việc trước khi tải biên bản</span>
                          ) : (
                            <label className="cursor-pointer text-xs font-medium text-accent hover:text-accent-hover">
                              {item.handoverRef ? 'Thay thế biên bản' : '+ Tải biên bản (PDF/Ảnh)'}
                              <input
                                type="file"
                                accept="application/pdf,image/*"
                                className="hidden"
                                disabled={isLoading}
                                onChange={(e) => handleFileUpload(item.id, 'HANDOVER', e)}
                              />
                            </label>
                          )
                        )}
                      </div>
                      {item.handoverRef ? (
                        <div className="flex items-center gap-2">
                          <span className="inline-block w-2 h-2 rounded-full bg-emerald-500"></span>
                          <span className="text-xs text-text-primary font-mono truncate max-w-[240px]">
                            {item.handoverRef.split('/').pop()}
                          </span>
                        </div>
                      ) : (
                        <p className="text-xs text-amber-700 italic">Chưa tải biên bản nghiệm thu bàn giao.</p>
                      )}
                    </div>
                  </div>

                  {/* Actions Bar */}
                  {item.status !== 'COMPLETED' && (
                    <div className="space-y-3 pt-1">
                      {item.appointmentStatus === 'ASSIGNED' ? (
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                          <div className="text-xs text-amber-900">
                            <span className="font-semibold">Công việc mới được phân công:</span> Vui lòng nhận việc trước khi triển khai cập nhật trạng thái thi công.
                          </div>
                          {data.role === 'TECHNICIAN' ? (
                            <Button
                              id={`accept-job-${item.id}`}
                              disabled={isLoading}
                              onClick={() => handleAcceptAppointment(item.appointmentId)}
                              variant="primary"
                              size="sm"
                              className="whitespace-nowrap"
                            >
                              {isLoading ? 'Đang xử lý...' : 'Nhận việc'}
                            </Button>
                          ) : (
                            <span className="text-xs text-amber-800 italic">Đang chờ kỹ thuật viên nhận việc</span>
                          )}
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                          <div className="flex flex-wrap items-center gap-2">
                            {item.appointmentStatus === 'ACCEPTED' && data.role === 'TECHNICIAN' && (
                              <Button
                                id={`start-work-${item.id}`}
                                disabled={isLoading}
                                onClick={() => handleStartWork(item.id)}
                                variant="primary"
                                size="sm"
                              >
                                {isLoading ? 'Đang xử lý...' : 'Bắt đầu công việc'}
                              </Button>
                            )}
                            <span className="text-xs text-text-tertiary">Chuyển trạng thái:</span>
                            {allowedTransitions.map((st) => (
                              <Button
                                key={st}
                                disabled={isLoading}
                                onClick={() => handleStatusChange(item.id, st)}
                                variant="secondary"
                                size="sm"
                              >
                                {STATUS_LABELS[st] || st}
                              </Button>
                            ))}
                          </div>

                          <div>
                            {item.status === 'HANDOVER_PENDING' && (
                              <Button
                                disabled={!canComplete || isLoading}
                                onClick={() => handleCompleteHandover(item.id)}
                                variant="primary"
                                size="sm"
                                className="bg-emerald-600 hover:bg-emerald-700 text-white"
                                title={
                                  !canComplete
                                    ? 'Yêu cầu tối thiểu 1 ảnh hiện trường và 1 biên bản nghiệm thu'
                                    : 'Xác nhận hoàn tất bàn giao đơn hàng'
                                }
                              >
                                {isLoading ? 'Đang xử lý...' : 'Nghiệm thu & Hoàn tất bàn giao'}
                              </Button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {item.status === 'COMPLETED' && item.completedAt && (
                    <div className="text-xs text-emerald-800 bg-emerald-50 p-2.5 rounded-lg border border-emerald-200 flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                      <span>Đã hoàn tất nghiệm thu & bàn giao lúc {new Date(item.completedAt).toLocaleString('vi-VN')}. Đơn hàng đã ở trạng thái COMPLETED.</span>
                    </div>
                  )}
                </Card>
              );
            })
          )}
        </div>
      )}

      {activeTab === 'SURVEY' && (
        <div className="space-y-4">
          {data.surveys.length === 0 ? (
            <Card className="p-12 text-center">
              <EmptyState
                icon={<Calendar className="w-8 h-8 text-text-tertiary" />}
                title="Chưa có phân công khảo sát"
                description="Bạn hiện không có lịch hẹn khảo sát nào."
              />
            </Card>
          ) : (
            data.surveys.map((survey) => (
              <Card
                key={survey.id}
                className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:border-border-strong transition-colors"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-text-primary text-base">{survey.customerName}</span>
                    <span className="text-xs font-mono text-text-tertiary">({survey.customerCode})</span>
                  </div>
                  <div className="text-xs text-text-secondary mt-1 flex items-center gap-1">
                    <MapPin className="w-3 h-3 text-text-tertiary" />
                    <span>{survey.address}</span>
                  </div>
                  <div className="text-xs text-text-secondary mt-0.5 flex items-center gap-1">
                    <Calendar className="w-3 h-3 text-text-tertiary" />
                    <span>Thời gian: {new Date(survey.startTime).toLocaleString('vi-VN')}</span>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <Badge variant={getStatusVariant(survey.status)}>
                    {STATUS_LABELS[survey.status] || survey.status}
                  </Badge>
                </div>
              </Card>
            ))
          )}
        </div>
      )}
    </div>
  );
}
