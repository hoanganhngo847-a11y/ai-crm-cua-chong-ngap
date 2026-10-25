"use server";
import { revalidatePath } from "next/cache";
import { campaignCommand } from "../../features/campaigns/service";
import {
  linkPersonalZaloContactToCustomer,
  listPersonalZaloContactCandidates,
  syncPersonalZaloContactCandidates,
  type PersonalZaloContactCandidate,
} from "../../features/campaigns/zalo-contact-linking";

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

export async function listPersonalZaloContactsAction(): Promise<{
  ok: boolean;
  candidates: PersonalZaloContactCandidate[];
  message?: string;
}> {
  try {
    const candidates = await listPersonalZaloContactCandidates();
    return { ok: true, candidates };
  } catch (error) {
    console.error("[listPersonalZaloContactsAction] error:", error);
    return {
      ok: false,
      candidates: [],
      message: "Không tải được danh sách liên hệ Zalo chưa liên kết.",
    };
  }
}

export async function syncPersonalZaloContactsAction(): Promise<{
  ok: boolean;
  candidates: PersonalZaloContactCandidate[];
  seen: number;
  autoLinked: number;
  message: string;
}> {
  try {
    const result = await syncPersonalZaloContactCandidates();
    revalidatePath("/campaigns", "layout");
    return {
      ok: true,
      candidates: result.candidates,
      seen: result.seen,
      autoLinked: result.autoLinked,
      message: `Đã đồng bộ ${result.seen} liên hệ Zalo.`,
    };
  } catch (error) {
    console.error("[syncPersonalZaloContactsAction] error:", error);
    return {
      ok: false,
      candidates: [],
      seen: 0,
      autoLinked: 0,
      message: "Không đồng bộ được danh bạ Zalo cá nhân. Kiểm tra kết nối ZCAJS rồi thử lại.",
    };
  }
}

export async function linkPersonalZaloContactAction(input: {
  candidateId: string;
  customerId: string;
}): Promise<{ ok: boolean; message: string }> {
  try {
    await linkPersonalZaloContactToCustomer(input);
    revalidatePath("/campaigns", "layout");
    revalidatePath("/customers/dossier");
    return { ok: true, message: "Đã liên kết đúng tài khoản Zalo với khách hàng." };
  } catch (error) {
    console.error("[linkPersonalZaloContactAction] error:", error);
    const code = error instanceof Error ? error.message : "";
    return {
      ok: false,
      message:
        code === "ZALO_CONTACT_ALREADY_LINKED_ELSEWHERE"
          ? "Tài khoản Zalo này đã thuộc một khách hàng khác. Hệ thống không tự ghi đè để tránh gửi nhầm người."
          : "Không liên kết được tài khoản Zalo với khách hàng.",
    };
  }
}
