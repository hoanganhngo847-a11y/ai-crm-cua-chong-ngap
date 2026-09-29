import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createAdminClient } from '@/lib/supabase/admin';
import { verifyActorForCompany } from '@/lib/server-auth/authorize';
import { ServerAuthError } from '@/lib/server-auth/errors';
import { binding } from './binding';
export { binding } from './binding';
import { dispatchMessage } from './transport';

import {
    ChannelError,
    canReply,
    decodeCursor,
    encodeCursor,
    object,
    sanitize,
    text,
    uuid,
} from './core';

export function env(key: string): string {
    const value = process.env[key];

    if (!value?.trim()) {
        throw new ChannelError('CHANNEL_NOT_CONFIGURED', 503);
    }

    return value.trim();
}

async function authorizeResourceCompany(company: string, actorClient?: SupabaseClient) {
    try {
        return await verifyActorForCompany(company, {
            allowedRoles: ['BOSS_ADMIN', 'SALE'],
        }, actorClient);
    } catch (error) {
        // Same semantics as Foundation's private verifyActorWithTenantMasking.
        if (error instanceof ServerAuthError && error.code === 'NOT_A_MEMBER') {
            throw new ChannelError('NOT_FOUND', 404);
        }
        throw error;
    }
}

export async function rpc(
    name: string,
    args: Record<string, unknown>,
) {
    const { data, error } = await createAdminClient().rpc(name, args);

    if (error) {
        const known: Record<string, number> = {
            IDEMPOTENCY_CONFLICT: 409,
            WINDOW_CLOSED: 409,
            INVALID_DELIVERY: 409,
            CARE_STOPPED: 409,
            ACCESS_DENIED: 403,
        };

        if (known[error.message]) {
            throw new ChannelError(error.message, known[error.message]);
        }

        throw new ChannelError('CHANNEL_STORAGE_UNAVAILABLE', 503);
    }

    return data;
}

export function errorResponse(error: unknown): Response {
    if (error instanceof ChannelError) {
        return Response.json(
            { error: error.code },
            { status: error.status },
        );
    }

    if (
        error &&
        typeof error === 'object' &&
        'status' in error &&
        (error.status === 401 || error.status === 403)
    ) {
        return Response.json(
            { error: 'ACCESS_DENIED' },
            { status: error.status },
        );
    }

    if (error instanceof SyntaxError) {
        return Response.json(
            { error: 'INVALID_JSON' },
            { status: 400 },
        );
    }

    return Response.json(
        { error: 'CHANNEL_UNAVAILABLE' },
        { status: 503 },
    );
}

export function sameOrigin(request: Request) {
    const origin = request.headers.get('origin');
    const expected = new URL(env('WEBSITE_ORIGIN')).origin;

    if (!origin || origin !== expected) {
        throw new ChannelError('ORIGIN_NOT_ALLOWED', 403);
    }
}

export async function authorizeConversation(id: string, actorClient?: SupabaseClient) {
    uuid(id);

    const client = createAdminClient();

    const { data: conversation, error } = await client
        .from('conversations')
        .select(
            'id,company_id,customer_id,channel,external_conversation_id',
        )
        .eq('id', id)
        .maybeSingle();

    if (error) {
        throw new ChannelError('CHANNEL_STORAGE_UNAVAILABLE', 503);
    }

    if (!conversation || conversation.channel !== 'FACEBOOK') {
        throw new ChannelError('NOT_FOUND', 404);
    }

    const actor = await authorizeResourceCompany(conversation.company_id, actorClient);

    const config = binding(conversation.external_conversation_id.split(':')[0]);

    if (
        conversation.company_id !== config.company ||
        !conversation.external_conversation_id.startsWith(
            config.page + ':',
        )
    ) {
        throw new ChannelError('PAGE_NOT_ALLOWED', 403);
    }

    return { client, conversation, actor, config };
}

export async function listConversations(before?: string | null, page?: string | null) {
    const config = binding(page);

    await verifyActorForCompany(config.company, {
        allowedRoles: ['BOSS_ADMIN', 'SALE'],
    });

    let query = createAdminClient()
        .from('conversations')
        .select(
            'id,customer_id,last_message_at,unread_count,status,created_at',
        )
        .eq('company_id', config.company)
        .eq('channel', 'FACEBOOK')
        .like('external_conversation_id', config.page + ':%')
        .order('last_message_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(50);

    if (before) {
        const cursor = decodeCursor(before);

        query = query.or(
            `last_message_at.lt.${cursor.time},and(last_message_at.eq.${cursor.time},id.lt.${cursor.id})`,
        );
    }

    const { data, error } = await query;

    if (error) {
        throw new ChannelError('CHANNEL_STORAGE_UNAVAILABLE', 503);
    }

    return {
        conversations: data,
        next_cursor:
            data.length === 50
                ? encodeCursor({
                    created_at: data[data.length - 1].last_message_at,
                    id: data[data.length - 1].id,
                })
                : null,
    };
}

export async function listMessages(
    id: string,
    before?: string | null,
) {
    const { client, conversation } =
        await authorizeConversation(id);

    let query = client
        .from('interactions')
        .select(
            'id,direction,sanitized_content,sanitization_status,actor_type,created_at',
        )
        .eq('company_id', conversation.company_id)
        .eq('conversation_id', id)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(50);

    if (before) {
        const cursor = decodeCursor(before);

        query = query.or(
            `created_at.lt.${cursor.time},and(created_at.eq.${cursor.time},id.lt.${cursor.id})`,
        );
    }

    const { data, error } = await query;

    if (error) {
        throw new ChannelError('CHANNEL_STORAGE_UNAVAILABLE', 503);
    }

    const states: {
        interaction_id: string;
        status: string;
    }[] = await rpc('han_message_states', {
        p_company: conversation.company_id,
        p_conversation: id,
        p_ids: data.map((row) => row.id),
    });

    const byId = new Map(
        states.map((row) => [row.interaction_id, row.status]),
    );

    return {
        messages: data.map((row) => ({
            ...row,
            delivery_status: byId.get(row.id) || null,
            sanitized_content:
                row.sanitization_status === 'SUCCEEDED'
                    ? sanitize(row.sanitized_content || '').content
                    : null,
        })),
        next_cursor:
            data.length === 50
                ? encodeCursor(data[data.length - 1])
                : null,
    };
}

export async function sendMessage(
    conversationId: string,
    input: unknown,
) {
    const body = object(input);
    const content = text(body.content, 2000);
    const requestId = uuid(body.request_id);

    const deliveryId = body.care_delivery_id
        ? uuid(body.care_delivery_id)
        : null;

    const { client, conversation, actor, config } =
        await authorizeConversation(conversationId);

    const { data: latest, error } = await client
        .from('interactions')
        .select('created_at')
        .eq('company_id', config.company)
        .eq('conversation_id', conversationId)
        .eq('direction', 'INBOUND')
        .eq('actor_type', 'CUSTOMER')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) {
        throw new ChannelError('CHANNEL_STORAGE_UNAVAILABLE', 503);
    }

    if (!canReply(latest?.created_at || null)) {
        throw new ChannelError('MESSAGING_WINDOW_CLOSED', 409);
    }

    const token = env(config.tokenEnv);
    const version = env('META_GRAPH_VERSION');

    if (!/^v\d+\.\d+$/.test(version)) {
        throw new ChannelError('CHANNEL_NOT_CONFIGURED', 503);
    }

    const safe = sanitize(content);

    const prepared = await rpc('han_prepare_send', {
        p_company: config.company,
        p_conversation: conversationId,
        p_actor: actor.userId,
        p_request: requestId,
        p_content: content,
        p_safe: safe.content,
        p_safe_status: safe.status,
        p_delivery: deliveryId,
    });

    if (!prepared.claimed) {
        return {
            request_id: requestId,
            status: prepared.status,
        };
    }

    const { status, mid } = await dispatchMessage({
        page: config.page,
        recipient: conversation.external_conversation_id.slice(
            config.page.length + 1,
        ),
        version,
        token,
        content,
    });

    await rpc('han_finish_send', {
        p_company: config.company,
        p_request: requestId,
        p_status: status,
        p_mid: mid,
    });

    return {
        request_id: requestId,
        status,
    };
}

export async function campaignStats(id: string, actorClient?: SupabaseClient) {
    uuid(id);

    const client = createAdminClient();

    const { data: campaign, error } = await client
        .from('care_campaigns')
        .select('company_id,channel')
        .eq('id', id)
        .maybeSingle();

    if (error) {
        throw new ChannelError('CHANNEL_STORAGE_UNAVAILABLE', 503);
    }

    if (!campaign || campaign.channel !== 'FACEBOOK') {
        throw new ChannelError('NOT_FOUND', 404);
    }

    await authorizeResourceCompany(campaign.company_id, actorClient);

    return rpc('han_care_stats', {
        p_company: campaign.company_id,
        p_campaign: id,
    });
}
