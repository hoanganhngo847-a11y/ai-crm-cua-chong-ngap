import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPgliteSupabase } from '../zalo/helpers/pglite-supabase';
import { processLeadAdsChange } from '../../features/omnichannel/facebook/lead-ads';

const company = 'd1111111-1111-4111-8111-111111111111';
const page = '1026991374010112';
const ad = 'verified-ad';
const quote = (v: unknown) => `'${String(typeof v === 'object' ? JSON.stringify(v) : v).replaceAll("'", "''")}'`;

test('intake and retry fail closed on conflicting, missing, late or asserted attribution evidence', async () => {
    const supabase = await createPgliteSupabase();
    const { db } = supabase;
    try {
        await db.exec(`INSERT INTO public.companies(id,name,status) VALUES ('${company}','Evidence matrix','ACTIVE');
            INSERT INTO public.meta_campaigns(company_id,ad_account_id,meta_campaign_id,name,status) VALUES ('${company}','act_1','real-campaign','Verified campaign','ACTIVE');
            INSERT INTO public.meta_ads(company_id,ad_account_id,meta_campaign_id,meta_ad_id,name,status) VALUES ('${company}','act_1','real-campaign','${ad}','Verified Ad','ACTIVE');`);
        const cases: Array<{ name: string; signed?: boolean; creative?: Record<string, unknown>; adId?: string; pageId?: string; flags?: Record<string, unknown>; expected?: string }> = [
            { name: 'signed', signed: true, expected: 'ATTRIBUTED' },
            { name: 'intake', creative: { pageId: page }, expected: 'ATTRIBUTED' },
            { name: 'no-proof' },
            { name: 'missing-page', signed: true, pageId: '' },
            { name: 'late', creative: { pageId: page, captureTiming: 'BACKFILL' } },
            { name: 'signed-cross-page', signed: true, creative: { pageId: '2222222222222222' } },
            { name: 'signed-conflict', signed: true, creative: { pageId: page, pageIdConflict: true } },
            { name: 'signed-bad-conflict', signed: true, creative: { pageId: page, pageIdConflict: 'invalid' } },
            { name: 'signed-cross-ad', signed: true, creative: { pageId: page, adId: 'other-ad' } },
            { name: 'signed-ad-conflict', signed: true, flags: { leadgen_ad_id_conflict: true } },
            { name: 'durable-conflict', signed: true, flags: { leadgen_page_evidence_conflict: true }, creative: { pageId: page, captureTiming: 'BACKFILL' } },
            { name: 'asserted-campaign', signed: true, adId: 'unmapped-ad' },
        ];
        for (const c of cases) {
            const adId = c.adId || ad;
            const pageId = c.pageId === undefined ? page : c.pageId;
            const context = {
                ...c.flags,
                ...(c.signed ? { leadgen_event_binding: { source: 'SIGNED_META_WEBHOOK', leadgenId: c.name, pageId, adId } } : {}),
                ...(c.creative ? { creative_snapshot: { source: 'META_MARKETING_API', captureTiming: 'AT_LEAD_INTAKE', adId, ...c.creative } } : {}),
            };
            const result = await db.query<{id: string}>(`SELECT public.record_lead_attribution_touchpoint(
                p_company=>'${company}',p_page_id=>${pageId ? quote(pageId) : 'NULL'},p_meta_ad_id=>${quote(adId)},
                p_meta_leadgen_id=>${quote(c.name)},p_meta_campaign_id=>'real-campaign',
                p_ads_context_data=>${quote(context)}::jsonb,p_attribution_status=>'ATTRIBUTED') AS id;`);
            const id = result.rows[0].id;
            const before = (await db.query<{attribution_status: string; meta_campaign_id: string | null}>(`SELECT attribution_status,meta_campaign_id FROM public.lead_attribution_touchpoints WHERE id=${quote(id)};`)).rows[0];
            assert.equal(before.attribution_status, c.expected || 'PENDING_SYNC', c.name);
            if (!c.expected) assert.equal(before.meta_campaign_id, null, c.name);
            // A later successful creative lookup cannot erase contradictory intake proof.
            if (c.name.startsWith('signed-') && c.creative) {
                await db.exec(`UPDATE public.lead_attribution_touchpoints SET ads_context_data=jsonb_set(ads_context_data,'{creative_snapshot}',
                    '{"source":"META_MARKETING_API","captureTiming":"BACKFILL","adId":"${ad}","pageId":"${page}"}') WHERE id=${quote(id)};`);
            }
        }
        await db.query(`SELECT public.retry_pending_lead_attribution('${company}');`);
        const rows = (await db.query<{meta_leadgen_id: string; attribution_status: string}>(`SELECT meta_leadgen_id,attribution_status FROM public.lead_attribution_touchpoints;`)).rows;
        for (const c of cases) assert.equal(rows.find(r => r.meta_leadgen_id === c.name)?.attribution_status, c.expected || 'PENDING_SYNC', `retry ${c.name}`);
        for (const role of ['anon', 'authenticated']) {
            const acl = (await db.query<{allowed: boolean}>(`SELECT has_function_privilege('${role}','public.retry_pending_lead_attribution(uuid,integer)','EXECUTE') AS allowed;`)).rows[0];
            assert.equal(acl.allowed, false);
        }
    } finally { await supabase.close(); }
});

test('a retry cannot manufacture signed proof absent from the immutable intake checkpoint', async () => {
    const saved = { ...process.env };
    const original = globalThis.fetch;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-test-key';
    process.env.META_EVIDENCE_TEST_TOKEN = 'local-meta-token';
    let context: Record<string, unknown> | undefined;
    const snapshot = { schemaVersion: 2, status: 'PARTIAL', source: 'META_MARKETING_API', captureTiming: 'AT_LEAD_INTAKE', capturedAt: '2026-11-04T00:00:00Z', adId: ad, format: 'UNKNOWN', headlines: [], descriptions: [], carouselAssets: [], imageAssets: [], videoAssets: [] };
    globalThis.fetch = (async (input, init) => {
        const url = new URL(String(input));
        const body = JSON.parse(String(init?.body || '{}'));
        if (url.pathname.endsWith('/claim_meta_leadgen_event')) return Response.json({ status: 'CLAIMED', claim_token: 'test-claim', ingest_args: { lead_data: { id: '99001', ad_id: ad, field_data: [] }, creative_snapshot: snapshot, payload: { ad_id: ad } } });
        if (url.pathname.endsWith('/ingest_meta_leadgen_event')) return Response.json({ customer_id: company, interaction_id: company });
        if (url.pathname.endsWith('/record_lead_attribution_touchpoint')) { context = body.p_ads_context_data; return Response.json(company); }
        if (url.pathname.endsWith('/mark_lead_attribution_phone_match') || url.pathname.endsWith('/finalize_meta_leadgen_event')) return Response.json(true);
        throw new Error('UNEXPECTED_REQUEST');
    }) as typeof fetch;
    try {
        await processLeadAdsChange({ page, company, name: 'Local test', tokenEnv: 'META_EVIDENCE_TEST_TOKEN' }, {
            kind: 'LEADGEN', adgroupId: null, createdTime: 1793750400, page, leadgenId: '99001', adId: ad, formId: '1', time: '2026-11-04T00:00:00Z', raw: {},
        });
        assert.ok(context);
        assert.equal(context.leadgen_event_binding, undefined, 'later delivery cannot introduce a new signed binding');
        assert.deepEqual(context.creative_snapshot, snapshot, 'intake creative remains immutable');
    } finally {
        globalThis.fetch = original;
        for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'META_EVIDENCE_TEST_TOKEN']) {
            if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
        }
    }
});
