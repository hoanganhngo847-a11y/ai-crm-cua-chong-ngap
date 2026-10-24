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
      <div className="p-8 text-center bg-white border border-border-subtle rounded-xl space-y-3 max-w-lg mx-auto my-12 shadow-xs">
        <h2 className="text-base font-semibold text-danger">Không có quyền truy cập</h2>
        <p className="text-sm text-text-secondary">
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
