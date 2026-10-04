import { createAdminClient } from '@/lib/supabase/admin';
import { verifyActorForCompany } from '@/lib/server-auth/authorize';
import { APPLICATION_ROLES } from '@/shared/constants/roles';
import { ensureContractForDepositConfirmedOrder } from '@/features/contract/services';
import type { SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';

/**
 * Server-authoritative Order Creation from a validated price calculation snapshot.
 * Protected by database-authoritative UNIQUE (company_id, price_calculation_id) and idempotent RPC.
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

  // 2. Generate candidate server payment reference
  const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  const paymentReference = `DH-${Date.now().toString().slice(-4)}${randomSuffix}`;

  const adminSupabase = createAdminClient();

  // 3. Authoritative lock + idempotent check executed inside RPC
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

  const canonicalPaymentRef = data.paymentReference || paymentReference;

  return {
    status: data.status,
    orderId: data.orderId,
    orderCode: data.orderCode,
    finalAmount: data.finalAmount,
    depositStatus: data.depositStatus,
    orderStatus: data.orderStatus,
    paymentReference: canonicalPaymentRef,
    // Backwards compatibility aliases
    order_id: data.orderId,
    order_code: data.orderCode,
  };
}

/**
 * Updates manual order deposit and debt (BOSS_ADMIN only).
 * If deposit threshold is reached, automatically triggers contract generation / recovery.
 */
export async function updateOrderDepositAndDebt(
  params: {
    companyId: string;
    orderId: string;
    depositAmount: number;
    idempotencyKey: string;
  },
  client?: SupabaseClient,
  adminClientOverride?: SupabaseClient
) {
  const { companyId, orderId, depositAmount, idempotencyKey } = params;

  // 1. Trusted Server Authorization: BOSS_ADMIN required
  const actor = await verifyActorForCompany(
    companyId,
    { allowedRoles: [APPLICATION_ROLES.BOSS_ADMIN] },
    client
  );

  const adminSupabase = adminClientOverride || createAdminClient();

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

  // 3. Re-read canonical Order state to determine deposit status & ensure contract recovery
  const { data: orderRow } = await adminSupabase
    .from('orders')
    .select('id, company_id, deposit_status')
    .eq('id', orderId)
    .eq('company_id', companyId)
    .maybeSingle();

  const isDepositConfirmed =
    orderRow?.deposit_status === 'CONFIRMED' || orderRow?.deposit_status === 'DEPOSIT_CONFIRMED';

  let contractId: string | null = null;
  let contractStatus: string | null = null;
  let contractGenerationStatus: 'GENERATED' | 'ALREADY_EXISTS' | 'PENDING_RECOVERY' | 'NOT_ELIGIBLE' =
    isDepositConfirmed ? 'PENDING_RECOVERY' : 'NOT_ELIGIBLE';

  if (isDepositConfirmed) {
    try {
      const contractRes = await ensureContractForDepositConfirmedOrder(companyId, orderId, adminSupabase);
      contractId = contractRes.contractId;
      contractStatus = contractRes.status;
      contractGenerationStatus =
        (contractRes.contractGenerationStatus as 'GENERATED' | 'ALREADY_EXISTS') || 'GENERATED';
    } catch (genError) {
      console.error('Lỗi khi tự động tạo/khôi phục hợp đồng sau cọc:', genError);
      contractGenerationStatus = 'PENDING_RECOVERY';
    }
  }

  return {
    ...data,
    depositConfirmed: isDepositConfirmed,
    contractId,
    contractStatus,
    contractGenerationStatus,
  };
}

export interface OrderListItemDTO {
  id: string;
  orderCode: string;
  customerId: string;
  customerName: string;
  customerCode?: string;
  finalAmount: number;
  depositStatus: string;
  orderStatus: string;
  paymentReference: string;
  collectedAmount: number;
  receivableAmount: number;
  depositConfirmed: boolean;
  contractId: string | null;
  contractStatus: string | null;
  contractRevision: number | null;
  isContractSigned: boolean;
  productionOrderId: string | null;
  productionStatus: string | null;
  createdAt: string;
}

/**
 * Trusted server projection for Orders list.
 * Authorizes BOSS_ADMIN and SALE.
 */
export async function getOrdersWithDetails(
  companyId: string,
  client?: SupabaseClient
): Promise<OrderListItemDTO[]> {
  await verifyActorForCompany(
    companyId,
    { allowedRoles: [APPLICATION_ROLES.BOSS_ADMIN, APPLICATION_ROLES.SALE] },
    client
  );

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from('orders')
    .select(`
      id,
      order_code,
      customer_id,
      final_amount,
      deposit_status,
      order_status,
      payment_reference,
      created_at,
      customers (
        id,
        name,
        customer_code
      ),
      finance_summaries (
        contract_value,
        collected_amount,
        receivable_amount
      ),
      contracts (
        id,
        status,
        revision_no,
        is_current,
        generated_file_ref,
        signed_file_ref
      ),
      production_orders (
        id,
        status
      )
    `)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });

  if (error || !data) {
    console.error('Lỗi khi lấy danh sách đơn hàng:', error);
    return [];
  }

  interface OrderQueryRow {
    id: string;
    order_code: string;
    customer_id: string;
    final_amount: number;
    deposit_status: string;
    order_status: string;
    payment_reference: string;
    created_at: string;
    customers?: { id?: string; name?: string; customer_code?: string } | null;
    finance_summaries?: { contract_value?: number; collected_amount?: number; receivable_amount?: number } | null;
    contracts?: Array<{ id: string; status: string; revision_no: number; is_current: boolean; generated_file_ref?: string | null; signed_file_ref?: string | null }> | null;
    production_orders?: { id?: string; status?: string } | null;
  }

  return (data as unknown as OrderQueryRow[]).map((row) => {
    const cust = row.customers || {};
    const fin = row.finance_summaries || {};
    const currentContract = Array.isArray(row.contracts)
      ? row.contracts.find((c) => c.is_current && c.status !== 'SUPERSEDED') || row.contracts[0] || null
      : null;
    const isUsableContract = Boolean(
      currentContract &&
      currentContract.generated_file_ref &&
      currentContract.generated_file_ref !== 'CLAIMED'
    );
    const prod = row.production_orders || null;

    const collected = Number(fin.collected_amount ?? 0);
    const finalAmt = Number(row.final_amount ?? 0);
    const receivable = Number(fin.receivable_amount ?? (finalAmt - collected));

    return {
      id: row.id,
      orderCode: row.order_code,
      customerId: row.customer_id,
      customerName: cust.name || 'Khách hàng',
      customerCode: cust.customer_code,
      finalAmount: finalAmt,
      depositStatus: row.deposit_status,
      orderStatus: row.order_status,
      paymentReference: row.payment_reference,
      collectedAmount: collected,
      receivableAmount: receivable,
      depositConfirmed: row.deposit_status === 'CONFIRMED' || row.deposit_status === 'DEPOSIT_CONFIRMED',
      contractId: isUsableContract && currentContract ? currentContract.id : null,
      contractStatus: isUsableContract && currentContract ? currentContract.status : null,
      contractRevision: isUsableContract && currentContract ? currentContract.revision_no : null,
      isContractSigned: Boolean(currentContract?.signed_file_ref && currentContract?.status === 'SIGNED'),
      productionOrderId: prod?.id || null,
      productionStatus: prod?.status || null,
      createdAt: row.created_at,
    };
  });
}
