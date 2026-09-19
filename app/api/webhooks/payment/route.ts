import { NextResponse } from 'next/server';
import { processPaymentWebhook } from '@/features/payment/services';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    // Validate payload cơ bản từ webhook
    if (!body.provider_ref || !body.amount || !body.occurred_at || !body.company_id) {
      return NextResponse.json({ error: 'Thiếu các trường bắt buộc (Missing required fields)' }, { status: 400 });
    }

    const result = await processPaymentWebhook({
      provider_ref: body.provider_ref,
      amount: body.amount,
      occurred_at: body.occurred_at,
      transfer_content: body.transfer_content || '',
      company_id: body.company_id
    });

    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error('Payment Webhook Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
