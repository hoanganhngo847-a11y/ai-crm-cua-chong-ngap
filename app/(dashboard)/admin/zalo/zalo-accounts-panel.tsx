'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronRight, Copy, Eye, EyeOff, Loader2, Plus, ShieldCheck, Upload, Users } from 'lucide-react';
import type { ZaloAccountSummary } from '@/features/omnichannel/zalo/accounts/service';

const INPUT = 'w-full rounded-lg border border-border-subtle bg-surface-primary px-3 py-2.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500';
const IMEI_COMMAND = "localStorage.getItem('z_uuid') || localStorage.getItem('sh_z_uuid')";
const UA_COMMAND = 'navigator.userAgent';
const ERRORS: Record<string, string> = {
  LOGIN_FAILED: 'Chưa đăng nhập được Zalo. Hãy kiểm tra Cookie, IMEI và User-Agent có cùng hồ sơ Chrome và còn hiệu lực.',
  DUPLICATE_ZALO_ACCOUNT: 'Tài khoản Zalo này đã được kết nối. Hãy dùng cookie của tài khoản khác.',
  ZALO_ACCOUNT_IDENTITY_CHANGED: 'Bộ thông tin mới thuộc tài khoản Zalo khác. Hãy thêm riêng tài khoản đó.',
  LISTENER_DISCONNECTED: 'Kết nối Zalo bị gián đoạn. Hệ thống đang thử kết nối lại.',
  PROCESS_EXITED: 'Phiên đồng bộ đã dừng. Hệ thống đang kiểm tra lại.',
  ZALO_LEGACY_NOT_READY: 'Hệ thống đang kiểm tra tài khoản hiện tại. Trạng thái sẽ tự cập nhật.',
};
function accountStatus(account: ZaloAccountSummary) {
  if (!account.enabled) return { text: 'Tạm dừng', color: 'bg-slate-100 text-slate-600' };
  if (account.status === 'CONNECTED' && account.last_heartbeat_at && Date.now() - Date.parse(account.last_heartbeat_at) < 90000) return { text: 'Đã kết nối', color: 'bg-emerald-50 text-emerald-700' };
  if (account.status === 'ERROR') return { text: 'Cần kiểm tra', color: 'bg-rose-50 text-rose-700' };
  if (account.status === 'CONNECTED') return { text: 'Đang kiểm tra lại kết nối', color: 'bg-amber-50 text-amber-700' };
  return { text: 'Đang kết nối', color: 'bg-blue-50 text-blue-700' };
}
function Command({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="flex items-start gap-2 rounded-lg bg-slate-950 p-3 text-xs text-slate-100">
    <code className="min-w-0 flex-1 break-all leading-relaxed">{value}</code>
    <button type="button" title="Sao chép lệnh" aria-label="Sao chép lệnh" onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); } catch { setCopied(false); } }} className="shrink-0 rounded p-1 hover:bg-white/15">{copied ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}</button>
  </div>;
}
export function ZaloAccountsPanel() {
  const [accounts, setAccounts] = useState<ZaloAccountSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [legacyConnected, setLegacyConnected] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | undefined>();
  const [label, setLabel] = useState('');
  const [cookie, setCookie] = useState('');
  const [imei, setImei] = useState('');
  const [userAgent, setUserAgent] = useState('');
  const [showCookie, setShowCookie] = useState(false);
  const [fileName, setFileName] = useState('');
  const [fileKey, setFileKey] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/inbox/zalo-zcajs/accounts', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error('READ_FAILED');
      setAccounts(body.accounts); setLegacyConnected(body.legacyConnected); setLoadError('');
    } catch { setLoadError('Chưa tải được trạng thái tài khoản. Hãy làm mới hoặc kiểm tra phiên đăng nhập.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { const initial = setTimeout(() => void load(), 0); const timer = setInterval(() => void load(), 10000); return () => { clearTimeout(initial); clearInterval(timer); }; }, [load]);
  function clearSecrets() { setCookie(''); setImei(''); setUserAgent(''); setFileName(''); setFileKey((key) => key + 1); setShowCookie(false); }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/inbox/zalo-zcajs/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: editing, label, cookie, imei, userAgent }) });
      const body = await response.json();
      if (!response.ok || !body.success) { setError(body.message || 'Chưa lưu được tài khoản.'); return; }
      clearSecrets(); setLabel(''); setEditing(undefined); setMessage(body.message); await load();
    } catch { setError('Kết nối bị gián đoạn. Hãy kiểm tra danh sách tài khoản trước khi thử lưu lại.'); }
    finally { setSaving(false); }
  }
  async function toggle(account: ZaloAccountSummary) {
    setBusyId(account.id); setError(''); setMessage('');
    try {
      const response = await fetch('/api/inbox/zalo-zcajs/accounts', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: account.id, enabled: !account.enabled }) });
      const body = await response.json();
      if (!response.ok || !body.success) setError(body.message || 'Chưa đổi được trạng thái.');
      else await load();
    } catch { setError('Chưa đổi được trạng thái. Vui lòng thử lại.'); }
    finally { setBusyId(null); }
  }
  return <>
    <div className="grid gap-3 sm:grid-cols-3">
      {[['Tài khoản hiện tại', loading ? 'Đang kiểm tra…' : legacyConnected ? 'Đang đồng bộ' : 'Cần kiểm tra kết nối'], ['Tài khoản thêm', `${accounts.length} / 3`], ['Đã kết nối thêm', String(accounts.filter((a) => accountStatus(a).text === 'Đã kết nối').length)]].map(([title, value]) => <div key={title} className="rounded-xl border border-border-subtle bg-surface-primary p-4"><p className="text-xs text-text-tertiary">{title}</p><p className="mt-2 text-base font-semibold text-text-primary">{value}</p></div>)}
    </div>
    {loadError && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{loadError}</p>}
    {message && <p role="status" className="flex items-start gap-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800"><CheckCircle2 className="h-5 w-5 shrink-0" />{message}</p>}
    {error && <p role="alert" className="flex items-start gap-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-800"><AlertCircle className="h-5 w-5 shrink-0" />{error}</p>}
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <section className="rounded-xl border border-border-subtle bg-surface-primary p-5 sm:p-6">
        <h2 className="flex items-center gap-2 text-base font-semibold"><Plus className="h-5 w-5 text-blue-600" />{editing ? 'Cập nhật thông tin kết nối' : 'Thêm tài khoản Zalo'}</h2>
        <p className="mt-1 text-xs leading-relaxed text-text-secondary">Chuẩn bị Cookie, IMEI và User-Agent từ cùng một hồ sơ Chrome đã đăng nhập tài khoản muốn thêm.</p>
        <form ref={formRef} onSubmit={save} className="mt-6 space-y-5" autoComplete="off">
          <div><label htmlFor="zalo-account-label" className="mb-1.5 block text-sm font-medium">Tên tài khoản <span className="text-rose-600">*</span></label>
            <input id="zalo-account-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="Ví dụ: Zalo tư vấn 02 — Lan" className={INPUT} required />
            <p className="mt-1 text-xs text-text-tertiary">Tên này giúp bạn chọn đúng tài khoản khi xem và trả lời hội thoại.</p></div>
          <div><label htmlFor="zalo-cookie" className="mb-1.5 block text-sm font-medium">Cookie Zalo (JSON) <span className="text-rose-600">*</span></label>
            <label className="mb-2 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-blue-300 bg-blue-50 px-3 py-3 text-sm text-blue-700 hover:bg-blue-100"><Upload className="h-4 w-4" />{fileName || 'Chọn file JSON từ J2TEAM Cookies'}
              <input key={fileKey} type="file" accept=".json,application/json" className="sr-only" aria-label="Tải file Cookie JSON" onChange={async (e) => {
                const file = e.target.files?.[0]; if (!file) return;
                if (file.size > 128 * 1024) { setError('File cookie tối đa 128 KB.'); return; }
                try { const text = await file.text(); JSON.parse(text); setCookie(text); setFileName(file.name); setError(''); }
                catch { setError('File chưa phải JSON hợp lệ. Hãy xuất lại từ J2TEAM Cookies, để trống mật khẩu mã hóa.'); }
              }} /></label>
            <textarea id="zalo-cookie" value={cookie} onChange={(e) => { setCookie(e.target.value); setFileName(''); }} rows={4} spellCheck={false} placeholder='Hoặc dán nội dung JSON có trường "cookies" vào đây' className={`${INPUT} font-mono text-xs`} style={{ WebkitTextSecurity: showCookie ? 'none' : 'disc' } as React.CSSProperties} required />
            <button type="button" onClick={() => setShowCookie((visible) => !visible)} className="mt-1 inline-flex items-center gap-1 text-xs text-text-secondary">{showCookie ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}{showCookie ? 'Ẩn cookie' : 'Hiện cookie để kiểm tra'}</button></div>
          <div><label htmlFor="zalo-imei" className="mb-1.5 block text-sm font-medium">IMEI <span className="text-rose-600">*</span></label><input id="zalo-imei" value={imei} onChange={(e) => setImei(e.target.value)} type="password" maxLength={200} placeholder="Dán kết quả lệnh lấy IMEI" className={INPUT} required /><p className="mt-1 text-xs text-text-tertiary">Đây là mã phiên Zalo Web lấy theo hướng dẫn bên cạnh. Kết quả phải khác null.</p></div>
          <div><label htmlFor="zalo-user-agent" className="mb-1.5 block text-sm font-medium">User-Agent <span className="text-rose-600">*</span></label><textarea id="zalo-user-agent" value={userAgent} onChange={(e) => setUserAgent(e.target.value)} maxLength={1024} rows={3} placeholder="Mozilla/5.0 ..." className={`${INPUT} font-mono text-xs`} spellCheck={false} required /></div>
          <p className="flex items-start gap-2 text-xs leading-relaxed text-text-secondary"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />Thông tin đăng nhập được mã hóa khi lưu và không hiển thị lại trong danh sách tài khoản.</p>
          <div className="flex flex-wrap items-center gap-3"><button type="submit" disabled={saving || (!editing && accounts.length >= 3)} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}{saving ? 'Đang lưu…' : editing ? 'Lưu và kết nối lại' : 'Lưu và kết nối tài khoản'}</button>
          {editing && <button type="button" onClick={() => { setEditing(undefined); setLabel(''); clearSecrets(); }} className="text-sm text-text-secondary">Hủy cập nhật</button>}</div>
        </form>
      </section>
      <section className="space-y-4 rounded-xl border border-border-subtle bg-surface-primary p-5 sm:p-6">
        <h2 className="text-base font-semibold">Hướng dẫn lấy thông tin</h2>
        <ol className="space-y-5 text-sm leading-relaxed text-text-secondary">
          <li><p className="font-semibold text-text-primary">1. Mở đúng tài khoản Zalo</p><p>Tạo một hồ sơ Chrome riêng cho mỗi tài khoản. Mở <a href="https://chat.zalo.me" target="_blank" rel="noreferrer" className="text-blue-600 underline">chat.zalo.me</a>, đăng nhập tài khoản muốn thêm và chờ hội thoại tải xong.</p></li>
          <li><p className="font-semibold text-text-primary">2. Xuất Cookie bằng J2TEAM Cookies</p><p>Cài <a href="https://chromewebstore.google.com/detail/j2team-cookies/okpidcojinmlaakglciglbpcpajaibco" target="_blank" rel="noreferrer" className="text-blue-600 underline">J2TEAM Cookies chính thức</a>. Khi đang mở Zalo Web, bấm tiện ích → Export/Xuất → lưu file JSON. Để trống mật khẩu mã hóa của bản JSON dùng kết nối. Chọn file đó ở ô Cookie.</p></li>
          <li className="space-y-2"><p className="font-semibold text-text-primary">3. Lấy IMEI</p><p>Trong cùng tab Zalo Web, mở Console bằng <strong>⌘ + ⌥ + J</strong> trên Mac hoặc <strong>Ctrl + Shift + J</strong> trên Windows. Nhập lệnh sau:</p><Command value={IMEI_COMMAND} /><p>Sao chép kết quả vào ô IMEI. Nếu kết quả là null, kiểm tra đã đăng nhập đúng Zalo Web rồi thử lại.</p></li>
          <li className="space-y-2"><p className="font-semibold text-text-primary">4. Lấy User-Agent</p><p>Trong cùng Console, nhập:</p><Command value={UA_COMMAND} /><p>Dán toàn bộ kết quả vào ô User-Agent.</p></li>
          <li><p className="font-semibold text-text-primary">5. Lưu và chờ kết nối</p><p>Đặt tên dễ nhớ rồi bấm <strong>Lưu và kết nối tài khoản</strong>. Đóng tab Zalo Web của tài khoản vừa thêm để tránh tranh phiên kết nối. Theo dõi trạng thái bên dưới; khi hiện Đã kết nối, mở Hộp thư để nhận tin nhắn.</p></li>
        </ol>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">Cookie là thông tin đăng nhập. Chỉ nhập tại trang CRM này. Mỗi bộ Cookie, IMEI và User-Agent phải thuộc cùng tài khoản và cùng hồ sơ Chrome.</div>
      </section>
    </div>
    <section className="rounded-xl border border-border-subtle bg-surface-primary p-5 sm:p-6"><div className="flex items-center justify-between gap-3"><h2 className="flex items-center gap-2 text-base font-semibold"><Users className="h-5 w-5 text-blue-600" />Tài khoản đã thêm</h2><button type="button" onClick={() => void load()} className="text-xs font-medium text-blue-600">Làm mới trạng thái</button></div>
      {loading ? <p className="py-6 text-sm text-text-secondary">Đang tải tài khoản…</p> : !accounts.length ? <p className="py-6 text-sm text-text-secondary">Chưa có tài khoản bổ sung. Tài khoản Zalo hiện tại vẫn hoạt động riêng.</p> : <div className="mt-4 divide-y divide-border-subtle">{accounts.map((account) => {
        const status = accountStatus(account);
        return <div key={account.id} className="flex flex-wrap items-center justify-between gap-3 py-4"><div><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold">{account.label}</p><span className={`rounded-full px-2 py-1 text-xs ${status.color}`}>{status.text}</span></div>
          {account.provider_uid && <p className="mt-1 text-xs text-text-tertiary">Zalo ID: {account.provider_uid}</p>}
          {account.error_code && <p className="mt-2 max-w-xl text-xs text-rose-700">{ERRORS[account.error_code] || 'Kết nối chưa hoàn tất. Hãy kiểm tra lại thông tin đã nhập.'}</p>}
        </div><div className="flex items-center gap-3"><button type="button" onClick={() => { setEditing(account.id); setLabel(account.label); clearSecrets(); setMessage(''); setError(''); formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} className="text-xs font-medium text-blue-600">Cập nhật thông tin</button>
          <button type="button" disabled={busyId === account.id} onClick={() => void toggle(account)} className="rounded-lg border border-border-subtle px-3 py-2 text-xs disabled:opacity-50">{account.enabled ? 'Tạm dừng' : 'Kết nối lại'}<ChevronRight className="ml-1 inline h-3 w-3" /></button></div></div>;
      })}</div>}
    </section>
  </>;
}
