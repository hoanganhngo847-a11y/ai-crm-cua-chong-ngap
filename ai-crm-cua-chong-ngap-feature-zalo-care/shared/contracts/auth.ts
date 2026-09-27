import type { ApplicationRole, MembershipStatus, ProfileStatus } from '../constants/roles';

/**
 * Context of an authenticated user at the Supabase Auth / UserProfile level.
 * Note: Having an AuthenticatedUserContext alone DOES NOT grant any business CRM access.
 */
export interface AuthenticatedUserContext {
  userId: string;
  email: string;
  fullName: string;
  profileStatus: ProfileStatus;
}

/**
 * Context of a verified ACTIVE member within a specific Company.
 * Fulfills the canonical authorization chain:
 *   authenticated → user ACTIVE → company membership ACTIVE → role verified
 */
export interface ActiveMemberContext extends AuthenticatedUserContext {
  profileStatus: 'ACTIVE';
  companyId: string;
  memberId: string;
  role: ApplicationRole;
  membershipStatus: 'ACTIVE';
  aal: 'aal1' | 'aal2';
  isMfaEnrolled: boolean;
}

/**
 * Comprehensive Actor Context representing the full server-derived identity.
 */
export interface ActorContext {
  userId: string;
  email: string;
  fullName: string;
  profileStatus: ProfileStatus;
  companyId: string | null;
  memberId: string | null;
  role: ApplicationRole | null;
  membershipStatus: MembershipStatus | null;
  aal: 'aal1' | 'aal2';
  isMfaEnrolled: boolean;
}

/**
 * Server Authorization Helper Signatures (AUTH_DESIGN.md Section 13)
 */
export type RequireAuthenticatedUser = () => Promise<AuthenticatedUserContext>;

export type RequireActiveMember = (
  companyId: string
) => Promise<ActiveMemberContext>;

export type RequireCompanyRole = (
  companyId: string,
  allowedRoles: ApplicationRole[]
) => Promise<ActiveMemberContext>;

export type RequireBossAdmin = (
  companyId: string,
  options?: { requireAal2?: boolean }
) => Promise<ActiveMemberContext>;

export type RequireSale = (
  companyId: string
) => Promise<ActiveMemberContext>;

export type RequireTechnician = (
  companyId: string
) => Promise<ActiveMemberContext>;
