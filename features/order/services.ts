import { createAdminClient } from '@/lib/supabase/admin';
import { verifyActorForCompany } from '@/lib/server-auth/authorize';
import { APPLICATION_ROLES } from '@/shared/constants/roles';
import { generateContractForOrder } from '@/features/contract/services';
import type { SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';

/**
 * Server-authoritative Order Creation from a validated price calculation snapshot.
 */
export async function createOrderFromCalculation(
  params: {
    companyId: string;
    customerId: string;
    priceCalculationId: string;
  },
  client?: SupabaseClient
) {
  const { companyId, customerId, priceCalculationId } = params;

  // 1. Authorize actor
  const actor = await verifyActorForCompany(
    companyId,
    { allowedRoles: [APPLICATION_ROLES.BOSS_ADMIN, APPLICATION_ROLES.SALE] },
    client
  );

  // 2. Generate server payment reference
  const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  const paymentReference = `DH-${Date.now().toString().slice(-4)}${randomSuffix}`;

  const adminSupabase = createAdminClient();
  const { data, error } = await adminSupabase.rpc('create_order_from_calculation_rpc', {
    p_company_id: companyId,
    p_customer_id: customerId,
    p_price_calculation_id: priceCalculationId,
    p_payment_reference: paymentReference,
    p_actor_user_id: actor.userId,
  });

  if (error) {
    console.error('Lỗi khi tạo đơn hàng từ bảng tính giá:', error);
    throw error;
  }

  return { ...data, paymentReference };
}

/**
 * Updates manual order deposit and debt (BOSS_ADMIN only).
 * If deposit threshold is reached, automatically triggers contract generation.
 */
export async function updateOrderDepositAndDebt(
  params: {
    companyId: string;
    orderId: string;
    depositAmount: number;
    idempotencyKey: string;
  },
  client?: SupabaseClient
) {
  const { companyId, orderId, depositAmount, idempotencyKey } = params;

  // 1. Trusted Server Authorization: BOSS_ADMIN required
  const actor = await verifyActorForCompany(
    companyId,
    { allowedRoles: [APPLICATION_ROLES.BOSS_ADMIN] },
    client
  );

  const adminSupabase = createAdminClient();

  // 2. Atomic RPC call with strict DB-level BOSS check and cumulative threshold calculation
  const { data, error } = await adminSupabase.rpc('update_order_deposit_rpc', {
    p_company_id: companyId,
    p_order_id: orderId,
    p_actor_user_id: actor.userId,
    p_deposit_amount: depositAmount,
    p_idempotency_key: idempotencyKey,
  });

  if (error || !data?.success) {
    console.error('Lỗi khi cập nhật tiền cọc và công nợ đơn hàng:', error);
    throw error || new Error('Không thể cập nhật cọc');
  }

  // 3. Automated contract generation if deposit threshold was reached
  if (data.depositConfirmed) {
    try {
      await generateContractForOrder({ companyId, orderId });
    } catch (genError) {
      console.error('Lỗi khi tự động tạo hợp đồng sau cọc:', genError);
      // Contract claim will remain eligible or be picked up by reconciliation
    }
  }

  return data;
}
