#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APPROVED_DESTINATION_PROVIDERS,
  CLOSEOUT_ENVELOPE,
  CLOSEOUT_EXACT_FILES,
  CLOSEOUT_PAYLOADS,
  MANIFEST_ENVELOPE,
  MANIFEST_SUMS,
  OFFSITE_BUNDLE_INDEX_FORMAT,
  OFFSITE_BUNDLE_INDEX_SCHEMA,
  assertSafeRelativePath,
  canonicalizeJsonJcs,
  parseJsonStrict,
  validateAgainstSchema,
  validateBundleIndex,
} from './contracts/offsite-bundle-index.mjs';

const MAGIC = Buffer.from('CRMBKP01', 'ascii');
const FORMAT_VERSION = 0x01;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_FIXED_BYTES = 25;
const KEY_BYTES = 32;
const MAX_AAD_BYTES = 4096;

export class HelperError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HelperError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new HelperError(code, message);
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function hasPrivateMode(mode) {
  return (mode & 0o077) === 0;
}

function formatMode(mode) {
  return (mode & 0o777).toString(8).padStart(4, '0');
}

// Temporary file tracking for clean interruption handling
const activeTempFiles = new Set();
let signalsInstalled = false;

function registerTemp(tempPath) {
  activeTempFiles.add(tempPath);
}

function unregisterTemp(tempPath) {
  activeTempFiles.delete(tempPath);
}

function cleanupTempFilesSync() {
  for (const tempPath of activeTempFiles) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup
    }
  }
  activeTempFiles.clear();
}

function installSignalHandlers() {
  if (signalsInstalled) return;
  signalsInstalled = true;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      cleanupTempFilesSync();
      process.exit(128 + 15);
    });
  }
  process.on('exit', () => {
    cleanupTempFilesSync();
  });
}

async function fsyncDirectory(dirPath) {
  let handle;
  try {
    handle = await fsp.open(dirPath, fs.constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Some platforms / filesystems do not support directory fsync
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function createTempFile(parentDir, prefix = 'offsite-tmp-') {
  for (let i = 0; i < 20; i += 1) {
    const randomHex = crypto.randomBytes(8).toString('hex');
    const tempPath = path.join(parentDir, `.${prefix}${randomHex}`);
    let handle;
    try {
      handle = await fsp.open(
        tempPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600,
      );
      await handle.chmod(0o600);
      registerTemp(tempPath);
      return { handle, tempPath };
    } catch (err) {
      if (handle) await handle.close().catch(() => {});
      if (err && err.code === 'EEXIST') continue;
      fail('TEMP_CREATE_FAILED', `cannot create temporary file: ${err.message}`);
    }
  }
  fail('TEMP_CREATE_FAILED', 'temporary file name collision limit exceeded');
}

async function publishNoReplace(tempHandle, tempPath, destination) {
  try {
    await fsp.link(tempPath, destination);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      fail('OUTPUT_EXISTS', `output path already exists: ${destination}`);
    }
    fail('PUBLISH_FAILED', `output could not be published atomically without overwrite: ${error.message}`);
  }
  try {
    await fsp.unlink(tempPath);
  } catch {
    await fsp.unlink(destination).catch(() => {});
    fail('PUBLISH_FAILED', 'temporary file could not be removed after publication');
  }
  unregisterTemp(tempPath);
  if (tempHandle) {
    await tempHandle.close().catch(() => {});
  }
  await fsyncDirectory(path.dirname(destination));
}

async function validateRootDirectory(root) {
  if (typeof root !== 'string' || root.length === 0) fail('USAGE', '--root is required');
  const resolved = path.resolve(root);
  let stat;
  try {
    stat = await fsp.lstat(resolved);
  } catch (error) {
    if (error && error.code === 'ENOENT') fail('ROOT_INVALID', 'backup root does not exist');
    fail('ROOT_INVALID', 'backup root cannot be inspected');
  }
  if (stat.isSymbolicLink()) fail('ROOT_SYMLINK', 'backup root must not be a symlink');
  if (!stat.isDirectory()) fail('ROOT_INVALID', 'backup root must be a directory');
  if (!hasPrivateMode(stat.mode)) {
    fail('ROOT_PERMISSIONS', `backup root mode ${formatMode(stat.mode)} permits group/other access`);
  }
  if ((stat.mode & 0o500) !== 0o500) {
    fail('ROOT_PERMISSIONS', 'backup root must be owner readable and executable');
  }
  return resolved;
}

async function readKeyFile(keyFile) {
  if (typeof keyFile !== 'string' || keyFile.length === 0) {
    fail('USAGE', '--key-file is required');
  }
  const resolved = path.resolve(keyFile);
  let before;
  try {
    before = await fsp.lstat(resolved);
  } catch (error) {
    if (error && error.code === 'ENOENT') fail('KEY_FILE_NOT_FOUND', 'key file does not exist');
    fail('KEY_FILE_READ', 'key file cannot be inspected');
  }
  if (before.isSymbolicLink()) fail('KEY_FILE_SYMLINK', 'key file must not be a symlink');
  if (!before.isFile()) fail('KEY_FILE_NOT_REGULAR', 'key file must be a regular file');
  if (!hasPrivateMode(before.mode) || (before.mode & 0o111) !== 0) {
    fail('KEY_FILE_PERMISSIONS', `key file mode ${formatMode(before.mode)} is not a private data file`);
  }
  if (before.size !== KEY_BYTES) {
    fail('KEY_FILE_SIZE', `key file must contain exactly ${KEY_BYTES} raw bytes`);
  }
  if (typeof process.getuid === 'function' && before.uid !== process.getuid()) {
    fail('KEY_FILE_OWNER', 'key file must be owned by the current user');
  }

  let handle;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    handle = await fsp.open(resolved, flags);
  } catch (error) {
    if (error && error.code === 'ELOOP') fail('KEY_FILE_SYMLINK', 'key file must not be a symlink');
    fail('KEY_FILE_READ', 'key file cannot be opened');
  }
  try {
    const after = await handle.stat();
    if (!after.isFile()) fail('KEY_FILE_NOT_REGULAR', 'key file must be a regular file');
    if (!hasPrivateMode(after.mode) || (after.mode & 0o111) !== 0) {
      fail('KEY_FILE_PERMISSIONS', `key file mode ${formatMode(after.mode)} is not a private data file`);
    }
    if (after.size !== KEY_BYTES) {
      fail('KEY_FILE_SIZE', `key file must contain exactly ${KEY_BYTES} raw bytes`);
    }
    const buffer = Buffer.alloc(KEY_BYTES);
    let bytesRead = 0;
    while (bytesRead < KEY_BYTES) {
      const res = await handle.read(buffer, bytesRead, KEY_BYTES - bytesRead, bytesRead);
      if (res.bytesRead === 0) break;
      bytesRead += res.bytesRead;
    }
    if (bytesRead !== KEY_BYTES) {
      fail('KEY_FILE_READ', 'could not read full 32 bytes from key file');
    }
    return buffer;
  } finally {
    await handle.close().catch(() => {});
  }
}

function resolveSuppliedPath(rootPath, value, optionName) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('USAGE', `--${optionName} is required`);
  }
  if (path.isAbsolute(value)) return path.resolve(value);
  const resolved = path.resolve(rootPath, value);
  const relative = path.relative(rootPath, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('USAGE', `--${optionName} must stay inside the backup root when relative`);
  }
  return resolved;
}

function parseAad(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    fail('AAD_INVALID', 'AAD is empty');
  }
  if (buffer.length > MAX_AAD_BYTES) {
    fail('AAD_LENGTH_INVALID', 'AAD exceeds the reviewed format limit');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    fail('AAD_INVALID', 'AAD is not valid UTF-8');
  }
  const fields = text.split('|');
  if (fields.length !== 5 || fields[0] !== 'v1') {
    fail('AAD_INVALID', 'AAD does not match the v1 field layout');
  }
  const prefixes = ['backup=', 'artifact=', 'bytes=', 'sha256='];
  const values = [];
  for (let index = 0; index < prefixes.length; index += 1) {
    const field = fields[index + 1];
    if (!field.startsWith(prefixes[index])) {
      fail('AAD_INVALID', 'AAD field prefix is invalid');
    }
    values.push(field.slice(prefixes[index].length));
  }
  const [backupId, artifact, bytesText, sha256] = values;
  const bytes = Number(bytesText);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    fail('AAD_INVALID', 'AAD byte count is invalid');
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    fail('AAD_INVALID', 'AAD SHA-256 is invalid');
  }
  return {
    text,
    backupId,
    artifact,
    bytes,
    sha256,
  };
}

export function parseEnvelopeHeaderBuffer(buffer) {
  const fileSize = buffer.length;
  if (fileSize < HEADER_FIXED_BYTES + TAG_BYTES) {
    fail('ENVELOPE_TOO_SMALL', 'envelope is smaller than the fixed header plus authentication tag');
  }
  const fixed = buffer.subarray(0, HEADER_FIXED_BYTES);
  if (!fixed.subarray(0, MAGIC.length).equals(MAGIC)) {
    fail('ENVELOPE_MAGIC_INVALID', 'envelope magic is invalid');
  }
  if (fixed[MAGIC.length] !== FORMAT_VERSION) {
    fail('ENVELOPE_VERSION_UNSUPPORTED', 'envelope format version is not supported');
  }
  const nonce = Buffer.from(fixed.subarray(9, 9 + NONCE_BYTES));
  const aadLength = fixed.readUInt32BE(21);
  if (aadLength === 0 || aadLength > MAX_AAD_BYTES) {
    fail('AAD_LENGTH_INVALID', 'AAD length is outside the reviewed format limit');
  }
  const minimumSize = HEADER_FIXED_BYTES + aadLength + TAG_BYTES;
  if (fileSize < minimumSize) {
    fail('ENVELOPE_TRUNCATED', 'envelope is truncated inside the header or authentication tag');
  }
  const aadBuffer = buffer.subarray(HEADER_FIXED_BYTES, HEADER_FIXED_BYTES + aadLength);
  const aad = parseAad(aadBuffer);
  const ciphertextOffset = HEADER_FIXED_BYTES + aadLength;
  const tagOffset = fileSize - TAG_BYTES;
  const ciphertextBytes = tagOffset - ciphertextOffset;
  const tag = buffer.subarray(tagOffset, fileSize);
  return {
    fixed,
    nonce,
    nonceHex: nonce.toString('hex'),
    aad,
    aadBuffer,
    aadLength,
    ciphertextOffset,
    ciphertextBytes,
    tagOffset,
    tag,
  };
}

async function readEnvelopeHeaderAt(filePath) {
  let handle;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    handle = await fsp.open(filePath, flags);
    const stat = await handle.stat();
    if (!stat.isFile()) fail('ARTIFACT_NOT_FILE', `${filePath} is not a regular file`);
    if (!hasPrivateMode(stat.mode)) {
      fail('ARTIFACT_PERMISSIONS', `${filePath} permissions permit group/other access`);
    }
    const fileSize = stat.size;
    if (fileSize < HEADER_FIXED_BYTES + TAG_BYTES) {
      fail('ENVELOPE_TOO_SMALL', `${filePath} is smaller than minimum header size`);
    }
    const fixed = Buffer.alloc(HEADER_FIXED_BYTES);
    await handle.read(fixed, 0, HEADER_FIXED_BYTES, 0);
    if (!fixed.subarray(0, MAGIC.length).equals(MAGIC)) {
      fail('ENVELOPE_MAGIC_INVALID', `${filePath} envelope magic is invalid`);
    }
    if (fixed[MAGIC.length] !== FORMAT_VERSION) {
      fail('ENVELOPE_VERSION_UNSUPPORTED', `${filePath} envelope format version is not supported`);
    }
    const nonce = Buffer.from(fixed.subarray(9, 9 + NONCE_BYTES));
    const aadLength = fixed.readUInt32BE(21);
    if (aadLength === 0 || aadLength > MAX_AAD_BYTES) {
      fail('AAD_LENGTH_INVALID', `${filePath} AAD length invalid`);
    }
    const minimumSize = HEADER_FIXED_BYTES + aadLength + TAG_BYTES;
    if (fileSize < minimumSize) {
      fail('ENVELOPE_TRUNCATED', `${filePath} truncated`);
    }
    const aadBuffer = Buffer.alloc(aadLength);
    await handle.read(aadBuffer, 0, aadLength, HEADER_FIXED_BYTES);
    const aad = parseAad(aadBuffer);
    return {
      fileSize,
      nonce,
      nonceHex: nonce.toString('hex'),
      aad,
      aadBuffer,
      aadLength,
      ciphertextOffset: HEADER_FIXED_BYTES + aadLength,
      ciphertextBytes: fileSize - HEADER_FIXED_BYTES - aadLength - TAG_BYTES,
    };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function decryptEnvelopeBuffer(envelopeBytes, key, expectedBackupId, expectedArtifact) {
  const header = parseEnvelopeHeaderBuffer(envelopeBytes);
  if (header.aad.backupId !== expectedBackupId) {
    fail('AAD_BACKUP_ID_MISMATCH', `AAD backup id mismatch: ${header.aad.backupId} !== ${expectedBackupId}`);
  }
  if (header.aad.artifact !== expectedArtifact) {
    fail('AAD_ARTIFACT_MISMATCH', `AAD artifact path mismatch: ${header.aad.artifact} !== ${expectedArtifact}`);
  }
  const ciphertext = envelopeBytes.subarray(header.ciphertextOffset, header.tagOffset);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.nonce);
  decipher.setAAD(header.aadBuffer);
  decipher.setAuthTag(header.tag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    fail('AUTHENTICATION_FAILED', `GCM authentication failed: ${err.message}`);
  }
  const actualHash = sha256Hex(plaintext);
  if (actualHash !== header.aad.sha256) {
    fail('PLAINTEXT_HASH_MISMATCH', 'decrypted plaintext hash does not match AAD');
  }
  if (plaintext.length !== header.aad.bytes) {
    fail('PLAINTEXT_BYTES_MISMATCH', 'decrypted plaintext size does not match AAD');
  }
  return {
    header,
    plaintext,
  };
}

/**
 * Command: canonicalize-storage-record-proof
 */
export async function canonicalizeStorageRecordProof({ proofPath, format, inPlaceAtomic = false }) {
  if (!proofPath) fail('USAGE', '--proof is required');
  if (format !== 'rfc8785-jcs-utf8-no-newline') {
    fail('USAGE', 'unsupported format; expected rfc8785-jcs-utf8-no-newline');
  }
  const resolved = path.resolve(proofPath);
  let stat;
  try {
    stat = await fsp.lstat(resolved);
  } catch {
    fail('PROOF_NOT_FOUND', `proof file not found: ${resolved}`);
  }
  if (stat.isSymbolicLink()) fail('PROOF_SYMLINK', 'proof file cannot be a symlink');
  if (!stat.isFile()) fail('PROOF_NOT_FILE', 'proof must be a regular file');

  const raw = await fsp.readFile(resolved, 'utf8');
  const parsed = parseJsonStrict(raw, 'proof');
  const canonicalText = canonicalizeJsonJcs(parsed);
  const canonicalBytes = Buffer.from(canonicalText, 'utf8');
  const proofSha256 = sha256Hex(canonicalBytes);

  if (inPlaceAtomic) {
    const parentDir = path.dirname(resolved);
    const { handle, tempPath } = await createTempFile(parentDir, 'canonical-proof-');
    try {
      await handle.writeFile(canonicalBytes);
      await handle.sync();
      await handle.close();
      await fsp.rename(tempPath, resolved);
      unregisterTemp(tempPath);
      await fsyncDirectory(parentDir);
    } catch (err) {
      await handle.close().catch(() => {});
      await fsp.unlink(tempPath).catch(() => {});
      unregisterTemp(tempPath);
      fail('CANONICALIZE_FAILED', `failed to write canonical proof atomically: ${err.message}`);
    }
  }

  return {
    status: 'ok',
    format: 'rfc8785-jcs-utf8-no-newline',
    proofPath: resolved,
    proofSha256,
    bytes: canonicalBytes.length,
    canonicalized: inPlaceAtomic,
  };
}

/**
 * Command: verify-canonical-storage-record-proof
 */
export async function verifyCanonicalStorageRecordProof({ proofPath, format }) {
  if (!proofPath) fail('USAGE', '--proof is required');
  if (format !== 'rfc8785-jcs-utf8-no-newline') {
    fail('USAGE', 'unsupported format; expected rfc8785-jcs-utf8-no-newline');
  }
  const resolved = path.resolve(proofPath);
  let stat;
  try {
    stat = await fsp.lstat(resolved);
  } catch {
    fail('PROOF_NOT_FOUND', `proof file not found: ${resolved}`);
  }
  if (stat.isSymbolicLink()) fail('PROOF_SYMLINK', 'proof file cannot be a symlink');
  if (!stat.isFile()) fail('PROOF_NOT_FILE', 'proof must be a regular file');

  const rawBytes = await fsp.readFile(resolved);
  let rawText;
  try {
    rawText = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
  } catch {
    fail('PROOF_NOT_CANONICAL', 'proof file is not valid UTF-8');
  }
  const parsed = parseJsonStrict(rawText, 'proof');
  const canonicalText = canonicalizeJsonJcs(parsed);
  const canonicalBytes = Buffer.from(canonicalText, 'utf8');

  if (Buffer.compare(rawBytes, canonicalBytes) !== 0) {
    fail('PROOF_NOT_CANONICAL', 'proof raw bytes differ from RFC 8785 JCS canonical bytes (trailing newline or whitespace detected)');
  }

  return {
    status: 'ok',
    format: 'rfc8785-jcs-utf8-no-newline',
    proofPath: resolved,
    proofSha256: sha256Hex(rawBytes),
    bytes: rawBytes.length,
    canonical: true,
  };
}

/**
 * Command: build-index
 */
export async function buildIndex({
  root,
  keyFile,
  backupId,
  mainManifestCiphertext,
  receipt,
  receiptStorageRecord,
  receiptStorageRecordObjectProof,
  approvedDestinationRecord,
  out,
  projectRef = 'qmhfmgkymjgoevwmkidm',
}) {
  const rootPath = await validateRootDirectory(root);
  const key = await readKeyFile(keyFile);
  const keyFingerprint = sha256Hex(key);

  const manifestPath = resolveSuppliedPath(rootPath, mainManifestCiphertext, 'main-manifest-ciphertext');
  const receiptPath = resolveSuppliedPath(rootPath, receipt, 'receipt');
  const recordPath = resolveSuppliedPath(rootPath, receiptStorageRecord, 'receipt-storage-record');
  const proofPath = resolveSuppliedPath(rootPath, receiptStorageRecordObjectProof, 'receipt-storage-record-object-proof');
  const destPath = resolveSuppliedPath(rootPath, approvedDestinationRecord, 'approved-destination-record');
  const outPath = resolveSuppliedPath(rootPath, out, 'out');

  // Verify receipts and records are valid JSON
  const receiptRaw = await fsp.readFile(receiptPath, 'utf8');
  parseJsonStrict(receiptRaw, 'receipt');
  const recordRaw = await fsp.readFile(recordPath, 'utf8');
  parseJsonStrict(recordRaw, 'receipt-storage-record');

  // Verify proof is strictly canonical JCS bytes before proceeding
  await verifyCanonicalStorageRecordProof({ proofPath, format: 'rfc8785-jcs-utf8-no-newline' });
  const proofRawBytes = await fsp.readFile(proofPath);
  const proofBytesBase64 = proofRawBytes.toString('base64');
  const proofSha256 = sha256Hex(proofRawBytes);

  // Read approved destination record
  const destRecordRaw = await fsp.readFile(destPath, 'utf8');
  const destRecord = parseJsonStrict(destRecordRaw, 'approved-destination-record');
  const destination = destRecord.destination ?? destRecord;
  if (!APPROVED_DESTINATION_PROVIDERS.includes(destination.provider)) {
    fail('DESTINATION_PROVIDER_UNSUPPORTED', `unsupported provider: ${destination.provider}`);
  }
  if (!destination.destinationId || !destination.bucket || destination.prefix === undefined) {
    fail('DESTINATION_RECORD_INVALID', 'destination record missing required fields');
  }

  // Decrypt and authenticate main manifest
  const manifestBytes = await fsp.readFile(manifestPath);
  const decryptedManifest = await decryptEnvelopeBuffer(
    manifestBytes,
    key,
    backupId,
    'manifest/backup-manifest.json',
  );
  const manifestObj = parseJsonStrict(decryptedManifest.plaintext.toString('utf8'), 'manifest');
  if (manifestObj.format !== 'crm-staging-backup-manifest/v1') {
    fail('MANIFEST_FORMAT_INVALID', 'manifest format mismatch');
  }
  if (manifestObj.backupId !== backupId) {
    fail('MANIFEST_BACKUP_ID_MISMATCH', 'manifest backupId does not match --backup-id');
  }
  if (manifestObj.keys?.fingerprint !== keyFingerprint) {
    fail('MANIFEST_KEY_FINGERPRINT_MISMATCH', 'manifest key fingerprint does not match key file');
  }

  // Nonce and path collision tracker
  const seenNonces = new Map();
  const seenPaths = new Set();

  function trackNonce(pathRel, nonceHex) {
    if (seenNonces.has(nonceHex)) {
      const prior = seenNonces.get(nonceHex);
      fail('NONCE_REUSE', `duplicate nonce detected between ${prior} and ${pathRel}: ${nonceHex}`);
    }
    seenNonces.set(nonceHex, pathRel);
  }

  const artifacts = [];

  // 1. Process main artifacts listed in the manifest
  for (const entry of manifestObj.artifacts) {
    const relPath = assertSafeRelativePath(entry.path, 'manifest artifact path');
    if (seenPaths.has(relPath)) {
      fail('DUPLICATE_ARTIFACT_PATH', `duplicate artifact path in manifest: ${relPath}`);
    }
    seenPaths.add(relPath);

    const fullPath = path.join(rootPath, relPath);
    const header = await readEnvelopeHeaderAt(fullPath);
    if (header.aad.backupId !== backupId) {
      fail('AAD_BACKUP_ID_MISMATCH', `AAD backup id mismatch on ${relPath}`);
    }
    if (header.aad.artifact !== relPath.slice(0, -'.aesgcm'.length)) {
      fail('AAD_ARTIFACT_MISMATCH', `AAD artifact path mismatch on ${relPath}`);
    }

    trackNonce(relPath, header.nonceHex);

    const ciphertextRaw = await fsp.readFile(fullPath);
    const ciphertextSha256 = sha256Hex(ciphertextRaw);
    if (entry.ciphertextSha256 && entry.ciphertextSha256 !== ciphertextSha256) {
      fail('CIPHERTEXT_HASH_MISMATCH', `hash on disk differs from manifest for ${relPath}`);
    }

    artifacts.push({
      path: relPath,
      kind: 'encrypted_artifact',
      ciphertextSha256,
      ciphertextBytes: ciphertextRaw.length,
      nonceHex: header.nonceHex,
      remote: {
        objectKey: path.posix.join(destination.prefix, relPath),
        immutableVersionId: `v1_${ciphertextSha256.slice(0, 16)}`,
        retentionUntil: '2027-11-01T12:00:00.000Z',
      },
    });
  }

  // 2. Add manifest envelope (manifest/backup-manifest.json.aesgcm)
  {
    const relPath = MANIFEST_ENVELOPE;
    if (seenPaths.has(relPath)) fail('DUPLICATE_ARTIFACT_PATH', `duplicate path: ${relPath}`);
    seenPaths.add(relPath);

    const fullPath = path.join(rootPath, relPath);
    const header = await readEnvelopeHeaderAt(fullPath);
    trackNonce(relPath, header.nonceHex);

    const ciphertextRaw = await fsp.readFile(fullPath);
    const ciphertextSha256 = sha256Hex(ciphertextRaw);

    artifacts.push({
      path: relPath,
      kind: 'manifest_envelope',
      ciphertextSha256,
      ciphertextBytes: ciphertextRaw.length,
      nonceHex: header.nonceHex,
      remote: {
        objectKey: path.posix.join(destination.prefix, relPath),
        immutableVersionId: `v1_${ciphertextSha256.slice(0, 16)}`,
        retentionUntil: '2027-11-01T12:00:00.000Z',
      },
    });
  }

  // 3. Add manifest checksum file (manifest/SHA256SUMS)
  {
    const relPath = MANIFEST_SUMS;
    if (seenPaths.has(relPath)) fail('DUPLICATE_ARTIFACT_PATH', `duplicate path: ${relPath}`);
    seenPaths.add(relPath);

    const fullPath = path.join(rootPath, relPath);
    let stat;
    try {
      stat = await fsp.lstat(fullPath);
    } catch {
      fail('MANIFEST_SUMS_MISSING', `missing checksum file: ${fullPath}`);
    }
    if (stat.isSymbolicLink()) fail('MANIFEST_SUMS_SYMLINK', 'checksum file must not be a symlink');
    if (!stat.isFile()) fail('MANIFEST_SUMS_NOT_FILE', 'checksum file must be a regular file');

    const sumsBytes = await fsp.readFile(fullPath);
    const sumsSha256 = sha256Hex(sumsBytes);

    // Plaintext checksum file MUST OMIT nonceHex!
    artifacts.push({
      path: relPath,
      kind: 'checksum_file',
      ciphertextSha256: sumsSha256,
      ciphertextBytes: sumsBytes.length,
      remote: {
        objectKey: path.posix.join(destination.prefix, relPath),
        immutableVersionId: `v1_${sumsSha256.slice(0, 16)}`,
        retentionUntil: '2027-11-01T12:00:00.000Z',
      },
    });
  }

  // 4. Add closeout envelope (closeout/backup-closeout.json.aesgcm)
  {
    const relPath = CLOSEOUT_ENVELOPE;
    if (seenPaths.has(relPath)) fail('DUPLICATE_ARTIFACT_PATH', `duplicate path: ${relPath}`);
    seenPaths.add(relPath);

    const fullPath = path.join(rootPath, relPath);
    const header = await readEnvelopeHeaderAt(fullPath);
    if (header.aad.backupId !== backupId) {
      fail('AAD_BACKUP_ID_MISMATCH', `closeout AAD backup id mismatch on ${relPath}`);
    }
    trackNonce(relPath, header.nonceHex);

    const ciphertextRaw = await fsp.readFile(fullPath);
    const ciphertextSha256 = sha256Hex(ciphertextRaw);

    artifacts.push({
      path: relPath,
      kind: 'closeout_envelope',
      ciphertextSha256,
      ciphertextBytes: ciphertextRaw.length,
      nonceHex: header.nonceHex,
      remote: {
        objectKey: path.posix.join(destination.prefix, relPath),
        immutableVersionId: `v1_${ciphertextSha256.slice(0, 16)}`,
        retentionUntil: '2027-11-01T12:00:00.000Z',
      },
    });
  }

  const totalCiphertextBytes = artifacts.reduce((sum, a) => sum + a.ciphertextBytes, 0);

  const indexData = {
    format: OFFSITE_BUNDLE_INDEX_FORMAT,
    backupId,
    projectRef,
    createdAt: new Date().toISOString(),
    destination: {
      provider: destination.provider,
      destinationId: destination.destinationId,
      bucket: destination.bucket,
      prefix: destination.prefix,
    },
    artifacts,
    storageRecordProof: {
      proofBytesBase64,
      proofSha256,
    },
    summary: {
      totalArtifacts: artifacts.length,
      encryptedArtifactCount: artifacts.filter((a) => a.path.endsWith('.aesgcm')).length,
      totalCiphertextBytes,
    },
  };

  // Self-validate against wire schema and business invariants
  validateAgainstSchema(OFFSITE_BUNDLE_INDEX_SCHEMA, indexData);
  validateBundleIndex(indexData);

  // Atomic publication
  const outDir = path.dirname(outPath);
  const outStat = await fsp.lstat(outDir).catch(() => null);
  if (!outStat || !outStat.isDirectory()) {
    fail('OUT_DIR_INVALID', `output parent directory does not exist or is not a directory: ${outDir}`);
  }

  const { handle: tempHandle, tempPath } = await createTempFile(outDir, 'offsite-index-');
  const indexJsonText = JSON.stringify(indexData, null, 2);
  const indexBytes = Buffer.from(indexJsonText, 'utf8');

  try {
    await tempHandle.writeFile(indexBytes);
    await tempHandle.sync();
    await publishNoReplace(tempHandle, tempPath, outPath);
  } catch (err) {
    await tempHandle.close().catch(() => {});
    await fsp.unlink(tempPath).catch(() => {});
    unregisterTemp(tempPath);
    throw err;
  }

  const indexSha256 = sha256Hex(indexBytes);

  return {
    status: 'ok',
    out: outPath,
    backupId,
    totalArtifacts: artifacts.length,
    encryptedArtifactCount: indexData.summary.encryptedArtifactCount,
    totalCiphertextBytes,
    indexSha256,
    evidenceLevel: 'local-synthetic-preparation-only',
  };
}

/**
 * Command: verify-index
 */
export async function verifyIndex({
  root,
  mainManifest,
  receipt,
  receiptStorageRecord,
  receiptStorageRecordObjectProof,
  index,
  checksums,
  approvedDestinationRecord,
  backupId,
  projectRef,
  finalizationReceipt = null,
  catalogEntry = null,
  approvedRegistryRecord = null,
}) {
  const rootPath = await validateRootDirectory(root);

  const indexPath = resolveSuppliedPath(rootPath, index, 'index');
  const checksumsPath = resolveSuppliedPath(rootPath, checksums, 'checksums');
  const proofPath = resolveSuppliedPath(rootPath, receiptStorageRecordObjectProof, 'receipt-storage-record-object-proof');
  const receiptPath = resolveSuppliedPath(rootPath, receipt, 'receipt');
  const recordPath = resolveSuppliedPath(rootPath, receiptStorageRecord, 'receipt-storage-record');
  const manifestPath = resolveSuppliedPath(rootPath, mainManifest, 'main-manifest');
  const destPath = resolveSuppliedPath(rootPath, approvedDestinationRecord, 'approved-destination-record');

  // 1. Read and parse offsite-bundle-index.json
  const indexRaw = await fsp.readFile(indexPath, 'utf8');
  const indexObj = parseJsonStrict(indexRaw, 'offsite-bundle-index');

  // Validate schema and business invariants
  validateAgainstSchema(OFFSITE_BUNDLE_INDEX_SCHEMA, indexObj);
  validateBundleIndex(indexObj);

  if (indexObj.backupId !== backupId) {
    fail('INDEX_BACKUP_ID_MISMATCH', `index backupId (${indexObj.backupId}) does not match --backup-id (${backupId})`);
  }
  if (indexObj.projectRef !== projectRef) {
    fail('INDEX_PROJECT_REF_MISMATCH', `index projectRef (${indexObj.projectRef}) does not match --project-ref (${projectRef})`);
  }

  // Verify approved destination matches index destination
  const destRaw = await fsp.readFile(destPath, 'utf8');
  const destObj = parseJsonStrict(destRaw, 'approved-destination-record');
  const destination = destObj.destination ?? destObj;
  if (destination.destinationId !== indexObj.destination.destinationId || destination.bucket !== indexObj.destination.bucket) {
    fail('DESTINATION_MISMATCH', 'index destination does not match approved destination record');
  }

  // Verify main manifest matches index artifacts
  const manifestRaw = await fsp.readFile(manifestPath, 'utf8');
  const manifestObj = parseJsonStrict(manifestRaw, 'main-manifest');
  const indexPaths = new Set(indexObj.artifacts.map((a) => a.path));
  for (const art of manifestObj.artifacts) {
    if (!indexPaths.has(art.path)) {
      fail('MANIFEST_INDEX_MISMATCH', `manifest artifact missing from index: ${art.path}`);
    }
  }

  // 2. Verify closeout directory exact 6 files
  const closeoutDir = path.join(rootPath, 'closeout');
  const closeoutEntries = await fsp.readdir(closeoutDir, { withFileTypes: true });
  const entryNames = closeoutEntries.map((e) => e.name).sort();
  const expectedNames = [...CLOSEOUT_EXACT_FILES].sort();

  if (entryNames.length !== expectedNames.length || !entryNames.every((v, i) => v === expectedNames[i])) {
    fail('CLOSEOUT_INVENTORY_MISMATCH', `closeout directory entries (${entryNames.join(', ')}) do not match exact set (${expectedNames.join(', ')})`);
  }
  for (const entry of closeoutEntries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      fail('CLOSEOUT_ENTRY_INVALID', `closeout entry ${entry.name} is not a regular non-symlink file`);
    }
  }

  // 3. Verify closeout/SHA256SUMS exact 5 entries matching payloads
  const sumsRaw = await fsp.readFile(checksumsPath, 'utf8');
  const lines = sumsRaw.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length !== 5) {
    fail('CLOSEOUT_SUMS_COUNT_MISMATCH', `closeout/SHA256SUMS must contain exactly 5 lines; found ${lines.length}`);
  }

  const sumsMap = new Map();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})\s+([A-Za-z0-9._/-]+)$/.exec(line);
    if (!match) fail('CLOSEOUT_SUMS_LINE_INVALID', `malformed checksum line: ${line}`);
    const [, hash, relPath] = match;
    if (sumsMap.has(relPath)) fail('CLOSEOUT_SUMS_DUPLICATE', `duplicate path in checksums: ${relPath}`);
    sumsMap.set(relPath, hash);
  }

  for (const expectedPayload of CLOSEOUT_PAYLOADS) {
    if (!sumsMap.has(expectedPayload)) {
      fail('CLOSEOUT_SUMS_MISSING_PAYLOAD', `missing payload in closeout/SHA256SUMS: ${expectedPayload}`);
    }
    const fullPayloadPath = path.join(rootPath, expectedPayload);
    const payloadBytes = await fsp.readFile(fullPayloadPath);
    const payloadHash = sha256Hex(payloadBytes);
    if (sumsMap.get(expectedPayload) !== payloadHash) {
      fail('CLOSEOUT_SUMS_HASH_MISMATCH', `hash mismatch on closeout payload: ${expectedPayload}`);
    }
  }

  // 4. Verify storageRecordProof
  const proofDecoded = Buffer.from(indexObj.storageRecordProof.proofBytesBase64, 'base64');
  const proofDecodedHash = sha256Hex(proofDecoded);
  if (proofDecodedHash !== indexObj.storageRecordProof.proofSha256) {
    fail('PROOF_HASH_MISMATCH', 'decoded proof hash mismatch');
  }
  const proofFileBytes = await fsp.readFile(proofPath);
  if (Buffer.compare(proofDecoded, proofFileBytes) !== 0) {
    fail('PROOF_BYTE_MISMATCH', 'proof bytes in index do not match proof file on disk');
  }

  // 5. Verify local receipts exist and are valid JSON
  const receiptRaw = await fsp.readFile(receiptPath, 'utf8');
  parseJsonStrict(receiptRaw, 'receipt');
  const recordRaw = await fsp.readFile(recordPath, 'utf8');
  parseJsonStrict(recordRaw, 'receipt-storage-record');

  // Verify external catalog/registry if provided
  if (catalogEntry) {
    const catalogPath = path.isAbsolute(catalogEntry) ? catalogEntry : path.resolve(rootPath, catalogEntry);
    const catRaw = await fsp.readFile(catalogPath, 'utf8');
    parseJsonStrict(catRaw, 'catalog-entry');
  }
  if (approvedRegistryRecord) {
    const regPath = path.isAbsolute(approvedRegistryRecord) ? approvedRegistryRecord : path.resolve(rootPath, approvedRegistryRecord);
    const regRaw = await fsp.readFile(regPath, 'utf8');
    parseJsonStrict(regRaw, 'approved-registry-record');
  }

  const indexBytes = await fsp.readFile(indexPath);
  const indexSha256 = sha256Hex(indexBytes);

  return {
    status: 'ok',
    backupId,
    projectRef,
    verifiedArtifactCount: indexObj.artifacts.length,
    verifiedCloseoutPayloads: 5,
    indexSha256,
    storageRecordProofSha256: proofDecodedHash,
    evidenceLevel: 'local-synthetic-verification-only',
    providerValidation: finalizationReceipt ? 'external-receipt-supplied' : 'local-preparation-only',
  };
}

/**
 * Provider-dependent commands fail-closed when invoked without real provider setup.
 */
function failProviderBlocked(command) {
  fail(
    'PROVIDER_BLOCKED',
    `Command '${command}' is BLOCKED: requires live offsite provider connection and credentials (not available in local synthetic phase)`,
  );
}

const COMMAND_OPTIONS = {
  'canonicalize-storage-record-proof': new Set(['proof', 'format', 'in-place-atomic']),
  'verify-canonical-storage-record-proof': new Set(['proof', 'format']),
  'build-index': new Set([
    'root',
    'key-file',
    'backup-id',
    'main-manifest-ciphertext',
    'receipt',
    'receipt-storage-record',
    'receipt-storage-record-object-proof',
    'approved-destination-record',
    'out',
    'project-ref',
  ]),
  'verify-index': new Set([
    'root',
    'main-manifest',
    'receipt',
    'receipt-storage-record',
    'receipt-storage-record-object-proof',
    'index',
    'checksums',
    'approved-destination-record',
    'backup-id',
    'project-ref',
    'finalization-receipt',
    'catalog-entry',
    'approved-registry-record',
  ]),
  'upload-readback': new Set(['root', 'main-manifest-ciphertext', 'closeout-ciphertext', 'key-file', 'backup-id', 'approved-destination-record']),
  'store-receipt-readback': new Set(['receipt', 'approved-destination-record', 'storage-record-out']),
  'store-storage-record-readback': new Set(['storage-record', 'approved-destination-record', 'object-proof-out']),
  'finalize-upload': new Set(['root', 'index', 'checksums', 'approved-destination-record', 'receipt-out']),
  'publish-finalization': new Set(['finalization-receipt', 'approved-registry-record', 'catalog-entry-out']),
  'verify-published-finalization': new Set(['catalog-entry', 'finalization-receipt', 'approved-registry-record', 'backup-id', 'project-ref']),
  'recover-bootstrap': new Set(['catalog-entry', 'approved-destination-record', 'approved-registry-record', 'restore-root']),
};

const BOOLEAN_OPTIONS = new Set(['in-place-atomic']);

function parseCli(argv) {
  if (argv.length === 0) fail('USAGE', 'missing command');
  const command = argv[0];
  if (command === '--help' || command === '-h' || command === 'help') {
    return { command: 'help', options: {} };
  }
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) {
    fail('USAGE', `unknown command: ${command}`);
  }
  const allowed = COMMAND_OPTIONS[command];
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { command: 'help', options: {} };
    if (!arg.startsWith('--') || arg === '--') fail('USAGE', 'unexpected positional argument');
    const name = arg.slice(2);
    if (!allowed.has(name)) fail('USAGE', `unsupported option for ${command}: --${name}`);
    if (BOOLEAN_OPTIONS.has(name)) {
      options[name] = true;
      continue;
    }
    index += 1;
    if (index >= argv.length || argv[index].startsWith('--')) {
      fail('USAGE', `option --${name} requires an argument`);
    }
    options[name] = argv[index];
  }
  return { command, options };
}

function emitJson(data, stream = process.stdout) {
  stream.write(`${JSON.stringify(data, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCli(argv);
  if (parsed.command === 'help') {
    process.stdout.write(`Usage:
  node scripts/backup/offsite-bundle.mjs canonicalize-storage-record-proof --proof <path> --format rfc8785-jcs-utf8-no-newline [--in-place-atomic]
  node scripts/backup/offsite-bundle.mjs verify-canonical-storage-record-proof --proof <path> --format rfc8785-jcs-utf8-no-newline
  node scripts/backup/offsite-bundle.mjs build-index --root <dir> --key-file <key> --backup-id <id> --main-manifest-ciphertext <path> --receipt <path> --receipt-storage-record <path> --receipt-storage-record-object-proof <path> --approved-destination-record <path> --out <path>
  node scripts/backup/offsite-bundle.mjs verify-index --root <dir> --main-manifest <path> --receipt <path> --receipt-storage-record <path> --receipt-storage-record-object-proof <path> --index <path> --checksums <path> --approved-destination-record <path> --backup-id <id> --project-ref <ref>
`);
    return;
  }

  let result;
  switch (parsed.command) {
    case 'canonicalize-storage-record-proof':
      result = await canonicalizeStorageRecordProof({
        proofPath: parsed.options.proof,
        format: parsed.options.format,
        inPlaceAtomic: Boolean(parsed.options['in-place-atomic']),
      });
      break;
    case 'verify-canonical-storage-record-proof':
      result = await verifyCanonicalStorageRecordProof({
        proofPath: parsed.options.proof,
        format: parsed.options.format,
      });
      break;
    case 'build-index':
      result = await buildIndex({
        root: parsed.options.root,
        keyFile: parsed.options['key-file'],
        backupId: parsed.options['backup-id'],
        mainManifestCiphertext: parsed.options['main-manifest-ciphertext'],
        receipt: parsed.options.receipt,
        receiptStorageRecord: parsed.options['receipt-storage-record'],
        receiptStorageRecordObjectProof: parsed.options['receipt-storage-record-object-proof'],
        approvedDestinationRecord: parsed.options['approved-destination-record'],
        out: parsed.options.out,
        projectRef: parsed.options['project-ref'],
      });
      break;
    case 'verify-index':
      result = await verifyIndex({
        root: parsed.options.root,
        mainManifest: parsed.options['main-manifest'],
        receipt: parsed.options.receipt,
        receiptStorageRecord: parsed.options['receipt-storage-record'],
        receiptStorageRecordObjectProof: parsed.options['receipt-storage-record-object-proof'],
        index: parsed.options.index,
        checksums: parsed.options.checksums,
        approvedDestinationRecord: parsed.options['approved-destination-record'],
        backupId: parsed.options['backup-id'],
        projectRef: parsed.options['project-ref'],
        finalizationReceipt: parsed.options['finalization-receipt'],
        catalogEntry: parsed.options['catalog-entry'],
        approvedRegistryRecord: parsed.options['approved-registry-record'],
      });
      break;
    case 'upload-readback':
    case 'store-receipt-readback':
    case 'store-storage-record-readback':
    case 'finalize-upload':
    case 'publish-finalization':
    case 'verify-published-finalization':
    case 'recover-bootstrap':
      failProviderBlocked(parsed.command);
      break;
    default:
      fail('USAGE', `unhandled command: ${parsed.command}`);
  }

  emitJson(result);
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isDirectInvocation()) {
  installSignalHandlers();
  main().catch((err) => {
    cleanupTempFilesSync();
    const code = err instanceof HelperError ? err.code : 'UNKNOWN';
    process.stderr.write(
      `${JSON.stringify({
        status: 'error',
        error: { code, message: err.message },
      })}\n`,
    );
    process.exit(1);
  });
}
