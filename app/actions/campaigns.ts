"use server";
import { revalidatePath } from "next/cache";
import { campaignCommand } from "../../features/campaigns/service";
export async function runCampaignCommand(
  command: string,
  input: unknown,
): Promise<{ ok: boolean; id?: string; message: string }> {
  try {
    const result = await campaignCommand(command, input);
    revalidatePath("/campaigns", "layout");
    revalidatePath("/customers/dossier");
    return { ok: true, id: result?.id, message: "Đã lưu thay đổi." };
  } catch {
    return {
      ok: false,
      message:
        "Thao tác bị từ chối. Kiểm tra quyền, trạng thái mẫu, eligibility và cấu hình kênh; tải lại trước khi thử lại.",
    };
  }
}
export async function loadCampaignPreview(id: string) {
  try {
    const { campaignRead } = await import("../../features/campaigns/service");
    const { data } = await campaignRead({ id });
    return { ok: true as const, data };
  } catch {
    return { ok: false as const, data: null };
  }
}
