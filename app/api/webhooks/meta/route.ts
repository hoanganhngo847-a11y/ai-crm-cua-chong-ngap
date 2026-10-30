import { createHash } from 'node:crypto';

import {
    ChannelError,
    object,
    parseLeadgenChanges,
    parseMeta,
    readBody,
    secureEqual,
    validSignature,
} from '@/features/omnichannel/facebook/core';
import {
    processFacebookInboundPhonePrivacy,
} from '@/features/omnichannel/facebook/phone-intake';
import {
    detectLeadForm,
    persistLeadFormToCustomer360,
    readIngestedInteractionId,
} from '@/features/omnichannel/facebook/lead-form';
import {
    processLeadAdsChange,
} from '@/features/omnichannel/facebook/lead-ads';
import {
    lookupFacebookDisplayName,
    promoteFacebookCustomerDisplayName,
} from '@/features/omnichannel/facebook/profile';
import { createAdminClient } from '@/lib/supabase/admin';

import {
    binding,
    env,
    errorResponse,
    rpc,
} from '@/features/omnichannel/facebook/server';

export const runtime = 'nodejs';

export async function GET(request: Request) {
    try {
        const query = new URL(request.url).searchParams;

        if (
            query.get('hub.mode') !== 'subscribe' ||
            !secureEqual(
                query.get('hub.verify_token') || '',
                env('META_VERIFY_TOKEN'),
            )
        ) {
            throw new ChannelError('VERIFICATION_FAILED', 403);
        }

        const challenge = query.get('hub.challenge');

        if (!challenge || challenge.length > 200) {
            throw new ChannelError('INVALID_CHALLENGE');
        }

        return new Response(challenge, {
            headers: {
                'Content-Type': 'text/plain',
                'Cache-Control': 'no-store',
            },
        });
    } catch (error) {
        return errorResponse(error);
    }
}

export async function POST(request: Request) {
    try {
        const raw = await readBody(request);
        const signature = request.headers.get('x-hub-signature-256');
        const signatureHeaderState = !signature
            ? 'missing'
            : /^sha256=[a-f0-9]{64}$/i.test(signature)
                ? 'present'
                : 'malformed';

        console.info(
            `[meta-webhook] signature_header=${signatureHeaderState} body_bytes=${Buffer.byteLength(raw, 'utf8')}`,
        );

        const signatureValid = validSignature(
            raw,
            signature,
            env('META_APP_SECRET'),
        );

        if (!signatureValid) {
            console.warn('[meta-webhook] signature=invalid');
            throw new ChannelError('INVALID_SIGNATURE', 403);
        }

        console.info('[meta-webhook] signature=valid');

        const body = object(JSON.parse(raw));
        if (body.object !== 'page' || !Array.isArray(body.entry) || body.entry.length > 200) {
            throw new ChannelError('INVALID_WEBHOOK');
        }

        const messagingBatches: Array<{ config: ReturnType<typeof binding>; events: ReturnType<typeof parseMeta> }> = [];
        const leadgenChanges: Array<{ config: ReturnType<typeof binding>; change: ReturnType<typeof parseLeadgenChanges>[number] }> = [];

        for (const value of body.entry) {
            const entry = object(value);
            if (typeof entry.id !== 'string') throw new ChannelError('INVALID_WEBHOOK');
            const config = binding(entry.id);

            if (Array.isArray(entry.messaging)) {
                messagingBatches.push({
                    config,
                    events: parseMeta({ object: 'page', entry: [entry] }, config.page),
                });
            }

            if (Array.isArray(entry.changes)) {
                const changes = parseLeadgenChanges({ object: 'page', entry: [entry] }, config.page);
                for (const change of changes) {
                    leadgenChanges.push({ config, change });
                }
            }
        }

        const totalEvents =
            messagingBatches.reduce((count, b) => count + b.events.length, 0) + leadgenChanges.length;
        if (totalEvents > 200) {
            throw new ChannelError('TOO_MANY_EVENTS', 413);
        }

        // Process Lead Ads events (Instant Forms) independently (Priority 3)
        const leadgenErrors: Array<{ leadgenId: string; error: unknown }> = [];
        for (const { config, change } of leadgenChanges) {
            try {
                await processLeadAdsChange(config, change);
            } catch (err) {
                console.error(`[meta-webhook] leadgen_event_failed id=${change.leadgenId}`);
                leadgenErrors.push({ leadgenId: change.leadgenId, error: err });
            }
        }

        if (leadgenErrors.length > 0) {
            console.error(`[meta-webhook] ${leadgenErrors.length} leadgen events failed in batch`);
            throw new ChannelError('LEAD_INGESTION_FAILED', 503);
        }

        // Process Messenger messaging events
        for (const { config, event } of messagingBatches.flatMap(({ config, events }) =>
            events.map((event) => ({ config, event })),
        )) {
            if (event.kind === 'MESSAGE') {
                const leadForm = detectLeadForm(event.content);
                const phonePrivacy = processFacebookInboundPhonePrivacy(event.content);

                // Keep the intake payload name stable for idempotent retries. Profile enrichment
                // is deliberately best-effort and promoted to the customer record after ingestion.
                const displayNamePromise = lookupFacebookDisplayName(config, event.sender);

                const ingestResult = await rpc('han_ingest', {
                    p_company: config.company,
                    p_channel: 'FACEBOOK',
                    p_external: `${config.page}:${event.sender}`,
                    p_key: event.key,
                    p_name: 'Khách Messenger',
                    p_phone: leadForm?.phone ?? phonePrivacy.phone,
                    p_content: event.content,
                    p_safe: phonePrivacy.safeContent,
                    p_safe_status: phonePrivacy.safeStatus,
                    p_occurred: event.time,
                    p_payload: {
                        ...event.raw,
                        crm_phone_detection: {
                            status: phonePrivacy.status,
                            valid_count: phonePrivacy.validPhones.length,
                            invalid_count: phonePrivacy.invalidCandidates.length,
                        },
                        ...(leadForm ? { crm_lead_form: true } : {}),
                        ...(event.referral ? { referral: event.referral } : {}),
                    },
                });

                const interactionId = readIngestedInteractionId(ingestResult);

                if (leadForm && interactionId) {
                    await persistLeadFormToCustomer360(createAdminClient(), {
                        companyId: config.company,
                        sourceInteractionId: interactionId,
                        form: leadForm,
                    });
                }

                // If Click-to-Messenger Ad referral is present, record attribution touchpoint
                if (event.referral && interactionId) {
                    try {
                        const adminClient = createAdminClient();
                        const { data: interaction } = await adminClient
                            .from('interactions')
                            .select('customer_id,conversation_id')
                            .eq('id', interactionId)
                            .maybeSingle();

                        if (interaction?.customer_id) {
                            const isAd = Boolean(event.referral.adId);
                            await rpc('record_lead_attribution_touchpoint', {
                                p_company: config.company,
                                p_customer: interaction.customer_id,
                                p_interaction: interactionId,
                                p_conversation: interaction.conversation_id ?? null,
                                p_channel: 'FACEBOOK_MESSENGER',
                                p_page_id: config.page,
                                p_page_name: config.name || null,
                                p_ad_account_id: null,
                                p_meta_campaign_id: null,
                                p_campaign_name: null,
                                p_meta_ad_set_id: null,
                                p_ad_set_name: null,
                                p_meta_ad_id: event.referral.adId || null,
                                p_ad_name: null,
                                p_meta_form_id: null,
                                p_form_name: null,
                                p_meta_leadgen_id: null,
                                p_referral_source: event.referral.source || 'ADS',
                                p_referral_type: event.referral.type || 'OPEN_THREAD',
                                p_ads_context_data: event.referral.adsContextData || null,
                                p_utm_source: null,
                                p_utm_medium: null,
                                p_utm_campaign: null,
                                p_utm_content: null,
                                p_utm_term: null,
                                p_fbclid: null,
                                p_attribution_status: 'UNATTRIBUTED',
                                p_attribution_method: isAd ? 'AD_LOOKUP' : 'MESSENGER_REFERRAL',
                                p_occurred: event.time,
                            });
                        }
                    } catch (attributionErr) {
                        console.warn('[meta-webhook] failed_to_record_messenger_attribution', attributionErr);
                    }
                }

                const displayName = await displayNamePromise;
                await promoteFacebookCustomerDisplayName(
                    config,
                    event.sender,
                    displayName,
                );
            } else {
                await rpc('han_receipt', {
                    p_company: config.company,
                    p_external: `${config.page}:${event.sender}`,
                    p_key: createHash('sha256')
                        .update(JSON.stringify(event.raw))
                        .digest('hex'),
                    p_kind: event.kind,
                    p_mids: event.mids,
                    p_watermark: event.watermark,
                });
            }
        }

        console.info('[meta-webhook] processed=true');
        return Response.json({ received: true });
    } catch (error) {
        return errorResponse(error);
    }
}
