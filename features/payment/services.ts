import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { ensureContractForDepositConfirmedOrder } from '@/features/contract/services';

export interface PaymentWebhookPayload {
  provider: string;
  provider_account: string;
  provider_ref: string;
  amount: number;
  occurred_at: string;
  transfer_content: string;
}

/**
 * Handles incoming provider payment webhook.
 * Dispatches to atomic process_payment_webhook_rpc and automatically triggers
 * contract generation or recovery if deposit threshold is reached.
 */
export async function processPaymentWebhook(payload: PaymentWebhookPayload, client?: SupabaseClient) {
  const { provider, provider_account, provider_ref, amount, occurred_at, transfer_content } = payload;

  if (!provider || !provider_account || !provider_ref || !amount || amount <= 0 || !occurred_at) {
    throw new Error('INVALID_INPUT: Thiếu trường bắt buộc trong thanh toán');
  }

  // 1. Extract payment reference from transfer content (e.g. DH-12345, DH-ABCD)
  const paymentRefMatch = (transfer_content || '').match(/DH-[A-Z0-9]+/i);
  const matchedPaymentRef = paymentRefMatch ? paymentRefMatch[0].toUpperCase() : '';

  // 2. Call atomic RPC
  const adminSupabase = client || createAdminClient();
  const { data, error } = await adminSupabase.rpc('process_payment_webhook_rpc', {
    p_provider: provider,
    p_provider_account: provider_account,
    p_provider_ref: provider_ref,
    p_amount: amount,
    p_occurred_at: occurred_at,
    p_transfer_content: transfer_content || '',
    p_payment_reference: matchedPaymentRef,
  });

  if (error) {
    console.error('Lỗi khi gọi process_payment_webhook_rpc:', error);
    throw new Error(error.message || String(error));
  }

  // 3. Automated contract generation and recovery if canonical order is DEPOSIT_CONFIRMED
  // For both MATCHED and ALREADY_PROCESSED: when orderId exists, re-read canonical Order state.
  if (data?.orderId) {
    try {
      const { data: order } = await adminSupabase
        .from('orders')
        .select('id, company_id, deposit_status')
        .eq('id', data.orderId)
        .maybeSingle();

      if (
        order &&
        (order.deposit_status === 'CONFIRMED' || order.deposit_status === 'DEPOSIT_CONFIRMED')
      ) {
        await ensureContractForDepositConfirmedOrder(order.company_id, order.id, adminSupabase);
      }
    } catch (genError) {
      console.error('Lỗi khi tự động sinh / khôi phục hợp đồng từ webhook thanh toán:', genError);
    }
  }

  return data;
}
