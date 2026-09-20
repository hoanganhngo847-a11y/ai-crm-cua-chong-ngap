import {
    readBody,
} from '@/features/omnichannel/facebook/core';

import {
    errorResponse,
    listMessages,
    sameOrigin,
    sendMessage,
} from '@/features/omnichannel/facebook/server';

type Context = {
    params: Promise<{ id: string }>;
};

export async function GET(
    request: Request,
    context: Context,
) {
    try {
        const { id } = await context.params;
        const before = new URL(request.url).searchParams.get('before');

        return Response.json(
            await listMessages(id, before),
            { headers: { 'Cache-Control': 'no-store' } },
        );
    } catch (error) {
        return errorResponse(error);
    }
}

export async function POST(
    request: Request,
    context: Context,
) {
    try {
        sameOrigin(request);

        const { id } = await context.params;
        const input = JSON.parse(
            await readBody(request, 16_000),
        );

        return Response.json(await sendMessage(id, input));
    } catch (error) {
        return errorResponse(error);
    }
}