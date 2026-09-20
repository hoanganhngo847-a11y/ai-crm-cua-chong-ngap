import { createHmac, timingSafeEqual } from 'node:crypto';

export class ChannelError extends Error {
    constructor(
        public code: string,
        public status = 400,
    ) {
        super(code);
    }
}

const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ChannelError('INVALID_INPUT');
    }

    return value as Record<string, unknown>;
}

export function text(value: unknown, max: number, min = 1): string {
    if (
        typeof value !== 'string' ||
        value.trim().length < min ||
        value.length > max
    ) {
        throw new ChannelError('INVALID_INPUT');
    }

    return value.trim();
}

export function uuid(value: unknown): string {
    if (typeof value !== 'string' || !UUID.test(value)) {
        throw new ChannelError('INVALID_ID');
    }

    return value;
}

export function normalizePhone(value: string): string {
    let phone = value.normalize('NFKC').replace(/[\s().-]/g, '');

    if (phone.startsWith('00')) {
        phone = '+' + phone.slice(2);
    }

    if (/^0\d{9,10}$/.test(phone)) {
        phone = '+84' + phone.slice(1);
    } else if (/^84\d{9,10}$/.test(phone)) {
        phone = '+' + phone;
    }

    if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
        throw new ChannelError('INVALID_PHONE');
    }

    return phone;
}

export function extractPhone(content: string): string | null {
    const matches =
        content
            .normalize('NFKC')
            .match(/(?:\+|00)?\d[\d\s().-]{6,}\d/g) || [];

    const phones = new Set<string>();

    for (const match of matches) {
        try {
            phones.add(normalizePhone(match));
        } catch {
            // Chuỗi số không hợp lệ: không dùng để nhận diện khách.
        }
    }

    return phones.size === 1 ? [...phones][0] : null;
}

export function sanitize(content: string): {
    content: string | null;
    status: 'SUCCEEDED' | 'PENDING';
} {
    const normalized = content
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '');

    const words = normalized.toLocaleLowerCase('vi').match(/\p{L}+/gu) || [];

    const numberWords = new Set([
        'không', 'một', 'hai', 'ba', 'bốn', 'tư',
        'năm', 'sáu', 'bảy', 'tám', 'chín',
        'zero', 'one', 'two', 'three', 'four',
        'five', 'six', 'seven', 'eight', 'nine',
    ]);

    const suspicious =
        words.filter((word) => numberWords.has(word)).length >= 3 ||
        /(?:sđt|sdt|điện thoại|phone|zalo|liên hệ)\s*[:=]/i.test(normalized);

    if (suspicious) {
        return { content: null, status: 'PENDING' };
    }

    return {
        content: normalized
            .replace(/\p{N}/gu, '•')
            .replace(/https?:\/\/\S+/gi, '[liên kết đã ẩn]'),
        status: 'SUCCEEDED',
    };
}

export function secureEqual(a: string, b: string): boolean {
    const first = Buffer.from(a);
    const second = Buffer.from(b);

    return (
        first.length === second.length &&
        timingSafeEqual(first, second)
    );
}

export function validSignature(
    raw: string,
    signature: string | null,
    secret: string,
): boolean {
    if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) {
        return false;
    }

    const expected =
        'sha256=' +
        createHmac('sha256', secret).update(raw).digest('hex');

    return secureEqual(signature, expected);
}

export type MetaEvent = {
    key: string;
    page: string;
    sender: string;
    time: string;
    kind: 'MESSAGE' | 'DELIVERY' | 'READ';
    content: string;
    raw: Record<string, unknown>;
    mids: string[];
    watermark: number | null;
};

export function parseMeta(body: unknown, page: string): MetaEvent[] {
    const root = object(body);

    if (root.object !== 'page' || !Array.isArray(root.entry)) {
        throw new ChannelError('INVALID_WEBHOOK');
    }

    const result: MetaEvent[] = [];

    for (const value of root.entry) {
        const entry = object(value);

        if (entry.id !== page) {
            throw new ChannelError('PAGE_NOT_ALLOWED', 403);
        }

        if (!Array.isArray(entry.messaging)) continue;

        for (const item of entry.messaging) {
            const event = object(item);
            const sender = object(event.sender);
            const recipient = object(event.recipient);

            // Tin gửi bởi phần mềm đã được lưu qua outbox.
            if (event.message && object(event.message).is_echo === true) {
                continue;
            }

            if (recipient.id !== page) {
                throw new ChannelError('PAGE_NOT_ALLOWED', 403);
            }

            const psid = text(sender.id, 100);

            if (!/^\d+$/.test(psid)) {
                throw new ChannelError('INVALID_WEBHOOK');
            }

            const timestamp = event.timestamp;

            if (
                typeof timestamp !== 'number' ||
                !Number.isFinite(timestamp) ||
                timestamp < 0 ||
                timestamp > Date.now() + 300_000
            ) {
                throw new ChannelError('INVALID_TIMESTAMP');
            }

            const base = {
                page,
                sender: psid,
                time: new Date(timestamp).toISOString(),
                raw: event,
            };

            if (event.message) {
                const message = object(event.message);
                const mid = text(message.mid, 250);

                const content =
                    typeof message.text === 'string'
                        ? message.text.slice(0, 10000)
                        : '[Khách gửi tệp đính kèm; nội dung cần kiểm tra]';

                result.push({
                    ...base,
                    key: `${page}:${mid}`,
                    kind: 'MESSAGE',
                    content,
                    mids: [],
                    watermark: null,
                });
            } else if (event.delivery || event.read) {
                const data = object(event.delivery || event.read);

                const mids = Array.isArray(data.mids)
                    ? data.mids.map((value) => text(value, 250))
                    : [];

                const watermark =
                    typeof data.watermark === 'number' &&
                    Number.isFinite(data.watermark)
                        ? data.watermark
                        : null;

                result.push({
                    ...base,
                    key: '',
                    kind: event.delivery ? 'DELIVERY' : 'READ',
                    content: '',
                    mids,
                    watermark,
                });
            }
        }
    }

    if (result.length > 200) {
        throw new ChannelError('TOO_MANY_EVENTS', 413);
    }

    return result;
}

export function canReply(
    lastInbound: string | null,
    now = Date.now(),
): boolean {
    if (!lastInbound) return false;

    const age = now - Date.parse(lastInbound);

    return (
        Number.isFinite(age) &&
        age >= 0 &&
        age < 24 * 60 * 60 * 1000
    );
}

export async function readBody(
    request: Request,
    max = 1_000_000,
): Promise<string> {
    if (!request.body) {
        throw new ChannelError('EMPTY_BODY');
    }

    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;

    try {
        for (;;) {
            const { done, value } = await reader.read();

            if (done) break;

            bytes += value.length;

            if (bytes > max) {
                await reader.cancel();
                throw new ChannelError('BODY_TOO_LARGE', 413);
            }

            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    return Buffer.concat(chunks).toString('utf8');
}

export function encodeCursor(row: {
    created_at: string;
    id: string;
}): string {
    return Buffer.from(
        JSON.stringify([row.created_at, row.id]),
    ).toString('base64url');
}

export function decodeCursor(value: string): {
    time: string;
    id: string;
} {
    try {
        if (value.length > 256) throw new Error();

        const parsed = JSON.parse(
            Buffer.from(value, 'base64url').toString('utf8'),
        );

        if (
            !Array.isArray(parsed) ||
            parsed.length !== 2 ||
            typeof parsed[0] !== 'string'
        ) {
            throw new Error();
        }

        return {
            time: new Date(parsed[0]).toISOString(),
            id: uuid(parsed[1]),
        };
    } catch {
        throw new ChannelError('INVALID_CURSOR');
    }
}