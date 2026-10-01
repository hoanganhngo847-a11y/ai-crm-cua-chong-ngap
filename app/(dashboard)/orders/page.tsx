import 'server-only';
import React from 'react';
import { getActorContext } from '@/lib/auth/context';
import { APPLICATION_ROLES } from '@/shared/constants/roles';
import { getOrdersWithDetails } from '@/features/order/services';
import OrdersView from '@/features/order/components/orders-view';

export const metadata = {
  title: 'Quản lý Đơn hàng & Đặt cọc | AI CRM Cửa Chống Ngập',
  description: 'Quản lý tiến trình đơn hàng, tình trạng đặt cọc, công nợ và hợp đồng kinh tế',
};

export default async function OrdersPage() {
  const actor = await getActorContext();

  if (!actor || !actor.companyId) {
    return (
      <div className="p-8 text-center bg-rose-950/40 border border-rose-800 rounded-xl m-6">
        <h2 className="text-xl font-bold text-rose-400 mb-2">Truy cập bị từ chối</h2>
        <p className="text-slate-300 text-sm">Chưa xác định danh tính hoặc tổ chức của phiên làm việc.</p>
      </div>
    );
  }

  // Chặn Kỹ thuật viên (Chỉ BOSS_ADMIN và SALE được truy cập bề mặt Đơn hàng)
  if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
    return (
      <div className="p-8 text-center bg-rose-950/40 border border-rose-800 rounded-xl m-6">
        <h2 className="text-xl font-bold text-rose-400 mb-2">Truy cập bị từ chối</h2>
        <p className="text-slate-300 text-sm">
          Tài khoản của bạn mang vai trò Kỹ thuật viên, không có quyền truy cập thông tin thương mại đơn hàng.
        </p>
      </div>
    );
  }

  const orders = await getOrdersWithDetails(actor.companyId);

  return (
    <div className="space-y-6">
      <div className="border-b border-slate-800 pb-4">
        <h1 className="text-2xl font-bold text-white">Quản lý Đơn hàng &amp; Thanh toán (Orders &amp; Payments)</h1>
        <p className="text-sm text-slate-400">
          Theo dõi trạng thái đơn hàng, đối soát thanh toán cọc và quản lý phát hành hợp đồng kinh tế.
        </p>
      </div>

      <OrdersView orders={orders} userRole={actor.role || ''} />
    </div>
  );
}
