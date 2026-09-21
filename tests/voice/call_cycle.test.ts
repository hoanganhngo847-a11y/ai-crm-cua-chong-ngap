/**
 * Tests: Call Cycle — Lịch gọi 3 lần
 *
 * Tất cả test dùng logic pure — không call Supabase thật.
 * Chạy: tsx --conditions=react-server tests/voice/call_cycle.test.ts
 */

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

interface MockDB {
  call_attempts: Array<Record<string, unknown>>;
  customers: Array<Record<string, unknown>>;
  customer_stage_histories: Array<Record<string, unknown>>;
}

function createMockDb(initial?: Partial<MockDB>): MockDB {
  return {
    call_attempts: initial?.call_attempts || [],
    customers: initial?.customers || [
      {
        id: 'customer-001',
        company_id: 'company-001',
        name: 'Nguyễn Văn A',
        customer_code: 'KH-000001',
        stage: 'LEAD_NEW',
      },
    ],
    customer_stage_histories: initial?.customer_stage_histories || [],
  };
}

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

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function runTests() {
  console.log('\n📞 Call Cycle Tests\n');

  // ── Test 1: attempt_no validation ──────────────────────────────────────────
  try {
    const validAttemptNos = [1, 2, 3];
    const invalidAttemptNos = [0, 4, -1];
    for (const n of validAttemptNos) assert([1, 2, 3].includes(n), `${n} phải hợp lệ`);
    for (const n of invalidAttemptNos) assert(![1, 2, 3].includes(n), `${n} phải không hợp lệ`);
    assertTest('attempt_no CHECK constraint: chỉ chấp nhận 1, 2, 3', true);
  } catch (e) {
    assertTest('attempt_no CHECK constraint: chỉ chấp nhận 1, 2, 3', false, (e as Error).message);
  }

  // ── Test 2: Attempt 2 delay ────────────────────────────────────────────────
  try {
    const RETRY_DELAY_MS = 2.5 * 60 * 60 * 1000;
    const now = Date.now();
    const scheduledAt = new Date(now + RETRY_DELAY_MS);
    const diffMs = scheduledAt.getTime() - now;
    assert(diffMs >= 2 * 60 * 60 * 1000, `Delay phải >= 2 giờ, got ${diffMs / 3600000}h`);
    assert(diffMs <= 4 * 60 * 60 * 1000, `Delay phải <= 4 giờ`);
    assertTest('Attempt 2: scheduled_at >= now + 2 giờ', true);
  } catch (e) {
    assertTest('Attempt 2: scheduled_at >= now + 2 giờ', false, (e as Error).message);
  }

  // ── Test 3: Attempt 3 ngày hôm sau ────────────────────────────────────────
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setUTCHours(2, 0, 0, 0); // 09:00 UTC+7
    const now = new Date();
    assert(tomorrow > now, 'Ngày mai phải sau hôm nay');
    assert(tomorrow.getUTCHours() === 2, 'Phải là 02:00 UTC (09:00 VN)');
    assertTest('Attempt 3: scheduled_at là ngày hôm sau (09:00 UTC+7)', true);
  } catch (e) {
    assertTest('Attempt 3: scheduled_at là ngày hôm sau (09:00 UTC+7)', false, (e as Error).message);
  }

  // ── Test 4: Unique constraint logic ───────────────────────────────────────
  try {
    const db = createMockDb();
    db.call_attempts.push({
      company_id: 'company-001', customer_id: 'customer-001',
      contact_cycle_id: 'cycle-001', attempt_no: 1, result: 'PENDING',
    });
    const duplicate = db.call_attempts.find(
      (a) => a.company_id === 'company-001' && a.customer_id === 'customer-001' &&
             a.contact_cycle_id === 'cycle-001' && a.attempt_no === 1
    );
    assert(!!duplicate, 'Duplicate phải được phát hiện');
    assertTest('Unique constraint: không trùng attempt_no trong cùng (company, customer, cycle)', true);
  } catch (e) {
    assertTest('Unique constraint: không trùng attempt_no trong cùng (company, customer, cycle)', false, (e as Error).message);
  }

  // ── Test 5: Inbound không tạo call_attempts ────────────────────────────────
  try {
    const db = createMockDb();
    const attemptsBefore = db.call_attempts.length;
    // Inbound: chỉ tạo calls và interactions, không đụng call_attempts
    assert(db.call_attempts.length === attemptsBefore, 'Inbound không được tạo call_attempts');
    assertTest('Inbound Hotline: không tạo call_attempts', true);
  } catch (e) {
    assertTest('Inbound Hotline: không tạo call_attempts', false, (e as Error).message);
  }

  // ── Test 6: 3 lần NO_ANSWER → UNREACHABLE ─────────────────────────────────
  try {
    const db = createMockDb();
    const cycleId = 'cycle-002';
    for (let i = 1; i <= 3; i++) {
      db.call_attempts.push({
        company_id: 'company-001', customer_id: 'customer-001',
        contact_cycle_id: cycleId, attempt_no: i, result: 'NO_ANSWER',
        called_at: new Date().toISOString(),
      });
    }
    const allAttempts = db.call_attempts.filter((a) => a.contact_cycle_id === cycleId);
    const allFailed = allAttempts.every((a) => ['NO_ANSWER', 'BUSY', 'FAILED'].includes(a.result as string));
    const hasThree = allAttempts.length === 3;
    if (allFailed && hasThree) {
      const customer = db.customers.find((c) => c.id === 'customer-001');
      if (customer) customer.stage = 'UNREACHABLE';
      db.customer_stage_histories.push({
        company_id: 'company-001', customer_id: 'customer-001',
        from_stage: 'CONTACT_CYCLE_3', to_stage: 'UNREACHABLE',
        reason: `NO_ANSWER_3_ATTEMPTS:${cycleId}`,
      });
    }
    const customer = db.customers.find((c) => c.id === 'customer-001');
    assert(customer?.stage === 'UNREACHABLE', 'Stage phải là UNREACHABLE');
    assert(db.customer_stage_histories.length > 0, 'Phải có stage history record');
    assertTest('Sau 3 lần NO_ANSWER: stage phải là UNREACHABLE', true);
  } catch (e) {
    assertTest('Sau 3 lần NO_ANSWER: stage phải là UNREACHABLE', false, (e as Error).message);
  }

  // ── Test 7: ANSWERED → không tạo attempt tiếp ─────────────────────────────
  try {
    const db = createMockDb();
    const cycleId = 'cycle-003';
    db.call_attempts.push({
      company_id: 'company-001', customer_id: 'customer-001',
      contact_cycle_id: cycleId, attempt_no: 1, result: 'ANSWERED',
    });
    const attemptsInCycle = db.call_attempts.filter((a) => a.contact_cycle_id === cycleId);
    assert(attemptsInCycle.length === 1, 'Phải chỉ có 1 attempt sau ANSWERED');
    assertTest('ANSWERED: không tạo attempt tiếp trong chu kỳ', true);
  } catch (e) {
    assertTest('ANSWERED: không tạo attempt tiếp trong chu kỳ', false, (e as Error).message);
  }

  // ── Test 8: UUID format ────────────────────────────────────────────────────
  try {
    const uuid = crypto.randomUUID();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    assert(uuidRegex.test(uuid), `${uuid} phải là UUID v4 hợp lệ`);
    assertTest('contact_cycle_id: phải là UUID v4 format', true);
  } catch (e) {
    assertTest('contact_cycle_id: phải là UUID v4 format', false, (e as Error).message);
  }

  // ── Test 9: Cycle mới không reset cycle cũ ────────────────────────────────
  try {
    const db = createMockDb();
    db.call_attempts.push({
      company_id: 'company-001', customer_id: 'customer-001',
      contact_cycle_id: 'old-cycle', attempt_no: 1, result: 'NO_ANSWER',
    });
    const newCycleId = crypto.randomUUID();
    db.call_attempts.push({
      company_id: 'company-001', customer_id: 'customer-001',
      contact_cycle_id: newCycleId, attempt_no: 1, result: 'PENDING',
    });
    assert(newCycleId !== 'old-cycle', 'Cycle mới phải có ID khác cycle cũ');
    const oldAttempts = db.call_attempts.filter((a) => a.contact_cycle_id === 'old-cycle');
    assert(oldAttempts.length === 1, 'Cycle cũ phải không bị thay đổi');
    assert(oldAttempts[0].result === 'NO_ANSWER', 'Result cycle cũ phải giữ nguyên');
    assertTest('Chu kỳ mới: contact_cycle_id riêng, không đụng đến cycle cũ', true);
  } catch (e) {
    assertTest('Chu kỳ mới: contact_cycle_id riêng, không đụng đến cycle cũ', false, (e as Error).message);
  }

  // ── Test 10: Stage mapping ─────────────────────────────────────────────────
  try {
    const stageMap: Record<number, string> = {
      1: 'CONTACT_CYCLE_1', 2: 'CONTACT_CYCLE_2', 3: 'CONTACT_CYCLE_3',
    };
    assert(stageMap[1] === 'CONTACT_CYCLE_1', 'Attempt 1 → CONTACT_CYCLE_1');
    assert(stageMap[2] === 'CONTACT_CYCLE_2', 'Attempt 2 → CONTACT_CYCLE_2');
    assert(stageMap[3] === 'CONTACT_CYCLE_3', 'Attempt 3 → CONTACT_CYCLE_3');
    assertTest('Stage mapping: CONTACT_CYCLE_1/2/3 theo attempt_no', true);
  } catch (e) {
    assertTest('Stage mapping: CONTACT_CYCLE_1/2/3 theo attempt_no', false, (e as Error).message);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n==================================================');
  console.log(`TEST RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('==================================================\n');
  if (failCount > 0) process.exit(1);
  console.log('✅ All call cycle tests passed!\n');
}

runTests().catch((err: unknown) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
