import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CLOSEOUT_PAYLOADS,
  canonicalizeJsonJcs,
  parseJsonStrict,
  validateAgainstSchema,
  validateBundleIndex,
  OFFSITE_BUNDLE_INDEX_SCHEMA,
} from '../../scripts/backup/contracts/offsite-bundle-index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const OFFSITE_HELPER = path.join(REPO_ROOT, 'scripts/backup/offsite-bundle.mjs');
const AESGCM_HELPER = path.join(REPO_ROOT, 'scripts/backup/aesgcm-stream.mjs');

function runCli(command, args, options = {}) {
  const result = spawnSync('node', [command, ...args], {
    encoding: 'utf8',
    ...options,
  });
  return result;
}

function parseJsonStdout(res) {
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(`Failed to parse stdout JSON: ${res.stdout}\nStderr: ${res.stderr}`);
  }
}

function parseJsonStderr(res) {
  try {
    return JSON.parse(res.stderr);
  } catch {
    throw new Error(`Failed to parse stderr JSON: ${res.stderr}\nStdout: ${res.stdout}`);
  }
}

async function createSyntheticEnvironment(baseDir, options = {}) {
  const backupId = options.backupId ?? '20261101T140000Z-11111111-2222-3333-4444-555555555555';
  const projectRef = options.projectRef ?? 'qmhfmgkymjgoevwmkidm';
  const tmp = await fsp.mkdtemp(path.join(baseDir, 'offsite-bundle-test-'));
  await fsp.chmod(tmp, 0o700);

  const key = options.key ?? crypto.randomBytes(32);
  const keyFile = path.join(tmp, 'key.bin');
  await fsp.writeFile(keyFile, key, { mode: 0o600 });

  for (const dir of ['db', 'sql', 'logs', 'future-class', 'manifest', 'closeout']) {
    await fsp.mkdir(path.join(tmp, dir), { mode: 0o700, recursive: true });
  }

  function encryptArtifact(plainText, plainArtifactPath, destPath, explicitNonce = null) {
    const plainFile = path.join(tmp, 'plain.tmp');
    fs.writeFileSync(plainFile, plainText, { mode: 0o600 });
    const fullDest = path.join(tmp, destPath);
    const res = runCli(AESGCM_HELPER, [
      'encrypt',
      '--in', plainFile,
      '--out', fullDest,
      '--key-file', keyFile,
      '--backup-id', backupId,
      '--artifact', plainArtifactPath,
    ]);
    fs.rmSync(plainFile, { force: true });
    if (res.status !== 0) throw new Error(`encrypt failed: ${res.stderr}`);
    const meta = JSON.parse(res.stdout);

    if (explicitNonce) {
      // Modify nonce in header if explicitNonce requested
      const buf = fs.readFileSync(fullDest);
      explicitNonce.copy(buf, 9);
      fs.writeFileSync(fullDest, buf, { mode: 0o600 });
      meta.nonceHex = explicitNonce.toString('hex');
    }
    return meta;
  }

  const dbMeta = encryptArtifact('DUMP_PAYLOAD', 'db/app.dump', 'db/app.dump.aesgcm');
  const sqlMeta = encryptArtifact('SQL_SCHEMA', 'sql/fingerprint.sql', 'sql/fingerprint.sql.aesgcm');
  const logsMeta = encryptArtifact('LOGS_DATA', 'logs/source.stderr', 'logs/source.stderr.aesgcm');
  const customMeta = encryptArtifact('CUSTOM_BIN', 'future-class/custom.bin', 'future-class/custom.bin.aesgcm');

  const manifestObj = {
    format: 'crm-staging-backup-manifest/v1',
    backupId,
    keys: {
      algorithm: 'AES-256-GCM',
      fingerprint: crypto.createHash('sha256').update(key).digest('hex'),
    },
    artifacts: [
      {
        path: 'db/app.dump.aesgcm',
        encryption: 'AES-256-GCM',
        formatVersion: 1,
        nonceHex: dbMeta.nonceHex,
        plaintextBytes: dbMeta.plaintextBytes,
        plaintextSha256: dbMeta.plaintextSha256,
        ciphertextBytes: dbMeta.ciphertextBytes,
        ciphertextSha256: dbMeta.ciphertextSha256,
        aad: dbMeta.aad,
      },
      {
        path: 'sql/fingerprint.sql.aesgcm',
        encryption: 'AES-256-GCM',
        formatVersion: 1,
        nonceHex: sqlMeta.nonceHex,
        plaintextBytes: sqlMeta.plaintextBytes,
        plaintextSha256: sqlMeta.plaintextSha256,
        ciphertextBytes: sqlMeta.ciphertextBytes,
        ciphertextSha256: sqlMeta.ciphertextSha256,
        aad: sqlMeta.aad,
      },
      {
        path: 'logs/source.stderr.aesgcm',
        encryption: 'AES-256-GCM',
        formatVersion: 1,
        nonceHex: logsMeta.nonceHex,
        plaintextBytes: logsMeta.plaintextBytes,
        plaintextSha256: logsMeta.plaintextSha256,
        ciphertextBytes: logsMeta.ciphertextBytes,
        ciphertextSha256: logsMeta.ciphertextSha256,
        aad: logsMeta.aad,
      },
      {
        path: 'future-class/custom.bin.aesgcm',
        encryption: 'AES-256-GCM',
        formatVersion: 1,
        nonceHex: customMeta.nonceHex,
        plaintextBytes: customMeta.plaintextBytes,
        plaintextSha256: customMeta.plaintextSha256,
        ciphertextBytes: customMeta.ciphertextBytes,
        ciphertextSha256: customMeta.ciphertextSha256,
        aad: customMeta.aad,
      },
    ],
  };

  const manifestPlain = path.join(tmp, 'manifest/backup-manifest.json');
  await fsp.writeFile(manifestPlain, JSON.stringify(manifestObj, null, 2), { mode: 0o600 });
  encryptArtifact(
    await fsp.readFile(manifestPlain),
    'manifest/backup-manifest.json',
    'manifest/backup-manifest.json.aesgcm',
  );

  // Generate manifest/SHA256SUMS covering main artifacts + manifest envelope
  const mainEnvelopes = [
    'db/app.dump.aesgcm',
    'sql/fingerprint.sql.aesgcm',
    'logs/source.stderr.aesgcm',
    'future-class/custom.bin.aesgcm',
    'manifest/backup-manifest.json.aesgcm',
  ];
  let sumsContent = '';
  for (const rel of mainEnvelopes) {
    const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(tmp, rel))).digest('hex');
    sumsContent += `${h}  ${rel}\n`;
  }
  const manifestSumsPath = path.join(tmp, 'manifest/SHA256SUMS');
  await fsp.writeFile(manifestSumsPath, sumsContent, { mode: 0o600 });

  // Closeout payload 1: backup-closeout.json.aesgcm
  const closeoutPlain = JSON.stringify({ closeoutState: 'complete', backupId });
  encryptArtifact(closeoutPlain, 'closeout/backup-closeout.json', 'closeout/backup-closeout.json.aesgcm');

  // Closeout payload 2: offsite-readback-receipt.json
  const receiptData = { format: 'crm-offsite-readback-receipt/v1', backupId, verified: true };
  const receiptPath = path.join(tmp, 'closeout/offsite-readback-receipt.json');
  await fsp.writeFile(receiptPath, JSON.stringify(receiptData, null, 2), { mode: 0o600 });

  // Closeout payload 3: receipt-storage-record.json
  const recordData = { format: 'crm-receipt-storage-record/v1', backupId, stored: true };
  const recordPath = path.join(tmp, 'closeout/receipt-storage-record.json');
  await fsp.writeFile(recordPath, JSON.stringify(recordData, null, 2), { mode: 0o600 });

  // Closeout payload 4: receipt-storage-record-object-proof.json (strictly canonical JCS)
  const proofObj = { format: 'crm-receipt-storage-record-object-proof/v1', status: 'verified', backupId };
  const proofCanonicalText = canonicalizeJsonJcs(proofObj);
  const proofPath = path.join(tmp, 'closeout/receipt-storage-record-object-proof.json');
  await fsp.writeFile(proofPath, Buffer.from(proofCanonicalText, 'utf8'), { mode: 0o600 });

  // Approved destination record
  const destRecord = {
    destination: {
      provider: 'supabase-storage',
      destinationId: 'staging-cold-backup-worm',
      bucket: 'cold-backups-staging',
      prefix: backupId,
    },
    projectRef,
  };
  const destRecordPath = path.join(tmp, 'approved-destination.json');
  await fsp.writeFile(destRecordPath, JSON.stringify(destRecord, null, 2), { mode: 0o600 });

  const indexPath = path.join(tmp, 'closeout/offsite-bundle-index.json');
  const closeoutSumsPath = path.join(tmp, 'closeout/SHA256SUMS');

  function writeCloseoutSums() {
    let closeoutSums = '';
    for (const rel of CLOSEOUT_PAYLOADS) {
      const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(tmp, rel))).digest('hex');
      closeoutSums += `${h}  ${rel}\n`;
    }
    fs.writeFileSync(closeoutSumsPath, closeoutSums, { mode: 0o600 });
  }

  return {
    root: tmp,
    backupId,
    projectRef,
    keyFile,
    manifestPlain,
    manifestCiphertext: path.join(tmp, 'manifest/backup-manifest.json.aesgcm'),
    receiptPath,
    recordPath,
    proofPath,
    destRecordPath,
    indexPath,
    closeoutSumsPath,
    writeCloseoutSums,
    cleanup: async () => {
      await fsp.rm(tmp, { recursive: true, force: true });
    },
  };
}

describe('offsite-bundle.mjs helper suite', () => {
  let tmpRoot;

  test('setup test directory', async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'offsite-bundle-main-'));
    await fsp.chmod(tmpRoot, 0o700);
  });

  // --------------------------------------------------------------------------
  // 1. CANONICALIZATION SUITE
  // --------------------------------------------------------------------------
  describe('canonicalize-storage-record-proof and verify-canonical', () => {
    test('canonicalizes non-canonical proof in-place atomically', async () => {
      const proofFile = path.join(tmpRoot, 'test-proof.json');
      const unformatted = '{\n  "z": 1,\n  "a": "alpha",\n  "m": [3, 2, 1]\n}\n';
      await fsp.writeFile(proofFile, unformatted, { mode: 0o600 });

      // Verification before canonicalization must fail
      const preCheck = runCli(OFFSITE_HELPER, [
        'verify-canonical-storage-record-proof',
        '--proof', proofFile,
        '--format', 'rfc8785-jcs-utf8-no-newline',
      ]);
      assert.equal(preCheck.status, 1);
      const preErr = parseJsonStderr(preCheck);
      assert.equal(preErr.error.code, 'PROOF_NOT_CANONICAL');

      // Canonicalize with --in-place-atomic
      const canonRes = runCli(OFFSITE_HELPER, [
        'canonicalize-storage-record-proof',
        '--proof', proofFile,
        '--format', 'rfc8785-jcs-utf8-no-newline',
        '--in-place-atomic',
      ]);
      assert.equal(canonRes.status, 0);
      const canonOut = parseJsonStdout(canonRes);
      assert.equal(canonOut.status, 'ok');
      assert.equal(canonOut.canonicalized, true);

      // Verify canonical bytes on disk
      const onDiskBytes = await fsp.readFile(proofFile);
      const onDiskText = onDiskBytes.toString('utf8');
      assert.equal(onDiskText, '{"a":"alpha","m":[3,2,1],"z":1}');
      assert.equal(onDiskText.includes('\n'), false);

      // Verification after canonicalization must pass
      const postCheck = runCli(OFFSITE_HELPER, [
        'verify-canonical-storage-record-proof',
        '--proof', proofFile,
        '--format', 'rfc8785-jcs-utf8-no-newline',
      ]);
      assert.equal(postCheck.status, 0);
      const postOut = parseJsonStdout(postCheck);
      assert.equal(postOut.status, 'ok');
      assert.equal(postOut.canonical, true);
    });

    test('rejects unsupported format argument', () => {
      const res = runCli(OFFSITE_HELPER, [
        'canonicalize-storage-record-proof',
        '--proof', path.join(tmpRoot, 'any.json'),
        '--format', 'unsupported-format',
      ]);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /unsupported format/);
    });

    test('rejects symlink proof file', async () => {
      const target = path.join(tmpRoot, 'real-target.json');
      await fsp.writeFile(target, '{}', { mode: 0o600 });
      const symlink = path.join(tmpRoot, 'symlink-proof.json');
      await fsp.symlink(target, symlink);

      const res = runCli(OFFSITE_HELPER, [
        'verify-canonical-storage-record-proof',
        '--proof', symlink,
        '--format', 'rfc8785-jcs-utf8-no-newline',
      ]);
      assert.equal(res.status, 1);
      assert.equal(parseJsonStderr(res).error.code, 'PROOF_SYMLINK');
    });
  });

  // --------------------------------------------------------------------------
  // 2. PRODUCER BUILD-INDEX SUITE
  // --------------------------------------------------------------------------
  describe('producer build-index', () => {
    test('builds valid Contract v1 index from synthetic backup set', async () => {
      const env = await createSyntheticEnvironment(tmpRoot);
      try {
        const res = runCli(OFFSITE_HELPER, [
          'build-index',
          '--root', env.root,
          '--key-file', env.keyFile,
          '--backup-id', env.backupId,
          '--main-manifest-ciphertext', env.manifestCiphertext,
          '--receipt', env.receiptPath,
          '--receipt-storage-record', env.recordPath,
          '--receipt-storage-record-object-proof', env.proofPath,
          '--approved-destination-record', env.destRecordPath,
          '--out', env.indexPath,
        ]);

        assert.equal(res.status, 0, `build-index failed: ${res.stderr}`);
        const out = parseJsonStdout(res);
        assert.equal(out.status, 'ok');
        assert.equal(out.totalArtifacts, 7);
        assert.equal(out.encryptedArtifactCount, 6);
        assert.equal(out.evidenceLevel, 'local-synthetic-preparation-only');

        // Check index file on disk
        const indexRaw = await fsp.readFile(env.indexPath, 'utf8');
        const indexObj = parseJsonStrict(indexRaw, 'produced index');

        // 1. Schema check
        validateAgainstSchema(OFFSITE_BUNDLE_INDEX_SCHEMA, indexObj);

        // 2. Business invariants check
        const inv = validateBundleIndex(indexObj);
        assert.equal(inv.valid, true);
        assert.equal(inv.totalArtifacts, 7);
        assert.equal(inv.encryptedCount, 6);

        // 3. Verify specific rules:
        // - checksum_file (manifest/SHA256SUMS) MUST omit nonceHex
        const sumsEntry = indexObj.artifacts.find((a) => a.path === 'manifest/SHA256SUMS');
        assert.ok(sumsEntry);
        assert.equal(sumsEntry.kind, 'checksum_file');
        assert.equal(Object.hasOwn(sumsEntry, 'nonceHex'), false);

        // - encrypted artifacts must carry 24-hex nonce
        const dbEntry = indexObj.artifacts.find((a) => a.path === 'db/app.dump.aesgcm');
        assert.ok(dbEntry);
        assert.equal(dbEntry.kind, 'encrypted_artifact');
        assert.match(dbEntry.nonceHex, /^[0-9a-f]{24}$/);

        // - manifest_envelope
        const manifestEntry = indexObj.artifacts.find((a) => a.path === 'manifest/backup-manifest.json.aesgcm');
        assert.ok(manifestEntry);
        assert.equal(manifestEntry.kind, 'manifest_envelope');

        // - closeout_envelope
        const closeoutEntry = indexObj.artifacts.find((a) => a.path === 'closeout/backup-closeout.json.aesgcm');
        assert.ok(closeoutEntry);
        assert.equal(closeoutEntry.kind, 'closeout_envelope');

        // - storageRecordProof matches raw proof bytes
        const proofBytes = await fsp.readFile(env.proofPath);
        assert.equal(indexObj.storageRecordProof.proofBytesBase64, proofBytes.toString('base64'));
        assert.equal(indexObj.storageRecordProof.proofSha256, crypto.createHash('sha256').update(proofBytes).digest('hex'));

        // - circular dependencies prevention
        assert.equal(indexObj.artifacts.some((a) => a.path === 'closeout/SHA256SUMS'), false);
        assert.equal(indexObj.artifacts.some((a) => a.path === 'closeout/offsite-bundle-index.json'), false);
      } finally {
        await env.cleanup();
      }
    });

    test('refuses to overwrite existing output (OUTPUT_EXISTS)', async () => {
      const env = await createSyntheticEnvironment(tmpRoot);
      try {
        // Pre-create the output path
        await fsp.writeFile(env.indexPath, 'existing', { mode: 0o600 });

        const res = runCli(OFFSITE_HELPER, [
          'build-index',
          '--root', env.root,
          '--key-file', env.keyFile,
          '--backup-id', env.backupId,
          '--main-manifest-ciphertext', env.manifestCiphertext,
          '--receipt', env.receiptPath,
          '--receipt-storage-record', env.recordPath,
          '--receipt-storage-record-object-proof', env.proofPath,
          '--approved-destination-record', env.destRecordPath,
          '--out', env.indexPath,
        ]);

        assert.equal(res.status, 1);
        const err = parseJsonStderr(res);
        assert.equal(err.error.code, 'OUTPUT_EXISTS');
      } finally {
        await env.cleanup();
      }
    });
  });

  // --------------------------------------------------------------------------
  // 3. PRODUCER-CONSUMER INTEGRATION SUITE
  // --------------------------------------------------------------------------
  describe('producer-consumer integration with aesgcm-stream.mjs', () => {
    test('aesgcm-stream.mjs verify-nonce-set accepts index created by offsite-bundle.mjs', async () => {
      const env = await createSyntheticEnvironment(tmpRoot);
      try {
        // 1. Producer builds the index
        const buildRes = runCli(OFFSITE_HELPER, [
          'build-index',
          '--root', env.root,
          '--key-file', env.keyFile,
          '--backup-id', env.backupId,
          '--main-manifest-ciphertext', env.manifestCiphertext,
          '--receipt', env.receiptPath,
          '--receipt-storage-record', env.recordPath,
          '--receipt-storage-record-object-proof', env.proofPath,
          '--approved-destination-record', env.destRecordPath,
          '--out', env.indexPath,
        ]);
        assert.equal(buildRes.status, 0);

        // 2. Generate closeout checksums
        env.writeCloseoutSums();

        // 3. Verify with offsite-bundle.mjs verify-index
        const verifyIndexRes = runCli(OFFSITE_HELPER, [
          'verify-index',
          '--root', env.root,
          '--main-manifest', env.manifestPlain,
          '--receipt', env.receiptPath,
          '--receipt-storage-record', env.recordPath,
          '--receipt-storage-record-object-proof', env.proofPath,
          '--index', env.indexPath,
          '--checksums', env.closeoutSumsPath,
          '--approved-destination-record', env.destRecordPath,
          '--backup-id', env.backupId,
          '--project-ref', env.projectRef,
        ]);
        assert.equal(verifyIndexRes.status, 0, `verify-index failed: ${verifyIndexRes.stderr}`);
        const verifyIndexOut = parseJsonStdout(verifyIndexRes);
        assert.equal(verifyIndexOut.status, 'ok');
        assert.equal(verifyIndexOut.verifiedArtifactCount, 7);
        assert.equal(verifyIndexOut.verifiedCloseoutPayloads, 5);

        // 4. Verbatim R1 verify-nonce-set execution by aesgcm-stream.mjs
        const verifyNonceRes = runCli(AESGCM_HELPER, [
          'verify-nonce-set',
          '--root', env.root,
          '--key-file', env.keyFile,
          '--backup-id', env.backupId,
          '--manifest', env.manifestPlain,
          '--supplemental-index', env.indexPath,
          '--include-manifest-envelope',
          '--reject-unlisted',
        ]);

        assert.equal(verifyNonceRes.status, 0, `verify-nonce-set failed: ${verifyNonceRes.stderr}`);
        const nonceOut = parseJsonStdout(verifyNonceRes);
        assert.equal(nonceOut.status, 'ok');
        assert.equal(nonceOut.artifactCount, 4);
        assert.equal(nonceOut.supplementalArtifactCount, 1);
        assert.equal(nonceOut.uniqueNonceCount, 6);
      } finally {
        await env.cleanup();
      }
    });
  });

  // --------------------------------------------------------------------------
  // 4. ADVERSARIAL AND TAMPERING TESTS
  // --------------------------------------------------------------------------
  describe('adversarial and tampering protection', () => {
    test('rejects tampered index bytes via closeout checksum mismatch', async () => {
      const env = await createSyntheticEnvironment(tmpRoot);
      try {
        runCli(OFFSITE_HELPER, [
          'build-index',
          '--root', env.root,
          '--key-file', env.keyFile,
          '--backup-id', env.backupId,
          '--main-manifest-ciphertext', env.manifestCiphertext,
          '--receipt', env.receiptPath,
          '--receipt-storage-record', env.recordPath,
          '--receipt-storage-record-object-proof', env.proofPath,
          '--approved-destination-record', env.destRecordPath,
          '--out', env.indexPath,
        ]);
        env.writeCloseoutSums();

        // Tamper index by appending a single byte
        await fsp.appendFile(env.indexPath, ' ');

        const res = runCli(OFFSITE_HELPER, [
          'verify-index',
          '--root', env.root,
          '--main-manifest', env.manifestPlain,
          '--receipt', env.receiptPath,
          '--receipt-storage-record', env.recordPath,
          '--receipt-storage-record-object-proof', env.proofPath,
          '--index', env.indexPath,
          '--checksums', env.closeoutSumsPath,
          '--approved-destination-record', env.destRecordPath,
          '--backup-id', env.backupId,
          '--project-ref', env.projectRef,
        ]);

        assert.equal(res.status, 1);
        const err = parseJsonStderr(res);
        assert.equal(err.error.code, 'CLOSEOUT_SUMS_HASH_MISMATCH');
      } finally {
        await env.cleanup();
      }
    });

    test('rejects extra file in closeout directory', async () => {
      const env = await createSyntheticEnvironment(tmpRoot);
      try {
        runCli(OFFSITE_HELPER, [
          'build-index',
          '--root', env.root,
          '--key-file', env.keyFile,
          '--backup-id', env.backupId,
          '--main-manifest-ciphertext', env.manifestCiphertext,
          '--receipt', env.receiptPath,
          '--receipt-storage-record', env.recordPath,
          '--receipt-storage-record-object-proof', env.proofPath,
          '--approved-destination-record', env.destRecordPath,
          '--out', env.indexPath,
        ]);
        env.writeCloseoutSums();

        // Introduce extra file into closeout/
        const extraPath = path.join(env.root, 'closeout/unauthorized-extra.txt');
        await fsp.writeFile(extraPath, 'malicious', { mode: 0o600 });

        const res = runCli(OFFSITE_HELPER, [
          'verify-index',
          '--root', env.root,
          '--main-manifest', env.manifestPlain,
          '--receipt', env.receiptPath,
          '--receipt-storage-record', env.recordPath,
          '--receipt-storage-record-object-proof', env.proofPath,
          '--index', env.indexPath,
          '--checksums', env.closeoutSumsPath,
          '--approved-destination-record', env.destRecordPath,
          '--backup-id', env.backupId,
          '--project-ref', env.projectRef,
        ]);

        assert.equal(res.status, 1);
        const err = parseJsonStderr(res);
        assert.equal(err.error.code, 'CLOSEOUT_INVENTORY_MISMATCH');
      } finally {
        await env.cleanup();
      }
    });

    test('rejects foreign backup ID mismatch', async () => {
      const env = await createSyntheticEnvironment(tmpRoot);
      try {
        runCli(OFFSITE_HELPER, [
          'build-index',
          '--root', env.root,
          '--key-file', env.keyFile,
          '--backup-id', env.backupId,
          '--main-manifest-ciphertext', env.manifestCiphertext,
          '--receipt', env.receiptPath,
          '--receipt-storage-record', env.recordPath,
          '--receipt-storage-record-object-proof', env.proofPath,
          '--approved-destination-record', env.destRecordPath,
          '--out', env.indexPath,
        ]);
        env.writeCloseoutSums();

        const res = runCli(OFFSITE_HELPER, [
          'verify-index',
          '--root', env.root,
          '--main-manifest', env.manifestPlain,
          '--receipt', env.receiptPath,
          '--receipt-storage-record', env.recordPath,
          '--receipt-storage-record-object-proof', env.proofPath,
          '--index', env.indexPath,
          '--checksums', env.closeoutSumsPath,
          '--approved-destination-record', env.destRecordPath,
          '--backup-id', 'foreign-backup-id',
          '--project-ref', env.projectRef,
        ]);

        assert.equal(res.status, 1);
        const err = parseJsonStderr(res);
        assert.equal(err.error.code, 'INDEX_BACKUP_ID_MISMATCH');
      } finally {
        await env.cleanup();
      }
    });

    test('rejects symlink in key-file path', async () => {
      const env = await createSyntheticEnvironment(tmpRoot);
      try {
        const symlinkKey = path.join(env.root, 'symlink-key.bin');
        await fsp.symlink(env.keyFile, symlinkKey);

        const res = runCli(OFFSITE_HELPER, [
          'build-index',
          '--root', env.root,
          '--key-file', symlinkKey,
          '--backup-id', env.backupId,
          '--main-manifest-ciphertext', env.manifestCiphertext,
          '--receipt', env.receiptPath,
          '--receipt-storage-record', env.recordPath,
          '--receipt-storage-record-object-proof', env.proofPath,
          '--approved-destination-record', env.destRecordPath,
          '--out', env.indexPath,
        ]);

        assert.equal(res.status, 1);
        const err = parseJsonStderr(res);
        assert.equal(err.error.code, 'KEY_FILE_SYMLINK');
      } finally {
        await env.cleanup();
      }
    });

    test('rejects key-file with group or other permissions (0644)', async () => {
      const env = await createSyntheticEnvironment(tmpRoot);
      try {
        await fsp.chmod(env.keyFile, 0o644);

        const res = runCli(OFFSITE_HELPER, [
          'build-index',
          '--root', env.root,
          '--key-file', env.keyFile,
          '--backup-id', env.backupId,
          '--main-manifest-ciphertext', env.manifestCiphertext,
          '--receipt', env.receiptPath,
          '--receipt-storage-record', env.recordPath,
          '--receipt-storage-record-object-proof', env.proofPath,
          '--approved-destination-record', env.destRecordPath,
          '--out', env.indexPath,
        ]);

        assert.equal(res.status, 1);
        const err = parseJsonStderr(res);
        assert.equal(err.error.code, 'KEY_FILE_PERMISSIONS');
      } finally {
        await env.cleanup();
      }
    });

    test('rejects duplicate nonce across artifacts (NONCE_REUSE)', async () => {
      const env = await createSyntheticEnvironment(tmpRoot);
      try {
        // Read header of db/app.dump.aesgcm and copy its nonce into sql/fingerprint.sql.aesgcm
        const dbPath = path.join(env.root, 'db/app.dump.aesgcm');
        const sqlPath = path.join(env.root, 'sql/fingerprint.sql.aesgcm');
        const dbBuf = await fsp.readFile(dbPath);
        const sqlBuf = await fsp.readFile(sqlPath);
        dbBuf.subarray(9, 21).copy(sqlBuf, 9);
        await fsp.writeFile(sqlPath, sqlBuf);

        const res = runCli(OFFSITE_HELPER, [
          'build-index',
          '--root', env.root,
          '--key-file', env.keyFile,
          '--backup-id', env.backupId,
          '--main-manifest-ciphertext', env.manifestCiphertext,
          '--receipt', env.receiptPath,
          '--receipt-storage-record', env.recordPath,
          '--receipt-storage-record-object-proof', env.proofPath,
          '--approved-destination-record', env.destRecordPath,
          '--out', env.indexPath,
        ]);

        assert.equal(res.status, 1);
        const err = parseJsonStderr(res);
        assert.equal(err.error.code, 'NONCE_REUSE');
      } finally {
        await env.cleanup();
      }
    });

    test('rejects unlisted encrypted artifact during R1 verify-nonce-set', async () => {
      const env = await createSyntheticEnvironment(tmpRoot);
      try {
        runCli(OFFSITE_HELPER, [
          'build-index',
          '--root', env.root,
          '--key-file', env.keyFile,
          '--backup-id', env.backupId,
          '--main-manifest-ciphertext', env.manifestCiphertext,
          '--receipt', env.receiptPath,
          '--receipt-storage-record', env.recordPath,
          '--receipt-storage-record-object-proof', env.proofPath,
          '--approved-destination-record', env.destRecordPath,
          '--out', env.indexPath,
        ]);
        env.writeCloseoutSums();

        // Plant an unlisted .aesgcm file
        const unlistedPath = path.join(env.root, 'db/unlisted.aesgcm');
        await fsp.writeFile(unlistedPath, 'fake-ciphertext', { mode: 0o600 });

        const res = runCli(AESGCM_HELPER, [
          'verify-nonce-set',
          '--root', env.root,
          '--key-file', env.keyFile,
          '--backup-id', env.backupId,
          '--manifest', env.manifestPlain,
          '--supplemental-index', env.indexPath,
          '--include-manifest-envelope',
          '--reject-unlisted',
        ]);

        assert.equal(res.status, 1);
        const err = parseJsonStderr(res);
        assert.equal(err.error.code, 'UNLISTED_ENCRYPTED_ARTIFACT');
      } finally {
        await env.cleanup();
      }
    });

    test('rejects missing payload in closeout/SHA256SUMS', async () => {
      const env = await createSyntheticEnvironment(tmpRoot);
      try {
        runCli(OFFSITE_HELPER, [
          'build-index',
          '--root', env.root,
          '--key-file', env.keyFile,
          '--backup-id', env.backupId,
          '--main-manifest-ciphertext', env.manifestCiphertext,
          '--receipt', env.receiptPath,
          '--receipt-storage-record', env.recordPath,
          '--receipt-storage-record-object-proof', env.proofPath,
          '--approved-destination-record', env.destRecordPath,
          '--out', env.indexPath,
        ]);
        // Write only 4 payloads in SHA256SUMS
        const partialSums = `${'0'.repeat(64)}  closeout/backup-closeout.json.aesgcm\n` +
          `${'0'.repeat(64)}  closeout/offsite-readback-receipt.json\n` +
          `${'0'.repeat(64)}  closeout/receipt-storage-record.json\n` +
          `${'0'.repeat(64)}  closeout/receipt-storage-record-object-proof.json\n`;
        await fsp.writeFile(env.closeoutSumsPath, partialSums, { mode: 0o600 });

        const res = runCli(OFFSITE_HELPER, [
          'verify-index',
          '--root', env.root,
          '--main-manifest', env.manifestPlain,
          '--receipt', env.receiptPath,
          '--receipt-storage-record', env.recordPath,
          '--receipt-storage-record-object-proof', env.proofPath,
          '--index', env.indexPath,
          '--checksums', env.closeoutSumsPath,
          '--approved-destination-record', env.destRecordPath,
          '--backup-id', env.backupId,
          '--project-ref', env.projectRef,
        ]);

        assert.equal(res.status, 1);
        const err = parseJsonStderr(res);
        assert.equal(err.error.code, 'CLOSEOUT_SUMS_COUNT_MISMATCH');
      } finally {
        await env.cleanup();
      }
    });
  });

  // --------------------------------------------------------------------------
  // 5. PROVIDER BLOCKED SUITE
  // --------------------------------------------------------------------------
  describe('provider-dependent commands fail-closed (BLOCKED)', () => {
    test('upload-readback is BLOCKED without live provider', () => {
      const res = runCli(OFFSITE_HELPER, [
        'upload-readback',
        '--root', tmpRoot,
        '--main-manifest-ciphertext', 'any',
        '--closeout-ciphertext', 'any',
        '--key-file', 'any',
        '--backup-id', 'any',
        '--approved-destination-record', 'any',
      ]);
      assert.equal(res.status, 1);
      const err = parseJsonStderr(res);
      assert.equal(err.error.code, 'PROVIDER_BLOCKED');
      assert.match(err.error.message, /Command 'upload-readback' is BLOCKED/);
    });

    test('finalize-upload is BLOCKED without live provider', () => {
      const res = runCli(OFFSITE_HELPER, [
        'finalize-upload',
        '--root', tmpRoot,
        '--index', 'any',
        '--checksums', 'any',
        '--approved-destination-record', 'any',
        '--receipt-out', 'any',
      ]);
      assert.equal(res.status, 1);
      const err = parseJsonStderr(res);
      assert.equal(err.error.code, 'PROVIDER_BLOCKED');
      assert.match(err.error.message, /Command 'finalize-upload' is BLOCKED/);
    });

    test('recover-bootstrap is BLOCKED without live provider', () => {
      const res = runCli(OFFSITE_HELPER, [
        'recover-bootstrap',
        '--catalog-entry', 'any',
        '--approved-destination-record', 'any',
        '--approved-registry-record', 'any',
        '--restore-root', 'any',
      ]);
      assert.equal(res.status, 1);
      const err = parseJsonStderr(res);
      assert.equal(err.error.code, 'PROVIDER_BLOCKED');
      assert.match(err.error.message, /Command 'recover-bootstrap' is BLOCKED/);
    });
  });

  test('teardown main test directory', async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });
});
