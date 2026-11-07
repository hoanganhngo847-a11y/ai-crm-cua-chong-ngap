import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
    getMetaPageToken,
    pageTokenStorageKey,
    storeMetaPageToken,
} from '../../features/omnichannel/facebook/page-token-vault';
import { decryptToken, encryptToken } from '../../features/omnichannel/facebook/token-vault';

const COMPANY = 'de6a7bf3-b5bc-418d-92d6-f9b241472598';
const PAGE = '1418087751743574';
const originalKey = process.env.META_TOKEN_ENCRYPTION_KEY;
const originalFallback = process.env.META_PAGE_TEST_TOKEN;
process.env.META_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);

after(() => {
    if (originalKey === undefined) delete process.env.META_TOKEN_ENCRYPTION_KEY;
    else process.env.META_TOKEN_ENCRYPTION_KEY = originalKey;
    if (originalFallback === undefined) delete process.env.META_PAGE_TEST_TOKEN;
    else process.env.META_PAGE_TEST_TOKEN = originalFallback;
});

type RpcCall = { name: string; args: Record<string, unknown> };
type RpcResult = { data?: unknown; error?: { code?: string; message?: string } | null };

function fakeClient(
    handler: (name: string, args: Record<string, unknown>) => RpcResult,
): { client: SupabaseClient; calls: RpcCall[] } {
    const calls: RpcCall[] = [];
    const client = {
        rpc: async (name: string, args: Record<string, unknown>) => {
            calls.push({ name, args });
            return handler(name, args);
        },
    } as unknown as SupabaseClient;
    return { client, calls };
}

test('Page token storage keys are namespaced away from Meta Ad Account IDs', () => {
    assert.equal(pageTokenStorageKey(PAGE), '__page__:' + PAGE);
    assert.throws(() => pageTokenStorageKey('act_123'));
});

test('storeMetaPageToken encrypts the token before calling the service-role vault RPC', async () => {
    const { client, calls } = fakeClient(() => ({ data: null, error: null }));
    await storeMetaPageToken(COMPANY, PAGE, 'page-access-token-secret', null, client);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'store_meta_ad_account_token');
    assert.equal(calls[0].args.p_company_id, COMPANY);
    assert.equal(calls[0].args.p_ad_account_id, '__page__:' + PAGE);
    const encrypted = String(calls[0].args.p_encrypted_access_token);
    assert.notEqual(encrypted, 'page-access-token-secret');
    assert.equal(decryptToken(encrypted), 'page-access-token-secret');
});

test('getMetaPageToken decrypts a stored token and returns it only while unexpired', async () => {
    const encrypted = encryptToken('stored-page-token');
    const { client } = fakeClient(() => ({
        data: [{ encrypted_access_token: encrypted, token_expires_at: null }],
        error: null,
    }));

    assert.equal(await getMetaPageToken(COMPANY, PAGE, undefined, client), 'stored-page-token');
});

test('getMetaPageToken uses a legacy environment token only when no vault record exists', async () => {
    process.env.META_PAGE_TEST_TOKEN = 'legacy-page-token';
    const { client } = fakeClient(() => ({ data: [], error: null }));

    assert.equal(
        await getMetaPageToken(COMPANY, PAGE, 'META_PAGE_TEST_TOKEN', client),
        'legacy-page-token',
    );
});

test('expired vault records fail closed instead of falling back to an environment token', async () => {
    process.env.META_PAGE_TEST_TOKEN = 'legacy-page-token';
    const encrypted = encryptToken('expired-page-token');
    const { client } = fakeClient(() => ({
        data: [{ encrypted_access_token: encrypted, token_expires_at: '2000-01-01T00:00:00.000Z' }],
        error: null,
    }));

    await assert.rejects(
        getMetaPageToken(COMPANY, PAGE, 'META_PAGE_TEST_TOKEN', client),
    );
});

test('only a missing vault RPC may fall back to a legacy token when the vault migration is absent', async () => {
    process.env.META_PAGE_TEST_TOKEN = 'legacy-page-token';
    const { client } = fakeClient(() => ({
        data: null,
        error: { code: 'PGRST202', message: 'function not found' },
    }));

    assert.equal(
        await getMetaPageToken(COMPANY, PAGE, 'META_PAGE_TEST_TOKEN', client),
        'legacy-page-token',
    );
});

test('unexpected vault errors fail closed even if a legacy token is configured', async () => {
    process.env.META_PAGE_TEST_TOKEN = 'legacy-page-token';
    const { client } = fakeClient(() => ({
        data: null,
        error: { code: '42501', message: 'permission denied' },
    }));

    await assert.rejects(
        getMetaPageToken(COMPANY, PAGE, 'META_PAGE_TEST_TOKEN', client),
    );
});
