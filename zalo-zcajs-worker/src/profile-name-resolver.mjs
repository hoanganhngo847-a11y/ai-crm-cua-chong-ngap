const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_LOOKUP_TIMEOUT_MS = 2500;

function cleanName(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.slice(0, 160);
}

function profileCandidates(response, externalUserId) {
  const changed = response?.changed_profiles;
  if (!changed || typeof changed !== 'object') return [];

  const exactKeys = [externalUserId, `${externalUserId}_0`];
  const direct = exactKeys
    .map((key) => changed[key])
    .filter((value) => value && typeof value === 'object');
  if (direct.length > 0) return direct;

  return Object.values(changed).filter((value) => {
    if (!value || typeof value !== 'object') return false;
    const userId = String(value.userId ?? value.uid ?? '').replace(/_0$/, '');
    return userId === externalUserId;
  });
}

export function extractZaloProfileNames(response, externalUserId) {
  const [profile] = profileCandidates(response, externalUserId);
  if (!profile) return null;

  const displayName = cleanName(profile.displayName) || cleanName(profile.display_name);
  const zaloName = cleanName(profile.zaloName) || cleanName(profile.zalo_name);
  const username = cleanName(profile.username);
  const bestName = displayName || zaloName || username;
  if (!bestName) return null;

  return {
    displayName: bestName,
    profileName: zaloName,
    source: displayName
      ? 'profile_display_name'
      : zaloName
        ? 'profile_zalo_name'
        : 'profile_username',
  };
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('ZALO_PROFILE_LOOKUP_TIMEOUT')), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

export function createZaloProfileNameResolver(api, options = {}) {
  const cacheTtlMs = Number(options.cacheTtlMs || DEFAULT_CACHE_TTL_MS);
  const negativeCacheTtlMs = Number(options.negativeCacheTtlMs || DEFAULT_NEGATIVE_CACHE_TTL_MS);
  const lookupTimeoutMs = Number(options.lookupTimeoutMs || DEFAULT_LOOKUP_TIMEOUT_MS);
  const cache = new Map();
  const inFlight = new Map();

  async function fetchProfile(externalUserId) {
    const now = Date.now();
    const cached = cache.get(externalUserId);
    if (cached && cached.expiresAt > now) return cached.profile;
    if (cached) cache.delete(externalUserId);

    if (inFlight.has(externalUserId)) return inFlight.get(externalUserId);
    if (!api || typeof api.getUserInfo !== 'function') return null;

    const lookup = (async () => {
      try {
        const response = await withTimeout(Promise.resolve(api.getUserInfo(externalUserId)), lookupTimeoutMs);
        const profile = extractZaloProfileNames(response, externalUserId);
        cache.set(externalUserId, {
          profile,
          expiresAt: Date.now() + (profile ? cacheTtlMs : negativeCacheTtlMs),
        });
        return profile;
      } catch (error) {
        cache.set(externalUserId, {
          profile: null,
          expiresAt: Date.now() + negativeCacheTtlMs,
        });
        console.warn(
          '[ZCAJS] profile name lookup failed; keeping message dName fallback:',
          error instanceof Error ? error.message : 'unknown'
        );
        return null;
      } finally {
        inFlight.delete(externalUserId);
      }
    })();

    inFlight.set(externalUserId, lookup);
    return lookup;
  }

  return async function resolveZaloSenderName(normalizedMessage) {
    if (!normalizedMessage || normalizedMessage.direction !== 'inbound') return normalizedMessage;

    const externalUserId = String(normalizedMessage.externalUserId || '').trim();
    const fallbackName = cleanName(normalizedMessage.senderName);
    const fallback = {
      ...normalizedMessage,
      ...(fallbackName
        ? { senderName: fallbackName, senderNameSource: 'message_dname' }
        : {}),
    };
    if (!externalUserId) return fallback;

    const profile = await fetchProfile(externalUserId);
    if (!profile) return fallback;

    return {
      ...fallback,
      senderName: profile.displayName,
      ...(profile.profileName ? { senderProfileName: profile.profileName } : {}),
      senderNameSource: profile.source,
    };
  };
}
