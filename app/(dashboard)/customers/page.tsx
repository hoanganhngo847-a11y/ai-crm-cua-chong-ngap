import React from 'react';
import { redirect } from 'next/navigation';
import { getActorContext } from '../../../lib/auth/context';
import { APPLICATION_ROLES } from '../../../shared/constants/roles';
import CustomerList from '../../../features/crm/components/customer-list';
import { EmptyState } from '../../../components/ui/empty-state';

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
      <EmptyState
        type="permission"
        title="Truy Cập Bị Từ Chối"
        description="Tài khoản của bạn mang vai trò KỸ THUẬT VIÊN. Khu vực Hiện trường & Khảo sát đã được gỡ khỏi hệ thống; vui lòng liên hệ quản trị viên nếu cần hỗ trợ."
        action={{
          label: 'Về trang Tài khoản',
          href: '/account',
        }}
      />
    );
  }

  return <CustomerList userRole={actor.role} userFullName={actor.fullName} />;
}
