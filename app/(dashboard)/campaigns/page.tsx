import Link from "next/link";
import { campaignRead } from "../../../features/campaigns/service";
import {
  CampaignNav,
  CampaignOff,
  CampaignStatus,
  campaignDate,
} from "../../../features/campaigns/ui";
import { PageHeader } from "../../../components/ui/page-header";
import { Card } from "../../../components/ui/card";
import { Button } from "../../../components/ui/button";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "../../../components/ui/data-table";
export default async function CampaignList({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const page = Math.max(1, Math.min(10000, Number(query.page) || 1));
  const status =
    typeof query.status === "string" &&
    ["ALL", "RUNNING", "SCHEDULED", "COMPLETED", "FAILED"].includes(
      query.status,
    )
      ? query.status
      : "ALL";
  const { data } = await campaignRead({ page, status });
  const rows = data?.campaigns ?? [];
  return (
    <div className="space-y-5">
      <PageHeader
        title="Chiến dịch tin nhắn"
        description="Chọn khách hàng, tự soạn mẫu, lưu bản nháp và theo dõi kết quả chiến dịch."
        primaryAction={
          <Link href="/campaigns/new">
            <Button>Tạo chiến dịch</Button>
          </Link>
        }
      />
      <CampaignNav />
      {!data?.enabled && <CampaignOff />}
      <div className="grid gap-3 md:grid-cols-3">
        <Link href="/customers/dossier">
          <Card className="h-full space-y-1 p-4 hover:border-[var(--accent)]">
            <strong>1. Chọn khách hàng</strong>
            <p className="text-sm text-[var(--text-secondary)]">
              Tick từng khách hoặc chọn cả trang trong Customer 360.
            </p>
          </Card>
        </Link>
        <Link href="/campaigns/templates">
          <Card className="h-full space-y-1 p-4 hover:border-[var(--accent)]">
            <strong>2. Tạo mẫu tin nhắn</strong>
            <p className="text-sm text-[var(--text-secondary)]">
              Tự viết nội dung và chèn biến tên khách, mã khách, Sale phụ trách.
            </p>
          </Card>
        </Link>
        <Link href="/campaigns/new">
          <Card className="h-full space-y-1 p-4 hover:border-[var(--accent)]">
            <strong>3. Tạo bản nháp chiến dịch</strong>
            <p className="text-sm text-[var(--text-secondary)]">
              Chọn kênh, tài khoản, mẫu và kiểm tra eligibility trước khi gửi.
            </p>
          </Card>
        </Link>
      </div>
      <div className="flex flex-wrap gap-3">
        {[
          ["ALL", "Tất cả"],
          ["RUNNING", "Đang chạy"],
          ["SCHEDULED", "Đặt lịch"],
          ["COMPLETED", "Hoàn tất"],
          ["FAILED", "Lỗi"],
        ].map(([v, l]) => (
          <Link
            key={v}
            aria-current={status === v ? "page" : undefined}
            href={`/campaigns?status=${v}&page=1`}
            className="rounded border border-[var(--border-subtle)] px-3 py-2 text-xs"
          >
            {l}
          </Link>
        ))}
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              {[
                "Tên chiến dịch",
                "Kênh",
                "Tài khoản gửi",
                "Mẫu",
                "Người nhận",
                "Đã gửi",
                "Delivered",
                "Failed",
                "Trạng thái",
                "Tạo bởi",
                "Thời gian",
              ].map((t) => (
                <TableHead key={t}>{t}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  <Link
                    href={`/campaigns/${c.id}`}
                    className="text-[var(--accent)]"
                  >
                    {c.name}
                  </Link>
                </TableCell>
                <TableCell>{c.channel}</TableCell>
                <TableCell>
                  {data?.senders.find((s) => s.id === c.sender_account_id)?.name ||
                    "—"}
                </TableCell>
                <TableCell>{c.template_snapshot.name}</TableCell>
                <TableCell>{c.selected_count}</TableCell>
                <TableCell>{c.sent_count}</TableCell>
                <TableCell>{c.delivered_count}</TableCell>
                <TableCell>{c.failed_count}</TableCell>
                <TableCell>
                  <CampaignStatus status={c.status} />
                </TableCell>
                <TableCell>{c.created_by_name || "—"}</TableCell>
                <TableCell>{campaignDate(c.created_at)}</TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={11}>
                  Chưa có chiến dịch. Bắt đầu bằng cách{" "}
                  <Link href="/customers/dossier" className="text-[var(--accent)]">
                    chọn khách hàng
                  </Link>{" "}
                  hoặc{" "}
                  <Link href="/campaigns/templates" className="text-[var(--accent)]">
                    tạo mẫu tin nhắn
                  </Link>
                  .
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
      <div className="flex gap-4 text-sm">
        {page > 1 && (
          <Link href={`/campaigns?page=${page - 1}&status=${status}`}>
            Trang trước
          </Link>
        )}
        <span>Trang {page}</span>
        {rows.length === 50 && (
          <Link href={`/campaigns?page=${page + 1}&status=${status}`}>
            Trang sau
          </Link>
        )}
      </div>
    </div>
  );
}
