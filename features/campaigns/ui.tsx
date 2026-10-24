import Link from "next/link";
import { Card } from "../../components/ui/card";
export function CampaignOff() {
  return (
    <Card className="p-8 space-y-3">
      <h2 className="font-semibold">Chiến dịch tin nhắn chưa được bật</h2>
      <p>
        Liên hệ quản trị viên để kiểm tra cấu hình chiến dịch cho công ty này.
      </p>
      <Link className="text-[var(--accent)]" href="/customers/dossier">
        Về Customer 360
      </Link>
    </Card>
  );
}
export function CampaignNav() {
  return (
    <nav className="flex gap-5 text-sm">
      <Link href="/campaigns">Chiến dịch</Link>
      <Link href="/campaigns/templates">Thư viện mẫu</Link>
      <Link href="/customers/dossier">Chọn khách hàng</Link>
    </nav>
  );
}
export function CampaignStatus({ status }: { status: string }) {
  return (
    <span className="rounded border border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-2 py-1 text-xs font-medium">
      {status}
    </span>
  );
}
export function campaignDate(value: string | null) {
  return value
    ? new Date(value).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })
    : "—";
}
