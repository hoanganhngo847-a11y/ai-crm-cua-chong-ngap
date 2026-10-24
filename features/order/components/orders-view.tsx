'use client';

import React, { useState, useTransition } from 'react';
import Link from 'next/link';
import type { OrderListItemDTO } from '../services';
import { updateOrderDepositAction, recoverOrderContractAction } from '../actions';
import { Card } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';

interface OrdersViewProps {
  orders: OrderListItemDTO[];
  userRole: string;
}

export default function OrdersView({ orders, userRole }: OrdersViewProps) {
  const isBossAdmin = userRole === 'BOSS_ADMIN';
  const isSaleOrBoss = userRole === 'BOSS_ADMIN' || userRole === 'SALE';
  const [selectedOrder, setSelectedOrder] = useState<OrderListItemDTO | null>(null);
  const [depositAmount, setDepositAmount] = useState<string>('');
  const [inFlightCommandId, setInFlightCommandId] = useState<string>('');
  const [loadingOrderId, setLoadingOrderId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [globalFeedback, setGlobalFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [isPending, startTransition] = useTransition();

  const handleOpenDepositModal = (order: OrderListItemDTO) => {
    setSelectedOrder(order);
    setDepositAmount('');
    setFeedback(null);
    // Generate command ID once per logical manual-deposit operation.
    // Retained across retries and network errors.
    setInFlightCommandId(`manual_dep_${order.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  };

  const handleDepositSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrder || loadingOrderId || isPending) return;

    const numAmount = Number(depositAmount);
    if (isNaN(numAmount) || numAmount <= 0) {
      setFeedback({ type: 'error', message: 'Vui lòng nhập số tiền cọc hợp lệ (lớn hơn 0).' });
      return;
    }

    // Retain stable in-flight command ID across retries
    let commandId = inFlightCommandId;
    if (!commandId) {
      commandId = `manual_dep_${selectedOrder.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      setInFlightCommandId(commandId);
    }

    setLoadingOrderId(selectedOrder.id);
    setFeedback(null);

    startTransition(async () => {
      try {
        const res = await updateOrderDepositAction({
          orderId: selectedOrder.id,
          depositAmount: numAmount,
          idempotencyKey: commandId,
        });

        if (res.success) {
          const depData = res.data as {
            depositConfirmed?: boolean;
            contractGenerationStatus?: string;
            contractStatus?: string;
          };
          let msg = 'Ghi nhận tiền cọc thành công!';
          if (depData?.contractGenerationStatus === 'GENERATED') {
            msg += ' Đã tự động khởi tạo hợp đồng thành công.';
          } else if (depData?.contractGenerationStatus === 'ALREADY_EXISTS') {
            msg += ' Hợp đồng kinh tế đã tồn tại.';
          } else if (depData?.contractGenerationStatus === 'PENDING_RECOVERY') {
            msg += ' Đã ghi nhận cọc, nhưng khởi tạo hợp đồng đang chờ khôi phục.';
          }

          setFeedback({
            type: 'success',
            message: msg,
          });
          // Clear modal only upon verified success
          setTimeout(() => {
            setSelectedOrder(null);
            setInFlightCommandId('');
          }, 1500);
        } else {
          setFeedback({
            type: 'error',
            message: res.error || 'Không thể ghi nhận tiền cọc.',
          });
          // Do NOT rotate inFlightCommandId on failure; retry sends same command ID
        }
      } catch (err: unknown) {
        setFeedback({
          type: 'error',
          message: err instanceof Error ? err.message : 'Lỗi hệ thống khi ghi nhận cọc.',
        });
        // Do NOT rotate inFlightCommandId on exception/network failure
      } finally {
        setLoadingOrderId(null);
      }
    });
  };

  const handleRecoverContract = (order: OrderListItemDTO) => {
    if (loadingOrderId || isPending) return;
    setLoadingOrderId(order.id);
    setGlobalFeedback(null);

    startTransition(async () => {
      try {
        const res = await recoverOrderContractAction({ orderId: order.id });
        if (res.success) {
          setGlobalFeedback({
            type: 'success',
            message: `Khôi phục/khởi tạo hợp đồng thành công cho đơn hàng ${order.orderCode}!`,
          });
        } else {
          setGlobalFeedback({
            type: 'error',
            message: res.error || 'Không thể khôi phục hợp đồng.',
          });
        }
      } catch (err: unknown) {
        setGlobalFeedback({
          type: 'error',
          message: err instanceof Error ? err.message : 'Lỗi hệ thống khi khôi phục hợp đồng.',
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
    <div className="space-y-4">
      {/* Filters Toolbar */}
      <Card className="p-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wider">
              Lọc trạng thái:
            </span>
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
                  className={`px-3 py-1 text-xs rounded-lg font-medium transition cursor-pointer ${
                    filterStatus === f.id
                      ? 'bg-blue-600 text-white shadow-subtle'
                      : 'bg-[var(--surface-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] border border-[var(--border-subtle)]'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <div className="text-xs text-[var(--text-secondary)]">
            Tổng số: <strong className="text-[var(--text-primary)]">{filtered.length}</strong> đơn hàng
          </div>
        </div>
      </Card>

      {/* Global Feedback Banner */}
      {globalFeedback && (
        <div
          className={`p-3 rounded-lg text-xs flex items-center justify-between border shadow-subtle ${
            globalFeedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}
        >
          <span>{globalFeedback.message}</span>
          <button
            onClick={() => setGlobalFeedback(null)}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] font-bold ml-2 cursor-pointer"
          >
            &times;
          </button>
        </div>
      )}

      {/* Orders Table */}
      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[120px]">Mã Đơn Hàng</TableHead>
              <TableHead>Khách Hàng</TableHead>
              <TableHead className="text-right">Tổng Tiền (VNĐ)</TableHead>
              <TableHead className="text-right">Đã Thu / Còn Lại</TableHead>
              <TableHead className="text-center">Trạng Thái Cọc</TableHead>
              <TableHead className="text-center">Trạng Thái Đơn</TableHead>
              <TableHead>Mã TT / Hợp Đồng</TableHead>
              <TableHead className="text-center">Tác Vụ</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((order) => {
              const needsContractRecovery = order.depositConfirmed && !order.contractId;

              return (
                <TableRow key={order.id}>
                  {/* Mã đơn hàng */}
                  <TableCell className="font-mono text-xs font-semibold text-blue-600">
                    {order.orderCode}
                  </TableCell>

                  {/* Khách hàng */}
                  <TableCell>
                    <div className="font-medium text-[var(--text-primary)]">{order.customerName}</div>
                    <div className="text-xs text-[var(--text-tertiary)] font-mono">
                      {order.customerCode || order.customerId.substring(0, 8)}
                    </div>
                  </TableCell>

                  {/* Tổng tiền */}
                  <TableCell className="text-right font-medium text-[var(--text-primary)]">
                    {order.finalAmount.toLocaleString('vi-VN')}
                  </TableCell>

                  {/* Đã thu / Còn lại */}
                  <TableCell className="text-right text-xs">
                    <div className="text-emerald-600 font-medium">
                      + {order.collectedAmount.toLocaleString('vi-VN')}
                    </div>
                    <div className="text-rose-600 font-medium">
                      - {order.receivableAmount.toLocaleString('vi-VN')}
                    </div>
                  </TableCell>

                  {/* Trạng thái cọc */}
                  <TableCell className="text-center">
                    {order.depositConfirmed ? (
                      <Badge variant="success" size="sm">
                        ĐÃ XÁC NHẬN CỌC
                      </Badge>
                    ) : (
                      <Badge variant="warning" size="sm">
                        CHƯA ĐỦ CỌC
                      </Badge>
                    )}
                  </TableCell>

                  {/* Trạng thái đơn */}
                  <TableCell className="text-center">
                    <Badge variant="neutral" size="sm" className="font-mono">
                      {order.orderStatus}
                    </Badge>
                  </TableCell>

                  {/* Mã TT / Hợp đồng */}
                  <TableCell className="text-xs space-y-1">
                    <div className="font-mono text-[var(--text-secondary)] text-[11px]" title="Mã tham chiếu thanh toán">
                      Ref: <span className="text-[var(--text-primary)] font-medium">{order.paymentReference}</span>
                    </div>
                    {order.contractId ? (
                      <div>
                        <Link
                          href="/contracts"
                          className="inline-flex items-center text-xs text-blue-600 hover:text-blue-700 underline font-medium"
                        >
                          HĐ ({order.contractStatus || 'DRAFT'} - Rev {order.contractRevision || 1})
                        </Link>
                      </div>
                    ) : needsContractRecovery ? (
                      <Badge variant="warning" size="sm">
                        Đã đủ cọc — Chưa tạo HĐ
                      </Badge>
                    ) : (
                      <span className="text-[var(--text-tertiary)] text-[11px]">Chưa tạo HĐ</span>
                    )}
                  </TableCell>

                  {/* Action */}
                  <TableCell className="text-center">
                    <div className="flex flex-col items-center justify-center gap-1.5">
                      {needsContractRecovery && isSaleOrBoss && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleRecoverContract(order)}
                          disabled={loadingOrderId === order.id || isPending}
                          isLoading={loadingOrderId === order.id}
                          className="text-amber-700 border-amber-300 hover:bg-amber-50"
                          title="Khôi phục tạo hợp đồng kinh tế theo trạng thái cọc"
                        >
                          Tạo / Khôi phục hợp đồng
                        </Button>
                      )}

                      {isBossAdmin && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleOpenDepositModal(order)}
                          disabled={loadingOrderId === order.id || isPending}
                          className="text-amber-700 hover:bg-amber-50"
                        >
                          Ghi nhận cọc
                        </Button>
                      )}

                      {!isBossAdmin && !needsContractRecovery && (
                        <span className="text-xs text-[var(--text-tertiary)]">Chỉ xem (Sale)</span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}

            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-12 text-center text-[var(--text-tertiary)]">
                  Chưa có đơn hàng nào phù hợp bộ lọc.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Manual Deposit Modal (BOSS_ADMIN ONLY) */}
      {selectedOrder && isBossAdmin && (
        <Modal
          isOpen={true}
          onClose={() => setSelectedOrder(null)}
          title="Ghi nhận tiền cọc thủ công"
          size="md"
        >
          <div className="space-y-4">
            <div className="bg-[var(--surface-secondary)] p-3 rounded-lg border border-[var(--border-subtle)] text-xs space-y-1.5">
              <div>
                Đơn hàng: <strong className="text-blue-600 font-mono">{selectedOrder.orderCode}</strong>
              </div>
              <div>
                Khách hàng: <strong className="text-[var(--text-primary)]">{selectedOrder.customerName}</strong>
              </div>
              <div>
                Tổng giá trị đơn: <strong>{selectedOrder.finalAmount.toLocaleString('vi-VN')} VNĐ</strong>
              </div>
              <div>
                Đã thu hiện tại: <strong className="text-emerald-600">{selectedOrder.collectedAmount.toLocaleString('vi-VN')} VNĐ</strong>
              </div>
              <div>
                Công nợ còn lại: <strong className="text-rose-600">{selectedOrder.receivableAmount.toLocaleString('vi-VN')} VNĐ</strong>
              </div>
            </div>

            <form onSubmit={handleDepositSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-[var(--text-primary)] mb-1">
                  Số tiền cọc thu thêm (VNĐ) <span className="text-rose-500">*</span>
                </label>
                <Input
                  type="number"
                  min="1000"
                  max="10000000000"
                  step="1000"
                  required
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  placeholder="Ví dụ: 5000000"
                  className="font-mono text-sm"
                />
                <p className="text-[11px] text-[var(--text-tertiary)] mt-1">
                  Hệ thống tự động kích hoạt tạo hợp đồng kinh tế khi đủ ngưỡng cọc.
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
                  onClick={() => setSelectedOrder(null)}
                  disabled={loadingOrderId !== null}
                >
                  Hủy
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={loadingOrderId !== null || !depositAmount}
                  isLoading={loadingOrderId !== null}
                >
                  Xác nhận thu cọc
                </Button>
              </div>
            </form>
          </div>
        </Modal>
      )}
    </div>
  );
}
