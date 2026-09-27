import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ClosingStyle,
  ObjectionStyle,
  QuestionStyle,
  SalutationRules,
  SalesStyleExample,
  SalesStyleGenerationStatus,
  SalesStyleProfileRecord,
  SalesStyleSourceRef,
  SentenceStyle,
} from '@/shared/contracts/sales-style';

interface RawActiveProfileRow {
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
  activated_at: string | null;
  activated_by_user_id: string | null;
  superseded_at: string | null;
  superseded_by_profile_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Human privileged action: activates a DRAFT sales style profile, superseding any existing ACTIVE profile for the same Sale.
 * Must be called with an authenticated user session client belonging to an active BOSS_ADMIN in the target company.
 * STRICT SECURITY: Never uses service_role key; relies on auth.uid() inside the database function.
 */
export async function activateSalesStyleProfile(
  authenticatedClient: SupabaseClient,
  profileId: string
): Promise<SalesStyleProfileRecord> {
  const { data, error } = await authenticatedClient.rpc('activate_sales_style_profile', {
    p_profile_id: profileId,
  });

  if (error) {
    throw new Error(`Failed to activate sales style profile: ${error.message} (code: ${error.code})`);
  }

  const rows = (data || []) as RawActiveProfileRow[];
  if (rows.length === 0) {
    throw new Error('activate_sales_style_profile RPC returned no rows');
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
    activatedAt: row.activated_at,
    activatedByUserId: row.activated_by_user_id,
    supersededAt: row.superseded_at,
    supersededByProfileId: row.superseded_by_profile_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
