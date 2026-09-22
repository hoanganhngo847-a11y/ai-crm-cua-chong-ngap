'use client';

import React, { useState, useTransition } from 'react';
import { callCustomerViaVoiceAction } from '../../../actions/voice';
import type { ClickToCallParams } from '../../../../shared/contracts/sensitive';

interface Props {
  customerId: string;
  customerCode: string;
  customerName: string;
  /** Provider từ lần gọi gần nhất hoặc cấu hình hiện tại */
  provider?: string;
  /** Disabled khi TECHNICIAN */
  disabled?: boolean;
}

/**
 * Nút GỌI KHÁCH — Click-to-Call an toàn.
 *
 * SECURITY:
 * - Browser chỉ gửi customerId — KHÔNG gửi phone.
 * - clickToCallAction (Foundation) xử lý toàn bộ server-side.
 * - Response chỉ chứa { callId, status } — không có phone.
 *
 * DISCLAIMER khi provider = 'MANUAL' (SIM/điện thoại vật lý):
 * Hiển thị cảnh báo rõ ràng rằng không thể đảm bảo che số hoàn toàn.
 */
export default function CallToCustomerButton({
  customerId,
  customerCode,
  customerName,
  provider,
  disabled = false,
}: Props) {
  const [isPending, startTransition] = useTransition();
  const [callState, setCallState] = useState<
    | { type: 'idle' }
    | { type: 'calling'; callId: string }
    | { type: 'error'; message: string }
  >({ type: 'idle' });

  const isManualProvider = !provider || provider === 'MANUAL';

  const handleCall = () => {
    startTransition(async () => {
      setCallState({ type: 'idle' });

      const params: ClickToCallParams = { customerId };
      const result = await callCustomerViaVoiceAction(params);

      if (result.success && result.data) {
        setCallState({ type: 'calling', callId: result.data.callId });
      } else {
        setCallState({
          type: 'error',
          message: result.error || 'Không thể thực hiện cuộc gọi.',
        });
      }
    });
  };

  return (
    <div className="space-y-3">
      {/* Disclaimer SIM/điện thoại vật lý */}
      {isManualProvider && (
        <div className="p-3 bg-amber-950/40 border border-amber-700/50 rounded-lg text-xs text-amber-300">
          <div className="flex items-start gap-2">
            <span className="text-amber-400 mt-0.5 flex-shrink-0">⚠️</span>
            <div>
              <span className="font-semibold">Lưu ý về bảo mật số điện thoại:</span>{' '}
              Hệ thống đang dùng chế độ thủ công (MANUAL). Nếu cuộc gọi thực hiện qua SIM/điện
              thoại vật lý, số khách hàng{' '}
              <span className="font-semibold text-amber-200">
                có thể hiển thị trên màn hình điện thoại và nhật ký cuộc gọi thiết bị
              </span>
              . Hệ thống CRM không thể đảm bảo che số hoàn toàn trong trường hợp này.
              <br />
              Để che số tuyệt đối, hãy sử dụng tổng đài SIP/VoIP (Stringee, Viettel VoIP...).
            </div>
          </div>
        </div>
      )}

      {/* Nút gọi */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleCall}
          disabled={disabled || isPending || callState.type === 'calling'}
          className={`
            flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition
            ${disabled
              ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
              : callState.type === 'calling'
              ? 'bg-emerald-800 text-emerald-200 cursor-default'
              : isPending
              ? 'bg-blue-800 text-blue-200 cursor-wait'
              : 'bg-blue-600 hover:bg-blue-500 text-white cursor-pointer'
            }
          `}
        >
          <span>{isPending ? '⏳' : callState.type === 'calling' ? '📞' : '📞'}</span>
          <span>
            {isPending
              ? 'Đang kết nối...'
              : callState.type === 'calling'
              ? 'Đang gọi...'
              : 'GỌI KHÁCH'}
          </span>
        </button>

        <div className="text-sm text-slate-400">
          <span className="text-slate-500">Khách:</span>{' '}
          <span className="font-medium text-slate-200">{customerName}</span>{' '}
          <span className="text-slate-500 font-mono text-xs">[{customerCode}]</span>
        </div>
      </div>

      {/* Kết quả gọi */}
      {callState.type === 'calling' && (
        <div className="flex items-center gap-2 text-sm text-emerald-400">
          <span className="animate-pulse">●</span>
          <span>
            Cuộc gọi đã được khởi tạo.{' '}
            <span className="text-slate-400 text-xs font-mono">ID: {callState.callId}</span>
          </span>
        </div>
      )}

      {callState.type === 'error' && (
        <div className="text-sm text-red-400 flex items-start gap-2">
          <span>✗</span>
          <span>{callState.message}</span>
        </div>
      )}
    </div>
  );
}
