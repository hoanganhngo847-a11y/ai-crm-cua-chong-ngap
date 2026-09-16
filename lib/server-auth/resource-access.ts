import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../supabase/admin';
import { APPLICATION_ROLES, type ApplicationRole } from '../../shared/constants/roles';
import {
  TECHNICIAN_ASSIGNMENT_STATUSES,
  CONTACT_ACCESS_PURPOSES,
  type ContactAccessPurpose,
} from '../../shared/contracts/sensitive';
import { ServerAuthError } from './errors';
import { verifyActorForCompany } from './authorize';
import type { TrustedActorContext } from './sensitive-context';

export interface CustomerResourceRow {
  id: string;
  company_id: string;
  customer_code: string;
  name: string;
  stage: string;
}

export interface AppointmentResourceRow {
  id: string;
  company_id: string;
  customer_id: string;
  type: string;
  assignee_id: string;
  address: string;
  status: string;
  start_time: string;
}

export interface SurveyResourceRow {
  id: string;
  company_id: string;
  customer_id: string;
  appointment_id: string;
  completed_by: string;
  site_condition: string;
  notes: string | null;
  completed_at: string;
  photos: unknown;
  measurements: unknown;
}

export interface InstallationResourceRow {
  id: string;
  company_id: string;
  customer_id: string;
  order_id: string;
  appointment_id: string;
  status: string;
  photos: unknown;
  handover_ref: string | null;
  completed_at: string | null;
}

export interface OrderResourceRow {
  id: string;
  company_id: string;
  customer_id: string;
  order_code: string;
  payment_reference: string;
  price_calculation_id: string;
  deposit_status: string;
  order_status: string;
  final_amount: number;
}

export interface ContractResourceRow {
  id: string;
  company_id: string;
  order_id: string;
  revision_no: number;
  template_version: string;
  generated_file_ref: string;
  signed_file_ref: string | null;
  status: string;
  contract_value: number;
  is_current: boolean;
}

export interface PaymentResourceRow {
  id: string;
  company_id: string;
  provider: string;
  provider_account: string;
  provider_ref: string;
  amount: number;
  occurred_at: string;
  transfer_content: string;
  matched_order_id: string | null;
  match_confidence: number | null;
  status: string;
}

export interface InteractionResourceRow {
  id: string;
  company_id: string;
  customer_id: string;
  conversation_id: string | null;
  channel: string;
  type: string;
  direction: string;
  sanitized_content: string | null;
  sanitization_status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'NOT_REQUIRED';
  sanitized_at: string | null;
  actor_type: string;
  actor_user_id: string | null;
  created_at: string;
}

/**
 * Internal private helper to mask cross-tenant access attempts as 404 RESOURCE_NOT_FOUND
 * to eliminate IDOR resource enumeration vulnerabilities.
 * Never exported.
 */
async function verifyActorWithTenantMasking(
  derivedCompanyId: string,
  allowedRoles?: ApplicationRole[],
  options: { requireAal2?: boolean } = {},
  client?: SupabaseClient
): Promise<TrustedActorContext> {
  try {
    return await verifyActorForCompany(
      derivedCompanyId,
      { allowedRoles, requireAal2: options.requireAal2 },
      client
    );
  } catch (err: unknown) {
    if (err instanceof ServerAuthError) {
      if (err.code === 'NOT_A_MEMBER') {
        // Mask cross-tenant lookup as 404 RESOURCE_NOT_FOUND
        throw new ServerAuthError('Không tìm thấy tài nguyên.', 404, 'RESOURCE_NOT_FOUND');
      }
    }
    throw err;
  }
}

/**
 * Authorizes access to a customer starting from customerId.
 *
 * Sequence:
 * 1. Minimal metadata lookup (id, company_id only).
 * 2. Actor authentication & tenancy derivation.
 * 3. Fixed application policy mapped from purpose (NO caller-supplied allowedRoles).
 * 4. Only after authorization passes: load full customer row.
 */
export async function authorizeCustomerAccess(
  customerId: string,
  purpose: ContactAccessPurpose | 'CRM_VIEW' = 'CRM_VIEW',
  client?: SupabaseClient
): Promise<{ actor: TrustedActorContext; customer: CustomerResourceRow }> {
  if (!customerId) {
    throw new ServerAuthError('Mã khách hàng không hợp lệ.', 400, 'RESOURCE_NOT_FOUND');
  }

  const adminClient = createAdminClient();

  // STEP 1: Minimal pre-auth metadata projection
  const { data: minimal, error: minError } = await adminClient
    .from('customers')
    .select('id, company_id')
    .eq('id', customerId)
    .maybeSingle();

  if (minError || !minimal) {
    throw new ServerAuthError('Không tìm thấy khách hàng.', 404, 'RESOURCE_NOT_FOUND');
  }

  // STEP 2 & 3: Fixed policy mapping
  let allowedRoles: ApplicationRole[] = [APPLICATION_ROLES.BOSS_ADMIN, APPLICATION_ROLES.SALE];
  let requireAal2 = false;

  if (purpose === CONTACT_ACCESS_PURPOSES.PRIVILEGED_ADMIN_OPERATION) {
    allowedRoles = [APPLICATION_ROLES.BOSS_ADMIN];
    requireAal2 = process.env.NODE_ENV === 'production';
  } else if (purpose === CONTACT_ACCESS_PURPOSES.CLICK_TO_CALL) {
    // Frozen rule: BOSS_ADMIN and SALE are allowed; TECHNICIAN is forbidden.
    allowedRoles = [APPLICATION_ROLES.BOSS_ADMIN, APPLICATION_ROLES.SALE];
  }

  const actor = await verifyActorWithTenantMasking(
    minimal.company_id,
    allowedRoles,
    { requireAal2 },
    client
  );

  // STEP 4: Post-auth projection
  const { data: customer, error } = await adminClient
    .from('customers')
    .select('id, company_id, customer_code, name, stage')
    .eq('id', customerId)
    .single();

  if (error || !customer) {
    throw new ServerAuthError('Không tìm thấy khách hàng.', 404, 'RESOURCE_NOT_FOUND');
  }

  return { actor, customer: customer as CustomerResourceRow };
}

/**
 * Authorizes access to an appointment starting from appointmentId.
 *
 * Sequence:
 * 1. Minimal metadata lookup (id, company_id, assignee_id, status).
 * 2. Actor authentication & tenancy verification.
 * 3. Strict technician active assignment check:
 *    Allowed statuses: ASSIGNED, ACCEPTED, IN_PROGRESS.
 *    Historical/completed appointments do not authorize.
 * 4. Post-auth payload projection.
 */
export async function authorizeAppointmentAccess(
  appointmentId: string,
  client?: SupabaseClient
): Promise<{ actor: TrustedActorContext; appointment: AppointmentResourceRow }> {
  if (!appointmentId) {
    throw new ServerAuthError('Mã lịch hẹn không hợp lệ.', 400, 'RESOURCE_NOT_FOUND');
  }

  const adminClient = createAdminClient();

  // STEP 1: Minimal pre-auth metadata projection
  const { data: minimal, error: minError } = await adminClient
    .from('appointments')
    .select('id, company_id, assignee_id, status')
    .eq('id', appointmentId)
    .maybeSingle();

  if (minError || !minimal) {
    throw new ServerAuthError('Không tìm thấy lịch hẹn.', 404, 'RESOURCE_NOT_FOUND');
  }

  // STEP 2: Actor & tenancy verification (fixed roles)
  const allowedRoles = [
    APPLICATION_ROLES.BOSS_ADMIN,
    APPLICATION_ROLES.SALE,
    APPLICATION_ROLES.TECHNICIAN,
  ];

  const actor = await verifyActorWithTenantMasking(
    minimal.company_id,
    allowedRoles,
    {},
    client
  );

  // STEP 3: Technician assignment validation
  if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
    if (minimal.assignee_id !== actor.userId) {
      throw new ServerAuthError('Kỹ thuật viên không được phân công lịch hẹn này.', 403, 'ROLE_FORBIDDEN');
    }

    const activeStatuses: readonly string[] = [
      TECHNICIAN_ASSIGNMENT_STATUSES.ASSIGNED,
      TECHNICIAN_ASSIGNMENT_STATUSES.ACCEPTED,
      TECHNICIAN_ASSIGNMENT_STATUSES.IN_PROGRESS,
    ];

    if (!activeStatuses.includes(minimal.status)) {
      throw new ServerAuthError(
        'Lịch hẹn không ở trạng thái hoạt động được phân công.',
        403,
        'ASSIGNMENT_INACTIVE'
      );
    }
  }

  // STEP 4: Post-auth projection
  const { data: appointment, error } = await adminClient
    .from('appointments')
    .select('id, company_id, customer_id, type, assignee_id, address, status, start_time')
    .eq('id', appointmentId)
    .single();

  if (error || !appointment) {
    throw new ServerAuthError('Không tìm thấy lịch hẹn.', 404, 'RESOURCE_NOT_FOUND');
  }

  return { actor, appointment: appointment as AppointmentResourceRow };
}

/**
 * Authorizes access to a survey starting from surveyId.
 *
 * Sequence:
 * 1. Minimal metadata lookup (id, company_id, appointment_id).
 * 2. Actor authentication & tenancy verification.
 * 3. Linked appointment active assignment validation for technicians.
 * 4. Post-auth payload projection.
 */
export async function authorizeSurveyAccess(
  surveyId: string,
  client?: SupabaseClient
): Promise<{ actor: TrustedActorContext; survey: SurveyResourceRow }> {
  if (!surveyId) {
    throw new ServerAuthError('Mã khảo sát không hợp lệ.', 400, 'RESOURCE_NOT_FOUND');
  }

  const adminClient = createAdminClient();

  // STEP 1: Minimal pre-auth metadata projection
  const { data: minimal, error: minError } = await adminClient
    .from('surveys')
    .select('id, company_id, appointment_id')
    .eq('id', surveyId)
    .maybeSingle();

  if (minError || !minimal) {
    throw new ServerAuthError('Không tìm thấy bản khảo sát.', 404, 'RESOURCE_NOT_FOUND');
  }

  // STEP 2: Actor & tenancy verification (fixed roles)
  const allowedRoles = [
    APPLICATION_ROLES.BOSS_ADMIN,
    APPLICATION_ROLES.SALE,
    APPLICATION_ROLES.TECHNICIAN,
  ];

  const actor = await verifyActorWithTenantMasking(
    minimal.company_id,
    allowedRoles,
    {},
    client
  );

  // STEP 3: Technician assignment validation on linked appointment
  if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
    const { data: apptRow, error: apptError } = await adminClient
      .from('appointments')
      .select('id, company_id, assignee_id, status')
      .eq('id', minimal.appointment_id)
      .maybeSingle();

    if (apptError || !apptRow) {
      throw new ServerAuthError('Không tìm thấy lịch hẹn liên kết của khảo sát.', 404, 'RESOURCE_NOT_FOUND');
    }

    if (apptRow.assignee_id !== actor.userId) {
      throw new ServerAuthError('Kỹ thuật viên không được phân công khảo sát này.', 403, 'ROLE_FORBIDDEN');
    }

    const activeStatuses: readonly string[] = [
      TECHNICIAN_ASSIGNMENT_STATUSES.ASSIGNED,
      TECHNICIAN_ASSIGNMENT_STATUSES.ACCEPTED,
      TECHNICIAN_ASSIGNMENT_STATUSES.IN_PROGRESS,
    ];

    if (!activeStatuses.includes(apptRow.status)) {
      throw new ServerAuthError(
        'Lịch hẹn liên kết khảo sát đã kết thúc hoặc không hoạt động.',
        403,
        'ASSIGNMENT_INACTIVE'
      );
    }
  }

  // STEP 4: Post-auth projection
  const { data: survey, error } = await adminClient
    .from('surveys')
    .select('id, company_id, customer_id, appointment_id, completed_by, site_condition, notes, completed_at, photos, measurements')
    .eq('id', surveyId)
    .single();

  if (error || !survey) {
    throw new ServerAuthError('Không tìm thấy bản khảo sát.', 404, 'RESOURCE_NOT_FOUND');
  }

  return { actor, survey: survey as SurveyResourceRow };
}

/**
 * Authorizes access to an installation starting from installationId.
 *
 * Sequence:
 * 1. Minimal metadata lookup (id, company_id, appointment_id, status).
 * 2. Actor authentication & tenancy verification.
 * 3. Linked appointment active assignment validation for technicians.
 * 4. Post-auth payload projection.
 */
export async function authorizeInstallationAccess(
  installationId: string,
  client?: SupabaseClient
): Promise<{ actor: TrustedActorContext; installation: InstallationResourceRow }> {
  if (!installationId) {
    throw new ServerAuthError('Mã lắp đặt không hợp lệ.', 400, 'RESOURCE_NOT_FOUND');
  }

  const adminClient = createAdminClient();

  // STEP 1: Minimal pre-auth metadata projection
  const { data: minimal, error: minError } = await adminClient
    .from('installations')
    .select('id, company_id, appointment_id, status')
    .eq('id', installationId)
    .maybeSingle();

  if (minError || !minimal) {
    throw new ServerAuthError('Không tìm thấy hồ sơ lắp đặt.', 404, 'RESOURCE_NOT_FOUND');
  }

  // STEP 2: Actor & tenancy verification (fixed roles)
  const allowedRoles = [
    APPLICATION_ROLES.BOSS_ADMIN,
    APPLICATION_ROLES.SALE,
    APPLICATION_ROLES.TECHNICIAN,
  ];

  const actor = await verifyActorWithTenantMasking(
    minimal.company_id,
    allowedRoles,
    {},
    client
  );

  // STEP 3: Technician assignment validation on linked appointment
  if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
    const { data: apptRow, error: apptError } = await adminClient
      .from('appointments')
      .select('id, company_id, assignee_id, status')
      .eq('id', minimal.appointment_id)
      .maybeSingle();

    if (apptError || !apptRow) {
      throw new ServerAuthError('Không tìm thấy lịch hẹn liên kết của lắp đặt.', 404, 'RESOURCE_NOT_FOUND');
    }

    if (apptRow.assignee_id !== actor.userId) {
      throw new ServerAuthError('Kỹ thuật viên không được phân công lắp đặt này.', 403, 'ROLE_FORBIDDEN');
    }

    const activeStatuses: readonly string[] = [
      TECHNICIAN_ASSIGNMENT_STATUSES.ASSIGNED,
      TECHNICIAN_ASSIGNMENT_STATUSES.ACCEPTED,
      TECHNICIAN_ASSIGNMENT_STATUSES.IN_PROGRESS,
    ];

    if (!activeStatuses.includes(apptRow.status)) {
      throw new ServerAuthError(
        'Lịch hẹn liên kết lắp đặt đã kết thúc hoặc không hoạt động.',
        403,
        'ASSIGNMENT_INACTIVE'
      );
    }
  }

  // STEP 4: Post-auth projection
  const { data: installation, error } = await adminClient
    .from('installations')
    .select('id, company_id, customer_id, order_id, appointment_id, status, photos, handover_ref, completed_at')
    .eq('id', installationId)
    .single();

  if (error || !installation) {
    throw new ServerAuthError('Không tìm thấy hồ sơ lắp đặt.', 404, 'RESOURCE_NOT_FOUND');
  }

  return { actor, installation: installation as InstallationResourceRow };
}

/**
 * Authorizes access to an order starting from orderId.
 * STRICT SECURITY: Fixed allowed roles [BOSS_ADMIN, SALE]. Policy widening is prohibited.
 */
export async function authorizeOrderAccess(
  orderId: string,
  client?: SupabaseClient
): Promise<{ actor: TrustedActorContext; order: OrderResourceRow }> {
  if (!orderId) {
    throw new ServerAuthError('Mã đơn hàng không hợp lệ.', 400, 'RESOURCE_NOT_FOUND');
  }

  const adminClient = createAdminClient();

  // STEP 1: Minimal pre-auth metadata projection
  const { data: minimal, error: minError } = await adminClient
    .from('orders')
    .select('id, company_id')
    .eq('id', orderId)
    .maybeSingle();

  if (minError || !minimal) {
    throw new ServerAuthError('Không tìm thấy đơn hàng.', 404, 'RESOURCE_NOT_FOUND');
  }

  // STEP 2: Actor verification with fixed policy
  const actor = await verifyActorWithTenantMasking(
    minimal.company_id,
    [APPLICATION_ROLES.BOSS_ADMIN, APPLICATION_ROLES.SALE],
    {},
    client
  );

  // STEP 3: Post-auth projection
  const { data: order, error } = await adminClient
    .from('orders')
    .select('id, company_id, customer_id, order_code, payment_reference, price_calculation_id, deposit_status, order_status, final_amount')
    .eq('id', orderId)
    .single();

  if (error || !order) {
    throw new ServerAuthError('Không tìm thấy đơn hàng.', 404, 'RESOURCE_NOT_FOUND');
  }

  return { actor, order: order as OrderResourceRow };
}

/**
 * Authorizes access to a contract starting from contractId.
 * STRICT SECURITY: Fixed allowed roles [BOSS_ADMIN, SALE]. Policy widening is prohibited.
 */
export async function authorizeContractAccess(
  contractId: string,
  client?: SupabaseClient
): Promise<{ actor: TrustedActorContext; contract: ContractResourceRow }> {
  if (!contractId) {
    throw new ServerAuthError('Mã hợp đồng không hợp lệ.', 400, 'RESOURCE_NOT_FOUND');
  }

  const adminClient = createAdminClient();

  // STEP 1: Minimal pre-auth metadata projection
  const { data: minimal, error: minError } = await adminClient
    .from('contracts')
    .select('id, company_id')
    .eq('id', contractId)
    .maybeSingle();

  if (minError || !minimal) {
    throw new ServerAuthError('Không tìm thấy hợp đồng.', 404, 'RESOURCE_NOT_FOUND');
  }

  // STEP 2: Actor verification with fixed policy
  const actor = await verifyActorWithTenantMasking(
    minimal.company_id,
    [APPLICATION_ROLES.BOSS_ADMIN, APPLICATION_ROLES.SALE],
    {},
    client
  );

  // STEP 3: Post-auth projection
  const { data: contract, error } = await adminClient
    .from('contracts')
    .select('id, company_id, order_id, revision_no, template_version, generated_file_ref, signed_file_ref, status, contract_value, is_current')
    .eq('id', contractId)
    .single();

  if (error || !contract) {
    throw new ServerAuthError('Không tìm thấy hợp đồng.', 404, 'RESOURCE_NOT_FOUND');
  }

  return { actor, contract: contract as ContractResourceRow };
}

/**
 * Authorizes access to a payment transaction starting from paymentId.
 * STRICT SECURITY: BOSS_ADMIN only! SALE and TECHNICIAN are completely forbidden.
 * Policy widening through caller arguments is STRICTLY PREVENTED.
 */
export async function authorizePaymentAccess(
  paymentId: string,
  client?: SupabaseClient
): Promise<{ actor: TrustedActorContext; payment: PaymentResourceRow }> {
  if (!paymentId) {
    throw new ServerAuthError('Mã giao dịch không hợp lệ.', 400, 'RESOURCE_NOT_FOUND');
  }

  const adminClient = createAdminClient();

  // STEP 1: Minimal pre-auth metadata projection (id, company_id only)
  const { data: minimal, error: minError } = await adminClient
    .from('payment_transactions')
    .select('id, company_id')
    .eq('id', paymentId)
    .maybeSingle();

  if (minError || !minimal) {
    throw new ServerAuthError('Không tìm thấy giao dịch thanh toán.', 404, 'RESOURCE_NOT_FOUND');
  }

  // STEP 2: Actor verification (BOSS_ADMIN only)
  const actor = await verifyActorWithTenantMasking(
    minimal.company_id,
    [APPLICATION_ROLES.BOSS_ADMIN],
    {},
    client
  );

  // STEP 3: Post-auth projection
  const { data: payment, error } = await adminClient
    .from('payment_transactions')
    .select('id, company_id, provider, provider_account, provider_ref, amount, occurred_at, transfer_content, matched_order_id, match_confidence, status')
    .eq('id', paymentId)
    .single();

  if (error || !payment) {
    throw new ServerAuthError('Không tìm thấy giao dịch thanh toán.', 404, 'RESOURCE_NOT_FOUND');
  }

  return { actor, payment: payment as PaymentResourceRow };
}

/**
 * Authorizes access to an interaction starting from interactionId.
 *
 * Sequence:
 * 1. Minimal metadata lookup (id, company_id, type, actor_type, sanitization_status).
 * 2. Actor verification according to purpose:
 *    - SANITIZED_READ: BOSS_ADMIN, SALE
 *    - PRIVILEGED_AUDIT: BOSS_ADMIN with AAL2
 * 3. Post-auth projection.
 */
export async function authorizeInteractionAccess(
  interactionId: string,
  purpose: 'SANITIZED_READ' | 'PRIVILEGED_AUDIT' = 'SANITIZED_READ',
  client?: SupabaseClient
): Promise<{ actor: TrustedActorContext; interaction: InteractionResourceRow }> {
  if (!interactionId) {
    throw new ServerAuthError('Mã tương tác không hợp lệ.', 400, 'RESOURCE_NOT_FOUND');
  }

  const adminClient = createAdminClient();

  // STEP 1: Minimal pre-auth metadata projection
  const { data: minimal, error: minError } = await adminClient
    .from('interactions')
    .select('id, company_id, type, actor_type, sanitization_status')
    .eq('id', interactionId)
    .maybeSingle();

  if (minError || !minimal) {
    throw new ServerAuthError('Không tìm thấy tương tác.', 404, 'RESOURCE_NOT_FOUND');
  }

  // STEP 2: Policy mapping
  const allowedRoles =
    purpose === 'PRIVILEGED_AUDIT'
      ? [APPLICATION_ROLES.BOSS_ADMIN]
      : [APPLICATION_ROLES.BOSS_ADMIN, APPLICATION_ROLES.SALE];

  const requireAal2 =
    purpose === 'PRIVILEGED_AUDIT' && process.env.NODE_ENV === 'production';

  const actor = await verifyActorWithTenantMasking(
    minimal.company_id,
    allowedRoles,
    { requireAal2 },
    client
  );

  // STEP 3: Post-auth projection
  const { data: interaction, error } = await adminClient
    .from('interactions')
    .select('id, company_id, customer_id, conversation_id, channel, type, direction, sanitized_content, sanitization_status, sanitized_at, actor_type, actor_user_id, created_at')
    .eq('id', interactionId)
    .single();

  if (error || !interaction) {
    throw new ServerAuthError('Không tìm thấy tương tác.', 404, 'RESOURCE_NOT_FOUND');
  }

  return { actor, interaction: interaction as InteractionResourceRow };
}

export interface CallResourceRow {
  id: string;
  company_id: string;
  customer_id: string;
  direction: string;
  agent_type: string;
  provider: string;
  provider_call_id: string | null;
  started_at: string;
  ended_at: string | null;
  status: string;
  recording_ref: string | null;
  transcript_status: string;
  created_at: string;
}

/**
 * Authorizes access to a call starting from callId.
 *
 * STRICT SECURITY: BOSS_ADMIN only! SALE and TECHNICIAN are completely forbidden.
 * Even if a SALE agent made the call, privileged access / verbatim transcript is DENIED.
 * Cross-tenant calls are masked as 404 RESOURCE_NOT_FOUND.
 */
export async function authorizeCallAccess(
  callId: string,
  client?: SupabaseClient
): Promise<{ actor: TrustedActorContext; call: CallResourceRow }> {
  if (!callId) {
    throw new ServerAuthError('Mã cuộc gọi không hợp lệ.', 400, 'RESOURCE_NOT_FOUND');
  }

  const adminClient = createAdminClient();

  // STEP 1: Minimal pre-auth metadata projection (id, company_id only)
  const { data: minimal, error: minError } = await adminClient
    .from('calls')
    .select('id, company_id')
    .eq('id', callId)
    .maybeSingle();

  if (minError || !minimal) {
    throw new ServerAuthError('Không tìm thấy cuộc gọi.', 404, 'RESOURCE_NOT_FOUND');
  }

  // STEP 2: Actor verification (BOSS_ADMIN only, AAL2 enforced in production)
  const actor = await verifyActorWithTenantMasking(
    minimal.company_id,
    [APPLICATION_ROLES.BOSS_ADMIN],
    { requireAal2: process.env.NODE_ENV === 'production' },
    client
  );

  // STEP 3: Post-auth projection
  const { data: call, error } = await adminClient
    .from('calls')
    .select('id, company_id, customer_id, direction, agent_type, provider, provider_call_id, started_at, ended_at, status, recording_ref, transcript_status, created_at')
    .eq('id', callId)
    .single();

  if (error || !call) {
    throw new ServerAuthError('Không tìm thấy cuộc gọi.', 404, 'RESOURCE_NOT_FOUND');
  }

  return { actor, call: call as CallResourceRow };
}
