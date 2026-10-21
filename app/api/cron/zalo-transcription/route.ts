import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import {
  processDueZaloTranscriptionJobs,
  processTargetedZaloTranscriptionJob,
} from '../../../../features/zalo-transcription/service';

export const dynamic = 'force-dynamic';

/**
 * Zalo Transcription Cron Worker
 *
 * Processes due transcription jobs from the queue (bulk) or targets a single
 * specific job (targeted).
 *
 * Authentication:
 *   Authorization: Bearer $CRON_SECRET
 *   Uses constant-time comparison to prevent timing attacks.
 *   Fail-closed with 503 Service Unavailable when CRON_SECRET is not configured (all environments).
 *   Missing or invalid Bearer token returns 401 Unauthorized.
 *   Authentication occurs before query parameter validation.
 *
 * Query Parameters:
 *   - limit: Integer between 1 and 10 (default 10) for bulk mode.
 *     Rejects empty, fractional, non-positive, >10, non-numeric, or duplicate parameters with 400.
 *   - transcription_id: UUID of single transcription to process.
 *     Targeted execution processes exactly that job once with NO fallback to bulk.
 *     Note on limit with transcription_id:
 *     If both `transcription_id` and `limit` are supplied, `limit` is still validated
 *     and any invalid supplied `limit` is rejected with 400. If valid, `limit` is ignored
 *     for the targeted execution because targeted mode strictly claims only that single job.
 *   - Duplicate query parameters are rejected with 400 Bad Request without echoing unvalidated keys.
 *
 * Bounded execution:
 *   - Max 10 jobs per bulk invocation (DB-enforced cap at 50)
 *   - Total worker duration bounded to 4 minutes
 *   - Individual job duration bounded to 3 minutes
 *
 * Safe Logging:
 *   No raw exception messages, tokens, or credentials are leaked in error logs.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_LIMIT_REGEX = /^(?:[1-9]|10)$/;

function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) {
    // Perform dummy comparison to preserve constant time
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export interface ZaloTranscriptionRouteDeps {
  processDue?: (limit: number) => Promise<{ claimed: number; processed: number; failed: number }>;
  processTargeted?: (id: string) => Promise<{ claimed: number; processed: number; failed: number }>;
}

export async function handleZaloTranscriptionCron(
  request: NextRequest,
  deps?: ZaloTranscriptionRouteDeps
): Promise<NextResponse> {
  // 1. Authentication (must occur before query validation)
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('[cron/zalo-transcription] CRON_SECRET is not configured.');
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }

  const authHeader = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
  if (!match) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const token = match[1];
  if (!constantTimeEqual(token, cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Query parameter validation
  const { searchParams } = new URL(request.url);

  // Reject duplicate parameters without echoing attacker-supplied strings
  for (const key of searchParams.keys()) {
    if (searchParams.getAll(key).length > 1) {
      return NextResponse.json(
        { error: 'Duplicate query parameter' },
        { status: 400 }
      );
    }
  }

  /**
   * Validate limit if supplied.
   * If transcription_id is also supplied, a valid limit is ignored during processing,
   * but an invalid supplied limit (empty, fraction, 0, negative, >10, text) is still rejected here with 400.
   */
  let limit = 10;
  if (searchParams.has('limit')) {
    const rawLimit = searchParams.get('limit') ?? '';
    if (!VALID_LIMIT_REGEX.test(rawLimit)) {
      return NextResponse.json(
        { error: 'Invalid limit parameter: must be an integer between 1 and 10' },
        { status: 400 }
      );
    }
    limit = Number.parseInt(rawLimit, 10);
  }

  // Validate transcription_id if supplied
  let targetId: string | undefined;
  if (searchParams.has('transcription_id')) {
    const rawId = searchParams.get('transcription_id') ?? '';
    if (!UUID_REGEX.test(rawId)) {
      return NextResponse.json(
        { error: 'Invalid transcription_id parameter: must be a valid UUID' },
        { status: 400 }
      );
    }
    targetId = rawId;
  }

  // 3. Execution
  try {
    if (targetId) {
      // Targeted execution: claims and processes exactly one job, no fallback
      const runner = deps?.processTargeted || processTargetedZaloTranscriptionJob;
      const result = await runner(targetId);
      return NextResponse.json({ ok: true, mode: 'TARGETED', ...result });
    }

    const runner = deps?.processDue || processDueZaloTranscriptionJobs;
    const result = await runner(limit);
    return NextResponse.json({ ok: true, mode: 'BULK', ...result });
  } catch {
    // Never expose raw exception messages or tokens in logs
    console.error('[cron/zalo-transcription] Worker execution failed');
    return NextResponse.json({ error: 'Worker error' }, { status: 500 });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleZaloTranscriptionCron(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleZaloTranscriptionCron(request);
}
