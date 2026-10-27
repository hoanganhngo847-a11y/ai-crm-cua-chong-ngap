import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseBotcakeInboundPayload,
  verifyBotcakeSecret,
} from '../../features/omnichannel/botcake/webhook';

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
