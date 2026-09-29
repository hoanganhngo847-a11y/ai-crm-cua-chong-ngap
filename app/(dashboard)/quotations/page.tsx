import 'server-only';
import React from 'react';
import { getActorContext } from '@/lib/auth/context';
import { getPriceCalculations } from '@/features/pricing/services';

interface PriceCalculationRow {
  id: string;
  customer_id: string;
  amount: number | null;
  status: string;
  missing_fields: string[] | null;
  created_at: string;
}

export default async function QuotationsPage() {
  const actor = await getActorContext();

  if (!actor || !actor.companyId) {
    return (
      <div className="p-8 text-center bg-red-950/40 border border-red-800 rounded-xl m-6">
        <h2 className="text-xl font-bold text-red-400 mb-2">Truy cập bị từ chối</h2>
        <p className="text-slate-300 text-sm">Chưa xác định danh tính hoặc tổ chức của phiên làm việc.</p>
      </div>
    );
  }

  const calculations = await getPriceCalculations(actor.companyId);

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6 text-gray-800">Danh sách tính giá (Quotations)</h1>
      <div className="overflow-x-auto shadow rounded-lg">
        <table className="min-w-full bg-white border border-gray-200">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="py-3 px-4 text-left text-sm font-semibold text-gray-700">Mã Bảng Tính</th>
              <th className="py-3 px-4 text-left text-sm font-semibold text-gray-700">Mã Khách Hàng</th>
              <th className="py-3 px-4 text-right text-sm font-semibold text-gray-700">Số Tiền (VNĐ)</th>
              <th className="py-3 px-4 text-center text-sm font-semibold text-gray-700">Trạng Thái</th>
              <th className="py-3 px-4 text-left text-sm font-semibold text-gray-700">Trường Thiếu</th>
              <th className="py-3 px-4 text-left text-sm font-semibold text-gray-700">Ngày Tạo</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {(calculations as unknown as PriceCalculationRow[])?.map((calc) => (
              <tr key={calc.id} className="hover:bg-gray-50 transition-colors">
                <td className="py-3 px-4 text-sm text-gray-600 font-mono truncate max-w-xs" title={calc.id}>
                  {calc.id.substring(0, 8)}...
                </td>
                <td className="py-3 px-4 text-sm text-gray-600 font-mono truncate max-w-xs" title={calc.customer_id}>
                  {calc.customer_id.substring(0, 8)}...
                </td>
                <td className="py-3 px-4 text-sm text-gray-900 text-right font-medium">
                  {calc.amount != null ? Number(calc.amount).toLocaleString('vi-VN') : '-'}
                </td>
                <td className="py-3 px-4 text-sm text-center">
                  {calc.status === 'NEED_INFO' ? (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-800">
                      CẦN THÔNG TIN (NEED_INFO)
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                      {calc.status}
                    </span>
                  )}
                </td>
                <td className="py-3 px-4 text-sm text-gray-600">
                  {calc.missing_fields && Array.isArray(calc.missing_fields) && calc.missing_fields.length > 0
                    ? calc.missing_fields.join(', ')
                    : '-'}
                </td>
                <td className="py-3 px-4 text-sm text-gray-600">
                  {new Date(calc.created_at).toLocaleString('vi-VN')}
                </td>
              </tr>
            ))}
            {(!calculations || calculations.length === 0) && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-gray-500">
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
