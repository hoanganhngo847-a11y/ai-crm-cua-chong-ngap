import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fetchMetaPages, graphVersion, marketingVersion, redactMetaError } from '../../features/omnichannel/facebook/graph-api';
import { listManagedAdAccounts, listManagedFacebookPages, parseTokenExpiration, exchangeCodeForUserAccessToken, exchangeLongLivedUserAccessToken, subscribeManagedPage } from '../../features/omnichannel/facebook/connect';
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

test('F-14: exchangeCodeForUserAccessToken performs long-lived exchange when supported and falls back gracefully', async () => {
    const original = globalThis.fetch;
    process.env.META_APP_ID = '123456';
    process.env.META_APP_SECRET = secret;
    process.env.WEBSITE_ORIGIN = 'https://staging.invalid';

    try {
        // Case A: long-lived exchange succeeds
        const fetchA: typeof fetch = async (input) => {
            const url = new URL(String(input));
            if (url.searchParams.get('grant_type') === 'fb_exchange_token') {
                return Response.json({ access_token: 'long-lived-token-xyz', expires_in: 5184000 });
            }
            return Response.json({ access_token: 'short-lived-token-abc', expires_in: 7200 });
        };
        const resA = await exchangeCodeForUserAccessToken('code-a', fetchA);
        assert.equal(resA.accessToken, 'long-lived-token-xyz');
        assert.equal(resA.expiresIn, 5184000);
        assert.ok(resA.tokenExpiresAt);

        // Case B: fb_exchange_token unsupported (returns 400 OAuth error) -> fallback to short-lived token
        const fetchB: typeof fetch = async (input) => {
            const url = new URL(String(input));
            if (url.searchParams.get('grant_type') === 'fb_exchange_token') {
                return new Response(JSON.stringify({ error: { message: 'fb_exchange_token unsupported', code: 100 } }), { status: 400 });
            }
            return Response.json({ access_token: 'short-lived-token-123', expires_in: 3600 });
        };
        const resB = await exchangeCodeForUserAccessToken('code-b', fetchB);
        assert.equal(resB.accessToken, 'short-lived-token-123');
        assert.equal(resB.expiresIn, 3600);
        assert.ok(resB.tokenExpiresAt);

        // Case C: code exchange returns expired token -> throws FACEBOOK_TOKEN_EXPIRED
        const fetchC: typeof fetch = async () => Response.json({ access_token: 'expired-token', expires_in: 0 });
        await assert.rejects(
            () => exchangeCodeForUserAccessToken('code-c', fetchC),
            /FACEBOOK_TOKEN_EXPIRED/,
        );
    } finally {
        globalThis.fetch = original;
    }
});

test('F-15: subscribeManagedPage decouples Messenger and Lead Ads subscriptions and preserves existing fields', async () => {
    const page = '654520554683416';
    const company = '11111111-1111-4111-8111-111111111111';
    process.env.META_PAGE_BINDINGS = JSON.stringify([{ page, company, tokenEnv: 'META_PAGE_TEST_TOKEN', name: 'Du Học Áo CHD' }]);
    process.env.META_PAGE_TEST_TOKEN = secret;
    process.env.META_APP_ID = '123456';

    // Scenario 1: Messenger succeeds, Lead Ads fails (e.g. 403 lack of permissions) -> reported as MESSENGER_CONNECTED, does NOT throw
    const calls: string[] = [];
    const fetch1: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/me/accounts')) {
            return Response.json({ data: [{ id: page, name: 'Du Học Áo CHD', access_token: secret }] });
        }
        if (url.pathname.endsWith('/subscribed_apps')) {
            if (init?.method === 'GET') {
                return Response.json({ data: [] });
            }
            if (init?.method === 'POST') {
                const body = String(init.body);
                calls.push(body);
                if (body.includes('leadgen')) {
                    return new Response(JSON.stringify({ error: { message: 'Permissions error', code: 200 } }), { status: 403 });
                }
                return Response.json({ success: true });
            }
        }
        throw new Error(`Unexpected call: ${url}`);
    };

    const res1 = await subscribeManagedPage('dummy-user-token', page, company, fetch1);
    assert.equal(res1.messengerSubscribed, true);
    assert.equal(res1.leadAdsSubscribed, false);
    assert.equal(res1.status, 'MESSENGER_CONNECTED');
    assert.equal(res1.leadAdsError, 'LEAD_ADS_NOT_CONNECTED');

    // Scenario 2: Both subscriptions succeed -> ALL_CONNECTED
    const fetch2: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/me/accounts')) return Response.json({ data: [{ id: page, name: 'Du Học Áo CHD', access_token: secret }] });
        if (url.pathname.endsWith('/subscribed_apps')) {
            if (init?.method === 'GET') return Response.json({ data: [] });
            if (init?.method === 'POST') return Response.json({ success: true });
        }
        throw new Error(`Unexpected call: ${url}`);
    };
    const res2 = await subscribeManagedPage('dummy-user-token', page, company, fetch2);
    assert.equal(res2.messengerSubscribed, true);
    assert.equal(res2.leadAdsSubscribed, true);
    assert.equal(res2.status, 'ALL_CONNECTED');

    // Scenario 3: Messenger fails -> throws FACEBOOK_SUBSCRIBE_FAILED
    const fetch3: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/me/accounts')) return Response.json({ data: [{ id: page, name: 'Du Học Áo CHD', access_token: secret }] });
        if (url.pathname.endsWith('/subscribed_apps')) {
            if (init?.method === 'GET') return Response.json({ data: [] });
            if (init?.method === 'POST') return new Response(JSON.stringify({ error: 'Server error' }), { status: 500 });
        }
        throw new Error(`Unexpected call: ${url}`);
    };
    await assert.rejects(
        () => subscribeManagedPage('dummy-user-token', page, company, fetch3),
        /FACEBOOK_SUBSCRIBE_FAILED/,
    );

    // Scenario 4: Existing subscriptions preserved and reconnection does not duplicate fields
    let postedFields = '';
    const fetch4: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/me/accounts')) return Response.json({ data: [{ id: page, name: 'Du Học Áo CHD', access_token: secret }] });
        if (url.pathname.endsWith('/subscribed_apps')) {
            if (init?.method === 'GET') {
                return Response.json({ data: [{ id: '123456', subscribed_fields: ['messages', 'feed'] }] });
            }
            if (init?.method === 'POST') {
                postedFields = String(init.body);
                return Response.json({ success: true });
            }
        }
        throw new Error(`Unexpected call: ${url}`);
    };
    const res4 = await subscribeManagedPage('dummy-user-token', page, company, fetch4);
    assert.equal(res4.messengerSubscribed, true);
    assert.equal(res4.leadAdsSubscribed, true);
    assert.ok(postedFields.includes('feed'));
    assert.ok(postedFields.includes('messages'));
    assert.ok(postedFields.includes('leadgen'));
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
