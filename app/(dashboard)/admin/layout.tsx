import React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getActorContext, requireBossAdmin } from '../../../lib/auth/context';
import { isMetaReviewerMfaExempt } from '../../../lib/auth/meta-review';
import { APPLICATION_ROLES } from '../../../shared/constants/roles';

export default async function AdminLayout({
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

  // 1. First enforce that the user is BOSS_ADMIN.
  // The Meta reviewer exception never bypasses role/company authorization.
  try {
    await requireBossAdmin(actor.companyId, { requireAal2: false });
  } catch (err: unknown) {
    const error = err as Error;
    return (
      <div className="p-8 text-center bg-red-950/40 border border-red-800 rounded-xl">
        <h2 className="text-xl font-bold text-red-400 mb-2">Quyền truy cập Quản trị viên</h2>
        <p className="text-slate-300 text-sm">{error.message || 'Bạn không có quyền truy cập.'}</p>
      </div>
    );
  }

  // 2. Check current path to allow MFA setup and verification pages.
  const headersList = await headers();
  const currentPath = headersList.get('x-pathname') || '';
  const isMfaRoute = currentPath.startsWith('/admin/mfa');
  const isFacebookConnectionRoute =
    currentPath === '/admin/facebook' || currentPath.startsWith('/admin/facebook/');
  const isMetaReviewFacebookExemption =
    isFacebookConnectionRoute && isMetaReviewerMfaExempt(actor.userId);

  // 3. BOSS_ADMIN still requires AAL2 everywhere except the narrowly scoped
  // Facebook connection page for an explicitly configured Meta reviewer user.
  if (
    !isMfaRoute &&
    !isMetaReviewFacebookExemption &&
    actor.role === APPLICATION_ROLES.BOSS_ADMIN &&
    actor.aal !== 'aal2'
  ) {
    if (!actor.isMfaEnrolled) {
      redirect('/admin/mfa/enroll');
    } else {
      redirect('/admin/mfa/verify');
    }
  }

  return <div>{children}</div>;
}
