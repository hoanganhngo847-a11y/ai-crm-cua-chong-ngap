import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import type { PageBinding } from './binding';
import { sanitize } from './core';

const GENERIC_FACEBOOK_NAMES = new Set([
    'Khách Messenger',
    'Khách Facebook',
    'Khách hàng Facebook',
    'Khách hàng',
    'Facebook User',
    'Unknown',
    'Ẩn danh',
]);

const PROFILE_CACHE_TTL_MS = 10 * 60 * 1000;
const PROFILE_CACHE_MAX_ENTRIES = 500;
const PROFILE_LOOKUP_TIMEOUT_MS = 3000;

type ProfileLookupResult = {
    name: string | null;
    failure: string | null;
};

const displayNameCache = new Map<string, { name: string; expiresAt: number }>();

function cacheKey(config: PageBinding, senderPsid: string): string {
    return `${config.page}:${senderPsid}`;
}

function readCachedDisplayName(key: string): string | null {
    const cached = displayNameCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
        displayNameCache.delete(key);
        return null;
    }
    return cached.name;
}

function cacheDisplayName(key: string, name: string): void {
    if (displayNameCache.size >= PROFILE_CACHE_MAX_ENTRIES) {
        const oldest = displayNameCache.keys().next().value;
        if (oldest) displayNameCache.delete(oldest);
    }
    displayNameCache.set(key, {
        name,
        expiresAt: Date.now() + PROFILE_CACHE_TTL_MS,
    });
}

function graphFailure(response: Response, payload: unknown): string {
    const error =
        payload && typeof payload === 'object' && !Array.isArray(payload)
            ? (payload as { error?: unknown }).error
            : null;
    const details =
        error && typeof error === 'object' && !Array.isArray(error)
            ? (error as { code?: unknown; error_subcode?: unknown })
            : null;
    const code = typeof details?.code === 'number' ? ` code=${details.code}` : '';
    const subcode =
        typeof details?.error_subcode === 'number'
            ? ` subcode=${details.error_subcode}`
            : '';
    return `status=${response.status}${code}${subcode}`;
}

async function requestGraph(
    url: URL,
    token: string,
): Promise<{ ok: true; payload: unknown } | { ok: false; failure: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROFILE_LOOKUP_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
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
            return { ok: false, failure: graphFailure(response, payload) };
        }

        return { ok: true, payload };
    } catch (error) {
        return {
            ok: false,
            failure:
                error instanceof Error && error.name === 'AbortError'
                    ? 'timeout'
                    : 'network_error',
        };
    } finally {
        clearTimeout(timeout);
    }
}

export function normalizeFacebookDisplayName(value: unknown): string | null {
    if (typeof value !== 'string') return null;

    const normalized = value
        .normalize('NFKC')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100);

    if (!normalized) return null;

    // Provider profile names are still user-controlled text. Apply the same bounded sanitizer
    // so a phone number embedded in a profile name cannot bypass Zero-Phone exposure rules.
    const safe = sanitize(normalized);
    if (safe.status !== 'SUCCEEDED' || !safe.content) return null;

    const displayName = safe.content.trim().slice(0, 100);
    if (!displayName || displayName.includes('[số liên hệ đã ẩn]')) return null;

    return displayName;
}

async function lookupDirectProfile(
    config: PageBinding,
    senderPsid: string,
    version: string,
    token: string,
): Promise<ProfileLookupResult> {
    const url = new URL(
        `https://graph.facebook.com/${version}/${encodeURIComponent(senderPsid)}`,
    );
    url.searchParams.set('fields', 'name');

    const result = await requestGraph(url, token);
    if (!result.ok) return { name: null, failure: result.failure };

    const payload =
        result.payload && typeof result.payload === 'object'
            ? (result.payload as { name?: unknown })
            : {};
    const name = normalizeFacebookDisplayName(payload.name);

    return { name, failure: name ? null : 'missing_name' };
}

/**
 * Some Page-scoped IDs cannot be read through GET /{psid}. This is common when the PSID was
 * created by a different app or when the app only has Standard Access for the customer.
 * The Page Conversations API still exposes the participant name for the same PSID, and it
 * works with the existing pages_messaging token, so use it as a free fallback.
 */
async function lookupConversationParticipant(
    config: PageBinding,
    senderPsid: string,
    version: string,
    token: string,
): Promise<ProfileLookupResult> {
    const url = new URL(
        `https://graph.facebook.com/${version}/${encodeURIComponent(config.page)}/conversations`,
    );
    url.searchParams.set('user_id', senderPsid);
    url.searchParams.set('fields', 'participants');
    url.searchParams.set('limit', '5');

    const result = await requestGraph(url, token);
    if (!result.ok) return { name: null, failure: result.failure };

    const payload =
        result.payload && typeof result.payload === 'object'
            ? (result.payload as { data?: unknown })
            : {};
    if (!Array.isArray(payload.data)) {
        return { name: null, failure: 'missing_data' };
    }

    for (const conversation of payload.data) {
        if (!conversation || typeof conversation !== 'object' || Array.isArray(conversation)) {
            continue;
        }

        const participants = (conversation as { participants?: unknown }).participants;
        if (!participants || typeof participants !== 'object' || Array.isArray(participants)) {
            continue;
        }

        const rows = (participants as { data?: unknown }).data;
        if (!Array.isArray(rows)) continue;

        for (const participant of rows) {
            if (
                !participant ||
                typeof participant !== 'object' ||
                Array.isArray(participant)
            ) {
                continue;
            }

            const { id, name } = participant as { id?: unknown; name?: unknown };
            if (id !== senderPsid || id === config.page) continue;

            const displayName = normalizeFacebookDisplayName(name);
            if (displayName) return { name: displayName, failure: null };
        }
    }

    return { name: null, failure: 'participant_not_found' };
}

/**
 * Resolve the Page-scoped Messenger user's display name from Meta Graph API.
 * This is best-effort metadata enrichment: profile lookup failures must never block webhook ingestion.
 */
export async function lookupFacebookDisplayName(
    config: PageBinding,
    senderPsid: string,
): Promise<string | null> {
    const version = process.env.META_GRAPH_VERSION?.trim();
    const token = process.env[config.tokenEnv]?.trim();

    if (
        !version ||
        !/^v\d+\.\d+$/.test(version) ||
        !token ||
        !/^\d+$/.test(senderPsid)
    ) {
        return null;
    }

    const key = cacheKey(config, senderPsid);
    const cached = readCachedDisplayName(key);
    if (cached) return cached;

    const direct = await lookupDirectProfile(config, senderPsid, version, token);
    if (direct.name) {
        cacheDisplayName(key, direct.name);
        return direct.name;
    }

    const fallback = await lookupConversationParticipant(
        config,
        senderPsid,
        version,
        token,
    );
    if (fallback.name) {
        cacheDisplayName(key, fallback.name);
        return fallback.name;
    }

    console.warn(
        `[facebook-profile] lookup_failed direct=${direct.failure || 'unknown'} fallback=${fallback.failure || 'unknown'}`,
    );
    return null;
}

/**
 * Existing staging conversations may already have the old placeholder name. Promote only those
 * generic placeholders; never overwrite a name that staff have manually curated in the CRM.
 */
export async function promoteFacebookCustomerDisplayName(
    config: PageBinding,
    senderPsid: string,
    displayName: string | null,
): Promise<void> {
    if (!displayName) return;

    try {
        const client = createAdminClient();
        const externalIdentity = `${config.page}:${senderPsid}`;

        const { data: identity } = await client
            .from('identities')
            .select('id, customer_id, display_name')
            .eq('company_id', config.company)
            .eq('channel', 'FACEBOOK')
            .eq('external_id', externalIdentity)
            .maybeSingle();

        if (!identity?.customer_id) return;

        const { data: customer } = await client
            .from('customers')
            .select('name')
            .eq('company_id', config.company)
            .eq('id', identity.customer_id)
            .maybeSingle();

        const currentName = customer?.name?.trim() || '';
        const shouldPromoteCustomer =
            !currentName || GENERIC_FACEBOOK_NAMES.has(currentName);
        const shouldPromoteIdentity = !identity.display_name?.trim();

        if (!shouldPromoteCustomer && !shouldPromoteIdentity) return;

        if (shouldPromoteCustomer) {
            await client
                .from('customers')
                .update({ name: displayName })
                .eq('company_id', config.company)
                .eq('id', identity.customer_id);
        }

        if (shouldPromoteIdentity) {
            await client
                .from('identities')
                .update({ display_name: displayName })
                .eq('company_id', config.company)
                .eq('id', identity.id);
        }
    } catch {
        // Name enrichment is non-critical. The signed message has already been durably ingested.
    }
}
