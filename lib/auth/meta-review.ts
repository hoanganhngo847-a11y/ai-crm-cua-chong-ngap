import 'server-only';

/**
 * Returns true only for explicitly configured Meta App Review users.
 *
 * Security:
 * - Server-only environment variable; never exposed to the browser.
 * - Exact user ID matching only.
 * - This helper does not bypass authorization by itself. Callers must still
 *   enforce the normal BOSS_ADMIN/company membership checks.
 * - Intended only for the Facebook connection review flow so the temporary
 *   reviewer account can reproduce Meta permissions without CRM TOTP.
 *
 * Remove META_REVIEWER_USER_IDS from production after App Review to revoke
 * the exemption without a code change.
 */
export function isMetaReviewerMfaExempt(userId: string | null | undefined): boolean {
  if (!userId) return false;

  const configured = process.env.META_REVIEWER_USER_IDS?.trim();
  if (!configured) return false;

  return configured
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(userId);
}
