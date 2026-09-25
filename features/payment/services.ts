import { createAdminClient } from '@/lib/supabase/admin';

export async function processPaymentWebhook(payload: {
  provider: string;
  provider_account: string;
  provider_ref: string;
  amount: number;
  occurred_at: string;
  transfer_content: string;
}) {
  const supabase = createAdminClient();
  const { provider, provider_account, provider_ref, amount, occurred_at, transfer_content } = payload;

  // 1. Trích xuất mã đối soát (payment_reference) từ nội dung chuyển khoản
  // Ví dụ chuẩn: DH-12345, DH-ABCDE
  const paymentRefMatch = transfer_content.match(/DH-[A-Z0-9]+/i);
  const matchedPaymentRef = paymentRefMatch ? paymentRefMatch[0].toUpperCase() : '';

  if (!matchedPaymentRef) {
    throw new Error('Không tìm thấy mã thanh toán hợp lệ trong nội dung chuyển khoản');
  }

  // 2. Gọi RPC xử lý thanh toán (Atomic, check finance summary)
  const { data, error } = await supabase.rpc('process_payment_webhook_rpc', {
    p_provider: provider,
    p_provider_account: provider_account,
    p_provider_ref: provider_ref,
    p_amount: amount,
    p_occurred_at: occurred_at,
    p_transfer_content: transfer_content,
    p_payment_reference: matchedPaymentRef
  });

  if (error) {
    console.error('Lỗi khi gọi RPC process_payment_webhook_rpc:', error);
    throw error;
  }

  return data;
}
