import 'server-only';
import React from 'react';
import { getActorContext } from '@/lib/auth/context';
import { getPriceCalculations } from '@/features/pricing/services';
import QuotationsTable, { type PriceCalculationItem } from '@/features/pricing/components/quotations-table';

export default async function QuotationsPage() {
  const actor = await getActorContext();

  if (!actor || !actor.companyId) {
    return (
      <div className="p-8 text-center bg-rose-950/40 border border-rose-800 rounded-xl m-6">
        <h2 className="text-xl font-bold text-rose-400 mb-2">Truy cập bị từ chối</h2>
        <p className="text-slate-300 text-sm">Chưa xác định danh tính hoặc tổ chức của phiên làm việc.</p>
      </div>
    );
  }

  const calculations = await getPriceCalculations(actor.companyId);

  return (
    <div className="space-y-6">
      <div className="border-b border-slate-800 pb-4">
        <h1 className="text-2xl font-bold text-white">Quản lý Báo giá & Tính giá (Quotations)</h1>
        <p className="text-sm text-slate-400">
          Quy trình thương mại: Từ kết quả tính giá kỹ thuật &rarr; Tạo đơn hàng chính thức &rarr; Quản lý đặt cọc &rarr; Hợp đồng kinh tế.
        </p>
      </div>

      <QuotationsTable
        calculations={calculations as unknown as PriceCalculationItem[]}
        userRole={actor.role || ''}
      />
    </div>
  );
}
