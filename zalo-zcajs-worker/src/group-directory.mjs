const cleanId = (value) => String(value ?? '').trim().replace(/_\d+$/, '');
const cleanName = (value) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 160) : '';

function withTimeout(promise, ms = 8000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('GROUP_LOOKUP_TIMEOUT')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// getGroupInfo can return only a preview in currentMems. memVerList/memberIds
// describe membership; profiles are resolved separately, without inventing names.
export async function readGroupDetails(api, groupId) {
  const deadline = Date.now() + 20000;
  const result = await withTimeout(api.getGroupInfo([groupId]));
  const raw = result?.gridInfoMap?.[groupId];
  if (!raw) return undefined;
  const adminIds = (raw.adminIds || []).map(cleanId);
  const creatorId = cleanId(raw.creatorId);
  const members = new Map();
  const add = (value) => {
    const item = typeof value === 'object' && value ? value : { id: value };
    const id = cleanId(item.id || item.uid || item.userId);
    if (!id) return;
    const previous = members.get(id) || {};
    members.set(id, {
      id,
      name: cleanName(item.displayName || item.dName || item.dname || item.zaloName || item.name) || previous.name || '',
      avatar: item.avatar || item.avt || previous.avatar,
      isAdmin: adminIds.includes(id) || id === creatorId,
      isCreator: id === creatorId,
    });
  };
  for (const list of [raw.memberIds, raw.memVerList, raw.currentMems, raw.members]) {
    if (Array.isArray(list)) list.forEach(add);
  }
  let profilesResolved = true;
  const missing = [...members.values()].filter((member) => !member.name).map((member) => member.id);
  if (missing.length && typeof api.getGroupMembersInfo !== 'function') profilesResolved = false;
  let next = 0;
  const resolveBatch = async () => {
    while (next < missing.length && typeof api.getGroupMembersInfo === 'function') {
      const start = next;
      next += 50;
      const remaining = deadline - Date.now();
      if (remaining <= 0) { profilesResolved = false; return; }
      try {
        const response = await withTimeout(api.getGroupMembersInfo(missing.slice(start, start + 50)), Math.min(8000, remaining));
        for (const [key, profile] of Object.entries(response?.profiles || {})) {
          // Ignore profiles outside the requested roster.
          const id = cleanId(profile.id || key);
          if (members.has(id)) add({ ...profile, id });
        }
      } catch {
        profilesResolved = false;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, Math.ceil(missing.length / 50)) }, resolveBatch));
  const total = typeof raw.totalMember === 'number' || (typeof raw.totalMember === 'string' && /^\d+$/.test(raw.totalMember))
    ? Number(raw.totalMember) : NaN;
  const totalMember = Number.isSafeInteger(total) && total >= 0 ? total : undefined;
  return {
    groupId,
    groupName: cleanName(raw.name || raw.groupName) || undefined,
    totalMember,
    avatar: raw.fullAvt || raw.avt || undefined,
    members: [...members.values()],
    // A preview or a locked member list must never masquerade as a full roster.
    membersComplete: profilesResolved && totalMember !== undefined && members.size === totalMember && [...members.values()].every((m) => m.name),
    fetchedAt: new Date().toISOString(),
  };
}

export function createGroupDirectory({ ttlMs = 5 * 60_000, logger = console } = {}) {
  const cache = new Map();
  const pending = new Map();
  return {
    invalidate: (id) => cache.delete(String(id)),
    async get(api, id, { force = false } = {}) {
      const key = String(id);
      const cached = cache.get(key);
      if (!force && cached && cached.expiresAt > Date.now()) return cached.data;
      if (pending.has(key)) return pending.get(key);
      const lookup = readGroupDetails(api, key).then((data) => {
        if (data) cache.set(key, { data, expiresAt: Date.now() + ttlMs });
        return data;
      }).catch((error) => {
        logger.warn('[ZCAJS] group lookup failed:', error.message);
        // Caller can explicitly report cached data as stale after a failed refresh.
        return undefined;
      }).finally(() => pending.delete(key));
      pending.set(key, lookup);
      return lookup;
    },
  };
}
