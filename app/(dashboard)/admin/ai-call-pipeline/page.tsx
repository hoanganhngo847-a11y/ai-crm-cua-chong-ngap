import React from 'react';
import Link from 'next/link';
import { connection } from 'next/server';
import { getActorContext, requireBossAdmin } from '../../../../lib/auth/context';
import {
  getZaloAiPipelineDashboard,
  type PipelineStageStatus,
} from '../../../../features/zalo-monitoring/dashboard';

const dateTimeFormatter = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function formatDateTime(value: string | null) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : dateTimeFormatter.format(parsed);
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remain = rounded % 60;
  return hours > 0
    ? `${hours}g ${minutes}p ${remain}s`
    : minutes > 0
      ? `${minutes}p ${remain}s`
      : `${remain}s`;
}

function statusClass(status: string) {
  switch (status) {
    case 'COMPLETED':
    case 'READY':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
    case 'PROCESSING':
      return 'border-blue-500/30 bg-blue-500/10 text-blue-300';
    case 'PENDING':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
    case 'FAILED':
      return 'border-red-500/30 bg-red-500/10 text-red-300';
    case 'NOT_STARTED':
      return 'border-slate-700 bg-slate-800 text-slate-400';
    default:
      return 'border-slate-700 bg-slate-800 text-slate-300';
  }
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold ${statusClass(status)}`}>
      {status}
    </span>
  );
}

function StageBreakdown({ counts }: { counts: Record<PipelineStageStatus, number> }) {
  const stages: PipelineStageStatus[] = ['COMPLETED', 'PROCESSING', 'PENDING', 'FAILED', 'NOT_STARTED'];
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {stages.map((stage) => (
        <span key={stage} className="rounded bg-slate-950 px-2 py-1 text-[11px] text-slate-400">
          {stage}: <span className="font-semibold text-slate-200">{counts[stage]}</span>
        </span>
      ))}
    </div>
  );
}

export default async function AiCallPipelinePage() {
  await connection();

  const actor = await getActorContext();
  if (!actor?.companyId) {
    return <div className="rounded-xl border border-red-900 bg-red-950/30 p-6 text-red-300">Không xác định được doanh nghiệp.</div>;
  }

  await requireBossAdmin(actor.companyId, { requireAal2: false });

  let dashboard;
  try {
    dashboard = await getZaloAiPipelineDashboard(actor.companyId);
  } catch {
    return (
      <div className="space-y-4">
        <Link href="/admin" className="text-sm text-blue-400 hover:text-blue-300">← Quay lại Quản trị</Link>
        <div className="rounded-xl border border-red-900 bg-red-950/30 p-6">
          <h1 className="text-xl font-bold text-red-300">AI Call Pipeline tạm thời không khả dụng</h1>
          <p className="mt-2 text-sm text-slate-400">Không thể tải dữ liệu giám sát. Không có thao tác ghi hoặc retry nào được thực hiện.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 border-b border-slate-800 pb-5 md:flex-row md:items-end md:justify-between">
        <div>
          <Link href="/admin" className="text-sm text-blue-400 hover:text-blue-300">← Quay lại Quản trị</Link>
          <h1 className="mt-2 text-2xl font-bold text-white">AI Call Pipeline</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Giám sát read-only luồng Zalo Personal: Recording → Transcription → AI Summary. Trang này không tự retry, không backfill và không thay đổi dữ liệu CRM.
          </p>
        </div>
        <div className="text-xs text-slate-500">Cập nhật: {formatDateTime(dashboard.generatedAt)}</div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <div className="text-xs uppercase tracking-wide text-slate-500">Cuộc gọi {dashboard.windowDays} ngày</div>
          <div className="mt-2 text-3xl font-bold text-white">{dashboard.totalCalls}</div>
          <div className="mt-1 text-xs text-slate-500">Recording READY: {dashboard.recordingReady}</div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <div className="text-xs uppercase tracking-wide text-slate-500">Transcription</div>
          <div className="mt-2 flex items-baseline gap-3">
            <span className="text-3xl font-bold text-emerald-400">{dashboard.transcription.COMPLETED}</span>
            <span className="text-sm text-red-400">{dashboard.transcription.FAILED} failed</span>
          </div>
          <StageBreakdown counts={dashboard.transcription} />
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <div className="text-xs uppercase tracking-wide text-slate-500">AI Summary</div>
          <div className="mt-2 flex items-baseline gap-3">
            <span className="text-3xl font-bold text-emerald-400">{dashboard.summary.COMPLETED}</span>
            <span className="text-sm text-red-400">{dashboard.summary.FAILED} failed</span>
          </div>
          <StageBreakdown counts={dashboard.summary} />
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <div className="text-xs uppercase tracking-wide text-slate-500">Gemini Pool</div>
          {dashboard.geminiPool.visible ? (
            <>
              <div className="mt-2 flex items-baseline gap-3">
                <span className="text-3xl font-bold text-emerald-400">{dashboard.geminiPool.ready}</span>
                <span className="text-sm text-slate-400">/ {dashboard.geminiPool.total} ready</span>
              </div>
              <div className="mt-2 text-xs text-slate-500">
                Cooldown: {dashboard.geminiPool.cooling} · Disabled: {dashboard.geminiPool.disabled}
              </div>
              <Link href="/admin/gemini-keys" className="mt-3 inline-block text-xs text-blue-400 hover:text-blue-300">Quản lý Gemini Pool →</Link>
            </>
          ) : (
            <div className="mt-3 text-sm text-slate-500">Không hiển thị cho company này.</div>
          )}
        </div>
      </div>

      {dashboard.windowTruncated && (
        <div className="rounded-lg border border-amber-800/50 bg-amber-950/20 px-4 py-3 text-xs text-amber-300">
          Thống kê cửa sổ {dashboard.windowDays} ngày đã chạm giới hạn 1.000 cuộc gọi; bảng gần nhất vẫn hiển thị chính xác 30 cuộc gọi mới nhất.
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
        <div className="border-b border-slate-800 px-5 py-4">
          <h2 className="font-semibold text-white">30 cuộc gọi gần nhất</h2>
          <p className="mt-1 text-xs text-slate-500">Chỉ hiển thị mã lỗi canonical; raw provider error/message không được đưa ra giao diện.</p>
        </div>

        {dashboard.recentCalls.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">Chưa có cuộc gọi Zalo Personal.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-[1180px] w-full text-left text-sm">
              <thead className="bg-slate-950/70 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3">Cuộc gọi</th>
                  <th className="px-4 py-3">Recording</th>
                  <th className="px-4 py-3">Transcription</th>
                  <th className="px-4 py-3">AI Summary</th>
                  <th className="px-4 py-3">CRM match</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {dashboard.recentCalls.map((call) => (
                  <tr key={call.id} className="align-top hover:bg-slate-800/30">
                    <td className="px-4 py-4">
                      <div className="font-medium text-white">{call.remoteDisplayName || 'Không rõ tên'}</div>
                      <div className="mt-1 text-xs text-slate-500">{call.direction} · {formatDuration(call.durationSeconds)}</div>
                      <div className="mt-1 text-xs text-slate-500">{formatDateTime(call.startedAt)}</div>
                      <div className="mt-1 font-mono text-[10px] text-slate-600">{call.id.slice(0, 8)}…</div>
                    </td>
                    <td className="px-4 py-4">
                      <StatusBadge status={call.recordingStatus} />
                    </td>
                    <td className="px-4 py-4">
                      <StatusBadge status={call.transcription?.status || call.transcriptStatus} />
                      {call.transcription ? (
                        <div className="mt-2 space-y-1 text-xs text-slate-500">
                          <div>{call.transcription.provider}{call.transcription.model ? ` · ${call.transcription.model}` : ''}</div>
                          <div>Attempts: {call.transcription.attempts}/{call.transcription.maxAttempts}</div>
                          {call.transcription.errorCode && <div className="font-mono text-red-400">{call.transcription.errorCode}</div>}
                        </div>
                      ) : (
                        <div className="mt-2 text-xs text-slate-600">Chưa có job</div>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      <StatusBadge status={call.summary?.status || call.summaryStatus} />
                      {call.summary ? (
                        <div className="mt-2 space-y-1 text-xs text-slate-500">
                          <div>{call.summary.provider} · {call.summary.model}</div>
                          <div>Attempts: {call.summary.attempts}/{call.summary.maxAttempts}</div>
                          {call.summary.leadTemperature && <div>Lead: <span className="font-semibold text-slate-300">{call.summary.leadTemperature}</span></div>}
                          {call.summary.followUpRequired && <div className="text-amber-300">AI đề xuất follow-up</div>}
                          {call.summary.errorCode && <div className="font-mono text-red-400">{call.summary.errorCode}</div>}
                        </div>
                      ) : (
                        <div className="mt-2 text-xs text-slate-600">Chưa có job</div>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      <StatusBadge status={call.matchingStatus} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
