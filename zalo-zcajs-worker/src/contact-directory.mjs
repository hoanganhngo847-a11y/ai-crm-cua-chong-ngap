import { normalizeDirectMessage } from './message-normalizer.mjs';

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
  if (!api || (typeof api.getAllFriends !== 'function' && typeof api.getRecentDirectMessages !== 'function')) {
    throw new Error('ZCAJS_CONTACT_DIRECTORY_UNAVAILABLE');
  }

  const byId = new Map();
  let succeeded = 0;

  function add(externalId, displayName) {
    const externalUserId = cleanId(externalId);
    if (!externalUserId) return;
    const name = cleanName(displayName);
    const current = byId.get(externalUserId);
    if (!current) {
      byId.set(externalUserId, {
        externalUserId,
        ...(name ? { displayName: name } : {}),
      });
      return;
    }
    if (!current.displayName && name) current.displayName = name;
  }

  if (typeof api.getAllFriends === 'function') {
    try {
      const raw = await api.getAllFriends();
      succeeded += 1;
      for (const item of rowsFromResponse(raw)) {
        if (!item || typeof item !== 'object') continue;
        add(
          item.uid ?? item.userId ?? item.user_id ?? item.id ?? item.zaloId,
          item.zaloName ?? item.displayName ?? item.display_name ?? item.name ?? item.username,
        );
        if (byId.size >= 5000) break;
      }
    } catch {
      // Recent 1:1 threads can still provide safe exact UIDs if the friend endpoint is unavailable.
    }
  }

  if (byId.size < 5000 && typeof api.getRecentDirectMessages === 'function') {
    try {
      const messages = await api.getRecentDirectMessages();
      succeeded += 1;
      for (const message of Array.isArray(messages) ? messages : []) {
        const normalized = normalizeDirectMessage(message);
        if (!normalized) continue;
        add(normalized.externalUserId, normalized.senderName);
        if (byId.size >= 5000) break;
      }
    } catch {
      // Friend directory can still be sufficient; fail only if neither source succeeded.
    }
  }

  if (succeeded === 0) throw new Error('ZCAJS_CONTACT_DIRECTORY_READ_FAILED');
  return [...byId.values()].slice(0, 5000);
}
