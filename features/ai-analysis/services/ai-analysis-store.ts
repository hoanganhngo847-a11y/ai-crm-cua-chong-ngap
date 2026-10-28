import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AiAnalysisEvidenceItem,
  AiAnalysisInput,
  AiAnalysisRecord,
  AiAnalysisSource,
  AiAnalysisSourceRef,
  AiCustomerAnalysisOutput,
  AiCustomerContext,
} from '@/shared/contracts/ai-analysis';
import { tryToCanonicalStage } from '@/features/crm/types/customer.types';

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
  classifierVersion?: string | null;
  dedupeKey?: string | null;
  previousAnalysisId?: string | null;
}

interface RawInputRow {
  interaction_id: string;
  conversation_id: string | null;
  channel: string;
  direction: 'INBOUND' | 'OUTBOUND';
  actor_type: 'CUSTOMER' | 'SALE' | 'AI' | 'SYSTEM' | 'TECHNICIAN';
  sanitized_content: string;
  created_at: string;
}

interface RawTranscriptRow {
  utterance_id: string;
  transcription_id: string;
  call_id: string;
  customer_id: string;
  speaker_role: 'STAFF' | 'CUSTOMER';
  utterance_channel: 'LEFT' | 'RIGHT';
  utterance_text: string;
  sequence: number;
  start_ms: number;
  end_ms: number;
  confidence: number | string | null;
  created_at: string;
}

interface RawRecordRow {
  id: string;
  company_id: string;
  customer_id: string;
  source_refs: AiAnalysisSourceRef[];
  summary: string;
  stage_suggestion: string | null;
  current_stage: string | null;
  stop_reason: string | null;
  objections: string[];
  next_action: string | null;
  confidence: number | string;
  evidence: string;
  evidence_items: unknown;
  reason: string | null;
  requires_verification: boolean;
  verification_status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'NOT_REQUIRED';
  classifier_version: string | null;
  dedupe_key: string | null;
  model_version: string;
  created_at: string;
}

function isMissingRpcError(error: { message?: string; code?: string } | null | undefined): boolean {
  const message = String(error?.message || '').toLowerCase();
  const code = String(error?.code || '');
  return (
    code === 'PGRST202' ||
    message.includes('could not find the function') ||
    message.includes('does not exist')
  );
}

function mapEvidenceItems(raw: unknown): AiAnalysisEvidenceItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .map((item): AiAnalysisEvidenceItem => ({
      quote: String(item.quote || ''),
      source: String(item.source || 'UNKNOWN'),
      occurredAt: item.occurredAt ? String(item.occurredAt) : null,
      speaker:
        item.speaker === 'CUSTOMER' || item.speaker === 'STAFF' || item.speaker === 'UNKNOWN'
          ? item.speaker
          : 'UNKNOWN',
      signal: item.signal ? String(item.signal) : null,
      stage: tryToCanonicalStage(item.stage),
      weight: item.weight !== null && item.weight !== undefined ? Number(item.weight) : null,
    }))
    .filter((item) => item.quote.trim().length > 0);
}

/**
 * Fetches bounded sanitized input for AI analysis:
 * - sanitized MESSAGE interactions via get_ai_analysis_input
 * - completed Zalo call transcript utterances via get_customer_call_transcript_input
 *
 * Guaranteed to return only non-sensitive data and fail closed on tenant/customer mismatch.
 */
export async function fetchAiAnalysisInput(
  client: SupabaseClient,
  params: GetAiAnalysisInputParams
): Promise<AiAnalysisInput> {
  const limit = params.limit ?? 50;

  const { data, error } = await client.rpc('get_ai_analysis_input', {
    p_company_id: params.companyId,
    p_customer_id: params.customerId,
    p_limit: limit,
  });

  if (error) {
    throw new Error(`Failed to fetch AI analysis input: ${error.message} (code: ${error.code})`);
  }

  // Safe customer context is fetched after the tenant-checked RPC so transcript-only
  // customers still work without weakening tenant isolation.
  const { data: custData, error: custError } = await client
    .from('customers')
    .select('id, customer_code, name, source, stage')
    .eq('id', params.customerId)
    .eq('company_id', params.companyId)
    .single();

  if (custError || !custData) {
    throw new Error(
      `Customer not found for AI analysis context: ${custError?.message || 'CUSTOMER_NOT_FOUND'}`
    );
  }

  const customer: AiCustomerContext = {
    customerId: custData.id,
    customerCode: custData.customer_code,
    name: custData.name,
    source: custData.source,
    stage: custData.stage,
  };

  const interactionRows = (data || []) as RawInputRow[];
  const sources: AiAnalysisSource[] = interactionRows.map((row) => ({
    sourceType: 'INTERACTION',
    interactionId: row.interaction_id,
    conversationId: row.conversation_id,
    channel: row.channel,
    direction: row.direction,
    actorType: row.actor_type,
    content: row.sanitized_content,
    createdAt: row.created_at,
  }));

  const { data: transcriptData, error: transcriptError } = await client.rpc(
    'get_customer_call_transcript_input',
    {
      p_company_id: params.companyId,
      p_customer_id: params.customerId,
      p_limit: limit,
    }
  );

  if (transcriptError) {
    if (!isMissingRpcError(transcriptError)) {
      throw new Error(
        `Failed to fetch call transcript input: ${transcriptError.message} (code: ${transcriptError.code})`
      );
    }
  } else if (Array.isArray(transcriptData)) {
    for (const row of transcriptData as RawTranscriptRow[]) {
      sources.push({
        sourceType: 'CALL_TRANSCRIPT_UTTERANCE',
        interactionId: row.utterance_id,
        utteranceId: row.utterance_id,
        conversationId: null,
        channel: 'ZALO_CALL',
        direction: row.speaker_role === 'CUSTOMER' ? 'INBOUND' : 'OUTBOUND',
        actorType: row.speaker_role === 'CUSTOMER' ? 'CUSTOMER' : 'SALE',
        speakerRole: row.speaker_role,
        content: row.utterance_text,
        createdAt: row.created_at,
      });
    }
  }

  // Bound the merged set to the latest N sources, then return chronological ASC.
  const boundedSources = sources
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  return {
    companyId: params.companyId,
    customer,
    sources: boundedSources,
  };
}

/**
 * Persists validated AI analysis output into public.ai_analyses via the record_ai_analysis RPC.
 * Enforces append-only storage, trusted model provenance, dedupe idempotency, and
 * zero customer stage mutations.
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
    p_current_stage: params.analysis.currentStage || null,
    p_reason: params.analysis.reason || null,
    p_requires_verification: true,
    p_evidence_items: params.analysis.evidenceItems || [],
    p_dedupe_key: params.dedupeKey || null,
    p_classifier_version: params.classifierVersion || null,
    p_previous_analysis_id: params.previousAnalysisId || null,
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
    stageSuggestion: tryToCanonicalStage(row.stage_suggestion),
    currentStage: tryToCanonicalStage(row.current_stage),
    stopReason: row.stop_reason,
    objections: row.objections,
    nextAction: row.next_action,
    confidence: Number(row.confidence),
    evidence: row.evidence,
    evidenceItems: mapEvidenceItems(row.evidence_items),
    reason: row.reason,
    requiresVerification: row.requires_verification !== false,
    verificationStatus: row.verification_status || 'PENDING',
    classifierVersion: row.classifier_version || null,
    dedupeKey: row.dedupe_key || null,
    modelVersion: row.model_version,
    createdAt: row.created_at,
  };
}
