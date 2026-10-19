import 'server-only';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../supabase/admin';
import {
  type CallProvider,
  type ClickToCallParams,
  type ClickToCallResult,
  CONTACT_ACCESS_PURPOSES,
} from '../../shared/contracts/sensitive';
import { ServerAuthError } from '../server-auth/errors';
import { authorizeCustomerAccess } from '../server-auth/resource-access';
import { resolveCustomerPrivateContactForTrustedOperation } from './customer-contact';

/**
 * Standard Mock Call Provider for local testing and CI only.
 * MUST NEVER BE SILENTLY USED IN PRODUCTION.
 */
export class MockCallProvider implements CallProvider {
  readonly name = 'MANUAL';

  async initiateCall(): Promise<{ providerCallId: string; status: string }> {
    const providerCallId = `call_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    return {
      providerCallId,
      status: 'INITIATED',
    };
  }
}

/**
 * Resolves the active telephony provider.
 * INVARIANT: In production, if no provider is configured, FAILS CLOSED with CALL_PROVIDER_NOT_CONFIGURED.
 */
function resolveCallProvider(injectedProvider?: CallProvider): CallProvider {
  if (injectedProvider) {
    return injectedProvider;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new ServerAuthError(
      'Dịch vụ tổng đài chưa được cấu hình cho môi trường sản xuất.',
      503,
      'CALL_PROVIDER_NOT_CONFIGURED'
    );
  }

  return new MockCallProvider();
}

/**
 * Executes a secure Click-to-Call flow.
 *
 * Flow:
 * 1. Authorize actor & customer resource:
 *    - BOSS_ADMIN and SALE: allowed by the frozen Foundation policy.
 *    - TECHNICIAN: Strictly prohibited.
 * 2. Privately resolve customer raw phone inside trusted server memory.
 * 3. Durable Call Record: Create 'INITIATED' call record in database BEFORE dialing external provider.
 * 4. Mandatory Audit Log: Log 'INITIATE_CALL' to public.audit_logs. Fails closed if audit write fails.
 * 5. Invoke telephony PBX provider adapter:
 *    - Mask provider errors: never leak exception.message (which may contain raw phone or provider credentials).
 * 6. Update call record and log interaction system event.
 * 7. Return SAFE response containing ONLY application callId and status. Never providerCallId or phone strings.
 */
export async function executeClickToCall(
  params: ClickToCallParams,
  callProvider?: CallProvider,
  client?: SupabaseClient,
  browserTest?: { integrationId: string; from: string; to: string; requestId: string }
): Promise<ClickToCallResult> {
  if (!params || !params.customerId) {
    throw new ServerAuthError('Mã khách hàng không hợp lệ.', 400, 'RESOURCE_NOT_FOUND');
  }

  const provider = browserTest ? { name: 'STRINGEE' } : resolveCallProvider(callProvider);

  // 1. Authorize customer access with CLICK_TO_CALL purpose
  // Fixed policy: BOSS_ADMIN and SALE allowed; TECHNICIAN forbidden.
  const { actor, customer } = await authorizeCustomerAccess(
    params.customerId,
    CONTACT_ACCESS_PURPOSES.CLICK_TO_CALL,
    client
  );

  // A test target is supplied only by the restricted server action, never raw browser input.
  // It does not resolve or dial a customer's private phone.
  const contact = browserTest ? null : await resolveCustomerPrivateContactForTrustedOperation(
    customer.id, CONTACT_ACCESS_PURPOSES.CLICK_TO_CALL, client
  );
  const adminClient = createAdminClient();
  const providerDbValue = ['MANUAL', 'STRINGEE', 'VIETTEL', 'TWILIO', 'VINFON'].includes(provider.name)
    ? provider.name : 'MANUAL';
  // One transaction: durable call, actor audit, Stringee attempt and optional browser reservation.
  const { data: prepared, error: prepareError } = await adminClient.rpc('prepare_sale_voice_call_atomic', {
    p_company_id: customer.company_id, p_customer_id: customer.id, p_actor_id: actor.userId,
    p_provider: providerDbValue, p_request_id: browserTest?.requestId || randomUUID(),
    p_test_integration_id: browserTest?.integrationId || null,
    p_test_from: browserTest?.from || null, p_test_to: browserTest?.to || null,
  });
  const row = Array.isArray(prepared) ? prepared[0] : prepared;
  if (prepareError || !row?.call_id) {
    throw new ServerAuthError('Không thể khởi tạo hồ sơ và kiểm toán cuộc gọi.', 409, 'CALL_PROVIDER_FAILURE');
  }
  const callRecord = { id: row.call_id as string };
  if (browserTest) return { success: true, callId: callRecord.id, status: 'PREPARED' };

  // 5. Invoke PBX provider adapter
  let providerResult: { providerCallId: string; status: string };
  try {
    providerResult = await (provider as CallProvider).initiateCall({
      fromStaffUserId: actor.userId,
      targetRawPhone: contact!.rawPhone,
      correlationId: `crm_${callRecord.id}`,
      customerId: customer.id,
      companyId: customer.company_id,
    });
  } catch {
    // Mark call record as FAILED in database
    await adminClient.rpc('apply_voice_call_status_atomic', {
      p_company_id: customer.company_id, p_provider: providerDbValue,
      p_provider_call_id: `crm_${callRecord.id}`, p_new_status: 'FAILED',
      p_event_idempotency_key: `dispatch_failed_${callRecord.id}`,
    });

    // CRITICAL SECURITY: NEVER expose _err.message to client as it could contain raw phone or PBX tokens!
    throw new ServerAuthError(
      'Không thể thực hiện cuộc gọi qua tổng đài.',
      502,
      'CALL_PROVIDER_FAILURE'
    );
  }

  // Signed answer callbacks may have already bound the canonical id. Do not overwrite it
  // or regress CONNECTED/COMPLETED to RINGING after a fast callback.
  const { error: bindError } = await adminClient.rpc('bind_sale_voice_provider_call', {
    p_company_id: customer.company_id, p_call_id: callRecord.id,
    p_provider_call_id: providerResult.providerCallId,
  });
  if (bindError) throw new ServerAuthError('Cuộc gọi cần đối soát liên kết.', 503, 'CALL_PROVIDER_FAILURE');

  // Insert non-textual system interaction event
  await adminClient.from('interactions').insert({
    company_id: customer.company_id,
    customer_id: customer.id,
    channel: 'PHONE',
    type: 'CALL_EVENT',
    direction: 'OUTBOUND',
    sanitized_content: null,
    sanitization_status: 'NOT_REQUIRED',
    actor_type: 'SYSTEM',
    actor_user_id: null,
  });

  // 7. Return safe response containing ONLY application identifiers.
  // Never return providerCallId, tokens, or phone strings.
  return {
    success: true,
    callId: callRecord.id,
    status: 'CALLING',
  };
}
