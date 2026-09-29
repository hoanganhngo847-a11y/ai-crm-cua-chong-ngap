import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../../lib/supabase/admin';
import { ZaloClientFactory, ZaloSendResult } from './zalo-client';
import type { SendZaloReplyResult } from './types';
import type { ZaloOutboundClientProvider } from './inbox-service';

export interface ZaloOutboundDispatcherOptions {
  supabase?: SupabaseClient;
  clientProvider?: ZaloOutboundClientProvider;
  fetchFn?: typeof fetch;
}

interface CanonicalClaimRow {
  delivery_id: string | null;
  company_id: string | null;
  conversation_id: string | null;
  interaction_id: string | null;
  customer_id: string | null;
  recipient_zalo_uid: string | null;
  oa_id: string | null;
  raw_content: string | null;
  sanitized_content: string | null;
  client_command_id: string | null;
  claim_status: 'CLAIMED' | 'ALREADY_SENT' | 'UNCERTAIN' | 'BUSY' | 'NOT_FOUND' | string;
}

/**
 * TV2 Unified Inbox → TV3 Zalo Provider Dispatcher.
 *
 * Architecture:
 * - TV2 owns the canonical command authority: `record_outbound_interaction_atomic` writes to
 *   `public.outbound_deliveries` (channel = 'ZALO') and `public.interactions`.
 * - TV3 Dispatcher owns the provider transport: claims the canonical delivery atomically,
 *   retrieves raw content from private storage, resolves OA and private credentials,
 *   calls Zalo API, and updates canonical delivery + interaction with explicit provider outcome.
 *
 * Outcome semantics:
 * - ACCEPTED with stable message_id → delivery SENT, external_ref linked.
 * - ACCEPTED with missing message_id → fail-closed to UNCERTAIN (zero synthetic IDs).
 * - REJECTED → delivery FAILED (retryable).
 * - UNCERTAIN (timeout/network) → delivery UNCERTAIN (never automatically resent).
 */
export class ZaloOutboundDispatcher {
  private readonly supabase: SupabaseClient;
  private readonly clientProvider: ZaloOutboundClientProvider;

  constructor(options: ZaloOutboundDispatcherOptions = {}) {
    const supabase = options.supabase ?? createAdminClient();
    this.supabase = supabase;
    this.clientProvider =
      options.clientProvider ??
      ((companyId, oaId) =>
        ZaloClientFactory.getClientForOa(companyId, oaId, { supabase, fetchFn: options.fetchFn }));
  }

  /**
   * Dispatches a single canonical outbound delivery.
   */
  async dispatchOutboundDelivery(
    deliveryId: string,
    options: { workerId?: string; overrideOaId?: string } = {}
  ): Promise<SendZaloReplyResult> {
    return this.dispatchDelivery(deliveryId, options);
  }

  async dispatchDelivery(
    deliveryId: string,
    options: { workerId?: string; overrideOaId?: string } = {}
  ): Promise<SendZaloReplyResult> {
    const workerId = options.workerId || `zalo_dispatcher_${crypto.randomUUID()}`;

    // 1. Atomic claim via trusted RPC
    const { data: claimData, error: claimError } = await this.supabase.rpc('zalo_claim_canonical_delivery', {
      p_delivery_id: deliveryId,
      p_worker_id: workerId,
      p_override_oa_id: options.overrideOaId ?? null,
    });

    if (claimError) {
      if (claimError.message.includes('ZALO_OA_NOT_CONFIGURED')) {
        return { success: false, status: 'FAILED', deliveryId, error: 'Zalo OA chưa được cấu hình cho doanh nghiệp này.' };
      }
      if (claimError.message.includes('ZALO_CONVERSATION_NOT_FOUND')) {
        return { success: false, status: 'FAILED', deliveryId, error: 'Không tìm thấy cuộc hội thoại.' };
      }
      throw new Error(`Durable outbox claim failed: ${claimError.message}`);
    }

    const row = (Array.isArray(claimData) ? claimData[0] : claimData) as CanonicalClaimRow | undefined;
    if (!row) {
      return { success: false, status: 'FAILED', deliveryId, error: 'No claim response returned' };
    }

    if (row.claim_status === 'ALREADY_SENT') {
      return {
        success: true,
        status: 'ALREADY_SENT',
        deliveryId,
        interactionId: row.interaction_id ?? undefined,
      };
    }
    if (row.claim_status === 'UNCERTAIN') {
      return {
        success: false,
        status: 'UNCERTAIN',
        deliveryId,
        interactionId: row.interaction_id ?? undefined,
        error: 'Tin nhắn đang ở trạng thái không chắc chắn; hệ thống không tự gửi lại.',
      };
    }
    if (row.claim_status === 'BUSY') {
      return {
        success: false,
        status: 'BUSY',
        deliveryId,
        interactionId: row.interaction_id ?? undefined,
        error: 'Tin nhắn này đang được xử lý bởi worker khác.',
      };
    }
    if (row.claim_status !== 'CLAIMED' || !row.company_id || !row.oa_id || !row.recipient_zalo_uid) {
      return {
        success: false,
        status: 'FAILED',
        deliveryId,
        interactionId: row.interaction_id ?? undefined,
        error: `Claim status: ${row.claim_status}`,
      };
    }

    // 2. Call Zalo provider API
    let sendResult: ZaloSendResult;
    try {
      const client = await this.clientProvider(row.company_id, row.oa_id);
      sendResult = await client.sendTextMessageWithOutcome(row.recipient_zalo_uid, row.raw_content || '');
    } catch (err: unknown) {
      sendResult = {
        outcome: 'REJECTED',
        errorCode: 'CLIENT_UNAVAILABLE',
        errorMessage: err instanceof Error ? err.message : 'Zalo client unavailable',
      };
    }

    // 3. Finalize canonical outcome
    if (sendResult.outcome === 'ACCEPTED') {
      const providerMsgId = sendResult.providerMsgId?.trim();
      if (!providerMsgId) {
        // Section 13: If Zalo claims ACCEPTED but stable provider message ID is missing:
        // fail closed into an explicit inconsistent/uncertain state. Do not invent external_ref!
        await this.supabase.rpc('zalo_record_canonical_failure', {
          p_delivery_id: deliveryId,
          p_error_message: 'Provider claimed ACCEPTED but returned no message_id',
          p_is_uncertain: true,
        });
        return {
          success: false,
          status: 'UNCERTAIN',
          deliveryId,
          interactionId: row.interaction_id ?? undefined,
          error: 'Provider claimed ACCEPTED but returned no stable message_id (fail-closed)',
        };
      }

      const { error: finError } = await this.supabase.rpc('zalo_finalize_canonical_outbound', {
        p_delivery_id: deliveryId,
        p_provider_msg_id: providerMsgId,
        p_oa_id: row.oa_id,
      });

      if (finError) {
        console.error(`[ZaloDispatcher] Finalize failed for delivery ${deliveryId}: ${finError.message}`);
        return {
          success: false,
          status: 'UNCERTAIN',
          deliveryId,
          interactionId: row.interaction_id ?? undefined,
          error: finError.message,
        };
      }

      return {
        success: true,
        status: 'SENT',
        deliveryId,
        interactionId: row.interaction_id ?? undefined,
        externalMessageId: providerMsgId,
      };
    } else if (sendResult.outcome === 'REJECTED') {
      await this.supabase.rpc('zalo_record_canonical_failure', {
        p_delivery_id: deliveryId,
        p_error_message: sendResult.errorMessage || 'Provider rejected message',
        p_is_uncertain: false,
      });
      return {
        success: false,
        status: 'FAILED',
        deliveryId,
        interactionId: row.interaction_id ?? undefined,
        error: sendResult.errorMessage,
      };
    } else {
      // UNCERTAIN
      await this.supabase.rpc('zalo_record_canonical_failure', {
        p_delivery_id: deliveryId,
        p_error_message: sendResult.errorMessage || 'Provider network timeout / uncertain delivery',
        p_is_uncertain: true,
      });
      return {
        success: false,
        status: 'UNCERTAIN',
        deliveryId,
        interactionId: row.interaction_id ?? undefined,
        error: sendResult.errorMessage || 'Delivery uncertain; manual reconciliation required',
      };
    }
  }

  /**
   * Batch worker dispatch for pending deliveries of a company.
   */
  async dispatchPendingZaloDeliveries(
    companyId: string,
    options: { limit?: number; workerId?: string } = {}
  ): Promise<{ dispatched: number; sent: number; failed: number; uncertain: number; skipped: number }> {
    const limit = options.limit || 10;
    const workerId = options.workerId || `zalo_batch_${crypto.randomUUID()}`;

    const { data: deliveries, error } = await this.supabase
      .from('outbound_deliveries')
      .select('id')
      .eq('company_id', companyId)
      .eq('channel', 'ZALO')
      .in('delivery_status', ['PENDING_DISPATCH', 'QUEUED'])
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error || !deliveries) {
      return { dispatched: 0, sent: 0, failed: 0, uncertain: 0, skipped: 0 };
    }

    const res = { dispatched: 0, sent: 0, failed: 0, uncertain: 0, skipped: 0 };
    for (const del of deliveries) {
      res.dispatched++;
      const outcome = await this.dispatchDelivery(del.id, { workerId });
      if (outcome.status === 'SENT' || outcome.status === 'ALREADY_SENT') res.sent++;
      else if (outcome.status === 'FAILED') res.failed++;
      else if (outcome.status === 'UNCERTAIN') res.uncertain++;
      else res.skipped++;
    }
    return res;
  }
}
