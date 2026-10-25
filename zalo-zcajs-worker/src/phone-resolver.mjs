function normalizeUid(value) {
  return String(value ?? '').trim().replace(/_0$/, '');
}

export function normalizeVietnamPhone(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  let digits = String(value).trim().replace(/[\s().-]+/g, '');
  if (!digits || /[*xX]/.test(digits)) return null;
  digits = digits.replace(/^\+/, '');

  if (/^84[1-9][0-9]{7,12}$/.test(digits)) {
    digits = `0${digits.slice(2)}`;
  }

  return /^0[1-9][0-9]{7,12}$/.test(digits) ? digits : null;
}

function profileMatchesUid(profile, expectedUid) {
  if (!profile || typeof profile !== 'object') return false;
  const candidates = [profile.userId, profile.uid, profile.user_id, profile.id]
    .map(normalizeUid)
    .filter(Boolean);
  return candidates.length === 0 || candidates.includes(expectedUid);
}

function findExactProfile(collection, expectedUid) {
  if (!collection || typeof collection !== 'object' || Array.isArray(collection)) return null;
  const direct = collection[expectedUid] || collection[`${expectedUid}_0`];
  if (direct && profileMatchesUid(direct, expectedUid)) return direct;

  for (const [key, profile] of Object.entries(collection)) {
    if (normalizeUid(key) === expectedUid && profileMatchesUid(profile, expectedUid)) return profile;
  }
  return null;
}

export function resolveExactZaloPhone(userInfo, userId) {
  const expectedUid = normalizeUid(userId);
  if (!/^[0-9]{5,40}$/.test(expectedUid)) return null;

  const profile =
    findExactProfile(userInfo?.changed_profiles, expectedUid) ||
    findExactProfile(userInfo?.unchanged_profiles, expectedUid);
  if (!profile) return null;

  const fields = [
    profile.phoneNumber,
    profile.phone_number,
    profile.phone,
    profile.phoneNum,
    profile.phone_num,
  ];
  for (const value of fields) {
    const phone = normalizeVietnamPhone(value);
    if (phone) return phone;
  }
  return null;
}
