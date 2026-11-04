import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, 'fixtures');
const REPO_ROOT = path.resolve(HERE, '../..');
const HELPER = path.join(REPO_ROOT, 'scripts/backup/aesgcm-stream.mjs');

const SAFE_RELATIVE_PATH = /^[A-Za-z0-9._/-]+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const NONCE_HEX = /^[0-9a-f]{24}$/;
const BACKUP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * Strict JSON parser that rejects duplicate keys, control characters, and malformed structures.
 */
export function parseJsonStrict(text, label = 'JSON') {
  let index = 0;
  const length = text.length;

  const invalid = (msg) => {
    throw new Error(`${label} invalid: ${msg}`);
  };

  const skipWhitespace = () => {
    while (index < length) {
      const code = text.charCodeAt(index);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
        index += 1;
      } else {
        break;
      }
    }
  };

  const parseString = () => {
    if (text[index] !== '"') invalid('expected quote');
    index += 1;
    let result = '';
    while (index < length) {
      const char = text[index];
      if (char === '"') {
        index += 1;
        return result;
      }
      if (char === '\\') {
        index += 1;
        if (index >= length) invalid('unterminated escape');
        const esc = text[index];
        index += 1;
        if (esc === '"' || esc === '\\' || esc === '/') result += esc;
        else if (esc === 'b') result += '\b';
        else if (esc === 'f') result += '\f';
        else if (esc === 'n') result += '\n';
        else if (esc === 'r') result += '\r';
        else if (esc === 't') result += '\t';
        else if (esc === 'u') {
          const hex = text.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) invalid('invalid unicode escape');
          index += 4;
          result += String.fromCharCode(parseInt(hex, 16));
        } else invalid('unknown escape');
        continue;
      }
      const code = text.charCodeAt(index);
      if (code < 0x20) invalid('unescaped control character');
      result += char;
      index += 1;
    }
    invalid('unterminated string');
  };

  const parseNumber = () => {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(index));
    if (!match) invalid('invalid number');
    const value = Number(match[0]);
    if (!Number.isFinite(value)) invalid('non-finite number');
    index += match[0].length;
    return value;
  };

  const parseValue = () => {
    skipWhitespace();
    if (index >= length) invalid('unexpected end of input');
    const char = text[index];
    if (char === '{') return parseObject();
    if (char === '[') return parseArray();
    if (char === '"') return parseString();
    if (char === 't' && text.slice(index, index + 4) === 'true') {
      index += 4;
      return true;
    }
    if (char === 'f' && text.slice(index, index + 5) === 'false') {
      index += 5;
      return false;
    }
    if (char === 'n' && text.slice(index, index + 4) === 'null') {
      index += 4;
      return null;
    }
    if (char === '-' || (char >= '0' && char <= '9')) return parseNumber();
    invalid(`unexpected character: ${char}`);
  };

  const parseArray = () => {
    index += 1;
    const result = [];
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      return result;
    }
    while (true) {
      result.push(parseValue());
      skipWhitespace();
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      if (text[index] === ']') {
        index += 1;
        return result;
      }
      invalid('unterminated array');
    }
  };

  const parseObject = () => {
    index += 1;
    const result = {};
    const seen = new Set();
    skipWhitespace();
    if (text[index] === '}') {
      index += 1;
      return result;
    }
    while (true) {
      skipWhitespace();
      if (text[index] !== '"') invalid('expected string key');
      const key = parseString();
      if (seen.has(key)) invalid(`duplicate JSON key: ${key}`);
      seen.add(key);
      skipWhitespace();
      if (text[index] !== ':') invalid('expected colon');
      index += 1;
      result[key] = parseValue();
      skipWhitespace();
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      if (text[index] === '}') {
        index += 1;
        return result;
      }
      invalid('unterminated object');
    }
  };

  const value = parseValue();
  skipWhitespace();
  if (index !== length) invalid('extra data after JSON root');
  return value;
}

/**
 * Validates instance against the exact rules of offsite-bundle-index.schema.json
 */
export function validateAgainstSchema(schema, data) {
  assert.ok(data && typeof data === 'object' && !Array.isArray(data), 'root must be an object');

  // Verify root properties against schema.properties and required
  const rootKeys = new Set(Object.keys(data));
  for (const req of schema.required) {
    assert.ok(rootKeys.has(req), `missing required root property: ${req}`);
  }
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties));
    for (const key of rootKeys) {
      assert.ok(allowed.has(key), `unexpected additional property on root: ${key}`);
    }
  }

  assert.equal(data.format, schema.properties.format.const, 'format must match const');
  assert.match(data.backupId, new RegExp(schema.properties.backupId.pattern), 'backupId format invalid');
  assert.match(data.projectRef, new RegExp(schema.properties.projectRef.pattern), 'projectRef format invalid');
  assert.match(data.createdAt, new RegExp(schema.properties.createdAt.pattern), 'createdAt format invalid');

  // Destination
  assert.ok(data.destination && typeof data.destination === 'object', 'destination must be object');
  assert.ok(schema.properties.destination.properties.provider.enum.includes(data.destination.provider), 'unsupported provider');
  assert.ok(typeof data.destination.destinationId === 'string' && data.destination.destinationId.length > 0, 'destinationId required');
  assert.ok(typeof data.destination.bucket === 'string' && data.destination.bucket.length > 0, 'bucket required');
  assert.ok(typeof data.destination.prefix === 'string', 'prefix required');

  // StorageRecordProof
  assert.ok(data.storageRecordProof && typeof data.storageRecordProof === 'object', 'storageRecordProof must be object');
  assert.match(data.storageRecordProof.proofBytesBase64, new RegExp(schema.properties.storageRecordProof.properties.proofBytesBase64.pattern), 'proofBytesBase64 pattern invalid');
  assert.match(data.storageRecordProof.proofSha256, new RegExp(schema.properties.storageRecordProof.properties.proofSha256.pattern), 'proofSha256 pattern invalid');

  // Artifacts
  assert.ok(Array.isArray(data.artifacts), 'artifacts must be array');
  assert.ok(data.artifacts.length >= schema.properties.artifacts.minItems, 'artifacts minItems');
  assert.ok(data.artifacts.length <= schema.properties.artifacts.maxItems, 'artifacts maxItems');

  const itemSchema = schema.properties.artifacts.items;
  const itemAllowedKeys = new Set(Object.keys(itemSchema.properties));

  for (const item of data.artifacts) {
    assert.ok(item && typeof item === 'object', 'artifact item must be object');
    const itemKeys = new Set(Object.keys(item));
    for (const req of itemSchema.required) {
      assert.ok(itemKeys.has(req), `artifact item missing required field: ${req}`);
    }
    if (itemSchema.additionalProperties === false) {
      for (const key of itemKeys) {
        assert.ok(itemAllowedKeys.has(key), `artifact item has additional property: ${key}`);
      }
    }

    assert.match(item.path, new RegExp(itemSchema.properties.path.pattern), 'path pattern invalid');
    assert.ok(itemSchema.properties.kind.enum.includes(item.kind), `invalid kind: ${item.kind}`);
    assert.match(item.ciphertextSha256, new RegExp(itemSchema.properties.ciphertextSha256.pattern), 'hash pattern invalid');
    assert.ok(Number.isSafeInteger(item.ciphertextBytes) && item.ciphertextBytes >= 0, 'ciphertextBytes invalid');

    // Conditional schema rules (allOf)
    if (['encrypted_artifact', 'manifest_envelope', 'closeout_envelope'].includes(item.kind)) {
      assert.ok(Object.hasOwn(item, 'nonceHex'), `encrypted artifact ${item.path} must have nonceHex`);
      assert.equal(typeof item.nonceHex, 'string', `nonceHex must be string on ${item.path}`);
      assert.match(item.nonceHex, new RegExp(itemSchema.properties.nonceHex.pattern), `nonceHex pattern invalid on ${item.path}`);
    } else if (item.kind === 'checksum_file') {
      // Must NOT have nonceHex (not: { required: ["nonceHex"] })
      assert.ok(!Object.hasOwn(item, 'nonceHex'), `checksum_file ${item.path} MUST NOT have nonceHex property`);
      assert.equal(item.nonceHex, undefined, `checksum_file ${item.path} nonceHex must be undefined`);
    }

    // Remote
    assert.ok(item.remote && typeof item.remote === 'object', 'remote must be object');
    assert.ok(typeof item.remote.objectKey === 'string' && item.remote.objectKey.length > 0, 'remote.objectKey required');
    assert.ok(typeof item.remote.immutableVersionId === 'string' && item.remote.immutableVersionId.length > 0, 'remote.immutableVersionId required');
    assert.match(item.remote.retentionUntil, new RegExp(itemSchema.properties.remote.properties.retentionUntil.pattern), 'retentionUntil format invalid');
  }

  // Summary
  assert.ok(data.summary && typeof data.summary === 'object', 'summary must be object');
  assert.equal(data.summary.totalArtifacts, data.artifacts.length, 'summary totalArtifacts');
}

/**
 * Reference contract validator implementing business invariants of CrmOffsiteBundleIndexV1
 */
export function validateBundleIndex(index) {
  assert.ok(index && typeof index === 'object' && !Array.isArray(index), 'index must be an object');
  assert.equal(index.format, 'crm-offsite-bundle-index/v1', 'format must be crm-offsite-bundle-index/v1');
  assert.match(index.backupId, BACKUP_ID_RE, 'backupId must match backup ID format');
  assert.ok(index.backupId.length <= 256, 'backupId max length is 256');
  assert.match(index.projectRef, /^[a-z0-9_-]+$/, 'projectRef format invalid');
  assert.match(index.createdAt, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$/, 'createdAt must be UTC RFC 3339');

  // Destination validation
  assert.ok(index.destination && typeof index.destination === 'object', 'destination must be an object');
  assert.ok(['aws-s3', 'gcs', 'azure-blob', 'supabase-storage', 's3-compatible'].includes(index.destination.provider), 'unsupported provider');
  assert.ok(typeof index.destination.destinationId === 'string' && index.destination.destinationId.length > 0, 'destinationId required');
  assert.ok(typeof index.destination.bucket === 'string' && index.destination.bucket.length > 0, 'bucket required');
  assert.ok(typeof index.destination.prefix === 'string', 'prefix required');

  // StorageRecordProof validation (§23.1)
  assert.ok(index.storageRecordProof && typeof index.storageRecordProof === 'object', 'storageRecordProof must be an object');
  assert.match(index.storageRecordProof.proofBytesBase64, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, 'proofBytesBase64 must be valid standard base64');
  assert.match(index.storageRecordProof.proofSha256, SHA256_HEX, 'proofSha256 must be 64 lowercase hex');
  const decodedProofBytes = Buffer.from(index.storageRecordProof.proofBytesBase64, 'base64');
  const computedProofSha256 = crypto.createHash('sha256').update(decodedProofBytes).digest('hex');
  assert.equal(index.storageRecordProof.proofSha256, computedProofSha256, 'proofSha256 must match raw bytes of proofBytesBase64');

  // Artifacts inventory validation
  assert.ok(Array.isArray(index.artifacts), 'artifacts must be an array');
  assert.ok(index.artifacts.length > 0, 'artifacts must not be empty');
  assert.ok(index.artifacts.length <= 10000, 'artifacts exceeds limit');

  const seenPaths = new Set();
  let encryptedCount = 0;
  let totalBytes = 0;
  let hasManifestEnvelope = false;
  let hasChecksumFile = false;
  let hasCloseoutEnvelope = false;

  for (const artifact of index.artifacts) {
    assert.ok(artifact && typeof artifact === 'object', 'artifact must be an object');
    assert.ok(typeof artifact.path === 'string' && artifact.path.length > 0, 'artifact path required');
    assert.match(artifact.path, SAFE_RELATIVE_PATH, 'artifact path characters invalid');
    assert.ok(!artifact.path.startsWith('/') && !artifact.path.endsWith('/') && !artifact.path.includes('//'), 'artifact path cannot have leading/trailing/double slashes');
    assert.ok(!artifact.path.split('/').some((s) => s === '' || s === '.' || s === '..'), 'artifact path cannot contain . or .. segments');

    // Circular dependency check (§23.1)
    assert.notEqual(artifact.path, 'closeout/SHA256SUMS', 'circular dependency: index MUST NOT contain closeout/SHA256SUMS');
    assert.notEqual(artifact.path, 'closeout/offsite-bundle-index.json', 'circular dependency: index MUST NOT contain itself');

    // Duplicate check
    assert.ok(!seenPaths.has(artifact.path), `duplicate artifact path: ${artifact.path}`);
    seenPaths.add(artifact.path);

    assert.ok(['encrypted_artifact', 'manifest_envelope', 'checksum_file', 'closeout_envelope'].includes(artifact.kind), `invalid kind: ${artifact.kind}`);
    assert.match(artifact.ciphertextSha256, SHA256_HEX, 'ciphertextSha256 must be 64 lowercase hex');
    assert.ok(Number.isSafeInteger(artifact.ciphertextBytes) && artifact.ciphertextBytes >= 0, 'ciphertextBytes must be non-negative integer');
    totalBytes += artifact.ciphertextBytes;

    if (artifact.path.endsWith('.aesgcm')) {
      encryptedCount += 1;
      assert.equal(typeof artifact.nonceHex, 'string', `encrypted artifact ${artifact.path} must have string nonceHex`);
      assert.match(artifact.nonceHex, NONCE_HEX, `encrypted artifact ${artifact.path} must have 24-hex nonceHex`);
    } else {
      // Non-encrypted artifacts MUST omit nonceHex entirely (never null, never string)
      assert.equal(artifact.nonceHex, undefined, `non-encrypted artifact ${artifact.path} must omit nonceHex entirely`);
      assert.ok(!Object.hasOwn(artifact, 'nonceHex'), `non-encrypted artifact ${artifact.path} must not have nonceHex property`);
    }

    if (artifact.path === 'manifest/backup-manifest.json.aesgcm') {
      assert.equal(artifact.kind, 'manifest_envelope');
      hasManifestEnvelope = true;
    }
    if (artifact.path === 'manifest/SHA256SUMS') {
      assert.equal(artifact.kind, 'checksum_file');
      hasChecksumFile = true;
    }
    if (artifact.path.startsWith('closeout/')) {
      assert.equal(artifact.path, 'closeout/backup-closeout.json.aesgcm', 'closeout encrypted artifact MUST only be closeout/backup-closeout.json.aesgcm');
      assert.equal(artifact.kind, 'closeout_envelope');
      hasCloseoutEnvelope = true;
    }

    // Remote metadata
    assert.ok(artifact.remote && typeof artifact.remote === 'object', 'artifact.remote required');
    assert.ok(typeof artifact.remote.objectKey === 'string' && artifact.remote.objectKey.length > 0, 'remote.objectKey required');
    assert.ok(typeof artifact.remote.immutableVersionId === 'string' && artifact.remote.immutableVersionId.length > 0, 'remote.immutableVersionId required');
    assert.match(artifact.remote.retentionUntil, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$/, 'remote.retentionUntil format invalid');
  }

  assert.ok(hasManifestEnvelope, 'manifest envelope must be included');
  assert.ok(hasChecksumFile, 'manifest SHA256SUMS must be included');
  assert.ok(hasCloseoutEnvelope, 'closeout backup-closeout.json.aesgcm must be included');

  // Summary validation
  assert.ok(index.summary && typeof index.summary === 'object', 'summary must be an object');
  assert.equal(index.summary.totalArtifacts, index.artifacts.length, 'summary.totalArtifacts must match artifacts.length');
  assert.equal(index.summary.encryptedArtifactCount, encryptedCount, 'summary.encryptedArtifactCount must match count of .aesgcm');
  assert.equal(index.summary.totalCiphertextBytes, totalBytes, 'summary.totalCiphertextBytes must match sum of ciphertextBytes');

  return {
    valid: true,
    totalArtifacts: index.artifacts.length,
    encryptedCount,
    totalBytes,
  };
}

describe('offsite-bundle-index contract acceptance suite', () => {
  let schema;

  test('loads and parses schema definition', async () => {
    const rawSchema = await fsp.readFile(path.join(FIXTURES_DIR, 'offsite-bundle-index.schema.json'), 'utf8');
    schema = JSON.parse(rawSchema);
    assert.equal(schema.$id, 'https://schemas.crm.internal/crm-offsite-bundle-index/v1.json');
    assert.equal(schema.properties.artifacts.items.properties.nonceHex.type, 'string');
  });

  test('valid canonical fixture passes all contract and schema rules', async () => {
    const raw = await fsp.readFile(path.join(FIXTURES_DIR, 'offsite-bundle-index.valid.json'), 'utf8');
    const index = parseJsonStrict(raw, 'valid fixture');
    validateAgainstSchema(schema, index);
    const result = validateBundleIndex(index);
    assert.equal(result.valid, true);
    assert.equal(result.totalArtifacts, 7);
    assert.equal(result.encryptedCount, 6);
  });

  test('rejects nonceHex: null on unencrypted artifact (P1-CONTRACT-01 regression test)', async () => {
    const raw = await fsp.readFile(path.join(FIXTURES_DIR, 'offsite-bundle-index.invalid-null-nonce.json'), 'utf8');
    const index = JSON.parse(raw);
    assert.throws(
      () => validateAgainstSchema(schema, index),
      /checksum_file manifest\/SHA256SUMS MUST NOT have nonceHex property/,
    );
    assert.throws(
      () => validateBundleIndex(index),
      /non-encrypted artifact manifest\/SHA256SUMS must omit nonceHex entirely/,
    );
  });

  test('rejects empty nonceHex: "" on encrypted artifact', async () => {
    const raw = await fsp.readFile(path.join(FIXTURES_DIR, 'offsite-bundle-index.invalid-empty-nonce.json'), 'utf8');
    const index = JSON.parse(raw);
    assert.throws(
      () => validateAgainstSchema(schema, index),
      /nonceHex pattern invalid/,
    );
    assert.throws(
      () => validateBundleIndex(index),
      /must have 24-hex nonceHex/,
    );
  });

  test('rejects plaintext artifact carrying a nonceHex', async () => {
    const raw = await fsp.readFile(path.join(FIXTURES_DIR, 'offsite-bundle-index.invalid-plaintext-nonce.json'), 'utf8');
    const index = JSON.parse(raw);
    assert.throws(
      () => validateAgainstSchema(schema, index),
      /checksum_file manifest\/SHA256SUMS MUST NOT have nonceHex property/,
    );
    assert.throws(
      () => validateBundleIndex(index),
      /non-encrypted artifact manifest\/SHA256SUMS must omit nonceHex entirely/,
    );
  });

  test('rejects circular dependency when closeout/SHA256SUMS is included', async () => {
    const raw = await fsp.readFile(path.join(FIXTURES_DIR, 'offsite-bundle-index.invalid-circular-sums.json'), 'utf8');
    const index = JSON.parse(raw);
    assert.throws(() => validateBundleIndex(index), /circular dependency/);
  });

  test('rejects duplicate artifact paths', async () => {
    const raw = await fsp.readFile(path.join(FIXTURES_DIR, 'offsite-bundle-index.invalid-duplicate-path.json'), 'utf8');
    const index = JSON.parse(raw);
    assert.throws(() => validateBundleIndex(index), /duplicate artifact path/);
  });

  test('rejects tampered storageRecordProof hash', async () => {
    const raw = await fsp.readFile(path.join(FIXTURES_DIR, 'offsite-bundle-index.invalid-bad-proof-hash.json'), 'utf8');
    const index = JSON.parse(raw);
    assert.throws(() => validateBundleIndex(index), /proofSha256 must match raw bytes/);
  });

  test('rejects invalid nonceHex format on encrypted artifact', async () => {
    const raw = await fsp.readFile(path.join(FIXTURES_DIR, 'offsite-bundle-index.invalid-bad-nonce.json'), 'utf8');
    const index = JSON.parse(raw);
    assert.throws(() => validateBundleIndex(index), /must have 24-hex nonceHex/);
  });

  test('rejects unapproved closeout encrypted envelope', async () => {
    const raw = await fsp.readFile(path.join(FIXTURES_DIR, 'offsite-bundle-index.invalid-unapproved-closeout.json'), 'utf8');
    const index = JSON.parse(raw);
    assert.throws(() => validateBundleIndex(index), /closeout encrypted artifact MUST only be closeout\/backup-closeout.json.aesgcm/);
  });

  test('rejects duplicate JSON keys via strict parser', () => {
    const jsonWithDuplicateKey = '{"format":"crm-offsite-bundle-index/v1","format":"duplicate"}';
    assert.throws(
      () => parseJsonStrict(jsonWithDuplicateKey, 'test duplicate key'),
      /duplicate JSON key: format/,
    );
  });

  test('executes verbatim B10/R1 verify-nonce-set on live synthetic tree with valid vs null index', async () => {
    const backupId = '20261101T120000Z-11111111-2222-3333-4444-555555555555';
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'contract-test-'));
    await fsp.chmod(tmp, 0o700);

    const key = crypto.randomBytes(32);
    const keyFile = path.join(tmp, 'key.bin');
    await fsp.writeFile(keyFile, key, { mode: 0o600 });

    for (const d of ['db', 'sql', 'logs', 'future-class', 'manifest', 'closeout']) {
      await fsp.mkdir(path.join(tmp, d), { mode: 0o700, recursive: true });
    }

    function encrypt(plainText, plainArtifactPath, destPath) {
      const plainFile = path.join(tmp, 'plain.tmp');
      fs.writeFileSync(plainFile, plainText, { mode: 0o600 });
      const fullDest = path.join(tmp, destPath);
      const res = spawnSync('node', [
        HELPER,
        'encrypt',
        '--in', plainFile,
        '--out', fullDest,
        '--key-file', keyFile,
        '--backup-id', backupId,
        '--artifact', plainArtifactPath,
      ], { encoding: 'utf8' });
      fs.rmSync(plainFile, { force: true });
      if (res.status !== 0) throw new Error(res.stderr);
      return JSON.parse(res.stdout);
    }

    const dbMeta = encrypt('DUMP', 'db/app.dump', 'db/app.dump.aesgcm');
    const sqlMeta = encrypt('SQL', 'sql/fingerprint.sql', 'sql/fingerprint.sql.aesgcm');
    const logsMeta = encrypt('LOG', 'logs/source.stderr', 'logs/source.stderr.aesgcm');
    const customMeta = encrypt('BIN', 'future-class/custom.bin', 'future-class/custom.bin.aesgcm');
    const closeoutMeta = encrypt(JSON.stringify({ closeout: true }), 'closeout/backup-closeout.json', 'closeout/backup-closeout.json.aesgcm');

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

    const manifestPlain = path.join(tmp, 'manifest.json');
    await fsp.writeFile(manifestPlain, JSON.stringify(manifestObj, null, 2), { mode: 0o600 });
    const manifestMeta = encrypt(await fsp.readFile(manifestPlain), 'manifest/backup-manifest.json', 'manifest/backup-manifest.json.aesgcm');

    const mainArtifacts = [
      'db/app.dump.aesgcm',
      'sql/fingerprint.sql.aesgcm',
      'logs/source.stderr.aesgcm',
      'future-class/custom.bin.aesgcm',
      'manifest/backup-manifest.json.aesgcm',
    ];
    let sumsContent = '';
    for (const rel of mainArtifacts) {
      const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(tmp, rel))).digest('hex');
      sumsContent += `${h}  ${rel}\n`;
    }
    await fsp.writeFile(path.join(tmp, 'manifest/SHA256SUMS'), sumsContent, { mode: 0o600 });
    const manifestSumsSha = crypto.createHash('sha256').update(Buffer.from(sumsContent)).digest('hex');

    await fsp.writeFile(path.join(tmp, 'closeout/offsite-readback-receipt.json'), JSON.stringify({ receipt: true }), { mode: 0o600 });
    await fsp.writeFile(path.join(tmp, 'closeout/receipt-storage-record.json'), JSON.stringify({ record: true }), { mode: 0o600 });
    await fsp.writeFile(path.join(tmp, 'closeout/receipt-storage-record-object-proof.json'), JSON.stringify({ proof: true }), { mode: 0o600 });

    const liveIndex = {
      format: 'crm-offsite-bundle-index/v1',
      backupId,
      projectRef: 'qmhfmgkymjgoevwmkidm',
      createdAt: '2026-11-01T12:05:00.000Z',
      destination: {
        provider: 'supabase-storage',
        destinationId: 'staging-cold-backup-worm',
        bucket: 'cold-backups-staging',
        prefix: backupId,
      },
      artifacts: [
        {
          path: 'db/app.dump.aesgcm',
          kind: 'encrypted_artifact',
          ciphertextSha256: dbMeta.ciphertextSha256,
          ciphertextBytes: dbMeta.ciphertextBytes,
          nonceHex: dbMeta.nonceHex,
          remote: { objectKey: 'db', immutableVersionId: 'v1', retentionUntil: '2027-11-01T12:00:00.000Z' },
        },
        {
          path: 'sql/fingerprint.sql.aesgcm',
          kind: 'encrypted_artifact',
          ciphertextSha256: sqlMeta.ciphertextSha256,
          ciphertextBytes: sqlMeta.ciphertextBytes,
          nonceHex: sqlMeta.nonceHex,
          remote: { objectKey: 'sql', immutableVersionId: 'v1', retentionUntil: '2027-11-01T12:00:00.000Z' },
        },
        {
          path: 'logs/source.stderr.aesgcm',
          kind: 'encrypted_artifact',
          ciphertextSha256: logsMeta.ciphertextSha256,
          ciphertextBytes: logsMeta.ciphertextBytes,
          nonceHex: logsMeta.nonceHex,
          remote: { objectKey: 'logs', immutableVersionId: 'v1', retentionUntil: '2027-11-01T12:00:00.000Z' },
        },
        {
          path: 'future-class/custom.bin.aesgcm',
          kind: 'encrypted_artifact',
          ciphertextSha256: customMeta.ciphertextSha256,
          ciphertextBytes: customMeta.ciphertextBytes,
          nonceHex: customMeta.nonceHex,
          remote: { objectKey: 'future', immutableVersionId: 'v1', retentionUntil: '2027-11-01T12:00:00.000Z' },
        },
        {
          path: 'manifest/backup-manifest.json.aesgcm',
          kind: 'manifest_envelope',
          ciphertextSha256: manifestMeta.ciphertextSha256,
          ciphertextBytes: manifestMeta.ciphertextBytes,
          nonceHex: manifestMeta.nonceHex,
          remote: { objectKey: 'manifest', immutableVersionId: 'v1', retentionUntil: '2027-11-01T12:00:00.000Z' },
        },
        {
          path: 'manifest/SHA256SUMS',
          kind: 'checksum_file',
          ciphertextSha256: manifestSumsSha,
          ciphertextBytes: Buffer.byteLength(sumsContent),
          // BẮT BUỘC BỎ QUA (omitted) nonceHex cho checksum_file
          remote: { objectKey: 'sums', immutableVersionId: 'v1', retentionUntil: '2027-11-01T12:00:00.000Z' },
        },
        {
          path: 'closeout/backup-closeout.json.aesgcm',
          kind: 'closeout_envelope',
          ciphertextSha256: closeoutMeta.ciphertextSha256,
          ciphertextBytes: closeoutMeta.ciphertextBytes,
          nonceHex: closeoutMeta.nonceHex,
          remote: { objectKey: 'closeout', immutableVersionId: 'v1', retentionUntil: '2027-11-01T12:00:00.000Z' },
        },
      ],
      storageRecordProof: {
        proofBytesBase64: 'eyJmb3JtYXQiOiJjcm0tcmVjZWlwdC1zdG9yYWdlLXJlY29yZC1vYmplY3QtcHJvb2YvdjEiLCJzdGF0dXMiOiJ2ZXJpZmllZCJ9',
        proofSha256: 'cf61ef51f8e872618657eeadd48bb72037d835bcbe21acb21c973fb93e90415e',
      },
      summary: {
        totalArtifacts: 7,
        encryptedArtifactCount: 6,
        totalCiphertextBytes: dbMeta.ciphertextBytes + sqlMeta.ciphertextBytes + logsMeta.ciphertextBytes + customMeta.ciphertextBytes + manifestMeta.ciphertextBytes + Buffer.byteLength(sumsContent) + closeoutMeta.ciphertextBytes,
      },
    };

    const indexPath = path.join(tmp, 'closeout/offsite-bundle-index.json');
    await fsp.writeFile(indexPath, JSON.stringify(liveIndex, null, 2), { mode: 0o600 });

    const closeoutPayloads = [
      'closeout/backup-closeout.json.aesgcm',
      'closeout/offsite-readback-receipt.json',
      'closeout/receipt-storage-record.json',
      'closeout/receipt-storage-record-object-proof.json',
      'closeout/offsite-bundle-index.json',
    ];

    function writeCloseoutSums() {
      let sums = '';
      for (const rel of closeoutPayloads) {
        const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(tmp, rel))).digest('hex');
        sums += `${h}  ${rel}\n`;
      }
      fs.writeFileSync(path.join(tmp, 'closeout/SHA256SUMS'), sums, { mode: 0o600 });
    }

    writeCloseoutSums();

    // Invocation verbatim B10/R1 từ Runbook v12
    const resValid = spawnSync('node', [
      HELPER,
      'verify-nonce-set',
      '--root', tmp,
      '--key-file', keyFile,
      '--backup-id', backupId,
      '--manifest', manifestPlain,
      '--supplemental-index', indexPath,
      '--include-manifest-envelope',
      '--reject-unlisted',
    ], { encoding: 'utf8' });

    assert.equal(resValid.status, 0, `verify-nonce-set failed unexpectedly: ${resValid.stderr}`);
    const validOutput = JSON.parse(resValid.stdout);
    assert.equal(validOutput.status, 'ok');
    assert.equal(validOutput.artifactCount, 4);
    assert.equal(validOutput.supplementalArtifactCount, 1);
    assert.equal(validOutput.uniqueNonceCount, 6);

    // Negative test: mutating to nonceHex: null must trigger SUPPLEMENTAL_INDEX_INVALID
    const indexWithNull = JSON.parse(JSON.stringify(liveIndex));
    indexWithNull.artifacts[5].nonceHex = null;
    await fsp.writeFile(indexPath, JSON.stringify(indexWithNull, null, 2), { mode: 0o600 });
    writeCloseoutSums();

    const resNull = spawnSync('node', [
      HELPER,
      'verify-nonce-set',
      '--root', tmp,
      '--key-file', keyFile,
      '--backup-id', backupId,
      '--manifest', manifestPlain,
      '--supplemental-index', indexPath,
      '--include-manifest-envelope',
      '--reject-unlisted',
    ], { encoding: 'utf8' });

    assert.equal(resNull.status, 1);
    assert.match(resNull.stderr, /SUPPLEMENTAL_INDEX_INVALID/);
    assert.match(resNull.stderr, /supplemental index nonceHex must be 24 lowercase hex characters/);

    await fsp.rm(tmp, { recursive: true, force: true });
  });
});
