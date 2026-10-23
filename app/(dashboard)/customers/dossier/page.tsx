import Link from 'next/link';
import { createAdminClient } from '../../../../lib/supabase/admin';
import { recordingActor } from '../../../../features/zalo-recordings/access';
import { dossierOwners, listCustomersForActor, listFilters } from '../../../../features/customer-360/service';
import { CUSTOMER_STAGES } from '../../../../features/crm/types/customer.types';

export const metadata = { title: 'Customer 360 | AI CRM' };
const field = 'rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm';
function date(value: string | null) { return value ? new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : 'Chưa có'; }
export default async function CustomerDossierList({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const parsed = listFilters.safeParse(Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== '')));
  if (!parsed.success) return <p role="alert" className="p-8">Bộ lọc không hợp lệ. <Link href="/customers/dossier">Xóa bộ lọc</Link></p>;
  const f = parsed.data;
  const actor = await recordingActor();
  const db = createAdminClient();
  const [data, owners] = await Promise.all([listCustomersForActor(db, actor, f), dossierOwners(db, actor.companyId)]);
  function pageHref(page: number) {
    const query = new URLSearchParams(Object.entries(f).map(([k, v]) => [k, String(v)]));
    query.set('page', String(page)); return `/customers/dossier?${query}`;
  }
  return <div className="mx-auto max-w-[1600px] space-y-6 p-4 text-slate-100 md:p-8">
    <header className="flex flex-wrap items-center justify-between gap-4"><div><h1 className="text-2xl font-bold">Customer 360</h1><p className="text-sm text-slate-400">Danh tính, lịch sử và tình trạng khách hàng trong một hồ sơ.</p></div><Link className="text-sm text-blue-300" href="/customers">Quản lý khách hàng →</Link></header>
    <form className="flex flex-wrap gap-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <input aria-label="Tìm khách hàng" name="search" defaultValue={f.search} placeholder="Tên, số điện thoại, email, Zalo, Facebook…" className={`${field} min-w-64 flex-1`} />
      <select aria-label="Sale phụ trách" name="owner" defaultValue={f.owner || ''} className={field}><option value="">Tất cả sale</option>{owners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
      <select aria-label="Kênh liên hệ" name="channel" defaultValue={f.channel || ''} className={field}><option value="">Tất cả kênh</option>{['ZALO','FACEBOOK','PHONE','EMAIL'].map(c => <option key={c}>{c}</option>)}</select>
      <select aria-label="Giai đoạn" name="stage" defaultValue={f.stage || ''} className={field}><option value="">Tất cả giai đoạn</option>{[...new Set(Object.values(CUSTOMER_STAGES))].map(s => <option key={s}>{s}</option>)}</select>
      <select aria-label="Sắp xếp" name="sort" defaultValue={f.sort} className={field}><option value="updated">Mới cập nhật</option><option value="name">Tên A–Z</option><option value="contact">Liên hệ gần nhất</option><option value="score">Điểm tiềm năng</option><option value="followup">Hạn liên hệ lại</option></select>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="recent" value="1" defaultChecked={!!f.recent} /> Hoạt động 7 ngày qua</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="hot" value="1" defaultChecked={!!f.hot} /> Điểm ≥ 70</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="overdue" value="1" defaultChecked={!!f.overdue} /> Quá hạn liên hệ</label>
      <button className="rounded-lg bg-blue-600 px-4 py-2 text-sm">Áp dụng</button><Link className="p-2 text-sm text-slate-400" href="/customers/dossier">Xóa lọc</Link>
    </form>
    <p className="text-sm text-slate-400">{data.total} khách hàng · Trang {data.page} / {Math.max(1, Math.ceil(data.total / data.pageSize))} · Điểm và lịch liên hệ chưa được đánh giá sẽ hiển thị “—”.</p>
    <div className="overflow-x-auto rounded-2xl border border-slate-800"><table className="w-full min-w-[1500px] text-left text-sm"><thead className="bg-slate-900 text-xs uppercase text-slate-400"><tr>{['Khách hàng','Zalo','Facebook','Điện thoại','Email','Sale','Giai đoạn','Điểm','Tình trạng hiện tại','Liên hệ gần nhất','Liên hệ lại','Cập nhật'].map(t => <th className="p-3" key={t}>{t}</th>)}</tr></thead><tbody>
      {data.items.map(c => <tr key={c.id} className="border-t border-slate-800 align-top hover:bg-slate-900/60">
        <td className="p-3"><Link className="font-semibold text-blue-300" href={`/customers/${c.id}/dossier`}>{c.name}</Link><p className="text-xs text-slate-500">{c.customer_code}</p></td>
        <td className="p-3">{c.zalo_name || '—'}</td><td className="p-3">{c.facebook_name || '—'}</td><td className="whitespace-nowrap p-3">{c.phone || '—'}</td><td className="p-3">{c.email || '—'}</td><td className="p-3">{c.assigned_sale || 'Chưa phân công'}</td>
        <td className="p-3"><span className="rounded bg-slate-800 px-2 py-1 text-xs">{c.stage}</span></td><td className="p-3">{c.lead_score ?? '—'}</td><td className="max-w-72 p-3">{c.current_situation || 'Chưa có phân tích'}</td><td className="p-3">{date(c.last_interaction)}</td><td className="p-3">{c.follow_up_at ? date(c.follow_up_at) : '—'}</td><td className="p-3">{date(c.updated_at)}</td>
      </tr>)}
      {!data.items.length && <tr><td colSpan={12} className="p-8 text-center text-slate-400">Không có khách hàng phù hợp.</td></tr>}
    </tbody></table></div>
    <nav aria-label="Phân trang" className="flex gap-4 text-sm">{f.page > 1 && <Link href={pageHref(f.page - 1)}>← Trước</Link>}{f.page * data.pageSize < data.total && <Link href={pageHref(f.page + 1)}>Sau →</Link>}</nav>
  </div>;
}
