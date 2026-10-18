import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { ZaloOutboundDispatcher } from '../../../../../features/omnichannel/zalo/outbound-dispatcher';

export const runtime = 'nodejs';

const DEFAULT_BATCH_LIMIT = 5;
const MAX_BATCH_LIMIT = 20;

function secureCompare(leftValue: string, rightValue: string): boolean {
  const left = Buffer.from(leftValue);
  const right = Buffer.from(rightValue);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isAuthorized(request: NextRequest, expectedSecret: string): boolean {
  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const workerHeader = request.headers.get('x-worker-secret') || '';
  const provided = workerHeader || bearer;
  return Boolean(provided) && secureCompare(provided, expectedSecret);
}

export async function POST(request: NextRequest) {
  const workerSecret = process.env.ZALO_ZCAJS_WORKER_SECRET || '';
  const companyId = (process.env.ZALO_ZCAJS_COMPANY_ID || '').trim();
  const transport = (process.env.ZALO_TRANSPORT || '').trim().toUpperCase();

  if (!workerSecret || !companyId) {
    return NextResponse.json(
      { success: false, error: 'ZCAJS_SERVER_CONFIG_MISSING' },
      { status: 503 }
    );
  }

  if (!isAuthorized(request, workerSecret)) {
    return NextResponse.json(
      { success: false, error: 'UNAUTHORIZED' },
      { status: 401 }
    );
  }

  if (transport !== 'ZCAJS') {
    return NextResponse.json(
      { success: false, error: 'ZCAJS_TRANSPORT_DISABLED' },
      { status: 409 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const requestedLimit = Number((body as { limit?: unknown })?.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(MAX_BATCH_LIMIT, Math.floor(requestedLimit)))
    : DEFAULT_BATCH_LIMIT;

  try {
    const dispatcher = new ZaloOutboundDispatcher();
    const result = await dispatcher.dispatchPendingZaloDeliveries(companyId, {
      limit,
      workerId: `zcajs_poll_${crypto.randomUUID()}`,
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error: unknown) {
    console.error(
      '[ZCAJS Dispatch] Failed to drain pending outbound deliveries:',
      error instanceof Error ? error.message : 'unknown'
    );
    return NextResponse.json(
      { success: false, error: 'ZCAJS_DISPATCH_FAILED' },
      { status: 500 }
    );
  }
}
