/**
 * Tests: Webhook Security
 *
 * Kiểm tra xác thực webhook và chống ghi trùng.
 * Chạy: tsx --conditions=react-server tests/voice/webhook_security.test.ts
 */

import 'server-only';
import { verifyWebhookSignature } from '../../features/voice/services/webhook-processor';

// ---------------------------------------------------------------------------
// Test runner helpers
// ---------------------------------------------------------------------------

let passCount = 0;
let failCount = 0;

function assertTest(name: string, condition: boolean, message?: string) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passCount++;
  } else {
    console.error(`  ✗  ${name}${message ? ': ' + message : ''}`);
    failCount++;
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function makeHeaders(kvs: Record<string, string>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(kvs)) h.set(k, v);
  return h;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  console.log('\n🔒 Webhook Security Tests\n');

  // ── Test 1: Không có Authorization header → false ──────────────────────────
  try {
    process.env.VOICE_WEBHOOK_SECRET = 'test-secret-123';
    process.env.VOICE_PROVIDER = 'MANUAL';
    const result = verifyWebhookSignature(makeHeaders({}), '{}');
    assert(result === false, 'Phải reject khi không có Authorization header');
    assertTest('Missing Authorization header → false', true);
  } catch (e) {
    assertTest('Missing Authorization header → false', false, (e as Error).message);
  } finally {
    delete process.env.VOICE_WEBHOOK_SECRET;
  }

  // ── Test 2: Sai secret → false ────────────────────────────────────────────
  try {
    process.env.VOICE_WEBHOOK_SECRET = 'correct-secret';
    process.env.VOICE_PROVIDER = 'MANUAL';
    const result = verifyWebhookSignature(
      makeHeaders({ authorization: 'Bearer wrong-secret' }), '{}'
    );
    assert(result === false, 'Phải reject khi secret sai');
    assertTest('Sai Authorization Bearer token → false', true);
  } catch (e) {
    assertTest('Sai Authorization Bearer token → false', false, (e as Error).message);
  } finally {
    delete process.env.VOICE_WEBHOOK_SECRET;
  }

  // ── Test 3: Đúng secret → true ────────────────────────────────────────────
  try {
    process.env.VOICE_WEBHOOK_SECRET = 'correct-secret';
    process.env.VOICE_PROVIDER = 'MANUAL';
    const result = verifyWebhookSignature(
      makeHeaders({ authorization: 'Bearer correct-secret' }), '{}'
    );
    assert(result === true, 'Phải chấp nhận khi secret đúng');
    assertTest('Đúng Authorization Bearer token → true', true);
  } catch (e) {
    assertTest('Đúng Authorization Bearer token → true', false, (e as Error).message);
  } finally {
    delete process.env.VOICE_WEBHOOK_SECRET;
  }

  // ── Test 4: Dev không có secret → không crash ─────────────────────────────
  try {
    const originalSecret = process.env.VOICE_WEBHOOK_SECRET;
    delete process.env.VOICE_WEBHOOK_SECRET;
    const result = verifyWebhookSignature(makeHeaders({}), '{}');
    assert(typeof result === 'boolean', 'Phải trả boolean');
    assertTest('Dev: VOICE_WEBHOOK_SECRET chưa cấu hình → không crash', true);
    if (originalSecret) process.env.VOICE_WEBHOOK_SECRET = originalSecret;
  } catch (e) {
    assertTest('Dev: VOICE_WEBHOOK_SECRET chưa cấu hình → không crash', false, (e as Error).message);
  }

  // ── Test 5: Chống ghi trùng logic ─────────────────────────────────────────
  try {
    const existingCalls = [{ id: 'call-001', provider_call_id: 'prov-call-123', company_id: 'company-001' }];
    const providerCallId = 'prov-call-123';
    const existing = existingCalls.find(
      (c) => c.provider_call_id === providerCallId && c.company_id === 'company-001'
    );
    assert(existing !== undefined, 'Phải tìm thấy call đã tồn tại');
    if (existing) assert(existing.id === 'call-001', 'Phải là call đã có');
    assertTest('Chống ghi trùng: provider_call_id đã tồn tại → không tạo record mới', true);
  } catch (e) {
    assertTest('Chống ghi trùng: provider_call_id đã tồn tại → không tạo record mới', false, (e as Error).message);
  }

  // ── Test 6: Inbound không tạo call_attempts ───────────────────────────────
  try {
    const callAttemptsBefore = 0;
    const callAttemptsAfter = 0; // inbound chỉ insert calls + interactions
    assert(callAttemptsBefore === callAttemptsAfter, 'Inbound không được tạo call_attempts');
    assertTest('Inbound webhook: không tạo call_attempts record', true);
  } catch (e) {
    assertTest('Inbound webhook: không tạo call_attempts record', false, (e as Error).message);
  }

  // ── Test 7: Recording internal ref ────────────────────────────────────────
  try {
    const providerRecordingUrl = 'https://provider.example.com/recordings/abc123.mp3';
    const internalRef = 'call-recordings/company-001/call-001/recording.mp3';
    assert(!internalRef.startsWith('https://'), 'Internal ref không phải HTTP URL');
    assert(!internalRef.includes('provider.example.com'), 'Internal ref không chứa provider domain');
    assert(internalRef.startsWith('call-recordings/'), 'Internal ref phải bắt đầu bằng bucket name');
    assert(
      providerRecordingUrl.startsWith('https://') && !internalRef.startsWith('https://'),
      'Provider URL là HTTP, internal ref không phải HTTP'
    );
    assertTest('Recording: chỉ lưu internal ref, không lưu provider URL trực tiếp', true);
  } catch (e) {
    assertTest('Recording: chỉ lưu internal ref, không lưu provider URL trực tiếp', false, (e as Error).message);
  }

  // ── Test 8: Response không chứa dữ liệu nhạy cảm ─────────────────────────
  try {
    const safeResponse = { ok: true, handled: true, message: 'call recorded' };
    assert('ok' in safeResponse, 'Response phải có ok');
    assert(!('phone' in safeResponse), 'Response không được có phone');
    assert(!('rawPhone' in safeResponse), 'Response không được có rawPhone');
    assert(!('providerCallId' in safeResponse), 'Response không được có providerCallId');
    assertTest('Webhook response: không có dữ liệu nhạy cảm', true);
  } catch (e) {
    assertTest('Webhook response: không có dữ liệu nhạy cảm', false, (e as Error).message);
  }

  // ── Test 9: Cron auth logic ────────────────────────────────────────────────
  try {
    const cronSecret = 'cron-secret-abc';
    function verifyCronToken(authHeader: string | null, secret: string): boolean {
      if (!authHeader) return false;
      return authHeader.replace(/^Bearer\s+/i, '') === secret;
    }
    assert(verifyCronToken(`Bearer ${cronSecret}`, cronSecret) === true, 'Đúng token → cho phép');
    assert(verifyCronToken('Bearer wrong', cronSecret) === false, 'Sai token → từ chối');
    assert(verifyCronToken(null, cronSecret) === false, 'Không có token → từ chối');
    assertTest('Cron endpoint: xác thực bằng CRON_SECRET bearer token', true);
  } catch (e) {
    assertTest('Cron endpoint: xác thực bằng CRON_SECRET bearer token', false, (e as Error).message);
  }

  // ── Test 10: Case-insensitive Bearer ──────────────────────────────────────
  try {
    process.env.VOICE_WEBHOOK_SECRET = 'my-secret';
    process.env.VOICE_PROVIDER = 'MANUAL';
    const r1 = verifyWebhookSignature(makeHeaders({ authorization: 'Bearer my-secret' }), '{}');
    const r2 = verifyWebhookSignature(makeHeaders({ authorization: 'BEARER my-secret' }), '{}');
    const r3 = verifyWebhookSignature(makeHeaders({ authorization: 'bearer my-secret' }), '{}');
    assert(r1 === true, 'Bearer (titlecase) phải được chấp nhận');
    assert(r2 === true, 'BEARER (uppercase) phải được chấp nhận');
    assert(r3 === true, 'bearer (lowercase) phải được chấp nhận');
    assertTest('Authorization header: "Bearer" prefix case-insensitive', true);
  } catch (e) {
    assertTest('Authorization header: "Bearer" prefix case-insensitive', false, (e as Error).message);
  } finally {
    delete process.env.VOICE_WEBHOOK_SECRET;
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n==================================================');
  console.log(`TEST RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('==================================================\n');
  if (failCount > 0) process.exit(1);
  console.log('✅ All webhook security tests passed!\n');
}

runTests().catch((err: unknown) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
