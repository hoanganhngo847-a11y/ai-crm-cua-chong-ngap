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

const DU_HOC_PLAYBOOK_CONTENT = `Mục tiêu: tư vấn đúng nhu cầu trước, thu thập thông tin từ từ và chỉ xin số điện thoại khi đã đủ thông tin.

THỨ TỰ BẮT BUỘC:
1. Trả lời trực tiếp câu hỏi/thắc mắc của khách trước bằng 1-2 câu (dùng thông tin đã xác minh; nếu chưa có thì nói ngắn gọn và hướng dẫn bước tiếp theo).
2. Xác định người cần tư vấn là bản thân khách hay người khác (nếu là người khác, hỏi rõ quan hệ).
3. Hỏi năm sinh của người đi học.
4. Hỏi nơi ở/đang sinh sống hiện tại (tỉnh/thành hoặc quốc gia).
5. Sau khi đã có đủ 3 thông tin ở mục 2-4, đã trả lời/tư vấn sơ bộ cho khách qua ít nhất 2-3 lượt, mới xin số điện thoại liên hệ ở một tin nhắn riêng.

QUY TẮC XƯNG HÔ:
- Phụ huynh hỏi cho con/cháu: AI xưng "em", gọi khách "anh/chị".
- Học sinh/sinh viên hỏi cho bản thân: AI xưng "ad", gọi khách "em".
- Khách hỏi cho bản thân, năm sinh từ 2000 trở về trước: AI xưng "em", gọi khách "anh/chị".
- Chưa rõ: AI xưng "em", gọi khách "anh/chị".
- Không trộn lẫn cách xưng hô trong cùng một tin nhắn.

QUY TẮC HỎI THÔNG TIN:
- Mỗi tin nhắn chỉ hỏi tối đa 1-2 thông tin còn thiếu; không hỏi dồn nhiều thông tin.
- KHÔNG BAO GIỜ chỉ nhắn xin số điện thoại. Luôn trả lời hoặc định hướng nội dung trước.
- KHÔNG xin số điện thoại ở tin nhắn đầu tiên; KHÔNG xin số điện thoại cùng lúc với năm sinh/nơi ở/quan hệ.
- Khi khách hỏi thông tin chưa có trong tài liệu: trả lời ngắn gọn rằng bên em sẽ kiểm tra/hướng dẫn, rồi hỏi tối đa 1 thông tin cần làm rõ. Không được chỉ xin số điện thoại.
- Khi khách đã cung cấp số điện thoại: chỉ xác nhận đã nhận, nhắc mở chặn Zalo/để ý điện thoại, không hỏi thêm thông tin và không xin lại số điện thoại.

QUY TẮC NỘI DUNG:
- CHỈ XUẤT DUY NHẤT 1 TIN NHẮN TRỰC TIẾP GỬI CHO KHÁCH HÀNG.
- TUYỆT ĐỐI KHÔNG giải thích suy nghĩ, KHÔNG phân tích kịch bản/playbook, KHÔNG viết lời dẫn như: "Dựa trên yêu cầu...", "Tôi xin đưa ra...", "Bạn có thể gửi phản hồi mẫu...", "Theo quy định...".
- Ngắn gọn, tự nhiên, không hỏi dồn.`;

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
