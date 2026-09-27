import {
  RESPONSE_SLA_LIMIT_SECONDS,
  type ResponseSlaConversationStatus,
  type ResponseSlaEvaluation,
  type ResponseSlaWindowSnapshot,
  type ResponseSlaWindowState,
} from '../../../../shared/contracts/response-sla';

const VALID_WINDOW_STATES: ReadonlySet<ResponseSlaWindowState> = new Set([
  'OPEN',
  'SALE_RESPONDED',
  'AI_RESPONDED',
  'CANCELLED',
]);

const VALID_CONVERSATION_STATUSES: ReadonlySet<ResponseSlaConversationStatus> = new Set([
  'OPEN',
  'PENDING_SALE',
  'AI_HANDLING',
  'CLOSED',
]);

/**
 * Parses and validates an ISO timestamp or Date instance.
 * Fails closed by throwing an Error if the timestamp is missing, unparseable, or invalid.
 */
function parseTimestamp(input: string | Date, paramName: string): Date {
  if (input instanceof Date) {
    if (isNaN(input.getTime())) {
      throw new Error(`Invalid timestamp for ${paramName}: Date instance is NaN`);
    }
    return input;
  }

  if (typeof input !== 'string' || !input.trim()) {
    throw new Error(`Invalid timestamp for ${paramName}: Expected non-empty string or Date`);
  }

  const parsed = new Date(input);
  if (isNaN(parsed.getTime())) {
    throw new Error(`Invalid timestamp for ${paramName}: Unable to parse "${input}"`);
  }

  return parsed;
}

/**
 * Calculates the exact Response SLA deadline from the trigger interaction timestamp.
 *
 * Requirements:
 * - Deadline = startedAt + exactly 300 seconds (RESPONSE_SLA_LIMIT_SECONDS).
 * - Invalid timestamp fails closed (throws Error).
 */
export function calculateResponseSlaDeadline(startedAt: string): string {
  const startDate = parseTimestamp(startedAt, 'startedAt');
  const deadlineMs = startDate.getTime() + RESPONSE_SLA_LIMIT_SECONDS * 1000;
  return new Date(deadlineMs).toISOString();
}

/**
 * Pure evaluator for 5-minute Response SLA.
 *
 * Rules:
 * 1. Timestamp invalid fails closed (throws Error).
 * 2. elapsedSeconds is strictly non-negative (Math.max(0, ...)).
 * 3. If window === 'SALE_RESPONDED' -> SALE_ALREADY_RESPONDED.
 * 4. If window !== 'OPEN' -> WINDOW_ALREADY_RESOLVED (e.g., AI_RESPONDED, CANCELLED).
 * 5. Conversation CLOSED -> CONVERSATION_CLOSED.
 * 6. Conversation AI_HANDLING -> AI_ALREADY_HANDLING.
 * 7. If now < deadline -> NOT_DUE.
 * 8. If now >= deadline -> ALLOW_AI_REPLY.
 *
 * Purity constraints:
 * - Pure deterministic evaluation.
 * - No database queries.
 * - No external network / OpenAI calls.
 * - No Supabase client / service-role usage.
 */
export function evaluateResponseSla(
  window: ResponseSlaWindowSnapshot,
  conversationStatus: ResponseSlaConversationStatus,
  now: string | Date = new Date()
): ResponseSlaEvaluation {
  if (!window || typeof window !== 'object') {
    throw new Error('Invalid window snapshot: snapshot must be an object');
  }

  if (!VALID_WINDOW_STATES.has(window.state)) {
    throw new Error(`Invalid window state: "${window.state}"`);
  }

  if (!VALID_CONVERSATION_STATUSES.has(conversationStatus)) {
    throw new Error(`Invalid conversation status: "${conversationStatus}"`);
  }

  const startDate = parseTimestamp(window.startedAt, 'window.startedAt');
  const deadlineDate = parseTimestamp(window.deadlineAt, 'window.deadlineAt');

  if (deadlineDate.getTime() < startDate.getTime()) {
    throw new Error('Invalid deadline: deadlineAt cannot be earlier than startedAt');
  }

  const nowDate = parseTimestamp(now, 'now');
  const nowMs = nowDate.getTime();
  const startedMs = startDate.getTime();
  const deadlineMs = deadlineDate.getTime();

  // Elapsed seconds cannot be negative
  const diffSeconds = Math.floor((nowMs - startedMs) / 1000);
  const elapsedSeconds = Math.max(0, diffSeconds);

  // 1. If Sale already responded, window is resolved with Sale victory
  if (window.state === 'SALE_RESPONDED') {
    return {
      decision: 'SALE_ALREADY_RESPONDED',
      evaluatedAt: nowDate.toISOString(),
      elapsedSeconds,
      deadlineAt: window.deadlineAt,
    };
  }

  // 2. If window is not OPEN (e.g. AI_RESPONDED or CANCELLED)
  if (window.state !== 'OPEN') {
    return {
      decision: 'WINDOW_ALREADY_RESOLVED',
      evaluatedAt: nowDate.toISOString(),
      elapsedSeconds,
      deadlineAt: window.deadlineAt,
    };
  }

  // 3. Conversation is CLOSED
  if (conversationStatus === 'CLOSED') {
    return {
      decision: 'CONVERSATION_CLOSED',
      evaluatedAt: nowDate.toISOString(),
      elapsedSeconds,
      deadlineAt: window.deadlineAt,
    };
  }

  // 4. Conversation is currently handled by AI
  if (conversationStatus === 'AI_HANDLING') {
    return {
      decision: 'AI_ALREADY_HANDLING',
      evaluatedAt: nowDate.toISOString(),
      elapsedSeconds,
      deadlineAt: window.deadlineAt,
    };
  }

  // 5. Check SLA deadline (OPEN or PENDING_SALE conversation with OPEN window)
  if (nowMs < deadlineMs) {
    return {
      decision: 'NOT_DUE',
      evaluatedAt: nowDate.toISOString(),
      elapsedSeconds,
      deadlineAt: window.deadlineAt,
    };
  }

  // 6. Deadline reached or passed -> AI is eligible to be considered for reply
  return {
    decision: 'ALLOW_AI_REPLY',
    evaluatedAt: nowDate.toISOString(),
    elapsedSeconds,
    deadlineAt: window.deadlineAt,
  };
}
