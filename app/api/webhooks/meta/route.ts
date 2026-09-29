import { createHash } from 'node:crypto';

import {
    ChannelError,
    extractPhone,
    object,
    parseMeta,
    readBody,
    sanitize,
    secureEqual,
    validSignature,
} from '@/features/omnichannel/facebook/core';

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

        if (
            !validSignature(
                raw,
                request.headers.get('x-hub-signature-256'),
                env('META_APP_SECRET'),
            )
        ) {
            throw new ChannelError('INVALID_SIGNATURE', 403);
        }

        const body = object(JSON.parse(raw));
        if (body.object !== 'page' || !Array.isArray(body.entry) || body.entry.length > 200) {
            throw new ChannelError('INVALID_WEBHOOK');
        }
        // Validate every signed entry before writing any event.
        const batches = body.entry.map((value) => {
            const entry = object(value);
            if (typeof entry.id !== 'string') throw new ChannelError('INVALID_WEBHOOK');
            const config = binding(entry.id);
            return { config, events: parseMeta({ object: 'page', entry: [entry] }, config.page) };
        });
        if (batches.reduce((count, batch) => count + batch.events.length, 0) > 200) {
            throw new ChannelError('TOO_MANY_EVENTS', 413);
        }

        for (const { config, event } of batches.flatMap(({ config, events }) =>
            events.map((event) => ({ config, event })),
        )) {
            if (event.kind === 'MESSAGE') {
                const safe = sanitize(event.content);

                await rpc('han_ingest', {
                    p_company: config.company,
                    p_channel: 'FACEBOOK',
                    p_external: `${config.page}:${event.sender}`,
                    p_key: event.key,
                    p_name: 'Khách Messenger',
                    p_phone: extractPhone(event.content),
                    p_content: event.content,
                    p_safe: safe.content,
                    p_safe_status: safe.status,
                    p_occurred: event.time,
                    p_payload: event.raw,
                });
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

        return Response.json({ received: true });
    } catch (error) {
        return errorResponse(error);
    }
}
