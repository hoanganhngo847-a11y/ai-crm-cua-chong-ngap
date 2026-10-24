import Link from "next/link";
import { Card } from "../../components/ui/card";
export function CampaignOff() {
  return (
    <Card className="space-y-2 border-amber-200 bg-amber-50 p-4 text-amber-950">
      <h2 className="font-semibold">Đang ở chế độ soạn thảo an toàn</h2>
      <p className="text-sm">
        Bạn vẫn có thể chọn khách hàng, tự tạo mẫu tin, lưu bản nháp và kiểm tra
        eligibility. Gửi thật / đặt lịch vẫn đang khóa cho tới khi kênh provider
        được quản trị viên bật và xác minh.
      </p>
      <div className="flex flex-wrap gap-4 text-sm font-medium">
        <Link className="text-[var(--accent)]" href="/customers/dossier">
          Chọn khách hàng
        </Link>
        <Link className="text-[var(--accent)]" href="/campaigns/templates">
          Tạo mẫu tin nhắn
        </Link>
        <Link className="text-[var(--accent)]" href="/campaigns/new">
          Tạo chiến dịch
        </Link>
      </div>
    </Card>
  );
}
export function CampaignNav() {
  return (
    <nav className="flex flex-wrap gap-5 text-sm">
      <Link href="/campaigns">Chiến dịch</Link>
      <Link href="/campaigns/new">Tạo chiến dịch</Link>
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
