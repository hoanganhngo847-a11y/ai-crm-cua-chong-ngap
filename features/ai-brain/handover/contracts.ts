import 'server-only';

export const HANDOVER_REASONS = [
  'CUSTOMER_REQUESTED_HUMAN',
  'CUSTOMER_COMPLAINT',
  'REFUND_REQUEST',
  'PRICE_QUOTATION_REQUIRED',
  'LEGAL_OR_POLICY',
  'PAYMENT_ISSUE',
  'LOW_CONFIDENCE',
  'INSUFFICIENT_KNOWLEDGE',
  'HIGH_VALUE_LEAD',
  'OTHER',
] as const;

export type HandoverReason = (typeof HANDOVER_REASONS)[number];

export const HANDOVER_PRIORITIES = ['URGENT', 'HIGH', 'NORMAL', 'LOW'] as const;

export type HandoverPriority = (typeof HANDOVER_PRIORITIES)[number];

export const HANDOVER_CASE_STATUSES = [
  'OPEN',
  'CLAIMED',
  'RESOLVED',
  'DISMISSED',
] as const;

export type HandoverCaseStatus = (typeof HANDOVER_CASE_STATUSES)[number];

export interface AiHandoverCase {
  readonly id: string;
  readonly companyId: string;
  readonly customerId: string;
  readonly conversationId: string;
  readonly sourceInteractionId: string;
  readonly reason: HandoverReason;
  readonly priority: HandoverPriority;
  readonly status: HandoverCaseStatus;
  readonly assignedTo: string | null;
  readonly brainTurnId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly claimedAt: string | null;
  readonly resolvedAt: string | null;
  readonly updatedAt: string;
}

export interface CreateHandoverCaseParams {
  readonly companyId: string;
  readonly customerId: string;
  readonly conversationId: string;
  readonly sourceInteractionId: string;
  readonly reason: HandoverReason;
  readonly priority: HandoverPriority;
  readonly brainTurnId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ClaimHandoverCaseParams {
  readonly companyId: string;
  readonly caseId: string;
  readonly userId: string;
}

export interface ResumeAiConversationParams {
  readonly companyId: string;
  readonly conversationId: string;
  readonly userId?: string | null;
}

export interface ListHandoverCasesParams {
  readonly companyId: string;
  readonly status?: HandoverCaseStatus | readonly HandoverCaseStatus[];
  readonly priority?: HandoverPriority;
  readonly assignedTo?: string | null;
  readonly limit?: number;
  readonly offset?: number;
}
