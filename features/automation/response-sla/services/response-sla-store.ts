import 'server-only';
import { createAdminClient } from '../../../../lib/supabase/admin';
import type {
  ResponseSlaClaimDecision,
  ResponseSlaClaimResult,
  ResponseSlaDurableWindow,
  ResponseSlaWindowState,
} from '../../../../shared/contracts/response-sla';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates that an input is a valid UUID string.
 * Fails closed if missing, not a string, or unparseable.
 */
function validateUuid(val: unknown, paramName: string): string {
  if (typeof val !== 'string' || !UUID_REGEX.test(val.trim())) {
    throw new Error(`Invalid parameter "${paramName}": expected valid UUID string`);
  }
  return val.trim();
}

export interface OpenResponseSlaWindowParams {
  companyId: string;
  conversationId: string;
  triggerInteractionId: string;
}

export interface ResolveResponseSlaOnSaleReplyParams {
  companyId: string;
  conversationId: string;
  saleInteractionId: string;
}

export interface ClaimResponseSlaForAiParams {
  companyId: string;
  windowId: string;
}

/**
 * Opens a new Response SLA window for an inbound customer interaction,
 * or idempotently returns the existing OPEN window for the conversation.
 *
 * Invariants:
 * - Strictly bounded SECURITY DEFINER RPC.
 * - Single-open invariant guaranteed by partial unique index in DB.
 * - Does not reset deadline if open window already exists.
 * - Rejects non-customer, non-inbound, or mismatched interactions.
 */
export async function openResponseSlaWindow(
  params: OpenResponseSlaWindowParams
): Promise<ResponseSlaDurableWindow> {
  const companyId = validateUuid(params?.companyId, 'companyId');
  const conversationId = validateUuid(params?.conversationId, 'conversationId');
  const triggerInteractionId = validateUuid(params?.triggerInteractionId, 'triggerInteractionId');

  const adminClient = createAdminClient();
  const { data, error } = await adminClient.rpc('open_response_sla_window', {
    p_company_id: companyId,
    p_conversation_id: conversationId,
    p_trigger_interaction_id: triggerInteractionId,
  });

  if (error) {
    throw new Error(`openResponseSlaWindow failed: ${error.message}`);
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new Error('openResponseSlaWindow failed: no row returned from database');
  }

  return {
    id: row.id,
    companyId: row.company_id,
    conversationId: row.conversation_id,
    customerId: row.customer_id,
    triggerInteractionId: row.trigger_interaction_id,
    startedAt: row.started_at,
    deadlineAt: row.deadline_at,
    state: row.state as ResponseSlaWindowState,
    resolvedAt: row.resolved_at,
    saleResponseInteractionId: row.sale_response_interaction_id,
    aiResponseInteractionId: row.ai_response_interaction_id,
    aiClaimedAt: row.ai_claimed_at,
    aiClaimId: row.ai_claim_id,
    aiClaimExpiresAt: row.ai_claim_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Resolves an active OPEN Response SLA window when a Sale agent replies.
 *
 * Invariants:
 * - Transitions state -> SALE_RESPONDED.
 * - Records sale_response_interaction_id and resolved_at.
 * - If no OPEN window exists, returns null idempotently.
 * - Rejects non-sale, non-outbound, or cross-tenant interactions.
 */
export async function resolveResponseSlaOnSaleReply(
  params: ResolveResponseSlaOnSaleReplyParams
): Promise<ResponseSlaDurableWindow | null> {
  const companyId = validateUuid(params?.companyId, 'companyId');
  const conversationId = validateUuid(params?.conversationId, 'conversationId');
  const saleInteractionId = validateUuid(params?.saleInteractionId, 'saleInteractionId');

  const adminClient = createAdminClient();
  const { data, error } = await adminClient.rpc('resolve_response_sla_on_sale_reply', {
    p_company_id: companyId,
    p_conversation_id: conversationId,
    p_sale_interaction_id: saleInteractionId,
  });

  if (error) {
    throw new Error(`resolveResponseSlaOnSaleReply failed: ${error.message}`);
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    companyId: row.company_id,
    conversationId: row.conversation_id,
    customerId: row.customer_id,
    triggerInteractionId: row.trigger_interaction_id,
    startedAt: row.started_at,
    deadlineAt: row.deadline_at,
    state: row.state as ResponseSlaWindowState,
    resolvedAt: row.resolved_at,
    saleResponseInteractionId: row.sale_response_interaction_id,
    aiResponseInteractionId: row.ai_response_interaction_id,
    aiClaimedAt: row.ai_claimed_at,
    aiClaimId: row.ai_claim_id,
    aiClaimExpiresAt: row.ai_claim_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Atomically claims an expired OPEN Response SLA window for AI processing.
 *
 * Invariants:
 * - Row-level locking (FOR UPDATE) prevents race conditions between concurrent AI workers.
 * - Re-checks canonical Conversation state and latest Interaction in same transaction.
 * - If Sale already responded before claim: auto-resolves window and denies AI claim.
 * - Requires mandatory audit logging; if audit write fails, transaction rolls back fail-closed.
 * - Does NOT send any AI message (AI CLAIM != AI MESSAGE SENT).
 * - Returns only safe metadata (zero raw PII / message content / phone).
 */
export async function claimResponseSlaForAi(
  params: ClaimResponseSlaForAiParams
): Promise<ResponseSlaClaimResult> {
  const companyId = validateUuid(params?.companyId, 'companyId');
  const windowId = validateUuid(params?.windowId, 'windowId');

  const adminClient = createAdminClient();
  const { data, error } = await adminClient.rpc('claim_response_sla_for_ai', {
    p_company_id: companyId,
    p_window_id: windowId,
  });

  if (error) {
    throw new Error(`claimResponseSlaForAi failed: ${error.message}`);
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new Error('claimResponseSlaForAi failed: no row returned from database');
  }

  return {
    claimed: Boolean(row.claimed),
    decision: row.decision as ResponseSlaClaimDecision,
    windowId: row.window_id,
    claimId: row.claim_id ?? null,
    conversationId: row.conversation_id,
    customerId: row.customer_id,
    claimedAt: row.claimed_at ?? null,
    claimExpiresAt: row.claim_expires_at ?? null,
    deadlineAt: row.deadline_at,
  };
}
