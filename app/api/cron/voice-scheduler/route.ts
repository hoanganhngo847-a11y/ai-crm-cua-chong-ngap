import { NextResponse, type NextRequest } from 'next/server';
import {
  getPendingDueAttempts,
} from '../../../../features/voice/services/call-attempt-scheduler';
import { dispatchAiOutboundCall } from '../../../../features/voice/services/call-dispatcher';

// GET /api/cron/voice-scheduler
//
// Cron job endpoint — gọi định kỳ (khuyến nghị mỗi 5 phút).
// Query call_attempts đến hạn và dispatch AI outbound call.
//
// Xác thực: Authorization: Bearer <CRON_SECRET>
// Không dùng user session — dùng createAdminClient() bên trong các service.
//
// Biến môi trường:
//   CRON_SECRET  — secret để xác thực cron job caller
//
// Cấu hình Vercel Cron (vercel.json):
//   { "crons": [{ "path": "/api/cron/voice-scheduler", "schedule": "each 5 minutes" }] }
//   Thay "each 5 minutes" bằng cron expression thực tế: mỗi 5 phút.
//
// Nếu dùng external scheduler (crontab, GitHub Actions...):
//   curl -H "Authorization: Bearer $CRON_SECRET" https://your-domain.com/api/cron/voice-scheduler
export async function GET(request: NextRequest): Promise<NextResponse> {
  // ── Xác thực cron caller ──────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[cron/voice-scheduler] CRON_SECRET chưa được cấu hình trong production.');
      return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
    }
    // Dev: bỏ qua auth nếu chưa có secret
    console.warn('[cron/voice-scheduler] CRON_SECRET chưa cấu hình — bỏ qua auth trong dev.');
  } else {
    const authHeader = request.headers.get('authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');

    if (token !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // ── Lấy danh sách attempt đến hạn ────────────────────────────────────────
  const batchSize = 50;
  let attempts;

  try {
    attempts = await getPendingDueAttempts(batchSize);
  } catch (err) {
    const error = err as Error;
    console.error('[cron/voice-scheduler] Lỗi query attempts:', error.message);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  if (attempts.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, message: 'No pending attempts' });
  }

  // ── Dispatch từng attempt ─────────────────────────────────────────────────
  let successCount = 0;
  let failCount = 0;
  const errors: string[] = [];

  for (const attempt of attempts) {
    try {
      await dispatchAiOutboundCall(attempt.id, attempt.company_id);
      successCount++;
    } catch (err) {
      const error = err as Error;
      failCount++;
      // SECURITY: log attemptId/companyId — không log phone
      errors.push(`attempt=${attempt.id} company=${attempt.company_id}: ${error.message}`);
      console.error(`[cron/voice-scheduler] Dispatch failed for attempt ${attempt.id}:`, error.message);
    }
  }

  const result = {
    ok: true,
    processed: successCount,
    failed: failCount,
    total: attempts.length,
    // Không trả errors array có thể chứa thông tin nhạy cảm ra ngoài
    // Chỉ log ở server
  };

  if (errors.length > 0) {
    console.error('[cron/voice-scheduler] Dispatch errors:', errors.join('; '));
  }

  return NextResponse.json(result);
}

// POST cũng được hỗ trợ (Vercel Cron dùng POST)
export const POST = GET;
