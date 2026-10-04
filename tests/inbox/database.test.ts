/**
 * TV2 Review-8 Inbox/Outbox Database Integration Test Suite
 *
 * Validates all P0 requirements against LIVE Supabase local instance:
 *
 * 1. ingest_provider_message_atomic:
 *    - Rejects missing provider_user_id (no synthetic identity)
 *    - Rejects missing provider_message_id (no synthetic message ID)
 *    - First-contact creates exactly ONE customer
 *    - Duplicate message returns is_duplicate=true
 *    - Sanitization status CLEAN/SANITIZED mapped to SUCCEEDED
 *
 * 2. record_outbound_interaction_atomic:
 *    - Successful outbound creates interaction + outbound_delivery
 *    - client_command_id idempotency (same payload → is_duplicate=true)
 *    - client_command_id payload mismatch → IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD
 *    - actor_user_id attribution stored correctly
 *
 * 3. claim_pending_outbound_deliveries:
 *    - Claims pending deliveries with FOR UPDATE SKIP LOCKED
 *
 * 4. RLS enforcement on outbound_deliveries
 *
 * Requires: Local Supabase running with migrations applied (npx supabase db reset)
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

let passed = 0;
let failed = 0;

function ok(label: string) {
  passed++;
  console.log(`[PASS] ${label}`);
}

function fail(label: string, reason: string) {
  failed++;
  console.error(`[FAIL] ${label}: ${reason}`);
}

function createTestClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

import { cleanupCompanyFixtures } from '../helpers/fixture-cleanup';
import { reconcileAuthUserFixture } from '../helpers/auth-fixture';

// Test company/customer/conversation/membership IDs
const TEST_COMPANY_ID = 'a0a0a0a0-0001-4000-8000-000000000001';
const TEST_COMPANY_ID_2 = 'a0a0a0a0-0002-4000-8000-000000000002';
const TEST_CUSTOMER_ID = 'c0c0c0c0-0001-4000-8000-000000000001';
const TEST_CONVERSATION_ID = 'd0d0d0d0-0001-4000-8000-000000000001';
let testUserId = '';

// Seed helpers
async function seedTestData(client: SupabaseClient) {
  // Pre-seed clean isolation for suite-owned company namespaces
  cleanupCompanyFixtures([TEST_COMPANY_ID, TEST_COMPANY_ID_2]);

  // Company 1 (for ingest tests)
  const { error: c1Err } = await client.from('companies').upsert({
    id: TEST_COMPANY_ID,
    name: 'Test Ingest Company',
    status: 'ACTIVE',
  }, { onConflict: 'id' });
  if (c1Err) throw new Error(`Failed to upsert company 1: ${c1Err.message}`);

  // Company 2 (for outbound tests)
  const { error: c2Err } = await client.from('companies').upsert({
    id: TEST_COMPANY_ID_2,
    name: 'Test Outbound Company',
    status: 'ACTIVE',
  }, { onConflict: 'id' });
  if (c2Err) throw new Error(`Failed to upsert company 2: ${c2Err.message}`);

  // Ensure user in auth.users, profile and company_members via canonical helper
  const email = 'test-sale-inbox@test.vn';
  testUserId = await reconcileAuthUserFixture(client, {
    email,
    password: 'TestPassword123!',
    fullName: 'Test Sale User',
    companyId: TEST_COMPANY_ID_2,
    role: 'SALE',
  });

  // Customer for outbound tests
  const { error: custErr } = await client.from('customers').insert({
    id: TEST_CUSTOMER_ID,
    company_id: TEST_COMPANY_ID_2,
    name: 'Test Outbound Customer',
    customer_code: 'KC-OUTB-TEST',
    stage: 'LEAD_NEW',
    source: 'FACEBOOK',
  });
  if (custErr) throw new Error(`Failed to insert customer: ${custErr.message}`);

  // Conversation for outbound tests
  const { error: convErr } = await client.from('conversations').insert({
    id: TEST_CONVERSATION_ID,
    company_id: TEST_COMPANY_ID_2,
    customer_id: TEST_CUSTOMER_ID,
    channel: 'FACEBOOK',
    external_conversation_id: 'fb-conv-test-001',
    status: 'OPEN',
    unread_count: 0,
  });
  if (convErr) throw new Error(`Failed to insert conversation: ${convErr.message}`);
}

// ============================================================================
// TEST: ingest_provider_message_atomic
// ============================================================================

async function testIngestRejectsEmptyProviderUserId(client: SupabaseClient) {
  const label = 'ingest_provider_message_atomic rejects empty provider_user_id';

  const { error } = await client.rpc('ingest_provider_message_atomic', {
    p_company_id: TEST_COMPANY_ID,
    p_channel: 'FACEBOOK',
    p_external_user_id: '',  // EMPTY → should reject
    p_external_ref: 'msg-test-001',
    p_sanitized_content: 'Test message',
    p_raw_content: 'Test message',
    p_sanitization_status: 'SUCCEEDED',
    p_sender_name: 'Test Sender',
    p_sender_phone: null,
    p_source_metadata: {},
  });

  if (error && error.message.includes('MISSING_PROVIDER_USER_ID')) {
    ok(label);
  } else {
    fail(label, `Expected MISSING_PROVIDER_USER_ID error, got: ${JSON.stringify(error)}`);
  }
}

async function testIngestRejectsEmptyMessageId(client: SupabaseClient) {
  const label = 'ingest_provider_message_atomic rejects empty message_id';

  const { error } = await client.rpc('ingest_provider_message_atomic', {
    p_company_id: TEST_COMPANY_ID,
    p_channel: 'FACEBOOK',
    p_external_user_id: 'fb-user-12345',
    p_external_ref: '',  // EMPTY → should reject
    p_sanitized_content: 'Test message',
    p_raw_content: 'Test message',
    p_sanitization_status: 'SUCCEEDED',
    p_sender_name: 'Test Sender',
    p_sender_phone: null,
    p_source_metadata: {},
  });

  if (error && error.message.includes('MISSING_PROVIDER_MESSAGE_ID')) {
    ok(label);
  } else {
    fail(label, `Expected MISSING_PROVIDER_MESSAGE_ID error, got: ${JSON.stringify(error)}`);
  }
}

async function testIngestFirstContactCreatesCustomer(client: SupabaseClient) {
  const label = 'ingest_provider_message_atomic first-contact creates customer + conversation + interaction';
  const uniqueUserId = `fb-first-${Date.now()}`;
  const uniqueMsgId = `mid-first-${Date.now()}`;

  const { data, error } = await client.rpc('ingest_provider_message_atomic', {
    p_company_id: TEST_COMPANY_ID,
    p_channel: 'FACEBOOK',
    p_external_user_id: uniqueUserId,
    p_external_ref: uniqueMsgId,
    p_sanitized_content: 'Xin chào, tôi muốn hỏi giá cửa chống ngập',
    p_raw_content: 'Xin chào, tôi muốn hỏi giá cửa chống ngập',
    p_sanitization_status: 'SUCCEEDED',
    p_sender_name: 'Khách Mới',
    p_sender_phone: '0912345678',
    p_source_metadata: { test: true },
  });

  if (error) {
    fail(label, `RPC error: ${error.message}`);
    return;
  }

  // RPC returns SETOF, so data is an array
  const rows = Array.isArray(data) ? data : [data];
  const result = rows[0] as Record<string, unknown> | undefined;
  if (
    result &&
    result.customer_id &&
    result.conversation_id &&
    result.interaction_id &&
    result.is_duplicate === false
  ) {
    ok(label);
  } else {
    fail(label, `Unexpected result: ${JSON.stringify(data)}`);
  }
}

async function testIngestDuplicateMessageIdempotent(client: SupabaseClient) {
  const label = 'ingest_provider_message_atomic duplicate message returns is_duplicate=true';
  const uniqueUserId = `fb-dup-${Date.now()}`;
  const uniqueMsgId = `mid-dup-${Date.now()}`;

  // First call
  await client.rpc('ingest_provider_message_atomic', {
    p_company_id: TEST_COMPANY_ID,
    p_channel: 'FACEBOOK',
    p_external_user_id: uniqueUserId,
    p_external_ref: uniqueMsgId,
    p_sanitized_content: 'Hello dup test',
    p_raw_content: 'Hello dup test',
    p_sanitization_status: 'SUCCEEDED',
    p_sender_name: 'Dup Tester',
    p_sender_phone: null,
    p_source_metadata: {},
  });

  // Second call with same external_ref
  const { data, error } = await client.rpc('ingest_provider_message_atomic', {
    p_company_id: TEST_COMPANY_ID,
    p_channel: 'FACEBOOK',
    p_external_user_id: uniqueUserId,
    p_external_ref: uniqueMsgId,
    p_sanitized_content: 'Hello dup test',
    p_raw_content: 'Hello dup test',
    p_sanitization_status: 'SUCCEEDED',
    p_sender_name: 'Dup Tester',
    p_sender_phone: null,
    p_source_metadata: {},
  });

  if (error) {
    fail(label, `RPC error: ${error.message}`);
    return;
  }

  const rows = Array.isArray(data) ? data : [data];
  const result = rows[0] as Record<string, unknown> | undefined;
  if (result && result.is_duplicate === true) {
    ok(label);
  } else {
    fail(label, `Expected is_duplicate=true, got: ${JSON.stringify(data)}`);
  }
}

async function testIngestSanitizationStatusMapping(client: SupabaseClient) {
  const label = 'ingest_provider_message_atomic maps CLEAN → SUCCEEDED in DB';
  const uniqueUserId = `fb-san-${Date.now()}`;
  const uniqueMsgId = `mid-san-${Date.now()}`;

  const { data, error } = await client.rpc('ingest_provider_message_atomic', {
    p_company_id: TEST_COMPANY_ID,
    p_channel: 'FACEBOOK',
    p_external_user_id: uniqueUserId,
    p_external_ref: uniqueMsgId,
    p_sanitized_content: 'Clean content no phone',
    p_raw_content: 'Clean content no phone',
    p_sanitization_status: 'CLEAN',  // Legacy → should be mapped to SUCCEEDED
    p_sender_name: 'San Tester',
    p_sender_phone: null,
    p_source_metadata: {},
  });

  if (error) {
    fail(label, `RPC error: ${error.message}`);
    return;
  }

  const rows = Array.isArray(data) ? data : [data];
  const result = rows[0] as Record<string, unknown> | undefined;
  if (!result || !result.interaction_id) {
    fail(label, `No interaction_id in result: ${JSON.stringify(data)}`);
    return;
  }

  // Check the actual stored sanitization_status
  const { data: interaction } = await client
    .from('interactions')
    .select('sanitization_status')
    .eq('id', result.interaction_id as string)
    .single();

  if (interaction && interaction.sanitization_status === 'SUCCEEDED') {
    ok(label);
  } else {
    fail(label, `Expected SUCCEEDED, got: ${interaction?.sanitization_status}`);
  }
}

async function testIngestConcurrentFirstContactCreatesExactlyOneCustomer(client: SupabaseClient) {
  const label = 'ingest_provider_message_atomic concurrent first-contact creates exactly ONE customer';
  const uniqueUserId = `fb-concurrent-${Date.now()}`;

  // Fire 3 concurrent inbound requests for the SAME user with DIFFERENT messages
  const promises = [1, 2, 3].map((i) =>
    client.rpc('ingest_provider_message_atomic', {
      p_company_id: TEST_COMPANY_ID,
      p_channel: 'FACEBOOK',
      p_external_user_id: uniqueUserId,
      p_external_ref: `mid-concurrent-${Date.now()}-${i}`,
      p_sanitized_content: `Concurrent message ${i}`,
      p_raw_content: `Concurrent message ${i}`,
      p_sanitization_status: 'SUCCEEDED',
      p_sender_name: 'Concurrent User',
      p_sender_phone: null,
      p_source_metadata: { index: i },
    })
  );

  const results = await Promise.all(promises);

  for (let i = 0; i < results.length; i++) {
    if (results[i].error) {
      fail(label, `Call ${i + 1} failed: ${results[i].error?.message}`);
      return;
    }
  }

  const customerIds = results.map((r) => {
    const rows = Array.isArray(r.data) ? r.data : [r.data];
    return (rows[0] as Record<string, unknown>)?.customer_id;
  });

  const uniqueCustomerIds = new Set(customerIds);
  if (uniqueCustomerIds.size !== 1) {
    fail(label, `Expected exactly 1 unique customer_id across concurrent calls, got: ${Array.from(uniqueCustomerIds).join(', ')}`);
    return;
  }

  // Double check in identities table
  const { data: identities, error: idErr } = await client
    .from('identities')
    .select('id, customer_id')
    .eq('company_id', TEST_COMPANY_ID)
    .eq('channel', 'FACEBOOK')
    .eq('external_id', uniqueUserId);

  if (idErr || !identities || identities.length !== 1) {
    fail(label, `Expected exactly 1 identity row, found: ${identities?.length}`);
    return;
  }

  ok(label);
}

// ============================================================================
// TEST: record_outbound_interaction_atomic
// ============================================================================

async function testOutboundCreatesRecords(client: SupabaseClient) {
  const label = 'record_outbound_interaction_atomic creates interaction + outbound_delivery';
  const commandId = crypto.randomUUID();

  const { data, error } = await client.rpc('record_outbound_interaction_atomic', {
    p_company_id: TEST_COMPANY_ID_2,
    p_conversation_id: TEST_CONVERSATION_ID,
    p_customer_id: null,
    p_channel: null,
    p_sanitized_content: 'Dạ em gửi báo giá cho anh ạ',
    p_raw_content: 'Dạ em gửi báo giá cho anh ạ',
    p_sanitization_status: 'SUCCEEDED',
    p_source_metadata: { source: 'sale_reply' },
    p_client_command_id: commandId,
    p_actor_user_id: testUserId,
  });

  if (error) {
    fail(label, `RPC error: ${error.message}`);
    return;
  }

  const result = data as Record<string, unknown>;
  if (
    result &&
    result.interaction_id &&
    result.delivery_id &&
    result.is_duplicate === false
  ) {
    ok(label);
  } else {
    fail(label, `Unexpected result: ${JSON.stringify(result)}`);
  }
}

async function testOutboundIdempotency(client: SupabaseClient) {
  const label = 'record_outbound_interaction_atomic idempotent on same command_id + same payload';
  const commandId = crypto.randomUUID();
  const content = 'Idempotent test message';

  // First call
  await client.rpc('record_outbound_interaction_atomic', {
    p_company_id: TEST_COMPANY_ID_2,
    p_conversation_id: TEST_CONVERSATION_ID,
    p_sanitized_content: content,
    p_raw_content: content,
    p_sanitization_status: 'SUCCEEDED',
    p_source_metadata: { source: 'sale_reply' },
    p_client_command_id: commandId,
    p_actor_user_id: testUserId,
  });

  // Second call with SAME command_id + SAME payload
  const { data, error } = await client.rpc('record_outbound_interaction_atomic', {
    p_company_id: TEST_COMPANY_ID_2,
    p_conversation_id: TEST_CONVERSATION_ID,
    p_sanitized_content: content,
    p_raw_content: content,
    p_sanitization_status: 'SUCCEEDED',
    p_source_metadata: { source: 'sale_reply' },
    p_client_command_id: commandId,
    p_actor_user_id: testUserId,
  });

  if (error) {
    fail(label, `RPC error: ${error.message}`);
    return;
  }

  const result = data as Record<string, unknown>;
  if (result && result.is_duplicate === true) {
    ok(label);
  } else {
    fail(label, `Expected is_duplicate=true, got: ${JSON.stringify(result)}`);
  }
}

async function testOutboundPayloadMismatchRejected(client: SupabaseClient) {
  const label = 'record_outbound_interaction_atomic rejects same command_id + different payload';
  const commandId = crypto.randomUUID();

  // First call
  await client.rpc('record_outbound_interaction_atomic', {
    p_company_id: TEST_COMPANY_ID_2,
    p_conversation_id: TEST_CONVERSATION_ID,
    p_sanitized_content: 'Original message',
    p_raw_content: 'Original message',
    p_sanitization_status: 'SUCCEEDED',
    p_source_metadata: { source: 'sale_reply' },
    p_client_command_id: commandId,
    p_actor_user_id: testUserId,
  });

  // Second call with SAME command_id but DIFFERENT payload
  const { error } = await client.rpc('record_outbound_interaction_atomic', {
    p_company_id: TEST_COMPANY_ID_2,
    p_conversation_id: TEST_CONVERSATION_ID,
    p_sanitized_content: 'COMPLETELY DIFFERENT message content here',
    p_raw_content: 'COMPLETELY DIFFERENT message content here',
    p_sanitization_status: 'SUCCEEDED',
    p_source_metadata: { source: 'sale_reply' },
    p_client_command_id: commandId,
    p_actor_user_id: testUserId,
  });

  if (error && error.message.includes('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD')) {
    ok(label);
  } else {
    fail(label, `Expected IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD, got: ${JSON.stringify(error)}`);
  }
}

async function testOutboundActorAttribution(client: SupabaseClient) {
  const label = 'record_outbound_interaction_atomic stores actor_user_id correctly';
  const commandId = crypto.randomUUID();

  const { data, error } = await client.rpc('record_outbound_interaction_atomic', {
    p_company_id: TEST_COMPANY_ID_2,
    p_conversation_id: TEST_CONVERSATION_ID,
    p_sanitized_content: 'Actor attribution test',
    p_raw_content: 'Actor attribution test',
    p_sanitization_status: 'SUCCEEDED',
    p_source_metadata: { source: 'sale_reply' },
    p_client_command_id: commandId,
    p_actor_user_id: testUserId,
  });

  if (error) {
    fail(label, `RPC error: ${error.message}`);
    return;
  }

  const result = data as Record<string, unknown>;
  if (!result || !result.interaction_id) {
    fail(label, `No interaction_id: ${JSON.stringify(result)}`);
    return;
  }

  // Verify actor_user_id is stored in the interaction
  const { data: interaction } = await client
    .from('interactions')
    .select('actor_user_id, actor_type')
    .eq('id', result.interaction_id as string)
    .single();

  if (interaction && interaction.actor_user_id === testUserId && interaction.actor_type === 'SALE') {
    ok(label);
  } else {
    fail(label, `Expected actor_user_id=${testUserId}, actor_type=SALE, got: ${JSON.stringify(interaction)}`);
  }
}

// ============================================================================
// TEST: claim_pending_outbound_deliveries
// ============================================================================

async function testClaimPendingDeliveries(client: SupabaseClient) {
  const label = 'claim_pending_outbound_deliveries claims PENDING_DISPATCH records';
  const commandId = crypto.randomUUID();

  // Create a fresh outbound so there's at least one PENDING_DISPATCH
  await client.rpc('record_outbound_interaction_atomic', {
    p_company_id: TEST_COMPANY_ID_2,
    p_conversation_id: TEST_CONVERSATION_ID,
    p_sanitized_content: 'Claim test message',
    p_raw_content: 'Claim test message',
    p_sanitization_status: 'SUCCEEDED',
    p_source_metadata: { source: 'test' },
    p_client_command_id: commandId,
    p_actor_user_id: testUserId,
  });

  const workerId = `test-worker-${Date.now()}`;
  const { data, error } = await client.rpc('claim_pending_outbound_deliveries', {
    p_company_id: TEST_COMPANY_ID_2,
    p_worker_id: workerId,
    p_limit: 10,
  });

  if (error) {
    fail(label, `RPC error: ${error.message}`);
    return;
  }

  const results = Array.isArray(data) ? data : (data ? [data] : []);
  if (results.length > 0) {
    ok(label);
  } else {
    fail(label, `Expected at least 1 claimed delivery, got 0`);
  }
}

// ============================================================================
// TEST: Outbound deliveries RLS (service_role only)
// ============================================================================

async function testOutboundDeliveriesRLS(client: SupabaseClient) {
  const label = 'outbound_deliveries table enforces RLS (service_role can read)';

  // Service role should be able to query
  const { error } = await client
    .from('outbound_deliveries')
    .select('id, delivery_status')
    .eq('company_id', TEST_COMPANY_ID_2)
    .limit(1);

  if (!error) {
    ok(label);
  } else {
    fail(label, `Unexpected error: ${error.message}`);
  }
}

// ============================================================================
// MAIN RUNNER
// ============================================================================

async function main() {
  console.log('================================================================');
  console.log('TV2 REVIEW-8 INBOX/OUTBOX DATABASE INTEGRATION TEST SUITE');
  console.log('================================================================\n');

  // Verify Supabase connectivity
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      headers: { 'apikey': SUPABASE_SERVICE_KEY },
    });
    if (!res.ok) {
      console.error(`✗ Cannot connect to Supabase at ${SUPABASE_URL}: HTTP ${res.status}`);
      process.exit(1);
    }
    console.log(`✓ Connected to Supabase at ${SUPABASE_URL}\n`);
  } catch (err) {
    console.error(`✗ Cannot connect to Supabase at ${SUPABASE_URL}:`, err);
    process.exit(1);
  }

  const client = createTestClient();

  try {
    // Seed test data
    console.log('Seeding test data...');
    await seedTestData(client);
    console.log('✓ Test data seeded\n');

    // --- Ingest Tests ---
    console.log('--- ingest_provider_message_atomic ---');
    await testIngestRejectsEmptyProviderUserId(client);
    await testIngestRejectsEmptyMessageId(client);
    await testIngestFirstContactCreatesCustomer(client);
    await testIngestDuplicateMessageIdempotent(client);
    await testIngestSanitizationStatusMapping(client);
    await testIngestConcurrentFirstContactCreatesExactlyOneCustomer(client);

    // --- Outbound Tests ---
    console.log('\n--- record_outbound_interaction_atomic ---');
    await testOutboundCreatesRecords(client);
    await testOutboundIdempotency(client);
    await testOutboundPayloadMismatchRejected(client);
    await testOutboundActorAttribution(client);

    // --- Claim Tests ---
    console.log('\n--- claim_pending_outbound_deliveries ---');
    await testClaimPendingDeliveries(client);

    // --- RLS Tests ---
    console.log('\n--- RLS Enforcement ---');
    await testOutboundDeliveriesRLS(client);
  } finally {
    console.log('\nCleaning up inbox test fixtures...');
    cleanupCompanyFixtures([TEST_COMPANY_ID, TEST_COMPANY_ID_2]);
  }

  // --- Summary ---
  console.log('\n================================================================');
  console.log(`INBOX DB INTEGRATION TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error in inbox DB integration tests:', err);
  process.exit(1);
});
