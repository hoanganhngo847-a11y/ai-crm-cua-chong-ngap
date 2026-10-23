'use client';

import { useActionState } from 'react';
import { requestDossierRefresh, saveDossierNote, saveDossierProfile, linkDossierEmail } from '../../app/actions/customer-dossier';

const initial = { ok: false, message: '' };
export function DossierProfileForm({ customerId, profile, owners }: { customerId: string;
  profile: { address: string | null; special_notes: string | null; birth_year: number | null; assigned_sale_id: string | null } | null;
  owners: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(saveDossierProfile, initial);
  const [emailState, emailAction, emailPending] = useActionState(linkDossierEmail, initial);
  const field = 'mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 p-2';
  return <details className="rounded-2xl border border-slate-800 bg-slate-900 p-5"><summary className="cursor-pointer font-semibold">Cập nhật hồ sơ & Email</summary>
    <form action={action} className="mt-4 grid gap-4 text-sm md:grid-cols-2">
      <input type="hidden" name="customerId" value={customerId} />
      <label>Địa chỉ<input name="address" defaultValue={profile?.address || ''} maxLength={1000} className={field} /></label>
      <label>Năm sinh<input type="number" name="birthYear" min={1900} max={2100} defaultValue={profile?.birth_year ?? ''} className={field} /></label>
      <label>Sale phụ trách<select name="assignedSale" defaultValue={profile?.assigned_sale_id || ''} className={field}><option value="">Theo hội thoại / Chưa phân công</option>{owners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
      <label>Ghi chú đặc biệt<textarea name="specialNotes" defaultValue={profile?.special_notes || ''} maxLength={4000} className={field} /></label>
      <button disabled={pending} className="w-fit rounded-lg bg-blue-600 px-4 py-2 disabled:opacity-50">{pending ? 'Đang lưu…' : 'Lưu hồ sơ'}</button><p aria-live="polite" className="text-slate-400">{state.message}</p>
    </form>
    <form action={emailAction} className="mt-5 flex flex-wrap items-end gap-3 border-t border-slate-800 pt-4 text-sm">
      <input type="hidden" name="customerId" value={customerId} /><label className="flex-1">Thêm email<input type="email" name="email" maxLength={254} required className={field} /></label><button disabled={emailPending} className="rounded-lg border border-slate-700 px-4 py-2 disabled:opacity-50">Liên kết email</button><p aria-live="polite" className="w-full text-slate-400">{emailState.message}</p>
    </form>
  </details>;
}
export function DossierRefresh({ customerId }: { customerId: string }) {
  const [state, action, pending] = useActionState(requestDossierRefresh, initial);
  return <form action={action} className="space-y-2">
    <input type="hidden" name="customerId" value={customerId} />
    <button disabled={pending} className="rounded-lg border border-blue-500/40 px-4 py-2 text-sm text-blue-300 disabled:opacity-50">{pending ? 'Đang phân tích…' : 'Cập nhật phân tích AI'}</button>
    <p aria-live="polite" className="text-sm text-slate-400">{state.message}</p>
  </form>;
}
export function DossierNote({ customerId }: { customerId: string }) {
  const [state, action, pending] = useActionState(saveDossierNote, initial);
  return <form action={action} className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-5">
    <h2 className="text-lg font-semibold">Ghi chú của sale</h2>
    <input type="hidden" name="customerId" value={customerId} />
    <label htmlFor="dossier-note" className="text-sm text-slate-400">Ghi chú thủ công (tối đa 2.000 ký tự)</label>
    <textarea id="dossier-note" name="note" required maxLength={2000} rows={3} className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3" />
    <button disabled={pending} className="rounded-lg bg-blue-600 px-4 py-2 text-sm disabled:opacity-50">{pending ? 'Đang lưu…' : 'Lưu ghi chú'}</button>
    <p aria-live="polite" className="text-sm text-slate-400">{state.message}</p>
  </form>;
}
