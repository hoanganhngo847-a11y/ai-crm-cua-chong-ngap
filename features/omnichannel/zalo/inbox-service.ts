import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../../lib/supabase/admin';
import { ZaloClient } from './zalo-client';
import { sanitizeMessageContent } from './sanitizer';
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

/**
 * Service providing the standardized interface for Member 2 (Unified Inbox).
 * Allows the Unified Inbox to:
 * 1. Fetch Zalo conversations.
 * 2. Fetch messages within a conversation.
 * 3. Reply directly via Zalo OpenAPI and record outbound SALE interactions in the CRM.
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
   * Sends a reply message from the Unified Inbox directly to Zalo OpenAPI
   * and logs the Interaction with direction: 'OUTBOUND' and actor_type: 'SALE'.
   */
  async sendZaloReply(params: SendZaloReplyParams): Promise<SendZaloReplyResult> {
    const { companyId, customerId, conversationId, content, recipientZaloId, saleUserId } = params;

    if (!content || !content.trim()) {
      return { success: false, error: 'Message content cannot be empty' };
    }

    if (!recipientZaloId) {
      return { success: false, error: 'Recipient Zalo ID is required' };
    }

    try {
      // 1. Send text message via Zalo OpenAPI
      const zaloRes = await this.zaloClient.sendTextMessage(recipientZaloId, content.trim());
      if (zaloRes.error !== 0) {
        return {
          success: false,
          error: `Zalo API error [${zaloRes.error}]: ${zaloRes.message}`,
        };
      }

      const externalMessageId = zaloRes.data?.message_id || `zalo_out_${Date.now()}`;
      const nowIso = new Date().toISOString();

      // 2. Sanitize outbound content for SALE safety (Zero-Phone invariant)
      const { sanitizedText } = sanitizeMessageContent(content.trim());

      // 3. Record Interaction in CRM (outbound, actor_type: 'SALE')
      const { data: newInteraction, error: intError } = await this.supabase
        .from('interactions')
        .insert({
          company_id: companyId,
          customer_id: customerId,
          conversation_id: conversationId,
          channel: 'ZALO',
          type: 'MESSAGE',
          direction: 'OUTBOUND',
          sanitized_content: sanitizedText,
          sanitization_status: 'SUCCEEDED', // Critical: SUCCEEDED allows SALE reading
          sanitized_at: nowIso,
          sanitizer_version: 'v1.0',
          external_ref: externalMessageId,
          actor_type: 'SALE',
          actor_user_id: saleUserId || null,
          created_at: nowIso,
        })
        .select('id')
        .single();

      if (intError) {
        throw new Error(`Failed to record outbound interaction: ${intError.message}`);
      }

      // 4. Save raw outbound content to private security zone
      if (newInteraction) {
        const rawRecord = {
          interaction_id: newInteraction.id,
          company_id: companyId,
          raw_content: content.trim(),
          raw_payload: {
            recipient: { user_id: recipientZaloId },
            message: { text: content.trim() },
            response: zaloRes,
          },
          source_metadata: {
            recipient_zalo_id: recipientZaloId,
            sale_user_id: saleUserId || null,
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
          // Schema fallback
        }
      }

      // 5. Update Conversation last_message_at
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
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error ? err.message : 'Unknown error occurred while sending Zalo reply';
      return {
        success: false,
        error: errorMessage,
      };
    }
  }
}
