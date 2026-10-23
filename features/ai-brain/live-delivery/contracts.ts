import 'server-only';

export type LiveDeliveryChannel = 'ZALO' | 'MESSENGER';

export interface LiveDeliveryClaim {
  id: string;
  company_id: string;
  customer_id: string;
  conversation_id: string;
  source_interaction_id: string;
  channel: LiveDeliveryChannel;
  attempts: number;
}

export interface LiveDeliveryWorkerResult {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
}

export interface LiveDeliverySendParams {
  claim: LiveDeliveryClaim;
  draft: string;
  commandId: string;
  minConfidence: number;
  turnId?: string | null;
}

export interface LiveDeliverySendOutcome {
  outcome: 'SENT' | 'FAILED' | 'REJECTED' | 'SKIPPED' | 'BUSY' | 'CONFLICT' | 'UNCERTAIN';
  externalMessageId?: string | null;
  errorCode?: string | null;
}

export interface LiveDeliveryTransport {
  readonly channel: LiveDeliveryChannel;
  sendReply(params: LiveDeliverySendParams): Promise<LiveDeliverySendOutcome>;
}

/**
 * Stable server-owned workload actor ID for AI Brain live reply execution.
 * Standard RFC 4122 UUID representing the live worker identity across tenants.
 */
export const LIVE_DELIVERY_WORKLOAD_ACTOR_ID = '00000000-0000-4000-8000-0000000000a2';
