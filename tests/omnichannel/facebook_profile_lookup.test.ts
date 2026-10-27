import assert from 'node:assert/strict';
import test from 'node:test';

import { lookupFacebookDisplayName } from '../../features/omnichannel/facebook/profile';

const binding = {
    page: '1343097708890171',
    company: 'de6a7bf3-b5bc-418d-92d6-f9b241472598',
    tokenEnv: 'META_PAGE_BOTCAKE_TOKEN',
};

process.env.META_GRAPH_VERSION = 'v26.0';
process.env.META_PAGE_BOTCAKE_TOKEN = 'test-token';

type FetchHandler = (url: URL) => Response;

function withFetch(handler: FetchHandler, run: (urls: URL[]) => Promise<void>) {
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

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

test('uses the direct Graph profile when it is available', async () => {
    await withFetch(
        () => jsonResponse({ name: 'Nguyễn Văn A' }),
        async (urls) => {
            const name = await lookupFacebookDisplayName(binding, '11111111111111111');

            assert.equal(name, 'Nguyễn Văn A');
            assert.equal(urls.length, 1);
            assert.match(urls[0].pathname, /\/v26\.0\/11111111111111111$/);
        },
    );
});

test('falls back to the Page Conversations API when direct profile lookup is unsupported', async () => {
    await withFetch(
        (url) => {
            if (url.pathname.includes('/conversations')) {
                return jsonResponse({
                    data: [
                        {
                            participants: {
                                data: [
                                    { id: binding.page, name: 'Cửa chống ngập' },
                                    { id: '22222222222222222', name: 'Linh Hạ' },
                                ],
                            },
                        },
                    ],
                });
            }

            return jsonResponse(
                { error: { code: 100, error_subcode: 33 } },
                400,
            );
        },
        async (urls) => {
            const name = await lookupFacebookDisplayName(binding, '22222222222222222');

            assert.equal(name, 'Linh Hạ');
            assert.equal(urls.length, 2);
            assert.match(urls[1].pathname, /\/v26\.0\/1343097708890171\/conversations$/);
            assert.equal(urls[1].searchParams.get('user_id'), '22222222222222222');
        },
    );
});

test('returns null and logs no sensitive data when both lookup paths fail', async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
        warnings.push(String(message));
    };

    try {
        await withFetch(
            () =>
                jsonResponse(
                    { error: { code: 100, error_subcode: 33 } },
                    400,
                ),
            async () => {
                const name = await lookupFacebookDisplayName(
                    binding,
                    '33333333333333333',
                );

                assert.equal(name, null);
                assert.equal(warnings.length, 1);
                assert.match(warnings[0], /lookup_failed/);
                assert.match(warnings[0], /status=400 code=100 subcode=33/);
                assert.doesNotMatch(warnings[0], /test-token/);
            },
        );
    } finally {
        console.warn = originalWarn;
    }
});

test('rejects profile names that contain a phone number', async () => {
    await withFetch(
        () => jsonResponse({ name: 'Linh 0912345678' }),
        async () => {
            const name = await lookupFacebookDisplayName(
                binding,
                '44444444444444444',
            );

            assert.equal(name, null);
        },
    );
});
