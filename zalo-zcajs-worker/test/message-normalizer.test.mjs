import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDirectMessage, ZALO_IMAGE_MARKER } from '../src/message-normalizer.mjs';

test('normalizes inbound text message', () => {
  const result = normalizeDirectMessage({
    type: 0,
    isSelf: false,
    threadId: 'customer-1',
    data: {
      msgId: 'm-text-1',
      uidFrom: 'customer-1',
      dName: 'Khách A',
      ts: '1792335600000',
      content: 'xin chào',
    },
  });

  assert.equal(result?.direction, 'inbound');
  assert.equal(result?.externalUserId, 'customer-1');
  assert.equal(result?.senderName, 'Khách A');
  assert.equal(result?.senderNameSource, 'message_dname');
  assert.equal(result?.content, 'xin chào');
});

test('preserves the Zalo profile-resolved display name source', () => {
  const result = normalizeDirectMessage({
    type: 0,
    isSelf: false,
    threadId: 'customer-profile',
    data: {
      msgId: 'm-profile-1',
      uidFrom: 'customer-profile',
      dName: 'Tên hiển thị trên Zalo PC',
      __zaloNameSource: 'profile_resolved',
      ts: '1792335600000',
      content: 'hello',
    },
  });

  assert.equal(result?.senderName, 'Tên hiển thị trên Zalo PC');
  assert.equal(result?.senderNameSource, 'profile_resolved');
});

test('normalizes Zalo photo attachment into a safe image marker', () => {
  const result = normalizeDirectMessage({
    type: 0,
    isSelf: false,
    threadId: 'customer-2',
    data: {
      msgId: 'm-photo-1',
      uidFrom: 'customer-2',
      msgType: 'chat.photo',
      ts: '1792335600000',
      content: {
        title: '',
        description: '',
        href: 'https://cdn.example.test/photo.jpg',
        thumb: 'https://cdn.example.test/thumb.jpg',
        type: 'image',
        params: '{}',
      },
    },
  });

  assert.equal(result?.direction, 'inbound');
  assert.equal(result?.content, `${ZALO_IMAGE_MARKER}https://cdn.example.test/photo.jpg`);
});

test('normalizes a manual self message as outbound to the peer thread', () => {
  const result = normalizeDirectMessage({
    type: 0,
    isSelf: true,
    threadId: 'customer-3',
    data: {
      msgId: 'm-self-1',
      uidFrom: 'logged-in-user',
      idTo: 'customer-3',
      dName: 'Owner',
      ts: '1792335600000',
      content: 'tin nhắn gửi trực tiếp trên Zalo',
    },
  });

  assert.equal(result?.direction, 'outbound');
  assert.equal(result?.isSelf, true);
  assert.equal(result?.externalUserId, 'customer-3');
  assert.equal(result?.content, 'tin nhắn gửi trực tiếp trên Zalo');
});

test('ignores group messages', () => {
  const result = normalizeDirectMessage({ type: 1, isSelf: false, threadId: 'group', data: {} });
  assert.equal(result, null);
});

test('accepts direct messages when the listener omits the numeric type', () => {
  const result = normalizeDirectMessage({
    isSelf: false,
    threadId: 'customer-4',
    data: {
      msgId: 'm-no-type-1',
      uidFrom: 'customer-4',
      ts: '1792335600000',
      content: 'không có type',
    },
  });

  assert.equal(result?.externalUserId, 'customer-4');
  assert.equal(result?.content, 'không có type');
});

test('keeps attachment-only messages that omit content', () => {
  const photo = normalizeDirectMessage({
    type: 0,
    isSelf: false,
    threadId: 'customer-5',
    data: {
      msgId: 'm-photo-empty-1',
      uidFrom: 'customer-5',
      msgType: 'chat.photo',
      ts: '1792335600000',
    },
  });
  assert.equal(photo?.content, '[Hình ảnh]');

  const file = normalizeDirectMessage({
    type: 0,
    isSelf: false,
    threadId: 'customer-6',
    data: {
      msgId: 'm-file-empty-1',
      uidFrom: 'customer-6',
      msgType: 'chat.file',
      ts: '1792335600000',
    },
  });
  assert.equal(file?.content, '[Tin nhắn đính kèm]');
});
