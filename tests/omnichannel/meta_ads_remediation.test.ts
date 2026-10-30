import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fetchMetaPages, graphVersion, marketingVersion, redactMetaError } from '../../features/omnichannel/facebook/graph-api';
import { listManagedAdAccounts, listManagedFacebookPages } from '../../features/omnichannel/facebook/connect';
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
    assert.ok(files.indexOf('20261030110000_meta_ads_final_remediation.sql') > files.indexOf('20261030100000_meta_ads_hardening.sql'));
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
