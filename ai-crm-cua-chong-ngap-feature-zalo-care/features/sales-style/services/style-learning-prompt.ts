import type { SalesStyleLearningInput } from '@/shared/contracts/sales-style';

/**
 * System prompt strictly enforcing the style vs business policy firewall.
 * Directs the AI model to extract only stylistic patterns and phrasing techniques,
 * explicitly forbidding learning or hallucinating business rules, discounts, or policies.
 */
export const SALES_STYLE_LEARNING_SYSTEM_PROMPT = `
You are an expert Linguistic Stylistic Analyst.
Your task is to analyze sanitized outbound communication from a Sales representative and extract their unique communication style, tone, and rhetorical patterns.

CRITICAL SAFETY AND BUSINESS POLICY FIREWALL:
1. FORM AND STYLE ONLY:
   - You are learning HOW the sale speaks, NOT WHAT business rules they apply.
   - Analyze: salutations, sentence rhythm, questioning techniques, framing, objection handling approaches, and closing cadence.
2. ABSOLUTELY FORBIDDEN TO INFER OR EXTRACT AS BUSINESS POLICIES:
   - NEVER extract pricing rules, discount percentages, or pricing policies.
     * Example: If the sale says "Anh giảm 10% cho em đợt này nhé", DO NOT infer "Company or sale offers 10% discounts".
     * Instead, observe purely stylistic traits, such as "Uses friendly, direct phrasing before proposing next steps".
   - NEVER extract payment terms, deposit authorities, or financial waivers.
   - NEVER extract contractual commitments, legal terms, or warranty duration promises.
   - NEVER invent or memorize door measurements, technical engineering specifications, or delivery timeline commitments.
   - NEVER generate business authorizations or executive permissions.
3. STRICT SCHEMA CONFORMANCE:
   - Your response must be valid JSON matching the exact requested style schema.
   - Do NOT include metadata, provenance, version, modelVersion, companyId, saleUserId, sourceRefs, or examples.
`.trim();

/**
 * Formats sanitized outbound sale interactions into a structured prompt for the model.
 */
export function buildSalesStyleLearningUserPrompt(input: SalesStyleLearningInput): string {
  const formattedSources = input.sources.length === 0
    ? 'No outbound messages available.'
    : input.sources
        .map((s, idx) => {
          return `[Message #${idx + 1}] (${s.createdAt}) via [${s.channel}]: "${s.content}"`;
        })
        .join('\n');

  return `
=== SANITIZED OUTBOUND MESSAGES FROM TARGET SALE ===
${formattedSources}

Based strictly on the messages above, extract the stylistic patterns and output a JSON object adhering to this schema:
{
  "salutationRules": {
    "selfReferences": ["<how the sale refers to themselves, e.g. 'em', 'mình'>"],
    "customerReferences": ["<how the sale addresses the customer, e.g. 'anh', 'chị'>"],
    "commonOpenings": ["<common opening phrases>"],
    "notes": ["<stylistic notes regarding greetings>"]
  },
  "sentenceStyle": {
    "preferredLength": "SHORT" | "MEDIUM" | "LONG" | "MIXED",
    "toneDescriptors": ["<adjectives describing tone, e.g. 'nhiệt tình', 'ngắn gọn'>"],
    "emojiUsage": "NONE" | "LOW" | "MEDIUM" | "HIGH",
    "punctuationPatterns": ["<punctuation habits, e.g. 'dùng dấu chấm lửng'>"],
    "notes": ["<sentence structure notes>"]
  },
  "questionStyle": {
    "commonPatterns": ["<common question formats>"],
    "discoveryApproach": ["<how the sale explores customer needs>"],
    "followUpApproach": ["<how the sale follows up>"],
    "notes": ["<inquiry style notes>"]
  },
  "objectionStyle": {
    "approaches": [
      {
        "situation": "<type of objection, e.g. 'khách chê đắt'>",
        "responseApproach": "<stylistic framing approach, e.g. 'đồng cảm trước rồi giải thích giá trị vật liệu inox 304'>"
      }
    ],
    "notes": ["<objection handling style notes>"]
  },
  "closingStyle": {
    "commonClosings": ["<common sign-offs>"],
    "callToActionPatterns": ["<how the sale asks for next steps, e.g. 'xin lịch hẹn đo'>"],
    "urgencyStyle": ["<urgency creation style without violating business rules>"],
    "notes": ["<closing style notes>"]
  }
}
`.trim();
}
