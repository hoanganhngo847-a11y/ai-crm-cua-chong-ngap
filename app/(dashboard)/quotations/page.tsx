import React from 'react';
import { getPriceCalculations } from '@/features/pricing/services';

export default async function QuotationsPage() {
  const calculations = await getPriceCalculations();

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Danh sách tính giá (Quotations)</h1>
      <div className="overflow-x-auto shadow rounded-lg">
        <table className="min-w-full bg-white border border-gray-200">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="py-3 px-4 text-left text-sm font-semibold text-gray-700">ID</th>
              <th className="py-3 px-4 text-left text-sm font-semibold text-gray-700">Customer ID</th>
              <th className="py-3 px-4 text-right text-sm font-semibold text-gray-700">Amount (VNĐ)</th>
              <th className="py-3 px-4 text-center text-sm font-semibold text-gray-700">Status</th>
              <th className="py-3 px-4 text-left text-sm font-semibold text-gray-700">Missing Fields</th>
              <th className="py-3 px-4 text-left text-sm font-semibold text-gray-700">Created At</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {calculations?.map((calc: any) => (
              <tr key={calc.id} className="hover:bg-gray-50">
                <td className="py-3 px-4 text-sm text-gray-600 truncate max-w-xs" title={calc.id}>
                  {calc.id.substring(0, 8)}...
                </td>
                <td className="py-3 px-4 text-sm text-gray-600 truncate max-w-xs" title={calc.customer_id}>
                  {calc.customer_id.substring(0, 8)}...
                </td>
                <td className="py-3 px-4 text-sm text-gray-900 text-right font-medium">
                  {calc.amount != null ? calc.amount.toLocaleString('vi-VN') : '-'}
                </td>
                <td className="py-3 px-4 text-sm text-center">
                  {calc.status === 'NEED_INFO' ? (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-800">
                      CẦN KIỂM TRA (NEED_INFO)
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                      {calc.status}
                    </span>
                  )}
                </td>
                <td className="py-3 px-4 text-sm text-gray-600">
                  {calc.missing_fields && calc.missing_fields.length > 0
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
