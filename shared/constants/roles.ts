/**
 * Canonical Application Roles (FROZEN ARCHITECTURE)
 * See docs/PROJECT_MASTER.md (Section 14) and docs/AUTH_DESIGN.md (Section 7).
 */
export const APPLICATION_ROLES = {
  BOSS_ADMIN: 'BOSS_ADMIN',
  SALE: 'SALE',
  TECHNICIAN: 'TECHNICIAN',
} as const;

export type ApplicationRole = (typeof APPLICATION_ROLES)[keyof typeof APPLICATION_ROLES];

/**
 * Valid application roles list for validation.
 */
export const ALL_ROLES: ApplicationRole[] = [
  APPLICATION_ROLES.BOSS_ADMIN,
  APPLICATION_ROLES.SALE,
  APPLICATION_ROLES.TECHNICIAN,
];

/**
 * Global Profile Statuses (user_profiles.status)
 */
export const PROFILE_STATUSES = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
} as const;

export type ProfileStatus = (typeof PROFILE_STATUSES)[keyof typeof PROFILE_STATUSES];

/**
 * Company Membership Statuses (company_members.status)
 */
export const MEMBERSHIP_STATUSES = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
} as const;

export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[keyof typeof MEMBERSHIP_STATUSES];
