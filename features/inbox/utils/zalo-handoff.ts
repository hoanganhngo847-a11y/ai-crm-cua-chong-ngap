export interface ZaloHandoffTarget {
  targeted: boolean;
  deepLink: string | null;
  webUrl: null;
  targetKind: 'phone' | 'none';
}

export function normalizeZaloPhone(value: string | null | undefined): string | null {
  if (!value || value.includes('*')) return null;
  let digits = value.replace(/[^0-9+]/g, '');
  if (!digits) return null;

  if (/^\+84[1-9][0-9]{7,12}$/.test(digits)) {
    digits = `0${digits.slice(3)}`;
  } else if (/^84[1-9][0-9]{7,12}$/.test(digits)) {
    digits = `0${digits.slice(2)}`;
  }

  return /^0[1-9][0-9]{7,12}$/.test(digits) ? digits : null;
}

export function normalizeZaloUid(value: string | null | undefined): string | null {
  const uid = value?.trim() || '';
  return /^[0-9]{5,40}$/.test(uid) ? uid : null;
}

export function buildZaloHandoffTarget(input: {
  phone?: string | null;
  uid?: string | null;
}): ZaloHandoffTarget {
  const phone = normalizeZaloPhone(input.phone);

  if (phone) {
    return {
      targeted: true,
      deepLink: `zalo://conversation?phone=${encodeURIComponent(phone)}`,
      webUrl: null,
      targetKind: 'phone',
    };
  }

  // UID alone is not enough for a reliable Zalo PC deep-link. The server-side
  // handoff resolver must first resolve the exact UID to a phone via ZCAJS.
  // Never fall back to Zalo Web, generic Zalo, or name-based search.
  return { targeted: false, deepLink: null, webUrl: null, targetKind: 'none' };
}
