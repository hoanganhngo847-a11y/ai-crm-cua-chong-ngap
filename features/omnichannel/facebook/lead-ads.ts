import 'server-only';

import {
    ChannelError,
    normalizePhone,
    type MetaLeadgenChange,
} from './core';
import type { PageBinding } from './binding';
import { rpc } from './server';
import { createAdminClient } from '@/lib/supabase/admin';

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

function graphVersion(): string {
    const v = process.env.META_GRAPH_VERSION?.trim();
    if (v && /^v\d+\.\d+$/.test(v)) return v;
    return 'v21.0';
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
        'id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,field_data',
    );
    url.searchParams.set('access_token', pageAccessToken);

    const response = await fetchFn(url.toString(), {
        method: 'GET',
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`[lead-ads] fetch_failed id=${leadgenId} status=${response.status} msg=${errorText}`);
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

    // 0. Durable event intake: claim event (Priority 3)
    try {
        const claimResult = (await rpc('claim_meta_leadgen_event', {
            p_company_id: config.company,
            p_page_id: config.page,
            p_leadgen_id: change.leadgenId,
            p_form_id: change.formId || null,
            p_ad_id: change.adId || null,
            p_occurred: change.time,
        })) as string;

        if (claimResult === 'ALREADY_PROCESSED') {
            return {
                leadgenId: change.leadgenId,
                status: 'EXISTING',
            };
        }
    } catch (claimErr) {
        console.warn(`[lead-ads] claim_leadgen_event_rpc_error id=${change.leadgenId}`, claimErr);
    }

    // 1. Retrieve lead details from Meta Graph API
    let leadData: MetaLeadData;
    try {
        leadData = await fetchMetaLeadDetails(change.leadgenId, token, customFetch);
    } catch (err) {
        console.error(`[lead-ads] failed_to_fetch_lead id=${change.leadgenId}`);
        try {
            await rpc('finalize_meta_leadgen_event', {
                p_company_id: config.company,
                p_leadgen_id: change.leadgenId,
                p_status: 'FAILED',
                p_error: 'FETCH_LEAD_DETAILS_FAILED',
            });
        } catch {
            // Best effort finalize
        }
        throw err;
    }

    // 2. Extract fields
    const fields = extractLeadFields(leadData.field_data || []);
    const safeContent = formatLeadAdsSafeContent(leadData, fields);
    const customerName = fields.fullName || 'Khách Lead Ads';

    // 3. Fallback to change IDs if leadData doesn't contain them
    const adId = leadData.ad_id || change.adId || null;
    const formId = leadData.form_id || change.formId || null;
    const campaignId = leadData.campaign_id || null;
    const adsetId = leadData.adset_id || change.adgroupId || null;

    // 4. Ingest into CRM via han_ingest RPC
    const intakeKey = `${config.page}:leadgen:${change.leadgenId}`;
    let ingestResult: unknown;
    try {
        ingestResult = await rpc('han_ingest', {
            p_company: config.company,
            p_channel: 'FACEBOOK',
            p_external: `${config.page}:leadgen:${change.leadgenId}`,
            p_key: intakeKey,
            p_name: customerName,
            p_phone: fields.normalizedPhone,
            p_content: safeContent,
            p_safe: safeContent,
            p_safe_status: 'SUCCEEDED',
            p_occurred: change.time,
            p_payload: {
                ...change.raw,
                leadgen_id: change.leadgenId,
                form_id: formId,
                ad_id: adId,
                campaign_id: campaignId,
                crm_lead_ads: true,
                field_data_keys: (leadData.field_data || []).map((f) => f.name),
            },
        });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('IDEMPOTENCY_CONFLICT')) {
            try {
                await rpc('finalize_meta_leadgen_event', {
                    p_company_id: config.company,
                    p_leadgen_id: change.leadgenId,
                    p_status: 'PROCESSED',
                });
            } catch {
                // Best effort
            }
            return {
                leadgenId: change.leadgenId,
                status: 'EXISTING',
            };
        }

        try {
            await rpc('finalize_meta_leadgen_event', {
                p_company_id: config.company,
                p_leadgen_id: change.leadgenId,
                p_status: 'FAILED',
                p_error: 'INGEST_FAILED',
            });
        } catch {
            // Best effort
        }
        throw err;
    }

    const interactionId =
        ingestResult && typeof ingestResult === 'object' && 'interaction_id' in ingestResult
            ? String((ingestResult as Record<string, unknown>).interaction_id || '')
            : undefined;

    // 5. Find Customer ID for touchpoint linking
    let customerId: string | undefined;
    if (interactionId) {
        const client = createAdminClient();
        const { data: interaction } = await client
            .from('interactions')
            .select('customer_id')
            .eq('id', interactionId)
            .maybeSingle();
        if (interaction?.customer_id) {
            customerId = interaction.customer_id;
        }
    }

    // 6. Record Lead Attribution Touchpoint (Priority 5: ATTRIBUTED only if campaign resolved)
    let touchpointId: string | undefined;
    try {
        const initialStatus = campaignId ? 'ATTRIBUTED' : 'UNATTRIBUTED';

        touchpointId = (await rpc('record_lead_attribution_touchpoint', {
            p_company: config.company,
            p_customer: customerId || null,
            p_interaction: interactionId || null,
            p_conversation: null,
            p_channel: 'FACEBOOK_LEAD_ADS',
            p_page_id: config.page,
            p_page_name: config.name || null,
            p_ad_account_id: null,
            p_meta_campaign_id: campaignId,
            p_campaign_name: leadData.campaign_name || null,
            p_meta_ad_set_id: adsetId,
            p_ad_set_name: leadData.adset_name || null,
            p_meta_ad_id: adId,
            p_ad_name: leadData.ad_name || null,
            p_meta_form_id: formId,
            p_form_name: leadData.form_name || null,
            p_meta_leadgen_id: change.leadgenId,
            p_referral_source: 'LEAD_ADS',
            p_referral_type: 'INSTANT_FORM',
            p_ads_context_data: null,
            p_utm_source: null,
            p_utm_medium: null,
            p_utm_campaign: null,
            p_utm_content: null,
            p_utm_term: null,
            p_fbclid: null,
            p_attribution_status: initialStatus,
            p_attribution_method: 'DIRECT_LEADGEN',
            p_occurred: change.time,
        })) as string;
    } catch (touchpointErr) {
        console.warn(`[lead-ads] failed_to_record_touchpoint id=${change.leadgenId}`, touchpointErr);
    }

    // 7. Finalize durable event as PROCESSED
    try {
        await rpc('finalize_meta_leadgen_event', {
            p_company_id: config.company,
            p_leadgen_id: change.leadgenId,
            p_status: 'PROCESSED',
            p_interaction_id: interactionId || null,
            p_customer_id: customerId || null,
        });
    } catch (finErr) {
        console.warn(`[lead-ads] finalize_meta_leadgen_event_failed id=${change.leadgenId}`, finErr);
    }

    return {
        leadgenId: change.leadgenId,
        customerId,
        interactionId,
        touchpointId,
        status: 'PROCESSED',
    };
}
