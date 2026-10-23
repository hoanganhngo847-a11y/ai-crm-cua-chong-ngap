import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { DossierError, getDossier } from '../../../../../features/customer-360/service';
import { SnapshotPanel } from '../../../../../features/customer-360/snapshot-panel';
import { DossierNote, DossierRefresh, DossierProfileForm } from '../../../../../features/customer-360/forms';
import ZaloRecordingHistory from '../../../calls/components/ZaloRecordingHistory';

export const metadata = { title: 'Hồ sơ Customer 360 | AI CRM' };
const filters = ['ALL','MESSAGE','CALL','NOTE','AI','EVENT'] as const;
const labels = ['Tất cả','Tin nhắn','Cuộc gọi','Ghi chú','AI Updates','Sự kiện'];
function date(value: string | null | undefined) { return value ? new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : 'Chưa xác định'; }
export default async function CustomerDossier({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const raw = await searchParams;
  const query = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), filter: z.enum(filters).default('ALL') }).strict().safeParse(raw);
  if (!query.success) return <p role="alert" className="p-8">Bộ lọc không hợp lệ. <Link href={`/customers/${id}/dossier`}>Xóa lọc</Link></p>;
  const parsedQuery = query.data;
  let dossier;
  try { dossier = await getDossier(id, query.data.page, query.data.filter); }
  catch (error) { if (error instanceof DossierError && error.status === 404) notFound(); throw error; }
  const { customer: c, profile, history, timeline, queue, boss } = dossier;
  const current = history[0];
  const assignedSale = dossier.owners.find(o => o.id === (profile?.assigned_sale_id ?? dossier.contacts.assignedSaleId))?.name;
  const stale = queue && queue.requested_version > queue.completed_version;
  const processing = !!queue?.lock_token && !!queue.lease_until && Date.parse(queue.lease_until) > Date.parse(dossier.observedAt);
  function href(page: number) { return `/customers/${id}/dossier?filter=${parsedQuery.filter}&page=${page}#timeline`; }
  return <div className="mx-auto max-w-7xl space-y-6 p-4 text-slate-100 md:p-8">
    <Link href="/customers/dossier" className="text-sm text-blue-300">← Danh sách Customer 360</Link>
    <header className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs text-slate-500">{c.customer_code}</p><h1 className="mt-1 text-3xl font-bold">{c.name}</h1></div><span className="rounded-lg bg-blue-500/10 px-3 py-2 text-sm text-blue-300">{c.stage}</span></div>
      <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-sm text-slate-400"><p>Sale: <span className="text-white">{assignedSale || 'Chưa phân công'}</span></p><p>Nguồn: {c.source}</p><p>Điểm tiềm năng: {current?.lead_score ?? 'Chưa đánh giá'}</p><p>Liên hệ gần nhất: {date(dossier.contacts.lastInteraction)}</p></div>
      <Link href={`/customers/${id}`} className="mt-4 inline-block text-xs text-blue-300">Hồ sơ nghiệp vụ, khảo sát và gọi khách →</Link>
    </header>
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
      <section className="rounded-2xl border border-blue-500/30 bg-slate-900 p-6">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">AI Customer Snapshot</h2><p className="mt-1 text-xs text-slate-400">AI cập nhật: {date(current?.generated_at)}{processing ? ' · Đang xử lý' : stale ? ' · Có dữ liệu mới, chờ cập nhật' : ''}</p></div>{boss && <DossierRefresh customerId={id} />}</div>
        {queue?.error_code && <p role="status" className="mb-4 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-300">Lần phân tích gần nhất chưa thành công. Hồ sơ trước vẫn được giữ lại.{queue.attempts >= 5 ? ' Đã hết lượt thử tự động; có thể yêu cầu cập nhật lại.' : ''}</p>}
        {boss ? <SnapshotPanel snapshot={current?.snapshot ?? null} /> : <p className="text-sm text-slate-400">Snapshot tổng hợp dành cho Boss theo quyền truy cập transcript hiện tại.</p>}
        <p className="mt-4 text-sm text-slate-400">Lịch liên hệ lại: {date(current?.follow_up_at)}</p>
      </section>
      <aside className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900 p-6"><h2 className="text-lg font-semibold">Liên hệ & Danh tính</h2>
        <dl className="space-y-4 text-sm"><div><dt className="text-slate-500">Email</dt><dd>{dossier.emails.join(', ') || 'Chưa xác định'}</dd></div><div><dt className="text-slate-500">Điện thoại</dt><dd>{dossier.contacts.phone || 'Chưa xác định'} · <Link href={`/customers/${id}`} className="text-blue-300">hồ sơ nghiệp vụ</Link></dd></div><div><dt className="text-slate-500">Địa chỉ</dt><dd>{profile?.address || 'Chưa xác định'}</dd></div><div><dt className="text-slate-500">Năm sinh</dt><dd>{profile?.birth_year ?? 'Chưa xác định'}</dd></div><div><dt className="text-slate-500">Ghi chú đặc biệt (nhập thủ công)</dt><dd className="whitespace-pre-wrap">{profile?.special_notes || 'Chưa có'}</dd></div></dl>
        <ul className="space-y-2 border-t border-slate-800 pt-4">{dossier.identities.map((identity, i) => <li key={i} className="text-sm"><span className="text-slate-500">{identity.channel}</span><p>{identity.display_name || identity.legacy_name || 'Đã liên kết'} <span className="text-xs text-slate-500">{identity.verified ? '· Đã xác minh' : '· Chưa xác minh'}</span></p></li>)}</ul>
        {!!dossier.conflicts.length && <p role="status" className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-300">Có {dossier.conflicts.length} xung đột danh tính cần quản trị viên kiểm tra. Các hồ sơ vẫn được giữ riêng.</p>}
      </aside>
    </div>
    {boss && <DossierProfileForm customerId={id} profile={profile} owners={dossier.owners} />}
    <DossierNote customerId={id} />
    <section id="timeline" className="scroll-mt-5 rounded-2xl border border-slate-800 bg-slate-900 p-6"><h2 className="text-xl font-semibold">Lịch sử tương tác</h2>
      <nav aria-label="Loại tương tác" className="my-4 flex flex-wrap gap-2">{filters.map((f, i) => <Link aria-current={query.data.filter === f ? 'page' : undefined} key={f} href={`/customers/${id}/dossier?filter=${f}#timeline`} className={`rounded-lg px-3 py-2 text-sm ${query.data.filter === f ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400'}`}>{labels[i]}</Link>)}</nav>
      <ol className="space-y-4 border-l border-slate-700 pl-5">{timeline.items.map(e => <li id={e.id} key={e.id} className="rounded-xl border border-slate-800 bg-slate-950/40 p-4"><div className="mb-2 flex flex-wrap justify-between gap-2 text-xs text-slate-500"><span>{e.kind === 'NOTE' ? 'Ghi chú thủ công' : e.kind === 'AI' ? 'Phân tích AI' : e.channel} · {e.direction === 'INBOUND' ? 'Khách → Sale' : e.direction === 'OUTBOUND' ? 'Sale → Khách' : ''}</span><time dateTime={e.at}>{date(e.at)}</time></div><p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-300">{e.content || 'Chưa có nội dung'}</p>{e.id.startsWith('recording:') && <a href="#calls" className="mt-2 inline-block text-xs text-blue-300">Nghe ghi âm / Mở transcript ↓</a>}</li>)}</ol>
      {!timeline.items.length && <p className="py-8 text-center text-sm text-slate-500">Chưa có tương tác phù hợp.</p>}
      <nav aria-label="Phân trang lịch sử" className="mt-5 flex gap-4 text-sm">{query.data.page > 1 && <Link href={href(query.data.page - 1)}>← Trước</Link>}<span className="text-slate-500">{timeline.total} sự kiện</span>{query.data.page * timeline.pageSize < timeline.total && <Link href={href(query.data.page + 1)}>Sau →</Link>}</nav>
    </section>
    <section id="calls" className="scroll-mt-5 space-y-4"><h2 className="text-xl font-semibold">Cuộc gọi · Recording · Transcript</h2><ZaloRecordingHistory customerId={id} /></section>
    {!!history.length && <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6"><h2 className="mb-4 text-lg font-semibold">Lịch sử phân tích AI</h2>{history.map(h => <details key={h.id} className="border-t border-slate-800 py-3"><summary className="cursor-pointer text-sm text-slate-300">{date(h.generated_at)} · Phiên bản {h.version}</summary><div className="pt-4"><SnapshotPanel snapshot={h.snapshot} /></div></details>)}<p className="mt-2 text-xs text-slate-500">Hiển thị 10 phiên bản gần nhất; các phiên bản cũ vẫn được lưu.</p></section>}
  </div>;
}
