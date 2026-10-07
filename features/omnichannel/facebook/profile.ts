import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import type { PageBinding } from './binding';
import { sanitize } from './core';

const GENERIC_FACEBOOK_NAMES = new Set([
    'Khách Messenger',
    'Khách Facebook',
    'Khách hàng Facebook',
    'Khách hàng',
]);

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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
        const url = new URL(
            `https://graph.facebook.com/${version}/${encodeURIComponent(senderPsid)}`,
        );
        url.searchParams.set('fields', 'name');

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${token}`,
            },
            cache: 'no-store',
            signal: controller.signal,
        });

        if (!response.ok) return null;

        const payload = (await response.json()) as { name?: unknown };
        if (typeof payload.name !== 'string') return null;

        const normalized = payload.name
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
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
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
            .select('customer_id')
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
        if (!GENERIC_FACEBOOK_NAMES.has(currentName)) return;

        await client
            .from('customers')
            .update({ name: displayName })
            .eq('company_id', config.company)
            .eq('id', identity.customer_id);
    } catch {
        // Name enrichment is non-critical. The signed message has already been durably ingested.
    }
}
