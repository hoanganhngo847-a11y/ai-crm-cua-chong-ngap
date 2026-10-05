/**
 * P2-001 Test Fixture Isolation & Repeatability Regression Gate
 *
 * Verifies that real-database test suites run safely and repeatedly on the SAME
 * local Supabase database instance WITHOUT requiring `supabase db reset`.
 *
 * Specifically verifies:
 * 1. Deliberate Stale-Fixture Contamination Regression (Inbox DB):
 *    - Injects an intentionally corrupt/stale conversation row under the deterministic ID
 *      with wrong customer_id, wrong channel, wrong external_id, wrong status, and wrong unread_count.
 *    - Proves that the patched suite cleans and re-establishes canonical facts (whereas
 *      baseline would silently reuse the stale row due to "if (!existingConv) insert").
 *    - Validates persisted database facts (company, customer, channel, external_id, status, unread_count).
 *    - Repeats the Inbox suite a second time without DB reset and verifies canonical facts again.
 * 2. Cross-suite namespace isolation and readability hardening (AI Analysis Worker vs Analytics).
 * 3. Response SLA window fixture idempotency (tests/response-sla/response-sla-db.test.ts run consecutively).
 * 4. Sales style runtime context fixture isolation (tests/sales-style/runtime-style-context.test.ts run consecutively).
 */

import { spawnSync } from 'child_process';
import assert from 'node:assert';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { cleanupCompanyFixtures } from '../helpers/fixture-cleanup';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const TEST_COMPANY_ID = 'a0a0a0a0-0001-4000-8000-000000000001';
const TEST_COMPANY_ID_2 = 'a0a0a0a0-0002-4000-8000-000000000002';
const CANONICAL_CUSTOMER_ID = 'c0c0c0c0-0001-4000-8000-000000000001';
const DIRTY_STALE_CUSTOMER_ID = 'b0b0b0b0-0001-4000-8000-000000000001';
const TEST_CONVERSATION_ID = 'd0d0d0d0-0001-4000-8000-000000000001';

interface Step {
  id: string;
  name: string;
  command: string;
  args: string[];
}

const SUITE_STEPS: Step[] = [
  // --- Stage 2: Cross-Suite Namespace Isolation (AI Worker + Analytics) ---
  {
    id: 'AI_WORKER_RUN_1',
    name: 'AI Analysis Worker — Iteration 1',
    command: 'npx',
    args: ['tsx', '--conditions=react-server', 'tests/ai-analysis/analysis-worker.test.ts'],
  },
  {
    id: 'ANALYTICS_RUN_1',
    name: 'Analytics DB Fixtures — Iteration 1',
    command: 'npx',
    args: ['tsx', '--conditions=react-server', 'tests/analytics/analytics.test.ts'],
  },
  {
    id: 'AI_WORKER_RUN_2',
    name: 'AI Analysis Worker — Iteration 2 (Verifying cross-suite namespace isolation with Analytics)',
    command: 'npx',
    args: ['tsx', '--conditions=react-server', 'tests/ai-analysis/analysis-worker.test.ts'],
  },
  {
    id: 'ANALYTICS_RUN_2',
    name: 'Analytics DB Fixtures — Iteration 2 (Verifying repeatability on dirty DB)',
    command: 'npx',
    args: ['tsx', '--conditions=react-server', 'tests/analytics/analytics.test.ts'],
  },

  // --- Stage 3: Response SLA DB Repeatability ---
  {
    id: 'RESPONSE_SLA_DB_RUN_1',
    name: 'Response SLA DB — Iteration 1',
    command: 'npx',
    args: ['tsx', '--conditions=react-server', 'tests/response-sla/response-sla-db.test.ts'],
  },
  {
    id: 'RESPONSE_SLA_DB_RUN_2',
    name: 'Response SLA DB — Iteration 2 (Verifying window idempotency and non-HAN fixture isolation)',
    command: 'npx',
    args: ['tsx', '--conditions=react-server', 'tests/response-sla/response-sla-db.test.ts'],
  },

  // --- Stage 4: Sales Style Runtime Context Repeatability ---
  {
    id: 'SALES_STYLE_RUNTIME_RUN_1',
    name: 'Sales Style Runtime Context — Iteration 1',
    command: 'npx',
    args: ['tsx', '--conditions=react-server', 'tests/sales-style/runtime-style-context.test.ts'],
  },
  {
    id: 'SALES_STYLE_RUNTIME_RUN_2',
    name: 'Sales Style Runtime Context — Iteration 2 (Verifying cross-suite namespace isolation with Facebook SLA)',
    command: 'npx',
    args: ['tsx', '--conditions=react-server', 'tests/sales-style/runtime-style-context.test.ts'],
  },
];

function executeSubprocess(stepName: string, command: string, args: string[]): void {
  console.log(`\n>>> [EXEC] ${stepName}`);
  const start = Date.now();
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'test',
    },
  });

  const duration = ((Date.now() - start) / 1000).toFixed(1);
  if (result.status !== 0) {
    console.error(`\n❌ [FAIL] ${stepName} failed with exit code ${result.status} (${duration}s)`);
    process.exit(result.status || 1);
  }

  console.log(`✓ [PASS] ${stepName} (${duration}s)`);
}

async function verifyCanonicalInboxFixture(
  client: SupabaseClient,
  stageLabel: string
): Promise<void> {
  console.log(`\n>>> [ASSERT CANONICAL FACTS] ${stageLabel}`);
  const { data: row, error } = await client
    .from('conversations')
    .select('id, company_id, customer_id, channel, external_conversation_id, status, unread_count')
    .eq('id', TEST_CONVERSATION_ID)
    .single();

  assert(!error, `Failed to query conversation ${TEST_CONVERSATION_ID}: ${error?.message}`);
  assert(row, `Conversation ${TEST_CONVERSATION_ID} must exist`);

  // Assert exact canonical business facts
  assert.strictEqual(row.company_id, TEST_COMPANY_ID_2, 'company_id must match canonical TEST_COMPANY_ID_2');
  assert.strictEqual(
    row.customer_id,
    CANONICAL_CUSTOMER_ID,
    `customer_id must be canonical '${CANONICAL_CUSTOMER_ID}' (received '${row.customer_id}'). Stale customer binding must be cleaned.`
  );
  assert.strictEqual(
    row.channel,
    'FACEBOOK',
    `channel must be canonical 'FACEBOOK' (received '${row.channel}'). Stale-fixture channel must be cleaned.`
  );
  assert.strictEqual(
    row.external_conversation_id,
    'fb-conv-test-001',
    `external_conversation_id must be canonical 'fb-conv-test-001' (received '${row.external_conversation_id}').`
  );
  assert.strictEqual(
    row.status,
    'OPEN',
    `status must be canonical 'OPEN' (received '${row.status}'). Stale-fixture status must be cleaned.`
  );
  assert.strictEqual(
    row.unread_count,
    0,
    `unread_count must be canonical 0 (received ${row.unread_count}). Stale count must be cleaned.`
  );

  console.log(`✓ [PASS] Canonical business facts verified for ${TEST_CONVERSATION_ID} (${stageLabel})`);
}

async function main() {
  console.log('================================================================');
  console.log('P2-001 FIXTURE ISOLATION & REPEATABILITY REGRESSION GATE');
  console.log('Verifying consecutive runs on the same local DB without reset');
  console.log('================================================================\n');

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    // ========================================================================
    // Stage 1: Deliberate Stale-Fixture Contamination Regression (Inbox DB)
    // ========================================================================
    console.log('--- STAGE 1: DELIBERATE STALE-FIXTURE CONTAMINATION REGRESSION ---');

    // 1A. Pre-clean suite-owned namespace to guarantee known initial state
    console.log('1A. Initializing suite-owned company namespace...');
    cleanupCompanyFixtures([TEST_COMPANY_ID, TEST_COMPANY_ID_2]);

    // Seed parent company and dirty customer for foreign key requirements
    const { error: cErr } = await adminClient.from('companies').upsert({
      id: TEST_COMPANY_ID_2,
      name: 'Test Outbound Company',
      status: 'ACTIVE',
    }, { onConflict: 'id' });
    if (cErr) {
      throw new Error(`Failed to upsert company: ${cErr.message}`);
    }

    const { error: custErr } = await adminClient.from('customers').insert({
      id: DIRTY_STALE_CUSTOMER_ID,
      company_id: TEST_COMPANY_ID_2,
      name: 'Dirty Stale Customer',
      customer_code: 'KC-DIRTY-TEST',
      stage: 'LEAD_NEW',
      source: 'ZALO',
    });
    if (custErr) {
      throw new Error(`Failed to insert dirty customer: ${custErr.message}`);
    }

    // 1B. Deliberately inject stale/corrupt conversation row under deterministic TEST_CONVERSATION_ID
    console.log('1B. Deliberately injecting stale/corrupted conversation fixture...');
    const { error: staleErr } = await adminClient.from('conversations').insert({
      id: TEST_CONVERSATION_ID,
      company_id: TEST_COMPANY_ID_2,
      customer_id: DIRTY_STALE_CUSTOMER_ID, // CORRUPTED: canonical is CANONICAL_CUSTOMER_ID
      channel: 'ZALO', // CORRUPTED: canonical is 'FACEBOOK'
      external_conversation_id: 'corrupt_stale_ext_id_999', // CORRUPTED: canonical is 'fb-conv-test-001'
      status: 'CLOSED', // CORRUPTED: canonical is 'OPEN'
      unread_count: 42, // CORRUPTED: canonical is 0
    });
    if (staleErr) {
      throw new Error(`Failed to inject stale fixture: ${staleErr.message}`);
    }

    // Verify stale row is actively corrupt before suite execution
    const { data: injectedStale } = await adminClient
      .from('conversations')
      .select('customer_id, channel, external_conversation_id, status, unread_count')
      .eq('id', TEST_CONVERSATION_ID)
      .single();
    assert.strictEqual(
      injectedStale?.customer_id,
      DIRTY_STALE_CUSTOMER_ID,
      'Injected row must have dirty customer_id'
    );
    assert.strictEqual(injectedStale?.channel, 'ZALO', 'Injected row must have dirty channel ZALO');
    assert.strictEqual(
      injectedStale?.external_conversation_id,
      'corrupt_stale_ext_id_999',
      'Injected row must have dirty external id'
    );
    assert.strictEqual(injectedStale?.status, 'CLOSED', 'Injected row must have dirty status CLOSED');
    assert.strictEqual(injectedStale?.unread_count, 42, 'Injected row must have dirty unread_count 42');
    console.log(
      '✓ Injected dirty fixture confirmed: customer_id=' +
        DIRTY_STALE_CUSTOMER_ID +
        ', channel=ZALO, external_id=corrupt_stale_ext_id_999, status=CLOSED, unread=42'
    );

    // 1C. Run Inbox DB Suite — Iteration 1
    // Patched behavior: seedTestData performs cleanupCompanyFixtures, deleting stale row,
    // then performs canonical direct INSERT.
    // (Baseline behavior: sees existing fixed ID -> skips insert -> leaves dirty row -> assertion below fails).
    executeSubprocess(
      'Inbox DB Suite — Iteration 1 (Cleans dirty fixture & re-seeds canonical facts)',
      'npx',
      ['tsx', '--conditions=react-server', 'tests/inbox/database.test.ts']
    );

    // 1D. Assert canonical persisted database facts
    await verifyCanonicalInboxFixture(adminClient, 'Post-Run 1 Verification');

    // 1E. Run Inbox DB Suite — Iteration 2 (Immediate repeat on same DB without reset)
    executeSubprocess(
      'Inbox DB Suite — Iteration 2 (Immediate repeat without DB reset, verifying repeatable isolation)',
      'npx',
      ['tsx', '--conditions=react-server', 'tests/inbox/database.test.ts']
    );

    // 1F. Assert canonical persisted database facts again
    await verifyCanonicalInboxFixture(adminClient, 'Post-Run 2 Verification');

    // ========================================================================
    // Stage 2–4: Consecutive Repeatability Across Real-DB Suites
    // ========================================================================
    for (const step of SUITE_STEPS) {
      executeSubprocess(step.name, step.command, step.args);
    }

    console.log('\n================================================================');
    console.log('FIXTURE REPEATABILITY GATE PASSED: ALL STEPS & ASSERTIONS OK');
    console.log('1. Deliberate stale-fixture contamination caught, cleaned, and reconciled.');
    console.log('2. Canonical persisted business facts verified in DB across repeated runs.');
    console.log('3. Cross-suite namespace isolation and repeatability proven without DB reset.');
    console.log('================================================================\n');
  } finally {
    // Clean up suite-owned inbox fixtures
    cleanupCompanyFixtures([TEST_COMPANY_ID, TEST_COMPANY_ID_2]);
  }
}

main().catch((err) => {
  console.error('\n❌ Fatal regression gate runner error:', err);
  process.exit(1);
});
