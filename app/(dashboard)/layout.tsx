import React from 'react';
import { redirect } from 'next/navigation';
import { getActorContext } from '../../lib/auth/context';
import { logoutAction } from '../(auth)/actions';

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
      <div className="min-h-screen flex items-center justify-center bg-slate-900 text-white p-4">
        <div className="max-w-md p-6 bg-slate-800 rounded-xl border border-red-500/30 text-center">
          <h2 className="text-xl font-bold text-red-400 mb-2">Truy cập bị từ chối</h2>
          <p className="text-slate-300 text-sm mb-4">
            Tài khoản của bạn chưa có tư cách thành viên hoạt động trong tổ chức nào.
          </p>
          <form action={logoutAction}>
            <button
              type="submit"
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm text-white"
            >
              Đăng xuất
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      {/* Top Navigation Bar */}
      <header className="h-16 border-b border-slate-800 bg-slate-900/80 backdrop-blur px-6 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <span className="font-bold text-lg bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
            AI CRM Cửa Chống Ngập
          </span>
          <nav className="flex items-center gap-4 text-sm">
            {(actor.role === 'BOSS_ADMIN' || actor.role === 'SALE') && (
              <a href="/crm" className="text-slate-300 hover:text-white transition">
                CRM & Hộp thư
              </a>
            )}
            {(actor.role === 'BOSS_ADMIN' || actor.role === 'TECHNICIAN') && (
              <a href="/field" className="text-slate-300 hover:text-white transition">
                Hiện trường & Khảo sát
              </a>
            )}
            {actor.role === 'BOSS_ADMIN' && (
              <a href="/admin" className="text-slate-300 hover:text-white transition">
                Quản trị hệ thống
              </a>
            )}
            <a href="/account" className="text-slate-300 hover:text-white transition">
              Tài khoản
            </a>
          </nav>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-sm font-medium text-white">{actor.fullName || actor.email}</div>
            <div className="text-xs text-slate-400">
              <span className="inline-block px-2 py-0.5 rounded bg-slate-800 text-blue-400 font-mono font-semibold">
                {actor.role}
              </span>
              {actor.aal && (
                <span className="ml-2 inline-block px-1.5 py-0.2 rounded bg-slate-800/80 text-emerald-400 font-mono text-[10px]">
                  {actor.aal.toUpperCase()}
                </span>
              )}
            </div>
          </div>
          <form action={logoutAction}>
            <button
              id="header-logout-button"
              type="submit"
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 hover:text-white border border-slate-700 transition"
            >
              Đăng xuất
            </button>
          </form>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 p-6 max-w-7xl w-full mx-auto">{children}</main>
    </div>
  );
}
