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
}

export interface MetaAdDto {
    id: string;
    name: string;
    campaign_id: string;
    status: string;
}

export interface MetaLeadFormDto {
    id: string;
    name: string;
    status?: string;
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
    url.searchParams.set('fields', 'id,name,status');
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
    url.searchParams.set('fields', 'id,name,campaign_id,status');
    url.searchParams.set('limit', '50');

    const ads = await fetchAllPages<MetaAdDto>(url, accessToken, customFetch);
    if (ads.length === 0) return 0;

    const supabase = createAdminClient();
    const rows = ads.map((a) => ({
        company_id: companyId,
        ad_account_id: formattedId,
        meta_campaign_id: a.campaign_id,
        meta_ad_id: a.id,
        name: a.name || 'Quảng cáo',
        status: (a.status || 'PAUSED').toUpperCase(),
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
    url.searchParams.set('fields', 'id,name,status');
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
 * Sync only campaign identity and ad-to-campaign mappings for lead attribution
 */
export async function syncCompanyMetaAttribution(
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
    adsCount: number;
    error?: string;
}> {
    const supabase = createAdminClient();
    const { data: accounts, error } = await supabase.from('meta_ad_accounts').select('*').eq('company_id', companyId);
    if (error) throw new Error('FAILED_TO_LOAD_AD_ACCOUNTS');
    const fallbackToken = options.token?.trim() || process.env.META_SYSTEM_USER_TOKEN?.trim();
    const accountResults: Array<{ adAccountId: string; status: 'SUCCESS' | 'FAILED' | 'SKIPPED'; error?: string }> = [];
    let campaignsCount = 0, adsCount = 0;
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
            const tokenRecord = stored.data?.[0];
            if (tokenRecord?.token_expires_at) {
                const expiresAtMs = new Date(tokenRecord.token_expires_at).getTime();
                if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
                    throw new Error('TOKEN_EXPIRED');
                }
            }
            if (tokenRecord?.encrypted_access_token) token = decryptToken(tokenRecord.encrypted_access_token);
            if (!token) throw new Error('MISSING_ACCESS_TOKEN');
            const validation = await validateAdAccountAccess(acc.ad_account_id, token, options.customFetch);
            if (!validation.valid) throw new Error(validation.error || 'INVALID_AD_ACCOUNT_ACCESS');
            const c = await syncCampaignsForAccount(companyId, acc.ad_account_id, token, options.customFetch);
            const a = await syncAdsForAccount(companyId, acc.ad_account_id, token, options.customFetch);
            const released = await supabase.rpc('release_meta_ad_account_sync_lease', {
                p_company_id: companyId, p_ad_account_id: acc.ad_account_id, p_lease_token: leaseToken, p_status: 'SUCCESS',
            });
            if (released.error || released.data !== true) throw new Error('SYNC_LEASE_FINALIZATION_FAILED');
            campaignsCount += c; adsCount += a;
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
        campaignsCount, adsCount,
        ...(accountsSynced === 0 && accountResults.length === 0 ? { error: 'NO_AD_ACCOUNTS' } : {}),
    };
}
