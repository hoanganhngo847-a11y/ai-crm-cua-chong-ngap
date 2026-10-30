import { NextResponse } from 'next/server';

import { getActorContext, requireBossAdmin } from '@/lib/auth/context';
import { syncCompanyMetaAds } from '@/features/omnichannel/facebook/marketing-sync';

export const runtime = 'nodejs';

export async function POST(request: Request) {
    try {
        const actor = await getActorContext();
        if (!actor?.companyId) {
            return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
        }

        await requireBossAdmin(actor.companyId);

        let body: { token?: string } = {};
        try {
            body = (await request.json()) as { token?: string };
        } catch {
            // Empty body is acceptable
        }

        const result = await syncCompanyMetaAds(actor.companyId, {
            token: body.token,
        });

        return NextResponse.json({
            ok: result.success,
            data: result,
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'SYNC_FAILED';
        console.error('[admin/meta-ads/sync] error:', error);
        return NextResponse.json(
            { error: message },
            { status: message === 'FORBIDDEN' ? 403 : 500 },
        );
    }
}
