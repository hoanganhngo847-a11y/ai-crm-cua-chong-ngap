import { NextResponse } from 'next/server';
import { processPaymentWebhook } from '@/features/payment/services';

export async function POST(request: Request) {
  try {
    // Xác minh nhà cung cấp (Ví dụ dummy check signature từ header)
    const signature = request.headers.get('x-provider-signature');
    if (!signature) {
      return NextResponse.json({ error: 'Unauthorized (Missing Signature)' }, { status: 401 });
    }

    const body = await request.json();
    
    // Validate payload cơ bản từ webhook
    // Bỏ qua company_id từ body để tránh giả mạo, RPC sẽ tự xử lý hoặc map từ account/provider
    if (!body.provider_ref || !body.amount || !body.occurred_at) {
      return NextResponse.json({ error: 'Thiếu các trường bắt buộc (Missing required fields)' }, { status: 400 });
    }

    const result = await processPaymentWebhook({
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
