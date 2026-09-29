import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../../lib/supabase/admin';
import { ZaloClient, ZaloClientFactory, ZaloSendResult } from '../../omnichannel/zalo/zalo-client';
import {
  AudienceCustomerInfo,
  CARE_AUDIENCE_GROUPS,
  CareAudienceGroup,
  CareCampaignDTO,
  CreateCareCampaignParams,
} from './types';
import { ZaloCareAnalyticsService } from './analytics-service';
import { renderCareTemplate } from './template';
import { ServerAuthError } from '../../../lib/server-auth/errors';

export type CampaignClientProvider = (companyId: string, oaId: string) => Promise<ZaloClient>;

export interface ZaloCareCampaignServiceOptions {
  supabase?: SupabaseClient;
  /** Overrides per-OA client resolution (tests). Production uses ZaloClientFactory. */
  clientProvider?: CampaignClientProvider;
  fetchFn?: typeof fetch;
  analyticsService?: ZaloCareAnalyticsService;
}

export interface ExecuteCampaignResult {
  sent: number;
  failed: number;
  uncertain: number;
  skipped: number;
  totalAudience: number;
}

interface CampaignClaimRow {
  claim_status: 'CLAIMED' | 'SKIPPED' | 'BUSY' | 'UNCERTAIN' | 'EXHAUSTED' | 'ALREADY_RESOLVED';
  delivery_id: string | null;
  claim_token: string | null;
  customer_name: string | null;
  recipient_zalo_uid: string | null;
  oa_id: string | null;
  message_template: string | null;
  attempt_count: number;
}

const AUDIENCE_STAGES: Record<CareAudienceGroup, string[]> = {
  [CARE_AUDIENCE_GROUPS.UNREACHABLE_3_TIMES]: ['UNREACHABLE'],
  [CARE_AUDIENCE_GROUPS.CONSIDERING]: ['NEGOTIATING', 'PRICE_OFFERED'],
  [CARE_AUDIENCE_GROUPS.QUOTED_NOT_CLOSED]: ['PRICE_CALCULATED', 'SURVEY_COMPLETED'],
  [CARE_AUDIENCE_GROUPS.OLD_CUSTOMER]: ['HANDOVER_COMPLETED', 'WARRANTY_ACTIVE'],
};

/**
 * Bulk Zalo care campaigns for the 4 business audience segments.
 *
 * Invariants:
 * 1. Suppression: opt-out / unfollow is re-checked inside the claim transaction (SKIPPED row kept
 *    as compliance evidence).
 * 2. Idempotency: one care_deliveries row per (campaign, customer); only the claim-token holder
 *    may call the provider. Re-running a campaign resumes it: FAILED rows are re-claimed up to
 *    maxAttempts, SENT/UNCERTAIN rows are never sent again.
 * 3. No blind retries: a timeout/5xx is UNCERTAIN and is not resent automatically.
 * 4. Metrics are recomputed from care_deliveries (never incremented ad hoc).
 */
export class ZaloCareCampaignService {
  private readonly supabase: SupabaseClient;
  private readonly clientProvider: CampaignClientProvider;
  private readonly analyticsService: ZaloCareAnalyticsService;

  constructor(options: ZaloCareCampaignServiceOptions = {}) {
    const supabase = options.supabase ?? createAdminClient();
    this.supabase = supabase;
    this.clientProvider =
      options.clientProvider ??
      ((companyId, oaId) => ZaloClientFactory.getClientForOa(companyId, oaId, { supabase, fetchFn: options.fetchFn }));
    this.analyticsService = options.analyticsService || new ZaloCareAnalyticsService({ supabase });
  }

  async createCampaign(params: CreateCareCampaignParams): Promise<CareCampaignDTO> {
    if (!AUDIENCE_STAGES[params.audienceGroup]) {
      throw new Error(`Unknown care audience group: ${params.audienceGroup}`);
    }
    if (!params.messageTemplate?.trim()) {
      throw new Error('messageTemplate is required');
    }

    const { data, error } = await this.supabase
      .from('care_campaigns')
      .insert({
        company_id: params.companyId,
        channel: 'ZALO',
        audience_rule: { audienceGroup: params.audienceGroup, title: params.title },
        message_template: params.messageTemplate.trim(),
        started_at: params.startedAt || new Date().toISOString(),
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
   * Customers of the segment that have a Zalo identity and have not opted out.
   */
  async getAudienceCustomers(companyId: string, audienceGroup: CareAudienceGroup): Promise<AudienceCustomerInfo[]> {
    const stages = AUDIENCE_STAGES[audienceGroup] || [];
    if (stages.length === 0) {
      return [];
    }

    const { data: customers, error: custError } = await this.supabase
      .from('customers')
      .select('id, name, stage')
      .eq('company_id', companyId)
      .in('stage', stages);
    if (custError) {
      throw new Error(`Failed to fetch audience customers: ${custError.message}`);
    }

    const customerList = (customers || []) as { id: string; name: string; stage: string }[];
    const customerIds = customerList.map((c) => c.id);
    if (customerIds.length === 0) {
      return [];
    }

    const [{ data: identities, error: idError }, { data: stopped, error: stopError }] = await Promise.all([
      this.supabase
        .from('identities')
        .select('customer_id, external_id')
        .eq('company_id', companyId)
        .eq('channel', 'ZALO')
        .in('customer_id', customerIds),
      this.supabase
        .from('care_schedules')
        .select('customer_id')
        .eq('company_id', companyId)
        .eq('channel', 'ZALO')
        .eq('enabled', false)
        .in('customer_id', customerIds),
    ]);
    if (idError) {
      throw new Error(`Failed to fetch Zalo identities: ${idError.message}`);
    }
    if (stopError) {
      throw new Error(`Failed to fetch care suppressions: ${stopError.message}`);
    }

    const zaloIdMap = new Map(
      ((identities || []) as { customer_id: string; external_id: string }[]).map((i) => [i.customer_id, i.external_id])
    );
    const optOutSet = new Set(((stopped || []) as { customer_id: string }[]).map((s) => s.customer_id));

    return customerList
      .filter((c) => zaloIdMap.has(c.id) && !optOutSet.has(c.id))
      .map((c) => ({
        customerId: c.id,
        customerName: c.name,
        customerStage: c.stage,
        zaloUid: zaloIdMap.get(c.id) as string,
      }));
  }

  /**
   * Sends (or resumes) a campaign. `companyId` must come from the verified caller and must own
   * the campaign.
   */
  async executeCampaign(
    campaignId: string,
    options: { companyId: string; batchSize?: number; delayMsBetweenBatches?: number; maxAttempts?: number }
  ): Promise<ExecuteCampaignResult> {
    const batchSize = options.batchSize || 20;
    const delayMs = options.delayMsBetweenBatches ?? 500;

    const { data: campaign, error: campError } = await this.supabase
      .from('care_campaigns')
      .select('id, company_id, audience_rule')
      .eq('id', campaignId)
      .eq('company_id', options.companyId)
      .maybeSingle();
    if (campError || !campaign) {
      throw new ServerAuthError(`Không tìm thấy chiến dịch chăm sóc (${campaignId}).`, 404, 'RESOURCE_NOT_FOUND');
    }

    const audienceGroup = campaign.audience_rule?.audienceGroup as CareAudienceGroup;
    const audience = await this.getAudienceCustomers(campaign.company_id, audienceGroup);
    const result: ExecuteCampaignResult = { sent: 0, failed: 0, uncertain: 0, skipped: 0, totalAudience: audience.length };

    for (let i = 0; i < audience.length; i += batchSize) {
      for (const target of audience.slice(i, i + batchSize)) {
        const { data: claimData, error: claimError } = await this.supabase.rpc('care_claim_campaign_delivery', {
          p_campaign_id: campaignId,
          p_customer_id: target.customerId,
          p_max_attempts: options.maxAttempts ?? 3,
        });
        if (claimError) {
          console.error(`[CareCampaign] Claim failed for customer ${target.customerId}: ${claimError.message}`);
          result.skipped++;
          continue;
        }

        const claim = (Array.isArray(claimData) ? claimData[0] : claimData) as CampaignClaimRow | undefined;
        if (!claim || claim.claim_status !== 'CLAIMED' || !claim.delivery_id || !claim.claim_token) {
          if (claim?.claim_status === 'UNCERTAIN') result.uncertain++;
          else result.skipped++;
          continue;
        }

        const message = renderCareTemplate(claim.message_template || '', { name: claim.customer_name || target.customerName });
        const outcome = await this.send(campaign.company_id, claim.oa_id as string, claim.recipient_zalo_uid as string, message);

        const { error: completeError } = await this.supabase.rpc('care_complete_delivery', {
          p_delivery_id: claim.delivery_id,
          p_claim_token: claim.claim_token,
          p_outcome: outcome.outcome,
          p_provider_msg_id: outcome.providerMsgId ?? null,
          p_error_code: outcome.errorCode ?? null,
          p_error_message: outcome.errorMessage ?? null,
        });
        if (completeError) {
          console.error(`[CareCampaign] Could not record outcome for delivery ${claim.delivery_id}: ${completeError.message}`);
          result.uncertain++;
          continue;
        }

        if (outcome.outcome === 'ACCEPTED') result.sent++;
        else if (outcome.outcome === 'REJECTED') result.failed++;
        else result.uncertain++;
      }

      if (i + batchSize < audience.length && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    await this.analyticsService.calculateCampaignMetrics(campaignId);
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
}
