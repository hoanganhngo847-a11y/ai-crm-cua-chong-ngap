import assert from 'node:assert/strict';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';

import { syncFacebookPages } from '../../features/omnichannel/facebook/sync';

const PAGE = '1343097708890171';
const COMPANY = 'de6a7bf3-b5bc-418d-92d6-f9b241472598';
const CUSTOMER = '40207180452206377';

process.env.META_GRAPH_VERSION = 'v26.0';
process.env.META_PAGE_TEST_TOKEN = 'test-token';
process.env.META_PAGE_BINDINGS = JSON.stringify([
    { page: PAGE, company: COMPANY, tokenEnv: 'META_PAGE_TEST_TOKEN' },
]);

type FetchHandler = (url: URL) => Response | Promise<Response>;
type RpcCall = { name: string; args: Record<string, unknown> };
type RpcResult = { data?: unknown; error?: { message: string } | null };

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function withFetch(
    handler: FetchHandler,
    run: (urls: URL[]) => Promise<void>,
): Promise<void> {
    const originalFetch = globalThis.fetch;
    const urls: URL[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = input instanceof URL ? input : new URL(String(input));
        urls.push(url);
        return handler(url);
    }) as typeof fetch;

    return run(urls).finally(() => {
        globalThis.fetch = originalFetch;
    });
}

function fakeClient(
    handler?: (name: string, args: Record<string, unknown>) => RpcResult,
): { client: SupabaseClient; calls: RpcCall[] } {
    const calls: RpcCall[] = [];
    const client = {
        rpc: async (name: string, args: Record<string, unknown>) => {
            calls.push({ name, args });
            return handler
                ? handler(name, args)
                : { data: { status: 'ACCEPTED' }, error: null };
        },
    } as unknown as SupabaseClient;

    return { client, calls };
}

function conversationResponse(): Response {
    return jsonResponse({
        data: [
            {
                id: 't_1',
                updated_time: '2026-10-27T08:40:19+0000',
                participants: {
                    data: [
                        { id: CUSTOMER, name: 'Mai Hạnh' },
                        { id: PAGE, name: 'Cửa chống ngập' },
                    ],
                },
            },
            {
                id: 't_old',
                updated_time: '2026-10-27T07:00:00+0000',
                participants: {
                    data: [
                        { id: '999', name: 'Khách cũ' },
                        { id: PAGE, name: 'Cửa chống ngập' },
                    ],
                },
            },
        ],
    });
}

test('polls customer messages, skips Page echoes, and stops at the lookback boundary', async () => {
    const { client, calls } = fakeClient();
    const promotions: Array<{ page: string; psid: string; name: string | null }> = [];

    await withFetch(
        (url) => {
            if (url.pathname.endsWith(`/${PAGE}/conversations`)) {
                return conversationResponse();
            }

            if (url.pathname.endsWith('/t_1/messages')) {
                return jsonResponse({
                    data: [
                        {
                            id: 'm_page',
                            from: { id: PAGE, name: 'Cửa chống ngập' },
                            message: 'auto reply',
                            created_time: '2026-10-27T08:40:19+0000',
                        },
                        {
                            id: 'm_customer',
                            from: { id: CUSTOMER, name: 'Mai Hạnh' },
                            message: 'hi bạn',
                            created_time: '2026-10-27T08:40:16+0000',
                        },
                        {
                            id: 'm_old',
                            from: { id: CUSTOMER, name: 'Mai Hạnh' },
                            message: 'tin cũ',
                            created_time: '2026-10-27T07:59:59+0000',
                        },
                    ],
                });
            }

            throw new Error(`unexpected URL ${url.pathname}`);
        },
        async (urls) => {
            const summary = await syncFacebookPages(
                { lookbackMinutes: 60 },
                {
                    client,
                    now: new Date('2026-10-27T09:00:00Z'),
                    promoteDisplayName: async (config, psid, name) => {
                        promotions.push({ page: config.page, psid, name });
                    },
                },
            );

            assert.equal(summary.ok, true);
            assert.equal(summary.pages[0].conversations, 1);
            assert.equal(summary.pages[0].messages_seen, 2);
            assert.equal(summary.pages[0].messages_ingested, 1);
            assert.equal(summary.pages[0].messages_skipped, 1);
            assert.equal(calls.length, 1);
            assert.equal(calls[0].name, 'han_ingest');
            assert.equal(calls[0].args.p_key, `${PAGE}:m_customer`);
            assert.equal(calls[0].args.p_external, `${PAGE}:${CUSTOMER}`);
            assert.equal(calls[0].args.p_name, 'Khách Messenger');
            assert.equal(calls[0].args.p_content, 'hi bạn');
            assert.equal(calls[0].args.p_safe, 'hi bạn');
            assert.equal(calls[0].args.p_safe_status, 'SUCCEEDED');
            assert.deepEqual(promotions, [
                { page: PAGE, psid: CUSTOMER, name: 'Mai Hạnh' },
            ]);

            // Graph v26 ignores `since`; the worker must filter client-side instead.
            assert.equal(urls[0].searchParams.get('since'), null);
            assert.equal(urls[1].searchParams.get('since'), null);
            assert.equal(
                urls.some((url) => url.pathname.includes('/t_old/messages')),
                false,
            );
        },
    );
});

test('treats a replayed message status as already ingested', async () => {
    const { client, calls } = fakeClient(() => ({
        data: { status: 'PROCESSED' },
        error: null,
    }));
    let promoted = 0;

    await withFetch(
        (url) => {
            if (url.pathname.endsWith(`/${PAGE}/conversations`)) {
                return conversationResponse();
            }

            return jsonResponse({
                data: [
                    {
                        id: 'm_customer',
                        from: { id: CUSTOMER, name: 'Mai Hạnh' },
                        message: 'hi bạn',
                        created_time: '2026-10-27T08:40:16+0000',
                    },
                ],
            });
        },
        async () => {
            const summary = await syncFacebookPages(
                { lookbackMinutes: 60 },
                {
                    client,
                    now: new Date('2026-10-27T09:00:00Z'),
                    promoteDisplayName: async () => {
                        promoted += 1;
                    },
                },
            );

            assert.equal(summary.ok, true);
            assert.equal(summary.pages[0].messages_ingested, 0);
            assert.equal(summary.pages[0].messages_skipped, 1);
            assert.equal(summary.pages[0].errors.length, 0);
            assert.equal(calls.length, 1);
            assert.equal(promoted, 1);
        },
    );
});

test('treats an idempotency conflict as an already-ingested message', async () => {
    const { client, calls } = fakeClient(() => ({
        error: { message: 'IDEMPOTENCY_CONFLICT' },
    }));

    await withFetch(
        (url) => {
            if (url.pathname.endsWith(`/${PAGE}/conversations`)) {
                return conversationResponse();
            }

            return jsonResponse({
                data: [
                    {
                        id: 'm_customer',
                        from: { id: CUSTOMER, name: 'Mai Hạnh' },
                        message: 'hi bạn',
                        created_time: '2026-10-27T08:40:16+0000',
                    },
                ],
            });
        },
        async () => {
            const summary = await syncFacebookPages(
                { lookbackMinutes: 60 },
                {
                    client,
                    now: new Date('2026-10-27T09:00:00Z'),
                    promoteDisplayName: async () => {},
                },
            );

            assert.equal(summary.ok, true);
            assert.equal(summary.pages[0].messages_ingested, 0);
            assert.equal(summary.pages[0].messages_skipped, 1);
            assert.equal(summary.pages[0].errors.length, 0);
            assert.equal(calls.length, 1);
        },
    );
});

test('redacts a phone number from the public message and stores it privately', async () => {
    const { client, calls } = fakeClient();

    await withFetch(
        (url) => {
            if (url.pathname.endsWith(`/${PAGE}/conversations`)) {
                return conversationResponse();
            }

            return jsonResponse({
                data: [
                    {
                        id: 'm_phone',
                        from: { id: CUSTOMER, name: 'Mai Hạnh' },
                        message: 'SĐT 0912345678',
                        created_time: '2026-10-27T08:40:16+0000',
                    },
                ],
            });
        },
        async () => {
            await syncFacebookPages(
                { lookbackMinutes: 60 },
                {
                    client,
                    now: new Date('2026-10-27T09:00:00Z'),
                    promoteDisplayName: async () => {},
                },
            );

            assert.equal(calls[0].args.p_phone, '+84912345678');
            assert.doesNotMatch(
                String(calls[0].args.p_safe),
                /0912345678/,
            );
            assert.match(String(calls[0].args.p_safe), /số điện thoại đã ẩn/);
        },
    );
});

test('returns a sanitized Graph failure without leaking the Page token', async () => {
    const { client, calls } = fakeClient();

    await withFetch(
        () =>
            jsonResponse(
                { error: { code: 190, error_subcode: 463, message: 'bad token' } },
                401,
            ),
        async () => {
            const summary = await syncFacebookPages(
                { lookbackMinutes: 60 },
                {
                    client,
                    now: new Date('2026-10-27T09:00:00Z'),
                    promoteDisplayName: async () => {},
                },
            );

            assert.equal(summary.ok, false);
            assert.deepEqual(summary.pages[0].errors, [
                'graph_status=401 code=190 subcode=463',
            ]);
            assert.equal(calls.length, 0);
            assert.doesNotMatch(
                JSON.stringify(summary),
                /test-token|bad token/,
            );
        },
    );
});
