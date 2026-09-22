import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../../lib/supabase/admin';
import { ZaloClient } from '../../omnichannel/zalo/zalo-client';
import {
  AudienceCustomerInfo,
  CARE_AUDIENCE_GROUPS,
  CareAudienceGroup,
  CareCampaignDTO,
  CreateCareCampaignParams,
} from './types';
import { ZaloCareAnalyticsService } from './analytics-service';

export interface ZaloCareCampaignServiceOptions {
  supabase?: SupabaseClient;
  zaloClient?: ZaloClient;
  analyticsService?: ZaloCareAnalyticsService;
}

/**
 * Service managing Bulk Care Campaigns via Zalo OA.
 * Target audience: 4 groups ('UNREACHABLE_3_TIMES', 'CONSIDERING', 'QUOTED_NOT_CLOSED', 'OLD_CUSTOMER').
 *
 * Reliability & Policy Invariants:
 * 1. Opt-out & Suppression: Checks customer opt-out state before sending; skips suppressed customers.
 * 2. Send Idempotency: Enforced by deterministic idempotency_key (campaign_id:customer_id:channel).
 * 3. Delivery State Tracking: Records state in care_deliveries (PENDING -> SENT -> DELIVERED / FAILED / SKIPPED).
 * 4. Retry Policy: Retries up to 2 times for transient sending errors before marking FAILED.
 */
export class ZaloCareCampaignService {
  private readonly supabase: SupabaseClient;
  private readonly zaloClient: ZaloClient;
  private readonly analyticsService: ZaloCareAnalyticsService;

  constructor(options: ZaloCareCampaignServiceOptions = {}) {
    this.zaloClient = options.zaloClient || new ZaloClient();

    if (options.supabase) {
      this.supabase = options.supabase;
    } else {
      this.supabase = createAdminClient();
    }

    this.analyticsService =
      options.analyticsService || new ZaloCareAnalyticsService({ supabase: this.supabase });
  }

  /**
   * Creates a new Care Campaign record in care_campaigns.
   */
  async createCampaign(params: CreateCareCampaignParams): Promise<CareCampaignDTO> {
    const startedAt = params.startedAt || new Date().toISOString();

    const { data, error } = await this.supabase
      .from('care_campaigns')
      .insert({
        company_id: params.companyId,
        channel: 'ZALO',
        audience_rule: {
          audienceGroup: params.audienceGroup,
          title: params.title,
        },
        message_template: params.messageTemplate,
        started_at: startedAt,
        sent_count: 0,
        delivered_count: 0,
        response_count: 0,
        converted_to_sale_count: 0,
      })
      .select('*')
      .single();

    if (error || !data) {
      throw new Error(`Failed to create care campaign: ${error?.message}`);
    }

    return {
      id: data.id,
      companyId: data.company_id,
      channel: data.channel,
      audienceRule: data.audience_rule,
      messageTemplate: data.message_template,
      startedAt: data.started_at,
      sentCount: data.sent_count,
      deliveredCount: data.delivered_count,
      responseCount: data.response_count,
      convertedToSaleCount: data.converted_to_sale_count,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  /**
   * Resolves target audience customers based on the 4 business segments.
   * Excludes customers without Zalo Identity or customers who have opted out (CareSchedule enabled = false).
   */
  async getAudienceCustomers(
    companyId: string,
    audienceGroup: CareAudienceGroup
  ): Promise<AudienceCustomerInfo[]> {
    let stages: string[];

    switch (audienceGroup) {
      case CARE_AUDIENCE_GROUPS.UNREACHABLE_3_TIMES:
        stages = ['UNREACHABLE'];
        break;
      case CARE_AUDIENCE_GROUPS.CONSIDERING:
        stages = ['NEGOTIATING', 'PRICE_OFFERED'];
        break;
      case CARE_AUDIENCE_GROUPS.QUOTED_NOT_CLOSED:
        stages = ['PRICE_CALCULATED', 'SURVEY_COMPLETED'];
        break;
      case CARE_AUDIENCE_GROUPS.OLD_CUSTOMER:
        stages = ['HANDOVER_COMPLETED', 'WARRANTY_ACTIVE'];
        break;
      default:
        stages = [];
    }

    // 1. Fetch matching customers in stage
    const { data: customers, error: custError } = await this.supabase
      .from('customers')
      .select('id, name, stage')
      .eq('company_id', companyId)
      .in('stage', stages);

    if (custError) {
      throw new Error(`Failed to fetch audience customers: ${custError.message}`);
    }

    interface CustomerRecord {
      id: string;
      name: string;
      stage: string;
    }
    interface IdentityRecord {
      customer_id: string;
      external_id: string;
    }
    interface CareScheduleRecord {
      customer_id: string;
    }

    const customerList = (customers || []) as unknown as CustomerRecord[];
    const customerIds = customerList.map((c) => c.id);

    if (customerIds.length === 0) {
      return [];
    }

    // 2. Fetch Zalo identities for these customers
    const { data: identities, error: idError } = await this.supabase
      .from('identities')
      .select('customer_id, external_id')
      .eq('company_id', companyId)
      .eq('channel', 'ZALO')
      .in('customer_id', customerIds);

    if (idError) {
      throw new Error(`Failed to fetch Zalo identities: ${idError.message}`);
    }

    const zaloIdMap = new Map<string, string>();
    const identityList = (identities || []) as unknown as IdentityRecord[];
    identityList.forEach((i) => {
      zaloIdMap.set(i.customer_id, i.external_id);
    });

    // 3. Fetch disabled care schedules to respect customer opt-outs & suppressions
    const { data: disabledSchedules } = await this.supabase
      .from('care_schedules')
      .select('customer_id')
      .eq('company_id', companyId)
      .eq('channel', 'ZALO')
      .eq('enabled', false)
      .in('customer_id', customerIds);

    const optOutSet = new Set<string>();
    const disabledList = (disabledSchedules || []) as unknown as CareScheduleRecord[];
    disabledList.forEach((s) => {
      optOutSet.add(s.customer_id);
    });

    // 4. Combine and filter eligible audience (Strict suppression of opted-out users)
    const result: AudienceCustomerInfo[] = [];

    for (const cust of customerList) {
      const zaloUid = zaloIdMap.get(cust.id);
      const isOptedOut = optOutSet.has(cust.id);

      if (zaloUid && !isOptedOut) {
        result.push({
          customerId: cust.id,
          customerName: cust.name,
          customerStage: cust.stage,
          zaloUid,
        });
      }
    }

    return result;
  }

  /**
   * Executes campaign sending with batching, rate limiting, and idempotency protection.
   */
  async executeCampaign(
    campaignId: string,
    options: { batchSize?: number; delayMsBetweenBatches?: number; maxRetries?: number } = {}
  ): Promise<{
    sent: number;
    failed: number;
    skipped: number;
    totalAudience: number;
  }> {
    const batchSize = options.batchSize || 20;
    const delayMs = options.delayMsBetweenBatches ?? 500;
    const maxRetries = options.maxRetries ?? 2;

    // Fetch campaign details
    const { data: campaign, error: campError } = await this.supabase
      .from('care_campaigns')
      .select('*')
      .eq('id', campaignId)
      .single();

    if (campError || !campaign) {
      throw new Error(`Care campaign ${campaignId} not found`);
    }

    const audienceGroup = campaign.audience_rule?.audienceGroup as CareAudienceGroup;
    const template = campaign.message_template;
    const audience = await this.getAudienceCustomers(campaign.company_id, audienceGroup);

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    // Process in batches
    for (let i = 0; i < audience.length; i += batchSize) {
      const batch = audience.slice(i, i + batchSize);

      for (const target of batch) {
        const idempotencyKey = `${campaignId}:${target.customerId}:ZALO`;

        // 1. IDEMPOTENCY CHECK: Check if delivery already exists
        const { data: existingDelivery } = await this.supabase
          .from('care_deliveries')
          .select('id, status')
          .eq('company_id', campaign.company_id)
          .eq('idempotency_key', idempotencyKey)
          .maybeSingle();

        if (existingDelivery) {
          skipped++;
          continue;
        }

        // 2. REAL-TIME OPT-OUT / SUPPRESSION CHECK (Fail-safe against recent opt-outs)
        const { data: optOutCheck } = await this.supabase
          .from('care_schedules')
          .select('id, enabled')
          .eq('company_id', campaign.company_id)
          .eq('customer_id', target.customerId)
          .eq('channel', 'ZALO')
          .maybeSingle();

        if (optOutCheck && optOutCheck.enabled === false) {
          // Record SKIPPED delivery to document suppression compliance
          await this.supabase.from('care_deliveries').insert({
            company_id: campaign.company_id,
            campaign_id: campaignId,
            customer_id: target.customerId,
            idempotency_key: idempotencyKey,
            channel: 'ZALO',
            status: 'SKIPPED',
          });
          skipped++;
          continue;
        }

        // 3. Insert PENDING delivery record BEFORE calling external provider (Durable state tracking)
        const { data: delivery, error: insertError } = await this.supabase
          .from('care_deliveries')
          .insert({
            company_id: campaign.company_id,
            campaign_id: campaignId,
            customer_id: target.customerId,
            idempotency_key: idempotencyKey,
            channel: 'ZALO',
            status: 'PENDING',
          })
          .select('id')
          .single();

        if (insertError || !delivery) {
          skipped++;
          continue;
        }

        // 4. Personalize message template
        const renderedMessage = template.replace(/\{name\}/g, target.customerName);

        // 5. Send message via Zalo OpenAPI with Retry Policy
        let isSuccess = false;
        let messageId = '';

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            const sendRes = await this.zaloClient.sendTextMessage(target.zaloUid, renderedMessage);

            if (sendRes.error === 0) {
              isSuccess = true;
              messageId = sendRes.data?.message_id || `msg_${Date.now()}`;
              break;
            }
          } catch {
            // Transient failure caught for retry attempt
          }

          if (attempt < maxRetries) {
            // Brief exponential backoff
            await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
          }
        }

        const nowIso = new Date().toISOString();
        if (isSuccess) {
          await this.supabase
            .from('care_deliveries')
            .update({
              status: 'SENT',
              sent_at: nowIso,
              delivered_at: nowIso,
              external_message_ref: messageId,
              updated_at: nowIso,
            })
            .eq('id', delivery.id);

          sent++;
        } else {
          await this.supabase
            .from('care_deliveries')
            .update({
              status: 'FAILED',
              updated_at: nowIso,
            })
            .eq('id', delivery.id);

          failed++;
        }
      }

      // Delay between batches to respect rate limits if more batches remain
      if (i + batchSize < audience.length && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    // 6. Update Campaign metrics from care_deliveries rollup
    await this.analyticsService.calculateCampaignMetrics(campaignId);

    return {
      sent,
      failed,
      skipped,
      totalAudience: audience.length,
    };
  }
}
