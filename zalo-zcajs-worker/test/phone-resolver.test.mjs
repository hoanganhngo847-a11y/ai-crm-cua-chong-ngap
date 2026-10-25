import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVietnamPhone, resolveExactZaloPhone } from '../src/phone-resolver.mjs';

test('normalizes Vietnamese phone formats used by Zalo PC deep links', () => {
  assert.equal(normalizeVietnamPhone('+84 912 345 678'), '0912345678');
  assert.equal(normalizeVietnamPhone('84912345678'), '0912345678');
  assert.equal(normalizeVietnamPhone('0912 345 678'), '0912345678');
  assert.equal(normalizeVietnamPhone('0912***678'), null);
});

test('resolves phone only from the exact requested UID profile', () => {
  const data = {
    changed_profiles: {
      '7994906426019206392_0': {
        userId: '7994906426019206392',
        phoneNumber: '+84912345678',
      },
      '111111111_0': {
        userId: '111111111',
        phoneNumber: '0987654321',
      },
    },
  };
  assert.equal(resolveExactZaloPhone(data, '7994906426019206392'), '0912345678');
  assert.equal(resolveExactZaloPhone(data, '222222222'), null);
});

test('does not borrow a phone from another profile when exact UID has none', () => {
  const data = {
    changed_profiles: {
      '7994906426019206392_0': { userId: '7994906426019206392', displayName: 'Target' },
      '111111111_0': { userId: '111111111', phoneNumber: '0987654321' },
    },
  };
  assert.equal(resolveExactZaloPhone(data, '7994906426019206392'), null);
});
