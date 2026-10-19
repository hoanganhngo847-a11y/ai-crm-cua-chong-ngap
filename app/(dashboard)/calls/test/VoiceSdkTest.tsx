'use client';

import Link from 'next/link';
import { prepareBrowserBusinessCallAction, cancelPreparedBrowserBusinessCallAction } from '../../../actions/voice';
import { useEffect, useRef, useState } from 'react';
import {
  ensureStringeeSdk, STRINGEE_SERVER_ADDRS,
  type StringeeCallLike, type StringeeClientLike, type StringeeResult, type StringeeState,
} from '../../../../features/voice/client/stringee-sdk';

type TokenData = { accessToken: string; userId: string; peerUserId?: string; expiresIn: number };

async function getToken(side?: 'A' | 'B', customerId?: string): Promise<{ data: TokenData; summary: string }> {
  const response = await fetch(`/api/voice/client-token${side ? `?testClient=${side}${customerId ? `&testCustomer=${encodeURIComponent(customerId)}` : ''}` : ''}`, { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || typeof data.accessToken !== 'string') throw new Error(`HTTP ${response.status}: ${data.error || 'TOKEN_FAILED'}`);
  const allowed = ['ok', 'accessToken', 'userId', 'peerUserId', 'expiresIn', 'serverAddresses', 'pstnAvailable', 'recordingEnabled'];
  if (Object.keys(data).some(key => !allowed.includes(key))) throw new Error('UNEXPECTED_TOKEN_RESPONSE_FIELDS');
  const payload = data.accessToken.split('.')[1].replaceAll('-', '+').replaceAll('_', '/');
  const claims = JSON.parse(atob(payload));
  if (claims.userId !== data.userId || claims.exp * 1000 <= Date.now() || claims.rest_api) throw new Error('INVALID_CLIENT_TOKEN');
  return { data, summary: `HTTP ${response.status} · token generated: yes · expires: ${new Date(claims.exp * 1000).toISOString()} · server secret fields: none` };
}

type TestCustomer = { id: string; name: string; customer_code: string };
function TestClient({ side, customer }: { side: 'A' | 'B'; customer?: TestCustomer }) {
  const preparedCallId = useRef('');
  const [crmCallId, setCrmCallId] = useState('');
  const [microphone, setMicrophone] = useState('Not requested');
  const [remoteAudio, setRemoteAudio] = useState('Not received');
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const mediaElements = useRef<HTMLMediaElement[]>([]);
  const audioContexts = useRef<AudioContext[]>([]);
  const meters = useRef<number[]>([]);
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
  const mediaContainer = useRef<HTMLDivElement | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const generation = useRef(0);

  const log = (message: string) => setEvents(old => [...old.slice(-19), message]);
  const clearMedia = () => {
    meters.current.forEach(window.clearInterval); meters.current = [];
    audioContexts.current.forEach(context => { void context.close(); }); audioContexts.current = [];
    mediaElements.current.forEach(element => { element.pause(); element.srcObject = null; }); mediaElements.current = [];
    mediaContainer.current?.replaceChildren();
  };
  const inspectRemoteStream = (stream: MediaStream) => {
    const tracks = stream.getAudioTracks();
    setRemoteAudio(tracks.some(track => track.readyState === 'live') ? 'Live audio track received' : 'No audio track');
    if (!tracks.length) return;
    const context = new AudioContext(); audioContexts.current.push(context);
    const source = context.createMediaStreamSource(stream); const analyser = context.createAnalyser();
    source.connect(analyser); const samples = new Uint8Array(analyser.fftSize);
    let detected = false;
    const timer = window.setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length);
      if (rms > 0.005 && !detected) { detected = true; setRemoteAudio('Live audio track received · non-silent signal detected'); log('remote audio: non-silent signal detected'); }
    }, 250);
    meters.current.push(timer);
    void context.resume().catch(() => undefined);
  };
  const playMedia = (element: HTMLMediaElement) => {
    mediaElements.current.push(element);
    void element.play().catch(() => setPlaybackBlocked(true));
  };
  const acquireMicrophone = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const acquired = stream.getAudioTracks().some(track => track.readyState === 'live');
      stream.getTracks().forEach(track => track.stop());
      if (!acquired) throw new Error('NO_MICROPHONE');
      setMicrophone('Acquired'); log('microphone acquired'); return true;
    } catch { setMicrophone('Denied or unavailable'); setError('Hãy cấp quyền microphone để thử audio.'); return false; }
  };
  const attachCall = (value: StringeeCallLike) => {
    call.current = value;
    value.on('addremotestream', ((stream: MediaStream) => {
      inspectRemoteStream(stream);
      if (audio.current) { audio.current.srcObject = stream; playMedia(audio.current); }
    }) as never);
    value.on('addremotetrack', ((track: { attach?: (audioOnly?: boolean) => HTMLElement }) => {
      const element = track.attach?.(true);
      if (element instanceof HTMLMediaElement) {
        mediaContainer.current?.appendChild(element); playMedia(element);
        if (element.srcObject instanceof MediaStream) inspectRemoteStream(element.srcObject);
      }
    }) as never);
    value.on('signalingstate', ((state: StringeeState) => {
      const reason = String(state?.reason || '');
      log(`signalingstate: ${state.code ?? ''} ${reason}`);
      if (state.code === 2 || /ring/i.test(reason)) setPhase('Ringing');
      if (state.code === 3 || /answer|connected/i.test(reason)) setPhase('Answered');
      if (state.code === 5 || state.code === 6 || /ended|hangup|busy|reject/i.test(reason)) {
        setPhase('Ended'); setIncoming(false); setBusy(false); call.current = null; clearMedia();
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
      const result = await getToken(side, customer?.id);
      if (current !== generation.current) return;
      setTokenSummary(result.summary); setIdentity(result.data.userId);
      users.current = { own: result.data.userId, peer: result.data.peerUserId || '' };
      const sdkClient = new window.StringeeClient!(STRINGEE_SERVER_ADDRS);
      client.current = sdkClient;
      sdkClient.on('connect', (() => { if (current === generation.current) log('connect'); }) as never);
      sdkClient.on('authen', ((result: StringeeResult) => {
        if (current !== generation.current) return;
        const message = String(result.message || '').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT REDACTED]').slice(0, 200);
        log(`authen: r=${result.r} ${message}`);
        setStatus(result.r === 0 ? 'Connected' : 'Error');
        if (result.r !== 0) setError(`Stringee authentication failed: ${message || result.r}`);
      }) as never);
      sdkClient.on('disconnect', (() => {
        if (current !== generation.current) return;
        setStatus(previous => previous === 'Error' ? 'Error' : 'Disconnected'); log('disconnect');
      }) as never);
      sdkClient.on('requestnewtoken', (() => {
        if (current !== generation.current) return;
        log('requestnewtoken');
        void getToken(side, customer?.id).then(result => {
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

  const startCall = async () => {
    const Constructor = window.StringeeCall2 || window.StringeeCall;
    if (!Constructor || !client.current || !users.current.peer || busy) return;
    setBusy(true);
    if (!(await acquireMicrophone())) { setBusy(false); return; }
    clearMedia(); setRemoteAudio('Not received'); setCrmCallId(''); preparedCallId.current = '';
    if (customer) {
      if (side !== 'A') return;
      setBusy(true); setPhase('Preparing CRM call');
      const prepared = await prepareBrowserBusinessCallAction({ customerId: customer.id, requestId: crypto.randomUUID() });
      if (!prepared.success || !prepared.data) { setBusy(false); setError(prepared.error || 'PREPARE_FAILED'); return; }
      preparedCallId.current = prepared.data.callId;
      setCrmCallId(prepared.data.callId); log(`CRM call + attempt prepared: ${prepared.data.callId}`);
    }
    const value = new Constructor(client.current, users.current.own, users.current.peer, false);
    attachCall(value); setBusy(true); setPhase('Calling'); setError('');
    value.makeCall(result => {
      log(`makeCall: r=${result.r} · Stringee callId=${value.callId || 'pending'}`);
      if (result.r !== 0) {
        if (preparedCallId.current) void cancelPreparedBrowserBusinessCallAction({ callId: preparedCallId.current }).catch(() => setError('Cuộc gọi cần đối soát hồ sơ chuẩn bị.'));
        setPhase('Error'); setError(`Call rejected: ${result.r}`); setBusy(false); call.current = null; }
    });
  };

  const answer = async () => {
    if (!(await acquireMicrophone())) return;
    call.current?.answer(result => {
    log(`answer: r=${result.r}`);
    if (result.r === 0) { setPhase('Answered'); setIncoming(false); }
    else { setError(`Answer rejected: ${result.r}`); setPhase('Error'); }
  });

  };

  const hangup = () => call.current?.hangup(result => {
    log(`hangup: r=${result.r}`);
    if (result.r !== 0) { setError(`Hangup rejected: ${result.r}`); return; }
    setPhase('Ended'); setBusy(false); setIncoming(false); call.current = null; clearMedia();
  });

  useEffect(() => () => {
    generation.current++;
    clearMedia();
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
      <button className="px-3 py-2 rounded bg-emerald-700 disabled:opacity-40" disabled={status !== 'Connected' || busy || Boolean(customer && side === 'B')} onClick={() => void startCall()}>Gọi {side === 'A' ? 'B' : 'A'}</button>
      <button className="px-3 py-2 rounded bg-blue-700 disabled:opacity-40" disabled={!incoming} onClick={() => void answer()}>Nhận cuộc gọi {side}</button>
      <button className="px-3 py-2 rounded bg-rose-700 disabled:opacity-40" disabled={!busy} onClick={hangup}>Kết thúc {side}</button>
    </div>
    <p>Call: {phase}</p>
    {crmCallId && <p className="text-xs break-all">CRM call_id: {crmCallId}</p>}
    <p className="text-xs">Microphone: {microphone} · Remote: {remoteAudio}</p>
    {playbackBlocked && <button className="px-3 py-2 rounded bg-amber-700" onClick={() => {
      setPlaybackBlocked(false); mediaElements.current.forEach(element => { void element.play().catch(() => setPlaybackBlocked(true)); });
      audioContexts.current.forEach(context => { void context.resume(); });
    }}>Bật âm thanh {side}</button>}
    {error && <p role="alert" className="text-rose-300">{error}</p>}
    <ol className="text-xs text-slate-400 space-y-1" aria-label={`Events ${side}`}>{events.map((event, i) => <li key={i}>{event}</li>)}</ol>
    <audio ref={audio} autoPlay playsInline />
    <div ref={mediaContainer} />
  </section>;
}

export default function VoiceSdkTest({ customer, testCustomerIds = [] }: { customer?: TestCustomer; testCustomerIds?: string[] }) {
  const [normalToken, setNormalToken] = useState('Chưa kiểm tra');
  return <div className="space-y-5">
    <h1 className="text-2xl font-bold">CRM Voice — {customer ? 'Business App-to-App Test' : 'App-to-App Test'}</h1>
    {customer ? <p>Customer test: {customer.name} [{customer.customer_code}] · {customer.id} · <Link href={`/calls/${customer.id}`}>Lịch sử CRM</Link></p>
      : testCustomerIds.map(id => <Link className="block text-blue-300" key={id} href={`/calls/test?customerId=${id}`}>Mở business test cho customer {id}</Link>)}
    <p className="text-sm text-slate-400">Hai client test riêng trong trình duyệt hiện tại. Kết nối A và B, sau đó gọi A → B và nhận tại B. Recording: Off. PSTN: Disabled.</p>
    <button className="px-3 py-2 rounded bg-slate-700" onClick={() => {
      void getToken().then(result => setNormalToken(`${result.summary} · userId: ${result.data.userId}`))
        .catch(error => setNormalToken(error instanceof Error ? error.message : 'TOKEN_FAILED'));
    }}>Kiểm tra token CRM</button>
    <p className="text-xs break-all" role="status">{normalToken}</p>
    <div className="grid gap-4 lg:grid-cols-2"><TestClient side="A" customer={customer} /><TestClient side="B" customer={customer} /></div>
  </div>;
}
