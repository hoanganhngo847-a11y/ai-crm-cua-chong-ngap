import { NextResponse, type NextRequest } from 'next/server';
import { createAdminClient } from '../../../../lib/supabase/admin';
import { ZaloCareSchedulerService } from '../../../../features/care/zalo/scheduler-service';
import { ZaloInboxService } from '../../../../features/omnichannel/zalo/inbox-service';

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

  const supabase = createAdminClient();
  const { data: configs, error } = await supabase.from('zalo_oa_configs').select('company_id').eq('status', 'ACTIVE');
  if (error) {
    console.error('[cron/zalo-care] Không đọc được danh sách OA:', error.message);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  const companyIds = Array.from(new Set(((configs || []) as { company_id: string }[]).map((c) => c.company_id)));
  const scheduler = new ZaloCareSchedulerService({ supabase });
  const inbox = new ZaloInboxService({ supabase });

  const care = { processed: 0, advanced: 0, failed: 0, uncertain: 0, skipped: 0 };
  const outbound = { reconciled: 0, failed: 0, uncertain: 0 };
  let companyErrors = 0;

  for (const companyId of companyIds) {
    try {
      const r = await scheduler.processDueSchedules({ companyId });
      care.processed += r.processed;
      care.advanced += r.advanced;
      care.failed += r.failed;
      care.uncertain += r.uncertain;
      care.skipped += r.skipped;

      const o = await inbox.reconcilePendingDeliveries({ companyId });
      outbound.reconciled += o.reconciled;
      outbound.failed += o.failed;
      outbound.uncertain += o.uncertain;
    } catch (err) {
      companyErrors++;
      console.error(`[cron/zalo-care] company=${companyId}:`, (err as Error).message);
    }
  }

  return NextResponse.json({ ok: companyErrors === 0, companies: companyIds.length, care, outbound });
}

export const POST = GET;
