import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../../lib/supabase/admin';
import { CampaignAnalyticsSummary, CareAudienceGroup } from './types';

export interface ZaloCareAnalyticsServiceOptions {
  supabase?: SupabaseClient;
}

export interface CompanyCareSummary {
  companyId: string;
  totalCampaigns: number;
  totalSent: number;
  totalDelivered: number;
  totalResponses: number;
  totalConvertedToSale: number;
  overallDeliveryRatePercent: number;
  overallResponseRatePercent: number;
  overallConversionRatePercent: number;
}

/**
 * Service for calculating, aggregating, and providing Care Campaign Analytics.
 * Invariant: Metrics are computed strictly from verifiable CareDelivery records.
 * Provides clean, accurate reporting data for Member 9 (Analytics).
 */
export class ZaloCareAnalyticsService {
  private readonly supabase: SupabaseClient;

  constructor(options: ZaloCareAnalyticsServiceOptions = {}) {
    if (options.supabase) {
      this.supabase = options.supabase;
    } else {
      this.supabase = createAdminClient();
    }
  }

  /**
   * Reconciles and recalculates metrics for a campaign from care_deliveries,
   * then updates the care_campaigns row.
   */
  async calculateCampaignMetrics(campaignId: string): Promise<CampaignAnalyticsSummary> {
    // 1. Fetch campaign metadata
    const { data: campaign, error: campError } = await this.supabase
      .from('care_campaigns')
      .select('*')
      .eq('id', campaignId)
      .single();

    if (campError || !campaign) {
      throw new Error(`Campaign ${campaignId} not found: ${campError?.message}`);
    }

    // 2. Fetch all deliveries for this campaign
    const { data: deliveries, error: delError } = await this.supabase
      .from('care_deliveries')
      .select('id, status, sent_at, delivered_at, responded_at, converted_to_sale_at')
      .eq('campaign_id', campaignId);

    if (delError) {
      throw new Error(`Failed to fetch deliveries for campaign ${campaignId}: ${delError.message}`);
    }

    const items = deliveries || [];

    let sentCount = 0;
    let deliveredCount = 0;
    let responseCount = 0;
    let convertedToSaleCount = 0;

    for (const d of items) {
      const isSent =
        Boolean(d.sent_at) ||
        ['SENT', 'DELIVERED', 'READ', 'RESPONDED', 'CONVERTED_TO_SALE'].includes(d.status);

      const isDelivered =
        Boolean(d.delivered_at) ||
        ['DELIVERED', 'READ', 'RESPONDED', 'CONVERTED_TO_SALE'].includes(d.status);

      const isResponded =
        Boolean(d.responded_at) ||
        ['RESPONDED', 'CONVERTED_TO_SALE'].includes(d.status);

      const isConverted =
        Boolean(d.converted_to_sale_at) ||
        d.status === 'CONVERTED_TO_SALE';

      if (isSent) sentCount++;
      if (isDelivered) deliveredCount++;
      if (isResponded) responseCount++;
      if (isConverted) convertedToSaleCount++;
    }

    const nowIso = new Date().toISOString();

    // 3. Atomically persist reconciled counts into care_campaigns table
    await this.supabase
      .from('care_campaigns')
      .update({
        sent_count: sentCount,
        delivered_count: deliveredCount,
        response_count: responseCount,
        converted_to_sale_count: convertedToSaleCount,
        updated_at: nowIso,
      })
      .eq('id', campaignId);

    const deliveryRatePercent = sentCount > 0 ? Number(((deliveredCount / sentCount) * 100).toFixed(2)) : 0;
    const responseRatePercent = sentCount > 0 ? Number(((responseCount / sentCount) * 100).toFixed(2)) : 0;
    const conversionRatePercent = responseCount > 0 ? Number(((convertedToSaleCount / responseCount) * 100).toFixed(2)) : 0;

    return {
      campaignId,
      title: campaign.audience_rule?.title || 'Chiến dịch chăm sóc Zalo',
      audienceGroup: campaign.audience_rule?.audienceGroup as CareAudienceGroup,
      sentCount,
      deliveredCount,
      responseCount,
      convertedToSaleCount,
      deliveryRatePercent,
      responseRatePercent,
      conversionRatePercent,
      updatedAt: nowIso,
    };
  }

  /**
   * Returns clean, calculated campaign report for Member 9 (Analytics).
   */
  async getCampaignAnalytics(campaignId: string): Promise<CampaignAnalyticsSummary> {
    return this.calculateCampaignMetrics(campaignId);
  }

  /**
   * Aggregates care campaign performance across the entire company.
   */
  async getCompanyCareSummary(companyId: string): Promise<CompanyCareSummary> {
    const { data: campaigns, error } = await this.supabase
      .from('care_campaigns')
      .select('id, sent_count, delivered_count, response_count, converted_to_sale_count')
      .eq('company_id', companyId)
      .eq('channel', 'ZALO');

    if (error) {
      throw new Error(`Failed to fetch company care campaigns: ${error.message}`);
    }

    const items = campaigns || [];
    let totalSent = 0;
    let totalDelivered = 0;
    let totalResponses = 0;
    let totalConverted = 0;

    for (const c of items) {
      totalSent += c.sent_count || 0;
      totalDelivered += c.delivered_count || 0;
      totalResponses += c.response_count || 0;
      totalConverted += c.converted_to_sale_count || 0;
    }

    return {
      companyId,
      totalCampaigns: items.length,
      totalSent,
      totalDelivered,
      totalResponses,
      totalConvertedToSale: totalConverted,
      overallDeliveryRatePercent: totalSent > 0 ? Number(((totalDelivered / totalSent) * 100).toFixed(2)) : 0,
      overallResponseRatePercent: totalSent > 0 ? Number(((totalResponses / totalSent) * 100).toFixed(2)) : 0,
      overallConversionRatePercent: totalResponses > 0 ? Number(((totalConverted / totalResponses) * 100).toFixed(2)) : 0,
    };
  }

  /**
   * Records that a customer care interaction led to a sales conversion.
   */
  async recordConversionToSale(
    companyId: string,
    customerId: string,
    deliveryId?: string
  ): Promise<boolean> {
    const nowIso = new Date().toISOString();

    let query = this.supabase
      .from('care_deliveries')
      .update({
        status: 'CONVERTED_TO_SALE',
        converted_to_sale_at: nowIso,
        updated_at: nowIso,
      })
      .eq('company_id', companyId)
      .eq('customer_id', customerId);

    if (deliveryId) {
      query = query.eq('id', deliveryId);
    } else {
      query = query.in('status', ['SENT', 'DELIVERED', 'RESPONDED']);
    }

    const { data: updated, error } = await query.select('campaign_id');

    if (error) {
      throw new Error(`Failed to record conversion to sale: ${error.message}`);
    }

    // Refresh campaign metrics if deliveries were updated
    if (updated && updated.length > 0) {
      const updatedRows = updated as Array<{ campaign_id?: string | null }>;
      const campaignIds: string[] = Array.from(
        new Set<string>(
          updatedRows
            .map((u) => (u.campaign_id ? String(u.campaign_id) : ''))
            .filter((id) => Boolean(id))
        )
      );
      for (const campId of campaignIds) {
        if (campId) {
          await this.calculateCampaignMetrics(campId);
        }
      }
    }

    return true;
  }
}
