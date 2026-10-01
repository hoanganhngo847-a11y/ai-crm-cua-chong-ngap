import { NextResponse, type NextRequest } from 'next/server';
import { processDueResponseSlaWindows } from '@/features/automation/response-sla/services/sla-automation-worker';

/**
 * GET/POST /api/cron/response-sla-worker
 *
 * Automated Cron worker for Response SLA overdue windows.
 * Protected by CRON_SECRET bearer token authentication.
 *
 * Triggered by:
 * - Vercel Cron / External Cron Runner (e.g. curl -H "Authorization: Bearer $CRON_SECRET" ...)
 * - Scheduled system automation every 1-5 minutes
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[cron/response-sla-worker] CRON_SECRET chưa được cấu hình trong production.');
      return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
    }
    // Dev: warning if unset
    console.warn('[cron/response-sla-worker] CRON_SECRET chưa cấu hình — chạy ở dev mode.');
  } else {
    const authHeader = request.headers.get('authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');

    if (token !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const summary = await processDueResponseSlaWindows({ limit: 50 });
    return NextResponse.json({
      ok: true,
      summary,
    });
  } catch (err: unknown) {
    const error = err as Error;
    console.error('[cron/response-sla-worker] Worker failure:', error.message);
    return NextResponse.json({ error: 'Database/Worker error', message: error.message }, { status: 500 });
  }
}

export const POST = GET;
