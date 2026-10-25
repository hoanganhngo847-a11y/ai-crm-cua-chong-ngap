import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JAVIS_BRAIN_SYSTEM_INSTRUCTION } from '../../services/javis-brain/model';

test('Javis Brain policy does not treat generic consultation as an explicit human request', () => {
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /generic request for consultation, advice, help, or support is NOT by itself a request for a human/i);
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /tôi cần tư vấn/i);
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /CUSTOMER_REQUESTED_HUMAN/);
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /only when the customer explicitly asks/i);
});
