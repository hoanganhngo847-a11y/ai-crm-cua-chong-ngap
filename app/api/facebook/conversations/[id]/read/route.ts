import {
    object,
    readBody,
    uuid,
} from '@/features/omnichannel/facebook/core';

import {
    authorizeConversation,
    errorResponse,
    rpc,
    sameOrigin,
} from '@/features/omnichannel/facebook/server';

export async function POST(
    request: Request,
    context: { params: Promise<{ id: string }> },
) {
    try {
        sameOrigin(request);

        const { id } = await context.params;

        const input = object(
            JSON.parse(await readBody(request, 2000)),
        );

        const lastSeen = uuid(input.last_seen_interaction_id);

        const { conversation, actor } =
            await authorizeConversation(id);

        const unread = await rpc('han_mark_read', {
            p_company: conversation.company_id,
            p_conversation: id,
            p_actor: actor.userId,
            p_seen: lastSeen,
        });

        return Response.json({ unread_count: unread });
    } catch (error) {
        return errorResponse(error);
    }
}