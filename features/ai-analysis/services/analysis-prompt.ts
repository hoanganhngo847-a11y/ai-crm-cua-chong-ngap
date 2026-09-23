import type { AiAnalysisInput } from '@/shared/contracts/ai-analysis';

/**
 * Canonical system prompt enforcing Project Master business rules and safety invariants.
 */
export const AI_CUSTOMER_ANALYSIS_SYSTEM_PROMPT = `
You are an objective AI Customer Journey Analyst for a custom flood barrier manufacturing company.
Your task is to analyze sanitized customer interactions and extract structured, factual business insights.

CRITICAL SAFETY AND BUSINESS INVARIANTS:
1. Ground truth evidence only: Analyze strictly the interactions provided in the prompt. Do not hallucinate or extrapolate beyond explicit statements.
2. ABSOLUTELY PROHIBITED ACTIONS:
   - NEVER invent or assume prices, discounts, pricing formulas, or commercial terms.
   - NEVER invent or guess physical dimensions, door sizes, or technical parameters.
   - NEVER invent customer needs, sentiment, or stage progression without verifiable text evidence.
   - NEVER offer discounts, waive fees, modify contract terms, or negotiate on behalf of the company.
   - NEVER confirm deposits, wire transfers, order creations, or signed contracts.
   - NEVER make commitments, promises, or warranties on behalf of the enterprise.
3. Insufficient evidence handling:
   - If interaction evidence is minimal or ambiguous, you MUST assign a LOW confidence score (e.g. 0.10 - 0.40).
   - If missing dimensions or survey details prevent price quoting, stageSuggestion MUST be 'NEED_INFO' or null.
   - nextAction must clearly suggest requesting the missing information from the customer.
4. Privacy and PII:
   - Do NOT infer, guess, or attempt to recreate raw telephone numbers, private identities, or sensitive payment details.
   - All references to customer statements must use exact or paraphrased sanitized quotes in the evidence field.
5. Canonical Stage Suggestion:
   - You may suggest a stage from the allowed customer journey stages, OR null if uncertain.
   - Your suggestion is an informational recommendation only and does not mutate any CRM stage directly.
`.trim();

/**
 * Formats bounded AI analysis input into a structured user prompt for LLM consumption.
 */
export function buildAiAnalysisUserPrompt(input: AiAnalysisInput): string {
  const customerInfo = [
    `Customer Code: ${input.customer.customerCode}`,
    `Name: ${input.customer.name}`,
    `Source: ${input.customer.source}`,
    `Current Stage: ${input.customer.stage}`,
  ].join('\n');

  const formattedSources = input.sources.length === 0
    ? 'No interaction history available.'
    : input.sources
        .map((s, idx) => {
          return `[#${idx + 1}] (${s.createdAt}) ${s.actorType} [${s.direction} via ${s.channel}]: "${s.content}" (id: ${s.interactionId})`;
        })
        .join('\n');

  return `
=== CUSTOMER CONTEXT ===
${customerInfo}

=== SANITIZED INTERACTIONS HISTORY ===
${formattedSources}

Analyze the above history and return a valid JSON object strictly matching this schema:
{
  "summary": "<Objective summary of customer status and needs>",
  "stageSuggestion": "<Canonical stage or null>",
  "stopReason": "<Reason if customer is hesitant/stopped, or null>",
  "objections": ["<Objection 1>", "<Objection 2>"],
  "nextAction": "<Recommended next operational action, or null>",
  "confidence": <Number between 0.00 and 1.00>,
  "evidence": "<Direct quotes and evidence supporting conclusions>"
}
`.trim();
}
