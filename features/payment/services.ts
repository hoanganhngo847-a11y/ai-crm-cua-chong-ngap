import { createClient } from '@/lib/supabase/server';

export async function processPaymentWebhook(payload: {
  provider_ref: string;
  amount: number;
  occurred_at: string;
  transfer_content: string;
  company_id?: string;
}) {
  const supabase = await createClient();
  const { provider_ref, amount, occurred_at, transfer_content } = payload;

  // 1. Trích xuất mã đối soát (payment_reference) từ nội dung chuyển khoản
  // Thay vì UUID, giờ ta tìm kiếm mã cấu trúc /DH[A-Z0-9]+/ hoặc lấy trực tiếp provider_ref
  // Giả định đơn giản: Nội dung CK chứa mã đối soát
  const paymentRefMatch = transfer_content.match(/[A-Za-z0-9_-]+/);
  const matchedPaymentRef = paymentRefMatch ? paymentRefMatch[0] : transfer_content;

  // 2. Gọi RPC xử lý thanh toán (Atomic, check finance summary)
  const { data, error } = await supabase.rpc('process_payment_webhook_rpc', {
    p_provider: 'BANK', // Hoặc lấy từ payload
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
