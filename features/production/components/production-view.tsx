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
import { Card } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { CheckCircle2 } from 'lucide-react';

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
    <div className="space-y-8">
      {/* SECTION 1: ELIGIBLE ORDERS FOR PRODUCTION */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">
              1. Đơn hàng đủ điều kiện sản xuất
            </h2>
            <p className="text-xs text-[var(--text-secondary)]">
              Đơn hàng đã ký hợp đồng kinh tế và có thông số kỹ thuật/vật tư chuẩn từ khảo sát và chính sách giá.
            </p>
          </div>
          <Badge variant="neutral" size="sm" className="font-mono">
            {data.eligibleOrders.length} đơn hàng chờ
          </Badge>
        </div>

        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[120px]">Mã Đơn Hàng</TableHead>
                <TableHead>Khách Hàng</TableHead>
                <TableHead>Thông Số Kỹ Thuật (Specs)</TableHead>
                <TableHead>Vật Tư Chuẩn (Materials)</TableHead>
                <TableHead className="text-center">Trạng Thái HĐ</TableHead>
                <TableHead className="text-center">Tác Vụ Xuất Xưởng</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.eligibleOrders.map((order) => {
                return (
                  <TableRow key={order.id}>
                    <TableCell className="font-mono text-xs font-semibold text-blue-600">
                      {order.orderCode}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium text-[var(--text-primary)]">{order.customerName}</div>
                      <div className="text-xs text-[var(--text-tertiary)] font-mono">
                        {order.customerCode || order.id.slice(0, 8)}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs font-mono">
                      {order.canonicalSpecs ? (
                        <div className="space-y-0.5 text-[var(--text-secondary)]">
                          <div>Kích thước: <strong className="text-[var(--text-primary)]">{String(order.canonicalSpecs.dimensions || '')}</strong></div>
                          {Boolean(order.canonicalSpecs.gate_type) && (
                            <div className="text-[var(--text-tertiary)]">Loại cửa: {String(order.canonicalSpecs.gate_type)}</div>
                          )}
                          {Boolean(order.canonicalSpecs.mounting_method) && (
                            <div className="text-[var(--text-tertiary)]">Lắp ráp: {String(order.canonicalSpecs.mounting_method)}</div>
                          )}
                        </div>
                      ) : (
                        <span className="text-rose-600 font-medium">Thiếu thông số</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {order.canonicalMaterials ? (
                        <div className="max-w-[200px] text-[var(--text-secondary)] font-mono truncate" title={JSON.stringify(order.canonicalMaterials)}>
                          {Object.entries(order.canonicalMaterials).map(([k, v]) => `${k}: ${v}`).join(', ')}
                        </div>
                      ) : (
                        <span className="text-rose-600 font-medium">Thiếu vật tư</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      {order.isContractSigned ? (
                        <Badge variant="success" size="sm">
                          HĐ ĐÃ KÝ
                        </Badge>
                      ) : (
                        <Badge variant="warning" size="sm">
                          CHƯA KÝ HĐ
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      {order.canRelease ? (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => handleOpenReleaseModal(order)}
                          className="text-xs"
                        >
                          Xuất xưởng sản xuất
                        </Button>
                      ) : (
                        <div className="flex flex-col items-center">
                          <Badge variant="danger" size="sm">
                            CẦN BỔ SUNG THÔNG TIN
                          </Badge>
                          <span className="text-[10px] text-[var(--text-tertiary)] mt-1 max-w-[180px] leading-tight">
                            {order.releaseBlockReason}
                          </span>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}

              {data.eligibleOrders.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-[var(--text-tertiary)]">
                    Chưa có đơn hàng nào chờ xuất xưởng.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      </div>

      {/* SECTION 2: PRODUCTION ORDERS IN PROGRESS */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">
              2. Tiến độ lệnh sản xuất tại xưởng
            </h2>
            <p className="text-xs text-[var(--text-secondary)]">
              Quản lý quy trình gia công xưởng và kiểm tra chất lượng (QC) tuân thủ State Machine.
            </p>
          </div>
          <Badge variant="neutral" size="sm" className="font-mono">
            {data.productionOrders.length} lệnh xưởng
          </Badge>
        </div>

        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px]">Mã Đơn / Khách Hàng</TableHead>
                <TableHead>Thông Số Kỹ Thuật</TableHead>
                <TableHead>Vật Tư</TableHead>
                <TableHead className="text-center">Trạng Thái Xưởng</TableHead>
                <TableHead className="text-center">Trạng Thái QC</TableHead>
                <TableHead>Hạn Giao Hàng</TableHead>
                <TableHead className="text-center">Tác Vụ Tiến Độ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.productionOrders.map((p) => {
                const isLoading = loadingAction === `progress_${p.id}` || loadingAction === `qc_${p.id}`;

                return (
                  <TableRow key={p.id}>
                    <TableCell>
                      <div className="font-mono text-xs font-semibold text-blue-600">{p.orderCode}</div>
                      <div className="text-[var(--text-primary)] text-xs font-medium">{p.customerName}</div>
                    </TableCell>
                    <TableCell className="text-xs font-mono text-[var(--text-secondary)]">
                      <div>Kích thước: <strong className="text-[var(--text-primary)]">{String(p.specs?.dimensions || '')}</strong></div>
                      {Boolean(p.specs?.gate_type) && <div>Loại: {String(p.specs.gate_type)}</div>}
                    </TableCell>
                    <TableCell className="text-xs font-mono text-[var(--text-secondary)] max-w-[180px] truncate" title={JSON.stringify(p.materials)}>
                      {Object.entries(p.materials || {}).map(([k, v]) => `${k}: ${v}`).join(', ')}
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant="neutral" size="sm" className="font-mono">
                        {p.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge
                        variant={
                          p.qcStatus === 'PASSED'
                            ? 'success'
                            : p.qcStatus === 'REWORK_REQUIRED'
                            ? 'warning'
                            : p.qcStatus === 'REJECTED'
                            ? 'danger'
                            : 'neutral'
                        }
                        size="sm"
                      >
                        {p.qcStatus}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-[var(--text-secondary)]">
                      {new Date(p.deadline).toLocaleString('vi-VN')}
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="flex items-center justify-center gap-1.5 flex-wrap">
                        {p.status === 'RELEASED_TO_FACTORY' && (
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => handleUpdateProgress(p.id, 'IN_PRODUCTION')}
                            disabled={isLoading}
                            className="text-xs"
                          >
                            Bắt đầu gia công
                          </Button>
                        )}
                        {p.status === 'IN_PRODUCTION' && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleUpdateProgress(p.id, 'QC_IN_PROGRESS')}
                            disabled={isLoading}
                            className="text-xs bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100"
                          >
                            Chuyển sang QC
                          </Button>
                        )}
                        {p.status === 'QC_IN_PROGRESS' && (
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => {
                              setQcModalOrder(p);
                              setQcStatus('PASSED');
                              setQcNotes('');
                            }}
                            disabled={isLoading}
                            className="text-xs bg-purple-600 hover:bg-purple-700"
                          >
                            Đánh giá QC
                          </Button>
                        )}
                        {p.status === 'QC_FAILED' && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleUpdateProgress(p.id, 'IN_PRODUCTION')}
                            disabled={isLoading}
                            className="text-xs text-amber-700 hover:bg-amber-50"
                          >
                            Gia công lại
                          </Button>
                        )}
                        {p.status === 'QC_PASSED' && (
                          <span className="text-xs text-emerald-600 font-medium flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5 inline" />
                            Sẵn sàng bàn giao
                          </span>
                        )}
                        {p.status === 'READY_FOR_DISPATCH' && (
                          p.qcStatus === 'PASSED' && p.orderStatus === 'READY_FOR_INSTALL' && !p.installationId ? (
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => handleOpenScheduleModal(p)}
                              disabled={isLoading}
                              className="text-xs bg-emerald-600 hover:bg-emerald-700"
                            >
                              Lên lịch lắp đặt
                            </Button>
                          ) : p.installationId ? (
                            <span className="text-xs text-emerald-600 font-medium font-mono">
                              Đã lên lịch ({p.installationStatus || 'SCHEDULED'})
                            </span>
                          ) : (
                            <span className="text-xs text-blue-600 font-medium">Đã xuất xưởng</span>
                          )
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}

              {data.productionOrders.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-[var(--text-tertiary)]">
                    Chưa có lệnh sản xuất nào đang thực hiện.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      </div>

      {/* RELEASE ORDER MODAL */}
      {selectedEligibleOrder && (
        <Modal
          isOpen={true}
          onClose={() => setSelectedEligibleOrder(null)}
          title="Xuất xưởng lệnh sản xuất"
          size="md"
        >
          <div className="space-y-4">
            <div className="bg-[var(--surface-secondary)] p-3 rounded-lg border border-[var(--border-subtle)] text-xs space-y-1.5">
              <div>
                Đơn hàng: <strong className="text-blue-600 font-mono">{selectedEligibleOrder.orderCode}</strong> ({selectedEligibleOrder.customerName})
              </div>
              <div>
                Thông số kỹ thuật chuẩn: <strong className="text-[var(--text-primary)]">{String(selectedEligibleOrder.canonicalSpecs?.dimensions || '')}</strong>
              </div>
              <div className="text-[var(--text-secondary)] truncate">
                Vật tư chuẩn: {Object.entries(selectedEligibleOrder.canonicalMaterials || {}).map(([k, v]) => `${k}: ${v}`).join(', ')}
              </div>
              <div className="text-[11px] text-emerald-600 font-medium flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5 inline" />
                Hợp đồng kinh tế đã ký kết hợp lệ
              </div>
            </div>

            <form onSubmit={handleReleaseSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-[var(--text-primary)] mb-1">
                  Thời hạn hoàn thành sản xuất (Deadline) <span className="text-rose-500">*</span>
                </label>
                <Input
                  type="datetime-local"
                  required
                  value={deadlineInput}
                  onChange={(e) => setDeadlineInput(e.target.value)}
                  className="font-mono text-sm"
                />
                <p className="text-[11px] text-[var(--text-tertiary)] mt-1">
                  Thông số sản xuất do máy chủ tải tự động từ khảo sát/hợp đồng. Trình duyệt không can thiệp thông số kỹ thuật.
                </p>
              </div>

              {feedback && (
                <div
                  className={`p-3 rounded-lg text-xs ${
                    feedback.type === 'success'
                      ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                      : 'bg-rose-50 border border-rose-200 text-rose-800'
                  }`}
                >
                  {feedback.message}
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setSelectedEligibleOrder(null)}
                  disabled={loadingAction !== null}
                >
                  Hủy
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={loadingAction !== null || !deadlineInput}
                  isLoading={loadingAction !== null}
                >
                  Phê duyệt xuất xưởng
                </Button>
              </div>
            </form>
          </div>
        </Modal>
      )}

      {/* QC EVALUATION MODAL */}
      {qcModalOrder && (
        <Modal
          isOpen={true}
          onClose={() => setQcModalOrder(null)}
          title="Ghi nhận đánh giá kiểm tra chất lượng (QC)"
          size="md"
        >
          <form onSubmit={handleQcSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-[var(--text-primary)] mb-1">
                Kết quả kiểm tra <span className="text-rose-500">*</span>
              </label>
              <select
                value={qcStatus}
                onChange={(e) => setQcStatus(e.target.value as QCStatus)}
                className="w-full bg-[var(--surface-primary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm focus:outline-none focus:border-blue-500"
              >
                <option value="PASSED">PASSED (Đạt tiêu chuẩn xuất xưởng)</option>
                <option value="REWORK_REQUIRED">REWORK_REQUIRED (Yêu cầu gia công lại)</option>
                <option value="REJECTED">REJECTED (Loại bỏ / Lỗi hỏng)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-[var(--text-primary)] mb-1">
                Ghi chú kiểm định
              </label>
              <textarea
                rows={3}
                value={qcNotes}
                onChange={(e) => setQcNotes(e.target.value)}
                placeholder="Ghi chú chi tiết kết quả đo đạc độ kín nước, sai số..."
                className="w-full bg-[var(--surface-primary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-xs focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setQcModalOrder(null)}
                disabled={loadingAction !== null}
              >
                Hủy
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={loadingAction !== null}
                isLoading={loadingAction !== null}
                className="bg-purple-600 hover:bg-purple-700"
              >
                Lưu kết quả QC
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {/* SCHEDULE INSTALLATION MODAL */}
      {selectedScheduleOrder && (
        <Modal
          isOpen={true}
          onClose={() => setSelectedScheduleOrder(null)}
          title={`Lên lịch lắp đặt — Đơn hàng ${selectedScheduleOrder.orderCode}`}
          size="md"
        >
          <div className="space-y-4">
            {feedback && (
              <div
                className={`p-3 rounded-lg text-xs font-medium ${
                  feedback.type === 'success'
                    ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                    : 'bg-rose-50 border border-rose-200 text-rose-800'
                }`}
              >
                {feedback.message}
              </div>
            )}

            <form onSubmit={handleScheduleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-[var(--text-primary)] mb-1">
                  Kỹ thuật viên phụ trách <span className="text-rose-500">*</span>
                </label>
                {data.technicians.length === 0 ? (
                  <p className="text-xs text-amber-600 italic">Không có kỹ thuật viên khả dụng trong hệ thống.</p>
                ) : (
                  <select
                    value={scheduleTechId}
                    onChange={(e) => setScheduleTechId(e.target.value)}
                    className="w-full bg-[var(--surface-primary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm focus:outline-none focus:border-emerald-500"
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
                <label className="block text-xs font-medium text-[var(--text-primary)] mb-1">
                  Thời gian bắt đầu lắp đặt <span className="text-rose-500">*</span>
                </label>
                <Input
                  type="datetime-local"
                  value={scheduleStartTime}
                  onChange={(e) => setScheduleStartTime(e.target.value)}
                  className="text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-[var(--text-primary)] mb-1">
                  Địa chỉ lắp đặt <span className="text-rose-500">*</span>
                </label>
                <Input
                  type="text"
                  value={scheduleAddress}
                  onChange={(e) => setScheduleAddress(e.target.value)}
                  placeholder="Nhập địa chỉ công trình thực tế..."
                  className="text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-[var(--text-primary)] mb-1">
                  Đội thợ thi công (crew) <span className="text-rose-500">*</span>
                </label>
                <Input
                  type="text"
                  value={scheduleCrew}
                  onChange={(e) => setScheduleCrew(e.target.value)}
                  placeholder="Danh sách thợ, phân cách bằng dấu phẩy..."
                  className="text-sm"
                />
                <p className="text-[11px] text-[var(--text-tertiary)] mt-1">Phân tách tên các thành viên đội thợ bằng dấu phẩy (,)</p>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setSelectedScheduleOrder(null)}
                  disabled={loadingAction !== null}
                >
                  Hủy
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={loadingAction !== null || data.technicians.length === 0}
                  isLoading={loadingAction !== null}
                  className="bg-emerald-600 hover:bg-emerald-700"
                >
                  Xác nhận lên lịch lắp đặt
                </Button>
              </div>
            </form>
          </div>
        </Modal>
      )}
    </div>
  );
}
