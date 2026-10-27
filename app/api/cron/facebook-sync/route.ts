import { NextResponse, type NextRequest } from 'next/server';

import { ChannelError } from '@/features/omnichannel/facebook/core';
import { syncFacebookPages } from '@/features/omnichannel/facebook/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function queryInteger(value: string | null, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

/**
 * GET/POST /api/cron/facebook-sync
 *
 * Pulls recent Messenger messages directly from Meta Graph API. This keeps the CRM usable
 * while the Meta app is still in Development mode and Meta only delivers webhooks for testers.
 *
 * Auth: Authorization: Bearer $CRON_SECRET (fail-closed in production).
 * Optional query params:
 * - lookback_minutes=5 (1..10080)
 * - pages=1343097708890171,1026991374010112
 * - folders=inbox,other,pending
 * - dry_run=true|false
 * - max_conversations=200
 * - max_messages=200
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
    const cronSecret = process.env.CRON_SECRET;

    if (!cronSecret) {
        if (process.env.NODE_ENV === 'production') {
            console.error('[cron/facebook-sync] CRON_SECRET chưa được cấu hình trong production.');
            return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
        }
        console.warn('[cron/facebook-sync] CRON_SECRET chưa cấu hình — chạy ở dev mode.');
    } else {
        const authHeader = request.headers.get('authorization') || '';
        const token = authHeader.replace(/^Bearer\s+/i, '');

        if (token !== cronSecret) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
    }

    const query = new URL(request.url).searchParams;

    const foldersParam = query.get('folders');
    const folders = foldersParam
        ? foldersParam
            .split(',')
            .map((f) => f.trim().toLowerCase())
            .filter(Boolean)
        : undefined;

    const dryRun = query.get('dry_run') === 'true';

    try {
        const summary = await syncFacebookPages({
            lookbackMinutes: queryInteger(query.get('lookback_minutes'), 5),
            pages: (query.get('pages') || '')
                .split(',')
                .map((page) => page.trim())
                .filter(Boolean),
            folders,
            dryRun,
            maxConversationsPerPage: queryInteger(query.get('max_conversations'), 200),
            maxMessagesPerConversation: queryInteger(query.get('max_messages'), 200),
        });

        const ingested = summary.pages.reduce(
            (total, page) => total + page.messages_ingested,
            0,
        );
        const inbound = summary.pages.reduce(
            (total, page) => total + (page.inbound_ingested ?? 0),
            0,
        );
        const outbound = summary.pages.reduce(
            (total, page) => total + (page.outbound_ingested ?? 0),
            0,
        );
        const errors = summary.pages.reduce(
            (total, page) => total + page.errors.length,
            0,
        );

        console.info(
            `[cron/facebook-sync] completed pages=${summary.pages.length} ingested=${ingested} (inbound=${inbound}, outbound=${outbound}) errors=${errors} dry_run=${dryRun}`,
        );

        if (errors > 0) {
            for (const page of summary.pages) {
                if (page.errors.length > 0) {
                    console.warn(
                        `[cron/facebook-sync] page=${page.page} errors=${page.errors.slice(0, 5).join('; ')}`,
                    );
                }
            }
        }

        return NextResponse.json({ ok: summary.ok, summary });
    } catch (error) {
        if (error instanceof ChannelError) {
            return NextResponse.json({ error: error.code }, { status: error.status });
        }

        console.error(
            '[cron/facebook-sync] failure:',
            error instanceof Error ? error.message : 'unknown',
        );
        return NextResponse.json({ error: 'Facebook sync failed' }, { status: 500 });
    }
}

export const POST = GET;
