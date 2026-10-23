import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AiHandoverCase,
  ClaimHandoverCaseParams,
  CreateHandoverCaseParams,
  ListHandoverCasesParams,
  ResumeAiConversationParams,
} from './contracts';

function mapCaseRow(row: Record<string, unknown>): AiHandoverCase {
  return Object.freeze({
    id: String(row.id),
    companyId: String(row.company_id),
    customerId: String(row.customer_id),
    conversationId: String(row.conversation_id),
    sourceInteractionId: String(row.source_interaction_id),
    reason: row.reason as AiHandoverCase['reason'],
    priority: row.priority as AiHandoverCase['priority'],
    status: row.status as AiHandoverCase['status'],
    assignedTo: (row.assigned_to as string | null) ?? null,
    brainTurnId: (row.brain_turn_id as string | null) ?? null,
    metadata: Object.freeze(
      typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {}
    ),
    createdAt: String(row.created_at),
    claimedAt: (row.claimed_at as string | null) ?? null,
    resolvedAt: (row.resolved_at as string | null) ?? null,
    updatedAt: String(row.updated_at),
  });
}

export async function createHandoverCase(
  client: SupabaseClient,
  params: CreateHandoverCaseParams
): Promise<string> {
  const { data, error } = await client.rpc('create_ai_handover_case', {
    p_company_id: params.companyId,
    p_customer_id: params.customerId,
    p_conversation_id: params.conversationId,
    p_source_interaction_id: params.sourceInteractionId,
    p_reason: params.reason,
    p_priority: params.priority,
    p_brain_turn_id: params.brainTurnId ?? null,
    p_metadata: params.metadata ?? {},
  });

  if (error || !data) {
    throw new Error(error ? `HANDOVER_CASE_CREATE_FAILED: ${error.message}` : 'HANDOVER_CASE_CREATE_FAILED');
  }

  return String(data);
}

export async function claimHandoverCase(
  client: SupabaseClient,
  params: ClaimHandoverCaseParams
): Promise<boolean> {
  const { data, error } = await client.rpc('claim_ai_handover_case', {
    p_company_id: params.companyId,
    p_case_id: params.caseId,
    p_user_id: params.userId,
  });

  if (error) {
    throw new Error(`HANDOVER_CASE_CLAIM_FAILED: ${error.message}`);
  }

  return data === true;
}

export async function resumeAiConversation(
  client: SupabaseClient,
  params: ResumeAiConversationParams
): Promise<boolean> {
  const { data, error } = await client.rpc('resume_ai_conversation', {
    p_company_id: params.companyId,
    p_conversation_id: params.conversationId,
    p_user_id: params.userId ?? null,
  });

  if (error) {
    throw new Error(`RESUME_AI_FAILED: ${error.message}`);
  }

  return data === true;
}

export async function listHandoverCases(
  client: SupabaseClient,
  params: ListHandoverCasesParams
): Promise<readonly AiHandoverCase[]> {
  let query = client
    .from('ai_handover_cases')
    .select('*')
    .eq('company_id', params.companyId);

  if (params.status) {
    if (Array.isArray(params.status)) {
      query = query.in('status', params.status);
    } else {
      query = query.eq('status', params.status);
    }
  }

  if (params.priority) {
    query = query.eq('priority', params.priority);
  }

  if (params.assignedTo !== undefined) {
    if (params.assignedTo === null) {
      query = query.is('assigned_to', null);
    } else {
      query = query.eq('assigned_to', params.assignedTo);
    }
  }

  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const offset = Math.max(params.offset ?? 0, 0);

  query = query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) {
    throw new Error(`LIST_HANDOVER_CASES_FAILED: ${error.message}`);
  }

  return Object.freeze((data || []).map((row) => mapCaseRow(row as Record<string, unknown>)));
}

export async function getActiveHandoverCaseForConversation(
  client: SupabaseClient,
  companyId: string,
  conversationId: string
): Promise<AiHandoverCase | null> {
  const { data, error } = await client
    .from('ai_handover_cases')
    .select('*')
    .eq('company_id', companyId)
    .eq('conversation_id', conversationId)
    .in('status', ['OPEN', 'CLAIMED'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`GET_ACTIVE_HANDOVER_CASE_FAILED: ${error.message}`);
  }

  return data ? mapCaseRow(data as Record<string, unknown>) : null;
}
