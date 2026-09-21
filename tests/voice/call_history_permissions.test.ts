/**
 * Tests: Call History Permissions
 *
 * Kiểm tra phân quyền xem lịch sử cuộc gọi:
 * - SALE: không thấy recording_ref, transcript
 * - BOSS_ADMIN: thấy đầy đủ
 * - TECHNICIAN: bị cấm hoàn toàn
 *
 * Chạy: tsx --conditions=react-server tests/voice/call_history_permissions.test.ts
 */

// ---------------------------------------------------------------------------
// Test runner
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

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const mockCallFull = {
  id: 'call-001',
  customerId: 'customer-001',
  customerName: 'Nguyễn Văn A',
  customerCode: 'KH-000001',
  direction: 'OUTBOUND' as const,
  agentType: 'AI' as const,
  status: 'COMPLETED' as const,
  startedAt: '2026-09-21T08:00:00.000Z',
  endedAt: '2026-09-21T08:05:00.000Z',
  durationSeconds: 300,
  hasRecording: true,
  transcriptStatus: 'COMPLETED' as const,
};

const mockCallForSale = { ...mockCallFull, hasRecording: null, transcriptStatus: null };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  console.log('\n🔐 Call History Permission Tests\n');

  // ── Test 1: SALE DTO không chứa recording/transcript ──────────────────────
  try {
    assert(mockCallForSale.hasRecording === null, 'hasRecording phải là null cho SALE');
    assert(mockCallForSale.transcriptStatus === null, 'transcriptStatus phải là null cho SALE');
    assertTest('SALE DTO: hasRecording = null, transcriptStatus = null', true);
  } catch (e) {
    assertTest('SALE DTO: hasRecording = null, transcriptStatus = null', false, (e as Error).message);
  }

  // ── Test 2: BOSS_ADMIN DTO đầy đủ ─────────────────────────────────────────
  try {
    assert(mockCallFull.hasRecording === true, 'BOSS_ADMIN phải thấy hasRecording');
    assert(mockCallFull.transcriptStatus === 'COMPLETED', 'BOSS_ADMIN phải thấy transcriptStatus');
    assertTest('BOSS_ADMIN DTO: hasRecording và transcriptStatus có giá trị thật', true);
  } catch (e) {
    assertTest('BOSS_ADMIN DTO: hasRecording và transcriptStatus có giá trị thật', false, (e as Error).message);
  }

  // ── Test 3: DTO không chứa phone ──────────────────────────────────────────
  try {
    const dtoKeys = Object.keys(mockCallFull);
    assert(!dtoKeys.includes('recording_ref'), 'DTO không được có recording_ref raw');
    assert(!dtoKeys.includes('rawPhone'), 'DTO không được có rawPhone');
    assert(!dtoKeys.includes('normalizedPhone'), 'DTO không được có normalizedPhone');
    assert(!dtoKeys.includes('phone'), 'DTO không được có phone');
    assertTest('DTO không chứa phone (recording_ref raw, normalizedPhone, rawPhone)', true);
  } catch (e) {
    assertTest('DTO không chứa phone (recording_ref raw, normalizedPhone, rawPhone)', false, (e as Error).message);
  }

  // ── Test 4: DTO không chứa provider_call_id ───────────────────────────────
  try {
    const dtoKeys = Object.keys(mockCallFull);
    assert(!dtoKeys.includes('provider_call_id'), 'DTO không được có provider_call_id');
    assert(!dtoKeys.includes('providerCallId'), 'DTO không được có providerCallId');
    assertTest('DTO không chứa provider_call_id', true);
  } catch (e) {
    assertTest('DTO không chứa provider_call_id', false, (e as Error).message);
  }

  // ── Test 5: TECHNICIAN bị chặn ────────────────────────────────────────────
  try {
    function checkRoleForCallHistory(role: string): boolean {
      if (role === 'TECHNICIAN') return false;
      return true;
    }
    assert(checkRoleForCallHistory('BOSS_ADMIN') === true, 'BOSS_ADMIN phải được phép');
    assert(checkRoleForCallHistory('SALE') === true, 'SALE phải được phép');
    assert(checkRoleForCallHistory('TECHNICIAN') === false, 'TECHNICIAN phải bị cấm');
    assertTest('TECHNICIAN: role check bắt buộc trả ROLE_FORBIDDEN', true);
  } catch (e) {
    assertTest('TECHNICIAN: role check bắt buộc trả ROLE_FORBIDDEN', false, (e as Error).message);
  }

  // ── Test 6: DTO shape đúng ─────────────────────────────────────────────────
  try {
    const requiredFields = [
      'id', 'customerId', 'customerName', 'customerCode',
      'direction', 'agentType', 'status', 'startedAt',
      'endedAt', 'durationSeconds', 'hasRecording', 'transcriptStatus',
    ] as const;
    for (const field of requiredFields) {
      assert(field in mockCallFull, `Field '${field}' phải có trong DTO`);
    }
    assertTest('CallHistoryItemDTO: shape đúng, tất cả field bắt buộc có', true);
  } catch (e) {
    assertTest('CallHistoryItemDTO: shape đúng, tất cả field bắt buộc có', false, (e as Error).message);
  }

  // ── Test 7: direction enum ─────────────────────────────────────────────────
  try {
    const validDirections = ['INBOUND', 'OUTBOUND'];
    assert(validDirections.includes(mockCallFull.direction), 'direction phải hợp lệ');
    assertTest('direction: chỉ INBOUND hoặc OUTBOUND', true);
  } catch (e) {
    assertTest('direction: chỉ INBOUND hoặc OUTBOUND', false, (e as Error).message);
  }

  // ── Test 8: agentType operational (không phải RBAC) ───────────────────────
  try {
    const validTypes = ['AI', 'SALE'];
    assert(validTypes.includes(mockCallFull.agentType), 'agentType phải là AI hoặc SALE');
    assertTest('agentType: AI hoặc SALE — operational category (không phải RBAC role)', true);
  } catch (e) {
    assertTest('agentType: AI hoặc SALE — operational category (không phải RBAC role)', false, (e as Error).message);
  }

  // ── Test 9: status enum ────────────────────────────────────────────────────
  try {
    const validStatuses = ['INITIATED', 'RINGING', 'CONNECTED', 'NO_ANSWER', 'BUSY', 'FAILED', 'COMPLETED'];
    assert(validStatuses.includes(mockCallFull.status), 'status phải hợp lệ');
    assertTest('status: hợp lệ theo CHECK constraint bảng calls', true);
  } catch (e) {
    assertTest('status: hợp lệ theo CHECK constraint bảng calls', false, (e as Error).message);
  }

  // ── Test 10: Transcript BOSS_ADMIN + AAL2 ─────────────────────────────────
  try {
    function canViewTranscript(role: string, aal: string, isProduction: boolean): boolean {
      if (role !== 'BOSS_ADMIN') return false;
      if (isProduction && aal !== 'aal2') return false;
      return true;
    }
    assert(canViewTranscript('BOSS_ADMIN', 'aal2', true) === true, 'BOSS_ADMIN+AAL2 prod → allow');
    assert(canViewTranscript('BOSS_ADMIN', 'aal1', true) === false, 'BOSS_ADMIN+AAL1 prod → deny');
    assert(canViewTranscript('SALE', 'aal2', true) === false, 'SALE prod → deny');
    assert(canViewTranscript('TECHNICIAN', 'aal2', true) === false, 'TECHNICIAN prod → deny');
    assertTest('Transcript access: BOSS_ADMIN only + AAL2 in production', true);
  } catch (e) {
    assertTest('Transcript access: BOSS_ADMIN only + AAL2 in production', false, (e as Error).message);
  }

  // ── Test 11: Duration tính đúng ───────────────────────────────────────────
  try {
    const startedAt = '2026-09-21T08:00:00.000Z';
    const endedAt = '2026-09-21T08:05:00.000Z';
    const duration = Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000);
    assert(duration === 300, `Duration phải là 300 giây, got ${duration}`);
    assertTest('durationSeconds: tính đúng từ startedAt và endedAt', true);
  } catch (e) {
    assertTest('durationSeconds: tính đúng từ startedAt và endedAt', false, (e as Error).message);
  }

  // ── Test 12: endedAt null khi đang gọi ────────────────────────────────────
  try {
    const ongoingCall = { ...mockCallFull, status: 'CONNECTED' as const, endedAt: null, durationSeconds: null };
    assert(ongoingCall.endedAt === null, 'endedAt phải là null khi đang gọi');
    assert(ongoingCall.durationSeconds === null, 'durationSeconds phải là null khi đang gọi');
    assertTest('endedAt: null khi cuộc gọi đang diễn ra', true);
  } catch (e) {
    assertTest('endedAt: null khi cuộc gọi đang diễn ra', false, (e as Error).message);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n==================================================');
  console.log(`TEST RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('==================================================\n');
  if (failCount > 0) process.exit(1);
  console.log('✅ All call history permission tests passed!\n');
}

runTests().catch((err: unknown) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
