import React from 'react';
import { connection } from 'next/server';
import { getActorContext, requireBossAdmin } from '../../../../lib/auth/context';
import { APPLICATION_ROLES } from '../../../../shared/constants/roles';
import { getAiControlState } from '../../../actions/ai-control';
import AiControlCenterClient from './AiControlCenterClient';

export const metadata = {
  title: 'AI Control Center | AI CRM Cửa Chống Ngập',
  description: 'Quản trị tự động trả lời đa kênh, độ tin cậy, chuyển giao tư vấn viên và nhật ký hội thoại AI.',
};

export default async function AiControlCenterPage() {
  await connection();
  const actor = await getActorContext();

  if (!actor || !actor.companyId || actor.membershipStatus !== 'ACTIVE') {
    return (
      <div className="rounded-xl border border-red-900 bg-red-950/30 p-6 text-red-300">
        Truy cập bị từ chối: Chưa xác định tổ chức hoạt động.
      </div>
    );
  }

  // BOSS_ADMIN requires AAL2 for sensitive operations per CRM Auth Policy
  if (actor.role === APPLICATION_ROLES.BOSS_ADMIN) {
    await requireBossAdmin(actor.companyId);
  } else if (actor.role !== APPLICATION_ROLES.SALE) {
    return (
      <div className="rounded-xl border border-red-900 bg-red-950/30 p-6 text-red-300">
        Truy cập bị từ chối: AI Control Center chỉ dành cho Ban Quản trị và Tư vấn viên Sale.
      </div>
    );
  }

  let initialState;
  try {
    initialState = await getAiControlState();
  } catch (err: unknown) {
    const error = err as Error;
    return (
      <div className="rounded-xl border border-red-900 bg-red-950/30 p-6">
        <h2 className="text-xl font-bold text-red-300">Không thể tải dữ liệu AI Control Center</h2>
        <p className="mt-2 text-sm text-slate-400">{error?.message || 'Lỗi kết nối cơ sở dữ liệu.'}</p>
      </div>
    );
  }

  return <AiControlCenterClient initialState={initialState} />;
}
