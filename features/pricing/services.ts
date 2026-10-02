import { createAdminClient } from '@/lib/supabase/admin';
import { verifyActorForCompany } from '@/lib/server-auth/authorize';
import { APPLICATION_ROLES } from '@/shared/constants/roles';
import { calculatePrice } from './utils';
import type { SupabaseClient } from '@supabase/supabase-js';

import { adaptSurveyToPricingInput } from '@/features/survey/adapters/pricing.adapter';

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
 * When surveyId is present, the server fetches the completed survey and derives measurements
 * authoritatively via adaptSurveyToPricingInput.
 */
export async function calculateAndSavePriceCalculation(
  params: {
    companyId: string;
    customerId: string;
    surveyId?: string;
    measurements?: Record<string, unknown>;
  },
  client?: SupabaseClient
) {
  const { companyId, customerId, surveyId } = params;

  // 1. Authorize actor
  await verifyActorForCompany(
    companyId,
    { allowedRoles: [APPLICATION_ROLES.BOSS_ADMIN, APPLICATION_ROLES.SALE] },
    client
  );

  const adminClient = createAdminClient();

  // 2. Derive measurements: when surveyId is supplied, fetch authoritative survey
  let canonicalMeasurements = params.measurements || {};
  if (surveyId) {
    const { data: survey, error: surveyError } = await adminClient
      .from('surveys')
      .select('*')
      .eq('id', surveyId)
      .eq('company_id', companyId)
      .maybeSingle();

    if (surveyError || !survey) {
      throw new Error('RESOURCE_NOT_FOUND: Không tìm thấy khảo sát hợp lệ thuộc doanh nghiệp.');
    }
    if (survey.customer_id !== customerId) {
      throw new Error('RESOURCE_NOT_FOUND: Khảo sát không thuộc khách hàng này.');
    }
    canonicalMeasurements = adaptSurveyToPricingInput(survey);
  }

  // 3. Fetch current policy
  const policy = await getActivePricingPolicy(companyId);

  // 4. Compute price
  const calculationResult = calculatePrice(canonicalMeasurements, policy);

  // 5. Persist via atomic RPC (service role only)
  const { data, error } = await adminClient.rpc('save_price_calculation_rpc', {
    p_company_id: companyId,
    p_customer_id: customerId,
    p_survey_id: surveyId || null,
    p_pricing_policy_id: policy.id,
    p_policy_version: policy.version,
    p_input_data: canonicalMeasurements,
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
 * Trusted server calculation and persistence of price calculation directly from a completed survey.
 * Invariants:
 * - Authorizes actor as active SALE or BOSS_ADMIN in the target company.
 * - Server fetches the Survey directly by (surveyId, companyId). Browser NEVER provides measurements or policies.
 * - Validates Customer belongs to target company.
 * - Applies canonical Survey-to-Pricing adapter (clear_width_mm / 1000 -> width_m, barrier_height_mm / 1000 -> height_m).
 * - Fetches active PricingPolicy.
 * - Pure calculation via calculatePrice().
 * - Persists immutable snapshot via save_price_calculation_rpc.
 * - Returns the resulting PriceCalculation.
 */
export async function calculatePriceFromSurvey(
  params: {
    companyId: string;
    surveyId: string;
  },
  client?: SupabaseClient
) {
  const { companyId, surveyId } = params;

  // 1. Authorize actor
  await verifyActorForCompany(
    companyId,
    { allowedRoles: [APPLICATION_ROLES.BOSS_ADMIN, APPLICATION_ROLES.SALE] },
    client
  );

  const adminClient = createAdminClient();

  // 2. Fetch authoritative survey directly from database
  const { data: survey, error: surveyError } = await adminClient
    .from('surveys')
    .select('*')
    .eq('id', surveyId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (surveyError || !survey) {
    throw new Error('RESOURCE_NOT_FOUND: Không tìm thấy khảo sát hợp lệ thuộc doanh nghiệp.');
  }

  // 3. Verify target customer belongs to the company
  const { data: customer, error: customerError } = await adminClient
    .from('customers')
    .select('id, company_id')
    .eq('id', survey.customer_id)
    .eq('company_id', companyId)
    .maybeSingle();

  if (customerError || !customer) {
    throw new Error('RESOURCE_NOT_FOUND: Khách hàng không thuộc doanh nghiệp.');
  }

  // 4. Adapt completed survey using canonical adapter
  const canonicalInput = adaptSurveyToPricingInput(survey);

  // 5. Fetch active PricingPolicy
  const policy = await getActivePricingPolicy(companyId);

  // 6. Compute price fail-closed
  const calculationResult = calculatePrice(canonicalInput, policy);

  // 7. Persist via save_price_calculation_rpc
  const { data, error } = await adminClient.rpc('save_price_calculation_rpc', {
    p_company_id: companyId,
    p_customer_id: survey.customer_id,
    p_survey_id: survey.id,
    p_pricing_policy_id: policy.id,
    p_policy_version: policy.version,
    p_input_data: canonicalInput,
    p_amount: calculationResult.amount,
    p_status: calculationResult.status,
    p_missing_fields: calculationResult.missing_fields,
  });

  if (error) {
    console.error('Lỗi khi lưu bảng tính giá từ khảo sát:', error);
    throw error;
  }

  return {
    id: data.id,
    company_id: companyId,
    customer_id: survey.customer_id,
    survey_id: survey.id,
    pricing_policy_id: policy.id,
    policy_version: policy.version,
    input_data: canonicalInput,
    amount: calculationResult.amount,
    status: calculationResult.status,
    missing_fields: calculationResult.missing_fields,
  };
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
    .select('id, company_id, customer_id, survey_id, pricing_policy_id, policy_version, input_data, amount, status, missing_fields, created_at, customers ( name, customer_code )')
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
