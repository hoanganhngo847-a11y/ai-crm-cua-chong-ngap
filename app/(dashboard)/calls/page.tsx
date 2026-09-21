import React from 'react';
import { redirect } from 'next/navigation';
import { getActorContext } from '../../../lib/auth/context';
import { getCompanyCallHistoryAction } from '../../actions/voice';
import CallHistoryTable from './components/CallHistoryTable';
import CustomerCallSearch from './components/CustomerCallSearch';

export default async function CallsPage() {
  const actor = await getActorContext();

  if (!actor || actor.profileStatus !== 'ACTIVE') {
    redirect('/login');
  }

  if (!actor.companyId || actor.membershipStatus !== 'ACTIVE') {
    redirect('/login');
  }

  // TECHNICIAN không có quyền xem trang này
  if (actor.role === 'TECHNICIAN') {
    return (
      <div className="flex items-center justify-center min-h-64">
        <div className="p-6 bg-slate-900 border border-red-500/30 rounded-xl text-center">
          <h2 className="text-red-400 font-bold mb-2">Truy cập bị từ chối</h2>
          <p className="text-slate-400 text-sm">Kỹ thuật viên không có quyền xem lịch sử cuộc gọi.</p>
        </div>
      </div>
    );
  }

  const isBossAdmin = actor.role === 'BOSS_ADMIN';

  const result = await getCompanyCallHistoryAction({ page: 1, pageSize: 20 });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="border-b border-slate-800 pb-4">
        <h1 className="text-2xl font-bold text-white">Lịch sử cuộc gọi</h1>
        <p className="text-sm text-slate-400 mt-1">
          {isBossAdmin
            ? 'Toàn bộ cuộc gọi — AI gọi ra, Hotline gọi vào, Sale gọi khách.'
            : 'Cuộc gọi trong hệ thống — tìm khách và bấm GỌI KHÁCH để liên hệ.'}
        </p>
      </div>

      <CustomerCallSearch provider={(process.env.VOICE_PROVIDER || 'MANUAL').toUpperCase()} />

      {/* Kết quả */}
      {result.success && result.data ? (
        <CallHistoryTable
          initialItems={result.data.items}
          total={result.data.total}
          currentPage={result.data.page}
          pageSize={result.data.pageSize}
          isBossAdmin={isBossAdmin}
        />
      ) : (
        <div className="p-6 bg-slate-900 border border-red-500/20 rounded-xl text-center text-red-400">
          {result.error || 'Không thể tải lịch sử cuộc gọi.'}
        </div>
      )}
    </div>
  );
}
