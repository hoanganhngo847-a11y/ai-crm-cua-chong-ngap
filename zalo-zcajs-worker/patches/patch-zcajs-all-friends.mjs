import fs from 'node:fs';

const zaloPath = 'src/zalo.ts';
const apiPath = 'src/apis/getAllFriends.ts';

const apiSource = `import { appContext } from "../context.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { encodeAES, handleZaloResponse, makeURL, request } from "../utils.js";

export type FriendProfile = Record<string, unknown>;
export type GetAllFriendsResponse = FriendProfile[];

export function getAllFriendsFactory(serviceURL: string) {
    return async function getAllFriends(count: number = 5000, page: number = 1) {
        if (!appContext.secretKey) throw new ZaloApiError("Secret key is not available");
        if (!appContext.imei) throw new ZaloApiError("IMEI is not available");
        const safeCount = Math.max(1, Math.min(5000, Math.trunc(Number(count) || 5000)));
        const safePage = Math.max(1, Math.trunc(Number(page) || 1));
        const params = {
            incInvalid: 1,
            page: safePage,
            count: safeCount,
            avatar_size: 120,
            actiontime: 0,
            imei: appContext.imei,
        };
        const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify(params));
        if (!encryptedParams) throw new ZaloApiError("Failed to encrypt friend-directory request");
        const response = await request(
            makeURL(serviceURL, { params: encryptedParams }),
            { method: "GET" },
        );
        const result = await handleZaloResponse<GetAllFriendsResponse>(response);
        if (result.error) throw new ZaloApiError(result.error.message, result.error.code);
        return Array.isArray(result.data) ? result.data : [];
    };
}
`;

fs.writeFileSync(apiPath, apiSource, 'utf8');

let zalo = fs.readFileSync(zaloPath, 'utf8');
const importAnchor = 'import { getCookieFactory } from "./apis/getCookie.js";';
const importLine = 'import { getAllFriendsFactory } from "./apis/getAllFriends.js";';
if (!zalo.includes(importAnchor)) throw new Error('ZCAJS all-friends patch import anchor missing');
if (!zalo.includes(importLine)) zalo = zalo.replace(importAnchor, `${importAnchor}\n${importLine}`);

const propertyAnchor = '    public getCookie: ReturnType<typeof getCookieFactory>;';
const propertyLine = '    public getAllFriends: ReturnType<typeof getAllFriendsFactory>;';
if (!zalo.includes(propertyAnchor)) throw new Error('ZCAJS all-friends patch property anchor missing');
if (!zalo.includes(propertyLine)) zalo = zalo.replace(propertyAnchor, `${propertyAnchor}\n${propertyLine}`);

const ctorAnchor = '        this.getCookie = getCookieFactory();';
if (!zalo.includes(ctorAnchor)) throw new Error('ZCAJS all-friends patch constructor anchor missing');
if (!zalo.includes('this.getAllFriends = getAllFriendsFactory')) {
    const block = `\n        const friendBase = zpwServiceMap.profile?.[0] || zpwServiceMap.friend?.[0];\n        this.getAllFriends = getAllFriendsFactory(\n            makeURL(\`${'${friendBase}'}/api/social/friend/getfriends\`, {\n                zpw_ver: Zalo.API_VERSION,\n                zpw_type: Zalo.API_TYPE,\n            }),\n        );`;
    zalo = zalo.replace(ctorAnchor, `${ctorAnchor}${block}`);
}

fs.writeFileSync(zaloPath, zalo, 'utf8');
