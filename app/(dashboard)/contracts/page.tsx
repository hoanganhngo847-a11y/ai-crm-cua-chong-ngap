import 'server-only';
import React from 'react';
import { getActorContext } from '@/lib/auth/context';
import { APPLICATION_ROLES } from '@/shared/constants/roles';
import { getContractsWithOrderDetails, type ContractListItemDTO } from '@/features/contract/services';
import ContractsView from '@/features/contract/components/contracts-view';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';

export const metadata = {
  title: 'Quản lý Hợp đồng & Ký duyệt | AI CRM Cửa Chống Ngập',
  description: 'Xem bản nháp hợp đồng, tải tài liệu đã ký và ký duyệt hợp đồng chính thức cấp độ AAL2',
};

export default async function ContractsPage() {
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

  // Kỹ thuật viên không có quyền truy cập thương mại Hợp đồng
  if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
    return (
      <EmptyState
        type="permission"
        title="Truy cập bị từ chối"
        description="Tài khoản của bạn mang vai trò Kỹ thuật viên, không có quyền truy cập danh sách hợp đồng thương mại."
        action={{
          label: 'Về trang Hiện trường & Lắp đặt',
          href: '/field',
        }}
      />
    );
  }

  const contracts: ContractListItemDTO[] = await getContractsWithOrderDetails(actor.companyId);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Hợp Đồng & Ký Duyệt (Contracts & Signatures)"
        description="Xem bản nháp hợp đồng kinh tế, tải bản ký và phê duyệt chữ ký chính thức cấp độ AAL2."
      />

      <ContractsView
        contracts={contracts}
        userRole={actor.role || ''}
        userAal={actor.aal}
      />
    </div>
  );
}
