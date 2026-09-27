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

      {/* Analytics Dashboard Direct Navigation Card */}
      <div className="p-6 bg-gradient-to-r from-blue-950/40 via-slate-900 to-indigo-950/40 border border-blue-500/20 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-white">Analytics doanh nghiệp (Báo cáo & Thống kê)</h2>
            <span className="text-[10px] px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 font-mono">M9.5</span>
          </div>
          <p className="text-xs text-slate-400 mt-1 max-w-2xl">
            Theo dõi toàn diện các chỉ số kinh doanh, phễu khách hàng, thời gian phản hồi SLA 5 phút, hoạt động khảo sát, và ảnh chụp tình hình tài chính doanh nghiệp.
          </p>
        </div>
        <a
          href="/admin/analytics"
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-semibold transition shrink-0 text-center"
        >
          Mở Dashboard →
        </a>
      </div>
    </div>
  );
}
