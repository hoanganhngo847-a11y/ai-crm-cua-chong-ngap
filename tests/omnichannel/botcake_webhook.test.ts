import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import {
  parseBotcakeInboundPayload,
  verifyBotcakeSecret,
} from '../../features/omnichannel/botcake/webhook';
import { GET, POST } from '../../app/api/webhooks/botcake/route';

const PAGE_ID = '1343097708890171';

test('Botcake secret comparison is fail-closed and timing-safe compatible', () => {
  assert.equal(verifyBotcakeSecret('secret-a', 'secret-a'), true);
  assert.equal(verifyBotcakeSecret('secret-a', 'secret-b'), false);
  assert.equal(verifyBotcakeSecret('', 'secret-a'), false);
  assert.equal(verifyBotcakeSecret('secret-a', ''), false);
  assert.equal(verifyBotcakeSecret('x'.repeat(513), 'x'.repeat(513)), false);
});

test('Botcake payload normalizes common sender, message, and timestamp shapes', () => {
  const event = parseBotcakeInboundPayload(
    {
      page_id: PAGE_ID,
      user: { id: 'psid-1', full_name: 'Khách thử nghiệm' },
      message: { id: 'mid-1', text: 'Xin chào', timestamp: 1_793_030_705_000 },
    },
    PAGE_ID,
  );

  assert.deepEqual(event, {
    pageId: PAGE_ID,
    externalUserId: 'psid-1',
    messageId: 'mid-1',
    content: 'Xin chào',
    senderName: 'Khách thử nghiệm',
    timestamp: '2026-10-26T16:05:05.000Z',
  });
});

test('Botcake contract payload conforms to required specification', () => {
  const minimalPayload = {
    page_id: PAGE_ID,
    psid: 'customer-page-scoped-id',
    message_id: 'botcake-message-id',
    text: 'Nội dung khách gửi',
    timestamp: '2026-10-26T16:05:05.000Z',
    sender_name: 'Tên khách',
  };
  const event = parseBotcakeInboundPayload(minimalPayload, PAGE_ID);
  assert.deepEqual(event, {
    pageId: PAGE_ID,
    externalUserId: 'customer-page-scoped-id',
    messageId: 'botcake-message-id',
    content: 'Nội dung khách gửi',
    senderName: 'Tên khách',
    timestamp: '2026-10-26T16:05:05.000Z',
  });
});

test('Botcake payload handles numeric page_id and customer object with first/last name', () => {
  const event = parseBotcakeInboundPayload(
    {
      page_id: 1343097708890171,
      customer: { psid: 'psid-99', first_name: 'Trần', last_name: 'Văn B' },
      message: { mid: 'mid-99', text: 'Cần tư vấn' },
      timestamp: 1793030705,
    },
    PAGE_ID,
  );
  assert.deepEqual(event, {
    pageId: PAGE_ID,
    externalUserId: 'psid-99',
    messageId: 'mid-99',
    content: 'Cần tư vấn',
    senderName: 'Trần Văn B',
    timestamp: '2026-10-26T16:05:05.000Z',
  });
});

test('Botcake payload refuses a different Page and incomplete message identity', () => {
  assert.throws(
    () => parseBotcakeInboundPayload({ page_id: '999', psid: 'psid', message_id: 'mid', text: 'x' }, PAGE_ID),
    /PAGE_NOT_CONFIGURED/,
  );
  assert.throws(
    () => parseBotcakeInboundPayload({ page_id: PAGE_ID, message_id: 'mid', text: 'x' }, PAGE_ID),
    /MISSING_SENDER_ID/,
  );
  assert.throws(
    () => parseBotcakeInboundPayload({ page_id: PAGE_ID, psid: 'psid', text: 'x' }, PAGE_ID),
    /MISSING_MESSAGE_ID/,
  );
  assert.throws(
    () => parseBotcakeInboundPayload({ page_id: PAGE_ID, psid: 'psid', message_id: 'mid' }, PAGE_ID),
    /MISSING_CONTENT/,
  );
});

test('GET /api/webhooks/botcake returns 503 BOTCAKE_NOT_CONFIGURED when env is missing', async () => {
  const prevPage = process.env.BOTCAKE_PAGE_ID;
  const prevCo = process.env.BOTCAKE_COMPANY_ID;
  const prevSec = process.env.BOTCAKE_WEBHOOK_SECRET;
  try {
    delete process.env.BOTCAKE_PAGE_ID;
    delete process.env.BOTCAKE_COMPANY_ID;
    delete process.env.BOTCAKE_WEBHOOK_SECRET;

    const res = await GET();
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, 'BOTCAKE_NOT_CONFIGURED');
  } finally {
    if (prevPage) process.env.BOTCAKE_PAGE_ID = prevPage;
    if (prevCo) process.env.BOTCAKE_COMPANY_ID = prevCo;
    if (prevSec) process.env.BOTCAKE_WEBHOOK_SECRET = prevSec;
  }
});

test('GET /api/webhooks/botcake returns 200 READY when env is configured', async () => {
  const prevPage = process.env.BOTCAKE_PAGE_ID;
  const prevCo = process.env.BOTCAKE_COMPANY_ID;
  const prevSec = process.env.BOTCAKE_WEBHOOK_SECRET;
  try {
    process.env.BOTCAKE_PAGE_ID = PAGE_ID;
    process.env.BOTCAKE_COMPANY_ID = 'de6a7bf3-b5bc-418d-92d6-f9b241472598';
    process.env.BOTCAKE_WEBHOOK_SECRET = 'test-secret-value-123';

    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'READY');
    assert.equal(body.page_id, PAGE_ID);
  } finally {
    if (prevPage) process.env.BOTCAKE_PAGE_ID = prevPage; else delete process.env.BOTCAKE_PAGE_ID;
    if (prevCo) process.env.BOTCAKE_COMPANY_ID = prevCo; else delete process.env.BOTCAKE_COMPANY_ID;
    if (prevSec) process.env.BOTCAKE_WEBHOOK_SECRET = prevSec; else delete process.env.BOTCAKE_WEBHOOK_SECRET;
  }
});

test('POST /api/webhooks/botcake ingests message and maintains idempotency on retry', async () => {
  const prevPage = process.env.BOTCAKE_PAGE_ID;
  const prevCo = process.env.BOTCAKE_COMPANY_ID;
  const prevSec = process.env.BOTCAKE_WEBHOOK_SECRET;
  const prevDemo = process.env.DEMO_MODE;
  try {
    process.env.DEMO_MODE = 'true';
    process.env.BOTCAKE_PAGE_ID = PAGE_ID;
    process.env.BOTCAKE_COMPANY_ID = 'de6a7bf3-b5bc-418d-92d6-f9b241472598';
    process.env.BOTCAKE_WEBHOOK_SECRET = 'test-secret-value-123';

    const payload = {
      page_id: PAGE_ID,
      psid: 'customer-scoped-test-1',
      message_id: 'mid-test-unique-001',
      text: 'Khách gửi tin nhắn kiểm thử',
      sender_name: 'Khách VIP',
      timestamp: '2026-10-26T16:05:05.000Z',
    };

    // First delivery with X-Botcake-Webhook-Secret
    const req1 = new NextRequest('http://localhost:3000/api/webhooks/botcake', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Botcake-Webhook-Secret': 'test-secret-value-123',
      },
      body: JSON.stringify(payload),
    });
    const res1 = await POST(req1);
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.success, true);
    assert.equal(body1.duplicate, false);
    assert.ok(body1.conversation_id);
    assert.equal(body1.page_id, PAGE_ID);

    // Duplicate retry with Authorization: Bearer
    const req2 = new NextRequest('http://localhost:3000/api/webhooks/botcake', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-secret-value-123',
      },
      body: JSON.stringify(payload),
    });
    const res2 = await POST(req2);
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.success, true);
    assert.equal(body2.duplicate, true);
    assert.equal(body2.conversation_id, body1.conversation_id);
  } finally {
    if (prevPage) process.env.BOTCAKE_PAGE_ID = prevPage; else delete process.env.BOTCAKE_PAGE_ID;
    if (prevCo) process.env.BOTCAKE_COMPANY_ID = prevCo; else delete process.env.BOTCAKE_COMPANY_ID;
    if (prevSec) process.env.BOTCAKE_WEBHOOK_SECRET = prevSec; else delete process.env.BOTCAKE_WEBHOOK_SECRET;
    if (prevDemo) process.env.DEMO_MODE = prevDemo; else delete process.env.DEMO_MODE;
  }
});

test('POST /api/webhooks/botcake rejects unauthorized requests', async () => {
  const prevPage = process.env.BOTCAKE_PAGE_ID;
  const prevCo = process.env.BOTCAKE_COMPANY_ID;
  const prevSec = process.env.BOTCAKE_WEBHOOK_SECRET;
  try {
    process.env.BOTCAKE_PAGE_ID = PAGE_ID;
    process.env.BOTCAKE_COMPANY_ID = 'de6a7bf3-b5bc-418d-92d6-f9b241472598';
    process.env.BOTCAKE_WEBHOOK_SECRET = 'test-secret-value-123';

    const req = new NextRequest('http://localhost:3000/api/webhooks/botcake', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer wrong-secret' },
      body: JSON.stringify({ page_id: PAGE_ID, psid: 'p1', message_id: 'm1', text: 'hi' }),
    });
    const res = await POST(req);
    assert.equal(res.status, 401);
  } finally {
    if (prevPage) process.env.BOTCAKE_PAGE_ID = prevPage; else delete process.env.BOTCAKE_PAGE_ID;
    if (prevCo) process.env.BOTCAKE_COMPANY_ID = prevCo; else delete process.env.BOTCAKE_COMPANY_ID;
    if (prevSec) process.env.BOTCAKE_WEBHOOK_SECRET = prevSec; else delete process.env.BOTCAKE_WEBHOOK_SECRET;
  }
});
