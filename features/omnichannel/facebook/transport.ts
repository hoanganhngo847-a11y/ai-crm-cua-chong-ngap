import 'server-only';
import { object, text } from './core';

type SendInput = {
    page: string;
    recipient: string;
    version: string;
    token: string;
    content: string;
};

type SendResult = {
    status: 'SENT' | 'FAILED' | 'UNKNOWN';
    mid: string | null;
};

export async function dispatchMessage(
    input: SendInput,
    fetcher: typeof fetch = fetch,
): Promise<SendResult> {
    try {
        const response = await fetcher(
            `https://graph.facebook.com/${input.version}/${input.page}/messages`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${input.token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    recipient: { id: input.recipient },
                    messaging_type: 'RESPONSE',
                    message: { text: input.content },
                }),
                signal: AbortSignal.timeout(10_000),
                cache: 'no-store',
            },
        );

        if (response.ok) {
            const payload = object(await response.json());

            return {
                status: 'SENT',
                mid: text(payload.message_id, 250),
            };
        }

        return {
            status: response.status >= 500 ? 'UNKNOWN' : 'FAILED',
            mid: null,
        };
    } catch {
        return {
            status: 'UNKNOWN',
            mid: null,
        };
    }
}