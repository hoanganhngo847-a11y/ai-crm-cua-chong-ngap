import fs from 'node:fs';

const zaloPath = 'src/zalo.ts';
const apiPath = 'src/apis/getUserInfo.ts';

const apiSource = `import { appContext } from "../context.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { encodeAES, handleZaloResponse, request } from "../utils.js";

export type ZaloUserProfile = {
    userId?: string;
    uid?: string;
    username?: string;
    displayName?: string;
    zaloName?: string;
    display_name?: string;
    zalo_name?: string;
    avatar?: string;
};

export type UserInfoResponse = {
    unchanged_profiles?: Record<string, Record<string, unknown>>;
    phonebook_version?: number;
    changed_profiles?: Record<string, ZaloUserProfile>;
};

export function getUserInfoFactory(serviceURL: string) {
    return async function getUserInfo(userId: string | string[]) {
        if (!appContext.secretKey) throw new ZaloApiError("Secret key is not available");
        if (!appContext.imei) throw new ZaloApiError("IMEI is not available");

        const userIds = (Array.isArray(userId) ? userId : [userId])
            .map((id) => String(id || "").trim())
            .filter(Boolean)
            .map((id) => (id.includes("_") ? id : \`${'${id}'}_0\`));
        if (userIds.length === 0) throw new ZaloApiError("Missing user id");

        // phonebook_version=0 intentionally asks Zalo for a fresh profile snapshot.
        // Callers fail soft to the message dName if this unofficial endpoint changes.
        const params = {
            phonebook_version: 0,
            friend_pversion_map: userIds,
            avatar_size: 120,
            language: appContext.language || "vi",
            show_online_status: 1,
            imei: appContext.imei,
        };

        const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify(params));
        if (!encryptedParams) throw new ZaloApiError("Failed to encrypt user-info request");

        const response = await request(serviceURL, {
            method: "POST",
            body: new URLSearchParams({ params: encryptedParams }),
        });
        const result = await handleZaloResponse<UserInfoResponse>(response);
        if (result.error) throw new ZaloApiError(result.error.message, result.error.code);

        return result.data || { changed_profiles: {} };
    };
}
`;

fs.writeFileSync(apiPath, apiSource, 'utf8');

let zalo = fs.readFileSync(zaloPath, 'utf8');
const importAnchor = 'import { getCookieFactory } from "./apis/getCookie.js";';
const importLine = 'import { getUserInfoFactory } from "./apis/getUserInfo.js";';
if (!zalo.includes(importAnchor)) throw new Error('ZCAJS user-info patch anchor missing: getCookie import');
if (!zalo.includes(importLine)) zalo = zalo.replace(importAnchor, `${importAnchor}\n${importLine}`);

const propertyAnchor = '    public getCookie: ReturnType<typeof getCookieFactory>;';
const propertyLine = '    public getUserInfo: ReturnType<typeof getUserInfoFactory>;';
if (!zalo.includes(propertyAnchor)) throw new Error('ZCAJS user-info patch anchor missing: getCookie property');
if (!zalo.includes(propertyLine)) zalo = zalo.replace(propertyAnchor, `${propertyAnchor}\n${propertyLine}`);

const ctorAnchor = '        this.getCookie = getCookieFactory();';
if (!zalo.includes(ctorAnchor)) throw new Error('ZCAJS user-info patch anchor missing: getCookie constructor');
if (!zalo.includes('ZALO_PC_DISPLAY_NAME_RESOLUTION')) {
    const block = `
        // ZALO_PC_DISPLAY_NAME_RESOLUTION
        // Resolve the current per-account display name before external message listeners run.
        // This mirrors Zalo Web/PC more closely than the potentially stale message dName.
        const profileBase = zpwServiceMap.profile?.[0] || zpwServiceMap.friend?.[0];
        this.getUserInfo = profileBase
            ? getUserInfoFactory(
                  makeURL(\`${'${profileBase}'}/api/social/friend/getprofiles/v2\`, {
                      zpw_ver: Zalo.API_VERSION,
                      zpw_type: Zalo.API_TYPE,
                  }),
              )
            : async () => ({ changed_profiles: {} });

        const displayNameCache = new Map<string, { name?: string; expiresAt: number }>();
        const displayNameInflight = new Map<string, Promise<string | undefined>>();
        const positiveTtlMs = 6 * 60 * 60 * 1000;
        const negativeTtlMs = 10 * 60 * 1000;

        const cleanDisplayName = (value: unknown) => {
            if (typeof value !== "string") return undefined;
            const name = value.replace(/\\s+/g, " ").trim();
            return name ? name.slice(0, 160) : undefined;
        };

        const resolveDisplayName = async (uid: string): Promise<string | undefined> => {
            const now = Date.now();
            const cached = displayNameCache.get(uid);
            if (cached && cached.expiresAt > now) return cached.name;
            if (cached) displayNameCache.delete(uid);
            const pending = displayNameInflight.get(uid);
            if (pending) return pending;

            const lookup = (async () => {
                try {
                    const response = await this.getUserInfo(uid);
                    const changed = response?.changed_profiles || {};
                    const profile =
                        changed[uid] ||
                        changed[\`${'${uid}'}_0\`] ||
                        Object.values(changed).find((candidate: any) => {
                            const candidateUid = String(candidate?.userId || candidate?.uid || "").replace(/_0$/, "");
                            return candidateUid === uid;
                        });
                    const profileRecord = profile as any;
                    const name =
                        cleanDisplayName(profileRecord?.displayName) ||
                        cleanDisplayName(profileRecord?.display_name) ||
                        cleanDisplayName(profileRecord?.zaloName) ||
                        cleanDisplayName(profileRecord?.zalo_name) ||
                        cleanDisplayName(profileRecord?.username);
                    displayNameCache.set(uid, {
                        name,
                        expiresAt: Date.now() + (name ? positiveTtlMs : negativeTtlMs),
                    });
                    return name;
                } catch {
                    displayNameCache.set(uid, { expiresAt: Date.now() + negativeTtlMs });
                    return undefined;
                } finally {
                    displayNameInflight.delete(uid);
                }
            })();
            displayNameInflight.set(uid, lookup);
            return lookup;
        };

        const originalListenerEmit = this.listener.emit.bind(this.listener) as (...args: any[]) => boolean;
        (this.listener as any).emit = (eventName: string, ...args: any[]) => {
            const message = args[0];
            if (eventName !== "message" || !message || message.type !== 0 || message.isSelf) {
                return originalListenerEmit(eventName, ...args);
            }

            const uid = String(message.threadId || message?.data?.uidFrom || "").trim();
            if (!uid) return originalListenerEmit(eventName, ...args);

            const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2500));
            void Promise.race([resolveDisplayName(uid), timeout])
                .then((name) => {
                    if (name && message?.data) {
                        message.data.dName = name;
                        message.data.__zaloNameSource = "profile_resolved";
                    }
                    originalListenerEmit(eventName, ...args);
                })
                .catch(() => originalListenerEmit(eventName, ...args));
            return true;
        };`;
    zalo = zalo.replace(ctorAnchor, `${ctorAnchor}${block}`);
}

fs.writeFileSync(zaloPath, zalo, 'utf8');
