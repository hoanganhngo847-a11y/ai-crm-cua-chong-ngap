import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { createAdminClient } from '@/lib/supabase/admin';
import { pageBindings, type PageBinding } from './binding';
import { sanitize } from './core';
import { processFacebookInboundPhonePrivacy } from './phone-intake';
import {
    normalizeFacebookDisplayName,
    promoteFacebookCustomerDisplayName,
} from './profile';

const GRAPH_TIMEOUT_MS = 10_000;
const GRAPH_PAGE_LIMIT = 100;
const MAX_GRAPH_PAGES = 10;
const DEFAULT_LOOKBACK_MINUTES = 5;
const MAX_LOOKBACK_MINUTES = 7 * 24 * 60;
const INITIAL_FOLDER_BACKFILL_MINUTES = 24 * 60;
const DEFAULT_MAX_CONVERSATIONS = 200;
const DEFAULT_MAX_MESSAGES = 200;

export const DEFAULT_FACEBOOK_FOLDERS = ['inbox', 'other', 'pending'];

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
    folders?: string[];
    maxConversationsPerPage?: number;
    maxMessagesPerConversation?: number;
    dryRun?: boolean;
};

export type FacebookSyncDependencies = {
    client?: SupabaseClient;
    fetcher?: typeof fetch;
    now?: Date;
    promoteDisplayName?: typeof promoteFacebookCustomerDisplayName;
};

export type FacebookSyncFolderResult = {
    folder: string;
    conversations: number;
    messages_seen: number;
    messages_ingested: number;
    messages_skipped: number;
    inbound_ingested: number;
    outbound_ingested: number;
    errors: string[];
};

export type FacebookSyncPageResult = {
    page: string;
    conversations: number;
    messages_seen: number;
    messages_ingested: number;
    messages_skipped: number;
    inbound_ingested: number;
    outbound_ingested: number;
    errors: string[];
    folders?: FacebookSyncFolderResult[];
};

export type FacebookSyncResult = {
    ok: boolean;
    started_at: string;
    finished_at: string;
    lookback_minutes: number;
    dry_run?: boolean;
    pages: FacebookSyncPageResult[];
};

type SyncWindow = {
    lookbackMinutes: number;
    maxConversationsPerPage: number;
    maxMessagesPerConversation: number;
    sinceMs: number;
    isExplicitLookback?: boolean;
};

type IngestOutcome = 'ingested' | 'duplicate' | 'skipped';

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

async function ingestInboundMessage(
    config: PageBinding,
    conversationId: string,
    customerPsid: string,
    message: GraphMessage,
    client: SupabaseClient,
    dryRun: boolean,
    errors: string[],
): Promise<IngestOutcome> {
    const mid = typeof message.id === 'string' ? message.id.trim() : '';
    if (!mid || mid.length > 250) return 'skipped';

    const occurred = graphTime(message.created_time);
    if (!occurred) return 'skipped';

    if (dryRun) return 'ingested';

    const content = messageContent(message);
    const privacy = processFacebookInboundPhonePrivacy(content);

    const { data, error } = await client.rpc('han_ingest', {
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
            from: { id: customerPsid },
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

    if (error) {
        if (error.message.includes('IDEMPOTENCY_CONFLICT')) {
            return 'duplicate';
        }

        errors.push(`han_ingest:${error.message.slice(0, 120)}`);
        return 'skipped';
    }

    const status = asRecord(data)?.status;

    if (status === 'ACCEPTED') return 'ingested';
    if (status === 'PROCESSED' || status === 'IDENTITY_REVIEW') {
        return 'duplicate';
    }

    errors.push(
        `han_ingest:unexpected_status=${String(status ?? 'missing').slice(0, 40)}`,
    );
    return 'skipped';
}

async function ingestOutboundFallback(
    config: PageBinding,
    customerPsid: string,
    mid: string,
    content: string,
    safeContent: string | null,
    safeStatus: string,
    occurred: string,
    payload: Record<string, unknown>,
    client: SupabaseClient,
    errors: string[],
): Promise<IngestOutcome> {
    const key = `${config.page}:${mid}`;
    const externalId = `${config.page}:${customerPsid}`;

    try {
        // Idempotency check: interaction already recorded
        const { data: existing } = await client
            .from('interactions')
            .select('id')
            .eq('company_id', config.company)
            .eq('channel', 'FACEBOOK')
            .eq('external_ref', key)
            .maybeSingle();

        if (existing?.id) return 'duplicate';

        // Reconciliation: check if outbox recorded this mid from CRM send
        const { data: outbox } = await client
            .from('han_outbox')
            .select('interaction_id')
            .eq('company_id', config.company)
            .eq('provider_mid', mid)
            .maybeSingle();

        if (outbox?.interaction_id) {
            await client
                .from('interactions')
                .update({ external_ref: key })
                .eq('id', outbox.interaction_id)
                .is('external_ref', null);
            return 'duplicate';
        }

        // Resolve customer
        let customerId: string | null = null;
        const { data: identity } = await client
            .from('identities')
            .select('customer_id')
            .eq('company_id', config.company)
            .eq('channel', 'FACEBOOK')
            .eq('external_id', externalId)
            .maybeSingle();

        customerId = identity?.customer_id ?? null;

        if (!customerId) {
            const { data: newCust, error: custErr } = await client
                .from('customers')
                .insert({
                    company_id: config.company,
                    name: 'Khách Messenger',
                    source: 'FACEBOOK',
                    stage: 'awareness',
                })
                .select('id')
                .single();

            if (custErr || !newCust) {
                errors.push(`outbound_fallback:cust_err=${custErr?.message || 'unknown'}`);
                return 'skipped';
            }
            customerId = newCust.id;

            await client.from('identities').insert({
                company_id: config.company,
                customer_id: customerId,
                channel: 'FACEBOOK',
                external_id: externalId,
                verified: false,
            });
        }

        // Resolve conversation
        let conversationId: string | null = null;
        const { data: conv } = await client
            .from('conversations')
            .select('id, last_message_at')
            .eq('company_id', config.company)
            .eq('channel', 'FACEBOOK')
            .eq('external_conversation_id', externalId)
            .maybeSingle();

        if (conv) {
            conversationId = conv.id;
            const currentLast = conv.last_message_at ? new Date(conv.last_message_at).getTime() : 0;
            if (new Date(occurred).getTime() > currentLast) {
                await client
                    .from('conversations')
                    .update({ last_message_at: occurred })
                    .eq('id', conversationId);
            }
        } else {
            const { data: newConv, error: convErr } = await client
                .from('conversations')
                .insert({
                    company_id: config.company,
                    customer_id: customerId,
                    channel: 'FACEBOOK',
                    external_conversation_id: externalId,
                    last_message_at: occurred,
                    unread_count: 0,
                })
                .select('id')
                .single();

            if (convErr || !newConv) {
                errors.push(`outbound_fallback:conv_err=${convErr?.message || 'unknown'}`);
                return 'skipped';
            }
            conversationId = newConv.id;
        }

        // Insert OUTBOUND interaction
        const { data: interaction, error: intErr } = await client
            .from('interactions')
            .insert({
                company_id: config.company,
                customer_id: customerId,
                conversation_id: conversationId,
                channel: 'FACEBOOK',
                type: 'MESSAGE',
                direction: 'OUTBOUND',
                sanitized_content: safeContent,
                sanitization_status: safeStatus,
                sanitized_at: safeStatus === 'SUCCEEDED' ? new Date().toISOString() : null,
                sanitizer_version: 'han-bounded-v2',
                external_ref: key,
                actor_type: 'SALE',
                created_at: occurred,
            })
            .select('id')
            .single();

        if (intErr) {
            if (intErr.message?.includes('duplicate key') || intErr.code === '23505') {
                return 'duplicate';
            }
            errors.push(`outbound_fallback:int_err=${intErr.message}`);
            return 'skipped';
        }

        if (interaction?.id) {
            try {
                await client.from('interaction_raw_contents').insert({
                    interaction_id: interaction.id,
                    company_id: config.company,
                    raw_content: content,
                    raw_payload: payload,
                });
            } catch {
                // Non-critical raw zone insertion
            }

            try {
                await client
                    .from('response_sla_windows')
                    .update({
                        state: 'SALE_RESPONDED',
                        sale_response_interaction_id: interaction.id,
                        resolved_at: occurred,
                        dispatch_state: 'PROVIDER_ACCEPTED',
                    })
                    .eq('conversation_id', conversationId)
                    .eq('state', 'OPEN')
                    .lte('started_at', occurred);
            } catch {
                // Non-critical SLA update
            }
        }

        return 'ingested';
    } catch (err) {
        errors.push(`outbound_fallback:ex=${err instanceof Error ? err.message : 'unknown'}`);
        return 'skipped';
    }
}

async function ingestOutboundMessage(
    config: PageBinding,
    conversationId: string,
    customerPsid: string,
    message: GraphMessage,
    client: SupabaseClient,
    dryRun: boolean,
    errors: string[],
): Promise<IngestOutcome> {
    const mid = typeof message.id === 'string' ? message.id.trim() : '';
    if (!mid || mid.length > 250) return 'skipped';

    const occurred = graphTime(message.created_time);
    if (!occurred) return 'skipped';

    if (dryRun) return 'ingested';

    const content = messageContent(message);
    const safe = sanitize(content);
    const safeContent = safe.status === 'SUCCEEDED' ? safe.content : null;
    const safeStatus = safe.status;

    const payload = {
        id: mid,
        created_time: occurred,
        from: { id: config.page },
        to: { id: customerPsid },
        message: content,
        has_attachments:
            Array.isArray(message.attachments) && message.attachments.length > 0,
        conversation_id: conversationId,
        sync_source: 'graph_poll_outbound',
    };

    // 1. Prefer atomic database operation via RPC han_ingest_outbound
    const { data, error } = await client.rpc('han_ingest_outbound', {
        p_company: config.company,
        p_channel: 'FACEBOOK',
        p_page: config.page,
        p_customer_psid: customerPsid,
        p_key: `${config.page}:${mid}`,
        p_content: content,
        p_safe: safeContent,
        p_safe_status: safeStatus,
        p_occurred: occurred,
        p_payload: payload,
    });

    if (!error) {
        const status = asRecord(data)?.status;
        if (status === 'ACCEPTED') return 'ingested';
        if (status === 'PROCESSED') return 'duplicate';
        errors.push(
            `han_ingest_outbound:unexpected_status=${String(status ?? 'missing').slice(0, 40)}`,
        );
        return 'skipped';
    }

    if (error.message.includes('IDEMPOTENCY_CONFLICT')) {
        return 'duplicate';
    }

    // If RPC is missing (e.g. before migration runs on target environment), use graceful fallback
    const isRpcMissing =
        error.code === 'PGRST202' ||
        error.message.includes('Could not find the function') ||
        error.message.includes('function public.han_ingest_outbound') ||
        error.message.includes('schema cache');

    if (!isRpcMissing) {
        errors.push(`han_ingest_outbound:${error.message.slice(0, 120)}`);
        return 'skipped';
    }

    return ingestOutboundFallback(
        config,
        customerPsid,
        mid,
        content,
        safeContent,
        safeStatus,
        occurred,
        payload,
        client,
        errors,
    );
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
    dryRun: boolean,
    folderResult: FacebookSyncFolderResult,
    folderSinceMs?: number,
): Promise<void> {
    const conversationId =
        typeof conversation.id === 'string' ? conversation.id.trim() : '';
    if (!conversationId) {
        folderResult.errors.push('conversation_id_missing');
        return;
    }

    const customer = conversationCustomer(conversation, config.page);
    if (!customer) {
        folderResult.errors.push('conversation_participants_ambiguous');
        return;
    }

    const effectiveSinceMs = folderSinceMs ?? window.sinceMs;

    let after: string | null = null;
    let remaining = window.maxMessagesPerConversation;
    let graphPages = 0;
    let reachedWindowBoundary = false;

    while (remaining > 0 && graphPages < MAX_GRAPH_PAGES && !reachedWindowBoundary) {
        const url = graphUrl(version, conversationId, 'messages');
        url.searchParams.set('fields', 'id,message,from,created_time,attachments');
        url.searchParams.set('limit', String(Math.min(GRAPH_PAGE_LIMIT, remaining)));
        if (after) url.searchParams.set('after', after);

        const response = await requestGraph(url, token, fetcher);
        if (!response.ok) {
            folderResult.errors.push(response.failure);
            break;
        }

        const list = readList<GraphMessage>(response.payload);

        // Graph ignores `since` for Page conversation messages and returns newest first,
        // so the lookback window must be enforced client-side.
        for (const message of list.rows) {
            const created = graphTime(message.created_time);
            if (!created) continue;

            if (Date.parse(created) < effectiveSinceMs) {
                reachedWindowBoundary = true;
                break;
            }

            if (remaining <= 0) break;
            remaining -= 1;
            folderResult.messages_seen += 1;

            const fromId =
                typeof message.from?.id === 'string' ? message.from.id.trim() : '';

            let outcome: IngestOutcome = 'skipped';

            if (fromId === customer.psid) {
                // Inbound customer message
                outcome = await ingestInboundMessage(
                    config,
                    conversationId,
                    customer.psid,
                    message,
                    client,
                    dryRun,
                    folderResult.errors,
                );
                if (outcome === 'ingested') {
                    folderResult.messages_ingested += 1;
                    folderResult.inbound_ingested += 1;
                } else {
                    folderResult.messages_skipped += 1;
                }
            } else if (fromId === config.page) {
                // Outbound Page administrator message
                outcome = await ingestOutboundMessage(
                    config,
                    conversationId,
                    customer.psid,
                    message,
                    client,
                    dryRun,
                    folderResult.errors,
                );
                if (outcome === 'ingested') {
                    folderResult.messages_ingested += 1;
                    folderResult.outbound_ingested += 1;
                } else {
                    folderResult.messages_skipped += 1;
                }
            } else {
                folderResult.messages_skipped += 1;
            }
        }

        graphPages += 1;
        if (!list.hasNext || !list.after) break;
        after = list.after;
    }

    if (customer.name && !dryRun) {
        await promoteDisplayName(config, customer.psid, customer.name);
    }
}

async function resolveFolderWindow(
    client: SupabaseClient,
    config: PageBinding,
    folder: string,
    window: SyncWindow,
    now: Date,
): Promise<{ folderSinceMs: number; isBackfill: boolean }> {
    if (window.isExplicitLookback) {
        return { folderSinceMs: window.sinceMs, isBackfill: false };
    }

    try {
        const { data, error } = await client.rpc('facebook_get_sync_checkpoint', {
            p_company_id: config.company,
            p_page_id: config.page,
            p_folder: folder,
        });

        if (error || !data) {
            // No checkpoint yet for this folder (e.g. initial backfill for 'other' or 'pending').
            const backfillSinceMs = now.getTime() - INITIAL_FOLDER_BACKFILL_MINUTES * 60_000;
            return { folderSinceMs: backfillSinceMs, isBackfill: true };
        }

        const lastSyncedMs = Date.parse(data as string);
        if (!Number.isFinite(lastSyncedMs)) {
            return { folderSinceMs: window.sinceMs, isBackfill: false };
        }

        const elapsedMinutes = Math.ceil((now.getTime() - lastSyncedMs) / (60 * 1000));
        const effectiveMinutes = Math.min(
            MAX_LOOKBACK_MINUTES,
            Math.max(DEFAULT_LOOKBACK_MINUTES, elapsedMinutes + 2),
        );
        const dynamicSinceMs = now.getTime() - effectiveMinutes * 60_000;

        return {
            folderSinceMs: dynamicSinceMs,
            isBackfill: elapsedMinutes > DEFAULT_LOOKBACK_MINUTES,
        };
    } catch {
        return { folderSinceMs: window.sinceMs, isBackfill: false };
    }
}

async function syncPage(
    config: PageBinding,
    window: SyncWindow,
    folders: string[],
    dryRun: boolean,
    now: Date,
    dependencies: FacebookSyncDependencies,
): Promise<FacebookSyncPageResult> {
    const pageResult: FacebookSyncPageResult = {
        page: config.page,
        conversations: 0,
        messages_seen: 0,
        messages_ingested: 0,
        messages_skipped: 0,
        inbound_ingested: 0,
        outbound_ingested: 0,
        errors: [],
        folders: [],
    };

    const version = process.env.META_GRAPH_VERSION?.trim();
    const token = process.env[config.tokenEnv]?.trim();

    if (!version || !/^v\d+\.\d+$/.test(version)) {
        pageResult.errors.push('graph_version_missing');
        return pageResult;
    }

    if (!token) {
        pageResult.errors.push('page_token_missing');
        return pageResult;
    }

    const client = dependencies.client ?? createAdminClient();
    const fetcher = dependencies.fetcher ?? fetch;
    const promoteDisplayName =
        dependencies.promoteDisplayName ?? promoteFacebookCustomerDisplayName;

    const seenConversations = new Set<string>();

    for (const folder of folders) {
        const folderResult: FacebookSyncFolderResult = {
            folder,
            conversations: 0,
            messages_seen: 0,
            messages_ingested: 0,
            messages_skipped: 0,
            inbound_ingested: 0,
            outbound_ingested: 0,
            errors: [],
        };

        const { folderSinceMs, isBackfill } = await resolveFolderWindow(
            client,
            config,
            folder,
            window,
            now,
        );

        let after: string | null = null;
        let remaining = window.maxConversationsPerPage;
        let graphPages = 0;
        let reachedWindowBoundary = false;

        while (remaining > 0 && graphPages < MAX_GRAPH_PAGES && !reachedWindowBoundary) {
            const url = graphUrl(version, config.page, 'conversations');
            url.searchParams.set('platform', 'messenger');
            url.searchParams.set('folder', folder);
            url.searchParams.set('fields', 'id,participants,updated_time');
            url.searchParams.set('limit', String(Math.min(GRAPH_PAGE_LIMIT, remaining)));
            if (after) url.searchParams.set('after', after);

            const response = await requestGraph(url, token, fetcher);
            if (!response.ok) {
                folderResult.errors.push(`folder_failed:${folder}:${response.failure}`);
                break;
            }

            const list = readList<GraphConversation>(response.payload);

            // Graph ignores `since` for Page conversations and returns them ordered by
            // updated_time desc, so stop at the first conversation older than the window.
            for (const conversation of list.rows) {
                const updated = graphTime(conversation.updated_time);
                if (!updated) continue;

                if (Date.parse(updated) < folderSinceMs) {
                    reachedWindowBoundary = true;
                    break;
                }

                const convId =
                    typeof conversation.id === 'string' ? conversation.id.trim() : '';

                if (convId && seenConversations.has(convId)) {
                    // Prevent duplicate processing across folder queries
                    continue;
                }
                if (convId) seenConversations.add(convId);

                if (remaining <= 0) break;
                remaining -= 1;
                folderResult.conversations += 1;

                await syncConversation(
                    config,
                    conversation,
                    window,
                    client,
                    fetcher,
                    token,
                    version,
                    promoteDisplayName,
                    dryRun,
                    folderResult,
                    folderSinceMs,
                );
            }

            graphPages += 1;
            if (!list.hasNext || !list.after) break;
            after = list.after;
        }

        if (!dryRun && folderResult.errors.length === 0) {
            try {
                await client.rpc('facebook_set_sync_checkpoint', {
                    p_company_id: config.company,
                    p_page_id: config.page,
                    p_folder: folder,
                    p_last_synced_at: now.toISOString(),
                });
            } catch {
                // Checkpoint persistence is best-effort defense-in-depth
            }
        }

        console.info(
            `[facebook-sync] page=${config.page} folder=${folder} conversations=${folderResult.conversations} seen=${folderResult.messages_seen} ingested=${folderResult.messages_ingested} (in=${folderResult.inbound_ingested},out=${folderResult.outbound_ingested}) skipped=${folderResult.messages_skipped} errors=${folderResult.errors.length}${isBackfill ? ' backfill=true' : ''}`,
        );

        pageResult.folders?.push(folderResult);
        pageResult.conversations += folderResult.conversations;
        pageResult.messages_seen += folderResult.messages_seen;
        pageResult.messages_ingested += folderResult.messages_ingested;
        pageResult.messages_skipped += folderResult.messages_skipped;
        pageResult.inbound_ingested += folderResult.inbound_ingested;
        pageResult.outbound_ingested += folderResult.outbound_ingested;
        if (folderResult.errors.length > 0) {
            pageResult.errors.push(...folderResult.errors);
        }
    }

    return pageResult;
}

/**
 * Pull recent Page conversations directly from Meta Graph API.
 *
 * Folder-aware polling across inbox, other, and pending message request folders.
 * Ingests inbound messages (customer -> Page) and outbound replies (Page admin -> customer).
 * Replays, duplicates, and CRM-originated sends are reconciled idempotently without duplicate rows.
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
    const folders = (options.folders ?? DEFAULT_FACEBOOK_FOLDERS)
        .map((folder) => folder.trim().toLowerCase())
        .filter(Boolean);
    const dryRun = Boolean(options.dryRun);

    const configs = pageBindings().filter(
        (config) => selectedPages.size === 0 || selectedPages.has(config.page),
    );

    const client = dependencies.client ?? createAdminClient();
    const isExplicitLookback = typeof options.lookbackMinutes === 'number';
    const window: SyncWindow = {
        lookbackMinutes,
        maxConversationsPerPage,
        maxMessagesPerConversation,
        sinceMs: now.getTime() - lookbackMinutes * 60_000,
        isExplicitLookback,
    };

    const pages: FacebookSyncPageResult[] = [];

    for (const config of configs) {
        pages.push(
            await syncPage(config, window, folders, dryRun, now, {
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
        dry_run: dryRun,
        pages,
    };
}
