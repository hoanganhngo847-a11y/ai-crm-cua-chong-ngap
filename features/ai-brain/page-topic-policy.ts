import 'server-only';

/**
 * Page-scoped topic policy for Facebook Page / Messenger turns.
 *
 * The CRM serves multiple Pages with different businesses. A prompt that
 * hardcodes one business (for example flood barriers) leaks that topic into
 * unrelated Pages. Keep the customer-facing topic boundary deterministic:
 * the prompt tells the model the Page scope, and the final guard rejects a
 * draft that still mentions an out-of-scope business.
 */

export const DU_HOC_PAGE_ID = '1026991374010112';
export const CUA_CHONG_NGAP_PAGE_ID = '1343097708890171';

export type PageTopic = 'DU_HOC' | 'CUA_CHONG_NGAP' | 'GENERIC';

export interface PageTopicContext {
  readonly pageId: string | null;
  readonly pageName: string;
  readonly topic: PageTopic;
}

const KNOWN_PAGE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  [DU_HOC_PAGE_ID]: 'Du học Đức và Học tiếng Đức CHD',
  [CUA_CHONG_NGAP_PAGE_ID]: 'Cửa chống ngập',
});

const NUMERIC_PAGE_ID = /^\d{1,100}$/;

export function pageTopicContext(
  pageId: string | null | undefined,
  pageName?: string | null,
): PageTopicContext {
  const normalized = typeof pageId === 'string' && NUMERIC_PAGE_ID.test(pageId.trim())
    ? pageId.trim()
    : null;
  const topic: PageTopic = normalized === DU_HOC_PAGE_ID
    ? 'DU_HOC'
    : normalized === CUA_CHONG_NGAP_PAGE_ID
      ? 'CUA_CHONG_NGAP'
      : 'GENERIC';
  const name = pageName?.trim()
    || (normalized ? KNOWN_PAGE_NAMES[normalized] : undefined)
    || 'Fanpage hiện tại';

  return Object.freeze({ pageId: normalized, pageName: name, topic });
}

/**
 * Terms that belong to the flood-barrier business. They are never allowed in a
 * customer-facing message on the study-abroad Page.
 */
const DU_HOC_OUT_OF_SCOPE =
  /(?:cửa\s*)?chống\s*ngập|flood\s*barrier|ngăn\s*nước|thoát\s*nước|ngập\s*nước|hầm\s*(?:xe|để\s*xe)|gara(?:\s*ô\s*tô)?/iu;

export function hasOutOfScopeTopic(text: string, context: PageTopicContext): boolean {
  if (!text || context.topic !== 'DU_HOC') return false;
  return DU_HOC_OUT_OF_SCOPE.test(text);
}

/**
 * Final deterministic guard. A draft that still mentions the flood-barrier
 * business on the study-abroad Page is rejected whole; callers may substitute
 * a Page-safe fallback or skip the send.
 */
export function sanitizePageScopedReply(draft: string, context: PageTopicContext): string {
  if (!draft || typeof draft !== 'string') return '';
  return hasOutOfScopeTopic(draft, context) ? '' : draft;
}

export function formatPageTopicPolicy(context: PageTopicContext): string {
  if (context.topic === 'DU_HOC') {
    return [
      '[PHẠM VI TƯ VẤN CỦA TRANG]',
      `- Trang hiện tại: ${context.pageName}.`,
      '- CHỈ tư vấn về du học Đức và học tiếng Đức.',
      '- TUYỆT ĐỐI KHÔNG nhắc đến cửa chống ngập, thiết bị chống ngập, ngăn nước, thoát nước, hầm xe, gara ô tô, hoặc bất kỳ sản phẩm/dịch vụ nào khác ngoài du học và học tiếng.',
      '- Nếu khách hỏi ngoài phạm vi, lịch sự cho biết trang chỉ hỗ trợ du học Đức và học tiếng Đức, rồi hướng khách quay lại nội dung phù hợp.',
    ].join('\n');
  }

  if (context.topic === 'CUA_CHONG_NGAP') {
    return [
      '[PHẠM VI TƯ VẤN CỦA TRANG]',
      `- Trang hiện tại: ${context.pageName}.`,
      '- CHỈ tư vấn về sản phẩm/dịch vụ của trang này.',
      '- TUYỆT ĐỐI KHÔNG nhắc đến du học, học tiếng, hoặc bất kỳ sản phẩm/dịch vụ nào khác ngoài phạm vi của trang.',
    ].join('\n');
  }

  return [
    '[PHẠM VI TƯ VẤN CỦA TRANG]',
    `- Trang hiện tại: ${context.pageName}.`,
    '- CHỈ tư vấn đúng sản phẩm/dịch vụ thuộc lĩnh vực của trang này.',
    '- TUYỆT ĐỐI KHÔNG nhắc đến sản phẩm/dịch vụ của trang khác hoặc lĩnh vực không liên quan.',
  ].join('\n');
}
