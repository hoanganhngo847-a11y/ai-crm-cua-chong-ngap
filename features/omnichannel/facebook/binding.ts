import 'server-only';
import { ChannelError, object, uuid } from './core';

export type PageBinding = { page: string; company: string; tokenEnv: string };

// Configuration is server-owned. A page selector never supplies tenant authority.
export function pageBindings(): PageBinding[] {
    try {
        const configured = process.env.META_PAGE_BINDINGS;
        const rows: unknown = configured
            ? JSON.parse(configured)
            : [{
                page: process.env.META_PAGE_ID,
                company: process.env.OMNICHANNEL_COMPANY_ID,
                tokenEnv: 'META_PAGE_ACCESS_TOKEN',
            }];
        if (!Array.isArray(rows) || rows.length === 0 || rows.length > 100) throw new Error();
        const seen = new Set<string>();
        return rows.map((value) => {
            const row = object(value);
            if (typeof row.page !== 'string' || !/^\d{1,100}$/.test(row.page) || seen.has(row.page)) throw new Error();
            if (typeof row.tokenEnv !== 'string' || !/^META_[A-Z0-9_]+_TOKEN$/.test(row.tokenEnv)) throw new Error();
            seen.add(row.page);
            return { page: row.page, company: uuid(row.company), tokenEnv: row.tokenEnv };
        });
    } catch {
        throw new ChannelError('CHANNEL_NOT_CONFIGURED', 503);
    }
}

export function binding(page?: string | null): PageBinding {
    const rows = pageBindings();
    if (!page && rows.length === 1) return rows[0];
    if (!page) throw new ChannelError('PAGE_REQUIRED');
    const row = rows.find((value) => value.page === page);
    if (!row) throw new ChannelError('NOT_FOUND', 404);
    return row;
}
