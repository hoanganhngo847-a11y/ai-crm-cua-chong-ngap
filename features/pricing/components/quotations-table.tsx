'use client';

import React, { useState, useTransition } from 'react';
import Link from 'next/link';
import { createOrderFromCalculationAction } from '@/features/order/actions';

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
      <div className="flex flex-wrap items-center justify-between gap-4 bg-slate-900/60 p-4 rounded-xl border border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Lọc trạng thái:</span>
          <div className="flex gap-1.5">
            {['ALL', 'CALCULATED', 'NEED_INFO'].map((st) => (
              <button
                key={st}
                onClick={() => setFilterStatus(st)}
                className={`px-3 py-1 text-xs rounded-lg font-medium transition ${
                  filterStatus === st
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                {st === 'ALL' ? 'Tất cả' : st === 'CALCULATED' ? 'Đã tính giá' : 'Cần thông tin'}
              </button>
            ))}
          </div>
        </div>
        <div className="text-xs text-slate-400">
          Tổng số: <strong className="text-white">{filtered.length}</strong> bảng tính
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900 shadow">
        <table className="min-w-full divide-y divide-slate-800 text-sm">
          <thead className="bg-slate-950/60 text-slate-400 text-xs uppercase font-medium">
            <tr>
              <th className="py-3 px-4 text-left">Mã Bảng Tính</th>
              <th className="py-3 px-4 text-left">Khách Hàng</th>
              <th className="py-3 px-4 text-right">Số Tiền (VNĐ)</th>
              <th className="py-3 px-4 text-center">Trạng Thái</th>
              <th className="py-3 px-4 text-left">Trường Thiếu</th>
              <th className="py-3 px-4 text-left">Ngày Tạo</th>
              <th className="py-3 px-4 text-center">Tác Vụ Thương Mại</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {filtered.map((calc) => {
              const isNeedInfo = calc.status === 'NEED_INFO';
              const isCalculated = calc.status === 'CALCULATED';
              const succ = successInfo[calc.id];
              const err = errorMessage[calc.id];
              const isLoading = loadingId === calc.id;

              return (
                <tr key={calc.id} className="hover:bg-slate-800/40 transition">
                  {/* Mã bảng tính */}
                  <td className="py-3 px-4 font-mono text-xs text-slate-400">
                    <span title={calc.id}>{calc.id.substring(0, 8)}...</span>
                  </td>

                  {/* Khách hàng */}
                  <td className="py-3 px-4">
                    <div className="font-medium text-white">
                      {calc.customers?.name || 'Khách hàng'}
                    </div>
                    <div className="text-xs text-slate-400 font-mono">
                      {calc.customers?.customer_code || calc.customer_id.substring(0, 8)}
                    </div>
                  </td>

                  {/* Số tiền */}
                  <td className="py-3 px-4 text-right font-medium text-slate-200">
                    {calc.amount != null ? Number(calc.amount).toLocaleString('vi-VN') : '-'}
                  </td>

                  {/* Trạng thái */}
                  <td className="py-3 px-4 text-center">
                    {isNeedInfo ? (
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-950/70 border border-rose-800 text-rose-300">
                        CẦN BỔ SUNG THÔNG TIN
                      </span>
                    ) : isCalculated ? (
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-950/70 border border-emerald-800 text-emerald-300">
                        ĐÃ TÍNH GIÁ
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-slate-800 text-slate-300">
                        {calc.status}
                      </span>
                    )}
                  </td>

                  {/* Trường thiếu */}
                  <td className="py-3 px-4 text-xs text-slate-400 max-w-[200px]">
                    {calc.missing_fields && Array.isArray(calc.missing_fields) && calc.missing_fields.length > 0 ? (
                      <span className="text-amber-400 font-mono">
                        {calc.missing_fields.join(', ')}
                      </span>
                    ) : (
                      <span className="text-slate-500">-</span>
                    )}
                  </td>

                  {/* Ngày tạo */}
                  <td className="py-3 px-4 text-xs text-slate-400">
                    {new Date(calc.created_at).toLocaleString('vi-VN')}
                  </td>

                  {/* Action */}
                  <td className="py-3 px-4 text-center">
                    {succ ? (
                      <div className="flex flex-col items-center gap-1">
                        <span className="text-xs text-emerald-400 font-medium">
                          ✓ Đã tạo đơn {succ.orderCode || ''}
                        </span>
                        <Link
                          href="/orders"
                          className="text-xs text-blue-400 hover:text-blue-300 underline font-medium"
                        >
                          Xem đơn hàng &amp; cọc &rarr;
                        </Link>
                      </div>
                    ) : isNeedInfo ? (
                      <div className="flex flex-col items-center">
                        <button
                          disabled
                          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700/50"
                          title="Không thể tạo đơn hàng khi chưa đủ thông tin kỹ thuật"
                        >
                          Cần bổ sung thông tin
                        </button>
                      </div>
                    ) : isCalculated ? (
                      <div className="flex flex-col items-center gap-1">
                        <button
                          onClick={() => handleCreateOrder(calc.id)}
                          disabled={!isAuthorized || isLoading}
                          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                            isAuthorized && !isLoading
                              ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-sm hover:shadow'
                              : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                          }`}
                        >
                          {isLoading ? (
                            <span className="inline-flex items-center gap-1.5">
                              <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                              Đang tạo...
                            </span>
                          ) : (
                            'Tạo Đơn Hàng'
                          )}
                        </button>
                        {err && (
                          <span className="text-[11px] text-rose-400 max-w-xs mt-1">
                            {err}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-slate-500">-</span>
                    )}
                  </td>
                </tr>
              );
            })}

            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="py-10 text-center text-slate-500">
                  Chưa có dữ liệu tính giá nào.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
