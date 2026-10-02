import 'server-only';
import React from 'react';
import { getActorContext } from '@/lib/auth/context';
import { APPLICATION_ROLES } from '@/shared/constants/roles';
import { getProductionDashboardData } from '@/features/production/production-service';
import ProductionView from '@/features/production/components/production-view';

export const metadata = {
  title: 'Quản lý Sản xuất & Xưởng | AI CRM Cửa Chống Ngập',
  description: 'Quản trị lệnh sản xuất xưởng, thông số kỹ thuật chuẩn và kiểm tra chất lượng QC',
};

export default async function ProductionPage() {
  const actor = await getActorContext();

  if (!actor || !actor.companyId) {
    return (
      <div className="p-8 text-center bg-rose-950/40 border border-rose-800 rounded-xl m-6">
        <h2 className="text-xl font-bold text-rose-400 mb-2">Truy cập bị từ chối</h2>
        <p className="text-slate-300 text-sm">Chưa xác định danh tính hoặc tổ chức của phiên làm việc.</p>
      </div>
    );
  }

  // Quyền hạn: BOSS_ADMIN duy nhất được quản lý và phê duyệt lệnh sản xuất xưởng
  if (actor.role !== APPLICATION_ROLES.BOSS_ADMIN) {
    return (
      <div className="p-8 text-center bg-rose-950/40 border border-rose-800 rounded-xl m-6">
        <h2 className="text-xl font-bold text-rose-400 mb-2">Truy cập bị từ chối</h2>
        <p className="text-slate-300 text-sm">
          Khu vực quản lý sản xuất và xuất xưởng chỉ dành cho Quản trị viên (Boss Admin).
        </p>
      </div>
    );
  }

  const dashboardData = await getProductionDashboardData(actor.companyId);

  return (
    <div className="space-y-6">
      <div className="border-b border-slate-800 pb-4">
        <h1 className="text-2xl font-bold text-white">Quản lý Sản xuất &amp; Gia công Xưởng (Production &amp; QC)</h1>
        <p className="text-sm text-slate-400">
          Xuất xưởng theo thông số kỹ thuật/vật tư chuẩn từ khảo sát, theo dõi tiến độ gia công và quản lý kiểm tra chất lượng (QC).
        </p>
      </div>

      <ProductionView initialData={dashboardData} />
    </div>
  );
}
