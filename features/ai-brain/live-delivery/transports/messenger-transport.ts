import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { binding as defaultBinding, type PageBinding } from '@/features/omnichannel/facebook/binding';
import { canReply } from '@/features/omnichannel/facebook/core';
import { dispatchMessage } from '@/features/omnichannel/facebook/transport';
import { extractMessengerPageId, extractMessengerRecipientId } from '../../page-id';
import type {
  LiveDeliverySendParams,
  LiveDeliverySendOutcome,
  LiveDeliveryTransport,
} from '../contracts';

export interface MessengerDeliveryTransportOptions {
  supabase?: SupabaseClient;
  dispatchFn?: typeof dispatchMessage;
  fetcher?: typeof fetch;
  resolveBinding?: (pageId?: string | null) => PageBinding;
}

export class MessengerDeliveryTransport implements LiveDeliveryTransport {
  public readonly channel = 'MESSENGER' as const;
  private readonly supabase: SupabaseClient;
  private readonly dispatchFn: typeof dispatchMessage;
  private readonly fetcher?: typeof fetch;
  private readonly resolveBinding: (pageId?: string | null) => PageBinding;

  constructor(options: MessengerDeliveryTransportOptions = {}) {
    this.supabase = options.supabase ?? createAdminClient();
    this.dispatchFn = options.dispatchFn ?? dispatchMessage;
    this.fetcher = options.fetcher;
    this.resolveBinding = options.resolveBinding ?? defaultBinding;
  }

  async sendReply(params: LiveDeliverySendParams): Promise<LiveDeliverySendOutcome> {
    const { claim, draft, lockToken } = params;

    // 0. Channel and required lock token guards
    if (claim.channel !== 'MESSENGER') {
      return { outcome: 'FAILED', errorCode: 'INVALID_CHANNEL' };
    }

    if (!lockToken || typeof lockToken !== 'string' || !lockToken.trim()) {
      return { outcome: 'FAILED', errorCode: 'MISSING_LOCK_TOKEN' };
    }

    // 1. Resolve conversation external ID (format: "pageId:recipientPsid")
    const { data: conv, error: convError } = await this.supabase
      .from('conversations')
      .select('id, company_id, channel, external_conversation_id, metadata')
      .eq('id', claim.conversation_id)
      .eq('company_id', claim.company_id)
      .maybeSingle();

    if (convError || !conv) {
      return { outcome: 'FAILED', errorCode: 'CONVERSATION_NOT_FOUND' };
    }

    if (conv.company_id !== claim.company_id || conv.channel !== 'FACEBOOK') {
      return { outcome: 'FAILED', errorCode: 'CHANNEL_OR_COMPANY_MISMATCH' };
    }

    const pageId = extractMessengerPageId(conv.external_conversation_id, conv.metadata);
    const recipientPsid = extractMessengerRecipientId(conv.external_conversation_id, conv.metadata);
    if (!pageId || !recipientPsid) {
      return { outcome: 'FAILED', errorCode: 'INVALID_EXTERNAL_CONVERSATION_ID' };
    }

    // 2. Resolve Page credentials via binding and enforce company + page match
    let config: PageBinding;
    try {
      config = this.resolveBinding(pageId);
    } catch {
      return { outcome: 'FAILED', errorCode: 'PAGE_NOT_CONFIGURED' };
    }

    if (config.company !== claim.company_id || config.page !== pageId) {
      return { outcome: 'FAILED', errorCode: 'PAGE_COMPANY_MISMATCH' };
    }

    const token = (process.env[config.tokenEnv] || '').trim();
    if (!token) {
      return { outcome: 'FAILED', errorCode: 'CHANNEL_NOT_CONFIGURED' };
    }

    const version = (process.env.META_GRAPH_VERSION || 'v21.0').trim();
    if (!/^v\d+\.\d+$/.test(version)) {
      return { outcome: 'FAILED', errorCode: 'INVALID_GRAPH_VERSION' };
    }

    // 3. Strict Canary Allowlist verification in transport
    const { data: canaryAllowed, error: canaryErr } = await this.supabase
      .from('ai_brain_live_canary_allowlist')
      .select('id')
      .eq('company_id', claim.company_id)
      .eq('channel', 'MESSENGER')
      .eq('conversation_id', claim.conversation_id)
      .eq('page_id', pageId)
      .eq('enabled', true)
      .maybeSingle();

    if (canaryErr || !canaryAllowed) {
      return { outcome: 'SKIPPED', errorCode: 'CANARY_NOT_ALLOWED' };
    }

    // 4. Pre-check delivery record: if already sent or already marked, never physically resend
    const { data: deliveryCheck, error: deliveryErr } = await this.supabase
      .from('ai_brain_live_deliveries')
      .select('lock_token, send_status, external_message_id, dispatch_started_at')
      .eq('id', claim.id)
      .maybeSingle();

    if (deliveryErr || !deliveryCheck) {
      return { outcome: 'FAILED', errorCode: 'DELIVERY_LOOKUP_FAILED' };
    }

    if (deliveryCheck.external_message_id) {
      return {
        outcome: 'SENT',
        externalMessageId: deliveryCheck.external_message_id,
      };
    }

    if (deliveryCheck.dispatch_started_at) {
      // Dispatch was already marked or attempted; never physically resend
      return { outcome: 'SKIPPED', errorCode: 'DISPATCH_ALREADY_STARTED' };
    }

    if (deliveryCheck.lock_token !== lockToken) {
      return { outcome: 'SKIPPED', errorCode: 'LEASE_FENCED' };
    }

    // 5. 24-hour messaging window guard
    const { data: latestInbound, error: inboundError } = await this.supabase
      .from('interactions')
      .select('created_at')
      .eq('company_id', claim.company_id)
      .eq('conversation_id', claim.conversation_id)
      .eq('direction', 'INBOUND')
      .eq('actor_type', 'CUSTOMER')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (inboundError) {
      return { outcome: 'FAILED', errorCode: 'INBOUND_WINDOW_CHECK_FAILED' };
    }

    if (!latestInbound || !canReply(latestInbound.created_at)) {
      return { outcome: 'FAILED', errorCode: 'MESSAGING_WINDOW_CLOSED' };
    }

    // 6. ATOMIC DURABLE DISPATCH-START FENCE BEFORE GRAPH CALL
    // Atomically validates active lock token, lease, scope, canary, current settings,
    // ownership, and 24h window, setting dispatch_started_at ONLY ONCE.
    const { data: fenceAcquired, error: fenceError } = await this.supabase.rpc(
      'start_ai_messenger_live_dispatch',
      {
        p_delivery_id: claim.id,
        p_lock_token: lockToken,
        p_company_id: claim.company_id,
        p_customer_id: claim.customer_id,
        p_conversation_id: claim.conversation_id,
        p_source_interaction_id: claim.source_interaction_id,
        p_page_id: pageId,
        p_min_confidence: params.minConfidence,
        p_turn_confidence: params.turnConfidence ?? null,
      }
    );

    if (fenceError || fenceAcquired !== true) {
      return { outcome: 'SKIPPED', errorCode: 'DISPATCH_FENCE_DENIED' };
    }

    // 7. Physical Dispatch via Meta Graph API (Fence held)
    const dispatchResult = await this.dispatchFn(
      {
        page: pageId,
        recipient: recipientPsid,
        version,
        token,
        content: draft,
      },
      this.fetcher
    );

    if (dispatchResult.status === 'SENT' && dispatchResult.mid) {
      // 8. Atomically record outbound interaction on CRM timeline
      const externalRef = `meta:${pageId}:${dispatchResult.mid}`;
      const { error: recordError } = await this.supabase.rpc('record_ai_messenger_live_outbound', {
        p_company_id: claim.company_id,
        p_customer_id: claim.customer_id,
        p_conversation_id: claim.conversation_id,
        p_source_interaction_id: claim.source_interaction_id,
        p_delivery_id: claim.id,
        p_external_ref: externalRef,
        p_content: draft,
        p_actor_type: 'AI',
      });

      if (recordError) {
        // Sanitize log: constant code and delivery ID only, no raw recordError.message
        console.error(`[MessengerDelivery] record_ai_messenger_live_outbound failed for delivery ${claim.id}`);
        // Successful provider send + record error => explicit non-retryable failure with provider ID preserved
        return {
          outcome: 'FAILED',
          externalMessageId: dispatchResult.mid,
          errorCode: 'OUTBOUND_PERSISTENCE_FAILED',
        };
      }

      return {
        outcome: 'SENT',
        externalMessageId: dispatchResult.mid,
      };
    }

    if (dispatchResult.status === 'UNKNOWN') {
      return {
        outcome: 'UNCERTAIN',
        errorCode: 'MESSENGER_DISPATCH_UNCERTAIN',
      };
    }

    return {
      outcome: 'FAILED',
      errorCode: 'MESSENGER_DISPATCH_FAILED',
    };
  }
}
