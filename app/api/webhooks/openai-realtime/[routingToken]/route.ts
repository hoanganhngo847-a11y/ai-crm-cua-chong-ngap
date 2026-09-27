import { NextResponse, type NextRequest } from 'next/server';
import { handleOpenAiRealtimeWebhook } from '../../../../../features/voice/services/realtime-handler';

export const runtime = 'nodejs';
type Context = { params: Promise<{ routingToken: string }> };

export async function POST(request: NextRequest, context: Context): Promise<NextResponse> {
  const { routingToken } = await context.params;
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  const result = await handleOpenAiRealtimeWebhook(routingToken, rawBody, request.headers);
  return NextResponse.json(result.body, { status: result.status });
}
