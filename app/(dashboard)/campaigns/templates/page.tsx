import { campaignRead } from "../../../../features/campaigns/service";
import { CampaignNav, CampaignOff } from "../../../../features/campaigns/ui";
import { TemplateLibrary } from "../../../../features/campaigns/templates";
import { PageHeader } from "../../../../components/ui/page-header";
export default async function TemplatesPage() {
  const { data, actor } = await campaignRead();
  return (
    <div className="space-y-5">
      <PageHeader
        title="Thư viện mẫu tin nhắn"
        description="Mẫu do người dùng tạo và duyệt. Phê duyệt provider được xác minh độc lập."
      />
      <CampaignNav />
      {!data?.enabled ? (
        <CampaignOff />
      ) : (
        <TemplateLibrary data={data} boss={actor.role === "BOSS_ADMIN"} />
      )}
    </div>
  );
}
