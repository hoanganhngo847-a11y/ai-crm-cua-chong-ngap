import { NextResponse } from 'next/server';

import { AuthError, getActorContext, requireBossAdmin } from '@/lib/auth/context';
import { createAdminClient } from '@/lib/supabase/admin';
import { syncCompanyMetaAttribution } from '@/features/omnichannel/facebook/marketing-sync';

export const runtime = 'nodejs';

export async function POST(request: Request) {
    try {
        const actor = await getActorContext();
        if (!actor?.companyId) {
            return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
        }
        await requireBossAdmin(actor.companyId);

        // Credentials come only from the private token vault or server config.
        const result = await syncCompanyMetaAttribution(actor.companyId);
        // A partial sync can still resolve pending submissions from trusted rows.
        const retry = await createAdminClient().rpc('retry_pending_lead_attribution', {
            p_company: actor.companyId,
        });
        const ok = result.success && !retry.error;
        if (request.headers.get('content-type')?.includes('application/x-www-form-urlencoded')) {
            return new NextResponse(null, {
                status: 303,
                headers: { Location: `/admin/facebook?attribution_sync=${ok ? 'success' : 'incomplete'}` },
            });
        }
        return NextResponse.json({
            ok,
            data: result,
            attribution_retry: retry.error ? { error: 'ATTRIBUTION_RETRY_FAILED' } : retry.data,
        });
    } catch (error) {
        if (error instanceof AuthError) {
            return NextResponse.json({ error: error.code }, { status: error.status });
        }
        console.error('[meta-attribution-sync] failed');
        return NextResponse.json({ error: 'ATTRIBUTION_SYNC_FAILED' }, { status: 500 });
    }
}
