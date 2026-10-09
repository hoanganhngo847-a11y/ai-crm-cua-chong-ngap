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

  // 2. Resolve current route for normal MFA setup/verification handling.
  const headersList = await headers();
  const currentPath = headersList.get('x-pathname') || '';
  const isMfaRoute = currentPath.startsWith('/admin/mfa');

  // Dedicated Meta App Review accounts are explicitly allowlisted server-side.
  // Their temporary exemption is user-scoped rather than path-scoped here because
  // the pathname header is not guaranteed to survive every production render hop.
  // The Facebook connect API routes still independently enforce the same exact
  // reviewer allowlist, BOSS_ADMIN role, and company membership.
  const isMetaReviewMfaExemption = isMetaReviewerMfaExempt(actor.userId);

  // If an allowlisted reviewer lands on an MFA screen from an older redirect,
  // send them to the intended review surface instead of enrolling a TOTP factor.
  if (isMetaReviewMfaExemption && isMfaRoute) {
    redirect('/admin/facebook');
  }

  // 3. Normal BOSS_ADMIN users still require AAL2. Only the exact temporary
  // Meta reviewer account configured by server-side UUID is exempt.
  if (
    !isMfaRoute &&
    !isMetaReviewMfaExemption &&
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
