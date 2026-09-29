export const PHONE_REQUEST_TEMPLATE =
    'Anh/chị vui lòng để lại số điện thoại để bên em liên hệ tư vấn cửa chống ngập ạ.';

export type InboxMessage = {
    id: string;
    direction: 'INBOUND' | 'OUTBOUND';
    sanitized_content: string | null;
    sanitization_status: string;
    actor_type: string;
    created_at: string;
    delivery_status: string | null;
};

export async function getFacebookMessages(
    conversationId: string,
    signal?: AbortSignal,
): Promise<InboxMessage[]> {
    const response = await fetch(
        `/api/facebook/conversations/${encodeURIComponent(conversationId)}/messages`,
        {
            cache: 'no-store',
            signal,
        },
    );

    if (!response.ok) {
        throw new Error('Không tải được hội thoại.');
    }

    return (await response.json()).messages;
}

export function watchFacebookMessages(
    conversationId: string,
    onMessages: (messages: InboxMessage[]) => void,
    onError: (error: Error) => void,
) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    async function tick() {
        try {
            const messages = await getFacebookMessages(
                conversationId,
                controller.signal,
            );

            onMessages(messages);
        } catch (error) {
            if (!controller.signal.aborted) {
                onError(
                    error instanceof Error
                        ? error
                        : new Error('Không tải được tin nhắn.'),
                );
            }
        } finally {
            if (!controller.signal.aborted) {
                timer = setTimeout(tick, 3000);
            }
        }
    }

    void tick();

    return () => {
        controller.abort();
        clearTimeout(timer);
    };
}

export async function replyOnFacebook(
    conversationId: string,
    content: string,
    requestId: string,
    careDeliveryId?: string,
) {
    const response = await fetch(
        `/api/facebook/conversations/${encodeURIComponent(conversationId)}/messages`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                content,
                request_id: requestId,
                care_delivery_id: careDeliveryId,
            }),
        },
    );

    const result = await response.json();

    if (!response.ok) {
        throw new Error(result.error || 'SEND_FAILED');
    }

    return result as {
        request_id: string;
        status: 'SENDING' | 'SENT' | 'FAILED' | 'UNKNOWN';
    };
}