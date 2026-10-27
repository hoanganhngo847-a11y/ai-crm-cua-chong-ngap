import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractMessengerPageId,
  extractMessengerRecipientId,
} from '../../features/ai-brain/page-id';

const PAGE_ID = '1343097708890171';
const PSID = '61592309996204';

test('Messenger page IDs: canonical pageId:psid wins', () => {
  assert.equal(extractMessengerPageId(`${PAGE_ID}:${PSID}`, null), PAGE_ID);
  assert.equal(extractMessengerRecipientId(`${PAGE_ID}:${PSID}`, null), PSID);
});

test('Messenger page IDs: Botcake metadata recovers page and recipient', () => {
  const metadata = { page_id: PAGE_ID, sender_id: PSID };
  assert.equal(extractMessengerPageId('customer-uuid', metadata), PAGE_ID);
  assert.equal(extractMessengerRecipientId('customer-uuid', metadata), PSID);
});

test('Messenger page IDs: alternate metadata keys are accepted', () => {
  assert.equal(extractMessengerPageId(null, { entry_id: PAGE_ID }), PAGE_ID);
  assert.equal(extractMessengerRecipientId(null, { psid: PSID }), PSID);
  assert.equal(extractMessengerRecipientId(null, { external_user_id: PSID }), PSID);
});

test('Messenger page IDs: non-numeric values fail closed', () => {
  assert.equal(extractMessengerPageId('page-not-numeric:user', null), null);
  assert.equal(extractMessengerRecipientId(`${PAGE_ID}:not-a-psid`, null), null);
  assert.equal(extractMessengerPageId(null, { page_id: 'page-name' }), null);
  assert.equal(extractMessengerRecipientId(null, { sender_id: 'psid-name' }), null);
  assert.equal(extractMessengerPageId(null, null), null);
  assert.equal(extractMessengerRecipientId(undefined, undefined), null);
});
