import test from 'node:test';
import assert from 'node:assert/strict';
import { buildZaloHandoffTarget } from '../../features/inbox/utils/zalo-handoff';

test('UID-only Zalo customer fails closed until server resolves a native phone', () => {
  const target = buildZaloHandoffTarget({ uid: '7994906426019206392' });
  assert.deepEqual(target, {
    targeted: false,
    deepLink: null,
    webUrl: null,
    targetKind: 'none',
  });
});

test('full phone opens exact Zalo PC conversation and never exposes a web fallback', () => {
  const target = buildZaloHandoffTarget({
    phone: '+84912345678',
    uid: '7994906426019206392',
  });
  assert.equal(target.targeted, true);
  assert.equal(target.targetKind, 'phone');
  assert.equal(target.deepLink, 'zalo://conversation?phone=0912345678');
  assert.equal(target.webUrl, null);
});

test('masked phone is never used even when an exact UID exists', () => {
  const target = buildZaloHandoffTarget({ phone: '0912***678', uid: '123456789' });
  assert.deepEqual(target, {
    targeted: false,
    deepLink: null,
    webUrl: null,
    targetKind: 'none',
  });
});

test('missing exact identity fails closed instead of opening generic Zalo', () => {
  const target = buildZaloHandoffTarget({ phone: null, uid: null });
  assert.deepEqual(target, {
    targeted: false,
    deepLink: null,
    webUrl: null,
    targetKind: 'none',
  });
});
