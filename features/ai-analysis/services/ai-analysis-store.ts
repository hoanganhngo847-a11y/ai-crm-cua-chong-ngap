import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AiAnalysisInput,
  AiAnalysisRecord,
  AiAnalysisSource,
  AiAnalysisSourceRef,
  AiCustomerAnalysisOutput,
  AiCustomerContext,
} from '@/shared/contracts/ai-analysis';

export interface GetAiAnalysisInputParams {
  companyId: string;
  customerId: string;
  limit?: number;
}

export interface PersistAiAnalysisParams {
  companyId: string;
  customerId: string;
  sourceRefs: AiAnalysisSourceRef[];
  analysis: AiCustomerAnalysisOutput;
  modelVersion: string;
}

interface RawInputRow {
  interaction_id: string;
  conversation_id: string | null;
  channel: string;
  direction: 'INBOUND' | 'OUTBOUND';
  actor_type: 'CUSTOMER' | 'SALE' | 'AI' | 'SYSTEM' | 'TECHNICIAN';
  sanitized_content: string;
  created_at: string;
  customer_id: string;
  customer_code: string;
  name: string;
  source: string;
  stage: string;
}

interface RawRecordRow {
  id: string;
  company_id: string;
  customer_id: string;
  source_refs: AiAnalysisSourceRef[];
  summary: string;
  stage_suggestion: string | null;
  stop_reason: string | null;
  objections: string[];
  next_action: string | null;
  confidence: number | string;
  evidence: string;
  model_version: string;
  created_at: string;
}

/**
 * Fetches bounded sanitized input for AI analysis via the get_ai_analysis_input RPC.
 * Guaranteed to return only non-sensitive data and fail closed on tenant/customer mismatch.
 */
export async function fetchAiAnalysisInput(
  client: SupabaseClient,
  params: GetAiAnalysisInputParams
): Promise<AiAnalysisInput> {
  const { data, error } = await client.rpc('get_ai_analysis_input', {
    p_company_id: params.companyId,
    p_customer_id: params.customerId,
    p_limit: params.limit ?? 50,
  });

  if (error) {
    throw new Error(`Failed to fetch AI analysis input: ${error.message} (code: ${error.code})`);
  }

  const rows = (data || []) as RawInputRow[];

  let customer: AiCustomerContext;
  const sources: AiAnalysisSource[] = [];

  if (rows.length > 0) {
    customer = {
      customerId: rows[0].customer_id,
      customerCode: rows[0].customer_code,
      name: rows[0].name,
      source: rows[0].source,
      stage: rows[0].stage,
    };

    for (const row of rows) {
      sources.push({
        interactionId: row.interaction_id,
        conversationId: row.conversation_id,
        channel: row.channel,
        direction: row.direction,
        actorType: row.actor_type,
        content: row.sanitized_content,
        createdAt: row.created_at,
      });
    }
  } else {
    // If no interactions matched sanitization criteria, fetch safe customer context
    const { data: custData, error: custError } = await client
      .from('customers')
      .select('id, customer_code, name, source, stage')
      .eq('id', params.customerId)
      .eq('company_id', params.companyId)
      .single();

    if (custError || !custData) {
      throw new Error(`Customer not found for AI analysis context: ${custError?.message}`);
    }

    customer = {
      customerId: custData.id,
      customerCode: custData.customer_code,
      name: custData.name,
      source: custData.source,
      stage: custData.stage,
    };
  }

  return {
    companyId: params.companyId,
    customer,
    sources,
  };
}

/**
 * Persists validated AI analysis output into public.ai_analyses via the record_ai_analysis RPC.
 * Enforces append-only storage, trusted model provenance, and zero customer stage mutations.
 */
export async function persistAiAnalysis(
  client: SupabaseClient,
  params: PersistAiAnalysisParams
): Promise<AiAnalysisRecord> {
  const { data, error } = await client.rpc('record_ai_analysis', {
    p_company_id: params.companyId,
    p_customer_id: params.customerId,
    p_source_refs: params.sourceRefs,
    p_summary: params.analysis.summary,
    p_stage_suggestion: params.analysis.stageSuggestion,
    p_stop_reason: params.analysis.stopReason,
    p_objections: params.analysis.objections,
    p_next_action: params.analysis.nextAction,
    p_confidence: params.analysis.confidence,
    p_evidence: params.analysis.evidence,
    p_model_version: params.modelVersion,
  });

  if (error) {
    throw new Error(`Failed to persist AI analysis: ${error.message} (code: ${error.code})`);
  }

  const rows = (data || []) as RawRecordRow[];
  if (rows.length === 0) {
    throw new Error('record_ai_analysis RPC returned no rows');
  }

  const row = rows[0];
  return {
    id: row.id,
    companyId: row.company_id,
    customerId: row.customer_id,
    sourceRefs: row.source_refs,
    summary: row.summary,
    stageSuggestion: row.stage_suggestion as AiAnalysisRecord['stageSuggestion'],
    stopReason: row.stop_reason,
    objections: row.objections,
    nextAction: row.next_action,
    confidence: Number(row.confidence),
    evidence: row.evidence,
    modelVersion: row.model_version,
    createdAt: row.created_at,
  };
}
