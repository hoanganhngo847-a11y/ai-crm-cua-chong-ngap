'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { linkZaloCustomer, listZaloCalls, playZaloRecording, searchZaloCustomers } from '../../../actions/zalo-recordings';

type Call = Awaited<ReturnType<typeof listZaloCalls>>['items'][number];
type Candidate = {id:string;name:string;customer_code:string};
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
