import 'server-only';
import React from 'react';
import { getActorContext } from '@/lib/auth/context';
import { getPriceCalculations } from '@/features/pricing/services';
import QuotationsTable, { type PriceCalculationItem } from '@/features/pricing/components/quotations-table';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';

export default async function QuotationsPage() {
  const actor = await getActorContext();

  if (!actor || !actor.companyId) {
    return (
      <EmptyState
        type="permission"
        title="Truy cập bị từ chối"
        description="Chưa xác định danh tính hoặc tổ chức của phiên làm việc."
      />
    );
  }

  const calculations = await getPriceCalculations(actor.companyId);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Báo Giá & Tính Giá (Quotations)"
        description="Quy trình thương mại: Từ kết quả tính giá kỹ thuật &rarr; Tạo đơn hàng chính thức &rarr; Quản lý đặt cọc &rarr; Hợp đồng kinh tế."
      />

      <QuotationsTable
        calculations={calculations as unknown as PriceCalculationItem[]}
        userRole={actor.role || ''}
      />
    </div>
  );
}
