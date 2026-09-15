/**
 * Safe Internal Redirect Validator for AI CRM
 *
 * Rules (FIX 1 — Open Redirect):
 * - External URLs denied (http:, https:, etc.)
 * - Protocol-relative URLs denied (//)
 * - Backslash tricks denied (/\, \\, etc.)
 * - javascript: / data: / vbscript: denied
 * - Strict allowlist of known application root routes
 * - Fallback to server-derived role destination
 */

export const ALLOWED_REDIRECT_PREFIXES = [
  '/admin',
  '/crm',
  '/field',
  '/account',
] as const;

export function sanitizeRedirectPath(
  target: string | null | undefined,
  fallback = '/crm'
): string {
  // Validate fallback itself
  const safeFallback =
    typeof fallback === 'string' &&
    ALLOWED_REDIRECT_PREFIXES.some(
      (prefix) => fallback === prefix || fallback.startsWith(prefix + '/')
    )
      ? fallback
      : '/crm';

  if (!target || typeof target !== 'string') {
    return safeFallback;
  }

  const trimmed = target.trim();

  // Deny empty or non-root-relative strings
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) {
    return safeFallback;
  }

  // Deny any backslash (used in tricks like /\evil.example or \evil.example)
  if (trimmed.includes('\\')) {
    return safeFallback;
  }

  // Deny control characters and scheme indicators (e.g. javascript:, data:, etc.)
  if (/[\x00-\x1F\x7F]/.test(trimmed) || trimmed.includes(':')) {
    return safeFallback;
  }

  // Parse as URL relative to a dummy local origin to inspect pathname
  try {
    const dummyBase = 'http://localhost';
    const parsed = new URL(trimmed, dummyBase);

    // Verify origin was not altered (e.g. via unexpected protocol tricks)
    if (parsed.origin !== dummyBase) {
      return safeFallback;
    }

    const pathname = parsed.pathname;

    // Enforce strict prefix allowlist for known CRM application paths
    const isAllowed = ALLOWED_REDIRECT_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(prefix + '/')
    );

    if (!isAllowed) {
      return safeFallback;
    }

    // Return safe internal path with search and hash preserved
    return pathname + parsed.search + parsed.hash;
  } catch {
    return safeFallback;
  }
}
