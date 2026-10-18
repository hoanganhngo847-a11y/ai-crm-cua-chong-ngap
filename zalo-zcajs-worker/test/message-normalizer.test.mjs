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
  assert.equal(result?.content, 'xin chào');
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
