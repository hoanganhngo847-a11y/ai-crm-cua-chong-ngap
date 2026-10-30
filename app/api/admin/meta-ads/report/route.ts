import { NextResponse } from 'next/server';

import { getActorContext } from '@/lib/auth/context';
import { verifyActorForCompany } from '@/lib/server-auth/authorize';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';

export async function GET(request: Request) {
    try {
        const actor = await getActorContext();
        if (!actor?.companyId) {
            return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
        }

        await verifyActorForCompany(actor.companyId, {
            allowedRoles: ['BOSS_ADMIN', 'SALE'],
        });

        const query = new URL(request.url).searchParams;
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        const from = query.get('from') || thirtyDaysAgo.toISOString();
        const to = query.get('to') || now.toISOString();
        const adAccountId = query.get('ad_account_id') || null;
        const campaignId = query.get('campaign_id') || null;

        const supabase = createAdminClient();
        const { data, error } = await supabase.rpc('get_meta_ads_performance_report', {
            p_company: actor.companyId,
            p_from: from,
            p_to: to,
            p_ad_account_id: adAccountId,
            p_campaign_id: campaignId,
        });

        if (error) {
            console.error('[admin/meta-ads/report] rpc_error:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({
            ok: true,
            data,
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'REPORT_FAILED';
        return NextResponse.json(
            { error: message },
            { status: message === 'FORBIDDEN' || message.includes('DENIED') ? 403 : 500 },
        );
    }
}
