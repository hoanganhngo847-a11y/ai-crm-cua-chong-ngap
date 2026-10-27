import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { createAdminClient } from '@/lib/supabase/admin';
import { pageBindings, type PageBinding } from './binding';
import { processFacebookInboundPhonePrivacy } from './phone-intake';
import {
    normalizeFacebookDisplayName,
    promoteFacebookCustomerDisplayName,
} from './profile';

const GRAPH_TIMEOUT_MS = 10_000;
const GRAPH_PAGE_LIMIT = 100;
const MAX_GRAPH_PAGES = 10;
const DEFAULT_LOOKBACK_MINUTES = 15;
const MAX_LOOKBACK_MINUTES = 7 * 24 * 60;
const DEFAULT_MAX_CONVERSATIONS = 200;
const DEFAULT_MAX_MESSAGES = 200;

const ATTACHMENT_PLACEHOLDER = '[Khách gửi tệp đính kèm; nội dung cần kiểm tra]';
const EMPTY_MESSAGE_PLACEHOLDER = '[Tin nhắn không có văn bản]';

type GraphConversation = {
    id?: unknown;
    updated_time?: unknown;
    participants?: {
        data?: Array<{
            id?: unknown;
            name?: unknown;
        }>;
    };
};

type GraphMessage = {
    id?: unknown;
    message?: unknown;
    created_time?: unknown;
    from?: {
        id?: unknown;
        name?: unknown;
    };
    attachments?: unknown;
};

type GraphList<T> = {
    rows: T[];
    after: string | null;
    hasNext: boolean;
};

export type FacebookSyncOptions = {
    lookbackMinutes?: number;
    pages?: string[];
    maxConversationsPerPage?: number;
    maxMessagesPerConversation?: number;
};

export type FacebookSyncDependencies = {
    client?: SupabaseClient;
    fetcher?: typeof fetch;
    now?: Date;
    promoteDisplayName?: typeof promoteFacebookCustomerDisplayName;
};

export type FacebookSyncPageResult = {
    page: string;
    conversations: number;
    messages_seen: number;
    messages_ingested: number;
    messages_skipped: number;
    errors: string[];
};

export type FacebookSyncResult = {
    ok: boolean;
    started_at: string;
    finished_at: string;
    lookback_minutes: number;
    pages: FacebookSyncPageResult[];
};

type SyncWindow = {
    lookbackMinutes: number;
    maxConversationsPerPage: number;
    maxMessagesPerConversation: number;
    since: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function clampInteger(
    value: number | undefined,
    minimum: number,
    maximum: number,
    fallback: number,
): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function graphFailure(status: number, payload: unknown): string {
    const root = asRecord(payload);
    const error = asRecord(root?.error);
    const code = typeof error?.code === 'number' ? ` code=${error.code}` : '';
    const subcode =
        typeof error?.error_subcode === 'number'
            ? ` subcode=${error.error_subcode}`
            : '';
    return `graph_status=${status}${code}${subcode}`;
}

async function requestGraph(
    url: URL,
    token: string,
    fetcher: typeof fetch,
): Promise<{ ok: true; payload: unknown } | { ok: false; failure: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GRAPH_TIMEOUT_MS);

    try {
        const response = await fetcher(url, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${token}`,
            },
            cache: 'no-store',
            signal: controller.signal,
        });

        let payload: unknown = null;
        try {
            payload = await response.json();
        } catch {
            // A non-JSON error body still carries the HTTP status.
        }

        if (!response.ok) {
            return { ok: false, failure: graphFailure(response.status, payload) };
        }

        return { ok: true, payload };
    } catch (error) {
        return {
            ok: false,
            failure:
                error instanceof Error && error.name === 'AbortError'
                    ? 'graph_timeout'
                    : 'graph_network_error',
        };
    } finally {
        clearTimeout(timeout);
    }
}

function readList<T>(payload: unknown): GraphList<T> {
    const root = asRecord(payload);
    const rows = Array.isArray(root?.data) ? (root.data as T[]) : [];
    const paging = asRecord(root?.paging);
    const cursors = asRecord(paging?.cursors);
    const after = typeof cursors?.after === 'string' ? cursors.after : null;
    const hasNext = typeof paging?.next === 'string' && paging.next.length > 0;

    return { rows, after, hasNext };
}

function graphTime(value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim()) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
}

function messageContent(message: GraphMessage): string {
    if (typeof message.message === 'string' && message.message.trim().length > 0) {
        return message.message.slice(0, 10_000);
    }

    if (Array.isArray(message.attachments) && message.attachments.length > 0) {
        return ATTACHMENT_PLACEHOLDER;
    }

    return EMPTY_MESSAGE_PLACEHOLDER;
}

function graphUrl(version: string, ...segments: string[]): URL {
    return new URL(
        `https://graph.facebook.com/${version}/${segments
            .map((segment) => encodeURIComponent(segment))
            .join('/')}`,
    );
}

function conversationCustomer(
    conversation: GraphConversation,
    page: string,
): { psid: string; name: string | null } | null {
    const participants = conversation.participants?.data;
    if (!Array.isArray(participants)) return null;

    const customers = participants.filter(
        (participant) =>
            typeof participant?.id === 'string' &&
            participant.id.length > 0 &&
            participant.id !== page,
    );

    if (customers.length !== 1) return null;

    const psid = customers[0].id as string;
    if (!/^\d+$/.test(psid)) return null;

    return {
        psid,
        name: normalizeFacebookDisplayName(customers[0].name),
    };
}

async function ingestMessage(
    config: PageBinding,
    conversationId: string,
    customerPsid: string,
    message: GraphMessage,
    client: SupabaseClient,
    result: FacebookSyncPageResult,
): Promise<'ingested' | 'skipped'> {
    const mid = typeof message.id === 'string' ? message.id.trim() : '';
    if (!mid || mid.length > 250) return 'skipped';

    const fromId =
        typeof message.from?.id === 'string' ? message.from.id.trim() : '';
    if (fromId === config.page) return 'skipped';
    if (fromId !== customerPsid) return 'skipped';

    const occurred = graphTime(message.created_time);
    if (!occurred) return 'skipped';

    const content = messageContent(message);
    const privacy = processFacebookInboundPhonePrivacy(content);

    const { error } = await client.rpc('han_ingest', {
        p_company: config.company,
        p_channel: 'FACEBOOK',
        p_external: `${config.page}:${customerPsid}`,
        p_key: `${config.page}:${mid}`,
        p_name: 'Khách Messenger',
        p_phone: privacy.phone,
        p_content: content,
        p_safe: privacy.safeContent,
        p_safe_status: privacy.safeStatus,
        p_occurred: occurred,
        p_payload: {
            id: mid,
            created_time: occurred,
            from: { id: fromId },
            message: content,
            has_attachments:
                Array.isArray(message.attachments) && message.attachments.length > 0,
            conversation_id: conversationId,
            sync_source: 'graph_poll',
            crm_phone_detection: {
                status: privacy.status,
                valid_count: privacy.validPhones.length,
                invalid_count: privacy.invalidCandidates.length,
            },
        },
    });

    if (!error) return 'ingested';

    if (error.message.includes('IDEMPOTENCY_CONFLICT')) {
        return 'skipped';
    }

    result.errors.push(`han_ingest:${error.message.slice(0, 120)}`);
    return 'skipped';
}

async function syncConversation(
    config: PageBinding,
    conversation: GraphConversation,
    window: SyncWindow,
    client: SupabaseClient,
    fetcher: typeof fetch,
    token: string,
    version: string,
    promoteDisplayName: typeof promoteFacebookCustomerDisplayName,
    result: FacebookSyncPageResult,
): Promise<void> {
    const conversationId =
        typeof conversation.id === 'string' ? conversation.id.trim() : '';
    if (!conversationId) {
        result.errors.push('conversation_id_missing');
        return;
    }

    const customer = conversationCustomer(conversation, config.page);
    if (!customer) {
        result.errors.push('conversation_participants_ambiguous');
        return;
    }

    let after: string | null = null;
    let remaining = window.maxMessagesPerConversation;
    let graphPages = 0;

    while (remaining > 0 && graphPages < MAX_GRAPH_PAGES) {
        const url = graphUrl(version, conversationId, 'messages');
        url.searchParams.set('fields', 'id,message,from,created_time,attachments');
        url.searchParams.set('limit', String(Math.min(GRAPH_PAGE_LIMIT, remaining)));
        url.searchParams.set('since', String(window.since));
        if (after) url.searchParams.set('after', after);

        const response = await requestGraph(url, token, fetcher);
        if (!response.ok) {
            result.errors.push(response.failure);
            break;
        }

        const list = readList<GraphMessage>(response.payload);

        for (const message of list.rows) {
            if (remaining <= 0) break;
            remaining -= 1;
            result.messages_seen += 1;

            const outcome = await ingestMessage(
                config,
                conversationId,
                customer.psid,
                message,
                client,
                result,
            );

            if (outcome === 'ingested') {
                result.messages_ingested += 1;
            } else {
                result.messages_skipped += 1;
            }
        }

        graphPages += 1;
        if (!list.hasNext || !list.after) break;
        after = list.after;
    }

    if (customer.name) {
        await promoteDisplayName(config, customer.psid, customer.name);
    }
}

async function syncPage(
    config: PageBinding,
    window: SyncWindow,
    dependencies: FacebookSyncDependencies,
): Promise<FacebookSyncPageResult> {
    const result: FacebookSyncPageResult = {
        page: config.page,
        conversations: 0,
        messages_seen: 0,
        messages_ingested: 0,
        messages_skipped: 0,
        errors: [],
    };

    const version = process.env.META_GRAPH_VERSION?.trim();
    const token = process.env[config.tokenEnv]?.trim();

    if (!version || !/^v\d+\.\d+$/.test(version)) {
        result.errors.push('graph_version_missing');
        return result;
    }

    if (!token) {
        result.errors.push('page_token_missing');
        return result;
    }

    const client = dependencies.client ?? createAdminClient();
    const fetcher = dependencies.fetcher ?? fetch;
    const promoteDisplayName =
        dependencies.promoteDisplayName ?? promoteFacebookCustomerDisplayName;

    let after: string | null = null;
    let remaining = window.maxConversationsPerPage;
    let graphPages = 0;

    while (remaining > 0 && graphPages < MAX_GRAPH_PAGES) {
        const url = graphUrl(version, config.page, 'conversations');
        url.searchParams.set('fields', 'id,participants,updated_time');
        url.searchParams.set('limit', String(Math.min(GRAPH_PAGE_LIMIT, remaining)));
        url.searchParams.set('since', String(window.since));
        if (after) url.searchParams.set('after', after);

        const response = await requestGraph(url, token, fetcher);
        if (!response.ok) {
            result.errors.push(response.failure);
            break;
        }

        const list = readList<GraphConversation>(response.payload);

        for (const conversation of list.rows) {
            if (remaining <= 0) break;
            remaining -= 1;
            result.conversations += 1;

            await syncConversation(
                config,
                conversation,
                window,
                client,
                fetcher,
                token,
                version,
                promoteDisplayName,
                result,
            );
        }

        graphPages += 1;
        if (!list.hasNext || !list.after) break;
        after = list.after;
    }

    return result;
}

/**
 * Pull recent Page conversations directly from Meta Graph API.
 *
 * This is the transport-independent fallback for messages that the webhook cannot deliver
 * while the Meta app is in Development mode. Polling uses the same `${page}:${mid}` key as
 * the webhook, so a message that arrives through both paths is ingested only once.
 */
export async function syncFacebookPages(
    options: FacebookSyncOptions = {},
    dependencies: FacebookSyncDependencies = {},
): Promise<FacebookSyncResult> {
    const startedAt = new Date();
    const lookbackMinutes = clampInteger(
        options.lookbackMinutes,
        1,
        MAX_LOOKBACK_MINUTES,
        DEFAULT_LOOKBACK_MINUTES,
    );
    const maxConversationsPerPage = clampInteger(
        options.maxConversationsPerPage,
        1,
        1000,
        DEFAULT_MAX_CONVERSATIONS,
    );
    const maxMessagesPerConversation = clampInteger(
        options.maxMessagesPerConversation,
        1,
        1000,
        DEFAULT_MAX_MESSAGES,
    );
    const now = dependencies.now ?? new Date();
    const selectedPages = new Set(
        (options.pages ?? []).map((page) => page.trim()).filter(Boolean),
    );

    const configs = pageBindings().filter(
        (config) => selectedPages.size === 0 || selectedPages.has(config.page),
    );

    const client = dependencies.client ?? createAdminClient();
    const window: SyncWindow = {
        lookbackMinutes,
        maxConversationsPerPage,
        maxMessagesPerConversation,
        since: Math.floor((now.getTime() - lookbackMinutes * 60_000) / 1000),
    };

    const pages: FacebookSyncPageResult[] = [];

    for (const config of configs) {
        pages.push(
            await syncPage(config, window, {
                ...dependencies,
                client,
            }),
        );
    }

    return {
        ok: pages.every((page) => page.errors.length === 0),
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        lookback_minutes: lookbackMinutes,
        pages,
    };
}
