import assert from 'node:assert/strict';
import test from 'node:test';
import { createGroupDirectory, readGroupDetails } from '../src/group-directory.mjs';

const groupId = '123456789012345678';
const raw = {
  name: 'Nhóm Công trình A', totalMember: 3, creatorId: '11111', adminIds: ['22222'],
  currentMems: [{ id: '11111', dName: 'Anh Nam' }],
  memVerList: ['11111_42', '22222_0', '33333_99'],
};

test('resolves the complete roster beyond the getGroupInfo preview, preserving large string IDs', async () => {
  const calls = [];
  const details = await readGroupDetails({
    getGroupInfo: async (ids) => { assert.deepEqual(ids, [groupId]); return { gridInfoMap: { [groupId]: raw } }; },
    getGroupMembersInfo: async (ids) => {
      calls.push(ids);
      return { profiles: { '22222_0': { displayName: 'Chị Lan' }, '33333_0': { id: '33333', zaloName: 'Anh An' }, unrelated: { displayName: 'Sai người' } } };
    },
  }, groupId);
  assert.equal(details.groupName, raw.name);
  assert.equal(details.totalMember, 3);
  assert.equal(details.membersComplete, true);
  assert.deepEqual(calls, [['22222', '33333']]);
  assert.deepEqual(details.members.map((m) => m.name), ['Anh Nam', 'Chị Lan', 'Anh An']);
  assert.equal(details.members[0].isCreator, true);
  assert.equal(details.members[1].isAdmin, true);
});

test('keeps known member IDs and marks incomplete when profile access is unavailable', async () => {
  const details = await readGroupDetails({ getGroupInfo: async () => ({ gridInfoMap: { [groupId]: raw } }) }, groupId);
  assert.equal(details.totalMember, 3);
  assert.equal(details.members.length, 3);
  assert.equal(details.members[1].name, '');
  assert.equal(details.membersComplete, false);
});

test('refresh bypasses cache and a group event invalidation exposes a rename', async () => {
  let name = 'Tên cũ';
  let calls = 0;
  const api = { getGroupInfo: async () => { calls++; return { gridInfoMap: { [groupId]: { name, totalMember: 0 } } }; } };
  const directory = createGroupDirectory();
  assert.equal((await directory.get(api, groupId)).groupName, name);
  name = 'Tên mới';
  assert.equal((await directory.get(api, groupId)).groupName, 'Tên cũ');
  assert.equal((await directory.get(api, groupId, { force: true })).groupName, name);
  directory.invalidate(groupId);
  await directory.get(api, groupId);
  assert.equal(calls, 3);
});

test('deduplicates simultaneous metadata lookups', async () => {
  let calls = 0;
  const directory = createGroupDirectory();
  const api = { getGroupInfo: async () => { calls++; return { gridInfoMap: { [groupId]: raw } }; } };
  await Promise.all([directory.get(api, groupId), directory.get(api, groupId)]);
  assert.equal(calls, 1);
});
