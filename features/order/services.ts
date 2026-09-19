import { createClient } from '@/lib/supabase/server';
import { generateContractForOrder } from '@/features/contract/services';

/**
 * Tính toán công nợ và cập nhật trạng thái đơn hàng
 * remaining_amount = total_amount - deposit_amount
 */
export async function updateOrderDepositAndDebt(orderId: string, depositAmount: number) {
  const supabase = createClient();
  
  // 1. Lấy đơn hàng hiện tại để tính toán với total_amount
  const { data: order, error: fetchError } = await supabase
    .from('orders')
    .select('total_amount, customer_id')
    .eq('id', orderId)
    .single();

  if (fetchError || !order) {
    throw new Error('Không tìm thấy đơn hàng (Order not found)');
  }

  // 2. Tính toán công nợ tự động
  const remainingAmount = (order.total_amount || 0) - depositAmount;

  // 3. Cập nhật đơn hàng thành ĐÃ CỌC (DEPOSIT_CONFIRMED theo hợp đồng dữ liệu)
  const { error: updateError } = await supabase
    .from('orders')
    .update({ 
      deposit_amount: depositAmount,
      remaining_amount: remainingAmount,
      status: 'DEPOSIT_CONFIRMED'
    })
    .eq('id', orderId);

  if (updateError) {
    console.error('Lỗi khi cập nhật tiền cọc và công nợ đơn hàng:', updateError);
    throw updateError;
  }

  // 4. Tự động sinh hợp đồng (Automation Trigger)
  // Việc sinh hợp đồng tuân thủ tuyệt đối dữ liệu đã chốt
  await generateContractForOrder(orderId, order.customer_id);

  return { success: true, remainingAmount };
}
