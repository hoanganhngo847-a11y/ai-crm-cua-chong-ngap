import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { binding as defaultBinding, type PageBinding } from '@/features/omnichannel/facebook/binding';
import { canReply } from '@/features/omnichannel/facebook/core';
import { dispatchMessage } from '@/features/omnichannel/facebook/transport';
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
    const { claim, draft } = params;

    // 1. Resolve conversation external ID (format: "pageId:recipientPsid")
    const { data: conv, error: convError } = await this.supabase
      .from('conversations')
      .select('id, company_id, channel, external_conversation_id')
      .eq('id', claim.conversation_id)
      .eq('company_id', claim.company_id)
      .maybeSingle();

    if (convError || !conv) {
      return { outcome: 'FAILED', errorCode: 'CONVERSATION_NOT_FOUND' };
    }

    const externalId = conv.external_conversation_id || '';
    const colonIdx = externalId.indexOf(':');
    if (colonIdx <= 0 || colonIdx === externalId.length - 1) {
      return { outcome: 'FAILED', errorCode: 'INVALID_EXTERNAL_CONVERSATION_ID' };
    }

    const pageId = externalId.slice(0, colonIdx);
    const recipientPsid = externalId.slice(colonIdx + 1);

    // 2. Resolve Page credentials via binding
    let config: PageBinding;
    try {
      config = this.resolveBinding(pageId);
    } catch {
      return { outcome: 'FAILED', errorCode: 'PAGE_NOT_CONFIGURED' };
    }

    if (config.company !== claim.company_id) {
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

    // 3. 24-hour messaging window guard
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

    if (!canReply(latestInbound?.created_at || null)) {
      return { outcome: 'FAILED', errorCode: 'MESSAGING_WINDOW_CLOSED' };
    }

    // 4. Dispatch via Meta Graph API
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
      // 5. Atomically record outbound interaction on CRM timeline
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
        console.error(`[MessengerDelivery] record_ai_messenger_live_outbound failed: ${recordError.message}`);
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
