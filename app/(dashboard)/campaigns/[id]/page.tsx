import { campaignRead } from "../../../../features/campaigns/service";
import { CampaignNav, CampaignOff } from "../../../../features/campaigns/ui";
import { CampaignDetail } from "../../../../features/campaigns/detail";
import { CampaignPerformance } from "../../../../features/campaigns/performance";
import { PageHeader } from "../../../../components/ui/page-header";

export default async function CampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { data, actor, readiness } = await campaignRead({ id });
  const campaign = data?.campaign;

  return (
    <div className="space-y-5">
      <PageHeader
        title={campaign?.name || "Chiến dịch"}
        description="Theo dõi mẫu đã gửi, số người nhận, phản hồi, eligibility và trạng thái từng khách hàng."
      />
      <CampaignNav />
      {!campaign ? (
        <CampaignOff />
      ) : (
        <>
          {!data.enabled && <CampaignOff />}
          <CampaignPerformance data={data} />
          <CampaignDetail
            data={data}
            boss={actor.role === "BOSS_ADMIN"}
            canExecute={
              Boolean(data.enabled) &&
              (actor.role === "BOSS_ADMIN" || data.sale_execute)
            }
            readiness={readiness}
          />
        </>
      )}
    </div>
  );
}
