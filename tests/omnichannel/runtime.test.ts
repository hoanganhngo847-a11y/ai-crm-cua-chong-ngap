import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { canReply, decodeCursor, encodeCursor, parseMeta, sanitize, validSignature } from '../../features/omnichannel/facebook/core';
import { binding, pageBindings } from '../../features/omnichannel/facebook/binding';
import { dispatchMessage } from '../../features/omnichannel/facebook/transport';
import { authorizeConversation, campaignStats, errorResponse } from '../../features/omnichannel/facebook/server';
import { POST as website } from '../../app/api/website/leads/route';
import { POST as meta } from '../../app/api/webhooks/meta/route';

const company = '55555555-5555-4555-8555-555555555555';
const companyB = '66666666-6666-4666-8666-666666666666';
Object.assign(process.env, {
    NODE_ENV: 'test',
    WEBSITE_ORIGIN: 'https://crm.test',
    OMNICHANNEL_COMPANY_ID: company,
    WEBSITE_RATE_SECRET: 'test-only-rate-secret-with-at-least-32-characters',
    TURNSTILE_SECRET_KEY: 'test-only-turnstile',
    META_APP_SECRET: 'test-only-meta',
    META_PAGE_ID: '123',
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'test-only-key',
});

const lead = {
    request_id: '77777777-7777-4777-8777-777777777777',
    name: 'Khách mới', phone: '0912345678', need: 'Cửa rộng 2.5m, ngập 40cm',
    consent: true, captcha_token: 'test-token', website: '',
};
function request(value = lead) {
    return new Request('https://crm.test/api/website/leads', {
        method: 'POST', headers: { origin: 'https://crm.test', 'content-type': 'application/json' },
        body: JSON.stringify(value),
    });
}
function event(page = '123', recipient = page) {
    return { object: 'page', entry: [{ id: page, messaging: [{
        sender: { id: '456' }, recipient: { id: recipient }, timestamp: Date.now(),
        message: { mid: 'mid-1', text: 'Gọi 0912345678, cửa rộng 2.5m' },
    }] }] };
}
const sign = (raw: string) => 'sha256=' + createHmac('sha256', process.env.META_APP_SECRET!).update(raw).digest('hex');

test('sanitizer preserves measurements, quantities, dates and times; redacts contact data', () => {
    const technical = 'cửa rộng 2.5m, ngập 40cm, 2 bộ, ngày 23/09/2026 lúc 14:30';
    assert.deepEqual(sanitize(technical), { content: technical, status: 'SUCCEEDED' });
    for (const phone of ['0912345678', '0912/345/678', '+84 (912) 345-678', '０９１２３４５６７８', '0912\u200B345678', 'không chín một hai ba bốn năm sáu bảy tám', 'khong chin mot hai ba bon nam sau bay tam', 'zero nine one two three four five six seven eight']) {
        const safe = sanitize(`${technical}; ${phone}`);
        assert.equal(safe.status, 'SUCCEEDED');
        assert.ok(safe.content?.includes(technical));
        assert.ok(!safe.content?.includes(phone));
    }
    assert.ok(!sanitize('Email abc@example.com').content?.includes('abc@example.com'));
    assert.ok(!sanitize('sdt: o9xx secret').content?.includes('o9xx'));
    assert.equal(sanitize('Hẹn 23.09.2026 14:30').content, 'Hẹn 23.09.2026 14:30');
    assert.deepEqual(sanitize('hai abc ba def bốn'), { content: null, status: 'FAILED' });
    assert.deepEqual(sanitize('a'.repeat(10001)), { content: null, status: 'FAILED' });
});

test('invalid signatures, wrong page and wrong recipient fail closed', async () => {
    const raw = JSON.stringify(event());
    assert.equal(validSignature(raw, sign(raw), process.env.META_APP_SECRET!), true);
    for (const signature of [null, 'sha256=bad', sign(raw + 'x')]) {
        assert.equal(validSignature(raw, signature, process.env.META_APP_SECRET!), false);
    }
    assert.throws(() => parseMeta(event('999'), '123'));
    assert.throws(() => parseMeta(event('123', '999'), '123'));
    assert.equal(parseMeta(event(), '123').length, 1);
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('Must not access DB'); };
    try {
        assert.equal((await meta(new Request('https://crm.test', { method: 'POST', body: raw }))).status, 403);
        const wrong = JSON.stringify(event('999'));
        assert.equal((await meta(new Request('https://crm.test', {
            method: 'POST', body: wrong, headers: { 'x-hub-signature-256': sign(wrong) },
        }))).status, 404);
    } finally { globalThis.fetch = original; }
});

test('multi-page mapping derives company from server configuration and rejects ambiguity', () => {
    process.env.META_PAGE_BINDINGS = JSON.stringify([
        { page: '123', company, tokenEnv: 'META_A_TOKEN' },
        { page: '999', company: companyB, tokenEnv: 'META_B_TOKEN' },
    ]);
    try {
        assert.equal(binding('999').company, companyB);
        assert.throws(() => binding());
        assert.throws(() => binding('888'));
        process.env.META_PAGE_BINDINGS = JSON.stringify([pageBindings()[0], pageBindings()[0]]);
        assert.throws(() => pageBindings());
    } finally { delete process.env.META_PAGE_BINDINGS; }
});

test('resource authorization masks wrong-company existence and keeps active-member/role checks', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => Response.json({
        id: lead.request_id, company_id: company, channel: 'FACEBOOK', external_conversation_id: '123:456',
    });
    function actorClient(profile: string, member: string | null, role = 'SALE'): SupabaseClient {
        return {
            auth: { getUser: async () => ({ data: { user: { id: lead.request_id } } }), mfa: {
                getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1' } }),
                listFactors: async () => ({ data: { totp: [] } }),
            } },
            from(table: string) {
                const query = {
                    select() { return query; }, eq() { return query; },
                    async maybeSingle() { return { data: table === 'user_profiles'
                        ? { id: lead.request_id, status: profile, full_name: 'Test' }
                        : member ? { id: lead.request_id, company_id: company, status: member, role } : null }; },
                };
                return query;
            },
        } as unknown as SupabaseClient;
    }
    try {
        for (const operation of [authorizeConversation, campaignStats]) {
            for (const [profile, member, role, status] of [
                ['ACTIVE', null, 'SALE', 404],
                ['INACTIVE', 'ACTIVE', 'SALE', 403],
                ['ACTIVE', 'INACTIVE', 'SALE', 403],
                ['ACTIVE', 'ACTIVE', 'TECHNICIAN', 403],
            ] as const) {
                await assert.rejects(() => operation(lead.request_id, actorClient(profile, member, role)), (error) => {
                    assert.equal(errorResponse(error).status, status);
                    return true;
                });
            }
        }
        assert.equal((await authorizeConversation(lead.request_id, actorClient('ACTIVE', 'ACTIVE'))).actor.role, 'SALE');
    } finally { globalThis.fetch = original; }
});

test('CAPTCHA failure never consumes quota; success precedes quota and intake', async () => {
    const original = globalThis.fetch;
    const calls: string[] = [];
    let captcha = { success: false, hostname: 'crm.test', action: 'lead' };
    let allowed = true;
    globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes('siteverify')) { calls.push('captcha'); return Response.json(captcha); }
        if (url.endsWith('/han_rate_limit')) { calls.push('quota'); return Response.json(allowed); }
        if (url.endsWith('/han_ingest')) {
            calls.push('intake');
            const body = JSON.parse(String(init?.body));
            assert.equal(body.p_external, null);
            assert.equal(body.p_key, lead.request_id);
            assert.equal(body.p_company, company);
            assert.equal(body.p_safe_status, 'SUCCEEDED');
            return Response.json({ status: 'ACCEPTED' });
        }
        throw new Error('Unexpected fetch');
    };
    try {
        for (const invalid of [captcha, { ...captcha, success: true, hostname: 'evil.test' }, { ...captcha, success: true, action: 'other' }]) {
            captcha = invalid; calls.length = 0;
            assert.equal((await website(request())).status, 403);
            assert.deepEqual(calls, ['captcha']);
        }
        captcha = { success: true, hostname: 'crm.test', action: 'lead' }; calls.length = 0;
        assert.equal((await website(request())).status, 202);
        assert.deepEqual(calls, ['captcha', 'quota', 'intake']);
        allowed = false; calls.length = 0;
        assert.equal((await website(request())).status, 429);
        assert.deepEqual(calls, ['captcha', 'quota']);
        calls.length = 0;
        assert.equal((await website(request({ ...lead, captcha_token: '' }))).status, 400);
        assert.deepEqual(calls, []);
    } finally { globalThis.fetch = original; }
});

test('24h window, cursor roundtrip and ambiguous provider failures', async () => {
    const now = Date.now();
    assert.equal(canReply(new Date(now - 86400000).toISOString(), now), false);
    assert.equal(canReply(new Date(now - 86399000).toISOString(), now), true);
    assert.equal(canReply(new Date(now + 1000).toISOString(), now), false);
    const row = { id: lead.request_id, created_at: new Date(now).toISOString() };
    assert.deepEqual(decodeCursor(encodeCursor(row)), { id: row.id, time: row.created_at });
    assert.throws(() => decodeCursor('garbage'));
    const input = { page: '123', recipient: '456', token: 'test', version: 'v99.0', content: 'Test' };
    for (const [code, status] of [[200, 'SENT'], [400, 'FAILED'], [500, 'UNKNOWN']] as const) {
        assert.equal((await dispatchMessage(input, async () => Response.json({ message_id: 'mid' }, { status: code }))).status, status);
    }
    assert.equal((await dispatchMessage(input, async () => { throw new Error('timeout'); })).status, 'UNKNOWN');
});
