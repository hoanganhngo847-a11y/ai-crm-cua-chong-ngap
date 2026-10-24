import { campaignRead } from "../../../../features/campaigns/service";
import { CampaignNav } from "../../../../features/campaigns/ui";
import { PersonalZaloTemplateLibrary } from "../../../../features/campaigns/personal-templates";
import { PageHeader } from "../../../../components/ui/page-header";

export default async function TemplatesPage() {
  const { data, actor } = await campaignRead();
  return (
    <div className="space-y-5">
      <PageHeader
        title="Thư viện mẫu Zalo cá nhân"
        description="Tự soạn nội dung dùng lại cho chiến dịch Zalo cá nhân. Mỗi khách trong chiến dịch được gửi lần lượt, cách nhau tối thiểu 5 phút."
      />
      <CampaignNav />
      {data && (
        <PersonalZaloTemplateLibrary
          data={data}
          boss={actor.role === "BOSS_ADMIN"}
        />
      )}
    </div>
  );
}
