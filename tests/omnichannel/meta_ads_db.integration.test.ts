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
function webhook(lead: string) {
    const raw = JSON.stringify({ object: 'page', entry: [{ id: page, changes: [{ field: 'leadgen', value: { leadgen_id: lead, form_id: '123', page_id: page, created_time: 1793318400 } }] }] });
    return POST(new Request('http://localhost/api/webhooks/meta', { method: 'POST', body: raw,
        headers: { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex') } }));
}

test('PostgreSQL ownership, ACLs, verified attribution, webhook concurrency, and partial retry recovery', async () => {
    sql(`CREATE DATABASE ${db};`, 'postgres');
    const original = globalThis.fetch;
    let attributionFault = false, finalizeFault = false, claimFault = false, intakeFault = false;
    let graphCalls = 0;
    let malformedClaim = false, finalizeRpcFault = false;
    let graphGate: Promise<void> | null = null;
    let releaseGraph: (() => void) | undefined;
    try {
        // Roles are cluster-wide and already provided by supabase start.
        const stubs = PLATFORM_STUBS.replace(/CREATE ROLE[^;]+;/g, '');
        const migrations = readdirSync('supabase/migrations').filter(f => f.endsWith('.sql')).sort();
        sql(stubs + migrations.map(f => readFileSync(`supabase/migrations/${f}`, 'utf8')).join('\n'));
        assert.equal(sql("SELECT to_regclass('public.meta_insights_daily') IS NULL AND to_regclass('public.meta_ad_sets') IS NULL AND to_regprocedure('public.get_meta_ads_performance_report(uuid,timestamptz,timestamptz,text,text)') IS NULL;"), 't', 'the released schema contains no advertising reporting API or reporting-only tables');
        assert.equal(sql("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('meta_campaigns','meta_ads') AND column_name IN ('daily_budget','lifetime_budget','objective','creative_id','creative_title','creative_body');"), '0');
        sql(`INSERT INTO public.companies(id,name,status) VALUES (${q(company)},'Meta native test','ACTIVE'),(${q(other)},'Other tenant','ACTIVE');
             INSERT INTO public.customers(id,company_id,name,source,stage) VALUES (${q(customer)},${q(company)},'First touch customer','FACEBOOK','LEAD_NEW');
             INSERT INTO public.meta_campaigns(company_id,ad_account_id,meta_campaign_id,name,status) VALUES (${q(company)},'act_1','campaign','Verified campaign','ACTIVE'),(${q(other)},'act_2','foreign','Foreign campaign','ACTIVE');
             INSERT INTO public.meta_ads(company_id,ad_account_id,meta_campaign_id,meta_ad_set_id,meta_ad_id,name,status) VALUES (${q(company)},'act_1','campaign','adset','ad','Verified ad','ACTIVE');`);

        // True overlapping transactions on independent PostgreSQL connections.
        const call = `SELECT public.claim_meta_leadgen_event(${q(company)},${q(page)},'10000');`;
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

        const touch = (lead: string, campaign: string | null, name: string, ad: string | null, time: string) =>
            `SELECT public.record_lead_attribution_touchpoint(p_company=>${q(company)},p_customer=>${q(customer)},p_meta_leadgen_id=>${q(lead)},p_meta_campaign_id=>${q(campaign)},p_campaign_name=>${q(name)},p_meta_ad_id=>${q(ad)},p_attribution_status=>'ATTRIBUTED',p_occurred=>${q(time)});`;
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
        process.env.META_PAGE_BINDINGS = JSON.stringify([{ page, company, tokenEnv: 'META_PAGE_TEST_TOKEN' }]);
        process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
        process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-key';
        globalThis.fetch = async (input, init) => {
            const url = new URL(String(input));
            if (url.hostname === 'graph.facebook.com') {
                graphCalls++;
                if (graphGate) await graphGate;
                const leadId = url.pathname.split('/').at(-1)!;
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
            if (fn === 'claim_meta_leadgen_event' && malformedClaim) return Response.json([]);
            if (fn === 'finalize_meta_leadgen_event' && args.p_status === 'PROCESSED' && finalizeRpcFault) return Response.json({ message: 'offline' }, { status: 500 });
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
        claimFault = false;
        malformedClaim = true;
        assert.equal((await webhook('20000')).status, 503);
        assert.equal(graphCalls, 0, 'unknown claim result must prevent processing');
        malformedClaim = false;
        graphGate = new Promise<void>(resolve => { releaseGraph = resolve; });
        const timeout = setTimeout(() => releaseGraph?.(), 10_000);
        const responses = await Promise.all([webhook('20001'), webhook('20001')]);
        clearTimeout(timeout);
        graphGate = null;
        assert.deepEqual(responses.map(r => r.status).sort(), [200,503]);
        assert.equal((await webhook('20001')).status, 200);
        assert.equal(sql(`SELECT count(*) FROM public.ai_brain_live_canary_allowlist WHERE company_id=${q(company)};`), '0', 'Lead IDs must never become Messenger recipients');
        assert.equal(sql(`SELECT count(*) FROM public.response_sla_windows WHERE company_id=${q(company)};`), '0', 'Lead Ads do not open a Messenger reply SLA');
        assert.equal(sql(`SELECT count(*) FROM private.han_intake_events WHERE company_id=${q(company)} AND event_key=${q(page+':leadgen:20001')};`), '1');
        assert.equal(sql(`SELECT count(*) FROM public.lead_attribution_touchpoints WHERE company_id=${q(company)} AND meta_leadgen_id='20001';`), '1');

        attributionFault = true;
        assert.equal((await webhook('20002')).status, 503);
        assert.equal(sql(`SELECT status FROM private.meta_leadgen_events WHERE company_id=${q(company)} AND leadgen_id='20002';`), 'FAILED');
        const beforeRetry = graphCalls;
        attributionFault = false;
        assert.equal((await webhook('20002')).status, 200);
        assert.equal(graphCalls, beforeRetry, 'retry must use persisted input, without refetching changed Meta details');
        assert.equal(sql(`SELECT count(*) FROM public.interactions WHERE company_id=${q(company)} AND external_ref=${q(page+':leadgen:20002')};`), '1');

        finalizeFault = true;
        assert.equal((await webhook('20003')).status, 503);
        assert.equal(sql(`SELECT status FROM private.meta_leadgen_events WHERE company_id=${q(company)} AND leadgen_id='20003';`), 'FAILED');
        finalizeFault = false;
        assert.equal((await webhook('20003')).status, 200);
        assert.equal(sql(`SELECT count(*) FROM public.lead_attribution_touchpoints WHERE company_id=${q(company)} AND meta_leadgen_id='20003';`), '1');

        finalizeRpcFault = true;
        assert.equal((await webhook('20005')).status, 503, 'finalization RPC outage must never acknowledge success');
        finalizeRpcFault = false;
        assert.equal((await webhook('20005')).status, 200);

        intakeFault = true;
        assert.equal((await webhook('20004')).status, 503, 'idempotency conflict is never successful finalization');
        assert.equal(sql(`SELECT status FROM private.meta_leadgen_events WHERE company_id=${q(company)} AND leadgen_id='20004';`), 'FAILED');

        // --- Rule C: one customer profile, many attribution events, zero lost history ---
        intakeFault = false;
        assert.equal((await webhook('30001')).status, 200);
        assert.equal((await webhook('30002')).status, 200, 'a duplicate-phone lead must reuse the customer, never fail the webhook');
        const concurrentSubmissions = await Promise.all([webhook('30003'), webhook('30004')]);
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
            '6',
            'fixture customer + four no-phone leadgen profiles (20001/20002/20003/20005: no identity to dedup by) + ONE phone-owned profile for the four 3000x submissions',
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
        // lands anything, only the assertion corroborated by an existing synced
        // campaign row resolves (INFERRED); everything else stays pending.
        const retryBeforeSync = JSON.parse(sql(`SELECT public.retry_pending_lead_attribution(${q(company)});`));
        assert.equal(retryBeforeSync.checked, 13, 'all pending leadgen rows are inspected in one bounded pass: 5 forged-loop rows, 4 stable no-phone webhooks, 4 duplicate-phone submissions');
        assert.equal(retryBeforeSync.resolved, 1);
        assert.equal(Number(retryBeforeSync.remaining), 12);
        assert.equal(
            sql(`SELECT attribution_status||'|'||COALESCE(campaign_name_snapshot,'') FROM public.lead_attribution_touchpoints WHERE company_id=${q(company)} AND meta_leadgen_id='unknown-ad';`),
            'INFERRED|Verified campaign',
        );
        // Tenant isolation: no company can claim another company's campaign evidence.
        const retryOther = JSON.parse(sql(`SELECT public.retry_pending_lead_attribution(${q(other)});`));
        assert.equal(retryOther.resolved, 0);

        // Simulated asset sync evidence (same records the marketing sync writes).
        sql(`INSERT INTO public.meta_campaigns(company_id,ad_account_id,meta_campaign_id,name,status)
             VALUES (${q(company)},'act_1','300_campaign','Chiến dịch Du học 300','ACTIVE');
             INSERT INTO public.meta_ads(company_id,ad_account_id,meta_campaign_id,meta_ad_set_id,meta_ad_id,name,status)
             VALUES (${q(company)},'act_1','300_campaign','300_adset','300_ad','Quảng cáo Meta 300','ACTIVE');`);
        const retryAfterSync = JSON.parse(sql(`SELECT public.retry_pending_lead_attribution(${q(company)});`));
        assert.equal(retryAfterSync.resolved, 4);
        assert.equal(Number(retryAfterSync.remaining), 8, 'only rows with unresolvable assertions stay pending: forged loops, no-phone stable leads, late-arrival');
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
        sql(`DROP DATABASE ${db} WITH (FORCE);`, 'postgres');
    }
});
