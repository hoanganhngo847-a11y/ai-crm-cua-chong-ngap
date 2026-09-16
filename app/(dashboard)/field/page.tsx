import React from 'react';
import { getActorContext } from '../../../lib/auth/context';

export default async function FieldDashboardPage() {
  const actor = await getActorContext();

  return (
    <div className="space-y-6">
      <div className="border-b border-slate-800 pb-4">
        <h1 className="text-2xl font-bold text-white">Khảo sát & Lắp đặt Hiện trường</h1>
        <p className="text-sm text-slate-400">
          Khu vực tác nghiệp của Kỹ thuật viên (TECHNICIAN) theo từng phân công hiện hành.
        </p>
      </div>

      <div className="p-6 bg-slate-900 border border-slate-800 rounded-xl space-y-4">
        <div className="flex items-center justify-between">
          <div className="font-semibold text-white">Thông tin Kỹ thuật viên</div>
          <span className="px-2.5 py-1 rounded bg-amber-900/40 border border-amber-700/50 text-amber-300 font-mono text-xs">
            {actor?.role}
          </span>
        </div>
        <p className="text-sm text-slate-300">
          Kỹ thuật viên: <strong className="text-white">{actor?.fullName}</strong>.
          <br />
          Theo AUTH DECISION 05, quyền khảo sát/lắp đặt chỉ khả dụng cho các công việc bạn đang được phân công trực tiếp ở trạng thái ASSIGNED, ACCEPTED, hoặc IN_PROGRESS.
        </p>
      </div>
    </div>
  );
}
