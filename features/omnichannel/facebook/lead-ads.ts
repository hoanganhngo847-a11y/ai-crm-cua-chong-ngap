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
 * Fetch lead details from Meta Graph API.
 *
 * Extended attribution fields (campaign/ad/adset identifiers and names) are
 * requested with the SAME single call used for the field data. If the page
 * token lacks the permission for those fields (they are optional attributes),
 * the original minimal field set is retried once so a valid lead is never
 * destroyed by a permission gap: pending campaign state is handled downstream.
 */
const LEAD_FIELDS_FULL =
    'id,created_time,form_id,form_name,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,field_data';
const LEAD_FIELDS_MINIMAL = 'id,created_time,form_id,field_data';

export async function fetchMetaLeadDetails(
    leadgenId: string,
    pageAccessToken: string,
    fetchDouble?: typeof fetch,
): Promise<MetaLeadData> {
    const fetchFn = fetchDouble || fetch;
    const version = graphVersion();
    let fields = LEAD_FIELDS_FULL;

    for (;;) {
        const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(leadgenId)}`);
        url.searchParams.set('fields', fields);

        const response = await fetchFn(url.toString(), {
            method: 'GET',
            headers: { Authorization: `Bearer ${pageAccessToken}` },
            redirect: 'error',
            cache: 'no-store',
            signal: AbortSignal.timeout(10_000),
        });

        if (response.ok) {
            return (await response.json()) as MetaLeadData;
        }
        if (fields !== LEAD_FIELDS_MINIMAL && response.status === 400) {
            // Extended attribution fields may require permissions the current
            // token lacks. Fall back once to the minimal set so a valid lead is
            // never destroyed by a permission gap; campaign state stays pending.
            console.warn('[lead-ads] extended_fields_unavailable falling_back status=400');
            fields = LEAD_FIELDS_MINIMAL;
            continue;
        }
        console.error(`[lead-ads] fetch_failed status=${response.status}`);
        throw new ChannelError('LEAD_RETRIEVAL_FAILED', response.status === 429 ? 429 : 503);
    }
}

/**
 * Normalize and extract fields from Lead Ads field_data.
 *
 * phoneStatus reports whether the form carried a usable canonical phone:
 * 'VALID' (normalized), 'INVALID' (a phone field existed but failed
 * normalization) or 'MISSING' (no phone field). Invalid and missing phones are
 * preserved for review downstream; the raw value itself never leaves these
 * production modules and is masked in every customer-visible representation.
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
                // Invalid phone candidate: preserved for review, never used for identity.
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

    const phoneStatus: 'VALID' | 'INVALID' | 'MISSING' =
        normalizedPhone !== null ? 'VALID' : rawPhone !== null ? 'INVALID' : 'MISSING';

    return {
        rawPhone,
        normalizedPhone,
        phoneStatus,
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
                    campaign_id: campaignId, crm_lead_ads: true, field_data_keys: (leadData.field_data || []).map(f => f.name),
                    crm_phone_detection: { status: fields.phoneStatus } },
            },
        }) as { interaction_id?: string; customer_id?: string;
            phone_match_status?: string; is_duplicate_phone?: boolean } | null;
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
        // Persist the phone match verdict on the attribution event so the customer
        // history can show every submission, including duplicate-phone indicators.
        // Idempotent across webhook retries: the durable event replay yields the
        // exact same verdict recorded at first admission.
        await rpc('mark_lead_attribution_phone_match', {
            p_company: config.company, p_meta_leadgen_id: change.leadgenId,
            p_phone_match_status: typeof ingest.phone_match_status === 'string' && ingest.phone_match_status
                ? ingest.phone_match_status : 'NO_PHONE',
            p_is_duplicate_phone: typeof ingest.is_duplicate_phone === 'boolean' ? ingest.is_duplicate_phone : null,
        });
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
