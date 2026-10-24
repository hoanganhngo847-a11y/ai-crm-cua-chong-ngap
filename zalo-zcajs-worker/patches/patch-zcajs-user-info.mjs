import fs from 'node:fs';

const zaloPath = 'src/zalo.ts';
const apiPath = 'src/apis/getUserInfo.ts';

const apiSource = `import { appContext } from "../context.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { encodeAES, handleZaloResponse, request } from "../utils.js";

export type ZaloUserProfile = {
    userId?: string;
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
        // If the endpoint or payload changes, callers fail soft and keep dName fallback.
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
if (!zalo.includes('this.getUserInfo = getUserInfoFactory(')) {
    const block = `
        const profileBase = zpwServiceMap.profile?.[0] || zpwServiceMap.friend?.[0];
        if (!profileBase) throw new Error("Zalo profile service is unavailable");
        this.getUserInfo = getUserInfoFactory(
            makeURL(\`${'${profileBase}'}/api/social/friend/getprofiles/v2\`, {
                zpw_ver: Zalo.API_VERSION,
                zpw_type: Zalo.API_TYPE,
            }),
        );`;
    zalo = zalo.replace(ctorAnchor, `${ctorAnchor}${block}`);
}

fs.writeFileSync(zaloPath, zalo, 'utf8');
