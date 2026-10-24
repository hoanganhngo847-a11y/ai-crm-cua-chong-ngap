import React from 'react';
import { redirect } from 'next/navigation';
import { getActorContext } from '../../../lib/auth/context';
import { APPLICATION_ROLES } from '../../../shared/constants/roles';
import { getTechnicianFieldWorkspaceData } from '../../../features/installation/installation-service';
import { FieldWorkspaceView } from '../../../features/installation/components/field-workspace-view';

export default async function FieldDashboardPage() {
  const actor = await getActorContext();
  if (!actor?.companyId || !actor?.userId) {
    redirect('/login');
  }

  // Permitted roles: BOSS_ADMIN, TECHNICIAN
  if (actor.role !== APPLICATION_ROLES.BOSS_ADMIN && actor.role !== APPLICATION_ROLES.TECHNICIAN) {
    return (
      <div className="p-8 text-center bg-white border border-border-subtle rounded-xl space-y-3 max-w-lg mx-auto my-12 shadow-xs">
        <h2 className="text-base font-semibold text-danger">Không có quyền truy cập</h2>
        <p className="text-sm text-text-secondary">
          Khu vực Hiện trường chỉ dành cho Kỹ thuật viên (TECHNICIAN) và Quản trị viên (BOSS_ADMIN).
        </p>
      </div>
    );
  }

  const workspaceData = await getTechnicianFieldWorkspaceData(
    actor.companyId,
    actor.userId,
    actor.role || ''
  );

  return <FieldWorkspaceView initialData={workspaceData} />;
}
