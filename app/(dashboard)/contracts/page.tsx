import React from 'react';
import { getContractsWithOrderDetails } from '@/features/contract/services';

export default async function ContractsPage() {
  const contracts = await getContractsWithOrderDetails();

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6 text-gray-800">Quản lý Hợp đồng & Công nợ (Contracts & Orders)</h1>
      <div className="overflow-x-auto shadow-md sm:rounded-lg">
        <table className="min-w-full bg-white border border-gray-200">
          <thead className="bg-gray-100 border-b border-gray-200">
            <tr>
              <th className="py-3 px-4 text-left text-sm font-semibold text-gray-700">Mã Hợp Đồng</th>
              <th className="py-3 px-4 text-left text-sm font-semibold text-gray-700">Khách Hàng</th>
              <th className="py-3 px-4 text-right text-sm font-semibold text-gray-700">Tổng Tiền (VNĐ)</th>
              <th className="py-3 px-4 text-right text-sm font-semibold text-gray-700">Công Nợ Còn Lại</th>
              <th className="py-3 px-4 text-center text-sm font-semibold text-gray-700">Trạng thái Ký</th>
              <th className="py-3 px-4 text-center text-sm font-semibold text-gray-700">Trạng thái Hợp đồng</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {contracts?.map((contract: any) => {
              // Xử lý dữ liệu fallback
              const order = contract.orders || {};
              const customer = contract.customers || {};
              const isSigned = !!contract.signed_file_ref;

              return (
                <tr key={contract.id} className="hover:bg-gray-50 transition-colors">
                  <td className="py-3 px-4 text-sm text-gray-600 font-mono truncate max-w-[120px]" title={contract.id}>
                    {contract.id.substring(0, 8)}...
                  </td>
                  <td className="py-3 px-4 text-sm text-gray-900 font-medium">
                    {customer.name || customer.id || 'N/A'}
                  </td>
                  <td className="py-3 px-4 text-sm text-gray-900 text-right">
                    {order.total_amount != null ? order.total_amount.toLocaleString('vi-VN') : '0'}
                  </td>
                  <td className="py-3 px-4 text-sm font-bold text-red-600 text-right">
                    {order.remaining_amount != null ? order.remaining_amount.toLocaleString('vi-VN') : '0'}
                  </td>
                  <td className="py-3 px-4 text-sm text-center">
                    {isSigned ? (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                        ĐÃ KÝ
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-yellow-100 text-yellow-800">
                        CHƯA KÝ
                      </span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-sm text-center">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                      {contract.status || 'DRAFT'}
                    </span>
                  </td>
                </tr>
              );
            })}
            {(!contracts || contracts.length === 0) && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-gray-500">
                  Chưa có dữ liệu hợp đồng nào.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
