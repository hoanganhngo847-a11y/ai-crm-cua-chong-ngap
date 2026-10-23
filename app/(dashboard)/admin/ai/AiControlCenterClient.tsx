'use client';

import React, { useState, useTransition } from 'react';
import Link from 'next/link';
import {
  type AiControlState,
  type LiveChannel,
  type VoiceMode,
  type ModelRoutingProfile,
  type AiMonitoringDashboardState,
  updateAiChannelSettingAction,
  emergencyKillSwitchAction,
  claimHandoverCaseAction,
  resolveHandoverCaseAction,
  resumeAiConversationAction,
  getAiMonitoringDashboardData,
  acknowledgeAlertAction,
  resolveAlertAction,
  triggerAlertEvaluationAction,
} from '../../../actions/ai-control';

const REASON_LABELS: Record<string, { label: string; color: string }> = {
  CUSTOMER_REQUESTED_HUMAN: { label: 'Khách yêu cầu gặp người', color: 'bg-blue-500/10 border-blue-500/30 text-blue-300' },
  CUSTOMER_COMPLAINT: { label: 'Khiếu nại dịch vụ', color: 'bg-red-500/10 border-red-500/30 text-red-300' },
  REFUND_REQUEST: { label: 'Yêu cầu hoàn tiền', color: 'bg-rose-500/10 border-rose-500/30 text-rose-300' },
  PRICE_QUOTATION_REQUIRED: { label: 'Cần báo giá chính thức', color: 'bg-amber-500/10 border-amber-500/30 text-amber-300' },
  LEGAL_OR_POLICY: { label: 'Pháp lý / Chính sách', color: 'bg-purple-500/10 border-purple-500/30 text-purple-300' },
  PAYMENT_ISSUE: { label: 'Vấn đề thanh toán', color: 'bg-orange-500/10 border-orange-500/30 text-orange-300' },
  LOW_CONFIDENCE: { label: 'Độ tin cậy thấp', color: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-300' },
  INSUFFICIENT_KNOWLEDGE: { label: 'Thiếu dữ liệu kiến thức', color: 'bg-cyan-500/10 border-cyan-500/30 text-cyan-300' },
  HIGH_VALUE_LEAD: { label: 'Khách tiềm năng cao', color: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' },
  OTHER: { label: 'Lý do khác', color: 'bg-slate-500/10 border-slate-500/30 text-slate-300' },
};

const PRIORITY_BADGES: Record<string, { label: string; color: string }> = {
  URGENT: { label: 'Khẩn cấp', color: 'bg-red-500/20 text-red-300 border-red-500/40' },
  HIGH: { label: 'Cao', color: 'bg-amber-500/20 text-amber-300 border-amber-500/40' },
  NORMAL: { label: 'Bình thường', color: 'bg-blue-500/20 text-blue-300 border-blue-500/40' },
  LOW: { label: 'Thấp', color: 'bg-slate-500/20 text-slate-300 border-slate-500/40' },
};

function formatTimeAgo(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${Math.max(1, diffSec)} giây trước`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} phút trước`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours} giờ trước`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} ngày trước`;
}

export default function AiControlCenterClient({ initialState }: { initialState: AiControlState }) {
  const [activeTab, setActiveTab] = useState<'settings' | 'handover' | 'conversations' | 'monitoring'>('settings');
  const [isPending, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [showKillConfirm, setShowKillConfirm] = useState(false);

  // Monitoring & Alerts state
  const [monitoring, setMonitoring] = useState<AiMonitoringDashboardState>(initialState.monitoring);
  const [metricsWindow, setMetricsWindow] = useState<'1h' | '24h' | '7d' | '30d'>('24h');
  const [metricsChannel, setMetricsChannel] = useState<string>('ALL');
  const [isRefreshingMonitoring, setIsRefreshingMonitoring] = useState(false);

  // Filters for Handover tab
  const [handoverFilter, setHandoverFilter] = useState<'ALL' | 'OPEN' | 'CLAIMED' | 'RESOLVED'>('OPEN');

  // Filters for Conversations tab
  const [channelFilter, setChannelFilter] = useState<string>('ALL');
  const [decisionFilter, setDecisionFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  // Local state for forms
  const [zaloSettings, setZaloSettings] = useState(initialState.settings.ZALO);
  const [messengerSettings, setMessengerSettings] = useState(initialState.settings.MESSENGER);
  const [voiceSettings, setVoiceSettings] = useState(initialState.settings.VOICE);

  const handleRefreshMonitoring = () => {
    setIsRefreshingMonitoring(true);
    setActionError(null);
    startTransition(async () => {
      try {
        const fresh = await triggerAlertEvaluationAction();
        setMonitoring(fresh);
        setActionSuccess('Đã cập nhật trạng thái giám sát & cảnh báo mới nhất.');
      } catch (err: unknown) {
        const error = err as Error;
        setActionError(error.message || 'Lỗi khi cập nhật dữ liệu giám sát.');
      } finally {
        setIsRefreshingMonitoring(false);
      }
    });
  };

  const handleMetricsFilterChange = (channel: string, window: '1h' | '24h' | '7d' | '30d') => {
    setMetricsChannel(channel);
    setMetricsWindow(window);
    startTransition(async () => {
      try {
        const fresh = await getAiMonitoringDashboardData({ channel, timeWindow: window });
        setMonitoring(fresh);
      } catch (err: unknown) {
        const error = err as Error;
        setActionError(error.message || 'Lỗi khi lọc chỉ số.');
      }
    });
  };

  const handleAcknowledgeAlert = (alertId: string) => {
    setActionError(null);
    setActionSuccess(null);
    startTransition(async () => {
      try {
        await acknowledgeAlertAction(alertId);
        setMonitoring((prev) => ({
          ...prev,
          alerts: prev.alerts.map((a) => (a.id === alertId ? { ...a, status: 'ACKNOWLEDGED' as const } : a)),
        }));
        setActionSuccess('Đã xác nhận cảnh báo.');
      } catch (err: unknown) {
        const error = err as Error;
        setActionError(error.message || 'Lỗi khi xác nhận cảnh báo.');
      }
    });
  };

  const handleResolveAlert = (alertId: string) => {
    setActionError(null);
    setActionSuccess(null);
    startTransition(async () => {
      try {
        await resolveAlertAction(alertId);
        setMonitoring((prev) => ({
          ...prev,
          alerts: prev.alerts.filter((a) => a.id !== alertId),
        }));
        setActionSuccess('Đã đánh dấu hoàn tất cảnh báo.');
      } catch (err: unknown) {
        const error = err as Error;
        setActionError(error.message || 'Lỗi khi xử lý cảnh báo.');
      }
    });
  };

  const handleUpdateChannel = (channel: LiveChannel, formState: typeof zaloSettings) => {
    setActionError(null);
    setActionSuccess(null);
    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.append('channel', channel);
        formData.append('enabled', formState.enabled ? 'true' : 'false');
        formData.append('min_confidence', String(formState.min_confidence));
        formData.append('voice_mode', formState.voice_mode);
        formData.append('model_routing_profile', formState.model_routing_profile);

        await updateAiChannelSettingAction(formData);
        setActionSuccess(`Đã lưu cài đặt kênh ${channel} thành công.`);
      } catch (err: unknown) {
        const error = err as Error;
        setActionError(error.message || 'Lỗi khi cập nhật cài đặt.');
      }
    });
  };

  const handleKillSwitch = () => {
    setShowKillConfirm(false);
    setActionError(null);
    setActionSuccess(null);
    startTransition(async () => {
      try {
        const res = await emergencyKillSwitchAction();
        setZaloSettings((prev) => ({ ...prev, enabled: false }));
        setMessengerSettings((prev) => ({ ...prev, enabled: false }));
        setVoiceSettings((prev) => ({ ...prev, enabled: false, voice_mode: 'OFF' }));
        setActionSuccess(`Đã ngắt khẩn cấp AI thành công (${res.disabledCount} kênh đã tắt).`);
      } catch (err: unknown) {
        const error = err as Error;
        setActionError(error.message || 'Lỗi khi thực hiện ngắt khẩn cấp.');
      }
    });
  };

  const handleClaimCase = (caseId: string) => {
    setActionError(null);
    setActionSuccess(null);
    startTransition(async () => {
      try {
        await claimHandoverCaseAction(caseId);
        setActionSuccess('Đã tiếp nhận ca chuyển giao và tạm dừng AI hội thoại.');
      } catch (err: unknown) {
        const error = err as Error;
        setActionError(error.message || 'Lỗi khi tiếp nhận ca.');
      }
    });
  };

  const handleResolveCase = (caseId: string) => {
    setActionError(null);
    setActionSuccess(null);
    startTransition(async () => {
      try {
        await resolveHandoverCaseAction(caseId);
        setActionSuccess('Đã đánh dấu hoàn tất ca chuyển giao.');
      } catch (err: unknown) {
        const error = err as Error;
        setActionError(error.message || 'Lỗi khi hoàn tất ca.');
      }
    });
  };

  const handleResumeAi = (conversationId: string) => {
    setActionError(null);
    setActionSuccess(null);
    startTransition(async () => {
      try {
        await resumeAiConversationAction(conversationId);
        setActionSuccess('Đã kích hoạt lại AI tự động trả lời cho hội thoại.');
      } catch (err: unknown) {
        const error = err as Error;
        setActionError(error.message || 'Lỗi khi kích hoạt lại AI.');
      }
    });
  };

  // Filtered Handover Cases
  const filteredCases = initialState.handoverCases.filter((c) => {
    if (handoverFilter === 'ALL') return true;
    return c.status === handoverFilter;
  });

  // Filtered Deliveries
  const filteredDeliveries = initialState.deliveries.filter((d) => {
    if (channelFilter !== 'ALL' && d.channel !== channelFilter) return false;
    if (decisionFilter !== 'ALL' && d.decision !== decisionFilter) return false;
    if (statusFilter !== 'ALL' && d.send_status !== statusFilter) return false;
    return true;
  });

  const isAnyLive = zaloSettings.enabled || messengerSettings.enabled || voiceSettings.voice_mode === 'LIVE';

  return (
    <div className="space-y-6">
      {/* Top Header & Emergency Kill Switch */}
      <div className="flex flex-col gap-4 border-b border-slate-800 pb-5 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <Link href="/admin" className="text-xs text-blue-400 hover:text-blue-300">
              ← Quản trị
            </Link>
            <span className="text-slate-600">/</span>
            <span className="text-xs text-slate-400">AI Control Center</span>
          </div>
          <h1 className="mt-1 text-2xl font-bold text-white flex items-center gap-3">
            AI Control Center
            {isAnyLive ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                ACTIVE
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-800 px-2.5 py-0.5 text-xs font-semibold text-slate-400">
                OFFLINE
              </span>
            )}
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Quản trị tự động trả lời đa kênh, độ tin cậy, chuyển giao tư vấn viên và nhật ký hội thoại AI.
          </p>
        </div>

        {initialState.isBossAdmin && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setShowKillConfirm(true)}
              disabled={isPending}
              className="inline-flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-600/20 px-4 py-2 text-sm font-semibold text-red-300 hover:bg-red-600/30 transition disabled:opacity-50"
            >
              <svg className="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824-2.126a5 5 0 013.535 1.464M3 3l18 18" />
              </svg>
              Tắt khẩn cấp AI Auto Reply
            </button>
          </div>
        )}
      </div>

      {/* Confirmation Modal for Kill Switch */}
      {showKillConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl border border-red-500/40 bg-slate-900 p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-500/20 border border-red-500/40 flex items-center justify-center text-red-400 shrink-0">
                ⚠️
              </div>
              <div>
                <h3 className="text-lg font-bold text-white">Xác nhận tắt khẩn cấp AI?</h3>
                <p className="text-xs text-slate-400">Hành động này sẽ ngắt toàn bộ tự động trả lời cho tất cả các kênh ngay lập tức.</p>
              </div>
            </div>
            <p className="text-sm text-slate-300 bg-slate-950 p-3 rounded-lg border border-slate-800">
              Tất cả các tin nhắn inbound mới sẽ được giữ nguyên mà không gửi phản hồi AI tự động. Tư vấn viên con người có thể phản hồi thủ công.
            </p>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowKillConfirm(false)}
                className="px-4 py-2 rounded-lg border border-slate-700 bg-slate-800 text-sm font-medium text-slate-300 hover:bg-slate-700"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                onClick={handleKillSwitch}
                disabled={isPending}
                className="px-4 py-2 rounded-lg bg-red-600 text-sm font-semibold text-white hover:bg-red-500 transition disabled:opacity-50"
              >
                {isPending ? 'Đang tắt...' : 'Xác nhận tắt ngay'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Feedback Alerts */}
      {actionSuccess && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-300 flex items-center justify-between">
          <span>✓ {actionSuccess}</span>
          <button onClick={() => setActionSuccess(null)} className="text-emerald-400 hover:text-emerald-200">✕</button>
        </div>
      )}
      {actionError && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300 flex items-center justify-between">
          <span>⚠️ {actionError}</span>
          <button onClick={() => setActionError(null)} className="text-red-400 hover:text-red-200">✕</button>
        </div>
      )}

      {/* Stats Quick Overview */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">Zalo OA</div>
          <div className="mt-1 flex items-center gap-2">
            <span className={`text-xl font-bold ${zaloSettings.enabled ? 'text-emerald-400' : 'text-slate-500'}`}>
              {zaloSettings.enabled ? 'LIVE' : 'OFF'}
            </span>
          </div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">Messenger</div>
          <div className="mt-1 flex items-center gap-2">
            <span className={`text-xl font-bold ${messengerSettings.enabled ? 'text-emerald-400' : 'text-slate-500'}`}>
              {messengerSettings.enabled ? 'LIVE' : 'OFF'}
            </span>
          </div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">Voice AI</div>
          <div className="mt-1 flex items-center gap-2">
            <span className={`text-xl font-bold ${
              voiceSettings.voice_mode === 'LIVE'
                ? 'text-emerald-400'
                : voiceSettings.voice_mode === 'TEST'
                  ? 'text-amber-400'
                  : 'text-slate-500'
            }`}>
              {voiceSettings.voice_mode}
            </span>
          </div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">Chờ xử lý</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-xl font-bold text-amber-400">{initialState.handoverCounts.open}</span>
            <span className="text-xs text-slate-500">ca mở</span>
          </div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">Đã phản hồi AI</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-xl font-bold text-emerald-400">{initialState.deliveryCounts.sent}</span>
            <span className="text-xs text-slate-500">tin nhắn</span>
          </div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">Độ tin cậy TB</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-xl font-bold text-blue-400">
              {(initialState.deliveryCounts.avgConfidence * 100).toFixed(1)}%
            </span>
          </div>
        </div>
      </div>

      {/* Main Tabs Navigation */}
      <div className="flex border-b border-slate-800 gap-6">
        <button
          onClick={() => setActiveTab('settings')}
          className={`pb-3 text-sm font-semibold transition border-b-2 ${
            activeTab === 'settings'
              ? 'border-blue-500 text-white'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          Cấu hình Kênh & AI
        </button>
        <button
          onClick={() => setActiveTab('handover')}
          className={`pb-3 text-sm font-semibold transition border-b-2 flex items-center gap-2 ${
            activeTab === 'handover'
              ? 'border-blue-500 text-white'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          Hộp thư Chuyển giao
          {initialState.handoverCounts.open > 0 && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
              {initialState.handoverCounts.open}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('conversations')}
          className={`pb-3 text-sm font-semibold transition border-b-2 ${
            activeTab === 'conversations'
              ? 'border-blue-500 text-white'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          Nhật ký Hội thoại AI ({initialState.deliveryCounts.total})
        </button>
        <button
          onClick={() => setActiveTab('monitoring')}
          className={`pb-3 text-sm font-semibold transition border-b-2 flex items-center gap-2 ${
            activeTab === 'monitoring'
              ? 'border-blue-500 text-white'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          Giám sát & Cảnh báo
          {monitoring?.alerts?.filter((a) => a.status === 'ACTIVE').length > 0 && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-500/20 text-red-300 border border-red-500/30 animate-pulse">
              {monitoring.alerts.filter((a) => a.status === 'ACTIVE').length}
            </span>
          )}
        </button>
      </div>

      {/* TAB 1: SETTINGS */}
      {activeTab === 'settings' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Zalo OA Settings Card */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 space-y-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-center font-bold text-blue-400">
                    Z
                  </div>
                  <div>
                    <h3 className="font-bold text-white">Zalo OA & ZCAJS</h3>
                    <p className="text-xs text-slate-400">Tự động trả lời khách hàng Zalo</p>
                  </div>
                </div>
                <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                  zaloSettings.enabled
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-slate-700 bg-slate-800 text-slate-400'
                }`}>
                  {zaloSettings.enabled ? 'LIVE' : 'OFF'}
                </span>
              </div>

              <div className="space-y-4 pt-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-slate-300">Kích hoạt gửi thật</label>
                  <input
                    type="checkbox"
                    checked={zaloSettings.enabled}
                    disabled={!initialState.isBossAdmin || isPending}
                    onChange={(e) => setZaloSettings({ ...zaloSettings, enabled: e.target.checked })}
                    className="w-5 h-5 rounded border-slate-700 bg-slate-950 text-blue-600 focus:ring-0 focus:ring-offset-0 cursor-pointer"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium text-slate-400">Ngưỡng tin cậy tối thiểu (min confidence)</label>
                    <span className="text-xs font-mono text-emerald-400 font-bold">{zaloSettings.min_confidence.toFixed(3)}</span>
                  </div>
                  <input
                    type="range"
                    min="0.5"
                    max="1.0"
                    step="0.01"
                    value={zaloSettings.min_confidence}
                    disabled={!initialState.isBossAdmin || isPending}
                    onChange={(e) => setZaloSettings({ ...zaloSettings, min_confidence: parseFloat(e.target.value) })}
                    className="w-full accent-blue-500 bg-slate-800 cursor-pointer"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">Tin cậy &lt; {zaloSettings.min_confidence.toFixed(3)} sẽ chuyển giao hoặc không gửi.</p>
                </div>

                <div>
                  <label className="text-xs font-medium text-slate-400 block mb-1">Model Routing Profile</label>
                  <select
                    value={zaloSettings.model_routing_profile}
                    disabled={!initialState.isBossAdmin || isPending}
                    onChange={(e) => setZaloSettings({ ...zaloSettings, model_routing_profile: e.target.value as ModelRoutingProfile })}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
                  >
                    <option value="STANDARD">STANDARD (Javis Runtime / Balanced)</option>
                    <option value="FAST">FAST (Flash Ultra Low Latency)</option>
                    <option value="QUALITY">QUALITY (Gemini Pro / Deep Reasoning)</option>
                  </select>
                </div>

                {initialState.isBossAdmin && (
                  <button
                    type="button"
                    onClick={() => handleUpdateChannel('ZALO', zaloSettings)}
                    disabled={isPending}
                    className="w-full rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 transition disabled:opacity-50"
                  >
                    {isPending ? 'Đang lưu...' : 'Lưu cấu hình Zalo'}
                  </button>
                )}
              </div>
            </div>

            {/* Messenger Settings Card */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 space-y-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center font-bold text-indigo-400">
                    M
                  </div>
                  <div>
                    <h3 className="font-bold text-white">Facebook Messenger</h3>
                    <p className="text-xs text-slate-400">Tự động trả lời Fanpage Messenger</p>
                  </div>
                </div>
                <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                  messengerSettings.enabled
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-slate-700 bg-slate-800 text-slate-400'
                }`}>
                  {messengerSettings.enabled ? 'LIVE' : 'OFF'}
                </span>
              </div>

              <div className="space-y-4 pt-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-slate-300">Kích hoạt gửi thật</label>
                  <input
                    type="checkbox"
                    checked={messengerSettings.enabled}
                    disabled={!initialState.isBossAdmin || isPending}
                    onChange={(e) => setMessengerSettings({ ...messengerSettings, enabled: e.target.checked })}
                    className="w-5 h-5 rounded border-slate-700 bg-slate-950 text-blue-600 focus:ring-0 focus:ring-offset-0 cursor-pointer"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium text-slate-400">Ngưỡng tin cậy tối thiểu (min confidence)</label>
                    <span className="text-xs font-mono text-emerald-400 font-bold">{messengerSettings.min_confidence.toFixed(3)}</span>
                  </div>
                  <input
                    type="range"
                    min="0.5"
                    max="1.0"
                    step="0.01"
                    value={messengerSettings.min_confidence}
                    disabled={!initialState.isBossAdmin || isPending}
                    onChange={(e) => setMessengerSettings({ ...messengerSettings, min_confidence: parseFloat(e.target.value) })}
                    className="w-full accent-blue-500 bg-slate-800 cursor-pointer"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">Tin cậy &lt; {messengerSettings.min_confidence.toFixed(3)} sẽ chuyển giao hoặc không gửi.</p>
                </div>

                <div>
                  <label className="text-xs font-medium text-slate-400 block mb-1">Model Routing Profile</label>
                  <select
                    value={messengerSettings.model_routing_profile}
                    disabled={!initialState.isBossAdmin || isPending}
                    onChange={(e) => setMessengerSettings({ ...messengerSettings, model_routing_profile: e.target.value as ModelRoutingProfile })}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
                  >
                    <option value="STANDARD">STANDARD (Javis Runtime / Balanced)</option>
                    <option value="FAST">FAST (Flash Ultra Low Latency)</option>
                    <option value="QUALITY">QUALITY (Gemini Pro / Deep Reasoning)</option>
                  </select>
                </div>

                {initialState.isBossAdmin && (
                  <button
                    type="button"
                    onClick={() => handleUpdateChannel('MESSENGER', messengerSettings)}
                    disabled={isPending}
                    className="w-full rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 transition disabled:opacity-50"
                  >
                    {isPending ? 'Đang lưu...' : 'Lưu cấu hình Messenger'}
                  </button>
                )}
              </div>
            </div>

            {/* Voice Receptionist Settings Card */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 space-y-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-center font-bold text-purple-400">
                    V
                  </div>
                  <div>
                    <h3 className="font-bold text-white">Voice Receptionist</h3>
                    <p className="text-xs text-slate-400">AI Tiếp nhận cuộc gọi Stringee/Zalo</p>
                  </div>
                </div>
                <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                  voiceSettings.voice_mode === 'LIVE'
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : voiceSettings.voice_mode === 'TEST'
                      ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                      : 'border-slate-700 bg-slate-800 text-slate-400'
                }`}>
                  {voiceSettings.voice_mode}
                </span>
              </div>

              <div className="space-y-4 pt-2">
                <div>
                  <label className="text-xs font-medium text-slate-400 block mb-1">Chế độ hoạt động Voice</label>
                  <select
                    value={voiceSettings.voice_mode}
                    disabled={!initialState.isBossAdmin || isPending}
                    onChange={(e) => setVoiceSettings({ ...voiceSettings, voice_mode: e.target.value as VoiceMode })}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
                  >
                    <option value="OFF">OFF (Tắt tự động tiếp nhận)</option>
                    <option value="TEST">TEST (Chế độ thử nghiệm nội bộ)</option>
                    <option value="LIVE">LIVE (Tiếp nhận cuộc gọi thật)</option>
                  </select>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium text-slate-400">Ngưỡng tin cậy tối thiểu</label>
                    <span className="text-xs font-mono text-emerald-400 font-bold">{voiceSettings.min_confidence.toFixed(3)}</span>
                  </div>
                  <input
                    type="range"
                    min="0.5"
                    max="1.0"
                    step="0.01"
                    value={voiceSettings.min_confidence}
                    disabled={!initialState.isBossAdmin || isPending}
                    onChange={(e) => setVoiceSettings({ ...voiceSettings, min_confidence: parseFloat(e.target.value) })}
                    className="w-full accent-blue-500 bg-slate-800 cursor-pointer"
                  />
                </div>

                <div>
                  <label className="text-xs font-medium text-slate-400 block mb-1">Model Routing Profile</label>
                  <select
                    value={voiceSettings.model_routing_profile}
                    disabled={!initialState.isBossAdmin || isPending}
                    onChange={(e) => setVoiceSettings({ ...voiceSettings, model_routing_profile: e.target.value as ModelRoutingProfile })}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
                  >
                    <option value="STANDARD">STANDARD (Javis Runtime / Balanced)</option>
                    <option value="FAST">FAST (Flash Ultra Low Latency)</option>
                    <option value="QUALITY">QUALITY (Gemini Pro / Deep Reasoning)</option>
                  </select>
                </div>

                {initialState.isBossAdmin && (
                  <button
                    type="button"
                    onClick={() => handleUpdateChannel('VOICE', voiceSettings)}
                    disabled={isPending}
                    className="w-full rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 transition disabled:opacity-50"
                  >
                    {isPending ? 'Đang lưu...' : 'Lưu cấu hình Voice'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: HANDOVER INBOX */}
      {activeTab === 'handover' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900/60 p-4 rounded-xl border border-slate-800">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">Lọc theo trạng thái:</span>
              <div className="flex gap-1.5">
                {(['OPEN', 'CLAIMED', 'RESOLVED', 'ALL'] as const).map((status) => (
                  <button
                    key={status}
                    type="button"
                    onClick={() => setHandoverFilter(status)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                      handoverFilter === status
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    {status === 'OPEN' && `Đang mở (${initialState.handoverCounts.open})`}
                    {status === 'CLAIMED' && `Đã tiếp nhận (${initialState.handoverCounts.claimed})`}
                    {status === 'RESOLVED' && `Đã hoàn tất (${initialState.handoverCounts.resolved})`}
                    {status === 'ALL' && `Tất cả (${initialState.handoverCounts.total})`}
                  </button>
                ))}
              </div>
            </div>
            <div className="text-xs text-slate-500">
              Cập nhật thời gian thực · Hội thoại tạm dừng khi tư vấn viên tiếp nhận.
            </div>
          </div>

          {filteredCases.length === 0 ? (
            <div className="p-12 text-center rounded-2xl border border-slate-800 bg-slate-900/40">
              <p className="text-sm text-slate-400">Không có ca chuyển giao nào trong bộ lọc này.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {filteredCases.map((item) => {
                const reasonInfo = REASON_LABELS[item.reason] || { label: item.reason, color: 'bg-slate-800 text-slate-300 border-slate-700' };
                const priorityInfo = PRIORITY_BADGES[item.priority] || { label: item.priority, color: 'bg-slate-800 text-slate-300 border-slate-700' };

                return (
                  <div
                    key={item.id}
                    className="rounded-2xl border border-slate-800 bg-slate-900 p-5 hover:border-slate-700 transition space-y-4"
                  >
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center font-bold text-slate-200">
                          {item.customer?.name ? item.customer.name[0].toUpperCase() : 'K'}
                        </div>
                        <div>
                          <div className="font-semibold text-white flex items-center gap-2">
                            <span>{item.customer?.name || 'Khách hàng'}</span>
                            {item.customer?.customer_code && (
                              <span className="text-xs text-slate-400 font-mono">({item.customer.customer_code})</span>
                            )}
                          </div>
                          <div className="text-xs text-slate-500 flex items-center gap-2 mt-0.5">
                            <span>Tạo {formatTimeAgo(item.created_at)}</span>
                            {item.assigned_name && (
                              <span>· Đang tiếp nhận: <strong className="text-slate-300">{item.assigned_name}</strong></span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${priorityInfo.color}`}>
                          {priorityInfo.label}
                        </span>
                        <span className={`px-2.5 py-1 rounded-full text-xs font-medium border ${reasonInfo.color}`}>
                          {reasonInfo.label}
                        </span>
                        <span className={`px-2 py-0.5 rounded text-[11px] font-mono font-bold ${
                          item.status === 'OPEN'
                            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                            : item.status === 'CLAIMED'
                              ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                              : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                        }`}>
                          {item.status}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between border-t border-slate-800/80 pt-3 flex-wrap gap-3">
                      <Link
                        href={`/inbox?customer_id=${item.customer_id}`}
                        className="text-xs font-semibold text-blue-400 hover:text-blue-300 flex items-center gap-1"
                      >
                        Mở hội thoại trong Hộp thư →
                      </Link>

                      <div className="flex items-center gap-2">
                        {item.status === 'OPEN' && (
                          <button
                            type="button"
                            onClick={() => handleClaimCase(item.id)}
                            disabled={isPending}
                            className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white transition disabled:opacity-50"
                          >
                            Tiếp nhận ca (Claim)
                          </button>
                        )}
                        {item.status === 'CLAIMED' && (
                          <>
                            <button
                              type="button"
                              onClick={() => handleResolveCase(item.id)}
                              disabled={isPending}
                              className="px-3 py-1.5 rounded-lg border border-emerald-500/40 bg-emerald-600/20 hover:bg-emerald-600/30 text-xs font-semibold text-emerald-300 transition disabled:opacity-50"
                            >
                              Hoàn tất (Resolve)
                            </button>
                            <button
                              type="button"
                              onClick={() => handleResumeAi(item.conversation_id)}
                              disabled={isPending}
                              className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white transition disabled:opacity-50"
                            >
                              Khôi phục AI (Resume)
                            </button>
                          </>
                        )}
                        {item.status === 'RESOLVED' && (
                          <button
                            type="button"
                            onClick={() => handleResumeAi(item.conversation_id)}
                            disabled={isPending}
                            className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 transition disabled:opacity-50"
                          >
                            Bật lại AI cho hội thoại
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: CONVERSATIONS LOG */}
      {activeTab === 'conversations' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-4 bg-slate-900/60 p-4 rounded-xl border border-slate-800">
            <div>
              <label className="text-[11px] text-slate-400 block mb-1">Kênh:</label>
              <select
                value={channelFilter}
                onChange={(e) => setChannelFilter(e.target.value)}
                className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-white"
              >
                <option value="ALL">Tất cả kênh</option>
                <option value="ZALO">Zalo OA</option>
                <option value="MESSENGER">Facebook Messenger</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] text-slate-400 block mb-1">Quyết định AI:</label>
              <select
                value={decisionFilter}
                onChange={(e) => setDecisionFilter(e.target.value)}
                className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-white"
              >
                <option value="ALL">Tất cả quyết định</option>
                <option value="RESPOND">RESPOND (Đã trả lời)</option>
                <option value="HANDOVER">HANDOVER (Chuyển giao)</option>
                <option value="NO_REPLY">NO_REPLY (Bỏ qua)</option>
                <option value="ERROR">ERROR (Lỗi)</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] text-slate-400 block mb-1">Trạng thái gửi:</label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-white"
              >
                <option value="ALL">Tất cả trạng thái</option>
                <option value="SENT">SENT (Đã gửi khách)</option>
                <option value="SKIPPED">SKIPPED (Bỏ qua an toàn)</option>
                <option value="FAILED">FAILED (Gửi thất bại)</option>
                <option value="PROCESSING">PROCESSING (Đang xử lý)</option>
                <option value="PENDING">PENDING (Chờ)</option>
              </select>
            </div>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/60 text-slate-400 border-b border-slate-800 font-semibold">
                <tr>
                  <th className="px-4 py-3">Thời gian</th>
                  <th className="px-4 py-3">Khách hàng</th>
                  <th className="px-4 py-3">Kênh</th>
                  <th className="px-4 py-3">Quyết định AI</th>
                  <th className="px-4 py-3">Độ tin cậy</th>
                  <th className="px-4 py-3">Trạng thái</th>
                  <th className="px-4 py-3 text-right">Chi tiết</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 text-slate-300">
                {filteredDeliveries.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                      Chưa có nhật ký lượt gửi AI nào phù hợp bộ lọc.
                    </td>
                  </tr>
                ) : (
                  filteredDeliveries.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-800/40 transition">
                      <td className="px-4 py-3 text-slate-400 whitespace-nowrap">
                        {formatTimeAgo(item.created_at)}
                      </td>
                      <td className="px-4 py-3 font-medium text-white whitespace-nowrap">
                        {item.customer?.name || item.customer_id.slice(0, 8)}
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                          {item.channel}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {item.decision ? (
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            item.decision === 'RESPOND'
                              ? 'bg-emerald-500/20 text-emerald-300'
                              : item.decision === 'HANDOVER'
                                ? 'bg-amber-500/20 text-amber-300'
                                : item.decision === 'NO_REPLY'
                                  ? 'bg-slate-700 text-slate-300'
                                  : 'bg-red-500/20 text-red-300'
                          }`}>
                            {item.decision}
                          </span>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono">
                        {item.confidence !== null ? (
                          <span className={item.confidence >= 0.85 ? 'text-emerald-400 font-bold' : 'text-amber-400'}>
                            {item.confidence.toFixed(3)}
                          </span>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                          item.send_status === 'SENT'
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                            : item.send_status === 'FAILED'
                              ? 'border-red-500/30 bg-red-500/10 text-red-300'
                              : item.send_status === 'SKIPPED'
                                ? 'border-slate-700 bg-slate-800 text-slate-400'
                                : 'border-blue-500/30 bg-blue-500/10 text-blue-300'
                        }`}>
                          {item.send_status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/inbox?customer_id=${item.customer_id}`}
                          className="text-blue-400 hover:text-blue-300 underline"
                        >
                          Hộp thư
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: MONITORING & ALERTS */}
      {activeTab === 'monitoring' && (
        <div className="space-y-8">
          {/* 1. Health Status Section */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <span>Trạng thái Kết nối & Hạ tầng AI</span>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                    monitoring.health.overall === 'HEALTHY'
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                      : monitoring.health.overall === 'DEGRADED'
                        ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                        : 'border-red-500/30 bg-red-500/10 text-red-300'
                  }`}>
                    {monitoring.health.overall}
                  </span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Kiểm tra tính sẵn sàng của CRM, Javis Brain, ZCAJS Worker, Messenger Transport, Supabase Scheduler và Voice.
                </p>
              </div>

              <button
                type="button"
                onClick={handleRefreshMonitoring}
                disabled={isRefreshingMonitoring || isPending}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 text-xs font-semibold text-slate-200 hover:bg-slate-700 transition disabled:opacity-50"
              >
                <span className={isRefreshingMonitoring ? 'animate-spin' : ''}>🔄</span>
                {isRefreshingMonitoring ? 'Đang kiểm tra...' : 'Đánh giá lại ngay'}
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {monitoring.health.components.map((comp) => (
                <div
                  key={comp.name}
                  className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-2 flex flex-col justify-between"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-semibold text-white">{comp.name}</span>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                      comp.status === 'HEALTHY'
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                        : comp.status === 'DEGRADED'
                          ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                          : comp.status === 'UNHEALTHY'
                            ? 'border-red-500/30 bg-red-500/10 text-red-300'
                            : 'border-slate-700 bg-slate-800 text-slate-400'
                    }`}>
                      {comp.status}
                    </span>
                  </div>

                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    {comp.details || '—'}
                  </p>

                  <div className="pt-2 border-t border-slate-800/60 flex items-center justify-between text-[10px] text-slate-500 font-mono">
                    <span>{comp.latencyMs !== undefined ? `${comp.latencyMs}ms` : '—'}</span>
                    <span>{formatTimeAgo(comp.lastCheckedAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 2. Active Alerts Section */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <span>Cảnh báo Hệ thống</span>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-800 text-slate-300 border border-slate-700">
                    {monitoring.alerts.length}
                  </span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Tự động phát hiện bất thường: cron failure, Javis timeout, queue backlog, FAILED spike, handover backlog.
                </p>
              </div>
            </div>

            {monitoring.alerts.length === 0 ? (
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-6 text-center">
                <span className="text-2xl">✓</span>
                <p className="mt-2 text-sm font-semibold text-emerald-300">
                  Hệ thống AI đang vận hành ổn định
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  Không có cảnh báo bất thường nào đang kích hoạt trong pipeline.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {monitoring.alerts.map((alert) => (
                  <div
                    key={alert.id}
                    className={`rounded-xl border p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 ${
                      alert.severity === 'CRITICAL'
                        ? 'border-red-500/40 bg-red-500/10'
                        : alert.severity === 'HIGH'
                          ? 'border-orange-500/40 bg-orange-500/10'
                          : alert.severity === 'WARNING'
                            ? 'border-amber-500/40 bg-amber-500/10'
                            : 'border-blue-500/40 bg-blue-500/10'
                    }`}
                  >
                    <div className="space-y-1.5 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border uppercase ${
                          alert.severity === 'CRITICAL'
                            ? 'border-red-500 text-red-300 bg-red-500/20'
                            : alert.severity === 'HIGH'
                              ? 'border-orange-500 text-orange-300 bg-orange-500/20'
                              : alert.severity === 'WARNING'
                                ? 'border-amber-500 text-amber-300 bg-amber-500/20'
                                : 'border-blue-500 text-blue-300 bg-blue-500/20'
                        }`}>
                          {alert.severity}
                        </span>

                        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold border border-slate-700 bg-slate-800 text-slate-300">
                          {alert.channel}
                        </span>

                        <span className="text-xs font-bold text-white">
                          {alert.title}
                        </span>

                        {alert.triggerCount > 1 && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-900/80 text-slate-300 border border-slate-700">
                            ×{alert.triggerCount} lần
                          </span>
                        )}

                        {alert.status === 'ACKNOWLEDGED' && (
                          <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-500/20 text-blue-300 border border-blue-500/40">
                            Đã xác nhận
                          </span>
                        )}
                      </div>

                      <p className="text-xs text-slate-300 leading-relaxed">
                        {alert.description}
                      </p>

                      <div className="flex items-center gap-4 text-[10px] text-slate-400">
                        <span>Lần đầu: {formatTimeAgo(alert.firstTriggeredAt)}</span>
                        <span>Lần cuối: {formatTimeAgo(alert.lastTriggeredAt)}</span>
                      </div>
                    </div>

                    {initialState.isBossAdmin && (
                      <div className="flex items-center gap-2 shrink-0">
                        {alert.status === 'ACTIVE' && (
                          <button
                            type="button"
                            onClick={() => handleAcknowledgeAlert(alert.id)}
                            disabled={isPending}
                            className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 text-xs font-medium text-slate-200 hover:bg-slate-700 transition"
                          >
                            Xác nhận
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleResolveAlert(alert.id)}
                          disabled={isPending}
                          className="px-3 py-1.5 rounded-lg bg-emerald-600/30 border border-emerald-500/40 text-xs font-medium text-emerald-200 hover:bg-emerald-600/50 transition"
                        >
                          Đã xử lý
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 3. Pipeline Metrics Section */}
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-white">Chỉ số Hiệu năng Pipeline (Metrics)</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Thống kê thời gian thực về khối lượng inbound, tỷ lệ phản hồi, độ trễ p50/p95 và hàng đợi.
                </p>
              </div>

              <div className="flex items-center gap-3">
                {/* Channel filter */}
                <select
                  value={metricsChannel}
                  onChange={(e) => handleMetricsFilterChange(e.target.value, metricsWindow)}
                  className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1 text-xs text-white"
                >
                  <option value="ALL">Tất cả kênh</option>
                  <option value="ZALO">Zalo OA</option>
                  <option value="MESSENGER">Messenger</option>
                  <option value="VOICE">Voice AI</option>
                </select>

                {/* Time window pills */}
                <div className="inline-flex rounded-lg border border-slate-800 bg-slate-900 p-0.5 text-xs">
                  {(['1h', '24h', '7d', '30d'] as const).map((w) => (
                    <button
                      key={w}
                      type="button"
                      onClick={() => handleMetricsFilterChange(metricsChannel, w)}
                      className={`px-2.5 py-1 rounded-md font-medium transition ${
                        metricsWindow === w
                          ? 'bg-blue-600 text-white'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {w === '1h' ? '1 Giờ' : w === '24h' ? '24 Giờ' : w === '7d' ? '7 Ngày' : '30 Ngày'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Metrics Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <div className="text-[11px] uppercase tracking-wider text-slate-500">Tin nhắn Inbound</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-white">{monitoring.metrics.inboundCount}</span>
                  <span className="text-xs text-slate-400">tin đến</span>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <div className="text-[11px] uppercase tracking-wider text-slate-500">Lượt xử lý AI (Turns)</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-blue-400">{monitoring.metrics.brainTurns}</span>
                  <span className="text-xs text-slate-400">lượt inference</span>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <div className="text-[11px] uppercase tracking-wider text-slate-500">Tỷ lệ Tự động Trả lời</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-emerald-400">
                    {monitoring.metrics.brainTurns > 0
                      ? `${Math.round((monitoring.metrics.respondCount / monitoring.metrics.brainTurns) * 100)}%`
                      : '0%'}
                  </span>
                  <span className="text-xs text-slate-400">({monitoring.metrics.respondCount} tin)</span>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <div className="text-[11px] uppercase tracking-wider text-slate-500">Chuyển giao Nhân viên</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-amber-400">
                    {monitoring.metrics.handoverCount > 0 && monitoring.metrics.brainTurns > 0
                      ? `${Math.round((monitoring.metrics.handoverCount / monitoring.metrics.brainTurns) * 100)}%`
                      : '0%'}
                  </span>
                  <span className="text-xs text-slate-400">({monitoring.metrics.handoverCount} ca)</span>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <div className="text-[11px] uppercase tracking-wider text-slate-500">Bỏ qua / Từ chối gửi</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-slate-400">{monitoring.metrics.noReplyCount}</span>
                  <span className="text-xs text-slate-500">tin an toàn</span>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <div className="text-[11px] uppercase tracking-wider text-slate-500">Gửi thành công / Thất bại</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-emerald-400">{monitoring.metrics.sendSuccess}</span>
                  <span className="text-xs text-slate-500">/</span>
                  <span className={`text-xl font-bold ${monitoring.metrics.sendFailure > 0 ? 'text-red-400' : 'text-slate-500'}`}>
                    {monitoring.metrics.sendFailure}
                  </span>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <div className="text-[11px] uppercase tracking-wider text-slate-500">Độ tin cậy Trung bình</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-indigo-400">
                    {(monitoring.metrics.averageConfidence * 100).toFixed(1)}%
                  </span>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <div className="text-[11px] uppercase tracking-wider text-slate-500">Độ trễ P50 / P95</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-xl font-bold text-white font-mono">{monitoring.metrics.p50LatencyMs}ms</span>
                  <span className="text-xs text-slate-500">/</span>
                  <span className="text-sm font-semibold text-slate-400 font-mono">{monitoring.metrics.p95LatencyMs}ms</span>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <div className="text-[11px] uppercase tracking-wider text-slate-500">Hàng đợi Chờ gửi</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className={`text-2xl font-bold ${monitoring.metrics.queueDepth > 5 ? 'text-amber-400' : 'text-white'}`}>
                    {monitoring.metrics.queueDepth}
                  </span>
                  <span className="text-xs text-slate-400">tin đang pending</span>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <div className="text-[11px] uppercase tracking-wider text-slate-500">Tuổi tin cũ nhất trong queue</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className={`text-2xl font-bold font-mono ${monitoring.metrics.oldestPendingAgeSeconds > 60 ? 'text-amber-400' : 'text-white'}`}>
                    {monitoring.metrics.oldestPendingAgeSeconds}s
                  </span>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <div className="text-[11px] uppercase tracking-wider text-slate-500">Lỗi Provider / Timeout</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className={`text-2xl font-bold ${monitoring.metrics.providerFailures > 0 ? 'text-red-400' : 'text-slate-500'}`}>
                    {monitoring.metrics.providerFailures}
                  </span>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <div className="text-[11px] uppercase tracking-wider text-slate-500">Lỗi Cron Scheduler</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className={`text-2xl font-bold ${monitoring.metrics.schedulerFailures > 0 ? 'text-red-400' : 'text-slate-500'}`}>
                    {monitoring.metrics.schedulerFailures}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
