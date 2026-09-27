import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { getActorContext } from '../../../../lib/auth/context';
import { getCallHistoryAction, getContactCycleStatusAction } from '../../../actions/voice';
import { getCallTranscriptAction } from '../../../actions/sensitive';
import CallHistoryTable from '../components/CallHistoryTable';
import CallAttemptTimeline from '../components/CallAttemptTimeline';
import CallToCustomerButton from '../components/CallToCustomerButton';

interface Props {
  params: Promise<{ customerId: string }>;
}

export default async function CustomerCallsPage({ params }: Props) {
  const { customerId } = await params;

  const actor = await getActorContext();

  if (!actor || actor.profileStatus !== 'ACTIVE') {
    redirect('/login');
  }

  if (!actor.companyId || actor.membershipStatus !== 'ACTIVE') {
    redirect('/login');
  }

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

  // Tải song song: lịch sử cuộc gọi + trạng thái chu kỳ
  const [historyResult, cycleResult] = await Promise.all([
    getCallHistoryAction({ customerId, page: 1, pageSize: 20 }),
    getContactCycleStatusAction({ customerId }),
  ]);

  if (!historyResult.success && historyResult.error?.includes('RESOURCE_NOT_FOUND')) {
    notFound();
  }

  // Thông tin khách từ lịch sử (item đầu tiên)
  const firstCall = historyResult.data?.items[0];
  const customerName = firstCall?.customerName || 'Khách hàng';
  const customerCode = firstCall?.customerCode || '';

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="border-b border-slate-800 pb-4">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold text-white">
              {customerName}
              {customerCode && (
                <span className="ml-2 text-base font-mono text-slate-400">[{customerCode}]</span>
              )}
            </h1>
            <p className="text-sm text-slate-400 mt-1">Lịch sử cuộc gọi & chu kỳ liên hệ</p>
          </div>

          {/* Nút GỌI KHÁCH */}
          {(actor.role === 'BOSS_ADMIN' || actor.role === 'SALE') && (
            <CallToCustomerButton
              customerId={customerId}
              customerCode={customerCode}
              customerName={customerName}
              provider={process.env.NEXT_PUBLIC_VOICE_PROVIDER || 'MANUAL'}
            />
          )}
        </div>
      </div>

      {/* Chu kỳ gọi hiện tại */}
      {cycleResult.success && cycleResult.data && (
        <section>
          <h2 className="text-lg font-semibold text-white mb-4">Chu kỳ liên hệ gần nhất</h2>

          <div className="p-4 bg-slate-900/60 border border-slate-800 rounded-xl">
            <div className="flex items-center gap-3 mb-4">
              <span className="text-sm text-slate-400">Trạng thái khách:</span>
              <span className="px-2 py-0.5 rounded text-xs font-mono font-semibold bg-slate-800 text-blue-400">
                {cycleResult.data.customerStage}
              </span>
            </div>

            <CallAttemptTimeline attempts={cycleResult.data.attempts} />
          </div>
        </section>
      )}

      {/* Lịch sử cuộc gọi */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-4">Tất cả cuộc gọi</h2>

        {historyResult.success && historyResult.data ? (
          <CallHistoryTable
            initialItems={historyResult.data.items}
            total={historyResult.data.total}
            currentPage={historyResult.data.page}
            pageSize={historyResult.data.pageSize}
            isBossAdmin={isBossAdmin}
          />
        ) : (
          <div className="p-6 bg-slate-900 border border-red-500/20 rounded-xl text-center text-red-400 text-sm">
            {historyResult.error || 'Không thể tải lịch sử cuộc gọi.'}
          </div>
        )}
      </section>

      {/* Transcript section — BOSS_ADMIN only */}
      {isBossAdmin && historyResult.data?.items.some((c) => c.transcriptStatus === 'COMPLETED') && (
        <section>
          <h2 className="text-lg font-semibold text-white mb-4">
            Bản chép lời cuộc gọi{' '}
            <span className="text-xs text-amber-400 font-normal">
              (Chỉ Quản trị viên — AAL2 có thể được yêu cầu)
            </span>
          </h2>

          <div className="space-y-3">
            {historyResult.data.items
              .filter((c) => c.transcriptStatus === 'COMPLETED')
              .map((call) => (
                <TranscriptCard key={call.id} callId={call.id} startedAt={call.startedAt} />
              ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transcript Card — BOSS_ADMIN only (separate async component)
// ---------------------------------------------------------------------------

async function TranscriptCard({ callId, startedAt }: { callId: string; startedAt: string }) {
  const result = await getCallTranscriptAction({ callId });

  const callTime = new Date(startedAt).toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div
      id={`transcript-${callId}`}
      className="p-4 bg-slate-900/60 border border-slate-700/50 rounded-xl"
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-slate-300">📋 Cuộc gọi {callTime}</span>
        <span className="text-xs text-slate-500 font-mono">{callId}</span>
      </div>

      {result.success && result.data ? (
        <div className="text-sm text-slate-300 whitespace-pre-wrap bg-slate-950/60 p-3 rounded-lg border border-slate-800 max-h-64 overflow-y-auto font-mono text-xs leading-relaxed">
          {result.data.transcript}
        </div>
      ) : (
        <div className="text-sm text-red-400">
          {result.error || result.message || 'Không thể tải transcript.'}
        </div>
      )}
    </div>
  );
}
