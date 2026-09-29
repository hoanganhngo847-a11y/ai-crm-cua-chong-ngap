import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import type {
  ActiveSalesStyleProfile,
  ClosingStyle,
  ObjectionStyle,
  QuestionStyle,
  SalutationRules,
  SentenceStyle,
} from '@/shared/contracts/sales-style';
import { fetchActiveSalesStyleProfile } from './sales-style-store';
import { validateSalesStyleOutput } from './validate-sales-style';

export interface RuntimeSalesStyleContextResult {
  styleContextPrompt: string;
  activeProfileId: string | null;
  isNeutralDefault: boolean;
  appliedStyle: ActiveSalesStyleProfile | null;
}

export interface BuildRuntimeSalesStyleContextParams {
  companyId: string;
  saleUserId?: string | null;
  client?: SupabaseClient;
}

export const BUSINESS_POLICY_FIREWALL_WARNING = `
[CRITICAL BUSINESS POLICY FIREWALL]
1. Absolute Price & Commercial Prohibition:
   - You MUST NOT invent, guess, quote, or commit to specific prices, discounts, or promotional fees.
   - You MUST NOT request or confirm customer deposits, wire transfers, or bank accounts.
   - You MUST NOT commit to binding delivery schedules, warranty terms, or contract signatures.
2. Technical Boundary:
   - Specific dimensions and pricing must be deferred to verified on-site measurement and official company quotation.
3. Tone:
   - Maintain professional, helpful, and courteous communication aligned with the specified style profile.
`.trim();

export const NEUTRAL_DEFAULT_STYLE_INSTRUCTIONS = `
[SALES COMMUNICATION STYLE: SAFE NEUTRAL DEFAULT]
- Tone: Lịch sự, chuyên nghiệp, nhã nhặn, tôn trọng khách hàng.
- Xưng hô: "Em" xưng với "Anh/Chị" (hoặc theo danh xưng khách hàng nếu đã rõ).
- Câu từ: Ngắn gọn, súc tích, rõ ý, ngữ pháp tiếng Việt chuẩn mực. Không dùng teencode hay biểu cảm quá mức.
- Câu hỏi: Hỏi thăm nhu cầu về kích thước cửa và tình trạng ngập nước một cách tự nhiên.
- Xử lý thắc mắc: Giải thích rõ ràng giải pháp cửa chống ngập, đề xuất hỗ trợ tư vấn kỹ thuật.
- Lời kết: Cảm ơn khách hàng và nhã nhặn hẹn hỗ trợ tư vấn chi tiết hơn.
`.trim();

function formatActiveStyleSections(style: {
  salutationRules: SalutationRules;
  sentenceStyle: SentenceStyle;
  questionStyle: QuestionStyle;
  objectionStyle: ObjectionStyle;
  closingStyle: ClosingStyle;
}): string {
  const parts: string[] = [];

  // Salutation
  parts.push('=== QUY TẮC XƯNG HÔ (SALUTATION) ===');
  const selfRefs = style.salutationRules.selfReferences || [];
  const custRefs = style.salutationRules.customerReferences || [];
  const openings = style.salutationRules.commonOpenings || [];
  if (selfRefs.length > 0) {
    parts.push(`- Xưng hô bản thân: ${selfRefs.join(', ')}`);
  }
  if (custRefs.length > 0) {
    parts.push(`- Danh xưng với khách: ${custRefs.join(', ')}`);
  }
  if (openings.length > 0) {
    parts.push(`- Câu chào hỏi mẫu: ${openings.join('; ')}`);
  }
  if (style.salutationRules.notes && style.salutationRules.notes.length > 0) {
    parts.push(`- Lưu ý: ${style.salutationRules.notes.join('; ')}`);
  }

  // Sentence Style
  parts.push('\n=== PHONG CÁCH CÂU TỪ (SENTENCE STYLE) ===');
  parts.push(`- Độ dài ưu tiên: ${style.sentenceStyle.preferredLength}`);
  parts.push(`- Mức độ sử dụng emoji: ${style.sentenceStyle.emojiUsage}`);
  if (style.sentenceStyle.toneDescriptors && style.sentenceStyle.toneDescriptors.length > 0) {
    parts.push(`- Giọng điệu: ${style.sentenceStyle.toneDescriptors.join(', ')}`);
  }
  if (style.sentenceStyle.punctuationPatterns && style.sentenceStyle.punctuationPatterns.length > 0) {
    parts.push(`- Dấu câu: ${style.sentenceStyle.punctuationPatterns.join('; ')}`);
  }
  if (style.sentenceStyle.notes && style.sentenceStyle.notes.length > 0) {
    parts.push(`- Lưu ý: ${style.sentenceStyle.notes.join('; ')}`);
  }

  // Question Style
  parts.push('\n=== PHONG CÁCH ĐẶT CÂU HỎI (QUESTION STYLE) ===');
  if (style.questionStyle.commonPatterns && style.questionStyle.commonPatterns.length > 0) {
    parts.push(`- Mẫu câu hỏi thường dùng: ${style.questionStyle.commonPatterns.join('; ')}`);
  }
  if (style.questionStyle.discoveryApproach && style.questionStyle.discoveryApproach.length > 0) {
    parts.push(`- Cách tiếp cận khai thác nhu cầu: ${style.questionStyle.discoveryApproach.join('; ')}`);
  }
  if (style.questionStyle.followUpApproach && style.questionStyle.followUpApproach.length > 0) {
    parts.push(`- Cách hỏi tiếp nối / theo sát: ${style.questionStyle.followUpApproach.join('; ')}`);
  }
  if (style.questionStyle.notes && style.questionStyle.notes.length > 0) {
    parts.push(`- Lưu ý: ${style.questionStyle.notes.join('; ')}`);
  }

  // Objection Style
  if (style.objectionStyle.approaches.length > 0) {
    parts.push('\n=== PHƯƠNG PHÁP XỬ LÝ TỪ CHỐI / THẮC MẮC (OBJECTION HANDLING) ===');
    for (const app of style.objectionStyle.approaches) {
      parts.push(`- Tình huống: "${app.situation}" -> Hướng giải quyết: "${app.responseApproach}"`);
    }
  }

  // Closing Style
  parts.push('\n=== PHONG CÁCH CHỐT VÀ LỜI KẾT (CLOSING STYLE) ===');
  if (style.closingStyle.commonClosings.length > 0) {
    parts.push(`- Lời chào kết thúc thường dùng: ${style.closingStyle.commonClosings.join('; ')}`);
  }
  if (style.closingStyle.callToActionPatterns.length > 0) {
    parts.push(`- Kêu gọi hành động (CTA): ${style.closingStyle.callToActionPatterns.join('; ')}`);
  }
  if (style.closingStyle.urgencyStyle.length > 0) {
    parts.push(`- Tạo tính cấp thiết: ${style.closingStyle.urgencyStyle.join('; ')}`);
  }

  return parts.join('\n');
}

/**
 * Builds the composable runtime sales style prompt context for AI auto-reply workers.
 *
 * Rules:
 * 1. If saleUserId is missing, null, or empty: returns safe neutral default (zero guessing).
 * 2. If saleUserId is provided: queries public.get_active_sales_style_profile via service_role.
 * 3. If no active profile exists (e.g. only DRAFT or SUPERSEDED): returns neutral default (zero Boss fallback).
 * 4. If active profile exists: runs style policy firewall validation. If valid, builds personalized context.
 * 5. Appends business policy firewall notice prohibiting price/discount/deposit commitments.
 */
export async function buildRuntimeSalesStyleContext(
  params: BuildRuntimeSalesStyleContextParams
): Promise<RuntimeSalesStyleContextResult> {
  const { companyId, saleUserId, client = createAdminClient() } = params;

  // 1. Unassigned / no sale user -> Safe neutral default
  if (!saleUserId || typeof saleUserId !== 'string' || saleUserId.trim().length === 0) {
    return {
      styleContextPrompt: `${NEUTRAL_DEFAULT_STYLE_INSTRUCTIONS}\n\n${BUSINESS_POLICY_FIREWALL_WARNING}`,
      activeProfileId: null,
      isNeutralDefault: true,
      appliedStyle: null,
    };
  }

  // 2. Fetch active profile for this company + sale user
  let activeProfile: ActiveSalesStyleProfile | null = null;
  try {
    activeProfile = await fetchActiveSalesStyleProfile(client, {
      companyId,
      saleUserId,
    });
  } catch {
    // If user is not found, not a member of company, or inactive, fail closed to safe neutral default
    return {
      styleContextPrompt: `${NEUTRAL_DEFAULT_STYLE_INSTRUCTIONS}\n\n${BUSINESS_POLICY_FIREWALL_WARNING}`,
      activeProfileId: null,
      isNeutralDefault: true,
      appliedStyle: null,
    };
  }

  // 3. No active profile found -> Safe neutral default (zero guessing)
  if (!activeProfile) {
    return {
      styleContextPrompt: `${NEUTRAL_DEFAULT_STYLE_INSTRUCTIONS}\n\n${BUSINESS_POLICY_FIREWALL_WARNING}`,
      activeProfileId: null,
      isNeutralDefault: true,
      appliedStyle: null,
    };
  }

  // 4. Style Policy Firewall Check (Defense in Depth)
  try {
    validateSalesStyleOutput({
      salutationRules: activeProfile.salutationRules,
      sentenceStyle: activeProfile.sentenceStyle,
      questionStyle: activeProfile.questionStyle,
      objectionStyle: activeProfile.objectionStyle,
      closingStyle: activeProfile.closingStyle,
    });
  } catch {
    // If active profile fails policy firewall, fail closed to safe neutral default
    return {
      styleContextPrompt: `${NEUTRAL_DEFAULT_STYLE_INSTRUCTIONS}\n\n${BUSINESS_POLICY_FIREWALL_WARNING}`,
      activeProfileId: null,
      isNeutralDefault: true,
      appliedStyle: null,
    };
  }

  // 5. Compose active personalized style prompt
  const sections = formatActiveStyleSections(activeProfile);
  const prompt = `[ACTIVE PERSONALIZED SALES STYLE (v${activeProfile.version})]\n${sections}\n\n${BUSINESS_POLICY_FIREWALL_WARNING}`;

  return {
    styleContextPrompt: prompt,
    activeProfileId: activeProfile.id,
    isNeutralDefault: false,
    appliedStyle: activeProfile,
  };
}
