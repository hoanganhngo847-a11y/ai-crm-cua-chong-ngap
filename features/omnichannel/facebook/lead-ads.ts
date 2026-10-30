import 'server-only';

import {
    ChannelError,
    normalizePhone,
    type MetaLeadgenChange,
} from './core';
import type { PageBinding } from './binding';
import { rpc } from './server';
import { graphVersion } from './graph-api';

export interface MetaLeadData {
    id: string;
    created_time?: string;
    ad_id?: string;
    ad_name?: string;
    adset_id?: string;
    adset_name?: string;
    campaign_id?: string;
    campaign_name?: string;
    form_id?: string;
    form_name?: string;
    field_data?: Array<{
        name: string;
        values: string[];
    }>;
}

export interface IngestedLeadResult {
    leadgenId: string;
    customerId?: string;
    interactionId?: string;
    touchpointId?: string;
    status: 'PROCESSED' | 'EXISTING' | 'FAILED';
    error?: string;
}

/**
 * Fetch lead details from Meta Graph API
 */
export async function fetchMetaLeadDetails(
    leadgenId: string,
    pageAccessToken: string,
    fetchDouble?: typeof fetch,
): Promise<MetaLeadData> {
    const fetchFn = fetchDouble || fetch;
    const version = graphVersion();
    const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(leadgenId)}`);
    url.searchParams.set(
        'fields',
        'id,created_time,form_id,field_data',
    );


    const response = await fetchFn(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${pageAccessToken}` },
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
        console.error(`[lead-ads] fetch_failed status=${response.status}`);
        throw new ChannelError('LEAD_RETRIEVAL_FAILED', response.status === 429 ? 429 : 503);
    }

    const payload = (await response.json()) as MetaLeadData;
    return payload;
}

/**
 * Normalize and extract fields from Lead Ads field_data
 */
export function extractLeadFields(fieldData: Array<{ name: string; values: string[] }> = []) {
    let rawPhone: string | null = null;
    let normalizedPhone: string | null = null;
    let fullName: string | null = null;
    let email: string | null = null;
    let city: string | null = null;
    const otherAnswers: Array<{ label: string; value: string }> = [];

    for (const field of fieldData) {
        const name = (field.name || '').toLowerCase().trim();
        const value = Array.isArray(field.values) && field.values.length > 0 ? String(field.values[0] || '').trim() : '';
        if (!value) continue;

        if (name === 'phone_number' || name === 'phone' || name.includes('phone') || name.includes('so_dien_thoai') || name.includes('sdt')) {
            rawPhone = value;
            try {
                normalizedPhone = normalizePhone(value);
            } catch {
                // Invalid phone candidate
            }
        } else if (name === 'full_name' || name === 'name' || name === 'ho_va_ten' || name === 'ho_ten') {
            fullName = value;
        } else if (name === 'email' || name.includes('email')) {
            email = value;
        } else if (name === 'city' || name === 'thanh_pho' || name.includes('city')) {
            city = value;
        } else {
            otherAnswers.push({ label: field.name, value });
        }
    }

    return {
        rawPhone,
        normalizedPhone,
        fullName,
        email,
        city,
        otherAnswers,
    };
}

/**
 * Format lead form answers into a readable safe note (without exposing raw phone)
 */
export function formatLeadAdsSafeContent(
    leadData: MetaLeadData,
    fields: ReturnType<typeof extractLeadFields>,
): string {
    const lines: string[] = ['[Facebook Lead Ads - Biểu mẫu tức thì]'];

    if (fields.fullName) lines.push(`Họ tên: ${fields.fullName}`);
    if (fields.email) lines.push(`Email: [email đã ẩn]`);
    if (fields.rawPhone) lines.push(`SĐT: [số liên hệ đã ẩn]`);
    if (fields.city) lines.push(`Tỉnh/Thành: ${fields.city}`);

    if (leadData.campaign_name) lines.push(`Chiến dịch: ${leadData.campaign_name}`);
    if (leadData.ad_name) lines.push(`Quảng cáo: ${leadData.ad_name}`);

    for (const item of fields.otherAnswers) {
        lines.push(`${item.label}: ${item.value}`);
    }

    return lines.join('\n').slice(0, 5000);
}

/**
 * Ingest a Meta Lead Ads event into CRM with attribution touchpoint
 */
export async function processLeadAdsChange(
    config: PageBinding,
    change: MetaLeadgenChange,
    customFetch?: typeof fetch,
): Promise<IngestedLeadResult> {
    const token = process.env[config.tokenEnv]?.trim();
    if (!token) {
        console.error(`[lead-ads] missing_token_env env=${config.tokenEnv} page=${config.page}`);
        throw new ChannelError('CHANNEL_NOT_CONFIGURED', 503);
    }

    const claim = await rpc('claim_meta_leadgen_event', {
        p_company_id: config.company, p_page_id: config.page, p_leadgen_id: change.leadgenId,
        p_form_id: change.formId || null, p_ad_id: change.adId || null, p_occurred: change.time,
    }) as { status?: string; claim_token?: string; occurred_at?: string; ingest_args?: { lead_data?: MetaLeadData } } | null;
    if (claim?.status === 'ALREADY_PROCESSED') return { leadgenId: change.leadgenId, status: 'EXISTING' };
    if (claim?.status !== 'CLAIMED' || !claim.claim_token) throw new ChannelError('LEADGEN_CLAIM_UNAVAILABLE', 503);
    const claimToken = claim.claim_token;
    const finalize = (status: 'PROCESSED' | 'FAILED', error?: string) => rpc('finalize_meta_leadgen_event', {
        p_company_id: config.company, p_leadgen_id: change.leadgenId,
        p_claim_token: claimToken, p_status: status, p_error: error || null,
    });
    try {
        // Reuse the immutable persisted response after partial intake. Changes to
        // the form/lead in Meta cannot alter han_ingest's idempotency payload.
        const leadData = claim.ingest_args?.lead_data || await fetchMetaLeadDetails(change.leadgenId, token, customFetch);
        const fields = extractLeadFields(leadData.field_data || []);
        const adId = leadData.ad_id || change.adId || null;
        const formId = leadData.form_id || change.formId || null;
        const campaignId = leadData.campaign_id || null;
        const adsetId = leadData.adset_id || change.adgroupId || null;
        const ingest = await rpc('ingest_meta_leadgen_event', {
            p_company_id: config.company, p_leadgen_id: change.leadgenId, p_claim_token: claimToken,
            p_ingest: {
                name: (fields.fullName || 'Khách Lead Ads').slice(0, 100), phone: fields.normalizedPhone,
                content: formatLeadAdsSafeContent(leadData, fields), lead_data: leadData,
                payload: { ...change.raw, leadgen_id: change.leadgenId, form_id: formId, ad_id: adId,
                    campaign_id: campaignId, crm_lead_ads: true, field_data_keys: (leadData.field_data || []).map(f => f.name) },
            },
        }) as { interaction_id?: string; customer_id?: string } | null;
        if (!ingest?.interaction_id || !ingest.customer_id) throw new ChannelError('LEADGEN_INTAKE_INCOMPLETE', 503);
        const touchpointId = await rpc('record_lead_attribution_touchpoint', {
            p_company: config.company, p_customer: ingest.customer_id, p_interaction: ingest.interaction_id,
            p_channel: 'FACEBOOK_LEAD_ADS', p_page_id: config.page, p_page_name: config.name || null,
            p_meta_campaign_id: campaignId, p_campaign_name: leadData.campaign_name || null,
            p_meta_ad_set_id: adsetId, p_ad_set_name: leadData.adset_name || null,
            p_meta_ad_id: adId, p_ad_name: leadData.ad_name || null, p_meta_form_id: formId,
            p_form_name: leadData.form_name || null, p_meta_leadgen_id: change.leadgenId,
            p_referral_source: 'LEAD_ADS', p_referral_type: 'INSTANT_FORM',
            p_attribution_status: 'UNATTRIBUTED', p_attribution_method: 'DIRECT_LEADGEN',
            p_occurred: claim.occurred_at || change.time,
        });
        if (typeof touchpointId !== 'string' || !touchpointId) throw new ChannelError('LEADGEN_ATTRIBUTION_INCOMPLETE', 503);
        if (await finalize('PROCESSED') !== true) throw new ChannelError('LEADGEN_FINALIZATION_FAILED', 503);
        return { leadgenId: change.leadgenId, customerId: ingest.customer_id, interactionId: ingest.interaction_id,
            touchpointId, status: 'PROCESSED' };
    } catch {
        // Failure acknowledgement must stay retryable even if the DB is down.
        // A lost lease is reclaimed after expiry and stale tokens cannot finalize.
        try { await finalize('FAILED', 'LEADGEN_PROCESSING_FAILED'); } catch { /* Retry via lease expiry. */ }
        throw new ChannelError('LEADGEN_PROCESSING_FAILED', 503);
    }
}
