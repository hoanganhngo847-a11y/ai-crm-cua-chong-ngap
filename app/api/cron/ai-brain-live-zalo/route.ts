import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { processDueAiBrainLiveZaloDeliveries } from '../../../../features/ai-brain/live-zalo-worker';

export const dynamic = 'force-dynamic';

const LIMIT_RE = /^(?:[1-9]|10)$/;

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export interface AiBrainLiveZaloRouteDeps {
  processDue?: (limit: number) => Promise<{ claimed: number; sent: number; skipped: number; failed: number }>;
}

export async function handleAiBrainLiveZaloCron(
  request: NextRequest,
  deps: AiBrainLiveZaloRouteDeps = {},
): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    console.error('[cron/ai-brain-live-zalo] CRON_SECRET is not configured');
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }

  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
  if (!match || !constantTimeEqual(match[1], secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  for (const key of searchParams.keys()) {
    if (key !== 'limit' || searchParams.getAll(key).length !== 1) {
      return NextResponse.json({ error: 'Invalid query parameter' }, { status: 400 });
    }
  }

  let limit = 5;
  if (searchParams.has('limit')) {
    const raw = searchParams.get('limit') ?? '';
    if (!LIMIT_RE.test(raw)) {
      return NextResponse.json({ error: 'Invalid limit parameter' }, { status: 400 });
    }
    limit = Number.parseInt(raw, 10);
  }

  try {
    const result = await (deps.processDue ?? processDueAiBrainLiveZaloDeliveries)(limit);
    return NextResponse.json({ ok: true, ...result });
  } catch {
    console.error('[cron/ai-brain-live-zalo] worker execution failed');
    return NextResponse.json({ error: 'Worker error' }, { status: 500 });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleAiBrainLiveZaloCron(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleAiBrainLiveZaloCron(request);
}
