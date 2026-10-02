'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { getActorContext } from '@/lib/auth/context';
import { createAdminClient } from '@/lib/supabase/admin';
import { APPLICATION_ROLES } from '@/shared/constants/roles';
import { createOrderFromCalculation, updateOrderDepositAndDebt } from './services';

const createOrderSchema = z.object({
  priceCalculationId: z.string().uuid({ message: 'Mã bảng tính giá không hợp lệ' }),
});

const updateDepositSchema = z.object({
  orderId: z.string().uuid({ message: 'Mã đơn hàng không hợp lệ' }),
  depositAmount: z
    .number({ message: 'Số tiền đặt cọc phải là số' })
    .positive({ message: 'Số tiền đặt cọc phải lớn hơn 0' })
    .max(100_000_000_000, { message: 'Số tiền vượt quá hạn mức cho phép' }),
  idempotencyKey: z
    .string()
    .min(1, { message: 'Mã xác thực giao dịch (idempotency key) là bắt buộc' })
    .max(256),
});

/**
 * Action: Tạo đơn hàng từ bảng tính giá (CALCULATED).
 * Allowed roles: BOSS_ADMIN, SALE.
 * Client ONLY supplies priceCalculationId.
 * Server looks up calculation, verifies status is CALCULATED and customer binding,
 * and derives final_amount and payment reference authoritatively.
 */
export async function createOrderFromCalculationAction(input: {
  priceCalculationId: string;
}): Promise<{
  success: boolean;
  orderId?: string;
  orderCode?: string;
  paymentReference?: string;
  error?: string;
}> {
  try {
    const parsed = createOrderSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues.map((e) => e.message).join(', '),
      };
    }

    const actor = await getActorContext();
    if (!actor?.companyId || !actor?.userId) {
      return { success: false, error: 'Chưa xác định danh tính hoặc tổ chức làm việc.' };
    }

    if (actor.role !== APPLICATION_ROLES.BOSS_ADMIN && actor.role !== APPLICATION_ROLES.SALE) {
      return { success: false, error: 'Bạn không có quyền tạo đơn hàng từ bảng tính giá.' };
    }

    const adminClient = createAdminClient();
    const { data: calc, error: calcErr } = await adminClient
      .from('price_calculations')
      .select('id, company_id, customer_id, amount, status')
      .eq('id', parsed.data.priceCalculationId)
      .eq('company_id', actor.companyId)
      .maybeSingle();

    if (calcErr || !calc) {
      return { success: false, error: 'Không tìm thấy bảng tính giá tương ứng trong tổ chức.' };
    }

    if (calc.status === 'NEED_INFO') {
      return {
        success: false,
        error: 'Bảng tính giá ở trạng thái Cần bổ sung thông tin (NEED_INFO). Không thể tạo đơn hàng.',
      };
    }

    if (calc.status !== 'CALCULATED' || calc.amount == null) {
      return {
        success: false,
        error: `Trạng thái bảng tính giá không hợp lệ (${calc.status}). Không thể tạo đơn hàng.`,
      };
    }

    const result = await createOrderFromCalculation({
      companyId: actor.companyId,
      customerId: calc.customer_id,
      priceCalculationId: calc.id,
    });

    revalidatePath('/quotations');
    revalidatePath('/orders');
    revalidatePath('/contracts');

    return {
      success: true,
      orderId: (result as { order_id?: string; id?: string })?.order_id || (result as { id?: string })?.id,
      orderCode: (result as { order_code?: string })?.order_code,
      paymentReference: result.paymentReference,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Lỗi khi tạo đơn hàng từ bảng tính giá';
    return { success: false, error: message };
  }
}

/**
 * Action: Cập nhật thủ công tiền cọc và công nợ đơn hàng.
 * Allowed roles: BOSS_ADMIN ONLY.
 * SALE strictly denied.
 * Idempotency key per logical submission, positive bounded amount.
 */
export async function updateOrderDepositAction(input: {
  orderId: string;
  depositAmount: number;
  idempotencyKey: string;
}): Promise<{
  success: boolean;
  data?: unknown;
  error?: string;
}> {
  try {
    const parsed = updateDepositSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues.map((e) => e.message).join(', '),
      };
    }

    const actor = await getActorContext();
    if (!actor?.companyId || !actor?.userId) {
      return { success: false, error: 'Chưa xác định danh tính hoặc tổ chức làm việc.' };
    }

    if (actor.role !== APPLICATION_ROLES.BOSS_ADMIN) {
      return {
        success: false,
        error: 'Quyền hạn bị từ chối: Chỉ Quản trị viên (Boss) mới được phép ghi nhận cọc thủ công.',
      };
    }

    const res = await updateOrderDepositAndDebt({
      companyId: actor.companyId,
      orderId: parsed.data.orderId,
      depositAmount: parsed.data.depositAmount,
      idempotencyKey: parsed.data.idempotencyKey,
    });

    revalidatePath('/orders');
    revalidatePath('/contracts');

    return { success: true, data: res };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Lỗi khi ghi nhận tiền cọc đơn hàng';
    return { success: false, error: message };
  }
}
