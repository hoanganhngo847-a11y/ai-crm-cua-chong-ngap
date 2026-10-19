'use client';

import React, { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { callCustomerViaVoiceAction } from '../../../actions/voice';
import type { ClickToCallParams } from '../../../../shared/contracts/sensitive';

interface Props {
  customerId: string;
  customerCode: string;
  customerName: string;
  provider?: string;
  disabled?: boolean;
}

type StringeeResult = { r?: number; message?: string; userId?: string };
type StringeeState = { reason?: string; code?: number };
type StringeeTrack = {
  attach?: (audioOnly?: boolean) => HTMLElement;
  detachAndRemove?: () => void;
};
type StringeeCallLike = {
  answer: (callback?: (result: StringeeResult) => void) => void;
  reject?: (callback?: (result: StringeeResult) => void) => void;
  hangup: (callback?: (result: StringeeResult) => void) => void;
  on: (event: string, callback: (...args: never[]) => void) => void;
};
type StringeeClientLike = {
  connect: (accessToken: string) => void;
  disconnect: () => void;
  on: (event: string, callback: (...args: never[]) => void) => void;
};
type StringeeClientConstructor = new () => StringeeClientLike;

declare global {
  interface Window {
    StringeeClient?: StringeeClientConstructor;
  }
}

const STRINGEE_SDK_URL = 'https://cdn.stringee.com/sdk/web/latest/stringee-web-sdk.min.js';

async function ensureStringeeSdk(): Promise<void> {
  if (window.StringeeClient) return;
  const existing = document.querySelector<HTMLScriptElement>('script[data-crm-stringee-sdk="true"]');
  if (existing) {
    await new Promise<void>((resolve, reject) => {
      if (window.StringeeClient) return resolve();
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('STRINGEE_SDK_LOAD_FAILED')), { once: true });
    });
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = STRINGEE_SDK_URL;
    script.async = true;
    script.dataset.crmStringeeSdk = 'true';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('STRINGEE_SDK_LOAD_FAILED'));
    document.head.appendChild(script);
  });
  if (!window.StringeeClient) throw new Error('STRINGEE_SDK_UNAVAILABLE');
}

/**
 * CRM browser softphone. The browser never receives the customer's phone number or provider secret.
 * A short-lived Stringee token is issued for the authenticated CRM actor; the server starts the
 * outbound call and bridges the answered customer back to this browser user. Recording is enforced
 * server-side by the signed SCCO before connect.
 */
export default function CallToCustomerButton({
  customerId,
  customerCode,
  customerName,
  provider,
  disabled = false,
}: Props) {
  const [isPending, startTransition] = useTransition();
  const [softphoneReady, setSoftphoneReady] = useState(false);
  const [softphoneError, setSoftphoneError] = useState<string | null>(null);
  const [callStatus, setCallStatus] = useState<'IDLE' | 'DIALING' | 'WAITING' | 'INCOMING' | 'ACTIVE' | 'ENDED' | 'ERROR'>('IDLE');
  const [callId, setCallId] = useState<string | null>(null);
  const [callMessage, setCallMessage] = useState<string | null>(null);
  const clientRef = useRef<StringeeClientLike | null>(null);
  const callRef = useRef<StringeeCallLike | null>(null);
  const pendingOutgoingRef = useRef(false);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const remoteTracksRef = useRef<StringeeTrack[]>([]);
  const remoteMediaContainerRef = useRef<HTMLDivElement | null>(null);

  const clearRemoteMedia = useCallback(() => {
    remoteTracksRef.current.forEach((track) => {
      try { track.detachAndRemove?.(); } catch { /* provider cleanup only */ }
    });
    remoteTracksRef.current = [];
    if (remoteMediaContainerRef.current) remoteMediaContainerRef.current.replaceChildren();
    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause();
      remoteAudioRef.current.srcObject = null;
    }
  }, []);

  const attachCallEvents = useCallback((call: StringeeCallLike) => {
    call.on('addremotestream', ((stream: MediaStream) => {
      const audio = remoteAudioRef.current;
      if (!audio) return;
      audio.srcObject = stream;
      void audio.play().catch(() => undefined);
    }) as never);

    call.on('addremotetrack', ((track: StringeeTrack) => {
      remoteTracksRef.current.push(track);
      const element = track.attach?.(true);
      if (element && remoteMediaContainerRef.current) {
        element.setAttribute('autoplay', 'true');
        remoteMediaContainerRef.current.appendChild(element);
        if (element instanceof HTMLMediaElement) void element.play().catch(() => undefined);
      }
    }) as never);

    call.on('signalingstate', ((state: StringeeState) => {
      const reason = String(state?.reason || '').toLowerCase();
      if (reason.includes('answer') || reason.includes('connected')) {
        setCallStatus('ACTIVE');
        setCallMessage('Đã kết nối — cuộc gọi đang được ghi âm.');
      }
      if (reason.includes('end') || reason.includes('hangup') || reason.includes('busy') || reason.includes('reject')) {
        pendingOutgoingRef.current = false;
        setCallStatus('ENDED');
        setCallMessage('Cuộc gọi đã kết thúc. Bản ghi sẽ được xử lý tự động.');
        clearRemoteMedia();
        callRef.current = null;
      }
    }) as never);
  }, [clearRemoteMedia]);

  const answerIncoming = useCallback((call: StringeeCallLike) => {
    callRef.current = call;
    attachCallEvents(call);
    call.answer((result) => {
      if (typeof result?.r === 'number' && result.r !== 0) {
        setCallStatus('ERROR');
        setCallMessage('Không thể nhận nhánh cuộc gọi từ tổng đài.');
        pendingOutgoingRef.current = false;
        return;
      }
      setCallStatus('ACTIVE');
      setCallMessage('Đã kết nối — cuộc gọi đang được ghi âm.');
    });
  }, [attachCallEvents]);

  const fetchClientToken = useCallback(async (): Promise<string> => {
    const response = await fetch('/api/voice/client-token', { cache: 'no-store' });
    const body = await response.json().catch(() => null) as { accessToken?: string; error?: string } | null;
    if (!response.ok || !body?.accessToken) {
      if (body?.error === 'CALL_PROVIDER_NOT_CONFIGURED') throw new Error('CALL_PROVIDER_NOT_CONFIGURED');
      throw new Error('VOICE_CLIENT_TOKEN_FAILED');
    }
    return body.accessToken;
  }, []);

  const connectSoftphone = useCallback(async () => {
    setSoftphoneError(null);
    setSoftphoneReady(false);
    try {
      await ensureStringeeSdk();
      if (!window.StringeeClient) throw new Error('STRINGEE_SDK_UNAVAILABLE');
      const accessToken = await fetchClientToken();
      const client = new window.StringeeClient();
      clientRef.current = client;

      client.on('authen', ((result: StringeeResult) => {
        if (result?.r === 0) {
          setSoftphoneReady(true);
          setSoftphoneError(null);
        } else {
          setSoftphoneReady(false);
          setSoftphoneError('Không thể xác thực tổng đài trên trình duyệt.');
        }
      }) as never);

      client.on('disconnect', (() => {
        setSoftphoneReady(false);
      }) as never);

      client.on('requestnewtoken', (() => {
        void fetchClientToken()
          .then((token) => client.connect(token))
          .catch(() => setSoftphoneError('Phiên tổng đài đã hết hạn. Hãy tải lại trang.'));
      }) as never);

      const onIncoming = ((incoming: StringeeCallLike) => {
        callRef.current = incoming;
        setCallStatus('INCOMING');
        setCallMessage('Khách đã bắt máy. Đang nối cuộc gọi tới trình duyệt…');
        if (pendingOutgoingRef.current) answerIncoming(incoming);
        else attachCallEvents(incoming);
      }) as never;
      client.on('incomingcall', onIncoming);
      client.on('incomingcall2', onIncoming);
      client.connect(accessToken);
    } catch (error) {
      setSoftphoneReady(false);
      setSoftphoneError(
        error instanceof Error && error.message === 'CALL_PROVIDER_NOT_CONFIGURED'
          ? 'Tổng đài chưa được cấu hình cho doanh nghiệp.'
          : 'Không thể kết nối tổng đài trên trình duyệt.'
      );
    }
  }, [answerIncoming, attachCallEvents, fetchClientToken]);

  useEffect(() => {
    void connectSoftphone();
    return () => {
      pendingOutgoingRef.current = false;
      try { callRef.current?.hangup(); } catch { /* best-effort cleanup */ }
      try { clientRef.current?.disconnect(); } catch { /* best-effort cleanup */ }
      clearRemoteMedia();
    };
  }, [clearRemoteMedia, connectSoftphone]);

  const requestMicrophone = async (): Promise<boolean> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach((track) => track.stop());
      return true;
    } catch {
      setCallStatus('ERROR');
      setCallMessage('Trình duyệt chưa được cấp quyền micro. Hãy cho phép micro rồi thử lại.');
      return false;
    }
  };

  const handleCall = async () => {
    if (disabled || isPending) return;
    if (!softphoneReady) {
      setCallStatus('ERROR');
      setCallMessage(softphoneError || 'Tổng đài đang kết nối. Hãy thử lại sau vài giây.');
      if (!clientRef.current) void connectSoftphone();
      return;
    }
    if (!(await requestMicrophone())) return;

    pendingOutgoingRef.current = true;
    setCallStatus('DIALING');
    setCallMessage('Đang yêu cầu tổng đài gọi khách…');
    setCallId(null);

    startTransition(async () => {
      const params: ClickToCallParams = { customerId };
      const result = await callCustomerViaVoiceAction(params);
      if (result.success && result.data) {
        setCallId(result.data.callId);
        setCallStatus('WAITING');
        setCallMessage('Đang đổ chuông tới khách. Khi khách bắt máy, CRM sẽ tự nối sale vào cuộc gọi.');
      } else {
        pendingOutgoingRef.current = false;
        setCallStatus('ERROR');
        setCallMessage(result.error || 'Không thể thực hiện cuộc gọi.');
      }
    });
  };

  const handleAnswer = () => {
    if (callRef.current) answerIncoming(callRef.current);
  };

  const handleHangup = () => {
    const call = callRef.current;
    pendingOutgoingRef.current = false;
    if (!call) {
      setCallStatus('ENDED');
      setCallMessage('Đã hủy chờ kết nối.');
      return;
    }
    call.hangup(() => {
      clearRemoteMedia();
      callRef.current = null;
      setCallStatus('ENDED');
      setCallMessage('Cuộc gọi đã kết thúc. Bản ghi sẽ được xử lý tự động.');
    });
  };

  const active = ['DIALING', 'WAITING', 'INCOMING', 'ACTIVE'].includes(callStatus);
  const providerConfigured = provider === 'STRINGEE' || !softphoneError?.includes('chưa được cấu hình');

  return (
    <div className="space-y-3">
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
      <div ref={remoteMediaContainerRef} className="hidden" aria-hidden="true" />

      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => void handleCall()}
          disabled={disabled || isPending || active || !providerConfigured}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition ${
            disabled || !providerConfigured
              ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
              : active
                ? 'bg-emerald-800 text-emerald-100 cursor-default'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer'
          }`}
          title="Gọi qua tổng đài CRM; cuộc gọi được ghi âm và chép lời theo chính sách doanh nghiệp"
        >
          <span>{active ? '●' : '📞'}</span>
          <span>{active ? 'ĐANG GỌI…' : 'GỌI & GHI ÂM'}</span>
        </button>

        {callStatus === 'INCOMING' && !pendingOutgoingRef.current && (
          <button
            type="button"
            onClick={handleAnswer}
            className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium"
          >
            Nhận cuộc gọi
          </button>
        )}

        {active && (
          <button
            type="button"
            onClick={handleHangup}
            className="px-3 py-2 rounded-lg bg-rose-700 hover:bg-rose-600 text-white text-sm font-medium"
          >
            Kết thúc
          </button>
        )}

        <div className="text-sm text-slate-400">
          <span className="text-slate-500">Khách:</span>{' '}
          <span className="font-medium text-slate-200">{customerName}</span>{' '}
          <span className="text-slate-500 font-mono text-xs">[{customerCode}]</span>
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className={`w-2 h-2 rounded-full ${softphoneReady ? 'bg-emerald-400' : 'bg-amber-400'}`} />
        <span className={softphoneReady ? 'text-emerald-300' : 'text-slate-400'}>
          {softphoneReady ? 'Softphone CRM sẵn sàng' : (softphoneError || 'Đang kết nối tổng đài…')}
        </span>
      </div>

      {callMessage && (
        <div className={`text-sm flex items-start gap-2 ${callStatus === 'ERROR' ? 'text-rose-400' : callStatus === 'ACTIVE' ? 'text-emerald-300' : 'text-slate-300'}`}>
          <span>{callStatus === 'ERROR' ? '✗' : callStatus === 'ACTIVE' ? '●' : '•'}</span>
          <span>
            {callMessage}
            {callId && <span className="ml-2 text-slate-500 text-xs font-mono">ID: {callId}</span>}
          </span>
        </div>
      )}

      <p className="text-[11px] text-slate-500 leading-relaxed max-w-2xl">
        Cuộc gọi qua tổng đài CRM có thể được ghi âm, chép lời và phân tích để phục vụ tư vấn/chăm sóc khách hàng. Hãy bảo đảm khách hàng được thông báo phù hợp theo chính sách và quy định áp dụng.
      </p>
    </div>
  );
}
