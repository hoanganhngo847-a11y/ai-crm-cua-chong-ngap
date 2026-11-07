import { createHash } from 'node:crypto';

import {
    ChannelError,
    object,
    parseMeta,
    parseLeadgenChanges,
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
    lookupFacebookDisplayName,
    promoteFacebookCustomerDisplayName,
} from '@/features/omnichannel/facebook/profile';
import { leadAdsPageBindings } from '@/features/omnichannel/facebook/lead-ads-binding';
import { processLeadAdsChange } from '@/features/omnichannel/facebook/lead-ads';
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
        const batches: Array<{ config: ReturnType<typeof binding>; events: ReturnType<typeof parseMeta> }> = [];
        const leadgen: Array<{
            config: ReturnType<typeof leadAdsPageBindings>[number];
            change: ReturnType<typeof parseLeadgenChanges>[number];
        }> = [];
        for (const value of body.entry) {
            const entry = object(value);
            if (typeof entry.id !== 'string') throw new ChannelError('INVALID_WEBHOOK');
            const envelope = { object: 'page', entry: [entry] };
            let messenger: ReturnType<typeof binding> | undefined;
            let messengerBindingError: unknown;
            try {
                messenger = binding(entry.id);
            } catch (error) {
                messengerBindingError = error;
            }
            const hasLeadgen = Array.isArray(entry.changes) &&
                entry.changes.some(change => change?.field === 'leadgen');
            const ads = hasLeadgen
                ? leadAdsPageBindings().find(config => config.page === entry.id)
                : undefined;

            if (!messenger && !ads) throw messengerBindingError;
            if (messenger) batches.push({ config: messenger, events: parseMeta(envelope, messenger.page) });
            if (ads && hasLeadgen) {
                for (const change of parseLeadgenChanges(envelope, ads.page)) leadgen.push({ config: ads, change });
            }
        }
        if (batches.reduce((count, batch) => count + batch.events.length, leadgen.length) > 200) {
            throw new ChannelError('TOO_MANY_EVENTS', 413);
        }

        for (const { config, event } of batches.flatMap(({ config, events }) =>
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
                    },
                });

                if (leadForm) {
                    const interactionId = readIngestedInteractionId(ingestResult);
                    if (interactionId) {
                        await persistLeadFormToCustomer360(createAdminClient(), {
                            companyId: config.company,
                            sourceInteractionId: interactionId,
                            form: leadForm,
                        });
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

        let leadgenFailed = false;
        for (const { config, change } of leadgen) {
            try {
                await processLeadAdsChange(config, change);
            } catch {
                leadgenFailed = true;
            }
        }
        if (leadgenFailed) throw new ChannelError('LEAD_INGESTION_FAILED', 503);

        console.info('[meta-webhook] processed=true');
        return Response.json({ received: true });
    } catch (error) {
        return errorResponse(error);
    }
}
