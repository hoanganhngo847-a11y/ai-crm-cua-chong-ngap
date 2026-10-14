import assert from 'node:assert';
import crypto from 'node:crypto';

/**
 * Fail-closed guard asserting that the Supabase target URL is local only.
 * Prevents accidental execution against staging or production environments.
 */
export function assertLocalSupabaseUrl(urlStr: string): void {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch (_err) {
    throw new Error('Refusing to run destructive DB idempotency test against non-local Supabase.');
  }

  const host = parsed.hostname.toLowerCase();
  const isLocal =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]';

  if (!isLocal) {
    throw new Error('Refusing to run destructive DB idempotency test against non-local Supabase.');
  }
}

// 0. Self-test guard functionality before doing any operations
function verifyGuard() {
  // Allowed local hosts
  assert.doesNotThrow(() => assertLocalSupabaseUrl('http://127.0.0.1:54321'));
  assert.doesNotThrow(() => assertLocalSupabaseUrl('http://localhost:54321'));
  assert.doesNotThrow(() => assertLocalSupabaseUrl('http://[::1]:54321'));

  // Disallowed remote hosts
  assert.throws(
    () => assertLocalSupabaseUrl('https://something.supabase.co'),
    /Refusing to run destructive DB idempotency test against non-local Supabase\./
  );
  assert.throws(
    () => assertLocalSupabaseUrl('https://api.prod.supabase.io'),
    /Refusing to run destructive DB idempotency test against non-local Supabase\./
  );
  assert.throws(
    () => assertLocalSupabaseUrl('http://192.168.1.100:54321'),
    /Refusing to run destructive DB idempotency test against non-local Supabase\./
  );
}

verifyGuard();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

// Guard BEFORE creating any client or writing to DB
assertLocalSupabaseUrl(SUPABASE_URL);

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
delete process.env.DEMO_MODE;

import { createAdminClient } from '../../lib/supabase/admin.ts';

async function runDbIdempotencyRuntimeTests() {
  console.log('======================================================================');
  console.log('STARTING REAL DATABASE RUNTIME IDEMPOTENCY TESTS');
  console.log('Testing public.ingest_provider_message_atomic RPC directly');
  console.log('======================================================================\n');

  // Verify guard once again with the effective URL
  assertLocalSupabaseUrl(SUPABASE_URL);

  const adminClient = createAdminClient();

  // Test company ID: Isolated randomized UUID for each run (never touches seeded/default data)
  const testCompanyId = crypto.randomUUID();
  const runId = Date.now();
  await adminClient.from('companies').upsert({ id: testCompanyId, name: `Test Co ${runId}`, status: 'ACTIVE' });

  const pageId = '1389294167596309';
  const externalUserId = `61592309${runId % 1000000}`;
  const externalConvId = `${pageId}:${externalUserId}`;

  // 1. Setup Historical Interaction with legacy ref F0
  const legacyF0 = crypto.createHash('sha256')
    .update(`${pageId}:${externalConvId}:10:00 PM:hello:INBOUND`)
    .digest('hex');

  console.log('1. Setting up Historical Interaction F0 in PostgreSQL...');
  const { data: histData, error: histError } = await adminClient.rpc('ingest_provider_message_atomic', {
    p_company_id: testCompanyId,
    p_channel: 'FACEBOOK',
    p_external_user_id: externalUserId,
    p_sender_name: 'Khách DB Test',
    p_sender_phone: null,
    p_external_conversation_id: externalConvId,
    p_external_ref: legacyF0,
    p_sanitized_content: 'hello',
    p_raw_content: 'hello',
    p_source_metadata: {
      legacy_external_ref: legacyF0,
    },
    p_sanitization_status: 'SUCCEEDED',
  });

  if (histError) {
    console.error('Failed to create historical interaction:', histError);
    process.exit(1);
  }

  const histRow = Array.isArray(histData) ? histData[0] : histData;
  assert.strictEqual(histRow.is_duplicate, false, 'Historical row should be freshly inserted');
  const historicalInteractionId = histRow.interaction_id;
  const convId = histRow.conversation_id;
  console.log(`   [PASS] Historical F0 created: id=${historicalInteractionId}, conv=${convId}\n`);

  // =========================================================================
  // DB1: Historical F0 exists. New canonical V2B + guessed legacy F0 arrives.
  // Legacy alias is unconfirmed (no explicit proof).
  // EXPECTED: MUST NOT suppress canonical MID!
  // is_duplicate = false, freshly inserted interaction.
  // =========================================================================
  console.log('2. Running DB1: Canonical V2B + unconfirmed guessed legacy F0...');
  const canonicalV2B = crypto.createHash('sha256')
    .update(`${pageId}:${externalConvId}:mid.$db1_B_${runId}`)
    .digest('hex');

  const { data: db1Data, error: db1Error } = await adminClient.rpc('ingest_provider_message_atomic', {
    p_company_id: testCompanyId,
    p_channel: 'FACEBOOK',
    p_external_user_id: externalUserId,
    p_sender_name: 'Khách DB Test',
    p_sender_phone: null,
    p_external_conversation_id: externalConvId,
    p_external_ref: canonicalV2B,
    p_sanitized_content: 'hello',
    p_raw_content: 'hello',
    p_source_metadata: {
      external_message_id: canonicalV2B,
      legacy_external_ref: legacyF0, // unconfirmed guessed ordinal collision
    },
    p_sanitization_status: 'SUCCEEDED',
  });

  if (db1Error) {
    console.error('DB1 RPC Error:', db1Error);
    process.exit(1);
  }

  const db1Row = Array.isArray(db1Data) ? db1Data[0] : db1Data;
  console.log(`   DB1 result: is_duplicate=${db1Row.is_duplicate}, id=${db1Row.interaction_id}`);
  assert.strictEqual(db1Row.is_duplicate, false, 'DB1: New canonical V2B must NOT be suppressed by guessed F0');
  assert.notStrictEqual(db1Row.interaction_id, historicalInteractionId, 'DB1: Must be a new physical interaction record');
  console.log('   [PASS] DB1 Passed: Inbound message V2B preserved without false duplicate suppression!\n');

  // =========================================================================
  // DB2: Rescan same canonical V2B.
  // EXPECTED: is_duplicate = true, returns V2B interaction id.
  // =========================================================================
  console.log('3. Running DB2: Rescan same canonical V2B...');
  const { data: db2Data, error: db2Error } = await adminClient.rpc('ingest_provider_message_atomic', {
    p_company_id: testCompanyId,
    p_channel: 'FACEBOOK',
    p_external_user_id: externalUserId,
    p_sender_name: 'Khách DB Test',
    p_sender_phone: null,
    p_external_conversation_id: externalConvId,
    p_external_ref: canonicalV2B,
    p_sanitized_content: 'hello',
    p_raw_content: 'hello',
    p_source_metadata: {
      external_message_id: canonicalV2B,
      legacy_external_ref: legacyF0,
    },
    p_sanitization_status: 'SUCCEEDED',
  });

  if (db2Error) {
    console.error('DB2 RPC Error:', db2Error);
    process.exit(1);
  }

  const db2Row = Array.isArray(db2Data) ? db2Data[0] : db2Data;
  console.log(`   DB2 result: is_duplicate=${db2Row.is_duplicate}, id=${db2Row.interaction_id}`);
  assert.strictEqual(db2Row.is_duplicate, true, 'DB2: Canonical V2B must be recognized as duplicate on rescan');
  assert.strictEqual(db2Row.interaction_id, db1Row.interaction_id, 'DB2: Must return existing V2B interaction record');
  console.log('   [PASS] DB2 Passed: Canonical idempotency working as expected!\n');

  // =========================================================================
  // DB3: Explicit confirmed alias (caller has evidence that V2A is historical F0).
  // legacy_alias_confidence = 'confirmed'.
  // EXPECTED: is_duplicate = true, returns historicalInteractionId.
  // =========================================================================
  console.log('4. Running DB3: Explicit confirmed alias V2A + F0 (with proof)...');
  const canonicalV2A = crypto.createHash('sha256')
    .update(`${pageId}:${externalConvId}:mid.$db3_A_${runId}`)
    .digest('hex');

  const { data: db3Data, error: db3Error } = await adminClient.rpc('ingest_provider_message_atomic', {
    p_company_id: testCompanyId,
    p_channel: 'FACEBOOK',
    p_external_user_id: externalUserId,
    p_sender_name: 'Khách DB Test',
    p_sender_phone: null,
    p_external_conversation_id: externalConvId,
    p_external_ref: canonicalV2A,
    p_sanitized_content: 'hello',
    p_raw_content: 'hello',
    p_source_metadata: {
      external_message_id: canonicalV2A,
      legacy_external_ref: legacyF0,
      legacy_alias_confidence: 'confirmed', // Explicitly proven mapping
    },
    p_sanitization_status: 'SUCCEEDED',
  });

  if (db3Error) {
    console.error('DB3 RPC Error:', db3Error);
    process.exit(1);
  }

  const db3Row = Array.isArray(db3Data) ? db3Data[0] : db3Data;
  console.log(`   DB3 result: is_duplicate=${db3Row.is_duplicate}, id=${db3Row.interaction_id}`);
  assert.strictEqual(db3Row.is_duplicate, true, 'DB3: Confirmed legacy alias must dedup');
  assert.strictEqual(db3Row.interaction_id, historicalInteractionId, 'DB3: Must return original historical F0 interaction');
  console.log('   [PASS] DB3 Passed: Explicit confirmed alias dedups to historical interaction!\n');

  console.log('======================================================================');
  console.log('ALL DB RUNTIME IDEMPOTENCY TESTS (DB1, DB2, DB3) PASSED PERFECTLY!');
  console.log('======================================================================');
}

runDbIdempotencyRuntimeTests().catch((err) => {
  console.error('DB runtime test error:', err);
  process.exit(1);
});
