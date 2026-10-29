import Link from 'next/link';
import { BulkSelection, BulkHeader, BulkCell } from '../../../../features/campaigns/bulk-selection';
import { createAdminClient } from '../../../../lib/supabase/admin';
import { recordingActor } from '../../../../features/zalo-recordings/access';
import { dossierOwners, listCustomersForActor, listFilters } from '../../../../features/customer-360/service';
import {
  CANONICAL_STAGE_LIST,
  CUSTOMER_STAGE_LABELS,
} from '../../../../features/crm/types/customer.types';
import { PageHeader } from '../../../../components/ui/page-header';
import { Button } from '../../../../components/ui/button';
import { StatusBadge } from '../../../../components/ui/status-badge';
import { Avatar } from '../../../../components/ui/avatar';
import { Card } from '../../../../components/ui/card';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TablePagination,
} from '../../../../components/ui/data-table';
import { EmptyState } from '../../../../components/ui/empty-state';
import {
  PhoneRevealProvider,
  SecurePhoneRow,
} from '../../../../features/crm/components/secure-phone-reveal';
import { Customer360EditableCell } from '../../../../features/customer-360/editable-cell';
import { Customer360OutreachCell } from '../../../../features/customer-360/outreach-cell';
import {
  Search,
  X,
  ExternalLink,
  ChevronRight,
  AlertTriangle,
  Flame,
  Clock,
} from 'lucide-react';

export const metadata = {
  title: 'Customer 360 | AI CRM Cửa Chống Ngập',
  description: 'Hồ sơ khách hàng 360 độ, danh tính đa kênh và AI dossier',
};

function formatDate(value: string | null) {
  if (!value) return '—';
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

export default async function CustomerDossierList({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const parsed = listFilters.safeParse(
    Object.fromEntries(
      Object.entries(raw).filter(([, v]) => v !== undefined && v !== '')
    )
  );

  if (!parsed.success) {
    return (
      <div className="p-8">
        <EmptyState
          type="error"
          title="Bộ lọc không hợp lệ"
          description="Tham số bộ lọc tìm kiếm trong URL không đúng định dạng."
          action={{
            label: 'Xóa bộ lọc & Tải lại',
            href: '/customers/dossier',
          }}
        />
      </div>
    );
  }

  const f = parsed.data;
  const actor = await recordingActor();
  const db = createAdminClient();
  const [data, owners] = await Promise.all([
    listCustomersForActor(db, actor, f),
    dossierOwners(db, actor.companyId),
  ]);

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));

  function pageHref(page: number) {
    const query = new URLSearchParams(
      Object.entries(f).map(([k, v]) => [k, String(v)])
    );
    query.set('page', String(page));
    return `/customers/dossier?${query}`;
  }

  // Active filters helper
  const hasActiveFilters = Boolean(
    f.search ||
      f.owner ||
      f.channel ||
      f.stage ||
      f.recent ||
      f.hot ||
      f.overdue ||
      (f.sort && f.sort !== 'updated')
  );

  const removeFilterHref = (keyToRemove: string) => {
    const query = new URLSearchParams(
      Object.entries(f)
        .filter(([k]) => k !== keyToRemove)
        .map(([k, v]) => [k, String(v)])
    );
    query.set('page', '1');
    return `/customers/dossier?${query}`;
  };

  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        title="Hồ Sơ Khách Hàng 360 (Customer 360)"
        description="Quản lý danh tính đa kênh, hành trình mua hàng, lịch sử ghi âm và AI Snapshot khách hàng."
        breadcrumbs={[
          { label: 'CRM', href: '/crm' },
          { label: 'Customer 360', isCurrent: true },
        ]}
        secondaryActions={
          <Link href="/customers">
            <Button variant="outline" size="sm" rightIcon={<ExternalLink className="w-3 h-3" />}>
              Quản lý chi tiết
            </Button>
          </Link>
        }
      />

      {/* Attio-Style Filter Toolbar */}
      <Card className="overflow-visible">
        <form
          method="GET"
          action="/customers/dossier"
          className="p-3.5 flex flex-col gap-3"
        >
          <div className="flex flex-wrap items-center gap-2.5">
            {/* Search Input */}
            <div className="relative flex-1 min-w-[240px] max-w-md">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-[var(--text-tertiary)] pointer-events-none" />
              <input
                type="text"
                name="search"
                defaultValue={f.search}
                placeholder="Tìm theo tên, SĐT, email, Zalo, Facebook, mã KH..."
                className="w-full h-8 pl-8 pr-3 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] rounded-md transition-colors placeholder:text-[var(--text-disabled)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)] focus:border-[var(--accent)]"
              />
            </div>

            {/* Owner Filter */}
            <select
              name="owner"
              defaultValue={f.owner || ''}
              className="h-8 px-2.5 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] rounded-md transition-colors focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            >
              <option value="">Tất cả Sale phụ trách</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>

            {/* Channel Filter */}
            <select
              name="channel"
              defaultValue={f.channel || ''}
              className="h-8 px-2.5 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] rounded-md transition-colors focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            >
              <option value="">Tất cả kênh</option>
              {['ZALO', 'FACEBOOK', 'PHONE', 'EMAIL'].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>

            {/* Stage Filter */}
            <select
              name="stage"
              defaultValue={f.stage || ''}
              className="h-8 px-2.5 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] rounded-md transition-colors focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            >
              <option value="">Tất cả giai đoạn</option>
              {CANONICAL_STAGE_LIST.map((stg) => (
                <option key={stg.value} value={stg.value}>
                  {stg.label}
                </option>
              ))}
            </select>

            {/* Sort Dropdown */}
            <select
              name="sort"
              defaultValue={f.sort}
              className="h-8 px-2.5 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] rounded-md transition-colors focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            >
              <option value="updated">Mới cập nhật</option>
              <option value="name">Tên A–Z</option>
              <option value="contact">Liên hệ gần nhất</option>
              <option value="score">Điểm tiềm năng</option>
              <option value="followup">Hạn liên hệ lại</option>
            </select>

            <Button type="submit" variant="primary" size="xs">
              Áp dụng
            </Button>

            {hasActiveFilters && (
              <Link href="/customers/dossier">
                <Button variant="ghost" size="xs" leftIcon={<X className="w-3 h-3" />}>
                  Xóa lọc
                </Button>
              </Link>
            )}
          </div>

          {/* Quick Filter Checkbox Toggles */}
          <div className="flex items-center gap-4 pt-1 border-t border-[var(--border-subtle)] text-xs text-[var(--text-secondary)]">
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                name="recent"
                value="1"
                defaultChecked={!!f.recent}
                className="rounded border-[var(--border-strong)] text-[var(--accent)] focus:ring-[var(--accent)]"
              />
              <span>Hoạt động 7 ngày qua</span>
            </label>

            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                name="hot"
                value="1"
                defaultChecked={!!f.hot}
                className="rounded border-[var(--border-strong)] text-[var(--accent)] focus:ring-[var(--accent)]"
              />
              <span className="flex items-center gap-1">
                <Flame className="w-3.5 h-3.5 text-rose-500" />
                Hot Leads (Điểm ≥ 70)
              </span>
            </label>

            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                name="overdue"
                value="1"
                defaultChecked={!!f.overdue}
                className="rounded border-[var(--border-strong)] text-[var(--accent)] focus:ring-[var(--accent)]"
              />
              <span className="flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-amber-500" />
                Quá hạn liên hệ
              </span>
            </label>
          </div>
        </form>

        {/* Active Filter Chips */}
        {hasActiveFilters && (
          <div className="px-3.5 pb-3 flex items-center gap-1.5 flex-wrap text-xs">
            <span className="text-[11px] text-[var(--text-tertiary)] mr-1">Bộ lọc đang bật:</span>
            {f.search && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--surface-secondary)] border border-[var(--border-subtle)] text-[11px] text-[var(--text-primary)]">
                Tìm: &ldquo;{f.search}&rdquo;
                <Link href={removeFilterHref('search')} className="hover:text-[var(--danger)]">
                  <X className="w-3 h-3" />
                </Link>
              </span>
            )}
            {f.channel && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--surface-secondary)] border border-[var(--border-subtle)] text-[11px] text-[var(--text-primary)]">
                Kênh: {f.channel}
                <Link href={removeFilterHref('channel')} className="hover:text-[var(--danger)]">
                  <X className="w-3 h-3" />
                </Link>
              </span>
            )}
            {f.stage && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--surface-secondary)] border border-[var(--border-subtle)] text-[11px] text-[var(--text-primary)]">
                Giai đoạn: {CUSTOMER_STAGE_LABELS[f.stage] || f.stage}
                <Link href={removeFilterHref('stage')} className="hover:text-[var(--danger)]">
                  <X className="w-3 h-3" />
                </Link>
              </span>
            )}
            {f.hot && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-50 border border-rose-200 text-[11px] text-rose-700">
                Hot Leads
                <Link href={removeFilterHref('hot')} className="hover:text-[var(--danger)]">
                  <X className="w-3 h-3" />
                </Link>
              </span>
            )}
            {f.overdue && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-[11px] text-amber-700">
                Quá hạn liên hệ
                <Link href={removeFilterHref('overdue')} className="hover:text-[var(--danger)]">
                  <X className="w-3 h-3" />
                </Link>
              </span>
            )}
            <Link
              href="/customers/dossier"
              className="text-[11px] text-[var(--accent)] hover:underline ml-1"
            >
              Xóa tất cả
            </Link>
          </div>
        )}
      </Card>

      {/* Data Table */}
      <PhoneRevealProvider>
      <BulkSelection key={data.items.map(c => c.id).join(',')} ids={data.items.map(c => c.id)} enabled={process.env.BULK_MESSAGING_ENABLED === 'true'}>
      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <BulkHeader />
              <TableHead className="min-w-[200px]">Khách hàng</TableHead>
              <TableHead className="min-w-[110px]">Giai đoạn</TableHead>
              <TableHead className="min-w-[130px]">Liên hệ</TableHead>
              <TableHead
                className="min-w-[150px]"
                title="Tên khách trên Facebook và trạng thái đã tiếp cận. Bấm vào trạng thái để đánh dấu thủ công."
              >
                Đã tiếp cận qua Facebook
              </TableHead>
              <TableHead
                className="min-w-[150px]"
                title="Tên khách trên Zalo và trạng thái đã tiếp cận. Bấm vào trạng thái để đánh dấu thủ công."
              >
                Đã tiếp cận qua Zalo
              </TableHead>
              <TableHead className="min-w-[140px]">Phân công cho Sale</TableHead>
              <TableHead className="min-w-[170px]">Ghi chú của Sale</TableHead>
              <TableHead className="min-w-[170px]">Ghi chú của Marketing</TableHead>
              <TableHead className="min-w-[190px]">Ghi chú của AI</TableHead>
              <TableHead className="min-w-[110px]">Liên hệ gần nhất</TableHead>
              <TableHead className="min-w-[110px]">Hạn gọi lại</TableHead>
              <TableHead className="w-[80px] text-right">Thao tác</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {data.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={process.env.BULK_MESSAGING_ENABLED === 'true' ? 13 : 12} className="p-0">
                  <EmptyState
                    type={hasActiveFilters ? 'no-results' : 'empty'}
                    title={
                      hasActiveFilters
                        ? 'Không tìm thấy khách hàng nào'
                        : 'Chưa có hồ sơ khách hàng'
                    }
                    description={
                      hasActiveFilters
                        ? 'Không có khách hàng nào phù hợp với bộ lọc tìm kiếm hiện tại.'
                        : 'Chưa có khách hàng nào được tạo trong tổ chức của bạn.'
                    }
                    action={
                      hasActiveFilters
                        ? {
                            label: 'Xóa bộ lọc',
                            href: '/customers/dossier',
                          }
                        : undefined
                    }
                  />
                </TableCell>
              </TableRow>
            ) : (
              data.items.map((c) => {
                const isOverdue =
                  c.follow_up_at &&
                  new Date(c.follow_up_at).getTime() < nowMs;

                return (
                  <TableRow key={c.id}>
                    <BulkCell id={c.id} name={c.name} />
                    {/* Customer Primary Cell */}
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <Avatar name={c.name} size="sm" />
                        <div className="min-w-0">
                          <Link
                            href={`/customers/${c.id}/dossier`}
                            className="font-medium text-[var(--text-primary)] hover:text-[var(--accent)] transition-colors truncate block"
                          >
                            {c.name}
                          </Link>
                          <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-[var(--text-tertiary)] font-mono">
                            <span>{c.customer_code}</span>
                            {c.zalo_name && (
                              <span className="px-1 py-0.2 rounded bg-cyan-50 text-cyan-700 border border-cyan-200 text-[10px]">
                                Zalo
                              </span>
                            )}
                            {c.facebook_name && (
                              <span className="px-1 py-0.2 rounded bg-blue-50 text-blue-700 border border-blue-200 text-[10px]">
                                FB
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </TableCell>

                    {/* Stage */}
                    <TableCell>
                      <StatusBadge status={c.stage} size="xs" />
                    </TableCell>

                    {/* Contact Phone / Email */}
                    <TableCell>
                      <div className="flex flex-col text-[11px] gap-1">
                        <SecurePhoneRow customerId={c.id} maskedPhone={c.phone} />
                        {c.email && (
                          <span className="text-[var(--text-tertiary)] truncate max-w-[130px]">
                            {c.email}
                          </span>
                        )}
                      </div>
                    </TableCell>

                    {/* Facebook / Zalo outreach */}
                    <TableCell>
                      <Customer360OutreachCell
                        customerId={c.id}
                        channel="FACEBOOK"
                        name={c.facebook_name}
                        at={c.facebook_outreach_at}
                        source={c.facebook_outreach_source}
                      />
                    </TableCell>

                    <TableCell>
                      <Customer360OutreachCell
                        customerId={c.id}
                        channel="ZALO"
                        name={c.zalo_name}
                        at={c.zalo_outreach_at}
                        source={c.zalo_outreach_source}
                      />
                    </TableCell>

                    {/* Phân công cho Sale (Editable) */}
                    <TableCell>
                      <Customer360EditableCell
                        customerId={c.id}
                        field="assigned_sale_name"
                        value={c.assigned_sale_name || c.assigned_sale || ''}
                        placeholder="Nhập tên sale..."
                        ownerSuggestions={owners.map((o) => o.name)}
                      />
                    </TableCell>

                    {/* Ghi chú của Sale (Editable) */}
                    <TableCell>
                      <Customer360EditableCell
                        customerId={c.id}
                        field="sale_notes"
                        value={c.sale_notes || ''}
                        placeholder="Nhập ghi chú sale..."
                      />
                    </TableCell>

                    {/* Ghi chú của Marketing (Editable) */}
                    <TableCell>
                      <Customer360EditableCell
                        customerId={c.id}
                        field="marketing_notes"
                        value={c.marketing_notes || ''}
                        placeholder="Nhập ghi chú mkt..."
                      />
                    </TableCell>

                    {/* Ghi chú của AI (Editable) */}
                    <TableCell>
                      <Customer360EditableCell
                        customerId={c.id}
                        field="ai_notes"
                        value={c.ai_notes || c.current_situation || ''}
                        placeholder="Nhập ghi chú AI..."
                      />
                    </TableCell>

                    {/* Last Interaction */}
                    <TableCell>
                      <span className="text-xs text-[var(--text-secondary)] font-mono">
                        {formatDate(c.last_interaction)}
                      </span>
                    </TableCell>

                    {/* Follow-up At */}
                    <TableCell>
                      {c.follow_up_at ? (
                        <div className="flex items-center gap-1.5">
                          {isOverdue && (
                            <span title="Quá hạn liên hệ">
                              <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                            </span>
                          )}
                          <span
                            className={`text-xs font-mono ${
                              isOverdue
                                ? 'text-amber-700 font-medium'
                                : 'text-[var(--text-secondary)]'
                            }`}
                          >
                            {formatDate(c.follow_up_at)}
                          </span>
                        </div>
                      ) : (
                        <span className="text-[var(--text-tertiary)]">—</span>
                      )}
                    </TableCell>

                    {/* Actions */}
                    <TableCell className="text-right">
                      <Link href={`/customers/${c.id}/dossier`}>
                        <Button variant="ghost" size="xs" rightIcon={<ChevronRight className="w-3 h-3" />}>
                          Hồ sơ
                        </Button>
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>

        {/* Pagination */}
        <TablePagination
          currentPage={data.page}
          totalPages={totalPages}
          totalItems={data.total}
          pageSize={data.pageSize}
          getPageHref={pageHref}
          className="border-t"
        />
      </Card>
      </BulkSelection>
      </PhoneRevealProvider>
    </div>
  );
}
