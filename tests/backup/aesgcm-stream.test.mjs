import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertNoDuplicateNoncePairs } from '../../scripts/backup/aesgcm-stream.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.resolve(HERE, '../../scripts/backup/aesgcm-stream.mjs');
const BACKUP_ID = '20261101T120000Z-11111111-2222-3333-4444-555555555555';
const ALT_BACKUP_ID = '20261101T130000Z-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TEMP_PREFIX = '.aesgcm-stream.tmp-';
const MAGIC = Buffer.from('CRMBKP01', 'ascii');

let workRoot;

before(async () => {
  workRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aesgcm-stream-test-'));
  await fsp.chmod(workRoot, 0o700);
});

after(async () => {
  await fsp.rm(workRoot, { recursive: true, force: true });
});

async function newCase(name) {
  const directory = path.join(workRoot, name);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.chmod(directory, 0o700);
  return directory;
}

async function makeKey(directory, name = 'key', bytes = 32) {
  const keyPath = path.join(directory, name);
  await fsp.writeFile(keyPath, crypto.randomBytes(bytes), { mode: 0o600 });
  await fsp.chmod(keyPath, 0o600);
  return keyPath;
}

function patternBlock(seed) {
  const block = Buffer.alloc(64 * 1024);
  for (let index = 0; index < block.length; index += 1) {
    block[index] = (index * 31 + seed * 17) & 0xff;
  }
  return block;
}

async function makeFile(filePath, size, seed = 1) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const hash = crypto.createHash('sha256');
  const block = patternBlock(seed);
  const handle = await fsp.open(filePath, 'w', 0o600);
  try {
    let written = 0;
    while (written < size) {
      const length = Math.min(block.length, size - written);
      await handle.write(block, 0, length, written);
      hash.update(block.subarray(0, length));
      written += length;
    }
  } finally {
    await handle.close();
  }
  await fsp.chmod(filePath, 0o600);
  return hash.digest('hex');
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function listTempFiles(directory) {
  const entries = await fsp.readdir(directory);
  return entries.filter((entry) => entry.startsWith(TEMP_PREFIX));
}

async function assertNoTempFiles(directory) {
  assert.deepEqual(await listTempFiles(directory), [], 'temporary files must be cleaned up');
}

async function assertMissing(target) {
  await assert.rejects(fsp.lstat(target), (error) => error && error.code === 'ENOENT');
}

function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [HELPER, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function parseJsonLine(text) {
  const lines = text.trim().split('\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 1, `expected exactly one JSON line, got: ${text}`);
  return JSON.parse(lines[0]);
}

function assertFailure(result, expectedCode) {
  assert.notEqual(result.status, 0, `expected failure, stdout=${result.stdout}`);
  const summary = parseJsonLine(result.stderr);
  assert.equal(summary.status, 'failed');
  assert.equal(summary.error.code, expectedCode);
  return summary;
}

function encryptArgs({ input, output, keyFile, backupId = BACKUP_ID, artifact, chunkSize }) {
  const args = [
    'encrypt',
    '--in',
    input,
    '--out',
    output,
    '--key-file',
    keyFile,
    '--backup-id',
    backupId,
    '--artifact',
    artifact,
  ];
  if (chunkSize !== undefined) args.push('--chunk-size', String(chunkSize));
  return args;
}

function decryptArgs({
  input,
  output,
  keyFile,
  backupId = BACKUP_ID,
  artifact,
  expectSha256,
  chunkSize,
}) {
  const args = [
    'decrypt',
    '--in',
    input,
    '--out',
    output,
    '--key-file',
    keyFile,
    '--backup-id',
    backupId,
    '--artifact',
    artifact,
  ];
  if (expectSha256 !== undefined) args.push('--expect-sha256', expectSha256);
  if (chunkSize !== undefined) args.push('--chunk-size', String(chunkSize));
  return args;
}

function encryptFile(args) {
  const result = runCli(encryptArgs(args));
  assert.equal(result.status, 0, result.stderr);
  return parseJsonLine(result.stdout);
}

function decryptFile(args) {
  const result = runCli(decryptArgs(args));
  assert.equal(result.status, 0, result.stderr);
  return parseJsonLine(result.stdout);
}

async function readEnvelope(filePath) {
  const buffer = await fsp.readFile(filePath);
  assert.equal(buffer.subarray(0, MAGIC.length).toString('ascii'), MAGIC.toString('ascii'));
  assert.equal(buffer[MAGIC.length], 1);
  const aadLength = buffer.readUInt32BE(21);
  const aad = buffer.subarray(25, 25 + aadLength).toString('utf8');
  return {
    buffer,
    nonceHex: buffer.subarray(9, 21).toString('hex'),
    aadLength,
    aad,
    ciphertextOffset: 25 + aadLength,
    tagOffset: buffer.length - 16,
  };
}

async function writeEnvelope(filePath, buffer) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(filePath, buffer, { mode: 0o600 });
  await fsp.chmod(filePath, 0o600);
}

function aadFor(backupId, artifact, data) {
  const digest = sha256Buffer(data);
  return `v1|backup=${backupId}|artifact=${artifact}|bytes=${data.length}|sha256=${digest}`;
}

function craftEnvelope({ key, nonce, aad, plaintext }) {
  const aadBuffer = Buffer.from(aad, 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(aadBuffer);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const header = Buffer.alloc(25 + aadBuffer.length);
  MAGIC.copy(header, 0);
  header[MAGIC.length] = 1;
  nonce.copy(header, 9);
  header.writeUInt32BE(aadBuffer.length, 21);
  aadBuffer.copy(header, 25);
  return Buffer.concat([header, ciphertext, tag]);
}

async function writeSums(root, relativePaths, sumsRelativePath = 'manifest/SHA256SUMS') {
  const lines = [];
  for (const relativePath of [...relativePaths].sort()) {
    const digest = await sha256File(path.join(root, relativePath));
    lines.push(`${digest}  ./${relativePath}`);
  }
  const absolute = path.join(root, sumsRelativePath);
  await fsp.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
  await fsp.writeFile(absolute, `${lines.join('\n')}\n`, { mode: 0o600 });
  await fsp.chmod(absolute, 0o600);
}

async function buildSet(root, {
  backupId = BACKUP_ID,
  key,
  files,
  closeoutFiles = [],
  manifestMutator = null,
  manifestText = null,
  manifestNonce = null,
  skipManifest = false,
  skipSums = false,
  closeoutIndexMutator = null,
  closeoutIndexText = null,
} = {}) {
  await fsp.mkdir(path.join(root, 'manifest'), { recursive: true, mode: 0o700 });
  const keyBytes = await fsp.readFile(key);
  const entries = [];
  const fixtureDirectory = path.join(root, '.fixtures');
  await fsp.mkdir(fixtureDirectory, { recursive: true, mode: 0o700 });
  await fsp.chmod(fixtureDirectory, 0o700);

  for (const [index, file] of files.entries()) {
    const artifact = file.artifact;
    const data = file.data ?? Buffer.alloc(0);
    const envelopePath = path.join(root, `${artifact}.aesgcm`);
    await fsp.mkdir(path.dirname(envelopePath), { recursive: true, mode: 0o700 });
    if (file.nonce) {
      const aad = aadFor(backupId, artifact, data);
      const envelope = craftEnvelope({ key: keyBytes, nonce: file.nonce, aad, plaintext: data });
      await writeEnvelope(envelopePath, envelope);
      entries.push({
        path: `${artifact}.aesgcm`,
        kind: 'synthetic',
        encryption: 'AES-256-GCM',
        formatVersion: 1,
        nonceHex: file.nonce.toString('hex'),
        plaintextBytes: data.length,
        plaintextSha256: sha256Buffer(data),
        ciphertextBytes: envelope.length,
        ciphertextSha256: sha256Buffer(envelope),
        aad,
      });
    } else {
      const fixturePath = path.join(fixtureDirectory, `fixture-${index}.bin`);
      await fsp.writeFile(fixturePath, data, { mode: 0o600 });
      await fsp.chmod(fixturePath, 0o600);
      const summary = encryptFile({
        input: fixturePath,
        output: envelopePath,
        keyFile: key,
        backupId,
        artifact,
      });
      entries.push({
        path: `${artifact}.aesgcm`,
        kind: 'synthetic',
        encryption: 'AES-256-GCM',
        formatVersion: 1,
        nonceHex: summary.nonceHex,
        plaintextBytes: summary.plaintextBytes,
        plaintextSha256: summary.plaintextSha256,
        ciphertextBytes: summary.ciphertextBytes,
        ciphertextSha256: summary.ciphertextSha256,
        aad: summary.aad,
      });
    }
  }

  const closeoutEntries = [];
  for (const [index, file] of closeoutFiles.entries()) {
    const artifact = file.artifact;
    const data = file.data ?? Buffer.alloc(0);
    const envelopePath = path.join(root, `${artifact}.aesgcm`);
    await fsp.mkdir(path.dirname(envelopePath), { recursive: true, mode: 0o700 });
    if (file.nonce) {
      const aad = aadFor(backupId, artifact, data);
      const envelope = craftEnvelope({ key: keyBytes, nonce: file.nonce, aad, plaintext: data });
      await writeEnvelope(envelopePath, envelope);
      closeoutEntries.push({
        path: `${artifact}.aesgcm`,
        artifact,
        data,
        summary: {
          nonceHex: file.nonce.toString('hex'),
          plaintextBytes: data.length,
          plaintextSha256: sha256Buffer(data),
          ciphertextBytes: envelope.length,
          ciphertextSha256: sha256Buffer(envelope),
          aad,
        },
      });
    } else {
      const fixturePath = path.join(fixtureDirectory, `closeout-${index}.bin`);
      await fsp.writeFile(fixturePath, data, { mode: 0o600 });
      await fsp.chmod(fixturePath, 0o600);
      const summary = encryptFile({
        input: fixturePath,
        output: envelopePath,
        keyFile: key,
        backupId,
        artifact,
      });
      closeoutEntries.push({ path: `${artifact}.aesgcm`, artifact, data, summary });
    }
  }

  let manifest = {
    format: 'crm-staging-backup-manifest/v1',
    backupId,
    artifacts: entries,
    keys: {
      algorithm: 'AES-256-GCM',
      fingerprint: sha256Buffer(keyBytes),
    },
  };
  if (manifestMutator) manifest = manifestMutator(manifest);
  const manifestPath = path.join(root, 'manifest/backup-manifest.json');
  const text = manifestText ?? `${JSON.stringify(manifest, null, 2)}\n`;
  await fsp.writeFile(manifestPath, text, { mode: 0o600 });
  await fsp.chmod(manifestPath, 0o600);

  let manifestSummary = null;
  if (!skipManifest) {
    const manifestEnvelope = path.join(root, 'manifest/backup-manifest.json.aesgcm');
    if (manifestNonce) {
      const data = Buffer.from(text, 'utf8');
      const aad = aadFor(backupId, 'manifest/backup-manifest.json', data);
      const envelope = craftEnvelope({
        key: keyBytes,
        nonce: manifestNonce,
        aad,
        plaintext: data,
      });
      await writeEnvelope(manifestEnvelope, envelope);
      manifestSummary = {
        nonceHex: manifestNonce.toString('hex'),
        plaintextBytes: data.length,
        plaintextSha256: sha256Buffer(data),
        ciphertextBytes: envelope.length,
        ciphertextSha256: sha256Buffer(envelope),
        aad,
      };
    } else {
      manifestSummary = encryptFile({
        input: manifestPath,
        output: manifestEnvelope,
        keyFile: key,
        backupId,
        artifact: 'manifest/backup-manifest.json',
      });
    }
  }

  if (closeoutEntries.length > 0) {
    const plaintextCloseout = {
      'closeout/offsite-readback-receipt.json': {
        format: 'crm-offsite-readback-receipt/v1',
        backupId,
        status: 'verified',
      },
      'closeout/receipt-storage-record.json': {
        format: 'crm-receipt-storage-record/v1',
        backupId,
      },
      'closeout/receipt-storage-record-object-proof.json': {
        format: 'crm-receipt-storage-record-object-proof/v1',
        backupId,
      },
    };
    for (const [relativePath, value] of Object.entries(plaintextCloseout)) {
      const absolute = path.join(root, relativePath);
      await fsp.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
      await fsp.writeFile(absolute, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await fsp.chmod(absolute, 0o600);
    }

    // Synthetic inventory projection, not a finalized provider index schema.
    const indexArtifacts = [{ path: 'manifest/SHA256SUMS' }];
    if (manifestSummary) {
      indexArtifacts.push({
        path: 'manifest/backup-manifest.json.aesgcm',
        nonceHex: manifestSummary.nonceHex,
        ciphertextSha256: manifestSummary.ciphertextSha256,
      });
    }
    for (const entry of entries) {
      indexArtifacts.push({
        path: entry.path,
        nonceHex: entry.nonceHex,
        ciphertextSha256: entry.ciphertextSha256,
      });
    }
    for (const entry of closeoutEntries) {
      indexArtifacts.push({
        path: entry.path,
        nonceHex: entry.summary.nonceHex,
        ciphertextSha256: entry.summary.ciphertextSha256,
      });
    }
    let index = { backupId, artifacts: indexArtifacts };
    if (closeoutIndexMutator) index = closeoutIndexMutator(index);
    const indexText = closeoutIndexText ?? `${JSON.stringify(index, null, 2)}\n`;
    const indexPath = path.join(root, 'closeout/offsite-bundle-index.json');
    await fsp.writeFile(indexPath, indexText, { mode: 0o600 });
    await fsp.chmod(indexPath, 0o600);
  }

  await fsp.rm(fixtureDirectory, { recursive: true, force: true });
  await fsp.rm(manifestPath, { force: true });

  if (!skipSums) {
    const mainPaths = files.map((file) => `${file.artifact}.aesgcm`);
    if (!skipManifest) mainPaths.push('manifest/backup-manifest.json.aesgcm');
    await writeSums(root, mainPaths);
    if (closeoutEntries.length > 0) {
      await writeSums(
        root,
        [
          ...closeoutEntries.map((entry) => entry.path),
          'closeout/offsite-readback-receipt.json',
          'closeout/receipt-storage-record.json',
          'closeout/receipt-storage-record-object-proof.json',
          'closeout/offsite-bundle-index.json',
        ],
        'closeout/SHA256SUMS',
      );
    }
  }

  return { entries, closeoutEntries, manifest, manifestSummary };
}

function verifySetArgs({
  root,
  keyFile,
  backupId = BACKUP_ID,
  excludePrefix,
  manifest,
  checksums,
  chunkSize,
}) {
  const args = ['verify-set', '--root', root, '--key-file', keyFile, '--backup-id', backupId];
  if (manifest !== undefined) args.push('--manifest', manifest);
  if (checksums !== undefined) args.push('--checksums', checksums);
  if (excludePrefix !== undefined) args.push('--exclude-prefix', excludePrefix);
  if (chunkSize !== undefined) args.push('--chunk-size', String(chunkSize));
  return args;
}

function verifySet(args) {
  const result = runCli(verifySetArgs(args));
  assert.equal(result.status, 0, result.stderr);
  return parseJsonLine(result.stdout);
}

function verifyNonceSetArgs({
  root,
  keyFile,
  backupId = BACKUP_ID,
  manifest,
  supplementalIndex,
  includeManifestEnvelope = false,
  rejectUnlisted = false,
  chunkSize,
}) {
  const args = [
    'verify-nonce-set',
    '--root',
    root,
    '--key-file',
    keyFile,
    '--backup-id',
    backupId,
    '--manifest',
    manifest,
    '--supplemental-index',
    supplementalIndex,
  ];
  if (includeManifestEnvelope) args.push('--include-manifest-envelope');
  if (rejectUnlisted) args.push('--reject-unlisted');
  if (chunkSize !== undefined) args.push('--chunk-size', String(chunkSize));
  return args;
}

function verifyNonceSet(args) {
  const result = runCli(verifyNonceSetArgs(args));
  assert.equal(result.status, 0, result.stderr);
  return parseJsonLine(result.stdout);
}

async function decryptManifestTo(root, keyFile, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fsp.chmod(path.dirname(destination), 0o700);
  return decryptFile({
    input: path.join(root, 'manifest/backup-manifest.json.aesgcm'),
    output: destination,
    keyFile,
    artifact: 'manifest/backup-manifest.json',
  });
}

const CLOSEOUT_PAYLOADS = [
  'closeout/backup-closeout.json.aesgcm',
  'closeout/offsite-readback-receipt.json',
  'closeout/receipt-storage-record.json',
  'closeout/receipt-storage-record-object-proof.json',
  'closeout/offsite-bundle-index.json',
];

async function refreshCloseoutSums(root) {
  await writeSums(root, CLOSEOUT_PAYLOADS, 'closeout/SHA256SUMS');
}

async function recoveryCase(name, options = {}) {
  const directory = await newCase(name);
  const keyFile = await makeKey(directory);
  const built = await buildSet(directory, {
    key: keyFile,
    files: [
      { artifact: 'db/app.dump', data: Buffer.from('synthetic dump') },
      { artifact: 'sql/fingerprint.sql', data: Buffer.from('SELECT 1;') },
      { artifact: 'logs/source.stderr', data: Buffer.from('synthetic log') },
      { artifact: 'future-class/custom.bin', data: Buffer.from('not a fixed prefix') },
    ],
    closeoutFiles: [{ artifact: 'closeout/backup-closeout.json', data: Buffer.from('{}') }],
    ...options,
  });
  const manifest = path.join(workRoot, `${name}-restore/backup-manifest.json`);
  await decryptManifestTo(directory, keyFile, manifest);
  return {
    directory, keyFile, manifest, built,
    nonceArgs: {
      root: directory, keyFile, manifest,
      supplementalIndex: path.join(directory, 'closeout/offsite-bundle-index.json'),
      includeManifestEnvelope: true, rejectUnlisted: true,
    },
  };
}

async function mutateIndex(directory, mutate) {
  const indexPath = path.join(directory, 'closeout/offsite-bundle-index.json');
  const index = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
  await fsp.writeFile(indexPath, `${JSON.stringify(mutate(index))}\n`);
  await refreshCloseoutSums(directory);
}

describe('runbook remediation contracts', () => {
  test('uses exactly the canonical helper path without a second implementation', async () => {
    assert.equal(HELPER, path.resolve(HERE, '../../scripts/backup/aesgcm-stream.mjs'));
    await assertMissing(path.resolve(HERE, '../../scripts/meta-ads/aesgcm-stream.mjs'));
    await assertMissing(path.resolve(HERE, '../meta-ads/aesgcm-stream.test.mjs'));
    const help = runCli(['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /scripts\/backup\/aesgcm-stream\.mjs verify-nonce-set/);
    assert.doesNotMatch(help.stdout, /scripts\/meta-ads/);
  });

  test('executes the verbatim R1 verify-set and verify-nonce-set shell commands', async () => {
    const fixture = await recoveryCase('exact-r1');
    const repoRoot = path.resolve(HERE, '../..');
    const runbook = await fsp.readFile(path.join(repoRoot, 'docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12.md'), 'utf8');
    const commands = [];
    for (const command of ['verify-set', 'verify-nonce-set']) {
      const prefix = `node "$REPO_ROOT/scripts/backup/aesgcm-stream.mjs" ${command} `;
      const start = runbook.indexOf(prefix);
      assert.ok(start >= 0, `missing ${command} invocation in runbook`);
      const lines = runbook.slice(start).split('\n');
      let script = '';
      for (const line of lines) {
        script += `${line}\n`;
        if (!line.endsWith('\\')) break;
      }
      commands.push(script);
    }
    const restoreRoot = path.dirname(path.dirname(fixture.manifest));
    const restoreManifest = path.join(restoreRoot, 'plaintext/backup-manifest.json');
    await fsp.mkdir(path.dirname(restoreManifest), { mode: 0o700 });
    await fsp.copyFile(fixture.manifest, restoreManifest);
    const env = {
      ...process.env, REPO_ROOT: repoRoot, BACKUP_ROOT: fixture.directory,
      RESTORE_ROOT: restoreRoot, KEY_FILE: fixture.keyFile, BACKUP_ID,
    };
    for (const script of commands) {
      const result = spawnSync('/bin/bash', ['-Eeuo', 'pipefail', '-c', script], { env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(parseJsonLine(result.stdout).status, 'ok');
    }
  });

  test('binds the supplied manifest and checksum bytes to the authenticated set', async () => {
    const f = await recoveryCase('supplied-inputs');
    const args = {
      root: f.directory, keyFile: f.keyFile, manifest: f.manifest,
      checksums: path.join(f.directory, 'manifest/SHA256SUMS'), excludePrefix: 'closeout/',
    };
    assert.equal(verifySet(args).suppliedManifest, true);
    const original = await fsp.readFile(f.manifest);
    await fsp.appendFile(f.manifest, '\n');
    assertFailure(runCli(verifySetArgs(args)), 'MANIFEST_SUPPLIED_MISMATCH');
    await fsp.writeFile(f.manifest, original);
    const forged = path.join(workRoot, 'forged-SHA256SUMS');
    await fsp.writeFile(forged, '0'.repeat(64) + '  manifest/backup-manifest.json.aesgcm\n', { mode: 0o600 });
    assertFailure(runCli(verifySetArgs({ ...args, checksums: forged })), 'SUMS_COVERAGE_MISMATCH');
    await assertNoTempFiles(f.directory);
  });

  test('rejects duplicate JSON keys at root, nested and escaped-key positions', async () => {
    for (const [i, transform] of [
      (text) => text.replace('"backupId":', '"backupId":"ignored","backupId":'),
      (text) => text.replace('"fingerprint":', '"fingerprint":"ignored","fingerprint":'),
      (text) => text.replace('"backupId":', '"backup\\u0049d":"ignored","backupId":'),
    ].entries()) {
      const directory = await newCase(`duplicate-json-${i}`);
      const keyFile = await makeKey(directory);
      await buildSet(directory, {
        key: keyFile, files: [{ artifact: 'db/test', data: Buffer.from('x') }],
        manifestMutator: (manifest) => manifest,
        // Create a fully GCM-authenticated manifest containing ambiguous JSON.
        manifestText: transform(JSON.stringify({
          format: 'crm-staging-backup-manifest/v1', backupId: BACKUP_ID, artifacts: [],
          keys: { fingerprint: '0'.repeat(64) },
        })),
      });
      const result = runCli(verifySetArgs({ root: directory, keyFile }));
      assertFailure(result, 'MANIFEST_INVALID');
      assert.match(parseJsonLine(result.stderr).error.message, /duplicate JSON key/);
    }
  });

  test('requires the manifest key fingerprint and rejects exposed child directories', async () => {
    for (const [i, mutate] of [
      (m) => { delete m.keys; return m; },
      (m) => { delete m.keys.fingerprint; return m; },
      (m) => { m.keys.algorithm = 'other'; return m; },
    ].entries()) {
      const f = await recoveryCase(`required-key-fingerprint-${i}`, { manifestMutator: mutate });
      assertFailure(runCli(verifySetArgs({ root: f.directory, keyFile: f.keyFile })), 'MANIFEST_INVALID');
    }
    const f = await recoveryCase('child-mode');
    await fsp.chmod(path.join(f.directory, 'sql'), 0o755);
    assertFailure(runCli(verifySetArgs({ root: f.directory, keyFile: f.keyFile })), 'ARTIFACT_DIRECTORY_PERMISSIONS');
  });

  test('authenticates every main envelope even when forged manifest and checksums match its bad tag', async () => {
    const directory = await newCase('gcm-all-main');
    const keyFile = await makeKey(directory);
    await buildSet(directory, {
      key: keyFile, files: [{ artifact: 'db/app.dump', data: Buffer.from('bytes') }],
      manifestMutator: (manifest) => {
        const filePath = path.join(directory, 'db/app.dump.aesgcm');
        const buffer = fs.readFileSync(filePath);
        buffer[buffer.length - 1] ^= 1;
        fs.writeFileSync(filePath, buffer);
        manifest.artifacts[0].ciphertextSha256 = sha256Buffer(buffer);
        return manifest;
      },
    });
    assertFailure(runCli(verifySetArgs({ root: directory, keyFile })), 'AUTHENTICATION_FAILED');
  });

  test('accepts exactly six closeout files and five lowercase checksum entries', async () => {
    const f = await recoveryCase('closeout-exact');
    const names = await fsp.readdir(path.join(f.directory, 'closeout'));
    assert.deepEqual(names.sort(), [...CLOSEOUT_PAYLOADS.map((p) => path.basename(p)), 'SHA256SUMS'].sort());
    const sums = await fsp.readFile(path.join(f.directory, 'closeout/SHA256SUMS'), 'utf8');
    assert.equal(sums.trimEnd().split('\n').length, 5);
    const summary = verifySet({ root: f.directory, keyFile: f.keyFile, excludePrefix: 'closeout/' });
    assert.equal(summary.closeoutChecksumEntries, 5);
    assert.equal(verifyNonceSet(f.nonceArgs).closeoutChecksumEntries, 5);
  });

  test('rejects missing, extra, duplicate, absolute, traversal and unapproved closeout checksum paths', async () => {
    const f = await recoveryCase('closeout-sums-negative');
    const sumsPath = path.join(f.directory, 'closeout/SHA256SUMS');
    const original = await fsp.readFile(sumsPath, 'utf8');
    const lines = original.trimEnd().split('\n');
    const bad = [
      lines.slice(1).join('\n') + '\n',
      original + lines[0] + '\n',
      [lines[0], lines[0], ...lines.slice(2)].join('\n') + '\n',
      original.replace('./closeout/backup-closeout.json.aesgcm', '/closeout/backup-closeout.json.aesgcm'),
      original.replace('./closeout/backup-closeout.json.aesgcm', 'closeout/../backup-closeout.json.aesgcm'),
      original.replace('./closeout/offsite-readback-receipt.json', 'closeout/not-approved.json'),
      original.replace(/^[0-9a-f]{64}/, 'A'.repeat(64)),
      original.replaceAll('\n', '\r\n'),
      original.replace('./closeout/offsite-readback-receipt.json', 'closeout/SHA256SUMS'),
    ];
    for (const text of bad) {
      await fsp.writeFile(sumsPath, text);
      assertFailure(runCli(verifySetArgs({ root: f.directory, keyFile: f.keyFile, excludePrefix: 'closeout/' })), 'CLOSEOUT_SUMS_INVALID');
    }
    await fsp.writeFile(sumsPath, original);
    assert.equal(verifySet({ root: f.directory, keyFile: f.keyFile, excludePrefix: 'closeout/' }).status, 'ok');
  });

  test('rejects missing, extra, directory, FIFO and symlink closeout directory entries', async () => {
    const f = await recoveryCase('closeout-dir-negative');
    const verify = () => runCli(verifySetArgs({ root: f.directory, keyFile: f.keyFile, excludePrefix: 'closeout/' }));
    const payload = path.join(f.directory, 'closeout/offsite-readback-receipt.json');
    const original = await fsp.readFile(payload);
    await fsp.unlink(payload);
    assertFailure(verify(), 'CLOSEOUT_SET_INVALID');
    await fsp.mkdir(payload, { mode: 0o700 });
    assertFailure(verify(), 'CLOSEOUT_NOT_REGULAR');
    await fsp.rmdir(payload);
    const fifo = spawnSync('mkfifo', [payload], { encoding: 'utf8' });
    assert.equal(fifo.status, 0, fifo.stderr);
    assertFailure(verify(), 'CLOSEOUT_NOT_REGULAR');
    await fsp.unlink(payload);
    await fsp.symlink(f.keyFile, payload);
    assertFailure(verify(), 'ARTIFACT_SYMLINK');
    await fsp.unlink(payload);
    await fsp.writeFile(payload, original, { mode: 0o600 });
    const extra = path.join(f.directory, 'closeout/extra-directory');
    await fsp.mkdir(extra, { mode: 0o700 });
    assertFailure(verify(), 'CLOSEOUT_SET_INVALID');
  });

  test('keeps main checksum validation restricted to encrypted envelopes', async () => {
    const f = await recoveryCase('main-sums-still-strict');
    await fsp.appendFile(path.join(f.directory, 'manifest/SHA256SUMS'), `${'0'.repeat(64)}  closeout/offsite-readback-receipt.json\n`);
    assertFailure(runCli(verifySetArgs({ root: f.directory, keyFile: f.keyFile, excludePrefix: 'closeout/' })), 'SUMS_INVALID');
  });
});

describe('verify-nonce-set adversarial fixtures', () => {
  test('derives all artifact classes including manifest envelope and supplemental closeout', async () => {
    const f = await recoveryCase('nonce-all-classes');
    const summary = verifyNonceSet(f.nonceArgs);
    assert.equal(summary.artifactCount, 4);
    assert.equal(summary.supplementalArtifactCount, 1);
    assert.equal(summary.uniqueNonceCount, 6);
    assert.equal(summary.includedManifestEnvelope, true);
    assert.equal(summary.rejectedUnlisted, true);
    assert.equal(summary.keyId, sha256Buffer(await fsp.readFile(f.keyFile)));
    assert.ok(summary.artifacts.some((entry) => entry.path === 'future-class/custom.bin.aesgcm'));
    // Strong guarantees apply even when callers omit the convenience flags.
    assert.equal(verifyNonceSet({ ...f.nonceArgs, includeManifestEnvelope: false, rejectUnlisted: false }).uniqueNonceCount, 6);
  });

  test('rejects duplicate key/nonce across main classes, manifest and closeout', async () => {
    const nonce = Buffer.alloc(12, 0x73);
    for (const [name, options] of [
      ['main', { files: [
        { artifact: 'sql/query.sql', data: Buffer.from('1'), nonce },
        { artifact: 'logs/error.txt', data: Buffer.from('2'), nonce },
      ] }],
      ['manifest', { files: [{ artifact: 'db/app.dump', data: Buffer.from('3'), nonce }], manifestNonce: nonce }],
      ['closeout', {
        files: [{ artifact: 'db/app.dump', data: Buffer.from('4'), nonce }],
        closeoutFiles: [{ artifact: 'closeout/backup-closeout.json', data: Buffer.from('{}'), nonce }],
      }],
    ]) {
      const f = await recoveryCase(`nonce-duplicate-${name}`, options);
      assertFailure(runCli(verifyNonceSetArgs(f.nonceArgs)), 'NONCE_REUSE');
    }
  });

  test('same nonce under distinct actual keys is a distinct nonce domain', async () => {
    const nonce = Buffer.alloc(12, 0x57);
    const pairs = [];
    for (const name of ['a', 'b']) {
      const f = await recoveryCase(`nonce-separate-key-${name}`, {
        files: [{ artifact: 'db/app.dump', data: Buffer.from(name), nonce }],
      });
      const summary = verifyNonceSet(f.nonceArgs);
      pairs.push({ keyId: summary.keyId, nonceHex: nonce.toString('hex'), owner: name });
    }
    assert.notEqual(pairs[0].keyId, pairs[1].keyId);
    assert.equal(assertNoDuplicateNoncePairs(pairs), 2);
    assert.throws(() => assertNoDuplicateNoncePairs([pairs[0], { ...pairs[0], owner: 'duplicate' }]), { code: 'NONCE_REUSE' });
  });

  test('caller/index keyId cannot hide nonce reuse within the single-key set', async () => {
    const nonce = Buffer.alloc(12, 0x31);
    const f = await recoveryCase('nonce-fake-key-id', {
      files: [{ artifact: 'db/app.dump', data: Buffer.from('x'), nonce }],
      closeoutFiles: [{ artifact: 'closeout/backup-closeout.json', data: Buffer.from('{}'), nonce }],
      closeoutIndexMutator: (index) => ({ ...index, artifacts: index.artifacts.map((entry) => ({ ...entry, keyId: crypto.randomBytes(32).toString('hex') })) }),
    });
    assertFailure(runCli(verifyNonceSetArgs(f.nonceArgs)), 'NONCE_REUSE');
  });

  test('rejects an unlisted encrypted artifact and prunes raw storage bytes per B9', async () => {
    const f = await recoveryCase('nonce-unlisted');
    const extra = path.join(f.directory, 'unknown.aesgcm');
    await fsp.copyFile(path.join(f.directory, 'db/app.dump.aesgcm'), extra);
    assertFailure(runCli(verifyNonceSetArgs(f.nonceArgs)), 'UNLISTED_ENCRYPTED_ARTIFACT');
    await fsp.unlink(extra);
    await fsp.mkdir(path.join(f.directory, 'storage/bytes'), { recursive: true, mode: 0o700 });
    await fsp.writeFile(path.join(f.directory, 'storage/bytes/customer-file.aesgcm'), 'raw source bytes', { mode: 0o600 });
    assert.equal(verifyNonceSet(f.nonceArgs).uniqueNonceCount, 6);
  });

  test('rejects missing inventory entries, duplicates, foreign backup ID and inconsistent metadata', async () => {
    for (const [name, mutate, code] of [
      ['missing-main', (index) => ({ ...index, artifacts: index.artifacts.filter((e) => e.path !== 'db/app.dump.aesgcm') }), 'SUPPLEMENTAL_INDEX_INVALID'],
      ['missing-manifest', (index) => ({ ...index, artifacts: index.artifacts.filter((e) => e.path !== 'manifest/backup-manifest.json.aesgcm') }), 'SUPPLEMENTAL_INDEX_INVALID'],
      ['missing-sums', (index) => ({ ...index, artifacts: index.artifacts.filter((e) => e.path !== 'manifest/SHA256SUMS') }), 'SUPPLEMENTAL_INDEX_INVALID'],
      ['missing-closeout', (index) => ({ ...index, artifacts: index.artifacts.filter((e) => !e.path.startsWith('closeout/')) }), 'SUPPLEMENTAL_INDEX_INVALID'],
      ['extra', (index) => ({ ...index, artifacts: [...index.artifacts, { path: 'rogue.aesgcm' }] }), 'SUPPLEMENTAL_INDEX_INVALID'],
      ['duplicate', (index) => ({ ...index, artifacts: [...index.artifacts, index.artifacts[0]] }), 'SUPPLEMENTAL_INDEX_INVALID'],
      ['backup', (index) => ({ ...index, backupId: ALT_BACKUP_ID }), 'SUPPLEMENTAL_INDEX_BACKUP_ID_MISMATCH'],
      ['nonce', (index) => ({ ...index, artifacts: index.artifacts.map((e) => e.path === 'db/app.dump.aesgcm' ? { ...e, nonceHex: '0'.repeat(24) } : e) }), 'SUPPLEMENTAL_NONCE_MISMATCH'],
      ['manifest-hash', (index) => ({ ...index, artifacts: index.artifacts.map((e) => e.path === 'manifest/backup-manifest.json.aesgcm' ? { ...e, ciphertextSha256: '0'.repeat(64) } : e) }), 'SUPPLEMENTAL_HASH_MISMATCH'],
      ['closeout-hash', (index) => ({ ...index, artifacts: index.artifacts.map((e) => e.path.startsWith('closeout/') ? { ...e, ciphertextSha256: '0'.repeat(64) } : e) }), 'SUPPLEMENTAL_HASH_MISMATCH'],
      ['absolute', (index) => ({ ...index, artifacts: [{ path: '/tmp/a.aesgcm' }, ...index.artifacts] }), 'SUPPLEMENTAL_INDEX_INVALID'],
      ['traversal', (index) => ({ ...index, artifacts: [{ path: 'closeout/../a.aesgcm' }, ...index.artifacts] }), 'SUPPLEMENTAL_INDEX_INVALID'],
      ['ambiguous', (index) => ({ ...index, objects: index.artifacts }), 'SUPPLEMENTAL_INDEX_INVALID'],
    ]) {
      const f = await recoveryCase(`index-negative-${name}`, { closeoutIndexMutator: mutate });
      assertFailure(runCli(verifyNonceSetArgs(f.nonceArgs)), code);
    }
  });

  test('rejects index byte tampering, duplicate JSON keys and missing listed files', async () => {
    const f = await recoveryCase('nonce-index-bytes');
    await fsp.appendFile(f.nonceArgs.supplementalIndex, '\n');
    assertFailure(runCli(verifyNonceSetArgs(f.nonceArgs)), 'CLOSEOUT_HASH_MISMATCH');
    const text = await fsp.readFile(f.nonceArgs.supplementalIndex, 'utf8');
    await fsp.writeFile(f.nonceArgs.supplementalIndex, text.replace('"backupId":', '"backupId":"ignored","backupId":'));
    await refreshCloseoutSums(f.directory);
    assertFailure(runCli(verifyNonceSetArgs(f.nonceArgs)), 'SUPPLEMENTAL_INDEX_INVALID');
    const missing = await recoveryCase('nonce-missing-file');
    await fsp.unlink(path.join(missing.directory, 'logs/source.stderr.aesgcm'));
    assertFailure(runCli(verifyNonceSetArgs(missing.nonceArgs)), 'LISTED_ENCRYPTED_ARTIFACT_MISSING');
  });

  test('authenticates closeout even when an attacker recomputes its index and checksums', async () => {
    const f = await recoveryCase('nonce-closeout-tag');
    const file = path.join(f.directory, 'closeout/backup-closeout.json.aesgcm');
    const buffer = await fsp.readFile(file);
    buffer[buffer.length - 1] ^= 1;
    await fsp.writeFile(file, buffer);
    await mutateIndex(f.directory, (index) => ({ ...index, artifacts: index.artifacts.map((entry) => entry.path === 'closeout/backup-closeout.json.aesgcm' ? { ...entry, ciphertextSha256: sha256Buffer(buffer) } : entry) }));
    assertFailure(runCli(verifyNonceSetArgs(f.nonceArgs)), 'AUTHENTICATION_FAILED');
    assertFailure(runCli(verifySetArgs({ root: f.directory, keyFile: f.keyFile, excludePrefix: 'closeout/' })), 'AUTHENTICATION_FAILED');
  });
});

describe('concurrent input mutation', () => {
  for (const mutation of ['append-during-read', 'append-after-output-fsync', 'replace-pathname']) {
    test(`rejects ${mutation} before plaintext publication`, async () => {
      const directory = await newCase(`toctou-${mutation}`);
      const keyFile = await makeKey(directory);
      const input = path.join(directory, 'plain.bin');
      const envelope = path.join(directory, 'data.aesgcm');
      const output = path.join(directory, 'restored.bin');
      const marker = path.join(directory, 'mutation-fired');
      await makeFile(input, 2 * 1024 * 1024, 81);
      encryptFile({ input, output: envelope, keyFile, artifact: 'db/app.dump' });
      const header = await readEnvelope(envelope);
      const ciphertextOffset = 25 + header.aadLength;
      const preload = path.join(directory, 'concurrent-writer.mjs');
      // Test-only interposition on real file I/O. It deterministically mutates
      // the actual input after stat/read, or after the output fsync. No helper
      // test switches or sleeps are needed to win the race.
      await fsp.writeFile(preload, `
import fsp from 'node:fs/promises';
const originalOpen = fsp.open.bind(fsp);
let fired = false;
async function mutate() {
  if (fired) return;
  fired = true;
  const input = ${JSON.stringify(envelope)};
  if (${JSON.stringify(mutation)} === 'replace-pathname') {
    await fsp.rename(input, input + '.old');
    await fsp.copyFile(input + '.old', input);
  } else {
    await fsp.appendFile(input, Buffer.from([0x42]));
  }
  await fsp.writeFile(${JSON.stringify(marker)}, 'mutated', { mode: 0o600 });
}
fsp.open = async function(...args) {
  const handle = await originalOpen(...args);
  if (args[0] === ${JSON.stringify(envelope)}) {
    const originalRead = handle.read.bind(handle);
    handle.read = async function(...readArgs) {
      const result = await originalRead(...readArgs);
      if (${JSON.stringify(mutation)} !== 'append-after-output-fsync'
        && readArgs[3] >= ${ciphertextOffset}) await mutate();
      return result;
    };
  }
  if (String(args[0]).includes(${JSON.stringify(TEMP_PREFIX)})) {
    const originalSync = handle.sync.bind(handle);
    handle.sync = async function() {
      await originalSync();
      if (${JSON.stringify(mutation)} === 'append-after-output-fsync') await mutate();
    };
  }
  return handle;
};
`, { mode: 0o600 });
      const result = spawnSync(process.execPath, ['--import', preload, HELPER, ...decryptArgs({
        input: envelope, output, keyFile, artifact: 'db/app.dump', chunkSize: 4096,
      })], { encoding: 'utf8' });
      assert.equal(await fsp.readFile(marker, 'utf8'), 'mutated');
      assertFailure(result, mutation === 'replace-pathname' ? 'INPUT_CHANGED' : 'ENVELOPE_TRAILING_BYTES');
      await assertMissing(output);
      await assertNoTempFiles(directory);
    });
  }

  test('reads a key correctly when the filesystem returns short reads', async () => {
    const directory = await newCase('short-key-reads');
    const keyFile = await makeKey(directory);
    const input = path.join(directory, 'plain');
    const output = path.join(directory, 'cipher');
    const restored = path.join(directory, 'restored');
    await fsp.writeFile(input, 'synthetic key short reads', { mode: 0o600 });
    const preload = path.join(directory, 'short-read.mjs');
    await fsp.writeFile(preload, `
import fsp from 'node:fs/promises';
const originalOpen = fsp.open.bind(fsp);
fsp.open = async function(...args) {
  const handle = await originalOpen(...args);
  if (args[0] === ${JSON.stringify(keyFile)}) {
    const originalRead = handle.read.bind(handle);
    handle.read = (buffer, offset, length, position) => originalRead(buffer, offset, Math.min(length, 7), position);
  }
  return handle;
};
`, { mode: 0o600 });
    const result = spawnSync(process.execPath, ['--import', preload, HELPER, ...encryptArgs({ input, output, keyFile, artifact: 'db/app.dump' })], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    decryptFile({ input: output, output: restored, keyFile, artifact: 'db/app.dump' });
    assert.equal(await fsp.readFile(restored, 'utf8'), 'synthetic key short reads');
  });
});

describe('round trip', () => {
  test('encrypts and decrypts empty, one-byte and small files', async () => {
    const directory = await newCase('roundtrip-small');
    const keyFile = await makeKey(directory);
    for (const [index, size] of [0, 1, 1024, 65537].entries()) {
      const artifact = `db/small-${index}.dump`;
      const input = path.join(directory, `plain-${index}.bin`);
      const output = path.join(directory, `envelope-${index}.aesgcm`);
      const restored = path.join(directory, `restored-${index}.bin`);
      const expectedHash = await makeFile(input, size, index + 1);

      const encrypted = encryptFile({ input, output, keyFile, artifact, chunkSize: 1024 });
      assert.equal(encrypted.status, 'ok');
      assert.equal(encrypted.operation, 'encrypt');
      assert.equal(encrypted.artifact, artifact);
      assert.equal(encrypted.plaintextBytes, size);
      assert.equal(encrypted.plaintextSha256, expectedHash);
      assert.match(encrypted.nonceHex, /^[0-9a-f]{24}$/);

      const envelope = await readEnvelope(output);
      assert.equal(envelope.nonceHex, encrypted.nonceHex);
      assert.equal(envelope.aad, encrypted.aad);
      assert.equal(envelope.buffer.length, 25 + envelope.aadLength + size + 16);
      assert.equal(encrypted.ciphertextBytes, envelope.buffer.length);
      assert.equal(encrypted.ciphertextSha256, sha256Buffer(envelope.buffer));
      assert.equal((await fsp.stat(output)).mode & 0o777, 0o600);

      const decrypted = decryptFile({
        input: output,
        output: restored,
        keyFile,
        artifact,
        expectSha256: expectedHash,
        chunkSize: 1024,
      });
      assert.equal(decrypted.status, 'ok');
      assert.equal(decrypted.operation, 'decrypt');
      assert.equal(decrypted.plaintextBytes, size);
      assert.equal(decrypted.plaintextSha256, expectedHash);
      assert.equal(decrypted.ciphertextBytes, encrypted.ciphertextBytes);
      assert.equal(decrypted.ciphertextSha256, encrypted.ciphertextSha256);
      assert.equal(await sha256File(restored), expectedHash);
      assert.equal((await fsp.stat(restored)).mode & 0o777, 0o600);
      await assertNoTempFiles(directory);
    }
  });

  test('supports multiple chunk sizes', async () => {
    const directory = await newCase('roundtrip-chunks');
    const keyFile = await makeKey(directory);
    const artifact = 'db/chunks.dump';
    const input = path.join(directory, 'plain.bin');
    const expectedHash = await makeFile(input, 1024 * 1024 + 123, 7);
    for (const chunkSize of [1024, 4096, 65536, 1024 * 1024, 8 * 1024 * 1024]) {
      const output = path.join(directory, `chunk-${chunkSize}.aesgcm`);
      const restored = path.join(directory, `chunk-${chunkSize}.out`);
      const encrypted = encryptFile({ input, output, keyFile, artifact, chunkSize });
      assert.equal(encrypted.plaintextBytes, 1024 * 1024 + 123);
      const decrypted = decryptFile({
        input: output,
        output: restored,
        keyFile,
        artifact,
        chunkSize,
      });
      assert.equal(decrypted.plaintextSha256, expectedHash);
      assert.equal(await sha256File(restored), expectedHash);
      await assertNoTempFiles(directory);
    }
    for (const invalid of [512, 8 * 1024 * 1024 + 1, 'abc', '0']) {
      const output = path.join(directory, `invalid-${String(invalid).replace(/[^a-z0-9]/gi, '_')}.aesgcm`);
      const result = runCli(encryptArgs({ input, output, keyFile, artifact, chunkSize: invalid }));
      assertFailure(result, 'CHUNK_SIZE_INVALID');
      await assertMissing(output);
    }
  });

  test('streams a 32 MiB file', { timeout: 120_000 }, async () => {
    const directory = await newCase('roundtrip-large');
    const keyFile = await makeKey(directory);
    const artifact = 'db/large.dump';
    const input = path.join(directory, 'large.bin');
    const output = path.join(directory, 'large.aesgcm');
    const restored = path.join(directory, 'large.out');
    const expectedHash = await makeFile(input, 32 * 1024 * 1024, 11);
    const encrypted = encryptFile({ input, output, keyFile, artifact, chunkSize: 65536 });
    assert.equal(encrypted.plaintextBytes, 32 * 1024 * 1024);
    const decrypted = decryptFile({
      input: output,
      output: restored,
      keyFile,
      artifact,
      chunkSize: 65536,
    });
    assert.equal(decrypted.plaintextSha256, expectedHash);
    assert.equal(await sha256File(restored), expectedHash);
    await assertNoTempFiles(directory);
  });
});

describe('fail-closed behavior', () => {
  test('rejects a wrong key without publishing plaintext', async () => {
    const directory = await newCase('wrong-key');
    const keyFile = await makeKey(directory, 'key-a');
    const wrongKey = await makeKey(directory, 'key-b');
    const artifact = 'db/app.dump';
    const input = path.join(directory, 'plain.bin');
    const output = path.join(directory, 'app.dump.aesgcm');
    const restored = path.join(directory, 'restored.bin');
    await makeFile(input, 4096, 2);
    encryptFile({ input, output, keyFile, artifact });
    const result = runCli(decryptArgs({ input: output, output: restored, keyFile: wrongKey, artifact }));
    assertFailure(result, 'AUTHENTICATION_FAILED');
    await assertMissing(restored);
    await assertNoTempFiles(directory);
  });

  test('rejects a wrong --expect-sha256 before publishing plaintext', async () => {
    const directory = await newCase('expect-sha256');
    const keyFile = await makeKey(directory);
    const artifact = 'db/app.dump';
    const input = path.join(directory, 'plain.bin');
    const output = path.join(directory, 'app.dump.aesgcm');
    const restored = path.join(directory, 'restored.bin');
    await makeFile(input, 4096, 12);
    encryptFile({ input, output, keyFile, artifact });
    const result = runCli(decryptArgs({
      input: output,
      output: restored,
      keyFile,
      artifact,
      expectSha256: '0'.repeat(64),
    }));
    assertFailure(result, 'EXPECT_SHA256_MISMATCH');
    await assertMissing(restored);
    await assertNoTempFiles(directory);
  });

  test('rejects wrong AAD backup id, artifact and hash', async () => {
    const directory = await newCase('wrong-aad');
    const keyFile = await makeKey(directory);
    const artifact = 'db/app.dump';
    const input = path.join(directory, 'plain.bin');
    const output = path.join(directory, 'app.dump.aesgcm');
    const data = Buffer.from('twelve bytes');
    assert.equal(data.length, 12);
    await fsp.writeFile(input, data, { mode: 0o600 });
    await fsp.chmod(input, 0o600);
    encryptFile({ input, output, keyFile, artifact });

    assertFailure(
      runCli(decryptArgs({
        input: output,
        output: path.join(directory, 'wrong-artifact.out'),
        keyFile,
        artifact: 'db/other.dump',
      })),
      'AAD_ARTIFACT_MISMATCH',
    );
    assertFailure(
      runCli(decryptArgs({
        input: output,
        output: path.join(directory, 'wrong-backup.out'),
        keyFile,
        backupId: ALT_BACKUP_ID,
        artifact,
      })),
      'AAD_BACKUP_ID_MISMATCH',
    );

    const envelope = await readEnvelope(output);
    const aadStart = 25;
    const aadEnd = 25 + envelope.aadLength;
    const originalAad = envelope.buffer.subarray(aadStart, aadEnd).toString('utf8');

    const hashTampered = Buffer.from(envelope.buffer);
    const hashAad = originalAad.replace(/sha256=[0-9a-f]{64}$/, `sha256=${'0'.repeat(64)}`);
    assert.notEqual(hashAad, originalAad);
    Buffer.from(hashAad, 'utf8').copy(hashTampered, aadStart);
    const hashPath = path.join(directory, 'hash-tampered.aesgcm');
    await writeEnvelope(hashPath, hashTampered);
    assertFailure(
      runCli(decryptArgs({
        input: hashPath,
        output: path.join(directory, 'hash-tampered.out'),
        keyFile,
        artifact,
      })),
      'AUTHENTICATION_FAILED',
    );

    const bytesTampered = Buffer.from(envelope.buffer);
    const bytesAad = originalAad.replace('bytes=12', 'bytes=11');
    assert.notEqual(bytesAad, originalAad);
    Buffer.from(bytesAad, 'utf8').copy(bytesTampered, aadStart);
    const bytesPath = path.join(directory, 'bytes-tampered.aesgcm');
    await writeEnvelope(bytesPath, bytesTampered);
    assertFailure(
      runCli(decryptArgs({
        input: bytesPath,
        output: path.join(directory, 'bytes-tampered.out'),
        keyFile,
        artifact,
      })),
      'CIPHERTEXT_LENGTH_MISMATCH',
    );
    await assertNoTempFiles(directory);
  });

  test('rejects modified ciphertext, modified tag, truncation and trailing bytes', async () => {
    const directory = await newCase('tamper');
    const keyFile = await makeKey(directory);
    const artifact = 'db/app.dump';
    const input = path.join(directory, 'plain.bin');
    const output = path.join(directory, 'app.dump.aesgcm');
    await makeFile(input, 8192, 3);
    encryptFile({ input, output, keyFile, artifact });
    const envelope = await readEnvelope(output);

    const ciphertextTampered = Buffer.from(envelope.buffer);
    ciphertextTampered[envelope.ciphertextOffset + 4] ^= 0x01;
    const ciphertextPath = path.join(directory, 'ciphertext-tampered.aesgcm');
    await writeEnvelope(ciphertextPath, ciphertextTampered);
    assertFailure(
      runCli(decryptArgs({
        input: ciphertextPath,
        output: path.join(directory, 'ciphertext-tampered.out'),
        keyFile,
        artifact,
      })),
      'AUTHENTICATION_FAILED',
    );

    const tagTampered = Buffer.from(envelope.buffer);
    tagTampered[tagTampered.length - 1] ^= 0x01;
    const tagPath = path.join(directory, 'tag-tampered.aesgcm');
    await writeEnvelope(tagPath, tagTampered);
    assertFailure(
      runCli(decryptArgs({
        input: tagPath,
        output: path.join(directory, 'tag-tampered.out'),
        keyFile,
        artifact,
      })),
      'AUTHENTICATION_FAILED',
    );

    const truncatedOne = envelope.buffer.subarray(0, envelope.buffer.length - 1);
    const truncatedPath = path.join(directory, 'truncated-one.aesgcm');
    await writeEnvelope(truncatedPath, truncatedOne);
    assertFailure(
      runCli(decryptArgs({
        input: truncatedPath,
        output: path.join(directory, 'truncated-one.out'),
        keyFile,
        artifact,
      })),
      'CIPHERTEXT_LENGTH_MISMATCH',
    );

    const truncatedHalf = envelope.buffer.subarray(0, Math.floor(envelope.buffer.length / 2));
    const truncatedHalfPath = path.join(directory, 'truncated-half.aesgcm');
    await writeEnvelope(truncatedHalfPath, truncatedHalf);
    assertFailure(
      runCli(decryptArgs({
        input: truncatedHalfPath,
        output: path.join(directory, 'truncated-half.out'),
        keyFile,
        artifact,
      })),
      'CIPHERTEXT_LENGTH_MISMATCH',
    );

    const trailing = Buffer.concat([envelope.buffer, Buffer.from([0x00])]);
    const trailingPath = path.join(directory, 'trailing.aesgcm');
    await writeEnvelope(trailingPath, trailing);
    assertFailure(
      runCli(decryptArgs({
        input: trailingPath,
        output: path.join(directory, 'trailing.out'),
        keyFile,
        artifact,
      })),
      'CIPHERTEXT_LENGTH_MISMATCH',
    );

    for (const outputPath of [
      'ciphertext-tampered.out',
      'tag-tampered.out',
      'truncated-one.out',
      'truncated-half.out',
      'trailing.out',
    ]) {
      await assertMissing(path.join(directory, outputPath));
    }
    await assertNoTempFiles(directory);
  });

  test('rejects invalid magic, version, AAD length and tiny envelopes', async () => {
    const directory = await newCase('bad-header');
    const keyFile = await makeKey(directory);
    const artifact = 'db/app.dump';
    const input = path.join(directory, 'plain.bin');
    const output = path.join(directory, 'app.dump.aesgcm');
    await makeFile(input, 1024, 4);
    encryptFile({ input, output, keyFile, artifact });
    const envelope = await readEnvelope(output);

    const badMagic = Buffer.from(envelope.buffer);
    badMagic[0] ^= 0x01;
    const badMagicPath = path.join(directory, 'bad-magic.aesgcm');
    await writeEnvelope(badMagicPath, badMagic);
    assertFailure(
      runCli(decryptArgs({
        input: badMagicPath,
        output: path.join(directory, 'bad-magic.out'),
        keyFile,
        artifact,
      })),
      'ENVELOPE_MAGIC_INVALID',
    );

    const badVersion = Buffer.from(envelope.buffer);
    badVersion[8] = 0x02;
    const badVersionPath = path.join(directory, 'bad-version.aesgcm');
    await writeEnvelope(badVersionPath, badVersion);
    assertFailure(
      runCli(decryptArgs({
        input: badVersionPath,
        output: path.join(directory, 'bad-version.out'),
        keyFile,
        artifact,
      })),
      'ENVELOPE_VERSION_UNSUPPORTED',
    );

    for (const aadLength of [0, 4097]) {
      const badAad = Buffer.from(envelope.buffer);
      badAad.writeUInt32BE(aadLength, 21);
      const badAadPath = path.join(directory, `bad-aad-${aadLength}.aesgcm`);
      await writeEnvelope(badAadPath, badAad);
      assertFailure(
        runCli(decryptArgs({
          input: badAadPath,
          output: path.join(directory, `bad-aad-${aadLength}.out`),
          keyFile,
          artifact,
        })),
        'AAD_LENGTH_INVALID',
      );
    }

    const tinyPath = path.join(directory, 'tiny.aesgcm');
    await writeEnvelope(tinyPath, Buffer.from('short'));
    assertFailure(
      runCli(decryptArgs({
        input: tinyPath,
        output: path.join(directory, 'tiny.out'),
        keyFile,
        artifact,
      })),
      'ENVELOPE_TOO_SMALL',
    );
    await assertNoTempFiles(directory);
  });

  test('refuses to overwrite an existing output', async () => {
    const directory = await newCase('no-overwrite');
    const keyFile = await makeKey(directory);
    const artifact = 'db/app.dump';
    const input = path.join(directory, 'plain.bin');
    const output = path.join(directory, 'app.dump.aesgcm');
    await makeFile(input, 1024, 5);
    await fsp.writeFile(output, 'sentinel', { mode: 0o600 });
    await fsp.chmod(output, 0o600);
    assertFailure(
      runCli(encryptArgs({ input, output, keyFile, artifact })),
      'OUTPUT_EXISTS',
    );
    assert.equal(await fsp.readFile(output, 'utf8'), 'sentinel');

    const restored = path.join(directory, 'restored.bin');
    await fsp.writeFile(restored, 'sentinel-two', { mode: 0o600 });
    await fsp.chmod(restored, 0o600);
    const envelopePath = path.join(directory, 'fresh.aesgcm');
    encryptFile({ input, output: envelopePath, keyFile, artifact });
    assertFailure(
      runCli(decryptArgs({ input: envelopePath, output: restored, keyFile, artifact })),
      'OUTPUT_EXISTS',
    );
    assert.equal(await fsp.readFile(restored, 'utf8'), 'sentinel-two');
    await assertNoTempFiles(directory);
  });

  test('validates key file mode, size, ownership and symlinks', async () => {
    const directory = await newCase('key-validation');
    const artifact = 'db/app.dump';
    const input = path.join(directory, 'plain.bin');
    await makeFile(input, 1024, 6);

    const goodKey = await makeKey(directory, 'good-key');
    const output = path.join(directory, 'good.aesgcm');
    encryptFile({ input, output, keyFile: goodKey, artifact });

    const looseKey = await makeKey(directory, 'loose-key');
    await fsp.chmod(looseKey, 0o644);
    assertFailure(
      runCli(encryptArgs({
        input,
        output: path.join(directory, 'loose.aesgcm'),
        keyFile: looseKey,
        artifact,
      })),
      'KEY_FILE_PERMISSIONS',
    );

    for (const size of [31, 33]) {
      const wrongSizeKey = await makeKey(directory, `key-${size}`, size);
      assertFailure(
        runCli(encryptArgs({
          input,
          output: path.join(directory, `key-${size}.aesgcm`),
          keyFile: wrongSizeKey,
          artifact,
        })),
        'KEY_FILE_SIZE',
      );
    }

    const keyTarget = await makeKey(directory, 'key-target');
    const keyLink = path.join(directory, 'key-link');
    await fsp.symlink(keyTarget, keyLink);
    assertFailure(
      runCli(encryptArgs({
        input,
        output: path.join(directory, 'key-link.aesgcm'),
        keyFile: keyLink,
        artifact,
      })),
      'KEY_FILE_SYMLINK',
    );
    await assertNoTempFiles(directory);
  });

  test('rejects symlink inputs, symlink outputs and non-private directories', async () => {
    const directory = await newCase('path-validation');
    const keyFile = await makeKey(directory);
    const artifact = 'db/app.dump';
    const input = path.join(directory, 'plain.bin');
    await makeFile(input, 1024, 8);

    const inputLink = path.join(directory, 'plain-link.bin');
    await fsp.symlink(input, inputLink);
    assertFailure(
      runCli(encryptArgs({
        input: inputLink,
        output: path.join(directory, 'input-link.aesgcm'),
        keyFile,
        artifact,
      })),
      'INPUT_SYMLINK',
    );

    const symlinkTarget = path.join(directory, 'target.bin');
    await fsp.writeFile(symlinkTarget, 'target', { mode: 0o600 });
    const outputLink = path.join(directory, 'output-link.aesgcm');
    await fsp.symlink(symlinkTarget, outputLink);
    assertFailure(
      runCli(encryptArgs({ input, output: outputLink, keyFile, artifact })),
      'OUTPUT_SYMLINK',
    );

    const realDirectory = path.join(directory, 'real-dir');
    await fsp.mkdir(realDirectory, { mode: 0o700 });
    await fsp.chmod(realDirectory, 0o700);
    const directoryLink = path.join(directory, 'dir-link');
    await fsp.symlink(realDirectory, directoryLink);
    assertFailure(
      runCli(encryptArgs({
        input,
        output: path.join(directoryLink, 'out.aesgcm'),
        keyFile,
        artifact,
      })),
      'OUTPUT_DIR_SYMLINK',
    );

    const openDirectory = path.join(directory, 'open-dir');
    await fsp.mkdir(openDirectory, { mode: 0o755 });
    await fsp.chmod(openDirectory, 0o755);
    assertFailure(
      runCli(encryptArgs({
        input,
        output: path.join(openDirectory, 'out.aesgcm'),
        keyFile,
        artifact,
      })),
      'OUTPUT_DIR_PERMISSIONS',
    );
    await assertNoTempFiles(directory);
  });

  test('never logs key material or plaintext', async () => {
    const directory = await newCase('no-secrets');
    const keyFile = await makeKey(directory);
    const keyBytes = await fsp.readFile(keyFile);
    const marker = 'TOP_SECRET_PLAINTEXT_MARKER_9f4c1d';
    const artifact = 'db/secret.dump';
    const input = path.join(directory, 'secret.bin');
    const output = path.join(directory, 'secret.aesgcm');
    const restored = path.join(directory, 'secret.out');
    await fsp.writeFile(input, marker, { mode: 0o600 });
    await fsp.chmod(input, 0o600);

    const encrypted = runCli(encryptArgs({ input, output, keyFile, artifact }));
    assert.equal(encrypted.status, 0, encrypted.stderr);
    const decrypted = runCli(decryptArgs({ input: output, output: restored, keyFile, artifact }));
    assert.equal(decrypted.status, 0, decrypted.stderr);
    const wrongKey = await makeKey(directory, 'wrong-key');
    const failed = runCli(decryptArgs({ input: output, output: path.join(directory, 'bad.out'), keyFile: wrongKey, artifact }));
    assertFailure(failed, 'AUTHENTICATION_FAILED');

    const keyHex = keyBytes.toString('hex');
    for (const result of [encrypted, decrypted, failed]) {
      assert.equal(result.stdout.includes(keyHex), false);
      assert.equal(result.stderr.includes(keyHex), false);
      assert.equal(result.stdout.includes(marker), false);
      assert.equal(result.stderr.includes(marker), false);
    }
    assert.equal(await fsp.readFile(restored, 'utf8'), marker);
  });

  test('rejects key material passed as an unsupported option', async () => {
    const directory = await newCase('key-argv');
    const keyFile = await makeKey(directory);
    const artifact = 'db/app.dump';
    const input = path.join(directory, 'plain.bin');
    await makeFile(input, 1024, 9);
    for (const option of ['--key', '--key-hex', '--secret']) {
      const result = runCli([
        'encrypt',
        '--in',
        input,
        '--out',
        path.join(directory, 'out.aesgcm'),
        '--key-file',
        keyFile,
        '--backup-id',
        BACKUP_ID,
        '--artifact',
        artifact,
        option,
        'deadbeef',
      ]);
      assertFailure(result, 'USAGE');
      await assertMissing(path.join(directory, 'out.aesgcm'));
    }
  });
});

describe('verify-set', () => {
  const sampleFiles = () => [
    { artifact: 'db/app.dump', data: Buffer.from('alpha') },
    { artifact: 'db/roles.sql', data: Buffer.from('beta beta') },
    { artifact: 'storage/storage-manifest.json', data: Buffer.from('{}') },
  ];

  test('authenticates the manifest, artifact headers, hashes and nonces', async () => {
    const directory = await newCase('verify-happy');
    const keyFile = await makeKey(directory);
    const { entries } = await buildSet(directory, { key: keyFile, files: sampleFiles() });
    const summary = verifySet({ root: directory, keyFile });
    assert.equal(summary.status, 'ok');
    assert.equal(summary.operation, 'verify-set');
    assert.equal(summary.backupId, BACKUP_ID);
    assert.equal(summary.artifactCount, 3);
    assert.equal(summary.uniqueNonceCount, 4);
    assert.equal(summary.sha256SumsEntries, 4);
    assert.equal(summary.excludedPrefix, null);
    assert.equal(summary.closeoutArtifacts, 0);
    assert.match(summary.manifest.nonceHex, /^[0-9a-f]{24}$/);
    assert.equal(summary.manifest.plaintextSha256.length, 64);
    const manifestEnvelope = await readEnvelope(
      path.join(directory, 'manifest/backup-manifest.json.aesgcm'),
    );
    assert.equal(summary.manifest.ciphertextBytes, manifestEnvelope.buffer.length);
    assert.equal(
      summary.manifest.ciphertextBytes,
      summary.manifest.plaintextBytes + 25 + manifestEnvelope.aadLength + 16,
    );
    assert.deepEqual(
      summary.artifacts.map((entry) => entry.path),
      entries.map((entry) => entry.path),
    );
    await assertNoTempFiles(directory);
  });

  test('rejects a wrong key, wrong backup id, missing manifest and missing sums', async () => {
    const directory = await newCase('verify-negative-basics');
    const keyFile = await makeKey(directory);
    const wrongKey = await makeKey(directory, 'wrong-key');
    await buildSet(directory, { key: keyFile, files: sampleFiles() });

    assertFailure(
      runCli(verifySetArgs({ root: directory, keyFile: wrongKey })),
      'AUTHENTICATION_FAILED',
    );
    assertFailure(
      runCli(verifySetArgs({ root: directory, keyFile, backupId: ALT_BACKUP_ID })),
      'MANIFEST_AAD_MISMATCH',
    );

    const missingManifest = await newCase('verify-missing-manifest');
    const missingManifestKey = await makeKey(missingManifest);
    await buildSet(missingManifest, {
      key: missingManifestKey,
      files: sampleFiles(),
      skipManifest: true,
    });
    assertFailure(
      runCli(verifySetArgs({ root: missingManifest, keyFile: missingManifestKey })),
      'MANIFEST_MISSING',
    );

    const missingSums = await newCase('verify-missing-sums');
    const missingSumsKey = await makeKey(missingSums);
    await buildSet(missingSums, {
      key: missingSumsKey,
      files: sampleFiles(),
      skipSums: true,
    });
    assertFailure(
      runCli(verifySetArgs({ root: missingSums, keyFile: missingSumsKey })),
      'SUMS_MISSING',
    );

    const openRoot = await newCase('verify-open-root');
    const openRootKey = await makeKey(openRoot);
    await buildSet(openRoot, { key: openRootKey, files: sampleFiles() });
    await fsp.chmod(openRoot, 0o755);
    assertFailure(
      runCli(verifySetArgs({ root: openRoot, keyFile: openRootKey })),
      'ROOT_PERMISSIONS',
    );
  });

  test('rejects invalid manifest structure and cross-field mismatches', async () => {
    const cases = [
      {
        name: 'malformed-json',
        build: { manifestText: '{' },
        code: 'MANIFEST_INVALID',
      },
      {
        name: 'wrong-format',
        build: { manifestMutator: (manifest) => ({ ...manifest, format: 'wrong' }) },
        code: 'MANIFEST_INVALID',
      },
      {
        name: 'wrong-backup-id',
        build: { manifestMutator: (manifest) => ({ ...manifest, backupId: ALT_BACKUP_ID }) },
        code: 'MANIFEST_BACKUP_ID_MISMATCH',
      },
      {
        name: 'empty-artifacts',
        build: { manifestMutator: (manifest) => ({ ...manifest, artifacts: [] }) },
        code: 'MANIFEST_INVALID',
      },
      {
        name: 'wrong-aad',
        build: {
          manifestMutator: (manifest) => {
            const copy = structuredClone(manifest);
            copy.artifacts[0].aad = aadFor(BACKUP_ID, 'db/other.dump', Buffer.from('alpha'));
            return copy;
          },
        },
        code: 'MANIFEST_AAD_MISMATCH',
      },
      {
        name: 'wrong-plaintext-sha',
        build: {
          manifestMutator: (manifest) => {
            const copy = structuredClone(manifest);
            copy.artifacts[0].plaintextSha256 = '0'.repeat(64);
            return copy;
          },
        },
        code: 'MANIFEST_AAD_MISMATCH',
      },
      {
        name: 'wrong-nonce',
        build: {
          manifestMutator: (manifest) => {
            const copy = structuredClone(manifest);
            copy.artifacts[0].nonceHex = 'ab'.repeat(12);
            return copy;
          },
        },
        code: 'MANIFEST_NONCE_MISMATCH',
      },
      {
        name: 'wrong-ciphertext-sha',
        build: {
          manifestMutator: (manifest) => {
            const copy = structuredClone(manifest);
            copy.artifacts[0].ciphertextSha256 = '0'.repeat(64);
            return copy;
          },
        },
        code: 'MANIFEST_HASH_MISMATCH',
      },
      {
        name: 'wrong-ciphertext-bytes',
        build: {
          manifestMutator: (manifest) => {
            const copy = structuredClone(manifest);
            copy.artifacts[0].ciphertextBytes += 1;
            return copy;
          },
        },
        code: 'MANIFEST_BYTES_MISMATCH',
      },
      {
        name: 'wrong-encryption',
        build: {
          manifestMutator: (manifest) => {
            const copy = structuredClone(manifest);
            copy.artifacts[0].encryption = 'AES-128-GCM';
            return copy;
          },
        },
        code: 'MANIFEST_INVALID',
      },
      {
        name: 'wrong-format-version',
        build: {
          manifestMutator: (manifest) => {
            const copy = structuredClone(manifest);
            copy.artifacts[0].formatVersion = 2;
            return copy;
          },
        },
        code: 'MANIFEST_INVALID',
      },
      {
        name: 'duplicate-path',
        build: {
          manifestMutator: (manifest) => {
            const copy = structuredClone(manifest);
            copy.artifacts.push(structuredClone(copy.artifacts[0]));
            return copy;
          },
        },
        code: 'MANIFEST_DUPLICATE_PATH',
      },
      {
        name: 'path-traversal',
        build: {
          manifestMutator: (manifest) => {
            const copy = structuredClone(manifest);
            copy.artifacts[0].path = '../evil.aesgcm';
            return copy;
          },
        },
        code: 'ARTIFACT_PATH_INVALID',
      },
      {
        name: 'self-listed',
        build: {
          manifestMutator: (manifest) => {
            const copy = structuredClone(manifest);
            copy.artifacts.push({
              ...structuredClone(copy.artifacts[0]),
              path: 'manifest/backup-manifest.json.aesgcm',
            });
            return copy;
          },
        },
        code: 'ARTIFACT_PATH_INVALID',
      },
      {
        name: 'wrong-key-fingerprint',
        build: {
          manifestMutator: (manifest) => ({
            ...manifest,
            keys: { ...manifest.keys, fingerprint: '0'.repeat(64) },
          }),
        },
        code: 'MANIFEST_KEY_FINGERPRINT_MISMATCH',
      },
    ];

    for (const testCase of cases) {
      const directory = await newCase(`verify-manifest-${testCase.name}`);
      const keyFile = await makeKey(directory);
      await buildSet(directory, {
        key: keyFile,
        files: sampleFiles(),
        ...testCase.build,
      });
      assertFailure(
        runCli(verifySetArgs({ root: directory, keyFile })),
        testCase.code,
      );
    }
  });

  test('rejects checksum coverage, checksum hashes and malformed checksum files', async () => {
    const directory = await newCase('verify-sums');
    const keyFile = await makeKey(directory);
    await buildSet(directory, { key: keyFile, files: sampleFiles() });
    const sumsPath = path.join(directory, 'manifest/SHA256SUMS');
    const original = await fsp.readFile(sumsPath, 'utf8');

    const tampered = original.replace(/^[0-9a-f]{64}/, '0'.repeat(64));
    assert.notEqual(tampered, original);
    await fsp.writeFile(sumsPath, tampered, { mode: 0o600 });
    await fsp.chmod(sumsPath, 0o600);
    assertFailure(runCli(verifySetArgs({ root: directory, keyFile })), 'SUMS_HASH_MISMATCH');

    const missingLine = original.split('\n').filter(Boolean).slice(1).join('\n') + '\n';
    await fsp.writeFile(sumsPath, missingLine, { mode: 0o600 });
    await fsp.chmod(sumsPath, 0o600);
    assertFailure(runCli(verifySetArgs({ root: directory, keyFile })), 'SUMS_COVERAGE_MISMATCH');

    const duplicate = `${original}${original.split('\n')[0]}\n`;
    await fsp.writeFile(sumsPath, duplicate, { mode: 0o600 });
    await fsp.chmod(sumsPath, 0o600);
    assertFailure(runCli(verifySetArgs({ root: directory, keyFile })), 'SUMS_INVALID');

    const malformed = `${original}not-a-checksum-line\n`;
    await fsp.writeFile(sumsPath, malformed, { mode: 0o600 });
    await fsp.chmod(sumsPath, 0o600);
    assertFailure(runCli(verifySetArgs({ root: directory, keyFile })), 'SUMS_INVALID');

    const storageEntry = `${original}${'0'.repeat(64)}  ./storage/bytes/object.aesgcm\n`;
    await fsp.writeFile(sumsPath, storageEntry, { mode: 0o600 });
    await fsp.chmod(sumsPath, 0o600);
    assertFailure(runCli(verifySetArgs({ root: directory, keyFile })), 'SUMS_INVALID');

    await fsp.writeFile(sumsPath, original, { mode: 0o600 });
    await fsp.chmod(sumsPath, 0o600);
    await fsp.chmod(sumsPath, 0o644);
    assertFailure(runCli(verifySetArgs({ root: directory, keyFile })), 'SUMS_INVALID');

    await fsp.chmod(sumsPath, 0o600);
    const linkedSumsRoot = await newCase('verify-sums-symlink');
    const linkedSumsKey = await makeKey(linkedSumsRoot);
    await buildSet(linkedSumsRoot, { key: linkedSumsKey, files: sampleFiles() });
    await fsp.rm(path.join(linkedSumsRoot, 'manifest/SHA256SUMS'));
    await fsp.symlink(
      path.join(directory, 'manifest/SHA256SUMS'),
      path.join(linkedSumsRoot, 'manifest/SHA256SUMS'),
    );
    assertFailure(
      runCli(verifySetArgs({ root: linkedSumsRoot, keyFile: linkedSumsKey })),
      'ARTIFACT_SYMLINK',
    );
  });

  test('detects extra, missing, tampered and non-private artifacts', async () => {
    const extraDirectory = await newCase('verify-extra-artifact');
    const extraKey = await makeKey(extraDirectory);
    await buildSet(extraDirectory, { key: extraKey, files: sampleFiles() });
    const extraSource = path.join(extraDirectory, 'db/app.dump.aesgcm');
    const extraPath = path.join(extraDirectory, 'db/extra.dump.aesgcm');
    await fsp.copyFile(extraSource, extraPath);
    await fsp.chmod(extraPath, 0o600);
    const extraHash = await sha256File(extraPath);
    await fsp.appendFile(
      path.join(extraDirectory, 'manifest/SHA256SUMS'),
      `${extraHash}  ./db/extra.dump.aesgcm\n`,
    );
    await fsp.chmod(path.join(extraDirectory, 'manifest/SHA256SUMS'), 0o600);
    assertFailure(
      runCli(verifySetArgs({ root: extraDirectory, keyFile: extraKey })),
      'ARTIFACT_SET_MISMATCH',
    );

    const missingDirectory = await newCase('verify-missing-artifact');
    const missingKey = await makeKey(missingDirectory);
    await buildSet(missingDirectory, { key: missingKey, files: sampleFiles() });
    await fsp.rm(path.join(missingDirectory, 'db/roles.sql.aesgcm'));
    assertFailure(
      runCli(verifySetArgs({ root: missingDirectory, keyFile: missingKey })),
      'SUMS_COVERAGE_MISMATCH',
    );

    const tamperedDirectory = await newCase('verify-tampered-artifact');
    const tamperedKey = await makeKey(tamperedDirectory);
    await buildSet(tamperedDirectory, { key: tamperedKey, files: sampleFiles() });
    const tamperedPath = path.join(tamperedDirectory, 'db/app.dump.aesgcm');
    const tamperedEnvelope = await readEnvelope(tamperedPath);
    const tamperedBytes = Buffer.from(tamperedEnvelope.buffer);
    tamperedBytes[tamperedEnvelope.ciphertextOffset + 1] ^= 0x01;
    await fsp.writeFile(tamperedPath, tamperedBytes, { mode: 0o600 });
    await fsp.chmod(tamperedPath, 0o600);
    const tamperedHash = await sha256File(tamperedPath);
    const sumsPath = path.join(tamperedDirectory, 'manifest/SHA256SUMS');
    const sumsText = await fsp.readFile(sumsPath, 'utf8');
    await fsp.writeFile(
      sumsPath,
      sumsText.replace(/(^[0-9a-f]{64})(  \.\/db\/app\.dump\.aesgcm$)/m, `${tamperedHash}$2`),
      { mode: 0o600 },
    );
    await fsp.chmod(sumsPath, 0o600);
    assertFailure(
      runCli(verifySetArgs({ root: tamperedDirectory, keyFile: tamperedKey })),
      'MANIFEST_HASH_MISMATCH',
    );

    const permissionDirectory = await newCase('verify-artifact-permissions');
    const permissionKey = await makeKey(permissionDirectory);
    await buildSet(permissionDirectory, { key: permissionKey, files: sampleFiles() });
    await fsp.chmod(path.join(permissionDirectory, 'db/app.dump.aesgcm'), 0o644);
    assertFailure(
      runCli(verifySetArgs({ root: permissionDirectory, keyFile: permissionKey })),
      'ARTIFACT_PERMISSIONS',
    );

    const symlinkDirectory = await newCase('verify-artifact-symlink');
    const symlinkKey = await makeKey(symlinkDirectory);
    await buildSet(symlinkDirectory, { key: symlinkKey, files: sampleFiles() });
    const symlinkTarget = path.join(symlinkDirectory, 'db/app.dump.aesgcm.target');
    await fsp.rename(path.join(symlinkDirectory, 'db/app.dump.aesgcm'), symlinkTarget);
    await fsp.symlink(symlinkTarget, path.join(symlinkDirectory, 'db/app.dump.aesgcm'));
    assertFailure(
      runCli(verifySetArgs({ root: symlinkDirectory, keyFile: symlinkKey })),
      'ARTIFACT_SYMLINK',
    );
  });

  test('detects nonce reuse, including the manifest nonce', async () => {
    const duplicateDirectory = await newCase('verify-duplicate-nonce');
    const duplicateKey = await makeKey(duplicateDirectory);
    const duplicateNonce = Buffer.from('11'.repeat(12), 'hex');
    await buildSet(duplicateDirectory, {
      key: duplicateKey,
      files: [
        { artifact: 'db/a.dump', data: Buffer.from('alpha'), nonce: duplicateNonce },
        { artifact: 'db/b.dump', data: Buffer.from('beta'), nonce: duplicateNonce },
      ],
    });
    assertFailure(
      runCli(verifySetArgs({ root: duplicateDirectory, keyFile: duplicateKey })),
      'NONCE_REUSE',
    );

    const manifestCollisionDirectory = await newCase('verify-manifest-nonce-collision');
    const manifestCollisionKey = await makeKey(manifestCollisionDirectory);
    const collisionNonce = Buffer.from('22'.repeat(12), 'hex');
    await buildSet(manifestCollisionDirectory, {
      key: manifestCollisionKey,
      files: [
        { artifact: 'db/a.dump', data: Buffer.from('alpha'), nonce: collisionNonce },
      ],
      manifestNonce: collisionNonce,
    });
    assertFailure(
      runCli(verifySetArgs({ root: manifestCollisionDirectory, keyFile: manifestCollisionKey })),
      'NONCE_REUSE',
    );
  });

  test('handles the closeout exclusion and its separate checksum file', async () => {
    const directory = await newCase('verify-closeout');
    const keyFile = await makeKey(directory);
    await buildSet(directory, {
      key: keyFile,
      files: sampleFiles(),
      closeoutFiles: [
        { artifact: 'closeout/backup-closeout.json', data: Buffer.from('{"status":"closed"}') },
      ],
    });

    assertFailure(
      runCli(verifySetArgs({ root: directory, keyFile })),
      'SUMS_COVERAGE_MISMATCH',
    );
    const summary = verifySet({
      root: directory,
      keyFile,
      excludePrefix: 'closeout/',
    });
    assert.equal(summary.artifactCount, 3);
    assert.equal(summary.closeoutArtifacts, 1);
    assert.equal(summary.uniqueNonceCount, 5);
    assert.equal(summary.excludedPrefix, 'closeout/');

    assertFailure(
      runCli(verifySetArgs({
        root: directory,
        keyFile,
        excludePrefix: 'other/',
      })),
      'EXCLUDE_PREFIX_INVALID',
    );

    const closeoutSumsPath = path.join(directory, 'closeout/SHA256SUMS');
    const closeoutSums = await fsp.readFile(closeoutSumsPath, 'utf8');
    await fsp.rm(closeoutSumsPath);
    assertFailure(
      runCli(verifySetArgs({ root: directory, keyFile, excludePrefix: 'closeout/' })),
      'CLOSEOUT_SUMS_MISSING',
    );
    await fsp.writeFile(closeoutSumsPath, closeoutSums, { mode: 0o600 });
    await fsp.chmod(closeoutSumsPath, 0o600);
    await fsp.writeFile(
      closeoutSumsPath,
      closeoutSums.replace(/^[0-9a-f]{64}/, '0'.repeat(64)),
      { mode: 0o600 },
    );
    await fsp.chmod(closeoutSumsPath, 0o600);
    assertFailure(
      runCli(verifySetArgs({ root: directory, keyFile, excludePrefix: 'closeout/' })),
      'CLOSEOUT_HASH_MISMATCH',
    );
  });

  test('rejects a closeout with a different backup id', async () => {
    const directory = await newCase('verify-closeout-backup-id');
    const keyFile = await makeKey(directory);
    await buildSet(directory, {
      key: keyFile,
      files: sampleFiles(),
      closeoutFiles: [
        { artifact: 'closeout/backup-closeout.json', data: Buffer.from('{"status":"closed"}') },
      ],
    });
    const closeoutPath = path.join(directory, 'closeout/backup-closeout.json.aesgcm');
    const envelope = await readEnvelope(closeoutPath);
    const aadStart = 25;
    const aadEnd = 25 + envelope.aadLength;
    const originalAad = envelope.buffer.subarray(aadStart, aadEnd).toString('utf8');
    const replacement = originalAad.replace(`backup=${BACKUP_ID}`, `backup=${ALT_BACKUP_ID}`);
    assert.notEqual(replacement, originalAad);
    assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(originalAad));
    Buffer.from(replacement, 'utf8').copy(envelope.buffer, aadStart);
    await writeEnvelope(closeoutPath, envelope.buffer);
    await refreshCloseoutSums(directory);
    assertFailure(
      runCli(verifySetArgs({ root: directory, keyFile, excludePrefix: 'closeout/' })),
      'CLOSEOUT_AAD_MISMATCH',
    );
  });
});

describe('nonce and publication safety', () => {
  test('uses a fresh random nonce for every artifact', async () => {
    const directory = await newCase('nonce-uniqueness');
    const keyFile = await makeKey(directory);
    const input = path.join(directory, 'plain.bin');
    await makeFile(input, 64, 41);
    const nonces = new Set();
    for (let index = 0; index < 64; index += 1) {
      const artifact = `db/nonce-${index}.dump`;
      const output = path.join(directory, `nonce-${index}.aesgcm`);
      const summary = encryptFile({ input, output, keyFile, artifact });
      assert.equal(nonces.has(summary.nonceHex), false, 'nonce must not repeat');
      nonces.add(summary.nonceHex);
      const envelope = await readEnvelope(output);
      assert.equal(envelope.nonceHex, summary.nonceHex);
    }
    assert.equal(nonces.size, 64);
    await assertNoTempFiles(directory);
  });

  test('publishes with no-replace semantics under a concurrent race', { timeout: 120_000 }, async () => {
    const directory = await newCase('concurrent-publish');
    const keyFile = await makeKey(directory);
    const artifact = 'db/race.dump';
    const input = path.join(directory, 'race.bin');
    const output = path.join(directory, 'race.aesgcm');
    const restored = path.join(directory, 'race.out');
    const expectedHash = await makeFile(input, 8 * 1024 * 1024, 42);
    const args = encryptArgs({ input, output, keyFile, artifact, chunkSize: 1024 });
    const [first, second] = await Promise.all([runCliAsync(args), runCliAsync(args)]);
    const statuses = [first.status, second.status].sort((left, right) => left - right);
    assert.deepEqual(statuses, [0, 1]);
    const failure = first.status === 1 ? first : second;
    assertFailure(failure, 'OUTPUT_EXISTS');
    const decrypted = decryptFile({
      input: output,
      output: restored,
      keyFile,
      artifact,
      expectSha256: expectedHash,
      chunkSize: 1024,
    });
    assert.equal(decrypted.plaintextSha256, expectedHash);
    await assertNoTempFiles(directory);
  });
});

describe('interruption and resource limits', () => {
  test('removes temporary plaintext when interrupted with SIGTERM', { timeout: 120_000 }, async () => {
    const directory = await newCase('interrupted-sigterm');
    const keyFile = await makeKey(directory);
    const artifact = 'db/large.dump';
    const input = path.join(directory, 'large.bin');
    const output = path.join(directory, 'large.aesgcm');
    const restored = path.join(directory, 'restored.bin');
    await makeFile(input, 64 * 1024 * 1024, 51);
    encryptFile({ input, output, keyFile, artifact, chunkSize: 1024 * 1024 });

    const child = spawn(
      process.execPath,
      [HELPER, ...decryptArgs({ input: output, output: restored, keyFile, artifact, chunkSize: 1024 })],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const tempName = await waitForTempFile(directory, child);
    assert.ok(tempName, `temporary plaintext was not observed; stdout=${stdout} stderr=${stderr}`);
    assert.equal((await fsp.lstat(path.join(directory, tempName))).mode & 0o777, 0o600);
    child.kill('SIGTERM');
    const exit = await waitForExit(child);
    assert.notEqual(exit.code, 0, 'interrupted decrypt must fail');
    await assertMissing(restored);
    await assertNoTempFiles(directory);
  });

  test('never publishes plaintext when killed with SIGKILL', { timeout: 120_000 }, async () => {
    const directory = await newCase('interrupted-sigkill');
    const keyFile = await makeKey(directory);
    const artifact = 'db/large.dump';
    const input = path.join(directory, 'large.bin');
    const output = path.join(directory, 'large.aesgcm');
    const restored = path.join(directory, 'restored.bin');
    await makeFile(input, 64 * 1024 * 1024, 52);
    encryptFile({ input, output, keyFile, artifact, chunkSize: 1024 * 1024 });

    const child = spawn(
      process.execPath,
      [HELPER, ...decryptArgs({ input: output, output: restored, keyFile, artifact, chunkSize: 1024 })],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const tempName = await waitForTempFile(directory, child);
    assert.ok(tempName, 'temporary plaintext was not observed before SIGKILL');
    child.kill('SIGKILL');
    await waitForExit(child);
    await assertMissing(restored);
    // SIGKILL cannot run the signal handler; the temporary name may remain.
    // It is private (0600) and is not the requested final plaintext path.
    for (const leftover of await listTempFiles(directory)) {
      await fsp.rm(path.join(directory, leftover), { force: true });
    }
  });

  test('keeps memory bounded while streaming a 192 MiB file', { timeout: 240_000 }, async (t) => {
    if (!fs.existsSync('/usr/bin/time')) {
      t.skip('/usr/bin/time is not available');
      return;
    }
    const directory = await newCase('memory');
    const keyFile = await makeKey(directory);
    const artifact = 'db/memory.dump';
    const input = path.join(directory, 'memory.bin');
    const output = path.join(directory, 'memory.aesgcm');
    const restored = path.join(directory, 'memory.out');
    const size = 192 * 1024 * 1024;
    const expectedHash = await makeFile(input, size, 61);

    const encrypted = runWithMemory(
      encryptArgs({ input, output, keyFile, artifact, chunkSize: 1024 * 1024 }),
    );
    assert.equal(encrypted.result.status, 0, encrypted.result.stderr);
    assert.ok(encrypted.maxRssBytes !== null, 'could not measure encrypt RSS');
    assert.ok(
      encrypted.maxRssBytes < 160 * 1024 * 1024,
      `encrypt max RSS ${encrypted.maxRssBytes} exceeds the streaming bound`,
    );

    const decrypted = runWithMemory(
      decryptArgs({ input: output, output: restored, keyFile, artifact, chunkSize: 1024 * 1024 }),
    );
    assert.equal(decrypted.result.status, 0, decrypted.result.stderr);
    assert.ok(decrypted.maxRssBytes !== null, 'could not measure decrypt RSS');
    assert.ok(
      decrypted.maxRssBytes < 160 * 1024 * 1024,
      `decrypt max RSS ${decrypted.maxRssBytes} exceeds the streaming bound`,
    );
    t.diagnostic(`192 MiB RSS: encrypt=${encrypted.maxRssBytes} bytes; decrypt=${decrypted.maxRssBytes} bytes`);
    assert.equal(await sha256File(restored), expectedHash);
  });
});

function runCliAsync(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HELPER, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

async function waitForTempFile(directory, child) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const temps = await listTempFiles(directory);
    if (temps.length > 0) return temps[0];
    if (child.exitCode !== null || child.signalCode !== null) return null;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

function runWithMemory(args) {
  const isDarwin = process.platform === 'darwin';
  const timeArgs = isDarwin ? ['-l'] : ['-v'];
  const result = spawnSync('/usr/bin/time', [...timeArgs, process.execPath, HELPER, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  let maxRssBytes = null;
  if (isDarwin) {
    const match = /(\d+)\s+maximum resident set size/.exec(result.stderr ?? '');
    if (match) maxRssBytes = Number(match[1]);
  } else {
    const match = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(result.stderr ?? '');
    if (match) maxRssBytes = Number(match[1]) * 1024;
  }
  return { result, maxRssBytes };
}
