import assert from 'node:assert/strict';
import test from 'node:test';
import { presentGroupMessage } from '../../features/inbox/utils/group-message';
import {
  ZALO_GROUP_EXTERNAL_REF_PREFIX,
  buildZcaJsSourceMetadata,
  formatGroupMessageContent,
  parseZcaJsInboundPayload,
} from '../../features/omnichannel/zalo/zcajs-inbound';

test('direct messages keep the raw Zalo msgId as external ref', () => {
  const parsed = parseZcaJsInboundPayload({
    messageId: 'm-1',
    externalUserId: '900001',
    senderName: 'Chị Mai',
    content: 'xin chào',
    direction: 'inbound',
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.data.isGroup, false);
  assert.equal(parsed.data.externalRef, 'm-1');
  assert.equal(parsed.data.externalConversationId, '900001');
  assert.equal(parsed.data.content, 'xin chào');
});

test('group messages get the group namespace and a sender prefix', () => {
  const parsed = parseZcaJsInboundPayload({
    messageId: 'g-1',
    externalUserId: 'group:1234567890',
    groupId: '1234567890',
    groupName: 'Nhóm khách biệt thự',
    senderName: 'Anh Nam',
    content: 'Còn hàng không shop?',
    direction: 'inbound',
    isGroup: true,
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.data.isGroup, true);
  assert.equal(parsed.data.groupId, '1234567890');
  assert.equal(parsed.data.externalUserId, 'group:1234567890');
  assert.equal(parsed.data.externalRef, `${ZALO_GROUP_EXTERNAL_REF_PREFIX}g-1`);
  assert.equal(parsed.data.senderName, 'Nhóm khách biệt thự');
  assert.equal(parsed.data.senderDisplayName, 'Anh Nam');
  assert.equal(parsed.data.content, 'Anh Nam: Còn hàng không shop?');

  const metadata = buildZcaJsSourceMetadata(parsed.data);
  assert.equal(metadata.is_group, true);
  assert.equal(metadata.group_name, 'Nhóm khách biệt thự');
  assert.equal(metadata.zalo_display_name, 'Nhóm khách biệt thự');
  assert.equal(metadata.zalo_sender_name, 'Anh Nam');
});

test('group images keep the image marker at the start of a line', () => {
  const content = formatGroupMessageContent(
    '[[ZALO_IMAGE]]https://cdn.example.test/a.jpg',
    'Chị Lan',
    false
  );
  const lines = content.split('\n');
  assert.equal(lines[0], 'Chị Lan:');
  assert.equal(lines[1], '[[ZALO_IMAGE]]https://cdn.example.test/a.jpg');
});

test('group fallback name is produced when Zalo has not resolved the group name yet', () => {
  const parsed = parseZcaJsInboundPayload({
    messageId: 'g-2',
    externalUserId: 'group:99887766',
    senderName: 'Thành viên A',
    content: 'hello',
    direction: 'inbound',
    isGroup: true,
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.data.senderName, 'Nhóm Zalo 7766');
  assert.equal(parsed.data.senderNameSource, 'message_dname');
});

test('rejects a group payload without a numeric group id', () => {
  const parsed = parseZcaJsInboundPayload({
    messageId: 'g-3',
    externalUserId: 'group:not-a-number',
    content: 'hello',
    direction: 'inbound',
    isGroup: true,
  });

  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.error, 'INVALID_GROUP_ID');
});

test('rejects malformed payloads instead of dropping them silently in the route', () => {
  assert.equal(parseZcaJsInboundPayload(null).ok, false);
  assert.equal(
    parseZcaJsInboundPayload({ messageId: 'm', externalUserId: '1', content: '   ' }).ok,
    false
  );
});

test('keeps author identity even without a display name and does not invent a member count', () => {
  const parsed = parseZcaJsInboundPayload({ messageId: 'g-4', externalUserId: 'group:99887766', senderId: '123456789012345678', content: 'hello' });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.data.senderId, '123456789012345678');
  assert.equal(parsed.data.totalMember, undefined);
  assert.match(parsed.data.content, /^Thành viên 123456789012345678:/);
  assert.equal(buildZcaJsSourceMetadata(parsed.data).zalo_sender_id, '123456789012345678');
});

test('keeps unresolved roster IDs and an explicit zero count', () => {
  const parsed = parseZcaJsInboundPayload({ messageId: 'g-5', externalUserId: 'group:99887766', content: 'hello', totalMember: 0, groupMembers: [null, { id: '12345', name: '' }], membersComplete: false });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.data.groupMembers?.length, 1);
  assert.equal(buildZcaJsSourceMetadata(parsed.data).member_count, 0);
  assert.equal(buildZcaJsSourceMetadata(parsed.data).members_complete, false);
});

test('history and realtime present the same author, including names with colons', () => {
  assert.deepEqual(presentGroupMessage('Anh Nam: xin chào', true), { senderName: 'Anh Nam', content: 'xin chào' });
  assert.deepEqual(presentGroupMessage('Nam: Kỹ thuật: xin chào', true, 'Nam: Kỹ thuật'), { senderName: 'Nam: Kỹ thuật', content: 'xin chào' });
  assert.deepEqual(presentGroupMessage('Giá: 500k', false), { senderName: undefined, content: 'Giá: 500k' });
});
