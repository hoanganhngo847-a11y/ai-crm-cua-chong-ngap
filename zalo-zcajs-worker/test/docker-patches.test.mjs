import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const patchScripts = [
  'patch-worker-contact-endpoint.mjs',
  'patch-worker-phone-resolver.mjs',
];

function applyPatch(script, cwd) {
  execFileSync(process.execPath, [path.join(workerRoot, 'patches', script)], {
    cwd,
    stdio: 'pipe',
  });
}

test('Docker worker patches apply cleanly and idempotently to src/index.mjs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcajs-patches-'));
  const indexFile = path.join(dir, 'src', 'index.mjs');
  try {
    await fs.mkdir(path.dirname(indexFile), { recursive: true });
    await fs.copyFile(path.join(workerRoot, 'src', 'index.mjs'), indexFile);

    for (const script of patchScripts) applyPatch(script, dir);

    const patched = await fs.readFile(indexFile, 'utf8');
    assert.match(patched, /import \{ listPersonalZaloContacts \} from '\.\/contact-directory\.mjs';/);
    assert.match(patched, /import \{ resolveExactZaloPhone \} from '\.\/phone-resolver\.mjs';/);
    assert.match(patched, /async function handleContacts\(req, res, url\)/);
    assert.match(patched, /url\.pathname === '\/v1\/contacts'/);
    assert.match(patched, /async function handleResolvePhone\(req, res\)/);
    assert.match(patched, /url\.pathname === '\/v1\/resolve-phone'/);
    execFileSync(process.execPath, ['--check', indexFile], { cwd: dir, stdio: 'pipe' });

    // Re-running the patches during a rebuild must not duplicate handlers/routes.
    for (const script of patchScripts) applyPatch(script, dir);
    assert.equal(await fs.readFile(indexFile, 'utf8'), patched);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
