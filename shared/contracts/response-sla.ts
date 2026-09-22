export const RESPONSE_SLA_LIMIT_SECONDS = 5 * 60;

export type ResponseSlaWindowState =
  | 'OPEN'
  | 'SALE_RESPONDED'
  | 'AI_RESPONDED'
  | 'CANCELLED';

export type ResponseSlaAiDecision =
  | 'ALLOW_AI_REPLY'
  | 'NOT_DUE'
  | 'SALE_ALREADY_RESPONDED'
  | 'WINDOW_ALREADY_RESOLVED'
  | 'CONVERSATION_CLOSED'
  | 'AI_ALREADY_HANDLING';

export type ResponseSlaConversationStatus =
  | 'OPEN'
  | 'PENDING_SALE'
  | 'AI_HANDLING'
  | 'CLOSED';

export interface ResponseSlaWindowSnapshot {
  conversationId: string;
  customerId: string;

  triggerInteractionId: string;

  startedAt: string;
  deadlineAt: string;

  state: ResponseSlaWindowState;

  resolvedAt: string | null;
  saleResponseInteractionId: string | null;
  aiResponseInteractionId: string | null;
}

export interface ResponseSlaEvaluation {
  decision: ResponseSlaAiDecision;
  evaluatedAt: string;
  elapsedSeconds: number;
  deadlineAt: string;
}
