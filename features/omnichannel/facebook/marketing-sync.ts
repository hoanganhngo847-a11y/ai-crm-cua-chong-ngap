import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { decryptToken } from './token-vault';
import { fetchMetaPages, marketingVersion, graphVersion, redactMetaError } from './graph-api';

export interface MetaAdAccountDto {
    id: string; // e.g. 'act_123456789'
    account_id: string; // e.g. '123456789'
    name: string;
    account_status: number;
    currency: string;
}

export interface MetaCampaignDto {
    id: string;
    name: string;
    status: string;
    objective?: string;
    daily_budget?: string;
    lifetime_budget?: string;
    start_time?: string;
    stop_time?: string;
}

export interface MetaAdSetDto {
    id: string;
    name: string;
    campaign_id: string;
    status: string;
    daily_budget?: string;
    lifetime_budget?: string;
}

export interface MetaAdDto {
    id: string;
    name: string;
    campaign_id: string;
    adset_id: string;
    status: string;
    creative?: {
        id?: string;
        title?: string;
        body?: string;
    };
}

export interface MetaLeadFormDto {
    id: string;
    name: string;
    status?: string;
    questions?: Array<{ key: string; label: string; type: string }>;
}

export interface MetaInsightDto {
    date_start: string;
    date_stop: string;
    campaign_id?: string;
    adset_id?: string;
    ad_id?: string;
    spend: string;
    impressions: string;
    clicks: string;
    ctr?: string;
    cpc?: string;
    cpm?: string;
    actions?: Array<{
        action_type: string;
        value: string;
    }>;
    cost_per_action_type?: Array<{
        action_type: string;
        value: string;
    }>;
}

/**
 * Robust fetch wrapper with backoff for Meta Graph API rate limits
 */
export async function fetchWithBackoff(
    url: string,
    options: RequestInit = {},
    customFetch?: typeof fetch,
    maxRetries = 2,
    initialDelayMs = 1000,
): Promise<Response> {
    const fetchFn = customFetch || fetch;
    let attempt = 0;
    let delay = initialDelayMs;

    for (;;) {
        attempt++;
        try {
            const response = await fetchFn(url, {
                ...options,
                cache: 'no-store',
                signal: AbortSignal.timeout(15_000),
            });

            if (response.status === 429 && attempt <= maxRetries) {
                await new Promise((resolve) => setTimeout(resolve, delay));
                delay *= 2;
                continue;
            }

            if (!response.ok) {
                const text = await response.clone().text();
                if ((text.includes('"code":17') || text.includes('"code":613') || response.status === 429) && attempt <= maxRetries) {
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    delay *= 2;
                    continue;
                }
                if (text.includes('"code":190')) {
                    // Token expired - do not retry
                    return response;
                }
            }

            return response;
        } catch {
            if (attempt > maxRetries) throw new Error('META_REQUEST_FAILED');
            await new Promise((resolve) => setTimeout(resolve, delay));
            delay *= 2;
        }
    }
}

/**
 * Fetch ad accounts managed by the user
 */
export async function fetchUserAdAccounts(
    accessToken: string,
    customFetch?: typeof fetch,
): Promise<MetaAdAccountDto[]> {
    const url = new URL(`https://graph.facebook.com/${marketingVersion()}/me/adaccounts`);
    url.searchParams.set('fields', 'id,account_id,name,account_status,currency');
    url.searchParams.set('limit', '100');
    return fetchAllPages<MetaAdAccountDto>(url, accessToken, customFetch);
}

async function fetchAllPages<T>(url: URL, token: string, customFetch?: typeof fetch): Promise<T[]> {
    return fetchMetaPages<T>(url, token, (input, init) => fetchWithBackoff(String(input), init, customFetch));
}

/**
 * Sync Campaigns for an Ad Account
 */
export async function syncCampaignsForAccount(
    companyId: string,
    adAccountId: string,
    accessToken: string,
    customFetch?: typeof fetch,
): Promise<number> {
    const version = marketingVersion();
    const formattedId = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
    const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(formattedId)}/campaigns`);
    url.searchParams.set('fields', 'id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time');
    url.searchParams.set('limit', '50');

    const campaigns = await fetchAllPages<MetaCampaignDto>(url, accessToken, customFetch);
    if (campaigns.length === 0) return 0;

    const supabase = createAdminClient();
    const rows = campaigns.map((c) => ({
        company_id: companyId,
        ad_account_id: formattedId,
        meta_campaign_id: c.id,
        name: c.name || 'Chiến dịch không tên',
        status: (c.status || 'PAUSED').toUpperCase(),
        objective: c.objective || null,
        daily_budget: c.daily_budget ? Number(c.daily_budget) / 100 : null,
        lifetime_budget: c.lifetime_budget ? Number(c.lifetime_budget) / 100 : null,
        start_time: c.start_time || null,
        stop_time: c.stop_time || null,
        synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    }));

    const { error } = await supabase
        .from('meta_campaigns')
        .upsert(rows, { onConflict: 'company_id,meta_campaign_id' });

    if (error) {
        throw new Error('META_CAMPAIGNS_UPSERT_FAILED');
    }

    return campaigns.length;
}

/**
 * Sync Ad Sets for an Ad Account
 */
export async function syncAdSetsForAccount(
    companyId: string,
    adAccountId: string,
    accessToken: string,
    customFetch?: typeof fetch,
): Promise<number> {
    const version = marketingVersion();
    const formattedId = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
    const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(formattedId)}/adsets`);
    url.searchParams.set('fields', 'id,name,campaign_id,status,daily_budget,lifetime_budget');
    url.searchParams.set('limit', '50');

    const adSets = await fetchAllPages<MetaAdSetDto>(url, accessToken, customFetch);
    if (adSets.length === 0) return 0;

    const supabase = createAdminClient();
    const rows = adSets.map((s) => ({
        company_id: companyId,
        ad_account_id: formattedId,
        meta_campaign_id: s.campaign_id,
        meta_ad_set_id: s.id,
        name: s.name || 'Nhóm quảng cáo',
        status: (s.status || 'PAUSED').toUpperCase(),
        daily_budget: s.daily_budget ? Number(s.daily_budget) / 100 : null,
        lifetime_budget: s.lifetime_budget ? Number(s.lifetime_budget) / 100 : null,
        synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    }));

    const { error } = await supabase
        .from('meta_ad_sets')
        .upsert(rows, { onConflict: 'company_id,meta_ad_set_id' });

    if (error) {
        throw new Error('META_ADSETS_UPSERT_FAILED');
    }

    return adSets.length;
}

/**
 * Sync Ads for an Ad Account
 */
export async function syncAdsForAccount(
    companyId: string,
    adAccountId: string,
    accessToken: string,
    customFetch?: typeof fetch,
): Promise<number> {
    const version = marketingVersion();
    const formattedId = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
    const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(formattedId)}/ads`);
    url.searchParams.set('fields', 'id,name,campaign_id,adset_id,status,creative{id,title,body}');
    url.searchParams.set('limit', '50');

    const ads = await fetchAllPages<MetaAdDto>(url, accessToken, customFetch);
    if (ads.length === 0) return 0;

    const supabase = createAdminClient();
    const rows = ads.map((a) => ({
        company_id: companyId,
        ad_account_id: formattedId,
        meta_campaign_id: a.campaign_id,
        meta_ad_set_id: a.adset_id,
        meta_ad_id: a.id,
        name: a.name || 'Quảng cáo',
        status: (a.status || 'PAUSED').toUpperCase(),
        creative_id: a.creative?.id || null,
        creative_title: a.creative?.title || null,
        creative_body: a.creative?.body || null,
        synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    }));

    const { error } = await supabase
        .from('meta_ads')
        .upsert(rows, { onConflict: 'company_id,meta_ad_id' });

    if (error) {
        throw new Error('META_ADS_UPSERT_FAILED');
    }

    return ads.length;
}

/**
 * Sync Lead Forms for a Facebook Page
 */
export async function syncLeadFormsForPage(
    companyId: string,
    pageId: string,
    pageAccessToken: string,
    customFetch?: typeof fetch,
): Promise<number> {
    const version = graphVersion();
    const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(pageId)}/leadgen_forms`);
    url.searchParams.set('fields', 'id,name,status,questions');
    url.searchParams.set('limit', '50');

    const forms = await fetchAllPages<MetaLeadFormDto>(url, pageAccessToken, customFetch);
    if (forms.length === 0) return 0;

    const supabase = createAdminClient();
    const rows = forms.map((f) => ({
        company_id: companyId,
        page_id: pageId,
        meta_form_id: f.id,
        name: f.name || 'Biểu mẫu Lead Ads',
        status: f.status || 'ACTIVE',
        questions: f.questions || [],
        synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    }));

    const { error } = await supabase
        .from('meta_lead_forms')
        .upsert(rows, { onConflict: 'company_id,meta_form_id' });

    if (error) {
        throw new Error('META_LEAD_FORMS_UPSERT_FAILED');
    }

    return forms.length;
}

function extractLeadsCount(actions?: Array<{ action_type: string; value: string }>): number {
    if (!Array.isArray(actions)) return 0;
    for (const a of actions) {
        if (
            a.action_type === 'lead' ||
            a.action_type === 'onsite_conversion.lead_grouped' ||
            a.action_type === 'offsite_conversion.fb_pixel_lead'
        ) {
            return parseInt(a.value, 10) || 0;
        }
    }
    return 0;
}

/**
 * Sync Daily Insights for an Ad Account (Account level and Campaign level)
 */
export async function syncDailyInsightsForAccount(
    companyId: string,
    adAccountId: string,
    accessToken: string,
    customFetch?: typeof fetch,
    datePreset = 'last_30d',
): Promise<number> {
    const version = marketingVersion();
    const formattedId = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;

    // 1. Account-level daily insights
    const accountUrl = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(formattedId)}/insights`);
    accountUrl.searchParams.set('fields', 'spend,impressions,clicks,ctr,cpc,cpm,actions,cost_per_action_type');
    accountUrl.searchParams.set('time_increment', '1');
    accountUrl.searchParams.set('date_preset', datePreset);
    accountUrl.searchParams.set('limit', '100');

    const accountInsights = await fetchAllPages<MetaInsightDto>(accountUrl, accessToken, customFetch);

    // 2. Campaign-level daily insights
    const campaignUrl = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(formattedId)}/insights`);
    campaignUrl.searchParams.set('level', 'campaign');
    campaignUrl.searchParams.set('fields', 'campaign_id,spend,impressions,clicks,ctr,cpc,cpm,actions,cost_per_action_type');
    campaignUrl.searchParams.set('time_increment', '1');
    campaignUrl.searchParams.set('date_preset', datePreset);
    campaignUrl.searchParams.set('limit', '100');

    const campaignInsights = await fetchAllPages<MetaInsightDto>(campaignUrl, accessToken, customFetch);

    const rows: Array<Record<string, unknown>> = [];

    for (const item of accountInsights) {
        const metaLeads = extractLeadsCount(item.actions);
        const spend = Number(item.spend || 0);
        const cpl = metaLeads > 0 ? Math.round(spend / metaLeads) : 0;

        rows.push({
            company_id: companyId,
            ad_account_id: formattedId,
            entity_type: 'ACCOUNT',
            entity_id: formattedId,
            date: item.date_start,
            spend,
            impressions: Number(item.impressions || 0),
            clicks: Number(item.clicks || 0),
            ctr: Number(item.ctr || 0),
            cpc: Number(item.cpc || 0),
            cpm: Number(item.cpm || 0),
            meta_leads: metaLeads,
            cpl,
            synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        });
    }

    for (const item of campaignInsights) {
        if (!item.campaign_id) continue;
        const metaLeads = extractLeadsCount(item.actions);
        const spend = Number(item.spend || 0);
        const cpl = metaLeads > 0 ? Math.round(spend / metaLeads) : 0;

        rows.push({
            company_id: companyId,
            ad_account_id: formattedId,
            entity_type: 'CAMPAIGN',
            entity_id: item.campaign_id,
            date: item.date_start,
            spend,
            impressions: Number(item.impressions || 0),
            clicks: Number(item.clicks || 0),
            ctr: Number(item.ctr || 0),
            cpc: Number(item.cpc || 0),
            cpm: Number(item.cpm || 0),
            meta_leads: metaLeads,
            cpl,
            synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        });
    }

    if (rows.length === 0) return 0;

    const supabase = createAdminClient();
    const { error } = await supabase
        .from('meta_insights_daily')
        .upsert(rows, { onConflict: 'company_id,entity_type,entity_id,date' });

    if (error) {
        throw new Error('META_INSIGHTS_UPSERT_FAILED');
    }

    return rows.length;
}

/**
 * Validate token access to a specific Ad Account (Priority 4)
 */
export async function validateAdAccountAccess(
    adAccountId: string,
    accessToken: string,
    customFetch?: typeof fetch,
): Promise<{ valid: boolean; error?: string }> {
    const version = marketingVersion();
    const formattedId = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
    const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(formattedId)}`);
    url.searchParams.set('fields', 'id,account_status');

    const response = await fetchWithBackoff(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error' }, customFetch);
    if (!response.ok) {
        const text = await response.text();
        if (text.includes('"code":190')) {
            return { valid: false, error: 'TOKEN_EXPIRED' };
        }
        if (text.includes('"code":10') || text.includes('"code":200')) {
            return { valid: false, error: 'TOKEN_PERMISSION_DENIED' };
        }
        return { valid: false, error: `ACCOUNT_ACCESS_FAILED_${response.status}` };
    }
    return { valid: true };
}

/**
 * Master coordinator to sync all Meta Ads assets for a company
 */
export async function syncCompanyMetaAds(
    companyId: string,
    options: {
        token?: string;
        customFetch?: typeof fetch;
    } = {},
): Promise<{
    success: boolean;
    accountsSynced: number;
    accountsFailed: number;
    accountsSkipped: number;
    accountResults: Array<{ adAccountId: string; status: 'SUCCESS' | 'FAILED' | 'SKIPPED'; error?: string }>;
    campaignsCount: number;
    adSetsCount: number;
    adsCount: number;
    insightsCount: number;
    error?: string;
}> {
    const supabase = createAdminClient();
    const { data: accounts, error } = await supabase.from('meta_ad_accounts').select('*').eq('company_id', companyId);
    if (error) throw new Error('FAILED_TO_LOAD_AD_ACCOUNTS');
    const fallbackToken = options.token?.trim() || process.env.META_SYSTEM_USER_TOKEN?.trim();
    const accountResults: Array<{ adAccountId: string; status: 'SUCCESS' | 'FAILED' | 'SKIPPED'; error?: string }> = [];
    let campaignsCount = 0, adSetsCount = 0, adsCount = 0, insightsCount = 0;
    for (const acc of accounts || []) {
        if (acc.account_status != null && acc.account_status !== 1) {
            accountResults.push({ adAccountId: acc.ad_account_id, status: 'SKIPPED', error: 'AD_ACCOUNT_INACTIVE' });
            continue;
        }
        let token = fallbackToken;
        let leaseToken: string | undefined;
        try {
            const lease = await supabase.rpc('acquire_meta_ad_account_sync_lease', {
                p_company_id: companyId, p_ad_account_id: acc.ad_account_id, p_lease_duration_seconds: 300,
            });
            if (lease.error) throw new Error('SYNC_LEASE_ACQUISITION_FAILED');
            if (!lease.data) {
                accountResults.push({ adAccountId: acc.ad_account_id, status: 'SKIPPED', error: 'SYNC_LEASE_UNAVAILABLE' });
                continue;
            }
            leaseToken = lease.data;
            const stored = await supabase.rpc('get_meta_ad_account_token', {
                p_company_id: companyId, p_ad_account_id: acc.ad_account_id,
            });
            if (stored.error) throw new Error('TOKEN_RETRIEVAL_FAILED');
            if (stored.data?.[0]?.encrypted_access_token) token = decryptToken(stored.data[0].encrypted_access_token);
            if (!token) throw new Error('MISSING_ACCESS_TOKEN');
            const validation = await validateAdAccountAccess(acc.ad_account_id, token, options.customFetch);
            if (!validation.valid) throw new Error(validation.error || 'INVALID_AD_ACCOUNT_ACCESS');
            const c = await syncCampaignsForAccount(companyId, acc.ad_account_id, token, options.customFetch);
            const s = await syncAdSetsForAccount(companyId, acc.ad_account_id, token, options.customFetch);
            const a = await syncAdsForAccount(companyId, acc.ad_account_id, token, options.customFetch);
            const i = await syncDailyInsightsForAccount(companyId, acc.ad_account_id, token, options.customFetch);
            const released = await supabase.rpc('release_meta_ad_account_sync_lease', {
                p_company_id: companyId, p_ad_account_id: acc.ad_account_id, p_lease_token: leaseToken, p_status: 'SUCCESS',
            });
            if (released.error || released.data !== true) throw new Error('SYNC_LEASE_FINALIZATION_FAILED');
            campaignsCount += c; adSetsCount += s; adsCount += a; insightsCount += i;
            accountResults.push({ adAccountId: acc.ad_account_id, status: 'SUCCESS' });
        } catch (err) {
            const message = redactMetaError(err, [token || '', fallbackToken || '']).slice(0, 500);
            console.error('[meta-sync] sync_account_failed', message);
            let failure = message;
            if (leaseToken) {
                const released = await supabase.rpc('release_meta_ad_account_sync_lease', {
                    p_company_id: companyId, p_ad_account_id: acc.ad_account_id,
                    p_lease_token: leaseToken, p_status: 'FAILED', p_error: message,
                });
                if (released.error || released.data !== true) failure += ';SYNC_LEASE_FINALIZATION_FAILED';
            }
            accountResults.push({ adAccountId: acc.ad_account_id, status: 'FAILED', error: failure });
        }
    }
    const accountsSynced = accountResults.filter(a => a.status === 'SUCCESS').length;
    const accountsFailed = accountResults.filter(a => a.status === 'FAILED').length;
    const accountsSkipped = accountResults.filter(a => a.status === 'SKIPPED').length;
    return {
        success: accountsSynced > 0 && accountsFailed === 0 && accountsSkipped === 0,
        accountsSynced, accountsFailed, accountsSkipped, accountResults,
        campaignsCount, adSetsCount, adsCount, insightsCount,
        ...(accountsSynced === 0 && accountResults.length === 0 ? { error: 'NO_AD_ACCOUNTS' } : {}),
    };
}
