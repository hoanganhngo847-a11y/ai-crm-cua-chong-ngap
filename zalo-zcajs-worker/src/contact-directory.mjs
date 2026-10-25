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
  let rawFriendsCount = 0;
  let recentMessagesCount = 0;

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
      const rows = rowsFromResponse(raw);
      rawFriendsCount = rows.length;
      for (const item of rows) {
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
      const msgList = Array.isArray(messages) ? messages : [];
      recentMessagesCount = msgList.length;
      for (const message of msgList) {
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

  if (typeof api.getUserInfo === 'function') {
    const missing = [];
    for (const [id, contact] of byId.entries()) {
      if (!contact.displayName) missing.push(id);
      if (missing.length >= 100) break;
    }
    if (missing.length > 0) {
      try {
        const info = await api.getUserInfo(missing);
        const changed = info?.changed_profiles || {};
        for (const [rawUid, profile] of Object.entries(changed)) {
          const uid = cleanId(rawUid);
          const contact = byId.get(uid);
          if (contact && !contact.displayName && profile && typeof profile === 'object') {
            const name = cleanName(profile.displayName || profile.zaloName || profile.display_name || profile.name);
            if (name) contact.displayName = name;
          }
        }
      } catch {
        // Fail-soft: keep contacts without resolved display name rather than failing directory read
      }
    }
  }

  console.log(
    `[ZCAJS] contact directory: friends_raw_count=${rawFriendsCount} recent_contact_count=${recentMessagesCount} normalized_contact_count=${byId.size}`
  );

  return [...byId.values()].slice(0, 5000);
}
