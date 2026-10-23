import 'server-only';

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../lib/supabase/admin';
import type {
  BrainDecision,
  BrainProvider,
  BrainServerContext,
} from './contracts';
import { JavisBrainProvider } from './javis-provider';
import { createBrainService } from './service';
import { ZaloInboxService } from '../omnichannel/zalo/inbox-service';
import { classifyHandoverReason, createHandoverCase } from './handover';
import type { BrainContextDataSource } from './context-contracts';
import { createSupabaseBrainContextDataSource } from './context-supabase';
import { resolveGroundingContext, type BrainTurnGrounding } from './grounding';

export interface LiveZaloClaim {
  id: string;
  company_id: string;
  customer_id: string;
  conversation_id: string;
  source_interaction_id: string;
  channel: 'ZALO';
  attempts: number;
}

interface EligibleLiveInput {
  text: string;
  minConfidence: number;
  context: BrainServerContext;
}

/**
 * Stable server-owned workload actor ID for AI Brain Zalo live reply execution.
 * Standard RFC 4122 UUID representing the live worker identity across tenants.
 */
export const LIVE_ZALO_WORKLOAD_ACTOR_ID = '00000000-0000-4000-8000-0000000000a2';

export interface LiveZaloWorkerResult {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
}

export interface LiveZaloWorkerOptions {
  supabase?: SupabaseClient;
  provider?: BrainProvider;
  inboxService?: ZaloInboxService;
  dataSource?: BrainContextDataSource;
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

async function loadEligibleInput(
  client: SupabaseClient,
  claim: LiveZaloClaim,
  dataSource?: BrainContextDataSource
): Promise<EligibleLiveInput | null> {
  const { data: setting, error: settingError } = await client
    .from('ai_brain_live_settings')
    .select('enabled, min_confidence')
    .eq('company_id', claim.company_id)
    .eq('channel', 'ZALO')
    .maybeSingle();
  if (settingError) throw new Error('LIVE_SETTING_LOOKUP_FAILED');
  if (!setting?.enabled) return null;

  const { data: conversation, error: conversationError } = await client
    .from('conversations')
    .select('id, company_id, customer_id, channel, status, assigned_to, ai_mode')
    .eq('id', claim.conversation_id)
    .eq('company_id', claim.company_id)
    .eq('customer_id', claim.customer_id)
    .maybeSingle();
  if (conversationError || !conversation) throw new Error('LIVE_SCOPE_INVALID');
  if (conversation.channel !== 'ZALO') {
    throw new Error('LIVE_SCOPE_INVALID');
  }

  // Conversation closed, human-owned, or AI paused -> AI silent
  if (
    conversation.status === 'CLOSED' ||
    conversation.status === 'PENDING_SALE' ||
    conversation.assigned_to !== null ||
    conversation.ai_mode === 'PAUSED'
  ) {
    return null;
  }

  const { data: interaction, error: interactionError } = await client
    .from('interactions')
    .select('id, company_id, customer_id, conversation_id, channel, type, direction, actor_type, sanitization_status, sanitized_content')
    .eq('id', claim.source_interaction_id)
    .eq('company_id', claim.company_id)
    .eq('customer_id', claim.customer_id)
    .eq('conversation_id', claim.conversation_id)
    .maybeSingle();
  if (interactionError || !interaction) throw new Error('LIVE_SOURCE_INVALID');
  if (
    interaction.channel !== 'ZALO' ||
    interaction.type !== 'MESSAGE' ||
    interaction.direction !== 'INBOUND' ||
    interaction.actor_type !== 'CUSTOMER' ||
    interaction.sanitization_status !== 'SUCCEEDED' ||
    typeof interaction.sanitized_content !== 'string' ||
    !interaction.sanitized_content.trim()
  ) {
    throw new Error('LIVE_SOURCE_INVALID');
  }

  const minConfidence = typeof setting.min_confidence === 'number'
    ? setting.min_confidence
    : parseFloat(String(setting.min_confidence || '0.85'));

  const traceId = randomUUID();
  let grounding: BrainTurnGrounding | undefined;
  if (dataSource) {
    try {
      grounding = await resolveGroundingContext({
        scope: {
          companyId: conversation.company_id,
          customerId: conversation.customer_id,
          conversationId: conversation.id,
          channel: 'ZALO',
          traceId,
        },
        inputText: interaction.sanitized_content,
        dataSource,
      });
    } catch {
      // Grounding failures collapse gracefully without breaking live delivery
    }
  }

  return {
    text: interaction.sanitized_content,
    minConfidence: Number.isFinite(minConfidence) ? minConfidence : 0.85,
    context: Object.freeze({
      companyId: conversation.company_id,
      customerId: conversation.customer_id,
      conversationId: conversation.id,
      channel: 'ZALO',
      modality: 'TEXT',
      caller: Object.freeze({ actorId: LIVE_ZALO_WORKLOAD_ACTOR_ID, actorType: 'WORKLOAD' }),
      permissionProfile: 'READ_ONLY',
      conversationState: 'AI_ACTIVE',
      allowDrafts: true,
      deliveryMode: 'LIVE_SEND',
      traceId,
      grounding,
    }),
  };
}

async function finish(
  client: SupabaseClient,
  claim: LiveZaloClaim,
  lockToken: string,
  status: 'SENT' | 'SKIPPED' | 'FAILED',
  details?: {
    decision?: BrainDecision | null;
    confidence?: number | null;
    externalMessageId?: string | null;
    errorCode?: string | null;
    turnId?: string | null;
  }
): Promise<void> {
  const { data, error } = await client.rpc('finish_ai_brain_live_delivery', {
    p_id: claim.id,
    p_lock_token: lockToken,
    p_send_status: status,
    p_decision: details?.decision ?? null,
    p_confidence: details?.confidence ?? null,
    p_external_message_id: details?.externalMessageId ?? null,
    p_error_code: details?.errorCode ?? null,
    p_brain_turn_id: details?.turnId ?? null,
  });
  if (error || data !== true) throw new Error('LIVE_FINISH_FENCED');
}

async function processClaim(
  client: SupabaseClient,
  claim: LiveZaloClaim,
  lockToken: string,
  provider: BrainProvider | undefined,
  inboxService: ZaloInboxService,
  dataSource?: BrainContextDataSource,
): Promise<'sent' | 'skipped' | 'failed'> {
  let eligible: EligibleLiveInput | null;
  try {
    eligible = await loadEligibleInput(client, claim, dataSource);
  } catch (err: unknown) {
    await finish(client, claim, lockToken, 'FAILED', {
      errorCode: err instanceof Error ? err.message : 'LIVE_SOURCE_INVALID',
    });
    return 'failed';
  }

  if (!eligible) {
    await finish(client, claim, lockToken, 'SKIPPED');
    return 'skipped';
  }

  const rawTimeout = process.env.LIVE_TIMEOUT_MS ? parseInt(process.env.LIVE_TIMEOUT_MS, 10) : 25000;
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout >= 1000 && rawTimeout <= 30000 ? rawTimeout : 25000;

  const service = createBrainService({
    provider,
    timeoutMs,
    resolveContext: async (selector) => {
      if (
        selector.customerId !== eligible.context.customerId ||
        selector.conversationId !== eligible.context.conversationId ||
        selector.channel !== 'ZALO' ||
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
    channel: 'ZALO',
    modality: 'TEXT',
    latency: 'STANDARD',
    requestedCapability: 'READ_ONLY',
    input: { text: eligible.text },
  });

  // Provider error or timeout
  if (result.decision === 'ERROR') {
    await finish(client, claim, lockToken, 'FAILED', {
      decision: 'ERROR',
      confidence: result.confidence,
      errorCode: result.errorCode,
      turnId: result.turnId,
    });
    return 'failed';
  }

  // Decision Gate: Only RESPOND can auto-send. HANDOVER or NO_REPLY must not send.
  if (result.decision === 'HANDOVER') {
    const { reason, priority } = classifyHandoverReason(result.handoverReason, {
      confidence: result.confidence,
    });
    try {
      await createHandoverCase(client, {
        companyId: claim.company_id,
        customerId: claim.customer_id,
        conversationId: claim.conversation_id,
        sourceInteractionId: claim.source_interaction_id,
        reason,
        priority,
        brainTurnId: result.turnId,
      });
    } catch {
      // Handover case creation failure must fail closed (do not send to customer)
    }

    await finish(client, claim, lockToken, 'SKIPPED', {
      decision: 'HANDOVER',
      confidence: result.confidence,
      turnId: result.turnId,
    });
    return 'skipped';
  }

  if (result.decision !== 'RESPOND') {
    await finish(client, claim, lockToken, 'SKIPPED', {
      decision: result.decision,
      confidence: result.confidence,
      turnId: result.turnId,
    });
    return 'skipped';
  }

  // Confidence Gate: Must be >= min_confidence
  if (result.confidence < eligible.minConfidence) {
    await finish(client, claim, lockToken, 'SKIPPED', {
      decision: 'RESPOND',
      confidence: result.confidence,
      errorCode: 'LOW_CONFIDENCE',
      turnId: result.turnId,
    });
    return 'skipped';
  }

  const proposedDraft = result.draft?.trim();
  if (!proposedDraft) {
    await finish(client, claim, lockToken, 'SKIPPED', {
      decision: 'RESPOND',
      confidence: result.confidence,
      errorCode: 'EMPTY_DRAFT',
      turnId: result.turnId,
    });
    return 'skipped';
  }

  // PRE-SEND RE-CHECK 1: Kill switch re-check right before sending!
  const { data: currentSetting, error: killSwitchCheckError } = await client
    .from('ai_brain_live_settings')
    .select('enabled')
    .eq('company_id', claim.company_id)
    .eq('channel', 'ZALO')
    .maybeSingle();

  if (killSwitchCheckError || !currentSetting?.enabled) {
    await finish(client, claim, lockToken, 'SKIPPED', {
      decision: 'RESPOND',
      confidence: result.confidence,
      errorCode: 'KILL_SWITCH_ENGAGED',
      turnId: result.turnId,
    });
    return 'skipped';
  }

  // PRE-SEND RE-CHECK 2: Human ownership / AI pause re-check right before sending!
  const { data: currentConv, error: convCheckError } = await client
    .from('conversations')
    .select('status, assigned_to, ai_mode')
    .eq('id', claim.conversation_id)
    .maybeSingle();

  if (
    convCheckError ||
    !currentConv ||
    currentConv.status === 'CLOSED' ||
    currentConv.status === 'PENDING_SALE' ||
    currentConv.assigned_to !== null ||
    currentConv.ai_mode === 'PAUSED'
  ) {
    await finish(client, claim, lockToken, 'SKIPPED', {
      decision: 'RESPOND',
      confidence: result.confidence,
      errorCode: currentConv?.ai_mode === 'PAUSED' ? 'AI_PAUSED' : 'HUMAN_TAKEN_OVER',
      turnId: result.turnId,
    });
    return 'skipped';
  }

  // CRM ZALO SENDER CALL (CRM is the delivery authority)
  const commandId = `ai-live:${claim.source_interaction_id}`;
  const sendResult = await inboxService.sendSystemZaloReply(
    {
      conversationId: claim.conversation_id,
      content: proposedDraft,
      commandId,
    },
    {
      kind: 'SYSTEM_WORKER',
      companyId: claim.company_id,
      actorType: 'AI',
      workerName: 'ai_brain_live_worker',
    }
  );

  if (sendResult.success && (sendResult.status === 'SENT' || sendResult.status === 'ALREADY_SENT')) {
    await finish(client, claim, lockToken, 'SENT', {
      decision: 'RESPOND',
      confidence: result.confidence,
      externalMessageId: sendResult.externalMessageId ?? null,
      turnId: result.turnId,
    });
    return 'sent';
  }

  await finish(client, claim, lockToken, 'FAILED', {
    decision: 'RESPOND',
    confidence: result.confidence,
    errorCode: sendResult.error || 'SEND_FAILED',
    turnId: result.turnId,
  });
  return 'failed';
}

export async function processDueAiBrainLiveZaloDeliveries(
  limit = 5,
  options: LiveZaloWorkerOptions = {},
): Promise<LiveZaloWorkerResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('INVALID_LIVE_LIMIT');

  const client = options.supabase ?? createAdminClient();
  const provider = options.provider ?? productionProvider();
  const inboxService = options.inboxService ?? new ZaloInboxService({ supabase: client });
  const dataSource = options.dataSource ?? (options.supabase ? undefined : createSupabaseBrainContextDataSource());
  const lockToken = randomUUID();

  const { data, error } = await client.rpc('claim_ai_brain_live_deliveries', {
    p_limit: limit,
    p_lock_token: lockToken,
  });
  if (error) throw new Error('LIVE_CLAIM_FAILED');

  const claims = (Array.isArray(data) ? data : []) as LiveZaloClaim[];
  const summary: LiveZaloWorkerResult = { claimed: claims.length, sent: 0, skipped: 0, failed: 0 };

  for (const claim of claims) {
    try {
      const outcome = await processClaim(client, claim, lockToken, provider, inboxService, dataSource);
      summary[outcome] += 1;
    } catch {
      summary.failed += 1;
      console.error('[ai-brain-live-zalo] processing failed');
    }
  }

  return summary;
}
