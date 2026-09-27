import React from 'react';
import { getActorContext, requireCompanyRole } from '../../../lib/auth/context';
import { APPLICATION_ROLES } from '../../../shared/constants/roles';

export default async function FieldLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const actor = await getActorContext();

  if (!actor || !actor.companyId) {
    return (
      <div className="p-8 text-center text-red-400">
        Truy cập bị từ chối: Chưa xác định tổ chức.
      </div>
    );
  }

  // Server-side authorization check enforcing TECHNICIAN or BOSS_ADMIN
  try {
    await requireCompanyRole(actor.companyId, [
      APPLICATION_ROLES.BOSS_ADMIN,
      APPLICATION_ROLES.TECHNICIAN,
    ]);
  } catch (err: unknown) {
    const error = err as Error;
    return (
      <div className="p-8 text-center bg-red-950/40 border border-red-800 rounded-xl">
        <h2 className="text-xl font-bold text-red-400 mb-2">Quyền truy cập Hiện trường (Kỹ thuật)</h2>
        <p className="text-slate-300 text-sm">
          {error.message || 'Khu vực này chỉ dành cho Kỹ thuật viên hoặc Quản trị viên.'}
        </p>
      </div>
    );
  }

  return <div>{children}</div>;
}
