'use client';

import React, { useState, useTransition } from 'react';
import Link from 'next/link';
import { createOrderFromCalculationAction } from '@/features/order/actions';
import { Card } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckCircle2 } from 'lucide-react';

export interface PriceCalculationItem {
  id: string;
  company_id: string;
  customer_id: string;
  amount: number | null;
  status: string;
  missing_fields: string[] | null;
  created_at: string;
  customers?: {
    name?: string | null;
    customer_code?: string | null;
  } | null;
}

interface QuotationsTableProps {
  calculations: PriceCalculationItem[];
  userRole: string;
}

export default function QuotationsTable({ calculations, userRole }: QuotationsTableProps) {
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [successInfo, setSuccessInfo] = useState<Record<string, { orderId?: string; orderCode?: string }>>({});
  const [errorMessage, setErrorMessage] = useState<Record<string, string>>({});
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [isPending, startTransition] = useTransition();

  const isAuthorized = userRole === 'BOSS_ADMIN' || userRole === 'SALE';

  const handleCreateOrder = (calcId: string) => {
    if (loadingId || isPending) return; // Prevent double-click
    setLoadingId(calcId);
    setErrorMessage((prev) => ({ ...prev, [calcId]: '' }));

    startTransition(async () => {
      try {
        const res = await createOrderFromCalculationAction({ priceCalculationId: calcId });
        if (res.success && res.orderId) {
          setSuccessInfo((prev) => ({
            ...prev,
            [calcId]: { orderId: res.orderId, orderCode: res.orderCode },
          }));
        } else {
          setErrorMessage((prev) => ({
            ...prev,
            [calcId]: res.error || 'Không thể tạo đơn hàng.',
          }));
        }
      } catch (err: unknown) {
        setErrorMessage((prev) => ({
          ...prev,
          [calcId]: err instanceof Error ? err.message : 'Lỗi hệ thống khi tạo đơn hàng.',
        }));
      } finally {
        setLoadingId(null);
      }
    });
  };

  const filtered = calculations.filter((calc) => {
    if (filterStatus === 'ALL') return true;
    return calc.status === filterStatus;
  });

  return (
    <div className="space-y-4">
      {/* Filter Toolbar */}
      <Card className="p-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wider">
              Lọc trạng thái:
            </span>
            <div className="flex gap-1.5">
              {[
                { id: 'ALL', label: 'Tất cả' },
                { id: 'CALCULATED', label: 'Đã tính giá' },
                { id: 'NEED_INFO', label: 'Cần thông tin' },
              ].map((st) => (
                <button
                  key={st.id}
                  onClick={() => setFilterStatus(st.id)}
                  className={`px-3 py-1 text-xs rounded-lg font-medium transition cursor-pointer ${
                    filterStatus === st.id
                      ? 'bg-blue-600 text-white shadow-subtle'
                      : 'bg-[var(--surface-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] border border-[var(--border-subtle)]'
                  }`}
                >
                  {st.label}
                </button>
              ))}
            </div>
          </div>
          <div className="text-xs text-[var(--text-secondary)]">
            Tổng số: <strong className="text-[var(--text-primary)]">{filtered.length}</strong> bảng tính
          </div>
        </div>
      </Card>

      {/* Table */}
      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[120px]">Mã Bảng Tính</TableHead>
              <TableHead>Khách Hàng</TableHead>
              <TableHead className="text-right">Số Tiền (VNĐ)</TableHead>
              <TableHead className="text-center">Trạng Thái</TableHead>
              <TableHead>Trường Thiếu</TableHead>
              <TableHead>Ngày Tạo</TableHead>
              <TableHead className="text-center">Tác Vụ Thương Mại</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((calc) => {
              const isNeedInfo = calc.status === 'NEED_INFO';
              const isCalculated = calc.status === 'CALCULATED';
              const succ = successInfo[calc.id];
              const err = errorMessage[calc.id];
              const isLoading = loadingId === calc.id;

              return (
                <TableRow key={calc.id}>
                  {/* Mã bảng tính */}
                  <TableCell className="font-mono text-xs text-[var(--text-secondary)]">
                    <span title={calc.id}>{calc.id.substring(0, 8)}...</span>
                  </TableCell>

                  {/* Khách hàng */}
                  <TableCell>
                    <div className="font-medium text-[var(--text-primary)]">
                      {calc.customers?.name || 'Khách hàng'}
                    </div>
                    <div className="text-xs text-[var(--text-tertiary)] font-mono">
                      {calc.customers?.customer_code || calc.customer_id.substring(0, 8)}
                    </div>
                  </TableCell>

                  {/* Số tiền */}
                  <TableCell className="text-right font-medium text-[var(--text-primary)]">
                    {calc.amount != null ? Number(calc.amount).toLocaleString('vi-VN') : '-'}
                  </TableCell>

                  {/* Trạng thái */}
                  <TableCell className="text-center">
                    {isNeedInfo ? (
                      <Badge variant="danger" size="sm">
                        CẦN BỔ SUNG THÔNG TIN
                      </Badge>
                    ) : isCalculated ? (
                      <Badge variant="success" size="sm">
                        ĐÃ TÍNH GIÁ
                      </Badge>
                    ) : (
                      <Badge variant="neutral" size="sm">
                        {calc.status}
                      </Badge>
                    )}
                  </TableCell>

                  {/* Trường thiếu */}
                  <TableCell className="text-xs text-[var(--text-secondary)] max-w-[200px]">
                    {calc.missing_fields && Array.isArray(calc.missing_fields) && calc.missing_fields.length > 0 ? (
                      <span className="text-amber-600 font-mono text-[11px]">
                        {calc.missing_fields.join(', ')}
                      </span>
                    ) : (
                      <span className="text-[var(--text-tertiary)]">-</span>
                    )}
                  </TableCell>

                  {/* Ngày tạo */}
                  <TableCell className="text-xs text-[var(--text-secondary)]">
                    {new Date(calc.created_at).toLocaleString('vi-VN')}
                  </TableCell>

                  {/* Action */}
                  <TableCell className="text-center">
                    {succ ? (
                      <div className="flex flex-col items-center gap-1">
                        <span className="text-xs text-emerald-600 font-medium flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5 inline" />
                          Đã tạo đơn {succ.orderCode || ''}
                        </span>
                        <Link
                          href="/orders"
                          className="text-xs text-blue-600 hover:text-blue-700 underline font-medium inline-flex items-center gap-1"
                        >
                          Xem đơn hàng &amp; cọc &rarr;
                        </Link>
                      </div>
                    ) : isNeedInfo ? (
                      <div className="flex flex-col items-center">
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled
                          className="text-xs opacity-60 cursor-not-allowed"
                          title="Không thể tạo đơn hàng khi chưa đủ thông tin kỹ thuật"
                        >
                          Cần bổ sung thông tin
                        </Button>
                      </div>
                    ) : isCalculated ? (
                      <div className="flex flex-col items-center gap-1">
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => handleCreateOrder(calc.id)}
                          disabled={!isAuthorized || isLoading}
                          isLoading={isLoading}
                        >
                          Tạo Đơn Hàng
                        </Button>
                        {err && (
                          <span className="text-[11px] text-rose-600 max-w-xs mt-1">
                            {err}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-[var(--text-tertiary)]">-</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}

            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-12 text-center text-[var(--text-tertiary)]">
                  Chưa có dữ liệu tính giá nào.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
