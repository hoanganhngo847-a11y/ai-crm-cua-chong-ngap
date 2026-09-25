import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  CompanyAnalyticsDailySeries,
  CompanyAnalyticsOverview,
} from '@/shared/contracts/analytics';

export interface FetchCompanyAnalyticsParams {
  companyId: string;
  from: string; // ISO 8601 timestamptz string
  to: string;   // ISO 8601 timestamptz string
}

const MAX_ANALYTICS_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

function validateAnalyticsParams(params: FetchCompanyAnalyticsParams): void {
  if (!params.companyId || typeof params.companyId !== 'string') {
    throw new Error('companyId must be a non-empty string');
  }

  if (!params.from || !params.to) {
    throw new Error('Analytics period requires both "from" and "to" timestamps');
  }

  const fromTime = new Date(params.from).getTime();
  const toTime = new Date(params.to).getTime();

  if (Number.isNaN(fromTime) || Number.isNaN(toTime)) {
    throw new Error('Analytics period timestamps must be valid ISO 8601 dates');
  }

  if (fromTime >= toTime) {
    throw new Error('Analytics period start (from) must be strictly before end (to)');
  }

  if (toTime - fromTime > MAX_ANALYTICS_RANGE_MS) {
    throw new Error('Analytics period cannot exceed 366 days');
  }
}

/**
 * Fetches the company-wide analytics overview for an authenticated BOSS_ADMIN session.
 *
 * STRICT SECURITY:
 * - Must be called with an authenticated user session SupabaseClient.
 * - Service-role key and anonymous sessions are rejected at the database boundary.
 * - Tenant isolation and role authorization (BOSS_ADMIN) are enforced inside the database RPC.
 */
export async function fetchCompanyAnalyticsOverview(
  authenticatedClient: SupabaseClient,
  params: FetchCompanyAnalyticsParams
): Promise<CompanyAnalyticsOverview> {
  validateAnalyticsParams(params);

  const { data, error } = await authenticatedClient.rpc('get_company_analytics_overview', {
    p_company_id: params.companyId,
    p_from: params.from,
    p_to: params.to,
  });

  if (error) {
    throw new Error(
      `Failed to fetch company analytics overview: ${error.message} (code: ${error.code})`
    );
  }

  if (!data) {
    throw new Error('get_company_analytics_overview RPC returned no data');
  }

  return data as CompanyAnalyticsOverview;
}

/**
 * Fetches the UTC daily time-series analytics for an authenticated BOSS_ADMIN session.
 *
 * STRICT SECURITY:
 * - Must be called with an authenticated user session SupabaseClient.
 * - Service-role key and anonymous sessions are rejected at the database boundary.
 * - Returns event-driven metrics aggregated by UTC day buckets.
 */
export async function fetchCompanyAnalyticsDailySeries(
  authenticatedClient: SupabaseClient,
  params: FetchCompanyAnalyticsParams
): Promise<CompanyAnalyticsDailySeries> {
  validateAnalyticsParams(params);

  const { data, error } = await authenticatedClient.rpc('get_company_analytics_daily_series', {
    p_company_id: params.companyId,
    p_from: params.from,
    p_to: params.to,
  });

  if (error) {
    throw new Error(
      `Failed to fetch company analytics daily series: ${error.message} (code: ${error.code})`
    );
  }

  return (data || []) as CompanyAnalyticsDailySeries;
}
