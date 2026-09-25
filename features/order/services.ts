import { createAdminClient } from '@/lib/supabase/admin';
import { authorizeOrderAccess } from '@/lib/server-auth/resource-access';
import { generateContractForOrder } from '@/features/contract/services';

/**
 * Tính toán công nợ và cập nhật trạng thái đơn hàng
 * remaining_amount = total_amount - deposit_amount
 */
export async function updateOrderDepositAndDebt(orderId: string, depositAmount: number, idempotencyKey: string) {
  const adminSupabase = createAdminClient();
  
  // 0. Trusted Server Authentication: Xác minh quyền BOSS_ADMIN (P0:2)
  const { actor, order } = await authorizeOrderAccess(orderId);
  if (actor.role !== 'BOSS_ADMIN') {
    throw new Error('Chỉ BOSS_ADMIN mới được phép cập nhật cọc thủ công');
  }

  // 1. Gọi RPC để cập nhật tiền cọc và ghi nhận công nợ (finance_summaries) trong một transaction atomic
  const { data, error } = await adminSupabase.rpc('update_order_deposit_rpc', {
    p_order_id: orderId,
    p_deposit_amount: depositAmount,
    p_idempotency_key: idempotencyKey
  });

  if (error || !data?.success) {
    console.error('Lỗi khi cập nhật tiền cọc và công nợ đơn hàng (Atomic RPC):', error);
    throw error || new Error('Không thể cập nhật cọc');
  }

  // 3. Tự động sinh hợp đồng (Automation Trigger)
  await generateContractForOrder(orderId, order.customer_id);

  return { success: true };
}
