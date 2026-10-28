import 'server-only';

import type { BrainChannel } from '../contracts';
import type { GroundingKnowledgeItem } from './contracts';

/**
 * Page-scoped sales playbooks are injected as verified knowledge because the
 * Javis Brain already renders [VERIFIED COMPANY KNOWLEDGE] into every turn.
 * A playbook is process guidance for the current Page, not a factual claim.
 */
export interface PagePlaybook extends GroundingKnowledgeItem {
  readonly pageId: string;
  readonly channel: BrainChannel;
}

export const DU_HOC_PAGE_ID = '1343097708890171';
export const CUA_CHONG_NGAP_PAGE_ID = '1026991374010112';

const DU_HOC_PLAYBOOK_CONTENT = `Mục tiêu bắt buộc của trang này: thu thập đủ 4 thông tin trước khi tư vấn chuyên sâu:
(1) Số điện thoại liên hệ;
(2) Năm sinh của người đi học;
(3) Người cần tư vấn là bản thân khách hay người khác (nếu là người khác, hỏi rõ quan hệ);
(4) Nơi ở/đang sinh sống hiện tại (tỉnh/thành hoặc quốc gia).

QUY TẮC PHẢN HỒI BẮT BUỘC:
- CHỈ XUẤT DUY NHẤT 1 CÂU TIN NHẮN TRỰC TIẾP GỬI CHO KHÁCH HÀNG.
- TUYỆT ĐỐI KHÔNG giải thích suy nghĩ, KHÔNG phân tích kịch bản/playbook, KHÔNG viết lời dẫn như: "Dựa trên yêu cầu...", "Tôi xin đưa ra...", "Bạn có thể gửi phản hồi mẫu...", "Theo quy định...".
- Cách tư vấn: xưng "em", gọi khách "anh/chị" trong nội dung câu; ngắn gọn, tự nhiên, không hỏi dồn.
- Bất kể khách nhắn gì, AI cũng đều phải phản hồi cho khách. Khi khách hỏi bất kỳ thông tin nào chưa có trong tài liệu, thông tin chưa rõ, hoặc hỏi về chi phí, học phí, biểu phí, điều kiện hoặc báo giá: hãy phản hồi: "Anh/chị cho em xin sđt liên hệ, để nhân viên bên em tư vấn chi tiết hơn cho nhé."
- ĐẶC BIỆT: Khi khách hàng đã cung cấp số điện thoại liên hệ: CHỈ CẦN NHẮN: "Bên em đã nhận thông tin và sớm liên hệ lại. Anh chị nhớ mở chặn người lạ ở zalo và để ý điện thoại giúp em ạ." (Tuyệt đối không hỏi thêm bất cứ thông tin nào khác).`;

const PAGE_PLAYBOOKS: readonly PagePlaybook[] = Object.freeze([
  Object.freeze({
    pageId: DU_HOC_PAGE_ID,
    channel: 'MESSENGER' as const,
    category: 'SALES_PLAYBOOK',
    title: 'Playbook tư vấn du học',
    content: DU_HOC_PLAYBOOK_CONTENT,
  }),
  Object.freeze({
    pageId: CUA_CHONG_NGAP_PAGE_ID,
    channel: 'MESSENGER' as const,
    category: 'SALES_PLAYBOOK',
    title: 'Playbook tư vấn Fanpage Cửa chống ngập',
    content: DU_HOC_PLAYBOOK_CONTENT,
  }),
]);

export function builtInPagePlaybook(
  channel: BrainChannel,
  pageId: string | null | undefined,
): PagePlaybook | null {
  if (channel !== 'MESSENGER' || !pageId) return null;
  return PAGE_PLAYBOOKS.find((item) => item.pageId === pageId) ?? null;
}
