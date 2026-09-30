import { NextResponse } from 'next/server';
import { processPaymentWebhook } from '@/features/payment/services';
import crypto from 'crypto';

export async function POST(request: Request) {
  try {
    const signature = request.headers.get('x-provider-signature');
    if (!signature) {
      return NextResponse.json({ error: 'Unauthorized: Missing signature' }, { status: 401 });
    }

    const secret = process.env.WEBHOOK_SECRET;
    if (!secret || typeof secret !== 'string' || secret.trim() === '') {
      console.error('CRITICAL: WEBHOOK_SECRET is not configured or invalid.');
      return NextResponse.json({ error: 'CONFIGURATION_ERROR' }, { status: 503 });
    }

    const rawBody = await request.text();

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    try {
      const sigBuf = Buffer.from(signature);
      const expectedBuf = Buffer.from(expectedSignature);
      if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        return NextResponse.json({ error: 'Unauthorized: Invalid signature' }, { status: 401 });
      }
    } catch {
      return NextResponse.json({ error: 'Unauthorized: Invalid signature format' }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Bad Request: Malformed JSON' }, { status: 400 });
    }

    if (
      !body ||
      typeof body !== 'object' ||
      !body.provider ||
      !body.provider_account ||
      !body.provider_ref ||
      typeof body.amount !== 'number' ||
      body.amount <= 0 ||
      !body.occurred_at
    ) {
      return NextResponse.json(
        { error: 'Bad Request: Missing or invalid required fields' },
        { status: 400 }
      );
    }

    const result = await processPaymentWebhook({
      provider: String(body.provider),
      provider_account: String(body.provider_account),
      provider_ref: String(body.provider_ref),
      amount: Number(body.amount),
      occurred_at: String(body.occurred_at),
      transfer_content: String(body.transfer_content || ''),
    });

    return NextResponse.json({ success: true, result }, { status: 200 });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error || '');
    if (errMsg.includes('UNKNOWN_PROVIDER_ACCOUNT')) {
      return NextResponse.json({ error: errMsg }, { status: 422 });
    }
    if (errMsg.includes('PAYMENT_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD')) {
      return NextResponse.json({ error: errMsg }, { status: 409 });
    }
    console.error('Payment Webhook Processing Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
