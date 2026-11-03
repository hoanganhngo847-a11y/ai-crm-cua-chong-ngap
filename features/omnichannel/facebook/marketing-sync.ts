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


export type MetaCreativeCaptureTiming = 'AT_LEAD_INTAKE' | 'BACKFILL';

export interface MetaAdCreativeAssetSnapshot {
    kind: 'IMAGE' | 'VIDEO';
    imageUrl?: string;
    thumbnailUrl?: string;
    videoId?: string;
    title?: string;
    description?: string;
    primaryText?: string;
    destinationUrl?: string;
}

export interface MetaAdCreativeSnapshot {
    schemaVersion: 1;
    status: 'AVAILABLE' | 'PARTIAL' | 'PENDING_SYNC' | 'UNAVAILABLE';
    source: 'META_MARKETING_API' | 'NONE';
    capturedAt: string;
    captureTiming: MetaCreativeCaptureTiming;
    reason?: string;
    adId: string;
    adName?: string;
    campaignId?: string;
    campaignName?: string;
    adsetId?: string;
    adsetName?: string;
    creativeId?: string;
    creativeName?: string;
    storyId?: string;
    format: 'IMAGE' | 'VIDEO' | 'CAROUSEL' | 'DYNAMIC' | 'UNKNOWN';
    primaryText?: string;
    headlines: string[];
    descriptions: string[];
    ctaType?: string;
    destinationUrl?: string;
    imageUrl?: string;
    thumbnailUrl?: string;
    videoId?: string;
    carouselAssets: MetaAdCreativeAssetSnapshot[];
    imageAssets: MetaAdCreativeAssetSnapshot[];
    videoAssets: MetaAdCreativeAssetSnapshot[];
}

function metaRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function metaText(value: unknown, maxLength = 4000): string | undefined {
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    const text = String(value).trim();
    return text ? text.slice(0, maxLength) : undefined;
}

function safeMetaAssetUrl(value: unknown): string | undefined {
    const raw = metaText(value, 2048);
    if (!raw) return undefined;
    try {
        const url = new URL(raw);
        const host = url.hostname.toLowerCase();
        const allowedHost =
            host === 'fbcdn.net' || host.endsWith('.fbcdn.net') ||
            host === 'fbsbx.com' || host.endsWith('.fbsbx.com') ||
            host === 'facebook.com' || host.endsWith('.facebook.com');
        if (url.protocol !== 'https:' || !allowedHost || url.username || url.password) return undefined;
        return url.toString();
    } catch {
        return undefined;
    }
}

function safeMetaDestinationUrl(value: unknown): string | undefined {
    const raw = metaText(value, 2048);
    if (!raw) return undefined;
    try {
        const url = new URL(raw);
        if (url.protocol !== 'https:' || url.username || url.password) return undefined;
        return url.toString();
    } catch {
        return undefined;
    }
}

function metaTextVariants(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const values = value.slice(0, 8)
        .map((item) => metaText(metaRecord(item).text ?? item, 3000))
        .filter((item): item is string => Boolean(item));
    return [...new Set(values)];
}

function uniqueMetaStrings(values: Array<string | undefined>): string[] {
    return [...new Set(values.filter((value): value is string => Boolean(value)))].slice(0, 8);
}

/**
 * Normalize the read-only Marketing API Ad/AdCreative response. Dynamic
 * creative variants remain separate arrays: we never invent pairings between
 * bodies, headlines, descriptions, images, videos or carousel assets.
 */
export function normalizeMetaAdCreativeSnapshot(
    payload: unknown,
    options: { capturedAt?: string; captureTiming?: MetaCreativeCaptureTiming } = {},
): MetaAdCreativeSnapshot {
    const ad = metaRecord(payload);
    const creative = metaRecord(ad.creative);
    const story = metaRecord(creative.object_story_spec);
    const linkData = metaRecord(story.link_data);
    const videoData = metaRecord(story.video_data);
    const templateData = metaRecord(story.template_data);
    const linkCta = metaRecord(linkData.call_to_action);
    const videoCta = metaRecord(videoData.call_to_action);
    const linkCtaValue = metaRecord(linkCta.value);
    const videoCtaValue = metaRecord(videoCta.value);
    const assetFeed = metaRecord(creative.asset_feed_spec);
    const feedBodies = metaTextVariants(assetFeed.bodies);
    const feedTitles = metaTextVariants(assetFeed.titles);
    const feedDescriptions = metaTextVariants(assetFeed.descriptions);

    const imageAssets: MetaAdCreativeAssetSnapshot[] = (Array.isArray(assetFeed.images) ? assetFeed.images : [])
        .slice(0, 8)
        .map((item) => {
            const entry = metaRecord(item);
            const imageUrl = safeMetaAssetUrl(entry.url) || safeMetaAssetUrl(entry.url_128) || safeMetaAssetUrl(entry.url_256);
            return imageUrl ? { kind: 'IMAGE' as const, imageUrl } : null;
        })
        .filter((item) => item !== null) as MetaAdCreativeAssetSnapshot[];

    const videoAssets: MetaAdCreativeAssetSnapshot[] = (Array.isArray(assetFeed.videos) ? assetFeed.videos : [])
        .slice(0, 8)
        .map((item) => {
            const entry = metaRecord(item);
            const videoId = metaText(entry.video_id, 128);
            const thumbnailUrl = safeMetaAssetUrl(entry.thumbnail_url);
            return videoId || thumbnailUrl
                ? { kind: 'VIDEO' as const, ...(videoId ? { videoId } : {}), ...(thumbnailUrl ? { thumbnailUrl } : {}) }
                : null;
        })
        .filter((item) => item !== null) as MetaAdCreativeAssetSnapshot[];

    const childAttachments = Array.isArray(linkData.child_attachments) ? linkData.child_attachments : [];
    const carouselAssets: MetaAdCreativeAssetSnapshot[] = childAttachments.slice(0, 10)
        .map((item) => {
            const entry = metaRecord(item);
            const cta = metaRecord(entry.call_to_action);
            const ctaValue = metaRecord(cta.value);
            const imageUrl = safeMetaAssetUrl(entry.picture) || safeMetaAssetUrl(entry.image_url);
            const videoId = metaText(entry.video_id, 128);
            const title = metaText(entry.name, 500);
            const description = metaText(entry.description, 1000);
            const destinationUrl = safeMetaDestinationUrl(entry.link) || safeMetaDestinationUrl(ctaValue.link);
            if (!imageUrl && !videoId && !title && !description) return null;
            return {
                kind: videoId ? 'VIDEO' as const : 'IMAGE' as const,
                ...(imageUrl ? { imageUrl } : {}),
                ...(videoId ? { videoId } : {}),
                ...(title ? { title } : {}),
                ...(description ? { description } : {}),
                ...(destinationUrl ? { destinationUrl } : {}),
            };
        })
        .filter((item) => item !== null) as MetaAdCreativeAssetSnapshot[];

    const primaryText =
        metaText(linkData.message, 5000) ||
        metaText(videoData.message, 5000) ||
        metaText(templateData.message, 5000) ||
        feedBodies[0];

    const headlines = uniqueMetaStrings([
        metaText(linkData.name, 500),
        metaText(videoData.title, 500),
        metaText(templateData.name, 500),
        ...feedTitles,
    ]);
    const descriptions = uniqueMetaStrings([
        metaText(linkData.description, 1000),
        metaText(videoData.description, 1000),
        ...feedDescriptions,
    ]);

    const firstFeedLink = Array.isArray(assetFeed.link_urls) ? metaRecord(assetFeed.link_urls[0]) : {};
    const firstFeedCta = Array.isArray(assetFeed.call_to_action_types) ? metaRecord(assetFeed.call_to_action_types[0]) : {};
    const imageUrl =
        safeMetaAssetUrl(creative.image_url) ||
        safeMetaAssetUrl(linkData.picture) ||
        safeMetaAssetUrl(videoData.image_url) ||
        imageAssets[0]?.imageUrl ||
        carouselAssets[0]?.imageUrl;
    const videoId =
        metaText(creative.video_id, 128) ||
        metaText(videoData.video_id, 128) ||
        videoAssets[0]?.videoId;
    const thumbnailUrl =
        safeMetaAssetUrl(creative.thumbnail_url) ||
        safeMetaAssetUrl(videoData.image_url) ||
        videoAssets[0]?.thumbnailUrl ||
        (videoId ? imageUrl : undefined);
    const destinationUrl =
        safeMetaDestinationUrl(linkData.link) ||
        safeMetaDestinationUrl(linkCtaValue.link) ||
        safeMetaDestinationUrl(videoCtaValue.link) ||
        safeMetaDestinationUrl(firstFeedLink.website_url) ||
        safeMetaDestinationUrl(firstFeedLink.url);
    const ctaType =
        metaText(linkCta.type, 100) ||
        metaText(videoCta.type, 100) ||
        metaText(firstFeedCta.type, 100) ||
        metaText(creative.call_to_action_type, 100);

    const hasCreative = Object.keys(creative).length > 0;
    const hasDisplayContent = Boolean(
        primaryText || headlines.length || descriptions.length || imageUrl || videoId ||
        carouselAssets.length || imageAssets.length || videoAssets.length
    );
    const format: MetaAdCreativeSnapshot['format'] =
        carouselAssets.length > 1 ? 'CAROUSEL' :
        Object.keys(assetFeed).length > 0 ? 'DYNAMIC' :
        videoId ? 'VIDEO' :
        imageUrl ? 'IMAGE' : 'UNKNOWN';

    return {
        schemaVersion: 1,
        status: !hasCreative ? 'UNAVAILABLE' : hasDisplayContent ? 'AVAILABLE' : 'PARTIAL',
        source: hasCreative ? 'META_MARKETING_API' : 'NONE',
        capturedAt: options.capturedAt || new Date().toISOString(),
        captureTiming: options.captureTiming || 'AT_LEAD_INTAKE',
        ...(!hasCreative ? { reason: 'CREATIVE_DETAILS_UNAVAILABLE' } : {}),
        adId: metaText(ad.id, 128) || '',
        ...(metaText(ad.name, 500) ? { adName: metaText(ad.name, 500) } : {}),
        ...(metaText(metaRecord(ad.campaign).id ?? ad.campaign_id, 128) ? { campaignId: metaText(metaRecord(ad.campaign).id ?? ad.campaign_id, 128) } : {}),
        ...(metaText(metaRecord(ad.campaign).name, 500) ? { campaignName: metaText(metaRecord(ad.campaign).name, 500) } : {}),
        ...(metaText(metaRecord(ad.adset).id ?? ad.adset_id, 128) ? { adsetId: metaText(metaRecord(ad.adset).id ?? ad.adset_id, 128) } : {}),
        ...(metaText(metaRecord(ad.adset).name, 500) ? { adsetName: metaText(metaRecord(ad.adset).name, 500) } : {}),
        ...(metaText(creative.id, 128) ? { creativeId: metaText(creative.id, 128) } : {}),
        ...(metaText(creative.name, 500) ? { creativeName: metaText(creative.name, 500) } : {}),
        ...(metaText(creative.effective_object_story_id ?? creative.object_story_id, 160) ? { storyId: metaText(creative.effective_object_story_id ?? creative.object_story_id, 160) } : {}),
        format,
        ...(primaryText ? { primaryText } : {}),
        headlines,
        descriptions,
        ...(ctaType ? { ctaType } : {}),
        ...(destinationUrl ? { destinationUrl } : {}),
        ...(imageUrl ? { imageUrl } : {}),
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
        ...(videoId ? { videoId } : {}),
        carouselAssets,
        imageAssets,
        videoAssets,
    };
}

function emptyMetaCreativeSnapshot(
    adId: string,
    status: 'PENDING_SYNC' | 'UNAVAILABLE',
    reason: string,
    captureTiming: MetaCreativeCaptureTiming,
): MetaAdCreativeSnapshot {
    return {
        schemaVersion: 1,
        status,
        source: 'NONE',
        capturedAt: new Date().toISOString(),
        captureTiming,
        reason,
        adId,
        format: 'UNKNOWN',
        headlines: [],
        descriptions: [],
        carouselAssets: [],
        imageAssets: [],
        videoAssets: [],
    };
}

/**
 * Fetch one ad's actual creative through the read-only Marketing API. This is
 * deliberately best-effort: missing mappings, expired tokens, permissions or
 * deleted assets never block durable Lead Ads intake.
 */
export async function fetchMetaAdCreativeSnapshot(
    companyId: string,
    adId: string,
    options: { customFetch?: typeof fetch; captureTiming?: MetaCreativeCaptureTiming; timeoutMs?: number } = {},
): Promise<MetaAdCreativeSnapshot> {
    const captureTiming = options.captureTiming || 'AT_LEAD_INTAKE';
    const pending = (reason: string) => emptyMetaCreativeSnapshot(adId, 'PENDING_SYNC', reason, captureTiming);

    try {
        const supabase = createAdminClient();
        const { data: ad, error: adError } = await supabase
            .from('meta_ads')
            .select('ad_account_id')
            .eq('company_id', companyId)
            .eq('meta_ad_id', adId)
            .maybeSingle();

        if (adError) return pending('AD_LOOKUP_FAILED');
        if (!ad?.ad_account_id) return pending('AD_NOT_SYNCED');

        const stored = await supabase.rpc('get_meta_ad_account_token', {
            p_company_id: companyId,
            p_ad_account_id: ad.ad_account_id,
        });
        if (stored.error) return pending('TOKEN_LOOKUP_FAILED');
        const tokenRecord = Array.isArray(stored.data) ? stored.data[0] : stored.data;
        if (!tokenRecord || typeof tokenRecord.encrypted_access_token !== 'string') return pending('TOKEN_UNAVAILABLE');
        if (tokenRecord.token_expires_at) {
            const expiresAt = new Date(tokenRecord.token_expires_at).getTime();
            if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return pending('TOKEN_EXPIRED');
        }

        let accessToken: string;
        try {
            accessToken = decryptToken(tokenRecord.encrypted_access_token);
        } catch {
            return pending('TOKEN_DECRYPTION_FAILED');
        }

        const version = marketingVersion();
        const fieldSets = [
            'id,name,campaign{id,name},adset{id,name},creative{id,name,object_type,object_story_spec,asset_feed_spec,image_url,thumbnail_url,video_id,effective_object_story_id,object_story_id,call_to_action_type}',
            'id,name,campaign{id,name},adset{id,name},creative{id,name,object_type,image_url,thumbnail_url,video_id}',
        ];
        let response: Response | null = null;
        const fetchFn = options.customFetch || fetch;
        const timeoutMs = Math.max(1000, Math.min(options.timeoutMs ?? 6000, 15000));
        for (let index = 0; index < fieldSets.length; index++) {
            const url = new URL('https://graph.facebook.com/' + version + '/' + encodeURIComponent(adId));
            url.searchParams.set('fields', fieldSets[index]);
            response = await fetchFn(url.toString(), {
                method: 'GET',
                headers: { Authorization: 'Bearer ' + accessToken },
                redirect: 'error',
                cache: 'no-store',
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (response.ok || response.status !== 400 || index === fieldSets.length - 1) break;
        }

        if (!response?.ok) {
            const status = response?.status || 0;
            if (status === 429 || status === 0 || status >= 500) return pending('META_TEMPORARY_FAILURE');
            if (status === 400 || status === 401 || status === 403 || status === 404) {
                return emptyMetaCreativeSnapshot(adId, 'UNAVAILABLE', 'META_PERMISSION_OR_CREATIVE_UNAVAILABLE', captureTiming);
            }
            return pending('META_CREATIVE_LOOKUP_FAILED');
        }

        let payload: unknown;
        try {
            payload = await response.json();
        } catch {
            return pending('META_INVALID_RESPONSE');
        }
        const snapshot = normalizeMetaAdCreativeSnapshot(payload, { captureTiming });
        return snapshot.status === 'UNAVAILABLE'
            ? { ...snapshot, adId: snapshot.adId || adId, reason: 'META_CREATIVE_NOT_AVAILABLE' }
            : { ...snapshot, adId: snapshot.adId || adId };
    } catch {
        return pending('META_CREATIVE_LOOKUP_FAILED');
    }
}

export interface MetaCreativeSnapshotSyncSummary {
    scanned: number;
    updated: number;
    pending: number;
    unavailable: number;
    failed: number;
}

/**
 * Backfill only missing/pending creative snapshots on existing Lead Ads
 * touchpoints. Once a usable or terminal snapshot is stored, it is never
 * overwritten by later edits to the source ad.
 */
export async function syncPendingCreativeSnapshots(
    companyId: string,
    options: { customFetch?: typeof fetch; limit?: number; timeoutMs?: number } = {},
): Promise<MetaCreativeSnapshotSyncSummary> {
    const supabase = createAdminClient();
    const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
    const scanLimit = Math.max(100, limit * 10);
    const { data: rows, error } = await supabase
        .from('lead_attribution_touchpoints')
        .select('id,meta_ad_id,ads_context_data')
        .eq('company_id', companyId)
        .eq('channel', 'FACEBOOK_LEAD_ADS')
        .not('meta_ad_id', 'is', null)
        .or('ads_context_data->creative_snapshot->>status.eq.PENDING_SYNC,ads_context_data->creative_snapshot.is.null')
        .order('occurred_at', { ascending: false })
        .limit(scanLimit);

    if (error) throw new Error('CREATIVE_SNAPSHOT_BACKFILL_QUERY_FAILED');

    const candidates = (rows || []).filter((row) => {
        const existing = metaRecord(metaRecord(row.ads_context_data).creative_snapshot);
        if (Object.keys(existing).length === 0) return true;
        return existing.status === 'PENDING_SYNC';
    }).slice(0, limit);

    const cache = new Map<string, MetaAdCreativeSnapshot>();
    let updated = 0;
    let pending = 0;
    let unavailable = 0;
    let failed = 0;

    for (const row of candidates) {
        const adId = metaText(row.meta_ad_id, 128);
        if (!adId) continue;
        let snapshot = cache.get(adId);
        if (!snapshot) {
            snapshot = await fetchMetaAdCreativeSnapshot(companyId, adId, {
                customFetch: options.customFetch,
                captureTiming: 'BACKFILL',
                timeoutMs: options.timeoutMs ?? 8000,
            });
            cache.set(adId, snapshot);
        }

        if (snapshot.status === 'PENDING_SYNC') {
            pending++;
            continue;
        }

        const currentContext = metaRecord(row.ads_context_data);
        const currentSnapshot = metaRecord(currentContext.creative_snapshot);
        if (currentSnapshot.status && currentSnapshot.status !== 'PENDING_SYNC') continue;

        const { error: updateError } = await supabase
            .from('lead_attribution_touchpoints')
            .update({ ads_context_data: { ...currentContext, creative_snapshot: snapshot } })
            .eq('id', row.id)
            .eq('company_id', companyId)
            .eq('channel', 'FACEBOOK_LEAD_ADS')
            .eq('meta_ad_id', adId);

        if (updateError) {
            failed++;
            continue;
        }
        updated++;
        if (snapshot.status === 'UNAVAILABLE') unavailable++;
    }

    return { scanned: candidates.length, updated, pending, unavailable, failed };
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
    creativeSnapshotSync: MetaCreativeSnapshotSyncSummary;
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
    let creativeSnapshotSync: MetaCreativeSnapshotSyncSummary = { scanned: 0, updated: 0, pending: 0, unavailable: 0, failed: 0 };
    try {
        creativeSnapshotSync = await syncPendingCreativeSnapshots(companyId, { customFetch: options.customFetch, limit: 25 });
    } catch {
        creativeSnapshotSync.failed = 1;
    }
    return {
        success: accountsSynced > 0 && accountsFailed === 0 && accountsSkipped === 0,
        creativeSnapshotSync,
        accountsSynced, accountsFailed, accountsSkipped, accountResults,
        campaignsCount, adsCount,
        ...(accountsSynced === 0 && accountResults.length === 0 ? { error: 'NO_AD_ACCOUNTS' } : {}),
    };
}
