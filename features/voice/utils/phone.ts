/** Normalize Vietnamese phone numbers to E.164 without logging the input. */
export function normalizeVietnamPhoneToE164(value: string): string | null {
  const compact = value.trim().replace(/[\s().-]/g, '');
  if (!compact) return null;

  let normalized = compact;
  if (normalized.startsWith('00')) normalized = `+${normalized.slice(2)}`;
  if (normalized.startsWith('0')) normalized = `+84${normalized.slice(1)}`;
  if (/^84\d+$/.test(normalized)) normalized = `+${normalized}`;

  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}
