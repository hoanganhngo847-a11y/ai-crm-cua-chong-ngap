import test from 'node:test';
import assert from 'node:assert/strict';
import { buildZaloHandoffTarget } from '../../features/inbox/utils/zalo-handoff';

test('UID-only Zalo customer opens the exact web conversation instead of generic Zalo', () => {
  const target = buildZaloHandoffTarget({ uid: '7994906426019206392' });
  assert.equal(target.targeted, true);
  assert.equal(target.targetKind, 'uid');
  assert.equal(target.deepLink, null);
  assert.equal(target.webUrl, 'https://chat.zalo.me/?c=7994906426019206392');
});

test('full phone prefers exact Zalo PC handoff while retaining UID exact fallback', () => {
  const target = buildZaloHandoffTarget({
    phone: '+84912345678',
    uid: '7994906426019206392',
  });
  assert.equal(target.targeted, true);
  assert.equal(target.targetKind, 'phone');
  assert.equal(target.deepLink, 'zalo://conversation?phone=0912345678');
  assert.equal(target.webUrl, 'https://chat.zalo.me/?c=7994906426019206392');
});

test('masked phone is never used and exact UID remains authoritative', () => {
  const target = buildZaloHandoffTarget({ phone: '0912***678', uid: '123456789' });
  assert.equal(target.targetKind, 'uid');
  assert.equal(target.deepLink, null);
  assert.equal(target.webUrl, 'https://chat.zalo.me/?c=123456789');
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
