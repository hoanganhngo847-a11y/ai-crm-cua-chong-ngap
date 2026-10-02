'use client';

import React, { useState, useTransition } from 'react';
import Link from 'next/link';
import type { OrderListItemDTO } from '../services';
import { updateOrderDepositAction } from '../actions';

interface OrdersViewProps {
  orders: OrderListItemDTO[];
  userRole: string;
}

export default function OrdersView({ orders, userRole }: OrdersViewProps) {
  const isBossAdmin = userRole === 'BOSS_ADMIN';
  const [selectedOrder, setSelectedOrder] = useState<OrderListItemDTO | null>(null);
  const [depositAmount, setDepositAmount] = useState<string>('');
  const [loadingOrderId, setLoadingOrderId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [isPending, startTransition] = useTransition();

  const handleOpenDepositModal = (order: OrderListItemDTO) => {
    setSelectedOrder(order);
    setDepositAmount('');
    setFeedback(null);
  };

  const handleDepositSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrder || loadingOrderId || isPending) return;

    const numAmount = Number(depositAmount);
    if (isNaN(numAmount) || numAmount <= 0) {
      setFeedback({ type: 'error', message: 'Vui lòng nhập số tiền cọc hợp lệ (lớn hơn 0).' });
      return;
    }

    // Stable client idempotency key for this logical submission
    const idempotencyKey = `manual_dep_${selectedOrder.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setLoadingOrderId(selectedOrder.id);
    setFeedback(null);

    startTransition(async () => {
      try {
        const res = await updateOrderDepositAction({
          orderId: selectedOrder.id,
          depositAmount: numAmount,
          idempotencyKey,
        });

        if (res.success) {
          setFeedback({
            type: 'success',
            message: `Ghi nhận tiền cọc thành công! ${(res.data as { depositConfirmed?: boolean })?.depositConfirmed ? 'Đã đủ điều kiện và tự động khởi tạo hợp đồng.' : ''}`,
          });
          // Clear modal after short delay or keep open for confirmation
          setTimeout(() => {
            setSelectedOrder(null);
          }, 1500);
        } else {
          setFeedback({
            type: 'error',
            message: res.error || 'Không thể ghi nhận tiền cọc.',
          });
        }
      } catch (err: unknown) {
        setFeedback({
          type: 'error',
          message: err instanceof Error ? err.message : 'Lỗi hệ thống khi ghi nhận cọc.',
        });
      } finally {
        setLoadingOrderId(null);
      }
    });
  };

  const filtered = orders.filter((o) => {
    if (filterStatus === 'ALL') return true;
    if (filterStatus === 'DEPOSIT_CONFIRMED') return o.depositConfirmed;
    if (filterStatus === 'DEPOSIT_PENDING') return !o.depositConfirmed;
    return o.orderStatus === filterStatus;
  });

  return (
    <div className="space-y-6">
      {/* Filters Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-slate-900/60 p-4 rounded-xl border border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Lọc trạng thái:</span>
          <div className="flex gap-1.5">
            {[
              { id: 'ALL', label: 'Tất cả' },
              { id: 'DEPOSIT_PENDING', label: 'Chờ cọc' },
              { id: 'DEPOSIT_CONFIRMED', label: 'Đã cọc' },
              { id: 'CONTRACT_SIGNED', label: 'Đã ký HĐ' },
            ].map((f) => (
              <button
                key={f.id}
                onClick={() => setFilterStatus(f.id)}
                className={`px-3 py-1 text-xs rounded-lg font-medium transition ${
                  filterStatus === f.id
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="text-xs text-slate-400">
          Tổng số: <strong className="text-white">{filtered.length}</strong> đơn hàng
        </div>
      </div>

      {/* Orders Table */}
      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900 shadow">
        <table className="min-w-full divide-y divide-slate-800 text-sm">
          <thead className="bg-slate-950/60 text-slate-400 text-xs uppercase font-medium">
            <tr>
              <th className="py-3 px-4 text-left">Mã Đơn Hàng</th>
              <th className="py-3 px-4 text-left">Khách Hàng</th>
              <th className="py-3 px-4 text-right">Tổng Tiền (VNĐ)</th>
              <th className="py-3 px-4 text-right">Đã Thu / Còn Lại</th>
              <th className="py-3 px-4 text-center">Trạng Thái Cọc</th>
              <th className="py-3 px-4 text-center">Trạng Thái Đơn</th>
              <th className="py-3 px-4 text-left">Mã TT / Hợp Đồng</th>
              <th className="py-3 px-4 text-center">Tác Vụ</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {filtered.map((order) => {
              return (
                <tr key={order.id} className="hover:bg-slate-800/40 transition">
                  {/* Mã đơn hàng */}
                  <td className="py-3 px-4 font-mono text-xs font-semibold text-blue-400">
                    {order.orderCode}
                  </td>

                  {/* Khách hàng */}
                  <td className="py-3 px-4">
                    <div className="font-medium text-white">{order.customerName}</div>
                    <div className="text-xs text-slate-400 font-mono">
                      {order.customerCode || order.customerId.substring(0, 8)}
                    </div>
                  </td>

                  {/* Tổng tiền */}
                  <td className="py-3 px-4 text-right font-medium text-slate-200">
                    {order.finalAmount.toLocaleString('vi-VN')}
                  </td>

                  {/* Đã thu / Còn lại */}
                  <td className="py-3 px-4 text-right text-xs">
                    <div className="text-emerald-400 font-medium">
                      + {order.collectedAmount.toLocaleString('vi-VN')}
                    </div>
                    <div className="text-rose-400 font-medium">
                      - {order.receivableAmount.toLocaleString('vi-VN')}
                    </div>
                  </td>

                  {/* Trạng thái cọc */}
                  <td className="py-3 px-4 text-center">
                    {order.depositConfirmed ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-950/70 border border-emerald-800 text-emerald-300">
                        ĐÃ XÁC NHẬN CỌC
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-950/70 border border-amber-800 text-amber-300">
                        CHƯA ĐỦ CỌC
                      </span>
                    )}
                  </td>

                  {/* Trạng thái đơn */}
                  <td className="py-3 px-4 text-center">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-mono bg-slate-800 text-slate-300">
                      {order.orderStatus}
                    </span>
                  </td>

                  {/* Mã TT / Hợp đồng */}
                  <td className="py-3 px-4 text-xs space-y-1">
                    <div className="font-mono text-slate-400" title="Mã tham chiếu thanh toán">
                      Ref: <span className="text-slate-300">{order.paymentReference}</span>
                    </div>
                    {order.contractId ? (
                      <div>
                        <Link
                          href="/contracts"
                          className="inline-flex items-center text-xs text-blue-400 hover:text-blue-300 underline"
                        >
                          HĐ ({order.contractStatus || 'DRAFT'} - Rev {order.contractRevision || 1})
                        </Link>
                      </div>
                    ) : (
                      <span className="text-slate-500 text-[11px]">Chưa tạo HĐ</span>
                    )}
                  </td>

                  {/* Action */}
                  <td className="py-3 px-4 text-center">
                    {isBossAdmin ? (
                      <button
                        onClick={() => handleOpenDepositModal(order)}
                        className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-medium text-amber-300 hover:text-amber-200 transition"
                      >
                        Ghi nhận cọc
                      </button>
                    ) : (
                      <span className="text-xs text-slate-500">Chỉ xem (Sale)</span>
                    )}
                  </td>
                </tr>
              );
            })}

            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="py-10 text-center text-slate-500">
                  Chưa có đơn hàng nào phù hợp bộ lọc.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Manual Deposit Modal (BOSS_ADMIN ONLY) */}
      {selectedOrder && isBossAdmin && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-5">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-lg font-bold text-white">Ghi nhận tiền cọc thủ công</h3>
              <button
                onClick={() => setSelectedOrder(null)}
                className="text-slate-400 hover:text-white text-lg font-bold"
              >
                &times;
              </button>
            </div>

            <div className="bg-slate-950 p-3 rounded-xl border border-slate-800/80 text-xs space-y-1.5">
              <div>
                Đơn hàng: <strong className="text-blue-400 font-mono">{selectedOrder.orderCode}</strong>
              </div>
              <div>
                Khách hàng: <strong className="text-white">{selectedOrder.customerName}</strong>
              </div>
              <div>
                Tổng giá trị đơn: <strong>{selectedOrder.finalAmount.toLocaleString('vi-VN')} VNĐ</strong>
              </div>
              <div>
                Đã thu hiện tại: <strong className="text-emerald-400">{selectedOrder.collectedAmount.toLocaleString('vi-VN')} VNĐ</strong>
              </div>
              <div>
                Công nợ còn lại: <strong className="text-rose-400">{selectedOrder.receivableAmount.toLocaleString('vi-VN')} VNĐ</strong>
              </div>
            </div>

            <form onSubmit={handleDepositSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Số tiền cọc thu thêm (VNĐ) <span className="text-rose-400">*</span>
                </label>
                <input
                  type="number"
                  min="1000"
                  max="10000000000"
                  step="1000"
                  required
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  placeholder="Ví dụ: 5000000"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono text-sm focus:outline-none focus:border-blue-500"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Server quyết định ngưỡng cọc tự động kích hoạt tạo hợp đồng kinh tế.
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
                  onClick={() => setSelectedOrder(null)}
                  disabled={loadingOrderId !== null}
                  className="px-4 py-2 rounded-lg text-xs font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 transition"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={loadingOrderId !== null || !depositAmount}
                  className="px-4 py-2 rounded-lg text-xs font-bold bg-amber-600 hover:bg-amber-500 text-white transition disabled:opacity-50"
                >
                  {loadingOrderId ? 'Đang xử lý...' : 'Xác nhận thu cọc'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
