import { createHmac } from 'node:crypto';

import {
    ChannelError,
    object,
    readBody,
    sanitize,
    uuid,
} from '@/features/omnichannel/facebook/core';

import {
    env,
    errorResponse,
    rpc,
    sameOrigin,
} from '@/features/omnichannel/facebook/server';

import {
    validateLead,
} from '@/features/omnichannel/website/validation';

export const runtime = 'nodejs';

export async function POST(request: Request) {
    try {
        sameOrigin(request);

        if (
            !request.headers
                .get('content-type')
                ?.startsWith('application/json')
        ) {
            throw new ChannelError('UNSUPPORTED_MEDIA_TYPE', 415);
        }

        const input = object(
            JSON.parse(await readBody(request, 16_000)),
        );

        const lead = validateLead(input);
        const company = uuid(env('OMNICHANNEL_COMPANY_ID'));
        const rateSecret = env('WEBSITE_RATE_SECRET');

        if (rateSecret.length < 32) {
            throw new ChannelError('CHANNEL_NOT_CONFIGURED', 503);
        }

        const key = createHmac('sha256', rateSecret)
            .update(lead.phone)
            .digest('hex');

        if (
            process.env.NODE_ENV === 'production' ||
            process.env.TURNSTILE_SECRET_KEY
        ) {
            const token =
                typeof input.captcha_token === 'string'
                    ? input.captcha_token
                    : '';

            if (!token || token.length > 2048) {
                throw new ChannelError('CAPTCHA_REQUIRED');
            }

            const response = await fetch(
                'https://challenges.cloudflare.com/turnstile/v0/siteverify',
                {
                    method: 'POST',
                    body: new URLSearchParams({
                        secret: env('TURNSTILE_SECRET_KEY'),
                        response: token,
                    }),
                    signal: AbortSignal.timeout(8000),
                    cache: 'no-store',
                },
            );

            const result = object(await response.json());

            if (
                !response.ok ||
                result.success !== true ||
                result.hostname !==
                new URL(env('WEBSITE_ORIGIN')).hostname ||
                result.action !== 'lead'
            ) {
                throw new ChannelError('CAPTCHA_FAILED', 403);
            }
        }

        // Business quotas must only be consumed by CAPTCHA-verified requests.
        const allowed = await rpc('han_rate_limit', {
            p_company: company,
            p_key: key,
        });

        if (!allowed) {
            throw new ChannelError('RATE_LIMITED', 429);
        }

        const safe = sanitize(lead.need);

        await rpc('han_ingest', {
            p_company: company,
            p_channel: 'WEBSITE',
            p_external: null,
            p_key: lead.requestId,
            p_name: sanitize(lead.name).content || 'Khách Website',
            p_phone: lead.phone,
            p_content: lead.need,
            p_safe: safe.content,
            p_safe_status: safe.status,
            p_occurred: new Date().toISOString(),
            p_payload: {
                name: lead.name,
                consent: true,
                consent_version: 'website-lead-v1',
            },
        });

        return Response.json(
            { accepted: true },
            {
                status: 202,
                headers: { 'Cache-Control': 'no-store' },
            },
        );
    } catch (error) {
        return errorResponse(error);
    }
}
