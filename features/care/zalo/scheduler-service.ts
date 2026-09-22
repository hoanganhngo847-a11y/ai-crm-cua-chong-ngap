import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../../lib/supabase/admin';
import { ZaloClient } from '../../omnichannel/zalo/zalo-client';
import { CareScheduleDTO } from './types';

export interface ZaloCareSchedulerServiceOptions {
  supabase?: SupabaseClient;
  zaloClient?: ZaloClient;
}

export interface CreateScheduleParams {
  companyId: string;
  customerId: string;
  frequencyMonths?: number;
  nextSendAt?: string;
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
 * Helper to calculate the next date after adding months.
 */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const expectedMonth = (result.getMonth() + months) % 12;
  result.setMonth(result.getMonth() + months);

  // Handle month overflow (e.g. Jan 31 + 1 month -> Feb 28)
  if (result.getMonth() !== expectedMonth && result.getMonth() !== (expectedMonth + 12) % 12) {
    result.setDate(0);
  }
  return result;
}

/**
 * Service managing periodic Care Schedules (1 month / cycle) for Zalo.
 * Handles:
 * - Schedule creation and updating.
 * - Due schedule processing & advancing next_send_at.
 * - Automatic stop on customer opt-out or system stop flags.
 */
export class ZaloCareSchedulerService {
  private readonly supabase: SupabaseClient;
  private readonly zaloClient: ZaloClient;

  constructor(options: ZaloCareSchedulerServiceOptions = {}) {
    this.zaloClient = options.zaloClient || new ZaloClient();

    if (options.supabase) {
      this.supabase = options.supabase;
    } else {
      this.supabase = createAdminClient();
    }
  }

  /**
   * Creates or updates a customer care schedule with 1 month frequency default.
   */
  async createOrUpdateSchedule(params: CreateScheduleParams): Promise<CareScheduleDTO> {
    const { companyId, customerId, frequencyMonths = 1 } = params;

    // Default next_send_at is 1 month from now if not specified
    const nextSendAt = params.nextSendAt || addMonths(new Date(), frequencyMonths).toISOString();

    const { data: existing } = await this.supabase!
      .from('care_schedules')
      .select('id')
      .eq('company_id', companyId)
      .eq('customer_id', customerId)
      .eq('channel', 'ZALO')
      .maybeSingle();

    let record: Record<string, unknown>;

    if (existing) {
      const { data, error } = await this.supabase!
        .from('care_schedules')
        .update({
          frequency_months: frequencyMonths,
          next_send_at: nextSendAt,
          enabled: true,
          stop_reason: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select('*')
        .single();

      if (error || !data) {
        throw new Error(`Failed to update care schedule: ${error?.message}`);
      }
      record = data;
    } else {
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
      record = data;
    }

    const rec = record as {
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
    };

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
   * Processes all active due schedules (next_send_at <= asOfDate),
   * sends periodic check-in message, and increments next_send_at by frequency_months.
   */
  async processDueSchedules(options: {
    companyId: string;
    asOfDate?: Date;
    defaultMessage?: string;
  }): Promise<{ processed: number; advanced: number; skipped: number }> {
    const asOfIso = (options.asOfDate || new Date()).toISOString();
    const defaultTemplate =
      options.defaultMessage ||
      'Chào bạn, Cửa Chống Ngập xin gửi lời chào thăm định kỳ. Nếu gia đình có nhu cầu bảo dưỡng hoặc tư vấn kỹ thuật, hãy nhắn lại cho chúng tôi nhé!';

    // Query active due schedules
    const { data: dueSchedules, error } = await this.supabase
      .from('care_schedules')
      .select('id, company_id, customer_id, channel, frequency_months, next_send_at, enabled')
      .eq('company_id', options.companyId)
      .eq('channel', 'ZALO')
      .eq('enabled', true)
      .lte('next_send_at', asOfIso);

    if (error) {
      throw new Error(`Failed to fetch due care schedules: ${error.message}`);
    }

    if (!dueSchedules || dueSchedules.length === 0) {
      return { processed: 0, advanced: 0, skipped: 0 };
    }

    let advanced = 0;
    let skipped = 0;

    for (const schedule of dueSchedules) {
      // Fetch customer's Zalo identity
      const { data: identity } = await this.supabase
        .from('identities')
        .select('external_id')
        .eq('company_id', schedule.company_id)
        .eq('customer_id', schedule.customer_id)
        .eq('channel', 'ZALO')
        .maybeSingle();

      if (!identity?.external_id) {
        skipped++;
        continue;
      }

      // Send periodic message
      try {
        await this.zaloClient.sendTextMessage(identity.external_id, defaultTemplate);
      } catch {
        // Even if sending fails, we can either retry or advance according to business policy
      }

      // Calculate next send date: exactly 1 month (or frequency_months) after the schedule date
      const currentNextSend = new Date(schedule.next_send_at);
      const newNextSend = addMonths(currentNextSend, schedule.frequency_months || 1);

      await this.supabase
        .from('care_schedules')
        .update({
          next_send_at: newNextSend.toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', schedule.id);

      advanced++;
    }

    return {
      processed: dueSchedules.length,
      advanced,
      skipped,
    };
  }

  /**
   * Explicitly stops a care schedule for a customer.
   */
  async stopSchedule(companyId: string, customerId: string, reason: string): Promise<boolean> {
    const { error } = await this.supabase
      .from('care_schedules')
      .update({
        enabled: false,
        stop_reason: reason,
        updated_at: new Date().toISOString(),
      })
      .eq('company_id', companyId)
      .eq('customer_id', customerId)
      .eq('channel', 'ZALO');

    if (error) {
      throw new Error(`Failed to stop care schedule: ${error.message}`);
    }

    return true;
  }

  /**
   * Scans an incoming message for customer refusal/opt-out intent.
   * If detected, automatically disables the care schedule.
   */
  async checkAndHandleOptOut(
    companyId: string,
    customerId: string,
    messageText: string
  ): Promise<boolean> {
    const normalized = messageText.toLowerCase().trim();
    const isOptOut = OPT_OUT_KEYWORDS.some((kw) => normalized.includes(kw));

    if (isOptOut) {
      await this.stopSchedule(companyId, customerId, 'CUSTOMER_OPT_OUT');
      return true;
    }

    return false;
  }
}
