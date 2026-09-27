import React from 'react';
import { getActorContext } from '../../../lib/auth/context';

export default async function CrmDashboardPage() {
  const actor = await getActorContext();

  return (
    <div className="space-y-6">
      <div className="border-b border-slate-800 pb-4">
        <h1 className="text-2xl font-bold text-white">Hộp thư & CRM Bán hàng</h1>
        <p className="text-sm text-slate-400">
          Màn hình làm việc tập trung cho tư vấn khách hàng và chốt đơn (SALE duy nhất).
        </p>
      </div>

      <div className="p-6 bg-slate-900 border border-slate-800 rounded-xl space-y-4">
        <div className="flex items-center justify-between">
          <div className="font-semibold text-white">Ngữ cảnh Thành viên Hợp lệ</div>
          <span className="px-2.5 py-1 rounded bg-blue-900/40 border border-blue-700/50 text-blue-300 font-mono text-xs">
            {actor?.role}
          </span>
        </div>
        <p className="text-sm text-slate-300">
          Chào mừng <strong className="text-white">{actor?.fullName}</strong>. Bạn đã được ủy quyền làm việc trên dữ liệu khách hàng của doanh nghiệp theo chính sách Zero-Phone Exposure (không lộ số điện thoại).
        </p>
      </div>
    </div>
  );
}
