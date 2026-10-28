import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const patchSource = readFileSync(
  new URL('../patches/patch-zcajs-recent-rest.mjs', import.meta.url),
  'utf8',
);

test('recent Zalo REST recovery forwards manually sent self messages', () => {
  assert.match(patchSource, /this\.listener\.emit\("message", message\)/);
  assert.match(patchSource, /if \(message\.isSelf\) emittedOutbound \+= 1;/);
  assert.match(patchSource, /Recovered recent Zalo DMs via REST/);
  assert.doesNotMatch(
    patchSource,
    /if \(message\.isSelf \|\| \(ownUid && senderUid === ownUid\)\) continue;/,
  );
});

test('recent Zalo REST recovery runs without waiting for the websocket', () => {
  assert.match(patchSource, /const startRecentSync = \(\) => \{/);
  assert.match(patchSource, /this\.listener\.on\("connected", startRecentSync\);/);
  assert.match(patchSource, /startRecentSync\(\);/);
  assert.doesNotMatch(
    patchSource,
    /this\.listener\.on\("closed", \(\) => \{[\s\S]*?recentSyncTimer = undefined;/,
  );
});
