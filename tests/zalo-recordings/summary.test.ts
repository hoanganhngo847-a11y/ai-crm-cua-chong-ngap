/**
 * Zalo Call AI Summary Unit & Route Validation Test Suite
 *
 * Covers:
 * - Structured Output Schema & Strict Validation (Enums, Types, Arrays, Truncation)
 * - Safe Error Code Mapping & Sanitization (Never leak tokens/keys/paths)
 * - Provider Error Mapping (Gemini & OpenAI)
 * - Prompt Construction (Distinguishes roles, no leakage)
 * - Worker Route Handler (/api/cron/zalo-call-summary):
 *   * Missing/invalid Bearer token -> 401
 *   * Unconfigured CRON_SECRET -> 503 in all environments
 *   * Duplicate query parameters -> 400
 *   * Invalid limit / UUID parameters -> 400
 *   * Targeted vs Bulk dispatch routing
 */
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import {
  GET as summaryGetHandler,
  POST as summaryPostHandler,
  handleZaloCallSummaryCron,
} from '../../app/api/cron/zalo-call-summary/route';
import {
  validateCallSummaryOutput,
  VALID_LEAD_TEMPERATURES,
  VALID_CONFIDENCE_LEVELS,
} from '../../features/zalo-summary/validation';
import {
  buildTranscriptInput,
  SUMMARY_SYSTEM_INSTRUCTION,
} from '../../features/zalo-summary/prompt';
import {
  mapGeminiSummaryError,
} from '../../features/zalo-summary/gemini-summary-provider';
import {
  resolveSummaryConfig,
} from '../../features/zalo-summary/provider-factory';
import {
  mapOpenAiSummaryError,
} from '../../features/zalo-summary/openai-summary-provider';
import {
  sanitizeSummaryErrorCode,
  sanitizeSummaryErrorMessage,
  isPermanentSummaryError,
  getSummaryRetryDelayMs,
  getSummaryFailureOutcome,
} from '../../features/zalo-summary/service';
import type { SummaryUtterance } from '../../features/zalo-summary/types';

let passCount = 0;
function testPass(msg: string) {
  console.log(`[PASS] ${msg}`);
  passCount++;
}

async function runSummaryUnitTests() {
  console.log('================================================================');
  console.log('STARTING ZALO CALL AI SUMMARY UNIT & ROUTE TEST SUITE');
  console.log('================================================================\n');

  // ==========================================================================
  // SECTION 1: Schema & Strict Validation Tests
  // ==========================================================================
  console.log('--- SECTION 1: Schema & Strict Validation Tests ---');

  const validSample = {
    summary: 'Khách hàng quan tâm đến dịch vụ và hẹn gọi lại sau.',
    customer_needs: ['Tư vấn lắp đặt', 'Báo giá chi tiết'],
    objections: ['Chi phí hơi cao'],
    next_actions: ['Gửi báo giá qua Zalo', 'Gọi lại sáng thứ 2'],
    lead_temperature: 'WARM',
    follow_up: {
      required: true,
      suggested_time: '2026-10-25 09:00',
      reason: 'Khách hàng muốn xem lại báo giá',
    },
    key_points: ['Khách đang cân nhắc', 'Đã nhận thông tin sơ bộ'],
    confidence: 'HIGH',
  };

  // 1.1: Valid payload passes
  const validated = validateCallSummaryOutput(validSample);
  assert.equal(validated.summary, validSample.summary);
  assert.equal(validated.lead_temperature, 'WARM');
  assert.equal(validated.confidence, 'HIGH');
  assert.equal(validated.follow_up.required, true);
  assert.equal(validated.follow_up.suggested_time, '2026-10-25 09:00');
  assert.deepEqual(validated.customer_needs, ['Tư vấn lắp đặt', 'Báo giá chi tiết']);
  testPass('1.1: Valid payload passes strict validation');

  // 1.2: Valid minimal payload with empty arrays and null follow_up
  const minimalSample = {
    summary: 'Cuộc gọi ngắn không có thông tin chi tiết.',
    customer_needs: [],
    objections: [],
    next_actions: [],
    lead_temperature: 'COLD',
    follow_up: {
      required: false,
      suggested_time: null,
      reason: null,
    },
    key_points: [],
    confidence: 'LOW',
  };
  const validatedMinimal = validateCallSummaryOutput(minimalSample);
  assert.equal(validatedMinimal.lead_temperature, 'COLD');
  assert.equal(validatedMinimal.confidence, 'LOW');
  assert.equal(validatedMinimal.follow_up.required, false);
  assert.equal(validatedMinimal.follow_up.suggested_time, null);
  testPass('1.2: Minimal valid payload with empty arrays and nulls passes');

  // 1.3: Reject non-object or null root
  assert.throws(() => validateCallSummaryOutput(null), /SUMMARY_INVALID_RESPONSE/);
  assert.throws(() => validateCallSummaryOutput('string'), /SUMMARY_INVALID_RESPONSE/);
  assert.throws(() => validateCallSummaryOutput([]), /SUMMARY_INVALID_RESPONSE/);
  testPass('1.3: Non-object or array root rejected');

  // 1.4: Reject missing/empty summary
  assert.throws(() => validateCallSummaryOutput({ ...validSample, summary: '' }), /SUMMARY_INVALID_RESPONSE/);
  assert.throws(() => validateCallSummaryOutput({ ...validSample, summary: '   ' }), /SUMMARY_INVALID_RESPONSE/);
  assert.throws(() => validateCallSummaryOutput({ ...validSample, summary: 123 }), /SUMMARY_INVALID_RESPONSE/);
  testPass('1.4: Empty or non-string summary rejected');

  // 1.5: Strict lead_temperature enum validation
  for (const temp of VALID_LEAD_TEMPERATURES) {
    const res = validateCallSummaryOutput({ ...validSample, lead_temperature: temp });
    assert.equal(res.lead_temperature, temp);
  }
  assert.throws(() => validateCallSummaryOutput({ ...validSample, lead_temperature: 'LUKEWARM' }), /SUMMARY_INVALID_RESPONSE/);
  assert.throws(() => validateCallSummaryOutput({ ...validSample, lead_temperature: 'hot_lead' }), /SUMMARY_INVALID_RESPONSE/);
  assert.throws(() => validateCallSummaryOutput({ ...validSample, lead_temperature: null }), /SUMMARY_INVALID_RESPONSE/);
  testPass('1.5: Strict lead_temperature enum (HOT | WARM | COLD) enforced');

  // 1.6: Strict confidence enum validation
  for (const conf of VALID_CONFIDENCE_LEVELS) {
    const res = validateCallSummaryOutput({ ...validSample, confidence: conf });
    assert.equal(res.confidence, conf);
  }
  assert.throws(() => validateCallSummaryOutput({ ...validSample, confidence: 'VERY_HIGH' }), /SUMMARY_INVALID_RESPONSE/);
  assert.throws(() => validateCallSummaryOutput({ ...validSample, confidence: 0.95 }), /SUMMARY_INVALID_RESPONSE/);
  assert.throws(() => validateCallSummaryOutput({ ...validSample, confidence: null }), /SUMMARY_INVALID_RESPONSE/);
  testPass('1.6: Strict confidence enum (LOW | MEDIUM | HIGH) enforced');

  // 1.7: Reject non-string items in arrays
  assert.throws(() => validateCallSummaryOutput({ ...validSample, customer_needs: [123] }), /SUMMARY_INVALID_RESPONSE/);
  assert.throws(() => validateCallSummaryOutput({ ...validSample, objections: 'single objection' }), /SUMMARY_INVALID_RESPONSE/);
  assert.throws(() => validateCallSummaryOutput({ ...validSample, next_actions: null }), /SUMMARY_INVALID_RESPONSE/);
  testPass('1.7: Malformed or non-string arrays rejected');

  // 1.8: Reject malformed follow_up
  assert.throws(() => validateCallSummaryOutput({ ...validSample, follow_up: null }), /SUMMARY_INVALID_RESPONSE/);
  assert.throws(() => validateCallSummaryOutput({ ...validSample, follow_up: { required: 'yes' } }), /SUMMARY_INVALID_RESPONSE/);
  assert.throws(() => validateCallSummaryOutput({ ...validSample, follow_up: { required: true, suggested_time: 12345 } }), /SUMMARY_INVALID_RESPONSE/);
  testPass('1.8: Malformed follow_up rejected');

  // 1.9: follow_up.suggested_time contract: natural language string, ISO string, and null are all valid
  const naturalLanguageTime = validateCallSummaryOutput({
    ...validSample,
    follow_up: {
      required: true,
      suggested_time: 'Sáng thứ 2 tuần tới',
      reason: 'Khách bận công tác cuối tuần',
    },
  });
  assert.equal(naturalLanguageTime.follow_up.suggested_time, 'Sáng thứ 2 tuần tới');

  const isoTime = validateCallSummaryOutput({
    ...validSample,
    follow_up: {
      required: true,
      suggested_time: '2026-10-26T09:00:00Z',
      reason: 'Khách hẹn giờ chính xác',
    },
  });
  assert.equal(isoTime.follow_up.suggested_time, '2026-10-26T09:00:00Z');

  const unrequiredNullTime = validateCallSummaryOutput({
    ...validSample,
    follow_up: {
      required: false,
      suggested_time: null,
      reason: null,
    },
  });
  assert.equal(unrequiredNullTime.follow_up.suggested_time, null);
  assert.equal(unrequiredNullTime.follow_up.required, false);

  assert.throws(
    () => validateCallSummaryOutput({ ...validSample, follow_up: { required: true, suggested_time: 12345 } }),
    /SUMMARY_INVALID_RESPONSE/
  );
  assert.throws(
    () => validateCallSummaryOutput({ ...validSample, follow_up: { required: true, suggested_time: false } }),
    /SUMMARY_INVALID_RESPONSE/
  );
  testPass('1.9: follow_up.suggested_time accepts natural language, ISO, and null without cast error');

  // ==========================================================================
  // SECTION 2: Prompt Construction & Utterance Formatter
  // ==========================================================================
  console.log('--- SECTION 2: Prompt Construction Tests ---');

  const testUtterances: SummaryUtterance[] = [
    {
      sequence: 1,
      speaker_role: 'STAFF',
      channel: 'RIGHT',
      start_ms: 1000,
      end_ms: 4500,
      text: 'Dạ em chào anh, bên em gọi từ dịch vụ.',
      confidence: 0.95,
    },
    {
      sequence: 2,
      speaker_role: 'CUSTOMER',
      channel: 'LEFT',
      start_ms: 5000,
      end_ms: 9000,
      text: 'Tôi cần hỏi giá lắp đặt cho nhà 3 tầng.',
      confidence: 0.92,
    },
  ];

  const formatted = buildTranscriptInput(testUtterances);
  assert.match(formatted, /\[00:01 - 00:04\] STAFF: Dạ em chào anh/);
  assert.match(formatted, /\[00:05 - 00:09\] CUSTOMER: Tôi cần hỏi giá/);
  assert.equal(buildTranscriptInput([]), '');
  assert.ok(SUMMARY_SYSTEM_INSTRUCTION.includes('ZERO HALLUCINATION'));
  assert.ok(SUMMARY_SYSTEM_INSTRUCTION.includes('lead_temperature'));
  testPass('2.1: Transcript input formatting and system instructions verified');

  // ==========================================================================
  // SECTION 3: Error Code Mapping & Sanitization
  // ==========================================================================
  console.log('--- SECTION 3: Error Code Mapping & Sanitization Tests ---');

  // 3.1: Gemini error mappings
  assert.equal(mapGeminiSummaryError(new Error('SUMMARY_PROVIDER_NOT_CONFIGURED')).message, 'SUMMARY_PROVIDER_NOT_CONFIGURED');
  assert.equal(mapGeminiSummaryError({ name: 'AbortError' }).message, 'SUMMARY_PROVIDER_TIMEOUT');
  assert.equal(mapGeminiSummaryError({ status: 401 }).message, 'SUMMARY_PROVIDER_AUTH_ERROR');
  assert.equal(mapGeminiSummaryError({ status: 403 }).message, 'SUMMARY_PROVIDER_AUTH_ERROR');
  assert.equal(mapGeminiSummaryError({ status: 429 }).message, 'SUMMARY_PROVIDER_RATE_LIMITED');
  assert.equal(mapGeminiSummaryError({ status: 503 }).message, 'SUMMARY_PROVIDER_UNAVAILABLE');
  assert.equal(mapGeminiSummaryError({ status: 400 }).message, 'SUMMARY_INVALID_RESPONSE');
  testPass('3.1: Gemini provider error mapping verified');

  // 3.2: OpenAI error mappings
  assert.equal(mapOpenAiSummaryError(new Error('SUMMARY_PROVIDER_NOT_CONFIGURED')).message, 'SUMMARY_PROVIDER_NOT_CONFIGURED');
  assert.equal(mapOpenAiSummaryError({ name: 'TimeoutError' }).message, 'SUMMARY_PROVIDER_TIMEOUT');
  assert.equal(mapOpenAiSummaryError({ status: 401 }).message, 'SUMMARY_PROVIDER_AUTH_ERROR');
  assert.equal(mapOpenAiSummaryError({ status: 429 }).message, 'SUMMARY_PROVIDER_RATE_LIMITED');
  assert.equal(mapOpenAiSummaryError({ status: 500 }).message, 'SUMMARY_PROVIDER_UNAVAILABLE');
  testPass('3.2: OpenAI provider error mapping verified');

  // 3.3: Sanitization: credentials and paths never leaked in messages
  const leakedError = new Error('Failed to connect with Bearer sk-ant-api03-secret12345678901234567890 at /Users/hoangthuy/secret/db.json');
  const sanitizedMessage = sanitizeSummaryErrorMessage(leakedError);
  assert.ok(!sanitizedMessage.includes('secret12345678901234567890'), 'Secret key must be stripped');
  assert.ok(!sanitizedMessage.includes('/Users/hoangthuy/secret'), 'Local filesystem path must be stripped');
  assert.match(sanitizedMessage, /Bearer \*\*\*/);

  assert.equal(sanitizeSummaryErrorCode(new Error('API key AIzaSyD93847592837482394 expired')), 'SUMMARY_PROVIDER_AUTH_ERROR');
  testPass('3.3: Secret token, API key, and path sanitization verified');

  // 3.4: Retry backoff calculation
  assert.equal(getSummaryRetryDelayMs(0), 30_000);
  assert.equal(getSummaryRetryDelayMs(1), 30_000);
  assert.equal(getSummaryRetryDelayMs(2), 60_000);
  assert.equal(getSummaryRetryDelayMs(3), 120_000);
  assert.equal(getSummaryRetryDelayMs(10), 3_600_000); // capped at 1h

  const outcome1 = getSummaryFailureOutcome(0, 3);
  assert.equal(outcome1.attempts, 1);
  assert.equal(outcome1.terminal, false);

  const outcomeTerminal = getSummaryFailureOutcome(2, 3);
  assert.equal(outcomeTerminal.attempts, 3);
  assert.equal(outcomeTerminal.terminal, true);
  testPass('3.4: Exponential backoff and retry outcomes verified');

  // 3.5: Summary Provider & Model resolution tests
  const originalSummaryProvider = process.env.SUMMARY_PROVIDER;
  const originalGeminiModel = process.env.GEMINI_SUMMARY_MODEL;
  const originalOpenAiModel = process.env.OPENAI_SUMMARY_MODEL;

  try {
    // Default GEMINI
    delete process.env.SUMMARY_PROVIDER;
    delete process.env.GEMINI_SUMMARY_MODEL;
    const defaultCfg = resolveSummaryConfig();
    assert.equal(defaultCfg.provider, 'GEMINI');
    assert.equal(defaultCfg.model, 'gemini-2.5-flash');

    // GEMINI with custom model
    process.env.SUMMARY_PROVIDER = 'GEMINI';
    process.env.GEMINI_SUMMARY_MODEL = 'gemini-custom-model-x';
    const geminiCustomCfg = resolveSummaryConfig();
    assert.equal(geminiCustomCfg.provider, 'GEMINI');
    assert.equal(geminiCustomCfg.model, 'gemini-custom-model-x');

    // OPENAI with custom model
    process.env.SUMMARY_PROVIDER = 'OPENAI';
    process.env.OPENAI_SUMMARY_MODEL = 'gpt-4o-custom';
    const openaiCustomCfg = resolveSummaryConfig();
    assert.equal(openaiCustomCfg.provider, 'OPENAI');
    assert.equal(openaiCustomCfg.model, 'gpt-4o-custom');

    // Invalid provider fails closed
    process.env.SUMMARY_PROVIDER = 'CLAUDE_UNKNOWN';
    assert.throws(() => resolveSummaryConfig(), /SUMMARY_PROVIDER_NOT_CONFIGURED/);

    testPass('3.5: Dynamic provider and model resolution (GEMINI/OPENAI/fail-closed) verified');
  } finally {
    process.env.SUMMARY_PROVIDER = originalSummaryProvider;
    process.env.GEMINI_SUMMARY_MODEL = originalGeminiModel;
    process.env.OPENAI_SUMMARY_MODEL = originalOpenAiModel;
  }

  // ==========================================================================
  // SECTION 4: Worker Route HTTP Authentication & Query Validation Tests
  // ==========================================================================
  console.log('--- SECTION 4: Worker Route HTTP & Query Parameter Tests ---');

  const TEST_SECRET = 'test-phase2b-cron-secret-abcdef123456';
  const originalEnvSecret = process.env.CRON_SECRET;
  const setEnv = (key: string, val: string | undefined) => {
    if (val === undefined) Reflect.deleteProperty(process.env, key);
    else (process.env as Record<string, string | undefined>)[key] = val;
  };

  try {
    setEnv('CRON_SECRET', TEST_SECRET);

    // 4.1: Missing Authorization header -> 401
    const reqNoAuth = new NextRequest('http://localhost/api/cron/zalo-call-summary');
    const resNoAuth = await summaryGetHandler(reqNoAuth);
    assert.equal(resNoAuth.status, 401, 'Missing auth header must return 401');
    testPass('4.1: Missing Authorization header returns 401');

    // 4.2: Invalid Bearer token -> 401
    const reqWrongAuth = new NextRequest('http://localhost/api/cron/zalo-call-summary', {
      headers: { authorization: 'Bearer wrong-secret' },
    });
    const resWrongAuth = await summaryGetHandler(reqWrongAuth);
    assert.equal(resWrongAuth.status, 401, 'Wrong token must return 401');
    testPass('4.2: Wrong Bearer token returns 401');

    // 4.3: Missing CRON_SECRET in environment -> 503
    setEnv('CRON_SECRET', undefined);
    const reqNoSecret = new NextRequest('http://localhost/api/cron/zalo-call-summary', {
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });
    const resNoSecret = await summaryGetHandler(reqNoSecret);
    assert.equal(resNoSecret.status, 503, 'Missing CRON_SECRET must return 503');
    testPass('4.3: Unconfigured CRON_SECRET fails closed with 503');

    // Restore CRON_SECRET
    setEnv('CRON_SECRET', TEST_SECRET);

    // 4.4: Duplicate query parameters -> 400
    const reqDup = new NextRequest('http://localhost/api/cron/zalo-call-summary?limit=1&limit=2', {
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });
    const resDup = await summaryGetHandler(reqDup);
    assert.equal(resDup.status, 400, 'Duplicate query params must return 400');
    testPass('4.4: Duplicate query parameters rejected with 400');

    // 4.5: Invalid limit parameters -> 400
    const invalidLimits = ['0', '-1', '11', 'abc', '1.5'];
    for (const badLimit of invalidLimits) {
      const reqBadLimit = new NextRequest(`http://localhost/api/cron/zalo-call-summary?limit=${badLimit}`, {
        headers: { authorization: `Bearer ${TEST_SECRET}` },
      });
      const resBadLimit = await summaryGetHandler(reqBadLimit);
      assert.equal(resBadLimit.status, 400, `limit=${badLimit} must return 400`);
    }
    testPass('4.5: Invalid limit parameters (0, negative, >10, fraction, text) rejected with 400');

    // 4.6: Invalid UUID parameters -> 400
    const reqBadSummaryId = new NextRequest('http://localhost/api/cron/zalo-call-summary?summary_id=not-a-uuid', {
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });
    const resBadSummaryId = await summaryGetHandler(reqBadSummaryId);
    assert.equal(resBadSummaryId.status, 400, 'Invalid summary_id UUID must return 400');

    const reqBadTxId = new NextRequest('http://localhost/api/cron/zalo-call-summary?transcription_id=not-a-uuid', {
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });
    const resBadTxId = await summaryGetHandler(reqBadTxId);
    assert.equal(resBadTxId.status, 400, 'Invalid transcription_id UUID must return 400');
    testPass('4.6: Invalid UUID parameters rejected with 400');

    // 4.7: Mock dependency injection for targeted and bulk execution
    let bulkLimitCalled: number | null = null;
    let targetedCalled: { summaryId?: string; transcriptionId?: string } | null = null;

    const mockDeps = {
      processDue: async (limit: number) => {
        bulkLimitCalled = limit;
        return { claimed: 1, processed: 1, failed: 0 };
      },
      processTargeted: async (target: { summaryId?: string; transcriptionId?: string }) => {
        targetedCalled = target;
        return { claimed: 1, processed: 1, failed: 0 };
      },
    };

    // Bulk mode
    const reqBulk = new NextRequest('http://localhost/api/cron/zalo-call-summary?limit=5', {
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });
    const resBulk = await handleZaloCallSummaryCron(reqBulk, mockDeps);
    assert.equal(resBulk.status, 200);
    const bulkJson = await resBulk.json();
    assert.equal(bulkJson.mode, 'BULK');
    assert.equal(bulkLimitCalled, 5);
    testPass('4.7: Valid bulk execution dispatches to processDue with limit');

    // Targeted mode with summary_id
    const targetUuid = '11111111-2222-3333-4444-555555555555';
    const reqTargeted = new NextRequest(`http://localhost/api/cron/zalo-call-summary?summary_id=${targetUuid}`, {
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });
    const resTargeted = await handleZaloCallSummaryCron(reqTargeted, mockDeps);
    assert.equal(resTargeted.status, 200);
    const targetedJson = await resTargeted.json();
    assert.equal(targetedJson.mode, 'TARGETED');
    assert.equal(targetedCalled ? (targetedCalled as { summaryId?: string }).summaryId : null, targetUuid);
    testPass('4.8: Targeted mode dispatches to processTargeted without fallback to bulk');

    // POST method works identical to GET
    const reqPost = new NextRequest('http://localhost/api/cron/zalo-call-summary?limit=3', {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });
    const resPost = await handleZaloCallSummaryCron(reqPost, mockDeps);
    assert.equal(resPost.status, 200);
    testPass('4.9: POST method supported and functions identically to GET');
  } finally {
    setEnv('CRON_SECRET', originalEnvSecret);
  }

  console.log('\n================================================================');
  console.log(`ALL ${passCount} SUMMARY UNIT & ROUTE TESTS PASSED SUCCESSFULLY!`);
  console.log('================================================================\n');
}

runSummaryUnitTests().catch((err) => {
  console.error('[FAIL] Summary unit tests encountered unhandled error:', err);
  process.exit(1);
});
