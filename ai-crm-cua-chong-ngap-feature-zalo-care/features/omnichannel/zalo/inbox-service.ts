import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../../lib/supabase/admin';
import { ZaloClient, ZaloClientFactory } from './zalo-client';
import { sanitizeMessageContent } from './sanitizer';
import { ServerAuthError } from '../../../lib/server-auth/errors';
import {
  SendZaloReplyParams,
  SendZaloReplyResult,
  ZaloConversationItem,
  ZaloMessageItem,
} from './types';

interface ConversationDbRow {
  id: string;
  company_id: string;
  customer_id: string;
  channel: 'ZALO';
  external_conversation_id: string;
  last_message_at: string;
  unread_count: number;
  status: 'OPEN' | 'PENDING_SALE' | 'AI_HANDLING' | 'CLOSED';
  assigned_to?: string | null;
  customers?: { name?: string } | null;
}

interface InteractionDbRow {
  id: string;
  conversation_id: string;
  customer_id: string;
  channel: 'ZALO';
  type: 'MESSAGE';
  direction: 'INBOUND' | 'OUTBOUND';
  sanitized_content?: string | null;
  external_ref: string | null;
  actor_type: 'CUSTOMER' | 'SALE' | 'SYSTEM' | 'AI' | 'TECHNICIAN';
  actor_user_id?: string | null;
  created_at: string;
}

interface OutboundDeliveryDbRow {
  id: string;
  company_id: string;
  conversation_id: string;
  customer_id: string;
  recipient_zalo_uid: string;
  content: string;
  provider_msg_id: string | null;
  status: string;
}

export interface ZaloInboxServiceOptions {
  supabase?: SupabaseClient;
  zaloClient?: ZaloClient;
}

export interface GetZaloConversationsParams {
  companyId: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface GetZaloMessagesParams {
  companyId: string;
  conversationId: string;
  limit?: number;
  offset?: number;
}

export interface AuthenticatedActor {
  userId: string;
  companyId: string;
  role: string;
}

export interface SendZaloReplyContext {
  actor: AuthenticatedActor;
}

export interface SendSystemZaloReplyContext {
  principal: 'SYSTEM';
  systemUserId?: string;
}

const ALLOWED_ACTOR_ROLES = ['SALE', 'BOSS_ADMIN'];

/**
 * Service providing the standardized interface for Member 2 (Unified Inbox).
 *
 * Security Invariants & Outbound Safety:
 * 1. Actor Authentication & Authorization (Fix Lỗi 4):
 *    - Enforces context.actor presence, active tenant match, and whitelist role ('SALE' | 'BOSS_ADMIN').
 *    - Rejects unauthorized or cross-tenant outbound requests with 401/403.
 * 2. Durable Outbox & Stable Idempotency (Fix Lỗi 5):
 *    - Generates or receives deterministic UUIDv4/caller command_id (No Math.random()).
 *    - Pre-records outbox entry in PENDING before provider call.
 *    - Fail-closed: Halts immediately if outbox insertion fails.
 * 3. Provider Call & Finalize Transaction (Fix Lỗi 6):
 *    - Updates outbox to SENDING with lease_until.
 *    - Calls Zalo Provider API.
 *    - On provider success: updates provider_msg_id and calls atomic finalize RPC.
 *    - If DB finalize fails: marks outbox as PROVIDER_SENT_PENDING_FINALIZE (NEVER resends to provider).
 */
export class ZaloInboxService {
  private readonly supabase: SupabaseClient;
  private readonly zaloClient?: ZaloClient;

  constructor(options: ZaloInboxServiceOptions = {}) {
    this.zaloClient = options.zaloClient;

    if (options.supabase) {
      this.supabase = options.supabase;
    } else {
      this.supabase = createAdminClient();
    }
  }

  /**
   * Fetches Zalo conversations for the unified inbox.
   */
  async getZaloConversations(
    params: GetZaloConversationsParams
  ): Promise<ZaloConversationItem[]> {
    const { companyId, status, limit = 50, offset = 0 } = params;

    let query = this.supabase
      .from('conversations')
      .select('id, company_id, customer_id, channel, external_conversation_id, last_message_at, unread_count, status, assigned_to, customers(name)')
      .eq('company_id', companyId)
      .eq('channel', 'ZALO')
      .order('last_message_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to fetch Zalo conversations: ${error.message}`);
    }

    return ((data || []) as unknown as ConversationDbRow[]).map((row) => ({
      id: row.id,
      companyId: row.company_id,
      customerId: row.customer_id,
      customerName: row.customers?.name || 'Khách Zalo',
      channel: 'ZALO',
      externalConversationId: row.external_conversation_id,
      lastMessageAt: row.last_message_at,
      unreadCount: row.unread_count,
      status: row.status,
      assignedTo: row.assigned_to,
    }));
  }

  /**
   * Fetches message interactions for a specific Zalo conversation.
   */
  async getZaloMessagesByConversation(
    params: GetZaloMessagesParams
  ): Promise<ZaloMessageItem[]> {
    const { companyId, conversationId, limit = 100, offset = 0 } = params;

    const { data, error } = await this.supabase
      .from('interactions')
      .select('id, conversation_id, customer_id, channel, type, direction, sanitized_content, external_ref, actor_type, actor_user_id, created_at')
      .eq('company_id', companyId)
      .eq('conversation_id', conversationId)
      .eq('channel', 'ZALO')
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) {
      throw new Error(`Failed to fetch Zalo messages: ${error.message}`);
    }

    return ((data || []) as unknown as InteractionDbRow[]).map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      customerId: row.customer_id,
      channel: 'ZALO',
      type: 'MESSAGE',
      direction: row.direction,
      content: row.sanitized_content || '',
      externalRef: row.external_ref,
      actorType: row.actor_type,
      actorUserId: row.actor_user_id,
      createdAt: row.created_at,
    }));
  }

  /**
   * Sends a reply message from the Unified Inbox directly to Zalo OpenAPI (User / Sale Actor).
   * Context with authenticated actor is strictly required.
   */
  async sendZaloReply(
    params: SendZaloReplyParams,
    context: SendZaloReplyContext
  ): Promise<SendZaloReplyResult> {
    if (!context || !context.actor || !context.actor.userId || !context.actor.companyId) {
      throw new ServerAuthError(
        'Authentication required: Missing authenticated actor for reply',
        401,
        'UNAUTHENTICATED'
      );
    }

    return this.executeSendReply(params, {
      actorType: 'SALE',
      userId: context.actor.userId,
      companyId: context.actor.companyId,
      role: context.actor.role,
    });
  }

  /**
   * Sends an automated system reply using System Principal.
   */
  async sendSystemZaloReply(
    params: SendZaloReplyParams,
    context: SendSystemZaloReplyContext = { principal: 'SYSTEM' }
  ): Promise<SendZaloReplyResult> {
    if (!context || context.principal !== 'SYSTEM') {
      throw new ServerAuthError(
        'System authorization required for system reply',
        403,
        'ROLE_FORBIDDEN'
      );
    }

    return this.executeSendReply(params, {
      actorType: 'SYSTEM',
      userId: context.systemUserId || null,
      companyId: null,
      role: 'SYSTEM',
    });
  }

  /**
   * Core Outbound Reply Execution Pipeline:
   * 1. Validate permissions & tenant ownership
   * 2. Fail-closed outbox claim
   * 3. Provider invocation
   * 4. Atomic DB finalization / reconciliation flagging
   */
  private async executeSendReply(
    params: SendZaloReplyParams,
    actorInfo: {
      actorType: 'SALE' | 'SYSTEM';
      userId: string | null;
      companyId: string | null;
      role: string;
    }
  ): Promise<SendZaloReplyResult> {
    const { conversationId, content } = params;

    if (!content || !content.trim()) {
      return { success: false, error: 'Message content cannot be empty' };
    }

    if (!conversationId) {
      return { success: false, error: 'conversationId is required' };
    }

    // 1. TRUSTED LOOKUP: Fetch conversation from DB
    const { data: convData, error: convErr } = await this.supabase
      .from('conversations')
      .select('id, company_id, customer_id, channel, external_conversation_id')
      .eq('id', conversationId)
      .maybeSingle();

    if (convErr || !convData) {
      return { success: false, error: 'Conversation not found' };
    }

    const conversation = convData as {
      id: string;
      company_id: string;
      customer_id: string;
      channel: string;
      external_conversation_id: string;
    };

    // 2. TENANT ISOLATION & ROLE AUTHORIZATION (Fix Lỗi 4)
    if (actorInfo.actorType === 'SALE') {
      if (actorInfo.companyId !== conversation.company_id) {
        throw new ServerAuthError(
          'Access forbidden: User tenant does not match conversation company',
          403,
          'RESOURCE_FORBIDDEN'
        );
      }

      if (!ALLOWED_ACTOR_ROLES.includes(actorInfo.role)) {
        throw new ServerAuthError(
          `Access forbidden: Role "${actorInfo.role}" is not authorized to send Zalo replies`,
          403,
          'ROLE_FORBIDDEN'
        );
      }
    }

    const effectiveCompanyId = conversation.company_id;
    const effectiveCustomerId = conversation.customer_id;

    // 3. RESOLVE TRUSTED RECIPIENT ZALO UID FROM IDENTITIES TABLE
    let recipientZaloId = conversation.external_conversation_id;

    const { data: identity } = await this.supabase
      .from('identities')
      .select('external_id')
      .eq('company_id', effectiveCompanyId)
      .eq('customer_id', effectiveCustomerId)
      .eq('channel', 'ZALO')
      .maybeSingle();

    if (identity?.external_id) {
      recipientZaloId = identity.external_id;
    }

    if (!recipientZaloId) {
      return {
        success: false,
        error: 'Trusted Zalo recipient identity not found for this conversation',
      };
    }

    // 4. DURABLE OUTBOX & STABLE IDEMPOTENCY (Fix Lỗi 5)
    // Deterministic command ID: Caller-provided or generated UUIDv4 (NO Date.now() + Math.random())
    const commandId = params.commandId || crypto.randomUUID();
    const idempotencyKey = `outbound:${effectiveCompanyId}:${conversationId}:${commandId}`;
    const nowIso = new Date().toISOString();

    const { data: deliveryRecord, error: deliveryErr } = await this.supabase
      .from('zalo_outbound_deliveries')
      .insert({
        company_id: effectiveCompanyId,
        conversation_id: conversationId,
        customer_id: effectiveCustomerId,
        recipient_zalo_uid: recipientZaloId,
        channel: 'ZALO',
        command_id: commandId,
        idempotency_key: idempotencyKey,
        content: content.trim(),
        status: 'PENDING',
        attempts: 0,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .select('id')
      .maybeSingle();

    // FAIL-CLOSED: If outbox insert fails or cannot claim, STOP IMMEDIATELY! NEVER call Zalo API without outbox record.
    if (deliveryErr || !deliveryRecord?.id) {
      throw new Error(
        `Durable outbox claim failed: ${deliveryErr?.message || 'Unable to record outbox delivery'}. Send halted (fail-closed).`
      );
    }

    const deliveryId = deliveryRecord.id;

    // 5. MARK OUTBOX DELIVERY AS SENDING WITH LEASE (Fix Lỗi 6)
    const leaseUntilIso = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    await this.supabase
      .from('zalo_outbound_deliveries')
      .update({
        status: 'SENDING',
        lease_until: leaseUntilIso,
        attempts: 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', deliveryId);

    // Resolve client
    let oaId = params.oaId || '';
    if (!oaId) {
      const { data: oaConfig } = await this.supabase
        .from('zalo_oa_configs')
        .select('oa_id')
        .eq('company_id', effectiveCompanyId)
        .eq('status', 'ACTIVE')
        .limit(1)
        .maybeSingle();
      if (oaConfig?.oa_id) {
        oaId = oaConfig.oa_id;
      }
    }

    const client =
      this.zaloClient ??
      (await ZaloClientFactory.getClientForOa(effectiveCompanyId, oaId, { supabase: this.supabase }));

    // 6. CALL ZALO OPENAPI OUTBOUND ENDPOINT
    let zaloRes;
    try {
      zaloRes = await client.sendTextMessage(recipientZaloId, content.trim());
    } catch (apiError: unknown) {
      const errorMsg = apiError instanceof Error ? apiError.message : 'Zalo OpenAPI communication failure';

      // Update delivery record to FAILED
      await this.supabase
        .from('zalo_outbound_deliveries')
        .update({
          status: 'FAILED',
          error_code: 'PROVIDER_EXCEPTION',
          error_message: errorMsg,
          updated_at: new Date().toISOString(),
        })
        .eq('id', deliveryId);

      return {
        success: false,
        error: errorMsg,
      };
    }

    // 7. PROCESS PROVIDER RESPONSE
    if (zaloRes.error !== 0) {
      const errorMsg = `Zalo API error [${zaloRes.error}]: ${zaloRes.message}`;

      await this.supabase
        .from('zalo_outbound_deliveries')
        .update({
          status: 'FAILED',
          error_code: String(zaloRes.error),
          error_message: zaloRes.message || errorMsg,
          updated_at: new Date().toISOString(),
        })
        .eq('id', deliveryId);

      return {
        success: false,
        error: errorMsg,
      };
    }

    const providerMsgId = zaloRes.data?.message_id || `zalo_out_${Date.now()}`;

    // Update provider_msg_id on outbox record immediately
    await this.supabase
      .from('zalo_outbound_deliveries')
      .update({
        provider_msg_id: providerMsgId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', deliveryId);

    // 8. ATOMIC DATABASE FINALIZE (Fix Lỗi 6)
    const { sanitizedText } = sanitizeMessageContent(content.trim());

    try {
      const { data: finalizeInteractionId, error: finalizeErr } = await this.supabase.rpc(
        'zalo_finalize_outbound_reply',
        {
          p_company_id: effectiveCompanyId,
          p_delivery_id: deliveryId,
          p_conversation_id: conversationId,
          p_customer_id: effectiveCustomerId,
          p_recipient_zalo_uid: recipientZaloId,
          p_content: content.trim(),
          p_sanitized_content: sanitizedText,
          p_provider_msg_id: providerMsgId,
          p_actor_type: actorInfo.actorType,
          p_actor_user_id: actorInfo.userId,
          p_raw_payload: {
            recipient: { user_id: recipientZaloId },
            message: { text: content.trim() },
            response: zaloRes,
          },
        }
      );

      if (finalizeErr || !finalizeInteractionId) {
        throw new Error(finalizeErr?.message || 'Finalize RPC failed');
      }

      return {
        success: true,
        interactionId: finalizeInteractionId,
        externalMessageId: providerMsgId,
      };
    } catch (finalizeError: unknown) {
      // CRITICAL: Provider already sent! Do NOT mark FAILED or resend to Zalo!
      // Mark outbox status as PROVIDER_SENT_PENDING_FINALIZE for reconciliation!
      const errDetail =
        finalizeError instanceof Error ? finalizeError.message : 'DB finalize failed after provider dispatch';

      await this.supabase
        .from('zalo_outbound_deliveries')
        .update({
          status: 'PROVIDER_SENT_PENDING_FINALIZE',
          error_message: errDetail,
          updated_at: new Date().toISOString(),
        })
        .eq('id', deliveryId);

      throw new Error(
        `Outbound message sent by provider (${providerMsgId}) but DB finalize failed. Marked as PROVIDER_SENT_PENDING_FINALIZE for reconciliation.`
      );
    }
  }

  /**
   * Reconciles deliveries in PROVIDER_SENT_PENDING_FINALIZE state.
   * CRITICAL ARCHITECTURE RULE (Fix Lỗi 6):
   * NEVER calls Zalo API again (the message was already dispatched by the provider).
   * Only retries the atomic DB finalization via zalo_finalize_outbound_reply RPC.
   */
  async reconcilePendingDeliveries(options?: {
    companyId?: string;
    limit?: number;
  }): Promise<{ reconciled: number; failed: number }> {
    let query = this.supabase
      .from('zalo_outbound_deliveries')
      .select('*')
      .eq('status', 'PROVIDER_SENT_PENDING_FINALIZE');

    if (options?.companyId) {
      query = query.eq('company_id', options.companyId);
    }
    if (options?.limit) {
      query = query.limit(options.limit);
    }

    const { data: pendingDeliveries, error } = await query;
    if (error || !pendingDeliveries) {
      return { reconciled: 0, failed: 0 };
    }

    let reconciled = 0;
    let failed = 0;

    for (const delivery of pendingDeliveries as OutboundDeliveryDbRow[]) {
      const { sanitizedText } = sanitizeMessageContent(delivery.content || '');
      const { data: finalizeId, error: finalizeErr } = await this.supabase.rpc(
        'zalo_finalize_outbound_reply',
        {
          p_company_id: delivery.company_id,
          p_delivery_id: delivery.id,
          p_conversation_id: delivery.conversation_id,
          p_customer_id: delivery.customer_id,
          p_recipient_zalo_uid: delivery.recipient_zalo_uid,
          p_content: delivery.content,
          p_sanitized_content: sanitizedText,
          p_provider_msg_id: delivery.provider_msg_id,
          p_actor_type: 'SALE',
          p_actor_user_id: null,
          p_raw_payload: {
            recipient: { user_id: delivery.recipient_zalo_uid },
            message: { text: delivery.content },
            reconciled: true,
          },
        }
      );

      if (finalizeErr || !finalizeId) {
        failed++;
      } else {
        reconciled++;
      }
    }

    return { reconciled, failed };
  }
}

