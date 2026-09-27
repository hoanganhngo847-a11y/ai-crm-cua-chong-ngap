import {
  RESPONSE_SLA_LIMIT_SECONDS,
  type ResponseSlaConversationStatus,
  type ResponseSlaWindowSnapshot,
  type ResponseSlaWindowState,
} from '../../shared/contracts/response-sla';
import {
  calculateResponseSlaDeadline,
  evaluateResponseSla,
} from '../../features/automation/response-sla/services/evaluate-response-sla';

async function runTests() {
  let passCount = 0;
  let failCount = 0;

  function assert(
    condition: boolean,
    testName: string,
    classification: 'UNIT' | 'EDGE_CASE' | 'INVARIANT' = 'UNIT',
    detail?: string
  ) {
    const label = `[${classification}] ${testName}`;
    if (condition) {
      console.log(`[PASS] ${label}`);
      passCount++;
    } else {
      console.error(`[FAIL] ${label} ${detail ? `(${detail})` : ''}`);
      failCount++;
    }
  }

  console.log('==================================================');
  console.log('RUNNING RESPONSE SLA 5-MINUTE DOMAIN EVALUATION TESTS');
  console.log('==================================================');

  // Helper factory for test snapshots
  function makeSnapshot(overrides: Partial<ResponseSlaWindowSnapshot> = {}): ResponseSlaWindowSnapshot {
    const startedAt = overrides.startedAt || '2026-09-22T07:00:00.000Z';
    return {
      conversationId: 'conv-11111111-1111-1111-1111-111111111111',
      customerId: 'cust-22222222-2222-2222-2222-222222222222',
      triggerInteractionId: 'msg-33333333-3333-3333-3333-333333333333',
      startedAt,
      deadlineAt: overrides.deadlineAt || calculateResponseSlaDeadline(startedAt),
      state: overrides.state || 'OPEN',
      resolvedAt: overrides.resolvedAt ?? null,
      saleResponseInteractionId: overrides.saleResponseInteractionId ?? null,
      aiResponseInteractionId: overrides.aiResponseInteractionId ?? null,
    };
  }

  // ----------------------------------------------------
  // Test 1: Deadline calculation (Start 07:00:00.000Z -> Deadline 07:05:00.000Z)
  // ----------------------------------------------------
  {
    const start = '2026-09-22T07:00:00.000Z';
    const expectedDeadline = '2026-09-22T07:05:00.000Z';
    const actualDeadline = calculateResponseSlaDeadline(start);
    assert(
      actualDeadline === expectedDeadline,
      'Test 1: Start 07:00:00.000Z calculates deadline to exactly 07:05:00.000Z (+300s)',
      'UNIT',
      `Expected ${expectedDeadline}, got ${actualDeadline}`
    );
    assert(
      RESPONSE_SLA_LIMIT_SECONDS === 300,
      'Test 1b: RESPONSE_SLA_LIMIT_SECONDS is exactly 300 seconds (5 minutes)',
      'UNIT'
    );
  }

  // ----------------------------------------------------
  // Test 2: 4 minutes 59 seconds elapsed -> NOT_DUE
  // ----------------------------------------------------
  {
    const window = makeSnapshot({
      startedAt: '2026-09-22T07:00:00.000Z',
      deadlineAt: '2026-09-22T07:05:00.000Z',
      state: 'OPEN',
    });
    const now = '2026-09-22T07:04:59.000Z'; // 4m 59s
    const evalResult = evaluateResponseSla(window, 'OPEN', now);
    assert(
      evalResult.decision === 'NOT_DUE' &&
        evalResult.elapsedSeconds === 299 &&
        evalResult.deadlineAt === '2026-09-22T07:05:00.000Z',
      'Test 2: At 4m59s elapsed, evaluation returns NOT_DUE with elapsedSeconds=299',
      'UNIT',
      `Got decision: ${evalResult.decision}, elapsed: ${evalResult.elapsedSeconds}`
    );
  }

  // ----------------------------------------------------
  // Test 3: Exactly at 5th minute (300 seconds) -> ALLOW_AI_REPLY
  // ----------------------------------------------------
  {
    const window = makeSnapshot({
      startedAt: '2026-09-22T07:00:00.000Z',
      deadlineAt: '2026-09-22T07:05:00.000Z',
      state: 'OPEN',
    });
    const now = '2026-09-22T07:05:00.000Z'; // exactly 5m 00s
    const evalResult = evaluateResponseSla(window, 'OPEN', now);
    assert(
      evalResult.decision === 'ALLOW_AI_REPLY' &&
        evalResult.elapsedSeconds === 300 &&
        evalResult.deadlineAt === '2026-09-22T07:05:00.000Z',
      'Test 3: Exactly at 5m00s deadline, evaluation returns ALLOW_AI_REPLY with elapsedSeconds=300',
      'UNIT',
      `Got decision: ${evalResult.decision}, elapsed: ${evalResult.elapsedSeconds}`
    );
  }

  // Test 3b: Past deadline (5m 01s and 10m) -> ALLOW_AI_REPLY
  {
    const window = makeSnapshot({
      startedAt: '2026-09-22T07:00:00.000Z',
      deadlineAt: '2026-09-22T07:05:00.000Z',
      state: 'OPEN',
    });
    const now1 = '2026-09-22T07:05:01.000Z'; // 5m 01s
    const evalResult1 = evaluateResponseSla(window, 'OPEN', now1);
    assert(
      evalResult1.decision === 'ALLOW_AI_REPLY' && evalResult1.elapsedSeconds === 301,
      'Test 3b: At 5m01s (past deadline), evaluation returns ALLOW_AI_REPLY with elapsedSeconds=301',
      'UNIT'
    );

    const now2 = '2026-09-22T07:10:00.000Z'; // 10m
    const evalResult2 = evaluateResponseSla(window, 'PENDING_SALE', now2);
    assert(
      evalResult2.decision === 'ALLOW_AI_REPLY' && evalResult2.elapsedSeconds === 600,
      'Test 3c: At 10m with conversation PENDING_SALE, evaluation returns ALLOW_AI_REPLY with elapsedSeconds=600',
      'UNIT'
    );
  }

  // ----------------------------------------------------
  // Test 4: Sale already responded -> SALE_ALREADY_RESPONDED
  // ----------------------------------------------------
  {
    const window = makeSnapshot({
      startedAt: '2026-09-22T07:00:00.000Z',
      deadlineAt: '2026-09-22T07:05:00.000Z',
      state: 'SALE_RESPONDED',
      resolvedAt: '2026-09-22T07:03:00.000Z',
      saleResponseInteractionId: 'msg-sale-44444444',
    });
    // Even after 5 minutes, if sale responded, AI must NEVER reply
    const now = '2026-09-22T07:06:00.000Z';
    const evalResult = evaluateResponseSla(window, 'OPEN', now);
    assert(
      evalResult.decision === 'SALE_ALREADY_RESPONDED' && evalResult.elapsedSeconds === 360,
      'Test 4: When window state is SALE_RESPONDED, evaluation returns SALE_ALREADY_RESPONDED',
      'UNIT',
      `Got decision: ${evalResult.decision}`
    );
  }

  // ----------------------------------------------------
  // Test 5: Conversation CLOSED -> CONVERSATION_CLOSED
  // ----------------------------------------------------
  {
    const window = makeSnapshot({
      startedAt: '2026-09-22T07:00:00.000Z',
      deadlineAt: '2026-09-22T07:05:00.000Z',
      state: 'OPEN',
    });
    // Past deadline, but conversation is closed
    const now = '2026-09-22T07:06:00.000Z';
    const evalResult = evaluateResponseSla(window, 'CLOSED', now);
    assert(
      evalResult.decision === 'CONVERSATION_CLOSED',
      'Test 5: When conversationStatus is CLOSED, evaluation returns CONVERSATION_CLOSED',
      'UNIT',
      `Got decision: ${evalResult.decision}`
    );
  }

  // ----------------------------------------------------
  // Test 6: Conversation AI_HANDLING -> AI_ALREADY_HANDLING
  // ----------------------------------------------------
  {
    const window = makeSnapshot({
      startedAt: '2026-09-22T07:00:00.000Z',
      deadlineAt: '2026-09-22T07:05:00.000Z',
      state: 'OPEN',
    });
    const now = '2026-09-22T07:06:00.000Z';
    const evalResult = evaluateResponseSla(window, 'AI_HANDLING', now);
    assert(
      evalResult.decision === 'AI_ALREADY_HANDLING',
      'Test 6: When conversationStatus is AI_HANDLING, evaluation returns AI_ALREADY_HANDLING',
      'UNIT',
      `Got decision: ${evalResult.decision}`
    );
  }

  // ----------------------------------------------------
  // Edge Case: Invalid startedAt fails closed (throws Error)
  // ----------------------------------------------------
  {
    let deadlineThrew = false;
    try {
      calculateResponseSlaDeadline('invalid-date-string');
    } catch {
      deadlineThrew = true;
    }
    assert(
      deadlineThrew,
      'Edge Case 1a: calculateResponseSlaDeadline throws on invalid startedAt string (fail closed)',
      'EDGE_CASE'
    );

    let evalThrew = false;
    try {
      const window = makeSnapshot({ startedAt: 'not-a-timestamp' });
      evaluateResponseSla(window, 'OPEN', '2026-09-22T07:05:00.000Z');
    } catch {
      evalThrew = true;
    }
    assert(
      evalThrew,
      'Edge Case 1b: evaluateResponseSla throws on invalid startedAt in snapshot (fail closed)',
      'EDGE_CASE'
    );
  }

  // ----------------------------------------------------
  // Edge Case: Invalid deadlineAt fails closed (throws Error)
  // ----------------------------------------------------
  {
    let evalThrew = false;
    try {
      const window = makeSnapshot({ deadlineAt: 'not-a-deadline' });
      evaluateResponseSla(window, 'OPEN', '2026-09-22T07:05:00.000Z');
    } catch {
      evalThrew = true;
    }
    assert(
      evalThrew,
      'Edge Case 2: evaluateResponseSla throws on invalid deadlineAt (fail closed)',
      'EDGE_CASE'
    );
  }

  // ----------------------------------------------------
  // Edge Case: deadlineAt earlier than startedAt fails closed (throws Error)
  // ----------------------------------------------------
  {
    let evalThrew = false;
    try {
      const window = makeSnapshot({
        startedAt: '2026-09-22T07:05:00.000Z',
        deadlineAt: '2026-09-22T07:00:00.000Z',
      });
      evaluateResponseSla(window, 'OPEN', '2026-09-22T07:05:00.000Z');
    } catch {
      evalThrew = true;
    }
    assert(
      evalThrew,
      'Edge Case 3: evaluateResponseSla throws if deadlineAt is earlier than startedAt',
      'EDGE_CASE'
    );
  }

  // ----------------------------------------------------
  // Edge Case: now timestamp is earlier than startedAt (elapsedSeconds non-negative, NOT_DUE)
  // ----------------------------------------------------
  {
    const window = makeSnapshot({
      startedAt: '2026-09-22T07:00:00.000Z',
      deadlineAt: '2026-09-22T07:05:00.000Z',
      state: 'OPEN',
    });
    // now is 1 minute before startedAt (e.g. clock skew)
    const now = '2026-09-22T06:59:00.000Z';
    const evalResult = evaluateResponseSla(window, 'OPEN', now);
    assert(
      evalResult.elapsedSeconds === 0 && evalResult.decision === 'NOT_DUE',
      'Edge Case 4: When now is earlier than startedAt, elapsedSeconds is 0 (non-negative) and decision is NOT_DUE',
      'EDGE_CASE',
      `elapsedSeconds: ${evalResult.elapsedSeconds}, decision: ${evalResult.decision}`
    );
  }

  // ----------------------------------------------------
  // Edge Case: Window already resolved (AI_RESPONDED or CANCELLED)
  // ----------------------------------------------------
  {
    const aiRespondedWindow = makeSnapshot({
      startedAt: '2026-09-22T07:00:00.000Z',
      deadlineAt: '2026-09-22T07:05:00.000Z',
      state: 'AI_RESPONDED',
      resolvedAt: '2026-09-22T07:05:05.000Z',
      aiResponseInteractionId: 'msg-ai-55555555',
    });
    const evalAi = evaluateResponseSla(aiRespondedWindow, 'OPEN', '2026-09-22T07:06:00.000Z');
    assert(
      evalAi.decision === 'WINDOW_ALREADY_RESOLVED',
      'Edge Case 5a: Window state AI_RESPONDED returns WINDOW_ALREADY_RESOLVED',
      'EDGE_CASE'
    );

    const cancelledWindow = makeSnapshot({
      startedAt: '2026-09-22T07:00:00.000Z',
      deadlineAt: '2026-09-22T07:05:00.000Z',
      state: 'CANCELLED',
      resolvedAt: '2026-09-22T07:02:00.000Z',
    });
    const evalCancelled = evaluateResponseSla(cancelledWindow, 'OPEN', '2026-09-22T07:06:00.000Z');
    assert(
      evalCancelled.decision === 'WINDOW_ALREADY_RESOLVED',
      'Edge Case 5b: Window state CANCELLED returns WINDOW_ALREADY_RESOLVED',
      'EDGE_CASE'
    );
  }

  // ----------------------------------------------------
  // Edge Case: Invalid now timestamp fails closed
  // ----------------------------------------------------
  {
    let evalThrew = false;
    try {
      const window = makeSnapshot();
      evaluateResponseSla(window, 'OPEN', 'bogus-now-date');
    } catch {
      evalThrew = true;
    }
    assert(
      evalThrew,
      'Edge Case 6: evaluateResponseSla throws if now is invalid string (fail closed)',
      'EDGE_CASE'
    );
  }

  // ----------------------------------------------------
  // Edge Case: Invalid window state or conversation status throws
  // ----------------------------------------------------
  {
    let stateThrew = false;
    try {
      const window = makeSnapshot({ state: 'UNKNOWN_STATE' as ResponseSlaWindowState });
      evaluateResponseSla(window, 'OPEN', '2026-09-22T07:05:00.000Z');
    } catch {
      stateThrew = true;
    }
    assert(
      stateThrew,
      'Edge Case 7a: Unknown window state throws (fail closed)',
      'EDGE_CASE'
    );

    let statusThrew = false;
    try {
      const window = makeSnapshot();
      evaluateResponseSla(window, 'UNKNOWN_STATUS' as ResponseSlaConversationStatus, '2026-09-22T07:05:00.000Z');
    } catch {
      statusThrew = true;
    }
    assert(
      statusThrew,
      'Edge Case 7b: Unknown conversationStatus throws (fail closed)',
      'EDGE_CASE'
    );
  }

  // ----------------------------------------------------
  // Invariant: Multiple consecutive Customer messages do NOT reset SLA window
  // ----------------------------------------------------
  {
    // Simulation:
    // 14:00 Customer message 1 -> Window opens with startedAt=14:00, deadlineAt=14:05
    // 14:01 Customer message 2 -> Must preserve initial window (startedAt=14:00, deadlineAt=14:05)
    // 14:02 Customer message 3 -> Must preserve initial window (startedAt=14:00, deadlineAt=14:05)
    const initialWindow = makeSnapshot({
      startedAt: '2026-09-22T14:00:00.000Z',
      deadlineAt: calculateResponseSlaDeadline('2026-09-22T14:00:00.000Z'),
      state: 'OPEN',
    });

    assert(
      initialWindow.deadlineAt === '2026-09-22T14:05:00.000Z',
      'Invariant 1a: Initial customer message opens window with deadline at 14:05:00.000Z',
      'INVARIANT'
    );

    // At 14:04:30 (after messages 2 and 3 arrived), evaluating the preserved window:
    const evalAt140430 = evaluateResponseSla(initialWindow, 'OPEN', '2026-09-22T14:04:30.000Z');
    assert(
      evalAt140430.decision === 'NOT_DUE' && evalAt140430.elapsedSeconds === 270,
      'Invariant 1b: At 14:04:30 (270s from 14:00), window is NOT_DUE (no reset from subsequent messages)',
      'INVARIANT'
    );

    // At 14:05:00, the original window reaches deadline -> ALLOW_AI_REPLY
    const evalAt140500 = evaluateResponseSla(initialWindow, 'OPEN', '2026-09-22T14:05:00.000Z');
    assert(
      evalAt140500.decision === 'ALLOW_AI_REPLY' && evalAt140500.elapsedSeconds === 300,
      'Invariant 1c: At 14:05:00, original window deadline fires ALLOW_AI_REPLY despite 14:01 & 14:02 messages',
      'INVARIANT'
    );
  }

  // ----------------------------------------------------
  // Invariant: Acceptance of Date instance for `now`
  // ----------------------------------------------------
  {
    const window = makeSnapshot({
      startedAt: '2026-09-22T07:00:00.000Z',
      deadlineAt: '2026-09-22T07:05:00.000Z',
      state: 'OPEN',
    });
    const nowDate = new Date('2026-09-22T07:05:00.000Z');
    const evalResult = evaluateResponseSla(window, 'OPEN', nowDate);
    assert(
      evalResult.decision === 'ALLOW_AI_REPLY' && evalResult.elapsedSeconds === 300,
      'Invariant 2: evaluateResponseSla accepts Date instances for now parameter',
      'INVARIANT'
    );
  }

  console.log('==================================================');
  console.log(`RESPONSE SLA TESTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('==================================================');

  if (failCount > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error in evaluate-response-sla.test.ts:', err);
  process.exit(1);
});
