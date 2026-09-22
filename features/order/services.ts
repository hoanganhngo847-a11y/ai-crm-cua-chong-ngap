import { createClient } from '@/lib/supabase/server';
import { generateContractForOrder } from '@/features/contract/services';

/**
 * Tính toán công nợ và cập nhật trạng thái đơn hàng
 * remaining_amount = total_amount - deposit_amount
 */
export async function updateOrderDepositAndDebt(orderId: string, depositAmount: number) {
  const supabase = await createClient();
  
  // 1. Gọi RPC để cập nhật tiền cọc và ghi nhận công nợ (finance_summaries) trong một transaction atomic
  const { data, error } = await supabase.rpc('update_order_deposit_rpc', {
    p_order_id: orderId,
    p_deposit_amount: depositAmount
  });

  if (error || !data?.success) {
    console.error('Lỗi khi cập nhật tiền cọc và công nợ đơn hàng (Atomic RPC):', error);
    throw error || new Error('Không thể cập nhật cọc');
  }

  // 2. Lấy thông tin order để tự động sinh hợp đồng
  const { data: order, error: fetchError } = await supabase
    .from('orders')
    .select('customer_id')
    .eq('id', orderId)
    .single();

  if (fetchError || !order) {
    throw new Error('Lỗi lấy thông tin order sau khi cập nhật cọc');
  }

  // 3. Tự động sinh hợp đồng (Automation Trigger)
  await generateContractForOrder(orderId, order.customer_id);

  return { success: true };
}
