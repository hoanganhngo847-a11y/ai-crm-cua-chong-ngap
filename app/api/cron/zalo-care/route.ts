import { NextResponse, type NextRequest } from 'next/server';
import { runZaloCareCron } from '../../../../features/care/zalo';

export const dynamic = 'force-dynamic';

// GET /api/cron/zalo-care
//
// Periodic Zalo worker (recommended every 15 minutes):
//   1. Due care schedules → claim → send → complete (never resends UNCERTAIN deliveries).
//   2. Outbound reconcile → finalize deliveries the provider already accepted (never resends).
//
// Auth: Authorization: Bearer $CRON_SECRET (fail-closed in production).
export async function GET(request: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[cron/zalo-care] CRON_SECRET chưa được cấu hình trong production.');
      return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
    }
    console.warn('[cron/zalo-care] CRON_SECRET chưa cấu hình — bỏ qua auth trong dev.');
  } else {
    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (token !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const result = await runZaloCareCron();
    return NextResponse.json(result);
  } catch (err: unknown) {
    console.error('[cron/zalo-care] Cron execution failed:', (err as Error).message);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
}
