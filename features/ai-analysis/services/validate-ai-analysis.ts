import {
  AI_ANALYSIS_STAGE_SUGGESTIONS,
  type AiAnalysisEvidenceItem,
  type AiAnalysisInput,
  type AiAnalysisStageSuggestion,
  type AiCustomerAnalysisOutput,
} from '@/shared/contracts/ai-analysis';
import { tryToCanonicalStage, type CanonicalCustomerStage } from '@/features/crm/types/customer.types';
import { normalizeVietnamese } from '@/features/crm/stage-classifier/normalize';

export class AiAnalysisValidationError extends Error {
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'AiAnalysisValidationError';
  }
}

function normalizeStage(value: unknown, field: string): CanonicalCustomerStage | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new AiAnalysisValidationError(`${field} must be a string or null`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!AI_ANALYSIS_STAGE_SUGGESTIONS.includes(trimmed as AiAnalysisStageSuggestion)) {
    throw new AiAnalysisValidationError(
      `${field} "${trimmed}" is not in the canonical stage allowlist`
    );
  }
  const canonical = tryToCanonicalStage(trimmed);
  if (!canonical) {
    throw new AiAnalysisValidationError(`${field} "${trimmed}" cannot be normalized to a canonical stage`);
  }
  return canonical;
}

function buildSourceCorpus(input?: AiAnalysisInput): Array<{
  content: string;
  source: string;
  occurredAt: string | null;
  speaker: 'CUSTOMER' | 'STAFF' | 'UNKNOWN';
}> {
  if (!input) return [];
  return (input.sources || []).map((source) => ({
    content: source.content || '',
    source: source.channel || source.sourceType || 'UNKNOWN',
    occurredAt: source.createdAt || null,
    speaker:
      source.actorType === 'CUSTOMER'
        ? 'CUSTOMER'
        : source.actorType === 'SALE'
          ? 'STAFF'
          : 'UNKNOWN',
  }));
}

function isGrounded(quote: string, input?: AiAnalysisInput): boolean {
  if (!input) return true;
  const cleanQuote = normalizeVietnamese(quote.replace(/\.\.\.$/, ''));
  if (!cleanQuote) return false;
  return buildSourceCorpus(input).some((source) => {
    const normalizedContent = normalizeVietnamese(source.content);
    return normalizedContent.includes(cleanQuote);
  });
}

function groundEvidenceFromString(
  evidence: string,
  input?: AiAnalysisInput
): AiAnalysisEvidenceItem | null {
  if (!input) return null;
  const cleanEvidence = normalizeVietnamese(evidence.replace(/\.\.\.$/, ''));
  if (!cleanEvidence) return null;
  const source = buildSourceCorpus(input).find((candidate) =>
    normalizeVietnamese(candidate.content).includes(cleanEvidence)
  );
  if (!source) return null;
  return {
    quote: evidence.length > 500 ? `${evidence.slice(0, 497)}...` : evidence,
    source: source.source,
    occurredAt: source.occurredAt,
    speaker: source.speaker,
    signal: 'model_evidence',
    stage: null,
    weight: null,
  };
}

/**
 * Validates untrusted LLM output and guarantees adherence to canonical data constraints.
 * Fails closed on any structural anomaly or domain rule violation.
 *
 * When `input` is provided, every evidence quote must be grounded in the supplied
 * sanitized sources. This prevents the model from fabricating citations.
 *
 * NOTE: modelVersion is NOT validated or extracted from untrusted model output.
 * Model provenance is bound strictly by the trusted runtime environment.
 */
export function validateAiAnalysisOutput(
  raw: unknown,
  input?: AiAnalysisInput
): AiCustomerAnalysisOutput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AiAnalysisValidationError('Output must be a non-null JSON object');
  }

  const record = raw as Record<string, unknown>;

  // 1. Summary validation (required, non-empty, bounded <= 2000 chars)
  if (typeof record.summary !== 'string' || record.summary.trim().length === 0) {
    throw new AiAnalysisValidationError('Summary must be a non-empty string');
  }
  const summary = record.summary.trim();
  if (summary.length > 2000) {
    throw new AiAnalysisValidationError('Summary exceeds maximum length of 2000 characters');
  }

  // 2. Confidence validation (required, finite number, 0.0 <= confidence <= 1.0)
  if (
    typeof record.confidence !== 'number' ||
    !Number.isFinite(record.confidence) ||
    record.confidence < 0 ||
    record.confidence > 1
  ) {
    throw new AiAnalysisValidationError(
      'Confidence must be a finite number between 0.0 and 1.0 inclusive'
    );
  }
  const confidence = Math.round(record.confidence * 100) / 100;

  // 3. Stage suggestion validation (canonical allowlist + legacy aliases -> canonical)
  const stageSuggestion = normalizeStage(record.stageSuggestion, 'stageSuggestion');
  const currentStage =
    normalizeStage(record.currentStage, 'currentStage') ||
    (input ? tryToCanonicalStage(input.customer.stage) : null);

  // 4. Objections validation (array of non-empty strings, bounded <= 20 items, <= 500 chars each)
  if (!Array.isArray(record.objections)) {
    throw new AiAnalysisValidationError('Objections must be an array of strings');
  }
  if (record.objections.length > 20) {
    throw new AiAnalysisValidationError('Objections list exceeds maximum allowed count of 20');
  }
  const objections: string[] = [];
  for (let i = 0; i < record.objections.length; i++) {
    const item = record.objections[i];
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new AiAnalysisValidationError(`Objection at index ${i} must be a non-empty string`);
    }
    const trimmed = item.trim();
    if (trimmed.length > 500) {
      throw new AiAnalysisValidationError(
        `Objection at index ${i} exceeds maximum length of 500 characters`
      );
    }
    objections.push(trimmed);
  }

  // 5. Stop reason validation (optional string, bounded <= 1000 chars)
  let stopReason: string | null = null;
  if (record.stopReason !== undefined && record.stopReason !== null) {
    if (typeof record.stopReason !== 'string') {
      throw new AiAnalysisValidationError('stopReason must be a string or null');
    }
    const trimmed = record.stopReason.trim();
    if (trimmed.length > 1000) {
      throw new AiAnalysisValidationError('stopReason exceeds maximum length of 1000 characters');
    }
    stopReason = trimmed.length > 0 ? trimmed : null;
  }

  // 6. Next action validation (optional string, bounded <= 1000 chars)
  let nextAction: string | null = null;
  if (record.nextAction !== undefined && record.nextAction !== null) {
    if (typeof record.nextAction !== 'string') {
      throw new AiAnalysisValidationError('nextAction must be a string or null');
    }
    const trimmed = record.nextAction.trim();
    if (trimmed.length > 1000) {
      throw new AiAnalysisValidationError('nextAction exceeds maximum length of 1000 characters');
    }
    nextAction = trimmed.length > 0 ? trimmed : null;
  }

  // 7. Reason validation (optional string, bounded <= 1000 chars)
  let reason: string | null = null;
  if (record.reason !== undefined && record.reason !== null) {
    if (typeof record.reason !== 'string') {
      throw new AiAnalysisValidationError('reason must be a string or null');
    }
    const trimmed = record.reason.trim();
    if (trimmed.length > 1000) {
      throw new AiAnalysisValidationError('reason exceeds maximum length of 1000 characters');
    }
    reason = trimmed.length > 0 ? trimmed : null;
  }

  // 8. Evidence validation (required, non-empty, bounded <= 5000 chars)
  if (typeof record.evidence !== 'string' || record.evidence.trim().length === 0) {
    throw new AiAnalysisValidationError('Evidence must be a non-empty string');
  }
  const evidence = record.evidence.trim();
  if (evidence.length > 5000) {
    throw new AiAnalysisValidationError('Evidence exceeds maximum length of 5000 characters');
  }

  // 9. Structured evidence items (quote-only, bounded, grounded when input is available)
  const evidenceItems: AiAnalysisEvidenceItem[] = [];
  if (record.evidenceItems !== undefined && record.evidenceItems !== null) {
    if (!Array.isArray(record.evidenceItems)) {
      throw new AiAnalysisValidationError('evidenceItems must be an array');
    }
    if (record.evidenceItems.length > 20) {
      throw new AiAnalysisValidationError('evidenceItems exceeds maximum allowed count of 20');
    }
    for (let i = 0; i < record.evidenceItems.length; i++) {
      const item = record.evidenceItems[i];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new AiAnalysisValidationError(`evidenceItems[${i}] must be an object`);
      }
      const itemRecord = item as Record<string, unknown>;

      if (typeof itemRecord.quote !== 'string' || itemRecord.quote.trim().length === 0) {
        throw new AiAnalysisValidationError(`evidenceItems[${i}].quote must be a non-empty string`);
      }
      const quote = itemRecord.quote.trim();
      if (quote.length > 500) {
        throw new AiAnalysisValidationError(`evidenceItems[${i}].quote exceeds 500 characters`);
      }
      if (!isGrounded(quote, input)) {
        throw new AiAnalysisValidationError(
          `evidenceItems[${i}].quote is not grounded in the provided sources`
        );
      }

      const source =
        typeof itemRecord.source === 'string' && itemRecord.source.trim()
          ? itemRecord.source.trim()
          : 'UNKNOWN';
      if (source.length > 50) {
        throw new AiAnalysisValidationError(`evidenceItems[${i}].source exceeds 50 characters`);
      }

      let occurredAt: string | null = null;
      if (itemRecord.occurredAt !== undefined && itemRecord.occurredAt !== null) {
        if (typeof itemRecord.occurredAt !== 'string' || Number.isNaN(Date.parse(itemRecord.occurredAt))) {
          throw new AiAnalysisValidationError(`evidenceItems[${i}].occurredAt is not a valid date`);
        }
        occurredAt = new Date(itemRecord.occurredAt).toISOString();
      }

      const speaker =
        itemRecord.speaker === 'CUSTOMER' || itemRecord.speaker === 'STAFF' || itemRecord.speaker === 'UNKNOWN'
          ? itemRecord.speaker
          : 'UNKNOWN';

      let signal: string | null = null;
      if (itemRecord.signal !== undefined && itemRecord.signal !== null) {
        if (typeof itemRecord.signal !== 'string' || itemRecord.signal.length > 100) {
          throw new AiAnalysisValidationError(`evidenceItems[${i}].signal is invalid`);
        }
        signal = itemRecord.signal.trim() || null;
      }

      const itemStage = normalizeStage(itemRecord.stage, `evidenceItems[${i}].stage`);

      let weight: number | null = null;
      if (itemRecord.weight !== undefined && itemRecord.weight !== null) {
        if (
          typeof itemRecord.weight !== 'number' ||
          !Number.isFinite(itemRecord.weight) ||
          itemRecord.weight < 0 ||
          itemRecord.weight > 1
        ) {
          throw new AiAnalysisValidationError(`evidenceItems[${i}].weight must be between 0 and 1`);
        }
        weight = Math.round(itemRecord.weight * 100) / 100;
      }

      evidenceItems.push({
        quote,
        source,
        occurredAt,
        speaker,
        signal,
        stage: itemStage,
        weight,
      });
    }
  }

  // Older model outputs only provide a free-text evidence field. If it can be
  // grounded in a real source, turn it into one structured item.
  if (evidenceItems.length === 0 && input) {
    const grounded = groundEvidenceFromString(evidence, input);
    if (grounded) evidenceItems.push(grounded);
  }

  return {
    summary,
    stageSuggestion,
    currentStage,
    stopReason,
    objections,
    nextAction,
    confidence,
    evidence,
    evidenceItems,
    reason,
    // AI suggestions never mutate the official stage, regardless of model output.
    requiresVerification: true,
  };
}
