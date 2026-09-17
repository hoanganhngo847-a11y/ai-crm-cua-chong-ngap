import React from 'react';
import { redirect } from 'next/navigation';
import { getActorContext } from '../../../lib/auth/context';
import { APPLICATION_ROLES } from '../../../shared/constants/roles';
import CustomerList from '../../../features/crm/components/customer-list';

export const metadata = {
  title: 'Khách hàng | AI CRM Cửa Chống Ngập',
  description: 'Quản lý danh sách và hành trình khách hàng đa kênh',
};

export default async function CustomersDashboardPage() {
  const actor = await getActorContext();

  if (!actor || actor.profileStatus !== 'ACTIVE') {
    redirect('/login');
  }

  // Kỹ thuật viên không có quyền truy cập danh sách khách hàng CRM tổng
  if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
    return (
      <div className="p-8 max-w-xl mx-auto text-center space-y-4">
        <div className="w-16 h-16 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-400 flex items-center justify-center mx-auto">
          <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-white">Truy Cập Bị Từ Chối</h2>
        <p className="text-sm text-slate-400">
          Tài khoản của bạn mang vai trò <strong>KỸ THUẬT VIÊN</strong>. Bạn chỉ có quyền xem các
          lịch hẹn và khảo sát được phân công trực tiếp tại mục{' '}
          <a href="/field" className="text-blue-400 underline hover:text-blue-300">
            Hiện trường & Khảo sát
          </a>
          .
        </p>
      </div>
    );
  }

  return <CustomerList userRole={actor.role} userFullName={actor.fullName} />;
}
