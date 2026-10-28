import 'server-only';

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { extractMessengerPageId } from '../page-id';
import type {
  BrainDecision,
  BrainProvider,
  BrainServerContext,
} from '../contracts';
import { ProviderFailure } from '../provider-failure';
import { JavisBrainProvider } from '../javis-provider';
import { createBrainService } from '../service';
import { classifyHandoverReason, createHandoverCase } from '../handover';
import type { BrainContextDataSource } from '../context-contracts';
import { createSupabaseBrainContextDataSource } from '../context-supabase';
import { resolveGroundingContext, type BrainTurnGrounding } from '../grounding';
import type {
  LiveDeliveryChannel,
  LiveDeliveryClaim,
  LiveDeliveryWorkerResult,
  LiveDeliveryTransport,
} from './contracts';
import { LIVE_DELIVERY_WORKLOAD_ACTOR_ID } from './contracts';
import { ZaloDeliveryTransport } from './transports/zalo-transport';
import { MessengerDeliveryTransport } from './transports/messenger-transport';

export const MESSENGER_FALLBACK_REPLY =
  'Anh/chị cho em xin sđt liên hệ, để nhân viên bên em tư vấn chi tiết hơn cho nhé.';

interface EligibleLiveInput {
  text: string;
  minConfidence: number;
  context: BrainServerContext;
}

export interface LiveDeliveryEngineOptions {
  supabase?: SupabaseClient;
  provider?: BrainProvider;
  dataSource?: BrainContextDataSource;
  transports?: Partial<Record<LiveDeliveryChannel, LiveDeliveryTransport>>;
  channel?: LiveDeliveryChannel;
}

function productionProvider(): BrainProvider | undefined {
  const baseUrl = process.env.JAVIS_BRAIN_BASE_URL?.trim();
  const authToken = process.env.JAVIS_BRAIN_INTERNAL_TOKEN?.trim();
  if (!baseUrl || !authToken) return { descriptor: { id: 'javis-brain-service', model: 'javis-router-v1' },
    async runTurn() { throw new ProviderFailure('BRAIN_CONFIG_MISSING', 'JAVIS_BRAIN'); } };
  try {
    return new JavisBrainProvider({ baseUrl, authToken });
  } catch {
    return { descriptor: { id: 'javis-brain-service', model: 'javis-router-v1' },
      async runTurn() { throw new ProviderFailure('BRAIN_CONFIG_MISSING', 'JAVIS_BRAIN'); } };
  }
}

async function loadEligibleInput(
  client: SupabaseClient,
  claim: LiveDeliveryClaim,
  dataSource?: BrainContextDataSource
): Promise<EligibleLiveInput | null> {
  const settingChannel = claim.channel;
  const expectedConvChannel = claim.channel === 'ZALO' ? 'ZALO' : 'FACEBOOK';
  const expectedInteractionChannel = claim.channel === 'ZALO' ? 'ZALO' : 'FACEBOOK';

  // 1. Check tenant live setting for this channel
  const { data: setting, error: settingError } = await client
    .from('ai_brain_live_settings')
    .select('enabled, min_confidence')
    .eq('company_id', claim.company_id)
    .eq('channel', settingChannel)
    .maybeSingle();

  if (settingError) throw new Error('LIVE_SETTING_LOOKUP_FAILED');
  if (!setting?.enabled) return null;

  // 2. Check conversation state
  const { data: conversation, error: conversationError } = await client
    .from('conversations')
    .select('id, company_id, customer_id, channel, status, assigned_to, ai_mode, external_conversation_id, metadata')
    .eq('id', claim.conversation_id)
    .eq('company_id', claim.company_id)
    .eq('customer_id', claim.customer_id)
    .maybeSingle();

  if (conversationError || !conversation) throw new Error('LIVE_SCOPE_INVALID');
  if (conversation.channel !== expectedConvChannel) {
    throw new Error('LIVE_SCOPE_INVALID');
  }

  // Conversation closed, human-owned, or AI paused -> AI silent
  // For Zalo, PENDING_SALE means waiting for human sale SLA.
  // For Messenger, AI replies immediately without waiting for sale (remove pending sale gate).
  if (
    conversation.status === 'CLOSED' ||
    (claim.channel === 'ZALO' && conversation.status === 'PENDING_SALE') ||
    conversation.assigned_to !== null ||
    conversation.ai_mode !== 'ACTIVE'
  ) {
    return null;
  }

  // Canary restriction for Messenger: default deny unless explicitly allowlisted
  if (claim.channel === 'MESSENGER') {
    const pageId = extractMessengerPageId(
      (conversation as { external_conversation_id?: string | null }).external_conversation_id,
      (conversation as { metadata?: unknown }).metadata,
    );
    if (!pageId) return null;

    const { data: canaryAllowed, error: canaryErr } = await client
      .from('ai_brain_live_canary_allowlist')
      .select('id')
      .eq('company_id', claim.company_id)
      .eq('channel', 'MESSENGER')
      .eq('conversation_id', claim.conversation_id)
      .eq('page_id', pageId)
      .eq('enabled', true)
      .maybeSingle();

    if (canaryErr || !canaryAllowed) {
      return null;
    }
  }

  // 3. Check source interaction
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
    interaction.channel !== expectedInteractionChannel ||
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
          channel: claim.channel,
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
      channel: claim.channel === 'ZALO' ? 'ZALO' : 'MESSENGER',
      modality: 'TEXT',
      caller: Object.freeze({ actorId: LIVE_DELIVERY_WORKLOAD_ACTOR_ID, actorType: 'WORKLOAD' }),
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
  claim: LiveDeliveryClaim,
  lockToken: string,
  status: 'SENT' | 'SKIPPED' | 'FAILED',
  details?: {
    decision?: BrainDecision | null;
    confidence?: number | null;
    externalMessageId?: string | null;
    errorCode?: string | null;
    turnId?: string | null;
    brainLatencyMs?: number | null;
  }
): Promise<void> {
  const isExtended = claim.channel === 'MESSENGER' || (claim.channel !== 'ZALO' && details?.brainLatencyMs != null);
  const rpcName = isExtended
    ? 'finish_ai_brain_live_delivery_extended'
    : 'finish_ai_brain_live_delivery';

  const params: Record<string, unknown> = {
    p_id: claim.id,
    p_lock_token: lockToken,
    p_send_status: status,
    p_decision: details?.decision ?? null,
    p_confidence: details?.confidence ?? null,
    p_external_message_id: details?.externalMessageId ?? null,
    p_error_code: details?.errorCode ?? null,
    p_brain_turn_id: details?.turnId ?? null,
  };

  if (rpcName === 'finish_ai_brain_live_delivery_extended') {
    params.p_brain_latency_ms = details?.brainLatencyMs ?? null;
  }

  const { data, error } = await client.rpc(rpcName, params);
  if (error || data !== true) throw new Error('LIVE_FINISH_FENCED');
}

async function processClaim(
  client: SupabaseClient,
  claim: LiveDeliveryClaim,
  lockToken: string,
  provider: BrainProvider | undefined,
  transports: Map<LiveDeliveryChannel, LiveDeliveryTransport>,
  dataSource?: BrainContextDataSource,
): Promise<'sent' | 'skipped' | 'failed'> {
  const eligibleAtDb = async () => {
    if (claim.channel !== 'ZALO') return true;
    const { data, error } = await client.rpc('ai_brain_live_zalo_is_eligible', {
      p_id: claim.id, p_lock_token: lockToken,
    });
    if (error) throw new Error('LIVE_ELIGIBILITY_CHECK_FAILED');
    return data === true;
  };
  let eligible: EligibleLiveInput | null;
  try {
    if (!await eligibleAtDb()) {
      await finish(client, claim, lockToken, 'SKIPPED', { errorCode: 'SLA_OR_HUMAN_REPLY_GUARD' });
      return 'skipped';
    }
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

  const expectedBrainChannel = claim.channel === 'ZALO' ? 'ZALO' : 'MESSENGER';

  const service = createBrainService({
    provider,
    timeoutMs,
    resolveContext: async (selector) => {
      if (
        selector.customerId !== eligible.context.customerId ||
        selector.conversationId !== eligible.context.conversationId ||
        selector.channel !== expectedBrainChannel ||
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
    channel: expectedBrainChannel,
    modality: 'TEXT',
    latency: 'STANDARD',
    requestedCapability: 'READ_ONLY',
    input: { text: eligible.text },
  });

  const brainLatencyMs = typeof result.latencyMs === 'number' && Number.isFinite(result.latencyMs)
    ? Math.round(result.latencyMs)
    : null;

  console.info(JSON.stringify({ event: 'LIVE_BRAIN_RESULT', deliveryId: claim.id, turnId: result.turnId,
    traceId: result.traceId, decision: result.decision, errorCode: result.errorCode, latencyMs: brainLatencyMs }));

  // Provider error or timeout
  if (result.decision === 'ERROR') {
    await finish(client, claim, lockToken, 'FAILED', {
      decision: 'ERROR',
      confidence: result.confidence,
      errorCode: result.errorCode,
      turnId: result.turnId,
      brainLatencyMs,
    });
    return 'failed';
  }

  // Handover case handling
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
      // Handover case creation failure must fail closed AND be visible with sanitized code and server ID only
      console.error(`[ai-brain-live-delivery] createHandoverCase failed for claim ${claim.id}`);
      await finish(client, claim, lockToken, 'FAILED', {
        decision: 'HANDOVER',
        confidence: result.confidence,
        errorCode: 'HANDOVER_CASE_CREATION_FAILED',
        turnId: result.turnId,
        brainLatencyMs,
      });
      return 'failed';
    }

    // For Zalo, handover skips send. For Messenger, we continue to auto-reply with draft or fallback.
    if (claim.channel !== 'MESSENGER') {
      await finish(client, claim, lockToken, 'SKIPPED', {
        decision: 'HANDOVER',
        confidence: result.confidence,
        turnId: result.turnId,
        brainLatencyMs,
      });
      return 'skipped';
    }
  }

  if (result.decision !== 'RESPOND' && (claim.channel !== 'MESSENGER' || result.decision !== 'HANDOVER')) {
    await finish(client, claim, lockToken, 'SKIPPED', {
      decision: result.decision,
      confidence: result.confidence,
      turnId: result.turnId,
      brainLatencyMs,
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
      brainLatencyMs,
    });
    return 'skipped';
  }

  const proposedDraft = (claim.channel === 'MESSENGER' && result.decision === 'HANDOVER')
    ? (result.draft?.trim() || MESSENGER_FALLBACK_REPLY)
    : result.draft?.trim();

  if (!proposedDraft) {
    await finish(client, claim, lockToken, 'SKIPPED', {
      decision: 'RESPOND',
      confidence: result.confidence,
      errorCode: 'EMPTY_DRAFT',
      turnId: result.turnId,
      brainLatencyMs,
    });
    return 'skipped';
  }

  // PRE-SEND RE-CHECK 1: Kill switch re-check right before sending!
  const settingChannel = claim.channel;
  const { data: currentSetting, error: killSwitchCheckError } = await client
    .from('ai_brain_live_settings')
    .select('enabled')
    .eq('company_id', claim.company_id)
    .eq('channel', settingChannel)
    .maybeSingle();

  if (killSwitchCheckError || !currentSetting?.enabled) {
    await finish(client, claim, lockToken, 'SKIPPED', {
      decision: 'RESPOND',
      confidence: result.confidence,
      errorCode: 'KILL_SWITCH_ENGAGED',
      turnId: result.turnId,
      brainLatencyMs,
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
    (claim.channel === 'ZALO' && currentConv.status === 'PENDING_SALE') ||
    currentConv.assigned_to !== null ||
    currentConv.ai_mode !== 'ACTIVE'
  ) {
    await finish(client, claim, lockToken, 'SKIPPED', {
      decision: 'RESPOND',
      confidence: result.confidence,
      errorCode: currentConv?.ai_mode === 'PAUSED' ? 'AI_PAUSED' : 'HUMAN_TAKEN_OVER',
      turnId: result.turnId,
      brainLatencyMs,
    });
    return 'skipped';
  }

  // PRE-SEND RE-CHECK 3: Canary allowlist re-check right before sending!
  if (claim.channel === 'MESSENGER') {
    const { data: convExternal } = await client
      .from('conversations')
      .select('external_conversation_id, metadata')
      .eq('id', claim.conversation_id)
      .eq('company_id', claim.company_id)
      .maybeSingle();

    const pageId = extractMessengerPageId(
      (convExternal as { external_conversation_id?: string | null } | null)?.external_conversation_id,
      (convExternal as { metadata?: unknown } | null)?.metadata,
    );

    const { data: canaryActive, error: canaryCheckErr } = pageId
      ? await client
          .from('ai_brain_live_canary_allowlist')
          .select('id')
          .eq('company_id', claim.company_id)
          .eq('channel', 'MESSENGER')
          .eq('conversation_id', claim.conversation_id)
          .eq('page_id', pageId)
          .eq('enabled', true)
          .maybeSingle()
      : { data: null, error: null };

    if (canaryCheckErr || !canaryActive) {
      await finish(client, claim, lockToken, 'SKIPPED', {
        decision: 'RESPOND',
        confidence: result.confidence,
        errorCode: 'CANARY_RESTRICTED',
        turnId: result.turnId,
        brainLatencyMs,
      });
      return 'skipped';
    }
  }

  // Recheck after generation: a Sale reply during the model call wins.
  if (!await eligibleAtDb()) {
    await finish(client, claim, lockToken, 'SKIPPED', { errorCode: 'SLA_OR_HUMAN_REPLY_GUARD', turnId: result.turnId });
    return 'skipped';
  }

  console.info(JSON.stringify({ event: 'BRAIN_PROPOSAL_READY', deliveryId: claim.id,
    turnId: result.turnId, traceId: result.traceId, latencyMs: brainLatencyMs }));
  // SENDER TRANSPORT CALL (CRM is the delivery authority)
  const transport = transports.get(claim.channel);
  if (!transport) {
    await finish(client, claim, lockToken, 'FAILED', {
      decision: 'RESPOND',
      confidence: result.confidence,
      errorCode: 'NO_TRANSPORT_AVAILABLE',
      turnId: result.turnId,
      brainLatencyMs,
    });
    return 'failed';
  }

  const effectiveConfidence =
    claim.channel === 'MESSENGER' && result.decision === 'HANDOVER'
      ? Math.max(result.confidence ?? 0.8, eligible.minConfidence)
      : result.confidence;

  const commandId = `ai-live:${claim.source_interaction_id}`;
  const sendOutcome = await transport.sendReply({
    claim,
    draft: proposedDraft,
    commandId,
    minConfidence: eligible.minConfidence,
    turnConfidence: effectiveConfidence,
    turnId: result.turnId,
    lockToken,
  });

  if (sendOutcome.outcome === 'SENT') {
    await finish(client, claim, lockToken, 'SENT', {
      decision: result.decision === 'HANDOVER' ? 'HANDOVER' : 'RESPOND',
      confidence: result.confidence,
      externalMessageId: sendOutcome.externalMessageId ?? null,
      errorCode: sendOutcome.errorCode ?? null,
      turnId: result.turnId,
      brainLatencyMs,
    });
    return 'sent';
  }

  if (sendOutcome.outcome === 'SKIPPED') {
    await finish(client, claim, lockToken, 'SKIPPED', {
      decision: 'RESPOND',
      confidence: result.confidence,
      errorCode: sendOutcome.errorCode ?? 'SKIPPED_BY_TRANSPORT',
      turnId: result.turnId,
      brainLatencyMs,
    });
    return 'skipped';
  }

  if (sendOutcome.outcome === 'UNCERTAIN') {
    await finish(client, claim, lockToken, 'FAILED', {
      decision: 'RESPOND',
      confidence: result.confidence,
      errorCode: sendOutcome.errorCode || 'MESSENGER_DISPATCH_UNCERTAIN',
      turnId: result.turnId,
      brainLatencyMs,
    });
    return 'failed';
  }

  await finish(client, claim, lockToken, 'FAILED', {
    decision: 'RESPOND',
    confidence: result.confidence,
    externalMessageId: sendOutcome.externalMessageId ?? null,
    errorCode: sendOutcome.errorCode || 'SEND_FAILED',
    turnId: result.turnId,
    brainLatencyMs,
  });
  return 'failed';
}

export async function processDueLiveDeliveries(
  limit = 5,
  options: LiveDeliveryEngineOptions = {},
): Promise<LiveDeliveryWorkerResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('INVALID_LIVE_LIMIT');

  const client = options.supabase ?? createAdminClient();
  const provider = options.provider ?? productionProvider();
  const dataSource = options.dataSource ?? (options.supabase ? undefined : createSupabaseBrainContextDataSource());
  const lockToken = randomUUID();

  // Initialize transport map
  const transports = new Map<LiveDeliveryChannel, LiveDeliveryTransport>();
  if (options.transports?.ZALO) {
    transports.set('ZALO', options.transports.ZALO);
  } else {
    transports.set('ZALO', new ZaloDeliveryTransport({ supabase: client }));
  }

  if (options.transports?.MESSENGER) {
    transports.set('MESSENGER', options.transports.MESSENGER);
  } else {
    transports.set('MESSENGER', new MessengerDeliveryTransport({ supabase: client }));
  }

  const { data, error } = await client.rpc('claim_ai_brain_live_deliveries', {
    p_limit: limit,
    p_lock_token: lockToken,
    p_channel: options.channel ?? null,
  });
  if (error) throw new Error('LIVE_CLAIM_FAILED');

  const claims = (Array.isArray(data) ? data : []) as LiveDeliveryClaim[];
  const summary: LiveDeliveryWorkerResult = { claimed: claims.length, sent: 0, skipped: 0, failed: 0 };

  for (const claim of claims) {
    try {
      const outcome = await processClaim(client, claim, lockToken, provider, transports, dataSource);
      summary[outcome] += 1;
    } catch {
      summary.failed += 1;
      console.error(`[ai-brain-live-delivery] processing failed for claim ${claim.id}`);
    }
  }

  return summary;
}
