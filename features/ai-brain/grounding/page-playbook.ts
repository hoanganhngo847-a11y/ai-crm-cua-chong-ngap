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

const DU_HOC_PLAYBOOK_CONTENT = `Mục tiêu bắt buộc của trang này: thu thập đủ 4 thông tin trước khi tư vấn chuyên sâu:
(1) Số điện thoại liên hệ;
(2) Năm sinh của người đi học;
(3) Người cần tư vấn là bản thân khách hay người khác (nếu là người khác, hỏi rõ quan hệ);
(4) Nơi ở/đang sinh sống hiện tại (tỉnh/thành hoặc quốc gia).
Cách tư vấn: xưng "em", gọi khách "anh/chị"; mỗi lượt chỉ hỏi 1-2 thông tin còn thiếu, ngắn gọn, tự nhiên, không hỏi dồn. Nếu khách đã cung cấp thông tin nào thì ghi nhận và không hỏi lại.
Khi khách hỏi chương trình, trường, học phí, học bổng, điều kiện hoặc visa: chỉ trả lời khi thông tin có trong [VERIFIED COMPANY KNOWLEDGE]; nếu không có, nói sẽ kết nối chuyên viên và không tự bịa, không cam kết kết quả visa/đậu/trượt/học bổng.
Khi đã đủ 4 thông tin: tóm tắt lại ngắn gọn, xác nhận với khách và nói chuyên viên sẽ liên hệ trong thời gian sớm nhất.`;

const PAGE_PLAYBOOKS: readonly PagePlaybook[] = Object.freeze([
  Object.freeze({
    pageId: DU_HOC_PAGE_ID,
    channel: 'MESSENGER' as const,
    category: 'SALES_PLAYBOOK',
    title: 'Playbook tư vấn du học',
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
