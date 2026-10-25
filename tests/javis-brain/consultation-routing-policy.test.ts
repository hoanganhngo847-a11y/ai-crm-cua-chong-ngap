import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JAVIS_BRAIN_SYSTEM_INSTRUCTION } from '../../services/javis-brain/model';

test('Javis Brain policy does not treat generic consultation as an explicit human request', () => {
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /generic request for consultation, advice, help, or support is NOT by itself a request for a human/i);
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /tôi cần tư vấn/i);
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /CUSTOMER_REQUESTED_HUMAN/);
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /only when the customer explicitly asks/i);
});

test('Javis Brain continues replying to short contextual customer follow-ups', () => {
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /Every new inbound customer message is a new turn/i);
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /there is no one-reply-per-conversation limit/i);
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /Do not choose "NO_REPLY" only because a message is short/i);
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /clear final closure/i);
});
