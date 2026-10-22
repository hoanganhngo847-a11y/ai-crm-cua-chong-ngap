import 'server-only';
import type { CallSummaryStructuredOutput, LeadTemperature, ConfidenceLevel } from './types';

export const VALID_LEAD_TEMPERATURES = new Set<LeadTemperature>(['HOT', 'WARM', 'COLD']);
export const VALID_CONFIDENCE_LEVELS = new Set<ConfidenceLevel>(['LOW', 'MEDIUM', 'HIGH']);

function isStringArray(val: unknown): val is string[] {
  return Array.isArray(val) && val.every((item) => typeof item === 'string');
}

/**
 * Validates untrusted LLM output and guarantees complete compliance with
 * the canonical structured summary schema.
 *
 * Strict failure (throws Error('SUMMARY_INVALID_RESPONSE')):
 * - Non-object or array root
 * - Missing or non-string summary
 * - Empty/whitespace-only summary
 * - Summary exceeding 4000 characters
 * - Missing or non-string-array customer_needs, objections, next_actions, key_points
 * - Invalid or unknown lead_temperature enum
 * - Invalid or unknown confidence enum
 * - Malformed follow_up object or non-boolean follow_up.required
 * - Extra structural corruption
 */
export function validateCallSummaryOutput(raw: unknown): CallSummaryStructuredOutput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('SUMMARY_INVALID_RESPONSE');
  }

  const data = raw as Record<string, unknown>;

  // 1. Validate summary
  if (typeof data.summary !== 'string') {
    throw new Error('SUMMARY_INVALID_RESPONSE');
  }
  const summary = data.summary.trim();
  if (summary.length === 0 || summary.length > 4000) {
    throw new Error('SUMMARY_INVALID_RESPONSE');
  }

  // 2. Validate customer_needs
  if (!isStringArray(data.customer_needs)) {
    throw new Error('SUMMARY_INVALID_RESPONSE');
  }
  const customer_needs = data.customer_needs
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 500);

  // 3. Validate objections
  if (!isStringArray(data.objections)) {
    throw new Error('SUMMARY_INVALID_RESPONSE');
  }
  const objections = data.objections
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 500);

  // 4. Validate next_actions
  if (!isStringArray(data.next_actions)) {
    throw new Error('SUMMARY_INVALID_RESPONSE');
  }
  const next_actions = data.next_actions
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 500);

  // 5. Validate key_points
  if (!isStringArray(data.key_points)) {
    throw new Error('SUMMARY_INVALID_RESPONSE');
  }
  const key_points = data.key_points
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 500);

  // 6. Validate lead_temperature
  if (typeof data.lead_temperature !== 'string') {
    throw new Error('SUMMARY_INVALID_RESPONSE');
  }
  const lead_temperature = data.lead_temperature.trim().toUpperCase() as LeadTemperature;
  if (!VALID_LEAD_TEMPERATURES.has(lead_temperature)) {
    throw new Error('SUMMARY_INVALID_RESPONSE');
  }

  // 7. Validate follow_up
  if (!data.follow_up || typeof data.follow_up !== 'object' || Array.isArray(data.follow_up)) {
    throw new Error('SUMMARY_INVALID_RESPONSE');
  }
  const rawFollowUp = data.follow_up as Record<string, unknown>;

  if (typeof rawFollowUp.required !== 'boolean') {
    throw new Error('SUMMARY_INVALID_RESPONSE');
  }

  let suggested_time: string | null = null;
  if (rawFollowUp.suggested_time !== null && rawFollowUp.suggested_time !== undefined) {
    if (typeof rawFollowUp.suggested_time !== 'string') {
      throw new Error('SUMMARY_INVALID_RESPONSE');
    }
    const trimmedTime = rawFollowUp.suggested_time.trim();
    suggested_time = trimmedTime.length > 0 && trimmedTime.length <= 200 ? trimmedTime : null;
  }

  let reason: string | null = null;
  if (rawFollowUp.reason !== null && rawFollowUp.reason !== undefined) {
    if (typeof rawFollowUp.reason !== 'string') {
      throw new Error('SUMMARY_INVALID_RESPONSE');
    }
    const trimmedReason = rawFollowUp.reason.trim();
    reason = trimmedReason.length > 0 && trimmedReason.length <= 1000 ? trimmedReason : null;
  }

  // 8. Validate confidence
  if (typeof data.confidence !== 'string') {
    throw new Error('SUMMARY_INVALID_RESPONSE');
  }
  const confidence = data.confidence.trim().toUpperCase() as ConfidenceLevel;
  if (!VALID_CONFIDENCE_LEVELS.has(confidence)) {
    throw new Error('SUMMARY_INVALID_RESPONSE');
  }

  return {
    summary,
    customer_needs,
    objections,
    next_actions,
    lead_temperature,
    follow_up: {
      required: rawFollowUp.required,
      suggested_time,
      reason,
    },
    key_points,
    confidence,
  };
}
