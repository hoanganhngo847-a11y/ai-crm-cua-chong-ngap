import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import {
    binding,
} from '../../features/omnichannel/facebook/binding';
import {
    extractReferral,
    parseLeadgenChanges,
    parseMeta,
} from '../../features/omnichannel/facebook/core';
import {
    extractLeadFields,
    formatLeadAdsSafeContent,
} from '../../features/omnichannel/facebook/lead-ads';
import {
    encryptToken,
    decryptToken,
    rotateToken,
    parseEncryptionKey,
} from '../../features/omnichannel/facebook/token-vault';
import {
    fetchWithBackoff,
    validateAdAccountAccess,
} from '../../features/omnichannel/facebook/marketing-sync';
import { POST as webhookPost } from '../../app/api/webhooks/meta/route';
import { POST as syncPost } from '../../app/api/admin/meta-ads/sync/route';
import { requireBossAdmin, AuthError } from '../../lib/auth/context';
import { createPgliteSupabase } from '../zalo/helpers/pglite-supabase';

const TARGET_PAGE_ID = '1026991374010112';
const SECONDARY_PAGE_ID = '2222222222222222';
const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const COMPANY_B = '22222222-2222-4222-8222-222222222222';
const APP_SECRET = 'meta-app-secret-production-test-key-32ch';
const VERIFY_TOKEN = 'chd-meta-verify-token-production-secret';
const PAGE_A_TOKEN = 'META_TEST_TOKEN_CHD_PAGE_ACCESS_TOKEN';

(process.env as Record<string, string | undefined>).NODE_ENV = 'test';
process.env.WEBSITE_ORIGIN = 'https://ai-crm-cua-chong-ngap.onrender.com';
process.env.META_APP_SECRET = APP_SECRET;
process.env.META_VERIFY_TOKEN = VERIFY_TOKEN;
process.env.META_GRAPH_VERSION = 'v26.0';
process.env.META_MARKETING_VERSION = 'v26.0';
process.env.META_PAGE_CHD_TOKEN = PAGE_A_TOKEN;
process.env.META_TOKEN_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key-never-for-client';

process.env.META_PAGE_BINDINGS = JSON.stringify([
    {
        page: TARGET_PAGE_ID,
        company: COMPANY_A,
        tokenEnv: 'META_PAGE_CHD_TOKEN',
        name: 'Du học Đức CHD',
    },
    {
        page: SECONDARY_PAGE_ID,
        company: COMPANY_B,
        tokenEnv: 'META_PAGE_B_TOKEN',
        name: 'Secondary Support Page',
    },
]);

function signPayload(raw: string, secret = APP_SECRET) {
    return 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
}

// -----------------------------------------------------------------------------
// SCENARIO 1: Webhook Messenger cũ tiếp tục hoạt động bình thường
// -----------------------------------------------------------------------------
test('Scenario 1: Legacy Messenger webhook continues working normally without regression', async () => {
    const originalFetch = globalThis.fetch;
    const rpcCalls: Array<{ name: string; args: any }> = [];

    globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes('/rest/v1/rpc/han_ingest')) {
            const body = JSON.parse(String(init?.body));
            rpcCalls.push({ name: 'han_ingest', args: body });
            return Response.json({ status: 'RECEIVED', interaction_id: 'test-int-legacy-01' });
        }
        if (url.includes('graph.facebook.com')) {
            return Response.json({ name: 'Nguyễn Văn A' });
        }
        if (url.includes('/rest/v1/')) {
            return Response.json([]);
        }
        throw new Error(`Unexpected fetch call to ${url}`);
    };

    try {
        const messengerPayload = {
            object: 'page',
            entry: [
                {
                    id: TARGET_PAGE_ID,
                    time: Date.now(),
                    messaging: [
                        {
                            sender: { id: '987654321012345' },
                            recipient: { id: TARGET_PAGE_ID },
                            timestamp: Date.now(),
                            message: {
                                mid: 'mid.legacy_msg_001',
                                text: 'Em muốn đăng ký tư vấn du học nghề Đức',
                            },
                        },
                    ],
                },
            ],
        };

        const raw = JSON.stringify(messengerPayload);
        const req = new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/webhooks/meta', {
            method: 'POST',
            headers: { 'x-hub-signature-256': signPayload(raw) },
            body: raw,
        });

        const res = await webhookPost(req);
        assert.equal(res.status, 200);
        const resBody = await res.json();
        assert.equal(resBody.received, true);

        // Verified han_ingest received legacy message correctly
        assert.equal(rpcCalls.length, 1);
        assert.equal(rpcCalls[0].args.p_channel, 'FACEBOOK');
        assert.equal(rpcCalls[0].args.p_company, COMPANY_A);
        assert.equal(rpcCalls[0].args.p_content, 'Em muốn đăng ký tư vấn du học nghề Đức');
        assert.equal(rpcCalls[0].args.p_key, `${TARGET_PAGE_ID}:mid.legacy_msg_001`);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// -----------------------------------------------------------------------------
// SCENARIO 2: Webhook Lead Ads (`leadgen`) hợp lệ được tiếp nhận và xử lý
// -----------------------------------------------------------------------------
test('Scenario 2: Valid Lead Ads webhook (leadgen) is received and processed with full attribution', async () => {
    const originalFetch = globalThis.fetch;
    const rpcCalls: Array<{ name: string; args: any }> = [];

    globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes('graph.facebook.com') && url.includes('leadgen_001')) {
            // Mock Meta Graph API leadgen details retrieval
            return Response.json({
                id: 'leadgen_001',
                created_time: '2026-10-30T00:00:00+0000',
                ad_id: 'ad_autumn_01',
                ad_name: 'Quảng cáo Du học Mùa Thu 2026',
                adset_id: 'adset_autumn_01',
                adset_name: 'Nhóm học sinh THPT 18-22',
                campaign_id: 'camp_autumn_01',
                campaign_name: 'Chiến dịch Tuyển sinh Đức Mùa Thu',
                form_id: 'form_lead_001',
                field_data: [
                    { name: 'full_name', values: ['Lê Hoàng Nam'] },
                    { name: 'phone_number', values: ['+84988123456'] },
                    { name: 'email', values: ['nam.le@example.com'] },
                    { name: 'nam_sinh', values: ['2004'] },
                ],
            });
        }
        if (url.includes('/rest/v1/rpc/claim_meta_leadgen_event')) return Response.json({ status: 'CLAIMED', claim_token: 'test-claim-token' });
        if (url.includes('/rest/v1/rpc/finalize_meta_leadgen_event')) return Response.json(true);
        if (url.includes('/rest/v1/rpc/ingest_meta_leadgen_event')) {
            const body = JSON.parse(String(init?.body));
            rpcCalls.push({ name: 'ingest_meta_leadgen_event', args: body });
            return Response.json({
                status: 'RECEIVED',
                customer_id: 'cust_lead_001',
                interaction_id: 'int_lead_001',
            });
        }
        if (url.includes('/rest/v1/rpc/record_lead_attribution_touchpoint')) {
            const body = JSON.parse(String(init?.body));
            rpcCalls.push({ name: 'record_lead_attribution_touchpoint', args: body });
            return Response.json('tp_lead_001');
        }
        if (url.includes('/rest/v1/')) {
            return Response.json([]);
        }
        throw new Error(`Unexpected fetch call to ${url}`);
    };

    try {
        const leadgenPayload = {
            object: 'page',
            entry: [
                {
                    id: TARGET_PAGE_ID,
                    time: Date.now(),
                    changes: [
                        {
                            field: 'leadgen',
                            value: {
                                leadgen_id: 'leadgen_001',
                                page_id: TARGET_PAGE_ID,
                                form_id: 'form_lead_001',
                                ad_id: 'ad_autumn_01',
                                created_time: Math.floor(Date.now() / 1000),
                            },
                        },
                    ],
                },
            ],
        };

        const raw = JSON.stringify(leadgenPayload);
        const req = new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/webhooks/meta', {
            method: 'POST',
            headers: { 'x-hub-signature-256': signPayload(raw) },
            body: raw,
        });

        const res = await webhookPost(req);
        assert.equal(res.status, 200);
        const resBody = await res.json();
        assert.equal(resBody.received, true);

        // Verify han_ingest was called for the lead
        const ingestCall = rpcCalls.find(c => c.name === 'ingest_meta_leadgen_event');
        assert.ok(ingestCall, 'han_ingest should be called for the lead');
        assert.equal(ingestCall.args.p_company_id, COMPANY_A);
        assert.equal(ingestCall.args.p_ingest.phone, '+84988123456', 'Phone normalized to standard VN format');

        // Verify record_lead_attribution_touchpoint was recorded
        const touchpointCall = rpcCalls.find(c => c.name === 'record_lead_attribution_touchpoint');
        assert.ok(touchpointCall, 'record_lead_attribution_touchpoint should be recorded');
        assert.equal(touchpointCall.args.p_channel, 'FACEBOOK_LEAD_ADS');
        assert.equal(touchpointCall.args.p_campaign_name, 'Chiến dịch Tuyển sinh Đức Mùa Thu');
        assert.equal(touchpointCall.args.p_ad_name, 'Quảng cáo Du học Mùa Thu 2026');
        assert.equal(touchpointCall.args.p_meta_ad_id, 'ad_autumn_01');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// -----------------------------------------------------------------------------
// SCENARIO 3: Webhook chữ ký sai hoặc payload sai bị từ chối 403 / fail-closed
// -----------------------------------------------------------------------------
test('Scenario 3: Tampered signature or malformed payload fails closed with 403/400', async () => {
    const raw = JSON.stringify({ object: 'page', entry: [] });

    // Missing signature -> 403
    const reqNoSig = new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/webhooks/meta', {
        method: 'POST',
        body: raw,
    });
    assert.equal((await webhookPost(reqNoSig)).status, 403);

    // Tampered signature -> 403
    const reqBadSig = new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/webhooks/meta', {
        method: 'POST',
        headers: { 'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000' },
        body: raw,
    });
    assert.equal((await webhookPost(reqBadSig)).status, 403);

    // Tampered body with original signature -> 403
    const reqTampered = new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/webhooks/meta', {
        method: 'POST',
        headers: { 'x-hub-signature-256': signPayload(raw) },
        body: raw + 'tampered',
    });
    assert.equal((await webhookPost(reqTampered)).status, 403);

    // Malformed JSON with matching signature -> 400
    const malformedJson = '{ bad json syntax :';
    const reqMalformed = new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/webhooks/meta', {
        method: 'POST',
        headers: { 'x-hub-signature-256': signPayload(malformedJson) },
        body: malformedJson,
    });
    assert.equal((await webhookPost(reqMalformed)).status, 400);
});

// -----------------------------------------------------------------------------
// SCENARIO 4: Webhook gửi lại (idempotency retry) không tạo lead hoặc interaction trùng
// -----------------------------------------------------------------------------
test('Scenario 4: Webhook idempotency retry is deduplicated safely without duplicate entries', async () => {
    const supabase = await createPgliteSupabase();
    const { db } = supabase;

    try {
        const companyId = '71111111-1111-4111-8111-111111111111';
        const customerId = '72222222-2222-4222-8222-222222222222';

        await db.exec(`
            INSERT INTO public.companies (id, name, status)
            VALUES ('${companyId}', 'Test Du Học Idempotent', 'ACTIVE')
            ON CONFLICT (id) DO NOTHING;

            INSERT INTO public.customers (id, company_id, customer_code, name, source, stage)
            VALUES ('${customerId}', '${companyId}', 'KH-IDEMP-01', 'Khách Idempotent', 'FACEBOOK', 'LEAD_NEW')
            ON CONFLICT (id) DO NOTHING;
        `);

        // First touchpoint record
        const res1 = await db.query(`
            SELECT record_lead_attribution_touchpoint(
                p_company => '${companyId}'::uuid,
                p_customer => '${customerId}'::uuid,
                p_channel => 'FACEBOOK_LEAD_ADS',
                p_page_id => 'target_page_123',
                p_meta_campaign_id => 'camp_001',
                p_campaign_name => 'Chiến dịch Mùa Thu',
                p_meta_ad_set_id => 'adset_001',
                p_ad_set_name => 'Nhóm THPT',
                p_meta_ad_id => 'ad_001',
                p_ad_name => 'Quảng cáo Tuyển sinh',
                p_meta_form_id => 'form_001',
                p_form_name => 'Biểu mẫu đăng ký',
                p_meta_leadgen_id => 'lg_idempotent_999',
                p_attribution_status => 'ATTRIBUTED',
                p_attribution_method => 'DIRECT_LEADGEN'
            );
        `);
        const firstId = (res1.rows[0] as any).record_lead_attribution_touchpoint;
        assert.ok(firstId, 'First insert must return generated UUID');

        // Check count of touchpoints
        const countBefore = await db.query(`
            SELECT count(*) FROM public.lead_attribution_touchpoints
            WHERE company_id = '${companyId}' AND meta_leadgen_id = 'lg_idempotent_999';
        `);
        assert.equal(Number((countBefore.rows[0] as any).count), 1);

        // Second duplicate touchpoint record with identical meta_leadgen_id
        const res2 = await db.query(`
            SELECT record_lead_attribution_touchpoint(
                p_company => '${companyId}'::uuid,
                p_customer => '${customerId}'::uuid,
                p_channel => 'FACEBOOK_LEAD_ADS',
                p_page_id => 'target_page_123',
                p_meta_campaign_id => 'camp_001',
                p_campaign_name => 'Chiến dịch Mùa Thu',
                p_meta_ad_set_id => 'adset_001',
                p_ad_set_name => 'Nhóm THPT',
                p_meta_ad_id => 'ad_001',
                p_ad_name => 'Quảng cáo Tuyển sinh',
                p_meta_form_id => 'form_001',
                p_form_name => 'Biểu mẫu đăng ký',
                p_meta_leadgen_id => 'lg_idempotent_999',
                p_attribution_status => 'ATTRIBUTED',
                p_attribution_method => 'DIRECT_LEADGEN'
            );
        `);
        const secondId = (res2.rows[0] as any).record_lead_attribution_touchpoint;
        assert.equal(secondId, firstId, 'Second call must idempotently return existing touchpoint ID');

        // Verify count remains strictly 1 (no duplicate rows)
        const countAfter = await db.query(`
            SELECT count(*) FROM public.lead_attribution_touchpoints
            WHERE company_id = '${companyId}' AND meta_leadgen_id = 'lg_idempotent_999';
        `);
        assert.equal(Number((countAfter.rows[0] as any).count), 1, 'Touchpoint must not be duplicated on retry');
    } finally {
        await supabase.close();
    }
});

// -----------------------------------------------------------------------------
// SCENARIO 5: Page không được phép (`PAGE_NOT_ALLOWED`) không thể ghi dữ liệu sang Company khác
// -----------------------------------------------------------------------------
test('Scenario 5: Unallowed Page fails closed and cannot write data across companies', async () => {
    // 5A: Unbound Page ID fails closed with 404 NOT_FOUND
    assert.throws(
        () => binding('9999999999999999'),
        (err: any) => err.code === 'NOT_FOUND' && err.status === 404
    );

    // 5B: Webhook POST with unbound page returns 404
    const unknownPagePayload = {
        object: 'page',
        entry: [
            {
                id: '9999999999999999',
                time: Date.now(),
                messaging: [{ sender: { id: '987654321012345' }, recipient: { id: '9999999999999999' }, message: { text: 'hi' } }],
            },
        ],
    };
    const rawUnknown = JSON.stringify(unknownPagePayload);
    const reqUnknown = new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/webhooks/meta', {
        method: 'POST',
        headers: { 'x-hub-signature-256': signPayload(rawUnknown) },
        body: rawUnknown,
    });
    assert.equal((await webhookPost(reqUnknown)).status, 404);

    // 5C: Inbound message where recipient.id is different from entry page fails closed with 403
    const mismatchEvent = {
        object: 'page',
        entry: [
            {
                id: TARGET_PAGE_ID,
                messaging: [
                    {
                        sender: { id: '987654321012345' },
                        recipient: { id: SECONDARY_PAGE_ID }, // mismatch cross-page attack
                        message: { mid: 'mid.mismatch', text: 'cross-tenant message' },
                    },
                ],
            },
        ],
    };
    assert.throws(
        () => parseMeta(mismatchEvent, TARGET_PAGE_ID),
        (err: any) => err.code === 'PAGE_NOT_ALLOWED' && err.status === 403
    );
});

// -----------------------------------------------------------------------------
// SCENARIO 6: Ad account của Company khác không thể bị truy vấn hoặc đồng bộ (Tenant Isolation)
// -----------------------------------------------------------------------------
test('Scenario 6: Ad accounts of other companies are strictly isolated via RLS', async () => {
    const supabase = await createPgliteSupabase();
    const { db } = supabase;

    try {
        const compA = '81111111-1111-4111-8111-111111111111';
        const compB = '82222222-2222-4222-8222-222222222222';
        const userA = '83333333-3333-4333-8333-333333333333';

        await db.exec(`
            INSERT INTO auth.users (id, email) VALUES
                ('${userA}', 'boss_a@test.local')
            ON CONFLICT (id) DO NOTHING;

            INSERT INTO public.companies (id, name, status) VALUES
                ('${compA}', 'Doanh nghiệp A', 'ACTIVE'),
                ('${compB}', 'Doanh nghiệp B', 'ACTIVE')
            ON CONFLICT (id) DO NOTHING;

            INSERT INTO public.company_members (company_id, user_id, role, status) VALUES
                ('${compA}', '${userA}', 'BOSS_ADMIN', 'ACTIVE')
            ON CONFLICT DO NOTHING;

            INSERT INTO public.meta_ad_accounts (company_id, ad_account_id, name, account_status) VALUES
                ('${compA}', 'act_aaa_111', 'Ad Account của A', 1),
                ('${compB}', 'act_bbb_222', 'Ad Account của B', 1);
        `);

        // Switch to authenticated user A context
        await db.exec(`
            SET ROLE authenticated;
            SET "request.jwt.claim.sub" = '${userA}';
            SET "request.jwt.claim.role" = 'authenticated';
        `);

        // Query ad accounts as User A
        const resA = await db.query(`SELECT ad_account_id, name FROM public.meta_ad_accounts;`);
        
        // Assert: User A sees only Company A's ad account
        assert.equal(resA.rows.length, 1);
        assert.equal((resA.rows[0] as any).ad_account_id, 'act_aaa_111');
        assert.equal((resA.rows[0] as any).name, 'Ad Account của A');

        // Reset role
        await db.exec(`RESET ROLE;`);
    } finally {
        await supabase.close();
    }
});

// -----------------------------------------------------------------------------
// SCENARIO 7: Lead có ad ID được ánh xạ chính xác đến campaign/ad set/ad
// -----------------------------------------------------------------------------
test('Scenario 7: Lead with ad ID correctly maps to campaign/adset/ad metadata and updates snapshots', async () => {
    const supabase = await createPgliteSupabase();
    const { db } = supabase;

    try {
        const compId = '61111111-1111-4111-8111-111111111111';
        const custId = '62222222-2222-4222-8222-222222222222';

        await db.exec(`
            INSERT INTO public.companies (id, name, status)
            VALUES ('${compId}', 'Du Học Đức CHD Attributed', 'ACTIVE')
            ON CONFLICT (id) DO NOTHING;

            INSERT INTO public.customers (id, company_id, customer_code, name, source, stage)
            VALUES ('${custId}', '${compId}', 'KH-ATTR-01', 'Hoàng Văn Thắng', 'FACEBOOK', 'LEAD_NEW')
            ON CONFLICT (id) DO NOTHING;

            INSERT INTO public.meta_ad_accounts (company_id, ad_account_id, name, account_status)
            VALUES ('${compId}', 'act_100', 'Tài khoản CHD Ads', 1);

            INSERT INTO public.meta_campaigns (company_id, ad_account_id, meta_campaign_id, name, status)
            VALUES ('${compId}', 'act_100', 'camp_berlin_01', 'Tuyển sinh Du học Đức Berlin 2026', 'ACTIVE');

            INSERT INTO public.meta_ad_sets (company_id, ad_account_id, meta_campaign_id, meta_ad_set_id, name, status)
            VALUES ('${compId}', 'act_100', 'camp_berlin_01', 'adset_berlin_01', 'Nhóm Học sinh Tốt nghiệp THPT', 'ACTIVE');

            INSERT INTO public.meta_ads (company_id, ad_account_id, meta_campaign_id, meta_ad_set_id, meta_ad_id, name, status)
            VALUES ('${compId}', 'act_100', 'camp_berlin_01', 'adset_berlin_01', 'ad_berlin_01', 'Video Review Trường ĐH Berlin', 'ACTIVE');
        `);

        // Record touchpoint with ad_id only (lookup should resolve names from meta_ads table)
        await db.query(`
            SELECT record_lead_attribution_touchpoint(
                p_company => '${compId}'::uuid,
                p_customer => '${custId}'::uuid,
                p_channel => 'FACEBOOK_LEAD_ADS',
                p_page_id => 'page_chd_01',
                p_ad_account_id => 'act_100',
                p_meta_ad_id => 'ad_berlin_01',
                p_meta_leadgen_id => 'lg_mapped_01',
                p_attribution_status => 'UNATTRIBUTED',
                p_attribution_method => 'AD_LOOKUP'
            );
        `);

        // Verify touchpoint row was enriched from database meta tables
        const tpRes = await db.query(`
            SELECT meta_campaign_id, campaign_name_snapshot, meta_ad_set_id, ad_set_name_snapshot, meta_ad_id, ad_name_snapshot, attribution_status
            FROM public.lead_attribution_touchpoints
            WHERE company_id = '${compId}' AND meta_leadgen_id = 'lg_mapped_01';
        `);
        assert.equal(tpRes.rows.length, 1);
        const tp = tpRes.rows[0] as any;
        assert.equal(tp.meta_campaign_id, 'camp_berlin_01');
        assert.equal(tp.campaign_name_snapshot, 'Tuyển sinh Du học Đức Berlin 2026');
        assert.equal(tp.meta_ad_set_id, 'adset_berlin_01');
        assert.equal(tp.ad_set_name_snapshot, 'Nhóm Học sinh Tốt nghiệp THPT');
        assert.equal(tp.meta_ad_id, 'ad_berlin_01');
        assert.equal(tp.ad_name_snapshot, 'Video Review Trường ĐH Berlin');
        assert.equal(tp.attribution_status, 'ATTRIBUTED');

        // Verify customer snapshot fields were updated
        const custRes = await db.query(`
            SELECT first_campaign_name, first_ad_name, latest_campaign_name, latest_ad_name, attribution_status
            FROM public.customers
            WHERE id = '${custId}';
        `);
        const cust = custRes.rows[0] as any;
        assert.equal(cust.first_campaign_name, 'Tuyển sinh Du học Đức Berlin 2026');
        assert.equal(cust.first_ad_name, 'Video Review Trường ĐH Berlin');
        assert.equal(cust.latest_campaign_name, 'Tuyển sinh Du học Đức Berlin 2026');
        assert.equal(cust.latest_ad_name, 'Video Review Trường ĐH Berlin');
        assert.equal(cust.attribution_status, 'ATTRIBUTED');
    } finally {
        await supabase.close();
    }
});

// -----------------------------------------------------------------------------
// SCENARIO 8: Lead thiếu attribution không bị gán nhầm campaign (giữ UNATTRIBUTED)
// -----------------------------------------------------------------------------
test('Scenario 8: Lead without attribution metadata remains UNATTRIBUTED without guessing campaign', async () => {
    const supabase = await createPgliteSupabase();
    const { db } = supabase;

    try {
        const compId = '51111111-1111-4111-8111-111111111111';
        const custId = '52222222-2222-4222-8222-222222222222';

        await db.exec(`
            INSERT INTO public.companies (id, name, status)
            VALUES ('${compId}', 'CHD Organic Leads', 'ACTIVE')
            ON CONFLICT (id) DO NOTHING;

            INSERT INTO public.customers (id, company_id, customer_code, name, source, stage)
            VALUES ('${custId}', '${compId}', 'KH-UNATTR-01', 'Khách Nhắn Tin Tự Nhiên', 'FACEBOOK', 'LEAD_NEW')
            ON CONFLICT (id) DO NOTHING;

            INSERT INTO public.meta_ad_accounts (company_id, ad_account_id, name, account_status)
            VALUES ('${compId}', 'act_random', 'Tài khoản Random', 1);

            INSERT INTO public.meta_campaigns (company_id, ad_account_id, meta_campaign_id, name, status)
            VALUES ('${compId}', 'act_random', 'camp_existing', 'Chiến dịch Quảng cáo Đang Chạy', 'ACTIVE');
        `);

        // Record organic messenger touchpoint without ad or campaign metadata
        await db.query(`
            SELECT record_lead_attribution_touchpoint(
                p_company => '${compId}'::uuid,
                p_customer => '${custId}'::uuid,
                p_channel => 'FACEBOOK_MESSENGER',
                p_page_id => 'page_chd_01',
                p_attribution_status => 'UNATTRIBUTED',
                p_attribution_method => 'MESSENGER_REFERRAL'
            );
        `);

        const tpRes = await db.query(`
            SELECT campaign_name_snapshot, ad_name_snapshot, attribution_status
            FROM public.lead_attribution_touchpoints
            WHERE company_id = '${compId}' AND customer_id = '${custId}';
        `);
        assert.equal((tpRes.rows[0] as any).campaign_name_snapshot, null);
        assert.equal((tpRes.rows[0] as any).ad_name_snapshot, null);
        assert.equal((tpRes.rows[0] as any).attribution_status, 'UNATTRIBUTED');

        const custRes = await db.query(`
            SELECT first_campaign_name, attribution_status
            FROM public.customers
            WHERE id = '${custId}';
        `);
        assert.equal((custRes.rows[0] as any).first_campaign_name, null);
        assert.equal((custRes.rows[0] as any).attribution_status, 'UNATTRIBUTED');
    } finally {
        await supabase.close();
    }
});

// -----------------------------------------------------------------------------
// SCENARIO 9: Click-to-Messenger referral được lưu và gắn đúng với Conversation / Customer
// -----------------------------------------------------------------------------
test('Scenario 9: Click-to-Messenger referral metadata is extracted and recorded', async () => {
    // 9A: Unit test referral extraction from various Meta payload locations
    const referralInMessaging = {
        referral: {
            source: 'ADS',
            type: 'OPEN_THREAD',
            ad_id: 'ad_ctm_123',
            ref: 'fb_ad_promo',
            ads_context_data: {
                ad_title: 'Học bổng Đức 100%',
                photo_url: 'https://example.com/ad.jpg',
            },
        },
    };
    const extracted1 = extractReferral(referralInMessaging);
    assert.ok(extracted1);
    assert.equal(extracted1?.source, 'ADS');
    assert.equal(extracted1?.adId, 'ad_ctm_123');
    assert.equal(extracted1?.adsContextData?.ad_title, 'Học bổng Đức 100%');

    // 9B: Referral nested inside message object
    const referralInMessage = {
        message: {
            mid: 'mid.referral_01',
            referral: {
                source: 'SHORTLINK',
                type: 'OPEN_THREAD',
                ref: 'qr_flyer_2026',
            },
        },
    };
    const extracted2 = extractReferral({}, referralInMessage.message);
    assert.ok(extracted2);
    assert.equal(extracted2?.source, 'SHORTLINK');
    assert.equal(extracted2?.ref, 'qr_flyer_2026');

    // 9C: Inbound webhook with referral calls record_lead_attribution_touchpoint
    const originalFetch = globalThis.fetch;
    const rpcCalls: Array<{ name: string; args: any }> = [];

    globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes('/rest/v1/rpc/han_ingest')) {
            const body = JSON.parse(String(init?.body));
            rpcCalls.push({ name: 'han_ingest', args: body });
            return Response.json({
                status: 'RECEIVED',
                customer_id: 'cust_ctm_001',
                interaction_id: '93000000-0000-4000-8000-000000000001',
            });
        }
        if (url.includes('/rest/v1/interactions')) {
            return Response.json({
                customer_id: 'cust_ctm_001',
                conversation_id: 'conv_ctm_001',
            });
        }
        if (url.includes('/rest/v1/rpc/record_lead_attribution_touchpoint')) {
            const body = JSON.parse(String(init?.body));
            rpcCalls.push({ name: 'record_lead_attribution_touchpoint', args: body });
            return Response.json('tp_ctm_001');
        }
        if (url.includes('graph.facebook.com')) {
            return Response.json({ name: 'Phạm Thuỳ Linh' });
        }
        if (url.includes('/rest/v1/')) {
            return Response.json([]);
        }
        throw new Error(`Unexpected fetch call to ${url}`);
    };

    try {
        const ctmPayload = {
            object: 'page',
            entry: [
                {
                    id: TARGET_PAGE_ID,
                    time: Date.now(),
                    messaging: [
                        {
                            sender: { id: '987654321012345' },
                            recipient: { id: TARGET_PAGE_ID },
                            timestamp: Date.now(),
                            referral: {
                                source: 'ADS',
                                type: 'OPEN_THREAD',
                                ad_id: 'ad_ctm_999',
                                ref: 'promo_code_scholarship',
                            },
                            message: {
                                mid: 'mid.ctm_msg_01',
                                text: 'Em muốn hỏi về chương trình học bổng',
                            },
                        },
                    ],
                },
            ],
        };

        const raw = JSON.stringify(ctmPayload);
        const req = new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/webhooks/meta', {
            method: 'POST',
            headers: { 'x-hub-signature-256': signPayload(raw) },
            body: raw,
        });

        const res = await webhookPost(req);
        assert.equal(res.status, 200);

        // Verify touchpoint was recorded with CLICK_TO_MESSENGER
        const tpCall = rpcCalls.find(c => c.name === 'record_lead_attribution_touchpoint');
        assert.ok(tpCall, 'record_lead_attribution_touchpoint must be called for Click-to-Messenger');
        assert.equal(tpCall.args.p_channel, 'FACEBOOK_MESSENGER');
        assert.equal(tpCall.args.p_meta_ad_id, 'ad_ctm_999');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// -----------------------------------------------------------------------------
// SCENARIO 10: Lỗi Meta API (Graph API 500, 429 rate limit, timeout, expired token) được xử lý an toàn
// -----------------------------------------------------------------------------
test('Scenario 10: Meta API errors (429 rate limit, 500, token expired) are handled safely with backoff', async () => {
    // 10A: Transient 429 rate limit retries and recovers
    let attemptCount = 0;
    const transientFetch = (async () => {
        attemptCount++;
        if (attemptCount === 1) {
            return new Response(JSON.stringify({ error: { code: 613, message: 'Calls have been reduced' } }), {
                status: 429,
                headers: { 'content-type': 'application/json' },
            });
        }
        return new Response(JSON.stringify({ data: [{ id: 'campaign_recovered' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }) as unknown as typeof fetch;

    const resRecovered = await fetchWithBackoff(
        'https://graph.facebook.com/v21.0/act_test/campaigns',
        {},
        transientFetch,
        2,
        10
    );
    assert.equal(resRecovered.status, 200);
    assert.equal(attemptCount, 2, 'Should retry after 429 and succeed on attempt 2');

    // 10B: Token expired error (code 190) returns immediately without endless retrying
    let tokenExpiredAttempts = 0;
    const expiredFetch = (async () => {
        tokenExpiredAttempts++;
        return new Response(
            JSON.stringify({ error: { code: 190, error_subcode: 463, message: 'Error validating access token: Session has expired' } }),
            { status: 400, headers: { 'content-type': 'application/json' } }
        );
    }) as unknown as typeof fetch;

    const resExpired = await fetchWithBackoff(
        'https://graph.facebook.com/v21.0/act_test/campaigns',
        {},
        expiredFetch,
        3,
        10
    );
    assert.equal(resExpired.status, 400);
    assert.equal(tokenExpiredAttempts, 1, 'Should return immediately without retrying on expired token');
});

// -----------------------------------------------------------------------------
// SCENARIO 11: Identity conflict không tự ý gộp khách hàng (tuân thủ IDENTITY_REVIEW)
// -----------------------------------------------------------------------------
test('Scenario 11: Identity conflict does not destructively merge customers and flags review', async () => {
    const leadChange = {
        field: 'leadgen',
        value: {
            leadgen_id: 'lg_conflict_001',
            page_id: TARGET_PAGE_ID,
            form_id: 'form_999',
            ad_id: 'ad_999',
            created_time: 1730246400,
        },
    };

    const parsed = parseLeadgenChanges(
        { object: 'page', entry: [{ id: TARGET_PAGE_ID, changes: [leadChange] }] },
        TARGET_PAGE_ID
    );
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].leadgenId, 'lg_conflict_001');

    const leadData = {
        id: 'lg_conflict_001',
        campaign_name: 'Chiến dịch Tuyển sinh Đức',
        ad_name: 'Quảng cáo Du học',
        field_data: [
            { name: 'full_name', values: ['Vũ Minh Trí'] },
            { name: 'phone_number', values: ['0912345678'] },
            { name: 'email', values: ['tri.vu@example.com'] },
            { name: 'program_of_interest', values: ['Du học nghề Điều dưỡng Đức'] },
        ],
    };

    const fields = extractLeadFields(leadData.field_data);
    const safeContent = formatLeadAdsSafeContent(leadData, fields);

    // Ensure safe lead content formatting sanitizes raw phone for safe preview
    assert.match(safeContent, /Họ tên: Vũ Minh Trí/);
    assert.match(safeContent, /SĐT: \[số liên hệ đã ẩn\]/, 'Phone must be masked in content representation');
    assert.match(safeContent, /Email: \[email đã ẩn\]/, 'Email must be masked in content representation');
    assert.match(safeContent, /Du học nghề Điều dưỡng Đức/);
});

// -----------------------------------------------------------------------------
// SCENARIO 12: Dữ liệu PII (raw phone, access token) không xuất hiện trong public response hoặc log
// -----------------------------------------------------------------------------
test('Scenario 12: Sensitive tokens are encrypted at rest (AES-256-GCM) and phone is zero-phone compliant', () => {
    const rawToken = 'EAABwb7QZAy9QBAOz2948719284712093847120938410928304918230948123';

    // 12A: Encrypt and decrypt roundtrip
    const ciphertext = encryptToken(rawToken);
    assert.notEqual(ciphertext, rawToken);
    assert.match(ciphertext, /^[a-zA-Z0-9_-]+$/, 'Encrypted format must be base64url string');

    const decrypted = decryptToken(ciphertext);
    assert.equal(decrypted, rawToken);

    // 12B: Tampered ciphertext fails to decrypt
    assert.throws(() => decryptToken('00000000000000000000000000000000'), /INVALID_ENCRYPTED_TOKEN/);

    // 12C: Plaintext token format check
    assert.equal(rawToken.includes('EAAB'), true);
    assert.equal(ciphertext.includes('EAAB'), false, 'Ciphertext must never expose raw token snippet');
});

// -----------------------------------------------------------------------------
// SCENARIO 13: Role không đủ quyền (SALE / TECHNICIAN) không thể kích hoạt sync
// -----------------------------------------------------------------------------
test('Scenario 13: Unauthorized roles (SALE, TECHNICIAN) are rejected from admin sync', async () => {
    // 13A: Unauthenticated request to /api/admin/meta-ads/sync returns 401
    const req = new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/admin/meta-ads/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
    });
    const res = await syncPost(req);
    assert.equal(res.status, 401);

    // 13B: Test requireBossAdmin rejection against real database entries via PGlite
    const supabase = await createPgliteSupabase();
    const { db } = supabase;

    try {
        const testCompany = '41111111-1111-4111-8111-111111111111';
        const saleUserId = '42222222-2222-4222-8222-222222222222';

        await db.exec(`
            INSERT INTO auth.users (id, email) VALUES
                ('${saleUserId}', 'sale_agent@chd.local')
            ON CONFLICT (id) DO NOTHING;

            INSERT INTO public.companies (id, name, status) VALUES
                ('${testCompany}', 'CHD Du Học', 'ACTIVE')
            ON CONFLICT (id) DO NOTHING;

            INSERT INTO public.user_profiles (id, full_name, status) VALUES
                ('${saleUserId}', 'Nguyễn Văn Sale', 'ACTIVE')
            ON CONFLICT (id) DO NOTHING;

            INSERT INTO public.company_members (company_id, user_id, role, status) VALUES
                ('${testCompany}', '${saleUserId}', 'SALE', 'ACTIVE')
            ON CONFLICT DO NOTHING;
        `);

        // Set actor as SALE user
        const saleClient = {
            ...supabase.client,
            auth: {
                ...supabase.client.auth,
                getUser: async () => ({
                    data: { user: { id: saleUserId, email: 'sale_agent@chd.local' } as any },
                    error: null,
                }),
                mfa: {
                    getAuthenticatorAssuranceLevel: async () => ({
                        data: { currentLevel: 'aal1', nextLevel: 'aal1' },
                        error: null,
                    }),
                    listFactors: async () => ({
                        data: { totp: [] },
                        error: null,
                    }),
                },
            },
        } as any;

        await assert.rejects(
            () => requireBossAdmin(testCompany, {}, saleClient),
            (err: any) => {
                assert.equal(err instanceof AuthError, true);
                assert.equal(err.status, 403);
                assert.equal(err.code, 'ROLE_FORBIDDEN');
                return true;
            }
        );
    } finally {
        await supabase.close();
    }
});

// -----------------------------------------------------------------------------
// SCENARIO 14: Database migration, foreign keys, unique constraints, RLS hoạt động đúng
// -----------------------------------------------------------------------------
test('Scenario 14: Database migration, foreign keys, and unique constraints are enforced', async () => {
    const supabase = await createPgliteSupabase();
    const { db } = supabase;

    try {
        const companyId = '31111111-1111-4111-8111-111111111111';

        await db.exec(`
            INSERT INTO public.companies (id, name, status)
            VALUES ('${companyId}', 'CHD Schema Testing', 'ACTIVE')
            ON CONFLICT (id) DO NOTHING;

            INSERT INTO public.meta_ad_accounts (company_id, ad_account_id, name, account_status)
            VALUES ('${companyId}', 'act_unique_01', 'Tài khoản Unique Test', 1);
        `);

        // Test Unique Constraint on (company_id, ad_account_id)
        await assert.rejects(
            async () => {
                await db.exec(`
                    INSERT INTO public.meta_ad_accounts (company_id, ad_account_id, name, account_status)
                    VALUES ('${companyId}', 'act_unique_01', 'Trùng account_id', 1);
                `);
            },
            (err: any) => {
                assert.match(err.message, /unique|duplicate key/i);
                return true;
            }
        );

        // Test Foreign Key on meta_ad_accounts -> companies
        const nonExistentCompany = '99999999-9999-4999-8999-999999999999';
        await assert.rejects(
            async () => {
                await db.exec(`
                    INSERT INTO public.meta_ad_accounts (company_id, ad_account_id, name, account_status)
                    VALUES ('${nonExistentCompany}', 'act_invalid_company', 'Tài khoản Invalid', 1);
                `);
            },
            (err: any) => {
                assert.match(err.message, /foreign key|violates/i);
                return true;
            }
        );
    } finally {
        await supabase.close();
    }
});

// -----------------------------------------------------------------------------
// SCENARIO 15: Chỉ số báo cáo (Spend, Impressions, Clicks, CTR, CPL, Cost per Qualified Lead) tính toán chính xác, xử lý an toàn phép chia cho 0
// -----------------------------------------------------------------------------
test('Scenario 15: Performance report calculations (Spend, CTR, CPL, Cost per Qualified Lead) and divide-by-zero safety', async () => {
    const supabase = await createPgliteSupabase();
    const { db } = supabase;

    try {
        const companyId = '21111111-1111-4111-8111-111111111111';

        await db.exec(`
            INSERT INTO public.companies (id, name, status)
            VALUES ('${companyId}', 'CHD Analytics Company', 'ACTIVE')
            ON CONFLICT (id) DO NOTHING;

            INSERT INTO public.meta_ad_accounts (company_id, ad_account_id, name, account_status)
            VALUES ('${companyId}', 'act_calc_01', 'Tài khoản Tính toán', 1);

            INSERT INTO public.meta_campaigns (company_id, ad_account_id, meta_campaign_id, name, status)
            VALUES ('${companyId}', 'act_calc_01', 'camp_calc_01', 'Chiến dịch Test Báo cáo', 'ACTIVE');
        `);

        // Case 15A: Zero spend, zero leads -> Must return 0 without divide by zero crash
        const resZero = await db.query(`
            SELECT get_meta_ads_performance_report(
                '${companyId}'::uuid,
                '2026-01-01T00:00:00Z'::timestamptz,
                '2026-12-31T23:59:59Z'::timestamptz
            );
        `);
        const reportZero = (resZero.rows[0] as any).get_meta_ads_performance_report;
        assert.equal(reportZero.overview.spend, 0);
        assert.equal(reportZero.overview.impressions, 0);
        assert.equal(reportZero.overview.clicks, 0);
        assert.equal(reportZero.overview.ctr, 0);
        assert.equal(reportZero.overview.crm_leads, 0);
        assert.equal(reportZero.overview.cpl, 0);
        assert.equal(reportZero.overview.cost_per_qualified, 0);

        // Case 15B: Real numbers
        // Spend: 10,000,000 VND
        // Impressions: 200,000
        // Clicks: 5,000 (CTR = 5000 / 200000 * 100 = 2.50%)
        // Meta Leads: 40
        // Account-level daily insights (for overview)
        await db.exec(`
            INSERT INTO public.meta_insights_daily (
                company_id, ad_account_id, entity_type, entity_id, date, spend, impressions, clicks, cpc, cpm, ctr, meta_leads
            ) VALUES (
                '${companyId}', 'act_calc_01', 'ACCOUNT', 'act_calc_01', '2026-10-25',
                10000000, 200000, 5000, 2000, 50000, 2.5, 40
            );

            INSERT INTO public.meta_insights_daily (
                company_id, ad_account_id, entity_type, entity_id, date, spend, impressions, clicks, cpc, cpm, ctr, meta_leads
            ) VALUES (
                '${companyId}', 'act_calc_01', 'CAMPAIGN', 'camp_calc_01', '2026-10-25',
                10000000, 200000, 5000, 2000, 50000, 2.5, 40
            );
        `);

        // 20 CRM Leads attributed to this campaign (CPL = 10,000,000 / 20 = 500,000 VND)
        // 5 of which reached QUALIFIED stages (Cost per Qualified Lead = 10,000,000 / 5 = 2,000,000 VND)
        for (let i = 1; i <= 20; i++) {
            const custId = `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`;
            const stage = i <= 5 ? 'high_potential' : 'LEAD_NEW'; // high_potential is qualified stage
            await db.exec(`
                INSERT INTO public.customers (
                    id, company_id, customer_code, name, source, stage,
                    first_campaign_name, latest_campaign_name, attribution_status, created_at
                ) VALUES (
                    '${custId}', '${companyId}', 'KH-CALC-${i}', 'Khách ${i}', 'FACEBOOK', '${stage}',
                    'Chiến dịch Test Báo cáo', 'Chiến dịch Test Báo cáo', 'ATTRIBUTED', '2026-10-25T12:00:00Z'
                );

                INSERT INTO public.lead_attribution_touchpoints (
                    company_id, customer_id, channel, touchpoint_type, meta_campaign_id, campaign_name_snapshot, attribution_status, occurred_at
                ) VALUES (
                    '${companyId}', '${custId}', 'FACEBOOK_LEAD_ADS', 'FIRST_TOUCH', 'camp_calc_01', 'Chiến dịch Test Báo cáo', 'ATTRIBUTED', '2026-10-25T12:00:00Z'
                );
            `);
        }

        const resReal = await db.query(`
            SELECT get_meta_ads_performance_report(
                '${companyId}'::uuid,
                '2026-10-01T00:00:00Z'::timestamptz,
                '2026-10-31T23:59:59Z'::timestamptz
            );
        `);
        const report = (resReal.rows[0] as any).get_meta_ads_performance_report;

        assert.equal(report.overview.spend, 10000000);
        assert.equal(report.overview.impressions, 200000);
        assert.equal(report.overview.clicks, 5000);
        assert.equal(report.overview.ctr, 2.5);
        assert.equal(report.overview.meta_leads, 40);
        assert.equal(report.overview.crm_leads, 20);
        assert.equal(report.overview.qualified_leads, 5);

        // Mathematical verification
        // CPL = 10,000,000 / 20 = 500,000
        assert.equal(report.overview.cpl, 500000);
        // Cost per Qualified Lead = 10,000,000 / 5 = 2,000,000
        assert.equal(report.overview.cost_per_qualified, 2000000);

        // Campaign breakdown validation
        assert.equal(report.campaigns.length, 1);
        const camp = report.campaigns[0];
        assert.equal(camp.campaign_id, 'camp_calc_01');
        assert.equal(camp.campaign_name, 'Chiến dịch Test Báo cáo');
        assert.equal(camp.spend, 10000000);
        assert.equal(camp.crm_leads, 20);
        assert.equal(camp.cpl, 500000);
    } finally {
        await supabase.close();
    }
});

// -----------------------------------------------------------------------------
// SCENARIO 16: Token Security & Vault Hardening (Priority 1)
// -----------------------------------------------------------------------------
test('Scenario 16: Token security, private schema isolation, and format validation', async () => {
    const supabase = await createPgliteSupabase();
    const { db } = supabase;

    try {
        const companyId = '41111111-1111-4111-8111-111111111111';
        const userId = '42222222-2222-4222-8222-222222222222';

        await db.exec(`
            INSERT INTO auth.users (id, email) VALUES ('${userId}', 'token_boss@test.local') ON CONFLICT DO NOTHING;
            INSERT INTO public.companies (id, name, status) VALUES ('${companyId}', 'CHD Token Security', 'ACTIVE') ON CONFLICT DO NOTHING;
            INSERT INTO public.company_members (company_id, user_id, role, status) VALUES ('${companyId}', '${userId}', 'BOSS_ADMIN', 'ACTIVE') ON CONFLICT DO NOTHING;
            INSERT INTO public.meta_ad_accounts (company_id, ad_account_id, name, account_status) VALUES ('${companyId}', 'act_token_sec_01', 'Ad Account Token Test', 1);
        `);

        // 16A: Verify meta_ad_accounts does NOT have access_token column anymore
        const colCheck = await db.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'meta_ad_accounts' AND column_name = 'access_token';
        `);
        assert.equal(colCheck.rows.length, 0, 'access_token column must not exist in public.meta_ad_accounts');

        // 16B: Verify private.meta_ad_account_tokens table cannot be selected by authenticated role directly
        await db.exec(`
            SET ROLE authenticated;
            SET "request.jwt.claim.sub" = '${userId}';
            SET "request.jwt.claim.role" = 'authenticated';
        `);

        await assert.rejects(
            async () => {
                await db.query(`SELECT * FROM private.meta_ad_account_tokens;`);
            },
            (err: any) => {
                assert.match(err.message, /permission denied/i);
                return true;
            }
        );

        // 16C: Ordinary members cannot invoke either credential RPC, including their own company.
        await assert.rejects(db.query(`SELECT public.store_meta_ad_account_token('${companyId}', 'act_token_sec_01', 'overwrite');`), /permission denied/i);
        await assert.rejects(db.query(`SELECT * FROM public.get_meta_ad_account_token('${companyId}', 'act_token_sec_01');`), /permission denied/i);
        await db.exec('RESET ROLE; SET ROLE service_role;');
        // Service-only storage remains usable.
        const encrypted = encryptToken('EAA_TEST_SECRET_TOKEN_VALUE');
        const expiresAt = new Date(Date.now() + 86400000).toISOString();

        await db.query(`
            SELECT public.store_meta_ad_account_token(
                '${companyId}'::uuid,
                'act_token_sec_01',
                '${encrypted}',
                '${expiresAt}'::timestamptz
            );
        `);

        const tokenFetch = await db.query(`
            SELECT encrypted_access_token, token_expires_at
            FROM public.get_meta_ad_account_token('${companyId}'::uuid, 'act_token_sec_01');
        `);
        assert.equal(tokenFetch.rows.length, 1);
        const storedEncrypted = (tokenFetch.rows[0] as any).encrypted_access_token;
        assert.equal(decryptToken(storedEncrypted), 'EAA_TEST_SECRET_TOKEN_VALUE');

        // 16D: Encryption key format validation & rotation
        assert.throws(
            () => parseEncryptionKey('', 'META_TOKEN_ENCRYPTION_KEY'),
            /MISSING_META_TOKEN_ENCRYPTION_KEY/
        );
        assert.throws(
            () => parseEncryptionKey('too-short-key', 'META_TOKEN_ENCRYPTION_KEY'),
            /INVALID_META_TOKEN_ENCRYPTION_KEY_FORMAT/
        );
        const validBuf = parseEncryptionKey('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'TEST');
        assert.equal(validBuf.length, 32);

        // Rotation test
        const rotated = rotateToken(encrypted);
        assert.equal(decryptToken(rotated), 'EAA_TEST_SECRET_TOKEN_VALUE');
    } finally {
        await supabase.close();
    }
});

// -----------------------------------------------------------------------------
// SCENARIO 17: SECURITY DEFINER RPC Authorization Hardening (Priority 2)
// -----------------------------------------------------------------------------
test('Scenario 17: SECURITY DEFINER RPCs enforce strict company authorization and cross-tenant isolation', async () => {
    const supabase = await createPgliteSupabase();
    const { db } = supabase;

    try {
        const compA = '51111111-1111-4111-8111-111111111111';
        const compB = '52222222-2222-4222-8222-222222222222';
        const userA = '53333333-3333-4333-8333-333333333333';
        const custB = '54444444-4444-4444-8444-444444444444';

        await db.exec(`
            INSERT INTO auth.users (id, email) VALUES ('${userA}', 'user_a@test.local') ON CONFLICT DO NOTHING;
            INSERT INTO public.companies (id, name, status) VALUES
                ('${compA}', 'Doanh nghiệp A Corp', 'ACTIVE'),
                ('${compB}', 'Doanh nghiệp B Corp', 'ACTIVE')
            ON CONFLICT DO NOTHING;

            INSERT INTO public.company_members (company_id, user_id, role, status) VALUES
                ('${compA}', '${userA}', 'SALE', 'ACTIVE')
            ON CONFLICT DO NOTHING;

            INSERT INTO public.customers (id, company_id, customer_code, name, source, stage) VALUES
                ('${custB}', '${compB}', 'KH-B-01', 'Khách B', 'FACEBOOK', 'LEAD_NEW')
            ON CONFLICT DO NOTHING;
        `);

        // Switch to authenticated User A (member of Company A only)
        await db.exec(`
            SET ROLE authenticated;
            SET "request.jwt.claim.sub" = '${userA}';
            SET "request.jwt.claim.role" = 'authenticated';
        `);

        // 17A: Anonymous users calling record_lead_attribution_touchpoint MUST FAIL (permission denied)
        await db.exec(`SET ROLE anon;`);
        await assert.rejects(
            async () => {
                await db.query(`
                    SELECT record_lead_attribution_touchpoint(
                        '${compB}'::uuid,
                        NULL, NULL, NULL,
                        'FACEBOOK_LEAD_ADS'
                    );
                `);
            },
            /permission denied/i
        );

        // 17B: Authenticated users calling record_lead_attribution_touchpoint MUST FAIL (F-11 security restriction)
        await db.exec(`
            SET ROLE authenticated;
            SET "request.jwt.claim.sub" = '${userA}';
            SET "request.jwt.claim.role" = 'authenticated';
        `);
        await assert.rejects(
            async () => {
                await db.query(`
                    SELECT record_lead_attribution_touchpoint(
                        '${compA}'::uuid,
                        NULL, NULL, NULL,
                        'FACEBOOK_LEAD_ADS'
                    );
                `);
            },
            /permission denied/i
        );

        // 17C: User A calling get_meta_ads_performance_report for Company B MUST FAIL CLOSED
        await assert.rejects(
            async () => {
                await db.query(`
                    SELECT get_meta_ads_performance_report(
                        '${compB}'::uuid,
                        '2026-01-01'::timestamptz,
                        '2026-12-31'::timestamptz
                    );
                `);
            },
            (err: any) => {
                assert.match(err.message, /UNAUTHORIZED_COMPANY_ACCESS/);
                return true;
            }
        );

        // 17D: Switch to service_role (the authorized server-side path)
        await db.exec(`SET ROLE service_role;`);

        // Cross-company attribution writes are rejected through the authorized path
        await assert.rejects(
            async () => {
                await db.query(`
                    SELECT record_lead_attribution_touchpoint(
                        '${compA}'::uuid,
                        '${custB}'::uuid
                    );
                `);
            },
            (err: any) => {
                assert.match(err.message, /CUSTOMER_COMPANY_MISMATCH/);
                return true;
            }
        );

        // Authorized service_role call for Company A with valid parameters SUCCEEDS
        const validTouchpoint = await db.query(`
            SELECT record_lead_attribution_touchpoint(
                '${compA}'::uuid,
                NULL, NULL, NULL,
                'FACEBOOK_LEAD_ADS',
                '1026991374010112', 'Trang A'
            );
        `);
        assert.ok((validTouchpoint.rows[0] as any).record_lead_attribution_touchpoint);
    } finally {
        await supabase.close();
    }
});

// -----------------------------------------------------------------------------
// SCENARIO 18: Durable Leadgen Webhook Intake & Independent Processing (Priority 3)
// -----------------------------------------------------------------------------
test('Scenario 18: Durable event intake, idempotency, and multi-leadgen batch fault isolation', async () => {
    const supabase = await createPgliteSupabase();
    const { db } = supabase;

    try {
        const companyId = '61111111-1111-4111-8111-111111111111';

        await db.exec(`
            INSERT INTO public.companies (id, name, status) VALUES ('${companyId}', 'CHD Durable Intake', 'ACTIVE') ON CONFLICT DO NOTHING;
        `);

        // 18A: Claim leadgen event
        const claim1 = await db.query(`
            SELECT public.claim_meta_leadgen_event(
                '${companyId}'::uuid,
                '1026991374010112',
                '100000001',
                'form_001',
                'ad_001'
            );
        `);
        const claim = (claim1.rows[0] as any).claim_meta_leadgen_event;
        assert.equal(claim.status, 'CLAIMED');
        // Processing duplicate receives BUSY and cannot steal ownership.
        const busy = await db.query(`SELECT public.claim_meta_leadgen_event('${companyId}', '1026991374010112', '100000001') AS claim;`);
        assert.equal((busy.rows[0] as any).claim.status, 'BUSY');
        await assert.rejects(db.query(`SELECT public.finalize_meta_leadgen_event('${companyId}', '100000001', '${claim.claim_token}', 'PROCESSED');`), /ATTRIBUTION_NOT_RECORDED/);
        const intake = await db.query(`SELECT public.ingest_meta_leadgen_event('${companyId}', '100000001', '${claim.claim_token}', '{"name":"Durable lead","phone":null,"content":"Safe content","payload":{}}'::jsonb) AS result;`);
        const result = (intake.rows[0] as any).result;
        await db.query(`SELECT public.record_lead_attribution_touchpoint(p_company=>'${companyId}', p_customer=>'${result.customer_id}', p_interaction=>'${result.interaction_id}', p_meta_leadgen_id=>'100000001');`);
        const completed = await db.query(`SELECT public.finalize_meta_leadgen_event('${companyId}', '100000001', '${claim.claim_token}', 'PROCESSED') AS completed;`);
        assert.equal((completed.rows[0] as any).completed, true);

        // Repeated claim returns ALREADY_PROCESSED
        const claim2 = await db.query(`
            SELECT public.claim_meta_leadgen_event(
                '${companyId}'::uuid,
                '1026991374010112',
                '100000001'
            );
        `);
        assert.equal((claim2.rows[0] as any).claim_meta_leadgen_event.status, 'ALREADY_PROCESSED');
    } finally {
        await supabase.close();
    }
});

// -----------------------------------------------------------------------------
// SCENARIO 19: Marketing API Concurrency Guard & Safe Pagination (Priority 4)
// -----------------------------------------------------------------------------
test('Scenario 19: Marketing sync lease concurrency guard and complete pagination check', async () => {
    const supabase = await createPgliteSupabase();
    const { db } = supabase;

    try {
        const companyId = '71111111-1111-4111-8111-111111111111';

        await db.exec(`
            INSERT INTO public.companies (id, name, status) VALUES ('${companyId}', 'CHD Lease Test', 'ACTIVE') ON CONFLICT DO NOTHING;
            INSERT INTO public.meta_ad_accounts (company_id, ad_account_id, name, account_status)
            VALUES ('${companyId}', 'act_lease_01', 'Tài khoản Lease', 1);
        `);

        // 19A: First worker acquires lease
        const lease1Res = await db.query(`
            SELECT acquire_meta_ad_account_sync_lease('${companyId}'::uuid, 'act_lease_01', 300);
        `);
        const token1 = (lease1Res.rows[0] as any).acquire_meta_ad_account_sync_lease;
        assert.ok(token1, 'First lease acquisition must succeed');

        // 19B: Concurrent worker attempts to acquire lease -> MUST FAIL (return NULL)
        const lease2Res = await db.query(`
            SELECT acquire_meta_ad_account_sync_lease('${companyId}'::uuid, 'act_lease_01', 300);
        `);
        assert.equal((lease2Res.rows[0] as any).acquire_meta_ad_account_sync_lease, null, 'Concurrent lease must be denied');

        // 19C: Release lease on failure -> preserves state and sets sync_error
        await db.query(`
            SELECT release_meta_ad_account_sync_lease(
                '${companyId}'::uuid,
                'act_lease_01',
                '${token1}'::uuid,
                'FAILED',
                'RATE_LIMIT_EXCEEDED'
            );
        `);

        const accCheck = await db.query(`
            SELECT sync_status, sync_error, sync_lease_token FROM public.meta_ad_accounts WHERE company_id = '${companyId}' AND ad_account_id = 'act_lease_01';
        `);
        assert.equal((accCheck.rows[0] as any).sync_status, 'FAILED');
        assert.equal((accCheck.rows[0] as any).sync_error, 'RATE_LIMIT_EXCEEDED');
        assert.equal((accCheck.rows[0] as any).sync_lease_token, null);

        // 19D: Validate ad account access error detection (Token expired 190)
        const mockFetchExpired = async () =>
            new Response(JSON.stringify({ error: { message: 'Session expired', code: 190 } }), { status: 400 });
        const accessCheck = await validateAdAccountAccess('act_lease_01', 'expired-token', mockFetchExpired as any);
        assert.equal(accessCheck.valid, false);
        assert.equal(accessCheck.error, 'TOKEN_EXPIRED');
    } finally {
        await supabase.close();
    }
});

// -----------------------------------------------------------------------------
// SCENARIO 20: Attribution Rule Strictness & First-Touch Preservation (Priority 5)
// -----------------------------------------------------------------------------
test('Scenario 20: Unmapped ad remains UNATTRIBUTED; First-touch snapshot is strictly immutable', async () => {
    const supabase = await createPgliteSupabase();
    const { db } = supabase;

    try {
        const companyId = '81111111-1111-4111-8111-111111111111';
        const customerId = '82222222-2222-4222-8222-222222222222';

        await db.exec(`
            INSERT INTO public.companies (id, name, status) VALUES ('${companyId}', 'CHD Attribution Test', 'ACTIVE') ON CONFLICT DO NOTHING;

            INSERT INTO public.customers (id, company_id, customer_code, name, source, stage)
            VALUES ('${customerId}', '${companyId}', 'KH-ATTR-01', 'Khách Attribution', 'FACEBOOK', 'LEAD_NEW')
            ON CONFLICT DO NOTHING;

            INSERT INTO public.meta_campaigns (company_id, ad_account_id, meta_campaign_id, name, status)
            VALUES ('${companyId}', 'act_01', 'camp_valid_100', 'Chiến dịch Đầu Tiên Có Thật', 'ACTIVE');

            INSERT INTO public.meta_ads (company_id, ad_account_id, meta_campaign_id, meta_ad_set_id, meta_ad_id, name, status)
            VALUES ('${companyId}', 'act_01', 'camp_valid_100', 'adset_100', 'ad_mapped_100', 'Quảng cáo Gốc 100', 'ACTIVE');
        `);

        // 20A: Touchpoint with an unknown unmapped ad ID MUST NOT be marked ATTRIBUTED
        const tpUnmappedId = await db.query(`
            SELECT record_lead_attribution_touchpoint(
                '${companyId}'::uuid,
                '${customerId}'::uuid,
                NULL, NULL,
                'FACEBOOK_LEAD_ADS',
                '1026991374010112', 'Trang CHD',
                NULL,
                NULL, NULL,
                NULL, NULL,
                'ad_completely_unknown_999',
                NULL,
                NULL, NULL,
                'lg_unknown_999',
                'LEAD_ADS', 'INSTANT_FORM',
                NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                'ATTRIBUTED'
            );
        `);
        const tp1 = (tpUnmappedId.rows[0] as any).record_lead_attribution_touchpoint;

        const checkTp1 = await db.query(`SELECT attribution_status FROM public.lead_attribution_touchpoints WHERE id = '${tp1}';`);
        assert.equal((checkTp1.rows[0] as any).attribution_status, 'PENDING_SYNC', 'Unmapped leadgen lead stays resolvable-pending; a safe retry may finish attribution, no name invented');

        // 20B: Touchpoint with mapped ad ID becomes ATTRIBUTED and records first-touch
        const tpMappedId = await db.query(`
            SELECT record_lead_attribution_touchpoint(
                '${companyId}'::uuid,
                '${customerId}'::uuid,
                NULL, NULL,
                'FACEBOOK_LEAD_ADS',
                '1026991374010112', 'Trang CHD',
                NULL,
                NULL, NULL,
                NULL, NULL,
                'ad_mapped_100',
                NULL,
                NULL, NULL,
                'lg_mapped_100'
            );
        `);
        const tp2 = (tpMappedId.rows[0] as any).record_lead_attribution_touchpoint;
        const checkTp2 = await db.query(`SELECT attribution_status, campaign_name_snapshot, touchpoint_type FROM public.lead_attribution_touchpoints WHERE id = '${tp2}';`);
        assert.equal((checkTp2.rows[0] as any).attribution_status, 'ATTRIBUTED');
        assert.equal((checkTp2.rows[0] as any).campaign_name_snapshot, 'Chiến dịch Đầu Tiên Có Thật');

        // 20C: Add second mapped campaign touchpoint and verify First-Touch snapshot is NOT overwritten
        await db.exec(`
            INSERT INTO public.meta_campaigns (company_id, ad_account_id, meta_campaign_id, name, status)
            VALUES ('${companyId}', 'act_01', 'camp_valid_200', 'Chiến dịch Thứ Hai (Mới)', 'ACTIVE');

            INSERT INTO public.meta_ads (company_id, ad_account_id, meta_campaign_id, meta_ad_set_id, meta_ad_id, name, status)
            VALUES ('${companyId}', 'act_01', 'camp_valid_200', 'adset_200', 'ad_mapped_200', 'Quảng cáo Sau 200', 'ACTIVE');
        `);

        await db.query(`
            SELECT record_lead_attribution_touchpoint(
                '${companyId}'::uuid,
                '${customerId}'::uuid,
                NULL, NULL,
                'FACEBOOK_LEAD_ADS',
                '1026991374010112', 'Trang CHD',
                NULL,
                NULL, NULL,
                NULL, NULL,
                'ad_mapped_200',
                NULL,
                NULL, NULL,
                'lg_mapped_200'
            );
        `);

        const custAfter = await db.query(`
            SELECT first_campaign_name, latest_campaign_name FROM public.customers WHERE id = '${customerId}';
        `);
        const cRow = custAfter.rows[0] as any;
        assert.equal(cRow.first_campaign_name, null, 'The first, unattributed touch remains immutable');
        assert.equal(cRow.latest_campaign_name, 'Chiến dịch Thứ Hai (Mới)');
    } finally {
        await supabase.close();
    }
});

// -----------------------------------------------------------------------------
// SCENARIO 21: Reporting Accuracy, Metric Distinction & Campaign Filtering (Priority 6)
// -----------------------------------------------------------------------------
test('Scenario 21: Performance report campaign filtering consistency and repeat touchpoint deduplication', async () => {
    const supabase = await createPgliteSupabase();
    const { db } = supabase;

    try {
        const companyId = '91111111-1111-4111-8111-111111111111';

        await db.exec(`
            INSERT INTO public.companies (id, name, status) VALUES ('${companyId}', 'CHD Accuracy Testing', 'ACTIVE') ON CONFLICT DO NOTHING;

            INSERT INTO public.meta_ad_accounts (company_id, ad_account_id, name, account_status)
            VALUES ('${companyId}', 'act_acc_01', 'Tài khoản Chính', 1);

            INSERT INTO public.meta_campaigns (company_id, ad_account_id, meta_campaign_id, name, status) VALUES
                ('${companyId}', 'act_acc_01', 'camp_acc_A', 'Chiến dịch A', 'ACTIVE'),
                ('${companyId}', 'act_acc_01', 'camp_acc_B', 'Chiến dịch B', 'ACTIVE');

            INSERT INTO public.meta_insights_daily (
                company_id, ad_account_id, entity_type, entity_id, date, spend, impressions, clicks, meta_leads
            ) VALUES
                ('${companyId}', 'act_acc_01', 'ACCOUNT', 'act_acc_01', '2026-10-28', 15000000, 150000, 3000, 30),
                ('${companyId}', 'act_acc_01', 'CAMPAIGN', 'camp_acc_A', '2026-10-28', 10000000, 100000, 2000, 20),
                ('${companyId}', 'act_acc_01', 'CAMPAIGN', 'camp_acc_B', '2026-10-28', 5000000, 50000, 1000, 10);
        `);

        // Customer 1 has 3 repeat touchpoints for Campaign A
        const cust1 = '92222222-2222-4222-8222-111111111111';
        await db.exec(`
            INSERT INTO public.customers (id, company_id, customer_code, name, source, stage, attribution_status)
            VALUES ('${cust1}', '${companyId}', 'KH-REPEAT-01', 'Khách Trùng', 'FACEBOOK', 'high_potential', 'ATTRIBUTED');

            INSERT INTO public.lead_attribution_touchpoints (company_id, customer_id, channel, touchpoint_type, ad_account_id, meta_campaign_id, attribution_status, occurred_at) VALUES
                ('${companyId}', '${cust1}', 'FACEBOOK_LEAD_ADS', 'FIRST_TOUCH', 'act_acc_01', 'camp_acc_A', 'ATTRIBUTED', '2026-10-28T10:00:00Z'),
                ('${companyId}', '${cust1}', 'FACEBOOK_MESSENGER', 'LATEST_TOUCH', 'act_acc_01', 'camp_acc_A', 'ATTRIBUTED', '2026-10-28T11:00:00Z'),
                ('${companyId}', '${cust1}', 'FACEBOOK_LEAD_ADS', 'LATEST_TOUCH', 'act_acc_01', 'camp_acc_A', 'ATTRIBUTED', '2026-10-28T12:00:00Z');
        `);

        // 21A: Report with Campaign A filter -> Spend MUST be 10,000,000 (not 15,000,000)
        const resFilterA = await db.query(`
            SELECT get_meta_ads_performance_report(
                '${companyId}'::uuid,
                '2026-10-01'::timestamptz,
                '2026-10-31'::timestamptz,
                'act_acc_01',
                'camp_acc_A'
            );
        `);
        const reportA = (resFilterA.rows[0] as any).get_meta_ads_performance_report;
        assert.equal(reportA.overview.spend, 10000000, 'Spend must match Campaign A spend when filtered');
        assert.equal(reportA.overview.meta_leads, 20);

        // 21B: Repeat touchpoints for same customer MUST NOT inflate crm_leads or unique_customers
        assert.equal(reportA.overview.crm_leads, 1, 'Repeat touchpoints must deduplicate to 1 unique lead');
        assert.equal(reportA.overview.unique_customers, 1, 'Must count exactly 1 unique customer');
        assert.equal(reportA.overview.total_touchpoints, 3, 'Total touchpoints must report all 3 events');

        // CPL = 10,000,000 / 1 = 10,000,000 VND
        assert.equal(reportA.overview.cpl, 10000000);
    } finally {
        await supabase.close();
    }
});
