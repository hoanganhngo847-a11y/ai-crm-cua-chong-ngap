import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../supabase/admin';
import { type CallTranscriptDTO } from '../../shared/contracts/sensitive';
import { ServerAuthError } from '../server-auth/errors';
import { authorizeCallAccess } from '../server-auth/resource-access';

export interface CallTranscriptAccessOptions {
  client?: SupabaseClient;
  overrideAdminClient?: SupabaseClient;
}

/**
 * Server-only primitive for accessing verbatim call transcripts from private schema.
 *
 * CRITICAL SECURITY INVARIANTS:
 * 1. Strictly server-internal.
 * 2. Only BOSS_ADMIN is authorized. SALE and TECHNICIAN are strictly denied (even if own call).
 * 3. Requires MFA / AAL2 in production.
 * 4. Cross-tenant access is masked as 404 RESOURCE_NOT_FOUND to prevent IDOR enumeration.
 * 5. Mandatory audit log BEFORE returning verbatim transcript. If audit insert fails,
 *    FAILS CLOSED (AUDIT_WRITE_FAILED) and never returns the transcript.
 * 6. Audit metadata NEVER includes phone, raw transcript, speaker text, recording URL, or provider secret.
 * 7. Calls bounded SECURITY DEFINER RPC public.get_call_transcript with service_role.
 */
export async function getVerbatimCallTranscript(
  callId: string,
  optionsOrClient?: CallTranscriptAccessOptions | SupabaseClient
): Promise<CallTranscriptDTO> {
  let client: SupabaseClient | undefined;
  let overrideAdminClient: SupabaseClient | undefined;

  if (optionsOrClient) {
    if ('auth' in optionsOrClient) {
      client = optionsOrClient as SupabaseClient;
    } else {
      client = optionsOrClient.client;
      overrideAdminClient = optionsOrClient.overrideAdminClient;
    }
  }

  // 1. Authorize call access (BOSS_ADMIN only, same company, AAL2 in production)
  const { actor, call } = await authorizeCallAccess(callId, client);

  const adminClient = overrideAdminClient || createAdminClient();

  // 2. MANDATORY AUDIT: Log privileged transcript view BEFORE returning transcript.
  // INVARIANT: If audit insert fails, FAIL CLOSED! Never return verbatim transcript.
  // INVARIANT: Never log transcript content, speaker text, recording URL, or phone in metadata!
  const { error: auditError } = await adminClient.from('audit_logs').insert({
    company_id: call.company_id,
    user_id: actor.userId,
    action: 'VIEW_CALL_TRANSCRIPT',
    resource_type: 'CALL',
    resource_id: call.id,
    customer_id: call.customer_id,
    result: 'SUCCESS',
    metadata: {
      call_id: call.id,
    },
  });

  if (auditError) {
    throw new ServerAuthError(
      'Lỗi ghi nhận kiểm toán bắt buộc. Thao tác xem nội dung bóc băng cuộc gọi bị từ chối.',
      500,
      'AUDIT_WRITE_FAILED'
    );
  }

  // 3. Query private.call_transcripts via trusted bounded RPC
  const { data: rpcData, error: rpcError } = await adminClient.rpc('get_call_transcript', {
    p_company_id: call.company_id,
    p_call_id: call.id,
  });

  if (rpcError || !rpcData || rpcData.length === 0) {
    throw new ServerAuthError(
      'Không tìm thấy nội dung bóc băng cuộc gọi.',
      404,
      'RESOURCE_NOT_FOUND'
    );
  }

  const row = rpcData[0];
  return {
    id: row.id,
    companyId: row.company_id,
    callId: row.call_id,
    transcript: row.transcript,
    speakers: row.speakers,
    processedAt: row.processed_at,
    language: row.language,
    createdAt: row.created_at,
  };
}
