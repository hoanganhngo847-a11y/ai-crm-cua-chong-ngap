'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  getZaloCallSummary,
  getZaloTranscription,
  linkZaloCustomer,
  listZaloCalls,
  playZaloRecording,
  retryZaloCallSummaryAction,
  retryZaloTranscription,
  searchZaloCustomers,
} from '../../../actions/zalo-recordings';

type Call = Awaited<ReturnType<typeof listZaloCalls>>['items'][number];
type Candidate = {id:string;name:string;customer_code:string};
function formatTranscriptTime(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function CallCard({call,onLinked}:{call:Call;onLinked:()=>void}) {
  const [candidates,setCandidates]=useState<Candidate[]>([]);
  const [selected,setSelected]=useState('');
  const [search,setSearch]=useState('');
  const [remember,setRemember]=useState(false);
  const [newName,setNewName]=useState(call.remote_display_name || '');
  const [creating,setCreating]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [audio,setAudio]=useState('');
  const initialStatus = (call as { transcript_status?: string }).transcript_status || 'PENDING';
  const [transcriptStatus, setTranscriptStatus] = useState<string>(initialStatus);
  const [transcript, setTranscript] = useState<Awaited<ReturnType<typeof getZaloTranscription>> | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);

  const initialSummaryStatus = (call as { summary_status?: string }).summary_status || 'NOT_STARTED';
  const [summaryStatus, setSummaryStatus] = useState<string>(initialSummaryStatus);
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof getZaloCallSummary>> | null>(null);
  const [expandedSummary, setExpandedSummary] = useState(false);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [retrySummaryBusy, setRetrySummaryBusy] = useState(false);

  const customer=(Array.isArray(call.customers)?call.customers[0]:call.customers) as {name:string;customer_code:string}|null;
  useEffect(()=>{
    if(call.customer_id) return;
    let active=true;
    searchZaloCustomers(call.id).then(items=>{if(active) setCandidates(items);}).catch(()=>{if(active) setError('Không tải được gợi ý.');});
    return ()=>{active=false;};
  },[call.id,call.customer_id]);
  async function perform(operation:()=>Promise<void>) {
    setBusy(true);setError('');
    try {await operation();} catch {setError('Thao tác chưa thành công. Vui lòng thử lại.');} finally {setBusy(false);}
  }
  async function toggleTranscript() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (!transcript) {
      setLoadingTranscript(true);
      try {
        const data = await getZaloTranscription(call.id);
        setTranscript(data);
        if (data?.status) setTranscriptStatus(data.status);
        setExpanded(true);
      } catch {
        setError('Không thể tải nội dung bóc băng.');
      } finally {
        setLoadingTranscript(false);
      }
    } else {
      setExpanded(true);
    }
  }
  async function handleRetryTranscription() {
    setRetryBusy(true);
    setError('');
    try {
      await retryZaloTranscription(call.id);
      setTranscriptStatus('PENDING');
      setTranscript(null);
      setExpanded(false);
    } catch {
      setError('Không thể yêu cầu thử lại bóc băng. Vui lòng thử lại sau.');
    } finally {
      setRetryBusy(false);
    }
  }
  async function toggleSummary() {
    if (expandedSummary) {
      setExpandedSummary(false);
      return;
    }
    if (!summary) {
      setLoadingSummary(true);
      try {
        const data = await getZaloCallSummary(call.id);
        setSummary(data);
        if (data?.status) setSummaryStatus(data.status);
        setExpandedSummary(true);
      } catch {
        setError('Không thể tải tóm tắt AI.');
      } finally {
        setLoadingSummary(false);
      }
    } else {
      setExpandedSummary(true);
    }
  }
  async function handleRetrySummary() {
    setRetrySummaryBusy(true);
    setError('');
    try {
      await retryZaloCallSummaryAction(call.id);
      setSummaryStatus('PENDING');
      setSummary(null);
      setExpandedSummary(false);
    } catch {
      setError('Không thể yêu cầu thử lại tóm tắt AI. Vui lòng thử lại sau.');
    } finally {
      setRetrySummaryBusy(false);
    }
  }
  return <article className="rounded-xl border border-slate-700 bg-slate-900 p-4 space-y-3">
    <div className="flex justify-between flex-wrap gap-2">
      <div><h3 className="font-semibold text-white">{call.remote_display_name || 'Chưa xác định tên'} · Zalo Personal</h3>
        <p className="text-sm text-slate-400">{new Date(call.started_at).toLocaleString('vi-VN')} · {Math.round(call.duration_seconds)} giây · {{INBOUND:'Gọi đến',OUTBOUND:'Gọi đi',UNKNOWN:'Chưa rõ hướng'}[call.direction as string] || 'Chưa rõ hướng'}</p>
      </div>
      <button type="button" disabled={busy} onClick={()=>perform(async()=>setAudio(await playZaloRecording(call.id)))} className="rounded bg-blue-800 px-3 py-2 text-sm disabled:opacity-50">▶ Nghe ghi âm</button>
    </div>
    {audio && <audio controls autoPlay src={audio} className="w-full" onError={()=>setError('Liên kết nghe đã hết hạn hoặc file chưa tải được. Bấm Nghe ghi âm để lấy lại.')} />}
    {call.identity_ambiguous && <p role="status" className="text-sm text-amber-300">Tên này có liên kết hoặc khách hàng trùng nhau. Các cuộc gọi sau vẫn cần xác nhận.</p>}
    {call.customer_id ? <p className="text-sm">Khách hàng: <Link href={`/customers/${call.customer_id}`} className="text-blue-300 underline">{customer?.name || 'Xem khách hàng'}</Link></p> : <>
      <p className="text-sm font-medium">Cuộc gọi Zalo mới · Khách hàng: Chưa xác định</p>
      <p className="text-xs text-slate-400">Tên hiển thị có thể trùng. Hãy xác nhận khách hàng trước khi ghi nhớ liên kết.</p>
      <form onSubmit={event=>{event.preventDefault();perform(async()=>{setCandidates(await searchZaloCustomers(call.id,search));setSelected('');});}} className="flex gap-2">
        <input aria-label="Tìm khách hàng" value={search} onChange={e=>setSearch(e.target.value)} minLength={2} maxLength={200} placeholder="Tên hoặc mã khách hàng" className="min-w-0 flex-1 rounded border border-slate-600 bg-slate-800 p-2 text-sm" />
        <button disabled={busy || search.trim().length<2} className="rounded bg-slate-700 px-3 text-sm disabled:opacity-50">Tìm khách hàng</button>
      </form>
      <fieldset className="space-y-2"><legend className="text-xs text-slate-400">Gợi ý (tối đa 20, chỉ để tham khảo)</legend>
        {candidates.map(candidate=><label key={candidate.id} className="flex gap-2 text-sm"><input type="radio" name={`customer-${call.id}`} value={candidate.id} checked={selected===candidate.id} onChange={()=>{setSelected(candidate.id);setCreating(false);}} />{candidate.name} · {candidate.customer_code}</label>)}
        {candidates.length===0 && <p className="text-xs text-slate-500">Chưa có gợi ý. Tìm khách hàng hoặc tạo mới.</p>}
      </fieldset>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={remember} disabled={!call.remote_display_name} onChange={e=>setRemember(e.target.checked)} />Ghi nhớ liên kết Zalo này cho các cuộc gọi sau</label>
      <div className="flex gap-3 flex-wrap">
        <button disabled={busy || !selected || creating} onClick={()=>perform(async()=>{await linkZaloCustomer(call.id,selected,remember);onLinked();})} className="rounded bg-blue-700 px-3 py-2 text-sm disabled:opacity-50">Xác nhận khách hàng</button>
        <button disabled={busy} onClick={()=>{setCreating(!creating);setSelected('');}} className="text-sm text-blue-300 underline">Tạo khách hàng mới</button>
      </div>
      {creating && <form className="flex gap-2" onSubmit={event=>{event.preventDefault();perform(async()=>{await linkZaloCustomer(call.id,null,remember,newName);onLinked();});}}>
        <input aria-label="Tên khách hàng mới" required maxLength={200} value={newName} onChange={e=>setNewName(e.target.value)} className="min-w-0 flex-1 rounded border border-slate-600 bg-slate-800 p-2 text-sm" />
        <button disabled={busy || !newName.trim()} className="rounded bg-blue-700 px-3 text-sm disabled:opacity-50">Tạo và liên kết</button>
      </form>}
    </>}
    <div className="pt-2 border-t border-slate-800 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">Bóc băng:</span>
          {transcriptStatus === 'COMPLETED' ? (
            <span className="inline-flex items-center rounded-full bg-emerald-950 px-2.5 py-0.5 text-xs font-medium text-emerald-400 border border-emerald-800">
              Đã hoàn thành
            </span>
          ) : transcriptStatus === 'FAILED' ? (
            <span className="inline-flex items-center rounded-full bg-red-950 px-2.5 py-0.5 text-xs font-medium text-red-400 border border-red-800">
              Thất bại
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-amber-950 px-2.5 py-0.5 text-xs font-medium text-amber-400 border border-amber-800">
              Đang xử lý…
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {transcriptStatus === 'COMPLETED' && (
            <button
              type="button"
              disabled={loadingTranscript}
              onClick={toggleTranscript}
              className="text-xs text-blue-400 hover:text-blue-300 underline disabled:opacity-50"
            >
              {loadingTranscript ? 'Đang tải…' : expanded ? 'Ẩn nội dung' : 'Xem nội dung'}
            </button>
          )}
          {transcriptStatus === 'FAILED' && (
            <button
              type="button"
              disabled={busy || retryBusy}
              onClick={handleRetryTranscription}
              className="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 text-xs text-slate-300 disabled:opacity-50"
            >
              {retryBusy ? 'Đang gửi…' : 'Thử lại'}
            </button>
          )}
        </div>
      </div>
      {expanded && transcript && (
        <div className="rounded-lg bg-slate-950/80 p-3 space-y-3 text-sm border border-slate-800 max-h-96 overflow-y-auto">
          {transcript.utterances.length === 0 ? (
            <p className="text-xs text-slate-400">Không có giọng nói được phát hiện.</p>
          ) : (
            transcript.utterances.map((u) => (
              <div key={u.id || u.sequence} className="space-y-1">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-slate-400">{formatTranscriptTime(u.start_ms)}</span>
                  <span
                    className={`font-semibold ${
                      u.speaker_role === 'STAFF' ? 'text-blue-400' : 'text-emerald-400'
                    }`}
                  >
                    {u.speaker_role === 'STAFF' ? 'Staff' : 'Customer'}
                  </span>
                </div>
                <p className="text-slate-200 pl-2 border-l border-slate-700 text-sm whitespace-pre-wrap">
                  {u.text}
                </p>
              </div>
            ))
          )}
        </div>
      )}
    </div>
    <div className="pt-2 border-t border-slate-800 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">AI Summary:</span>
          {summaryStatus === 'COMPLETED' ? (
            <span className="inline-flex items-center rounded-full bg-emerald-950 px-2.5 py-0.5 text-xs font-medium text-emerald-400 border border-emerald-800">
              Đã hoàn thành
            </span>
          ) : summaryStatus === 'FAILED' ? (
            <span className="inline-flex items-center rounded-full bg-red-950 px-2.5 py-0.5 text-xs font-medium text-red-400 border border-red-800">
              Thất bại
            </span>
          ) : summaryStatus === 'PROCESSING' ? (
            <span className="inline-flex items-center rounded-full bg-blue-950 px-2.5 py-0.5 text-xs font-medium text-blue-400 border border-blue-800">
              Đang phân tích…
            </span>
          ) : summaryStatus === 'PENDING' ? (
            <span className="inline-flex items-center rounded-full bg-amber-950 px-2.5 py-0.5 text-xs font-medium text-amber-400 border border-amber-800">
              Đang chờ xử lý…
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-slate-800 px-2.5 py-0.5 text-xs font-medium text-slate-400 border border-slate-700">
              Chưa bắt đầu
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {summaryStatus === 'COMPLETED' && (
            <button
              type="button"
              disabled={loadingSummary}
              onClick={toggleSummary}
              className="text-xs text-blue-400 hover:text-blue-300 underline disabled:opacity-50"
            >
              {loadingSummary ? 'Đang tải…' : expandedSummary ? 'Ẩn tóm tắt' : 'Xem tóm tắt'}
            </button>
          )}
          {summaryStatus === 'FAILED' && (
            <button
              type="button"
              disabled={busy || retrySummaryBusy}
              onClick={handleRetrySummary}
              className="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 text-xs text-slate-300 disabled:opacity-50"
            >
              {retrySummaryBusy ? 'Đang gửi…' : 'Thử lại'}
            </button>
          )}
        </div>
      </div>
      {expandedSummary && summary && summary.status === 'COMPLETED' && (
        <div className="rounded-lg bg-slate-950/80 p-3 space-y-3 text-sm border border-slate-800">
          <div className="flex flex-wrap items-center gap-2 pb-2 border-b border-slate-800 text-xs">
            {summary.lead_temperature && (
              <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-medium border ${
                summary.lead_temperature === 'HOT'
                  ? 'bg-rose-950/80 text-rose-300 border-rose-800'
                  : summary.lead_temperature === 'WARM'
                  ? 'bg-amber-950/80 text-amber-300 border-amber-800'
                  : 'bg-slate-800 text-slate-300 border-slate-700'
              }`}>
                Nhiệt độ lead: <strong>{summary.lead_temperature}</strong>
              </span>
            )}
            {summary.confidence && (
              <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-medium border ${
                summary.confidence === 'HIGH'
                  ? 'bg-emerald-950/80 text-emerald-300 border-emerald-800'
                  : summary.confidence === 'MEDIUM'
                  ? 'bg-amber-950/80 text-amber-300 border-amber-800'
                  : 'bg-slate-800 text-slate-400 border-slate-700'
              }`}>
                Độ tin cậy: <strong>{summary.confidence}</strong>
              </span>
            )}
          </div>
          {summary.summary && (
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Tóm tắt</h4>
              <p className="text-slate-200 text-sm whitespace-pre-wrap">{summary.summary}</p>
            </div>
          )}
          {Array.isArray(summary.key_points) && summary.key_points.length > 0 && (
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Điểm chính</h4>
              <ul className="list-disc list-inside space-y-0.5 text-xs text-slate-300">
                {summary.key_points.map((kp: string, idx: number) => (
                  <li key={idx}>{kp}</li>
                ))}
              </ul>
            </div>
          )}
          {Array.isArray(summary.customer_needs) && summary.customer_needs.length > 0 && (
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Nhu cầu khách hàng</h4>
              <ul className="list-disc list-inside space-y-0.5 text-xs text-slate-300">
                {summary.customer_needs.map((item: string, idx: number) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {Array.isArray(summary.objections) && summary.objections.length > 0 && (
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Phản đối / Băn khoăn</h4>
              <ul className="list-disc list-inside space-y-0.5 text-xs text-slate-300">
                {summary.objections.map((item: string, idx: number) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {Array.isArray(summary.next_actions) && summary.next_actions.length > 0 && (
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Việc cần làm tiếp (Gợi ý AI)</h4>
              <ul className="list-disc list-inside space-y-0.5 text-xs text-slate-300">
                {summary.next_actions.map((item: string, idx: number) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {summary.follow_up_required && (
            <div className="rounded border border-amber-800/60 bg-amber-950/30 p-2 space-y-1 text-xs">
              <span className="font-semibold text-amber-300">Cần liên hệ lại (Follow-up):</span>
              {summary.follow_up_suggested_time && (
                <p className="text-slate-300">Thời gian: {summary.follow_up_suggested_time}</p>
              )}
              {summary.follow_up_reason && (
                <p className="text-slate-300">Lý do: {summary.follow_up_reason}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
  </article>;
}
export default function ZaloRecordingHistory({customerId}:{customerId?:string}) {
  const [result,setResult]=useState<Awaited<ReturnType<typeof listZaloCalls>>|null>(null);
  const [page,setPage]=useState(1),[version,setVersion]=useState(0),[error,setError]=useState('');
  useEffect(()=>{
    let active=true;
    listZaloCalls(page,customerId).then(data=>{if(active){setResult(data);setError('');}}).catch(()=>{if(active) setError('Không tải được lịch sử Zalo. Kiểm tra kết nối hoặc cấu hình hệ thống.');});
    return ()=>{active=false;};
  },[page,customerId,version]);
  return <section aria-label="Cuộc gọi Zalo Personal" className="space-y-3">
    <div className="flex items-center justify-between"><h2 className="font-semibold text-lg">Cuộc gọi Zalo Personal</h2><button onClick={()=>setVersion(v=>v+1)} className="text-sm text-blue-300 underline">Làm mới</button></div>
    {error && <p role="alert" className="text-red-300 text-sm">{error}</p>}
    {!result && !error && <p role="status" className="text-slate-400 text-sm">Đang tải cuộc gọi Zalo…</p>}
    {result?.items.map(call=><CallCard key={call.id} call={call} onLinked={()=>setVersion(v=>v+1)} />)}
    {result?.items.length===0 && <p className="text-slate-400 text-sm">Chưa có bản ghi Zalo trong phạm vi quyền của bạn.</p>}
    {result && result.total>20 && <div className="flex items-center gap-3 text-sm"><button disabled={page<=1} onClick={()=>setPage(p=>p-1)} className="disabled:opacity-40">← Trước</button><span>Trang {page} / {Math.ceil(result.total/20)}</span><button disabled={page*20>=result.total} onClick={()=>setPage(p=>p+1)} className="disabled:opacity-40">Sau →</button></div>}
  </section>;
}
