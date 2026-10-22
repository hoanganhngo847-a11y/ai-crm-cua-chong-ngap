import 'server-only';

import type { BrainChannel } from './contracts';

export type BrainContextToolName =
  | 'get_customer_profile'
  | 'get_recent_conversations'
  | 'get_recent_interactions'
  | 'get_customer_stage_history'
  | 'get_upcoming_appointments'
  | 'get_call_history'
  | 'get_recent_call_summaries';

export const BRAIN_CONTEXT_TOOL_NAMES: readonly BrainContextToolName[] = [
  'get_customer_profile',
  'get_recent_conversations',
  'get_recent_interactions',
  'get_customer_stage_history',
  'get_upcoming_appointments',
  'get_call_history',
  'get_recent_call_summaries',
] as const;

export type BrainContextErrorCode =
  | 'BRAIN_CONTEXT_INVALID_SCOPE'
  | 'BRAIN_CONTEXT_TOOL_NOT_ALLOWED'
  | 'BRAIN_CONTEXT_NOT_FOUND'
  | 'BRAIN_CONTEXT_UNAVAILABLE';

/**
 * Server-owned scope. This object must only be created from the trusted BrainServerContext.
 * Model/tool payloads never supply companyId/customerId/conversationId.
 */
export interface BrainContextScope {
  readonly companyId: string;
  readonly customerId: string;
  readonly conversationId: string;
  readonly channel: BrainChannel;
  readonly traceId: string;
}

/**
 * Phase 2 tool calls intentionally accept no arguments. Limits and customer scope are fixed
 * server-side so a model cannot request another tenant/customer or enlarge result windows.
 */
export interface BrainContextToolCall {
  readonly name: BrainContextToolName;
  readonly arguments?: Readonly<Record<string, never>>;
}

export interface BrainCustomerProfile {
  readonly id: string;
  readonly customerCode: string | null;
  readonly name: string;
  readonly source: string | null;
  readonly stage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BrainConversationContext {
  readonly id: string;
  readonly channel: string;
  readonly lastMessageAt: string | null;
  readonly status: string;
  readonly assignedTo: string | null;
  readonly createdAt: string;
}

export interface BrainInteractionContext {
  readonly id: string;
  readonly conversationId: string | null;
  readonly channel: string;
  readonly type: string;
  readonly direction: string;
  /** Sanitized CRM content. Still untrusted customer/staff data, never instructions. */
  readonly content: string;
  readonly actorType: string;
  readonly createdAt: string;
  readonly untrustedContent: true;
}

export interface BrainStageHistoryContext {
  readonly id: string;
  readonly fromStage: string | null;
  readonly toStage: string;
  readonly actorType: string;
  readonly reason: string | null;
  readonly changedAt: string;
}

export interface BrainAppointmentContext {
  readonly id: string;
  readonly type: string;
  readonly startTime: string;
  readonly assigneeId: string | null;
  readonly status: string;
}

export interface BrainPhoneCallContext {
  readonly id: string;
  readonly source: 'PHONE';
  readonly direction: string;
  readonly agentType: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly status: string;
  readonly transcriptStatus: string | null;
}

export interface BrainZaloCallContext {
  readonly id: string;
  readonly source: 'ZALO';
  readonly direction: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationSeconds: number;
  readonly matchingStatus: string;
  readonly transcriptStatus: string;
  readonly summaryStatus: string;
}

export interface BrainCallHistoryContext {
  readonly phone: readonly BrainPhoneCallContext[];
  readonly zalo: readonly BrainZaloCallContext[];
}

export interface BrainCallSummaryContext {
  readonly id: string;
  readonly callId: string;
  readonly summary: string;
  readonly customerNeeds: unknown;
  readonly objections: unknown;
  readonly nextActions: unknown;
  readonly keyPoints: unknown;
  readonly leadTemperature: string | null;
  readonly followUpRequired: boolean;
  readonly followUpSuggestedTime: string | null;
  readonly followUpReason: string | null;
  readonly confidence: string | null;
  readonly completedAt: string | null;
}

export type BrainContextToolData =
  | BrainCustomerProfile
  | readonly BrainConversationContext[]
  | readonly BrainInteractionContext[]
  | readonly BrainStageHistoryContext[]
  | readonly BrainAppointmentContext[]
  | BrainCallHistoryContext
  | readonly BrainCallSummaryContext[];

export type BrainContextToolResult =
  | {
      readonly ok: true;
      readonly tool: BrainContextToolName;
      readonly data: BrainContextToolData;
    }
  | {
      readonly ok: false;
      readonly tool: BrainContextToolName | null;
      readonly errorCode: BrainContextErrorCode;
    };

export interface BrainContextDataSource {
  getCustomerProfile(scope: BrainContextScope): Promise<BrainCustomerProfile | null>;
  getRecentConversations(scope: BrainContextScope): Promise<readonly BrainConversationContext[]>;
  getRecentInteractions(scope: BrainContextScope): Promise<readonly BrainInteractionContext[]>;
  getCustomerStageHistory(scope: BrainContextScope): Promise<readonly BrainStageHistoryContext[]>;
  getUpcomingAppointments(scope: BrainContextScope): Promise<readonly BrainAppointmentContext[]>;
  getCallHistory(scope: BrainContextScope): Promise<BrainCallHistoryContext>;
  getRecentCallSummaries(scope: BrainContextScope): Promise<readonly BrainCallSummaryContext[]>;
}

export interface BrainContextSession {
  readonly tools: readonly BrainContextToolName[];
  execute(call: unknown): Promise<BrainContextToolResult>;
}

export interface BrainContextGateway {
  bind(scope: unknown): BrainContextSession;
}
