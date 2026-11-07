import 'server-only';

// Reviewed against Meta's version tables on 2026-10-30. Marketing has a
// shorter support window; never inherit its version from Messenger config.
export function marketingVersion(): string {
    const version = process.env.META_MARKETING_VERSION?.trim() || 'v26.0';
    if (!['v25.0', 'v26.0'].includes(version)) throw new Error('UNSUPPORTED_META_MARKETING_VERSION');
    return version;
}

export function graphVersion(): string {
    const version = process.env.META_GRAPH_VERSION?.trim() || 'v26.0';
    if (!/^v(21|22|23|24|25|26)\.0$/.test(version)) throw new Error('UNSUPPORTED_META_GRAPH_VERSION');
    return version;
}

/** Do not pass upstream Error objects to console, responses or persisted errors. */
export function redactMetaError(error: unknown, secrets: string[] = []): string {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of secrets.filter(Boolean)) {
        for (const value of [secret, encodeURIComponent(secret)]) message = message.split(value).join('[REDACTED]');
    }
    return message
        .replace(/(access_token|client_secret|fb_exchange_token)(["'\s]*[:=]["'\s]*)([^&\s"'<>]+)/gi, '$1$2[REDACTED]')
        .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]');
}

/** Meta next links are untrusted and often contain tokens. Keep the original
 * token in a header and never forward credentials to another host or edge. */
export function metaPageUrl(value: string, initial: URL): URL {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('INVALID_META_PAGINATION_URL'); }
    if (url.origin !== 'https://graph.facebook.com' || url.pathname !== initial.pathname || url.username || url.password || url.hash) {
        throw new Error('INVALID_META_PAGINATION_URL');
    }
    url.searchParams.delete('access_token');
    return url;
}

export async function fetchMetaPages<T>(
    initial: URL,
    token: string,
    fetchFn: typeof fetch = fetch,
    maxPages = 50,
): Promise<T[]> {
    const results: T[] = [];
    let next: string | null = initial.toString();
    const visited = new Set<string>();
    while (next) {
        if (visited.size >= maxPages) throw new Error('META_INCOMPLETE_SYNC_PAGINATION_LIMIT');
        const url = metaPageUrl(next, initial);
        if (visited.has(url.toString())) throw new Error('META_INCOMPLETE_SYNC_PAGINATION_CYCLE');
        visited.add(url.toString());
        let response: Response;
        try {
            response = await fetchFn(url.toString(), {
                headers: { Authorization: `Bearer ${token}` },
                cache: 'no-store',
                redirect: 'error',
                signal: AbortSignal.timeout(15_000),
            });
        } catch { throw new Error('META_PAGE_REQUEST_FAILED'); }
        // Upstream bodies can echo tokens/URLs. Log a bounded code only.
        if (!response.ok) throw new Error(`GRAPH_PAGE_FETCH_FAILED_${response.status}`);
        let payload: { data?: T[]; paging?: { next?: unknown }; error?: unknown };
        try { payload = await response.json(); } catch { throw new Error('META_INCOMPLETE_SYNC_INVALID_JSON'); }
        if (!payload || payload.error || !Array.isArray(payload.data) ||
            (payload.paging?.next != null && typeof payload.paging.next !== 'string')) {
            throw new Error('META_INCOMPLETE_SYNC_INVALID_PAGE');
        }
        results.push(...payload.data);
        next = payload.paging?.next as string || null;
    }
    return results;
}
