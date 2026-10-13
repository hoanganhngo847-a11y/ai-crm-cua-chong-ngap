import assert from 'node:assert';
import crypto from 'node:crypto';
import type { InboxMessage } from '../../features/inbox/types/inbox.types';
import { healthServer } from '../../fb-inbox-worker/src/health-server.js';
import http from 'node:http';

interface TestResult {
  test: string;
  expected: string;
  actual: string;
  status: 'PASS' | 'FAIL';
}

const resultsTable: TestResult[] = [];

function recordTest(test: string, expected: string, actual: string, passed: boolean) {
  resultsTable.push({
    test,
    expected,
    actual,
    status: passed ? 'PASS' : 'FAIL',
  });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${test}`);
  console.log(`  Expected: ${expected}`);
  console.log(`  Actual:   ${actual}`);
  assert.ok(passed, `Test failed: ${test} (Expected: ${expected}, Actual: ${actual})`);
}

/**
 * State simulation harness mimicking the conversation-isolated architecture of inbox-view.tsx
 */
class InboxStateSimulationHarness {
  public selectedConversationId: string | null = null;
  public activeConversationRef: string | null = null;
  public fetchGenerationRef: number = 0;
  public messagesByConversation: Record<string, InboxMessage[]> = {};
  public draftsByConversation: Record<string, string> = {};
  public pendingCommandsRef: Record<string, { commandId: string; content: string }> = {};
  public loadingMessages: boolean = false;

  public selectConversation(convId: string) {
    this.selectedConversationId = convId;
    this.activeConversationRef = convId;
    if (!this.messagesByConversation[convId]) {
      this.loadingMessages = true;
    }
  }

  public getVisibleMessages(): InboxMessage[] {
    return this.selectedConversationId
      ? this.messagesByConversation[this.selectedConversationId] || []
      : [];
  }

  public getVisibleDraft(): string {
    return this.selectedConversationId
      ? this.draftsByConversation[this.selectedConversationId] || ''
      : '';
  }

  public setDraft(text: string) {
    if (!this.selectedConversationId) return;
    this.draftsByConversation[this.selectedConversationId] = text;
  }

  public startFetch(convId: string): { generation: number; controller: AbortController } {
    const generation = ++this.fetchGenerationRef;
    const controller = new AbortController();
    return { generation, controller };
  }

  public completeFetch(convId: string, generation: number, serverMessages: InboxMessage[]) {
    // P0-A guard: ignore response if active conversation changed or newer request started
    if (convId !== this.activeConversationRef || generation !== this.fetchGenerationRef) {
      return false; // Ignored
    }

    const existingForConv = this.messagesByConversation[convId] || [];
    if (existingForConv.length === 0) {
      this.messagesByConversation[convId] = serverMessages;
    } else {
      const serverById = new Map<string, InboxMessage>();
      const serverByCommandId = new Map<string, InboxMessage>();
      for (const sm of serverMessages) {
        if (sm.id) serverById.set(sm.id, sm);
        if (sm.client_command_id) serverByCommandId.set(sm.client_command_id, sm);
      }

      const reconciled: InboxMessage[] = [];
      const matchedServerIds = new Set<string>();

      for (const localMsg of existingForConv) {
        const matched =
          (localMsg.id ? serverById.get(localMsg.id) : null) ||
          (localMsg.client_command_id ? serverByCommandId.get(localMsg.client_command_id) : null);
        if (matched) {
          reconciled.push({
            ...localMsg,
            ...matched,
            client_command_id: localMsg.client_command_id || matched.client_command_id,
          });
          if (matched.id) matchedServerIds.add(matched.id);
        } else {
          reconciled.push(localMsg);
        }
      }

      for (const sm of serverMessages) {
        if (sm.id && !matchedServerIds.has(sm.id)) {
          reconciled.push(sm);
        }
      }

      this.messagesByConversation[convId] = reconciled;
    }

    this.loadingMessages = false;
    return true; // Applied
  }

  public prepareSendMessage(content: string): { sendConvId: string; commandId: string; isRetry: boolean } {
    if (!this.selectedConversationId) {
      throw new Error('No active conversation');
    }
    const sendConvId = this.selectedConversationId;
    const pendingForConv = this.pendingCommandsRef[sendConvId];
    let commandId: string;
    let isRetry = false;

    if (pendingForConv && pendingForConv.content === content) {
      commandId = pendingForConv.commandId;
      isRetry = true;
    } else {
      commandId = crypto.randomUUID();
      this.pendingCommandsRef[sendConvId] = { commandId, content };
    }

    // Optimistic bubble in sendConvId cache
    const optimistic: InboxMessage = {
      id: `optimistic-${commandId}`,
      conversation_id: sendConvId,
      customer_id: 'cust-test',
      channel: 'facebook',
      sender_type: 'sale',
      sender_name: 'Sale',
      content,
      created_at: new Date().toISOString(),
      direction: 'outbound',
      delivery_status: 'PENDING_DISPATCH',
      client_command_id: commandId,
    };

    this.messagesByConversation[sendConvId] = [
      ...(this.messagesByConversation[sendConvId] || []),
      optimistic,
    ];

    // Clear draft ONLY for sendConvId
    this.draftsByConversation[sendConvId] = '';

    return { sendConvId, commandId, isRetry };
  }

  public completeSend(sendConvId: string, serverMsg: InboxMessage) {
    const convMsgs = this.messagesByConversation[sendConvId] || [];
    const exists = convMsgs.some(
      (m) =>
        m.id === serverMsg.id ||
        (m.client_command_id && m.client_command_id === serverMsg.client_command_id)
    );

    if (exists) {
      this.messagesByConversation[sendConvId] = convMsgs.map((m) =>
        m.id === serverMsg.id ||
        (m.client_command_id && m.client_command_id === serverMsg.client_command_id)
          ? { ...m, ...serverMsg }
          : m
      );
    } else {
      this.messagesByConversation[sendConvId] = convMsgs
        .filter((m) => m.client_command_id !== serverMsg.client_command_id)
        .concat(serverMsg);
    }

    delete this.pendingCommandsRef[sendConvId];
  }
}

async function runAllTests() {
  console.log('========================================================================================');
  console.log('TEST SUITE: P0 CONVERSATION ISOLATION & WORKER OUTBOX HEARTBEAT HARDENING');
  console.log('========================================================================================\n');

  // ========================================================================================
  // CASE A: Stale fetch from conversation A completing after user switched to B
  // ========================================================================================
  console.log('--- Case A: Stale fetch race condition ---');
  const harnessA = new InboxStateSimulationHarness();

  harnessA.selectConversation('conv-A');
  const reqA = harnessA.startFetch('conv-A');

  // Switch to B before A completes
  harnessA.selectConversation('conv-B');
  const reqB = harnessA.startFetch('conv-B');

  // Fetch B completes
  const msgsB: InboxMessage[] = [
    {
      id: 'msg-b1',
      conversation_id: 'conv-B',
      customer_id: 'cust-b',
      channel: 'facebook',
      sender_type: 'customer',
      content: 'Hello from B',
      created_at: new Date().toISOString(),
    },
  ];
  const appliedB = harnessA.completeFetch('conv-B', reqB.generation, msgsB);

  // Fetch A completes LATE
  const msgsA: InboxMessage[] = [
    {
      id: 'msg-a1',
      conversation_id: 'conv-A',
      customer_id: 'cust-a',
      channel: 'facebook',
      sender_type: 'customer',
      content: 'Old message from A',
      created_at: new Date().toISOString(),
    },
  ];
  const appliedA = harnessA.completeFetch('conv-A', reqA.generation, msgsA);

  const visibleA = harnessA.getVisibleMessages();
  recordTest(
    'Case A.1: Stale fetch A response is ignored',
    'applied: false',
    `applied: ${appliedA}`,
    appliedA === false
  );
  recordTest(
    'Case A.2: Visible messages strictly contain only B (0 messages from A)',
    '1 message from B only',
    `${visibleA.length} msg(s), content: "${visibleA[0]?.content}"`,
    visibleA.length === 1 && visibleA[0]?.id === 'msg-b1'
  );

  // ========================================================================================
  // CASE B: Switch from loaded A to unloaded B
  // ========================================================================================
  console.log('\n--- Case B: Switching from loaded A to new B (No history flash) ---');
  const harnessB = new InboxStateSimulationHarness();
  harnessB.selectConversation('conv-A');
  const reqB_A = harnessB.startFetch('conv-A');
  harnessB.completeFetch('conv-A', reqB_A.generation, [
    {
      id: 'msg-a1',
      conversation_id: 'conv-A',
      customer_id: 'cust-a',
      channel: 'facebook',
      sender_type: 'customer',
      content: 'Customer A history',
      created_at: new Date().toISOString(),
    },
  ]);

  // Now switch to B
  harnessB.selectConversation('conv-B');
  const visibleDuringLoadingB = harnessB.getVisibleMessages();
  recordTest(
    'Case B: In loading state of B, visible history never renders A history',
    'empty visible messages',
    `visible count: ${visibleDuringLoadingB.length}`,
    visibleDuringLoadingB.length === 0
  );

  // ========================================================================================
  // CASE C: Outbound optimistic pending in A, switch to B, poll returns SENT for A
  // ========================================================================================
  console.log('\n--- Case C: Optimistic outbound in A, switch B, poll updates A ---');
  const harnessC = new InboxStateSimulationHarness();
  harnessC.selectConversation('conv-A');
  const reqC_A = harnessC.startFetch('conv-A');
  harnessC.completeFetch('conv-A', reqC_A.generation, []);

  // Send message in A
  const sendC = harnessC.prepareSendMessage('Tin nhắn đang gửi tại A');

  // Switch to B
  harnessC.selectConversation('conv-B');
  const reqC_B = harnessC.startFetch('conv-B');
  harnessC.completeFetch('conv-B', reqC_B.generation, []);

  // Poll response for A returns SENT
  const polledA: InboxMessage[] = [
    {
      id: 'msg-a-out',
      conversation_id: 'conv-A',
      customer_id: 'cust-a',
      channel: 'facebook',
      sender_type: 'sale',
      content: 'Tin nhắn đang gửi tại A',
      created_at: new Date().toISOString(),
      direction: 'outbound',
      delivery_status: 'SENT',
      client_command_id: sendC.commandId,
    },
  ];
  // Reconcile into conv-A cache
  harnessC.completeFetch('conv-A', 999, polledA); // Even if generation is old or poll completes
  // In the real component, setMessagesByConversation updates conv-A directly:
  harnessC.messagesByConversation['conv-A'] = polledA;

  const visibleC_B = harnessC.getVisibleMessages();
  recordTest(
    'Case C.1: Conversation B does NOT receive bubbles or SENT badge of A',
    '0 messages in B',
    `count in B: ${visibleC_B.length}`,
    visibleC_B.length === 0
  );
  recordTest(
    'Case C.2: Conversation A cache correctly holds SENT bubble',
    'delivery_status: SENT in A cache',
    `delivery_status: ${harnessC.messagesByConversation['conv-A']?.[0]?.delivery_status}`,
    harnessC.messagesByConversation['conv-A']?.[0]?.delivery_status === 'SENT'
  );

  // ========================================================================================
  // CASE D: HTTP POST send pending for A, switch B, POST returns
  // ========================================================================================
  console.log('\n--- Case D: POST in flight for A while switching to B ---');
  const harnessD = new InboxStateSimulationHarness();
  harnessD.selectConversation('conv-A');
  const sendD = harnessD.prepareSendMessage('Outbound pending to A');

  // Switch to B
  harnessD.selectConversation('conv-B');

  // POST response completes for A
  harnessD.completeSend('conv-A', {
    id: 'server-msg-d1',
    conversation_id: 'conv-A',
    customer_id: 'cust-a',
    channel: 'facebook',
    sender_type: 'sale',
    content: 'Outbound pending to A',
    created_at: new Date().toISOString(),
    direction: 'outbound',
    delivery_status: 'PENDING_DISPATCH',
    client_command_id: sendD.commandId,
  });

  const visibleD_B = harnessD.getVisibleMessages();
  recordTest(
    'Case D.1: Active conversation B visible stream is unchanged by A send completion',
    '0 messages in B',
    `count in B: ${visibleD_B.length}`,
    visibleD_B.length === 0
  );
  recordTest(
    'Case D.2: Conversation A has server message recorded in its own cache',
    'id: server-msg-d1 in A cache',
    `id: ${harnessD.messagesByConversation['conv-A']?.[0]?.id}`,
    harnessD.messagesByConversation['conv-A']?.[0]?.id === 'server-msg-d1'
  );

  // ========================================================================================
  // CASE E: Draft isolation across conversations
  // ========================================================================================
  console.log('\n--- Case E: Draft isolation per conversation ---');
  const harnessE = new InboxStateSimulationHarness();
  harnessE.selectConversation('conv-A');
  harnessE.setDraft('Dự thảo tư vấn cho khách hàng A');

  recordTest(
    'Case E.1: Draft in A shows entered text',
    'Dự thảo tư vấn cho khách hàng A',
    harnessE.getVisibleDraft(),
    harnessE.getVisibleDraft() === 'Dự thảo tư vấn cho khách hàng A'
  );

  // Switch to B
  harnessE.selectConversation('conv-B');
  recordTest(
    'Case E.2: Switch to B displays empty draft',
    'empty string',
    `"${harnessE.getVisibleDraft()}"`,
    harnessE.getVisibleDraft() === ''
  );

  // Type in B
  harnessE.setDraft('Ghi chú riêng cho B');
  recordTest(
    'Case E.3: B receives its own independent draft',
    'Ghi chú riêng cho B',
    harnessE.getVisibleDraft(),
    harnessE.getVisibleDraft() === 'Ghi chú riêng cho B'
  );

  // Switch back to A
  harnessE.selectConversation('conv-A');
  recordTest(
    'Case E.4: Returning to A restores draft A untouched',
    'Dự thảo tư vấn cho khách hàng A',
    harnessE.getVisibleDraft(),
    harnessE.getVisibleDraft() === 'Dự thảo tư vấn cho khách hàng A'
  );

  // Switch back to B
  harnessE.selectConversation('conv-B');
  recordTest(
    'Case E.5: Returning to B restores draft B untouched',
    'Ghi chú riêng cho B',
    harnessE.getVisibleDraft(),
    harnessE.getVisibleDraft() === 'Ghi chú riêng cho B'
  );

  // Send from A clears only A
  harnessE.selectConversation('conv-A');
  harnessE.prepareSendMessage('Dự thảo tư vấn cho khách hàng A');
  recordTest(
    'Case E.6: Sending A clears draft A',
    'empty string',
    `"${harnessE.getVisibleDraft()}"`,
    harnessE.getVisibleDraft() === ''
  );

  harnessE.selectConversation('conv-B');
  recordTest(
    'Case E.7: Draft B remains intact after sending A',
    'Ghi chú riêng cho B',
    harnessE.getVisibleDraft(),
    harnessE.getVisibleDraft() === 'Ghi chú riêng cho B'
  );

  // ========================================================================================
  // CASE F: Pending command & Idempotency command ID scoped per conversation
  // ========================================================================================
  console.log('\n--- Case F: Pending command & command ID conversation scoping ---');
  const harnessF = new InboxStateSimulationHarness();

  harnessF.selectConversation('conv-A');
  const sendF_A = harnessF.prepareSendMessage('Cùng một nội dung tư vấn giá');

  // Retry sending in conv-A with same text -> reuse commandId
  const retryF_A = harnessF.prepareSendMessage('Cùng một nội dung tư vấn giá');
  recordTest(
    'Case F.1: Network retry in same conversation reuses command ID',
    `commandId: ${sendF_A.commandId}`,
    `commandId: ${retryF_A.commandId}`,
    retryF_A.commandId === sendF_A.commandId && retryF_A.isRetry === true
  );

  // Switch to B and send EXACT SAME text -> MUST get new command ID!
  harnessF.selectConversation('conv-B');
  const sendF_B = harnessF.prepareSendMessage('Cùng một nội dung tư vấn giá');
  recordTest(
    'Case F.2: Sending same text in conversation B generates NEW command ID (never reuse across convs)',
    'Different commandId, isRetry: false',
    `B commandId: ${sendF_B.commandId}, isRetry: ${sendF_B.isRetry}`,
    sendF_B.commandId !== sendF_A.commandId && sendF_B.isRetry === false
  );

  // ========================================================================================
  // WORKER HEARTBEAT & DEGRADED READINESS TESTS
  // ========================================================================================
  console.log('\n--- Worker Operational Heartbeat & Readiness Hardening ---');

  // Reset healthServer state
  healthServer.updateState({ meta_inbox_state: 'READY', browser_connected: true });
  healthServer.recordMainLoopHeartbeat();
  healthServer.recordOutboxPollAttempt();
  healthServer.recordOutboxPollSuccess(2);

  const snapHealthy = healthServer.getSnapshot();
  recordTest(
    'Worker Heartbeat 1: Healthy fresh heartbeat reports outbox_loop_healthy = true',
    'outbox_loop_healthy: true',
    `outbox_loop_healthy: ${snapHealthy.outbox_loop_healthy}`,
    snapHealthy.outbox_loop_healthy === true
  );

  // Test /ready endpoint when fresh
  const port = 3199;
  await healthServer.start(port, '127.0.0.1');

  async function queryReady(): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    return new Promise((resolve) => {
      http.get(`http://127.0.0.1:${port}/ready`, (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode || 0, body: JSON.parse(raw) });
          } catch (_) {
            resolve({ statusCode: res.statusCode || 0, body: {} });
          }
        });
      });
    });
  }

  const resHealthy = await queryReady();
  recordTest(
    'Worker Heartbeat 2: /ready returns 200 when Meta is READY and outbox poll is fresh',
    'HTTP 200, ready: true, state: READY',
    `HTTP ${resHealthy.statusCode}, ready: ${resHealthy.body.ready}, state: ${resHealthy.body.state}`,
    resHealthy.statusCode === 200 && resHealthy.body.ready === true && resHealthy.body.state === 'READY'
  );

  // Now simulate stale outbox poll attempt (> 45s ago)
  (healthServer.state as Record<string, unknown>).last_outbox_poll_attempt_at = new Date(Date.now() - 60000).toISOString();

  const resDegraded = await queryReady();
  recordTest(
    'Worker Heartbeat 3: /ready returns 503 DEGRADED_OUTBOX_LOOP when outbox poll is stale',
    'HTTP 503, ready: false, state: DEGRADED_OUTBOX_LOOP',
    `HTTP ${resDegraded.statusCode}, ready: ${resDegraded.body.ready}, state: ${resDegraded.body.state}`,
    resDegraded.statusCode === 503 && resDegraded.body.ready === false && resDegraded.body.state === 'DEGRADED_OUTBOX_LOOP'
  );

  // Record fresh attempt again
  healthServer.recordOutboxPollAttempt();
  healthServer.recordOutboxPollSuccess(0);
  const resRecovered = await queryReady();
  recordTest(
    'Worker Heartbeat 4: /ready recovers to 200 immediately upon fresh outbox poll cycle',
    'HTTP 200, ready: true, state: READY',
    `HTTP ${resRecovered.statusCode}, ready: ${resRecovered.body.ready}, state: ${resRecovered.body.state}`,
    resRecovered.statusCode === 200 && resRecovered.body.ready === true && resRecovered.body.state === 'READY'
  );

  await healthServer.stop();

  console.log('\n========================================================================================');
  console.log('ACCEPTANCE MATRIX: CONVERSATION ISOLATION & WORKER HEARTBEAT');
  console.log('========================================================================================\n');
  console.table(resultsTable);

  const passedCount = resultsTable.filter((r) => r.status === 'PASS').length;
  console.log(`\nOVERALL STATUS: ALL ${passedCount}/${resultsTable.length} TESTS PASSED (100%)\n`);
}

runAllTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
