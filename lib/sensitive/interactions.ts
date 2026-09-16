import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../supabase/admin';
import { APPLICATION_ROLES } from '../../shared/constants/roles';
import {
  type SanitizedInteractionDTO,
  type RawInteractionContentDTO,
  RAW_INTERACTION_PURPOSES,
  type RawInteractionPurpose,
} from '../../shared/contracts/sensitive';
import { ServerAuthError } from '../server-auth/errors';
import { authorizeInteractionAccess } from '../server-auth/resource-access';

/**
 * Explicit frozen allowlist of non-textual system event types that may have NOT_REQUIRED sanitization status.
 * Any other event type, or any event with a non-system actor, MUST NEVER have NOT_REQUIRED.
 */
const FROZEN_NON_TEXT_SYSTEM_EVENT_TYPES: readonly string[] = ['CALL_EVENT'];

/**
 * Accesses a sanitized interaction for SALE / CRM usage.
 *
 * CRITICAL SECURITY INVARIANTS:
 * 1. Raw interaction content is NEVER exposed to SALE client code.
 * 2. SALE textual interaction access: sanitization_status MUST be SUCCEEDED.
 * 3. FAILED or PENDING never falls back to raw content.
 * 4. NOT_REQUIRED is strictly restricted to non-textual SYSTEM events:
 *    - actor_type MUST be SYSTEM.
 *    - event type MUST be in FROZEN_NON_TEXT_SYSTEM_EVENT_TYPES ('CALL_EVENT').
 *    - sanitized_content MUST be empty/null (no customer-entered text).
 *    If any condition is not met, fails closed with SANITIZATION_INCOMPLETE.
 */
export async function getSanitizedInteractionForSale(
  interactionId: string,
  client?: SupabaseClient
): Promise<SanitizedInteractionDTO> {
  const { interaction } = await authorizeInteractionAccess(
    interactionId,
    'SANITIZED_READ',
    client
  );

  if (interaction.sanitization_status === 'SUCCEEDED') {
    // Legitimate sanitized derivative
    return {
      id: interaction.id,
      companyId: interaction.company_id,
      customerId: interaction.customer_id,
      conversationId: interaction.conversation_id,
      channel: interaction.channel,
      type: interaction.type,
      direction: interaction.direction,
      sanitizedContent: interaction.sanitized_content,
      sanitizationStatus: interaction.sanitization_status,
      sanitizedAt: interaction.sanitized_at,
      actorType: interaction.actor_type,
      actorUserId: interaction.actor_user_id,
      createdAt: interaction.created_at,
    };
  }

  if (interaction.sanitization_status === 'NOT_REQUIRED') {
    // Strict multi-clause validation for NOT_REQUIRED:
    // Clause 1: Must be SYSTEM actor
    const isSystemActor = interaction.actor_type === 'SYSTEM';

    // Clause 2: Must be an explicit frozen non-text event type
    const isNonTextEventType = FROZEN_NON_TEXT_SYSTEM_EVENT_TYPES.includes(interaction.type);

    // Clause 3: Content must not contain textual payload
    const hasNoTextualPayload = !interaction.sanitized_content || interaction.sanitized_content.trim() === '';

    if (!isSystemActor || !isNonTextEventType || !hasNoTextualPayload) {
      throw new ServerAuthError(
        'Sự kiện không đáp ứng điều kiện miễn làm sạch (Bảo mật: ngăn chặn bypass làm sạch).',
        403,
        'SANITIZATION_INCOMPLETE'
      );
    }

    return {
      id: interaction.id,
      companyId: interaction.company_id,
      customerId: interaction.customer_id,
      conversationId: interaction.conversation_id,
      channel: interaction.channel,
      type: interaction.type,
      direction: interaction.direction,
      sanitizedContent: null,
      sanitizationStatus: interaction.sanitization_status,
      sanitizedAt: interaction.sanitized_at,
      actorType: interaction.actor_type,
      actorUserId: interaction.actor_user_id,
      createdAt: interaction.created_at,
    };
  }

  // All other statuses (FAILED, PENDING, or unhandled): FAIL CLOSED
  throw new ServerAuthError(
    'Nội dung tương tác chưa sẵn sàng hoặc làm sạch thất bại.',
    403,
    'SANITIZATION_INCOMPLETE'
  );
}

/**
 * Server-internal primitive for accessing raw interaction content in private schema.
 *
 * CRITICAL SECURITY INVARIANTS:
 * 1. Human interactive context:
 *    - SALE: NEVER raw interaction content.
 *    - TECHNICIAN: NEVER raw interaction content.
 *    - BOSS_ADMIN: Allowed ONLY under PRIVILEGED_AUDIT with MFA AAL2 and mandatory audit write.
 * 2. Worker pipeline purposes (VOICE_TRANSCRIPTION, SANITIZATION_PIPELINE):
 *    - MUST NOT be authorized for normal user sessions. Fails closed until worker identity
 *      architecture is established.
 */
export async function resolveRawInteractionContentForTrustedOperation(
  interactionId: string,
  purpose: RawInteractionPurpose,
  client?: SupabaseClient
): Promise<RawInteractionContentDTO> {
  if (!Object.values(RAW_INTERACTION_PURPOSES).includes(purpose)) {
    throw new ServerAuthError(
      'Mục đích truy cập nội dung gốc không hợp lệ.',
      400,
      'INVALID_PURPOSE'
    );
  }

  // Worker pipeline purposes are not accessible from normal interactive user sessions
  if (
    purpose === RAW_INTERACTION_PURPOSES.VOICE_TRANSCRIPTION ||
    purpose === RAW_INTERACTION_PURPOSES.SANITIZATION_PIPELINE
  ) {
    throw new ServerAuthError(
      'Mục đích xử lý ngầm (Worker Pipeline) không được phép truy cập từ phiên người dùng tương tác.',
      403,
      'ROLE_FORBIDDEN'
    );
  }

  // Human Privileged Audit: strictly BOSS_ADMIN only
  const { actor, interaction } = await authorizeInteractionAccess(
    interactionId,
    'PRIVILEGED_AUDIT',
    client
  );

  if (actor.role !== APPLICATION_ROLES.BOSS_ADMIN) {
    throw new ServerAuthError(
      'Chỉ quản trị viên cấp cao (Sếp) mới có quyền kiểm toán nội dung tương tác gốc.',
      403,
      'ROLE_FORBIDDEN'
    );
  }

  if (process.env.NODE_ENV === 'production' && actor.aal !== 'aal2') {
    throw new ServerAuthError(
      'Yêu cầu xác thực hai yếu tố (MFA / AAL2) để kiểm toán nội dung gốc.',
      403,
      'MFA_REQUIRED'
    );
  }

  // Query private.interaction_raw_contents via trusted RPC with schema fallback
  const adminClient = createAdminClient();
  type RawDataRow = {
    interaction_id: string;
    company_id: string;
    raw_content: string;
    raw_payload: Record<string, unknown>;
    source_metadata: Record<string, unknown>;
    created_at: string;
  };
  let rawData: RawDataRow | null = null;

  const { data: rpcData, error: rpcError } = await adminClient.rpc('get_interaction_raw_content', {
    p_company_id: interaction.company_id,
    p_interaction_id: interaction.id,
  });

  if (!rpcError && rpcData && rpcData.length > 0) {
    rawData = rpcData[0] as RawDataRow;
  } else {
    try {
      const { data: schemaData } = await adminClient
        .schema('private')
        .from('interaction_raw_contents')
        .select('interaction_id, company_id, raw_content, raw_payload, source_metadata, created_at')
        .eq('company_id', interaction.company_id)
        .eq('interaction_id', interaction.id)
        .maybeSingle();
      if (schemaData) {
        rawData = schemaData as unknown as RawDataRow;
      }
    } catch {
      // Schema not exposed to PostgREST
    }
  }

  if (!rawData) {
    throw new ServerAuthError(
      'Không tìm thấy nội dung tương tác gốc.',
      404,
      'RESOURCE_NOT_FOUND'
    );
  }

  // MANDATORY AUDIT: Log privileged raw view before returning
  const { error: auditError } = await adminClient.from('audit_logs').insert({
    company_id: interaction.company_id,
    user_id: actor.userId,
    action: 'VIEW_RAW_INTERACTION',
    resource_type: 'INTERACTION',
    resource_id: interaction.id,
    customer_id: interaction.customer_id,
    result: 'SUCCESS',
    metadata: {
      interaction_id: interaction.id,
      purpose,
    },
  });

  if (auditError) {
    throw new ServerAuthError(
      'Lỗi ghi nhận kiểm toán bắt buộc. Thao tác xem nội dung gốc bị từ chối.',
      500,
      'AUDIT_WRITE_FAILED'
    );
  }

  return {
    interactionId: rawData.interaction_id,
    companyId: rawData.company_id,
    rawContent: rawData.raw_content,
    rawPayload: (rawData.raw_payload as Record<string, unknown>) || {},
    sourceMetadata: (rawData.source_metadata as Record<string, unknown>) || {},
    createdAt: rawData.created_at,
  };
}
