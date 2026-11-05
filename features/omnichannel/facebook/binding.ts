import 'server-only';
import { ChannelError, object, uuid } from './core';

export type PageBinding = {
    page: string;
    company: string;
    tokenEnv?: string;
    name?: string;
};

function parseConfiguredRows(raw: string | undefined): unknown[] {
    if (!raw?.trim()) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error();
    return parsed;
}

// Configuration is server-owned. META_ADS_PAGE_BINDINGS is additive so a Lead Ads
// rollout never replaces the existing Messenger Page bindings.
export function pageBindings(): PageBinding[] {
    try {
        const messengerRows = parseConfiguredRows(process.env.META_PAGE_BINDINGS);
        const leadAdsRows = parseConfiguredRows(process.env.META_ADS_PAGE_BINDINGS);
        const hasExplicitBindings = messengerRows.length > 0 || leadAdsRows.length > 0;
        const sources = hasExplicitBindings
            ? [messengerRows, leadAdsRows]
            : [[{
                page: process.env.META_PAGE_ID,
                company: process.env.OMNICHANNEL_COMPANY_ID,
                tokenEnv: 'META_PAGE_ACCESS_TOKEN',
                name: process.env.META_PAGE_NAME,
            }]];

        const byPage = new Map<string, PageBinding>();

        for (const source of sources) {
            if (source.length > 100) throw new Error();
            const seenInSource = new Set<string>();

            for (const value of source) {
                const row = object(value);
                if (typeof row.page !== 'string' || !/^\d{1,100}$/.test(row.page) || seenInSource.has(row.page)) {
                    throw new Error();
                }
                seenInSource.add(row.page);

                const company = uuid(row.company);
                let tokenEnv: string | undefined;
                if (row.tokenEnv !== undefined) {
                    if (typeof row.tokenEnv !== 'string' || !/^META_[A-Z0-9_]+_TOKEN$/.test(row.tokenEnv)) {
                        throw new Error();
                    }
                    tokenEnv = row.tokenEnv;
                }
                if (
                    row.name !== undefined
                    && (typeof row.name !== 'string' || !row.name.trim() || row.name.trim().length > 120)
                ) {
                    throw new Error();
                }

                const existing = byPage.get(row.page);
                if (existing && existing.company !== company) throw new Error();
                byPage.set(row.page, {
                    page: row.page,
                    company,
                    tokenEnv: tokenEnv ?? existing?.tokenEnv,
                    name: typeof row.name === 'string' ? row.name.trim() : existing?.name,
                });
            }
        }

        if (byPage.size === 0 || byPage.size > 100) throw new Error();
        return Array.from(byPage.values());
    } catch {
        throw new ChannelError('CHANNEL_NOT_CONFIGURED', 503);
    }
}

export function bindingsForCompany(company: string): PageBinding[] {
    return pageBindings().filter((value) => value.company === company);
}

export function binding(page?: string | null): PageBinding {
    const rows = pageBindings();
    if (!page && rows.length === 1) return rows[0];
    if (!page) throw new ChannelError('PAGE_REQUIRED');
    const row = rows.find((value) => value.page === page);
    if (!row) throw new ChannelError('NOT_FOUND', 404);
    return row;
}
