import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AiAnalysisEvidenceItem,
  AiAnalysisInput,
  AiAnalysisRecord,
  AiAnalysisSourceRef,
  AiCustomerAnalysisOutput,
} from '@/shared/contracts/ai-analysis';
import { tryToCanonicalStage } from '@/features/crm/types/customer.types';
import {
  classifyCustomerStage,
  normalizeVietnamese,
  type StageClassification,
} from '@/features/crm/stage-classifier';
import { fetchAiAnalysisInput, persistAiAnalysis } from './ai-analysis-store';
import { validateAiAnalysisOutput } from './validate-ai-analysis';

/**
 * Dependency injection boundary for AI Analysis Model implementations.
 * Enforces trusted provenance: modelVersion is an immutable, environment-governed property,
 * never generated, inferred, or trusted from untrusted model output.
 */
export interface AiAnalysisModel {
  readonly modelVersion: string;
  analyze(input: AiAnalysisInput): Promise<unknown>;
}

export interface RunCustomerAnalysisPipelineParams {
  model: AiAnalysisModel;
  companyId: string;
  customerId: string;
  client: SupabaseClient;
  limit?: number;
}

export class NoAnalyzableSourcesError extends Error {
  constructor(message = 'No sanitized interactions available to perform AI customer analysis') {
    super(message);
    this.name = 'NoAnalyzableSourcesError';
  }
}

function roundConfidence(value: number): number {
  return Math.round(Math.min(Math.max(value, 0), 1) * 100) / 100;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= 20) break;
  }
  return result;
}

function buildSourceRefs(input: AiAnalysisInput): AiAnalysisSourceRef[] {
  const seen = new Set<string>();
  const refs: AiAnalysisSourceRef[] = [];
  for (const source of input.sources) {
    const type =
      source.sourceType || (source.utteranceId ? 'CALL_TRANSCRIPT_UTTERANCE' : 'INTERACTION');
    const id = source.utteranceId || source.interactionId;
    if (!id) continue;
    const key = `${type}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ type, id });
  }
  return refs;
}

function groundEvidenceFromInput(
  quote: string,
  input: AiAnalysisInput
): AiAnalysisEvidenceItem | null {
  const cleanQuote = normalizeVietnamese(quote.replace(/\.\.\.$/, ''));
  if (!cleanQuote) return null;

  for (const source of input.sources) {
    if (!normalizeVietnamese(source.content).includes(cleanQuote)) continue;
    return {
      quote: quote.length > 500 ? `${quote.slice(0, 497)}...` : quote,
      source: source.channel || source.sourceType || 'UNKNOWN',
      occurredAt: source.createdAt || null,
      speaker:
        source.actorType === 'CUSTOMER'
          ? 'CUSTOMER'
          : source.actorType === 'SALE'
            ? 'STAFF'
            : 'UNKNOWN',
      signal: 'model_evidence',
      stage: null,
      weight: null,
    };
  }
  return null;
}

/**
 * Reconciles the untrusted LLM suggestion with the deterministic rules baseline.
 *
 * Safety rules:
 * - AI suggestions never mutate the official stage.
 * - contract_signed is never accepted without explicit signed-contract evidence.
 * - If the model disagrees with strong deterministic evidence and provides no
 *   grounded citation, the baseline wins and confidence is capped.
 * - Evidence items always come from real sanitized sources, never invented.
 */
export function reconcileAiAnalysis(
  analysis: AiCustomerAnalysisOutput,
  classification: StageClassification,
  input: AiAnalysisInput
): AiCustomerAnalysisOutput {
  let stage = tryToCanonicalStage(analysis.stageSuggestion);
  let confidence = analysis.confidence;
  let reason = analysis.reason || classification.reason;
  let evidenceItems: AiAnalysisEvidenceItem[] = analysis.evidenceItems || [];
  const objections = uniqueStrings([
    ...(analysis.objections || []),
    ...classification.objections,
  ]);
  const nextAction = analysis.nextAction || classification.nextAction;
  const currentStage = classification.currentStage;
  const strongDeterministic =
    classification.confidence >= 0.55 && !classification.sourceRuleApplied;

  if (!stage) {
    stage = classification.suggestedStage;
    confidence = Math.min(confidence, classification.confidence);
    reason = `${reason ? `${reason} ` : ''}AI không đưa ra giai đoạn; dùng baseline xác định ${classification.suggestedStage}.`;
  }

  // Contract signed is high-risk: only keep it when the rules baseline also found
  // explicit signed-contract evidence.
  if (stage === 'contract_signed' && classification.suggestedStage !== 'contract_signed') {
    stage = classification.suggestedStage === 'low_potential' ? 'low_potential' : 'high_potential';
    confidence = Math.min(confidence, 0.5);
    reason = `AI đề xuất Đã ký hợp đồng nhưng chưa có bằng chứng đã ký đủ mạnh; hạ xuống ${stage} và cần xác minh thủ công.`;
  }

  // If the model disagrees with strong explicit evidence and gives no citation,
  // prefer the deterministic baseline rather than an unsupported guess.
  if (stage !== classification.suggestedStage && evidenceItems.length === 0 && strongDeterministic) {
    stage = classification.suggestedStage;
    confidence = Math.min(confidence, classification.confidence, 0.6);
    reason = `AI không cung cấp trích dẫn nguồn cho đề xuất khác; dùng baseline ${classification.suggestedStage} và cần xác minh thủ công.`;
  }

  // Ensure contract_signed always carries at least one explicit contract citation.
  if (stage === 'contract_signed') {
    const contractEvidence = evidenceItems.filter((item) => item.stage === 'contract_signed');
    if (contractEvidence.length === 0) {
      const baselineContract = classification.evidenceItems.filter(
        (item) => item.stage === 'contract_signed'
      );
      if (baselineContract.length > 0) {
        evidenceItems = [...baselineContract, ...evidenceItems].slice(0, 20);
      } else {
        stage = 'high_potential';
        confidence = Math.min(confidence, 0.45);
        reason = 'Chưa có trích dẫn xác nhận hợp đồng đã ký; giữ ở Có tiềm năng và cần xác minh thủ công.';
      }
    }
  }

  // If the model gave no structured citations, use grounded baseline citations.
  if (evidenceItems.length === 0) {
    evidenceItems = classification.evidenceItems;
  }

  // Last resort: ground the free-text evidence string in a real source.
  if (evidenceItems.length === 0) {
    const grounded = groundEvidenceFromInput(analysis.evidence, input);
    if (grounded) evidenceItems = [grounded];
  }

  return {
    ...analysis,
    stageSuggestion: stage,
    currentStage,
    confidence: roundConfidence(confidence),
    reason: reason.slice(0, 1000),
    evidenceItems: evidenceItems.slice(0, 20),
    objections,
    nextAction,
    requiresVerification: true,
  };
}

/**
 * Orchestrates the secure end-to-end customer analysis pipeline:
 * 1. Reads bounded, sanitized interactions + completed call transcripts via service_role RPCs.
 * 2. Runs a deterministic rules classifier as a trusted baseline.
 * 3. Invokes the model boundary with the baseline attached to the input.
 * 4. Strictly validates the untrusted model output fail-closed (omits/ignores any forged modelVersion).
 * 5. Reconciles AI output with explicit evidence, never mutating the official stage.
 * 6. Extracts audit-safe source_refs and persists with a dedupe key.
 */
export async function runCustomerAnalysisPipeline(
  params: RunCustomerAnalysisPipelineParams
): Promise<AiAnalysisRecord> {
  const { model, companyId, customerId, client, limit } = params;

  // 1. Fetch bounded input
  const input = await fetchAiAnalysisInput(client, {
    companyId,
    customerId,
    limit,
  });

  if (input.sources.length === 0) {
    throw new NoAnalyzableSourcesError(
      `Customer ${customerId} has no sanitized interactions or completed call transcripts available for evidence-based analysis.`
    );
  }

  // 2. Deterministic baseline
  const classification = classifyCustomerStage({
    customer: {
      stage: input.customer.stage,
      source: input.customer.source,
    },
    sources: input.sources.map((source) => ({
      id: source.utteranceId || source.interactionId,
      sourceType:
        source.sourceType || (source.utteranceId ? 'CALL_TRANSCRIPT_UTTERANCE' : 'INTERACTION'),
      channel: source.channel,
      speaker:
        source.actorType === 'CUSTOMER'
          ? 'CUSTOMER'
          : source.actorType === 'SALE'
            ? 'STAFF'
            : 'UNKNOWN',
      content: source.content,
      occurredAt: source.createdAt,
    })),
  });

  const inputWithBaseline: AiAnalysisInput = {
    ...input,
    classifier: {
      suggestedStage: classification.suggestedStage,
      currentStage: classification.currentStage,
      confidence: classification.confidence,
      reason: classification.reason,
      evidence: classification.evidence,
      evidenceItems: classification.evidenceItems,
      objections: classification.objections,
      nextAction: classification.nextAction,
      requiresVerification: classification.requiresVerification,
      sourceRuleApplied: classification.sourceRuleApplied,
      classifierVersion: classification.classifierVersion,
      scores: classification.scores,
    },
  };

  // 3. Untrusted model execution
  const rawOutput = await model.analyze(inputWithBaseline);

  // 4. Strict schema and business validation (modelVersion is excluded from this result)
  const validatedAnalysis = validateAiAnalysisOutput(rawOutput, inputWithBaseline);

  // 5. Reconcile with deterministic evidence; official stage is never mutated.
  const reconciledAnalysis = reconcileAiAnalysis(
    validatedAnalysis,
    classification,
    inputWithBaseline
  );

  // 6. Audit-safe source references
  const sourceRefs = buildSourceRefs(inputWithBaseline);

  // 7. Stable dedupe key: same model + classifier + sources + current stage => same note.
  const dedupeKey = createHash('sha256')
    .update(
      JSON.stringify({
        modelVersion: model.modelVersion,
        classifierVersion: classification.classifierVersion,
        currentStage: classification.currentStage,
        sources: sourceRefs.map((ref) => `${ref.type}:${ref.id}`).sort(),
      })
    )
    .digest('hex');

  return persistAiAnalysis(client, {
    companyId,
    customerId,
    sourceRefs,
    analysis: reconciledAnalysis,
    modelVersion: model.modelVersion,
    classifierVersion: classification.classifierVersion,
    dedupeKey,
  });
}

/**
 * Fake deterministic model for unit and integration testing without external API calls.
 */
export class FakeDeterministicAiModel implements AiAnalysisModel {
  constructor(
    public readonly modelVersion: string,
    private readonly responseOrFactory:
      | unknown
      | ((input: AiAnalysisInput) => unknown | Promise<unknown>)
  ) {}

  async analyze(input: AiAnalysisInput): Promise<unknown> {
    if (typeof this.responseOrFactory === 'function') {
      return (this.responseOrFactory as (input: AiAnalysisInput) => unknown | Promise<unknown>)(
        input
      );
    }
    return this.responseOrFactory;
  }
}
