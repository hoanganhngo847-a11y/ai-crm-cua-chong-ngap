/** Native PostgreSQL, independent connections, isolated disposable database.
 * The webhook runs through its real route + service RPCs. Only Graph and the
 * HTTP-to-SQL adapter are test doubles; SQL state machines are production code.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { PLATFORM_STUBS } from '../zalo/helpers/pglite-supabase';
import { POST } from '../../app/api/webhooks/meta/route';
import { decryptToken, encryptToken } from '../../features/omnichannel/facebook/token-vault';

const config = readFileSync('supabase/config.toml', 'utf8');
const project = config.match(/^project_id\s*=\s*"([\w-]+)"/m)?.[1];
assert.ok(project, 'deterministic local project required');
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321').hostname), 'local database only');
const container = `supabase_db_${project}`;
const db = `meta_ads_${randomUUID().replaceAll('-', '')}`;
const company = randomUUID();
const other = randomUUID();
const customer = randomUUID();
const page = '1026991374010112';
const appSecret = 'dummy-webhook-secret';
const q = (v: unknown) => v == null ? 'NULL' : `'${String(typeof v === 'object' ? JSON.stringify(v) : v).replaceAll("'", "''")}'`;
function sql(value: string, database = db) {
    return execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], {
        input: value, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], timeout: 90_000,
    }).trim();
}
function query(value: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = spawn('docker', ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db], { timeout: 30_000 });
        let output = '', error = '';
        proc.stdout.on('data', c => output += c);
        proc.stderr.on('data', c => error += c);
        proc.on('error', reject);
        // exit can precede stdout drainage on Linux; close waits for all stdio.
        proc.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(error || 'POSTGRES_TEST_PROCESS_FAILED')));
        proc.stdin.end(value);
    });
}
function webhook(lead: string, adId?: string) {
    const raw = JSON.stringify({ object: 'page', entry: [{ id: page, changes: [{ field: 'leadgen', value: { leadgen_id: lead, form_id: '123', page_id: page, created_time: 1793318400, ...(adId ? { ad_id: adId } : {}) } }] }] });
    return POST(new Request('http://localhost/api/webhooks/meta', { method: 'POST', body: raw,
        headers: { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex') } }));
}

test('PostgreSQL ownership, ACLs, verified attribution, webhook concurrency, and partial retry recovery', async () => {
    sql(`CREATE DATABASE ${db};`, 'postgres');
    const original = globalThis.fetch;
    let attributionFault = false, finalizeFault = false, claimFault = false, intakeFault = false;
    let snapshotAdSetArgument: unknown = undefined;
    let graphCalls = 0;
    let creativeCalls = 0;
    let creativeText = 'Nội dung tại thời điểm tiếp nhận';
    const savedEnv = { ...process.env };
    process.env.META_TOKEN_ENCRYPTION_KEY = 'b'.repeat(64);
    const encryptedCreativeToken = encryptToken('EAA_creative_snapshot_test_token');
    const encryptedPageToken = encryptToken('dummy-page-access-token');
    let pageTokenReads = 0, pageTokenFault = false;
    let malformedClaim = false, finalizeRpcFault = false;
    let graphGate: Promise<void> | null = null;
    let releaseGraph: (() => void) | undefined;
    try {
        // Roles are cluster-wide and already provided by supabase start.
        const stubs = PLATFORM_STUBS.replace(/CREATE ROLE[^;]+;/g, '');
        const migrations = readdirSync('supabase/migrations').filter(f => f.endsWith('.sql')).sort();
        sql(stubs + migrations.map(f => readFileSync(`supabase/migrations/${f}`, 'utf8')).join('\n'));
        const version = Number(sql('SHOW server_version_num;'));
        assert.ok(version >= 170000 && version < 180000, 'native integration requires PostgreSQL 17');
        assert.equal(sql('SHOW transaction_isolation;'), 'read committed');
        assert.equal(sql("SELECT to_regclass('public.meta_insights_daily') IS NULL AND to_regclass('public.meta_ad_sets') IS NULL AND to_regprocedure('public.get_meta_ads_performance_report(uuid,timestamptz,timestamptz,text,text)') IS NULL;"), 't', 'the released schema contains no advertising reporting API or reporting-only tables');
        assert.equal(sql("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('meta_campaigns','meta_ads') AND column_name IN ('daily_budget','lifetime_budget','objective','creative_id','creative_title','creative_body');"), '0');
        sql(`INSERT INTO public.companies(id,name,status) VALUES (${q(company)},'Meta native test','ACTIVE'),(${q(other)},'Other tenant','ACTIVE');
             INSERT INTO public.customers(id,company_id,name,source,stage) VALUES (${q(customer)},${q(company)},'First touch customer','FACEBOOK','LEAD_NEW');
             INSERT INTO public.meta_campaigns(company_id,ad_account_id,meta_campaign_id,name,status) VALUES (${q(company)},'act_1','campaign','Verified campaign','ACTIVE'),(${q(other)},'act_2','foreign','Foreign campaign','ACTIVE');
             INSERT INTO public.meta_ad_accounts(company_id,ad_account_id,name,currency,account_status) VALUES (${q(company)},'act_snapshot','Snapshot account','VND',1);
             INSERT INTO public.meta_ads(company_id,ad_account_id,meta_campaign_id,meta_ad_set_id,meta_ad_id,name,status) VALUES (${q(company)},'act_1','campaign','adset','ad','Verified ad','ACTIVE');
             INSERT INTO public.meta_campaigns(company_id,ad_account_id,meta_campaign_id,name,status) VALUES (${q(company)},'act_snapshot','campaign_snapshot','Verified snapshot campaign','ACTIVE');
             INSERT INTO public.meta_ads(company_id,ad_account_id,meta_campaign_id,meta_ad_set_id,meta_ad_id,name,status) VALUES (${q(company)},'act_snapshot','campaign_snapshot','adset_snapshot','ad_snapshot_1','Verified snapshot ad','ACTIVE');`);

        // True overlapping transactions on independent PostgreSQL connections.
        sql(`SET ROLE service_role;
             SELECT public.store_meta_ad_account_token(${q(company)},${q('__page__:' + page)},${q(encryptedPageToken)});
             SELECT public.store_meta_ad_account_token(${q(company)},'act_snapshot',${q(encryptedCreativeToken)});`);
        const call = `SET ROLE service_role; SELECT public.claim_meta_leadgen_event(${q(company)},${q(page)},'10000');`;
        const claims = await Promise.all(Array.from({ length: 8 }, () => query(call).then(JSON.parse)));
        assert.equal(claims.filter(c => c.status === 'CLAIMED').length, 1);
        assert.equal(claims.filter(c => c.status === 'BUSY').length, 7);
        const oldToken = claims.find(c => c.status === 'CLAIMED').claim_token;
        assert.equal(sql(`SELECT public.finalize_meta_leadgen_event(${q(company)},'10000',${q(randomUUID())},'FAILED');`), 'f');
        sql(`UPDATE private.meta_leadgen_events SET lease_until=now()-interval '1 second' WHERE leadgen_id='10000';`);
        const reclaimed = JSON.parse(sql(call));
        assert.equal(reclaimed.status, 'CLAIMED');
        assert.notEqual(reclaimed.claim_token, oldToken);
        assert.equal(sql(`SELECT public.finalize_meta_leadgen_event(${q(company)},'10000',${q(oldToken)},'FAILED');`), 'f');
        sql(`UPDATE private.meta_leadgen_events SET lease_until=NULL WHERE leadgen_id='10000';`);
        assert.equal(sql(`SELECT public.finalize_meta_leadgen_event(${q(company)},'10000',${q(reclaimed.claim_token)},'FAILED');`), 'f', 'a missing lease never authorizes finalization');
        assert.equal(sql(`SELECT status FROM private.meta_leadgen_events WHERE leadgen_id='10000';`), 'PROCESSING');
        assert.throws(()=>sql(`SELECT public.ingest_meta_leadgen_event(${q(company)},'10000',${q(reclaimed.claim_token)},'{}');`),/Command failed/,'a missing lease also denies intake');

        const protectedRpcs = [
            'claim_meta_leadgen_event(uuid,text,text,text,text,timestamptz)',
            'finalize_meta_leadgen_event(uuid,text,uuid,text,uuid,uuid,text)',
            'release_meta_ad_account_sync_lease(uuid,text,uuid,text,text)',
            'ingest_meta_leadgen_event(uuid,text,uuid,jsonb)',
        ];
        for (const signature of protectedRpcs) {
            for (const role of ['anon', 'authenticated']) {
                assert.equal(sql(`SELECT has_function_privilege(${q(role)},${q('public.' + signature)},'EXECUTE');`), 'f', `${role}: ${signature}`);
            }
            assert.equal(sql(`SELECT has_function_privilege('service_role',${q('public.' + signature)},'EXECUTE');`), 't');
        }
        assert.equal(sql("SELECT to_regprocedure('public.finalize_meta_leadgen_event(uuid,text,text,uuid,uuid,text)') IS NULL;"), 't', 'the unfenced finalizer overload is removed');

        // Company membership cannot overwrite evidence or credentials.
        for (const role of ['anon', 'authenticated']) {
            for (const statement of [
                `SELECT * FROM private.meta_ad_account_tokens`, `SELECT * FROM private.meta_leadgen_events`,
                `SELECT public.store_meta_ad_account_token(${q(company)},'act_1','overwrite')`,
                `SELECT * FROM public.get_meta_ad_account_token(${q(company)},'act_1')`,
                `INSERT INTO public.meta_campaigns(company_id,ad_account_id,meta_campaign_id,name) VALUES (${q(company)},'act_1','forged','Forged')`,
                `SELECT public.record_lead_attribution_touchpoint(p_company=>${q(company)})`,
            ]) assert.throws(() => sql(`SET ROLE ${role}; ${statement};`), /Command failed/);
        }
        sql(`SET ROLE service_role; SELECT public.store_meta_ad_account_token(${q(company)},'act_1','dummy-encrypted');`);
        assert.equal(sql(`SET ROLE service_role; SELECT encrypted_access_token FROM public.get_meta_ad_account_token(${q(company)},'act_1');`), 'dummy-encrypted');

        sql(`INSERT INTO public.meta_ad_accounts(company_id,ad_account_id,name) VALUES (${q(company)},'act_lease','Lease fixture');`);
        const leaseCall = `SET ROLE service_role; SELECT public.acquire_meta_ad_account_sync_lease(${q(company)},'act_lease',300);`;
        const leases = await Promise.all(Array.from({ length: 6 }, () => query(leaseCall)));
        const lease = leases.find(Boolean)!;
        assert.equal(leases.filter(Boolean).length, 1, 'only one concurrent sync owns the account');
        const release = (token: string | null, tenant = company, status = 'SUCCESS') => sql(`SET ROLE service_role; SELECT public.release_meta_ad_account_sync_lease(${q(tenant)},'act_lease',${q(token)},${q(status)});`);
        assert.equal(release(null), 'f');
        assert.equal(release(randomUUID()), 'f');
        assert.equal(release(lease, other), 'f');
        sql(`UPDATE public.meta_ad_accounts SET sync_lease_until=clock_timestamp()-interval '1 second' WHERE ad_account_id='act_lease';`);
        assert.equal(release(lease), 'f');
        const newLease = sql(leaseCall);
        assert.notEqual(newLease, lease);
        assert.equal(release(lease), 'f', 'stale owner cannot clear the replacement lease');
        assert.equal(release(newLease, company, 'FAILED'), 't');
        assert.equal(sql("SELECT last_synced_at IS NULL AND sync_lease_token IS NULL FROM public.meta_ad_accounts WHERE ad_account_id='act_lease';"), 't');
        const successLease = sql(leaseCall);
        assert.equal(release(successLease), 't');
        assert.equal(release(successLease), 'f', 'completed leases cannot be reused');
        assert.equal(sql("SELECT last_synced_at IS NOT NULL AND sync_status='SUCCESS' FROM public.meta_ad_accounts WHERE ad_account_id='act_lease';"), 't');

        const touch = (lead: string, campaign: string | null, name: string, ad: string | null, time: string) => {
            const pageEvidence = ad ? JSON.stringify({
                leadgen_event_binding: {
                    source: 'SIGNED_META_WEBHOOK',
                    leadgenId: lead,
                    pageId: page,
                    adId: ad,
                },
            }) : null;
            return `SELECT public.record_lead_attribution_touchpoint(
                p_company=>${q(company)},p_customer=>${q(customer)},p_page_id=>${q(page)},p_meta_leadgen_id=>${q(lead)},
                p_meta_campaign_id=>${q(campaign)},p_campaign_name=>${q(name)},p_meta_ad_id=>${q(ad)},
                p_ads_context_data=>${q(pageEvidence)}::jsonb,
                p_attribution_status=>'ATTRIBUTED',p_occurred=>${q(time)}
            );`;
        };
        for (const [lead, campaign, name, ad] of [['name-only',null,'Fabricated name',null],['forged','unknown','Fabricated',null],['foreign','foreign','Foreign campaign',null],['unknown-ad','campaign','Fabricated','unknown-ad']]) {
            const id = sql(touch(lead!, campaign!, name!, ad, '2026-10-29T10:00:00Z'));
            const row = JSON.parse(sql(`SELECT row_to_json(t) FROM public.lead_attribution_touchpoints t WHERE id=${q(id)};`));
            // Unverifiable webhook assertions stay non-attributed: identifiers are preserved
            // in raw_meta, the campaign is resolvable by a later safe retry, no name invented.
            assert.equal(row.attribution_status, 'PENDING_SYNC');
            assert.equal(row.meta_campaign_id, null);
            assert.equal(row.campaign_name_snapshot, null);
            assert.equal(row.ads_context_data.raw_meta.campaign_id, campaign);
        }
        const verified = sql(touch('verified', 'forged-campaign', 'Forged name', 'ad', '2026-10-30T10:00:00Z'));
        const row = JSON.parse(sql(`SELECT row_to_json(t) FROM public.lead_attribution_touchpoints t WHERE id=${q(verified)};`));
        assert.equal(row.attribution_status, 'ATTRIBUTED');
        assert.equal(row.meta_campaign_id, 'campaign');
        assert.equal(row.campaign_name_snapshot, 'Verified campaign');
        sql(touch('late-arrival', null, 'Forged late', null, '2026-10-29T12:00:00Z'));
        const snapshots = JSON.parse(sql(`SELECT row_to_json(c) FROM public.customers c WHERE id=${q(customer)};`));
        assert.equal(snapshots.first_campaign_name, null);
        assert.equal(snapshots.latest_campaign_name, 'Verified campaign');
        assert.equal(new Date(snapshots.latest_touch_at).toISOString(), '2026-10-30T10:00:00.000Z');

        process.env.META_APP_SECRET = appSecret;
        process.env.META_PAGE_TEST_TOKEN = 'dummy-page-access-token';
        process.env.META_PAGE_BINDINGS = JSON.stringify([{ page, company, tokenEnv: 'META_PAGE_TEST_TOKEN', leadAdsEnabled: true }]);
        delete process.env.META_ADS_PAGE_BINDINGS;
        sql(`INSERT INTO public.ai_brain_shadow_settings(company_id,channel,enabled) VALUES(${q(company)},'MESSENGER',true);`);
        process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
        process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-key';
        globalThis.fetch = async (input, init) => {
            const url = new URL(String(input));
            if (url.hostname === 'graph.facebook.com') {
                assert.equal(init?.method, 'GET', 'integration must never send messages or mutate Meta assets');
                graphCalls++;
                if (graphGate) await graphGate;
                const leadId = url.pathname.split('/').at(-1)!;
                if (leadId === 'ad_snapshot_1') {
                    creativeCalls++;
                    return Response.json({
                        id: leadId,
                        name: 'Quảng cáo snapshot',
                        campaign: { id: 'campaign_snapshot', name: 'Chiến dịch snapshot' },
                        adset: { id: 'adset_snapshot', name: 'Nhóm quảng cáo snapshot' },
                        creative: { id: 'creative_snapshot', object_story_spec: { page_id: page, link_data: {
                            message: creativeText, name: 'Headline snapshot', description: 'Description snapshot',
                            picture: 'https://scontent.xx.fbcdn.net/v/t45.1600-4/snapshot.jpg',
                        } } },
                    });
                }
                if (leadId === '20006') {
                    return Response.json({
                        id: leadId, created_time: 1793318400, form_id: '123', form_name: 'Snapshot form',
                        ad_id: 'ad_snapshot_1', ad_name: 'Raw ad',
                        // Leadgen details omit optional Ad Set fields; intake must
                        // recover them only from the verified Ad creative response.
                        campaign_id: 'campaign_snapshot',
                        campaign_name: 'Raw campaign',
                        field_data: [{ name: 'full_name', values: ['Snapshot Lead'] }],
                    });
                }
                // Phone-bearing leads (3xxxx) exercise duplicate-phone history; campaign
                // identifiers remain unverifiable webhook assertions like production would
                // return when asset data is not yet synced.
                if (/^3\d+$/.test(leadId)) {
                    return Response.json({
                        id: leadId, created_time: 1793318400, form_id: '345', form_name: 'Form 300',
                        campaign_id: '300_campaign', campaign_name: 'Fabricated', ad_id: '300_ad',
                        ad_name: 'Fabricated ad', adset_id: '300_adset', adset_name: 'Fabricated set',
                        field_data: [
                            { name: 'full_name', values: ['Nguyễn Văn A'] },
                            { name: 'phone_number', values: ['843000000001'] },
                        ],
                    });
                }
                return Response.json({ id: leadId, campaign_id: 'forged', campaign_name: 'Fabricated', field_data: [{ name: 'full_name', values: ['Stable lead'] }] });
            }
            assert.equal(url.hostname, '127.0.0.1');
            const fn = url.pathname.split('/').at(-1)!;
            const args = JSON.parse(String(init?.body || '{}'));
            if (fn === 'record_lead_attribution_touchpoint' && args.p_meta_leadgen_id === '20006') {
                snapshotAdSetArgument = args.p_meta_ad_set_id;
            }
            if (url.pathname.endsWith('/meta_ads') && (init?.method || 'GET') === 'GET') {
                assert.equal(url.searchParams.get('company_id'), `eq.${company}`);
                const adId = url.searchParams.get('meta_ad_id');
                assert.ok(adId);
                assert.ok(adId.startsWith('eq.'));
                return Response.json(JSON.parse(await query(`SET ROLE service_role;
                    SELECT coalesce((SELECT to_json(a) FROM (SELECT ad_account_id FROM public.meta_ads
                      WHERE company_id=${q(company)} AND meta_ad_id=${q(adId.slice(3))}) a),'null'::json);`)));
            }
            if (fn === 'get_meta_ad_account_token') {
                assert.equal(args.p_company_id, company);
                assert.ok([`__page__:${page}`, 'act_snapshot'].includes(args.p_ad_account_id));
                if (args.p_ad_account_id === `__page__:${page}`) {
                    pageTokenReads++;
                    if (pageTokenFault) return Response.json({ code: '42501', message: 'vault unavailable' }, { status: 503 });
                }
                // Execute the real table-valued vault RPC, including its service-role
                // grant and tenant predicate, instead of substituting an Ad Account token.
                return Response.json(JSON.parse(await query(`SET ROLE service_role;
                    SELECT coalesce(json_agg(t),'[]'::json) FROM public.get_meta_ad_account_token(
                      ${q(args.p_company_id)},${q(args.p_ad_account_id)}) t;`)));
            }
            if (fn === 'claim_meta_leadgen_event' && malformedClaim) return Response.json([]);
            if (fn === 'finalize_meta_leadgen_event' && finalizeRpcFault) return Response.json({ message: 'offline' }, { status: 500 });
            if (fn === 'claim_meta_leadgen_event' && claimFault) return Response.json({ message: 'fault' }, { status: 500 });
            if (fn === 'ingest_meta_leadgen_event' && intakeFault) return Response.json({ message: 'IDEMPOTENCY_CONFLICT' }, { status: 409 });
            if (fn === 'record_lead_attribution_touchpoint' && attributionFault) return Response.json({ message: 'fault' }, { status: 500 });
            if (fn === 'finalize_meta_leadgen_event' && args.p_status === 'PROCESSED' && finalizeFault) return Response.json(false);
            assert.match(fn, /^(claim_meta_leadgen_event|ingest_meta_leadgen_event|record_lead_attribution_touchpoint|mark_lead_attribution_phone_match|finalize_meta_leadgen_event)$/);
            const params = Object.entries(args).map(([key, value]) => { assert.match(key, /^[a-z_]+$/); return `${key}=>${q(value)}`; }).join(',');
            try {
                const result = JSON.parse(await query(`SET statement_timeout='20s'; SET ROLE service_role; SELECT to_json(public.${fn}(${params}));`));
                if (fn === 'claim_meta_leadgen_event' && result?.status === 'BUSY') releaseGraph?.();
                return Response.json(result);
            }
            catch (error) { console.error('test RPC failure', fn, error instanceof Error ? error.message : 'unknown'); return Response.json({ message: 'database failure' }, { status: 500 }); }
        };
        claimFault = true;
        assert.equal((await webhook('20000')).status, 503);
        assert.equal(graphCalls, 0, 'claim RPC error must prevent processing');
        assert.equal(pageTokenReads, 0, 'claim RPC error must prevent unnecessary token reads');
        claimFault = false;
        malformedClaim = true;
        assert.equal((await webhook('20000')).status, 503);
        assert.equal(graphCalls, 0, 'unknown claim result must prevent processing');
        assert.equal(pageTokenReads, 0, 'unknown claim result must prevent unnecessary token reads');
        malformedClaim = false;
        graphGate = new Promise<void>(resolve => { releaseGraph = resolve; });
        const timeout = setTimeout(() => releaseGraph?.(), 10_000);
        const responses = await Promise.all([webhook('20001'), webhook('20001')]);
        clearTimeout(timeout);
        graphGate = null;
        assert.deepEqual(responses.map(r => r.status).sort(), [200,503]);
        assert.equal(graphCalls, 1, 'only the claim owner may read the lead from Graph');
        assert.equal(pageTokenReads, 1, 'the BUSY request must not read the Page token');
        const readsAfterProcessing = pageTokenReads;
        pageTokenFault = true;
        assert.equal((await webhook('20001')).status, 200);
        assert.equal(pageTokenReads, readsAfterProcessing, 'processed retries must not depend on a Page token');
        assert.equal(graphCalls, 1, 'processed retries must not refetch the lead');
        pageTokenFault = false;
        assert.equal(sql(`SELECT count(*) FROM public.ai_brain_live_canary_allowlist WHERE company_id=${q(company)};`), '0', 'Lead IDs must never become Messenger recipients');
        assert.equal(sql(`SELECT count(*) FROM public.response_sla_windows WHERE company_id=${q(company)};`), '0', 'Lead Ads do not open a Messenger reply SLA');
        for(const table of ['public.conversations','public.identities','public.ai_brain_shadow_runs','public.ai_brain_live_deliveries','public.ai_brain_live_settings','private.han_outbox','public.care_deliveries']) {
            assert.equal(sql(`SELECT count(*) FROM ${table} WHERE company_id=${q(company)};`),'0',`Lead Ads cannot create messaging/AI side effects in ${table}`);
        }
        assert.equal(sql(`SELECT count(*) FROM private.han_intake_events WHERE company_id=${q(company)} AND event_key=${q(page+':leadgen:20001')};`), '1');
        assert.equal(sql(`SELECT count(*) FROM public.lead_attribution_touchpoints WHERE company_id=${q(company)} AND meta_leadgen_id='20001';`), '1');

        attributionFault = true;
        assert.equal((await webhook('20002')).status, 503);
        assert.equal(sql(`SELECT status FROM private.meta_leadgen_events WHERE company_id=${q(company)} AND leadgen_id='20002';`), 'FAILED');
        const beforeRetry = graphCalls;
        const tokenReadsBeforeRetry = pageTokenReads;
        attributionFault = false;
        pageTokenFault = true;
        assert.equal((await webhook('20002')).status, 200);
        assert.equal(graphCalls, beforeRetry, 'retry must use persisted input, without refetching changed Meta details');
        assert.equal(pageTokenReads, tokenReadsBeforeRetry, 'checkpoint recovery must not read an unnecessary Page token');
        pageTokenFault = false;
        assert.equal(sql(`SELECT count(*) FROM public.interactions WHERE company_id=${q(company)} AND external_ref=${q(page+':leadgen:20002')};`), '1');

        finalizeFault = true;
        assert.equal((await webhook('20003')).status, 503);
        assert.equal(sql(`SELECT status FROM private.meta_leadgen_events WHERE company_id=${q(company)} AND leadgen_id='20003';`), 'FAILED');
        finalizeFault = false;
        assert.equal((await webhook('20003')).status, 200);
        assert.equal(sql(`SELECT count(*) FROM public.lead_attribution_touchpoints WHERE company_id=${q(company)} AND meta_leadgen_id='20003';`), '1');

        finalizeRpcFault = true;
        assert.equal((await webhook('20005')).status, 503, 'finalization RPC outage must never acknowledge success');
        assert.equal(sql(`SELECT status FROM private.meta_leadgen_events WHERE company_id=${q(company)} AND leadgen_id='20005';`), 'PROCESSING');
        const graphBeforeLeaseRecovery = graphCalls;
        finalizeRpcFault = false;
        assert.equal((await webhook('20005')).status, 503, 'an unexpired lease still fences concurrent retries after a request dies');
        sql(`UPDATE private.meta_leadgen_events SET lease_until=clock_timestamp()-interval '1 second'
             WHERE company_id=${q(company)} AND leadgen_id='20005';`);
        pageTokenFault = true;
        assert.equal((await webhook('20005')).status, 200);
        assert.equal(graphCalls, graphBeforeLeaseRecovery, 'expired lease recovery reuses durable lead input');
        assert.equal(sql(`SELECT status||'|'||(claim_token IS NULL)::text||'|'||(lease_until IS NULL)::text
             FROM private.meta_leadgen_events WHERE company_id=${q(company)} AND leadgen_id='20005';`), 'PROCESSED|true|true');
        pageTokenFault = false;

        // Creative evidence is checkpointed with the durable intake. A retry after
        // the ad is edited must reuse the first snapshot, not fetch the new version.
        attributionFault = true;
        creativeText = 'Nội dung tại thời điểm tiếp nhận';
        assert.equal((await webhook('20006', 'ad_snapshot_1')).status, 503);
        assert.equal(creativeCalls, 1);
        assert.equal(
            sql(`SELECT ingest_args->'creative_snapshot'->>'primaryText' FROM private.meta_leadgen_events WHERE company_id=${q(company)} AND leadgen_id='20006';`),
            'Nội dung tại thời điểm tiếp nhận',
            'the first creative snapshot is persisted with intake arguments',
        );
        creativeText = 'Nội dung sau khi quảng cáo được chỉnh sửa';
        attributionFault = false;
        const beforeCreativeRetry = graphCalls;
        assert.equal((await webhook('20006', 'ad_snapshot_1')).status, 200);
        assert.equal(graphCalls, beforeCreativeRetry, 'retry must not refetch the lead or ad after the snapshot was checkpointed');
        assert.equal(creativeCalls, 1, 'the newer ad creative must not replace the first snapshot');
        const persistedCreative = JSON.parse(sql(`SELECT jsonb_build_object(
            'intake',e.ingest_args->'creative_snapshot',
            'touchpoint',t.ads_context_data->'creative_snapshot',
            'adset_id',t.meta_ad_set_id
          ) FROM private.meta_leadgen_events e
          JOIN public.lead_attribution_touchpoints t
            ON t.company_id=e.company_id AND t.meta_leadgen_id=e.leadgen_id
          WHERE e.company_id=${q(company)} AND e.leadgen_id='20006';`));
        assert.equal(persistedCreative.intake.primaryText, 'Nội dung tại thời điểm tiếp nhận');
        assert.equal(persistedCreative.touchpoint.primaryText, 'Nội dung tại thời điểm tiếp nhận');
        assert.equal(persistedCreative.touchpoint.captureTiming, 'AT_LEAD_INTAKE');
        assert.equal(persistedCreative.touchpoint.pageId, page, 'the originating Page ID is checkpointed with the creative evidence');
        assert.equal(snapshotAdSetArgument, 'adset_snapshot', 'missing Lead Details Ad Set is recovered from the verified Meta creative response');
        assert.ok(persistedCreative.touchpoint.capturedAt, 'snapshot capture time is persisted');
        assert.equal(persistedCreative.adset_id, 'adset_snapshot', 'Ad Set ID is resolved from the synced Ad object');

        pageTokenFault = true;
        const graphBeforeTokenFailure = graphCalls;
        assert.equal((await webhook('20004')).status, 503, 'fresh intake fails closed when Page credentials cannot be read');
        assert.equal(graphCalls, graphBeforeTokenFailure, 'token failure cannot reach Graph');
        assert.equal(sql(`SELECT status||'|'||(claim_token IS NULL)::text||'|'||(lease_until IS NULL)::text
             FROM private.meta_leadgen_events WHERE company_id=${q(company)} AND leadgen_id='20004';`), 'FAILED|true|true', 'token failure must release the owned lease for retry');
        pageTokenFault = false;
        intakeFault = true;
        assert.equal((await webhook('20004')).status, 503, 'idempotency conflict is never successful finalization');
        assert.equal(sql(`SELECT status FROM private.meta_leadgen_events WHERE company_id=${q(company)} AND leadgen_id='20004';`), 'FAILED');

        // --- Rule C: one customer profile, many attribution events, zero lost history ---
        intakeFault = false;
        assert.equal((await webhook('30001', '300_ad')).status, 200);
        assert.equal((await webhook('30002', '300_ad')).status, 200, 'a duplicate-phone lead must reuse the customer, never fail the webhook');
        const concurrentSubmissions = await Promise.all([webhook('30003', '300_ad'), webhook('30004', '300_ad')]);
        assert.deepEqual(
            concurrentSubmissions.map((r) => r.status).sort((a, b) => (a ?? 600) - (b ?? 600)),
            [200, 200],
            'concurrent same-phone submissions must never race into duplicate customers',
        );

        const phoneEvents = sql(
            `SELECT leadgen_id||'|'||status||'|'||COALESCE(phone_match_status,'')||'|'||COALESCE(is_duplicate_phone::text,'')
             FROM private.meta_leadgen_events WHERE company_id=${q(company)} AND leadgen_id ~ '^300' ORDER BY leadgen_id;`,
        ).split('\n');
        assert.equal(phoneEvents.length, 4);
        for (const [idx, line] of phoneEvents.entries()) {
            const [leadId, status, matchStatus, dup] = line.split('|');
            assert.equal(status, 'PROCESSED');
            assert.equal(matchStatus, idx === 0 ? 'NEW_PHONE' : 'MATCHED_EXISTING');
            assert.equal(dup, idx === 0 ? 'false' : 'true');
        }
        assert.equal(
            sql(`SELECT count(*) FROM public.customers WHERE company_id=${q(company)};`),
            '7',
            'fixture customer + five no-phone leadgen profiles (20001/20002/20003/20005/20006: no identity to dedup by) + ONE phone-owned profile for the four 3000x submissions',
        );
        const phoneTouchpoints = sql(
            `SELECT meta_leadgen_id||'|'||touchpoint_type||'|'||attribution_status||'|'||COALESCE(campaign_name_snapshot,'')||'|'
                ||CASE WHEN is_duplicate_phone THEN 'dup' ELSE 'first' END
             FROM public.lead_attribution_touchpoints
             WHERE company_id=${q(company)} AND meta_leadgen_id ~ '^300' ORDER BY meta_leadgen_id;`,
        ).split('\n');
        assert.equal(phoneTouchpoints.length, 4, 'every submission keeps its own attribution event');
        for (const [idx, line] of phoneTouchpoints.entries()) {
            const [leadId, type, status, campaign, dup] = line.split('|');
            assert.equal(type, idx === 0 ? 'FIRST_TOUCH' : 'LATEST_TOUCH');
            assert.equal(status, 'PENDING_SYNC', 'unsynced asset evidence must stay pending, never attributed from webhook names');
            assert.equal(campaign, '', 'no fabricated campaign name');
            assert.equal(dup, idx === 0 ? 'first' : 'dup');
        }
        assert.equal(
            sql(`SELECT count(DISTINCT customer_id) FROM public.lead_attribution_touchpoints WHERE company_id=${q(company)} AND meta_leadgen_id ~ '^300';`),
            '1',
            'all four submissions belong to ONE customer profile',
        );

        // Marking is fenced, idempotent and fail-closed on forged statuses.
        assert.equal(sql(`SET ROLE service_role; SELECT public.mark_lead_attribution_phone_match(${q(company)},'30001','MATCHED_EXISTING',true);`), 't', 're-marking with a different verdict updates the row');
        assert.equal(sql(`SET ROLE service_role; SELECT public.mark_lead_attribution_phone_match(${q(company)},'30001','MATCHED_EXISTING',true);`), 'f', 'same verdict again is an idempotent no-op');
        assert.throws(() => sql(`SET ROLE service_role; SELECT public.mark_lead_attribution_phone_match(${q(company)},'30001','FORGED_STATUS',true);`), /INVALID_PHONE_MATCH_STATUS/);
        assert.throws(() => sql(`SET ROLE service_role; SELECT public.mark_lead_attribution_phone_match(${q(other)},'30001','MATCHED_EXISTING',true);`), /LEADGEN_EVENT_NOT_FOUND/, 'cross-tenant marking fails closed');
        for (const statement of [
            `SELECT public.mark_lead_attribution_phone_match(${q(company)},'30001','MATCHED_EXISTING',true)`,
            `SELECT public.retry_pending_lead_attribution(${q(company)},1)`,
        ]) for (const role of ['anon', 'authenticated']) assert.throws(() => sql(`SET ROLE ${role}; ${statement};`), /Command failed/);

        // Pending campaign resolution: a bounded, safe retry. Before the asset sync
        // lands an exact Ad mapping, a campaign assertion remains unverified.
        const retryBeforeSync = JSON.parse(sql(`SELECT public.retry_pending_lead_attribution(${q(company)});`));
        assert.equal(retryBeforeSync.checked, 13, 'all pending leadgen rows are inspected in one bounded pass: 5 forged-loop rows, 4 stable no-phone webhooks, 4 duplicate-phone submissions');
        assert.equal(retryBeforeSync.resolved, 0);
        assert.equal(Number(retryBeforeSync.remaining), 13);
        assert.equal(
            sql(`SELECT attribution_status||'|'||COALESCE(campaign_name_snapshot,'') FROM public.lead_attribution_touchpoints WHERE company_id=${q(company)} AND meta_leadgen_id='unknown-ad';`),
            'PENDING_SYNC|',
        );
        // Tenant isolation: no company can claim another company's campaign evidence.
        const retryOther = JSON.parse(sql(`SELECT public.retry_pending_lead_attribution(${q(other)});`));
        assert.equal(retryOther.resolved, 0);

        // Simulated asset sync evidence (same records the marketing sync writes).
        sql(`INSERT INTO public.meta_campaigns(company_id,ad_account_id,meta_campaign_id,name,status)
             VALUES (${q(company)},'act_1','300_campaign','Chiến dịch Du học 300','ACTIVE');
             INSERT INTO public.meta_ads(company_id,ad_account_id,meta_campaign_id,meta_ad_set_id,meta_ad_id,name,status)
             VALUES (${q(company)},'act_1','300_campaign','300_adset','300_ad','Quảng cáo Meta 300','ACTIVE');`);
        // The real admin sync backfills the creative from Meta after the Ad row lands.
        // Mirror that persisted evidence here before invoking the SQL retry state machine.
        sql(`UPDATE public.lead_attribution_touchpoints
             SET ads_context_data = jsonb_set(
                 COALESCE(ads_context_data, '{}'::jsonb),
                 '{creative_snapshot}',
                 jsonb_build_object(
                     'schemaVersion', 2,
                     'status', 'AVAILABLE',
                     'source', 'META_MARKETING_API',
                     'adId', '300_ad',
                     'pageId', ${q(page)},
                     'pageIdConflict', false,
                     'capturedAt', '2026-11-04T00:00:00Z',
                     'captureTiming', 'BACKFILL',
                     'format', 'UNKNOWN',
                     'headlines', '[]'::jsonb,
                     'descriptions', '[]'::jsonb,
                     'carouselAssets', '[]'::jsonb,
                     'imageAssets', '[]'::jsonb,
                     'videoAssets', '[]'::jsonb
                 ),
                 true
             )
             WHERE company_id = ${q(company)} AND meta_leadgen_id ~ '^300';`);
        const retryAfterSync = JSON.parse(sql(`SELECT public.retry_pending_lead_attribution(${q(company)});`));
        assert.equal(retryAfterSync.resolved, 4);
        assert.equal(Number(retryAfterSync.remaining), 9, 'only rows with unresolvable assertions stay pending: forged loops, no-phone stable leads, late-arrival');
        const resolvedOne = JSON.parse(sql(`SELECT row_to_json(t) FROM public.lead_attribution_touchpoints t WHERE company_id=${q(company)} AND meta_leadgen_id='30001';`));
        assert.equal(resolvedOne.attribution_status, 'ATTRIBUTED');
        assert.equal(resolvedOne.campaign_name_snapshot, 'Chiến dịch Du học 300');
        assert.equal(resolvedOne.ad_name_snapshot, 'Quảng cáo Meta 300');
        assert.equal(resolvedOne.ad_set_name_snapshot, null);
        assert.equal(resolvedOne.ads_context_data.raw_meta.campaign_name, 'Fabricated', 'the webhook assertion stays recorded for audit');
        const phoneCustomer = sql(`SELECT customer_id FROM private.customer_private_contacts WHERE company_id=${q(company)} AND normalized_phone='+843000000001';`);
        const phoneSnapshots = JSON.parse(sql(`SELECT row_to_json(c) FROM public.customers c WHERE id=${q(phoneCustomer)};`));
        assert.equal(phoneSnapshots.first_campaign_name, 'Chiến dịch Du học 300');
        assert.equal(phoneSnapshots.attribution_status, 'ATTRIBUTED');
    } finally {
        globalThis.fetch = original;
        for (const key of ['META_TOKEN_ENCRYPTION_KEY', 'META_APP_SECRET', 'META_PAGE_TEST_TOKEN',
            'META_PAGE_BINDINGS', 'META_ADS_PAGE_BINDINGS', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
        sql(`DROP DATABASE ${db} WITH (FORCE);`, 'postgres');
    }
});

test('token migration preserves ciphertext, expiry and linked rows; conflicts or incomplete copies roll back', () => {
    sql(`CREATE DATABASE ${db};`, 'postgres');
    const oldKey = process.env.META_TOKEN_ENCRYPTION_KEY;
    process.env.META_TOKEN_ENCRYPTION_KEY = 'b'.repeat(64); // synthetic fixture key only
    try {
        const hardening = readFileSync('supabase/migrations/20261030100000_meta_ads_hardening.sql', 'utf8');
        const files = readdirSync('supabase/migrations').filter(f => f.endsWith('.sql') && f < '20261030100000').sort();
        sql(PLATFORM_STUBS.replace(/CREATE ROLE[^;]+;/g, '') + files.map(f => readFileSync(`supabase/migrations/${f}`, 'utf8')).join('\n'));
        sql(hardening.slice(0, hardening.indexOf('-- Preserve ciphertext')) + '\nCOMMIT;');
        const encrypted = encryptToken('EAA_synthetic_existing_connection');
        const noExpiry = encryptToken('EAA_synthetic_no_expiry');
        const expiry = '2027-01-01T01:02:03.456Z';
        sql(`INSERT INTO public.companies(id,name,status) VALUES (${q(company)},'Token migration fixture','ACTIVE');
            INSERT INTO public.customers(id,company_id,name,source,stage) VALUES (${q(customer)},${q(company)},'Existing CRM customer','FACEBOOK','LEAD_NEW');
            INSERT INTO public.meta_ad_accounts(company_id,ad_account_id,name,access_token,token_expires_at) VALUES
              (${q(company)},'act_existing','Existing link',${q(encrypted)},${q(expiry)}),
              (${q(company)},'act_null_expiry','Null expiry',${q(noExpiry)},NULL),
              (${q(company)},'act_no_token','No token',NULL,NULL);`);
        const accounts = () => sql('SELECT jsonb_agg(to_jsonb(a) ORDER BY ad_account_id) FROM public.meta_ad_accounts a;');
        const vault = () => sql('SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY ad_account_id),\'[]\') FROM private.meta_ad_account_tokens t;');
        const crm = sql('SELECT jsonb_agg(to_jsonb(c)) FROM public.customers c;');
        const failsSafely = (code: string) => {
            const beforeAccounts = accounts(), beforeVault = vault();
            assert.throws(() => sql(hardening), (error: unknown) => {
                assert.ok(error && typeof error === 'object' && 'stderr' in error);
                assert.ok(String(error.stderr).includes(code));
                return true;
            });
            assert.equal(accounts(), beforeAccounts, 'source columns, tokens, expiries and account rows survive failure');
            assert.equal(vault(), beforeVault, 'existing vault rows survive failure');
            assert.equal(sql('SELECT jsonb_agg(to_jsonb(c)) FROM public.customers c;'), crm);
        };
        sql('ALTER TABLE public.meta_ad_accounts DROP COLUMN token_expires_at;');
        failsSafely('META_TOKEN_SOURCE_SCHEMA_INCOMPLETE');
        sql(`ALTER TABLE public.meta_ad_accounts ADD COLUMN token_expires_at timestamptz;
             UPDATE public.meta_ad_accounts SET token_expires_at=${q(expiry)} WHERE ad_account_id='act_existing';`);
        for (const invalid of ['', 'plaintext-token']) {
            sql(`UPDATE public.meta_ad_accounts SET access_token=${q(invalid)} WHERE ad_account_id='act_existing';`);
            failsSafely('META_TOKEN_SOURCE_REQUIRES_VERIFICATION');
        }
        sql(`UPDATE public.meta_ad_accounts SET access_token=${q(encrypted)} WHERE ad_account_id='act_existing';
             UPDATE public.meta_ad_accounts SET token_expires_at=${q(expiry)} WHERE ad_account_id='act_no_token';`);
        failsSafely('META_TOKEN_SOURCE_REQUIRES_VERIFICATION');
        sql("UPDATE public.meta_ad_accounts SET token_expires_at=NULL WHERE ad_account_id='act_no_token';");
        sql(`INSERT INTO private.meta_ad_account_tokens(company_id,ad_account_id,encrypted_access_token,token_expires_at)
             VALUES (${q(company)},'act_existing',${q(noExpiry)},${q(expiry)});`);
        failsSafely('META_TOKEN_VAULT_CONFLICT');
        sql(`UPDATE private.meta_ad_account_tokens SET encrypted_access_token=${q(encrypted)},token_expires_at=NULL;`);
        failsSafely('META_TOKEN_VAULT_CONFLICT');
        sql(`UPDATE private.meta_ad_account_tokens SET token_expires_at=${q(expiry)};`);
        // Simulate a trigger silently suppressing one copy: post-copy validation
        // must detect the gap and roll back, keeping the public columns intact.
        sql(`CREATE FUNCTION private.fixture_skip_token() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
             CREATE TRIGGER fixture_skip_token BEFORE INSERT ON private.meta_ad_account_tokens FOR EACH ROW EXECUTE FUNCTION private.fixture_skip_token();`);
        failsSafely('META_TOKEN_COPY_INCOMPLETE');
        sql('DROP TRIGGER fixture_skip_token ON private.meta_ad_account_tokens; DROP FUNCTION private.fixture_skip_token();');
        const before = JSON.parse(accounts()).map((a: Record<string, unknown>) => {
            const { access_token: _token, token_expires_at: _expiry, ...rest } = a;
            return rest;
        });
        sql(hardening);
        assert.equal(sql("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='meta_ad_accounts' AND column_name IN ('access_token','token_expires_at');"), '0');
        const after = JSON.parse(accounts()).map((a: Record<string, unknown>) => {
            const { sync_lease_until: _until, sync_lease_token: _lease, ...rest } = a;
            return rest;
        });
        assert.deepEqual(after, before, 'all IDs and account linkage metadata are unchanged');
        assert.equal(sql('SELECT jsonb_agg(to_jsonb(c)) FROM public.customers c;'), crm);
        const rows = JSON.parse(vault());
        assert.equal(rows.length, 2);
        const migrated = rows.find((r: { ad_account_id: string }) => r.ad_account_id === 'act_existing');
        assert.equal(migrated.encrypted_access_token, encrypted);
        assert.equal(decryptToken(migrated.encrypted_access_token), 'EAA_synthetic_existing_connection');
        assert.equal(new Date(migrated.token_expires_at).toISOString(), expiry);
        const withoutExpiry = rows.find((r: { ad_account_id: string }) => r.ad_account_id === 'act_null_expiry');
        assert.equal(withoutExpiry.encrypted_access_token, noExpiry);
        assert.equal(withoutExpiry.token_expires_at, null);
        assert.equal(decryptToken(withoutExpiry.encrypted_access_token), 'EAA_synthetic_no_expiry');
        assert.equal(sql("SELECT relrowsecurity FROM pg_class WHERE oid='private.meta_ad_account_tokens'::regclass;"), 't');
        for (const role of ['anon', 'authenticated']) {
            assert.equal(sql(`SELECT has_table_privilege(${q(role)},'private.meta_ad_account_tokens','SELECT');`), 'f');
            assert.equal(sql(`SELECT has_function_privilege(${q(role)},'public.get_meta_ad_account_token(uuid,text)','EXECUTE');`), 'f');
        }
        // Upgrade an existing populated schema through every remaining migration;
        // ciphertext, expiry and account/Page linkage must survive unchanged.
        const vaultBeforeUpgrade = vault(), accountsBeforeUpgrade = accounts();
        const remaining = readdirSync('supabase/migrations').filter(f => f.endsWith('.sql') && f > '20261030100000_meta_ads_hardening.sql').sort();
        sql(remaining.map(f => readFileSync(`supabase/migrations/${f}`, 'utf8')).join('\n'));
        assert.equal(vault(), vaultBeforeUpgrade);
        assert.equal(accounts(), accountsBeforeUpgrade);
        assert.equal(sql('SELECT jsonb_agg(to_jsonb(c)) FROM public.customers c;'), crm);
    } finally {
        if (oldKey === undefined) delete process.env.META_TOKEN_ENCRYPTION_KEY;
        else process.env.META_TOKEN_ENCRYPTION_KEY = oldKey;
        sql(`DROP DATABASE ${db} WITH (FORCE);`, 'postgres');
    }
});

test('PostgreSQL 17 dump/restore preserves Meta tokens, Page/account links, event checkpoints, attribution and security metadata', () => {
    const restored = `${db}_restored`;
    const oldKey = process.env.META_TOKEN_ENCRYPTION_KEY;
    process.env.META_TOKEN_ENCRYPTION_KEY = 'c'.repeat(64);
    sql(`CREATE DATABASE ${db}; CREATE DATABASE ${restored};`, 'postgres');
    try {
        const version = Number(sql('SHOW server_version_num;'));
        assert.ok(version >= 170000 && version < 180000);
        const files = readdirSync('supabase/migrations').filter(f => f.endsWith('.sql')).sort();
        sql(PLATFORM_STUBS.replace(/CREATE ROLE[^;]+;/g, '') + files.map(f => readFileSync(`supabase/migrations/${f}`, 'utf8')).join('\n'));
        const encrypted = encryptToken('synthetic-page-backup-token');
        const expiry = '2027-01-01T01:02:03.456Z';
        sql(`INSERT INTO public.companies(id,name,status) VALUES (${q(company)},'Backup fixture','ACTIVE');
            INSERT INTO public.meta_ad_accounts(company_id,ad_account_id,name) VALUES (${q(company)},'act_backup','Backup account');
            INSERT INTO public.meta_campaigns(company_id,ad_account_id,meta_campaign_id,name,status)
              VALUES (${q(company)},'act_backup','backup_campaign','Backup campaign','ACTIVE');
            INSERT INTO public.meta_ads(company_id,ad_account_id,meta_campaign_id,meta_ad_id,name,status)
              VALUES (${q(company)},'act_backup','backup_campaign','backup_ad','Backup Ad','ACTIVE');
            SET ROLE service_role;
            SELECT public.store_meta_ad_account_token(${q(company)},${q('__page__:' + page)},${q(encrypted)},${q(expiry)});
            SELECT public.store_meta_ad_account_token(${q(company)},'act_backup',${q(encrypted)},${q(expiry)});`);
        const claim = JSON.parse(sql(`SET ROLE service_role; SELECT public.claim_meta_leadgen_event(${q(company)},${q(page)},'40001');`));
        const input = { name: 'Backup lead', phone: null, content: 'Synthetic form', lead_data: { id: '40001', field_data: [] }, payload: { ad_id: 'backup_ad' } };
        const intake = JSON.parse(sql(`SET ROLE service_role; SELECT public.ingest_meta_leadgen_event(${q(company)},'40001',${q(claim.claim_token)},${q(input)}::jsonb);`));
        const evidence = { leadgen_event_binding: { source: 'SIGNED_META_WEBHOOK', leadgenId: '40001', pageId: page, adId: 'backup_ad' } };
        sql(`SET ROLE service_role; SELECT public.record_lead_attribution_touchpoint(
            p_company=>${q(company)},p_customer=>${q(intake.customer_id)},p_interaction=>${q(intake.interaction_id)},
            p_page_id=>${q(page)},p_meta_leadgen_id=>'40001',p_meta_ad_id=>'backup_ad',p_ads_context_data=>${q(evidence)}::jsonb);`);
        assert.equal(sql(`SET ROLE service_role; SELECT public.finalize_meta_leadgen_event(${q(company)},'40001',${q(claim.claim_token)},'PROCESSED');`), 't');
        const tables = ['meta_ad_accounts', 'meta_campaigns', 'meta_ads', 'meta_lead_forms', 'lead_attribution_touchpoints', 'meta_ad_account_tokens', 'meta_leadgen_events', 'customers'];
        const tableFilter = tables.map(q).join(',');
        const security = `SELECT jsonb_build_object(
            'tables',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'rls',c.relrowsecurity,
              'force_rls',c.relforcerowsecurity,'owner',pg_get_userbyid(c.relowner),
              'acl',(SELECT jsonb_agg(jsonb_build_array(grantee,privilege_type,is_grantable) ORDER BY grantee,privilege_type,is_grantable)
                FROM aclexplode(c.relacl))) ORDER BY n.nspname,c.relname)
              FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname IN ('public','private') AND c.relkind='r' AND c.relname IN (${tableFilter})),
            'constraints',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,k.conname,pg_get_constraintdef(k.oid),k.convalidated)
              ORDER BY n.nspname,c.relname,k.conname) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
              JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private') AND c.relname IN (${tableFilter})),
            'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY schemaname,tablename,policyname) FROM pg_policies p
              WHERE schemaname IN ('public','private') AND tablename IN (${tableFilter})),
            'rpcs',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'signature',pg_get_function_identity_arguments(p.oid),
              'definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'config',p.proconfig,
              'acl',(SELECT jsonb_agg(jsonb_build_array(grantee,privilege_type,is_grantable) ORDER BY grantee,privilege_type,is_grantable)
                FROM aclexplode(p.proacl))) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid))
              FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
              AND (p.proname LIKE '%meta_%' OR p.proname LIKE '%lead_attribution%'))
          );`;
        const before = sql(security);
        const rows = (table: string, database = db) => sql(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM ${table} t;`, database);
        const dataTables = ['private.meta_ad_account_tokens', 'private.meta_leadgen_events', 'private.han_intake_events',
            'private.customer_private_contacts', 'private.interaction_raw_contents', 'public.meta_ad_accounts',
            'public.meta_campaigns', 'public.meta_ads', 'public.lead_attribution_touchpoints', 'public.customers', 'public.interactions'];
        const beforeData = new Map(dataTables.map(table => [table, rows(table)]));
        const dump = execFileSync('docker', ['exec', container, 'pg_dump', '-U', 'postgres', '-d', db, '--format=custom'], { maxBuffer: 64 * 1024 * 1024, timeout: 90_000 });
        assert.ok(dump.subarray(0, 5).equals(Buffer.from('PGDMP')), 'a real custom-format PostgreSQL backup is required');
        execFileSync('docker', ['exec', '-i', container, 'pg_restore', '-U', 'postgres', '-d', restored, '--exit-on-error'], {
            input: dump, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: 90_000,
        });
        assert.equal(sql(security, restored), before, 'RLS, grants, owners, RPC bodies and constraints survive restore');
        for (const table of dataTables) assert.equal(rows(table, restored), beforeData.get(table), `${table} survives restore byte-for-byte`);
        const recovered = JSON.parse(sql(`SET ROLE service_role; SELECT row_to_json(t) FROM public.get_meta_ad_account_token(${q(company)},${q('__page__:' + page)}) t;`, restored));
        assert.equal(recovered.encrypted_access_token, encrypted);
        assert.equal(decryptToken(recovered.encrypted_access_token), 'synthetic-page-backup-token');
        assert.equal(new Date(recovered.token_expires_at).toISOString(), expiry);
        const replay = JSON.parse(sql(`SET ROLE service_role; SELECT public.claim_meta_leadgen_event(${q(company)},${q(page)},'40001');`, restored));
        assert.equal(replay.status, 'ALREADY_PROCESSED', 'restored events retain idempotency');
        for (const role of ['anon', 'authenticated']) {
            assert.throws(() => sql(`SET ROLE ${role}; SELECT * FROM private.meta_ad_account_tokens;`, restored));
            assert.throws(() => sql(`SET ROLE ${role}; SELECT * FROM public.get_meta_ad_account_token(${q(company)},${q('__page__:' + page)});`, restored));
        }
    } finally {
        if (oldKey === undefined) delete process.env.META_TOKEN_ENCRYPTION_KEY;
        else process.env.META_TOKEN_ENCRYPTION_KEY = oldKey;
        sql(`DROP DATABASE ${restored} WITH (FORCE); DROP DATABASE ${db} WITH (FORCE);`, 'postgres');
    }
});

test('pending retry restores first/latest campaign and Ad projections without losing history or crossing companies', () => {
    sql(`CREATE DATABASE ${db};`, 'postgres');
    try {
        const migrations = readdirSync('supabase/migrations').filter(f => f.endsWith('.sql')).sort();
        sql(PLATFORM_STUBS.replace(/CREATE ROLE[^;]+;/g, '') + migrations.map(f => readFileSync(`supabase/migrations/${f}`, 'utf8')).join('\n'));
        const guarded = randomUUID(), foreign = randomUUID();
        sql(`INSERT INTO public.companies(id,name,status) VALUES (${q(company)},'Projection A','ACTIVE'),(${q(other)},'Projection B','ACTIVE');
            INSERT INTO public.customers(id,company_id,name,source,stage) VALUES
              (${q(customer)},${q(company)},'Projection customer','FACEBOOK','LEAD_NEW'),
              (${q(guarded)},${q(company)},'Timestamp protected','FACEBOOK','LEAD_NEW'),
              (${q(foreign)},${q(other)},'Other company','FACEBOOK','LEAD_NEW');
            INSERT INTO public.meta_campaigns(company_id,ad_account_id,meta_campaign_id,name,status)
              VALUES (${q(company)},'act_projection','latest_campaign','Latest campaign','ACTIVE');
            INSERT INTO public.meta_ads(company_id,ad_account_id,meta_campaign_id,meta_ad_id,name,status)
              VALUES (${q(company)},'act_projection','latest_campaign','latest_ad','Latest Ad','ACTIVE');`);
        const touch = (tenant: string, who: string, lead: string, adId: string, occurred: string) => sql(`
            SELECT public.record_lead_attribution_touchpoint(p_company=>${q(tenant)},p_customer=>${q(who)},
              p_page_id=>${q(page)},p_meta_leadgen_id=>${q(lead)},p_meta_ad_id=>${q(adId)},p_occurred=>${q(occurred)},
              p_ads_context_data=>${q({ leadgen_event_binding: { source: 'SIGNED_META_WEBHOOK', leadgenId: lead, pageId: page, adId } })}::jsonb);`);
        for (const [who, prefix] of [[customer, 'projection'], [guarded, 'guarded']]) {
            touch(company, who, `${prefix}-first`, 'pending_ad', '2026-10-01T00:00:00Z');
            touch(company, who, `${prefix}-latest`, 'latest_ad', '2026-10-02T00:00:00Z');
        }
        touch(other, foreign, 'foreign-first', 'pending_ad', '2026-10-01T00:00:00Z');
        const snapshot = (who: string) => JSON.parse(sql(`SELECT jsonb_build_object(
            'first_campaign',first_campaign_name,'first_ad',first_ad_name,'first_at',first_touch_at,
            'latest_campaign',latest_campaign_name,'latest_ad',latest_ad_name,'latest_at',latest_touch_at)
            FROM public.customers WHERE id=${q(who)};`));
        assert.equal(snapshot(customer).first_ad, null, 'pending first touch has no invented Ad name');
        assert.equal(snapshot(customer).latest_ad, 'Latest Ad');
        sql(`UPDATE public.customers SET first_campaign_name='Protected first campaign',first_ad_name='Protected first Ad',
              first_touch_at='2026-09-01T00:00:00Z',latest_campaign_name='Protected latest campaign',latest_ad_name='Protected latest Ad',
              latest_touch_at='2026-11-01T00:00:00Z' WHERE id=${q(guarded)};`);
        const protectedBefore = snapshot(guarded), foreignBefore = snapshot(foreign);
        const foreignHistory = sql(`SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.lead_attribution_touchpoints t WHERE company_id=${q(other)};`);
        const identities = () => sql(`SELECT jsonb_agg(jsonb_build_array(id,company_id,customer_id,meta_leadgen_id,occurred_at,touchpoint_type) ORDER BY id)
            FROM public.lead_attribution_touchpoints WHERE company_id=${q(company)};`);
        const historyBefore = identities();
        assert.equal(JSON.parse(sql(`SELECT public.retry_pending_lead_attribution(${q(company)});`)).resolved, 0);
        sql(`INSERT INTO public.meta_campaigns(company_id,ad_account_id,meta_campaign_id,name,status)
              VALUES (${q(company)},'act_projection','first_campaign','First campaign','ACTIVE');
            INSERT INTO public.meta_ads(company_id,ad_account_id,meta_campaign_id,meta_ad_id,name,status)
              VALUES (${q(company)},'act_projection','first_campaign','pending_ad','First Ad','ACTIVE');`);
        assert.equal(JSON.parse(sql(`SELECT public.retry_pending_lead_attribution(${q(company)});`)).resolved, 2);
        const projected = snapshot(customer);
        assert.equal(projected.first_campaign, 'First campaign');
        assert.equal(projected.first_ad, 'First Ad');
        assert.equal(projected.latest_campaign, 'Latest campaign');
        assert.equal(projected.latest_ad, 'Latest Ad');
        assert.equal(new Date(projected.first_at).toISOString(), '2026-10-01T00:00:00.000Z');
        assert.equal(new Date(projected.latest_at).toISOString(), '2026-10-02T00:00:00.000Z');
        assert.equal(identities(), historyBefore, 'retry retains every historical identity, occurrence time and first/latest designation');
        assert.deepEqual(snapshot(guarded), protectedBefore, 'existing timestamp guards protect both projections');
        assert.deepEqual(snapshot(foreign), foreignBefore, 'retry cannot update another company customer');
        assert.equal(sql(`SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.lead_attribution_touchpoints t WHERE company_id=${q(other)};`), foreignHistory);
        assert.equal(JSON.parse(sql(`SELECT public.retry_pending_lead_attribution(${q(company)});`)).resolved, 0, 'retry is idempotent');
    } finally { sql(`DROP DATABASE ${db} WITH (FORCE);`, 'postgres'); }
});
