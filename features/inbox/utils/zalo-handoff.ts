export interface ZaloHandoffTarget {
  targeted: boolean;
  deepLink: string | null;
  webUrl: string | null;
  targetKind: 'phone' | 'uid' | 'none';
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
  const uid = normalizeZaloUid(input.uid);

  // Zalo PC's desktop URI is only reliably documented in the ecosystem by phone.
  // When the CRM has a full phone, use it to open the native app, but keep the
  // UID-based Zalo Web conversation as the exact fallback whenever possible.
  if (phone) {
    return {
      targeted: true,
      deepLink: `zalo://conversation?phone=${encodeURIComponent(phone)}`,
      webUrl: uid
        ? `https://chat.zalo.me/?c=${encodeURIComponent(uid)}`
        : `https://chat.zalo.me/?phone=${encodeURIComponent(phone)}&openConv=true`,
      targetKind: 'phone',
    };
  }

  // Personal Zalo identities synced by ZCAJS always have the authoritative UID.
  // Zalo Web accepts the conversation id via ?c=, allowing exact navigation even
  // when the customer never shared a phone number with the CRM.
  if (uid) {
    return {
      targeted: true,
      deepLink: null,
      webUrl: `https://chat.zalo.me/?c=${encodeURIComponent(uid)}`,
      targetKind: 'uid',
    };
  }

  // Fail closed: never open generic Zalo and make the sale search by name.
  return { targeted: false, deepLink: null, webUrl: null, targetKind: 'none' };
}
