import { z } from "zod";
import { campaignRead } from "../../../../features/campaigns/service";
import { CampaignNav } from "../../../../features/campaigns/ui";
import { PersonalZaloCampaignWizard } from "../../../../features/campaigns/personal-wizard";
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
  const personalReady = readiness.ZALO_PERSONAL;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Tạo chiến dịch Zalo cá nhân"
        description="Chọn khách hàng → chọn hoặc tạo mẫu → kiểm tra → gửi lần lượt. Mỗi khách cách nhau 5 phút; sau khi gửi, trang chiến dịch thống kê số đã gửi và số khách phản hồi."
      />
      <CampaignNav />
      {data && (
        <PersonalZaloCampaignWizard
          data={data}
          ready={personalReady}
          canManageTemplates={actor.role === "BOSS_ADMIN"}
          canExecute={
            personalReady &&
            (actor.role === "BOSS_ADMIN" || data.sale_execute)
          }
        />
      )}
    </div>
  );
}
