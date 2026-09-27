import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '../supabase/server';
import {
  APPLICATION_ROLES,
  type ApplicationRole,
  type MembershipStatus,
  type ProfileStatus,
} from '../../shared/constants/roles';
import type {
  ActiveMemberContext,
  ActorContext,
  AuthenticatedUserContext,
} from '../../shared/contracts/auth';
import { getMfaAssuranceState } from './mfa';

export class AuthError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 403, code = 'FORBIDDEN') {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Resolves the single auditable server-side source of truth for the current actor context.
 *
 * Enforces canonical identity chain:
 *   Supabase User (AuthN)
 *     -> public.user_profiles (Application Identity)
 *     -> public.company_members (Authorization)
 *
 * Rules:
 * - Does NOT trust roles or company IDs from client request bodies or headers.
 * - Always reads active database state.
 */
export async function getActorContext(
  companyId?: string,
  client?: SupabaseClient
): Promise<ActorContext | null> {
  const supabase = client || (await createServerClient());

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return null;
  }

  // 1. Fetch user_profiles directly
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, full_name, status')
    .eq('id', user.id)
    .maybeSingle();

  const profileStatus: ProfileStatus = (profile?.status as ProfileStatus) || 'INACTIVE';
  const fullName = profile?.full_name || '';

  // 2. Fetch company_members directly
  let memberQuery = supabase
    .from('company_members')
    .select('id, company_id, role, status')
    .eq('user_id', user.id);

  if (companyId) {
    memberQuery = memberQuery.eq('company_id', companyId);
  }

  const { data: members } = await memberQuery;

  // Resolve membership record
  type MemberRow = {
    id: string;
    company_id: string;
    role: ApplicationRole;
    status: MembershipStatus;
  };

  let memberRecord: MemberRow | null = null;

  if (members && members.length > 0) {
    if (companyId) {
      memberRecord = members[0] as unknown as MemberRow;
    } else {
      // If no companyId specified:
      // Single company phase: pick the active membership if there is exactly one
      const activeMembers = members.filter((m) => m.status === 'ACTIVE');
      if (activeMembers.length === 1) {
        memberRecord = activeMembers[0] as unknown as MemberRow;
      } else if (activeMembers.length > 1) {
        // Multi-membership ambiguity: require explicit companyId
        memberRecord = null;
      } else {
        // Only inactive memberships exist
        memberRecord = members[0] as unknown as MemberRow;
      }
    }
  }

  // 3. Resolve MFA / AAL status
  const mfaState = await getMfaAssuranceState(supabase);

  return {
    userId: user.id,
    email: user.email || '',
    fullName,
    profileStatus,
    companyId: memberRecord?.company_id || null,
    memberId: memberRecord?.id || null,
    role: memberRecord?.role || null,
    membershipStatus: memberRecord?.status || null,
    aal: mfaState.currentLevel,
    isMfaEnrolled: mfaState.isEnrolled,
  };
}

/**
 * 1. Require Authenticated User
 * Throws 401 if unauthenticated.
 * Throws 403 if user_profiles.status !== 'ACTIVE'.
 */
export async function requireAuthenticatedUser(
  client?: SupabaseClient
): Promise<AuthenticatedUserContext> {
  const supabase = client || (await createServerClient());

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw new AuthError('Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.', 401, 'UNAUTHORIZED');
  }

  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('id, full_name, status')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError || !profile) {
    throw new AuthError('Không tìm thấy hồ sơ người dùng.', 403, 'PROFILE_NOT_FOUND');
  }

  if (profile.status !== 'ACTIVE') {
    throw new AuthError(
      'Tài khoản của bạn đã bị tạm khóa. Vui lòng liên hệ quản trị viên.',
      403,
      'USER_INACTIVE'
    );
  }

  return {
    userId: user.id,
    email: user.email || '',
    fullName: profile.full_name,
    profileStatus: 'ACTIVE',
  };
}

/**
 * 2. Require Active Member in target Company
 * Throws 403 if user is not an ACTIVE member of target company.
 */
export async function requireActiveMember(
  companyId: string,
  client?: SupabaseClient
): Promise<ActiveMemberContext> {
  const authUser = await requireAuthenticatedUser(client);
  const supabase = client || (await createServerClient());

  const { data: member, error: memberError } = await supabase
    .from('company_members')
    .select('id, company_id, role, status')
    .eq('user_id', authUser.userId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (memberError || !member) {
    throw new AuthError('Bạn không có quyền truy cập vào tổ chức này.', 403, 'NOT_A_MEMBER');
  }

  if (member.status !== 'ACTIVE') {
    throw new AuthError('Tư cách thành viên của bạn tại tổ chức này đã bị vô hiệu hóa.', 403, 'MEMBERSHIP_INACTIVE');
  }

  const mfaState = await getMfaAssuranceState(supabase);

  return {
    ...authUser,
    profileStatus: 'ACTIVE',
    companyId: member.company_id,
    memberId: member.id,
    role: member.role as ApplicationRole,
    membershipStatus: 'ACTIVE',
    aal: mfaState.currentLevel,
    isMfaEnrolled: mfaState.isEnrolled,
  };
}

/**
 * 3. Require Specific Role(s) in target Company
 */
export async function requireCompanyRole(
  companyId: string,
  allowedRoles: ApplicationRole[],
  client?: SupabaseClient
): Promise<ActiveMemberContext> {
  const memberContext = await requireActiveMember(companyId, client);

  if (!allowedRoles.includes(memberContext.role)) {
    throw new AuthError('Bạn không có đặc quyền thực hiện thao tác này.', 403, 'ROLE_FORBIDDEN');
  }

  return memberContext;
}

/**
 * 4. Helper for BOSS_ADMIN with MFA AAL2 Enforcement foundation
 *
 * Rules (AUTH DECISION 01):
 * - Must be ACTIVE BOSS_ADMIN.
 * - If requireAal2 is requested (or in production), must satisfy AAL2.
 */
export async function requireBossAdmin(
  companyId: string,
  options: { requireAal2?: boolean } = {},
  client?: SupabaseClient
): Promise<ActiveMemberContext> {
  const context = await requireCompanyRole(companyId, [APPLICATION_ROLES.BOSS_ADMIN], client);

  const shouldEnforceAal2 =
    options.requireAal2 !== undefined
      ? options.requireAal2
      : process.env.NODE_ENV === 'production';

  if (shouldEnforceAal2 && context.aal !== 'aal2') {
    throw new AuthError(
      'Yêu cầu xác thực hai yếu tố (MFA / AAL2) cho tài khoản Quản trị viên.',
      403,
      'MFA_REQUIRED'
    );
  }

  return context;
}

/**
 * 5. Helper for SALE
 */
export async function requireSale(
  companyId: string,
  client?: SupabaseClient
): Promise<ActiveMemberContext> {
  return requireCompanyRole(companyId, [APPLICATION_ROLES.SALE], client);
}

/**
 * 6. Helper for TECHNICIAN
 */
export async function requireTechnician(
  companyId: string,
  client?: SupabaseClient
): Promise<ActiveMemberContext> {
  return requireCompanyRole(companyId, [APPLICATION_ROLES.TECHNICIAN], client);
}
