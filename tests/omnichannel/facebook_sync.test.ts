import assert from 'node:assert/strict';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
    DEFAULT_FACEBOOK_FOLDERS,
    syncFacebookPages,
} from '../../features/omnichannel/facebook/sync';

const PAGE_A = '1343097708890171'; // Cửa chống ngập
const PAGE_B = '1026991374010112'; // CHD
const COMPANY = 'de6a7bf3-b5bc-418d-92d6-f9b241472598';
const CUSTOMER_A = '40207180452206377';
const CUSTOMER_B = '27894311773558665'; // Yen Nguyen

process.env.META_GRAPH_VERSION = 'v26.0';
process.env.META_PAGE_BOTCAKE_TOKEN = 'token-page-a';
process.env.META_PAGE_CHD_TOKEN = 'token-page-b';
process.env.META_PAGE_BINDINGS = JSON.stringify([
    { page: PAGE_A, company: COMPANY, tokenEnv: 'META_PAGE_BOTCAKE_TOKEN', name: 'Cửa chống ngập' },
    { page: PAGE_B, company: COMPANY, tokenEnv: 'META_PAGE_CHD_TOKEN', name: 'Du học CHD' },
]);

type FetchHandler = (url: URL, headers: Headers) => Response | Promise<Response>;
type RpcCall = { name: string; args: Record<string, unknown> };
type RpcResult = { data?: unknown; error?: { message: string; code?: string } | null };

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

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof URL ? input : new URL(String(input));
        urls.push(url);
        const headers = new Headers(init?.headers);
        return handler(url, headers);
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

test('polls default folders (inbox, other, pending), ingesting both inbound and Page outbound messages', async () => {
    const { client, calls } = fakeClient();
    const promotions: Array<{ page: string; psid: string; name: string | null }> = [];

    await withFetch(
        (url) => {
            const folder = url.searchParams.get('folder');

            if (url.pathname.endsWith(`/${PAGE_A}/conversations`)) {
                if (folder === 'inbox') {
                    return jsonResponse({
                        data: [
                            {
                                id: 't_inbox',
                                updated_time: '2026-10-27T08:40:19+0000',
                                participants: {
                                    data: [
                                        { id: CUSTOMER_A, name: 'Mai Hạnh' },
                                        { id: PAGE_A, name: 'Cửa chống ngập' },
                                    ],
                                },
                            },
                        ],
                    });
                }
                return jsonResponse({ data: [] });
            }

            if (url.pathname.endsWith('/t_inbox/messages')) {
                return jsonResponse({
                    data: [
                        {
                            id: 'm_page_reply',
                            from: { id: PAGE_A, name: 'Cửa chống ngập' },
                            message: 'Dạ shop chào bạn, shop có thể hỗ trợ gì ạ?',
                            created_time: '2026-10-27T08:40:19+0000',
                        },
                        {
                            id: 'm_customer_inbound',
                            from: { id: CUSTOMER_A, name: 'Mai Hạnh' },
                            message: 'Báo giá cửa 2.5m giúp mình',
                            created_time: '2026-10-27T08:35:10+0000',
                        },
                    ],
                });
            }

            return jsonResponse({ data: [] });
        },
        async (urls) => {
            const summary = await syncFacebookPages(
                { lookbackMinutes: 60, pages: [PAGE_A] },
                {
                    client,
                    now: new Date('2026-10-27T09:00:00Z'),
                    promoteDisplayName: async (config, psid, name) => {
                        promotions.push({ page: config.page, psid, name });
                    },
                },
            );

            assert.equal(summary.ok, true);
            const pageResult = summary.pages[0];
            assert.equal(pageResult.conversations, 1);
            assert.equal(pageResult.messages_seen, 2);
            assert.equal(pageResult.messages_ingested, 2);
            assert.equal(pageResult.inbound_ingested, 1);
            assert.equal(pageResult.outbound_ingested, 1);
            assert.equal(pageResult.messages_skipped, 0);

            // Calls: han_ingest_outbound for m_page_reply, han_ingest for m_customer_inbound
            assert.equal(calls.length, 2);

            const outboundCall = calls.find((c) => c.name === 'han_ingest_outbound');
            assert.ok(outboundCall);
            assert.equal(outboundCall.args.p_key, `${PAGE_A}:m_page_reply`);
            assert.equal(outboundCall.args.p_customer_psid, CUSTOMER_A);
            assert.equal(outboundCall.args.p_page, PAGE_A);
            assert.equal(outboundCall.args.p_content, 'Dạ shop chào bạn, shop có thể hỗ trợ gì ạ?');

            const inboundCall = calls.find((c) => c.name === 'han_ingest');
            assert.ok(inboundCall);
            assert.equal(inboundCall.args.p_key, `${PAGE_A}:m_customer_inbound`);
            assert.equal(inboundCall.args.p_external, `${PAGE_A}:${CUSTOMER_A}`);

            assert.deepEqual(promotions, [
                { page: PAGE_A, psid: CUSTOMER_A, name: 'Mai Hạnh' },
            ]);

            // Verified polling queried folder=inbox, folder=other, folder=pending
            const polledFolders = urls
                .filter((u) => u.pathname.endsWith(`/${PAGE_A}/conversations`))
                .map((u) => u.searchParams.get('folder'));
            assert.deepEqual(polledFolders, DEFAULT_FACEBOOK_FOLDERS);
        },
    );
});

test('polls CHD Page other folder and discovers Yen Nguyen conversation', async () => {
    const { client, calls } = fakeClient();
    const promotions: Array<{ page: string; psid: string; name: string | null }> = [];

    await withFetch(
        (url, headers) => {
            const folder = url.searchParams.get('folder');

            if (url.pathname.endsWith(`/${PAGE_B}/conversations`)) {
                // Must authenticate with CHD token
                assert.equal(headers.get('Authorization'), 'Bearer token-page-b');

                if (folder === 'other') {
                    return jsonResponse({
                        data: [
                            {
                                id: 't_yen_nguyen',
                                updated_time: '2026-10-27T03:06:11+0000',
                                participants: {
                                    data: [
                                        { id: CUSTOMER_B, name: 'Yen Nguyen' },
                                        { id: PAGE_B, name: 'Du học CHD' },
                                    ],
                                },
                            },
                        ],
                    });
                }
                return jsonResponse({ data: [] });
            }

            if (url.pathname.endsWith('/t_yen_nguyen/messages')) {
                return jsonResponse({
                    data: [
                        {
                            id: 'm_chd_outbound',
                            from: { id: PAGE_B, name: 'Du học CHD' },
                            message: 'Chào bạn Yen Nguyen, bạn cần tư vấn du học Đức ngành nào ạ?',
                            created_time: '2026-10-27T03:06:11+0000',
                        },
                        {
                            id: 'm_yen_inbound_1',
                            from: { id: CUSTOMER_B, name: 'Yen Nguyen' },
                            message: 'Em muốn hỏi về chứng minh tài chính',
                            created_time: '2026-10-27T03:05:00+0000',
                        },
                    ],
                });
            }

            return jsonResponse({ data: [] });
        },
        async () => {
            const summary = await syncFacebookPages(
                { lookbackMinutes: 24 * 60, pages: [PAGE_B], folders: ['other'] },
                {
                    client,
                    now: new Date('2026-10-27T12:00:00Z'),
                    promoteDisplayName: async (config, psid, name) => {
                        promotions.push({ page: config.page, psid, name });
                    },
                },
            );

            assert.equal(summary.ok, true);
            const pageResult = summary.pages[0];
            assert.equal(pageResult.conversations, 1);
            assert.equal(pageResult.messages_seen, 2);
            assert.equal(pageResult.messages_ingested, 2);
            assert.equal(pageResult.inbound_ingested, 1);
            assert.equal(pageResult.outbound_ingested, 1);

            assert.deepEqual(promotions, [
                { page: PAGE_B, psid: CUSTOMER_B, name: 'Yen Nguyen' },
            ]);
        },
    );
});

test('prevents duplicated processing when a conversation appears in multiple folders', async () => {
    const { client, calls } = fakeClient();

    await withFetch(
        (url) => {
            const folder = url.searchParams.get('folder');

            if (url.pathname.endsWith(`/${PAGE_A}/conversations`)) {
                // Both inbox and other return the exact same conversation
                return jsonResponse({
                    data: [
                        {
                            id: 't_duplicate_across_folders',
                            updated_time: '2026-10-27T08:50:00+0000',
                            participants: {
                                data: [
                                    { id: CUSTOMER_A, name: 'Mai Hạnh' },
                                    { id: PAGE_A, name: 'Cửa chống ngập' },
                                ],
                            },
                        },
                    ],
                });
            }

            if (url.pathname.endsWith('/t_duplicate_across_folders/messages')) {
                return jsonResponse({
                    data: [
                        {
                            id: 'm_single',
                            from: { id: CUSTOMER_A, name: 'Mai Hạnh' },
                            message: 'Hello test',
                            created_time: '2026-10-27T08:50:00+0000',
                        },
                    ],
                });
            }

            return jsonResponse({ data: [] });
        },
        async (urls) => {
            const summary = await syncFacebookPages(
                { lookbackMinutes: 60, pages: [PAGE_A] },
                { client, now: new Date('2026-10-27T09:00:00Z') },
            );

            assert.equal(summary.ok, true);
            // Conversation was seen in inbox, so in other and pending it was skipped
            assert.equal(summary.pages[0].conversations, 1);
            assert.equal(summary.pages[0].messages_ingested, 1);
            assert.equal(calls.length, 1);

            // Message fetch should only have happened once
            const messageUrls = urls.filter((u) => u.pathname.includes('/messages'));
            assert.equal(messageUrls.length, 1);
        },
    );
});

test('handles folder pagination and stops client-side at the lookback boundary', async () => {
    const { client, calls } = fakeClient();

    await withFetch(
        (url) => {
            if (url.pathname.endsWith(`/${PAGE_A}/conversations`)) {
                const after = url.searchParams.get('after');
                if (!after) {
                    return jsonResponse({
                        data: [
                            {
                                id: 't_recent',
                                updated_time: '2026-10-27T08:50:00+0000',
                                participants: {
                                    data: [
                                        { id: CUSTOMER_A, name: 'Mai Hạnh' },
                                        { id: PAGE_A, name: 'Cửa chống ngập' },
                                    ],
                                },
                            },
                        ],
                        paging: {
                            cursors: { after: 'cursor_page_2' },
                            next: 'https://graph.facebook.com/...',
                        },
                    });
                }

                if (after === 'cursor_page_2') {
                    return jsonResponse({
                        data: [
                            {
                                id: 't_old_boundary',
                                updated_time: '2026-10-27T07:30:00+0000', // Older than 60m window (08:00:00Z)
                                participants: {
                                    data: [
                                        { id: '111222', name: 'Khách cũ' },
                                        { id: PAGE_A, name: 'Cửa chống ngập' },
                                    ],
                                },
                            },
                        ],
                    });
                }
            }

            if (url.pathname.endsWith('/t_recent/messages')) {
                return jsonResponse({
                    data: [
                        {
                            id: 'm_recent',
                            from: { id: CUSTOMER_A, name: 'Mai Hạnh' },
                            message: 'Tin mới',
                            created_time: '2026-10-27T08:50:00+0000',
                        },
                        {
                            id: 'm_old_in_conv',
                            from: { id: CUSTOMER_A, name: 'Mai Hạnh' },
                            message: 'Tin cũ trong hội thoại',
                            created_time: '2026-10-27T07:20:00+0000', // Older than window
                        },
                    ],
                });
            }

            return jsonResponse({ data: [] });
        },
        async (urls) => {
            const summary = await syncFacebookPages(
                { lookbackMinutes: 60, pages: [PAGE_A], folders: ['inbox'] },
                { client, now: new Date('2026-10-27T09:00:00Z') },
            );

            assert.equal(summary.ok, true);
            assert.equal(summary.pages[0].conversations, 1);
            assert.equal(summary.pages[0].messages_ingested, 1);
            assert.equal(calls.length, 1);
            assert.equal(calls[0].args.p_key, `${PAGE_A}:m_recent`);

            // Verified t_old_boundary messages were NEVER queried
            assert.equal(
                urls.some((u) => u.pathname.includes('/t_old_boundary/messages')),
                false,
            );
        },
    );
});

test('treats an idempotency conflict as an already-ingested message for both inbound and outbound', async () => {
    const { client, calls } = fakeClient(() => ({
        error: { message: 'IDEMPOTENCY_CONFLICT' },
    }));

    await withFetch(
        (url) => {
            if (url.pathname.endsWith(`/${PAGE_A}/conversations`)) {
                return jsonResponse({
                    data: [
                        {
                            id: 't_conv',
                            updated_time: '2026-10-27T08:40:16+0000',
                            participants: {
                                data: [
                                    { id: CUSTOMER_A, name: 'Mai Hạnh' },
                                    { id: PAGE_A, name: 'Cửa chống ngập' },
                                ],
                            },
                        },
                    ],
                });
            }

            return jsonResponse({
                data: [
                    {
                        id: 'm_dup_inbound',
                        from: { id: CUSTOMER_A, name: 'Mai Hạnh' },
                        message: 'hi bạn',
                        created_time: '2026-10-27T08:40:16+0000',
                    },
                    {
                        id: 'm_dup_outbound',
                        from: { id: PAGE_A, name: 'Cửa chống ngập' },
                        message: 'chào bạn',
                        created_time: '2026-10-27T08:40:17+0000',
                    },
                ],
            });
        },
        async () => {
            const summary = await syncFacebookPages(
                { lookbackMinutes: 60, pages: [PAGE_A], folders: ['inbox'] },
                {
                    client,
                    now: new Date('2026-10-27T09:00:00Z'),
                    promoteDisplayName: async () => {},
                },
            );

            assert.equal(summary.ok, true);
            assert.equal(summary.pages[0].messages_ingested, 0);
            assert.equal(summary.pages[0].messages_skipped, 2);
            assert.equal(summary.pages[0].errors.length, 0);
            assert.equal(calls.length, 2);
        },
    );
});

test('handles partial folder failures without aborting other folders', async () => {
    const { client, calls } = fakeClient();

    await withFetch(
        (url) => {
            const folder = url.searchParams.get('folder');

            if (url.pathname.endsWith(`/${PAGE_A}/conversations`)) {
                if (folder === 'inbox') {
                    return jsonResponse({
                        data: [
                            {
                                id: 't_inbox_ok',
                                updated_time: '2026-10-27T08:40:00+0000',
                                participants: {
                                    data: [
                                        { id: CUSTOMER_A, name: 'Mai Hạnh' },
                                        { id: PAGE_A, name: 'Cửa chống ngập' },
                                    ],
                                },
                            },
                        ],
                    });
                }
                if (folder === 'other') {
                    // Simulated Graph API folder failure (e.g. rate limit or permission error on that folder)
                    return jsonResponse(
                        { error: { code: 100, message: 'Invalid folder' } },
                        400,
                    );
                }
                if (folder === 'pending') {
                    return jsonResponse({ data: [] });
                }
            }

            if (url.pathname.endsWith('/t_inbox_ok/messages')) {
                return jsonResponse({
                    data: [
                        {
                            id: 'm_ok',
                            from: { id: CUSTOMER_A, name: 'Mai Hạnh' },
                            message: 'Inbox ok',
                            created_time: '2026-10-27T08:40:00+0000',
                        },
                    ],
                });
            }

            return jsonResponse({ data: [] });
        },
        async () => {
            const summary = await syncFacebookPages(
                { lookbackMinutes: 60, pages: [PAGE_A] },
                { client, now: new Date('2026-10-27T09:00:00Z') },
            );

            // Overall summary reflects folder failure
            assert.equal(summary.ok, false);
            const pageResult = summary.pages[0];
            assert.equal(pageResult.messages_ingested, 1);
            assert.equal(pageResult.errors.length, 1);
            assert.match(pageResult.errors[0], /folder_failed:other/);
            assert.equal(calls.length, 1);

            // Folders array breakdown
            const otherFolder = pageResult.folders?.find((f) => f.folder === 'other');
            assert.ok(otherFolder);
            assert.equal(otherFolder.errors.length, 1);

            const inboxFolder = pageResult.folders?.find((f) => f.folder === 'inbox');
            assert.ok(inboxFolder);
            assert.equal(inboxFolder.messages_ingested, 1);
            assert.equal(inboxFolder.errors.length, 0);
        },
    );
});

test('handles attachment placeholder and empty message gracefully', async () => {
    const { client, calls } = fakeClient();

    await withFetch(
        (url) => {
            if (url.pathname.endsWith(`/${PAGE_A}/conversations`)) {
                return jsonResponse({
                    data: [
                        {
                            id: 't_attachments',
                            updated_time: '2026-10-27T08:50:00+0000',
                            participants: {
                                data: [
                                    { id: CUSTOMER_A, name: 'Mai Hạnh' },
                                    { id: PAGE_A, name: 'Cửa chống ngập' },
                                ],
                            },
                        },
                    ],
                });
            }

            return jsonResponse({
                data: [
                    {
                        id: 'm_attach',
                        from: { id: CUSTOMER_A, name: 'Mai Hạnh' },
                        message: '',
                        attachments: [{ type: 'image' }],
                        created_time: '2026-10-27T08:50:00+0000',
                    },
                    {
                        id: 'm_empty',
                        from: { id: PAGE_A, name: 'Cửa chống ngập' },
                        message: '',
                        created_time: '2026-10-27T08:51:00+0000',
                    },
                ],
            });
        },
        async () => {
            const summary = await syncFacebookPages(
                { lookbackMinutes: 60, pages: [PAGE_A], folders: ['inbox'] },
                { client, now: new Date('2026-10-27T09:00:00Z') },
            );

            assert.equal(summary.ok, true);
            assert.equal(summary.pages[0].messages_ingested, 2);

            const attachCall = calls.find((c) => c.args.p_key === `${PAGE_A}:m_attach`);
            assert.equal(attachCall?.args.p_content, '[Khách gửi tệp đính kèm; nội dung cần kiểm tra]');

            const emptyCall = calls.find((c) => c.args.p_key === `${PAGE_A}:m_empty`);
            assert.equal(emptyCall?.args.p_content, '[Tin nhắn không có văn bản]');
        },
    );
});

test('dry run mode tallies messages without calling database RPCs', async () => {
    const { client, calls } = fakeClient();

    await withFetch(
        (url) => {
            if (url.pathname.endsWith(`/${PAGE_A}/conversations`)) {
                return jsonResponse({
                    data: [
                        {
                            id: 't_dry',
                            updated_time: '2026-10-27T08:50:00+0000',
                            participants: {
                                data: [
                                    { id: CUSTOMER_A, name: 'Mai Hạnh' },
                                    { id: PAGE_A, name: 'Cửa chống ngập' },
                                ],
                            },
                        },
                    ],
                });
            }

            return jsonResponse({
                data: [
                    {
                        id: 'm_1',
                        from: { id: CUSTOMER_A, name: 'Mai Hạnh' },
                        message: 'Dry run inbound',
                        created_time: '2026-10-27T08:50:00+0000',
                    },
                    {
                        id: 'm_2',
                        from: { id: PAGE_A, name: 'Cửa chống ngập' },
                        message: 'Dry run outbound',
                        created_time: '2026-10-27T08:51:00+0000',
                    },
                ],
            });
        },
        async () => {
            const summary = await syncFacebookPages(
                { lookbackMinutes: 60, pages: [PAGE_A], dryRun: true },
                { client, now: new Date('2026-10-27T09:00:00Z') },
            );

            assert.equal(summary.ok, true);
            assert.equal(summary.dry_run, true);
            assert.equal(summary.pages[0].messages_ingested, 2);
            assert.equal(summary.pages[0].inbound_ingested, 1);
            assert.equal(summary.pages[0].outbound_ingested, 1);
            // ZERO database calls made in dry-run mode
            assert.equal(calls.length, 0);
        },
    );
});

test('redacts a phone number from the public message and stores it privately', async () => {
    const { client, calls } = fakeClient();

    await withFetch(
        (url) => {
            if (url.pathname.endsWith(`/${PAGE_A}/conversations`)) {
                return jsonResponse({
                    data: [
                        {
                            id: 't_phone',
                            updated_time: '2026-10-27T08:40:16+0000',
                            participants: {
                                data: [
                                    { id: CUSTOMER_A, name: 'Mai Hạnh' },
                                    { id: PAGE_A, name: 'Cửa chống ngập' },
                                ],
                            },
                        },
                    ],
                });
            }

            return jsonResponse({
                data: [
                    {
                        id: 'm_phone',
                        from: { id: CUSTOMER_A, name: 'Mai Hạnh' },
                        message: 'SĐT 0912345678',
                        created_time: '2026-10-27T08:40:16+0000',
                    },
                ],
            });
        },
        async () => {
            await syncFacebookPages(
                { lookbackMinutes: 60, pages: [PAGE_A], folders: ['inbox'] },
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
                { lookbackMinutes: 60, pages: [PAGE_A] },
                {
                    client,
                    now: new Date('2026-10-27T09:00:00Z'),
                    promoteDisplayName: async () => {},
                },
            );

            assert.equal(summary.ok, false);
            assert.deepEqual(summary.pages[0].errors, [
                'folder_failed:inbox:graph_status=401 code=190 subcode=463',
                'folder_failed:other:graph_status=401 code=190 subcode=463',
                'folder_failed:pending:graph_status=401 code=190 subcode=463',
            ]);
            assert.equal(calls.length, 0);
            assert.doesNotMatch(
                JSON.stringify(summary),
                /token-page-a|bad token/,
            );
        },
    );
});
