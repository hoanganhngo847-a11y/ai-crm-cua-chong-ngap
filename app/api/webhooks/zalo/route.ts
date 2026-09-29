import { NextRequest, NextResponse } from 'next/server';
import { handleZaloWebhookRequest } from '../../../../features/omnichannel/zalo/webhook-handler';

export const dynamic = 'force-dynamic';

/**
 * Zalo OA Webhook Ingestion Endpoint.
 *
 * All logic lives in handleZaloWebhookRequest (features/omnichannel/zalo/webhook-handler.ts):
 * per-OA HMAC verification, server-side tenant resolution (unknown OA → 403, lookup outage → 503
 * so Zalo retries), durable claim + atomic DB ingestion, sanitized error responses.
 */
export async function POST(request: NextRequest) {
  const { status, body } = await handleZaloWebhookRequest(request);
  return NextResponse.json(body, { status });
}
