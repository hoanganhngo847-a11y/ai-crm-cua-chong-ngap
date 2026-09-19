import { createClient } from '@/lib/supabase/server';

export async function processPaymentWebhook(payload: {
  provider_ref: string;
  amount: number;
  occurred_at: string;
  transfer_content: string;
  company_id: string;
}) {
  const supabase = createClient();
  const { provider_ref, amount, occurred_at, transfer_content, company_id } = payload;

  // 1. Trích xuất mã đơn hàng từ nội dung chuyển khoản
  // Trong dự án thực tế, order_code có thể có định dạng riêng, ví dụ: /ORDER-[A-Z0-9]+/
  // Ở đây giả định tìm thấy UUID hoặc một mã định danh dài
  const orderIdMatch = transfer_content.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  const matchedOrderId = orderIdMatch ? orderIdMatch[0] : null;

  if (matchedOrderId) {
    // 2. Truy vấn đơn hàng để đối chiếu
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, deposit_amount, status')
      .eq('id', matchedOrderId)
      .single();

    if (!orderError && order) {
      // 3. Kiểm tra số tiền chuyển có khớp hoặc lớn hơn yêu cầu cọc không
      if (amount >= order.deposit_amount) {
        // Cập nhật trạng thái đơn hàng thành ĐÃ CỌC (DEPOSITED / DEPOSIT_CONFIRMED)
        // Lưu ý: Theo DATA_CONTRACT.md, canonical value là DEPOSIT_CONFIRMED
        await supabase
          .from('orders')
          .update({ status: 'DEPOSIT_CONFIRMED' }) 
          .eq('id', order.id);

        // Lưu giao dịch thanh toán với trạng thái MATCHED, độ tự tin 100
        const { error: txError } = await supabase
          .from('payment_transactions')
          .insert({
            provider_ref,
            amount,
            occurred_at,
            transfer_content,
            company_id,
            matched_order_id: order.id,
            match_confidence: '100',
            status: 'MATCHED'
          });

        if (txError) console.error('Lỗi khi lưu giao dịch MATCHED:', txError);
        return { status: 'MATCHED', orderId: order.id };
      }
    }
  }

  // 4. Không tìm thấy đơn hoặc số tiền bị thiếu -> Chờ kiểm tra thủ công
  // Tuyệt đối không tự động chuyển trạng thái đơn hàng.
  const { error: pendingTxError } = await supabase
    .from('payment_transactions')
    .insert({
      provider_ref,
      amount,
      occurred_at,
      transfer_content,
      company_id,
      matched_order_id: matchedOrderId || null,
      match_confidence: matchedOrderId ? '50' : '0',
      status: 'PENDING_REVIEW'
    });

  if (pendingTxError) console.error('Lỗi khi lưu giao dịch PENDING_REVIEW:', pendingTxError);
  return { status: 'PENDING_REVIEW', orderId: matchedOrderId };
}
