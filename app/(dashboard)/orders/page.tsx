import 'server-only';
import React from 'react';
import { getActorContext } from '@/lib/auth/context';
import { APPLICATION_ROLES } from '@/shared/constants/roles';
import { getOrdersWithDetails } from '@/features/order/services';
import OrdersView from '@/features/order/components/orders-view';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';

export const metadata = {
  title: 'Quản lý Đơn hàng & Đặt cọc | AI CRM Cửa Chống Ngập',
  description: 'Quản lý tiến trình đơn hàng, tình trạng đặt cọc, công nợ và hợp đồng kinh tế',
};

export default async function OrdersPage() {
  const actor = await getActorContext();

  if (!actor || !actor.companyId) {
    return (
      <EmptyState
        type="permission"
        title="Truy cập bị từ chối"
        description="Chưa xác định danh tính hoặc tổ chức của phiên làm việc."
      />
    );
  }

  // Chặn Kỹ thuật viên (Chỉ BOSS_ADMIN và SALE được truy cập bề mặt Đơn hàng)
  if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
    return (
      <EmptyState
        type="permission"
        title="Truy cập bị từ chối"
        description="Tài khoản của bạn mang vai trò Kỹ thuật viên, không có quyền truy cập thông tin thương mại đơn hàng."
        action={{
          label: 'Về trang Hiện trường & Lắp đặt',
          href: '/field',
        }}
      />
    );
  }

  const orders = await getOrdersWithDetails(actor.companyId);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Đơn Hàng & Thanh Toán (Orders & Payments)"
        description="Theo dõi trạng thái đơn hàng, đối soát thanh toán cọc và quản lý phát hành hợp đồng kinh tế."
      />

      <OrdersView orders={orders} userRole={actor.role || ''} />
    </div>
  );
}
