import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { APPLICATION_ROLES, type ApplicationRole } from '../../shared/constants/roles';
import { ServerAuthError } from './errors';
import { resolveTrustedActor, type TrustedActorContext } from './sensitive-context';

export interface AuthorizeOptions {
  allowedRoles?: ApplicationRole[];
  requireAal2?: boolean;
}

/**
 * Fundamental Trusted Actor Authorization Primitive.
 *
 * Verifies the complete canonical authorization chain:
 * 1. Authenticated session (auth.getUser())
 * 2. Active User Profile (user_profiles.status === 'ACTIVE')
 * 3. Active Company Membership (company_members.status === 'ACTIVE')
 * 4. Company matching target resource company
 * 5. Allowed application role(s)
 * 6. MFA AAL2 assurance level (when required)
 *
 * Fails closed. Does NOT trust client-supplied claims or headers.
 */
export async function verifyActorForCompany(
  companyId: string,
  options: AuthorizeOptions = {},
  client?: SupabaseClient
): Promise<TrustedActorContext> {
  const actor = await resolveTrustedActor(companyId, client);

  // 1. Role verification
  if (options.allowedRoles && options.allowedRoles.length > 0) {
    if (!options.allowedRoles.includes(actor.role)) {
      throw new ServerAuthError(
        'Bạn không có đặc quyền thực hiện thao tác này.',
        403,
        'ROLE_FORBIDDEN'
      );
    }
  }

  // 2. MFA AAL2 verification
  const shouldEnforceAal2 =
    options.requireAal2 !== undefined
      ? options.requireAal2
      : actor.role === APPLICATION_ROLES.BOSS_ADMIN && process.env.NODE_ENV === 'production';

  if (shouldEnforceAal2 && actor.aal !== 'aal2') {
    throw new ServerAuthError(
      'Yêu cầu xác thực hai yếu tố (MFA / AAL2) cho thao tác quản trị viên.',
      403,
      'MFA_REQUIRED'
    );
  }

  return actor;
}

/**
 * Specialized helper for privileged BOSS_ADMIN operations requiring AAL2.
 */
export async function requirePrivilegedBoss(
  companyId: string,
  client?: SupabaseClient
): Promise<TrustedActorContext> {
  return verifyActorForCompany(
    companyId,
    {
      allowedRoles: [APPLICATION_ROLES.BOSS_ADMIN],
      requireAal2: true,
    },
    client
  );
}
