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
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Quản lý Bảo hành & Hậu mãi</h1>
          <p className="text-sm text-slate-400">
            Tiếp nhận sự cố, phân công kỹ thuật viên xử lý và quản lý vòng đời phiếu bảo hành.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs font-mono text-cyan-400">
            Vai trò: {data.role}
          </span>
          {canCreateTicket && (
            <button
              onClick={() => setShowCreateModal(true)}
              className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium text-xs shadow-lg transition-all"
            >
              + Tiếp nhận bảo hành
            </button>
          )}
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

      {data.tickets.length === 0 ? (
        <div className="p-12 text-center rounded-xl bg-slate-900 border border-slate-800">
          <p className="text-slate-400 text-sm">
            {isTech ? 'Bạn không có phiếu bảo hành nào được phân công.' : 'Chưa có phiếu bảo hành nào trong hệ thống.'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {data.tickets.map((t) => {
            const rawTransitions = VALID_TRANSITIONS[t.status] || [];
            // Role filtering for transitions:
            // BOSS_ADMIN can do all valid transitions.
            // SALE can only reopen when resolved/closed.
            // TECHNICIAN can do IN_PROGRESS, RESOLVED, FAILED.
            const transitions = rawTransitions.filter((st) => {
              if (isBoss) return true;
              if (isTech) return ['IN_PROGRESS', 'RESOLVED', 'FAILED'].includes(st);
              if (data.role === 'SALE') return st === 'REOPENED';
              return false;
            });

            return (
              <div
                key={t.id}
                className="p-6 rounded-xl bg-slate-900 border border-slate-800 space-y-4 shadow-lg"
              >
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-white text-base">{t.customerName}</span>
                      <span className="text-xs font-mono text-slate-400">({t.customerCode})</span>
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">
                      Đơn hàng: <span className="font-mono text-cyan-400">{t.orderCode}</span> | Mở lúc:{' '}
                      <span className="text-slate-300">{new Date(t.openedAt).toLocaleString('vi-VN')}</span>
                      {t.resolvedAt && (
                        <span> | Đã giải quyết lúc: {new Date(t.resolvedAt).toLocaleString('vi-VN')}</span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <span
                      className={`px-3 py-1 rounded-full text-xs font-semibold ${
                        t.status === 'CLOSED'
                          ? 'bg-emerald-950 text-emerald-300 border border-emerald-700'
                          : t.status === 'RESOLVED'
                          ? 'bg-blue-950 text-blue-300 border border-blue-700'
                          : t.status === 'IN_PROGRESS'
                          ? 'bg-amber-950 text-amber-300 border border-amber-700'
                          : t.status === 'REOPENED'
                          ? 'bg-purple-950 text-purple-300 border border-purple-700'
                          : t.status === 'CANCELLED' || t.status === 'FAILED'
                          ? 'bg-rose-950 text-rose-300 border border-rose-700'
                          : 'bg-slate-800 text-slate-300 border border-slate-700'
                      }`}
                    >
                      {STATUS_LABELS[t.status] || t.status}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-slate-950/60 p-4 rounded-lg border border-slate-800/60 text-xs">
                  <div>
                    <div className="text-slate-400 font-medium mb-1">Mô tả sự cố:</div>
                    <div className="text-slate-200 whitespace-pre-wrap">{t.issue}</div>
                    {t.notes && (
                      <div className="mt-2 text-slate-400">
                        <span className="font-medium text-slate-400">Ghi chú: </span>
                        <span className="text-slate-300">{t.notes}</span>
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="text-slate-400 font-medium mb-1">Kỹ thuật viên phụ trách:</div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-200">
                        {t.assignedTechnicianName || 'Chưa phân công'}
                      </span>
                      {isBoss && ['OPEN', 'ASSIGNED', 'REOPENED'].includes(t.status) && (
                        <button
                          onClick={() => {
                            setAssigningTicket(t);
                            setSelectedTechId(t.assignedTo || '');
                          }}
                          className="px-2 py-0.5 text-[11px] rounded bg-slate-800 hover:bg-slate-700 text-cyan-400 border border-slate-700"
                        >
                          {t.assignedTo ? 'Đổi KTV' : 'Phân công'}
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Actions row */}
                {transitions.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <span className="text-xs text-slate-400">Chuyển trạng thái:</span>
                    {transitions.map((st) => (
                      <button
                        key={st}
                        disabled={loading}
                        onClick={() => handleStatusTransition(t, st)}
                        className="px-2.5 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors disabled:opacity-50"
                      >
                        {STATUS_LABELS[st] || st}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* CREATE TICKET MODAL */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl bg-slate-900 border border-slate-800 p-6 space-y-4 shadow-2xl">
            <h2 className="text-lg font-bold text-white">Mở phiếu tiếp nhận bảo hành</h2>
            <form onSubmit={handleCreateTicket} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-300 font-medium mb-1">Chọn đơn hàng hoàn tất (COMPLETED):</label>
                {data.eligibleOrders.length === 0 ? (
                  <p className="text-amber-400 text-xs italic">
                    Không có đơn hàng nào đã hoàn tất nghiệm thu (COMPLETED) trong tổ chức.
                  </p>
                ) : (
                  <select
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200"
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
                <label className="block text-slate-300 font-medium mb-1">Mô tả sự cố:</label>
                <textarea
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200"
                  rows={3}
                  value={issueText}
                  onChange={(e) => setIssueText(e.target.value)}
                  placeholder="Mô tả chi tiết hiện tượng lỗi/sự cố của khách hàng..."
                  required
                />
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1">Ghi chú thêm (tùy chọn):</label>
                <input
                  type="text"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200"
                  value={notesText}
                  onChange={(e) => setNotesText(e.target.value)}
                  placeholder="Ghi chú hẹn giờ, phản ánh của khách..."
                />
              </div>

              <div className="flex justify-end gap-3 pt-3">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  disabled={loading}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={loading || !selectedOrder || !issueText.trim()}
                  className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium disabled:opacity-50"
                >
                  {loading ? 'Đang tạo...' : 'Tạo phiếu'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ASSIGN TECH MODAL */}
      {assigningTicket && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-800 p-6 space-y-4 shadow-2xl">
            <h2 className="text-lg font-bold text-white">Phân công Kỹ thuật viên</h2>
            <p className="text-xs text-slate-400">
              Phiếu bảo hành: <span className="text-white font-mono">{assigningTicket.orderCode}</span>
            </p>
            <form onSubmit={handleAssignTechnician} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-300 font-medium mb-1">Chọn kỹ thuật viên:</label>
                {data.technicians.length === 0 ? (
                  <p className="text-amber-400 text-xs italic">
                    Chưa có kỹ thuật viên nào trong tổ chức.
                  </p>
                ) : (
                  <select
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200"
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

              <div className="flex justify-end gap-3 pt-3">
                <button
                  type="button"
                  onClick={() => setAssigningTicket(null)}
                  disabled={loading}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={loading || !selectedTechId}
                  className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium disabled:opacity-50"
                >
                  {loading ? 'Đang phân công...' : 'Xác nhận'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* REOPEN MODAL */}
      {reopeningTicket && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-800 p-6 space-y-4 shadow-2xl">
            <h2 className="text-lg font-bold text-white">Mở lại phiếu bảo hành</h2>
            <form onSubmit={handleReopenTicket} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-300 font-medium mb-1">Lý do mở lại:</label>
                <textarea
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200"
                  rows={3}
                  value={reopenReason}
                  onChange={(e) => setReopenReason(e.target.value)}
                  placeholder="Khách phản hồi sự cố tái diễn..."
                  required
                />
              </div>

              <div className="flex justify-end gap-3 pt-3">
                <button
                  type="button"
                  onClick={() => setReopeningTicket(null)}
                  disabled={loading}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={loading || !reopenReason.trim()}
                  className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-medium disabled:opacity-50"
                >
                  {loading ? 'Đang xử lý...' : 'Mở lại'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
