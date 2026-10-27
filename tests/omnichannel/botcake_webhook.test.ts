import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import {
  parseBotcakeInboundPayload,
  parseBotcakeWebhookPayload,
  verifyBotcakeSecret,
} from '../../features/omnichannel/botcake/webhook';
import { GET, POST } from '../../app/api/webhooks/botcake/route';

const PAGE_ID = '1343097708890171';
const COMPANY_ID = 'de6a7bf3-b5bc-418d-92d6-f9b241472598';
const SECRET = 'test-secret-value-123';

function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previous = {
    page: process.env.BOTCAKE_PAGE_ID,
    company: process.env.BOTCAKE_COMPANY_ID,
    secret: process.env.BOTCAKE_WEBHOOK_SECRET,
    demo: process.env.DEMO_MODE,
  };

  process.env.BOTCAKE_PAGE_ID = PAGE_ID;
  process.env.BOTCAKE_COMPANY_ID = COMPANY_ID;
  process.env.BOTCAKE_WEBHOOK_SECRET = SECRET;
  process.env.DEMO_MODE = 'true';

  return fn().finally(() => {
    if (previous.page) process.env.BOTCAKE_PAGE_ID = previous.page;
    else delete process.env.BOTCAKE_PAGE_ID;
    if (previous.company) process.env.BOTCAKE_COMPANY_ID = previous.company;
    else delete process.env.BOTCAKE_COMPANY_ID;
    if (previous.secret) process.env.BOTCAKE_WEBHOOK_SECRET = previous.secret;
    else delete process.env.BOTCAKE_WEBHOOK_SECRET;
    if (previous.demo) process.env.DEMO_MODE = previous.demo;
    else delete process.env.DEMO_MODE;
  });
}

function pancakePayload(overrides: {
  pageId?: string;
  messageId?: string;
  text?: string;
  senderId?: string;
  senderName?: string;
  type?: 'INBOX' | 'COMMENT';
  insertedAt?: string;
  fromId?: string;
  isRemoved?: boolean;
} = {}) {
  const pageId = overrides.pageId ?? PAGE_ID;
  const senderId = overrides.senderId ?? 'psid-pancake-1';
  const messageId = overrides.messageId ?? 'm_pancake_1';

  return {
    page_id: pageId,
    event_type: 'messaging',
    data: {
      conversation: {
        id: 'fb_conversation_1',
        from: { id: senderId, name: overrides.senderName ?? 'Khách Pancake' },
        snippet: overrides.text ?? 'Xin chào',
        type: overrides.type ?? 'INBOX',
        is_combined: false,
        is_removed: false,
      },
      message: {
        id: messageId,
        conversation_id: 'fb_conversation_1',
        page_id: pageId,
        message: overrides.text ?? 'Xin chào',
        original_message: overrides.text ?? 'Xin chào',
        type: overrides.type ?? 'INBOX',
        inserted_at: overrides.insertedAt ?? '2026-10-27T03:14:43.000000',
        from: {
          id: overrides.fromId ?? senderId,
          name: overrides.senderName ?? 'Khách Pancake',
          page_customer_id: 'page-customer-1',
        },
        attachments: [],
        is_removed: overrides.isRemoved ?? false,
        is_hidden: false,
      },
    },
  };
}

test('Botcake secret comparison is fail-closed and timing-safe compatible', () => {
  assert.equal(verifyBotcakeSecret('secret-a', 'secret-a'), true);
  assert.equal(verifyBotcakeSecret('secret-a', 'secret-b'), false);
  assert.equal(verifyBotcakeSecret('', 'secret-a'), false);
  assert.equal(verifyBotcakeSecret('secret-a', ''), false);
  assert.equal(verifyBotcakeSecret('x'.repeat(513), 'x'.repeat(513)), false);
});

test('Pancake messaging payload carries the real message id, text, sender and UTC timestamp', () => {
  const result = parseBotcakeWebhookPayload(pancakePayload(), PAGE_ID);
  assert.equal(result.kind, 'message');
  if (result.kind !== 'message') return;

  assert.deepEqual(result.event, {
    pageId: PAGE_ID,
    externalUserId: 'psid-pancake-1',
    messageId: 'm_pancake_1',
    content: 'Xin chào',
    senderName: 'Khách Pancake',
    timestamp: '2026-10-27T03:14:43.000Z',
    transport: 'PANCAKE_WEBHOOK',
    providerConversationId: 'fb_conversation_1',
  });
});

test('Pancake page ids may use a platform prefix', () => {
  const result = parseBotcakeWebhookPayload(
    pancakePayload({ pageId: `fb_${PAGE_ID}` }),
    PAGE_ID,
  );
  assert.equal(result.kind, 'message');
  if (result.kind === 'message') assert.equal(result.event.pageId, PAGE_ID);
});

test('Pancake comments, outbound replies and removed messages are ignored', () => {
  const comment = parseBotcakeWebhookPayload(
    pancakePayload({ type: 'COMMENT' }),
    PAGE_ID,
  );
  assert.deepEqual(comment, { kind: 'ignored', reason: 'COMMENT' });

  const outbound = parseBotcakeWebhookPayload(
    pancakePayload({ fromId: PAGE_ID }),
    PAGE_ID,
  );
  assert.deepEqual(outbound, { kind: 'ignored', reason: 'OUTBOUND' });

  const removed = parseBotcakeWebhookPayload(
    pancakePayload({ isRemoved: true }),
    PAGE_ID,
  );
  assert.deepEqual(removed, { kind: 'ignored', reason: 'REMOVED' });
});

test('Pancake payloads for another Page are rejected', () => {
  assert.throws(
    () => parseBotcakeWebhookPayload(pancakePayload({ pageId: '999' }), PAGE_ID),
    /PAGE_NOT_CONFIGURED/,
  );
});

test('Legacy JSON API payload normalizes common sender, message, and timestamp shapes', () => {
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
    transport: 'JSON_API',
  });
});

test('Legacy JSON API rejects unresolved Botcake template variables in identity fields', () => {
  assert.throws(
    () => parseBotcakeWebhookPayload({
      page_id: PAGE_ID,
      psid: '{{customer.psid}}',
      message_id: 'mid-real-1',
      text: 'hello',
    }, PAGE_ID),
    /UNRESOLVED_TEMPLATE_VARIABLE:sender_id/,
  );

  assert.throws(
    () => parseBotcakeWebhookPayload({
      page_id: PAGE_ID,
      psid: 'psid-real-1',
      message_id: '{{message.mid}}',
      text: 'hello',
    }, PAGE_ID),
    /UNRESOLVED_TEMPLATE_VARIABLE:message_id/,
  );
});

test('Legacy JSON API accepts quotes and newlines without breaking parsing', () => {
  const event = parseBotcakeInboundPayload({
    page_id: PAGE_ID,
    psid: 'psid-real-2',
    message_id: 'mid-real-2',
    text: 'Anh ơi "báo giá" giúp em\nCửa 2m nhé',
    sender_name: 'Khách "VIP"',
  }, PAGE_ID);

  assert.equal(event.content, 'Anh ơi "báo giá" giúp em\nCửa 2m nhé');
  assert.equal(event.senderName, 'Khách "VIP"');
});

test('Legacy JSON API ignores an unresolved sender name but keeps the message', () => {
  const event = parseBotcakeInboundPayload({
    page_id: PAGE_ID,
    psid: 'psid-real-3',
    message_id: 'mid-real-3',
    text: 'hello',
    sender_name: '{{customer.name}}',
  }, PAGE_ID);

  assert.equal(event.senderName, undefined);
});

test('GET /api/webhooks/botcake returns 503 BOTCAKE_NOT_CONFIGURED when env is missing', async () => {
  const previous = {
    page: process.env.BOTCAKE_PAGE_ID,
    company: process.env.BOTCAKE_COMPANY_ID,
    secret: process.env.BOTCAKE_WEBHOOK_SECRET,
  };
  try {
    delete process.env.BOTCAKE_PAGE_ID;
    delete process.env.BOTCAKE_COMPANY_ID;
    delete process.env.BOTCAKE_WEBHOOK_SECRET;

    const res = await GET();
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, 'BOTCAKE_NOT_CONFIGURED');
  } finally {
    if (previous.page) process.env.BOTCAKE_PAGE_ID = previous.page;
    if (previous.company) process.env.BOTCAKE_COMPANY_ID = previous.company;
    if (previous.secret) process.env.BOTCAKE_WEBHOOK_SECRET = previous.secret;
  }
});

test('GET /api/webhooks/botcake returns 200 READY with the Pancake transport', async () => {
  await withEnv(async () => {
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'READY');
    assert.equal(body.page_id, PAGE_ID);
    assert.equal(body.transport, 'PANCAKE_WEBHOOK');
    assert.deepEqual(body.accepts, ['PANCAKE_WEBHOOK', 'JSON_API']);
  });
});

test('POST /api/webhooks/botcake ingests a Pancake event and deduplicates retries', async () => {
  await withEnv(async () => {
    const payload = pancakePayload({
      messageId: 'm_pancake_route_1',
      senderId: 'psid-pancake-route-1',
      text: 'Khách gửi tin nhắn kiểm thử',
    });

    const first = await POST(new NextRequest(
      `http://localhost:3000/api/webhooks/botcake?token=${SECRET}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    ));
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.success, true);
    assert.equal(firstBody.duplicate, false);
    assert.equal(firstBody.page_id, PAGE_ID);
    assert.equal(firstBody.transport, 'PANCAKE_WEBHOOK');
    assert.ok(firstBody.conversation_id);

    const retry = await POST(new NextRequest(
      'http://localhost:3000/api/webhooks/botcake',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Botcake-Webhook-Secret': SECRET,
        },
        body: JSON.stringify(payload),
      },
    ));
    assert.equal(retry.status, 200);
    const retryBody = await retry.json();
    assert.equal(retryBody.success, true);
    assert.equal(retryBody.duplicate, true);
    assert.equal(retryBody.conversation_id, firstBody.conversation_id);
  });
});

test('POST /api/webhooks/botcake ignores Pancake comments without creating a conversation', async () => {
  await withEnv(async () => {
    const res = await POST(new NextRequest(
      'http://localhost:3000/api/webhooks/botcake',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SECRET}`,
        },
        body: JSON.stringify(pancakePayload({
          type: 'COMMENT',
          messageId: 'm_comment_1',
          senderId: 'psid-comment-1',
        })),
      },
    ));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ignored, true);
    assert.equal(body.reason, 'COMMENT');
  });
});

test('POST /api/webhooks/botcake rejects unresolved template variables with 422', async () => {
  await withEnv(async () => {
    const res = await POST(new NextRequest(
      'http://localhost:3000/api/webhooks/botcake',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SECRET}`,
        },
        body: JSON.stringify({
          page_id: PAGE_ID,
          psid: '{{customer.psid}}',
          message_id: '{{message.mid}}',
          text: '{{message.text}}',
        }),
      },
    ));
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error, 'UNRESOLVED_TEMPLATE_VARIABLE');
    assert.equal(body.field, 'sender_id');
  });
});

test('POST /api/webhooks/botcake rejects another Page with 403', async () => {
  await withEnv(async () => {
    const res = await POST(new NextRequest(
      'http://localhost:3000/api/webhooks/botcake',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SECRET}`,
        },
        body: JSON.stringify(pancakePayload({ pageId: '999' })),
      },
    ));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'PAGE_NOT_CONFIGURED');
  });
});

test('POST /api/webhooks/botcake rejects invalid JSON and unauthorized requests', async () => {
  await withEnv(async () => {
    const invalid = await POST(new NextRequest(
      'http://localhost:3000/api/webhooks/botcake',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SECRET}`,
        },
        body: '{not-json',
      },
    ));
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'INVALID_JSON');

    const unauthorized = await POST(new NextRequest(
      'http://localhost:3000/api/webhooks/botcake',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wrong-secret',
        },
        body: JSON.stringify(pancakePayload({ messageId: 'm_unauth_1' })),
      },
    ));
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).error, 'UNAUTHORIZED');
  });
});
