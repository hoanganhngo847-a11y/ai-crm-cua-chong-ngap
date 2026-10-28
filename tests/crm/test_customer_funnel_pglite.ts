import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createPgliteSupabase } from '../zalo/helpers/pglite-supabase';

const MIGRATION_PREFIX = '20261028130000_customer_funnel_six_stages';

const COMPANY_A = '90000000-0000-0000-0000-000000000001';
const COMPANY_B = '90000000-0000-0000-0000-000000000002';

const BOSS_USER = '91000000-0000-0000-0000-000000000001';
const SALE_USER = '91000000-0000-0000-0000-000000000002';

const C_LEAD = '92000000-0000-0000-0000-000000000001';
const C_PRICE = '92000000-0000-0000-0000-000000000002';
const C_CARE = '92000000-0000-0000-0000-000000000003';
const C_LOST = '92000000-0000-0000-0000-000000000004';
const C_SURVEY = '92000000-0000-0000-0000-000000000005';
const C_COMPANY_B = '92000000-0000-0000-0000-000000000006';
const C_VERIFY = '92000000-0000-0000-0000-000000000007';

const INTERACTION_1 = '93000000-0000-0000-0000-000000000001';

let passCount = 0;
let failCount = 0;

function check(condition: boolean, message: string) {
  if (condition) {
    passCount++;
    console.log(`✓ PASS: ${message}`);
  } else {
    failCount++;
    console.error(`✗ FAIL: ${message}`);
  }
}

async function main() {
  console.log('='.repeat(72));
  console.log('CUSTOMER FUNNEL MIGRATION + RPC TESTS (PGlite / real PostgreSQL)');
  console.log('='.repeat(72));

  const supabase = await createPgliteSupabase({ skipMigrations: [MIGRATION_PREFIX] });
  const { db } = supabase;

  try {
    // -------------------------------------------------------------------------
    console.log('\n--- 1. Seed legacy data BEFORE the funnel migration ---');
    await db.exec(`
      INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        ('${BOSS_USER}', 'funnel_boss@test.local', '{"full_name":"Funnel Boss"}'::jsonb),
        ('${SALE_USER}', 'funnel_sale@test.local', '{"full_name":"Funnel Sale"}'::jsonb);

      INSERT INTO public.companies (id, name, status) VALUES
        ('${COMPANY_A}', 'Funnel Company A', 'ACTIVE'),
        ('${COMPANY_B}', 'Funnel Company B', 'ACTIVE');

      INSERT INTO public.customers
        (id, company_id, customer_code, name, source, stage, created_at, updated_at)
      VALUES
        ('${C_LEAD}', '${COMPANY_A}', 'KH-FUN-001', 'Khách LEAD', 'FACEBOOK', 'LEAD_NEW', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
        ('${C_PRICE}', '${COMPANY_A}', 'KH-FUN-002', 'Khách PRICE', 'ZALO', 'PRICE_OFFERED', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
        ('${C_CARE}', '${COMPANY_A}', 'KH-FUN-003', 'Khách CARE', 'WEBSITE', 'CARE_NURTURING', '2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z'),
        ('${C_LOST}', '${COMPANY_A}', 'KH-FUN-004', 'Khách LOST', 'FACEBOOK', 'LOST', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z'),
        ('${C_SURVEY}', '${COMPANY_A}', 'KH-FUN-005', 'Khách SURVEY', 'ZALO', 'SURVEY_REQUESTED', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z'),
        ('${C_COMPANY_B}', '${COMPANY_B}', 'KH-FUN-006', 'Khách B', 'FACEBOOK', 'LEAD_NEW', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z');
    `);
    check(true, 'Legacy customers seeded');

    // -------------------------------------------------------------------------
    console.log('\n--- 2. Apply the funnel migration to legacy data ---');
    const migrationDir = path.resolve(process.cwd(), 'supabase/migrations');
    const migrationFile = fs
      .readdirSync(migrationDir)
      .find((file) => file.startsWith(MIGRATION_PREFIX));
    assert(migrationFile, 'Funnel migration file must exist');
    const migrationSql = fs.readFileSync(path.join(migrationDir, migrationFile), 'utf8');
    await db.exec(migrationSql);
    check(true, 'Funnel migration applied on a database containing legacy stages');

    // Canonical-only rows are created after the migration (the old constraint
    // would reject lowercase values, which is exactly why the migration exists).
    await db.exec(`
      INSERT INTO public.customers
        (id, company_id, customer_code, name, source, stage, created_at, updated_at)
      VALUES
        ('${C_VERIFY}', '${COMPANY_A}', 'KH-FUN-007', 'Khách xác minh AI', 'ZALO', 'awareness', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z');

      INSERT INTO public.interactions
        (id, company_id, customer_id, channel, type, direction, sanitized_content,
         sanitization_status, sanitized_at, actor_type, created_at)
      VALUES
        ('${INTERACTION_1}', '${COMPANY_A}', '${C_VERIFY}', 'ZALO', 'MESSAGE', 'INBOUND',
         'Tôi muốn ký hợp đồng, giá bao nhiêu?', 'SUCCEEDED', now(), 'CUSTOMER', now());
    `);

    const stages = await db.query<{ id: string; stage: string }>(
      `SELECT id, stage FROM public.customers ORDER BY customer_code`
    );
    const stageById = new Map(stages.rows.map((row) => [row.id, row.stage]));

    check(stageById.get(C_LEAD) === 'awareness', 'LEAD_NEW → awareness');
    check(stageById.get(C_PRICE) === 'PRICE_OFFERED', 'PRICE_OFFERED is left unchanged for review');
    check(stageById.get(C_CARE) === 'CARE_NURTURING', 'CARE_NURTURING is left unchanged for review');
    check(stageById.get(C_LOST) === 'low_potential', 'LOST → low_potential');
    check(stageById.get(C_SURVEY) === 'SURVEY_REQUESTED', 'SURVEY_REQUESTED is left unchanged for review');
    check(stageById.get(C_COMPANY_B) === 'awareness', 'LEAD_NEW in company B → awareness');

    const history = await db.query<{
      customer_id: string;
      from_stage: string;
      to_stage: string;
      actor_type: string;
      source_ref: string;
      verification_status: string;
    }>(
      `SELECT customer_id, from_stage, to_stage, actor_type, source_ref, verification_status
       FROM public.customer_stage_histories
       ORDER BY customer_id`
    );
    check(history.rows.length === 3, `Exactly 3 SYSTEM history rows written (got ${history.rows.length})`);
    check(
      history.rows.every(
        (row) =>
          row.actor_type === 'SYSTEM' &&
          row.source_ref === 'MIGRATION_20261028130000' &&
          row.verification_status === 'VERIFIED'
      ),
      'Migration history rows are SYSTEM + VERIFIED + tagged with migration source'
    );
    const leadHistory = history.rows.find((row) => row.customer_id === C_LEAD);
    check(
      leadHistory?.from_stage === 'LEAD_NEW' && leadHistory?.to_stage === 'awareness',
      'History keeps the original legacy stage as from_stage'
    );

    const audit = await db.query<{
      action: string;
      legacy_stage: string;
      canonical_stage: string | null;
      customer_count: number;
      company_id: string;
    }>(
      `SELECT action, legacy_stage, canonical_stage, customer_count::int, company_id
       FROM public.customer_stage_migration_audit
       ORDER BY action, legacy_stage`
    );
    const mapped = audit.rows.filter((row) => row.action === 'MAPPED');
    const review = audit.rows.filter((row) => row.action === 'LEFT_FOR_REVIEW');
    const before = audit.rows.filter((row) => row.action === 'TOTAL_BEFORE');
    const after = audit.rows.filter((row) => row.action === 'TOTAL_AFTER');

    check(mapped.length === 3, `MAPPED audit covers 3 legacy stages (got ${mapped.length})`);
    check(
      mapped.some((row) => row.legacy_stage === 'LEAD_NEW' && row.canonical_stage === 'awareness'),
      'Audit records LEAD_NEW → awareness'
    );
    check(
      review.some((row) => row.legacy_stage === 'PRICE_OFFERED' && row.canonical_stage === 'high_potential'),
      'Audit flags PRICE_OFFERED as review-only with a suggested canonical stage'
    );
    check(
      review.some((row) => row.legacy_stage === 'SURVEY_REQUESTED') &&
        review.some((row) => row.legacy_stage === 'CARE_NURTURING'),
      'Audit flags SURVEY_REQUESTED and CARE_NURTURING for review'
    );
    check(
      before.reduce((sum, row) => sum + row.customer_count, 0) === 6 &&
        after.reduce((sum, row) => sum + row.customer_count, 0) === 6,
      'Migration audit proves no customer was lost (6 before = 6 after)'
    );
    check(
      before.some((row) => row.company_id === COMPANY_A && row.customer_count === 5) &&
        before.some((row) => row.company_id === COMPANY_B && row.customer_count === 1),
      'Migration audit is scoped per company'
    );

    // -------------------------------------------------------------------------
    console.log('\n--- 3. Canonical stage function + CHECK constraint ---');
    const canonical = await db.query<{ a: string; b: string; c: string | null; d: string | null }>(
      `SELECT public.canonical_customer_stage('PRICE_OFFERED') AS a,
              public.canonical_customer_stage('  deep_research ') AS b,
              public.canonical_customer_stage('bogus') AS c,
              public.canonical_customer_stage(NULL) AS d`
    );
    check(canonical.rows[0].a === 'high_potential', 'canonical_customer_stage maps PRICE_OFFERED');
    check(canonical.rows[0].b === 'deep_research', 'canonical_customer_stage trims and lowercases');
    check(canonical.rows[0].c === null && canonical.rows[0].d === null, 'Unknown/NULL stage returns NULL (fail-closed)');

    let constraintRejected = false;
    try {
      await db.query(
        `INSERT INTO public.customers (company_id, customer_code, name, source, stage)
         VALUES ($1, 'KH-FUN-BAD', 'Bad stage', 'MANUAL', 'bogus')`,
        [COMPANY_A]
      );
    } catch {
      constraintRejected = true;
    }
    check(constraintRejected, 'CHECK constraint rejects an unknown stage');

    await db.query(
      `INSERT INTO public.customers (company_id, customer_code, name, source, stage)
       VALUES ($1, 'KH-FUN-DEEP', 'Deep research', 'MANUAL', 'deep_research')`,
      [COMPANY_A]
    );
    check(true, 'CHECK constraint accepts the canonical deep_research stage');

    // -------------------------------------------------------------------------
    console.log('\n--- 4. get_customer_stage_counts (shared Kanban/Funnel source) ---');
    const countsResult = await supabase.client.rpc('get_customer_stage_counts', {
      p_company_id: COMPANY_A,
    });
    check(!countsResult.error, `get_customer_stage_counts succeeds (${countsResult.error?.message || 'ok'})`);
    const counts = new Map<string, { count: number; review: number }>(
      (countsResult.data || []).map((row: any) => [
        row.stage,
        { count: Number(row.customer_count), review: Number(row.needs_review_count) },
      ])
    );
    check(counts.get('awareness')?.count === 2, 'awareness count = 2 (LEAD_NEW mapped + canonical row)');
    check(counts.get('interested')?.count === 1, 'interested count = 1 (SURVEY_REQUESTED legacy)');
    check(counts.get('interested')?.review === 1, 'interested review count = 1');
    check(counts.get('deep_research')?.count === 1, 'deep_research count = 1 (new canonical row)');
    check(counts.get('low_potential')?.count === 1, 'low_potential count = 1 (LOST mapped)');
    check(counts.get('high_potential')?.count === 1, 'high_potential count = 1 (PRICE_OFFERED legacy)');
    check(counts.get('high_potential')?.review === 1, 'high_potential review count = 1');
    check(counts.get('contract_signed')?.count === 1, 'contract_signed count = 1 (CARE_NURTURING legacy)');
    check(counts.get('contract_signed')?.review === 1, 'contract_signed review count = 1');
    check(!counts.has('unmapped'), 'No unmapped bucket when every stage is recognized');

    const filteredCounts = await supabase.client.rpc('get_customer_stage_counts', {
      p_company_id: COMPANY_A,
      p_source: 'ZALO',
    });
    const filtered = new Map<string, number>(
      (filteredCounts.data || []).map((row: any) => [row.stage, Number(row.customer_count)])
    );
    check(filtered.get('high_potential') === 1, 'Source filter keeps PRICE_OFFERED (ZALO)');
    check(filtered.get('awareness') === 1, 'Source filter keeps canonical awareness row (ZALO)');

    const searched = await supabase.client.rpc('get_customer_stage_counts', {
      p_company_id: COMPANY_A,
      p_search: 'Khách PRICE',
    });
    const searchedMap = new Map<string, number>(
      (searched.data || []).map((row: any) => [row.stage, Number(row.customer_count)])
    );
    check(searchedMap.get('high_potential') === 1, 'Search filter matches customer name');
    check(
      [...searchedMap.entries()].filter(([stage, count]) => stage !== 'high_potential' && count > 0)
        .length === 0,
      'Search filter excludes non-matching customers'
    );

    const tenantCounts = await supabase.client.rpc('get_customer_stage_counts', {
      p_company_id: COMPANY_B,
    });
    const tenantMap = new Map<string, number>(
      (tenantCounts.data || []).map((row: any) => [row.stage, Number(row.customer_count)])
    );
    check(tenantMap.get('awareness') === 1, 'Tenant B only sees its own customer');

    // -------------------------------------------------------------------------
    console.log('\n--- 5. update_customer_stage_atomic ---');
    const beforeHistory = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.customer_stage_histories WHERE customer_id = $1`,
      [C_LEAD]
    );

    const moved = await supabase.client.rpc('update_customer_stage_atomic', {
      p_company_id: COMPANY_A,
      p_customer_id: C_LEAD,
      p_new_stage: 'interested',
      p_note: 'Khách hỏi giá và muốn tư vấn thêm',
      p_changed_by: SALE_USER,
      p_actor_type: 'USER',
      p_expected_stage: 'awareness',
    });
    check(!moved.error, `Atomic stage move succeeds (${moved.error?.message || 'ok'})`);
    check(moved.data?.changed === true, 'Atomic move reports changed=true');
    check(moved.data?.customer?.stage === 'interested', 'Customer row is updated to interested');
    check(moved.data?.history?.from_stage === 'awareness', 'History from_stage = awareness');
    check(moved.data?.history?.to_stage === 'interested', 'History to_stage = interested');
    check(moved.data?.history?.verification_status === 'VERIFIED', 'User move is marked VERIFIED');
    check(moved.data?.history?.changed_by_user_id === SALE_USER, 'History records the acting user');
    check(
      moved.data?.history?.reason === 'Khách hỏi giá và muốn tư vấn thêm',
      'History keeps the operator note as reason'
    );

    const noop = await supabase.client.rpc('update_customer_stage_atomic', {
      p_company_id: COMPANY_A,
      p_customer_id: C_LEAD,
      p_new_stage: 'IN_CARE',
      p_note: 'Không đổi gì',
      p_changed_by: SALE_USER,
      p_actor_type: 'USER',
      p_expected_stage: 'interested',
    });
    check(!noop.error, `Legacy no-op move succeeds (${noop.error?.message || 'ok'})`);
    check(noop.data?.changed === false, 'No-op move reports changed=false');
    check(noop.data?.history === null, 'No-op move does not create noisy history');
    const afterHistory = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.customer_stage_histories WHERE customer_id = $1`,
      [C_LEAD]
    );
    check(afterHistory.rows[0].n === beforeHistory.rows[0].n + 1, 'Only the real move appended history');

    const conflict = await supabase.client.rpc('update_customer_stage_atomic', {
      p_company_id: COMPANY_A,
      p_customer_id: C_LEAD,
      p_new_stage: 'high_potential',
      p_expected_stage: 'awareness',
    });
    check(
      !!conflict.error && conflict.error.message.includes('STAGE_CONFLICT'),
      'Optimistic concurrency rejects a stale expected_stage with STAGE_CONFLICT'
    );

    const tenantMismatch = await supabase.client.rpc('update_customer_stage_atomic', {
      p_company_id: COMPANY_B,
      p_customer_id: C_LEAD,
      p_new_stage: 'high_potential',
    });
    check(
      !!tenantMismatch.error && tenantMismatch.error.message.includes('CUSTOMER_NOT_FOUND'),
      'Cross-tenant stage update is rejected with CUSTOMER_NOT_FOUND'
    );

    const invalidStage = await supabase.client.rpc('update_customer_stage_atomic', {
      p_company_id: COMPANY_A,
      p_customer_id: C_LEAD,
      p_new_stage: 'not_a_stage',
    });
    check(
      !!invalidStage.error && invalidStage.error.message.includes('INVALID_STAGE'),
      'Unknown target stage is rejected with INVALID_STAGE'
    );

    const invalidConfidence = await supabase.client.rpc('update_customer_stage_atomic', {
      p_company_id: COMPANY_A,
      p_customer_id: C_LEAD,
      p_new_stage: 'high_potential',
      p_confidence: 1.5,
    });
    check(
      !!invalidConfidence.error && invalidConfidence.error.message.includes('INVALID_CONFIDENCE'),
      'Confidence outside [0,1] is rejected'
    );

    // -------------------------------------------------------------------------
    console.log('\n--- 6. record_ai_analysis: dedupe + non-mutating suggestions ---');
    const sourceRefs = JSON.stringify([{ type: 'INTERACTION', id: INTERACTION_1 }]);
    const dedupeKey = 'a'.repeat(64);

    const recordParams = {
      p_company_id: COMPANY_A,
      p_customer_id: C_VERIFY,
      p_source_refs: sourceRefs,
      p_summary: 'Khách muốn ký hợp đồng và hỏi giá.',
      p_stage_suggestion: 'high_potential',
      p_stop_reason: null,
      p_objections: JSON.stringify([]),
      p_next_action: 'Gửi báo giá chính thức.',
      p_confidence: 0.72,
      p_evidence: 'Tôi muốn ký hợp đồng, giá bao nhiêu?',
      p_model_version: 'test-model-v1',
      p_current_stage: 'awareness',
      p_reason: 'Khách thể hiện ý định ký và hỏi giá.',
      p_requires_verification: true,
      p_evidence_items: JSON.stringify([
        {
          quote: 'Tôi muốn ký hợp đồng',
          source: 'ZALO',
          speaker: 'CUSTOMER',
          occurredAt: '2026-07-01T00:00:00Z',
          signal: 'high_contract_next',
          stage: 'high_potential',
          weight: 0.6,
        },
      ]),
      p_dedupe_key: dedupeKey,
      p_classifier_version: 'stage-rules-v1',
    };

    const firstRecord = await supabase.client.rpc('record_ai_analysis', recordParams);
    check(!firstRecord.error, `record_ai_analysis succeeds (${firstRecord.error?.message || 'ok'})`);
    const firstRow = Array.isArray(firstRecord.data) ? firstRecord.data[0] : firstRecord.data;
    check(firstRow?.stage_suggestion === 'high_potential', 'AI suggestion is stored as high_potential');
    check(firstRow?.current_stage === 'awareness', 'Current stage snapshot is stored');
    check(firstRow?.verification_status === 'PENDING', 'New AI suggestion is PENDING verification');
    check(firstRow?.requires_verification === true, 'AI suggestion requires verification');
    check(firstRow?.dedupe_key === dedupeKey, 'Dedupe key is persisted');

    const customerAfterRecord = await db.query<{ stage: string }>(
      `SELECT stage FROM public.customers WHERE id = $1`,
      [C_VERIFY]
    );
    check(
      customerAfterRecord.rows[0].stage === 'awareness',
      'Recording an AI suggestion does NOT mutate the official stage'
    );

    const duplicateRecord = await supabase.client.rpc('record_ai_analysis', recordParams);
    const duplicateRow = Array.isArray(duplicateRecord.data)
      ? duplicateRecord.data[0]
      : duplicateRecord.data;
    check(!duplicateRecord.error, 'Reprocessing the same conversation succeeds idempotently');
    check(duplicateRow?.id === firstRow?.id, 'Reprocessing returns the existing analysis id');
    const analysisCount = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.ai_analyses WHERE customer_id = $1`,
      [C_VERIFY]
    );
    check(analysisCount.rows[0].n === 1, 'No duplicate AI note is created for the same dedupe key');

    const legacySuggestion = await supabase.client.rpc('record_ai_analysis', {
      ...recordParams,
      p_stage_suggestion: 'PRICE_OFFERED',
      p_dedupe_key: 'b'.repeat(64),
    });
    const legacyRow = Array.isArray(legacySuggestion.data)
      ? legacySuggestion.data[0]
      : legacySuggestion.data;
    check(
      legacyRow?.stage_suggestion === 'high_potential',
      'Legacy AI stage suggestion is normalized to canonical before storage'
    );

    const badDedupe = await supabase.client.rpc('record_ai_analysis', {
      ...recordParams,
      p_dedupe_key: 'not-a-sha256',
    });
    check(
      !!badDedupe.error && badDedupe.error.message.includes('INVALID_DEDUPE_KEY'),
      'Malformed dedupe key is rejected'
    );

    const sensitiveEvidence = await supabase.client.rpc('record_ai_analysis', {
      ...recordParams,
      p_dedupe_key: 'c'.repeat(64),
      p_evidence_items: JSON.stringify([
        { quote: 'Tôi muốn ký hợp đồng', source: 'ZALO', phone: '0912345678' },
      ]),
    });
    check(
      !!sensitiveEvidence.error &&
        sensitiveEvidence.error.message.includes('SENSITIVE_DATA_IN_EVIDENCE_ITEM'),
      'Evidence items carrying phone/raw payload are rejected'
    );

    // -------------------------------------------------------------------------
    console.log('\n--- 7. get_customer_stage_suggestions ---');
    const suggestions = await supabase.client.rpc('get_customer_stage_suggestions', {
      p_company_id: COMPANY_A,
      p_customer_id: C_VERIFY,
      p_limit: 10,
    });
    check(!suggestions.error, `Suggestion read succeeds (${suggestions.error?.message || 'ok'})`);
    check(Array.isArray(suggestions.data) && suggestions.data.length === 2, 'Both AI suggestions are returned');
    check(
      new Date(suggestions.data[0].created_at).getTime() >
        new Date(suggestions.data[1].created_at).getTime(),
      'Suggestions are ordered newest first'
    );
    check(
      suggestions.data.every((row: any) => row.verification_status === 'PENDING'),
      'Suggestions remain PENDING until a human verifies them'
    );

    const otherTenantSuggestions = await supabase.client.rpc('get_customer_stage_suggestions', {
      p_company_id: COMPANY_B,
      p_customer_id: C_VERIFY,
      p_limit: 10,
    });
    check(
      !!otherTenantSuggestions.error &&
        otherTenantSuggestions.error.message.includes('TENANT_MISMATCH'),
      'Cross-tenant suggestion read is rejected'
    );

    // -------------------------------------------------------------------------
    console.log('\n--- 8. verify_ai_stage_suggestion ---');
    // 8a. SALE cannot accept contract_signed.
    const contractAnalysis = await supabase.client.rpc('record_ai_analysis', {
      ...recordParams,
      p_stage_suggestion: 'contract_signed',
      p_confidence: 0.7,
      p_dedupe_key: 'd'.repeat(64),
    });
    const contractRow = Array.isArray(contractAnalysis.data)
      ? contractAnalysis.data[0]
      : contractAnalysis.data;
    check(!!contractRow?.id, 'Contract-signed suggestion stored for verification test');

    const wrongCustomerVerify = await supabase.client.rpc('verify_ai_stage_suggestion', {
      p_company_id: COMPANY_A,
      p_analysis_id: contractRow.id,
      p_customer_id: C_LEAD,
      p_decision: 'ACCEPTED',
      p_verified_by: BOSS_USER,
      p_verifier_role: 'BOSS_ADMIN',
      p_note: 'Áp dụng nhầm khách hàng.',
    });
    check(
      !!wrongCustomerVerify.error &&
        wrongCustomerVerify.error.message.includes('ANALYSIS_NOT_FOUND'),
      'Analysis cannot be applied through another customer URL'
    );
    const stageAfterWrongCustomer = await db.query<{ stage: string }>(
      `SELECT stage FROM public.customers WHERE id = $1`,
      [C_VERIFY]
    );
    check(
      stageAfterWrongCustomer.rows[0].stage === 'awareness',
      'Wrong-customer rejection does not mutate the official stage'
    );

    const saleAcceptContract = await supabase.client.rpc('verify_ai_stage_suggestion', {
      p_company_id: COMPANY_A,
      p_analysis_id: contractRow.id,
      p_customer_id: C_VERIFY,
      p_decision: 'ACCEPTED',
      p_verified_by: SALE_USER,
      p_verifier_role: 'SALE',
      p_note: 'Tôi đã kiểm tra hợp đồng giấy.',
    });
    check(
      !!saleAcceptContract.error &&
        saleAcceptContract.error.message.includes('CONTRACT_SIGNED_REQUIRES_BOSS_ADMIN'),
      'SALE cannot accept contract_signed (BOSS_ADMIN only)'
    );

    // 8a-bis. BOSS_ADMIN must still provide a real written verification note.
    const bossShortNote = await supabase.client.rpc('verify_ai_stage_suggestion', {
      p_company_id: COMPANY_A,
      p_analysis_id: contractRow.id,
      p_customer_id: C_VERIFY,
      p_decision: 'ACCEPTED',
      p_verified_by: BOSS_USER,
      p_verifier_role: 'BOSS_ADMIN',
      p_note: 'đã ký',
    });
    check(
      !!bossShortNote.error &&
        bossShortNote.error.message.includes('CONTRACT_SIGNED_NOTE_REQUIRED'),
      'BOSS_ADMIN needs a verification note of at least 10 characters for contract_signed'
    );
    const stageAfterShortNote = await db.query<{ stage: string }>(
      `SELECT stage FROM public.customers WHERE id = $1`,
      [C_VERIFY]
    );
    check(
      stageAfterShortNote.rows[0].stage === 'awareness',
      'Short-note rejection does not mutate the official stage'
    );

    // 8b. BOSS_ADMIN can accept it, with an atomic history row.
    const bossAcceptContract = await supabase.client.rpc('verify_ai_stage_suggestion', {
      p_company_id: COMPANY_A,
      p_analysis_id: contractRow.id,
      p_customer_id: C_VERIFY,
      p_decision: 'ACCEPTED',
      p_verified_by: BOSS_USER,
      p_verifier_role: 'BOSS_ADMIN',
      p_note: 'Đã đối chiếu hợp đồng giấy có chữ ký.',
    });
    check(
      !bossAcceptContract.error,
      `BOSS_ADMIN accepts contract_signed (${bossAcceptContract.error?.message || 'ok'})`
    );
    check(
      bossAcceptContract.data?.customer?.stage === 'contract_signed',
      'Acceptance moves the official stage to contract_signed'
    );
    check(
      bossAcceptContract.data?.history?.source_ref === `AI_ANALYSIS:${contractRow.id}`,
      'History links back to the verified AI analysis'
    );
    check(
      bossAcceptContract.data?.analysis?.verification_status === 'ACCEPTED',
      'Analysis is marked ACCEPTED'
    );

    const acceptAgain = await supabase.client.rpc('verify_ai_stage_suggestion', {
      p_company_id: COMPANY_A,
      p_analysis_id: contractRow.id,
      p_customer_id: C_VERIFY,
      p_decision: 'ACCEPTED',
      p_verified_by: BOSS_USER,
      p_verifier_role: 'BOSS_ADMIN',
      p_note: 'Lặp lại',
    });
    check(
      !!acceptAgain.error && acceptAgain.error.message.includes('ANALYSIS_ALREADY_VERIFIED'),
      'An analysis cannot be verified twice'
    );

    // 8c. Rejection does not change the stage.
    const rejectTarget = await supabase.client.rpc('record_ai_analysis', {
      ...recordParams,
      p_stage_suggestion: 'deep_research',
      p_dedupe_key: 'e'.repeat(64),
    });
    const rejectRow = Array.isArray(rejectTarget.data) ? rejectTarget.data[0] : rejectTarget.data;
    const reject = await supabase.client.rpc('verify_ai_stage_suggestion', {
      p_company_id: COMPANY_A,
      p_analysis_id: rejectRow.id,
      p_customer_id: C_VERIFY,
      p_decision: 'REJECTED',
      p_verified_by: SALE_USER,
      p_verifier_role: 'SALE',
      p_note: 'Khách chỉ hỏi giá, chưa nghiên cứu sâu.',
    });
    check(!reject.error, `Rejection succeeds (${reject.error?.message || 'ok'})`);
    check(reject.data?.customer === null, 'Rejection returns no customer mutation');
    const stageAfterReject = await db.query<{ stage: string }>(
      `SELECT stage FROM public.customers WHERE id = $1`,
      [C_VERIFY]
    );
    check(
      stageAfterReject.rows[0].stage === 'contract_signed',
      'Rejection leaves the official stage unchanged'
    );
    check(
      reject.data?.analysis?.verification_status === 'REJECTED',
      'Rejected analysis is marked REJECTED'
    );

    // 8d. Stale analysis cannot be accepted after a manual stage change.
    const staleTarget = await supabase.client.rpc('record_ai_analysis', {
      ...recordParams,
      p_stage_suggestion: 'high_potential',
      p_current_stage: 'contract_signed',
      p_dedupe_key: 'f'.repeat(64),
    });
    const staleRow = Array.isArray(staleTarget.data) ? staleTarget.data[0] : staleTarget.data;
    await supabase.client.rpc('update_customer_stage_atomic', {
      p_company_id: COMPANY_A,
      p_customer_id: C_VERIFY,
      p_new_stage: 'low_potential',
      p_note: 'Khách đổi ý, không làm nữa.',
      p_changed_by: BOSS_USER,
      p_expected_stage: 'contract_signed',
    });
    const staleAccept = await supabase.client.rpc('verify_ai_stage_suggestion', {
      p_company_id: COMPANY_A,
      p_analysis_id: staleRow.id,
      p_customer_id: C_VERIFY,
      p_decision: 'ACCEPTED',
      p_verified_by: BOSS_USER,
      p_verifier_role: 'BOSS_ADMIN',
      p_note: 'Chấp nhận đề xuất cũ.',
    });
    check(
      !!staleAccept.error &&
        staleAccept.error.message.includes('STAGE_CHANGED_SINCE_ANALYSIS'),
      'Acceptance is rejected when the customer stage changed after the analysis'
    );

    // 8e. Invalid role/decision guards.
    const invalidRole = await supabase.client.rpc('verify_ai_stage_suggestion', {
      p_company_id: COMPANY_A,
      p_analysis_id: staleRow.id,
      p_customer_id: C_VERIFY,
      p_decision: 'ACCEPTED',
      p_verified_by: BOSS_USER,
      p_verifier_role: 'TECHNICIAN',
    });
    check(
      !!invalidRole.error && invalidRole.error.message.includes('ROLE_FORBIDDEN'),
      'Technician role cannot verify AI suggestions'
    );

    const invalidDecision = await supabase.client.rpc('verify_ai_stage_suggestion', {
      p_company_id: COMPANY_A,
      p_analysis_id: staleRow.id,
      p_customer_id: C_VERIFY,
      p_decision: 'MAYBE',
      p_verified_by: BOSS_USER,
      p_verifier_role: 'BOSS_ADMIN',
    });
    check(
      !!invalidDecision.error && invalidDecision.error.message.includes('INVALID_DECISION'),
      'Invalid verification decision is rejected'
    );

    // -------------------------------------------------------------------------
    console.log('\n--- 9. Transcript input RPC guards ---');
    const emptyTranscript = await supabase.client.rpc('get_customer_call_transcript_input', {
      p_company_id: COMPANY_A,
      p_customer_id: C_VERIFY,
      p_limit: 10,
    });
    check(!emptyTranscript.error, `Transcript read succeeds for a customer without calls (${emptyTranscript.error?.message || 'ok'})`);
    check(Array.isArray(emptyTranscript.data) && emptyTranscript.data.length === 0, 'No transcript rows are fabricated');

    const transcriptTenant = await supabase.client.rpc('get_customer_call_transcript_input', {
      p_company_id: COMPANY_B,
      p_customer_id: C_VERIFY,
      p_limit: 10,
    });
    check(
      !!transcriptTenant.error && transcriptTenant.error.message.includes('TENANT_MISMATCH'),
      'Cross-tenant transcript read is rejected'
    );

    const transcriptLimit = await supabase.client.rpc('get_customer_call_transcript_input', {
      p_company_id: COMPANY_A,
      p_customer_id: C_VERIFY,
      p_limit: 500,
    });
    check(
      !!transcriptLimit.error && transcriptLimit.error.message.includes('INVALID_LIMIT'),
      'Transcript limit is bounded'
    );
  } finally {
    await supabase.close();
  }

  console.log('\n' + '='.repeat(72));
  console.log(`RESULT: ${passCount} passed, ${failCount} failed`);
  console.log('='.repeat(72));

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal test error:', error);
  process.exit(1);
});
