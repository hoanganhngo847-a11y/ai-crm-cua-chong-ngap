import { createAdminClient } from '@/lib/supabase/admin';
import { verifyActorForCompany } from '@/lib/server-auth/authorize';
import { APPLICATION_ROLES } from '@/shared/constants/roles';
import { calculatePrice } from './utils';
import type { SupabaseClient } from '@supabase/supabase-js';

export async function getActivePricingPolicy(companyId: string) {
  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from('pricing_policies')
    .select('*')
    .eq('company_id', companyId)
    .eq('status', 'ACTIVE')
    .order('effective_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    throw new Error('POLICY_CONFIGURATION_ERROR: Không tìm thấy chính sách giá hiệu lực');
  }

  return data;
}

/**
 * Calculates and persists an immutable price calculation snapshot via trusted server RPC.
 */
export async function calculateAndSavePriceCalculation(
  params: {
    companyId: string;
    customerId: string;
    surveyId?: string;
    measurements: Record<string, unknown>;
  },
  client?: SupabaseClient
) {
  const { companyId, customerId, surveyId, measurements } = params;

  // 1. Authorize actor
  await verifyActorForCompany(
    companyId,
    { allowedRoles: [APPLICATION_ROLES.BOSS_ADMIN, APPLICATION_ROLES.SALE] },
    client
  );

  // 2. Fetch current policy
  const policy = await getActivePricingPolicy(companyId);

  // 3. Compute price
  const calculationResult = calculatePrice(measurements, policy);

  // 4. Persist via atomic RPC (service role only)
  const adminClient = createAdminClient();
  const { data, error } = await adminClient.rpc('save_price_calculation_rpc', {
    p_company_id: companyId,
    p_customer_id: customerId,
    p_survey_id: surveyId || null,
    p_pricing_policy_id: policy.id,
    p_policy_version: policy.version,
    p_input_data: measurements,
    p_amount: calculationResult.amount,
    p_status: calculationResult.status,
    p_missing_fields: calculationResult.missing_fields,
  });

  if (error) {
    console.error('Lỗi khi lưu lịch sử tính giá:', error);
    throw error;
  }

  return data;
}

/**
 * Trusted server retrieval of price calculations for a company.
 */
export async function getPriceCalculations(
  companyId: string,
  customerId?: string,
  client?: SupabaseClient
) {
  // Authorize actor
  await verifyActorForCompany(
    companyId,
    { allowedRoles: [APPLICATION_ROLES.BOSS_ADMIN, APPLICATION_ROLES.SALE] },
    client
  );

  const adminClient = createAdminClient();
  let query = adminClient
    .from('price_calculations')
    .select('id, company_id, customer_id, survey_id, pricing_policy_id, policy_version, input_data, amount, status, missing_fields, created_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });

  if (customerId) {
    query = query.eq('customer_id', customerId);
  }

  const { data, error } = await query;
  if (error) {
    console.error('Lỗi khi lấy danh sách tính giá:', error);
    return [];
  }
  return data;
}

/**
 * Trusted server retrieval of a single price calculation.
 */
export async function getPriceCalculationById(
  companyId: string,
  calculationId: string,
  client?: SupabaseClient
) {
  await verifyActorForCompany(
    companyId,
    { allowedRoles: [APPLICATION_ROLES.BOSS_ADMIN, APPLICATION_ROLES.SALE] },
    client
  );

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from('price_calculations')
    .select('*')
    .eq('company_id', companyId)
    .eq('id', calculationId)
    .maybeSingle();

  if (error || !data) {
    return null;
  }
  return data;
}
