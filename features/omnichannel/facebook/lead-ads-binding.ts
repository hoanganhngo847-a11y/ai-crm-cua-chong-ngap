import 'server-only';

import { pageBindings, type PageBinding } from './binding';
import { ChannelError, object, uuid } from './core';

const RELEASE_COMPANY = 'de6a7bf3-b5bc-418d-92d6-f9b241472598';
const RELEASE_AD_ACCOUNT = 'act_996324396811261';
const RELEASE_PAGES = new Set([
    '1418087751743574',
    '1026991374010112',
    '654520554683416',
    '1014780055265237',
]);

export type LeadAdsPageBinding = PageBinding & { leadAdsEnabled: true };

function configRows(raw: string | undefined) {
    if (!raw?.trim()) return [];
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length > 100) throw new Error('INVALID_BINDINGS');
    return rows.map(object);
}

export function leadAdsPageBindings(): LeadAdsPageBinding[] {
    try {
        const explicit = configRows(process.env.META_ADS_PAGE_BINDINGS);
        const optedIn = configRows(process.env.META_PAGE_BINDINGS).filter(row => row.leadAdsEnabled === true);
        if (explicit.length === 0 && optedIn.length === 0) return [];

        const messenger = process.env.META_PAGE_BINDINGS || process.env.META_PAGE_ID ? pageBindings() : [];
        const legacy = new Map(messenger.map(row => [row.page, row]));
        const ads = new Map<string, LeadAdsPageBinding>();
        const explicitPages = new Set<string>();

        for (const row of explicit) {
            if (typeof row.page !== 'string' || explicitPages.has(row.page)) throw new Error('DUPLICATE_PAGE');
            explicitPages.add(row.page);
        }
        for (const row of [...optedIn, ...explicit]) {
            const { page, tokenEnv, name } = row;
            const company = uuid(row.company);
            if (typeof page !== 'string' || !/^\d{1,100}$/.test(page) ||
                typeof tokenEnv !== 'string' || !/^META_[A-Z0-9_]+_TOKEN$/.test(tokenEnv) ||
                (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 120))) {
                throw new Error('INVALID_PAGE_BINDING');
            }
            const existing = legacy.get(page);
            if ((existing && existing.company !== company) || (company === RELEASE_COMPANY && !RELEASE_PAGES.has(page))) {
                throw new Error('PAGE_NOT_ALLOWED');
            }
            ads.set(page, {
                page, company, tokenEnv: existing?.tokenEnv ?? tokenEnv,
                name: typeof name === 'string' ? name.trim() : existing?.name,
                leadAdsEnabled: true,
            });
        }
        return [...ads.values()];
    } catch {
        throw new ChannelError('CHANNEL_NOT_CONFIGURED', 503);
    }
}

export function isLeadAdsAdAccountAllowed(company: string, adAccountId: string): boolean {
    return company !== RELEASE_COMPANY || adAccountId === RELEASE_AD_ACCOUNT;
}

// The live IDs must come from the reviewed owner inventory. Fixtures for
// independent tenants do not stand in for the six approved Production forms.
export function assertApprovedLeadAdsForm(config: LeadAdsPageBinding, formId: string): void {
    if (config.company !== RELEASE_COMPANY) return;

    let forms: Record<string, unknown>;
    try {
        forms = object(JSON.parse(process.env.META_ADS_APPROVED_FORMS || ''));
    } catch {
        throw new ChannelError('LEAD_ADS_FORMS_NOT_CONFIGURED', 503);
    }

    const seen = new Set<string>();
    for (const page of Object.keys(forms)) {
        const ids = forms[page];
        if (!RELEASE_PAGES.has(page) || !Array.isArray(ids) || ids.length === 0) {
            throw new ChannelError('LEAD_ADS_FORMS_NOT_CONFIGURED', 503);
        }
        for (const id of ids) {
            if (typeof id !== 'string' || !/^\d{1,100}$/.test(id) || seen.has(id)) {
                throw new ChannelError('LEAD_ADS_FORMS_NOT_CONFIGURED', 503);
            }
            seen.add(id);
        }
    }
    if (seen.size !== 6) {
        throw new ChannelError('LEAD_ADS_FORMS_NOT_CONFIGURED', 503);
    }
    const pageForms = forms[config.page];
    if (!Array.isArray(pageForms) || !pageForms.includes(formId)) {
        throw new ChannelError('FORM_NOT_ALLOWED', 403);
    }
}
