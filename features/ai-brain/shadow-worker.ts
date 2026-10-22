import 'server-only';

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../lib/supabase/admin';
import type {
  BrainChannel,
  BrainConversationState,
  BrainProvider,
  BrainServerContext,
  BrainTurnResult,
} from './contracts';
import { JavisBrainProvider } from './javis-provider';
import { createBrainService } from './service';

interface ShadowClaim {
  id: string;
  company_id: string;
  customer_id: string;
  conversation_id: string;
  source_interaction_id: string;
  channel: 'MESSENGER' | 'ZALO';
  attempts: number;
}

interface EligibleShadowInput {
  text: string;
  context: BrainServerContext;
}

/**
 * Documented stable server-owned workload actor ID for AI Brain shadow execution.
 * Standard UUID representing the background shadow worker workload identity across tenants.
 */
export const SHADOW_WORKLOAD_ACTOR_ID = '00000000-0000-4000-8000-0000000000a1';

export interface ShadowWorkerResult {
  claimed: number;
  completed: number;
  skipped: number;
  failed: number;
}

export interface ShadowWorkerOptions {
  supabase?: SupabaseClient;
  provider?: BrainProvider;
}

function productionProvider(): BrainProvider | undefined {
  const baseUrl = process.env.JAVIS_BRAIN_BASE_URL?.trim();
  const authToken = process.env.JAVIS_BRAIN_INTERNAL_TOKEN?.trim();
  if (!baseUrl || !authToken) return undefined;
  try {
    return new JavisBrainProvider({ baseUrl, authToken });
  } catch {
    return undefined;
  }
}

function expectedInteractionChannel(channel: ShadowClaim['channel']): 'FACEBOOK' | 'ZALO' {
  return channel === 'MESSENGER' ? 'FACEBOOK' : 'ZALO';
}

function conversationState(status: string, assignedTo: string | null): BrainConversationState {
  if (status === 'CLOSED') return 'AI_PAUSED';
  if (status === 'PENDING_SALE' || assignedTo) return 'HUMAN_ACTIVE';
  return 'AI_ACTIVE';
}

async function loadEligibleInput(client: SupabaseClient, claim: ShadowClaim): Promise<EligibleShadowInput | null> {
  const { data: setting, error: settingError } = await client
    .from('ai_brain_shadow_settings')
    .select('enabled')
    .eq('company_id', claim.company_id)
    .eq('channel', claim.channel)
    .maybeSingle();
  if (settingError) throw new Error('SHADOW_SETTING_LOOKUP_FAILED');
  if (!setting?.enabled) return null;

  const { data: conversation, error: conversationError } = await client
    .from('conversations')
    .select('id,company_id,customer_id,channel,status,assigned_to')
    .eq('id', claim.conversation_id)
    .eq('company_id', claim.company_id)
    .eq('customer_id', claim.customer_id)
    .maybeSingle();
  if (conversationError || !conversation) throw new Error('SHADOW_SCOPE_INVALID');
  if (conversation.channel !== expectedInteractionChannel(claim.channel)) {
    throw new Error('SHADOW_SCOPE_INVALID');
  }

  const { data: interaction, error: interactionError } = await client
    .from('interactions')
    .select('id,company_id,customer_id,conversation_id,channel,type,direction,actor_type,sanitization_status,sanitized_content')
    .eq('id', claim.source_interaction_id)
    .eq('company_id', claim.company_id)
    .eq('customer_id', claim.customer_id)
    .eq('conversation_id', claim.conversation_id)
    .maybeSingle();
  if (interactionError || !interaction) throw new Error('SHADOW_SOURCE_INVALID');
  if (
    interaction.channel !== expectedInteractionChannel(claim.channel) ||
    interaction.type !== 'MESSAGE' ||
    interaction.direction !== 'INBOUND' ||
    interaction.actor_type !== 'CUSTOMER' ||
    interaction.sanitization_status !== 'SUCCEEDED' ||
    typeof interaction.sanitized_content !== 'string' ||
    !interaction.sanitized_content.trim()
  ) {
    throw new Error('SHADOW_SOURCE_INVALID');
  }

  const state = conversationState(conversation.status, conversation.assigned_to);
  return {
    text: interaction.sanitized_content,
    context: Object.freeze({
      companyId: conversation.company_id,
      customerId: conversation.customer_id,
      conversationId: conversation.id,
      channel: claim.channel as BrainChannel,
      modality: 'TEXT',
      caller: Object.freeze({ actorId: SHADOW_WORKLOAD_ACTOR_ID, actorType: 'WORKLOAD' }),
      permissionProfile: 'READ_ONLY',
      conversationState: state,
      allowDrafts: state !== 'AI_PAUSED',
      traceId: randomUUID(),
    }),
  };
}

async function finish(
  client: SupabaseClient,
  claim: ShadowClaim,
  lockToken: string,
  status: 'COMPLETED' | 'SKIPPED' | 'FAILED',
  result?: BrainTurnResult,
): Promise<void> {
  const { data, error } = await client.rpc('finish_ai_brain_shadow_run', {
    p_id: claim.id,
    p_lock_token: lockToken,
    p_status: status,
    p_decision: result?.decision ?? null,
    p_draft: status === 'COMPLETED' && result?.delivery === 'DRAFT_ONLY' ? result.draft ?? null : null,
    p_confidence: result?.confidence ?? null,
    p_handover_required: result?.handoverRequired ?? null,
    p_handover_reason: result?.handoverReason ?? null,
    p_provider: result?.provider ?? null,
    p_model: result?.model ?? null,
    p_latency_ms: result ? Math.round(result.latencyMs) : null,
    p_error_code: result?.errorCode ?? null,
    p_turn_id: result?.turnId ?? null,
    p_trace_id: result?.traceId ?? null,
    p_tools_used: result?.toolsUsed ?? [],
    p_source_references: result?.sourceReferences ?? [],
    p_memory_references: result?.memoryReferences ?? [],
  });
  if (error || data !== true) throw new Error('SHADOW_FINISH_FENCED');
}

async function processClaim(
  client: SupabaseClient,
  claim: ShadowClaim,
  lockToken: string,
  provider: BrainProvider | undefined,
): Promise<'completed' | 'skipped' | 'failed'> {
  let eligible: EligibleShadowInput | null;
  try {
    eligible = await loadEligibleInput(client, claim);
  } catch {
    const result = await createBrainService({
      resolveContext: async () => { throw new Error('INVALID_CONTEXT'); },
      provider,
    }).handleBrainTurn({
      customerId: claim.customer_id,
      conversationId: claim.conversation_id,
      channel: claim.channel,
      modality: 'TEXT',
      input: { text: '[invalid shadow source]' },
    });
    await finish(client, claim, lockToken, 'FAILED', result);
    return 'failed';
  }

  if (!eligible) {
    await finish(client, claim, lockToken, 'SKIPPED');
    return 'skipped';
  }

  const service = createBrainService({
    provider,
    timeoutMs: 5000,
    resolveContext: async (selector) => {
      if (
        selector.customerId !== eligible.context.customerId ||
        selector.conversationId !== eligible.context.conversationId ||
        selector.channel !== eligible.context.channel ||
        selector.modality !== 'TEXT'
      ) {
        throw new Error('INVALID_CONTEXT');
      }
      return eligible.context;
    },
  });

  const result = await service.handleBrainTurn({
    customerId: claim.customer_id,
    conversationId: claim.conversation_id,
    channel: claim.channel,
    modality: 'TEXT',
    latency: 'STANDARD',
    requestedCapability: 'READ_ONLY',
    input: { text: eligible.text },
  });

  const terminal = result.decision === 'ERROR' ? 'FAILED' : 'COMPLETED';
  await finish(client, claim, lockToken, terminal, result);
  return terminal === 'FAILED' ? 'failed' : 'completed';
}

export async function processDueAiBrainShadowRuns(
  limit = 5,
  options: ShadowWorkerOptions = {},
): Promise<ShadowWorkerResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('INVALID_SHADOW_LIMIT');

  const client = options.supabase ?? createAdminClient();
  const provider = options.provider ?? productionProvider();
  const lockToken = randomUUID();
  const { data, error } = await client.rpc('claim_ai_brain_shadow_runs', {
    p_limit: limit,
    p_lock_token: lockToken,
  });
  if (error) throw new Error('SHADOW_CLAIM_FAILED');

  const claims = (Array.isArray(data) ? data : []) as ShadowClaim[];
  const summary: ShadowWorkerResult = { claimed: claims.length, completed: 0, skipped: 0, failed: 0 };
  for (const claim of claims) {
    try {
      const outcome = await processClaim(client, claim, lockToken, provider);
      summary[outcome] += 1;
    } catch {
      summary.failed += 1;
      // The lease is intentionally left fenced. A stale PROCESSING row may be reclaimed after 5 minutes.
      // Never log raw exception/provider text here.
      console.error('[ai-brain-shadow] processing failed');
    }
  }
  return summary;
}
