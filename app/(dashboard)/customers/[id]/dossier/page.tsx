import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { DossierError, getDossier } from '../../../../../features/customer-360/service';
import { SnapshotPanel } from '../../../../../features/customer-360/snapshot-panel';
import { DossierNote, DossierRefresh, DossierProfileForm } from '../../../../../features/customer-360/forms';
import ZaloRecordingHistory from '../../../calls/components/ZaloRecordingHistory';
import { Button } from '../../../../../components/ui/button';
import { StatusBadge } from '../../../../../components/ui/status-badge';
import { Badge } from '../../../../../components/ui/badge';
import { Card, CardHeader, CardTitle, CardContent } from '../../../../../components/ui/card';
import { Avatar } from '../../../../../components/ui/avatar';
import {
  PhoneRevealProvider,
  SecurePhoneRow,
} from '../../../../../features/crm/components/secure-phone-reveal';
import {
  PhoneCall,
  ExternalLink,
  Sparkles,
  AlertTriangle,
  Mail,
  Phone,
  MapPin,
  Calendar,
  FileText,
  MessageSquare,
  ChevronLeft,
} from 'lucide-react';

export const metadata = { title: 'Hồ sơ Customer 360 | AI CRM' };

const filters = ['ALL', 'MESSAGE', 'CALL', 'NOTE', 'AI', 'EVENT'] as const;
const filterLabels: Record<string, string> = {
  ALL: 'Tất cả',
  MESSAGE: 'Tin nhắn',
  CALL: 'Cuộc gọi',
  NOTE: 'Ghi chú',
  AI: 'AI Updates',
  EVENT: 'Sự kiện',
};

function formatDate(value: string | null | undefined) {
  if (!value) return 'Chưa xác định';
  try {
    return new Date(value).toLocaleString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      dateStyle: 'short',
      timeStyle: 'short',
    });
  } catch {
    return value;
  }
}

export default async function CustomerDossier({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const raw = await searchParams;

  const query = z
    .object({
      page: z.coerce.number().int().min(1).max(10000).default(1),
      filter: z.enum(filters).default('ALL'),
      tab: z.enum(['overview', 'timeline', 'calls', 'history', 'profile']).default('overview'),
    })
    .strict()
    .safeParse(raw);

  if (!query.success) {
    return (
      <div className="p-8">
        <p role="alert" className="text-xs text-[var(--danger)]">
          Bộ lọc hoặc tham số URL không hợp lệ.{' '}
          <Link href={`/customers/${id}/dossier`} className="text-[var(--accent)] underline">
            Xóa lọc
          </Link>
        </p>
      </div>
    );
  }

  const parsedQuery = query.data;
  let dossier;
  try {
    dossier = await getDossier(id, parsedQuery.page, parsedQuery.filter);
  } catch (error) {
    if (error instanceof DossierError && error.status === 404) notFound();
    throw error;
  }

  const { customer: c, profile, history, timeline, queue, boss } = dossier;
  const current = history[0];
  const assignedSale =
    profile?.assigned_sale_name ||
    dossier.owners.find(
      (o) => o.id === (profile?.assigned_sale_id ?? dossier.contacts.assignedSaleId)
    )?.name;

  const stale = queue && queue.requested_version > queue.completed_version;
  const processing =
    !!queue?.lock_token &&
    !!queue.lease_until &&
    Date.parse(queue.lease_until) > Date.parse(dossier.observedAt);

  const activeTab = parsedQuery.tab;

  function tabHref(tabName: string) {
    const q = new URLSearchParams(
      Object.entries(parsedQuery).map(([k, v]) => [k, String(v)])
    );
    q.set('tab', tabName);
    return `/customers/${id}/dossier?${q}#tabs`;
  }

  function timelineHref(page: number, filterName: string = parsedQuery.filter) {
    const q = new URLSearchParams();
    q.set('tab', 'timeline');
    q.set('filter', filterName);
    q.set('page', String(page));
    return `/customers/${id}/dossier?${q}#tabs`;
  }

  const scoreBadgeVariant =
    current?.lead_score !== null && current?.lead_score !== undefined
      ? current.lead_score >= 70
        ? 'danger'
        : current.lead_score >= 40
        ? 'warning'
        : 'neutral'
      : 'neutral';

  return (
    <div className="space-y-6">
      {/* Top Breadcrumb & Actions */}
      <div className="flex items-center justify-between gap-3">
        <Link
          href="/customers/dossier"
          className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
          <span>Danh sách Customer 360</span>
        </Link>

        <div className="flex items-center gap-2">
          {boss && <DossierRefresh customerId={id} />}
          <Link href={`/calls/${id}`}>
            <Button variant="secondary" size="xs" leftIcon={<PhoneCall className="w-3 h-3 text-emerald-600" />}>
              Gọi điện
            </Button>
          </Link>
          <Link href={`/customers/${id}`}>
            <Button variant="outline" size="xs" rightIcon={<ExternalLink className="w-3 h-3" />}>
              Hồ sơ nghiệp vụ &amp; Khảo sát
            </Button>
          </Link>
        </div>
      </div>

      {/* Record Workspace Header (Attio Style) */}
      <Card className="p-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-4">
            <Avatar name={c.name} size="lg" />
            <div className="min-w-0">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-xl sm:text-2xl font-semibold text-[var(--text-primary)] tracking-tight">
                  {c.name}
                </h1>
                <StatusBadge status={c.stage} size="sm" />
                {current?.lead_score !== null && current?.lead_score !== undefined && (
                  <Badge variant={scoreBadgeVariant} size="sm">
                    Lead Score: {current.lead_score}
                  </Badge>
                )}
              </div>

              <div className="flex items-center gap-3 mt-1.5 text-xs text-[var(--text-secondary)] flex-wrap">
                <span className="font-mono text-[var(--text-tertiary)]">
                  Mã: {c.customer_code}
                </span>
                <span>•</span>
                <span>
                  Sale:{' '}
                  <strong className="font-medium text-[var(--text-primary)]">
                    {assignedSale || 'Chưa phân công'}
                  </strong>
                </span>
                <span>•</span>
                <span>Nguồn: {c.source || 'Trực tiếp'}</span>
                <span>•</span>
                <span>
                  Liên hệ gần nhất: {formatDate(dossier.contacts.lastInteraction)}
                </span>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* Tab Navigation */}
      <div id="tabs" className="border-b border-[var(--border-subtle)] flex items-center gap-2 overflow-x-auto select-none">
        <Link
          href={tabHref('overview')}
          className={`px-3.5 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
            activeTab === 'overview'
              ? 'border-[var(--accent)] text-[var(--accent)] font-semibold'
              : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          }`}
        >
          Tổng quan &amp; AI Snapshot
        </Link>
        <Link
          href={tabHref('timeline')}
          className={`px-3.5 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
            activeTab === 'timeline'
              ? 'border-[var(--accent)] text-[var(--accent)] font-semibold'
              : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          }`}
        >
          Dòng thời gian tương tác ({timeline.total})
        </Link>
        <Link
          href={tabHref('calls')}
          className={`px-3.5 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
            activeTab === 'calls'
              ? 'border-[var(--accent)] text-[var(--accent)] font-semibold'
              : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          }`}
        >
          Cuộc gọi &amp; Ghi âm Zalo
        </Link>
        <Link
          href={tabHref('history')}
          className={`px-3.5 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
            activeTab === 'history'
              ? 'border-[var(--accent)] text-[var(--accent)] font-semibold'
              : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          }`}
        >
          Lịch sử phiên bản AI ({history.length})
        </Link>
        {boss && (
          <Link
            href={tabHref('profile')}
            className={`px-3.5 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
              activeTab === 'profile'
                ? 'border-[var(--accent)] text-[var(--accent)] font-semibold'
                : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            Chỉnh sửa hồ sơ &amp; Email
          </Link>
        )}
      </div>

      {/* TAB 1: OVERVIEW */}
      {activeTab === 'overview' && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
          {/* Main Left Column: AI Snapshot & Notes */}
          <div className="space-y-6">
            <Card>
              <CardHeader className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-indigo-600" />
                    <span>AI Customer Snapshot</span>
                  </CardTitle>
                  <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                    Cập nhật:{' '}
                    <span className="font-mono">{formatDate(current?.generated_at)}</span>
                    {processing
                      ? ' · Đang xử lý'
                      : stale
                      ? ' · Có tương tác mới, chờ phân tích'
                      : ''}
                  </p>
                </div>
              </CardHeader>

              <CardContent className="space-y-4">
                {queue?.error_code && (
                  <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                    <span>
                      Lần phân tích gần nhất chưa hoàn tất. Bản phân tích trước đó vẫn được giữ an toàn.{' '}
                      {queue.attempts >= 5 ? 'Đã hết lượt thử tự động; có thể bấm cập nhật lại.' : ''}
                    </span>
                  </div>
                )}

                {boss ? (
                  <SnapshotPanel snapshot={current?.snapshot ?? null} />
                ) : (
                  <p className="text-xs text-[var(--text-secondary)] italic">
                    AI Snapshot tổng hợp hiện được giới hạn hiển thị theo phân quyền transcript của Ban quản trị.
                  </p>
                )}

                <div className="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between text-xs text-[var(--text-secondary)]">
                  <span>
                    Lịch hẹn gọi lại tiếp theo:{' '}
                    <strong className="text-[var(--text-primary)] font-mono">
                      {formatDate(current?.follow_up_at)}
                    </strong>
                  </span>
                </div>
              </CardContent>
            </Card>

            {/* Quick Note Input */}
            <DossierNote customerId={id} />
          </div>

          {/* Right Rail: Contact & Identity Context */}
          <aside className="space-y-6">
            <PhoneRevealProvider>
            <Card>
              <CardHeader>
                <CardTitle>Liên hệ &amp; Danh tính đa kênh</CardTitle>
              </CardHeader>

              <CardContent className="space-y-4 text-xs">
                {/* Phone */}
                <div className="flex items-start gap-2.5">
                  <Phone className="w-4 h-4 text-[var(--text-tertiary)] mt-0.5 shrink-0" />
                  <div>
                    <div className="text-[11px] text-[var(--text-tertiary)]">Số điện thoại</div>
                    <div className="font-mono text-sm font-medium text-[var(--text-primary)]">
                      <SecurePhoneRow
                        customerId={dossier.customer.id}
                        maskedPhone={dossier.contacts.phone}
                      />
                    </div>
                  </div>
                </div>

                {/* Email */}
                <div className="flex items-start gap-2.5">
                  <Mail className="w-4 h-4 text-[var(--text-tertiary)] mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[11px] text-[var(--text-tertiary)]">Email</div>
                    <div className="font-medium text-[var(--text-primary)] truncate">
                      {dossier.emails.join(', ') || 'Chưa có'}
                    </div>
                  </div>
                </div>

                {/* Address */}
                <div className="flex items-start gap-2.5">
                  <MapPin className="w-4 h-4 text-[var(--text-tertiary)] mt-0.5 shrink-0" />
                  <div>
                    <div className="text-[11px] text-[var(--text-tertiary)]">Địa chỉ công trình</div>
                    <div className="text-[var(--text-primary)] leading-relaxed">
                      {profile?.address || 'Chưa cập nhật'}
                    </div>
                  </div>
                </div>

                {/* Birth year */}
                <div className="flex items-start gap-2.5">
                  <Calendar className="w-4 h-4 text-[var(--text-tertiary)] mt-0.5 shrink-0" />
                  <div>
                    <div className="text-[11px] text-[var(--text-tertiary)]">Năm sinh</div>
                    <div className="font-mono text-[var(--text-primary)]">
                      {profile?.birth_year ?? 'Chưa xác định'}
                    </div>
                  </div>
                </div>

                {/* Sale Notes */}
                {(profile?.sale_notes || profile?.special_notes) && (
                  <div className="p-3 rounded-lg bg-[var(--surface-secondary)] border border-[var(--border-subtle)]">
                    <div className="text-[11px] font-semibold text-[var(--text-secondary)] mb-1">
                      Ghi chú của Sale
                    </div>
                    <p className="text-xs text-[var(--text-primary)] whitespace-pre-wrap leading-relaxed">
                      {profile.sale_notes || profile.special_notes}
                    </p>
                  </div>
                )}

                {/* Marketing Notes */}
                {profile?.marketing_notes && (
                  <div className="p-3 rounded-lg bg-[var(--surface-secondary)] border border-[var(--border-subtle)]">
                    <div className="text-[11px] font-semibold text-[var(--text-secondary)] mb-1">
                      Ghi chú của Marketing
                    </div>
                    <p className="text-xs text-[var(--text-primary)] whitespace-pre-wrap leading-relaxed">
                      {profile.marketing_notes}
                    </p>
                  </div>
                )}

                {/* AI Notes */}
                {profile?.ai_notes && (
                  <div className="p-3 rounded-lg bg-[var(--surface-secondary)] border border-[var(--border-subtle)]">
                    <div className="text-[11px] font-semibold text-[var(--text-secondary)] mb-1">
                      Ghi chú của AI
                    </div>
                    <p className="text-xs text-[var(--text-primary)] whitespace-pre-wrap leading-relaxed">
                      {profile.ai_notes}
                    </p>
                  </div>
                )}

                {/* Channel Identities */}
                <div className="pt-3 border-t border-[var(--border-subtle)] space-y-2">
                  <div className="text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider font-mono">
                    Danh tính đã liên kết
                  </div>
                  {dossier.identities.map((identity, i) => (
                    <div
                      key={i}
                      className="p-2 rounded bg-[var(--surface-secondary)] border border-[var(--border-subtle)] flex items-center justify-between"
                    >
                      <div className="min-w-0">
                        <span className="text-[10px] font-mono uppercase text-[var(--text-tertiary)] block">
                          {identity.channel}
                        </span>
                        <span className="font-medium text-[var(--text-primary)] truncate block">
                          {identity.display_name || identity.legacy_name || 'Đã liên kết'}
                        </span>
                      </div>
                      <Badge variant={identity.verified ? 'success' : 'neutral'} size="xs">
                        {identity.verified ? 'Xác minh' : 'Chưa xác minh'}
                      </Badge>
                    </div>
                  ))}
                </div>

                {/* Identity Conflicts */}
                {!!dossier.conflicts.length && (
                  <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-xs">
                    Có {dossier.conflicts.length} xung đột danh tính cần kiểm tra. Dữ liệu các hồ sơ vẫn được cách ly an toàn.
                  </div>
                )}
              </CardContent>
            </Card>
            </PhoneRevealProvider>
          </aside>
        </div>
      )}

      {/* TAB 2: TIMELINE */}
      {activeTab === 'timeline' && (
        <Card className="p-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5 pb-3 border-b border-[var(--border-subtle)]">
            <div>
              <CardTitle>Dòng thời gian tương tác</CardTitle>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                Toàn bộ tin nhắn, cuộc gọi, ghi chú và cập nhật AI theo thứ tự thời gian.
              </p>
            </div>

            {/* Filter Pills */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {filters.map((fKey) => (
                <Link
                  key={fKey}
                  href={timelineHref(1, fKey)}
                  className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
                    parsedQuery.filter === fKey
                      ? 'bg-[var(--accent)] text-white font-medium'
                      : 'bg-[var(--surface-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-subtle)]'
                  }`}
                >
                  {filterLabels[fKey]}
                </Link>
              ))}
            </div>
          </div>

          {timeline.items.length === 0 ? (
            <div className="py-12 text-center text-xs text-[var(--text-tertiary)]">
              Chưa có sự kiện tương tác nào phù hợp với bộ lọc &ldquo;{filterLabels[parsedQuery.filter]}&rdquo;.
            </div>
          ) : (
            <div className="relative pl-6 space-y-4 before:absolute before:left-3 before:top-2 before:bottom-2 before:w-px before:bg-[var(--border-subtle)]">
              {timeline.items.map((e) => (
                <div key={e.id} className="relative group">
                  <div className="absolute -left-6 top-1.5 w-6 h-6 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-secondary)] flex items-center justify-center text-[var(--text-secondary)] text-xs shadow-xs">
                    {e.kind === 'CALL' ? (
                      <Phone className="w-3 h-3 text-emerald-600" />
                    ) : e.kind === 'AI' ? (
                      <Sparkles className="w-3 h-3 text-indigo-600" />
                    ) : e.kind === 'NOTE' ? (
                      <FileText className="w-3 h-3 text-amber-600" />
                    ) : (
                      <MessageSquare className="w-3 h-3 text-blue-600" />
                    )}
                  </div>

                  <div className="bg-[var(--surface-primary)] border border-[var(--border-subtle)] rounded-lg p-3.5 shadow-xs hover:border-[var(--border-strong)] transition-all">
                    <div className="flex items-start justify-between gap-2 mb-1.5 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-[var(--text-primary)]">
                          {e.kind === 'NOTE'
                            ? 'Ghi chú thủ công'
                            : e.kind === 'AI'
                            ? 'Phân tích AI'
                            : e.channel}
                        </span>
                        {e.direction && (
                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[var(--surface-secondary)] text-[var(--text-secondary)]">
                            {e.direction === 'INBOUND' ? 'Khách → Sale' : 'Sale → Khách'}
                          </span>
                        )}
                      </div>
                      <time className="font-mono text-[11px] text-[var(--text-tertiary)]" dateTime={e.at}>
                        {formatDate(e.at)}
                      </time>
                    </div>

                    <p className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">
                      {e.content || 'Chưa có nội dung ghi nhận'}
                    </p>

                    {e.id.startsWith('recording:') && (
                      <Link
                        href={tabHref('calls')}
                        className="mt-2.5 inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline font-medium"
                      >
                        <Phone className="w-3 h-3" />
                        <span>Mở bản ghi âm &amp; transcript cuộc gọi →</span>
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Timeline Pagination */}
          <div className="mt-5 pt-3 border-t border-[var(--border-subtle)] flex items-center justify-between text-xs text-[var(--text-secondary)]">
            <span>Tổng cộng: {timeline.total} sự kiện</span>
            <div className="flex items-center gap-2">
              {parsedQuery.page > 1 && (
                <Link href={timelineHref(parsedQuery.page - 1)}>
                  <Button variant="outline" size="xs">
                    ← Trang trước
                  </Button>
                </Link>
              )}
              {parsedQuery.page * timeline.pageSize < timeline.total && (
                <Link href={timelineHref(parsedQuery.page + 1)}>
                  <Button variant="outline" size="xs">
                    Trang sau →
                  </Button>
                </Link>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* TAB 3: CALLS */}
      {activeTab === 'calls' && (
        <Card className="p-5">
          <CardHeader className="px-0 pt-0">
            <CardTitle>Lịch sử cuộc gọi, Ghi âm &amp; Transcript Zalo</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <ZaloRecordingHistory customerId={id} />
          </CardContent>
        </Card>
      )}

      {/* TAB 4: HISTORY */}
      {activeTab === 'history' && (
        <Card className="p-5">
          <CardHeader className="px-0 pt-0">
            <CardTitle>Lịch sử các phiên bản phân tích AI</CardTitle>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">
              Lưu giữ toàn bộ snapshot lịch sử để đối chiếu diễn biến tâm lý khách hàng theo thời gian.
            </p>
          </CardHeader>
          <CardContent className="px-0 pb-0 space-y-4">
            {history.length === 0 ? (
              <p className="py-8 text-center text-xs text-[var(--text-tertiary)]">
                Chưa có phiên bản phân tích AI nào được lưu trữ.
              </p>
            ) : (
              history.map((h) => (
                <details
                  key={h.id}
                  className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-3 text-xs"
                >
                  <summary className="cursor-pointer font-medium text-[var(--text-primary)] hover:text-[var(--accent)] flex items-center justify-between">
                    <span>
                      Phiên bản {h.version} — {formatDate(h.generated_at)}
                    </span>
                    <span className="text-[11px] text-[var(--text-tertiary)] font-mono">
                      {h.snapshot?.confidence ? `Tin cậy ${Math.round(h.snapshot.confidence * 100)}%` : ''}
                    </span>
                  </summary>
                  <div className="pt-3 mt-2 border-t border-[var(--border-subtle)] bg-[var(--surface-primary)] p-4 rounded-md">
                    <SnapshotPanel snapshot={h.snapshot} />
                  </div>
                </details>
              ))
            )}
          </CardContent>
        </Card>
      )}

      {/* TAB 5: PROFILE */}
      {activeTab === 'profile' && boss && (
        <DossierProfileForm customerId={id} profile={profile} owners={dossier.owners} />
      )}
    </div>
  );
}
