import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { processDueZaloTranscriptionJobs } from '../../../../features/zalo-transcription/service';

export const dynamic = 'force-dynamic';

/**
 * Zalo Transcription Cron Worker
 *
 * Processes due transcription jobs from the queue.
 *
 * Authentication:
 *   Authorization: Bearer $CRON_SECRET
 *   Uses constant-time comparison to prevent timing attacks.
 *   Fail-closed in production when CRON_SECRET is not configured.
 *
 * Production invocation:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/zalo-transcription
 *   Or configure as a Render Cron Job / external scheduler.
 *   For initial controlled testing: manual authenticated GET/POST request.
 *
 * Bounded execution:
 *   - Max 10 jobs per invocation (DB-enforced cap at 50)
 *   - Total worker duration bounded to 4 minutes
 *   - Individual job duration bounded to 3 minutes
 *   - Remaining jobs expire via DB lease and are reclaimed next invocation
 */

function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) {
    // Still perform a comparison to avoid timing leak on length
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[cron/zalo-transcription] CRON_SECRET is not configured in production.');
      return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
    }
    console.warn('[cron/zalo-transcription] CRON_SECRET not configured — allowing in dev/test.');
  } else {
    const authHeader = request.headers.get('authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!constantTimeEqual(token, cronSecret)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const result = await processDueZaloTranscriptionJobs(10);
    return NextResponse.json({ ok: true, ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron/zalo-transcription] Execution failed:', msg);
    return NextResponse.json({ error: 'Worker error' }, { status: 500 });
  }
}

export const POST = GET;
