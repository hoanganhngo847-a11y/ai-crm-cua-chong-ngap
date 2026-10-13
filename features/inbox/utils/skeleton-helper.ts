/**
 * Pure helper for evaluating syncing skeleton decisions and correlation
 * between conversation updates and interaction events.
 *
 * Used by both production InboxView and test suites to eliminate code duplication.
 */

export interface SkeletonCorrelationInput {
  conversationLastMessageAt: string | null;
  previousConversationLastMessageAt?: string | null;
  latestRenderedInteractionAtMs: number;
}

export interface SkeletonCorrelationResult {
  advanced: boolean;
  isAlreadyRendered: boolean;
  shouldScheduleSkeleton: boolean;
  newLastAtMs: number;
}

/**
 * Evaluates whether a conversation update event advances last_message_at
 * and whether a syncing skeleton should be scheduled (with anti-flicker delay)
 * or suppressed because the interaction has already been rendered.
 */
export function evaluateSkeletonCorrelation({
  conversationLastMessageAt,
  previousConversationLastMessageAt,
  latestRenderedInteractionAtMs,
}: SkeletonCorrelationInput): SkeletonCorrelationResult {
  const newLastAtMs = conversationLastMessageAt ? new Date(conversationLastMessageAt).getTime() : 0;
  const prevLastAtMs = previousConversationLastMessageAt ? new Date(previousConversationLastMessageAt).getTime() : 0;

  const advanced = Boolean(
    newLastAtMs && (!prevLastAtMs || newLastAtMs > prevLastAtMs)
  );

  const isAlreadyRendered = latestRenderedInteractionAtMs >= newLastAtMs;
  const shouldScheduleSkeleton = advanced && !isAlreadyRendered;

  return {
    advanced,
    isAlreadyRendered,
    shouldScheduleSkeleton,
    newLastAtMs,
  };
}

/**
 * Checks whether an incoming interaction has arrived in time to suppress
 * or cancel an active/pending syncing skeleton.
 */
export function shouldSuppressSkeletonForInteraction({
  interactionCreatedAt,
  conversationLastMessageAtMs,
}: {
  interactionCreatedAt: string | number;
  conversationLastMessageAtMs: number;
}): boolean {
  const createdAtMs = typeof interactionCreatedAt === 'number'
    ? interactionCreatedAt
    : new Date(interactionCreatedAt).getTime();
  return createdAtMs >= conversationLastMessageAtMs;
}
