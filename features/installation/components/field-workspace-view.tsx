'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  updateInstallationStatusAction,
  uploadInstallationEvidenceAction,
  completeInstallationAction,
} from '../actions';
import type { FieldWorkspaceData } from '../installation-service';
import type { SettableInstallationStatus } from '../types';

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

  const handleFileUpload = async (
    installationId: string,
    evidenceType: 'PHOTO' | 'HANDOVER',
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setErrorMsg(null);
    setSuccessMsg(null);
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
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Không gian Tác nghiệp Hiện trường</h1>
          <p className="text-sm text-slate-400">
            Quản lý công việc khảo sát, thi công lắp đặt và nghiệm thu bàn giao theo phân công hiện hành.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs font-mono text-cyan-400">
            Vai trò: {data.role}
          </span>
          <div className="flex rounded-lg bg-slate-800 p-1 border border-slate-700">
            <button
              onClick={() => setActiveTab('INSTALLATION')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                activeTab === 'INSTALLATION'
                  ? 'bg-cyan-600 text-white shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Lắp đặt ({data.installations.length})
            </button>
            <button
              onClick={() => setActiveTab('SURVEY')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                activeTab === 'SURVEY'
                  ? 'bg-cyan-600 text-white shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Khảo sát ({data.surveys.length})
            </button>
          </div>
        </div>
      </div>

      {errorMsg && (
        <div className="p-4 rounded-lg bg-rose-950/50 border border-rose-800 text-rose-300 text-sm flex items-center justify-between">
          <span>{errorMsg}</span>
          <button onClick={() => setErrorMsg(null)} className="text-xs underline text-rose-400">Đóng</button>
        </div>
      )}

      {successMsg && (
        <div className="p-4 rounded-lg bg-emerald-950/50 border border-emerald-800 text-emerald-300 text-sm flex items-center justify-between">
          <span>{successMsg}</span>
          <button onClick={() => setSuccessMsg(null)} className="text-xs underline text-emerald-400">Đóng</button>
        </div>
      )}

      {activeTab === 'INSTALLATION' && (
        <div className="space-y-4">
          {data.installations.length === 0 ? (
            <div className="p-12 text-center rounded-xl bg-slate-900 border border-slate-800">
              <p className="text-slate-400 text-sm">Chưa có phân công lắp đặt nào đang hoạt động.</p>
            </div>
          ) : (
            data.installations.map((item) => {
              const allowedTransitions = ALLOWED_TRANSITIONS[item.status] || [];
              const canComplete =
                item.status === 'HANDOVER_PENDING' &&
                item.photos.length > 0 &&
                !!item.handoverRef;
              const isLoading = loadingId === item.id;

              return (
                <div
                  key={item.id}
                  className="p-6 rounded-xl bg-slate-900 border border-slate-800 space-y-4 shadow-lg"
                >
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-white text-base">
                          {item.customerName}
                        </span>
                        <span className="text-xs font-mono text-slate-400">
                          ({item.customerCode})
                        </span>
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        Mã đơn: <span className="font-mono text-cyan-400">{item.orderCode}</span> | Địa chỉ:{' '}
                        <span className="text-slate-300">{item.address}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <span
                        className={`px-3 py-1 rounded-full text-xs font-semibold ${
                          item.status === 'COMPLETED'
                            ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-700/60'
                            : item.status === 'HANDOVER_PENDING'
                            ? 'bg-purple-950/80 text-purple-300 border border-purple-700/60'
                            : item.status === 'INSTALLING'
                            ? 'bg-blue-950/80 text-blue-300 border border-blue-700/60'
                            : item.status === 'FAILED'
                            ? 'bg-rose-950/80 text-rose-300 border border-rose-700/60'
                            : 'bg-amber-950/80 text-amber-300 border border-amber-700/60'
                        }`}
                      >
                        {STATUS_LABELS[item.status] || item.status}
                      </span>
                    </div>
                  </div>

                  {/* Evidence status */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-slate-950/60 p-4 rounded-lg border border-slate-800/60">
                    <div>
                      <div className="text-xs font-medium text-slate-400 mb-2 flex items-center justify-between">
                        <span>Ảnh hiện trường ({item.photos.length})</span>
                        {item.status !== 'COMPLETED' && (
                          <label className="cursor-pointer text-xs text-cyan-400 hover:text-cyan-300 underline">
                            + Tải ảnh mới
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              disabled={isLoading}
                              onChange={(e) => handleFileUpload(item.id, 'PHOTO', e)}
                            />
                          </label>
                        )}
                      </div>
                      {item.photos.length === 0 ? (
                        <p className="text-xs text-slate-500 italic">Chưa có ảnh hiện trường được tải lên.</p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {item.photos.map((p, idx) => (
                            <span
                              key={idx}
                              className="px-2 py-0.5 rounded bg-slate-800 text-[10px] font-mono text-slate-300 truncate max-w-[200px]"
                              title={p}
                            >
                              Ảnh #{idx + 1}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="text-xs font-medium text-slate-400 mb-2 flex items-center justify-between">
                        <span>Biên bản nghiệm thu</span>
                        {item.status !== 'COMPLETED' && (
                          <label className="cursor-pointer text-xs text-cyan-400 hover:text-cyan-300 underline">
                            {item.handoverRef ? 'Thay thế biên bản' : '+ Tải biên bản (PDF/Ảnh)'}
                            <input
                              type="file"
                              accept="application/pdf,image/*"
                              className="hidden"
                              disabled={isLoading}
                              onChange={(e) => handleFileUpload(item.id, 'HANDOVER', e)}
                            />
                          </label>
                        )}
                      </div>
                      {item.handoverRef ? (
                        <div className="flex items-center gap-2">
                          <span className="inline-block w-2 h-2 rounded-full bg-emerald-400"></span>
                          <span className="text-xs text-emerald-300 font-mono truncate max-w-[240px]">
                            {item.handoverRef.split('/').pop()}
                          </span>
                        </div>
                      ) : (
                        <p className="text-xs text-amber-400/80 italic">Chưa tải biên bản nghiệm thu bàn giao.</p>
                      )}
                    </div>
                  </div>

                  {/* Actions Bar */}
                  {item.status !== 'COMPLETED' && (
                    <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-400">Chuyển trạng thái:</span>
                        {allowedTransitions.map((st) => (
                          <button
                            key={st}
                            disabled={isLoading}
                            onClick={() => handleStatusChange(item.id, st)}
                            className="px-2.5 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors disabled:opacity-50"
                          >
                            {STATUS_LABELS[st] || st}
                          </button>
                        ))}
                      </div>

                      <div>
                        {item.status === 'HANDOVER_PENDING' && (
                          <button
                            disabled={!canComplete || isLoading}
                            onClick={() => handleCompleteHandover(item.id)}
                            className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white shadow transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                            title={
                              !canComplete
                                ? 'Yêu cầu tối thiểu 1 ảnh hiện trường và 1 biên bản nghiệm thu'
                                : 'Xác nhận hoàn tất bàn giao đơn hàng'
                            }
                          >
                            {isLoading ? 'Đang xử lý...' : 'Nghiệm thu & Hoàn tất bàn giao'}
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {item.status === 'COMPLETED' && item.completedAt && (
                    <div className="text-xs text-emerald-400/90 bg-emerald-950/30 p-2.5 rounded border border-emerald-900/50">
                      Đã hoàn tất nghiệm thu & bàn giao lúc {new Date(item.completedAt).toLocaleString('vi-VN')}. Đơn hàng đã ở trạng thái COMPLETED.
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {activeTab === 'SURVEY' && (
        <div className="space-y-4">
          {data.surveys.length === 0 ? (
            <div className="p-12 text-center rounded-xl bg-slate-900 border border-slate-800">
              <p className="text-slate-400 text-sm">Chưa có phân công khảo sát nào.</p>
            </div>
          ) : (
            data.surveys.map((survey) => (
              <div
                key={survey.id}
                className="p-5 rounded-xl bg-slate-900 border border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-white">{survey.customerName}</span>
                    <span className="text-xs font-mono text-slate-400">({survey.customerCode})</span>
                  </div>
                  <div className="text-xs text-slate-400 mt-1">
                    Địa chỉ: <span className="text-slate-300">{survey.address}</span>
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    Thời gian: <span className="text-slate-300">{new Date(survey.startTime).toLocaleString('vi-VN')}</span>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <span
                    className={`px-3 py-1 rounded-full text-xs font-medium ${
                      survey.status === 'COMPLETED'
                        ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                        : survey.status === 'IN_PROGRESS'
                        ? 'bg-blue-950 text-blue-300 border border-blue-800'
                        : 'bg-amber-950 text-amber-300 border border-amber-800'
                    }`}
                  >
                    {STATUS_LABELS[survey.status] || survey.status}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
