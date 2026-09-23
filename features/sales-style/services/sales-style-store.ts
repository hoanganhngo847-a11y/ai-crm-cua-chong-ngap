import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ClosingStyle,
  ObjectionStyle,
  QuestionStyle,
  SalutationRules,
  SalesStyleExample,
  SalesStyleGenerationStatus,
  SalesStyleLearningInput,
  SalesStyleOutput,
  SalesStyleProfileRecord,
  SalesStyleSource,
  SalesStyleSourceRef,
  SentenceStyle,
} from '@/shared/contracts/sales-style';

export interface FetchSalesStyleLearningInputParams {
  companyId: string;
  saleUserId: string;
  limit?: number;
}

export interface PersistSalesStyleProfileParams {
  companyId: string;
  saleUserId: string;
  sourceRefs: SalesStyleSourceRef[];
  styleOutput: SalesStyleOutput;
  modelVersion: string;
}

interface RawInputRow {
  interaction_id: string;
  channel: string;
  sanitized_content: string;
  created_at: string;
}

interface RawProfileRow {
  id: string;
  company_id: string;
  sale_user_id: string;
  version: string;
  salutation_rules: SalutationRules;
  sentence_style: SentenceStyle;
  question_style: QuestionStyle;
  objection_style: ObjectionStyle;
  closing_style: ClosingStyle;
  examples: SalesStyleExample[];
  source_refs: SalesStyleSourceRef[];
  model_version: string | null;
  generation_status: SalesStyleGenerationStatus;
  created_at: string;
  updated_at: string;
}

/**
 * Fetches bounded sanitized outbound messages for a validated active Sale via get_sales_style_learning_input RPC.
 * Fails closed if the target user is inactive, not a Sale, or belongs to a different company.
 */
export async function fetchSalesStyleLearningInput(
  client: SupabaseClient,
  params: FetchSalesStyleLearningInputParams
): Promise<SalesStyleLearningInput> {
  const { data, error } = await client.rpc('get_sales_style_learning_input', {
    p_company_id: params.companyId,
    p_sale_user_id: params.saleUserId,
    p_limit: params.limit ?? 100,
  });

  if (error) {
    throw new Error(`Failed to fetch sales style learning input: ${error.message} (code: ${error.code})`);
  }

  const rows = (data || []) as RawInputRow[];
  const sources: SalesStyleSource[] = rows.map((row) => ({
    interactionId: row.interaction_id,
    channel: row.channel,
    content: row.sanitized_content,
    createdAt: row.created_at,
  }));

  return {
    companyId: params.companyId,
    saleUserId: params.saleUserId,
    sources,
  };
}

/**
 * Persists validated Sales Style output via record_sales_style_profile RPC.
 * Enforces trusted server version generation, DB-derived examples provenance,
 * DRAFT generation status, and mandatory audit log insertion.
 */
export async function persistSalesStyleProfile(
  client: SupabaseClient,
  params: PersistSalesStyleProfileParams
): Promise<SalesStyleProfileRecord> {
  const { data, error } = await client.rpc('record_sales_style_profile', {
    p_company_id: params.companyId,
    p_sale_user_id: params.saleUserId,
    p_source_refs: params.sourceRefs,
    p_salutation_rules: params.styleOutput.salutationRules,
    p_sentence_style: params.styleOutput.sentenceStyle,
    p_question_style: params.styleOutput.questionStyle,
    p_objection_style: params.styleOutput.objectionStyle,
    p_closing_style: params.styleOutput.closingStyle,
    p_model_version: params.modelVersion,
  });

  if (error) {
    throw new Error(`Failed to persist sales style profile: ${error.message} (code: ${error.code})`);
  }

  const rows = (data || []) as RawProfileRow[];
  if (rows.length === 0) {
    throw new Error('record_sales_style_profile RPC returned no rows');
  }

  const row = rows[0];
  return {
    id: row.id,
    companyId: row.company_id,
    saleUserId: row.sale_user_id,
    version: row.version,
    salutationRules: row.salutation_rules,
    sentenceStyle: row.sentence_style,
    questionStyle: row.question_style,
    objectionStyle: row.objection_style,
    closingStyle: row.closing_style,
    examples: row.examples,
    sourceRefs: row.source_refs,
    modelVersion: row.model_version,
    generationStatus: row.generation_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
