'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  createWarrantyTicketAction,
  assignWarrantyTicketAction,
  updateWarrantyStatusAction,
  reopenWarrantyTicketAction,
} from '../actions';
import type {
  WarrantyDashboardData,
  WarrantyDashboardTicketItem,
  WarrantyEligibleOrder,
} from '../warranty-service';
import type { WarrantyTicketStatus } from '../types';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { EmptyState } from '@/components/ui/empty-state';
import { ShieldCheck, Plus, AlertCircle, CheckCircle2, UserCheck, Clock } from 'lucide-react';

interface WarrantyViewProps {
  initialData: WarrantyDashboardData;
}

export function WarrantyView({ initialData }: WarrantyViewProps) {
  const router = useRouter();
  const [data] = useState<WarrantyDashboardData>(initialData);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Modals
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [assigningTicket, setAssigningTicket] = useState<WarrantyDashboardTicketItem | null>(null);
  const [reopeningTicket, setReopeningTicket] = useState<WarrantyDashboardTicketItem | null>(null);

  // Form states
  const [selectedOrder, setSelectedOrder] = useState<WarrantyEligibleOrder | null>(null);
  const [issueText, setIssueText] = useState('');
  const [notesText, setNotesText] = useState('');

  const [selectedTechId, setSelectedTechId] = useState('');
  const [reopenReason, setReopenReason] = useState('');

  const STATUS_LABELS: Record<WarrantyTicketStatus, string> = {
    OPEN: 'Mới mở',
    ASSIGNED: 'Đã phân công',
    IN_PROGRESS: 'Đang xử lý',
    RESOLVED: 'Đã xử lý xong',
    CLOSED: 'Đã đóng phiếu',
    REOPENED: 'Đã mở lại',
    CANCELLED: 'Đã hủy',
    FAILED: 'Thất bại',
  };

  const VALID_TRANSITIONS: Record<WarrantyTicketStatus, WarrantyTicketStatus[]> = {
    OPEN: ['ASSIGNED', 'CANCELLED'],
    ASSIGNED: ['IN_PROGRESS', 'OPEN', 'CANCELLED'],
    IN_PROGRESS: ['RESOLVED', 'FAILED'],
    RESOLVED: ['CLOSED', 'REOPENED'],
    CLOSED: ['REOPENED'],
    REOPENED: ['ASSIGNED', 'IN_PROGRESS'],
    CANCELLED: [],
    FAILED: [],
  };

  const getStatusBadgeVariant = (st: WarrantyTicketStatus): 'neutral' | 'success' | 'warning' | 'danger' | 'info' => {
    switch (st) {
      case 'CLOSED':
      case 'RESOLVED':
        return 'success';
      case 'IN_PROGRESS':
        return 'info';
      case 'OPEN':
      case 'ASSIGNED':
      case 'REOPENED':
        return 'warning';
      case 'CANCELLED':
      case 'FAILED':
        return 'danger';
      default:
        return 'neutral';
    }
  };

  const handleCreateTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrder || !issueText.trim()) {
      setErrorMsg('Vui lòng chọn đơn hàng và nhập mô tả sự cố.');
      return;
    }

    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await createWarrantyTicketAction({
        customerId: selectedOrder.customerId,
        orderId: selectedOrder.id,
        issue: issueText.trim(),
        notes: notesText.trim() || undefined,
      });

      if (!res.success) {
        setErrorMsg(res.error || 'Tạo phiếu bảo hành thất bại');
      } else {
        setSuccessMsg('Đã mở phiếu bảo hành mới thành công!');
        setShowCreateModal(false);
        setSelectedOrder(null);
        setIssueText('');
        setNotesText('');
        router.refresh();
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Lỗi xử lý';
      setErrorMsg(message);
    } finally {
      setLoading(false);
    }
  };

  const handleAssignTechnician = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assigningTicket || !selectedTechId) {
      setErrorMsg('Vui lòng chọn kỹ thuật viên.');
      return;
    }

    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await assignWarrantyTicketAction({
        ticketId: assigningTicket.id,
        technicianId: selectedTechId,
      });

      if (!res.success) {
        setErrorMsg(res.error || 'Phân công kỹ thuật viên thất bại');
      } else {
        setSuccessMsg('Phân công kỹ thuật viên thành công!');
        setAssigningTicket(null);
        setSelectedTechId('');
        router.refresh();
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Lỗi xử lý';
      setErrorMsg(message);
    } finally {
      setLoading(false);
    }
  };

  const handleReopenTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reopeningTicket || !reopenReason.trim()) {
      setErrorMsg('Vui lòng nhập lý do mở lại phiếu bảo hành.');
      return;
    }

    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await reopenWarrantyTicketAction({
        ticketId: reopeningTicket.id,
        reason: reopenReason.trim(),
      });

      if (!res.success) {
        setErrorMsg(res.error || 'Mở lại phiếu bảo hành thất bại');
      } else {
        setSuccessMsg('Đã mở lại phiếu bảo hành thành công!');
        setReopeningTicket(null);
        setReopenReason('');
        router.refresh();
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Lỗi xử lý';
      setErrorMsg(message);
    } finally {
      setLoading(false);
    }
  };

  const handleStatusTransition = async (ticket: WarrantyDashboardTicketItem, nextStatus: WarrantyTicketStatus) => {
    if (nextStatus === 'REOPENED') {
      setReopeningTicket(ticket);
      return;
    }

    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await updateWarrantyStatusAction({
        ticketId: ticket.id,
        status: nextStatus,
      });

      if (!res.success) {
        setErrorMsg(res.error || 'Cập nhật trạng thái bảo hành thất bại');
      } else {
        setSuccessMsg(`Đã cập nhật trạng thái phiếu sang "${STATUS_LABELS[nextStatus] || nextStatus}"`);
        router.refresh();
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Lỗi xử lý';
      setErrorMsg(message);
    } finally {
      setLoading(false);
    }
  };

  const canCreateTicket = ['BOSS_ADMIN', 'SALE'].includes(data.role);
  const isBoss = data.role === 'BOSS_ADMIN';
  const isTech = data.role === 'TECHNICIAN';

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Vận hành', href: '/field' },
          { label: 'Bảo hành & Hậu mãi' },
        ]}
        title="Quản lý Bảo hành & Hậu mãi"
        description="Tiếp nhận sự cố, phân công kỹ thuật viên xử lý và quản lý vòng đời phiếu bảo hành."
        primaryAction={
          <div className="flex items-center gap-3">
            <Badge variant="neutral">
              Vai trò: {data.role}
            </Badge>
            {canCreateTicket && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => setShowCreateModal(true)}
              >
                <Plus className="w-4 h-4 mr-1.5" />
                Tiếp nhận bảo hành
              </Button>
            )}
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

      {data.tickets.length === 0 ? (
        <Card className="p-12 text-center">
          <EmptyState
            icon={<ShieldCheck className="w-8 h-8 text-text-tertiary" />}
            title="Chưa có phiếu bảo hành"
            description={
              isTech
                ? 'Bạn không có phiếu bảo hành nào được phân công.'
                : 'Chưa có phiếu bảo hành nào trong hệ thống.'
            }
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {data.tickets.map((t) => {
            const rawTransitions = VALID_TRANSITIONS[t.status] || [];
            const transitions = rawTransitions.filter((st) => {
              if (isBoss) return true;
              if (isTech) return ['IN_PROGRESS', 'RESOLVED', 'FAILED'].includes(st);
              if (data.role === 'SALE') return st === 'REOPENED';
              return false;
            });

            return (
              <Card
                key={t.id}
                className="p-5 space-y-4 hover:border-border-strong transition-colors"
              >
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 border-b border-border-subtle pb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-text-primary text-base">{t.customerName}</span>
                      <span className="text-xs font-mono text-text-tertiary">({t.customerCode})</span>
                    </div>
                    <div className="text-xs text-text-secondary mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span>Đơn hàng: <strong className="font-mono text-accent">{t.orderCode}</strong></span>
                      <span className="text-border-strong">•</span>
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3 text-text-tertiary" />
                        Mở lúc: {new Date(t.openedAt).toLocaleString('vi-VN')}
                      </span>
                      {t.resolvedAt && (
                        <>
                          <span className="text-border-strong">•</span>
                          <span className="text-emerald-700">Giải quyết lúc: {new Date(t.resolvedAt).toLocaleString('vi-VN')}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <Badge variant={getStatusBadgeVariant(t.status)}>
                      {STATUS_LABELS[t.status] || t.status}
                    </Badge>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-surface-secondary p-4 rounded-lg border border-border-subtle text-xs">
                  <div>
                    <div className="text-text-tertiary font-medium mb-1">Mô tả sự cố:</div>
                    <div className="text-text-primary whitespace-pre-wrap leading-relaxed">{t.issue}</div>
                    {t.notes && (
                      <div className="mt-2 text-text-secondary">
                        <span className="font-medium text-text-tertiary">Ghi chú: </span>
                        <span>{t.notes}</span>
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="text-text-tertiary font-medium mb-1">Kỹ thuật viên phụ trách:</div>
                    <div className="flex items-center gap-2">
                      <span className="text-text-primary font-medium">
                        {t.assignedTechnicianName || 'Chưa phân công'}
                      </span>
                      {isBoss && ['OPEN', 'ASSIGNED', 'REOPENED'].includes(t.status) && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setAssigningTicket(t);
                            setSelectedTechId(t.assignedTo || '');
                          }}
                          className="h-6 text-[11px] px-2"
                        >
                          <UserCheck className="w-3 h-3 mr-1" />
                          {t.assignedTo ? 'Đổi KTV' : 'Phân công'}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Actions row */}
                {transitions.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <span className="text-xs text-text-tertiary">Chuyển trạng thái:</span>
                    {transitions.map((st) => (
                      <Button
                        key={st}
                        variant="secondary"
                        size="sm"
                        disabled={loading}
                        onClick={() => handleStatusTransition(t, st)}
                      >
                        {STATUS_LABELS[st] || st}
                      </Button>
                    ))}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* CREATE TICKET MODAL */}
      <Modal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        title="Mở phiếu tiếp nhận bảo hành"
        description="Chọn đơn hàng đã hoàn tất nghiệm thu và mô tả sự cố kỹ thuật."
        size="md"
      >
        <form onSubmit={handleCreateTicket} className="space-y-4 text-xs">
          <div>
            <label className="block text-text-secondary font-medium mb-1">
              Chọn đơn hàng hoàn tất (COMPLETED): <span className="text-danger">*</span>
            </label>
            {data.eligibleOrders.length === 0 ? (
              <p className="text-amber-700 text-xs italic bg-amber-50 p-2.5 rounded-lg border border-amber-200">
                Không có đơn hàng nào đã hoàn tất nghiệm thu (COMPLETED) trong tổ chức.
              </p>
            ) : (
              <select
                className="w-full bg-surface-primary border border-border-subtle rounded-lg p-2.5 text-text-primary text-xs focus:outline-none focus:border-accent"
                value={selectedOrder?.id || ''}
                onChange={(e) => {
                  const found = data.eligibleOrders.find((o) => o.id === e.target.value);
                  setSelectedOrder(found || null);
                }}
                required
              >
                <option value="">-- Chọn đơn hàng --</option>
                {data.eligibleOrders.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.code} - {o.customerName} ({o.customerCode})
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label className="block text-text-secondary font-medium mb-1">
              Mô tả sự cố: <span className="text-danger">*</span>
            </label>
            <textarea
              className="w-full bg-surface-primary border border-border-subtle rounded-lg p-2.5 text-text-primary text-xs focus:outline-none focus:border-accent resize-none"
              rows={3}
              value={issueText}
              onChange={(e) => setIssueText(e.target.value)}
              placeholder="Mô tả chi tiết hiện tượng lỗi/sự cố của khách hàng..."
              required
            />
          </div>

          <div>
            <label className="block text-text-secondary font-medium mb-1">Ghi chú thêm (tùy chọn):</label>
            <input
              type="text"
              className="w-full bg-surface-primary border border-border-subtle rounded-lg p-2.5 text-text-primary text-xs focus:outline-none focus:border-accent"
              value={notesText}
              onChange={(e) => setNotesText(e.target.value)}
              placeholder="Ghi chú hẹn giờ, phản ánh của khách..."
            />
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-border-subtle">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setShowCreateModal(false)}
              disabled={loading}
            >
              Hủy
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={loading || !selectedOrder || !issueText.trim()}
            >
              {loading ? 'Đang tạo...' : 'Tạo phiếu'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ASSIGN TECH MODAL */}
      <Modal
        isOpen={!!assigningTicket}
        onClose={() => setAssigningTicket(null)}
        title="Phân công Kỹ thuật viên"
        description={assigningTicket ? `Phiếu bảo hành: ${assigningTicket.orderCode}` : undefined}
        size="sm"
      >
        <form onSubmit={handleAssignTechnician} className="space-y-4 text-xs">
          <div>
            <label className="block text-text-secondary font-medium mb-1">
              Chọn kỹ thuật viên: <span className="text-danger">*</span>
            </label>
            {data.technicians.length === 0 ? (
              <p className="text-amber-700 text-xs italic bg-amber-50 p-2.5 rounded-lg border border-amber-200">
                Chưa có kỹ thuật viên nào trong tổ chức.
              </p>
            ) : (
              <select
                className="w-full bg-surface-primary border border-border-subtle rounded-lg p-2.5 text-text-primary text-xs focus:outline-none focus:border-accent"
                value={selectedTechId}
                onChange={(e) => setSelectedTechId(e.target.value)}
                required
              >
                <option value="">-- Chọn kỹ thuật viên --</option>
                {data.technicians.map((t) => (
                  <option key={t.userId} value={t.userId}>
                    {t.fullName}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-border-subtle">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setAssigningTicket(null)}
              disabled={loading}
            >
              Hủy
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={loading || !selectedTechId}
            >
              {loading ? 'Đang phân công...' : 'Xác nhận'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* REOPEN MODAL */}
      <Modal
        isOpen={!!reopeningTicket}
        onClose={() => setReopeningTicket(null)}
        title="Mở lại phiếu bảo hành"
        description="Nhập lý do khách phản hồi để mở lại quy trình xử lý bảo hành."
        size="sm"
      >
        <form onSubmit={handleReopenTicket} className="space-y-4 text-xs">
          <div>
            <label className="block text-text-secondary font-medium mb-1">
              Lý do mở lại: <span className="text-danger">*</span>
            </label>
            <textarea
              className="w-full bg-surface-primary border border-border-subtle rounded-lg p-2.5 text-text-primary text-xs focus:outline-none focus:border-accent resize-none"
              rows={3}
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              placeholder="Khách phản hồi sự cố tái diễn..."
              required
            />
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-border-subtle">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setReopeningTicket(null)}
              disabled={loading}
            >
              Hủy
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={loading || !reopenReason.trim()}
            >
              {loading ? 'Đang xử lý...' : 'Mở lại'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
