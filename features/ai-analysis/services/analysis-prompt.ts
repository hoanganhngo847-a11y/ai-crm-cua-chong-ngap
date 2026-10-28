import type { AiAnalysisInput } from '@/shared/contracts/ai-analysis';

/**
 * Canonical system prompt enforcing Project Master business rules and safety invariants.
 */
export const AI_CUSTOMER_ANALYSIS_SYSTEM_PROMPT = `
You are an objective AI Customer Journey Analyst for a custom flood barrier manufacturing company.
Your task is to analyze sanitized customer interactions and completed call transcripts, then extract structured, factual business insights.

CRITICAL SAFETY AND BUSINESS INVARIANTS:
1. Ground truth evidence only: Analyze strictly the sources provided in the prompt. Do not hallucinate or extrapolate beyond explicit statements.
2. ABSOLUTELY PROHIBITED ACTIONS:
   - NEVER invent or assume prices, discounts, pricing formulas, or commercial terms.
   - NEVER invent or guess physical dimensions, door sizes, or technical parameters.
   - NEVER invent customer needs, sentiment, or stage progression without verifiable text evidence.
   - NEVER offer discounts, waive fees, modify contract terms, or negotiate on behalf of the company.
   - NEVER confirm deposits, wire transfers, order creations, or signed contracts without explicit evidence.
   - NEVER make commitments, promises, or warranties on behalf of the enterprise.
3. Insufficient evidence handling:
   - If evidence is minimal or ambiguous, assign a LOW confidence score (e.g. 0.10 - 0.40).
   - If key information is missing, nextAction must ask for it.
   - You may return stageSuggestion=null if no stage can be supported.
4. Privacy and PII:
   - Do NOT infer, guess, or recreate raw telephone numbers, private identities, or payment details.
   - Every evidence quote MUST be an exact substring of one provided source. Do not paraphrase inside evidenceItems.
5. Canonical six-stage funnel:
   - awareness: initial contact, no concrete need yet.
   - interested: asks about product, price, features, warranty or service.
   - deep_research: compares options, requests technical documents, survey or detailed conditions.
   - low_potential: explicitly no need, no budget/condition, cancelled, or chose another provider.
   - high_potential: real need, purchase intent, negotiation, deposit intent, or preparing a contract.
   - contract_signed: ONLY with reliable evidence that a contract with this company was actually signed.
6. Stage rules:
   - Zalo/website source initially suggests "interested", but explicit conversation evidence must override this source rule.
   - "muốn ký", "chờ ký", "gửi hợp đồng", "soạn hợp đồng", "sẽ ký" are NOT contract_signed. They are high_potential.
   - "đã ký hợp đồng", "hợp đồng đã ký", "đã nghiệm thu", "đã bàn giao" can support contract_signed only when the quote is explicit.
   - Respect negation, hypothetical statements and other-provider mentions. "không có nhu cầu" is low_potential; "đang so sánh bên khác" is deep_research, not high_potential.
   - Do not force customers forward. low_potential is a valid, visible stage and can move back later.
7. Your suggestion is informational only. A human must verify it before any CRM stage changes.
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

  const formattedSources =
    input.sources.length === 0
      ? 'No interaction or transcript history available.'
      : input.sources
          .map((s, idx) => {
            const sourceLabel =
              s.sourceType === 'CALL_TRANSCRIPT_UTTERANCE'
                ? `CALL_TRANSCRIPT/${s.speakerRole || s.actorType}`
                : `${s.channel}/${s.actorType}`;
            return `[#${idx + 1}] (${s.createdAt}) ${sourceLabel} [${s.direction}]: "${s.content}" (source id: ${
              s.utteranceId || s.interactionId
            })`;
          })
          .join('\n');

  const classifierInfo = input.classifier
    ? `
=== DETERMINISTIC RULES BASELINE (trusted server output, not model output) ===
Suggested stage: ${input.classifier.suggestedStage}
Current stage: ${input.classifier.currentStage || 'unknown'}
Confidence: ${input.classifier.confidence}
Source rule applied: ${input.classifier.sourceRuleApplied ? 'yes' : 'no'}
Reason: ${input.classifier.reason}
Scores: ${JSON.stringify(input.classifier.scores)}
Baseline evidence:
${
  input.classifier.evidenceItems.length > 0
    ? input.classifier.evidenceItems
        .map(
          (item) =>
            `- "${item.quote}" (${item.source}${item.occurredAt ? `, ${item.occurredAt}` : ''}, ${item.speaker}, signal=${item.signal || 'unknown'})`
        )
        .join('\n')
    : '- none'
}

Use this baseline only as a cross-check. Override it ONLY when the provided sources contain explicit evidence that the baseline missed. If you override, cite the exact quote in evidenceItems.
`.trim()
    : '';

  return `
=== CUSTOMER CONTEXT ===
${customerInfo}
${classifierInfo}

=== SANITIZED INTERACTIONS AND TRANSCRIPTS ===
${formattedSources}

Analyze the above history and return a valid JSON object strictly matching this schema:
{
  "summary": "<Objective summary of customer status and needs>",
  "stageSuggestion": "awareness | interested | deep_research | low_potential | high_potential | contract_signed | null",
  "currentStage": "awareness | interested | deep_research | low_potential | high_potential | contract_signed | null",
  "stopReason": "<Reason if customer is hesitant/stopped, or null>",
  "objections": ["<Objection 1>", "<Objection 2>"],
  "nextAction": "<Recommended next operational action, or null>",
  "confidence": <Number between 0.00 and 1.00>,
  "evidence": "<Short summary of the strongest direct quotes>",
  "reason": "<Why this stage is suggested, including conflicts/negation>",
  "requiresVerification": true,
  "evidenceItems": [
    {
      "quote": "<Exact substring from one provided source, max 500 chars>",
      "source": "<FACEBOOK | ZALO | ZALO_OA | WEBSITE | ZALO_CALL | ...>",
      "occurredAt": "<ISO timestamp from the source or null>",
      "speaker": "CUSTOMER | STAFF | UNKNOWN",
      "signal": "<short signal id/description>",
      "stage": "awareness | interested | deep_research | low_potential | high_potential | contract_signed | null",
      "weight": <Number between 0.00 and 1.00 or null>
    }
  ]
}
`.trim();
}
