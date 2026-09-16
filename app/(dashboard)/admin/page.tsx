import React from 'react';
import { getActorContext } from '../../../lib/auth/context';

export default async function AdminDashboardPage() {
  const actor = await getActorContext();

  return (
    <div className="space-y-6">
      <div className="border-b border-slate-800 pb-4">
        <h1 className="text-2xl font-bold text-white">Bảng điều khiển Quản trị viên (Sếp)</h1>
        <p className="text-sm text-slate-400">
          Khu vực bảo mật cao nhất: Quản lý nhân sự, chính sách giá và tài chính doanh nghiệp.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="p-6 bg-slate-900 border border-slate-800 rounded-xl">
          <div className="text-sm font-medium text-slate-400 mb-1">Xác thực 2 yếu tố (MFA)</div>
          <div className="text-lg font-semibold text-white">
            Cấp độ hiện tại: <span className="text-emerald-400 font-mono">{actor?.aal?.toUpperCase() || 'AAL1'}</span>
          </div>
          <p className="text-xs text-slate-500 mt-2">
            Theo AUTH DECISION 01, tài khoản BOSS_ADMIN yêu cầu AAL2 khi truy cập dữ liệu nhạy cảm.
          </p>
        </div>

        <div className="p-6 bg-slate-900 border border-slate-800 rounded-xl">
          <div className="text-sm font-medium text-slate-400 mb-1">Quyền hạn Doanh nghiệp</div>
          <div className="text-lg font-semibold text-blue-400 font-mono">{actor?.role}</div>
          <p className="text-xs text-slate-500 mt-2">
            Được ủy quyền quản trị toàn bộ dữ liệu thuộc Company: {actor?.companyId}
          </p>
        </div>

        <div className="p-6 bg-slate-900 border border-slate-800 rounded-xl">
          <div className="text-sm font-medium text-slate-400 mb-1">Trạng thái Hồ sơ</div>
          <div className="text-lg font-semibold text-emerald-400">{actor?.profileStatus}</div>
          <p className="text-xs text-slate-500 mt-2">
            Hồ sơ người dùng ứng dụng và tư cách thành viên đều đang ACTIVE.
          </p>
        </div>
      </div>
    </div>
  );
}
