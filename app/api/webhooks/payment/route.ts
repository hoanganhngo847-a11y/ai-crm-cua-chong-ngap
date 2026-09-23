import { NextResponse } from 'next/server';
import { processPaymentWebhook } from '@/features/payment/services';
import crypto from 'crypto';

export async function POST(request: Request) {
  try {
    const signature = request.headers.get('x-provider-signature');
    if (!signature) {
      return NextResponse.json({ error: 'Unauthorized (Missing Signature)' }, { status: 401 });
    }

    const rawBody = await request.text();
    
    // Robust HMAC verification
    const secret = process.env.WEBHOOK_SECRET || '';
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    try {
      const isSignatureValid = crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
      );
      if (!isSignatureValid) {
        return NextResponse.json({ error: 'Unauthorized (Invalid Signature)' }, { status: 401 });
      }
    } catch (e) {
      // Catch errors like length mismatch in timingSafeEqual
      return NextResponse.json({ error: 'Unauthorized (Invalid Signature format)' }, { status: 401 });
    }

    const body = JSON.parse(rawBody);

    // Validate payload, dropping company_id from body. Ensure provider and provider_account are passed
    if (!body.provider_ref || !body.amount || !body.occurred_at || !body.provider || !body.provider_account) {
      return NextResponse.json({ error: 'Thiếu các trường bắt buộc (Missing required fields)' }, { status: 400 });
    }

    const result = await processPaymentWebhook({
      provider: body.provider,
      provider_account: body.provider_account,
      provider_ref: body.provider_ref,
      amount: body.amount,
      occurred_at: body.occurred_at,
      transfer_content: body.transfer_content || ''
    });

    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error('Payment Webhook Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
