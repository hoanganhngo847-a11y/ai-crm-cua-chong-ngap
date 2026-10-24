import { Card } from "../../components/ui/card";
import type { CampaignData } from "./contracts";

type CampaignWithReplyCount = NonNullable<CampaignData["campaign"]> & {
  replied_count?: number | null;
};

export function CampaignPerformance({ data }: { data: CampaignData }) {
  if (!data.campaign) return null;
  const campaign = data.campaign as CampaignWithReplyCount;
  const replied = campaign.replied_count;
  const responseRate =
    replied !== null && replied !== undefined && campaign.sent_count > 0
      ? `${((replied / campaign.sent_count) * 100).toFixed(1)}%`
      : "—";

  return (
    <Card className="space-y-4 p-5">
      <div>
        <h2 className="font-semibold">Hiệu quả mẫu tin nhắn</h2>
        <p className="text-sm text-[var(--text-secondary)]">
          {campaign.template_snapshot.name}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-[var(--border-subtle)] p-4">
          <p className="text-xs text-[var(--text-secondary)]">Đã gửi đến</p>
          <strong className="text-2xl">{campaign.sent_count}</strong>
          <span className="ml-1 text-sm">người</span>
        </div>
        <div className="rounded-lg border border-[var(--border-subtle)] p-4">
          <p className="text-xs text-[var(--text-secondary)]">Đã phản hồi</p>
          <strong className="text-2xl">
            {replied === null || replied === undefined ? "—" : replied}
          </strong>
          {replied !== null && replied !== undefined && (
            <span className="ml-1 text-sm">người</span>
          )}
        </div>
        <div className="rounded-lg border border-[var(--border-subtle)] p-4">
          <p className="text-xs text-[var(--text-secondary)]">Tỷ lệ phản hồi</p>
          <strong className="text-2xl">{responseRate}</strong>
        </div>
      </div>
      <p className="text-xs text-[var(--text-secondary)]">
        “Đã phản hồi” là số khách đã nhận tin của chiến dịch và sau đó có tin
        nhắn inbound trên cùng kênh. Chỉ tính mỗi khách một lần.
      </p>
    </Card>
  );
}
