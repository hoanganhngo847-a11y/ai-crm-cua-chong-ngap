import { redirect } from 'next/navigation';
import { getActorContext } from '../../../lib/auth/context';
import { APPLICATION_ROLES } from '../../../shared/constants/roles';
import CustomerList from '../../../features/crm/components/customer-list';

export default async function CrmDashboardPage() {
  const actor = await getActorContext();

  if (!actor || actor.profileStatus !== 'ACTIVE') {
    redirect('/login');
  }

  // Chặn Kỹ thuật viên (chỉ BOSS_ADMIN và SALE được truy cập CRM).
  if (actor.role !== APPLICATION_ROLES.BOSS_ADMIN && actor.role !== APPLICATION_ROLES.SALE) {
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
          Khu vực CRM bán hàng chỉ dành cho Chuyên viên Sale và Ban quản trị. Kỹ thuật viên vui lòng truy cập{' '}
          <a href="/field" className="text-blue-400 underline hover:text-blue-300">
            Hiện trường &amp; Khảo sát
          </a>.
        </p>
      </div>
    );
  }

  // CRM chính dùng cùng màn hình Customer 360 đã có phân quyền dữ liệu theo vai trò:
  // - BOSS_ADMIN: số điện thoại thật (có audit bắt buộc ở API).
  // - SALE: chỉ nhận số đã che.
  return <CustomerList userRole={actor.role} userFullName={actor.fullName} />;
}
