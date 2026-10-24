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
        description="Tự soạn nội dung dùng lại cho chiến dịch. Gửi thật vẫn tuân theo trạng thái provider và eligibility."
      />
      <CampaignNav />
      {!data?.enabled && <CampaignOff />}
      {data && (
        <TemplateLibrary data={data} boss={actor.role === "BOSS_ADMIN"} />
      )}
    </div>
  );
}
