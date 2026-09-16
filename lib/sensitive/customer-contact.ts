import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../supabase/admin';
import {
  CONTACT_ACCESS_PURPOSES,
  type ContactAccessPurpose,
  type CustomerPrivateContactInternal,
} from '../../shared/contracts/sensitive';
import { ServerAuthError } from '../server-auth/errors';
import { authorizeCustomerAccess } from '../server-auth/resource-access';

export interface CustomerContactAccessOptions {
  reason?: string;
  client?: SupabaseClient;
  overrideAdminClient?: SupabaseClient;
}

/**
 * Server-only primitive for accessing raw customer contact in private schema.
 *
 * CRITICAL SECURITY INVARIANTS:
 * 1. Strictly server-internal. NEVER return raw contact JSON to browser clients.
 * 2. Authorization is purpose-specific: arbitrary string purposes are forbidden.
 * 3. CLICK_TO_CALL: permitted for SALE only (Boss is configuration-dependent, fails closed).
 *    Strictly denied for TECHNICIAN.
 * 4. PRIVILEGED_ADMIN_OPERATION: permitted for BOSS_ADMIN only, requires MFA AAL2 in production,
 *    sanitizes client reason, and writes a mandatory audit record to public.audit_logs BEFORE
 *    returning raw contact. If audit insert fails, it FAILS CLOSED and never returns raw phone.
 * 5. Phone numbers are NEVER included in audit metadata or thrown errors.
 */
export async function resolveCustomerPrivateContactForTrustedOperation(
  customerId: string,
  purpose: ContactAccessPurpose,
  optionsOrClient?: CustomerContactAccessOptions | SupabaseClient
): Promise<CustomerPrivateContactInternal> {
  if (!Object.values(CONTACT_ACCESS_PURPOSES).includes(purpose)) {
    throw new ServerAuthError(
      'Mục đích truy cập thông tin liên hệ không hợp lệ.',
      400,
      'INVALID_PURPOSE'
    );
  }

  // Parse options or SupabaseClient
  let client: SupabaseClient | undefined;
  let reason: string | undefined;
  let overrideAdminClient: SupabaseClient | undefined;

  if (optionsOrClient) {
    if ('auth' in optionsOrClient) {
      client = optionsOrClient as SupabaseClient;
    } else {
      client = optionsOrClient.client;
      reason = optionsOrClient.reason;
      overrideAdminClient = optionsOrClient.overrideAdminClient;
    }
  }

  // 1. Authorize customer access with fixed purpose-based policy
  const { actor, customer } = await authorizeCustomerAccess(customerId, purpose, client);

  // 2. Extra checks per purpose
  let sanitizedReason = 'Truy xuất thông tin liên hệ bảo mật';
  if (purpose === CONTACT_ACCESS_PURPOSES.PRIVILEGED_ADMIN_OPERATION) {
    if (process.env.NODE_ENV === 'production' && actor.aal !== 'aal2') {
      throw new ServerAuthError(
        'Yêu cầu xác thực hai yếu tố (MFA / AAL2) để xem thông tin liên hệ bảo mật.',
        403,
        'MFA_REQUIRED'
      );
    }

    if (reason !== undefined) {
      if (typeof reason !== 'string' || reason.trim().length < 5 || reason.trim().length > 200) {
        throw new ServerAuthError(
          'Lý do truy cập số điện thoại bảo mật phải từ 5 đến 200 ký tự.',
          400,
          'INVALID_PURPOSE'
        );
      }
      sanitizedReason = reason.trim().replace(/[\r\n\x00-\x1f\x7f]/g, ' ');
    }
  }

  // 3. Query private.customer_private_contacts via trusted SECURITY DEFINER RPC
  const adminClient = overrideAdminClient || createAdminClient();
  let contact: { normalized_phone: string; raw_phone: string; is_verified: boolean } | null = null;

  const { data: rpcData, error: rpcError } = await adminClient.rpc('get_customer_private_contact', {
    p_company_id: customer.company_id,
    p_customer_id: customer.id,
  });

  if (!rpcError && rpcData && rpcData.length > 0) {
    contact = rpcData[0];
  } else {
    try {
      const { data: schemaData } = await adminClient
        .schema('private')
        .from('customer_private_contacts')
        .select('normalized_phone, raw_phone, is_verified')
        .eq('company_id', customer.company_id)
        .eq('customer_id', customer.id)
        .maybeSingle();
      if (schemaData) {
        contact = schemaData;
      }
    } catch {
      // Schema not exposed to PostgREST
    }
  }

  if (!contact) {
    throw new ServerAuthError(
      'Không tìm thấy thông tin liên hệ bảo mật của khách hàng.',
      404,
      'RESOURCE_NOT_FOUND'
    );
  }

  // 4. MANDATORY AUDIT: For PRIVILEGED_ADMIN_OPERATION, write audit log before returning raw phone.
  // INVARIANT: If audit insert fails, FAIL CLOSED! Never return raw phone.
  // INVARIANT: Never log raw_phone or normalized_phone in metadata!
  if (purpose === CONTACT_ACCESS_PURPOSES.PRIVILEGED_ADMIN_OPERATION) {
    const { error: auditError } = await adminClient.from('audit_logs').insert({
      company_id: customer.company_id,
      user_id: actor.userId,
      action: 'VIEW_RAW_PHONE',
      resource_type: 'CUSTOMER',
      resource_id: customer.id,
      customer_id: customer.id,
      result: 'SUCCESS',
      metadata: {
        customer_code: customer.customer_code,
        purpose,
        reason: sanitizedReason,
      },
    });

    if (auditError) {
      throw new ServerAuthError(
        'Lỗi ghi nhận kiểm toán bắt buộc. Thao tác xem thông tin bảo mật bị từ chối.',
        500,
        'AUDIT_WRITE_FAILED'
      );
    }
  }

  return {
    customerId: customer.id,
    companyId: customer.company_id,
    rawPhone: contact.raw_phone,
    normalizedPhone: contact.normalized_phone,
    isVerified: contact.is_verified,
  };
}
