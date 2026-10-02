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
      <div className="p-8 text-center bg-slate-900 border border-slate-800 rounded-xl space-y-3">
        <h2 className="text-lg font-bold text-rose-400">Không có quyền truy cập</h2>
        <p className="text-sm text-slate-400">
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
