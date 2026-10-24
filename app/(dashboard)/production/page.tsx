import 'server-only';
import React from 'react';
import { getActorContext } from '@/lib/auth/context';
import { APPLICATION_ROLES } from '@/shared/constants/roles';
import { getProductionDashboardData } from '@/features/production/production-service';
import ProductionView from '@/features/production/components/production-view';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';

export const metadata = {
  title: 'Quản lý Sản xuất & Xưởng | AI CRM Cửa Chống Ngập',
  description: 'Quản trị lệnh sản xuất xưởng, thông số kỹ thuật chuẩn và kiểm tra chất lượng QC',
};

export default async function ProductionPage() {
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

  // Quyền hạn: BOSS_ADMIN duy nhất được quản lý và phê duyệt lệnh sản xuất xưởng
  if (actor.role !== APPLICATION_ROLES.BOSS_ADMIN) {
    return (
      <EmptyState
        type="permission"
        title="Truy cập bị từ chối"
        description="Khu vực quản lý sản xuất và xuất xưởng chỉ dành cho Quản trị viên (Boss Admin)."
        action={{
          label: 'Về trang Tổng quan CRM',
          href: '/crm',
        }}
      />
    );
  }

  const dashboardData = await getProductionDashboardData(actor.companyId);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sản Xuất & Gia Công Xưởng (Production & QC)"
        description="Xuất xưởng theo thông số kỹ thuật/vật tư chuẩn từ khảo sát, theo dõi tiến độ gia công và quản lý kiểm tra chất lượng (QC)."
      />

      <ProductionView initialData={dashboardData} />
    </div>
  );
}
