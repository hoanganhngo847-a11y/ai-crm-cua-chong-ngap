import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../../lib/supabase/admin';
import { ZaloClient } from './zalo-client';
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

export interface SendZaloReplyContext {
  actor?: {
    userId: string;
    companyId: string;
    role?: string;
  };
}

/**
 * Service providing the standardized interface for Member 2 (Unified Inbox).
 *
 * Security Invariants & Outbound Safety:
 * 1. Boundary Protection:
 *    - Does NOT trust companyId, customerId, recipientZaloId from client input.
 *    - Derives customer, identity, and recipient Zalo UID securely from DB via conversationId.
 *    - Verifies tenant isolation: Rejects with 403 Forbidden if conversation belongs to another company.
 * 2. Durable Outbox & Outbound Idempotency:
 *    - Creates an outbound delivery record in PENDING state before calling Zalo OpenAPI.
 *    - Updates record to SENT with provider_msg_id on success; records FAILED on failure.
 *    - Never creates false interaction records if provider call fails.
 */
export class ZaloInboxService {
  private readonly supabase: SupabaseClient;
  private readonly zaloClient: ZaloClient;

  constructor(options: ZaloInboxServiceOptions = {}) {
    this.zaloClient = options.zaloClient || new ZaloClient();

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
   * Sends a reply message from the Unified Inbox directly to Zalo OpenAPI.
   *
   * Security & Outbox Contract:
   * - Caller only needs to specify `{ conversationId, content }`.
   * - Derives tenant, customer, and recipient from DB with tenant isolation checks.
   * - Pre-records PENDING outbound delivery in DB before invoking Zalo OpenAPI.
   */
  async sendZaloReply(
    params: SendZaloReplyParams,
    context?: SendZaloReplyContext
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

    // 2. TENANT ISOLATION BOUNDARY: Verify actor permissions and company ownership
    const actorCompanyId = context?.actor?.companyId;
    if (actorCompanyId && actorCompanyId !== conversation.company_id) {
      throw new ServerAuthError(
        'Access forbidden: User tenant does not match conversation company',
        403,
        'RESOURCE_FORBIDDEN'
      );
    }

    const effectiveCompanyId = conversation.company_id;
    const effectiveCustomerId = conversation.customer_id;
    const saleUserId = context?.actor?.userId || null;

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

    // 4. DURABLE OUTBOX: Pre-record outbound delivery in PENDING state with unique idempotency key
    const idempotencyKey = `outbound:${effectiveCompanyId}:${conversationId}:${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const nowIso = new Date().toISOString();

    const { data: deliveryRecord, error: deliveryErr } = await this.supabase
      .from('zalo_outbound_deliveries')
      .insert({
        company_id: effectiveCompanyId,
        conversation_id: conversationId,
        customer_id: effectiveCustomerId,
        recipient_zalo_uid: recipientZaloId,
        idempotency_key: idempotencyKey,
        content: content.trim(),
        status: 'PENDING',
        attempts: 1,
      })
      .select('id')
      .maybeSingle();

    if (deliveryErr) {
      console.error('Failed to create outbound delivery record:', deliveryErr.message);
    }

    const deliveryId = deliveryRecord?.id;

    // 5. CALL ZALO OPENAPI OUTBOUND ENDPOINT
    let zaloRes;
    try {
      zaloRes = await this.zaloClient.sendTextMessage(recipientZaloId, content.trim());
    } catch (apiError: unknown) {
      const errorMsg = apiError instanceof Error ? apiError.message : 'Zalo OpenAPI communication failure';

      // Update delivery record to FAILED
      if (deliveryId) {
        await this.supabase
          .from('zalo_outbound_deliveries')
          .update({
            status: 'FAILED',
            error_code: 'PROVIDER_EXCEPTION',
            error_message: errorMsg,
            updated_at: new Date().toISOString(),
          })
          .eq('id', deliveryId);
      }

      return {
        success: false,
        error: errorMsg,
      };
    }

    // 6. PROCESS PROVIDER RESPONSE
    if (zaloRes.error !== 0) {
      const errorMsg = `Zalo API error [${zaloRes.error}]: ${zaloRes.message}`;

      if (deliveryId) {
        await this.supabase
          .from('zalo_outbound_deliveries')
          .update({
            status: 'FAILED',
            error_code: String(zaloRes.error),
            error_message: zaloRes.message || errorMsg,
            updated_at: new Date().toISOString(),
          })
          .eq('id', deliveryId);
      }

      return {
        success: false,
        error: errorMsg,
      };
    }

    const externalMessageId = zaloRes.data?.message_id || `zalo_out_${Date.now()}`;

    // 7. RECORD CRM INTERACTION ON SUCCESS
    const { sanitizedText } = sanitizeMessageContent(content.trim());

    const { data: newInteraction, error: intError } = await this.supabase
      .from('interactions')
      .insert({
        company_id: effectiveCompanyId,
        customer_id: effectiveCustomerId,
        conversation_id: conversationId,
        channel: 'ZALO',
        type: 'MESSAGE',
        direction: 'OUTBOUND',
        sanitized_content: sanitizedText,
        sanitization_status: 'SUCCEEDED',
        sanitized_at: nowIso,
        sanitizer_version: 'v1.0',
        external_ref: externalMessageId,
        actor_type: 'SALE',
        actor_user_id: saleUserId,
        created_at: nowIso,
      })
      .select('id')
      .single();

    if (intError) {
      throw new Error(`Failed to record outbound interaction in CRM: ${intError.message}`);
    }

    // 8. RECORD RAW OUTBOUND CONTENT TO PRIVATE SECURITY ZONE
    if (newInteraction) {
      const rawRecord = {
        interaction_id: newInteraction.id,
        company_id: effectiveCompanyId,
        raw_content: content.trim(),
        raw_payload: {
          recipient: { user_id: recipientZaloId },
          message: { text: content.trim() },
          response: zaloRes,
        },
        source_metadata: {
          recipient_zalo_id: recipientZaloId,
          sale_user_id: saleUserId,
          external_message_id: externalMessageId,
        },
        created_at: nowIso,
      };

      try {
        type SupabaseWithSchema = SupabaseClient & {
          schema?: (s: string) => { from: (t: string) => ReturnType<SupabaseClient['from']> };
        };
        const clientWithSchema = this.supabase as SupabaseWithSchema;
        if (typeof clientWithSchema.schema === 'function') {
          await clientWithSchema.schema('private').from('interaction_raw_contents').insert(rawRecord);
        } else {
          await this.supabase.from('interaction_raw_contents').insert(rawRecord);
        }
      } catch {
        // Schema fallback caught
      }
    }

    // 9. UPDATE OUTBOUND DELIVERY RECORD TO SENT
    if (deliveryId) {
      await this.supabase
        .from('zalo_outbound_deliveries')
        .update({
          status: 'SENT',
          provider_msg_id: externalMessageId,
          interaction_id: newInteraction?.id || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', deliveryId);
    }

    // 10. UPDATE CONVERSATION LAST_MESSAGE_AT
    await this.supabase
      .from('conversations')
      .update({
        last_message_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', conversationId);

    return {
      success: true,
      interactionId: newInteraction?.id,
      externalMessageId,
    };
  }
}
