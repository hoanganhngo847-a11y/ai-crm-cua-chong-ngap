'use client';

import React, { useState, useEffect, useRef } from 'react';
import { createZaloOutboundCall, getZaloDeviceReadiness } from '../../../actions/zalo-recordings';

interface Props {
  customerId: string;
  customerName: string;
  disabled?: boolean;
}

type CallStatus =
  | 'IDLE'
  | 'CREATING'
  | 'AGENT_DISPATCHING'
  | 'OPENING_ZALO'
  | 'CONTACT_VERIFIED'
  | 'CALL_TRIGGERED'
  | 'COMPLETED'
  | 'FAILED';

interface DeviceItem {
  id: string;
  device_name: string;
  staff_user_id: string | null;
  is_current_staff: boolean;
  computed_status: 'ONLINE' | 'DEGRADED' | 'OFFLINE';
  zalo_running: boolean;
  permissions_ok: boolean;
}

interface ReadinessState {
  isReady: boolean;
  status: 'ONLINE' | 'DEGRADED' | 'OFFLINE' | 'NO_DEVICE';
  reason: string;
  devices: DeviceItem[];
  readyDevice: DeviceItem | null;
  zaloRunning: boolean;
}

export default function ZaloCallButton({ customerId, customerName, disabled = false }: Props) {
  const [status, setStatus] = useState<CallStatus>('IDLE');
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [readiness, setReadiness] = useState<ReadinessState | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);

  const cleanupTimer = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  // Poll device readiness from CRM
  useEffect(() => {
    let active = true;
    const checkReadiness = async () => {
      try {
        const res = await getZaloDeviceReadiness();
        if (active) {
          setReadiness(res);
          if (res.readyDevice && !selectedDeviceId) {
            setSelectedDeviceId(res.readyDevice.id);
          }
        }
      } catch {
        if (active) {
          setReadiness({
            isReady: false,
            status: 'OFFLINE',
            reason: 'Không thể kết nối máy chủ để kiểm tra thiết bị.',
            devices: [],
            readyDevice: null,
            zaloRunning: false,
          });
        }
      }
    };

    checkReadiness();
    const interval = setInterval(checkReadiness, 15000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [selectedDeviceId]);

  useEffect(() => {
    return () => cleanupTimer();
  }, []);

  const handleStartCall = async () => {
    try {
      setStatus('CREATING');
      setStatusMessage('Đang khởi tạo yêu cầu gọi Zalo...');
      setShowModal(true);

      const targetDeviceId = selectedDeviceId || readiness?.readyDevice?.id || undefined;
      const res = await createZaloOutboundCall(customerId, targetDeviceId);
      const reqId = res.request_id;
      setRequestId(reqId);
      setStatus('AGENT_DISPATCHING');
      setStatusMessage('Đang kết nối Mac Agent qua loopback...');

      // 1. Try local loopback HTTP server first
      let loopbackSuccess = false;
      try {
        const loopbackRes = await fetch('http://127.0.0.1:48123/call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ request_id: reqId }),
          signal: AbortSignal.timeout(2000),
        });
        if (loopbackRes.ok) {
          loopbackSuccess = true;
        }
      } catch {
        loopbackSuccess = false;
      }

      // 2. If loopback failed or unavailable, fallback to custom URL scheme
      if (!loopbackSuccess) {
        setStatusMessage('Đang mở qua ứng dụng crm-zalo://...');
        window.location.href = `crm-zalo://call?request_id=${encodeURIComponent(reqId)}`;
      }

      // 3. Start polling server status
      let attempts = 0;
      cleanupTimer();
      pollTimerRef.current = setInterval(async () => {
        attempts += 1;
        if (attempts > 60) {
          cleanupTimer();
          setStatus('FAILED');
          setStatusMessage('Hết thời gian chờ phản hồi từ Mac Agent.');
          return;
        }

        try {
          const statusRes = await fetch(`/api/voice/zalo-personal/outbound/status?request_id=${encodeURIComponent(reqId)}`);
          if (!statusRes.ok) return;
          const json = await statusRes.json();
          if (!json.ok || !json.request) return;

          const req = json.request;
          const serverStatus = req.status;

          if (serverStatus === 'OPENING_ZALO') {
            setStatus('OPENING_ZALO');
            setStatusMessage('Đang mở Zalo Desktop và tìm kiếm liên hệ...');
          } else if (serverStatus === 'CONTACT_VERIFIED') {
            setStatus('CONTACT_VERIFIED');
            setStatusMessage(`Đã xác minh liên hệ: "${req.expected_display_name || customerName}". Đang kích hoạt cuộc gọi...`);
          } else if (serverStatus === 'CALL_TRIGGERED') {
            setStatus('CALL_TRIGGERED');
            setStatusMessage('Đã kết nối cuộc gọi thoại trên Zalo Desktop!');
          } else if (serverStatus === 'COMPLETED') {
            setStatus('COMPLETED');
            setStatusMessage('Cuộc gọi Zalo hoàn tất và bản ghi âm đã được gắn vào hồ sơ khách hàng.');
            cleanupTimer();
          } else if (serverStatus === 'FAILED' || serverStatus === 'EXPIRED') {
            setStatus('FAILED');
            setStatusMessage(req.failure_reason || 'Không thể thực hiện cuộc gọi Zalo tự động.');
            cleanupTimer();
          }
        } catch {
          // Retry next tick
        }
      }, 1500);
    } catch (err: unknown) {
      setStatus('FAILED');
      const msg = err instanceof Error ? err.message : 'Không thể khởi tạo cuộc gọi.';
      setStatusMessage(msg);
    }
  };

  const isEligible = readiness?.isReady === true;
  const isBusy = status === 'CREATING' || status === 'AGENT_DISPATCHING';
  const buttonDisabled = disabled || !isEligible || isBusy;

  const tooltipText = !readiness
    ? 'Đang kiểm tra trạng thái Agent...'
    : !isEligible
    ? readiness.reason || 'Agent Zalo chưa sẵn sàng'
    : `Gọi Zalo tới ${customerName}${readiness.readyDevice ? ` qua ${readiness.readyDevice.device_name}` : ''}${!readiness.zaloRunning ? ' (Agent sẽ tự mở Zalo)' : ''}`;

  const onlineDevices = (readiness?.devices || []).filter((d) => d.computed_status === 'ONLINE');

  return (
    <div className="inline-flex items-center gap-1.5">
      <button
        type="button"
        disabled={buttonDisabled}
        onClick={handleStartCall}
        className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold shadow-lg transition active:scale-95 ${
          buttonDisabled
            ? 'bg-slate-700/60 text-slate-400 cursor-not-allowed opacity-60 shadow-none'
            : 'bg-blue-600 hover:bg-blue-500 text-white shadow-blue-600/20'
        }`}
        title={tooltipText}
      >
        <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
          <path d="M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2.05 21.45a.75.75 0 00.9.9l4.282-1.388A9.957 9.957 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2zm0 18a7.96 7.96 0 01-4.24-1.21.75.75 0 00-.518-.088l-2.955.958.958-2.955a.75.75 0 00-.088-.518A7.96 7.96 0 014 12c0-4.411 3.589-8 8-8s8 3.589 8 8-3.589 8-8 8zm-2.5-11a.75.75 0 00-.75.75v3.5a.75.75 0 001.5 0v-2.75h1.75a.75.75 0 000-1.5h-2.5zm6 0a.75.75 0 00-.75.75v3.5a.75.75 0 001.5 0v-2.75h1.75a.75.75 0 000-1.5h-2.5z" />
        </svg>
        <span>Gọi Zalo</span>
        {readiness && !isEligible && (
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 ml-0.5" title={readiness.reason} />
        )}
      </button>

      {/* Multi-Device Selector (if multiple online devices available) */}
      {onlineDevices.length > 1 && (
        <select
          value={selectedDeviceId}
          onChange={(e) => setSelectedDeviceId(e.target.value)}
          aria-label="Chọn thiết bị Mac gọi Zalo"
          className="text-[11px] rounded-lg bg-slate-800 border border-slate-700 text-slate-300 py-1.5 px-2 focus:ring-1 focus:ring-blue-500"
          title="Chọn thiết bị Mac thực hiện cuộc gọi"
        >
          {onlineDevices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.device_name} {d.is_current_staff ? '(Máy của bạn)' : ''}
            </option>
          ))}
        </select>
      )}

      {/* Status Modal / Notification */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-800 p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-blue-600/20 text-blue-400 flex items-center justify-center font-bold">
                  Z
                </div>
                <div>
                  <h3 className="font-bold text-white text-sm">Cuộc gọi Zalo Personal</h3>
                  <p className="text-xs text-slate-400">{customerName}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowModal(false);
                  if (status === 'COMPLETED' || status === 'FAILED') {
                    setStatus('IDLE');
                  }
                }}
                className="text-slate-400 hover:text-white text-xs px-2 py-1 rounded-lg hover:bg-slate-800 transition"
              >
                Đóng
              </button>
            </div>

            <div className="py-2 space-y-3">
              <div className="flex items-center gap-3">
                {status === 'CALL_TRIGGERED' || status === 'COMPLETED' ? (
                  <span className="w-3 h-3 rounded-full bg-emerald-500 animate-ping" />
                ) : status === 'FAILED' ? (
                  <span className="w-3 h-3 rounded-full bg-red-500" />
                ) : (
                  <span className="w-3 h-3 rounded-full bg-blue-500 animate-pulse" />
                )}
                <span className="text-xs font-medium text-slate-200">
                  {status === 'IDLE' && 'Sẵn sàng'}
                  {status === 'CREATING' && 'Đang tạo phiên gọi...'}
                  {status === 'AGENT_DISPATCHING' && 'Đang kết nối Mac Agent...'}
                  {status === 'OPENING_ZALO' && 'Đang mở Zalo Desktop...'}
                  {status === 'CONTACT_VERIFIED' && 'Đã xác minh liên hệ!'}
                  {status === 'CALL_TRIGGERED' && 'Đang gọi thoại Zalo...'}
                  {status === 'COMPLETED' && 'Cuộc gọi hoàn tất'}
                  {status === 'FAILED' && 'Chưa thực hiện được cuộc gọi'}
                </span>
              </div>

              <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800/80 text-xs text-slate-300">
                {statusMessage}
              </div>

              {requestId && (
                <div className="text-[10px] font-mono text-slate-500 truncate">
                  Request ID: {requestId}
                </div>
              )}
            </div>

            <div className="flex justify-end pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => {
                  setShowModal(false);
                  if (status === 'COMPLETED' || status === 'FAILED') {
                    setStatus('IDLE');
                  }
                }}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white transition"
              >
                Đóng cửa sổ
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
