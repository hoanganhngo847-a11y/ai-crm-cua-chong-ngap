'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ensureStringeeSdk, STRINGEE_SERVER_ADDRS,
  type StringeeCallLike, type StringeeClientLike, type StringeeResult, type StringeeState,
} from '../../../../features/voice/client/stringee-sdk';

type TokenData = { accessToken: string; userId: string; peerUserId?: string; expiresIn: number };

async function getToken(side?: 'A' | 'B'): Promise<{ data: TokenData; summary: string }> {
  const response = await fetch(`/api/voice/client-token${side ? `?testClient=${side}` : ''}`, { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || typeof data.accessToken !== 'string') throw new Error(`HTTP ${response.status}: ${data.error || 'TOKEN_FAILED'}`);
  const allowed = ['ok', 'accessToken', 'userId', 'peerUserId', 'expiresIn', 'serverAddresses', 'pstnAvailable', 'recordingEnabled'];
  if (Object.keys(data).some(key => !allowed.includes(key))) throw new Error('UNEXPECTED_TOKEN_RESPONSE_FIELDS');
  const payload = data.accessToken.split('.')[1].replaceAll('-', '+').replaceAll('_', '/');
  const claims = JSON.parse(atob(payload));
  if (claims.userId !== data.userId || claims.exp * 1000 <= Date.now() || claims.rest_api) throw new Error('INVALID_CLIENT_TOKEN');
  return { data, summary: `HTTP ${response.status} · token generated: yes · expires: ${new Date(claims.exp * 1000).toISOString()} · server secret fields: none` };
}

function TestClient({ side }: { side: 'A' | 'B' }) {
  const [status, setStatus] = useState('Disconnected');
  const [sdkLoaded, setSdkLoaded] = useState(false);
  const [identity, setIdentity] = useState('');
  const [tokenSummary, setTokenSummary] = useState('');
  const [phase, setPhase] = useState('Idle');
  const [error, setError] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [incoming, setIncoming] = useState(false);
  const [busy, setBusy] = useState(false);
  const client = useRef<StringeeClientLike | null>(null);
  const call = useRef<StringeeCallLike | null>(null);
  const users = useRef({ own: '', peer: '' });
  const audio = useRef<HTMLAudioElement | null>(null);
  const generation = useRef(0);

  const log = (message: string) => setEvents(old => [...old.slice(-19), message]);
  const attachCall = (value: StringeeCallLike) => {
    call.current = value;
    value.on('addremotestream', ((stream: MediaStream) => {
      if (audio.current) { audio.current.srcObject = stream; void audio.current.play().catch(() => undefined); }
    }) as never);
    value.on('signalingstate', ((state: StringeeState) => {
      const reason = String(state?.reason || '');
      log(`signalingstate: ${state.code ?? ''} ${reason}`);
      if (state.code === 2 || /ring/i.test(reason)) setPhase('Ringing');
      if (state.code === 3 || /answer|connected/i.test(reason)) setPhase('Answered');
      if (state.code === 5 || state.code === 6 || /ended|hangup|busy|reject/i.test(reason)) {
        setPhase('Ended'); setIncoming(false); setBusy(false); call.current = null;
      }
    }) as never);
    value.on('mediastate', ((state: StringeeState) => log(`mediastate: ${state.code ?? ''} ${state.reason || ''}`)) as never);
  };

  const connect = async () => {
    const current = ++generation.current;
    setStatus('Connecting'); setError('');
    try {
      client.current?.disconnect();
      await ensureStringeeSdk();
      setSdkLoaded(true);
      const result = await getToken(side);
      if (current !== generation.current) return;
      setTokenSummary(result.summary); setIdentity(result.data.userId);
      users.current = { own: result.data.userId, peer: result.data.peerUserId || '' };
      const sdkClient = new window.StringeeClient!(STRINGEE_SERVER_ADDRS);
      client.current = sdkClient;
      sdkClient.on('connect', (() => { if (current === generation.current) log('connect'); }) as never);
      sdkClient.on('authen', ((result: StringeeResult) => {
        if (current !== generation.current) return;
        log(`authen: r=${result.r}`);
        setStatus(result.r === 0 ? 'Connected' : 'Error');
        if (result.r !== 0) setError('Stringee authentication failed');
      }) as never);
      sdkClient.on('disconnect', (() => {
        if (current !== generation.current) return;
        setStatus('Disconnected'); log('disconnect');
      }) as never);
      sdkClient.on('requestnewtoken', (() => {
        if (current !== generation.current) return;
        log('requestnewtoken');
        void getToken(side).then(result => {
          if (current === generation.current) { setTokenSummary(result.summary); sdkClient.connect(result.data.accessToken); }
        }).catch(() => { setStatus('Error'); setError('Token renewal failed'); });
      }) as never);
      const onIncoming = ((value: StringeeCallLike) => {
        if (current !== generation.current) return;
        if (call.current) { value.reject?.(); return; }
        attachCall(value); setIncoming(true); setBusy(true); setPhase('Ringing'); log('incomingcall');
      }) as never;
      sdkClient.on('incomingcall', onIncoming);
      sdkClient.on('incomingcall2', onIncoming);
      sdkClient.connect(result.data.accessToken);
    } catch (caught) {
      setStatus('Error'); setError(caught instanceof Error ? caught.message : 'CONNECTION_FAILED');
    }
  };

  const startCall = () => {
    const Constructor = window.StringeeCall2 || window.StringeeCall;
    if (!Constructor || !client.current || !users.current.peer || busy) return;
    const value = new Constructor(client.current, users.current.own, users.current.peer, false);
    attachCall(value); setBusy(true); setPhase('Calling'); setError('');
    value.makeCall(result => {
      log(`makeCall: r=${result.r}`);
      if (result.r !== 0) { setPhase('Error'); setError(`Call rejected: ${result.r}`); setBusy(false); call.current = null; }
    });
  };

  const answer = () => call.current?.answer(result => {
    log(`answer: r=${result.r}`);
    if (result.r === 0) { setPhase('Answered'); setIncoming(false); }
    else { setError(`Answer rejected: ${result.r}`); setPhase('Error'); }
  });

  const hangup = () => call.current?.hangup(result => {
    log(`hangup: r=${result.r}`); setPhase('Ended'); setBusy(false); setIncoming(false); call.current = null;
  });

  useEffect(() => () => {
    generation.current++;
    try { call.current?.hangup(); } catch { /* cleanup */ }
    try { client.current?.disconnect(); } catch { /* cleanup */ }
  }, []);

  return <section className="rounded-xl border border-slate-700 bg-slate-900 p-5 space-y-3" aria-label={`Client ${side}`}>
    <h2 className="text-lg font-semibold">Client {side}</h2>
    <p role="status">{status} · SDK loaded: {sdkLoaded ? 'Yes' : 'No'}</p>
    <p className="text-xs break-all">Stringee userId: {identity || '—'}</p>
    <p className="text-xs text-slate-400">{tokenSummary}</p>
    <div className="flex flex-wrap gap-2">
      <button className="px-3 py-2 rounded bg-blue-700 disabled:opacity-40" disabled={status === 'Connecting' || status === 'Connected' || busy} onClick={() => void connect()}>Kết nối {side}</button>
      <button className="px-3 py-2 rounded bg-slate-700 disabled:opacity-40" disabled={status !== 'Connected' || busy} onClick={() => client.current?.disconnect()}>Ngắt kết nối {side}</button>
      <button className="px-3 py-2 rounded bg-emerald-700 disabled:opacity-40" disabled={status !== 'Connected' || busy} onClick={startCall}>Gọi {side === 'A' ? 'B' : 'A'}</button>
      <button className="px-3 py-2 rounded bg-blue-700 disabled:opacity-40" disabled={!incoming} onClick={answer}>Nhận cuộc gọi {side}</button>
      <button className="px-3 py-2 rounded bg-rose-700 disabled:opacity-40" disabled={!busy} onClick={hangup}>Kết thúc {side}</button>
    </div>
    <p>Call: {phase}</p>
    {error && <p role="alert" className="text-rose-300">{error}</p>}
    <ol className="text-xs text-slate-400 space-y-1" aria-label={`Events ${side}`}>{events.map((event, i) => <li key={i}>{event}</li>)}</ol>
    <audio ref={audio} autoPlay playsInline />
  </section>;
}

export default function VoiceSdkTest() {
  const [normalToken, setNormalToken] = useState('Chưa kiểm tra');
  return <div className="space-y-5">
    <h1 className="text-2xl font-bold">CRM Voice — App-to-App Test</h1>
    <p className="text-sm text-slate-400">Hai client test riêng trong trình duyệt hiện tại. Kết nối A và B, sau đó gọi A → B và nhận tại B. Recording: Off. PSTN: Disabled.</p>
    <button className="px-3 py-2 rounded bg-slate-700" onClick={() => {
      void getToken().then(result => setNormalToken(`${result.summary} · userId: ${result.data.userId}`))
        .catch(error => setNormalToken(error instanceof Error ? error.message : 'TOKEN_FAILED'));
    }}>Kiểm tra token CRM</button>
    <p className="text-xs break-all" role="status">{normalToken}</p>
    <div className="grid gap-4 lg:grid-cols-2"><TestClient side="A" /><TestClient side="B" /></div>
  </div>;
}
