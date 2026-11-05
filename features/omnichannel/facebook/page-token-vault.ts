import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { createAdminClient } from '@/lib/supabase/admin';
import { ChannelError, uuid } from './core';
import { decryptToken, encryptToken } from './token-vault';

// The current private Meta token vault is keyed by (company_id, ad_account_id).
// Reserve a disjoint key namespace for Page tokens; Meta Ad Account IDs use act_*.
const PAGE_TOKEN_STORAGE_PREFIX = '__page__:';

export function pageTokenStorageKey(pageId: string): string {
    if (typeof pageId !== 'string' || !/^\d{1,100}$/.test(pageId)) {
        throw new ChannelError('CHANNEL_NOT_CONFIGURED', 503);
    }
    return PAGE_TOKEN_STORAGE_PREFIX + pageId;
}

function legacyToken(tokenEnv?: string): string | null {
    if (!tokenEnv || !/^META_[A-Z0-9_]+_TOKEN$/.test(tokenEnv)) return null;
    return process.env[tokenEnv]?.trim() || null;
}

export async function storeMetaPageToken(
    companyId: string,
    pageId: string,
    accessToken: string,
    tokenExpiresAt?: string | null,
    client?: SupabaseClient,
): Promise<void> {
    const company = uuid(companyId);
    const storageKey = pageTokenStorageKey(pageId);
    const token = typeof accessToken === 'string' ? accessToken.trim() : '';
    if (!token) throw new ChannelError('CHANNEL_NOT_CONFIGURED', 503);

    const expiresAt = tokenExpiresAt?.trim() || null;
    if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) {
        throw new ChannelError('CHANNEL_NOT_CONFIGURED', 503);
    }

    let encryptedAccessToken: string;
    try {
        encryptedAccessToken = encryptToken(token);
    } catch {
        throw new ChannelError('CHANNEL_NOT_CONFIGURED', 503);
    }

    let admin: SupabaseClient;
    try {
        admin = client ?? createAdminClient();
    } catch {
        throw new ChannelError('CHANNEL_NOT_CONFIGURED', 503);
    }

    const { error } = await admin.rpc('store_meta_ad_account_token', {
        p_company_id: company,
        p_ad_account_id: storageKey,
        p_encrypted_access_token: encryptedAccessToken,
        p_token_expires_at: expiresAt,
    });

    if (error) throw new ChannelError('CHANNEL_NOT_CONFIGURED', 503);
}

export async function getMetaPageToken(
    companyId: string,
    pageId: string,
    tokenEnv?: string,
    client?: SupabaseClient,
): Promise<string> {
    const company = uuid(companyId);
    const storageKey = pageTokenStorageKey(pageId);
    const fallback = legacyToken(tokenEnv);

    let admin: SupabaseClient;
    try {
        admin = client ?? createAdminClient();
    } catch {
        if (fallback) return fallback;
        throw new ChannelError('CHANNEL_NOT_CONFIGURED', 503);
    }

    let result;
    try {
        result = await admin.rpc('get_meta_ad_account_token', {
            p_company_id: company,
            p_ad_account_id: storageKey,
        });
    } catch {
        throw new ChannelError('CHANNEL_NOT_CONFIGURED', 503);
    }

    if (result.error) {
        // Backward compatibility for a deployment that has not applied the Meta
        // token-vault migration yet. Other database errors fail closed.
        if (fallback && result.error.code === 'PGRST202') return fallback;
        throw new ChannelError('CHANNEL_NOT_CONFIGURED', 503);
    }

    const row = Array.isArray(result.data)
        ? result.data[0] as Record<string, unknown> | undefined
        : result.data as Record<string, unknown> | null;
    const encrypted = row?.encrypted_access_token;

    if (typeof encrypted === 'string' && encrypted.length > 0) {
        if (row?.token_expires_at != null) {
            const expiresAt = Date.parse(String(row.token_expires_at));
            if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
                throw new ChannelError('CHANNEL_NOT_CONFIGURED', 503);
            }
        }

        try {
            const token = decryptToken(encrypted);
            if (token.trim()) return token;
        } catch {
            throw new ChannelError('CHANNEL_NOT_CONFIGURED', 503);
        }
        throw new ChannelError('CHANNEL_NOT_CONFIGURED', 503);
    }

    if (fallback) return fallback;
    throw new ChannelError('CHANNEL_NOT_CONFIGURED', 503);
}
