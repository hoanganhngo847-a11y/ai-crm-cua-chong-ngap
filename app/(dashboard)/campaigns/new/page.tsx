import { z } from "zod";
import { campaignRead } from "../../../../features/campaigns/service";
import { CampaignNav, CampaignOff } from "../../../../features/campaigns/ui";
import { CampaignWizard } from "../../../../features/campaigns/wizard";
import { PageHeader } from "../../../../components/ui/page-header";
export default async function NewCampaign({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams).customers;
  const ids = z
    .array(z.string().uuid())
    .max(500)
    .safeParse(typeof raw === "string" && raw ? raw.split(",") : []);
  if (!ids.success)
    return <p role="alert">Danh sách người nhận không hợp lệ.</p>;
  const { data, actor, readiness } = await campaignRead({
    customer_ids: [...new Set(ids.data)],
  });
  return (
    <div className="space-y-5">
      <PageHeader
        title="Tạo chiến dịch"
        description="Chọn mẫu đã duyệt, kiểm tra eligibility và xác nhận số tin trước khi gửi."
      />
      <CampaignNav />
      {!data?.enabled ? (
        <CampaignOff />
      ) : (
        <CampaignWizard
          data={data}
          readiness={readiness}
          canExecute={actor.role === "BOSS_ADMIN" || data.sale_execute}
        />
      )}
    </div>
  );
}
