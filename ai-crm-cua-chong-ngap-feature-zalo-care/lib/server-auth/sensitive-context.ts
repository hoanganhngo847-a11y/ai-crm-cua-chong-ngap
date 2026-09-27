import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '../supabase/server';
import { requireActiveMember } from '../auth/context';
import type { ActiveMemberContext } from '../../shared/contracts/auth';
import { ServerAuthError } from './errors';

export interface TrustedActorContext extends ActiveMemberContext {
  // Brand / alias to emphasize that this context has been fully verified on trusted server
  isTrustedServerVerified: true;
}

/**
 * Resolves and independently validates the active actor context for a target company.
 *
 * Rules:
 * 1. Resolves caller identity via supabase.auth.getUser().
 * 2. Enforces active user_profiles status.
 * 3. Enforces active company_members status for target company.
 * 4. Resolves current MFA AAL assurance level.
 */
export async function resolveTrustedActor(
  companyId: string,
  client?: SupabaseClient
): Promise<TrustedActorContext> {
  if (!companyId) {
    throw new ServerAuthError(
      'Mã công ty không hợp lệ.',
      400,
      'RESOURCE_NOT_FOUND'
    );
  }

  const supabase = client || (await createServerClient());

  try {
    const activeMember = await requireActiveMember(companyId, supabase);
    return {
      ...activeMember,
      isTrustedServerVerified: true,
    };
  } catch (err: unknown) {
    if (err instanceof ServerAuthError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : 'Ủy quyền thất bại.';
    // Standardize to ServerAuthError
    if (message.includes('Phiên làm việc đã hết hạn')) {
      throw new ServerAuthError(message, 401, 'UNAUTHENTICATED');
    }
    if (message.includes('tạm khóa')) {
      throw new ServerAuthError(message, 403, 'USER_INACTIVE');
    }
    if (message.includes('vô hiệu hóa')) {
      throw new ServerAuthError(message, 403, 'MEMBERSHIP_INACTIVE');
    }
    if (message.includes('không có quyền truy cập vào tổ chức')) {
      throw new ServerAuthError(message, 403, 'NOT_A_MEMBER');
    }
    throw new ServerAuthError(message, 403, 'RESOURCE_FORBIDDEN');
  }
}
