import fs from 'node:fs';

// Protocol from zca-js src/apis/getGroupMembersInfo.ts. This adapter targets
// the older ZCAJS build pinned by our Dockerfile.
fs.writeFileSync('src/apis/getGroupMembersInfo.ts', `import { appContext } from "../context.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { encodeAES, handleZaloResponse, makeURL, request } from "../utils.js";

export function getGroupMembersInfoFactory(serviceURL: string) {
    return async function getGroupMembersInfo(memberIds: string[]) {
        if (!appContext.secretKey) throw new ZaloApiError("Secret key is not available");
        const params = encodeAES(appContext.secretKey, JSON.stringify({
            friend_pversion_map: memberIds.map(id => id.endsWith("_0") ? id : id + "_0"),
        }));
        if (!params) throw new ZaloApiError("Failed to encrypt group-member request");
        const response = await request(makeURL(serviceURL, { params }));
        const result = await handleZaloResponse<{ profiles?: Record<string, any> }>(response);
        if (result.error) throw new ZaloApiError(result.error.message, result.error.code);
        return result.data || { profiles: {} };
    };
}
`);

let source = fs.readFileSync('src/zalo.ts', 'utf8');
const entries = [
  ['import { getCookieFactory } from "./apis/getCookie.js";', 'import { getGroupMembersInfoFactory } from "./apis/getGroupMembersInfo.js";'],
  ['    public getCookie: ReturnType<typeof getCookieFactory>;', '    public getGroupMembersInfo: ReturnType<typeof getGroupMembersInfoFactory>;'],
  ['        this.getCookie = getCookieFactory();', `        this.getGroupMembersInfo = getGroupMembersInfoFactory(
            makeURL(\`\${zpwServiceMap.profile?.[0] || zpwServiceMap.friend?.[0]}/api/social/group/members\`, {
                zpw_ver: Zalo.API_VERSION, zpw_type: Zalo.API_TYPE,
            }),
        );`],
];
for (const [anchor, addition] of entries) {
  if (!source.includes(anchor)) throw new Error('Group-member patch anchor missing');
  if (!source.includes(addition)) source = source.replace(anchor, anchor + '\n' + addition);
}
fs.writeFileSync('src/zalo.ts', source);
