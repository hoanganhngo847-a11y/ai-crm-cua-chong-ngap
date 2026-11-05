import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPECTED_IMAGE_DIGEST,
  EXPECTED_SUPABASE_IMAGE,
  extractBaselineFromContainer,
} from '../../scripts/backup/extract-platform-acl-baseline.mjs';

const imageId = `sha256:${'a'.repeat(64)}`;
const expectedRepo = EXPECTED_SUPABASE_IMAGE.split(':')[0];

function makeRunner({ repoDigests, serverVersion }) {
  const calls = [];
  const runCommand = (_command, args) => {
    calls.push(args);
    if (args[0] === 'inspect') return `${imageId}\n`;
    if (args[0] === 'image') return JSON.stringify(repoDigests);
    if (args[0] === 'exec' && args.at(-1) === 'SHOW server_version;') return `${serverVersion}\n`;
    throw new Error('Unexpected command: ' + args.join(' '));
  };
  return { runCommand, calls };
}

test('platform ACL extractor rejects a container without the exact pinned Supabase image digest', () => {
  const { runCommand, calls } = makeRunner({
    repoDigests: [`${expectedRepo}@sha256:${'0'.repeat(64)}`],
    serverVersion: '17.11',
  });
  assert.throws(() => extractBaselineFromContainer('test-postgres', runCommand), /image digest mismatch/);
  assert.equal(calls.length, 2, 'must stop before connecting to PostgreSQL');
});

test('platform ACL extractor rejects a container with an unexpected PostgreSQL version', () => {
  const { runCommand, calls } = makeRunner({
    repoDigests: [`${expectedRepo}@${EXPECTED_IMAGE_DIGEST}`],
    serverVersion: '16.9',
  });
  assert.throws(() => extractBaselineFromContainer('test-postgres', runCommand), /server version mismatch/);
  assert.equal(calls.length, 3, 'must stop before querying relation or column catalogs');
});
