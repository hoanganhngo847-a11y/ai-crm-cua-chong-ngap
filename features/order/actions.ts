'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getActorContext } from '@/lib/auth/context';
import { createAdminClient } from '@/lib/supabase/admin';
import { APPLICATION_ROLES } from '@/shared/constants/roles';
import { ensureContractForDepositConfirmedOrder } from '@/features/contract/services';
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
export async function createOrderFromCalculationAction(
  input: {
    priceCalculationId: string;
  },
  options?: { userClient?: SupabaseClient }
): Promise<{
  success: boolean;
  status?: string;
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

    const actor = await getActorContext(undefined, options?.userClient);
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

    try {
      revalidatePath('/quotations');
      revalidatePath('/orders');
      revalidatePath('/contracts');
    } catch {
      // Revalidation non-fatal in test environment
    }

    return {
      success: true,
      status: result.status,
      orderId: result.orderId,
      orderCode: result.orderCode,
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
export async function updateOrderDepositAction(
  input: {
    orderId: string;
    depositAmount: number;
    idempotencyKey: string;
  },
  options?: { userClient?: SupabaseClient }
): Promise<{
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

    const actor = await getActorContext(undefined, options?.userClient);
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

    try {
      revalidatePath('/orders');
      revalidatePath('/contracts');
    } catch {
      // Revalidation non-fatal in test environment
    }

    return { success: true, data: res };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Lỗi khi ghi nhận tiền cọc đơn hàng';
    return { success: false, error: message };
  }
}

const recoverContractSchema = z.object({
  orderId: z.string().uuid({ message: 'Mã đơn hàng không hợp lệ' }),
});

/**
 * Action: Tạo / Khôi phục hợp đồng cho đơn hàng đã xác nhận đặt cọc (DEPOSIT_CONFIRMED).
 * Allowed roles: BOSS_ADMIN, SALE.
 * Server remains authoritative: verifies order ownership, deposit confirmation,
 * derives canonical contract facts, and reuses existing contract safely.
 */
export async function recoverOrderContractAction(
  input: {
    orderId: string;
  },
  options?: { userClient?: SupabaseClient }
): Promise<{
  success: boolean;
  contractId?: string;
  contractStatus?: string;
  contractGenerationStatus?: string;
  error?: string;
}> {
  try {
    const parsed = recoverContractSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues.map((e) => e.message).join(', '),
      };
    }

    const actor = await getActorContext(undefined, options?.userClient);
    if (!actor?.companyId || !actor?.userId) {
      return { success: false, error: 'Chưa xác định danh tính hoặc tổ chức làm việc.' };
    }

    if (actor.role !== APPLICATION_ROLES.BOSS_ADMIN && actor.role !== APPLICATION_ROLES.SALE) {
      return {
        success: false,
        error: 'Bạn không có quyền tạo hoặc khôi phục hợp đồng cho đơn hàng này.',
      };
    }

    const res = await ensureContractForDepositConfirmedOrder(actor.companyId, parsed.data.orderId);

    try {
      revalidatePath('/orders');
      revalidatePath('/contracts');
    } catch {
      // Revalidation non-fatal in test environment
    }

    return {
      success: true,
      contractId: res.contractId,
      contractStatus: res.status,
      contractGenerationStatus: res.contractGenerationStatus,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Lỗi khi tạo / khôi phục hợp đồng';
    return { success: false, error: message };
  }
}
