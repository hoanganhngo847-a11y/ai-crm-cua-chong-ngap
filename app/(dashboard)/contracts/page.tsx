import 'server-only';
import React from 'react';
import { getActorContext } from '@/lib/auth/context';
import { APPLICATION_ROLES } from '@/shared/constants/roles';
import { getContractsWithOrderDetails, type ContractListItemDTO } from '@/features/contract/services';
import ContractsView from '@/features/contract/components/contracts-view';

export const metadata = {
  title: 'Quản lý Hợp đồng & Ký duyệt | AI CRM Cửa Chống Ngập',
  description: 'Xem bản nháp hợp đồng, tải tài liệu đã ký và ký duyệt hợp đồng chính thức cấp độ AAL2',
};

export default async function ContractsPage() {
  const actor = await getActorContext();

  if (!actor || !actor.companyId) {
    return (
      <div className="p-8 text-center bg-rose-950/40 border border-rose-800 rounded-xl m-6">
        <h2 className="text-xl font-bold text-rose-400 mb-2">Truy cập bị từ chối</h2>
        <p className="text-slate-300 text-sm">Chưa xác định danh tính hoặc tổ chức của phiên làm việc.</p>
      </div>
    );
  }

  // Kỹ thuật viên không có quyền truy cập thương mại Hợp đồng
  if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
    return (
      <div className="p-8 text-center bg-rose-950/40 border border-rose-800 rounded-xl m-6">
        <h2 className="text-xl font-bold text-rose-400 mb-2">Truy cập bị từ chối</h2>
        <p className="text-slate-300 text-sm">
          Tài khoản của bạn mang vai trò Kỹ thuật viên, không có quyền truy cập danh sách hợp đồng thương mại.
        </p>
      </div>
    );
  }

  const contracts: ContractListItemDTO[] = await getContractsWithOrderDetails(actor.companyId);

  return (
    <div className="space-y-6">
      <div className="border-b border-slate-800 pb-4">
        <h1 className="text-2xl font-bold text-white">Quản lý Hợp đồng &amp; Ký duyệt (Contracts &amp; Signatures)</h1>
        <p className="text-sm text-slate-400">
          Xem bản nháp hợp đồng kinh tế, tải bản ký và phê duyệt chữ ký chính thức cấp độ AAL2.
        </p>
      </div>

      <ContractsView
        contracts={contracts}
        userRole={actor.role || ''}
        userAal={actor.aal}
      />
    </div>
  );
}
