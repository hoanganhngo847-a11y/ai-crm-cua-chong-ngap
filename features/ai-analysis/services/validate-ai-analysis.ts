import {
  AI_ANALYSIS_STAGE_SUGGESTIONS,
  type AiAnalysisStageSuggestion,
  type AiCustomerAnalysisOutput,
} from '@/shared/contracts/ai-analysis';

export class AiAnalysisValidationError extends Error {
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'AiAnalysisValidationError';
  }
}

/**
 * Validates untrusted LLM output and guarantees adherence to canonical data constraints.
 * Fails closed on any structural anomaly or domain rule violation.
 *
 * NOTE: modelVersion is NOT validated or extracted from untrusted model output.
 * Model provenance is bound strictly by the trusted runtime environment.
 */
export function validateAiAnalysisOutput(raw: unknown): AiCustomerAnalysisOutput {
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
  // Round to 2 decimal places to match numeric(3,2)
  const confidence = Math.round(record.confidence * 100) / 100;

  // 3. Stage suggestion validation (canonical allowlist or null)
  let stageSuggestion: AiAnalysisStageSuggestion | null = null;
  if (record.stageSuggestion !== undefined && record.stageSuggestion !== null) {
    if (typeof record.stageSuggestion !== 'string') {
      throw new AiAnalysisValidationError('stageSuggestion must be a string or null');
    }
    const stageStr = record.stageSuggestion.trim();
    if (!AI_ANALYSIS_STAGE_SUGGESTIONS.includes(stageStr as AiAnalysisStageSuggestion)) {
      throw new AiAnalysisValidationError(
        `stageSuggestion "${stageStr}" is not in the canonical stage allowlist`
      );
    }
    stageSuggestion = stageStr as AiAnalysisStageSuggestion;
  }

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

  // 7. Evidence validation (required, non-empty, bounded <= 5000 chars)
  if (typeof record.evidence !== 'string' || record.evidence.trim().length === 0) {
    throw new AiAnalysisValidationError('Evidence must be a non-empty string');
  }
  const evidence = record.evidence.trim();
  if (evidence.length > 5000) {
    throw new AiAnalysisValidationError('Evidence exceeds maximum length of 5000 characters');
  }

  return {
    summary,
    stageSuggestion,
    stopReason,
    objections,
    nextAction,
    confidence,
    evidence,
  };
}
