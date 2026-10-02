import React from 'react';
import { redirect } from 'next/navigation';
import { getActorContext } from '../../../lib/auth/context';
import { APPLICATION_ROLES } from '../../../shared/constants/roles';
import { getWarrantyDashboardData } from '../../../features/warranty/warranty-service';
import { WarrantyView } from '../../../features/warranty/components/warranty-view';

export default async function WarrantyDashboardPage() {
  const actor = await getActorContext();
  if (!actor?.companyId || !actor?.userId) {
    redirect('/login');
  }

  // Allowed roles: BOSS_ADMIN, SALE, TECHNICIAN
  if (
    actor.role !== APPLICATION_ROLES.BOSS_ADMIN &&
    actor.role !== APPLICATION_ROLES.SALE &&
    actor.role !== APPLICATION_ROLES.TECHNICIAN
  ) {
    return (
      <div className="p-8 text-center bg-slate-900 border border-slate-800 rounded-xl space-y-3">
        <h2 className="text-lg font-bold text-rose-400">Không có quyền truy cập</h2>
        <p className="text-sm text-slate-400">
          Trang bảo hành yêu cầu vai trò Quản trị viên, Sale, hoặc Kỹ thuật viên.
        </p>
      </div>
    );
  }

  const initialData = await getWarrantyDashboardData(
    actor.companyId,
    actor.userId,
    actor.role || ''
  );

  return <WarrantyView initialData={initialData} />;
}
