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

test('includes recent 1:1 non-friend conversations and keeps exact thread UID', async () => {
  const api = {
    async getAllFriends() {
      return [{ uid: '810000001', zaloName: 'Friend A' }];
    },
    async getRecentDirectMessages() {
      return [
        {
          type: 0,
          threadId: '810000002',
          isSelf: false,
          data: {
            msgId: 'msg-recent-1',
            uidFrom: '810000002',
            dName: 'Khach chua ket ban',
            content: 'hello',
            ts: Date.now(),
          },
        },
      ];
    },
  };

  assert.deepEqual(await listPersonalZaloContacts(api), [
    { externalUserId: '810000001', displayName: 'Friend A' },
    { externalUserId: '810000002', displayName: 'Khach chua ket ban' },
  ]);
});

test('falls back to recent direct chats if friend directory read fails', async () => {
  const api = {
    async getAllFriends() {
      throw new Error('friend endpoint unavailable');
    },
    async getRecentDirectMessages() {
      return [
        {
          type: 0,
          threadId: '820000001',
          isSelf: true,
          data: {
            msgId: 'msg-recent-2',
            idTo: '820000001',
            content: 'outbound',
            ts: Date.now(),
          },
        },
      ];
    },
  };

  assert.deepEqual(await listPersonalZaloContacts(api), [
    { externalUserId: '820000001' },
  ]);
});

test('fails closed when the pinned ZCAJS API has no supported directory capability', async () => {
  await assert.rejects(
    () => listPersonalZaloContacts({}),
    /ZCAJS_CONTACT_DIRECTORY_UNAVAILABLE/,
  );
});
