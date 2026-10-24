import test from 'node:test';
import assert from 'node:assert/strict';
import { listPersonalZaloContacts } from '../src/contact-directory.mjs';

test('normalizes, deduplicates and bounds Zalo friend records without exposing extra fields', async () => {
  const api = {
    async getAllFriends() {
      return [
        { uid: '700000001', zaloName: '  Nguyen   Van A  ', phone: '0900000000' },
        { userId: '700000001_0', displayName: 'Duplicate' },
        { user_id: '700000002', display_name: 'Tran B' },
        { uid: 'not-a-zalo-id', displayName: 'Invalid' },
      ];
    },
  };

  assert.deepEqual(await listPersonalZaloContacts(api), [
    { externalUserId: '700000001', displayName: 'Nguyen Van A' },
    { externalUserId: '700000002', displayName: 'Tran B' },
  ]);
});

test('accepts object-shaped friend directory responses', async () => {
  const api = {
    async getAllFriends() {
      return {
        friends: {
          a: { id: '800000001', name: 'A' },
          b: { zaloId: '800000002', username: 'B' },
        },
      };
    },
  };

  assert.deepEqual(await listPersonalZaloContacts(api), [
    { externalUserId: '800000001', displayName: 'A' },
    { externalUserId: '800000002', displayName: 'B' },
  ]);
});

test('fails closed when the pinned ZCAJS API has no friend-directory capability', async () => {
  await assert.rejects(
    () => listPersonalZaloContacts({}),
    /ZCAJS_CONTACT_DIRECTORY_UNAVAILABLE/,
  );
});
