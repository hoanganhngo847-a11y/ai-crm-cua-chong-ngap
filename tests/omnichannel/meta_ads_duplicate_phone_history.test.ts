/** PG-level regression suite for Meta Ads duplicate-phone history (Rule B/C).
 *
 * Exercises the definitive business scenarios against the REAL SQL state
 * machines inside PGlite (all migrations applied): one customer profile, many
 * attribution events, zero lost campaign history, and every channel-semantic
 * fence preserved. Webhook-level idempotency and concurrency live in
 * `meta_ads_db.integration.test.ts` (native Postgres); Zalo regression lives in
 * the dedicated Zalo suites.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPgliteSupabase } from '../zalo/helpers/pglite-supabase';

const q = (v: unknown) =>
    v === null || v === undefined ? 'NULL'
        : typeof v === 'string' ? `'${v.replaceAll("'", "''")}'`
        : String(v);

const PAGE = '1026991374010112';

function insertCompany(id: string, name: string) {
    return `INSERT INTO public.companies (id, name, status) VALUES ('${id}', '${name}', 'ACTIVE') ON CONFLICT (id) DO NOTHING;`;
}

/** A claimed, lease-live leadgen intake slot, mirroring what the claim RPC produces. */
function claimLeadgen(company: string, leadgenId: string, occurred: string) {
    return `
        INSERT INTO private.meta_leadgen_events (company_id, page_id, leadgen_id, form_id, ad_id, status, occurred_at, claim_token, lease_until)
        VALUES ('${company}', ${q(PAGE)}, ${q(leadgenId)}, 'form_01', 'ad_01', 'PROCESSING', ${q(occurred)}, gen_random_uuid(), clock_timestamp() + interval '5 minutes')
        ON CONFLICT (company_id, leadgen_id) DO UPDATE SET status = 'PROCESSING', claim_token = gen_random_uuid(), lease_until = clock_timestamp() + interval '5 minutes';
    `;
}

interface DbLike {
    exec: (sql: string) => Promise<unknown>;
    query: (sql: string) => Promise<{ rows: unknown[] }>;
}

interface Submission {
    interaction_id: string;
    customer_id: string;
    phone_match_status: string;
    is_duplicate_phone: boolean;
    touchpointId: string;
}

/** The exact SQL funnel the server executes for a leadgen webhook:
 * ingest (with the phone verdict) → record touchpoint → mark the verdict. */
async function submitLeadgen(
    db: DbLike,
    opts: {
        company: string;
        leadgenId: string;
        occurred: string;
        callerName?: string;
        phone: string | null;
        content: string;
        campaignId?: string | null;
        campaignName?: string | null;
        adId?: string | null;
        adName?: string | null;
    },
): Promise<Submission> {
    await db.exec(claimLeadgen(opts.company, opts.leadgenId, opts.occurred));
    const ingest = JSON.stringify({
        name: (opts.callerName || 'Khách Lead Ads').slice(0, 100),
        phone: opts.phone,
        content: opts.content,
        lead_data: { id: opts.leadgenId, form_id: 'form_01' },
        payload: {
            leadgen_id: opts.leadgenId, page_id: PAGE, form_id: 'form_01',
            ad_id: opts.adId ?? 'ad_01', campaign_id: opts.campaignId ?? 'campaign_asserted',
            crm_lead_ads: true, field_data_keys: ['full_name', 'phone_number'],
            crm_phone_detection: { status: opts.phone ? 'VALID' : 'MISSING' },
        },
    });
    const ingestRes = await db.query(`
        SELECT to_json(public.ingest_meta_leadgen_event(
            p_company_id => ${q(opts.company)}, p_leadgen_id => ${q(opts.leadgenId)},
            p_claim_token => (SELECT claim_token FROM private.meta_leadgen_events WHERE company_id = ${q(opts.company)} AND leadgen_id = ${q(opts.leadgenId)}),
            p_ingest => ${q(ingest)}
        ));
    `);
    const result = (ingestRes.rows[0] as { to_json: Submission & { status?: string } }).to_json;
    assert.ok(result.interaction_id, 'intake must always return the persisted interaction');
    const touchRes = await db.query(`
        SELECT public.record_lead_attribution_touchpoint(
            p_company => ${q(opts.company)}, p_customer => ${q(result.customer_id)}, p_interaction => ${q(result.interaction_id)},
            p_channel => 'FACEBOOK_LEAD_ADS', p_page_id => ${q(PAGE)}, p_page_name => 'Du học CHD',
            p_meta_campaign_id => ${q(opts.campaignId ?? null)}, p_campaign_name => ${q(opts.campaignName ?? null)},
            p_meta_ad_id => ${q(opts.adId ?? null)}, p_ad_name => ${q(opts.adName ?? null)},
            p_meta_form_id => 'form_01', p_form_name => 'Form Du học',
            p_meta_leadgen_id => ${q(opts.leadgenId)}, p_referral_source => 'LEAD_ADS', p_referral_type => 'INSTANT_FORM',
            p_attribution_status => 'UNATTRIBUTED', p_attribution_method => 'DIRECT_LEADGEN', p_occurred => ${q(opts.occurred)}
        ) AS touchpoint_id;
    `);
    const touchpointId = (touchRes.rows[0] as { touchpoint_id: string }).touchpoint_id;
    assert.ok(touchpointId, 'attribution event must be recorded');
    const markRes = await db.query(`
        SELECT public.mark_lead_attribution_phone_match(
            p_company => ${q(opts.company)}, p_meta_leadgen_id => ${q(opts.leadgenId)},
            p_phone_match_status => ${q(result.phone_match_status)}, p_is_duplicate_phone => ${q(result.is_duplicate_phone)}
        ) AS marked;
    `);
    assert.equal((markRes.rows[0] as { marked: boolean }).marked, true, 'verdict must land on the attribution event');
    return { ...result, touchpointId };
}

interface TouchRow {
    touchpoint_id: string; touchpoint_type: string; attribution_status: string;
    meta_campaign_id: string | null; campaign_name_snapshot: string | null;
    is_duplicate_phone: boolean | null; normalized_phone_match_status: string | null; occurred_at: string;
    raw_meta_campaign_id: string | null;
}
const touchRows = async (db: DbLike, company: string): Promise<TouchRow[]> => {
    const res = await db.query(`
        SELECT id AS touchpoint_id, touchpoint_type, attribution_status, meta_campaign_id,
               campaign_name_snapshot, is_duplicate_phone, normalized_phone_match_status, occurred_at,
               ads_context_data->'raw_meta'->>'campaign_id' AS raw_meta_campaign_id
        FROM public.lead_attribution_touchpoints
        WHERE company_id='${company}' ORDER BY occurred_at, touchpoint_id;
    `);
    return res.rows as TouchRow[];
};

const one = async (db: DbLike, sql: string): Promise<Record<string, unknown>> => {
    const res = await db.query(sql);
    return res.rows[0] as Record<string, unknown>;
};

test('TEST 1: fresh phone creates exactly one customer, one contact, one attribution event marked NEW_PHONE', async () => {
    const supabase = await createPgliteSupabase();
    const { db } = supabase;
    try {
        const company = 'b1111111-1111-4111-8111-111111111111';
        await db.exec(insertCompany(company, 'CHD Lead Ads'));
        const r = await submitLeadgen(db, {
            company, leadgenId: '3300001', occurred: '2026-10-15T02:00:00Z',
            callerName: 'Nguyễn Văn A', phone: '+843000000011',
            content: '[Facebook Lead Ads - Biểu mẫu tức thì]\nHọ tên: Nguyễn Văn A\nSĐT: [số liên hệ đã ẩn]',
            campaignId: 'campaign_unknown_a', campaignName: 'Tên chiến dịch chưa được xác minh',
        });

        assert.equal(r.phone_match_status, 'NEW_PHONE');
        assert.equal(r.is_duplicate_phone, false);
        const c = await one(db, `
            SELECT
                (SELECT count(*) FROM public.customers WHERE company_id='${company}') AS customers,
                (SELECT count(*) FROM private.customer_private_contacts WHERE company_id='${company}') AS contacts,
                (SELECT count(*) FROM public.lead_attribution_touchpoints WHERE company_id='${company}') AS touchpoints,
                (SELECT customer_id FROM private.customer_private_contacts WHERE company_id='${company}') AS owner;
        `);
        assert.equal(Number(c.customers), 1);
        assert.equal(Number(c.contacts), 1);
        assert.equal(Number(c.touchpoints), 1);
        assert.equal(c.owner, r.customer_id, 'the canonical phone binds to exactly the created profile');
        const rows = await touchRows(db, company);
        assert.equal(rows[0].touchpoint_type, 'FIRST_TOUCH');
        assert.equal(rows[0].attribution_status, 'PENDING_SYNC', 'unverified campaign assertion waits for synced evidence, no name invented');
        assert.equal(rows[0].raw_meta_campaign_id, 'campaign_unknown_a', 'the identifier stays preserved for the safe retry');
        assert.equal(rows[0].campaign_name_snapshot, null);
    } finally {
        await supabase.close();
    }
});

test('TEST 2: Campaign B after Campaign A reuses the SAME customer; both campaigns stay visible; replay keeps the verdict', async () => {
    const supabase = await createPgliteSupabase();
    const { db } = supabase;
    try {
        const company = 'b2222222-1111-4111-8111-111111111111';
        await db.exec(insertCompany(company, 'CHD Lead Ads'));
        await submitLeadgen(db, {
            company, leadgenId: '3302001', occurred: '2026-10-15T02:00:00Z',
            phone: '+843000000011', content: 'Lead từ chiến dịch du học Đức',
        });
        const b = await submitLeadgen(db, {
            company, leadgenId: '3302002', occurred: '2026-10-30T02:00:00Z',
            phone: '+843000000011', content: 'Lead từ chiến dịch IELTS',
        });

        const profiles = await one(db, `SELECT count(*) AS c FROM public.customers WHERE company_id='${company}'`);
        assert.equal(Number(profiles.c), 1, 'Rule C CASE 2: never a second customer for the same phone');

        const live = await touchRows(db, company);
        assert.equal(live.length, 2, 'every submission keeps its own attribution event');
        assert.equal(live[0].is_duplicate_phone, false);
        assert.equal(live[0].normalized_phone_match_status, 'NEW_PHONE');
        assert.equal(live[1].is_duplicate_phone, true);
        assert.equal(live[1].normalized_phone_match_status, 'MATCHED_EXISTING');
        assert.equal(live[1].touchpoint_type, 'LATEST_TOUCH');
        assert.equal(b.phone_match_status, 'MATCHED_EXISTING');
        assert.equal(b.is_duplicate_phone, true);

        // Durable webhook retry: the same lead replays the persisted verdict without new rows.
        const replay = ((await db.query(`
            SELECT to_json(public.ingest_meta_leadgen_event(
                p_company_id => ${q(company)}, p_leadgen_id => '3302002',
                p_claim_token => (SELECT claim_token FROM private.meta_leadgen_events WHERE company_id = ${q(company)} AND leadgen_id = '3302002'),
                p_ingest => '{}'::jsonb
            ));
        `)).rows[0] as { to_json: {
            interaction_id: string; customer_id: string; phone_match_status: string; is_duplicate_phone: boolean;
        } }).to_json;
        assert.equal(replay.interaction_id, b.interaction_id, 'replay returns the same persisted interaction');
        assert.equal(replay.phone_match_status, 'MATCHED_EXISTING');
        assert.equal(replay.is_duplicate_phone, true);
        assert.equal(Number((await one(db, `SELECT count(*) AS c FROM public.lead_attribution_touchpoints WHERE company_id='${company}'`)).c), 2, 'no extra history on retry');
    } finally {
        await supabase.close();
    }
});

test('TEST 3: three campaigns on one phone: one customer, three events, all three campaign associations preserved', async () => {
    const supabase = await createPgliteSupabase();
    const { db } = supabase;
    try {
        const company = 'b3333333-1111-4111-8111-111111111111';
        await db.exec(insertCompany(company, 'CHD Lead Ads'));
        await submitLeadgen(db, {
            company, leadgenId: '3303001', occurred: '2026-10-15T02:00:00Z',
            phone: '+843000000011', content: 'Lead A', campaignId: 'camp_a_2026',
        });
        await submitLeadgen(db, {
            company, leadgenId: '3303002', occurred: '2026-10-30T02:00:00Z',
            phone: '+843000000011', content: 'Lead B', campaignId: 'camp_b_2026',
        });
        await submitLeadgen(db, {
            company, leadgenId: '3303003', occurred: '2026-11-05T02:00:00Z',
            phone: '+843000000011', content: 'Lead C', campaignId: 'camp_c_2026',
        });

        const c = await one(db, `
            SELECT
                (SELECT count(*) FROM public.customers WHERE company_id='${company}') AS customers,
                (SELECT count(DISTINCT customer_id) FROM public.lead_attribution_touchpoints WHERE company_id='${company}') AS touch_owners,
                (SELECT count(*) FROM public.lead_attribution_touchpoints WHERE company_id='${company}') AS touchpoints;
        `);
        assert.equal(Number(c.customers), 1);
        assert.equal(Number(c.touch_owners), 1);
        assert.equal(Number(c.touchpoints), 3);

        const live = await touchRows(db, company);
        assert.deepEqual(live.map((t) => t.raw_meta_campaign_id), ['camp_a_2026', 'camp_b_2026', 'camp_c_2026'], 'three independently preserved campaign associations');
        assert.deepEqual(live.map((t) => t.is_duplicate_phone), [false, true, true]);
        assert.equal(live[0].touchpoint_type, 'FIRST_TOUCH');
        assert.equal(live[2].touchpoint_type, 'LATEST_TOUCH');
    } finally {
        await supabase.close();
    }
});

test('TEST 5: the same phone in two tenants never matches across companies', async () => {
    const supabase = await createPgliteSupabase();
    const { db } = supabase;
    try {
        const companyA = 'b5555555-1111-4111-8111-111111111111';
        const companyB = 'b5555555-2222-4222-8222-222222222222';
        await db.exec(insertCompany(companyA, 'Tenant A') + insertCompany(companyB, 'Tenant B'));
        const a = await submitLeadgen(db, {
            company: companyA, leadgenId: '3305001', occurred: '2026-10-15T02:00:00Z',
            phone: '+843000000011', content: 'Tenant A lead',
        });
        const b = await submitLeadgen(db, {
            company: companyB, leadgenId: '3305002', occurred: '2026-10-15T03:00:00Z',
            phone: '+843000000011', content: 'Tenant B lead',
        });

        assert.notEqual(a.customer_id, b.customer_id, 'no cross-tenant customer reuse');
        assert.equal(b.phone_match_status, 'NEW_PHONE', 'tenant B sees the phone for the first time');
        assert.equal(b.is_duplicate_phone, false);
        const totals = await one(db, `
            SELECT
                (SELECT count(*) FROM private.customer_private_contacts WHERE company_id='${companyA}') AS contacts_a,
                (SELECT count(*) FROM private.customer_private_contacts WHERE company_id='${companyB}') AS contacts_b;
        `);
        assert.equal(Number(totals.contacts_a), 1);
        assert.equal(Number(totals.contacts_b), 1, 'each tenant retains its own canonical binding');
    } finally {
        await supabase.close();
    }
});

test('TEST 6: multiple profiles owning the same phone: no auto-merge, submission preserved unbound for manual resolution', async () => {
    const supabase = await createPgliteSupabase();
    const { db } = supabase;
    try {
        const company = 'b6666666-1111-4111-8111-111111111111';
        const owner1 = 'b6666666-2222-4222-8222-222222222222';
        const owner2 = 'b6666666-3333-4333-8333-333333333333';
        await db.exec(`
            ${insertCompany(company, 'CHD Lead Ads')}

            INSERT INTO public.customers (id, company_id, customer_code, name, source, stage)
            VALUES ('${owner1}', '${company}', 'KH-T6A', 'Chủ A', 'FACEBOOK', 'LEAD_NEW'),
                   ('${owner2}', '${company}', 'KH-T6B', 'Chủ B', 'FACEBOOK', 'LEAD_NEW');

            INSERT INTO private.customer_private_contacts (company_id, customer_id, normalized_phone, raw_phone)
            VALUES ('${company}', '${owner1}', '+843000000011', '0300000011');

            -- CASE 3 (multiple owners of one phone) is impossible while one profile
            -- owns a phone; this disposable test DB relaxes the constraint to stage
            -- the ambiguous state a historical data fix may have produced.
            ALTER TABLE private.customer_private_contacts DROP CONSTRAINT uq_cpc_company_normalized_phone;

            INSERT INTO private.customer_private_contacts (company_id, customer_id, normalized_phone, raw_phone)
            VALUES ('${company}', '${owner2}', '+843000000011', '0300000011');
        `);
        const r = await submitLeadgen(db, {
            company, leadgenId: '3306001', occurred: '2026-10-30T02:00:00Z',
            callerName: 'Nguyễn Văn A', phone: '+843000000011', content: 'Lead đa chủ sở hữu',
        });
        assert.equal(r.phone_match_status, 'AMBIGUOUS_MULTIPLE', 'Rule C CASE 3 never picks an arbitrary owner');
        assert.equal(r.is_duplicate_phone, true);

        const c = await one(db, `
            SELECT
                (SELECT count(*) FROM public.customers WHERE company_id='${company}') AS customers,
                (SELECT count(*) FROM private.customer_private_contacts WHERE company_id='${company}' AND normalized_phone='+843000000011') AS bindings,
                (SELECT count(*) FROM private.customer_private_contacts WHERE company_id='${company}' AND customer_id=${q(r.customer_id)}) AS new_bindings;
        `);
        assert.equal(Number(c.customers), 3, 'the incoming submission is preserved as its own safely-recorded profile');
        assert.equal(Number(c.bindings), 2, 'an ambiguous phone never gains another automatic binding');
        assert.equal(Number(c.new_bindings), 0, 'the preserved profile stays unbound until manual resolution');
        assert.notEqual(r.customer_id, owner1);
        assert.notEqual(r.customer_id, owner2, 'no arbitrary owner picked');

        const rows = await touchRows(db, company);
        assert.equal(rows.length, 1, 'the preserved submission still records its attribution event');
        assert.equal(rows[0].is_duplicate_phone, true);
        assert.equal(rows[0].attribution_status, 'PENDING_SYNC');

        const audit = await one(db, `
            SELECT count(*) AS c FROM public.audit_logs
            WHERE company_id='${company}' AND action='OMNICHANNEL_IDENTITY_REVIEW';
        `);
        assert.equal(Number(audit.c), 1, 'manual duplicate resolution is demanded via the review trail');
    } finally {
        await supabase.close();
    }
});

test('TEST 7: invalid phones fail closed at intake; missing phones still preserve the lead safely', async () => {
    const supabase = await createPgliteSupabase();
    const { db } = supabase;
    try {
        const company = 'b7777777-1111-4111-8111-111111111111';
        await db.exec(insertCompany(company, 'CHD Lead Ads'));

        // The normalization boundary guarantees callers hand a canonical +E.164 or NULL.
        await assert.rejects(
            db.query(`SELECT public.han_ingest('${company}', 'FACEBOOK', '110:159001', 'key_invalid_phone', 'Khách', '0300000011', 'nội dung', 'nội dung', 'SUCCEEDED', '2026-10-30T02:00:00Z', '{}'::jsonb);`),
            /INVALID_REQUEST/,
            'a non-canonical phone value is rejected, never silently matched',
        );
        assert.equal(Number((await one(db, `SELECT count(*) AS c FROM public.customers WHERE company_id='${company}'`)).c), 0);

        // CASE 4: no phone at all — the lead is preserved without invented identity.
        const r = await submitLeadgen(db, {
            company, leadgenId: '3307001', occurred: '2026-10-30T02:00:00Z',
            phone: null, content: '[Facebook Lead Ads]\nHọ tên: Không SĐT',
        });
        assert.equal(r.phone_match_status, 'NO_PHONE');
        assert.equal(r.is_duplicate_phone, false);
        const c = await one(db, `
            SELECT
                (SELECT count(*) FROM public.customers WHERE company_id='${company}') AS customers,
                (SELECT count(*) FROM private.customer_private_contacts WHERE company_id='${company}') AS contacts,
                (SELECT count(*) FROM public.interactions WHERE company_id='${company}') AS interactions;
        `);
        assert.equal(Number(c.customers), 1, 'lead is preserved with its own profile');
        assert.equal(Number(c.contacts), 0, 'no phone binding invented');
        assert.equal(Number(c.interactions), 1);
    } finally {
        await supabase.close();
    }
});

test('TEST 8: unresolvable campaign stays pending and is safely completed by retry without moving first-touch', async () => {
    const supabase = await createPgliteSupabase();
    const { db } = supabase;
    try {
        const company = 'b8888888-1111-4111-8111-111111111111';
        await db.exec(insertCompany(company, 'CHD Lead Ads'));
        const a = await submitLeadgen(db, {
            company, leadgenId: '3308001', occurred: '2026-10-15T02:00:00Z',
            phone: '+843000000011', content: 'Lead A', campaignId: 'camp_t8_a', campaignName: 'Tên chưa xác minh',
        });
        const rowsBefore = await touchRows(db, company);
        assert.equal(rowsBefore[0].attribution_status, 'PENDING_SYNC', 'campaign lookup with no synced evidence is pending, not attributed');
        assert.equal(rowsBefore[0].campaign_name_snapshot, null);
        assert.equal(rowsBefore[0].raw_meta_campaign_id, 'camp_t8_a', 'identifier preserved for a later safe retry');

        const retryBeforeSync = (await db.query(`SELECT public.retry_pending_lead_attribution(${q(company)}) AS r;`)).rows[0] as { r: { checked: number; resolved: number; remaining: number } };
        assert.equal(Number(retryBeforeSync.r.checked), 1);
        assert.equal(Number(retryBeforeSync.r.resolved), 0, 'no synced evidence, nothing resolves');
        assert.equal(Number(retryBeforeSync.r.remaining), 1);

        // The marketing asset sync lands (exactly the rows the marketing sync writes).
        await db.exec(`
            INSERT INTO public.meta_campaigns (company_id, ad_account_id, meta_campaign_id, name, status)
            VALUES ('${company}', 'act_01', 'camp_t8_a', 'Chiến dịch Du học Đức', 'ACTIVE');
        `);
        const retryAfterSync = (await db.query(`SELECT public.retry_pending_lead_attribution(${q(company)}) AS r;`)).rows[0] as { r: { resolved: number; remaining: number } };
        assert.equal(Number(retryAfterSync.r.resolved), 1);
        assert.equal(Number(retryAfterSync.r.remaining), 0);

        const resolved = await touchRows(db, company);
        assert.equal(resolved[0].attribution_status, 'INFERRED', 'resolved through the lead-scoped campaign identifier');
        assert.equal(resolved[0].campaign_name_snapshot, 'Chiến dịch Du học Đức');
        assert.equal(resolved[0].is_duplicate_phone, false, 'the preserved history never loses verdicts');
        assert.equal(resolved[0].raw_meta_campaign_id, 'camp_t8_a');

        // Second campaign submission AFTER resolution: first-touch must never move.
        await db.exec(`
            INSERT INTO public.meta_campaigns (company_id, ad_account_id, meta_campaign_id, name, status)
            VALUES ('${company}', 'act_01', 'camp_t8_b', 'Chiến dịch IELTS Online', 'ACTIVE');
            INSERT INTO public.meta_ads (company_id, ad_account_id, meta_campaign_id, meta_ad_set_id, meta_ad_id, name, status)
            VALUES ('${company}', 'act_01', 'camp_t8_b', 'adset_t8_b', 'ad_resolved_t8', 'Quảng cáo IELTS', 'ACTIVE');
        `);
        await submitLeadgen(db, {
            company, leadgenId: '3308002', occurred: '2026-10-30T02:00:00Z',
            phone: '+843000000011', content: 'Lead B', campaignId: 'camp_t8_b', adId: 'ad_resolved_t8', adName: 'Quảng cáo IELTS',
        });
        const final = await touchRows(db, company);
        assert.equal(final.length, 2);
        assert.equal(final[0].campaign_name_snapshot, 'Chiến dịch Du học Đức', 'first-touch attribution is immutable');
        assert.equal(final[0].attribution_status, 'INFERRED');
        assert.equal(final[1].attribution_status, 'ATTRIBUTED', 'ad-identifier evidence resolves ATTRIBUTED');
        assert.equal(final[1].campaign_name_snapshot, 'Chiến dịch IELTS Online');

        const snap = await one(db, `
            SELECT first_campaign_name, latest_campaign_name, first_touch_at, latest_touch_at, attribution_status
            FROM public.customers WHERE id=${q(a.customer_id)};
        `);
        assert.equal(snap.first_campaign_name, 'Chiến dịch Du học Đức');
        assert.equal(snap.latest_campaign_name, 'Chiến dịch IELTS Online');
        assert.equal(new Date(snap.first_touch_at as unknown as string).toISOString(), '2026-10-15T02:00:00.000Z', 'first-touch timestamp never moves forward');
        assert.equal(new Date(snap.latest_touch_at as unknown as string).toISOString(), '2026-10-30T02:00:00.000Z');
        assert.equal(snap.attribution_status, 'ATTRIBUTED');
    } finally {
        await supabase.close();
    }
});

test('TEST 10: Messenger and Website keep their exact prior semantics while leadgen reuses by phone', async () => {
    const supabase = await createPgliteSupabase();
    const { db } = supabase;
    try {
        const company = 'b1010101-1111-4111-8111-111111111111';
        const messengerCust = 'b1010101-2222-4222-8222-222222222222';
        const phoneOwner = 'b1010101-3333-4333-8333-333333333333';
        await db.exec(`
            ${insertCompany(company, 'CHD Lead Ads')}

            INSERT INTO public.customers (id, company_id, customer_code, name, source, stage)
            VALUES ('${messengerCust}', '${company}', 'KH-T10MSG', 'Khách Messenger', 'FACEBOOK', 'LEAD_NEW'),
                   ('${phoneOwner}', '${company}', 'KH-T10PH', 'Chủ số điện thoại', 'FACEBOOK', 'LEAD_NEW');

            INSERT INTO private.customer_private_contacts (company_id, customer_id, normalized_phone, raw_phone)
            VALUES ('${company}', '${phoneOwner}', '+843000000011', '0300000011');

            INSERT INTO public.identities (company_id, customer_id, channel, external_id, verified)
            VALUES ('${company}', '${messengerCust}', 'FACEBOOK', '110:159000000001', false);
        `);

        // Messenger: the phone owner is a different profile than the PSID identity.
        // Established semantics: no destructive merge, flagged for review, CONFLICT verdict.
        const msg = await db.query(`
            SELECT to_json(public.han_ingest(
                ${q(company)}, 'FACEBOOK', '110:159000000001', 'fb-msg-key-1',
                'Khách Messenger', '+843000000011', 'Tôi quan tâm du học Đức', 'Tôi quan tâm du học Đức',
                'SUCCEEDED', '2026-10-29T02:00:00Z', '{}'::jsonb
            )) AS result;
        `);
        const msgResult = (msg.rows[0] as { result: { interaction_id: string; phone_match_status: string; is_duplicate_phone: boolean } }).result;
        assert.equal(msgResult.phone_match_status, 'CONFLICT');
        assert.equal(msgResult.is_duplicate_phone, true);
        assert.equal(
            (await one(db, `SELECT customer_id AS o FROM public.interactions WHERE company_id='${company}' AND id=${q(msgResult.interaction_id)}`)).o,
            messengerCust,
            'identity still resolves the conversation owner',
        );
        assert.equal(
            (await one(db, `SELECT customer_id AS o FROM private.customer_private_contacts WHERE company_id='${company}' AND normalized_phone='+843000000011'`)).o,
            phoneOwner,
            'the phone binding is never moved or reassigned',
        );
        assert.equal(
            (await one(db, `SELECT status AS s FROM private.han_intake_events WHERE company_id='${company}' AND event_key='fb-msg-key-1'`)).s,
            'IDENTITY_REVIEW',
        );

        // Website: no persistent identity; a known phone lands with its own preserved
        // profile flagged for review — identical to the established behavior.
        const web = await db.query(`
            SELECT to_json(public.han_ingest(
                ${q(company)}, 'WEBSITE', NULL, 'web-lead-key-1',
                'Khách Website', '+843000000011', 'Đăng ký tư vấn', 'Đăng ký tư vấn',
                'SUCCEEDED', '2026-10-30T02:00:00Z',
                '{"utm_source":"facebook","utm_campaign":"camp_web_2026"}'::jsonb
            )) AS result;
        `);
        const webResult = (web.rows[0] as { result: { interaction_id: string; phone_match_status: string; is_duplicate_phone: boolean } }).result;
        assert.notEqual(
            (await one(db, `SELECT customer_id AS o FROM public.interactions WHERE company_id='${company}' AND id=${q(webResult.interaction_id)}`)).o,
            phoneOwner,
            'website intake never silently binds to the phone owner',
        );
        assert.equal(webResult.phone_match_status, 'CONFLICT');
        assert.equal(webResult.is_duplicate_phone, true);
        assert.equal(
            Number((await one(db, `SELECT count(*) AS c FROM private.customer_private_contacts WHERE company_id='${company}'`)).c),
            1,
            'no additional automatic phone binding',
        );

        // Zalo and Messenger ingestion paths, plus authorization/RLS, are pinned by
        // tests/omnichannel/facebook_sync.test.ts, meta_messenger_platform.test.ts and the Zalo suites.
    } finally {
        await supabase.close();
    }
});
