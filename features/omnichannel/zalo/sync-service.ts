import { createAdminClient } from '../../../lib/supabase/admin';
import { ZaloClient } from './zalo-client';
import { ZaloWebhookPayload } from './types';
import { sanitizeMessageContent } from './sanitizer';
import { IZaloOAMappingResolver, ZaloOAMappingService } from './oa-mapping';

import type { SupabaseClient } from '@supabase/supabase-js';

export interface SyncResult {
  status: 'synced' | 'duplicate' | 'ignored' | 'error';
  interactionId?: string;
  conversationId?: string;
  customerId?: string;
  isNewCustomer?: boolean;
  message?: string;
}

export interface ZaloSyncServiceOptions {
  supabase?: SupabaseClient;
  zaloClient?: ZaloClient;
  oaMappingResolver?: IZaloOAMappingResolver;
  defaultCompanyId?: string;
}

const OPT_OUT_KEYWORDS = [
  'dung lam phien',
  'dừng làm phiền',
  'ngung gui',
  'ngừng gửi',
  'khong co nhu cau',
  'không có nhu cầu',
  'huy',
  'hủy',
  'stop',
  'tu choi',
  'từ chối',
];

/**
 * Service to synchronize incoming Zalo events to the Core CRM Data Model.
 *
 * Security & Data Invariants:
 * 1. Provider Verification & Tenant Isolation:
 *    Maps company_id server-side via verified OA ID. Fails closed if OA ID is unmapped.
 * 2. Durable Idempotency Claim Invariant:
 *    Uses zalo_ingress_events table with UNIQUE(company_id, oa_id, external_ref).
 *    Claims via INSERT ... ON CONFLICT DO NOTHING (or unique constraint rejection).
 * 3. Atomic Ingress Pipeline:
 *    Pipeline: Ingress Claim -> Customer -> Identity -> Conversation -> Interaction -> Private Raw Data.
 *    Fail-closed: Absolutely NEVER catch and swallow private raw payload storage errors.
 *    Rolls back on failure to prevent orphan records.
 * 4. Zero-Phone Sanitization:
 *    Sanitizes public text before recording; sets sanitization_status = 'SUCCEEDED' for SALE.
 */
export class ZaloSyncService {
  private readonly supabase: SupabaseClient;
  private readonly zaloClient: ZaloClient;
  private readonly oaMappingResolver: IZaloOAMappingResolver;

  constructor(options: ZaloSyncServiceOptions = {}) {
    this.zaloClient = options.zaloClient || new ZaloClient();

    if (options.oaMappingResolver) {
      this.oaMappingResolver = options.oaMappingResolver;
    } else {
      const customMapping: Record<string, string> = {};
      if (options.defaultCompanyId) {
        customMapping['__test_fallback__'] = options.defaultCompanyId;
        if (this.zaloClient.oaId) {
          customMapping[this.zaloClient.oaId] = options.defaultCompanyId;
        }
      }
      this.oaMappingResolver = new ZaloOAMappingService({
        customMapping,
        supabase: options.supabase,
        allowTestMockFallback: Boolean(options.defaultCompanyId),
      });
    }

    if (options.supabase) {
      this.supabase = options.supabase;
    } else {
      this.supabase = createAdminClient();
    }
  }

  /**
   * Main webhook event ingestion pipeline.
   * Atomically claims event, processes data entities, and records private raw payload.
   */
  async handleWebhookEvent(event: ZaloWebhookPayload): Promise<SyncResult> {
    const eventName = event.event_name;
    const isUserMessage = eventName.startsWith('user_send_');
    const isOaMessage = eventName.startsWith('oa_send_');

    if (!isUserMessage && !isOaMessage) {
      return { status: 'ignored', message: `Unhandled event type: ${eventName}` };
    }

    // 1. TENANT ISOLATION: Derive company_id server-side from verified OA ID
    const oaId =
      event.oa_id ||
      (isUserMessage ? event.recipient?.id : event.sender?.id) ||
      '';

    const companyId = await this.oaMappingResolver.resolveCompanyId(oaId);

    const senderId = event.sender?.id;
    const recipientId = event.recipient?.id;
    const rawMsgId = event.message?.msg_id || `${eventName}_${event.timestamp}_${senderId}`;

    if (!senderId) {
      return { status: 'error', message: 'Missing sender ID in webhook payload' };
    }

    const isInbound = isUserMessage;
    const zaloUserUid = isInbound ? senderId : recipientId;

    if (!zaloUserUid) {
      return { status: 'error', message: 'Missing Zalo user UID in webhook payload' };
    }

    // Extract raw text content
    let rawContent = event.message?.text || '';
    if (!rawContent && event.message?.attachments && event.message.attachments.length > 0) {
      const firstAttachment = event.message.attachments[0];
      rawContent = `[Tệp đính kèm: ${firstAttachment.type}]`;
    }
    if (!rawContent) {
      rawContent = `[Tin nhắn ${eventName}]`;
    }

    // 2. DURABLE IDEMPOTENCY CLAIM INVARIANT:
    // Namespaced idempotency key: zalo:companyId:oaId:rawMsgId
    const namespacedExternalRef = `zalo:${companyId}:${oaId}:${rawMsgId}`;

    // Atomically claim the ingress event via DB invariant (UNIQUE constraint on company_id, oa_id, external_ref)
    const { error: claimError } = await this.supabase
      .from('zalo_ingress_events')
      .insert({
        company_id: companyId,
        oa_id: oaId,
        external_ref: namespacedExternalRef,
        event_name: eventName,
        sender_id: senderId,
        recipient_id: recipientId,
        status: 'CLAIMED',
      });

    if (claimError) {
      // 23505 is PostgreSQL unique_violation error code
      const isUniqueViolation =
        claimError.code === '23505' ||
        claimError.message?.toLowerCase().includes('unique') ||
        claimError.message?.toLowerCase().includes('duplicate');

      if (isUniqueViolation) {
        // Query existing interaction to return consistent idempotent acknowledgment
        const { data: existingInteraction } = await this.supabase
          .from('interactions')
          .select('id, conversation_id, customer_id')
          .eq('company_id', companyId)
          .eq('channel', 'ZALO')
          .in('external_ref', [rawMsgId, namespacedExternalRef])
          .maybeSingle();

        return {
          status: 'duplicate',
          interactionId: existingInteraction?.id,
          conversationId: existingInteraction?.conversation_id,
          customerId: existingInteraction?.customer_id,
          message: 'Duplicate event skipped by idempotency claim invariant',
        };
      }

      throw new Error(`Failed to claim webhook ingress event: ${claimError.message}`);
    }

    // Pipeline tracking for safe atomic rollback on downstream failure
    let createdCustomerId: string | null = null;
    let createdIdentityId: string | null = null;
    let createdConversationId: string | null = null;
    let createdInteractionId: string | null = null;

    try {
      // 3. EVIDENCE CONTRACT: IDENTITY & CUSTOMER RESOLUTION
      let customerId: string;
      let isNewCustomer = false;

      const { data: existingIdentity } = await this.supabase
        .from('identities')
        .select('id, customer_id')
        .eq('company_id', companyId)
        .eq('channel', 'ZALO')
        .eq('external_id', zaloUserUid)
        .maybeSingle();

      if (existingIdentity?.customer_id) {
        customerId = existingIdentity.customer_id;
      } else {
        isNewCustomer = true;
        let customerName = `Khách Zalo ${zaloUserUid.slice(-4)}`;

        try {
          const profile = await this.zaloClient.getUserProfile(zaloUserUid);
          if (profile.user_name) {
            customerName = profile.user_name;
          }
        } catch {
          // Fallback to placeholder name
        }

        const { data: newCustomer, error: custError } = await this.supabase
          .from('customers')
          .insert({
            company_id: companyId,
            name: customerName,
            source: 'ZALO_OA',
            stage: 'LEAD_NEW',
          })
          .select('id')
          .single();

        if (custError || !newCustomer) {
          throw new Error(`Failed to create customer for Zalo UID ${zaloUserUid}: ${custError?.message}`);
        }

        customerId = newCustomer.id;
        createdCustomerId = newCustomer.id;

        // Link identity strictly by external_id
        const { data: newIdent, error: identError } = await this.supabase
          .from('identities')
          .insert({
            company_id: companyId,
            customer_id: customerId,
            channel: 'ZALO',
            external_id: zaloUserUid,
            verified: false,
            metadata: { zalo_uid: zaloUserUid },
          })
          .select('id')
          .maybeSingle();

        if (identError) {
          throw new Error(`Failed to create identity for Zalo UID ${zaloUserUid}: ${identError.message}`);
        }

        if (newIdent) {
          createdIdentityId = newIdent.id;
        }
      }

      // 4. CONVERSATION MANAGEMENT
      let conversationId: string;
      const nowIso = new Date().toISOString();

      const { data: existingConversation } = await this.supabase
        .from('conversations')
        .select('id, unread_count')
        .eq('company_id', companyId)
        .eq('channel', 'ZALO')
        .eq('external_conversation_id', zaloUserUid)
        .maybeSingle();

      if (existingConversation) {
        conversationId = existingConversation.id;
        const newUnread = isInbound
          ? existingConversation.unread_count + 1
          : existingConversation.unread_count;

        await this.supabase
          .from('conversations')
          .update({
            last_message_at: nowIso,
            unread_count: newUnread,
            status: 'OPEN',
            updated_at: nowIso,
          })
          .eq('id', conversationId);
      } else {
        const { data: newConv, error: convError } = await this.supabase
          .from('conversations')
          .insert({
            company_id: companyId,
            customer_id: customerId,
            channel: 'ZALO',
            external_conversation_id: zaloUserUid,
            last_message_at: nowIso,
            unread_count: isInbound ? 1 : 0,
            status: 'OPEN',
          })
          .select('id')
          .single();

        if (convError || !newConv) {
          throw new Error(`Failed to create conversation for Zalo UID ${zaloUserUid}: ${convError?.message}`);
        }

        conversationId = newConv.id;
        createdConversationId = newConv.id;
      }

      // 5. SECURITY ZONE INGRESS: SANITIZE CONTENT & RECORD INTERACTION
      const { sanitizedText } = sanitizeMessageContent(rawContent);

      const { data: newInteraction, error: intError } = await this.supabase
        .from('interactions')
        .insert({
          company_id: companyId,
          customer_id: customerId,
          conversation_id: conversationId,
          channel: 'ZALO',
          type: 'MESSAGE',
          direction: isInbound ? 'INBOUND' : 'OUTBOUND',
          sanitized_content: sanitizedText,
          sanitization_status: 'SUCCEEDED',
          sanitized_at: nowIso,
          sanitizer_version: 'v1.0',
          external_ref: rawMsgId,
          actor_type: isInbound ? 'CUSTOMER' : 'SALE',
          actor_user_id: null,
          created_at: nowIso,
        })
        .select('id')
        .single();

      if (intError || !newInteraction) {
        throw new Error(`Failed to insert interaction: ${intError?.message}`);
      }

      createdInteractionId = newInteraction.id;

      // 6. PRIVATE SECURITY ZONE: RECORD RAW PAYLOAD & RAW CONTENT
      // CRITICAL: NEVER swallow or ignore errors here. Fail closed and rollback on failure.
      const rawRecord = {
        interaction_id: newInteraction.id,
        company_id: companyId,
        raw_content: rawContent,
        raw_payload: event as unknown as Record<string, unknown>,
        source_metadata: {
          oa_id: oaId,
          sender_id: senderId,
          recipient_id: recipientId,
          timestamp: event.timestamp,
          event_name: event.event_name,
        },
        created_at: nowIso,
      };

      type SupabaseWithSchema = SupabaseClient & {
        schema?: (s: string) => { from: (t: string) => ReturnType<SupabaseClient['from']> };
      };
      const clientWithSchema = this.supabase as SupabaseWithSchema;

      let rawInsertError: { message?: string } | null = null;
      if (typeof clientWithSchema.schema === 'function') {
        const res = await clientWithSchema.schema('private').from('interaction_raw_contents').insert(rawRecord);
        rawInsertError = res.error;
      } else {
        const res = await this.supabase.from('interaction_raw_contents').insert(rawRecord);
        rawInsertError = res.error;
      }

      if (rawInsertError) {
        throw new Error(
          `Security Zone Ingress Violation: Failed to persist raw interaction content in private zone: ${rawInsertError.message}`
        );
      }

      // Mark ingress event as PROCESSED
      await this.supabase
        .from('zalo_ingress_events')
        .update({ status: 'PROCESSED' })
        .eq('company_id', companyId)
        .eq('oa_id', oaId)
        .eq('external_ref', namespacedExternalRef);

      // 7. POST-INGESTION CARE ACTIONS
      if (isInbound) {
        await this.handlePostMessageCareActions(companyId, customerId, rawContent);
      }

      return {
        status: 'synced',
        interactionId: newInteraction.id,
        conversationId,
        customerId,
        isNewCustomer,
        message: 'Message processed and recorded successfully',
      };
    } catch (pipelineError: unknown) {
      // ATOMIC INGRESS ROLLBACK: Cleanup created entities to prevent orphan data
      if (createdInteractionId) {
        await this.supabase.from('interactions').delete().eq('id', createdInteractionId);
      }
      if (createdConversationId) {
        await this.supabase.from('conversations').delete().eq('id', createdConversationId);
      }
      if (createdIdentityId) {
        await this.supabase.from('identities').delete().eq('id', createdIdentityId);
      }
      if (createdCustomerId) {
        await this.supabase.from('customers').delete().eq('id', createdCustomerId);
      }

      // Mark ingress event as FAILED
      const errorMsg = pipelineError instanceof Error ? pipelineError.message : 'Pipeline error';
      await this.supabase
        .from('zalo_ingress_events')
        .update({ status: 'FAILED', error_message: errorMsg })
        .eq('company_id', companyId)
        .eq('oa_id', oaId)
        .eq('external_ref', namespacedExternalRef);

      throw pipelineError;
    }
  }

  /**
   * Handles post-inbound care automation:
   * 1. Detects customer opt-out keywords and disables care schedule.
   * 2. Flags any recent care deliveries as responded.
   */
  private async handlePostMessageCareActions(
    companyId: string,
    customerId: string,
    content: string
  ): Promise<void> {
    const normalizedText = content.toLowerCase().trim();

    // Check Opt-out intent
    const isOptOut = OPT_OUT_KEYWORDS.some((kw) => normalizedText.includes(kw));
    if (isOptOut) {
      await this.supabase
        .from('care_schedules')
        .update({
          enabled: false,
          stop_reason: 'CUSTOMER_OPT_OUT',
          updated_at: new Date().toISOString(),
        })
        .eq('company_id', companyId)
        .eq('customer_id', customerId)
        .eq('channel', 'ZALO');
    }

    // Check if there is an active recent CareDelivery awaiting response
    const { data: pendingDelivery } = await this.supabase
      .from('care_deliveries')
      .select('id')
      .eq('company_id', companyId)
      .eq('customer_id', customerId)
      .eq('channel', 'ZALO')
      .in('status', ['SENT', 'DELIVERED'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (pendingDelivery) {
      await this.supabase
        .from('care_deliveries')
        .update({
          status: 'RESPONDED',
          responded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', pendingDelivery.id);
    }
  }
}
