import type { DossierSnapshot } from './contracts';
import { actionLabels } from './contracts';

export function SnapshotPanel({ snapshot }: { snapshot: DossierSnapshot | null }) {
  if (!snapshot) return <p className="py-6 text-slate-400">Chưa có phân tích AI. Dữ kiện chưa xác định sẽ được để trống.</p>;
  const sections: [string, DossierSnapshot['intent']][] = [
    ['Nhu cầu', snapshot.intent], ['Quan tâm', snapshot.interests], ['Pain points', snapshot.painPoints],
    ['Objections', snapshot.objections], ['Tín hiệu tích cực', snapshot.positiveSignals], ['Rủi ro', snapshot.riskFlags],
    ['Cam kết của khách', snapshot.customerCommitments], ['Cam kết của sale', snapshot.salesCommitments],
  ];
  return <div className="space-y-5">
    <div><h3 className="text-sm font-medium text-blue-300">Tình trạng hiện tại</h3><p className="mt-2 text-lg leading-relaxed">{snapshot.currentSituation?.text || 'Chưa xác định'}</p></div>
    {snapshot.summary && <p className="text-sm leading-relaxed text-slate-300">{snapshot.summary.text}</p>}
    <div className="grid gap-5 md:grid-cols-2">{sections.map(([title, values]) => <section key={title}><h3 className="mb-2 text-sm font-semibold text-slate-300">{title}</h3>{values.length ? <ul className="list-inside list-disc space-y-1 text-sm text-slate-400">{values.map((v, i) => <li key={i}>{v.text}</li>)}</ul> : <p className="text-sm text-slate-500">Chưa có bằng chứng</p>}</section>)}</div>
    <section className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4"><h3 className="font-semibold">Bước tiếp theo được đề xuất</h3>{snapshot.nextActions.length ? <ul className="mt-2 space-y-1 text-sm text-blue-200">{snapshot.nextActions.map((a, i) => <li key={i}>{actionLabels[a.action]}</li>)}</ul> : <p className="mt-2 text-sm text-slate-400">Chưa có đề xuất</p>}<p className="mt-3 text-xs text-slate-500">Đề xuất cần người phụ trách xem xét.</p></section>
    <p className="text-xs text-slate-500">Độ tin cậy AI: {Math.round(snapshot.confidence * 100)}% · Trích dẫn từ dữ liệu khách/sale; chưa phải thông tin cá nhân đã xác minh.</p>
    <a className="text-xs text-blue-300" href="#timeline">Xem lịch sử và nguồn bằng chứng ({snapshot.evidence.length}) ↓</a>
  </div>;
}
