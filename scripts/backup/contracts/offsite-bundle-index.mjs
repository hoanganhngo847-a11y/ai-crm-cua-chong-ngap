import assert from 'node:assert/strict';
import crypto from 'node:crypto';

export const OFFSITE_BUNDLE_INDEX_FORMAT = 'crm-offsite-bundle-index/v1';
export const OFFSITE_BUNDLE_INDEX_SCHEMA_ID = 'https://schemas.crm.internal/crm-offsite-bundle-index/v1.json';

export const SAFE_RELATIVE_PATH = /^[A-Za-z0-9._/-]+$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const NONCE_HEX = /^[0-9a-f]{24}$/;
export const BACKUP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
export const PROJECT_REF_RE = /^[a-z0-9_-]+$/;
export const UTC_TIMESTAMP_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$/;
export const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const APPROVED_DESTINATION_PROVIDERS = Object.freeze([
  'aws-s3',
  'gcs',
  'azure-blob',
  'supabase-storage',
  's3-compatible',
]);

export const ARTIFACT_KINDS = Object.freeze([
  'encrypted_artifact',
  'manifest_envelope',
  'checksum_file',
  'closeout_envelope',
]);

export const CLOSEOUT_PAYLOADS = Object.freeze([
  'closeout/backup-closeout.json.aesgcm',
  'closeout/offsite-readback-receipt.json',
  'closeout/receipt-storage-record.json',
  'closeout/receipt-storage-record-object-proof.json',
  'closeout/offsite-bundle-index.json',
]);

export const CLOSEOUT_EXACT_FILES = Object.freeze([
  'backup-closeout.json.aesgcm',
  'offsite-readback-receipt.json',
  'receipt-storage-record.json',
  'receipt-storage-record-object-proof.json',
  'offsite-bundle-index.json',
  'SHA256SUMS',
]);

export const CLOSEOUT_SHA256SUMS_PATH = 'closeout/SHA256SUMS';
export const OFFSITE_INDEX_PATH = 'closeout/offsite-bundle-index.json';
export const MANIFEST_ENVELOPE = 'manifest/backup-manifest.json.aesgcm';
export const MANIFEST_SUMS = 'manifest/SHA256SUMS';
export const CLOSEOUT_ENVELOPE = 'closeout/backup-closeout.json.aesgcm';

export const OFFSITE_BUNDLE_INDEX_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: OFFSITE_BUNDLE_INDEX_SCHEMA_ID,
  title: 'CrmOffsiteBundleIndexV1',
  description: 'Normative wire schema for closeout/offsite-bundle-index.json in Meta Ads Staging Backup & Recovery',
  type: 'object',
  required: [
    'format',
    'backupId',
    'projectRef',
    'createdAt',
    'destination',
    'artifacts',
    'storageRecordProof',
    'summary',
  ],
  additionalProperties: false,
  properties: {
    format: {
      type: 'string',
      const: OFFSITE_BUNDLE_INDEX_FORMAT,
    },
    backupId: {
      type: 'string',
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
      maxLength: 256,
    },
    projectRef: {
      type: 'string',
      pattern: '^[a-z0-9_-]+$',
      maxLength: 64,
    },
    createdAt: {
      type: 'string',
      pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,6})?Z$',
    },
    destination: {
      type: 'object',
      required: ['provider', 'destinationId', 'bucket', 'prefix'],
      additionalProperties: false,
      properties: {
        provider: {
          type: 'string',
          enum: ['aws-s3', 'gcs', 'azure-blob', 'supabase-storage', 's3-compatible'],
        },
        destinationId: { type: 'string', minLength: 1, maxLength: 128 },
        bucket: { type: 'string', minLength: 1, maxLength: 128 },
        prefix: { type: 'string', maxLength: 512 },
      },
    },
    artifacts: {
      type: 'array',
      minItems: 1,
      maxItems: 10000,
      items: {
        type: 'object',
        required: [
          'path',
          'kind',
          'ciphertextSha256',
          'ciphertextBytes',
          'remote',
        ],
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
            pattern: '^[A-Za-z0-9._/-]+$',
            maxLength: 1024,
          },
          kind: {
            type: 'string',
            enum: [
              'encrypted_artifact',
              'manifest_envelope',
              'checksum_file',
              'closeout_envelope',
            ],
          },
          ciphertextSha256: {
            type: 'string',
            pattern: '^[0-9a-f]{64}$',
          },
          ciphertextBytes: {
            type: 'integer',
            minimum: 0,
            maximum: 70368744177632,
          },
          nonceHex: {
            type: 'string',
            pattern: '^[0-9a-f]{24}$',
          },
          remote: {
            type: 'object',
            required: ['objectKey', 'immutableVersionId', 'retentionUntil'],
            additionalProperties: false,
            properties: {
              objectKey: { type: 'string', minLength: 1, maxLength: 1024 },
              immutableVersionId: { type: 'string', minLength: 1, maxLength: 256 },
              retentionUntil: {
                type: 'string',
                pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,6})?Z$',
              },
            },
          },
        },
        allOf: [
          {
            if: {
              properties: {
                kind: {
                  enum: [
                    'encrypted_artifact',
                    'manifest_envelope',
                    'closeout_envelope',
                  ],
                },
              },
            },
            then: {
              required: ['nonceHex'],
            },
          },
          {
            if: {
              properties: {
                kind: {
                  const: 'checksum_file',
                },
              },
            },
            then: {
              not: {
                required: ['nonceHex'],
              },
            },
          },
        ],
      },
    },
    storageRecordProof: {
      type: 'object',
      required: ['proofBytesBase64', 'proofSha256'],
      additionalProperties: false,
      properties: {
        proofBytesBase64: {
          type: 'string',
          pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
        },
        proofSha256: {
          type: 'string',
          pattern: '^[0-9a-f]{64}$',
        },
      },
    },
    summary: {
      type: 'object',
      required: [
        'totalArtifacts',
        'encryptedArtifactCount',
        'totalCiphertextBytes',
      ],
      additionalProperties: false,
      properties: {
        totalArtifacts: { type: 'integer', minimum: 1 },
        encryptedArtifactCount: { type: 'integer', minimum: 1 },
        totalCiphertextBytes: { type: 'integer', minimum: 0 },
      },
    },
  },
});

/**
 * Strict JSON parser rejecting duplicate keys at any depth, unescaped control chars,
 * non-finite numbers, and unterminated strings.
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
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 * Keys sorted by UTF-16 code unit values; no whitespace; standard JSON string/number encoding.
 */
export function canonicalizeJsonJcs(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalizeJsonJcs(item));
    return `[${items.join(',')}]`;
  }
  const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJsonJcs(value[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Ensures relative paths stay strictly inside their designated tree,
 * without leading/trailing/duplicate slashes or `.`/`..` segments.
 */
export function assertSafeRelativePath(relPath, label = 'path') {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (!SAFE_RELATIVE_PATH.test(relPath)) {
    throw new Error(`${label} contains invalid characters: ${relPath}`);
  }
  if (relPath.startsWith('/') || relPath.endsWith('/') || relPath.includes('//')) {
    throw new Error(`${label} cannot have leading/trailing/duplicate slashes: ${relPath}`);
  }
  const segments = relPath.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new Error(`${label} cannot contain empty, dot or dot-dot segments: ${relPath}`);
    }
  }
  return relPath;
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
  assert.equal(index.format, OFFSITE_BUNDLE_INDEX_FORMAT, 'format must be crm-offsite-bundle-index/v1');
  assert.match(index.backupId, BACKUP_ID_RE, 'backupId must match backup ID format');
  assert.ok(index.backupId.length <= 256, 'backupId max length is 256');
  assert.match(index.projectRef, PROJECT_REF_RE, 'projectRef format invalid');
  assert.match(index.createdAt, UTC_TIMESTAMP_RE, 'createdAt must be UTC RFC 3339');

  // Destination validation
  assert.ok(index.destination && typeof index.destination === 'object', 'destination must be an object');
  assert.ok(APPROVED_DESTINATION_PROVIDERS.includes(index.destination.provider), 'unsupported provider');
  assert.ok(typeof index.destination.destinationId === 'string' && index.destination.destinationId.length > 0, 'destinationId required');
  assert.ok(typeof index.destination.bucket === 'string' && index.destination.bucket.length > 0, 'bucket required');
  assert.ok(typeof index.destination.prefix === 'string', 'prefix required');

  // StorageRecordProof validation (§23.1)
  assert.ok(index.storageRecordProof && typeof index.storageRecordProof === 'object', 'storageRecordProof must be an object');
  assert.match(index.storageRecordProof.proofBytesBase64, BASE64_RE, 'proofBytesBase64 must be valid standard base64');
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
    assertSafeRelativePath(artifact.path, 'artifact path');

    // Circular dependency check (§23.1)
    assert.notEqual(artifact.path, CLOSEOUT_SHA256SUMS_PATH, 'circular dependency: index MUST NOT contain closeout/SHA256SUMS');
    assert.notEqual(artifact.path, OFFSITE_INDEX_PATH, 'circular dependency: index MUST NOT contain itself');

    // Duplicate check
    assert.ok(!seenPaths.has(artifact.path), `duplicate artifact path: ${artifact.path}`);
    seenPaths.add(artifact.path);

    assert.ok(ARTIFACT_KINDS.includes(artifact.kind), `invalid kind: ${artifact.kind}`);
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

    if (artifact.path === MANIFEST_ENVELOPE) {
      assert.equal(artifact.kind, 'manifest_envelope');
      hasManifestEnvelope = true;
    }
    if (artifact.path === MANIFEST_SUMS) {
      assert.equal(artifact.kind, 'checksum_file');
      hasChecksumFile = true;
    }
    if (artifact.path.startsWith('closeout/')) {
      assert.equal(artifact.path, CLOSEOUT_ENVELOPE, 'closeout encrypted artifact MUST only be closeout/backup-closeout.json.aesgcm');
      assert.equal(artifact.kind, 'closeout_envelope');
      hasCloseoutEnvelope = true;
    }

    // Remote metadata
    assert.ok(artifact.remote && typeof artifact.remote === 'object', 'artifact.remote required');
    assert.ok(typeof artifact.remote.objectKey === 'string' && artifact.remote.objectKey.length > 0, 'remote.objectKey required');
    assert.ok(typeof artifact.remote.immutableVersionId === 'string' && artifact.remote.immutableVersionId.length > 0, 'remote.immutableVersionId required');
    assert.match(artifact.remote.retentionUntil, UTC_TIMESTAMP_RE, 'remote.retentionUntil format invalid');
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
