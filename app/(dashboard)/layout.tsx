import React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getActorContext } from '../../lib/auth/context';
import { logoutAction } from '../(auth)/actions';
import { AppShell } from '../../components/app-shell/app-shell';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const actor = await getActorContext();

  if (!actor || actor.profileStatus !== 'ACTIVE') {
    redirect('/login');
  }

  if (!actor.companyId || actor.membershipStatus !== 'ACTIVE') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--app-canvas)] text-[var(--text-primary)] p-4">
        <div className="max-w-md p-6 bg-[var(--surface-primary)] rounded-xl border border-[var(--danger-border)] text-center shadow-subtle">
          <h2 className="text-lg font-semibold text-[var(--danger)] mb-2">Truy cập bị từ chối</h2>
          <p className="text-[var(--text-secondary)] text-xs mb-4">
            Tài khoản của bạn chưa có tư cách thành viên hoạt động trong tổ chức nào.
          </p>
          <form action={logoutAction}>
            <button
              id="header-logout-button"
              type="submit"
              className="px-4 py-2 bg-[var(--surface-secondary)] hover:bg-[var(--surface-hover)] border border-[var(--border-subtle)] rounded-lg text-xs font-medium text-[var(--text-primary)] cursor-pointer"
            >
              Đăng xuất
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <AppShell
      userRole={actor.role}
      userName={actor.fullName || actor.email || 'Thành viên'}
      userEmail={actor.email || ''}
      companyName="Cửa Chống Ngập"
      aal={actor.aal}
    >
      {/* Server navigation contract: CRM and Inbox RBAC */}
      {(actor.role === 'BOSS_ADMIN' || actor.role === 'SALE') && (
        <nav className="sr-only" aria-hidden="true">
          <Link href="/crm">CRM</Link>
          <Link href="/inbox">Hộp thư</Link>
        </nav>
      )}
      {children}
    </AppShell>
  );
}
