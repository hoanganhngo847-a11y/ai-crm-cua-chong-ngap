import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BRAIN_CONTEXT_TOOL_NAMES,
  createBrainContextGateway,
  type BrainContextDataSource,
  type BrainContextScope,
} from '../../features/ai-brain';

const companyA = '11111111-1111-4111-8111-111111111111';
const companyB = '22222222-2222-4222-8222-222222222222';
const customerA = '33333333-3333-4333-8333-333333333333';
const customerB = '44444444-4444-4444-8444-444444444444';
const conversationA = '55555555-5555-4555-8555-555555555555';
const conversationB = '66666666-6666-4666-8666-666666666666';
const traceA = '77777777-7777-4777-8777-777777777777';
const traceB = '88888888-8888-4888-8888-888888888888';

function scope(overrides: Partial<BrainContextScope> = {}): BrainContextScope {
  return {
    companyId: companyA,
    customerId: customerA,
    conversationId: conversationA,
    channel: 'MESSENGER',
    traceId: traceA,
    ...overrides,
  };
}

function fakeSource(log: BrainContextScope[] = []): BrainContextDataSource {
  const capture = <T>(s: BrainContextScope, value: T): T => {
    log.push(s);
    return value;
  };
  return {
    async getCustomerProfile(s) {
      return capture(s, {
        id: s.customerId,
        customerCode: null,
        name: s.customerId === customerA ? 'Customer A' : 'Customer B',
        source: 'TEST',
        stage: 'LEAD',
        createdAt: '2026-10-22T00:00:00Z',
        updatedAt: '2026-10-22T00:00:00Z',
      });
    },
    async getRecentConversations(s) { return capture(s, []); },
    async getRecentInteractions(s) { return capture(s, []); },
    async getCustomerStageHistory(s) { return capture(s, []); },
    async getUpcomingAppointments(s) { return capture(s, []); },
    async getCallHistory(s) { return capture(s, { phone: [], zalo: [] }); },
    async getRecentCallSummaries(s) { return capture(s, []); },
  };
}

test('invalid trusted scope fails closed and exposes no tools', async () => {
  const gateway = createBrainContextGateway(fakeSource());
  const session = gateway.bind({ ...scope(), companyId: 'attacker-company' });
  assert.deepEqual(session.tools, []);
  assert.deepEqual(await session.execute({ name: 'get_customer_profile' }), {
    ok: false,
    tool: null,
    errorCode: 'BRAIN_CONTEXT_INVALID_SCOPE',
  });
});

test('valid session exposes only the fixed read-only allowlist', () => {
  const gateway = createBrainContextGateway(fakeSource());
  const session = gateway.bind(scope());
  assert.deepEqual(session.tools, BRAIN_CONTEXT_TOOL_NAMES);
  assert.ok(Object.isFrozen(session.tools));
});

for (const malicious of [
  { name: 'get_customer_profile', arguments: { companyId: companyB } },
  { name: 'get_customer_profile', arguments: { customerId: customerB } },
  { name: 'get_recent_interactions', arguments: { limit: 999999 } },
  { name: 'get_recent_interactions', arguments: { conversationId: conversationB } },
  { name: 'get_all_customers', arguments: {} },
  { name: 'delete_customer', arguments: {} },
]) {
  test('model cannot enlarge scope or invoke non-allowlisted tools', async () => {
    const log: BrainContextScope[] = [];
    const result = await createBrainContextGateway(fakeSource(log)).bind(scope()).execute(malicious);
    assert.deepEqual(result, {
      ok: false,
      tool: null,
      errorCode: 'BRAIN_CONTEXT_TOOL_NOT_ALLOWED',
    });
    assert.equal(log.length, 0);
  });
}

test('empty arguments are accepted but trusted scope remains server-owned', async () => {
  const log: BrainContextScope[] = [];
  const trusted = scope();
  const result = await createBrainContextGateway(fakeSource(log)).bind(trusted).execute({
    name: 'get_customer_profile',
    arguments: {},
  });
  assert.equal(result.ok, true);
  assert.equal(log.length, 1);
  assert.deepEqual(log[0], trusted);
  assert.ok(Object.isFrozen(log[0]));
});

test('sessions for different tenants/customers do not share scope', async () => {
  const log: BrainContextScope[] = [];
  const gateway = createBrainContextGateway(fakeSource(log));
  const a = await gateway.bind(scope()).execute({ name: 'get_customer_profile' });
  const b = await gateway.bind(scope({
    companyId: companyB,
    customerId: customerB,
    conversationId: conversationB,
    traceId: traceB,
    channel: 'ZALO',
  })).execute({ name: 'get_customer_profile' });

  assert.equal(a.ok && 'name' in a.data ? a.data.name : null, 'Customer A');
  assert.equal(b.ok && 'name' in b.data ? b.data.name : null, 'Customer B');
  assert.equal(log[0]?.companyId, companyA);
  assert.equal(log[0]?.customerId, customerA);
  assert.equal(log[1]?.companyId, companyB);
  assert.equal(log[1]?.customerId, customerB);
});

test('every allowlisted tool receives exactly the bound scope', async () => {
  const log: BrainContextScope[] = [];
  const session = createBrainContextGateway(fakeSource(log)).bind(scope());
  for (const name of BRAIN_CONTEXT_TOOL_NAMES) {
    const result = await session.execute({ name });
    assert.equal(result.ok, true, name);
  }
  assert.equal(log.length, BRAIN_CONTEXT_TOOL_NAMES.length);
  for (const seen of log) assert.deepEqual(seen, scope());
});

test('data-source failures collapse to canonical context error', async () => {
  const source = fakeSource();
  source.getRecentInteractions = async () => {
    throw new Error('postgres://secret-host?password=do-not-leak');
  };
  const result = await createBrainContextGateway(source).bind(scope()).execute({ name: 'get_recent_interactions' });
  assert.deepEqual(result, {
    ok: false,
    tool: 'get_recent_interactions',
    errorCode: 'BRAIN_CONTEXT_UNAVAILABLE',
  });
  assert.ok(!JSON.stringify(result).includes('password'));
});

test('missing customer is a canonical not-found response', async () => {
  const source = fakeSource();
  source.getCustomerProfile = async () => null;
  const result = await createBrainContextGateway(source).bind(scope()).execute({ name: 'get_customer_profile' });
  assert.deepEqual(result, {
    ok: false,
    tool: 'get_customer_profile',
    errorCode: 'BRAIN_CONTEXT_NOT_FOUND',
  });
});
