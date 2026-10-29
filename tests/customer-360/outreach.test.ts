import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTREACH_CHANNEL_LABELS,
  OUTREACH_CHANNELS,
  canToggleOutreach,
  formatOutreachDate,
  resolveOutreachState,
} from '../../features/customer-360/outreach';

test('outreach channels and labels cover Facebook and Zalo', () => {
  assert.deepEqual([...OUTREACH_CHANNELS], ['FACEBOOK', 'ZALO']);
  assert.equal(OUTREACH_CHANNEL_LABELS.FACEBOOK, 'Facebook');
  assert.equal(OUTREACH_CHANNEL_LABELS.ZALO, 'Zalo');
});

test('automatic outbound evidence wins over a manual mark', () => {
  const state = resolveOutreachState('2026-10-27T08:00:00Z', '2026-10-24T09:00:00Z');
  assert.deepEqual(state, { reached: true, at: '2026-10-24T09:00:00Z', source: 'AUTO' });
  assert.equal(canToggleOutreach(state), false, 'auto evidence is not manually removable');
});

test('a manual mark tracks a sale step that happened outside the CRM', () => {
  const state = resolveOutreachState('2026-10-27T08:00:00Z', null);
  assert.deepEqual(state, { reached: true, at: '2026-10-27T08:00:00Z', source: 'MANUAL' });
  assert.equal(canToggleOutreach(state), true, 'manual marks stay toggleable');
});

test('a customer without any evidence is not marked as reached', () => {
  const state = resolveOutreachState(null, null);
  assert.deepEqual(state, { reached: false, at: null, source: null });
  assert.equal(canToggleOutreach(state), true);
});

test('outreach dates render in Vietnam date format and reject invalid values', () => {
  assert.equal(formatOutreachDate('2026-10-24T02:00:00Z'), '24/10/2026');
  assert.equal(formatOutreachDate(null), null);
  assert.equal(formatOutreachDate('not-a-date'), null);
});
