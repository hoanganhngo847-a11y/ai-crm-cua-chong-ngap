import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../../lib/supabase/admin';
import { ServerAuthError } from '../../../lib/server-auth/errors';
import type { TrustedActorContext } from '../../../lib/server-auth/sensitive-context';
import { ZaloClient, ZaloClientFactory, ZaloSendResult } from './zalo-client';
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
  direction: 'INBOUND' | 'OUTBOUND';
  sanitized_content?: string | null;
  external_ref: string | null;
  actor_type: 'CUSTOMER' | 'SALE' | 'SYSTEM' | 'AI' | 'TECHNICIAN';
  actor_user_id?: string | null;
  created_at: string;
}

interface OutboundClaimRow {
  claim_status: 'CLAIMED' | 'ALREADY_SENT' | 'PENDING_FINALIZE' | 'BUSY' | 'UNCERTAIN' | 'CONFLICT';
  delivery_id: string;
  claim_token: string | null;
  oa_id: string | null;
  recipient_zalo_uid: string;
  customer_id: string;
  provider_msg_id: string | null;
  interaction_id: string | null;
}

interface FinalizeResult {
  interaction_id: string;
  already_finalized: boolean;
  provider_msg_id: string | null;
}

export type ZaloOutboundClientProvider = (companyId: string, oaId: string) => Promise<ZaloClient>;

export interface ZaloInboxServiceOptions {
  supabase?: SupabaseClient;
  /** Overrides per-OA client resolution (tests). Production uses ZaloClientFactory. */
  clientProvider?: ZaloOutboundClientProvider;
  fetchFn?: typeof fetch;
}

export interface GetZaloConversationsParams {
  /** Must come from a server-verified actor, never from the browser. */
  companyId: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface GetZaloMessagesParams {
  /** Must come from a server-verified actor, never from the browser. */
  companyId: string;
  conversationId: string;
  limit?: number;
  offset?: number;
}

/**
 * Trusted machine principal for automated sends (AI auto-reply after the 5-minute rule,
 * system notifications). It is a separate entry point: a user request can never become a
 * system send by omitting the actor.
 */
export interface ZaloSystemPrincipal {
  kind: 'SYSTEM_WORKER';
  companyId: string;
  actorType: 'AI' | 'SYSTEM';
  workerName: string;
}

const HUMAN_SENDER_ROLES = new Set(['SALE', 'BOSS_ADMIN']);

function mapClaimError(message: string): Error {
  if (message.includes('ZALO_OUTBOUND_ACTOR_FORBIDDEN')) {
    return new ServerAuthError('Bạn không có quyền gửi tin nhắn Zalo.', 403, 'ROLE_FORBIDDEN');
  }
  if (message.includes('ZALO_CONVERSATION_NOT_FOUND')) {
    return new ServerAuthError('Không tìm thấy hội thoại Zalo.', 404, 'RESOURCE_NOT_FOUND');
  }
  return new Error(`Durable outbox claim failed (send halted, fail-closed): ${message}`);
}

/**
 * Unified-inbox facade for Zalo (consumed by Member 2).
 *
 * Outbound pipeline (every step durable, provider called at most once per command_id):
 *   1. zalo_claim_outbound_delivery — verifies actor membership/role + tenant in the DB, derives
 *      recipient and OA from the conversation, writes the outbox row (SENDING + lease + claim
 *      token) keyed by UNIQUE(company_id, channel, command_id). Any failure → no provider call.
 *   2. Zalo API call, outcome classified ACCEPTED / REJECTED / UNCERTAIN.
 *   3. zalo_record_outbound_provider_result — provider_msg_id persisted right after success.
 *   4. zalo_finalize_outbound_delivery — interaction + private raw + conversation + SENT in one
 *      transaction; idempotent and retried by reconcilePendingDeliveries() without resending.
 */
export class ZaloInboxService {
  private readonly supabase: SupabaseClient;
  private readonly clientProvider: ZaloOutboundClientProvider;

  constructor(options: ZaloInboxServiceOptions = {}) {
    const supabase = options.supabase ?? createAdminClient();
    this.supabase = supabase;
    this.clientProvider =
      options.clientProvider ??
      ((companyId, oaId) => ZaloClientFactory.getClientForOa(companyId, oaId, { supabase, fetchFn: options.fetchFn }));
  }

  async getZaloConversations(params: GetZaloConversationsParams): Promise<ZaloConversationItem[]> {
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

  async getZaloMessagesByConversation(params: GetZaloMessagesParams): Promise<ZaloMessageItem[]> {
    const { companyId, conversationId, limit = 100, offset = 0 } = params;

    const { data, error } = await this.supabase
      .from('interactions')
      .select('id, conversation_id, customer_id, direction, sanitized_content, external_ref, actor_type, actor_user_id, created_at')
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
   * Human send from the unified inbox. `actor` MUST be produced by the trusted server
   * authorization chain (verifyActorForCompany / resolveTrustedActor) — it is not optional.
   */
  async sendZaloReply(params: SendZaloReplyParams, actor: TrustedActorContext): Promise<SendZaloReplyResult> {
    if (!actor || actor.isTrustedServerVerified !== true || !actor.userId || !actor.companyId) {
      throw new ServerAuthError('Authentication required: missing verified actor for Zalo reply', 401, 'UNAUTHENTICATED');
    }
    if (actor.profileStatus !== 'ACTIVE' || actor.membershipStatus !== 'ACTIVE') {
      throw new ServerAuthError('Membership is not active', 403, 'MEMBERSHIP_INACTIVE');
    }
    if (!HUMAN_SENDER_ROLES.has(actor.role)) {
      throw new ServerAuthError(`Role "${actor.role}" is not authorized to send Zalo replies`, 403, 'ROLE_FORBIDDEN');
    }

    return this.executeSend(params, actor.companyId, 'SALE', actor.userId);
  }

  /**
   * Automated send by a trusted system worker. Separate entry point with an explicit principal.
   */
  async sendSystemZaloReply(params: SendZaloReplyParams, principal: ZaloSystemPrincipal): Promise<SendZaloReplyResult> {
    if (!principal || principal.kind !== 'SYSTEM_WORKER' || !principal.companyId || !principal.workerName) {
      throw new ServerAuthError('System worker principal required for automated Zalo reply', 403, 'ROLE_FORBIDDEN');
    }
    if (principal.actorType !== 'AI' && principal.actorType !== 'SYSTEM') {
      throw new ServerAuthError('Invalid system actor type', 403, 'ROLE_FORBIDDEN');
    }

    return this.executeSend(params, principal.companyId, principal.actorType, null);
  }

  private async executeSend(
    params: SendZaloReplyParams,
    companyId: string,
    actorType: 'SALE' | 'AI' | 'SYSTEM',
    actorUserId: string | null
  ): Promise<SendZaloReplyResult> {
    const content = (params.content || '').trim();
    if (!content) {
      return { success: false, status: 'FAILED', error: 'Message content cannot be empty' };
    }
    if (!params.conversationId) {
      return { success: false, status: 'FAILED', error: 'conversationId is required' };
    }
    if (!params.commandId || !params.commandId.trim()) {
      return { success: false, status: 'FAILED', error: 'commandId is required (stable idempotency key)' };
    }

    const { sanitizedText } = sanitizeMessageContent(content);
    const contentHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');

    // 1. Durable claim (fail-closed)
    const { data: claimData, error: claimError } = await this.supabase.rpc('zalo_claim_outbound_delivery', {
      p_company_id: companyId,
      p_conversation_id: params.conversationId,
      p_command_id: params.commandId.trim(),
      p_actor_type: actorType,
      p_actor_user_id: actorUserId,
      p_raw_content: content,
      p_sanitized_content: sanitizedText,
      p_content_sha256: contentHash,
      p_oa_id: params.oaId ?? null,
    });

    if (claimError) {
      if (claimError.message.includes('ZALO_OA_NOT_CONFIGURED')) {
        return { success: false, status: 'FAILED', error: 'Zalo OA chưa được cấu hình cho hội thoại này.' };
      }
      if (claimError.message.includes('AI_DISPATCH_FENCED')) {
        return { success: false, status: 'BUSY', error: 'AI đang giữ quyền phản hồi (AI_DISPATCH_FENCED).' };
      }
      if (claimError.message.includes('DISPATCH_UNCERTAIN')) {
        return { success: false, status: 'UNCERTAIN', error: 'Hội thoại đang ở trạng thái không chắc chắn (DISPATCH_UNCERTAIN).' };
      }
      if (claimError.message.includes('AI_ALREADY_RESPONDED')) {
        return { success: false, status: 'CONFLICT', error: 'AI đã phản hồi cho hội thoại này (AI_ALREADY_RESPONDED).' };
      }
      if (claimError.message.includes('SALE_ALREADY_DISPATCHING')) {
        return { success: false, status: 'BUSY', error: 'Tư vấn viên khác đang phản hồi (SALE_ALREADY_DISPATCHING).' };
      }
      if (claimError.message.includes('SALE_ALREADY_RESPONDED')) {
        return { success: false, status: 'CONFLICT', error: 'Tư vấn viên đã phản hồi cho hội thoại này (SALE_ALREADY_RESPONDED).' };
      }
      throw mapClaimError(claimError.message);
    }

    const claim = (Array.isArray(claimData) ? claimData[0] : claimData) as OutboundClaimRow | undefined;
    if (!claim) {
      throw new Error('Durable outbox claim returned no row (send halted, fail-closed)');
    }

    switch (claim.claim_status) {
      case 'ALREADY_SENT':
        return {
          success: true,
          status: 'ALREADY_SENT',
          deliveryId: claim.delivery_id,
          interactionId: claim.interaction_id ?? undefined,
          externalMessageId: claim.provider_msg_id ?? undefined,
        };
      case 'PENDING_FINALIZE':
        return this.finalize(claim.delivery_id);
      case 'BUSY':
        return { success: false, status: 'BUSY', deliveryId: claim.delivery_id, error: 'Tin nhắn này đang được gửi.' };
      case 'CONFLICT':
        return { success: false, status: 'CONFLICT', deliveryId: claim.delivery_id, error: 'commandId đã dùng cho nội dung khác.' };
      case 'UNCERTAIN':
        return {
          success: false,
          status: 'UNCERTAIN',
          deliveryId: claim.delivery_id,
          error: 'Không xác định được tin đã tới Zalo hay chưa; cần kiểm tra thủ công, hệ thống không tự gửi lại.',
        };
      case 'CLAIMED':
        break;
      default:
        throw new Error(`Unexpected outbox claim status ${String(claim.claim_status)}`);
    }

    const claimToken = claim.claim_token as string;

    // 2. Provider call (at most once per successful claim)
    let sendResult: ZaloSendResult;
    try {
      const client = await this.clientProvider(companyId, claim.oa_id as string);
      sendResult = await client.sendTextMessageWithOutcome(claim.recipient_zalo_uid, content);
    } catch (err: unknown) {
      // Client construction failed before any request left the process: definitely not sent.
      sendResult = {
        outcome: 'REJECTED',
        errorCode: 'CLIENT_UNAVAILABLE',
        errorMessage: err instanceof Error ? err.message : 'Zalo client unavailable',
      };
    }

    // 3. Persist the provider outcome immediately
    const { error: recordError } = await this.supabase.rpc('zalo_record_outbound_provider_result', {
      p_delivery_id: claim.delivery_id,
      p_claim_token: claimToken,
      p_outcome: sendResult.outcome,
      p_provider_msg_id: sendResult.providerMsgId ?? null,
      p_error_code: sendResult.errorCode ?? null,
      p_error_message: sendResult.errorMessage ?? null,
    });
    if (recordError) {
      console.error(
        `[ZaloInbox] Provider outcome ${sendResult.outcome} for delivery ${claim.delivery_id} could not be recorded: ${recordError.message}`
      );
      return {
        success: sendResult.outcome === 'ACCEPTED',
        status: 'UNCERTAIN',
        deliveryId: claim.delivery_id,
        externalMessageId: sendResult.providerMsgId,
        error: 'Kết quả gửi chưa được ghi nhận; hệ thống sẽ không tự gửi lại.',
      };
    }

    if (sendResult.outcome === 'REJECTED') {
      return {
        success: false,
        status: 'FAILED',
        deliveryId: claim.delivery_id,
        error: `Zalo từ chối tin nhắn [${sendResult.errorCode}]: ${sendResult.errorMessage}`,
      };
    }
    if (sendResult.outcome === 'UNCERTAIN') {
      return {
        success: false,
        status: 'UNCERTAIN',
        deliveryId: claim.delivery_id,
        error: 'Không xác định được tin đã tới Zalo hay chưa; hệ thống không tự gửi lại.',
      };
    }

    // 4. Atomic finalize
    return this.finalize(claim.delivery_id);
  }

  private async finalize(deliveryId: string): Promise<SendZaloReplyResult> {
    const { data, error } = await this.supabase.rpc('zalo_finalize_outbound_delivery', { p_delivery_id: deliveryId });
    if (error || !data) {
      // Provider already accepted the message. Stay in PROVIDER_SENT_PENDING_FINALIZE for reconcile.
      console.error(`[ZaloInbox] Finalize failed for delivery ${deliveryId}: ${error?.message || 'no result'}`);
      return {
        success: true,
        status: 'PENDING_FINALIZE',
        deliveryId,
        error: 'Tin đã gửi tới Zalo; bản ghi CRM sẽ được đồng bộ lại tự động.',
      };
    }
    const result = data as FinalizeResult;
    return {
      success: true,
      status: result.already_finalized ? 'ALREADY_SENT' : 'SENT',
      deliveryId,
      interactionId: result.interaction_id,
      externalMessageId: result.provider_msg_id ?? undefined,
    };
  }

  /**
   * Retries DB finalization for deliveries the provider already accepted. Never calls Zalo.
   * Also reports PROVIDER_UNCERTAIN deliveries that need a human decision.
   */
  async reconcilePendingDeliveries(options: { companyId?: string; limit?: number } = {}): Promise<{
    reconciled: number;
    failed: number;
    uncertain: number;
  }> {
    let pendingQuery = this.supabase
      .from('zalo_outbound_deliveries')
      .select('id')
      .eq('status', 'PROVIDER_SENT_PENDING_FINALIZE')
      .order('updated_at', { ascending: true })
      .limit(options.limit ?? 100);
    let uncertainQuery = this.supabase
      .from('zalo_outbound_deliveries')
      .select('id')
      .eq('status', 'PROVIDER_UNCERTAIN')
      .limit(1000);

    if (options.companyId) {
      pendingQuery = pendingQuery.eq('company_id', options.companyId);
      uncertainQuery = uncertainQuery.eq('company_id', options.companyId);
    }

    const [{ data: pending, error }, { data: uncertainRows }] = await Promise.all([pendingQuery, uncertainQuery]);
    if (error) {
      throw new Error(`Failed to list pending outbound deliveries: ${error.message}`);
    }

    let reconciled = 0;
    let failed = 0;
    for (const row of (pending || []) as { id: string }[]) {
      const { error: finalizeError } = await this.supabase.rpc('zalo_finalize_outbound_delivery', { p_delivery_id: row.id });
      if (finalizeError) {
        failed++;
        console.error(`[ZaloInbox] Reconcile finalize failed for delivery ${row.id}: ${finalizeError.message}`);
      } else {
        reconciled++;
      }
    }

    return { reconciled, failed, uncertain: (uncertainRows || []).length };
  }
}
