/**
 * Zalo Transcription Phase 2A Automation & Targeted Mode Test Suite
 *
 * Verifies Requirements A through J:
 * - A: Bulk cron default limit (10) and processing
 * - B: Limit=1 claims at most 1 job when multiple are due
 * - C: Limit parameter validation (0, -1, 999999, fraction, string, duplicate)
 * - D: Targeted mode claims only the requested ID; never falls back to bulk
 * - E: Mismatched company / unknown ID fails closed
 * - F: Target non-pending / not-due / non-ready not claimed; isolated lease reclamation
 * - G: 2 workers do not duplicate jobs (documented PGlite serial + row lease fencing)
 * - H: Security & ACL: anon/authenticated denied, service_role allowed
 * - I: Original recording preserved on provider failures; lock token fencing
 * - J: Observability & credential sanitization in error codes and structured logs
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { GET as cronHandler, POST as cronPostHandler, handleZaloTranscriptionCron } from '../../app/api/cron/zalo-transcription/handler';
import { sha256 } from '../../features/zalo-recordings/metadata';
import { RECORDING_BUCKET, uploadRecording } from '../../features/zalo-recordings/upload';
import { MockTranscriptionProvider } from '../../features/zalo-transcription/provider';
import {
  processDueZaloTranscriptionJobs,
  processTargetedZaloTranscriptionJob,
  sanitizeErrorCode,
  sanitizeErrorMessage,
} from '../../features/zalo-transcription/service';
import { createPgliteSupabase } from '../zalo/helpers/pglite-supabase';
import { audioFixture, metadataFixture, uploadRequest } from './fixture';

let passCount = 0;
function testPass(msg: string) {
  console.log(`[PASS] ${msg}`);
  passCount++;
}

async function runAutomationTestSuite() {
  console.log('================================================================');
  console.log('STARTING ZALO TRANSCRIPTION PHASE 2A AUTOMATION TEST SUITE');
  console.log('================================================================\n');

  // ==========================================================================
  // SECTION 1: Route Handler HTTP & Query Parameter Validation Tests
  // ==========================================================================
  console.log('--- SECTION 1: Route Handler HTTP & Query Parameter Tests ---');

  const TEST_SECRET = 'test-phase2a-cron-secret-1234567890';
  const originalEnvSecret = process.env.CRON_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;

  const setEnv = (key: string, val: string | undefined) => {
    if (val === undefined) Reflect.deleteProperty(process.env, key);
    else (process.env as Record<string, string | undefined>)[key] = val;
  };

  try {
    setEnv('CRON_SECRET', TEST_SECRET);
    setEnv('NODE_ENV', undefined);

    // 1.1: Missing Authorization header -> 401
    const reqNoAuth = new NextRequest('http://localhost/api/cron/zalo-transcription');
    const resNoAuth = await cronHandler(reqNoAuth);
    assert.equal(resNoAuth.status, 401, 'Missing auth header must return 401');
    testPass('1.1: Missing Authorization header returns 401');

    // 1.2: Invalid Bearer token -> 401
    const reqWrongAuth = new NextRequest('http://localhost/api/cron/zalo-transcription', {
      headers: { authorization: 'Bearer wrong-secret-token' },
    });
    const resWrongAuth = await cronHandler(reqWrongAuth);
    assert.equal(resWrongAuth.status, 401, 'Wrong Bearer token must return 401');

    const reqNonBearer = new NextRequest('http://localhost/api/cron/zalo-transcription', {
      headers: { authorization: `Basic ${TEST_SECRET}` },
    });
    const resNonBearer = await cronHandler(reqNonBearer);
    assert.equal(resNonBearer.status, 401, 'Non-Bearer syntax must return 401');
    testPass('1.2: Wrong Bearer token or non-Bearer syntax returns 401');

    // 1.3: Unconfigured CRON_SECRET fails closed with 503 across all environments
    setEnv('CRON_SECRET', undefined);
    setEnv('NODE_ENV', undefined);
    const reqNoSecretDev = new NextRequest('http://localhost/api/cron/zalo-transcription');
    const resNoSecretDev = await cronHandler(reqNoSecretDev);
    assert.equal(resNoSecretDev.status, 503, 'Missing CRON_SECRET in non-production must return 503');

    setEnv('NODE_ENV', 'production');
    const reqProdNoSecret = new NextRequest('http://localhost/api/cron/zalo-transcription');
    const resProdNoSecret = await cronHandler(reqProdNoSecret);
    assert.equal(resProdNoSecret.status, 503, 'Missing CRON_SECRET in production must return 503');
    testPass('1.3: Unconfigured CRON_SECRET fails closed with 503 in all environments');

    // Restore test secret for subsequent route tests
    setEnv('CRON_SECRET', TEST_SECRET);
    setEnv('NODE_ENV', undefined);

    // 1.4: Duplicate query parameters -> 400
    const reqDupLimit = new NextRequest('http://localhost/api/cron/zalo-transcription?limit=1&limit=2', {
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });
    const resDupLimit = await cronHandler(reqDupLimit);
    assert.equal(resDupLimit.status, 400, 'Duplicate limit params must return 400');

    const fakeId1 = randomUUID();
    const fakeId2 = randomUUID();
    const reqDupTarget = new NextRequest(`http://localhost/api/cron/zalo-transcription?transcription_id=${fakeId1}&transcription_id=${fakeId2}`, {
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });
    const resDupTarget = await cronHandler(reqDupTarget);
    assert.equal(resDupTarget.status, 400, 'Duplicate transcription_id params must return 400');
    testPass('1.4: Duplicate query parameters rejected with 400');

    // 1.5: Invalid limit parameters -> 400
    const invalidLimits = ['0', '-1', '999999', '11', '3.5', 'abc', ''];
    for (const badLimit of invalidLimits) {
      const reqBadLimit = new NextRequest(`http://localhost/api/cron/zalo-transcription?limit=${badLimit}`, {
        headers: { authorization: `Bearer ${TEST_SECRET}` },
      });
      const resBadLimit = await cronHandler(reqBadLimit);
      assert.equal(resBadLimit.status, 400, `limit=${badLimit} must return 400 Bad Request`);
    }
    testPass('1.5: Invalid limit parameters (0, -1, 999999, 11, 3.5, string, empty) return 400');

    // 1.6: Invalid transcription_id parameters -> 400
    const invalidIds = ['not-a-uuid', '12345', ' ', 'g1234567-89ab-cdef-0123-456789abcdef'];
    for (const badId of invalidIds) {
      const reqBadId = new NextRequest(`http://localhost/api/cron/zalo-transcription?transcription_id=${encodeURIComponent(badId)}`, {
        headers: { authorization: `Bearer ${TEST_SECRET}` },
      });
      const resBadId = await cronHandler(reqBadId);
      assert.equal(resBadId.status, 400, `transcription_id=${badId} must return 400 Bad Request`);
    }
    testPass('1.6: Invalid transcription_id parameters return 400');

    // 1.7: Valid limit is ignored for target, but invalid limit is still rejected (Requirement)
    const validTargetId = randomUUID();
    const reqTargetWithBadLimit = new NextRequest(
      `http://localhost/api/cron/zalo-transcription?transcription_id=${validTargetId}&limit=invalid`,
      { headers: { authorization: `Bearer ${TEST_SECRET}` } }
    );
    const resTargetWithBadLimit = await cronHandler(reqTargetWithBadLimit);
    assert.equal(resTargetWithBadLimit.status, 400, 'Invalid limit with targetId must still return 400');

    // 1.8: POST method equivalence
    const reqPost = new NextRequest('http://localhost/api/cron/zalo-transcription?limit=0', {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });
    const resPost = await cronPostHandler(reqPost);
    assert.equal(resPost.status, 400, 'POST handler must execute same validation');
    testPass('1.7 & 1.8: Target with invalid limit returns 400; POST route handler executes identical validation');

    // 1.9: Route forwarding: default bulk mode forwards default limit=10
    let bulkForwardedLimit: number | undefined;
    const reqDefaultBulk = new NextRequest('http://localhost/api/cron/zalo-transcription', {
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });
    const resDefaultBulk = await handleZaloTranscriptionCron(reqDefaultBulk, {
      processDue: async (limit) => {
        bulkForwardedLimit = limit;
        return { claimed: 10, processed: 10, failed: 0 };
      },
      processTargeted: async () => {
        throw new Error('processTargeted must not be called in bulk mode');
      },
    });
    assert.equal(resDefaultBulk.status, 200);
    const jsonDefaultBulk = await resDefaultBulk.json();
    assert.equal(jsonDefaultBulk.ok, true);
    assert.equal(jsonDefaultBulk.mode, 'BULK');
    assert.equal(bulkForwardedLimit, 10, 'Default bulk limit must be 10');
    assert.equal(jsonDefaultBulk.claimed, 10);
    testPass('1.9: Route forwarding default bulk mode forwards limit=10');

    // 1.10: Route forwarding: explicit limit=1 is truly 1
    let explicitForwardedLimit: number | undefined;
    const reqLimit1 = new NextRequest('http://localhost/api/cron/zalo-transcription?limit=1', {
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });
    const resLimit1 = await handleZaloTranscriptionCron(reqLimit1, {
      processDue: async (limit) => {
        explicitForwardedLimit = limit;
        return { claimed: 1, processed: 1, failed: 0 };
      },
    });
    assert.equal(resLimit1.status, 200);
    const jsonLimit1 = await resLimit1.json();
    assert.equal(jsonLimit1.mode, 'BULK');
    assert.equal(explicitForwardedLimit, 1, 'Explicit limit=1 must be forwarded as 1');
    assert.equal(jsonLimit1.claimed, 1);
    testPass('1.10: Route forwarding with limit=1 forwards limit=1');

    // 1.11: Route forwarding: targeted mode forwards targetId and NEVER calls bulk
    let targetedForwardedId: string | undefined;
    let bulkCalledInTargeted = false;
    const targetedTestId = randomUUID();
    const reqTargeted = new NextRequest(`http://localhost/api/cron/zalo-transcription?transcription_id=${targetedTestId}`, {
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });
    const resTargeted = await handleZaloTranscriptionCron(reqTargeted, {
      processDue: async () => {
        bulkCalledInTargeted = true;
        return { claimed: 5, processed: 5, failed: 0 };
      },
      processTargeted: async (id) => {
        targetedForwardedId = id;
        return { claimed: 1, processed: 1, failed: 0 };
      },
    });
    assert.equal(resTargeted.status, 200);
    const jsonTargeted = await resTargeted.json();
    assert.equal(jsonTargeted.ok, true);
    assert.equal(jsonTargeted.mode, 'TARGETED');
    assert.equal(targetedForwardedId, targetedTestId);
    assert.equal(bulkCalledInTargeted, false, 'Bulk worker must NEVER be called in targeted mode');
    testPass('1.11: Route forwarding targeted mode processes targetId without invoking bulk');

    // 1.12: Target precedence: valid limit supplied with transcription_id is ignored during execution
    let targetWithLimitCalledId: string | undefined;
    let bulkCalledWithTarget = false;
    const reqTargetWithLimit = new NextRequest(
      `http://localhost/api/cron/zalo-transcription?transcription_id=${targetedTestId}&limit=5`,
      { headers: { authorization: `Bearer ${TEST_SECRET}` } }
    );
    const resTargetWithLimit = await handleZaloTranscriptionCron(reqTargetWithLimit, {
      processDue: async () => {
        bulkCalledWithTarget = true;
        return { claimed: 5, processed: 5, failed: 0 };
      },
      processTargeted: async (id) => {
        targetWithLimitCalledId = id;
        return { claimed: 1, processed: 1, failed: 0 };
      },
    });
    assert.equal(resTargetWithLimit.status, 200);
    const jsonTargetWithLimit = await resTargetWithLimit.json();
    assert.equal(jsonTargetWithLimit.mode, 'TARGETED');
    assert.equal(targetWithLimitCalledId, targetedTestId);
    assert.equal(bulkCalledWithTarget, false, 'Targeted execution ignores valid limit and does not call bulk');
    testPass('1.12: Target mode takes strict precedence over valid limit');

    // 1.13: Unknown target returns 0 without bulk fallback
    let unknownBulkFallback = false;
    const unknownId = randomUUID();
    const reqUnknown = new NextRequest(`http://localhost/api/cron/zalo-transcription?transcription_id=${unknownId}`, {
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });
    const resUnknown = await handleZaloTranscriptionCron(reqUnknown, {
      processDue: async () => {
        unknownBulkFallback = true;
        return { claimed: 3, processed: 3, failed: 0 };
      },
      processTargeted: async () => {
        return { claimed: 0, processed: 0, failed: 0 };
      },
    });
    assert.equal(resUnknown.status, 200);
    const jsonUnknown = await resUnknown.json();
    assert.equal(jsonUnknown.ok, true);
    assert.equal(jsonUnknown.mode, 'TARGETED');
    assert.equal(jsonUnknown.claimed, 0);
    assert.equal(jsonUnknown.processed, 0);
    assert.equal(unknownBulkFallback, false, 'Unknown target must never fall back to bulk');
    testPass('1.13: Unknown target returns 0 claimed/processed/failed with no bulk fallback');

    // 1.14: Duplicate query param error message does NOT echo attacker-supplied parameter names
    const reqAttackerDup = new NextRequest('http://localhost/api/cron/zalo-transcription?evil_param_payload=1&evil_param_payload=2', {
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });
    const resAttackerDup = await cronHandler(reqAttackerDup);
    assert.equal(resAttackerDup.status, 400);
    const jsonAttackerDup = await resAttackerDup.json();
    assert.equal(jsonAttackerDup.error, 'Duplicate query parameter');
    assert.ok(!JSON.stringify(jsonAttackerDup).includes('evil_param_payload'), 'Must not echo attacker key');
    testPass('1.14: Duplicate query parameter error does not echo attacker-supplied parameter name');
  } finally {
    setEnv('CRON_SECRET', originalEnvSecret);
    setEnv('NODE_ENV', originalNodeEnv);
  }

  // ==========================================================================
  // SECTION 2: Service Unit & Credential Sanitization Defenses
  // ==========================================================================
  console.log('\n--- SECTION 2: Service Unit & Credential Sanitization Defenses ---');

  // 2.1: processDueZaloTranscriptionJobs limit validation
  await assert.rejects(
    async () => processDueZaloTranscriptionJobs(0),
    /INVALID_LIMIT/,
    'limit=0 must reject with INVALID_LIMIT'
  );
  await assert.rejects(
    async () => processDueZaloTranscriptionJobs(-1),
    /INVALID_LIMIT/,
    'limit=-1 must reject with INVALID_LIMIT'
  );
  await assert.rejects(
    async () => processDueZaloTranscriptionJobs(11),
    /INVALID_LIMIT/,
    'limit=11 must reject with INVALID_LIMIT'
  );
  await assert.rejects(
    async () => processDueZaloTranscriptionJobs(3.5),
    /INVALID_LIMIT/,
    'fractional limit must reject with INVALID_LIMIT'
  );
  await assert.rejects(
    async () => processDueZaloTranscriptionJobs(Number.NaN),
    /INVALID_LIMIT/,
    'NaN limit must reject with INVALID_LIMIT'
  );
  await assert.rejects(
    async () => processDueZaloTranscriptionJobs('10' as any),
    /INVALID_LIMIT/,
    'string limit must reject with INVALID_LIMIT'
  );
  testPass('2.1: processDueZaloTranscriptionJobs enforces strict service limit cap (1..10)');

  // 2.2: processTargetedZaloTranscriptionJob UUID validation
  await assert.rejects(
    async () => processTargetedZaloTranscriptionJob('not-uuid'),
    /INVALID_TRANSCRIPTION_ID/,
    'non-uuid must reject with INVALID_TRANSCRIPTION_ID'
  );
  await assert.rejects(
    async () => processTargetedZaloTranscriptionJob(''),
    /INVALID_TRANSCRIPTION_ID/,
    'empty string must reject with INVALID_TRANSCRIPTION_ID'
  );
  testPass('2.2: processTargetedZaloTranscriptionJob strictly validates UUID format');

  // 2.3: sanitizeErrorCode defenses: uppercase secrets never leaked as error codes; no prefix wildcards
  assert.equal(sanitizeErrorCode(new Error('CRON_SECRET_VALUE_XYZ')), 'TRANSCRIPTION_FAILED');
  assert.equal(sanitizeErrorCode(new Error('MY_SUPER_API_KEY_999')), 'TRANSCRIPTION_FAILED');
  assert.equal(sanitizeErrorCode(new Error('USER_PASSWORD_HASH')), 'TRANSCRIPTION_FAILED');
  assert.equal(sanitizeErrorCode(new Error('Bearer eyJhbGciOi...')), 'PROVIDER_AUTH_ERROR');
  assert.equal(sanitizeErrorCode(new Error('AIzaSyD-fake-key-123')), 'TRANSCRIPTION_FAILED');
  assert.equal(sanitizeErrorCode(new Error('GEMINI_UNAPPROVED_WILDCARD_SECRET_KEY')), 'TRANSCRIPTION_FAILED', 'Prefix wildcard must not be accepted');
  assert.equal(sanitizeErrorCode(new Error('OPENAI_UNAPPROVED_CUSTOM_CODE_999')), 'TRANSCRIPTION_FAILED', 'Prefix wildcard must not be accepted');
  assert.equal(sanitizeErrorCode(new Error('TRANSCRIPTION_UNAPPROVED_CODE')), 'TRANSCRIPTION_FAILED', 'Prefix wildcard must not be accepted');
  // Legitimate provider and service constants must be preserved
  assert.equal(sanitizeErrorCode(new Error('RATE_LIMITED')), 'RATE_LIMITED');
  assert.equal(sanitizeErrorCode(new Error('TIMEOUT')), 'TIMEOUT');
  assert.equal(sanitizeErrorCode(new Error('TRANSCRIPTION_LOCK_LOST')), 'TRANSCRIPTION_LOCK_LOST');
  assert.equal(sanitizeErrorCode(new Error('CLAIM_TRANSCRIPTION_JOB_FAILED')), 'CLAIM_TRANSCRIPTION_JOB_FAILED');
  assert.equal(sanitizeErrorCode(new Error('GEMINI_AUTH_ERROR')), 'GEMINI_AUTH_ERROR');
  assert.equal(sanitizeErrorCode(new Error('GEMINI_TIMESTAMP_MISSING')), 'GEMINI_TIMESTAMP_MISSING');
  assert.equal(sanitizeErrorCode(new Error('GEMINI_AUDIO_TOO_LONG')), 'GEMINI_AUDIO_TOO_LONG');
  assert.equal(sanitizeErrorCode(new Error('TRANSCRIPTION_NETWORK_ERROR')), 'TRANSCRIPTION_NETWORK_ERROR');
  assert.equal(sanitizeErrorCode(new Error('EXPIRED_LEASE_MAX_ATTEMPTS')), 'EXPIRED_LEASE_MAX_ATTEMPTS');
  assert.equal(sanitizeErrorCode(new Error('AUDIO_SPLIT_FAILED')), 'AUDIO_SPLIT_FAILED');
  testPass('2.3: sanitizeErrorCode enforces strict allowlist, blocks uppercase secrets, and rejects prefix wildcards');

  // 2.4: BULK client init failure emits sanitized invocation_failed with DATABASE_ERROR and zero counts/duration
  const savedSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const savedServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const originalConsoleError = console.error;
    const errorLogs: string[] = [];
    console.error = (...args: any[]) => {
      errorLogs.push(args.map(String).join(" "));
    };

    try {
      await assert.rejects(
        async () => processDueZaloTranscriptionJobs(5),
        /DATABASE_ERROR/,
        "Bulk process without admin client config must throw DATABASE_ERROR"
      );
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(errorLogs.length, 1, "Exactly one invocation_failed log must be emitted on bulk init failure");
    assert.ok(errorLogs[0].includes("action=invocation_failed"), "Must log action=invocation_failed");
    assert.ok(errorLogs[0].includes("mode=BULK"), "Must log mode=BULK");
    assert.ok(errorLogs[0].includes("error_code=DATABASE_ERROR"), "Must log error_code=DATABASE_ERROR");
    assert.ok(errorLogs[0].includes('"claimed_count":0'), "Must log claimed_count: 0");
    assert.ok(errorLogs[0].includes('"processed_count":0'), "Must log processed_count: 0");
    assert.ok(errorLogs[0].includes('"failed_count":0'), "Must log failed_count: 0");
    assert.ok(errorLogs[0].includes('"duration_ms":0'), "Must log duration_ms: 0");
    assert.ok(!errorLogs[0].toLowerCase().includes("missing"), "Must not leak raw config error message");
    testPass("2.4: BULK client initialization failure emits sanitized invocation_failed with DATABASE_ERROR");

    // 2.5: TARGETED client init failure emits sanitized invocation_failed with DATABASE_ERROR and zero counts/duration
    const dummyTargetId = randomUUID();
    const targetedErrorLogs: string[] = [];
    console.error = (...args: any[]) => {
      targetedErrorLogs.push(args.map(String).join(" "));
    };

    try {
      await assert.rejects(
        async () => processTargetedZaloTranscriptionJob(dummyTargetId),
        /DATABASE_ERROR/,
        "Targeted process without admin client config must throw DATABASE_ERROR"
      );
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(targetedErrorLogs.length, 1, "Exactly one invocation_failed log must be emitted on targeted init failure");
    assert.ok(targetedErrorLogs[0].includes("action=invocation_failed"), "Must log action=invocation_failed");
    assert.ok(targetedErrorLogs[0].includes("mode=TARGETED"), "Must log mode=TARGETED");
    assert.ok(targetedErrorLogs[0].includes(`target_id=${dummyTargetId}`), "Must log target_id");
    assert.ok(targetedErrorLogs[0].includes("error_code=DATABASE_ERROR"), "Must log error_code=DATABASE_ERROR");
    assert.ok(targetedErrorLogs[0].includes('"claimed_count":0'), "Must log claimed_count: 0");
    assert.ok(targetedErrorLogs[0].includes('"processed_count":0'), "Must log processed_count: 0");
    assert.ok(targetedErrorLogs[0].includes('"failed_count":0'), "Must log failed_count: 0");
    assert.ok(targetedErrorLogs[0].includes('"duration_ms":0'), "Must log duration_ms: 0");
    assert.ok(!targetedErrorLogs[0].toLowerCase().includes("missing"), "Must not leak raw config error message");
    testPass("2.5: TARGETED client initialization failure emits sanitized invocation_failed with DATABASE_ERROR");
  } finally {
    if (savedSupabaseUrl !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = savedSupabaseUrl;
    if (savedServiceRoleKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedServiceRoleKey;
  }

  // ==========================================================================
  // SECTION 3: PGlite Database Integration (Requirements A - J)
  // ==========================================================================
  console.log('\n--- SECTION 3: PGlite Database Integration Tests ---');

  const harness = await createPgliteSupabase();
  const db = harness.db;

  try {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const bossA = randomUUID();
    const saleA = randomUUID();
    const customerA = randomUUID();
    const deviceA = randomUUID();
    const secretA = 's'.repeat(44);

    // Seed companies & users
    await db.query(`INSERT INTO companies(id, name) VALUES($1, 'Company A'), ($2, 'Company B')`, [companyA, companyB]);
    for (const [id, role, comp] of [
      [bossA, 'BOSS_ADMIN', companyA],
      [saleA, 'SALE', companyA],
    ]) {
      await db.query(`INSERT INTO auth.users(id) VALUES($1)`, [id]);
      await db.query(`INSERT INTO user_profiles(id, full_name) VALUES($1, 'User') ON CONFLICT(id) DO NOTHING`, [id]);
      await db.query(`INSERT INTO company_members(company_id, user_id, role, status) VALUES($1, $2, $3, 'ACTIVE')`, [comp, id, role]);
    }

    await db.query(
      `INSERT INTO customers(id, company_id, name, source, stage) VALUES($1, $2, 'Customer A', 'ZALO', 'LEAD_NEW')`,
      [customerA, companyA]
    );

    // Register capture device
    const devRes = await harness.client.rpc('zalo_manage_device', {
      p_company: companyA,
      p_actor: bossA,
      p_device: deviceA,
      p_name: 'Macbook Automation Device',
      p_hash: sha256(secretA),
      p_staff: saleA,
    });
    assert.ifError(devRes.error);

    // Setup in-memory mock storage
    const storageObjects = new Map<string, Buffer>();
    const adminClient = Object.assign(harness.client, {
      storage: {
        from: (bucket: string) => ({
          upload: async (path: string, body: Buffer) => {
            if (storageObjects.has(path)) return { error: { message: 'exists' } };
            storageObjects.set(path, body);
            await db.query(
              `INSERT INTO storage.objects(bucket_id, name, metadata) VALUES($1, $2, $3)`,
              [bucket, path, JSON.stringify({ size: body.length })]
            );
            return { error: null };
          },
          download: async (path: string) => {
            if (!storageObjects.has(path)) return { data: null, error: { message: 'Object not found' } };
            return { data: new Blob([new Uint8Array(storageObjects.get(path)!)]), error: null };
          },
        }),
      },
    }) as unknown as SupabaseClient;

    const audioBytes = audioFixture();

    // Helper to upload a recording and get call & transcription IDs
    async function createReadyTranscription(companyId: string, name = 'Call Test'): Promise<{ callId: string; txId: string }> {
      const meta = metadataFixture(deviceA, name);
      const res = await uploadRecording(uploadRequest(meta, audioBytes, secretA), adminClient);
      assert.equal(res.duplicate, false);
      const callId = res.call_id;
      const txRow = (await db.query<{ id: string }>(
        `SELECT id FROM zalo_call_transcriptions WHERE call_id = $1`,
        [callId]
      )).rows[0];
      return { callId, txId: txRow.id };
    }

    // ------------------------------------------------------------------------
    // Test 3.1 [Req A & B]: Bulk claiming with limit: limit=1 claims at most 1 job
    // ------------------------------------------------------------------------
    const jobA1 = await createReadyTranscription(companyA, 'Bulk 1');
    const jobA2 = await createReadyTranscription(companyA, 'Bulk 2');
    const jobA3 = await createReadyTranscription(companyA, 'Bulk 3');

    const mockProvider = new MockTranscriptionProvider();
    const bulkResult = await processDueZaloTranscriptionJobs(1, {
      client: adminClient,
      provider: mockProvider,
    });

    assert.equal(bulkResult.claimed, 1, 'limit=1 must claim exactly 1 job');
    assert.equal(bulkResult.processed, 1, 'limit=1 must process exactly 1 job');
    assert.equal(bulkResult.failed, 0);

    // Verify exactly 1 job is completed and remaining 2 jobs remain PENDING
    const completedRows = (await db.query<{ id: string }>(
      `SELECT id FROM zalo_call_transcriptions WHERE id IN ($1, $2, $3) AND status = 'COMPLETED'`,
      [jobA1.txId, jobA2.txId, jobA3.txId]
    )).rows;
    assert.equal(completedRows.length, 1, 'Exactly one job must be completed');

    const pendingRows = (await db.query<{ id: string }>(
      `SELECT id FROM zalo_call_transcriptions WHERE id IN ($1, $2, $3) AND status = 'PENDING'`,
      [jobA1.txId, jobA2.txId, jobA3.txId]
    )).rows;
    assert.equal(pendingRows.length, 2, 'Remaining 2 jobs must stay in PENDING status');
    testPass('3.1 [Req A & B]: Bulk worker limit=1 claims at most 1 job, preserving pending queue');

    // ------------------------------------------------------------------------
    // Test 3.2 [Req D]: Targeted claim: processes ONLY the specified ID
    // ------------------------------------------------------------------------
    const targetJob1 = pendingRows[0].id;
    const untouchedJob2 = pendingRows[1].id;

    const targetedResult = await processTargetedZaloTranscriptionJob(targetJob1, {
      client: adminClient,
      provider: mockProvider,
    });

    assert.equal(targetedResult.claimed, 1, 'Targeted worker must claim exactly 1 job');
    assert.equal(targetedResult.processed, 1, 'Targeted worker must process exactly 1 job');
    assert.equal(targetedResult.failed, 0);

    // Verify targeted job is COMPLETED
    const targetStatus = (await db.query<{ status: string }>(
      `SELECT status FROM zalo_call_transcriptions WHERE id = $1`,
      [targetJob1]
    )).rows[0].status;
    assert.equal(targetStatus, 'COMPLETED', 'Targeted job must be COMPLETED');

    // Verify second job was NEVER claimed and remains PENDING
    const untouchedStatus = (await db.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM zalo_call_transcriptions WHERE id = $1`,
      [untouchedJob2]
    )).rows[0];
    assert.equal(untouchedStatus.status, 'PENDING', 'Non-targeted job must remain PENDING');
    assert.equal(untouchedStatus.attempts, 0, 'Non-targeted job attempts must not change');
    testPass('3.2 [Req D]: Targeted worker claims ONLY requested job; other jobs remain untouched');

    // ------------------------------------------------------------------------
    // Test 3.3 [Req E]: Tenant isolation and unknown target ID fail closed
    // ------------------------------------------------------------------------
    // Non-existent target
    const unknownTargetId = randomUUID();
    const unknownRes = await processTargetedZaloTranscriptionJob(unknownTargetId, {
      client: adminClient,
      provider: mockProvider,
    });
    assert.equal(unknownRes.claimed, 0);
    assert.equal(unknownRes.processed, 0);

    // Mismatched company: job belongs to Company A, caller requests with Company B
    const mismatchedClaim = await adminClient.rpc('zalo_claim_transcription_job', {
      p_company: companyB,
      p_transcription_id: untouchedJob2,
    });
    assert.ifError(mismatchedClaim.error);
    assert.equal(((mismatchedClaim.data || []) as unknown[]).length, 0, 'Cross-tenant targeted claim must return empty');

    // p_company NULL must return empty (Requirement: no wildcard)
    const nullCompanyClaim = await adminClient.rpc('zalo_claim_transcription_job', {
      p_company: null as any,
      p_transcription_id: untouchedJob2,
    });
    assert.ifError(nullCompanyClaim.error);
    assert.equal(((nullCompanyClaim.data || []) as unknown[]).length, 0, 'NULL company must return empty');

    // Job in Company A remains PENDING
    const untouchedCheck = (await db.query<{ status: string }>(
      `SELECT status FROM zalo_call_transcriptions WHERE id = $1`,
      [untouchedJob2]
    )).rows[0].status;
    assert.equal(untouchedCheck, 'PENDING', 'Cross-tenant claim attempt must not mutate row');
    testPass('3.3 [Req E]: Cross-tenant / unknown target ID fails closed with 0 claimed');

    // ------------------------------------------------------------------------
    // Test 3.4 [Req F]: Non-pending / not-due / non-ready target contracts
    // ------------------------------------------------------------------------
    // A: COMPLETED job cannot be claimed
    const claimCompleted = await adminClient.rpc('zalo_claim_transcription_job', {
      p_company: companyA,
      p_transcription_id: targetJob1,
    });
    assert.equal(((claimCompleted.data || []) as unknown[]).length, 0, 'COMPLETED job cannot be claimed');

    // B: Future next_run_at job cannot be claimed
    const futureJob = await createReadyTranscription(companyA, 'Future Job');
    await db.query(
      `UPDATE zalo_call_transcriptions SET next_run_at = now() + interval '1 hour' WHERE id = $1`,
      [futureJob.txId]
    );
    const claimFuture = await adminClient.rpc('zalo_claim_transcription_job', {
      p_company: companyA,
      p_transcription_id: futureJob.txId,
    });
    assert.equal(((claimFuture.data || []) as unknown[]).length, 0, 'Future scheduled job cannot be claimed');

    // C: Non-READY recording status cannot be claimed
    const nonReadyJob = await createReadyTranscription(companyA, 'Non-Ready Call');
    await db.query(
      `UPDATE zalo_personal_calls SET recording_status = 'UPLOADING' WHERE id = $1`,
      [nonReadyJob.callId]
    );
    const claimNonReady = await adminClient.rpc('zalo_claim_transcription_job', {
      p_company: companyA,
      p_transcription_id: nonReadyJob.txId,
    });
    assert.equal(((claimNonReady.data || []) as unknown[]).length, 0, 'Non-READY recording call cannot be claimed');

    // D: Active PROCESSING job with unexpired lease cannot be claimed
    const activeProcJob = await createReadyTranscription(companyA, 'Active Processing');
    await db.query(
      `UPDATE zalo_call_transcriptions
       SET status = 'PROCESSING', lease_expires_at = now() + interval '300 seconds', lock_token = gen_random_uuid()
       WHERE id = $1`,
      [activeProcJob.txId]
    );
    const claimActiveProc = await adminClient.rpc('zalo_claim_transcription_job', {
      p_company: companyA,
      p_transcription_id: activeProcJob.txId,
    });
    assert.equal(((claimActiveProc.data || []) as unknown[]).length, 0, 'Active lease job cannot be claimed');
    testPass('3.4 [Req F]: COMPLETED, future scheduled, non-READY, and active lease jobs cannot be claimed');

    // ------------------------------------------------------------------------
    // Test 3.5 [Req F continued]: Target-isolated expired lease reclamation
    // ------------------------------------------------------------------------
    const expiredJobTarget = await createReadyTranscription(companyA, 'Expired Target');
    const expiredJobOther = await createReadyTranscription(companyA, 'Expired Other');

    // Set both to PROCESSING with expired lease
    await db.query(
      `UPDATE zalo_call_transcriptions
       SET status = 'PROCESSING', lease_expires_at = now() - interval '10 seconds', lock_token = gen_random_uuid(), attempts = 1
       WHERE id IN ($1, $2)`,
      [expiredJobTarget.txId, expiredJobOther.txId]
    );

    // Targeted claim on expiredJobTarget
    const reclaimClaimRes = await adminClient.rpc('zalo_claim_transcription_job', {
      p_company: companyA,
      p_transcription_id: expiredJobTarget.txId,
    });
    assert.ifError(reclaimClaimRes.error);
    const reclaimedRows = (reclaimClaimRes.data || []) as { id: string; attempts: number }[];
    assert.equal(reclaimedRows.length, 1, 'Expired lease target must be reclaimed and claimed');
    assert.equal(reclaimedRows[0].attempts, 2, 'Attempts must be incremented on lease expiration reclaim');

    // CRITICAL: verify expiredJobOther was NOT touched or mutated!
    const otherJobRow = (await db.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM zalo_call_transcriptions WHERE id = $1`,
      [expiredJobOther.txId]
    )).rows[0];
    assert.equal(otherJobRow.status, 'PROCESSING', 'Non-targeted expired job must not have status changed');
    assert.equal(otherJobRow.attempts, 1, 'Non-targeted expired job attempts must not be incremented');

    // When attempts >= max_attempts on expired lease, it fails closed (status=FAILED) and is not claimed
    await db.query(
      `UPDATE zalo_call_transcriptions
       SET status = 'PROCESSING', lease_expires_at = now() - interval '10 seconds', lock_token = gen_random_uuid(), attempts = 2, max_attempts = 3
       WHERE id = $1`,
      [expiredJobOther.txId]
    );
    const reclaimMaxRes = await adminClient.rpc('zalo_claim_transcription_job', {
      p_company: companyA,
      p_transcription_id: expiredJobOther.txId,
    });
    assert.equal(((reclaimMaxRes.data || []) as unknown[]).length, 0, 'Max attempts exceeded must return 0 claimed');
    const expiredOtherFinal = (await db.query<{ status: string; error_code: string }>(
      `SELECT status, error_code FROM zalo_call_transcriptions WHERE id = $1`,
      [expiredJobOther.txId]
    )).rows[0];
    assert.equal(expiredOtherFinal.status, 'FAILED');
    assert.equal(expiredOtherFinal.error_code, 'EXPIRED_LEASE_MAX_ATTEMPTS');

    // attempts = 10 expired lease: bounded at 10, does not violate attempts <= 10 constraint
    const max10Job = await createReadyTranscription(companyA, 'Max 10 Attempts');
    await db.query(
      `UPDATE zalo_call_transcriptions
       SET status = 'PROCESSING', lease_expires_at = now() - interval '10 seconds', lock_token = gen_random_uuid(), attempts = 10, max_attempts = 10
       WHERE id = $1`,
      [max10Job.txId]
    );
    const reclaim10Res = await adminClient.rpc('zalo_claim_transcription_job', {
      p_company: companyA,
      p_transcription_id: max10Job.txId,
    });
    assert.ifError(reclaim10Res.error);
    assert.equal(((reclaim10Res.data || []) as unknown[]).length, 0, 'attempts=10 expired returns 0 claimed');
    const max10Row = (await db.query<{ status: string; attempts: number; error_code: string; updated_at: string }>(
      `SELECT status, attempts, error_code, updated_at FROM zalo_call_transcriptions WHERE id = $1`,
      [max10Job.txId]
    )).rows[0];
    assert.equal(max10Row.status, 'FAILED');
    assert.equal(max10Row.attempts, 10, 'attempts counter must be bounded at 10 without constraint violation');
    assert.equal(max10Row.error_code, 'EXPIRED_LEASE_MAX_ATTEMPTS');

    // Call transcript_status must be transitioned to FAILED
    const callStatusCheck = (await db.query<{ transcript_status: string }>(
      `SELECT transcript_status FROM zalo_personal_calls WHERE id = $1`,
      [max10Job.callId]
    )).rows[0];
    assert.equal(callStatusCheck.transcript_status, 'FAILED', 'Call transcript_status must be transitioned to FAILED');

    // Subsequent targeted call on FAILED job does not mutate row or updated_at
    const claimFailedAgain = await adminClient.rpc('zalo_claim_transcription_job', {
      p_company: companyA,
      p_transcription_id: max10Job.txId,
    });
    assert.ifError(claimFailedAgain.error);
    assert.equal(((claimFailedAgain.data || []) as unknown[]).length, 0);
    const max10RowAfter = (await db.query<{ updated_at: string }>(
      `SELECT updated_at FROM zalo_call_transcriptions WHERE id = $1`,
      [max10Job.txId]
    )).rows[0];
    assert.equal(new Date(max10RowAfter.updated_at).toISOString(), new Date(max10Row.updated_at).toISOString(), 'Subsequent claim on FAILED job must not mutate row');
    testPass('3.5 [Req F]: Expired lease reclamation is strictly isolated to target and respects max attempts (bounded at 10 with idempotent terminal state)');

    // ------------------------------------------------------------------------
    // Test 3.6 [Req G]: 2 workers concurrency & duplicate claim prevention
    // ------------------------------------------------------------------------
    // Note: In PGlite, tests execute in a single serial process. This test verifies that
    // active row lease and FOR UPDATE SKIP LOCKED prevent Worker 2 from claiming the same job
    // while Worker 1 holds the lease. We explicitly document that PGlite serializes execution
    // and do NOT falsely claim this is multithreaded Postgres concurrency.
    const concurrentJob = await createReadyTranscription(companyA, 'Concurrent Job');

    // Worker 1 claims job
    const claimWorker1 = await adminClient.rpc('zalo_claim_transcription_job', {
      p_company: companyA,
      p_transcription_id: concurrentJob.txId,
      p_locked_by: 'worker_1',
    });
    const w1Rows = (claimWorker1.data || []) as { id: string }[];
    assert.equal(w1Rows.length, 1, 'Worker 1 claims the job');

    // Worker 2 attempts to claim the same job while Worker 1 lease is active
    const claimWorker2 = await adminClient.rpc('zalo_claim_transcription_job', {
      p_company: companyA,
      p_transcription_id: concurrentJob.txId,
      p_locked_by: 'worker_2',
    });
    const w2Rows = (claimWorker2.data || []) as unknown[];
    assert.equal(w2Rows.length, 0, 'Worker 2 cannot double-claim active job held by Worker 1');
    testPass('3.6 [Req G]: Row lease & SKIP LOCKED prevent duplicate claiming (PGlite serial verified)');

    // ------------------------------------------------------------------------
    // Test 3.7 [Req H]: Service-role only RPC ACL: anon & authenticated denied
    // ------------------------------------------------------------------------
    await db.query(`BEGIN`);
    let anonError: any;
    try {
      await db.query(`SET LOCAL ROLE anon`);
      await db.query(`SELECT * FROM public.zalo_claim_transcription_job($1, $2)`, [companyA, concurrentJob.txId]);
    } catch (err) {
      anonError = err;
    } finally {
      await db.query(`ROLLBACK`);
    }
    assert.ok(anonError, 'Role anon must be denied execution on zalo_claim_transcription_job');
    assert.equal(anonError.code, '42501', 'Must fail with 42501 permission denied for anon');

    await db.query(`BEGIN`);
    let authError: any;
    try {
      await db.query(`SET LOCAL ROLE authenticated`);
      await db.query(`SELECT * FROM public.zalo_claim_transcription_job($1, $2)`, [companyA, concurrentJob.txId]);
    } catch (err) {
      authError = err;
    } finally {
      await db.query(`ROLLBACK`);
    }
    assert.ok(authError, 'Role authenticated must be denied execution on zalo_claim_transcription_job');
    assert.equal(authError.code, '42501', 'Must fail with 42501 permission denied for authenticated');
    testPass('3.7 [Req H]: ACL enforcement: anon and authenticated roles denied with 42501');

    // ------------------------------------------------------------------------
    // Test 3.8 [Req I]: Provider failure preserves original recording intact
    // ------------------------------------------------------------------------
    const failJob = await createReadyTranscription(companyA, 'Fail Job');
    const failingProvider = {
      name: 'MOCK',
      model: 'mock-model',
      transcribe: async () => {
        throw new Error('PROVIDER_TEMPORARY_ERROR');
      },
    };

    // Before failure: recording exists in storage
    assert.ok(storageObjects.size > 0, 'Storage objects must exist');

    // Run targeted worker with failing provider
    const failRes = await processTargetedZaloTranscriptionJob(failJob.txId, {
      client: adminClient,
      provider: failingProvider as any,
    });
    assert.equal(failRes.claimed, 1);
    assert.equal(failRes.processed, 0);
    assert.equal(failRes.failed, 1);

    // Verify job status updated to retry_scheduled / PENDING
    const failJobRow = (await db.query<{ status: string; attempts: number; error_code: string }>(
      `SELECT status, attempts, error_code FROM zalo_call_transcriptions WHERE id = $1`,
      [failJob.txId]
    )).rows[0];
    assert.equal(failJobRow.status, 'PENDING');
    assert.equal(failJobRow.attempts, 1);

    // CRITICAL: verify original recording file in storage is 100% intact
    const callRecordingPath = (await db.query<{ recording_path: string }>(
      `SELECT recording_path FROM zalo_personal_calls WHERE id = $1`,
      [failJob.callId]
    )).rows[0].recording_path;
    assert.ok(storageObjects.has(callRecordingPath), 'Original recording in storage MUST remain intact on failure');
    testPass('3.8 [Req I]: Provider failure preserves original recording file intact');

    // ------------------------------------------------------------------------
    // Test 3.9 [Req I]: Lock token fencing: stale lock token fails with TRANSCRIPTION_LOCK_LOST
    // ------------------------------------------------------------------------
    const staleLockToken = randomUUID();
    const completeRes = await adminClient.rpc('zalo_complete_transcription', {
      p_company: companyA,
      p_transcription_id: failJob.txId,
      p_lock_token: staleLockToken,
      p_full_transcript: 'Stale transcript',
      p_utterances: [],
    });
    assert.ok(completeRes.error, 'Completion with stale lock token must fail');
    assert.ok(
      completeRes.error.message.includes('TRANSCRIPTION_LOCK_LOST'),
      'Stale token must trigger TRANSCRIPTION_LOCK_LOST'
    );
    testPass('3.9 [Req I]: Stale lock token completion fenced by TRANSCRIPTION_LOCK_LOST');

    console.log('\n================================================================');
    console.log(`ALL AUTOMATION & TARGETED WORKER TESTS PASSED: ${passCount} PASSED, 0 FAILED`);
    console.log('================================================================\n');
  } finally {
    await harness.close();
  }
}

runAutomationTestSuite().catch((err) => {
  console.error('\n❌ AUTOMATION TEST SUITE FAILED:', err);
  process.exit(1);
});
