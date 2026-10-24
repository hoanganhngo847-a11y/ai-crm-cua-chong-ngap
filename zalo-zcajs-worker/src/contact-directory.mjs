function cleanId(value) {
  const id = String(value ?? '').trim().replace(/_0$/, '');
  return /^[0-9]{5,40}$/.test(id) ? id : '';
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function rowsFromResponse(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['friends', 'data', 'changed_profiles', 'profiles']) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === 'object') return Object.values(candidate);
  }
  return Object.values(value);
}

export async function listPersonalZaloContacts(api) {
  if (!api || typeof api.getAllFriends !== 'function') {
    throw new Error('ZCAJS_CONTACT_DIRECTORY_UNAVAILABLE');
  }

  const raw = await api.getAllFriends();
  const seen = new Set();
  const contacts = [];

  for (const item of rowsFromResponse(raw)) {
    if (!item || typeof item !== 'object') continue;
    const externalUserId = cleanId(
      item.uid ?? item.userId ?? item.user_id ?? item.id ?? item.zaloId
    );
    if (!externalUserId || seen.has(externalUserId)) continue;
    seen.add(externalUserId);

    const displayName = cleanName(
      item.zaloName ?? item.displayName ?? item.display_name ?? item.name ?? item.username
    );
    contacts.push({
      externalUserId,
      ...(displayName ? { displayName } : {}),
    });
    if (contacts.length >= 5000) break;
  }

  return contacts;
}
