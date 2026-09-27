import { createAdminClient } from '../../../lib/supabase/admin';
import { ZaloClient, ZaloClientFactory } from './zalo-client';
import { ZaloWebhookPayload } from './types';
import { sanitizeMessageContent } from './sanitizer';
import { IZaloOAMappingResolver, ZaloOAMappingService } from './oa-mapping';

import type { SupabaseClient } from '@supabase/supabase-js';

export interface SyncResult {
  status: 'synced' | 'duplicate' | 'ignored' | 'error' | 'busy';
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
 *    Uses zalo_ingress_events table with state machine ('CLAIMED', 'PROCESSED', 'FAILED').
 *    Atomic claim via zalo_claim_ingress_event RPC.
 * 3. Atomic Ingress Pipeline & Zero JS Rollback:
 *    Postgres RPC (zalo_process_ingress_message) executes complete CRM mutation atomically.
 *    No manual JS compensation deletes. PostgreSQL rolls back automatically on error.
 * 4. Zero-Phone Sanitization:
 *    Sanitizes public text before recording; sets sanitization_status = 'SUCCEEDED' for SALE.
 */
export class ZaloSyncService {
  private readonly supabase: SupabaseClient;
  private readonly zaloClient?: ZaloClient;
  private readonly oaMappingResolver: IZaloOAMappingResolver;

  constructor(options: ZaloSyncServiceOptions = {}) {
    // 1. Initialize supabase client first (Fix Lỗi 1)
    const supabase = options.supabase ?? createAdminClient();
    this.supabase = supabase;

    // 2. Only mock client allowed from test suite (Fix Lỗi 7)
    this.zaloClient = options.zaloClient;

    // 3. Inject initialized supabase instance into ZaloOAMappingService
    if (options.oaMappingResolver) {
      this.oaMappingResolver = options.oaMappingResolver;
    } else {
      const customMapping: Record<string, string> = {};
      if (options.defaultCompanyId) {
        customMapping['__test_fallback__'] = options.defaultCompanyId;
        if (this.zaloClient?.oaId) {
          customMapping[this.zaloClient.oaId] = options.defaultCompanyId;
        }
      }
      this.oaMappingResolver = new ZaloOAMappingService({
        customMapping,
        supabase: this.supabase,
        allowTestMockFallback: Boolean(options.defaultCompanyId),
      });
    }
  }

  /**
   * Main webhook event ingestion pipeline.
   * Atomically claims event, processes data entities, and records private raw payload via DB RPC.
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

    // 2. RESOLVE CLIENT: Dynamic tenant client via ZaloClientFactory in production runtime (Fix Lỗi 7)
    const client =
      this.zaloClient ??
      (await ZaloClientFactory.getClientForOa(companyId, oaId, { supabase: this.supabase }));

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

    // 3. DURABLE IDEMPOTENCY CLAIM INVARIANT (Fix Lỗi 2, 13)
    // Namespaced idempotency key: zalo:companyId:oaId:rawMsgId
    const namespacedExternalRef = `zalo:${companyId}:${oaId}:${rawMsgId}`;

    // Atomically claim via zalo_claim_ingress_event RPC
    const { data: claimData, error: claimRpcError } = await this.supabase.rpc('zalo_claim_ingress_event', {
      p_company_id: companyId,
      p_oa_id: oaId,
      p_external_ref: namespacedExternalRef,
      p_event_name: eventName,
      p_sender_id: senderId,
      p_recipient_id: recipientId,
    });

    if (claimRpcError) {
      throw new Error(`Failed to claim webhook ingress event: ${claimRpcError.message}`);
    }

    const claimResult = Array.isArray(claimData) ? claimData[0] : claimData;
    const claimStatus = claimResult?.claim_status || 'CLAIMED';

    if (claimStatus === 'DUPLICATE') {
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

    if (claimStatus === 'BUSY') {
      return {
        status: 'busy',
        message: 'Event is currently being processed by another worker (lease active). Retry later.',
      };
    }

    // 4. ATOMIC CRM INGRESS MUTATION (Zero JS Compensation, Fix Lỗi 3, 13)
    let customerName = `Khách Zalo ${zaloUserUid.slice(-4)}`;
    try {
      const profile = await client.getUserProfile(zaloUserUid);
      if (profile?.user_name) {
        customerName = profile.user_name;
      }
    } catch {
      // Fallback to placeholder name
    }

    const { sanitizedText } = sanitizeMessageContent(rawContent);

    try {
      const { data: mutationData, error: mutationError } = await this.supabase.rpc('zalo_process_ingress_message', {
        p_company_id: companyId,
        p_oa_id: oaId,
        p_external_ref: namespacedExternalRef, // Fix Lỗi 13: namespaced external ref
        p_raw_msg_id: rawMsgId,                // Provider message ID in source_metadata
        p_zalo_user_uid: zaloUserUid,
        p_user_name: customerName,
        p_event_name: eventName,
        p_sender_id: senderId,
        p_recipient_id: recipientId,
        p_is_inbound: isInbound,
        p_sanitized_content: sanitizedText,
        p_raw_content: rawContent,
        p_raw_payload: event as unknown as Record<string, unknown>,
        p_timestamp: typeof event.timestamp === 'number' ? event.timestamp : Date.now(),
      });

      if (mutationError || !mutationData) {
        throw new Error(
          mutationError?.message || 'Atomic ingress mutation failed at database level'
        );
      }

      const res = mutationData as {
        customer_id: string;
        conversation_id: string;
        interaction_id: string;
        is_new_customer: boolean;
      };

      // 5. POST-INGESTION CARE ACTIONS
      if (isInbound) {
        await this.handlePostMessageCareActions(companyId, res.customer_id, rawContent);
      }

      return {
        status: 'synced',
        interactionId: res.interaction_id,
        conversationId: res.conversation_id,
        customerId: res.customer_id,
        isNewCustomer: res.is_new_customer,
        message: 'Message processed and recorded successfully',
      };
    } catch (pipelineError: unknown) {
      // ZERO JS ROLLBACK: PostgreSQL transaction already rolled back atomic state.
      // Update ingress event to FAILED with last_error.
      const errorMsg = pipelineError instanceof Error ? pipelineError.message : 'Pipeline error';
      await this.supabase
        .from('zalo_ingress_events')
        .update({
          status: 'FAILED',
          last_error: errorMsg,
          updated_at: new Date().toISOString(),
        })
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
