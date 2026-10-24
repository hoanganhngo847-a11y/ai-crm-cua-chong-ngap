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
        description="Theo dõi chiến dịch được xác nhận và kết quả gửi từng người nhận."
      />
      <CampaignNav />
      {!data?.enabled ? (
        <CampaignOff />
      ) : (
        <>
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
                      {data.senders.find((s) => s.id === c.sender_account_id)
                        ?.name || "—"}
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
                      Chưa có chiến dịch phù hợp.{" "}
                      <Link
                        href="/customers/dossier"
                        className="text-[var(--accent)]"
                      >
                        Chọn khách hàng
                      </Link>
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
            {data.campaigns.length === 50 && (
              <Link href={`/campaigns?page=${page + 1}&status=${status}`}>
                Trang sau
              </Link>
            )}
          </div>
        </>
      )}
    </div>
  );
}
