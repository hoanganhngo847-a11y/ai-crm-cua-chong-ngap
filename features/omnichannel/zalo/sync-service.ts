import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../../lib/supabase/admin';
import { ZaloClient, ZaloClientFactory } from './zalo-client';
import { ZaloWebhookPayload } from './types';
import { sanitizeMessageContent } from './sanitizer';
import { detectCareOptOut } from './opt-out';
import { IZaloOAMappingResolver, ZaloOAMappingService, ZaloOATenant } from './oa-mapping';

export interface SyncResult {
  status: 'synced' | 'duplicate' | 'ignored' | 'busy';
  interactionId?: string;
  conversationId?: string;
  customerId?: string;
  isNewCustomer?: boolean;
  message?: string;
}

export type ZaloClientProvider = (companyId: string, oaId: string) => Promise<ZaloClient>;

export interface ZaloSyncServiceOptions {
  supabase?: SupabaseClient;
  oaMappingResolver?: IZaloOAMappingResolver;
  /** Overrides per-OA client resolution (tests). Production uses ZaloClientFactory. */
  clientProvider?: ZaloClientProvider;
  fetchFn?: typeof fetch;
}

type StatusKind = 'DELIVERED' | 'READ' | 'FOLLOW' | 'UNFOLLOW';

type ClassifiedEvent =
  | { kind: 'MESSAGE'; inbound: boolean; oaId: string; userId: string }
  | { kind: 'STATUS'; status: StatusKind; oaId: string; userId: string }
  | { kind: 'IGNORED' };

interface ClaimRow {
  claim_status: 'CLAIMED' | 'DUPLICATE' | 'BUSY';
  event_id: string;
  retry_count: number;
  claim_token: string | null;
}

interface IngressResult {
  duplicate: boolean;
  customer_id: string | null;
  conversation_id: string | null;
  interaction_id: string | null;
  is_new_customer: boolean;
}

/**
 * Maps a Zalo webhook payload to (OA id, Zalo user id) and an ingestion kind.
 * The OA id is only a lookup key: the company is always resolved server-side from it.
 */
export function classifyZaloEvent(event: ZaloWebhookPayload): ClassifiedEvent {
  const name = event.event_name || '';

  if (name.startsWith('user_send_')) {
    return { kind: 'MESSAGE', inbound: true, oaId: event.oa_id || event.recipient?.id || '', userId: event.sender?.id || '' };
  }
  if (name.startsWith('oa_send_')) {
    return { kind: 'MESSAGE', inbound: false, oaId: event.oa_id || event.sender?.id || '', userId: event.recipient?.id || '' };
  }
  if (name === 'user_received_message' || name === 'user_seen_message') {
    return {
      kind: 'STATUS',
      status: name === 'user_received_message' ? 'DELIVERED' : 'READ',
      oaId: event.oa_id || event.sender?.id || '',
      userId: event.recipient?.id || '',
    };
  }
  if (name === 'follow' || name === 'unfollow') {
    return {
      kind: 'STATUS',
      status: name === 'follow' ? 'FOLLOW' : 'UNFOLLOW',
      oaId: event.oa_id || event.recipient?.id || '',
      userId: event.follower?.id || event.sender?.id || '',
    };
  }
  return { kind: 'IGNORED' };
}

function parseEventTime(timestamp: number | string | undefined): string {
  const ms = Number(timestamp);
  if (Number.isFinite(ms) && ms > 0) {
    return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

/**
 * Canonical provider reference shared by ingress, outbound finalize and dedupe:
 *   zalo:{companyId}:{oaId}:{providerMessageId}
 */
export function canonicalZaloExternalRef(companyId: string, oaId: string, providerRef: string): string {
  return `zalo:${companyId}:${oaId}:${providerRef}`;
}

/**
 * Synchronizes incoming Zalo webhook events into the CRM core model.
 *
 * Invariants:
 * 1. Tenant isolation — company is derived from the verified OA id; unknown OA fails closed.
 * 2. Durable claim — zalo_claim_ingress_event (PROCESSED → duplicate, FAILED/stale → re-claim,
 *    active lease → busy). Only the holder of the claim token can process or fail the event.
 * 3. Atomic ingress — zalo_process_ingress_message performs customer/identity, conversation,
 *    interaction, private raw, care response/opt-out and PROCESSED in ONE DB transaction.
 *    There is no JS compensation: on error PostgreSQL rolls back and the event is marked FAILED
 *    so the provider retry re-claims it.
 * 4. Zero-phone — only sanitized text reaches public.interactions.
 */
export class ZaloSyncService {
  private readonly supabase: SupabaseClient;
  private readonly oaMappingResolver: IZaloOAMappingResolver;
  private readonly clientProvider: ZaloClientProvider;

  constructor(options: ZaloSyncServiceOptions = {}) {
    // The tenant resolver MUST share the same (service-role) client: it looks up zalo_oa_configs.
    const supabase = options.supabase ?? createAdminClient();
    this.supabase = supabase;
    this.oaMappingResolver = options.oaMappingResolver ?? new ZaloOAMappingService(supabase);
    this.clientProvider =
      options.clientProvider ??
      ((companyId, oaId) =>
        ZaloClientFactory.getClientForOa(companyId, oaId, { supabase, fetchFn: options.fetchFn }));
  }

  /**
   * @param tenant pre-resolved tenant (the webhook handler resolves it to pick the signing secret).
   */
  async handleWebhookEvent(event: ZaloWebhookPayload, tenant?: ZaloOATenant): Promise<SyncResult> {
    const classified = classifyZaloEvent(event);
    if (classified.kind === 'IGNORED') {
      return { status: 'ignored', message: `Unhandled event type: ${event.event_name}` };
    }

    const resolvedTenant =
      tenant && tenant.oaId === classified.oaId ? tenant : await this.oaMappingResolver.resolveTenant(classified.oaId);
    const companyId = resolvedTenant.companyId;
    const oaId = resolvedTenant.oaId;

    if (!classified.userId) {
      return { status: 'ignored', message: 'Missing Zalo user id in webhook payload' };
    }

    const providerRef = this.providerRefFor(event, classified);
    const externalRef = canonicalZaloExternalRef(companyId, oaId, providerRef);

    const { data: claimData, error: claimError } = await this.supabase.rpc('zalo_claim_ingress_event', {
      p_company_id: companyId,
      p_oa_id: oaId,
      p_external_ref: externalRef,
      p_event_name: event.event_name,
      p_sender_id: event.sender?.id ?? null,
      p_recipient_id: event.recipient?.id ?? null,
    });
    if (claimError) {
      throw new Error(`Failed to claim webhook ingress event: ${claimError.message}`);
    }

    const claim = (Array.isArray(claimData) ? claimData[0] : claimData) as ClaimRow | undefined;
    if (!claim) {
      throw new Error('Ingress claim returned no result');
    }
    if (claim.claim_status === 'DUPLICATE') {
      return { status: 'duplicate', message: 'Event already processed' };
    }
    if (claim.claim_status === 'BUSY') {
      return { status: 'busy', message: 'Event is being processed by another worker (lease active). Retry later.' };
    }

    const claimToken = claim.claim_token as string;

    try {
      if (classified.kind === 'STATUS') {
        await this.processStatusEvent(event, classified.status, classified.userId, {
          eventId: claim.event_id,
          claimToken,
          companyId,
          oaId,
          externalRef,
        });
        return { status: 'synced', message: `Status event ${classified.status} recorded` };
      }

      const result = await this.processMessageEvent(event, classified.inbound, classified.userId, providerRef, {
        eventId: claim.event_id,
        claimToken,
        companyId,
        oaId,
        externalRef,
      });

      return {
        status: result.duplicate ? 'duplicate' : 'synced',
        interactionId: result.interaction_id ?? undefined,
        conversationId: result.conversation_id ?? undefined,
        customerId: result.customer_id ?? undefined,
        isNewCustomer: result.is_new_customer,
        message: result.duplicate ? 'Message already recorded under the canonical reference' : 'Message recorded',
      };
    } catch (pipelineError: unknown) {
      const message = pipelineError instanceof Error ? pipelineError.message : 'Ingress pipeline error';
      // Only the claim holder can fail the event; a lost claim is a no-op here.
      const { error: failError } = await this.supabase.rpc('zalo_fail_ingress_event', {
        p_event_id: claim.event_id,
        p_claim_token: claimToken,
        p_error: message,
      });
      if (failError) {
        console.error(`[ZaloSync] Could not mark ingress event FAILED (lease will expire): ${failError.message}`);
      }
      throw pipelineError;
    }
  }

  private providerRefFor(event: ZaloWebhookPayload, classified: Exclude<ClassifiedEvent, { kind: 'IGNORED' }>): string {
    if (classified.kind === 'MESSAGE' && event.message?.msg_id) {
      return event.message.msg_id;
    }
    // Receipts/follow events carry no message id: derive a deterministic, collision-resistant ref.
    const material = JSON.stringify([
      event.event_name,
      String(event.timestamp),
      classified.userId,
      [...(event.message?.msg_ids || [])].sort(),
    ]);
    const digest = crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
    return `${event.event_name}:${digest}`;
  }

  private async processMessageEvent(
    event: ZaloWebhookPayload,
    inbound: boolean,
    zaloUserUid: string,
    providerMsgId: string,
    claim: { eventId: string; claimToken: string; companyId: string; oaId: string; externalRef: string }
  ): Promise<IngressResult> {
    let rawContent = event.message?.text || '';
    if (!rawContent && event.message?.attachments?.length) {
      rawContent = `[Tệp đính kèm: ${event.message.attachments[0].type}]`;
    }
    if (!rawContent) {
      rawContent = `[Tin nhắn ${event.event_name}]`;
    }

    const userName = inbound ? await this.lookupDisplayNameForNewUser(claim.companyId, claim.oaId, zaloUserUid) : '';
    const { sanitizedText } = sanitizeMessageContent(rawContent);

    const { data, error } = await this.supabase.rpc('zalo_process_ingress_message', {
      p_event_id: claim.eventId,
      p_claim_token: claim.claimToken,
      p_company_id: claim.companyId,
      p_oa_id: claim.oaId,
      p_external_ref: claim.externalRef,
      p_raw_msg_id: providerMsgId,
      p_zalo_user_uid: zaloUserUid,
      p_user_name: userName,
      p_event_name: event.event_name,
      p_sender_id: event.sender?.id ?? null,
      p_recipient_id: event.recipient?.id ?? null,
      p_is_inbound: inbound,
      p_sanitized_content: sanitizedText,
      p_raw_content: rawContent,
      p_raw_payload: event as unknown as Record<string, unknown>,
      p_event_at: parseEventTime(event.timestamp),
      p_opt_out: inbound && detectCareOptOut(rawContent),
    });

    if (error || !data) {
      throw new Error(error?.message || 'Atomic ingress transaction returned no result');
    }
    return data as IngressResult;
  }

  private async processStatusEvent(
    event: ZaloWebhookPayload,
    status: StatusKind,
    zaloUserUid: string,
    claim: { eventId: string; claimToken: string; companyId: string; oaId: string; externalRef: string }
  ): Promise<void> {
    const { error } = await this.supabase.rpc('zalo_process_ingress_status_event', {
      p_event_id: claim.eventId,
      p_claim_token: claim.claimToken,
      p_company_id: claim.companyId,
      p_oa_id: claim.oaId,
      p_external_ref: claim.externalRef,
      p_kind: status,
      p_zalo_user_uid: zaloUserUid,
      p_provider_msg_ids: event.message?.msg_ids || [],
      p_event_at: parseEventTime(event.timestamp),
    });
    if (error) {
      throw new Error(error.message);
    }
  }

  /**
   * Fetches the Zalo display name only when the user has no identity yet (first message).
   * Profile failures never block ingestion; the DB falls back to "Khách Zalo xxxx".
   */
  private async lookupDisplayNameForNewUser(companyId: string, oaId: string, zaloUserUid: string): Promise<string> {
    const { data: identity } = await this.supabase
      .from('identities')
      .select('id')
      .eq('company_id', companyId)
      .eq('channel', 'ZALO')
      .eq('external_id', zaloUserUid)
      .maybeSingle();
    if (identity) {
      return '';
    }

    try {
      const client = await this.clientProvider(companyId, oaId);
      const profile = await client.getUserProfile(zaloUserUid);
      // A display name is user-controlled text: strip anything that looks like a phone number.
      return profile?.user_name ? sanitizeMessageContent(profile.user_name).sanitizedText.slice(0, 120) : '';
    } catch {
      return '';
    }
  }
}
