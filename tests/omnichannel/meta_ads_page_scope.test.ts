import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    configuredFacebookPageIds,
    configuredLeadAdsPageIds,
    getConfiguredFacebookConnections,
} from '../../features/omnichannel/facebook/connect';

test('Facebook admin counts only opted-in Lead Ads Pages and preserves verified/unknown subscription states', async () => {
    const saved = { ...process.env };
    const original = globalThis.fetch;
    const company = 'd1111111-1111-4111-8111-111111111111';
    const other = 'd2222222-2222-4222-8222-222222222222';
    const binding = (page: string, tenant = company) => ({ page, company: tenant, name: `Page ${page}`, tokenEnv: 'META_SCOPE_TEST_TOKEN' });
    const subscriptionReads: string[] = [];
    const tokenReads: string[] = [];
    const env = {
        NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_SERVICE_ROLE_KEY: 'local-scope-test-key',
        META_APP_ID: '12345',
        META_SCOPE_TEST_TOKEN: 'synthetic-scope-token',
        META_PAGE_BINDINGS: JSON.stringify([binding('111'), binding('222')]),
        META_ADS_PAGE_BINDINGS: JSON.stringify([binding('222'), binding('333'), binding('444'), binding('555', other)]),
    };
    Object.assign(process.env, env);
    globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname === '127.0.0.1' && url.pathname.endsWith('/get_meta_ad_account_token')) {
            const args = JSON.parse(String(init?.body));
            assert.equal(args.p_company_id, company);
            tokenReads.push(args.p_ad_account_id);
            return Response.json([]);
        }
        assert.equal(url.hostname, 'graph.facebook.com');
        assert.equal(init?.method, 'GET', 'status checks cannot change subscriptions');
        assert.ok(url.pathname.endsWith('/subscribed_apps'));
        const page = url.pathname.split('/').at(-2)!;
        subscriptionReads.push(page);
        if (page === '444') return Response.json({ error: { code: 10 } }, { status: 403 });
        assert.ok(['222', '333'].includes(page));
        return Response.json({ data: [{ id: '12345', subscribed_fields: page === '222' ? ['messages', 'leadgen'] : ['messages'] }] });
    };
    try {
        assert.deepEqual([...configuredFacebookPageIds(company)].sort(), ['111', '222', '333', '444']);
        assert.deepEqual([...configuredLeadAdsPageIds(company)].sort(), ['222', '333', '444']);
        const connections = await getConfiguredFacebookConnections(company);
        assert.equal(connections.length, 3, 'overlapping Messenger/Lead Ads Page counts once; Messenger-only and other tenants are excluded');
        assert.deepEqual(subscriptionReads.sort(), ['222', '333', '444']);
        assert.deepEqual(tokenReads.sort(), ['__page__:222', '__page__:333', '__page__:444']);
        const byId = new Map(connections.map(connection => [connection.pageId, connection]));
        assert.equal(byId.get('222')?.leadAdsSubscribed, true);
        assert.equal(byId.get('222')?.leadAdsStatus, 'ALL_CONNECTED');
        assert.equal(byId.get('333')?.leadAdsSubscribed, false, 'a Messenger subscription is not a Lead Ads subscription');
        assert.equal(byId.get('333')?.leadAdsStatus, 'LEAD_ADS_NOT_CONNECTED');
        assert.equal(byId.get('444')?.leadAdsSubscribed, false);
        assert.equal(byId.get('444')?.leadAdsStatus, 'SUBSCRIPTION_UNKNOWN', 'failed read-back must never report connected');
    } finally {
        globalThis.fetch = original;
        for (const key of Object.keys(env)) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    }
});
