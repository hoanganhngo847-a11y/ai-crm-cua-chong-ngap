import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../../lib/supabase/admin';
import { ZaloClient, ZaloClientFactory, ZaloSendResult } from '../../omnichannel/zalo/zalo-client';
import { detectCareOptOut } from '../../omnichannel/zalo/opt-out';
import { CareScheduleDTO } from './types';
import { renderCareTemplate } from './template';

export type CareClientProvider = (companyId: string, oaId: string) => Promise<ZaloClient>;

export interface ZaloCareSchedulerServiceOptions {
  supabase?: SupabaseClient;
  /** Overrides per-OA client resolution (tests). Production uses ZaloClientFactory. */
  clientProvider?: CareClientProvider;
  fetchFn?: typeof fetch;
}

export interface CreateScheduleParams {
  companyId: string;
  customerId: string;
  frequencyMonths?: number;
  nextSendAt?: string;
  /**
   * Required to turn a STOPPED schedule back on (PROJECT_MASTER §13: never re-enable silently).
   */
  reactivation?: { actorUserId: string; reason: string };
}

export interface ProcessDueSchedulesResult {
  processed: number;
  advanced: number;
  failed: number;
  uncertain: number;
  skipped: number;
}

export class CareScheduleStoppedError extends Error {
  readonly stopReason: string | null;

  constructor(stopReason: string | null) {
    super(`Care schedule is stopped (${stopReason || 'UNKNOWN'}); explicit reactivation is required.`);
    this.name = 'CareScheduleStoppedError';
    this.stopReason = stopReason;
  }
}

interface ScheduleClaimRow {
  claim_status:
    | 'CLAIMED'
    | 'NOT_FOUND'
    | 'STOPPED'
    | 'NOT_DUE'
    | 'OA_NOT_CONFIGURED'
    | 'NO_ZALO_IDENTITY'
    | 'ALREADY_RESOLVED'
    | 'BUSY'
    | 'UNCERTAIN'
    | 'EXHAUSTED';
  delivery_id: string | null;
  claim_token: string | null;
  customer_id: string | null;
  customer_name: string | null;
  recipient_zalo_uid: string | null;
  oa_id: string | null;
  message_template: string | null;
  attempt_count: number;
}

interface ScheduleRow {
  id: string;
  company_id: string;
  customer_id: string;
  channel: 'ZALO';
  frequency_months: number;
  next_send_at: string;
  enabled: boolean;
  stop_reason?: string | null;
  created_at: string;
  updated_at: string;
}

const DEFAULT_PERIODIC_TEMPLATE =
  'Chào {name}, Cửa Chống Ngập xin gửi lời hỏi thăm định kỳ. Nếu gia đình cần bảo dưỡng hoặc tư vấn kỹ thuật, hãy nhắn lại cho chúng tôi nhé!';

/**
 * Month arithmetic with end-of-month clamping (Jan 31 + 1 month → Feb 28/29).
 */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(day, lastDay));
  return result;
}

function toDto(rec: ScheduleRow): CareScheduleDTO {
  return {
    id: rec.id,
    companyId: rec.company_id,
    customerId: rec.customer_id,
    channel: rec.channel,
    frequencyMonths: rec.frequency_months,
    nextSendAt: rec.next_send_at,
    enabled: rec.enabled,
    stopReason: rec.stop_reason,
    createdAt: rec.created_at,
    updatedAt: rec.updated_at,
  };
}

/**
 * Periodic (default monthly) Zalo care schedules.
 *
 * Worker invariants (#9):
 * - A send happens only after care_claim_schedule_delivery returns CLAIMED with a claim token;
 *   concurrent workers get BUSY. The claim row is keyed per (schedule, target date).
 * - FAILED (provider definitively rejected) re-claims the SAME delivery row with attempt_count+1
 *   up to maxAttempts; the schedule stays due until then.
 * - UNCERTAIN (timeout / crash mid-send) is never resent: the cycle is consumed to avoid a
 *   duplicate care message, and the delivery stays UNCERTAIN for review.
 * - next_send_at advances inside care_complete_delivery, in the same transaction as SENT.
 * - Stopped schedules (opt-out, unfollow, business decision) are never re-enabled implicitly.
 */
export class ZaloCareSchedulerService {
  private readonly supabase: SupabaseClient;
  private readonly clientProvider: CareClientProvider;

  constructor(options: ZaloCareSchedulerServiceOptions = {}) {
    const supabase = options.supabase ?? createAdminClient();
    this.supabase = supabase;
    this.clientProvider =
      options.clientProvider ??
      ((companyId, oaId) => ZaloClientFactory.getClientForOa(companyId, oaId, { supabase, fetchFn: options.fetchFn }));
  }

  async createOrUpdateSchedule(params: CreateScheduleParams): Promise<CareScheduleDTO> {
    const { companyId, customerId, frequencyMonths = 1 } = params;
    if (!Number.isInteger(frequencyMonths) || frequencyMonths < 1) {
      throw new Error('frequencyMonths must be a positive integer');
    }
    const nextSendAt = params.nextSendAt || addMonths(new Date(), frequencyMonths).toISOString();

    const { data: existing, error: existingError } = await this.supabase
      .from('care_schedules')
      .select('id, enabled, stop_reason')
      .eq('company_id', companyId)
      .eq('customer_id', customerId)
      .eq('channel', 'ZALO')
      .maybeSingle();
    if (existingError) {
      throw new Error(`Failed to load care schedule: ${existingError.message}`);
    }

    if (existing) {
      const isStopped = existing.enabled === false;
      if (isStopped && !params.reactivation) {
        throw new CareScheduleStoppedError(existing.stop_reason ?? null);
      }
      if (isStopped && params.reactivation && !params.reactivation.reason.trim()) {
        throw new Error('A reactivation reason is required');
      }

      const { data, error } = await this.supabase
        .from('care_schedules')
        .update({
          frequency_months: frequencyMonths,
          next_send_at: nextSendAt,
          ...(isStopped ? { enabled: true, stop_reason: null } : {}),
        })
        .eq('id', existing.id)
        .select('*')
        .single();
      if (error || !data) {
        throw new Error(`Failed to update care schedule: ${error?.message}`);
      }

      if (isStopped && params.reactivation) {
        await this.audit(companyId, customerId, existing.id, 'CARE_SCHEDULE_REACTIVATED', params.reactivation.actorUserId, {
          previous_stop_reason: existing.stop_reason ?? null,
          reason: params.reactivation.reason.trim().slice(0, 300),
        });
      }
      return toDto(data as ScheduleRow);
    }

    const { data, error } = await this.supabase
      .from('care_schedules')
      .insert({
        company_id: companyId,
        customer_id: customerId,
        channel: 'ZALO',
        frequency_months: frequencyMonths,
        next_send_at: nextSendAt,
        enabled: true,
        stop_reason: null,
      })
      .select('*')
      .single();
    if (error || !data) {
      throw new Error(`Failed to insert care schedule: ${error?.message}`);
    }
    return toDto(data as ScheduleRow);
  }

  async processDueSchedules(options: {
    companyId: string;
    asOfDate?: Date;
    defaultMessage?: string;
    limit?: number;
    maxAttempts?: number;
  }): Promise<ProcessDueSchedulesResult> {
    const asOf = options.asOfDate || new Date();

    const { data: dueSchedules, error } = await this.supabase
      .from('care_schedules')
      .select('id')
      .eq('company_id', options.companyId)
      .eq('channel', 'ZALO')
      .eq('enabled', true)
      .lte('next_send_at', asOf.toISOString())
      .order('next_send_at', { ascending: true })
      .limit(options.limit ?? 200);
    if (error) {
      throw new Error(`Failed to fetch due care schedules: ${error.message}`);
    }

    const result: ProcessDueSchedulesResult = { processed: 0, advanced: 0, failed: 0, uncertain: 0, skipped: 0 };

    for (const schedule of (dueSchedules || []) as { id: string }[]) {
      result.processed++;

      const { data: claimData, error: claimError } = await this.supabase.rpc('care_claim_schedule_delivery', {
        p_company_id: options.companyId,
        p_schedule_id: schedule.id,
        p_default_template: options.defaultMessage || DEFAULT_PERIODIC_TEMPLATE,
        p_as_of: asOf.toISOString(),
        p_max_attempts: options.maxAttempts ?? 3,
      });
      if (claimError) {
        console.error(`[CareScheduler] Claim failed for schedule ${schedule.id}: ${claimError.message}`);
        result.skipped++;
        continue;
      }

      const claim = (Array.isArray(claimData) ? claimData[0] : claimData) as ScheduleClaimRow | undefined;
      if (!claim || claim.claim_status !== 'CLAIMED' || !claim.delivery_id || !claim.claim_token) {
        if (claim?.claim_status === 'OA_NOT_CONFIGURED') {
          console.warn(`[CareScheduler] Schedule ${schedule.id}: no ACTIVE Zalo OA resolvable; left due.`);
        }
        result.skipped++;
        continue;
      }

      const message = renderCareTemplate(claim.message_template || DEFAULT_PERIODIC_TEMPLATE, {
        name: claim.customer_name || 'Quý khách',
      });
      const outcome = await this.send(options.companyId, claim.oa_id as string, claim.recipient_zalo_uid as string, message);

      const { error: completeError } = await this.supabase.rpc('care_complete_delivery', {
        p_delivery_id: claim.delivery_id,
        p_claim_token: claim.claim_token,
        p_outcome: outcome.outcome,
        p_provider_msg_id: outcome.providerMsgId ?? null,
        p_error_code: outcome.errorCode ?? null,
        p_error_message: outcome.errorMessage ?? null,
      });
      if (completeError) {
        // Lease will expire → next tick classifies the delivery UNCERTAIN (never resent).
        console.error(`[CareScheduler] Could not record outcome for delivery ${claim.delivery_id}: ${completeError.message}`);
        result.uncertain++;
        continue;
      }

      if (outcome.outcome === 'ACCEPTED') result.advanced++;
      else if (outcome.outcome === 'REJECTED') result.failed++;
      else result.uncertain++;
    }

    return result;
  }

  private async send(companyId: string, oaId: string, recipient: string, message: string): Promise<ZaloSendResult> {
    try {
      const client = await this.clientProvider(companyId, oaId);
      return await client.sendTextMessageWithOutcome(recipient, message);
    } catch (err: unknown) {
      return {
        outcome: 'REJECTED',
        errorCode: 'CLIENT_UNAVAILABLE',
        errorMessage: err instanceof Error ? err.message : 'Zalo client unavailable',
      };
    }
  }

  /**
   * Stops a schedule and records the reason. Idempotent.
   */
  async stopSchedule(companyId: string, customerId: string, reason: string, actorUserId: string | null = null): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('care_schedules')
      .update({ enabled: false, stop_reason: reason })
      .eq('company_id', companyId)
      .eq('customer_id', customerId)
      .eq('channel', 'ZALO')
      .select('id');
    if (error) {
      throw new Error(`Failed to stop care schedule: ${error.message}`);
    }
    for (const row of (data || []) as { id: string }[]) {
      await this.audit(companyId, customerId, row.id, 'CARE_SCHEDULE_STOPPED', actorUserId, { stop_reason: reason, channel: 'ZALO' });
    }
    return true;
  }

  /**
   * Stops the schedule when the message expresses an opt-out (whole-word matching).
   */
  async checkAndHandleOptOut(companyId: string, customerId: string, messageText: string): Promise<boolean> {
    if (!detectCareOptOut(messageText)) {
      return false;
    }
    await this.stopSchedule(companyId, customerId, 'CUSTOMER_OPT_OUT');
    return true;
  }

  private async audit(
    companyId: string,
    customerId: string,
    scheduleId: string,
    action: string,
    actorUserId: string | null,
    metadata: Record<string, unknown>
  ): Promise<void> {
    const { error } = await this.supabase.from('audit_logs').insert({
      company_id: companyId,
      user_id: actorUserId,
      action,
      resource_type: 'CARE_SCHEDULE',
      resource_id: scheduleId,
      customer_id: customerId,
      result: 'SUCCESS',
      metadata,
    });
    if (error) {
      throw new Error(`Failed to write care schedule audit: ${error.message}`);
    }
  }
}
