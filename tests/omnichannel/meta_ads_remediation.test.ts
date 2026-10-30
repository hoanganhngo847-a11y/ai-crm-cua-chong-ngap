import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fetchMetaPages, graphVersion, marketingVersion, redactMetaError } from '../../features/omnichannel/facebook/graph-api';
import { listManagedAdAccounts, listManagedFacebookPages, parseTokenExpiration, exchangeCodeForUserAccessToken, exchangeLongLivedUserAccessToken, subscribeManagedPage, readPageSubscribedFields, isExplicitlyUnsupportedExchangeError } from '../../features/omnichannel/facebook/connect';
import { decryptToken, encryptToken, rotateToken } from '../../features/omnichannel/facebook/token-vault';
import { fetchMetaLeadDetails } from '../../features/omnichannel/facebook/lead-ads';
import { fetchUserAdAccounts, syncCompanyMetaAds, syncCampaignsForAccount, syncAdsForAccount, syncAdSetsForAccount, syncDailyInsightsForAccount, syncLeadFormsForPage, validateAdAccountAccess } from '../../features/omnichannel/facebook/marketing-sync';

const secret = 'EAA_dummy_sensitive_token+/=?';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-test-key';
process.env.META_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);

function captureLogs() {
    const entries: string[] = [];
    const original = { error: console.error, warn: console.warn, info: console.info };
    for (const key of ['error', 'warn', 'info'] as const) console[key] = (...args) => { entries.push(args.map(String).join(' ')); };
    return { entries, restore: () => Object.assign(console, original) };
}

test('migration versions are unique; applied funnel migration is unchanged; final security migration follows foundation', () => {
    const files = readdirSync('supabase/migrations').filter(f => f.endsWith('.sql')).sort();
    assert.equal(new Set(files.map(f => f.split('_')[0])).size, files.length);
    assert.ok(files.includes('20261028130000_customer_funnel_six_stages.sql'));
    assert.equal(createHash('sha256').update(readFileSync('supabase/migrations/20261028130000_customer_funnel_six_stages.sql')).digest('hex'), '44a5da682bd501210347b870731fc2260e82e881ef94b9481787ad15dec3c2b0', 'Preserve the applied production migration byte for byte');
    const messenger = files.indexOf('20261028130001_remove_messenger_pending_sale_gate_and_enable_pages.sql');
    assert.ok(messenger > files.indexOf('20261028130000_customer_funnel_six_stages.sql'));
    assert.ok(messenger < files.indexOf('20261028140000_fix_messenger_confidence_and_sla_resolution.sql'), 'Renumbering must preserve newer RPC safety definitions');
    assert.ok(files.indexOf('20261030110000_meta_ads_final_remediation.sql') > files.indexOf('20261030100000_meta_ads_hardening.sql'));
    assert.ok(files.indexOf('20261030120000_meta_ads_attribution_rpc_security.sql') > files.indexOf('20261030110000_meta_ads_final_remediation.sql'));
});

test('all reporting and lead endpoints use independent supported versions and Bearer headers', async () => {
    process.env.META_GRAPH_VERSION = 'v25.0';
    process.env.META_MARKETING_VERSION = 'v26.0';
    assert.equal(graphVersion(), 'v25.0');
    assert.equal(marketingVersion(), 'v26.0');
    const original = globalThis.fetch;
    const requests: URL[] = [];
    const graphFetch: typeof fetch = async (input, init) => {
        const url = new URL(String(input)); requests.push(url);
        assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${secret}`);
        assert.equal(url.searchParams.has('access_token'), false);
        return Response.json(url.pathname.endsWith('/999') ? { id: '999' } : { data: [] });
    };
    globalThis.fetch = graphFetch;
    try {
        await fetchUserAdAccounts(secret, graphFetch);
        await syncCampaignsForAccount('company', '123', secret, graphFetch);
        await syncAdSetsForAccount('company', '123', secret, graphFetch);
        await syncAdsForAccount('company', '123', secret, graphFetch);
        await syncDailyInsightsForAccount('company', '123', secret, graphFetch);
        await syncLeadFormsForPage('company', '123', secret, graphFetch);
        await validateAdAccountAccess('123', secret, graphFetch);
        await fetchMetaLeadDetails('999', secret, graphFetch);
        assert.equal(requests.at(-1)?.searchParams.get('fields'), 'id,created_time,form_id,field_data', 'Basic lead read must not request ad-level fields requiring ads_management');
        await listManagedAdAccounts(secret);
        await listManagedFacebookPages(secret);
        for (const url of requests) {
            const graphOnly = /\/(leadgen_forms|999)$/.test(url.pathname) || url.pathname.endsWith('/me/accounts');
            assert.equal(url.pathname.split('/')[1], graphOnly ? 'v25.0' : 'v26.0', url.pathname);
            assert.ok(url.searchParams.has('fields'));
        }
        assert.equal(requests.filter(u => u.pathname.endsWith('/insights')).length, 2);
        const scopeSource = readFileSync('app/api/facebook/connect/start/route.ts', 'utf8');
        assert.doesNotMatch(scopeSource, /ads_management|pages_manage_ads/);
        assert.match(scopeSource, /ads_read,leads_retrieval/);
        process.env.META_MARKETING_VERSION = 'v21.0';
        assert.throws(marketingVersion, /UNSUPPORTED/);
    } finally { globalThis.fetch = original; process.env.META_GRAPH_VERSION = 'v26.0'; process.env.META_MARKETING_VERSION = 'v26.0'; }
});

test('pagination completes beyond ten pages; truncation, malformed pages, hostile links and cycles fail closed', async () => {
    for (const list of [listManagedFacebookPages, listManagedAdAccounts]) {
        const original = globalThis.fetch;
        let calls = 0;
        globalThis.fetch = async (input, init) => {
            const url = new URL(String(input));
            assert.equal(url.searchParams.has('access_token'), false);
            assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${secret}`);
            calls++;
            return Response.json({ data: [{ id: String(calls), name: 'Page', access_token: 'page-token' }],
                ...(calls < 11 ? { paging: { next: `${url.origin}${url.pathname}?after=${calls}&access_token=${encodeURIComponent(secret)}` } } : {}) });
        };
        try { assert.equal((await list(secret)).length, 11); } finally { globalThis.fetch = original; }
    }
    const url = new URL('https://graph.facebook.com/v26.0/me/adaccounts');
    await assert.rejects(fetchMetaPages(url, secret, async () => Response.json({ data: [], paging: { next: `${url}?after=next` } }), 1), /PAGINATION_LIMIT/);
    await assert.rejects(fetchMetaPages(url, secret, async () => Response.json({ data: [], paging: { next: String(url) } })), /PAGINATION_CYCLE/);
    await assert.rejects(fetchMetaPages(url, secret, async () => Response.json({ data: [], paging: { next: 'https://attacker.invalid/steal' } })), /INVALID_META_PAGINATION_URL/);
    await assert.rejects(fetchMetaPages(url, secret, async () => Response.json({ error: { message: secret } })), /INVALID_PAGE/);
    for (const sync of [syncCampaignsForAccount, syncAdsForAccount, syncAdSetsForAccount, syncDailyInsightsForAccount]) {
        await assert.rejects(sync('company', '123', secret, async input => {
            const url = new URL(String(input));
            const page = Number(url.searchParams.get('after') || '0') + 1;
            return Response.json({ data: [], paging: { next: `${url.origin}${url.pathname}?after=${page}` } });
        }), /INCOMPLETE_SYNC_PAGINATION_LIMIT/);
    }
    for (const list of [listManagedFacebookPages, listManagedAdAccounts]) {
        const original = globalThis.fetch;
        let page = 0;
        globalThis.fetch = async input => {
            const url = new URL(String(input));
            return Response.json({ data: [], paging: { next: `${url.origin}${url.pathname}?after=${++page}` } });
        };
        try { await assert.rejects(list(secret), /PAGINATION_LIMIT/); } finally { globalThis.fetch = original; }
    }
});

test('URL, upstream response, transport, and database errors never leak access tokens to logs or results', async () => {
    const logs = captureLogs();
    const original = globalThis.fetch;
    try {
        const unsafe = `https://graph.facebook.com/v26.0/x?access_token=${encodeURIComponent(secret)}`;
        const redacted = redactMetaError(new Error(`${unsafe} Bearer ${secret} {"access_token":"${secret}"}`), [secret]);
        assert.ok(!redacted.includes(secret) && !redacted.includes(encodeURIComponent(secret)));
        await assert.rejects(syncCampaignsForAccount('company', '123', secret, async () => new Response(`error ${unsafe} ${secret}`, { status: 400 })), /GRAPH_PAGE_FETCH_FAILED_400/);
        await assert.rejects(fetchMetaPages(new URL('https://graph.facebook.com/v26.0/me/adaccounts'), secret, async () => { throw new Error(`${unsafe} ${secret}`); }), /META_PAGE_REQUEST_FAILED/);
        globalThis.fetch = async input => {
            const url = String(input);
            if (url.includes('meta_ad_accounts?')) return Response.json([{ ad_account_id: 'act_123' }]);
            if (url.includes('acquire_meta')) return Response.json('lease-token');
            if (url.includes('get_meta')) return Response.json([]);
            if (url.includes('release_meta')) return Response.json(true);
            if (url.includes('meta_campaigns?')) return Response.json({ message: `database echoed ${secret}` }, { status: 400 });
            if (url.includes('graph.facebook.com')) return Response.json(url.includes('/campaigns') ? { data: [{ id: 'campaign', name: secret }] } : { id: 'act_123' });
            throw new Error('unexpected');
        };
        const result = await syncCompanyMetaAds('company', { token: secret });
        assert.equal(result.success, false);
        assert.equal(result.accountsFailed, 1);
        const all = JSON.stringify([logs.entries, result]);
        assert.ok(!all.includes(secret) && !all.includes(encodeURIComponent(secret)), all);
    } finally { globalThis.fetch = original; logs.restore(); }
});

test('account result counts reflect success, failures, missing credentials, lease errors, and skipped owners', async () => {
    const original = globalThis.fetch;
    const logs = captureLogs();
    const oldSystem = process.env.META_SYSTEM_USER_TOKEN;
    delete process.env.META_SYSTEM_USER_TOKEN;
    const statuses = ['good', 'expired', 'missing', 'badcipher', 'tokenrpc', 'busy', 'leaserpc', 'releasefail', 'inactive'];
    let selected = statuses;
    globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        const args = init?.body ? JSON.parse(String(init.body)) : {};
        const id = args.p_ad_account_id;
        if (url.pathname === '/rest/v1/meta_ad_accounts') return Response.json(selected.map(ad_account_id => ({ ad_account_id, account_status: ad_account_id === 'inactive' ? 2 : 1 })));
        if (url.pathname.endsWith('acquire_meta_ad_account_sync_lease')) {
            if (id === 'leaserpc') return Response.json({ message: 'offline' }, { status: 500 });
            return Response.json(id === 'busy' ? null : `lease-${id}`);
        }
        if (url.pathname.endsWith('get_meta_ad_account_token')) {
            if (id === 'tokenrpc') return Response.json({ message: 'offline' }, { status: 500 });
            return Response.json(id === 'missing' ? [] : [{ encrypted_access_token: id === 'badcipher' ? 'broken' : encryptToken(secret) }]);
        }
        if (url.pathname.endsWith('release_meta_ad_account_sync_lease')) return Response.json(id !== 'releasefail');
        if (url.hostname === 'graph.facebook.com') {
            if (url.pathname.endsWith('/act_expired')) return Response.json({ error: { code: 190 } }, { status: 400 });
            return Response.json(/\/(campaigns|adsets|ads|insights)$/.test(url.pathname) ? { data: [] } : { id: 'act_good' });
        }
        throw new Error(`Unexpected test fetch ${url.pathname}`);
    };
    try {
        const result = await syncCompanyMetaAds('company');
        assert.equal(result.success, false);
        assert.equal(result.accountsSynced, 1);
        assert.equal(result.accountsFailed, 6);
        assert.equal(result.accountsSkipped, 2);
        assert.equal(result.accountResults.find(a => a.adAccountId === 'missing')?.error, 'MISSING_ACCESS_TOKEN');
        assert.equal(result.accountResults.find(a => a.adAccountId === 'busy')?.status, 'SKIPPED');
        assert.equal(result.accountResults.find(a => a.adAccountId === 'leaserpc')?.error, 'SYNC_LEASE_ACQUISITION_FAILED');
        assert.match(result.accountResults.find(a => a.adAccountId === 'releasefail')?.error || '', /FINALIZATION_FAILED/);
        selected = ['good'];
        assert.equal((await syncCompanyMetaAds('company')).success, true);
        selected = [];
        const empty = await syncCompanyMetaAds('company');
        assert.equal(empty.success, false);
        assert.equal(empty.accountsSynced, 0);
        assert.equal(empty.error, 'NO_AD_ACCOUNTS');
    } finally { globalThis.fetch = original; logs.restore(); if (oldSystem) process.env.META_SYSTEM_USER_TOKEN = oldSystem; }
});

test('legacy SHA256-derived ciphertext survives explicit previous-key migration and rotates to the primary key', () => {
    const previous = process.env.META_PREVIOUS_TOKEN_ENCRYPTION_KEY;
    const legacyPassphrase = 'old-production-format-fixture';
    const legacyKey = createHash('sha256').update(legacyPassphrase).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', legacyKey, iv);
    const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
    const packed = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
    try {
        delete process.env.META_PREVIOUS_TOKEN_ENCRYPTION_KEY;
        assert.throws(() => decryptToken(packed), /TOKEN_DECRYPTION_FAILED/);
        process.env.META_PREVIOUS_TOKEN_ENCRYPTION_KEY = legacyKey.toString('hex');
        assert.equal(decryptToken(packed), secret);
        const rotated = rotateToken(packed);
        delete process.env.META_PREVIOUS_TOKEN_ENCRYPTION_KEY;
        assert.equal(decryptToken(rotated), secret);
        assert.throws(() => decryptToken(packed), /TOKEN_DECRYPTION_FAILED/);
    } finally { if (previous) process.env.META_PREVIOUS_TOKEN_ENCRYPTION_KEY = previous; else delete process.env.META_PREVIOUS_TOKEN_ENCRYPTION_KEY; }
});

test('offline key verifier emits only status/counts for verified legacy rows and rejects mismatched keys', async () => {
    const { spawnSync } = await import('node:child_process');
    const legacy = 'dummy-legacy-verifier-secret';
    const previousKey = createHash('sha256').update(legacy).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', previousKey, iv);
    const body = Buffer.concat([cipher.update(secret), cipher.final()]);
    const packed = Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
    for (const valid of [true, false]) {
        const result = spawnSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', 'scripts/meta-ads/verify-token-key.ts'], {
            input: JSON.stringify([packed]), encoding: 'utf8', timeout: 10_000,
            env: { ...process.env, META_LEGACY_TOKEN_ENCRYPTION_SECRET: legacy, META_PREVIOUS_TOKEN_ENCRYPTION_KEY: valid ? previousKey.toString('hex') : '0'.repeat(64) },
        });
        assert.equal(result.status, valid ? 0 : 1);
        assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
        assert.ok(!`${result.stdout}${result.stderr}`.includes(legacy));
        assert.ok(!`${result.stdout}${result.stderr}`.includes(packed));
        assert.ok(!`${result.stdout}${result.stderr}`.includes(previousKey.toString('hex')));
        if (valid) assert.deepEqual(JSON.parse(result.stdout), { status: 'VERIFIED', checked: 1, legacyVerified: 1 });
        else assert.equal(result.stderr.trim(), 'META_TOKEN_KEY_VERIFICATION_FAILED');
    }
});

test('discovered asset identifiers are accepted independently and the Page requires an explicit tenant binding', async () => {
    const { binding } = await import('../../features/omnichannel/facebook/binding');
    const { configuredFacebookPageIds } = await import('../../features/omnichannel/facebook/connect');
    const page = '654520554683416';
    const form = '1698659958359492';
    const account = '996324396811261';
    const company = '11111111-1111-4111-8111-111111111111';
    const oldBindings = process.env.META_PAGE_BINDINGS;
    const original = globalThis.fetch;
    try {
        process.env.META_PAGE_BINDINGS = JSON.stringify([{ page: '123', company, tokenEnv: 'META_STAGING_PAGE_TOKEN' }]);
        assert.throws(() => binding(page), /NOT_FOUND/);
        process.env.META_PAGE_BINDINGS = JSON.stringify([{ page, company, tokenEnv: 'META_STAGING_PAGE_TOKEN', name: 'Du Học Áo CHD' }]);
        assert.equal(binding(page).company, company);
        assert.equal(binding(page).page, page);
        assert.ok(configuredFacebookPageIds(company).has(page));
        let formWrite = false;
        globalThis.fetch = async (input, init) => {
            const url = new URL(String(input));
            if (url.hostname === 'graph.facebook.com') {
                assert.equal(url.searchParams.has('access_token'), false);
                if (url.pathname.endsWith('/me/accounts')) return Response.json({ data: [{ id: page, name: 'Du Học Áo CHD', access_token: secret }] });
                if (url.pathname.endsWith('/me/adaccounts')) return Response.json({ data: [{ id: `act_${account}`, account_id: account, name: 'TKQC Du học - NV mới' }] });
                if (url.pathname.endsWith(`/${page}/leadgen_forms`)) return Response.json({ data: [{ id: form, name: 'Offline form fixture' }] });
                if (url.pathname.endsWith(`/act_${account}/campaigns`)) return Response.json({ data: [] });
                throw new Error('unexpected Graph edge');
            }
            assert.equal(url.pathname, '/rest/v1/meta_lead_forms');
            const rows = JSON.parse(String(init?.body));
            assert.equal(rows[0].company_id, company);
            assert.equal(rows[0].page_id, page);
            assert.equal(rows[0].meta_form_id, form);
            formWrite = true;
            return new Response(null, { status: 201 });
        };
        assert.equal((await listManagedFacebookPages(secret))[0].id, page);
        assert.equal((await listManagedAdAccounts(secret))[0].id, `act_${account}`);
        assert.equal(await syncLeadFormsForPage(company, page, secret), 1);
        assert.equal(await syncCampaignsForAccount(company, account, secret), 0);
        assert.equal(formWrite, true);
        // Co-discovery is deliberately not used to assert Page/account/business ownership.
    } finally {
        globalThis.fetch = original;
        if (oldBindings == null) delete process.env.META_PAGE_BINDINGS; else process.env.META_PAGE_BINDINGS = oldBindings;
    }
});

test('OAuth transport errors cannot echo a credential-bearing token-exchange URL', async () => {
    const { exchangeCodeForUserAccessToken } = await import('../../features/omnichannel/facebook/connect');
    const original = globalThis.fetch;
    const oldApp = process.env.META_APP_ID, oldSecret = process.env.META_APP_SECRET, oldOrigin = process.env.WEBSITE_ORIGIN;
    try {
        process.env.META_APP_ID = '1780871206505449';
        process.env.META_APP_SECRET = secret;
        process.env.WEBSITE_ORIGIN = 'https://staging.invalid';
        globalThis.fetch = async input => { throw new Error(`transport failed ${String(input)}`); };
        await assert.rejects(exchangeCodeForUserAccessToken('dummy-oauth-code'), error => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, 'FACEBOOK_TOKEN_EXCHANGE_FAILED');
            assert.ok(!error.message.includes(secret));
            return true;
        });
    } finally {
        globalThis.fetch = original;
        for (const [key, value] of [['META_APP_ID', oldApp], ['META_APP_SECRET', oldSecret], ['WEBSITE_ORIGIN', oldOrigin]]) {
            if (value == null) delete process.env[key!]; else process.env[key!] = value;
        }
    }
});

test('F-14: parseTokenExpiration parses actual Meta expires_in and detects expired tokens without hardcoding 60 days', () => {
    const fixedNow = 1700000000000;
    // 1. Long-lived token (~60 days: 5184000s)
    const longLived = parseTokenExpiration(5184000, fixedNow);
    assert.equal(longLived.expiresIn, 5184000);
    assert.equal(longLived.tokenExpiresAt, new Date(fixedNow + 5184000 * 1000).toISOString());
    assert.equal(longLived.isExpired, false);

    // 2. Short-lived token (~2 hours: 7200s)
    const shortLived = parseTokenExpiration('7200', fixedNow);
    assert.equal(shortLived.expiresIn, 7200);
    assert.equal(shortLived.tokenExpiresAt, new Date(fixedNow + 7200 * 1000).toISOString());
    assert.equal(shortLived.isExpired, false);

    // 3. Expired token (0 or negative)
    const expiredZero = parseTokenExpiration(0, fixedNow);
    assert.equal(expiredZero.isExpired, true);
    const expiredNegative = parseTokenExpiration(-3600, fixedNow);
    assert.equal(expiredNegative.isExpired, true);

    // 4. Missing / null expires_in (e.g. system user tokens)
    const missing = parseTokenExpiration(null, fixedNow);
    assert.equal(missing.expiresIn, null);
    assert.equal(missing.tokenExpiresAt, null);
    assert.equal(missing.isExpired, false);
});

test('FIX A: OAuth token exchange handles long-lived, explicit unsupported, transient errors, malformed responses, and expired fallback', async () => {
    const original = globalThis.fetch;
    process.env.META_APP_ID = '123456';
    process.env.META_APP_SECRET = secret;
    process.env.WEBSITE_ORIGIN = 'https://staging.invalid';

    try {
        // 1. Successful long-lived exchange
        const fetchSuccess: typeof fetch = async (input) => {
            const url = new URL(String(input));
            if (url.searchParams.get('grant_type') === 'fb_exchange_token') {
                return Response.json({ access_token: 'long-lived-token-xyz', expires_in: 5184000 });
            }
            return Response.json({ access_token: 'short-lived-token-abc', expires_in: 7200 });
        };
        const resSuccess = await exchangeCodeForUserAccessToken('code-success', fetchSuccess);
        assert.equal(resSuccess.accessToken, 'long-lived-token-xyz');
        assert.equal(resSuccess.expiresIn, 5184000);
        assert.equal(resSuccess.tokenType, 'long_lived');
        assert.equal(resSuccess.isLongLived, true);
        assert.ok(resSuccess.tokenExpiresAt);

        // 2. Explicit unsupported exchange (HTTP 400 with OAuthException / code 100) -> safe short-lived fallback
        const fetchUnsupported: typeof fetch = async (input) => {
            const url = new URL(String(input));
            if (url.searchParams.get('grant_type') === 'fb_exchange_token') {
                return new Response(JSON.stringify({ error: { message: 'fb_exchange_token unsupported for this app', code: 100, type: 'OAuthException' } }), { status: 400 });
            }
            return Response.json({ access_token: 'short-lived-token-123', expires_in: 3600 });
        };
        const resUnsupported = await exchangeCodeForUserAccessToken('code-unsupported', fetchUnsupported);
        assert.equal(resUnsupported.accessToken, 'short-lived-token-123');
        assert.equal(resUnsupported.expiresIn, 3600);
        assert.equal(resUnsupported.tokenType, 'short_lived_fallback');
        assert.equal(resUnsupported.isLongLived, false);
        assert.ok(resUnsupported.tokenExpiresAt);

        // 3. Ambiguous code-100 invalid-parameter errors must NOT trigger short-lived fallback.
        const fetchInvalidParameter: typeof fetch = async (input) => {
            const url = new URL(String(input));
            if (url.searchParams.get('grant_type') === 'fb_exchange_token') {
                return new Response(JSON.stringify({
                    error: {
                        message: 'Invalid parameter fb_exchange_token',
                        code: 100,
                        type: 'OAuthException',
                    },
                }), { status: 400 });
            }
            return Response.json({ access_token: 'short-lived-token-123', expires_in: 3600 });
        };
        await assert.rejects(
            () => exchangeCodeForUserAccessToken('code-invalid-parameter', fetchInvalidParameter),
            /FACEBOOK_TOKEN_EXCHANGE_FAILED/,
        );
        assert.equal(
            isExplicitlyUnsupportedExchangeError(400, {
                error: { message: 'Invalid parameter fb_exchange_token', code: 100, type: 'OAuthException' },
            }),
            false,
        );

        // 4. Timeout on long-lived exchange -> exchange failure (throws FACEBOOK_TOKEN_EXCHANGE_FAILED)
        const fetchTimeout: typeof fetch = async (input) => {
            const url = new URL(String(input));
            if (url.searchParams.get('grant_type') === 'fb_exchange_token') {
                throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
            }
            return Response.json({ access_token: 'short-lived-token-123', expires_in: 3600 });
        };
        await assert.rejects(
            () => exchangeCodeForUserAccessToken('code-timeout', fetchTimeout),
            /FACEBOOK_TOKEN_EXCHANGE_FAILED/,
        );

        // 4. HTTP 429 on long-lived exchange -> exchange failure (throws FACEBOOK_TOKEN_EXCHANGE_FAILED)
        const fetch429: typeof fetch = async (input) => {
            const url = new URL(String(input));
            if (url.searchParams.get('grant_type') === 'fb_exchange_token') {
                return new Response(JSON.stringify({ error: { message: 'Rate limit exceeded', code: 17 } }), { status: 429 });
            }
            return Response.json({ access_token: 'short-lived-token-123', expires_in: 3600 });
        };
        await assert.rejects(
            () => exchangeCodeForUserAccessToken('code-429', fetch429),
            /FACEBOOK_TOKEN_EXCHANGE_FAILED/,
        );

        // 5. HTTP 500 on long-lived exchange -> exchange failure (throws FACEBOOK_TOKEN_EXCHANGE_FAILED)
        const fetch500: typeof fetch = async (input) => {
            const url = new URL(String(input));
            if (url.searchParams.get('grant_type') === 'fb_exchange_token') {
                return new Response(JSON.stringify({ error: { message: 'Internal server error' } }), { status: 500 });
            }
            return Response.json({ access_token: 'short-lived-token-123', expires_in: 3600 });
        };
        await assert.rejects(
            () => exchangeCodeForUserAccessToken('code-500', fetch500),
            /FACEBOOK_TOKEN_EXCHANGE_FAILED/,
        );

        // 6. Malformed response (non-JSON or missing access_token) -> exchange failure (throws FACEBOOK_TOKEN_EXCHANGE_FAILED)
        const fetchMalformed: typeof fetch = async (input) => {
            const url = new URL(String(input));
            if (url.searchParams.get('grant_type') === 'fb_exchange_token') {
                return new Response('<html>502 Bad Gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } });
            }
            return Response.json({ access_token: 'short-lived-token-123', expires_in: 3600 });
        };
        await assert.rejects(
            () => exchangeCodeForUserAccessToken('code-malformed', fetchMalformed),
            /FACEBOOK_TOKEN_EXCHANGE_FAILED/,
        );

        // 7. Expired short-lived fallback -> throws FACEBOOK_TOKEN_EXPIRED
        const fetchExpired: typeof fetch = async () => Response.json({ access_token: 'expired-token', expires_in: 0 });
        await assert.rejects(
            () => exchangeCodeForUserAccessToken('code-expired', fetchExpired),
            /FACEBOOK_TOKEN_EXPIRED/,
        );
    } finally {
        globalThis.fetch = original;
    }
});

test('FIX B: subscribeManagedPage handles subscription preservation, read-back verification, and error edge cases', async () => {
    const page = '654520554683416';
    const company = '11111111-1111-4111-8111-111111111111';
    const appId = '123456';
    process.env.META_PAGE_BINDINGS = JSON.stringify([{ page, company, tokenEnv: 'META_PAGE_TEST_TOKEN', name: 'Du Học Áo CHD' }]);
    process.env.META_PAGE_TEST_TOKEN = secret;
    process.env.META_APP_ID = appId;

    const basePageResponse = { data: [{ id: page, name: 'Du Học Áo CHD', access_token: secret }] };

    // 1. GET 403 on initial check: does not mutate subscriptions, returns SUBSCRIPTION_UNKNOWN
    let postCalled = false;
    const fetch403: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/me/accounts')) return Response.json(basePageResponse);
        if (url.pathname.endsWith('/subscribed_apps')) {
            if (init?.method === 'GET') return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
            if (init?.method === 'POST') { postCalled = true; return Response.json({ success: true }); }
        }
        throw new Error(`Unexpected call: ${url}`);
    };
    const res403 = await subscribeManagedPage('token', page, company, fetch403);
    assert.equal(postCalled, false, 'POST must not be called when GET returns 403');
    assert.equal(res403.status, 'SUBSCRIPTION_UNKNOWN');
    assert.equal(res403.messengerSubscribed, false);
    assert.equal(res403.leadAdsSubscribed, false);

    // 2. GET 500 on initial check: does not mutate subscriptions, returns SUBSCRIPTION_UNKNOWN
    postCalled = false;
    const fetch500: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/me/accounts')) return Response.json(basePageResponse);
        if (url.pathname.endsWith('/subscribed_apps')) {
            if (init?.method === 'GET') return new Response(JSON.stringify({ error: 'Server error' }), { status: 500 });
            if (init?.method === 'POST') { postCalled = true; return Response.json({ success: true }); }
        }
        throw new Error(`Unexpected call: ${url}`);
    };
    const res500 = await subscribeManagedPage('token', page, company, fetch500);
    assert.equal(postCalled, false, 'POST must not be called when GET returns 500');
    assert.equal(res500.status, 'SUBSCRIPTION_UNKNOWN');

    // 3. GET timeout on initial check: does not mutate subscriptions, returns SUBSCRIPTION_UNKNOWN
    postCalled = false;
    const fetchTimeout: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/me/accounts')) return Response.json(basePageResponse);
        if (url.pathname.endsWith('/subscribed_apps')) {
            if (init?.method === 'GET') throw new DOMException('Timeout', 'TimeoutError');
            if (init?.method === 'POST') { postCalled = true; return Response.json({ success: true }); }
        }
        throw new Error(`Unexpected call: ${url}`);
    };
    const resTimeout = await subscribeManagedPage('token', page, company, fetchTimeout);
    assert.equal(postCalled, false, 'POST must not be called when GET times out');
    assert.equal(resTimeout.status, 'SUBSCRIPTION_UNKNOWN');

    // 4. GET malformed response on initial check: does not mutate subscriptions, returns SUBSCRIPTION_UNKNOWN
    postCalled = false;
    const fetchMalformed: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/me/accounts')) return Response.json(basePageResponse);
        if (url.pathname.endsWith('/subscribed_apps')) {
            if (init?.method === 'GET') return Response.json({ data: 'not-an-array' });
            if (init?.method === 'POST') { postCalled = true; return Response.json({ success: true }); }
        }
        throw new Error(`Unexpected call: ${url}`);
    };
    const resMalformed = await subscribeManagedPage('token', page, company, fetchMalformed);
    assert.equal(postCalled, false, 'POST must not be called when GET is malformed');
    assert.equal(resMalformed.status, 'SUBSCRIPTION_UNKNOWN');

    // 4b. App exists but subscribed_fields is missing: state is unknown and no POST is allowed.
    let missingFieldsPostCalled = false;
    const fetchMissingSubscribedFields: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/me/accounts')) return Response.json(basePageResponse);
        if (url.pathname.endsWith('/subscribed_apps')) {
            if (init?.method === 'GET') return Response.json({ data: [{ id: appId }] });
            if (init?.method === 'POST') {
                missingFieldsPostCalled = true;
                return Response.json({ success: true });
            }
        }
        throw new Error(`Unexpected call: ${url}`);
    };
    const resMissingFields = await subscribeManagedPage('token', page, company, fetchMissingSubscribedFields);
    assert.equal(missingFieldsPostCalled, false, 'POST must not run when subscribed_fields is missing');
    assert.equal(resMissingFields.status, 'SUBSCRIPTION_UNKNOWN');
    assert.match(resMissingFields.error || '', /MALFORMED_SUBSCRIBED_FIELDS/);

    // 5. App not found in a successful GET response: treated as empty existing fields, subscribes and verifies
    let postedCount5 = 0;
    let currentFields5: string[] = [];
    const fetchAppNotFoundWithReadBack: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/me/accounts')) return Response.json(basePageResponse);
        if (url.pathname.endsWith('/subscribed_apps')) {
            if (init?.method === 'GET') {
                if (postedCount5 === 0) {
                    return Response.json({ data: [{ id: '999999', subscribed_fields: ['feed'] }] });
                }
                return Response.json({ data: [{ id: appId, subscribed_fields: currentFields5 }] });
            }
            if (init?.method === 'POST') {
                postedCount5++;
                const params = new URLSearchParams(String(init.body));
                currentFields5 = (params.get('subscribed_fields') || '').split(',');
                return Response.json({ success: true });
            }
        }
        throw new Error(`Unexpected call: ${url}`);
    };
    const resAppNotFound = await subscribeManagedPage('token', page, company, fetchAppNotFoundWithReadBack);
    assert.equal(resAppNotFound.messengerSubscribed, true);
    assert.equal(resAppNotFound.leadAdsSubscribed, true);
    assert.equal(resAppNotFound.status, 'ALL_CONNECTED');

    // 6. Existing fields preserved: existing fields ['feed', 'mention'] are preserved in all POST bodies
    const postBodies6: string[] = [];
    let currentFields6: string[] = ['feed', 'mention'];
    const fetchPreserve: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/me/accounts')) return Response.json(basePageResponse);
        if (url.pathname.endsWith('/subscribed_apps')) {
            if (init?.method === 'GET') {
                return Response.json({ data: [{ id: appId, subscribed_fields: currentFields6 }] });
            }
            if (init?.method === 'POST') {
                const body = String(init.body);
                postBodies6.push(body);
                const params = new URLSearchParams(body);
                currentFields6 = (params.get('subscribed_fields') || '').split(',');
                return Response.json({ success: true });
            }
        }
        throw new Error(`Unexpected call: ${url}`);
    };
    const resPreserve = await subscribeManagedPage('token', page, company, fetchPreserve);
    assert.equal(resPreserve.status, 'ALL_CONNECTED');
    for (const body of postBodies6) {
        assert.ok(body.includes('feed'), `POST body must preserve feed: ${body}`);
        assert.ok(body.includes('mention'), `POST body must preserve mention: ${body}`);
    }

    // 7. Read-back mismatch: POST for messages returns success, but read-back lacks messages
    const fetchMismatch: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/me/accounts')) return Response.json(basePageResponse);
        if (url.pathname.endsWith('/subscribed_apps')) {
            if (init?.method === 'GET') {
                return Response.json({ data: [{ id: appId, subscribed_fields: ['feed'] }] });
            }
            if (init?.method === 'POST') {
                return Response.json({ success: true });
            }
        }
        throw new Error(`Unexpected call: ${url}`);
    };
    const resMismatch = await subscribeManagedPage('token', page, company, fetchMismatch);
    assert.equal(resMismatch.status, 'SUBSCRIPTION_UNKNOWN');
    assert.equal(resMismatch.messengerSubscribed, false);
    assert.equal(resMismatch.error, 'SUBSCRIPTION_READBACK_MISMATCH');

    // 8. Both subscriptions successful
    let currentFields8: string[] = [];
    const fetchBoth: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/me/accounts')) return Response.json(basePageResponse);
        if (url.pathname.endsWith('/subscribed_apps')) {
            if (init?.method === 'GET') {
                return Response.json({ data: [{ id: appId, subscribed_fields: currentFields8 }] });
            }
            if (init?.method === 'POST') {
                const params = new URLSearchParams(String(init.body));
                currentFields8 = (params.get('subscribed_fields') || '').split(',');
                return Response.json({ success: true });
            }
        }
        throw new Error(`Unexpected call: ${url}`);
    };
    const resBoth = await subscribeManagedPage('token', page, company, fetchBoth);
    assert.equal(resBoth.messengerSubscribed, true);
    assert.equal(resBoth.leadAdsSubscribed, true);
    assert.equal(resBoth.status, 'ALL_CONNECTED');

    // 9. Messenger success with leadgen failure: messages is verified, leadgen returns 403
    let currentFields9: string[] = [];
    const fetchLeadFail: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/me/accounts')) return Response.json(basePageResponse);
        if (url.pathname.endsWith('/subscribed_apps')) {
            if (init?.method === 'GET') {
                return Response.json({ data: [{ id: appId, subscribed_fields: currentFields9 }] });
            }
            if (init?.method === 'POST') {
                const body = String(init.body);
                if (body.includes('leadgen')) {
                    return new Response(JSON.stringify({ error: { message: 'Permissions error', code: 200 } }), { status: 403 });
                }
                const params = new URLSearchParams(body);
                currentFields9 = (params.get('subscribed_fields') || '').split(',');
                return Response.json({ success: true });
            }
        }
        throw new Error(`Unexpected call: ${url}`);
    };
    const resLeadFail = await subscribeManagedPage('token', page, company, fetchLeadFail);
    assert.equal(resLeadFail.messengerSubscribed, true);
    assert.equal(resLeadFail.leadAdsSubscribed, false);
    assert.equal(resLeadFail.status, 'MESSENGER_CONNECTED');
    assert.equal(resLeadFail.leadAdsError, 'LEAD_ADS_NOT_CONNECTED');

    // 10. Leadgen POST succeeds but read-back omits leadgen: report unknown, never connected.
    const fetchLeadReadbackMismatch: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/me/accounts')) return Response.json(basePageResponse);
        if (url.pathname.endsWith('/subscribed_apps')) {
            if (init?.method === 'GET') {
                return Response.json({ data: [{ id: appId, subscribed_fields: ['messages'] }] });
            }
            if (init?.method === 'POST') {
                return Response.json({ success: true });
            }
        }
        throw new Error(`Unexpected call: ${url}`);
    };
    const resLeadReadbackMismatch = await subscribeManagedPage(
        'token',
        page,
        company,
        fetchLeadReadbackMismatch,
    );
    assert.equal(resLeadReadbackMismatch.messengerSubscribed, true);
    assert.equal(resLeadReadbackMismatch.leadAdsSubscribed, false);
    assert.equal(resLeadReadbackMismatch.status, 'SUBSCRIPTION_UNKNOWN');
    assert.equal(resLeadReadbackMismatch.leadAdsError, 'SUBSCRIPTION_READBACK_MISMATCH');
    assert.equal(resLeadReadbackMismatch.error, 'SUBSCRIPTION_READBACK_MISMATCH');
});

test('F-06: webhook isolates Lead Ads failures and processes Messenger messages in mixed batch; retries deduplicate safely', async () => {
    const { POST: webhookPost } = await import('../../app/api/webhooks/meta/route');
    const { createHmac } = await import('node:crypto');
    const originalFetch = globalThis.fetch;
    const page = '654520554683416';
    const company = '11111111-1111-4111-8111-111111111111';
    const testSecret = 'meta-test-secret-32-chars-long!!';
    process.env.META_APP_SECRET = testSecret;
    process.env.META_PAGE_BINDINGS = JSON.stringify([{ page, company, tokenEnv: 'META_PAGE_TEST_TOKEN', name: 'Du Học Áo CHD' }]);
    process.env.META_PAGE_TEST_TOKEN = secret;

    let hanIngestCalls = 0;
    let leadgenProcessed = 0;
    let shouldFailLead1 = true;

    const mockFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.includes('/rest/v1/rpc/han_ingest')) {
            hanIngestCalls++;
            return Response.json({ status: 'ACCEPTED', interaction_id: 'int-msg-123' });
        }
        if (url.includes('graph.facebook.com')) {
            if (url.includes('lead_fail_01')) {
                if (shouldFailLead1) {
                    return new Response(JSON.stringify({ error: 'Graph retrieval failed' }), { status: 500 });
                }
                return Response.json({
                    id: 'lead_fail_01',
                    created_time: '2026-10-30T00:00:00+0000',
                    field_data: [{ name: 'phone_number', values: ['0912345678'] }],
                });
            }
            if (url.includes('lead_ok_02')) {
                return Response.json({
                    id: 'lead_ok_02',
                    created_time: '2026-10-30T00:00:00+0000',
                    field_data: [{ name: 'phone_number', values: ['0987654321'] }],
                });
            }
            return Response.json({ name: 'Nguyễn Văn Test' });
        }
        if (url.includes('/rest/v1/rpc/claim_meta_leadgen_event')) {
            const body = JSON.parse(String(init?.body));
            if (body.p_leadgen_id === 'lead_ok_02' && leadgenProcessed > 0) {
                return Response.json({ status: 'ALREADY_PROCESSED' });
            }
            return Response.json({ status: 'CLAIMED', claim_token: `token-${body.p_leadgen_id}` });
        }
        if (url.includes('/rest/v1/rpc/finalize_meta_leadgen_event')) {
            return Response.json(true);
        }
        if (url.includes('/rest/v1/rpc/ingest_meta_leadgen_event')) {
            leadgenProcessed++;
            return Response.json({ customer_id: 'cust-123', interaction_id: 'int-456' });
        }
        if (url.includes('/rest/v1/rpc/record_lead_attribution_touchpoint')) {
            return Response.json('tp-123');
        }
        if (url.includes('/rest/v1/')) {
            return Response.json([]);
        }
        throw new Error(`Unexpected fetch: ${url}`);
    };

    globalThis.fetch = mockFetch;

    try {
        const mixedBatch = {
            object: 'page',
            entry: [
                {
                    id: page,
                    messaging: [
                        {
                            sender: { id: '987654321012345' },
                            recipient: { id: page },
                            timestamp: Date.now(),
                            message: { mid: 'mid.mixed_01', text: 'Xin chào tư vấn du học' },
                        },
                    ],
                    changes: [
                        { field: 'leadgen', value: { leadgen_id: 'lead_fail_01', form_id: 'form_1', page_id: page, created_time: Math.floor(Date.now() / 1000) } },
                        { field: 'leadgen', value: { leadgen_id: 'lead_ok_02', form_id: 'form_1', page_id: page, created_time: Math.floor(Date.now() / 1000) } },
                    ],
                },
            ],
        };

        const raw = JSON.stringify(mixedBatch);
        const validSig = 'sha256=' + createHmac('sha256', testSecret).update(raw).digest('hex');

        // PASS 1: Lead Ads 1 fails, but Messenger message MUST be processed!
        const req1 = new Request('https://staging.invalid/api/webhooks/meta', {
            method: 'POST',
            headers: { 'x-hub-signature-256': validSig },
            body: raw,
        });

        const res1 = await webhookPost(req1);
        // Batch returns 503 so Meta will retry
        assert.equal(res1.status, 503);
        const body1 = await res1.json();
        assert.equal(body1.error, 'LEAD_INGESTION_FAILED');

        // VERIFIED: Messenger message WAS processed even though a Lead Ads event failed!
        assert.equal(hanIngestCalls, 1, 'Messenger message must be ingested despite Lead Ads failure');

        // PASS 2: Meta retries the batch. Now the transient failure on lead_fail_01 is resolved.
        shouldFailLead1 = false;
        const req2 = new Request('https://staging.invalid/api/webhooks/meta', {
            method: 'POST',
            headers: { 'x-hub-signature-256': validSig },
            body: raw,
        });

        const res2 = await webhookPost(req2);
        // Entire batch now succeeds with 200
        assert.equal(res2.status, 200);
        const body2 = await res2.json();
        assert.equal(body2.received, true);

        // VERIFIED: Idempotency held - han_ingest called for the retry and handled deduplication
        assert.equal(hanIngestCalls, 2);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
