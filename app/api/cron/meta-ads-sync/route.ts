import { NextResponse, type NextRequest } from 'next/server';

import { createAdminClient } from '@/lib/supabase/admin';
import { syncCompanyMetaAds } from '@/features/omnichannel/facebook/marketing-sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest): Promise<NextResponse> {
    return handleCronSync(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
    return handleCronSync(request);
}

async function handleCronSync(request: NextRequest): Promise<NextResponse> {
    const cronSecret = process.env.CRON_SECRET;

    if (!cronSecret) {
        if (process.env.NODE_ENV === 'production') {
            console.error('[cron/meta-ads-sync] CRON_SECRET is not configured in production.');
            return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
        }
        console.warn('[cron/meta-ads-sync] CRON_SECRET is missing — running in dev mode.');
    } else {
        const authHeader = request.headers.get('authorization') || '';
        const token = authHeader.replace(/^Bearer\s+/i, '');

        if (token !== cronSecret) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
    }

    const supabase = createAdminClient();

    // Get all distinct companies that have configured meta_ad_accounts
    const { data: accounts, error } = await supabase
        .from('meta_ad_accounts')
        .select('company_id')
        .eq('account_status', 1);

    if (error) {
        console.error('[cron/meta-ads-sync] failed to fetch ad accounts', error);
        return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }

    const companyIds = Array.from(new Set((accounts || []).map((a) => a.company_id)));
    const results: Record<string, { success: boolean; error?: string }> = {};

    for (const companyId of companyIds) {
        try {
            const res = await syncCompanyMetaAds(companyId);
            results[companyId] = res;
        } catch (err: unknown) {
            results[companyId] = { success: false, error: err instanceof Error ? err.message : 'META_SYNC_FAILED' };
        }
    }

    const synced = Object.values(results).filter(result => result.success).length;
    return NextResponse.json({
        ok: synced === companyIds.length,
        synced_companies: synced,
        failed_companies: companyIds.length - synced,
        results,
    });
}
