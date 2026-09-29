import 'server-only';
import React from 'react';
import { getActorContext } from '@/lib/auth/context';
import { getContractsWithOrderDetails, type ContractListItemDTO } from '@/features/contract/services';

export default async function ContractsPage() {
  const actor = await getActorContext();

  if (!actor || !actor.companyId) {
    return (
      <div className="p-8 text-center bg-red-950/40 border border-red-800 rounded-xl m-6">
        <h2 className="text-xl font-bold text-red-400 mb-2">Truy cập bị từ chối</h2>
        <p className="text-slate-300 text-sm">Chưa xác định danh tính hoặc tổ chức của phiên làm việc.</p>
      </div>
    );
  }

  const contracts: ContractListItemDTO[] = await getContractsWithOrderDetails(actor.companyId);

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6 text-gray-800">Quản lý Hợp đồng & Công nợ (Contracts & Orders)</h1>
      <div className="overflow-x-auto shadow-md sm:rounded-lg">
        <table className="min-w-full bg-white border border-gray-200">
          <thead className="bg-gray-100 border-b border-gray-200">
            <tr>
              <th className="py-3 px-4 text-left text-sm font-semibold text-gray-700">Mã Đơn / Hợp Đồng</th>
              <th className="py-3 px-4 text-left text-sm font-semibold text-gray-700">Khách Hàng</th>
              <th className="py-3 px-4 text-right text-sm font-semibold text-gray-700">Tổng Tiền (VNĐ)</th>
              <th className="py-3 px-4 text-right text-sm font-semibold text-gray-700">Công Nợ Còn Lại</th>
              <th className="py-3 px-4 text-center text-sm font-semibold text-gray-700">Trạng thái Ký</th>
              <th className="py-3 px-4 text-center text-sm font-semibold text-gray-700">Trạng thái Hợp đồng</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {contracts?.map((contract) => (
              <tr key={contract.id} className="hover:bg-gray-50 transition-colors">
                <td className="py-3 px-4 text-sm text-gray-600 font-mono truncate max-w-[140px]" title={contract.id}>
                  {contract.orderCode || contract.id.substring(0, 8)}
                </td>
                <td className="py-3 px-4 text-sm text-gray-900 font-medium">
                  {contract.customerName}
                </td>
                <td className="py-3 px-4 text-sm text-gray-900 text-right">
                  {contract.contractValue.toLocaleString('vi-VN')}
                </td>
                <td className="py-3 px-4 text-sm font-bold text-red-600 text-right">
                  {contract.receivableAmount.toLocaleString('vi-VN')}
                </td>
                <td className="py-3 px-4 text-sm text-center">
                  {contract.isSigned ? (
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
            ))}
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
