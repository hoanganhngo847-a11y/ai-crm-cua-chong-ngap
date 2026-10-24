import fs from 'node:fs';

const zaloPath = 'src/zalo.ts';
const apiPath = 'src/apis/getRecentDirectMessages.ts';

const apiSource = `import { appContext } from "../context.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { Message, TMessage } from "../models/Message.js";
import { encodeAES, handleZaloResponse, makeURL, request } from "../utils.js";

type RecentDirectMessagesResponse = {
    msgs?: TMessage[];
    pageMsgs?: TMessage[];
};

export function getRecentDirectMessagesFactory(serviceURL: string) {
    return async function getRecentDirectMessages() {
        if (!appContext.secretKey) throw new ZaloApiError("Secret key is not available");
        if (!appContext.imei) throw new ZaloApiError("IMEI is not available");

        const encryptedParams = encodeAES(
            appContext.secretKey,
            JSON.stringify({
                threadIdLocalMsgId: JSON.stringify({}),
                imei: appContext.imei,
            }),
        );
        if (!encryptedParams) throw new ZaloApiError("Failed to encrypt recent-message request");

        const response = await request(
            makeURL(serviceURL, {
                params: encryptedParams,
            }),
        );
        const result = await handleZaloResponse<RecentDirectMessagesResponse>(response);
        if (result.error) throw new ZaloApiError(result.error.message, result.error.code);

        const data = result.data || {};
        const rawMessages = [...(data.msgs || []), ...(data.pageMsgs || [])];
        const seen = new Set<string>();
        const messages: Message[] = [];

        for (const raw of rawMessages) {
            const id = String(raw?.msgId || raw?.realMsgId || raw?.cliMsgId || "").trim();
            if (!id || seen.has(id)) continue;
            seen.add(id);
            messages.push(new Message(raw));
        }

        return messages;
    };
}
`;

fs.writeFileSync(apiPath, apiSource, 'utf8');

let zalo = fs.readFileSync(zaloPath, 'utf8');
const importAnchor = 'import { getCookieFactory } from "./apis/getCookie.js";';
const importLine = 'import { getRecentDirectMessagesFactory } from "./apis/getRecentDirectMessages.js";';
if (!zalo.includes(importAnchor)) throw new Error('ZCAJS patch anchor missing: getCookie import');
if (!zalo.includes(importLine)) zalo = zalo.replace(importAnchor, `${importAnchor}\n${importLine}`);

const ctorAnchor = '        this.getCookie = getCookieFactory();';
if (!zalo.includes(ctorAnchor)) throw new Error('ZCAJS patch anchor missing: getCookie constructor');

const recentSyncBlock = `

        // Zalo Web can keep a first-time/stranger direct message in the recent
        // conversation preload even when the websocket listener does not emit it.
        // Recover those recent inbound DMs through the same listener event so the
        // CRM ingress path, tenant checks and idempotency remain unchanged.
        const conversationBase = zpwServiceMap.conversation?.[0] || "https://tt-convers-wpa.chat.zalo.me";
        const getRecentDirectMessages = getRecentDirectMessagesFactory(
            makeURL(\`${'${conversationBase}'}/api/preloadconvers/get-last-msgs\`, {
                zpw_ver: Zalo.API_VERSION,
                zpw_type: Zalo.API_TYPE,
                nretry: 0,
            }),
        );
        const recentSeen = new Map<string, number>();
        const recentWindowMs = 24 * 60 * 60 * 1000;
        let recentSyncTimer: ReturnType<typeof setInterval> | undefined;
        let recentSyncRunning = false;

        const messageTimestampMs = (message: any) => {
            const numeric = Number(message?.data?.ts);
            if (!Number.isFinite(numeric) || numeric <= 0) return 0;
            return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
        };
        const messageId = (message: any) =>
            String(message?.data?.msgId || message?.data?.realMsgId || message?.data?.cliMsgId || "").trim();
        const rememberRecent = (message: any) => {
            const id = messageId(message);
            if (id) recentSeen.set(id, Date.now());
        };
        const pruneRecent = (now: number) => {
            for (const [id, seenAt] of recentSeen.entries()) {
                if (now - seenAt > recentWindowMs) recentSeen.delete(id);
            }
        };
        const syncRecent = async () => {
            if (recentSyncRunning) return;
            recentSyncRunning = true;
            try {
                const now = Date.now();
                pruneRecent(now);
                const messages = await getRecentDirectMessages();
                let emitted = 0;
                for (const message of messages) {
                    if (message.isSelf) continue;
                    const id = messageId(message);
                    const ts = messageTimestampMs(message);
                    if (!id || !ts || now - ts > recentWindowMs || recentSeen.has(id)) continue;
                    recentSeen.set(id, now);
                    this.listener.emit("message", message);
                    emitted += 1;
                }
                if (emitted > 0) logger.info("Recovered recent inbound Zalo DMs via REST", emitted);
            } catch (error) {
                logger.warn(
                    "Recent inbound Zalo DM recovery failed",
                    error instanceof Error ? error.message : "unknown",
                );
            } finally {
                recentSyncRunning = false;
            }
        };

        this.listener.on("message", rememberRecent);
        this.listener.on("connected", () => {
            setTimeout(() => void syncRecent(), 1_000);
            if (recentSyncTimer) clearInterval(recentSyncTimer);
            recentSyncTimer = setInterval(() => void syncRecent(), 30_000);
        });
        this.listener.on("closed", () => {
            if (recentSyncTimer) clearInterval(recentSyncTimer);
            recentSyncTimer = undefined;
        });`;

if (!zalo.includes('Recovered recent inbound Zalo DMs via REST')) {
    zalo = zalo.replace(ctorAnchor, `${ctorAnchor}${recentSyncBlock}`);
}

fs.writeFileSync(zaloPath, zalo, 'utf8');
