'use client';

import React, { useState, useTransition } from 'react';
import type { ProductionDashboardDTO, ProductionDashboardOrderDTO } from '../production-service';
import type { ProductionOrderDTO, QCStatus, SettableProductionStatus } from '../types';
import {
  releaseOrderToProductionAction,
  updateProductionProgressAction,
  recordQualityCheckAction,
} from '../actions';
import { createInstallationScheduleAction } from '@/features/installation/actions';

interface ProductionViewProps {
  initialData: ProductionDashboardDTO;
}

export default function ProductionView({ initialData }: ProductionViewProps) {
  const [data] = useState<ProductionDashboardDTO>(initialData);
  const [selectedEligibleOrder, setSelectedEligibleOrder] = useState<ProductionDashboardOrderDTO | null>(null);
  const [deadlineInput, setDeadlineInput] = useState<string>('');
  const [qcModalOrder, setQcModalOrder] = useState<ProductionOrderDTO | null>(null);
  const [qcStatus, setQcStatus] = useState<QCStatus>('PASSED');
  const [qcNotes, setQcNotes] = useState<string>('');
  const [selectedScheduleOrder, setSelectedScheduleOrder] = useState<ProductionDashboardDTO['productionOrders'][number] | null>(null);
  const [scheduleTechId, setScheduleTechId] = useState<string>('');
  const [scheduleStartTime, setScheduleStartTime] = useState<string>('');
  const [scheduleAddress, setScheduleAddress] = useState<string>('');
  const [scheduleCrew, setScheduleCrew] = useState<string>('');
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleOpenReleaseModal = (order: ProductionDashboardOrderDTO) => {
    setSelectedEligibleOrder(order);
    // Default deadline to 7 days from now
    const defaultDate = new Date();
    defaultDate.setDate(defaultDate.getDate() + 7);
    setDeadlineInput(defaultDate.toISOString().slice(0, 16));
    setFeedback(null);
  };

  const handleReleaseSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEligibleOrder || loadingAction || isPending) return;

    if (!deadlineInput) {
      setFeedback({ type: 'error', message: 'Vui lòng chọn thời hạn hoàn thành (deadline).' });
      return;
    }

    const isoDeadline = new Date(deadlineInput).toISOString();
    setLoadingAction(`release_${selectedEligibleOrder.id}`);
    setFeedback(null);

    startTransition(async () => {
      try {
        const res = await releaseOrderToProductionAction({
          orderId: selectedEligibleOrder.id,
          deadline: isoDeadline,
        });

        if (res.success && res.data) {
          setFeedback({
            type: 'success',
            message: 'Đã xuất xưởng sản xuất thành công!',
          });
          setTimeout(() => {
            setSelectedEligibleOrder(null);
            window.location.reload();
          }, 1200);
        } else {
          setFeedback({
            type: 'error',
            message: res.error || 'Không thể tạo lệnh xuất xưởng.',
          });
        }
      } catch (err: unknown) {
        setFeedback({
          type: 'error',
          message: err instanceof Error ? err.message : 'Lỗi hệ thống khi tạo lệnh sản xuất.',
        });
      } finally {
        setLoadingAction(null);
      }
    });
  };

  const handleUpdateProgress = (orderId: string, status: SettableProductionStatus) => {
    if (loadingAction || isPending) return;
    setLoadingAction(`progress_${orderId}`);

    startTransition(async () => {
      try {
        const res = await updateProductionProgressAction(orderId, status);
        if (res.success) {
          window.location.reload();
        } else {
          alert(res.error || 'Không thể cập nhật tiến độ sản xuất.');
        }
      } catch (err: unknown) {
        alert(err instanceof Error ? err.message : 'Lỗi cập nhật tiến độ.');
      } finally {
        setLoadingAction(null);
      }
    });
  };

  const handleQcSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!qcModalOrder || loadingAction || isPending) return;

    setLoadingAction(`qc_${qcModalOrder.id}`);
    startTransition(async () => {
      try {
        const res = await recordQualityCheckAction(
          qcModalOrder.id,
          qcStatus,
          qcNotes || undefined
        );

        if (res.success) {
          setQcModalOrder(null);
          window.location.reload();
        } else {
          alert(res.error || 'Không thể ghi nhận kết quả QC.');
        }
      } catch (err: unknown) {
        alert(err instanceof Error ? err.message : 'Lỗi ghi nhận QC.');
      } finally {
        setLoadingAction(null);
      }
    });
  };

  const handleOpenScheduleModal = (order: ProductionDashboardDTO['productionOrders'][number]) => {
    setSelectedScheduleOrder(order);
    const defaultTech = data.technicians[0]?.id || '';
    setScheduleTechId(defaultTech);
    const defaultDate = new Date();
    defaultDate.setDate(defaultDate.getDate() + 1);
    defaultDate.setHours(9, 0, 0, 0);
    setScheduleStartTime(defaultDate.toISOString().slice(0, 16));
    setScheduleAddress(order.customerAddress || '');
    setScheduleCrew(data.technicians[0]?.fullName || 'Đội thi công chính');
    setFeedback(null);
  };

  const handleScheduleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedScheduleOrder || loadingAction || isPending) return;

    if (!scheduleTechId) {
      setFeedback({ type: 'error', message: 'Vui lòng chọn kỹ thuật viên phụ trách.' });
      return;
    }
    if (!scheduleStartTime) {
      setFeedback({ type: 'error', message: 'Vui lòng chọn thời gian bắt đầu lắp đặt.' });
      return;
    }
    if (!scheduleAddress.trim()) {
      setFeedback({ type: 'error', message: 'Vui lòng nhập địa chỉ lắp đặt.' });
      return;
    }
    const crewList = scheduleCrew
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    if (crewList.length === 0) {
      setFeedback({ type: 'error', message: 'Vui lòng nhập ít nhất 1 người trong đội thợ.' });
      return;
    }

    setLoadingAction(`schedule_${selectedScheduleOrder.id}`);
    setFeedback(null);

    startTransition(async () => {
      try {
        const res = await createInstallationScheduleAction({
          orderId: selectedScheduleOrder.orderId,
          technicianId: scheduleTechId,
          startTime: new Date(scheduleStartTime).toISOString(),
          address: scheduleAddress.trim(),
          crew: crewList,
        });

        if (res.success && res.data) {
          setFeedback({
            type: 'success',
            message: res.data.idempotent
              ? 'Lịch lắp đặt đã tồn tại cho đơn hàng này.'
              : 'Đã lên lịch lắp đặt thành công!',
          });
          setTimeout(() => {
            setSelectedScheduleOrder(null);
            window.location.reload();
          }, 1200);
        } else {
          setFeedback({
            type: 'error',
            message: res.error || 'Không thể lên lịch lắp đặt.',
          });
        }
      } catch (err: unknown) {
        setFeedback({
          type: 'error',
          message: err instanceof Error ? err.message : 'Lỗi hệ thống khi lên lịch lắp đặt.',
        });
      } finally {
        setLoadingAction(null);
      }
    });
  };

  return (
    <div className="space-y-10">
      {/* SECTION 1: ELIGIBLE ORDERS FOR PRODUCTION */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">1. Đơn hàng đủ điều kiện sản xuất</h2>
            <p className="text-xs text-slate-400">
              Đơn hàng đã ký hợp đồng kinh tế và có thông số kỹ thuật/vật tư chuẩn từ khảo sát và chính sách giá.
            </p>
          </div>
          <span className="px-2.5 py-1 rounded bg-slate-800 text-xs text-slate-300 font-mono">
            {data.eligibleOrders.length} đơn hàng chờ
          </span>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900 shadow">
          <table className="min-w-full divide-y divide-slate-800 text-sm">
            <thead className="bg-slate-950/60 text-slate-400 text-xs uppercase font-medium">
              <tr>
                <th className="py-3 px-4 text-left">Mã Đơn Hàng</th>
                <th className="py-3 px-4 text-left">Khách Hàng</th>
                <th className="py-3 px-4 text-left">Thông Số Kỹ Thuật (Specs)</th>
                <th className="py-3 px-4 text-left">Vật Tư Chuẩn (Materials)</th>
                <th className="py-3 px-4 text-center">Trạng Thái HĐ</th>
                <th className="py-3 px-4 text-center">Tác Vụ Xuất Xưởng</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {data.eligibleOrders.map((order) => {
                return (
                  <tr key={order.id} className="hover:bg-slate-800/40 transition">
                    <td className="py-3 px-4 font-mono text-xs font-semibold text-blue-400">
                      {order.orderCode}
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-medium text-white">{order.customerName}</div>
                      <div className="text-xs text-slate-400 font-mono">
                        {order.customerCode || order.id.slice(0, 8)}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-xs font-mono">
                      {order.canonicalSpecs ? (
                        <div className="space-y-0.5 text-slate-300">
                          <div>Kích thước: <strong className="text-white">{String(order.canonicalSpecs.dimensions || '')}</strong></div>
                          {Boolean(order.canonicalSpecs.gate_type) && (
                            <div className="text-slate-400">Loại cửa: {String(order.canonicalSpecs.gate_type)}</div>
                          )}
                          {Boolean(order.canonicalSpecs.mounting_method) && (
                            <div className="text-slate-400">Lắp ráp: {String(order.canonicalSpecs.mounting_method)}</div>
                          )}
                        </div>
                      ) : (
                        <span className="text-rose-400">Thiếu thông số</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-xs">
                      {order.canonicalMaterials ? (
                        <div className="max-w-[200px] text-slate-300 font-mono truncate" title={JSON.stringify(order.canonicalMaterials)}>
                          {Object.entries(order.canonicalMaterials).map(([k, v]) => `${k}: ${v}`).join(', ')}
                        </div>
                      ) : (
                        <span className="text-rose-400">Thiếu vật tư</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-center">
                      {order.isContractSigned ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-emerald-950/70 border border-emerald-800 text-emerald-300">
                          HĐ ĐÃ KÝ
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-amber-950/70 border border-amber-800 text-amber-300">
                          CHƯA KÝ HĐ
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-center">
                      {order.canRelease ? (
                        <button
                          onClick={() => handleOpenReleaseModal(order)}
                          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-blue-600 hover:bg-blue-500 text-white transition shadow-sm"
                        >
                          Xuất xưởng sản xuất
                        </button>
                      ) : (
                        <div className="flex flex-col items-center">
                          <span className="px-2.5 py-1 rounded bg-slate-800 text-[11px] font-semibold text-rose-400 border border-rose-900/50">
                            CẦN BỔ SUNG THÔNG TIN
                          </span>
                          <span className="text-[10px] text-slate-400 mt-1 max-w-[180px] leading-tight">
                            {order.releaseBlockReason}
                          </span>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}

              {data.eligibleOrders.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-500">
                    Chưa có đơn hàng nào chờ xuất xưởng.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* SECTION 2: PRODUCTION ORDERS IN PROGRESS */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">2. Tiến độ lệnh sản xuất tại xưởng</h2>
            <p className="text-xs text-slate-400">
              Quản lý quy trình gia công xưởng và kiểm tra chất lượng (QC) tuân thủ State Machine.
            </p>
          </div>
          <span className="px-2.5 py-1 rounded bg-slate-800 text-xs text-slate-300 font-mono">
            {data.productionOrders.length} lệnh xưởng
          </span>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900 shadow">
          <table className="min-w-full divide-y divide-slate-800 text-sm">
            <thead className="bg-slate-950/60 text-slate-400 text-xs uppercase font-medium">
              <tr>
                <th className="py-3 px-4 text-left">Mã Đơn / Khách Hàng</th>
                <th className="py-3 px-4 text-left">Thông Số Kỹ Thuật</th>
                <th className="py-3 px-4 text-left">Vật Tư</th>
                <th className="py-3 px-4 text-center">Trạng Thái Xưởng</th>
                <th className="py-3 px-4 text-center">Trạng Thái QC</th>
                <th className="py-3 px-4 text-left">Hạn Giao Hàng</th>
                <th className="py-3 px-4 text-center">Tác Vụ Tiến Độ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {data.productionOrders.map((p) => {
                const isLoading = loadingAction === `progress_${p.id}` || loadingAction === `qc_${p.id}`;

                return (
                  <tr key={p.id} className="hover:bg-slate-800/40 transition">
                    <td className="py-3 px-4">
                      <div className="font-mono text-xs font-semibold text-blue-400">{p.orderCode}</div>
                      <div className="text-white text-xs">{p.customerName}</div>
                    </td>
                    <td className="py-3 px-4 text-xs font-mono text-slate-300">
                      <div>Kích thước: <strong className="text-white">{String(p.specs?.dimensions || '')}</strong></div>
                      {Boolean(p.specs?.gate_type) && <div>Loại: {String(p.specs.gate_type)}</div>}
                    </td>
                    <td className="py-3 px-4 text-xs font-mono text-slate-400 max-w-[180px] truncate" title={JSON.stringify(p.materials)}>
                      {Object.entries(p.materials || {}).map(([k, v]) => `${k}: ${v}`).join(', ')}
                    </td>
                    <td className="py-3 px-4 text-center">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-mono bg-slate-800 text-slate-300">
                        {p.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-center">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold ${
                          p.qcStatus === 'PASSED'
                            ? 'bg-emerald-950/70 border border-emerald-800 text-emerald-300'
                            : p.qcStatus === 'REWORK_REQUIRED'
                            ? 'bg-amber-950/70 border border-amber-800 text-amber-300'
                            : p.qcStatus === 'REJECTED'
                            ? 'bg-rose-950/70 border border-rose-800 text-rose-300'
                            : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {p.qcStatus}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-400">
                      {new Date(p.deadline).toLocaleString('vi-VN')}
                    </td>
                    <td className="py-3 px-4 text-center">
                      <div className="flex items-center justify-center gap-1.5 flex-wrap">
                        {p.status === 'RELEASED_TO_FACTORY' && (
                          <button
                            onClick={() => handleUpdateProgress(p.id, 'IN_PRODUCTION')}
                            disabled={isLoading}
                            className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white transition"
                          >
                            Bắt đầu gia công
                          </button>
                        )}
                        {p.status === 'IN_PRODUCTION' && (
                          <button
                            onClick={() => handleUpdateProgress(p.id, 'QC_IN_PROGRESS')}
                            disabled={isLoading}
                            className="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 text-xs font-medium text-white transition"
                          >
                            Chuyển sang QC
                          </button>
                        )}
                        {p.status === 'QC_IN_PROGRESS' && (
                          <button
                            onClick={() => {
                              setQcModalOrder(p);
                              setQcStatus('PASSED');
                              setQcNotes('');
                            }}
                            disabled={isLoading}
                            className="px-2.5 py-1 rounded bg-purple-600 hover:bg-purple-500 text-xs font-bold text-white transition"
                          >
                            Đánh giá QC
                          </button>
                        )}
                        {p.status === 'QC_FAILED' && (
                          <button
                            onClick={() => handleUpdateProgress(p.id, 'IN_PRODUCTION')}
                            disabled={isLoading}
                            className="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 text-xs font-medium text-white transition"
                          >
                            Gia công lại
                          </button>
                        )}
                        {p.status === 'QC_PASSED' && (
                          <span className="text-xs text-emerald-400 font-medium">✓ Sẵn sàng bàn giao</span>
                        )}
                        {p.status === 'READY_FOR_DISPATCH' && (
                          p.qcStatus === 'PASSED' && p.orderStatus === 'READY_FOR_INSTALL' && !p.installationId ? (
                            <button
                              onClick={() => handleOpenScheduleModal(p)}
                              disabled={isLoading}
                              className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-xs font-bold text-white transition shadow"
                            >
                              Lên lịch lắp đặt
                            </button>
                          ) : p.installationId ? (
                            <span className="text-xs text-emerald-400 font-medium font-mono">
                              Đã lên lịch ({p.installationStatus || 'SCHEDULED'})
                            </span>
                          ) : (
                            <span className="text-xs text-blue-400 font-medium">Đã xuất xưởng</span>
                          )
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}

              {data.productionOrders.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-500">
                    Chưa có lệnh sản xuất nào đang thực hiện.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* RELEASE ORDER MODAL */}
      {selectedEligibleOrder && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-5">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-lg font-bold text-white">Xuất xưởng lệnh sản xuất</h3>
              <button
                onClick={() => setSelectedEligibleOrder(null)}
                className="text-slate-400 hover:text-white text-lg font-bold"
              >
                &times;
              </button>
            </div>

            <div className="bg-slate-950 p-3 rounded-xl border border-slate-800/80 text-xs space-y-2">
              <div>
                Đơn hàng: <strong className="text-blue-400 font-mono">{selectedEligibleOrder.orderCode}</strong> ({selectedEligibleOrder.customerName})
              </div>
              <div>
                Thông số kỹ thuật chuẩn: <strong className="text-white">{String(selectedEligibleOrder.canonicalSpecs?.dimensions || '')}</strong>
              </div>
              <div className="text-slate-400 truncate">
                Vật tư chuẩn: {Object.entries(selectedEligibleOrder.canonicalMaterials || {}).map(([k, v]) => `${k}: ${v}`).join(', ')}
              </div>
              <div className="text-[11px] text-emerald-400 font-mono">
                ✓ Hợp đồng kinh tế đã ký kết hợp lệ
              </div>
            </div>

            <form onSubmit={handleReleaseSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Thời hạn hoàn thành sản xuất (Deadline) <span className="text-rose-400">*</span>
                </label>
                <input
                  type="datetime-local"
                  required
                  value={deadlineInput}
                  onChange={(e) => setDeadlineInput(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono text-sm focus:outline-none focus:border-blue-500"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Thông số sản xuất do máy chủ tải tự động từ khảo sát/hợp đồng. Trình duyệt không can thiệp thông số kỹ thuật.
                </p>
              </div>

              {feedback && (
                <div
                  className={`p-3 rounded-lg text-xs ${
                    feedback.type === 'success'
                      ? 'bg-emerald-950/80 border border-emerald-800 text-emerald-300'
                      : 'bg-rose-950/80 border border-rose-800 text-rose-300'
                  }`}
                >
                  {feedback.message}
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setSelectedEligibleOrder(null)}
                  disabled={loadingAction !== null}
                  className="px-4 py-2 rounded-lg text-xs font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 transition"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={loadingAction !== null || !deadlineInput}
                  className="px-4 py-2 rounded-lg text-xs font-bold bg-blue-600 hover:bg-blue-500 text-white transition disabled:opacity-50"
                >
                  {loadingAction ? 'Đang xuất xưởng...' : 'Phê duyệt xuất xưởng'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* QC EVALUATION MODAL */}
      {qcModalOrder && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-5">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-lg font-bold text-white">Ghi nhận đánh giá kiểm tra chất lượng (QC)</h3>
              <button
                onClick={() => setQcModalOrder(null)}
                className="text-slate-400 hover:text-white text-lg font-bold"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleQcSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Kết quả kiểm tra <span className="text-rose-400">*</span>
                </label>
                <select
                  value={qcStatus}
                  onChange={(e) => setQcStatus(e.target.value as QCStatus)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                >
                  <option value="PASSED">PASSED (Đạt tiêu chuẩn xuất xưởng)</option>
                  <option value="REWORK_REQUIRED">REWORK_REQUIRED (Yêu cầu gia công lại)</option>
                  <option value="REJECTED">REJECTED (Loại bỏ / Lỗi hỏng)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Ghi chú kiểm định
                </label>
                <textarea
                  rows={3}
                  value={qcNotes}
                  onChange={(e) => setQcNotes(e.target.value)}
                  placeholder="Ghi chú chi tiết kết quả đo đạc độ kín nước, sai số..."
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setQcModalOrder(null)}
                  disabled={loadingAction !== null}
                  className="px-4 py-2 rounded-lg text-xs font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 transition"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={loadingAction !== null}
                  className="px-4 py-2 rounded-lg text-xs font-bold bg-purple-600 hover:bg-purple-500 text-white transition disabled:opacity-50"
                >
                  {loadingAction ? 'Đang lưu...' : 'Lưu kết quả QC'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* SCHEDULE INSTALLATION MODAL */}
      {selectedScheduleOrder && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-5">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-lg font-bold text-white">
                Lên lịch lắp đặt — Đơn hàng {selectedScheduleOrder.orderCode}
              </h3>
              <button
                onClick={() => setSelectedScheduleOrder(null)}
                className="text-slate-400 hover:text-white text-lg"
              >
                ✕
              </button>
            </div>

            {feedback && (
              <div
                className={`p-3 rounded-lg text-xs font-medium ${
                  feedback.type === 'success'
                    ? 'bg-emerald-950/80 border border-emerald-800 text-emerald-300'
                    : 'bg-rose-950/80 border border-rose-800 text-rose-300'
                }`}
              >
                {feedback.message}
              </div>
            )}

            <form onSubmit={handleScheduleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Kỹ thuật viên phụ trách <span className="text-rose-400">*</span>
                </label>
                {data.technicians.length === 0 ? (
                  <p className="text-xs text-amber-400 italic">Không có kỹ thuật viên khả dụng trong hệ thống.</p>
                ) : (
                  <select
                    value={scheduleTechId}
                    onChange={(e) => setScheduleTechId(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
                  >
                    {data.technicians.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.fullName} ({t.id.slice(0, 8)})
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Thời gian bắt đầu lắp đặt <span className="text-rose-400">*</span>
                </label>
                <input
                  type="datetime-local"
                  value={scheduleStartTime}
                  onChange={(e) => setScheduleStartTime(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Địa chỉ lắp đặt <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  value={scheduleAddress}
                  onChange={(e) => setScheduleAddress(e.target.value)}
                  placeholder="Nhập địa chỉ công trình thực tế..."
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Đội thợ thi công (crew) <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  value={scheduleCrew}
                  onChange={(e) => setScheduleCrew(e.target.value)}
                  placeholder="Danh sách thợ, phân cách bằng dấu phẩy..."
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
                />
                <p className="text-[11px] text-slate-500 mt-1">Phân tách tên các thành viên đội thợ bằng dấu phẩy (,)</p>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setSelectedScheduleOrder(null)}
                  disabled={loadingAction !== null}
                  className="px-4 py-2 rounded-lg text-xs font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 transition"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={loadingAction !== null || data.technicians.length === 0}
                  className="px-4 py-2 rounded-lg text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white transition disabled:opacity-50"
                >
                  {loadingAction ? 'Đang xử lý...' : 'Xác nhận lên lịch lắp đặt'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
