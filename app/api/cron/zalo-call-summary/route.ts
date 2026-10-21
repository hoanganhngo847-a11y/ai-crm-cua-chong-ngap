import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import {
  processDueZaloCallSummaryJobs,
  processTargetedZaloCallSummaryJob,
} from '../../../../features/zalo-summary/service';

export const dynamic = 'force-dynamic';

/**
 * Zalo Call AI Summary Cron Worker
 *
 * Processes due call summary jobs asynchronously:
 * - Targeted mode: ?summary_id=<uuid> OR ?transcription_id=<uuid>
 *   (Strictly claims only that single job; NO bulk fallback)
 * - Bulk mode: ?limit=1..10 (default 10)
 *
 * Authentication:
 *   Authorization: Bearer $CRON_SECRET
 *   Constant-time comparison with timingSafeEqual.
 *   Missing CRON_SECRET -> 503 Service Unavailable.
 *   Missing or invalid Bearer token -> 401 Unauthorized.
 *   Auth occurs strictly BEFORE query parameter validation.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_LIMIT_REGEX = /^(?:[1-9]|10)$/;

function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export interface ZaloCallSummaryRouteDeps {
  processDue?: (limit: number) => Promise<{ claimed: number; processed: number; failed: number }>;
  processTargeted?: (target: { summaryId?: string; transcriptionId?: string }) => Promise<{
    claimed: number;
    processed: number;
    failed: number;
  }>;
}

export async function handleZaloCallSummaryCron(
  request: NextRequest,
  deps?: ZaloCallSummaryRouteDeps
): Promise<NextResponse> {
  // 1. Authentication
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('[cron/zalo-call-summary] CRON_SECRET is not configured.');
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

  for (const key of searchParams.keys()) {
    if (searchParams.getAll(key).length > 1) {
      return NextResponse.json(
        { error: 'Duplicate query parameter' },
        { status: 400 }
      );
    }
  }

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

  let summaryId: string | undefined;
  if (searchParams.has('summary_id')) {
    const rawId = searchParams.get('summary_id') ?? '';
    if (!UUID_REGEX.test(rawId)) {
      return NextResponse.json(
        { error: 'Invalid summary_id parameter: must be a valid UUID' },
        { status: 400 }
      );
    }
    summaryId = rawId;
  }

  let transcriptionId: string | undefined;
  if (searchParams.has('transcription_id')) {
    const rawId = searchParams.get('transcription_id') ?? '';
    if (!UUID_REGEX.test(rawId)) {
      return NextResponse.json(
        { error: 'Invalid transcription_id parameter: must be a valid UUID' },
        { status: 400 }
      );
    }
    transcriptionId = rawId;
  }

  // 3. Execution
  try {
    if (summaryId || transcriptionId) {
      const runner = deps?.processTargeted || processTargetedZaloCallSummaryJob;
      const result = await runner({ summaryId, transcriptionId });
      return NextResponse.json({ ok: true, mode: 'TARGETED', ...result });
    }

    const runner = deps?.processDue || processDueZaloCallSummaryJobs;
    const result = await runner(limit);
    return NextResponse.json({ ok: true, mode: 'BULK', ...result });
  } catch {
    console.error('[cron/zalo-call-summary] Worker execution failed');
    return NextResponse.json({ error: 'Worker error' }, { status: 500 });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleZaloCallSummaryCron(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleZaloCallSummaryCron(request);
}
