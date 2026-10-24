import { campaignRead } from "../../../../features/campaigns/service";
import { CampaignNav, CampaignOff } from "../../../../features/campaigns/ui";
import { CampaignDetail } from "../../../../features/campaigns/detail";
import { PageHeader } from "../../../../components/ui/page-header";
export default async function CampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { data, actor, readiness } = await campaignRead({ id });
  return (
    <div className="space-y-5">
      <PageHeader
        title={data?.campaign?.name || "Chiến dịch"}
        description="Kết quả từng người nhận, eligibility, bản mẫu đã đóng băng và nhật ký thao tác."
      />
      <CampaignNav />
      {!data?.enabled || !data.campaign ? (
        <CampaignOff />
      ) : (
        <CampaignDetail
          data={data}
          boss={actor.role === "BOSS_ADMIN"}
          canExecute={actor.role === "BOSS_ADMIN" || data.sale_execute}
          readiness={readiness}
        />
      )}
    </div>
  );
}
