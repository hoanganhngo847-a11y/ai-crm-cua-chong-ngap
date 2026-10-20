'use client';
import { useEffect, useState } from 'react';
import { listZaloDevices, registerZaloDevice, revokeZaloDevice } from '../../../actions/zalo-recordings';

export default function DeviceManager() {
  const [data,setData]=useState<Awaited<ReturnType<typeof listZaloDevices>>|null>(null);
  const [id,setId]=useState(''),[name,setName]=useState(''),[staff,setStaff]=useState('');
  const [credential,setCredential]=useState<{device_id:string;secret:string}|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[version,setVersion]=useState(0);
  useEffect(()=>{let active=true;listZaloDevices().then(value=>{if(active)setData(value);}).catch(()=>{if(active)setError('Không tải được thiết bị.');});return()=>{active=false;};},[version]);
  return <div className="space-y-5">
    <p className="text-sm text-slate-400">Mỗi đăng ký dành cho một tài khoản Zalo trên một Mac. Khi đổi tài khoản Zalo, thu hồi thiết bị và đăng ký context mới trước khi bật upload. Tên hiển thị không phải Zalo UID.</p>
    <form className="space-y-3 max-w-xl" onSubmit={async event=>{event.preventDefault();setBusy(true);setError('');setCredential(null);try{setCredential(await registerZaloDevice(id,name,staff||null));setVersion(v=>v+1);}catch{setError('Đăng ký chưa thành công. Kiểm tra Device ID mới và nhân viên hợp lệ.');}finally{setBusy(false);}}}>
      <label className="block text-sm">Device ID từ lệnh <code>bash local-agent/run.sh --device-id</code><input required value={id} onChange={e=>setId(e.target.value)} placeholder="UUID của Mac" className="mt-1 block w-full rounded bg-slate-800 p-2" /></label>
      <label className="block text-sm">Tên thiết bị<input required maxLength={100} value={name} onChange={e=>setName(e.target.value)} className="mt-1 block w-full rounded bg-slate-800 p-2" /></label>
      <label className="block text-sm">Nhân viên<select value={staff} onChange={e=>setStaff(e.target.value)} className="mt-1 block w-full rounded bg-slate-800 p-2"><option value="">Máy dùng chung — chỉ Boss xem bản ghi</option>{data?.staff.map(member=>{const profile=(Array.isArray(member.user_profiles)?member.user_profiles[0]:member.user_profiles) as {full_name:string}|null;return <option key={member.user_id} value={member.user_id}>{profile?.full_name || member.user_id} ({member.role})</option>;})}</select></label>
      <button disabled={busy} className="rounded bg-blue-700 px-4 py-2 disabled:opacity-50">Đăng ký thiết bị</button>
    </form>
    {credential && <div className="max-w-xl space-y-2 rounded border border-amber-600 p-4"><p>Secret chỉ hiển thị lần này. Nhập vào Terminal khi chạy <code>bash local-agent/run.sh --configure-upload</code>.</p><label className="block text-sm">Device secret<textarea aria-label="Device secret" readOnly value={credential.secret} className="mt-1 block w-full break-all rounded bg-slate-800 p-2 font-mono" /></label><button onClick={()=>setCredential(null)} className="text-sm underline">Đã lưu vào Keychain, ẩn secret</button></div>}
    {error && <p role="alert" className="text-red-300">{error}</p>}
    <ul className="space-y-2">{data?.devices.map(device=><li key={device.id} className="rounded border border-slate-700 p-3 text-sm space-y-1"><p>{device.device_name} · {device.active?'Hoạt động':'Đã thu hồi'}</p><p className="text-slate-400 break-all">{device.id}</p><p className="text-slate-400">Upload gần nhất: {device.last_seen_at?new Date(device.last_seen_at).toLocaleString('vi-VN'):'Chưa có'}</p>{device.active && <button disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await revokeZaloDevice(device.id);setCredential(null);setVersion(v=>v+1);}catch{setError('Chưa thu hồi được thiết bị.');}finally{setBusy(false);}}} className="text-red-300 underline disabled:opacity-50">Thu hồi quyền upload</button>}</li>)}</ul>
  </div>;
}
