import 'server-only';
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
 *    - SALE: allowed.
 *    - BOSS_ADMIN: Configuration-dependent per frozen DATA_CONTRACT:1072. Fails closed until business config exists.
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
  client?: SupabaseClient
): Promise<ClickToCallResult> {
  if (!params || !params.customerId) {
    throw new ServerAuthError('Mã khách hàng không hợp lệ.', 400, 'RESOURCE_NOT_FOUND');
  }

  const provider = resolveCallProvider(callProvider);

  // 1. Authorize customer access with CLICK_TO_CALL purpose
  // Fixed policy: SALE only. (Boss fails closed as configuration-dependent; Tech forbidden)
  const { actor, customer } = await authorizeCustomerAccess(
    params.customerId,
    CONTACT_ACCESS_PURPOSES.CLICK_TO_CALL,
    client
  );

  // 2. Privately resolve customer raw phone inside trusted server
  const contact = await resolveCustomerPrivateContactForTrustedOperation(
    customer.id,
    CONTACT_ACCESS_PURPOSES.CLICK_TO_CALL,
    client
  );

  const adminClient = createAdminClient();

  const providerDbValue = ['MANUAL', 'STRINGEE', 'VIETTEL', 'TWILIO', 'VINFON'].includes(provider.name)
    ? provider.name
    : 'MANUAL';

  // 3. DURABLE ORCHESTRATION: Create call record in database BEFORE external dialing
  const { data: callRecord, error: callError } = await adminClient
    .from('calls')
    .insert({
      company_id: customer.company_id,
      customer_id: customer.id,
      direction: 'OUTBOUND',
      agent_type: 'SALE',
      started_at: new Date().toISOString(),
      status: 'INITIATED',
      provider: providerDbValue,
      transcript_status: 'PENDING',
    })
    .select('id')
    .single();

  if (callError || !callRecord) {
    throw new ServerAuthError('Lỗi khởi tạo hồ sơ cuộc gọi.', 500, 'CALL_PROVIDER_FAILURE');
  }

  // 4. MANDATORY AUDIT: Write INITIATE_CALL event
  const { error: auditError } = await adminClient.from('audit_logs').insert({
    company_id: customer.company_id,
    user_id: actor.userId,
    action: 'INITIATE_CALL',
    resource_type: 'CALL',
    resource_id: callRecord.id,
    customer_id: customer.id,
    result: 'SUCCESS',
    metadata: {
      call_id: callRecord.id,
    },
  });

  if (auditError) {
    // If audit write fails, mark call as FAILED and fail closed
    await adminClient.from('calls').update({ status: 'FAILED' }).eq('id', callRecord.id);
    throw new ServerAuthError(
      'Lỗi ghi nhận kiểm toán cuộc gọi. Thao tác bị từ chối.',
      500,
      'AUDIT_WRITE_FAILED'
    );
  }

  // 5. Invoke PBX provider adapter
  let providerResult: { providerCallId: string; status: string };
  try {
    providerResult = await provider.initiateCall({
      fromStaffUserId: actor.userId,
      targetRawPhone: contact.rawPhone,
      customerId: customer.id,
      companyId: customer.company_id,
    });
  } catch {
    // Mark call record as FAILED in database
    await adminClient.from('calls').update({ status: 'FAILED' }).eq('id', callRecord.id);

    // CRITICAL SECURITY: NEVER expose _err.message to client as it could contain raw phone or PBX tokens!
    throw new ServerAuthError(
      'Không thể thực hiện cuộc gọi qua tổng đài.',
      502,
      'CALL_PROVIDER_FAILURE'
    );
  }

  // 6. Update call record with provider correlation ID and status
  await adminClient
    .from('calls')
    .update({
      provider_call_id: providerResult.providerCallId,
      status: 'RINGING',
    })
    .eq('id', callRecord.id);

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
