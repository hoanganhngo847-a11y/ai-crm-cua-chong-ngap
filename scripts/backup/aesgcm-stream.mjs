#!/usr/bin/env node
/**
 * Streaming AES-256-GCM backup artifact helper.
 *
 * Contract source: docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12.md section 5.2.
 *
 * Envelope (all integers big-endian):
 *
 *   offset  size  field
 *   0       8     magic "CRMBKP01"
 *   8       1     format version 0x01
 *   9       12    random 96-bit nonce
 *   21      4     AAD length
 *   25      N     AAD UTF-8
 *   25+N    ...   AES-256-GCM ciphertext (same length as plaintext)
 *   EOF-16  16    GCM authentication tag
 *
 * AAD:
 *
 *   v1|backup=<BACKUP_ID>|artifact=<relative-path>|bytes=<plaintext-bytes>|sha256=<plaintext-sha256>
 *
 * Security properties:
 *   - the 32-byte key is read only from a private regular file; key bytes are
 *     never accepted through argv, environment variables or stdout;
 *   - both hashing and encryption/decryption are streamed with a bounded buffer;
 *   - plaintext is written only to a 0600 temporary file in the destination
 *     directory and is published only after the GCM tag and the AAD byte
 *     count/SHA-256 both verify;
 *   - publication uses an exclusive hard link (no overwrite) followed by
 *     unlinking the temporary name and fsyncing the parent directory;
 *   - failures remove the temporary file and never leave a complete plaintext
 *     at the requested output path;
 *   - only a JSON summary is printed; key material, plaintext and tokens are
 *     never logged.
 *
 * This helper does not create, store, rotate or export keys.
 * Inputs and their ancestor directories must be immutable/exclusively held
 * during use. EOF, metadata and pathname checks detect observed changes, but
 * ordinary filesystem APIs cannot lock out a writer after the last check.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAGIC = Buffer.from('CRMBKP01', 'ascii');
export const FORMAT_VERSION = 0x01;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const HEADER_FIXED_BYTES = 25;
export const KEY_BYTES = 32;
export const MAX_AAD_BYTES = 4096;
export const MAX_BACKUP_ID_BYTES = 256;
export const MAX_ARTIFACT_PATH_BYTES = 1024;
export const MAX_PLAINTEXT_BYTES = 2 ** 36 - 32; // single GCM invocation, just under 64 GiB
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
export const MAX_MANIFEST_ARTIFACTS = 10000;
export const MAX_SHA256SUMS_BYTES = 16 * 1024 * 1024;
export const MAX_CLOSEOUT_BYTES = 64 * 1024 * 1024;
export const MAX_JSON_DEPTH = 64;
export const DEFAULT_CHUNK_SIZE = 64 * 1024;
export const MIN_CHUNK_SIZE = 1024;
export const MAX_CHUNK_SIZE = 8 * 1024 * 1024;
export const MANIFEST_FORMAT = 'crm-staging-backup-manifest/v1';
export const MANIFEST_ARTIFACT = 'manifest/backup-manifest.json';
export const MANIFEST_ENVELOPE = `${MANIFEST_ARTIFACT}.aesgcm`;
export const SHA256SUMS_PATH = 'manifest/SHA256SUMS';
export const CLOSEOUT_PREFIX = 'closeout/';
export const CLOSEOUT_SHA256SUMS_PATH = 'closeout/SHA256SUMS';
export const CLOSEOUT_CLOSEOUT_ENVELOPE = 'closeout/backup-closeout.json.aesgcm';
export const CLOSEOUT_CLOSEOUT_ARTIFACT = 'closeout/backup-closeout.json';
export const CLOSEOUT_PAYLOAD_PATHS = Object.freeze([
  CLOSEOUT_CLOSEOUT_ENVELOPE,
  'closeout/offsite-readback-receipt.json',
  'closeout/receipt-storage-record.json',
  'closeout/receipt-storage-record-object-proof.json',
  'closeout/offsite-bundle-index.json',
]);
export const CLOSEOUT_INDEX_PATH = 'closeout/offsite-bundle-index.json';
export const CLOSEOUT_ENTRY_NAMES = Object.freeze([
  'backup-closeout.json.aesgcm',
  'offsite-readback-receipt.json',
  'receipt-storage-record.json',
  'receipt-storage-record-object-proof.json',
  'offsite-bundle-index.json',
  'SHA256SUMS',
]);
export const STORAGE_BYTES_PREFIX = 'storage/bytes/';

const AES_GCM = 'aes-256-gcm';
const TEMP_PREFIX = '.aesgcm-stream.tmp-';
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9._/-]+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const NONCE_HEX = /^[0-9a-f]{24}$/;
const BACKUP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Strict JSON parser used for the authenticated manifest and the supplemental
 * bundle index. JSON.parse silently keeps the last duplicate object key; a
 * duplicate key is ambiguous for every downstream consumer, so reject it here
 * (at any nesting depth). Strings with unpaired UTF-16 surrogates and
 * non-finite numbers are also rejected.
 */
function parseJsonStrict(text, code, label) {
  let index = 0;
  const length = text.length;

  const invalid = (message) => fail(code, `${label} ${message}`);

  const skipWhitespace = () => {
    while (index < length) {
      const codePoint = text.charCodeAt(index);
      if (codePoint === 0x20 || codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) {
        index += 1;
      } else {
        break;
      }
    }
  };

  const expectLiteral = (literal, value) => {
    if (text.slice(index, index + literal.length) !== literal) invalid('contains invalid JSON');
    index += literal.length;
    return value;
  };

  const parseString = () => {
    if (text[index] !== '"') invalid('contains an invalid JSON string');
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
        if (index >= length) invalid('contains an unterminated escape sequence');
        const escape = text[index];
        index += 1;
        switch (escape) {
          case '"': result += '"'; break;
          case '\\': result += '\\'; break;
          case '/': result += '/'; break;
          case 'b': result += '\b'; break;
          case 'f': result += '\f'; break;
          case 'n': result += '\n'; break;
          case 'r': result += '\r'; break;
          case 't': result += '\t'; break;
          case 'u': {
            if (index + 4 > length) invalid('contains an unterminated unicode escape');
            const hex = text.slice(index, index + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) invalid('contains an invalid unicode escape');
            const unit = Number.parseInt(hex, 16);
            index += 4;
            if (unit >= 0xd800 && unit <= 0xdbff) {
              if (text.slice(index, index + 2) !== '\\u') {
                invalid('contains an unpaired high surrogate');
              }
              index += 2;
              if (index + 4 > length) invalid('contains an unterminated low surrogate');
              const lowHex = text.slice(index, index + 4);
              if (!/^[0-9a-fA-F]{4}$/.test(lowHex)) invalid('contains an invalid low surrogate');
              const low = Number.parseInt(lowHex, 16);
              if (low < 0xdc00 || low > 0xdfff) invalid('contains an unpaired high surrogate');
              index += 4;
              result += String.fromCharCode(unit, low);
            } else if (unit >= 0xdc00 && unit <= 0xdfff) {
              invalid('contains an unpaired low surrogate');
            } else {
              result += String.fromCharCode(unit);
            }
            break;
          }
          default:
            invalid('contains an invalid escape sequence');
        }
        continue;
      }
      const codePoint = text.charCodeAt(index);
      if (codePoint < 0x20) invalid('contains an unescaped control character');
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
        if (codePoint <= 0xdbff && index + 1 < length) {
          const next = text.charCodeAt(index + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            result += text[index] + text[index + 1];
            index += 2;
            continue;
          }
        }
        invalid('contains an unpaired surrogate');
      }
      result += char;
      index += 1;
    }
    invalid('contains an unterminated string');
  };

  const parseNumber = () => {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(index));
    if (!match) invalid('contains an invalid number');
    const value = Number(match[0]);
    if (!Number.isFinite(value)) invalid('contains a non-finite number');
    index += match[0].length;
    return value;
  };

  const parseArray = (depth) => {
    index += 1;
    const result = [];
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      return result;
    }
    while (true) {
      result.push(parseValue(depth + 1));
      skipWhitespace();
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      if (text[index] === ']') {
        index += 1;
        return result;
      }
      invalid('contains an unterminated array');
    }
  };

  const parseObject = (depth) => {
    index += 1;
    const result = Object.create(null);
    const seen = new Set();
    skipWhitespace();
    if (text[index] === '}') {
      index += 1;
      return result;
    }
    while (true) {
      skipWhitespace();
      if (text[index] !== '"') invalid('contains an object key that is not a string');
      const key = parseString();
      if (seen.has(key)) invalid(`contains a duplicate JSON key: ${key}`);
      seen.add(key);
      skipWhitespace();
      if (text[index] !== ':') invalid('contains an object key without a colon');
      index += 1;
      result[key] = parseValue(depth + 1);
      skipWhitespace();
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      if (text[index] === '}') {
        index += 1;
        return result;
      }
      invalid('contains an unterminated object');
    }
  };

  const parseValue = (depth) => {
    if (depth > MAX_JSON_DEPTH) invalid('exceeds the reviewed nesting depth');
    skipWhitespace();
    const char = text[index];
    if (char === '{') return parseObject(depth);
    if (char === '[') return parseArray(depth);
    if (char === '"') return parseString();
    if (char === 't') return expectLiteral('true', true);
    if (char === 'f') return expectLiteral('false', false);
    if (char === 'n') return expectLiteral('null', null);
    if (char === '-' || (char >= '0' && char <= '9')) return parseNumber();
    invalid('contains invalid JSON');
  };

  const value = parseValue(0);
  skipWhitespace();
  if (index !== length) invalid('contains trailing data');
  return value;
}

function hasPrivateMode(mode) {
  return (mode & 0o077) === 0;
}

function formatMode(mode) {
  return (mode & 0o777).toString(8).padStart(4, '0');
}

function validateBackupId(backupId) {
  if (typeof backupId !== 'string' || backupId.length === 0) {
    fail('BACKUP_ID_INVALID', 'backup id must be a non-empty string');
  }
  if (Buffer.byteLength(backupId, 'utf8') > MAX_BACKUP_ID_BYTES || !BACKUP_ID_RE.test(backupId)) {
    fail('BACKUP_ID_INVALID', 'backup id contains unsupported characters or is too long');
  }
  return backupId;
}

function validateArtifactPath(artifact) {
  if (typeof artifact !== 'string' || artifact.length === 0) {
    fail('ARTIFACT_PATH_INVALID', 'artifact path must be a non-empty relative path');
  }
  if (Buffer.byteLength(artifact, 'utf8') > MAX_ARTIFACT_PATH_BYTES) {
    fail('ARTIFACT_PATH_INVALID', 'artifact path is too long');
  }
  if (!SAFE_RELATIVE_PATH.test(artifact)) {
    fail('ARTIFACT_PATH_INVALID', 'artifact path contains unsupported characters');
  }
  if (artifact.startsWith('/') || artifact.endsWith('/') || artifact.includes('//')) {
    fail('ARTIFACT_PATH_INVALID', 'artifact path must be a canonical relative path');
  }
  const segments = artifact.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('ARTIFACT_PATH_INVALID', 'artifact path must not contain empty, "." or ".." segments');
  }
  if (path.posix.normalize(artifact) !== artifact) {
    fail('ARTIFACT_PATH_INVALID', 'artifact path is not canonical');
  }
  if (artifact.endsWith('.aesgcm')) {
    fail('ARTIFACT_PATH_INVALID', 'artifact path must name plaintext, not an encrypted envelope');
  }
  if (artifact === 'storage/bytes' || artifact.startsWith(STORAGE_BYTES_PREFIX)) {
    fail('ARTIFACT_PATH_INVALID', 'storage/bytes is pruned from the encrypted artifact set');
  }
  return artifact;
}

function validateEnvelopeRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.endsWith('.aesgcm')) {
    fail('ARTIFACT_PATH_INVALID', 'encrypted artifact path must end with .aesgcm');
  }
  const artifact = relativePath.slice(0, -'.aesgcm'.length);
  validateArtifactPath(artifact);
  if (relativePath === MANIFEST_ENVELOPE) {
    fail('ARTIFACT_PATH_INVALID', 'the main manifest must not list itself');
  }
  return { relativePath, artifact };
}

function validateChunkSize(value) {
  if (value === undefined || value === null) return DEFAULT_CHUNK_SIZE;
  const text = String(value);
  if (!/^[0-9]+$/.test(text)) {
    fail('CHUNK_SIZE_INVALID', 'chunk size must be a positive decimal integer');
  }
  const size = Number(text);
  if (!Number.isSafeInteger(size) || size < MIN_CHUNK_SIZE || size > MAX_CHUNK_SIZE) {
    fail(
      'CHUNK_SIZE_INVALID',
      `chunk size must be between ${MIN_CHUNK_SIZE} and ${MAX_CHUNK_SIZE} bytes`,
    );
  }
  return size;
}

export function buildAad({ backupId, artifact, bytes, sha256 }) {
  validateBackupId(backupId);
  validateArtifactPath(artifact);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_PLAINTEXT_BYTES) {
    fail('AAD_INVALID', 'AAD byte count is outside the supported range');
  }
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
    fail('AAD_INVALID', 'AAD SHA-256 must be 64 lowercase hex characters');
  }
  return `v1|backup=${backupId}|artifact=${artifact}|bytes=${bytes}|sha256=${sha256}`;
}

export function parseAad(buffer) {
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
  validateBackupId(backupId);
  validateArtifactPath(artifact);
  if (!/^(0|[1-9][0-9]*)$/.test(bytesText)) {
    fail('AAD_INVALID', 'AAD byte count is not canonical decimal');
  }
  const bytes = Number(bytesText);
  if (!Number.isSafeInteger(bytes) || bytes > MAX_PLAINTEXT_BYTES) {
    fail('AAD_INVALID', 'AAD byte count is outside the supported range');
  }
  if (!SHA256_HEX.test(sha256)) {
    fail('AAD_INVALID', 'AAD SHA-256 is not 64 lowercase hex characters');
  }
  const canonical = `v1|backup=${backupId}|artifact=${artifact}|bytes=${bytes}|sha256=${sha256}`;
  if (canonical !== text) {
    fail('AAD_INVALID', 'AAD is not in canonical form');
  }
  return { backupId, artifact, bytes, sha256, text };
}

const activeTemps = new Set();
const activeTempDirectories = new Set();

function registerTemp(tempPath) {
  activeTemps.add(tempPath);
}

function unregisterTemp(tempPath) {
  activeTemps.delete(tempPath);
}

function registerTempDirectory(directory) {
  activeTempDirectories.add(directory);
}

function unregisterTempDirectory(directory) {
  activeTempDirectories.delete(directory);
}

function cleanupTempsSync() {
  for (const tempPath of activeTemps) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Best effort during signal handling. The final path is never published
      // until all authentication checks pass.
    }
  }
  activeTemps.clear();
  for (const directory of activeTempDirectories) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best effort during signal handling.
    }
  }
  activeTempDirectories.clear();
}

function installSignalHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      cleanupTempsSync();
      const number = os.constants.signals[signal];
      process.exit(128 + (typeof number === 'number' ? number : 1));
    });
  }
}

async function lstatOrNull(target) {
  try {
    return await fsp.lstat(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
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
    if (typeof process.getuid === 'function' && after.uid !== process.getuid()) {
      fail('KEY_FILE_OWNER', 'key file must be owned by the current user');
    }
    const key = Buffer.alloc(KEY_BYTES);
    try {
      let offset = 0;
      while (offset < KEY_BYTES) {
        const { bytesRead } = await handle.read(key, offset, KEY_BYTES - offset, offset);
        if (bytesRead === 0) fail('KEY_FILE_SIZE', 'key file is shorter than 32 bytes');
        offset += bytesRead;
      }
      const extra = Buffer.alloc(1);
      const extraRead = await handle.read(extra, 0, 1, KEY_BYTES);
      if (extraRead.bytesRead !== 0) fail('KEY_FILE_SIZE', 'key file is longer than 32 bytes');
      return key;
    } catch (error) {
      key.fill(0);
      throw error;
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

async function openRegularInput(inputPath, codes) {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    fail('USAGE', '--in is required');
  }
  const resolved = path.resolve(inputPath);
  let stat;
  try {
    stat = await fsp.lstat(resolved);
  } catch (error) {
    if (error && error.code === 'ENOENT') fail(codes.notFound, 'input file does not exist');
    fail(codes.read, 'input file cannot be inspected');
  }
  if (stat.isSymbolicLink()) fail(codes.symlink, 'input file must not be a symlink');
  if (!stat.isFile()) fail(codes.notRegular, 'input file must be a regular file');

  let handle;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    handle = await fsp.open(resolved, flags);
  } catch (error) {
    if (error && error.code === 'ELOOP') fail(codes.symlink, 'input file must not be a symlink');
    fail(codes.read, 'input file cannot be opened');
  }
  const after = await handle.stat();
  if (!after.isFile()) {
    await handle.close().catch(() => {});
    fail(codes.notRegular, 'input file must be a regular file');
  }
  return { handle, stat: after, resolved };
}

async function validateOutputTarget(outputPath, inputResolved) {
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    fail('USAGE', '--out is required');
  }
  const resolved = path.resolve(outputPath);
  if (inputResolved && resolved === inputResolved) {
    fail('OUTPUT_SAME_AS_INPUT', 'output path must differ from input path');
  }
  const directory = path.dirname(resolved);
  let dirStat;
  try {
    dirStat = await fsp.lstat(directory);
  } catch (error) {
    if (error && error.code === 'ENOENT') fail('OUTPUT_DIR_INVALID', 'output directory does not exist');
    fail('OUTPUT_DIR_INVALID', 'output directory cannot be inspected');
  }
  if (dirStat.isSymbolicLink()) fail('OUTPUT_DIR_SYMLINK', 'output directory must not be a symlink');
  if (!dirStat.isDirectory()) fail('OUTPUT_DIR_INVALID', 'output parent must be a directory');
  if (!hasPrivateMode(dirStat.mode)) {
    fail(
      'OUTPUT_DIR_PERMISSIONS',
      `output directory mode ${formatMode(dirStat.mode)} permits group/other access`,
    );
  }
  if ((dirStat.mode & 0o700) !== 0o700) {
    fail('OUTPUT_DIR_PERMISSIONS', 'output directory must be owner read/write/executable');
  }
  const existing = await lstatOrNull(resolved);
  if (existing) {
    if (existing.isSymbolicLink()) fail('OUTPUT_SYMLINK', 'output path must not be a symlink');
    fail('OUTPUT_EXISTS', 'output path already exists; refusing to overwrite');
  }
  return { resolved, directory };
}

async function createPrivateTemp(directory) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const name = `${TEMP_PREFIX}${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
    const tempPath = path.join(directory, name);
    let handle;
    try {
      handle = await fsp.open(tempPath, 'wx', 0o600);
    } catch (error) {
      if (error && error.code === 'EEXIST') continue;
      fail('TEMP_CREATE_FAILED', 'temporary file cannot be created');
    }
    try {
      await handle.chmod(0o600);
      registerTemp(tempPath);
      return { handle, tempPath };
    } catch {
      await handle.close().catch(() => {});
      await fsp.unlink(tempPath).catch(() => {});
      fail('TEMP_CREATE_FAILED', 'temporary file permissions cannot be secured');
    }
  }
  fail('TEMP_CREATE_FAILED', 'temporary file name collision');
}

async function removeTemp(temp) {
  if (!temp) return;
  if (temp.handle) {
    await temp.handle.close().catch(() => {});
    temp.handle = null;
  }
  if (temp.tempPath) {
    try {
      await fsp.unlink(temp.tempPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') return;
    }
    unregisterTemp(temp.tempPath);
  }
}

async function fsyncDirectory(directory) {
  let handle;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0);
    handle = await fsp.open(directory, flags);
    await handle.sync();
  } catch {
    fail('DIRECTORY_FSYNC_FAILED', 'parent directory could not be fsynced');
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function publishNoReplace(temp, destination, directory) {
  try {
    await fsp.link(temp.tempPath, destination);
  } catch (error) {
    if (error && error.code === 'EEXIST') fail('OUTPUT_EXISTS', 'output path already exists');
    fail('PUBLISH_FAILED', 'output could not be published atomically without overwrite');
  }
  try {
    await fsp.unlink(temp.tempPath);
  } catch {
    await fsp.unlink(destination).catch(() => {});
    fail('PUBLISH_FAILED', 'temporary name could not be removed after publication');
  }
  unregisterTemp(temp.tempPath);
  temp.tempPath = null;
  if (temp.handle) {
    await temp.handle.close().catch(() => {});
    temp.handle = null;
  }
  try {
    await fsyncDirectory(directory);
  } catch (error) {
    await fsp.unlink(destination).catch(() => {});
    throw error;
  }
}

async function readExactly(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) fail('INPUT_TRUNCATED', 'input ended before the expected byte count');
    offset += bytesRead;
  }
  return buffer;
}

async function readChunk(handle, buffer, length, position) {
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) fail('INPUT_TRUNCATED', 'input ended before the expected byte count');
    offset += bytesRead;
  }
  return offset;
}

async function assertHandleEof(handle, expectedSize, code, message) {
  const probe = Buffer.alloc(1);
  const { bytesRead } = await handle.read(probe, 0, 1, expectedSize);
  if (bytesRead !== 0) fail(code, message);
}

async function assertHandleSize(handle, expectedSize, code, message) {
  const stat = await handle.stat();
  if (stat.size !== expectedSize) fail(code, message);
}

async function assertStableInput(handle, expectedSize, {
  trailingCode,
  sizeCode,
  trailingMessage,
  sizeMessage,
  inputState = null,
}) {
  // Read at the expected EOF first. A concurrent append is visible even when
  // the initial stat size (and therefore the computed tag offset) is stale.
  await assertHandleEof(handle, expectedSize, trailingCode, trailingMessage);
  await assertHandleSize(handle, expectedSize, sizeCode, sizeMessage);
  if (inputState !== null) {
    const current = await handle.stat();
    const named = await lstatOrNull(inputState.resolved);
    const initial = inputState.stat;
    if (
      !named || !named.isFile() || named.isSymbolicLink()
      || [current, named].some((stat) => (
        stat.dev !== initial.dev || stat.ino !== initial.ino
        || stat.size !== initial.size || stat.mtimeMs !== initial.mtimeMs
        || stat.ctimeMs !== initial.ctimeMs
      ))
    ) {
      fail('INPUT_CHANGED', 'input identity or metadata changed during decryption');
    }
  }
}

async function writeExactly(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, position + offset);
    if (bytesWritten === 0) fail('OUTPUT_WRITE', 'output write made no progress');
    offset += bytesWritten;
  }
  return offset;
}

async function hashOpenHandle(handle, size, chunkSize) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.alloc(chunkSize);
  let position = 0;
  while (position < size) {
    const length = Math.min(chunkSize, size - position);
    await readChunk(handle, buffer, length, position);
    hash.update(buffer.subarray(0, length));
    position += length;
  }
  return hash.digest('hex');
}

function parseEnvelopeHeaderBuffer(buffer) {
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
  if (ciphertextBytes !== aad.bytes) {
    fail(
      'CIPHERTEXT_LENGTH_MISMATCH',
      'ciphertext length does not match the authenticated AAD byte count',
    );
  }
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
    fileSize,
  };
}

async function readEnvelopeHeader(handle, fileSize) {
  if (fileSize < HEADER_FIXED_BYTES + TAG_BYTES) {
    fail('ENVELOPE_TOO_SMALL', 'envelope is smaller than the fixed header plus authentication tag');
  }
  const fixed = await readExactly(handle, HEADER_FIXED_BYTES, 0);
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
  const aadBuffer = await readExactly(handle, aadLength, HEADER_FIXED_BYTES);
  const aad = parseAad(aadBuffer);
  const ciphertextOffset = HEADER_FIXED_BYTES + aadLength;
  const tagOffset = fileSize - TAG_BYTES;
  const ciphertextBytes = tagOffset - ciphertextOffset;
  if (ciphertextBytes !== aad.bytes) {
    fail(
      'CIPHERTEXT_LENGTH_MISMATCH',
      'ciphertext length does not match the authenticated AAD byte count',
    );
  }
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
    fileSize,
  };
}

async function hashFileAt(root, relativePath, chunkSize) {
  const absolute = path.join(root, relativePath);
  let stat;
  try {
    stat = await fsp.lstat(absolute);
  } catch (error) {
    if (error && error.code === 'ENOENT') fail('ARTIFACT_MISSING', `artifact is missing: ${relativePath}`);
    fail('ARTIFACT_READ', `artifact cannot be inspected: ${relativePath}`);
  }
  if (stat.isSymbolicLink()) fail('ARTIFACT_SYMLINK', `artifact must not be a symlink: ${relativePath}`);
  if (!stat.isFile()) fail('ARTIFACT_NOT_REGULAR', `artifact must be a regular file: ${relativePath}`);
  if (!hasPrivateMode(stat.mode)) {
    fail('ARTIFACT_PERMISSIONS', `artifact mode ${formatMode(stat.mode)} permits group/other access: ${relativePath}`);
  }
  let handle;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    handle = await fsp.open(absolute, flags);
  } catch {
    fail('ARTIFACT_READ', `artifact cannot be opened: ${relativePath}`);
  }
  try {
    const after = await handle.stat();
    if (!after.isFile()) fail('ARTIFACT_NOT_REGULAR', `artifact must be a regular file: ${relativePath}`);
    const digest = await hashOpenHandle(handle, after.size, chunkSize);
    await assertStableInput(handle, after.size, {
      trailingCode: 'ARTIFACT_TRAILING_BYTES',
      sizeCode: 'ARTIFACT_SIZE_CHANGED',
      trailingMessage: `artifact grew after it was hashed: ${relativePath}`,
      sizeMessage: `artifact size changed while it was hashed: ${relativePath}`,
    });
    return { digest, size: after.size };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readHeaderAt(root, relativePath) {
  const absolute = path.join(root, relativePath);
  let stat;
  try {
    stat = await fsp.lstat(absolute);
  } catch (error) {
    if (error && error.code === 'ENOENT') fail('ARTIFACT_MISSING', `artifact is missing: ${relativePath}`);
    fail('ARTIFACT_READ', `artifact cannot be inspected: ${relativePath}`);
  }
  if (stat.isSymbolicLink()) fail('ARTIFACT_SYMLINK', `artifact must not be a symlink: ${relativePath}`);
  if (!stat.isFile()) fail('ARTIFACT_NOT_REGULAR', `artifact must be a regular file: ${relativePath}`);
  if (!hasPrivateMode(stat.mode)) {
    fail('ARTIFACT_PERMISSIONS', `artifact mode ${formatMode(stat.mode)} permits group/other access: ${relativePath}`);
  }
  let handle;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    handle = await fsp.open(absolute, flags);
  } catch {
    fail('ARTIFACT_READ', `artifact cannot be opened: ${relativePath}`);
  }
  try {
    const after = await handle.stat();
    const header = await readEnvelopeHeader(handle, after.size);
    await assertStableInput(handle, after.size, {
      trailingCode: 'ARTIFACT_TRAILING_BYTES',
      sizeCode: 'ARTIFACT_SIZE_CHANGED',
      trailingMessage: `artifact grew after its header was read: ${relativePath}`,
      sizeMessage: `artifact size changed while its header was read: ${relativePath}`,
    });
    return { header, size: after.size };
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function encryptFile({
  input,
  output,
  keyFile,
  backupId,
  artifact,
  chunkSize = DEFAULT_CHUNK_SIZE,
}) {
  validateBackupId(backupId);
  validateArtifactPath(artifact);
  const effectiveChunkSize = validateChunkSize(chunkSize);
  const key = await readKeyFile(keyFile);
  let inputHandle = null;
  let temp = null;
  try {
    const inputState = await openRegularInput(input, {
      notFound: 'INPUT_NOT_FOUND',
      read: 'INPUT_READ',
      symlink: 'INPUT_SYMLINK',
      notRegular: 'INPUT_NOT_REGULAR',
    });
    inputHandle = inputState.handle;
    const initialStat = inputState.stat;
    if (initialStat.size > MAX_PLAINTEXT_BYTES) {
      fail('INPUT_TOO_LARGE', 'input exceeds the single-invocation GCM plaintext ceiling');
    }
    const outputState = await validateOutputTarget(output, inputState.resolved);

    const plaintextSha256 = await hashOpenHandle(inputHandle, initialStat.size, effectiveChunkSize);
    const finalStat = await inputHandle.stat();
    if (
      finalStat.size !== initialStat.size ||
      finalStat.mtimeMs !== initialStat.mtimeMs ||
      finalStat.ino !== initialStat.ino ||
      finalStat.dev !== initialStat.dev
    ) {
      fail('INPUT_CHANGED', 'input changed while it was being hashed');
    }

    const aadText = buildAad({
      backupId,
      artifact,
      bytes: initialStat.size,
      sha256: plaintextSha256,
    });
    const aadBuffer = Buffer.from(aadText, 'utf8');
    if (aadBuffer.length > MAX_AAD_BYTES) {
      fail('AAD_LENGTH_INVALID', 'constructed AAD exceeds the reviewed format limit');
    }

    const nonce = crypto.randomBytes(NONCE_BYTES);
    const cipher = crypto.createCipheriv(AES_GCM, key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aadBuffer);

    const header = Buffer.alloc(HEADER_FIXED_BYTES + aadBuffer.length);
    MAGIC.copy(header, 0);
    header[MAGIC.length] = FORMAT_VERSION;
    nonce.copy(header, 9);
    header.writeUInt32BE(aadBuffer.length, 21);
    aadBuffer.copy(header, HEADER_FIXED_BYTES);

    temp = await createPrivateTemp(outputState.directory);
    const ciphertextHash = crypto.createHash('sha256');
    let ciphertextBytes = 0;

    const writeEncrypted = async (bytes) => {
      if (bytes.length === 0) return;
      await writeExactly(temp.handle, bytes, ciphertextBytes);
      ciphertextHash.update(bytes);
      ciphertextBytes += bytes.length;
    };

    await writeEncrypted(header);

    const buffer = Buffer.alloc(effectiveChunkSize);
    const encryptionPassHash = crypto.createHash('sha256');
    let position = 0;
    while (position < initialStat.size) {
      const length = Math.min(effectiveChunkSize, initialStat.size - position);
      await readChunk(inputHandle, buffer, length, position);
      encryptionPassHash.update(buffer.subarray(0, length));
      const encrypted = cipher.update(buffer.subarray(0, length));
      if (encrypted.length !== length) {
        fail('CRYPTO_OUTPUT_LENGTH', 'cipher produced an unexpected ciphertext length');
      }
      await writeEncrypted(encrypted);
      position += length;
    }
    const finalBytes = cipher.final();
    if (finalBytes.length !== 0) {
      fail('CRYPTO_OUTPUT_LENGTH', 'cipher produced unexpected final bytes');
    }
    const tag = cipher.getAuthTag();
    if (tag.length !== TAG_BYTES) {
      fail('CRYPTO_OUTPUT_LENGTH', 'cipher produced an unexpected authentication tag length');
    }
    await writeEncrypted(tag);

    if (encryptionPassHash.digest('hex') !== plaintextSha256) {
      fail('INPUT_CHANGED', 'input content changed between the hash and encryption passes');
    }
    const afterEncryptStat = await inputHandle.stat();
    if (
      afterEncryptStat.size !== initialStat.size ||
      afterEncryptStat.mtimeMs !== initialStat.mtimeMs ||
      afterEncryptStat.ino !== initialStat.ino ||
      afterEncryptStat.dev !== initialStat.dev
    ) {
      fail('INPUT_CHANGED', 'input changed while it was being encrypted');
    }
    await assertStableInput(inputHandle, initialStat.size, {
      trailingCode: 'INPUT_CHANGED',
      sizeCode: 'INPUT_CHANGED',
      trailingMessage: 'input grew after the encryption pass',
      sizeMessage: 'input size changed after the encryption pass',
    });

    const ciphertextSha256 = ciphertextHash.digest('hex');
    await temp.handle.sync();
    await temp.handle.close();
    temp.handle = null;
    await publishNoReplace(temp, outputState.resolved, outputState.directory);
    temp = null;

    return {
      status: 'ok',
      operation: 'encrypt',
      artifact,
      backupId,
      format: 'AES-256-GCM',
      formatVersion: FORMAT_VERSION,
      nonceHex: nonce.toString('hex'),
      plaintextBytes: initialStat.size,
      plaintextSha256,
      ciphertextBytes,
      ciphertextSha256,
      aad: aadText,
    };
  } finally {
    key.fill(0);
    if (inputHandle) await inputHandle.close().catch(() => {});
    await removeTemp(temp);
  }
}

function validateExpectSha256(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
    fail('USAGE', '--expect-sha256 must be 64 hexadecimal characters');
  }
  return value.toLowerCase();
}

async function decryptWithKey({
  key,
  input,
  output,
  backupId,
  artifact,
  expectSha256 = null,
  chunkSize = DEFAULT_CHUNK_SIZE,
  verifyOnly = false,
}) {
  validateBackupId(backupId);
  validateArtifactPath(artifact);
  const effectiveChunkSize = validateChunkSize(chunkSize);
  const expected = validateExpectSha256(expectSha256);
  let inputHandle = null;
  let temp = null;
  try {
    const inputState = await openRegularInput(input, {
      notFound: 'INPUT_NOT_FOUND',
      read: 'INPUT_READ',
      symlink: 'INPUT_SYMLINK',
      notRegular: 'INPUT_NOT_REGULAR',
    });
    inputHandle = inputState.handle;
    const header = await readEnvelopeHeader(inputHandle, inputState.stat.size);
    if (header.aad.backupId !== backupId) {
      fail('AAD_BACKUP_ID_MISMATCH', 'envelope AAD backup id does not match the requested backup id');
    }
    if (header.aad.artifact !== artifact) {
      fail('AAD_ARTIFACT_MISMATCH', 'envelope AAD artifact path does not match the requested artifact');
    }
    if (expected !== null && header.aad.sha256 !== expected) {
      fail('EXPECT_SHA256_MISMATCH', 'requested SHA-256 does not match the authenticated envelope AAD');
    }
    const outputState = verifyOnly ? null : await validateOutputTarget(output, inputState.resolved);

    if (!verifyOnly) temp = await createPrivateTemp(outputState.directory);
    const decipher = crypto.createDecipheriv(AES_GCM, key, header.nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(header.aadBuffer);

    const plaintextHash = crypto.createHash('sha256');
    const envelopeHash = crypto.createHash('sha256');
    envelopeHash.update(header.fixed);
    envelopeHash.update(header.aadBuffer);
    let plaintextBytes = 0;
    let position = header.ciphertextOffset;
    let remaining = header.ciphertextBytes;
    const buffer = Buffer.alloc(effectiveChunkSize);

    while (remaining > 0) {
      const length = Math.min(effectiveChunkSize, remaining);
      await readChunk(inputHandle, buffer, length, position);
      envelopeHash.update(buffer.subarray(0, length));
      const plaintext = decipher.update(buffer.subarray(0, length));
      if (plaintext.length !== length) {
        fail('CRYPTO_OUTPUT_LENGTH', 'decipher produced an unexpected plaintext length');
      }
      try {
        if (!verifyOnly) await writeExactly(temp.handle, plaintext, plaintextBytes);
        plaintextHash.update(plaintext);
        plaintextBytes += plaintext.length;
      } finally {
        plaintext.fill(0);
      }
      position += length;
      remaining -= length;
    }

    const tag = await readExactly(inputHandle, TAG_BYTES, header.tagOffset);
    envelopeHash.update(tag);
    // The tag offset was computed from the initial stat. Check the actual EOF
    // before authenticating so a byte appended after that stat cannot be
    // silently ignored.
    await assertStableInput(inputHandle, header.fileSize, {
      trailingCode: 'ENVELOPE_TRAILING_BYTES',
      sizeCode: 'ENVELOPE_SIZE_CHANGED',
      trailingMessage: 'envelope has trailing bytes beyond the authenticated length',
      sizeMessage: 'envelope size changed during decryption',
      inputState,
    });
    decipher.setAuthTag(tag);
    let finalBytes;
    try {
      finalBytes = decipher.final();
    } catch {
      fail('AUTHENTICATION_FAILED', 'GCM authentication tag verification failed');
    }
    if (finalBytes.length !== 0) {
      fail('CRYPTO_OUTPUT_LENGTH', 'decipher produced unexpected final plaintext bytes');
    }
    if (plaintextBytes !== header.aad.bytes) {
      fail('PLAINTEXT_BYTES_MISMATCH', 'decrypted byte count does not match the authenticated AAD');
    }
    const plaintextSha256 = plaintextHash.digest('hex');
    if (plaintextSha256 !== header.aad.sha256) {
      fail('PLAINTEXT_SHA256_MISMATCH', 'decrypted SHA-256 does not match the authenticated AAD');
    }
    if (expected !== null && plaintextSha256 !== expected) {
      fail('EXPECT_SHA256_MISMATCH', 'decrypted SHA-256 does not match --expect-sha256');
    }
    const ciphertextSha256 = envelopeHash.digest('hex');
    if (!verifyOnly) {
      await temp.handle.sync();
      await temp.handle.close();
      temp.handle = null;
    }
    // Check after output fsync/close, immediately before publication (or
    // verification success), including pathname replacement and metadata.
    await assertStableInput(inputHandle, header.fileSize, {
      trailingCode: 'ENVELOPE_TRAILING_BYTES',
      sizeCode: 'ENVELOPE_SIZE_CHANGED',
      trailingMessage: 'envelope has trailing bytes beyond the authenticated length',
      sizeMessage: 'envelope size changed during decryption',
      inputState,
    });

    if (!verifyOnly) {
      await publishNoReplace(temp, outputState.resolved, outputState.directory);
      temp = null;
    }

    return {
      status: 'ok',
      operation: verifyOnly ? 'authenticate' : 'decrypt',
      artifact,
      backupId,
      format: 'AES-256-GCM',
      formatVersion: FORMAT_VERSION,
      nonceHex: header.nonceHex,
      plaintextBytes,
      plaintextSha256,
      ciphertextBytes: header.fileSize,
      ciphertextSha256,
      aad: header.aad.text,
    };
  } finally {
    if (inputHandle) await inputHandle.close().catch(() => {});
    await removeTemp(temp);
  }
}

export async function decryptFile({
  input,
  output,
  keyFile,
  backupId,
  artifact,
  expectSha256 = null,
  chunkSize = DEFAULT_CHUNK_SIZE,
}) {
  const key = await readKeyFile(keyFile);
  try {
    return await decryptWithKey({
      key,
      input,
      output,
      backupId,
      artifact,
      expectSha256,
      chunkSize,
    });
  } finally {
    key.fill(0);
  }
}

function assertSafeRelativePath(relativePath, code) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    !SAFE_RELATIVE_PATH.test(relativePath) ||
    relativePath.startsWith('/') ||
    relativePath.endsWith('/') ||
    relativePath.includes('//')
  ) {
    fail(code, 'path must be a canonical safe relative path');
  }
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail(code, 'path must not contain empty, "." or ".." segments');
  }
  if (path.posix.normalize(relativePath) !== relativePath) {
    fail(code, 'path is not canonical');
  }
  return relativePath;
}

async function readFileLimited(absolutePath, limit, missingCode, invalidCode) {
  let stat;
  try {
    stat = await fsp.lstat(absolutePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') fail(missingCode, 'file is missing');
    fail(invalidCode, 'file cannot be inspected');
  }
  if (stat.isSymbolicLink()) fail(invalidCode, 'file must not be a symlink');
  if (!stat.isFile()) fail(invalidCode, 'file must be a regular file');
  if (!hasPrivateMode(stat.mode)) {
    fail(invalidCode, `file mode ${formatMode(stat.mode)} permits group/other access`);
  }
  if (stat.size > limit) fail(invalidCode, 'file exceeds the reviewed size limit');
  let handle;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    handle = await fsp.open(absolutePath, flags);
  } catch {
    fail(invalidCode, 'file cannot be opened');
  }
  try {
    const after = await handle.stat();
    if (!after.isFile()) fail(invalidCode, 'file must be a regular file');
    if (after.size > limit) fail(invalidCode, 'file exceeds the reviewed size limit');
    const buffer = await readExactly(handle, after.size, 0);
    await assertStableInput(handle, after.size, {
      trailingCode: invalidCode,
      sizeCode: invalidCode,
      trailingMessage: 'file grew after it was read',
      sizeMessage: 'file size changed while it was read',
    });
    return buffer;
  } finally {
    await handle.close().catch(() => {});
  }
}

function parseChecksumText(buffer, {
  code = 'SUMS_INVALID',
  label = 'checksum file',
  allowNonAesgcm = false,
  requireExactCount = null,
  allowedPaths = null,
  requirePrefix = null,
  forbidPrefix = null,
  selfPath = null,
} = {}) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    fail(code, `${label} is not valid UTF-8`);
  }
  if (text.includes('\r')) {
    fail(code, `${label} must use LF line endings`);
  }
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) fail(code, `${label} is empty`);
  if (requireExactCount !== null && lines.length !== requireExactCount) {
    fail(code, `${label} must contain exactly ${requireExactCount} entries`);
  }
  const entries = new Map();
  for (const line of lines) {
    if (line === '') fail(code, `${label} contains a blank line`);
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match) {
      fail(code, `${label} line must be a lowercase 64-hex digest followed by a path`);
    }
    const digest = match[1];
    let entryPath = match[2];
    while (entryPath.startsWith('./')) entryPath = entryPath.slice(2);
    assertSafeRelativePath(entryPath, code);
    if (selfPath !== null && entryPath === selfPath) {
      fail(code, `${label} must not cover itself`);
    }
    if (!allowNonAesgcm && !entryPath.endsWith('.aesgcm')) {
      fail(code, `${label} may only cover encrypted .aesgcm artifacts`);
    }
    if (entryPath.startsWith(STORAGE_BYTES_PREFIX)) {
      fail(code, `${label} must prune storage/bytes`);
    }
    if (requirePrefix !== null && !entryPath.startsWith(requirePrefix)) {
      fail(code, `${label} path is outside ${requirePrefix}`);
    }
    if (forbidPrefix !== null && entryPath.startsWith(forbidPrefix)) {
      fail(code, `${label} path must exclude ${forbidPrefix}`);
    }
    if (allowedPaths !== null && !allowedPaths.has(entryPath)) {
      fail(code, `${label} contains an unapproved path: ${entryPath}`);
    }
    if (entries.has(entryPath)) {
      fail(code, `${label} contains a duplicate path: ${entryPath}`);
    }
    entries.set(entryPath, digest);
  }
  if (entries.size === 0) fail(code, `${label} is empty`);
  if (requireExactCount !== null && entries.size !== requireExactCount) {
    fail(code, `${label} must contain exactly ${requireExactCount} entries`);
  }
  return entries;
}

async function readChecksumFile(absolutePath, options = {}, {
  missingCode = 'SUMS_MISSING',
  invalidCode = 'SUMS_INVALID',
} = {}) {
  const buffer = await readFileLimited(
    absolutePath,
    MAX_SHA256SUMS_BYTES,
    missingCode,
    invalidCode,
  );
  return parseChecksumText(buffer, { code: invalidCode, ...options });
}

async function validateCloseoutDirectory(rootPath) {
  const closeoutPath = path.join(rootPath, 'closeout');
  let directoryStat;
  try {
    directoryStat = await fsp.lstat(closeoutPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') fail('CLOSEOUT_MISSING', 'closeout directory is missing');
    fail('CLOSEOUT_INVALID', 'closeout directory cannot be inspected');
  }
  if (directoryStat.isSymbolicLink()) fail('CLOSEOUT_SYMLINK', 'closeout directory must not be a symlink');
  if (!directoryStat.isDirectory()) fail('CLOSEOUT_INVALID', 'closeout must be a directory');
  if (!hasPrivateMode(directoryStat.mode)) {
    fail(
      'CLOSEOUT_PERMISSIONS',
      `closeout directory mode ${formatMode(directoryStat.mode)} permits group/other access`,
    );
  }
  if ((directoryStat.mode & 0o500) !== 0o500) {
    fail('CLOSEOUT_PERMISSIONS', 'closeout directory must be owner readable and executable');
  }
  let entries;
  try {
    entries = await fsp.readdir(closeoutPath, { withFileTypes: true });
  } catch {
    fail('CLOSEOUT_INVALID', 'closeout directory cannot be read');
  }
  const actualNames = entries.map((entry) => entry.name).sort();
  const expectedNames = [...CLOSEOUT_ENTRY_NAMES].sort();
  if (actualNames.length !== expectedNames.length) {
    fail(
      'CLOSEOUT_SET_INVALID',
      `closeout must contain exactly ${expectedNames.length} entries; found ${actualNames.length}`,
    );
  }
  for (let index = 0; index < expectedNames.length; index += 1) {
    if (actualNames[index] !== expectedNames[index]) {
      fail('CLOSEOUT_SET_INVALID', `closeout entry is not approved: ${actualNames[index]}`);
    }
  }
  const paths = new Map();
  for (const entry of entries) {
    const absolute = path.join(closeoutPath, entry.name);
    let fileStat;
    try {
      fileStat = await fsp.lstat(absolute);
    } catch {
      fail('CLOSEOUT_INVALID', `closeout entry cannot be inspected: ${entry.name}`);
    }
    if (fileStat.isSymbolicLink()) {
      fail('CLOSEOUT_SYMLINK', `closeout entry must not be a symlink: ${entry.name}`);
    }
    if (!fileStat.isFile()) {
      fail('CLOSEOUT_NOT_REGULAR', `closeout entry must be a regular file: ${entry.name}`);
    }
    if (!hasPrivateMode(fileStat.mode)) {
      fail(
        'CLOSEOUT_PERMISSIONS',
        `closeout entry mode ${formatMode(fileStat.mode)} permits group/other access: ${entry.name}`,
      );
    }
    paths.set(entry.name, absolute);
  }
  return paths;
}

async function verifyCloseoutBundle(rootPath, backupId) {
  const closeoutPath = path.join(rootPath, 'closeout');
  const closeoutStat = await lstatOrNull(closeoutPath);
  if (!closeoutStat) fail('CLOSEOUT_MISSING', 'closeout directory is missing');
  const sumsPath = path.join(rootPath, CLOSEOUT_SHA256SUMS_PATH);
  if (!(await lstatOrNull(sumsPath))) {
    fail('CLOSEOUT_SUMS_MISSING', 'closeout checksum file is missing');
  }
  const paths = await validateCloseoutDirectory(rootPath);
  const sums = await readChecksumFile(paths.get('SHA256SUMS'), {
    label: 'closeout checksum file',
    allowNonAesgcm: true,
    requireExactCount: CLOSEOUT_PAYLOAD_PATHS.length,
    allowedPaths: new Set(CLOSEOUT_PAYLOAD_PATHS),
    requirePrefix: CLOSEOUT_PREFIX,
    selfPath: CLOSEOUT_SHA256SUMS_PATH,
  }, {
    missingCode: 'CLOSEOUT_SUMS_MISSING',
    invalidCode: 'CLOSEOUT_SUMS_INVALID',
  });
  compareSets(
    [...sums.keys()],
    [...CLOSEOUT_PAYLOAD_PATHS],
    'CLOSEOUT_SUMS_COVERAGE_MISMATCH',
    'closeout checksum path set',
  );
  const payloads = new Map();
  for (const relativePath of CLOSEOUT_PAYLOAD_PATHS) {
    const bytes = await readFileLimited(
      path.join(rootPath, relativePath),
      MAX_CLOSEOUT_BYTES,
      'CLOSEOUT_MISSING',
      'CLOSEOUT_INVALID',
    );
    if (sha256Hex(bytes) !== sums.get(relativePath)) {
      fail('CLOSEOUT_HASH_MISMATCH', `closeout SHA-256 does not match: ${relativePath}`);
    }
    payloads.set(relativePath, bytes);
  }
  const header = parseEnvelopeHeaderBuffer(payloads.get(CLOSEOUT_CLOSEOUT_ENVELOPE));
  if (header.aad.backupId !== backupId) {
    fail('CLOSEOUT_AAD_MISMATCH', 'closeout AAD backup id does not match --backup-id');
  }
  if (header.aad.artifact !== CLOSEOUT_CLOSEOUT_ARTIFACT) {
    fail('CLOSEOUT_AAD_MISMATCH', 'closeout AAD path does not match the closeout artifact');
  }
  return { paths, sums, payloads, header };
}

async function walkAesgcm(root, { pruneStorageBytes = true } = {}) {
  const found = [];
  async function walk(relativeDirectory) {
    const absolute = relativeDirectory ? path.join(root, relativeDirectory) : root;
    let entries;
    try {
      entries = await fsp.readdir(absolute, { withFileTypes: true });
    } catch {
      fail('ARTIFACT_READ', 'artifact directory cannot be read');
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        fail('ARTIFACT_SYMLINK', `artifact tree must not contain symlinks: ${relative}`);
      }
      if (pruneStorageBytes && relative === 'storage/bytes') continue;
      if (entry.isDirectory()) {
        const directoryStat = await fsp.lstat(path.join(root, relative));
        if (!hasPrivateMode(directoryStat.mode)) {
          fail(
            'ARTIFACT_DIRECTORY_PERMISSIONS',
            `artifact directory mode ${formatMode(directoryStat.mode)} permits group/other access: ${relative}`,
          );
        }
        await walk(relative);
        continue;
      }
      if (!entry.isFile()) {
        if (relative.endsWith('.aesgcm')) {
          fail('ARTIFACT_NOT_REGULAR', `encrypted artifact must be a regular file: ${relative}`);
        }
        continue;
      }
      if (relative.endsWith('.aesgcm')) found.push(relative);
    }
  }
  await walk('');
  found.sort();
  return found;
}

function compareSets(actual, expected, code, label) {
  const actualSet = [...new Set(actual)].sort();
  const expectedSet = [...new Set(expected)].sort();
  const actualText = actualSet.join('\n');
  const expectedText = expectedSet.join('\n');
  if (actualText !== expectedText) {
    const missing = expectedSet.filter((item) => !actualSet.includes(item));
    const extra = actualSet.filter((item) => !expectedSet.includes(item));
    const details = [];
    if (missing.length > 0) details.push(`missing=${missing.slice(0, 3).join(',')}`);
    if (extra.length > 0) details.push(`extra=${extra.slice(0, 3).join(',')}`);
    fail(code, `${label} mismatch (${details.join('; ') || 'ordering'})`);
  }
}

function recordNoncePair(owners, keyId, nonceHex, owner) {
  const pair = `${keyId}:${nonceHex}`;
  const previous = owners.get(pair);
  if (previous !== undefined) {
    fail('NONCE_REUSE', `nonce reuse detected between ${previous} and ${owner}`);
  }
  owners.set(pair, owner);
}

function recordNonce(owners, keyId, nonceHex, owner) {
  recordNoncePair(owners, keyId, nonceHex, owner);
}

/**
 * Pure nonce-domain check exported for adversarial tests. A duplicate nonce is
 * only a reuse when the key id is also the same; the same nonce under a
 * different key id belongs to a different nonce domain. The helper does not
 * implement per-artifact keys, so its CLI paths always use the key-file
 * fingerprint as the key id.
 */
export function assertNoDuplicateNoncePairs(entries) {
  if (!Array.isArray(entries)) {
    fail('NONCE_PAIR_INVALID', 'nonce entries must be an array');
  }
  const owners = new Map();
  for (const entry of entries) {
    if (!isPlainObject(entry)) {
      fail('NONCE_PAIR_INVALID', 'nonce entry must be an object');
    }
    if (typeof entry.keyId !== 'string' || !SHA256_HEX.test(entry.keyId)) {
      fail('NONCE_PAIR_INVALID', 'nonce entry key id must be 64 lowercase hex characters');
    }
    if (typeof entry.nonceHex !== 'string' || !NONCE_HEX.test(entry.nonceHex)) {
      fail('NONCE_PAIR_INVALID', 'nonce entry nonce must be 24 lowercase hex characters');
    }
    if (typeof entry.owner !== 'string' || entry.owner.length === 0) {
      fail('NONCE_PAIR_INVALID', 'nonce entry owner must be a non-empty string');
    }
    recordNoncePair(owners, entry.keyId, entry.nonceHex, entry.owner);
  }
  return owners.size;
}

function validateManifest(manifest, backupId) {
  if (!isPlainObject(manifest)) fail('MANIFEST_INVALID', 'manifest must be a JSON object');
  if (manifest.format !== MANIFEST_FORMAT) {
    fail('MANIFEST_INVALID', `manifest format must be ${MANIFEST_FORMAT}`);
  }
  if (manifest.backupId !== backupId) {
    fail('MANIFEST_BACKUP_ID_MISMATCH', 'manifest backup id does not match --backup-id');
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    fail('MANIFEST_INVALID', 'manifest artifacts must be a non-empty array');
  }
  if (manifest.artifacts.length > MAX_MANIFEST_ARTIFACTS) {
    fail('MANIFEST_INVALID', 'manifest contains too many artifacts');
  }
  const entries = [];
  const seenPaths = new Set();
  for (const raw of manifest.artifacts) {
    if (!isPlainObject(raw)) fail('MANIFEST_INVALID', 'manifest artifact entry must be an object');
    const { relativePath, artifact } = validateEnvelopeRelativePath(raw.path);
    if (seenPaths.has(relativePath)) {
      fail('MANIFEST_DUPLICATE_PATH', `manifest contains a duplicate artifact path: ${relativePath}`);
    }
    seenPaths.add(relativePath);
    if (raw.encryption !== 'AES-256-GCM') {
      fail('MANIFEST_INVALID', `manifest artifact encryption must be AES-256-GCM: ${relativePath}`);
    }
    if (raw.formatVersion !== FORMAT_VERSION) {
      fail('MANIFEST_INVALID', `manifest artifact format version must be ${FORMAT_VERSION}: ${relativePath}`);
    }
    if (typeof raw.nonceHex !== 'string' || !NONCE_HEX.test(raw.nonceHex)) {
      fail('MANIFEST_INVALID', `manifest artifact nonceHex is invalid: ${relativePath}`);
    }
    if (
      !Number.isSafeInteger(raw.plaintextBytes) ||
      raw.plaintextBytes < 0 ||
      raw.plaintextBytes > MAX_PLAINTEXT_BYTES
    ) {
      fail('MANIFEST_INVALID', `manifest artifact plaintextBytes is invalid: ${relativePath}`);
    }
    if (typeof raw.plaintextSha256 !== 'string' || !SHA256_HEX.test(raw.plaintextSha256)) {
      fail('MANIFEST_INVALID', `manifest artifact plaintextSha256 is invalid: ${relativePath}`);
    }
    if (
      !Number.isSafeInteger(raw.ciphertextBytes) ||
      raw.ciphertextBytes < HEADER_FIXED_BYTES + TAG_BYTES ||
      raw.ciphertextBytes > MAX_PLAINTEXT_BYTES + MAX_AAD_BYTES + HEADER_FIXED_BYTES + TAG_BYTES
    ) {
      fail('MANIFEST_INVALID', `manifest artifact ciphertextBytes is invalid: ${relativePath}`);
    }
    if (typeof raw.ciphertextSha256 !== 'string' || !SHA256_HEX.test(raw.ciphertextSha256)) {
      fail('MANIFEST_INVALID', `manifest artifact ciphertextSha256 is invalid: ${relativePath}`);
    }
    if (typeof raw.aad !== 'string') {
      fail('MANIFEST_INVALID', `manifest artifact aad is missing: ${relativePath}`);
    }
    const parsedAad = parseAad(Buffer.from(raw.aad, 'utf8'));
    if (parsedAad.backupId !== backupId) {
      fail('MANIFEST_AAD_MISMATCH', `manifest artifact AAD backup id is invalid: ${relativePath}`);
    }
    if (parsedAad.artifact !== artifact) {
      fail('MANIFEST_AAD_MISMATCH', `manifest artifact AAD path does not match its envelope path: ${relativePath}`);
    }
    if (parsedAad.bytes !== raw.plaintextBytes) {
      fail('MANIFEST_AAD_MISMATCH', `manifest artifact AAD byte count does not match: ${relativePath}`);
    }
    if (parsedAad.sha256 !== raw.plaintextSha256) {
      fail('MANIFEST_AAD_MISMATCH', `manifest artifact AAD SHA-256 does not match: ${relativePath}`);
    }
    entries.push({
      path: relativePath,
      artifact,
      nonceHex: raw.nonceHex,
      plaintextBytes: raw.plaintextBytes,
      plaintextSha256: raw.plaintextSha256,
      ciphertextBytes: raw.ciphertextBytes,
      ciphertextSha256: raw.ciphertextSha256,
      aad: raw.aad,
      parsedAad,
    });
  }
  return entries;
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

function decodeUtf8Strict(buffer, code, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    fail(code, `${label} is not valid UTF-8`);
  }
}

async function loadAuthenticatedManifest({
  key,
  rootPath,
  backupId,
  chunkSize,
  suppliedManifestPath,
  temporaryDirectory,
}) {
  const manifestEnvelopePath = path.join(rootPath, MANIFEST_ENVELOPE);
  const manifestEnvelopeStat = await lstatOrNull(manifestEnvelopePath);
  if (!manifestEnvelopeStat) fail('MANIFEST_MISSING', 'encrypted main manifest is missing');
  const { header: manifestHeader, size: manifestEnvelopeSize } = await readHeaderAt(
    rootPath,
    MANIFEST_ENVELOPE,
  );
  if (manifestHeader.aad.backupId !== backupId) {
    fail('MANIFEST_AAD_MISMATCH', 'manifest envelope AAD backup id does not match --backup-id');
  }
  if (manifestHeader.aad.artifact !== MANIFEST_ARTIFACT) {
    fail('MANIFEST_AAD_MISMATCH', 'manifest envelope AAD does not name the main manifest');
  }
  if (manifestHeader.aad.bytes > MAX_MANIFEST_BYTES) {
    fail('MANIFEST_TOO_LARGE', 'manifest plaintext exceeds the reviewed size limit');
  }

  const manifestPlainPath = path.join(temporaryDirectory, 'backup-manifest.json');
  const manifestAuthentication = await decryptWithKey({
    key,
    input: manifestEnvelopePath,
    output: manifestPlainPath,
    backupId,
    artifact: MANIFEST_ARTIFACT,
    chunkSize,
  });
  const manifestBytes = await readFileLimited(
    manifestPlainPath,
    MAX_MANIFEST_BYTES,
    'MANIFEST_INVALID',
    'MANIFEST_INVALID',
  );

  // The caller-supplied manifest is only a transport copy. It is never used as
  // the inventory source: its exact bytes must equal the authenticated
  // plaintext produced by decrypting the root manifest envelope.
  if (suppliedManifestPath !== undefined && suppliedManifestPath !== null) {
    const suppliedPath = resolveSuppliedPath(rootPath, suppliedManifestPath, 'manifest');
    const suppliedBytes = await readFileLimited(
      suppliedPath,
      MAX_MANIFEST_BYTES,
      'MANIFEST_SUPPLIED_MISSING',
      'MANIFEST_SUPPLIED_INVALID',
    );
    if (Buffer.compare(suppliedBytes, manifestBytes) !== 0) {
      fail(
        'MANIFEST_SUPPLIED_MISMATCH',
        'caller-supplied manifest does not match the authenticated manifest plaintext',
      );
    }
  }

  const manifestText = decodeUtf8Strict(manifestBytes, 'MANIFEST_INVALID', 'manifest plaintext');
  const manifest = parseJsonStrict(manifestText, 'MANIFEST_INVALID', 'manifest plaintext');
  const entries = validateManifest(manifest, backupId);
  const keyFingerprint = sha256Hex(key);

  if (!isPlainObject(manifest.keys) || manifest.keys.algorithm !== 'AES-256-GCM'
    || typeof manifest.keys.fingerprint !== 'string' || !SHA256_HEX.test(manifest.keys.fingerprint)) {
    fail('MANIFEST_INVALID', 'manifest must specify AES-256-GCM and the key-file SHA-256 fingerprint');
  }
  if (manifest.keys.fingerprint !== keyFingerprint) {
    fail('MANIFEST_KEY_FINGERPRINT_MISMATCH', 'manifest key fingerprint does not match the key file');
  }

  return {
    manifest,
    entries,
    manifestHeader,
    manifestEnvelopeSize,
    manifestBytes,
    keyFingerprint,
    manifestCiphertextSha256: manifestAuthentication.ciphertextSha256,
  };
}

function normalizeIndexPath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('SUPPLEMENTAL_INDEX_INVALID', 'supplemental index artifact path must be a non-empty string');
  }
  let normalized = value;
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  assertSafeRelativePath(normalized, 'SUPPLEMENTAL_INDEX_INVALID');
  return normalized;
}

// Consumes the inventory projection already supported by this implementation.
// v12 specifies index semantics, not its complete wire schema. This is NOT a
// provider-signature/version/retention validator; R1 offsite verification must
// validate the original index before this consumer is used operationally.
function validateSupplementalIndex(index, backupId, entries, manifestHeader, manifestDigest) {
  if (!isPlainObject(index)) {
    fail('SUPPLEMENTAL_INDEX_INVALID', 'supplemental index must be a JSON object');
  }
  if (index.backupId !== backupId) {
    fail(
      'SUPPLEMENTAL_INDEX_BACKUP_ID_MISMATCH',
      'supplemental index backup id does not match --backup-id',
    );
  }
  const lists = [];
  if (index.artifacts !== undefined) lists.push(index.artifacts);
  if (index.objects !== undefined) lists.push(index.objects);
  if (lists.length === 0) {
    fail('SUPPLEMENTAL_INDEX_INVALID', 'supplemental index must contain an artifacts or objects array');
  }
  if (lists.length !== 1) {
    fail('SUPPLEMENTAL_INDEX_INVALID', 'supplemental index must have one unambiguous artifact inventory');
  }
  const parsedLists = [];
  for (const list of lists) {
    if (!Array.isArray(list)) {
      fail('SUPPLEMENTAL_INDEX_INVALID', 'supplemental index artifact inventory must be an array');
    }
    const parsed = [];
    const seen = new Set();
    for (const raw of list) {
      let pathValue;
      let entryNonceHex = null;
      let entryCiphertextSha256 = null;
      if (typeof raw === 'string') {
        pathValue = raw;
      } else if (isPlainObject(raw)) {
        const pathFields = ['path', 'relativePath', 'objectKey', 'key', 'name']
          .filter((field) => raw[field] !== undefined);
        if (pathFields.length !== 1) {
          fail(
            'SUPPLEMENTAL_INDEX_INVALID',
            'supplemental index artifact object must have exactly one path field',
          );
        }
        pathValue = raw[pathFields[0]];
        if (raw.nonceHex !== undefined) {
          if (typeof raw.nonceHex !== 'string' || !NONCE_HEX.test(raw.nonceHex)) {
            fail('SUPPLEMENTAL_INDEX_INVALID', 'supplemental index nonceHex must be 24 lowercase hex characters');
          }
          entryNonceHex = raw.nonceHex;
        }
        const digestField = raw.ciphertextSha256 !== undefined ? 'ciphertextSha256' : 'sha256';
        if (raw[digestField] !== undefined) {
          if (typeof raw[digestField] !== 'string' || !SHA256_HEX.test(raw[digestField])) {
            fail('SUPPLEMENTAL_INDEX_INVALID', 'supplemental index ciphertext hash must be 64 lowercase hex characters');
          }
          entryCiphertextSha256 = raw[digestField];
        }
      } else {
        fail('SUPPLEMENTAL_INDEX_INVALID', 'supplemental index artifact entry must be a string or object');
      }
      const normalized = normalizeIndexPath(pathValue);
      if (seen.has(normalized)) {
        fail('SUPPLEMENTAL_INDEX_INVALID', `supplemental index contains a duplicate path: ${normalized}`);
      }
      seen.add(normalized);
      parsed.push({
        path: normalized,
        nonceHex: entryNonceHex,
        ciphertextSha256: entryCiphertextSha256,
      });
    }
    parsedLists.push(parsed);
  }
  compareSets(
    parsedLists[0].map((entry) => entry.path),
    [...entries.map((entry) => entry.path), MANIFEST_ENVELOPE, SHA256SUMS_PATH, CLOSEOUT_CLOSEOUT_ENVELOPE],
    'SUPPLEMENTAL_INDEX_INVALID',
    'supplemental index artifact inventory',
  );

  const mainByPath = new Map(entries.map((entry) => [entry.path, entry]));
  mainByPath.set(MANIFEST_ENVELOPE, {
    path: MANIFEST_ENVELOPE,
    nonceHex: manifestHeader.nonceHex,
    ciphertextSha256: manifestDigest,
  });
  const supplemental = [];
  for (const entry of parsedLists[0]) {
    if (!entry.path.endsWith('.aesgcm')) continue;
    if (mainByPath.has(entry.path)) {
      const expected = mainByPath.get(entry.path);
      if (entry.nonceHex !== null && entry.nonceHex !== expected.nonceHex) {
        fail('SUPPLEMENTAL_NONCE_MISMATCH', `supplemental index nonce does not match the main set: ${entry.path}`);
      }
      if (
        entry.ciphertextSha256 !== null
        && expected.ciphertextSha256 !== null
        && entry.ciphertextSha256 !== expected.ciphertextSha256
      ) {
        fail('SUPPLEMENTAL_HASH_MISMATCH', `supplemental index hash does not match the main set: ${entry.path}`);
      }
      continue;
    }
    if (!entry.path.startsWith(CLOSEOUT_PREFIX)) {
      fail(
        'SUPPLEMENTAL_INDEX_INVALID',
        `supplemental index lists an encrypted path outside closeout/: ${entry.path}`,
      );
    }
    supplemental.push(entry);
  }
  if (
    supplemental.length !== 1
    || supplemental[0].path !== CLOSEOUT_CLOSEOUT_ENVELOPE
  ) {
    fail(
      'SUPPLEMENTAL_INDEX_INVALID',
      'supplemental index must list exactly the closeout encrypted envelope',
    );
  }
  return { entries: parsedLists[0], supplemental };
}

export async function verifySet({
  root,
  keyFile,
  backupId,
  excludePrefix = null,
  manifestPath = null,
  checksumsPath = null,
  chunkSize = DEFAULT_CHUNK_SIZE,
}) {
  validateBackupId(backupId);
  if (excludePrefix !== null && excludePrefix !== undefined && excludePrefix !== CLOSEOUT_PREFIX) {
    fail('EXCLUDE_PREFIX_INVALID', 'the only supported exclusion is --exclude-prefix closeout/');
  }
  const effectiveExclude = excludePrefix === undefined ? null : excludePrefix;
  const effectiveChunkSize = validateChunkSize(chunkSize);
  const key = await readKeyFile(keyFile);
  let temporaryDirectory = null;
  try {
    const rootPath = await validateRootDirectory(root);
    temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'aesgcm-verify-'));
    registerTempDirectory(temporaryDirectory);
    const manifestInfo = await loadAuthenticatedManifest({
      key,
      rootPath,
      backupId,
      chunkSize: effectiveChunkSize,
      suppliedManifestPath: manifestPath,
      temporaryDirectory,
    });
    const { entries, manifestHeader, manifestEnvelopeSize, keyFingerprint } = manifestInfo;

    const allEnvelopes = await walkAesgcm(rootPath);
    const mainEnvelopes = effectiveExclude === null
      ? allEnvelopes
      : allEnvelopes.filter((entry) => !entry.startsWith(effectiveExclude));
    const closeoutEnvelopes = effectiveExclude === null
      ? []
      : allEnvelopes.filter((entry) => entry.startsWith(effectiveExclude));

    const effectiveChecksumsPath = checksumsPath === undefined || checksumsPath === null
      ? path.join(rootPath, SHA256SUMS_PATH)
      : resolveSuppliedPath(rootPath, checksumsPath, 'checksums');
    const mainSums = await readChecksumFile(effectiveChecksumsPath, {
      label: 'checksum file',
      forbidPrefix: effectiveExclude ?? null,
      selfPath: SHA256SUMS_PATH,
    });
    compareSets([...mainSums.keys()], mainEnvelopes, 'SUMS_COVERAGE_MISMATCH', 'SHA256SUMS coverage');

    const actualHashes = new Map();
    for (const relativePath of mainEnvelopes) {
      const result = await hashFileAt(rootPath, relativePath, effectiveChunkSize);
      actualHashes.set(relativePath, result);
    }
    for (const [relativePath, expectedDigest] of mainSums) {
      const actual = actualHashes.get(relativePath);
      if (!actual || actual.digest !== expectedDigest) {
        fail('SUMS_HASH_MISMATCH', `SHA256SUMS digest does not match: ${relativePath}`);
      }
    }

    const expectedArtifactPaths = mainEnvelopes.filter((entry) => entry !== MANIFEST_ENVELOPE);
    compareSets(
      entries.map((entry) => entry.path),
      expectedArtifactPaths,
      'ARTIFACT_SET_MISMATCH',
      'manifest artifact set',
    );

    const nonceOwners = new Map();
    recordNonce(nonceOwners, keyFingerprint, manifestHeader.nonceHex, MANIFEST_ENVELOPE);
    const manifestActual = actualHashes.get(MANIFEST_ENVELOPE);
    if (!manifestActual || manifestActual.size !== manifestEnvelopeSize) {
      fail('MANIFEST_HASH_MISMATCH', 'manifest envelope size changed during verification');
    }
    if (manifestActual.digest !== manifestInfo.manifestCiphertextSha256) {
      fail('MANIFEST_HASH_MISMATCH', 'manifest envelope changed after authentication');
    }
    if (mainSums.get(MANIFEST_ENVELOPE) !== manifestActual.digest) {
      fail('SUMS_HASH_MISMATCH', 'SHA256SUMS digest does not match the encrypted manifest');
    }

    const verifiedArtifacts = [];
    for (const entry of entries) {
      const { header, size } = await readHeaderAt(rootPath, entry.path);
      if (header.aad.backupId !== backupId) {
        fail('MANIFEST_AAD_MISMATCH', `artifact AAD backup id does not match: ${entry.path}`);
      }
      if (header.aad.artifact !== entry.artifact) {
        fail('MANIFEST_AAD_MISMATCH', `artifact AAD path does not match: ${entry.path}`);
      }
      if (header.aad.bytes !== entry.plaintextBytes) {
        fail('MANIFEST_BYTES_MISMATCH', `artifact plaintext byte count does not match: ${entry.path}`);
      }
      if (header.aad.sha256 !== entry.plaintextSha256) {
        fail('MANIFEST_HASH_MISMATCH', `artifact plaintext SHA-256 does not match: ${entry.path}`);
      }
      if (header.aad.text !== entry.aad) {
        fail('MANIFEST_AAD_MISMATCH', `artifact AAD text does not match: ${entry.path}`);
      }
      if (header.nonceHex !== entry.nonceHex) {
        fail('MANIFEST_NONCE_MISMATCH', `artifact nonce does not match the manifest: ${entry.path}`);
      }
      if (size !== entry.ciphertextBytes) {
        fail('MANIFEST_BYTES_MISMATCH', `artifact ciphertext byte count does not match: ${entry.path}`);
      }
      const actual = actualHashes.get(entry.path);
      if (!actual || actual.digest !== entry.ciphertextSha256) {
        fail('MANIFEST_HASH_MISMATCH', `artifact ciphertext SHA-256 does not match: ${entry.path}`);
      }
      if (mainSums.get(entry.path) !== entry.ciphertextSha256) {
        fail('SUMS_HASH_MISMATCH', `artifact SHA-256 does not match SHA256SUMS: ${entry.path}`);
      }
      recordNonce(nonceOwners, keyFingerprint, header.nonceHex, entry.path);
      const authenticated = await decryptWithKey({
        key, input: path.join(rootPath, entry.path), backupId, artifact: entry.artifact,
        expectSha256: entry.plaintextSha256, chunkSize: effectiveChunkSize, verifyOnly: true,
      });
      if (authenticated.ciphertextSha256 !== entry.ciphertextSha256) {
        fail('MANIFEST_HASH_MISMATCH', `artifact changed after checksum verification: ${entry.path}`);
      }
      verifiedArtifacts.push({
        artifact: entry.artifact,
        path: entry.path,
        nonceHex: entry.nonceHex,
        plaintextBytes: entry.plaintextBytes,
        plaintextSha256: entry.plaintextSha256,
        ciphertextBytes: entry.ciphertextBytes,
        ciphertextSha256: entry.ciphertextSha256,
      });
    }

    let closeoutVerified = 0;
    let closeoutChecksumEntries = 0;
    if (effectiveExclude !== null) {
      const closeoutDirectory = await lstatOrNull(path.join(rootPath, 'closeout'));
      if (closeoutDirectory) {
        const closeoutBundle = await verifyCloseoutBundle(rootPath, backupId);
        compareSets(
          closeoutEnvelopes,
          [CLOSEOUT_CLOSEOUT_ENVELOPE],
          'CLOSEOUT_COVERAGE_MISMATCH',
          'closeout encrypted artifact set',
        );
        recordNonce(
          nonceOwners,
          keyFingerprint,
          closeoutBundle.header.nonceHex,
          CLOSEOUT_CLOSEOUT_ENVELOPE,
        );
        const authenticated = await decryptWithKey({
          key, input: path.join(rootPath, CLOSEOUT_CLOSEOUT_ENVELOPE), backupId,
          artifact: CLOSEOUT_CLOSEOUT_ARTIFACT, chunkSize: effectiveChunkSize, verifyOnly: true,
        });
        if (authenticated.ciphertextSha256 !== closeoutBundle.sums.get(CLOSEOUT_CLOSEOUT_ENVELOPE)) {
          fail('CLOSEOUT_HASH_MISMATCH', 'closeout changed after checksum verification');
        }
        closeoutVerified = 1;
        closeoutChecksumEntries = closeoutBundle.sums.size;
      }
    }

    return {
      status: 'ok',
      operation: 'verify-set',
      backupId,
      manifest: {
        artifact: MANIFEST_ARTIFACT,
        envelope: MANIFEST_ENVELOPE,
        nonceHex: manifestHeader.nonceHex,
        plaintextBytes: manifestHeader.aad.bytes,
        plaintextSha256: manifestHeader.aad.sha256,
        ciphertextBytes: manifestEnvelopeSize,
        ciphertextSha256: manifestActual.digest,
      },
      artifacts: verifiedArtifacts,
      artifactCount: verifiedArtifacts.length,
      excludedPrefix: effectiveExclude,
      closeoutArtifacts: closeoutVerified,
      closeoutChecksumEntries,
      uniqueNonceCount: nonceOwners.size,
      sha256SumsEntries: mainSums.size,
      suppliedManifest: manifestPath !== undefined && manifestPath !== null,
      suppliedChecksums: checksumsPath !== undefined && checksumsPath !== null,
    };
  } finally {
    key.fill(0);
    if (temporaryDirectory) {
      await fsp.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
      unregisterTempDirectory(temporaryDirectory);
    }
  }
}

export async function verifyNonceSet({
  root,
  keyFile,
  backupId,
  manifestPath,
  supplementalIndexPath,
  includeManifestEnvelope = false,
  rejectUnlisted = false,
  chunkSize = DEFAULT_CHUNK_SIZE,
}) {
  validateBackupId(backupId);
  if (typeof manifestPath !== 'string' || manifestPath.length === 0) {
    fail('USAGE', '--manifest is required');
  }
  if (typeof supplementalIndexPath !== 'string' || supplementalIndexPath.length === 0) {
    fail('USAGE', '--supplemental-index is required');
  }
  const effectiveChunkSize = validateChunkSize(chunkSize);
  const key = await readKeyFile(keyFile);
  let temporaryDirectory = null;
  try {
    const rootPath = await validateRootDirectory(root);
    temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'aesgcm-nonce-'));
    registerTempDirectory(temporaryDirectory);
    const manifestInfo = await loadAuthenticatedManifest({
      key,
      rootPath,
      backupId,
      chunkSize: effectiveChunkSize,
      suppliedManifestPath: manifestPath,
      temporaryDirectory,
    });
    const { entries, manifestHeader, keyFingerprint } = manifestInfo;

    const indexAbsolute = resolveSuppliedPath(rootPath, supplementalIndexPath, 'supplemental-index');
    const indexRelative = path.relative(rootPath, indexAbsolute);
    if (indexRelative !== CLOSEOUT_INDEX_PATH) {
      fail(
        'SUPPLEMENTAL_INDEX_INVALID',
        `supplemental index must be ${CLOSEOUT_INDEX_PATH} under the backup root`,
      );
    }
    const closeoutBundle = await verifyCloseoutBundle(rootPath, backupId);
    const indexBytes = closeoutBundle.payloads.get(CLOSEOUT_INDEX_PATH);
    if (!indexBytes) {
      fail('SUPPLEMENTAL_INDEX_MISSING', 'supplemental index is missing from the closeout bundle');
    }
    const indexText = decodeUtf8Strict(
      indexBytes,
      'SUPPLEMENTAL_INDEX_INVALID',
      'supplemental index',
    );
    const index = parseJsonStrict(indexText, 'SUPPLEMENTAL_INDEX_INVALID', 'supplemental index');
    const supplemental = validateSupplementalIndex(
      index,
      backupId,
      entries,
      manifestHeader,
      manifestInfo.manifestCiphertextSha256,
    );

    const mainExpected = new Set([MANIFEST_ENVELOPE, ...entries.map((entry) => entry.path)]);
    const expected = new Set([...mainExpected, ...supplemental.supplemental.map((entry) => entry.path)]);
    // storage/bytes/ contains raw source objects, not backup envelopes (§B9).
    const allEnvelopes = await walkAesgcm(rootPath);
    const actualSet = new Set(allEnvelopes);
    const unlisted = allEnvelopes.filter((entry) => !expected.has(entry));
    if (unlisted.length > 0) {
      fail(
        'UNLISTED_ENCRYPTED_ARTIFACT',
        `encrypted artifact is not listed by the authenticated manifest or closeout index: ${unlisted[0]}`,
      );
    }
    const missing = [...expected].filter((entry) => !actualSet.has(entry));
    if (missing.length > 0) {
      fail(
        'LISTED_ENCRYPTED_ARTIFACT_MISSING',
        `listed encrypted artifact is missing: ${missing[0]}`,
      );
    }

    const nonceEntries = [];
    const mainManifestActual = await hashFileAt(rootPath, MANIFEST_ENVELOPE, effectiveChunkSize);
    if (mainManifestActual.digest !== manifestInfo.manifestCiphertextSha256) {
      fail('MANIFEST_HASH_MISMATCH', 'manifest envelope changed after authentication');
    }
    const mainSums = await readChecksumFile(path.join(rootPath, SHA256SUMS_PATH), {
      forbidPrefix: CLOSEOUT_PREFIX, selfPath: SHA256SUMS_PATH,
    });
    compareSets([...mainSums.keys()], [...mainExpected], 'SUMS_COVERAGE_MISMATCH', 'main checksum inventory');
    if (mainSums.get(MANIFEST_ENVELOPE) !== mainManifestActual.digest) {
      fail('SUMS_HASH_MISMATCH', 'main checksum does not match the authenticated manifest');
    }
    nonceEntries.push({
      keyId: keyFingerprint,
      nonceHex: manifestHeader.nonceHex,
      owner: MANIFEST_ENVELOPE,
    });
    const mainArtifacts = [];
    for (const entry of entries) {
      const { header, size } = await readHeaderAt(rootPath, entry.path);
      if (header.aad.backupId !== backupId) {
        fail('MANIFEST_AAD_MISMATCH', `artifact AAD backup id does not match: ${entry.path}`);
      }
      if (header.aad.artifact !== entry.artifact) {
        fail('MANIFEST_AAD_MISMATCH', `artifact AAD path does not match: ${entry.path}`);
      }
      if (header.aad.bytes !== entry.plaintextBytes) {
        fail('MANIFEST_BYTES_MISMATCH', `artifact plaintext byte count does not match: ${entry.path}`);
      }
      if (header.aad.sha256 !== entry.plaintextSha256) {
        fail('MANIFEST_HASH_MISMATCH', `artifact plaintext SHA-256 does not match: ${entry.path}`);
      }
      if (header.aad.text !== entry.aad) {
        fail('MANIFEST_AAD_MISMATCH', `artifact AAD text does not match: ${entry.path}`);
      }
      if (header.nonceHex !== entry.nonceHex) {
        fail('MANIFEST_NONCE_MISMATCH', `artifact nonce does not match the manifest: ${entry.path}`);
      }
      if (size !== entry.ciphertextBytes) {
        fail('MANIFEST_BYTES_MISMATCH', `artifact ciphertext byte count does not match: ${entry.path}`);
      }
      const actual = await hashFileAt(rootPath, entry.path, effectiveChunkSize);
      if (actual.digest !== entry.ciphertextSha256) {
        fail('MANIFEST_HASH_MISMATCH', `artifact ciphertext SHA-256 does not match: ${entry.path}`);
      }
      if (mainSums.get(entry.path) !== actual.digest) {
        fail('SUMS_HASH_MISMATCH', `main checksum does not match: ${entry.path}`);
      }
      const authenticated = await decryptWithKey({
        key, input: path.join(rootPath, entry.path), backupId, artifact: entry.artifact,
        expectSha256: entry.plaintextSha256, chunkSize: effectiveChunkSize, verifyOnly: true,
      });
      if (authenticated.ciphertextSha256 !== entry.ciphertextSha256) {
        fail('MANIFEST_HASH_MISMATCH', `artifact changed after checksum verification: ${entry.path}`);
      }
      nonceEntries.push({
        keyId: keyFingerprint,
        nonceHex: header.nonceHex,
        owner: entry.path,
      });
      mainArtifacts.push({
        artifact: entry.artifact,
        path: entry.path,
        nonceHex: entry.nonceHex,
        plaintextBytes: entry.plaintextBytes,
        plaintextSha256: entry.plaintextSha256,
        ciphertextBytes: entry.ciphertextBytes,
        ciphertextSha256: entry.ciphertextSha256,
      });
    }

    const supplementalArtifacts = [];
    for (const indexEntry of supplemental.supplemental) {
      const bytes = closeoutBundle.payloads.get(indexEntry.path);
      if (!bytes) {
        fail(
          'SUPPLEMENTAL_INDEX_INVALID',
          `supplemental index lists an artifact outside the validated closeout bundle: ${indexEntry.path}`,
        );
      }
      const header = parseEnvelopeHeaderBuffer(bytes);
      const digest = sha256Hex(bytes);
      if (header.aad.backupId !== backupId) {
        fail('SUPPLEMENTAL_AAD_MISMATCH', `supplemental artifact AAD backup id does not match: ${indexEntry.path}`);
      }
      const expectedArtifact = indexEntry.path.slice(0, -'.aesgcm'.length);
      if (header.aad.artifact !== expectedArtifact) {
        fail('SUPPLEMENTAL_AAD_MISMATCH', `supplemental artifact AAD path does not match: ${indexEntry.path}`);
      }
      if (closeoutBundle.sums.get(indexEntry.path) !== digest) {
        fail('SUPPLEMENTAL_HASH_MISMATCH', `supplemental artifact hash does not match closeout sums: ${indexEntry.path}`);
      }
      if (indexEntry.nonceHex !== null && indexEntry.nonceHex !== header.nonceHex) {
        fail('SUPPLEMENTAL_NONCE_MISMATCH', `supplemental artifact nonce does not match the index: ${indexEntry.path}`);
      }
      if (indexEntry.ciphertextSha256 !== null && indexEntry.ciphertextSha256 !== digest) {
        fail('SUPPLEMENTAL_HASH_MISMATCH', `supplemental artifact hash does not match the index: ${indexEntry.path}`);
      }
      nonceEntries.push({
        // One key per backup set (§5.2). Do not interpret a caller/index keyId:
        // that field has no runbook wire schema and cannot create a nonce domain.
        keyId: keyFingerprint,
        nonceHex: header.nonceHex,
        owner: indexEntry.path,
      });
      supplementalArtifacts.push({
        artifact: expectedArtifact,
        path: indexEntry.path,
        nonceHex: header.nonceHex,
        ciphertextBytes: bytes.length,
        ciphertextSha256: digest,
      });
      const authenticated = await decryptWithKey({
        key, input: path.join(rootPath, indexEntry.path), backupId, artifact: expectedArtifact,
        chunkSize: effectiveChunkSize, verifyOnly: true,
      });
      if (authenticated.ciphertextSha256 !== digest) {
        fail('SUPPLEMENTAL_HASH_MISMATCH', 'supplemental envelope changed after checksum verification');
      }
    }

    const uniqueNonceCount = assertNoDuplicateNoncePairs(nonceEntries);

    return {
      status: 'ok',
      operation: 'verify-nonce-set',
      backupId,
      keyId: keyFingerprint,
      manifest: {
        artifact: MANIFEST_ARTIFACT,
        envelope: MANIFEST_ENVELOPE,
        nonceHex: manifestHeader.nonceHex,
        plaintextBytes: manifestHeader.aad.bytes,
        plaintextSha256: manifestHeader.aad.sha256,
        ciphertextBytes: manifestInfo.manifestEnvelopeSize,
        ciphertextSha256: mainManifestActual.digest,
      },
      artifacts: mainArtifacts,
      artifactCount: mainArtifacts.length,
      supplementalArtifacts,
      supplementalArtifactCount: supplementalArtifacts.length,
      includedManifestEnvelope: true,
      rejectedUnlisted: true,
      requestedIncludeManifestEnvelope: Boolean(includeManifestEnvelope),
      requestedRejectUnlisted: Boolean(rejectUnlisted),
      closeoutChecksumEntries: closeoutBundle.sums.size,
      uniqueNonceCount,
      encryptedArtifactCount: uniqueNonceCount,
      indexValidation: 'local-inventory-and-checksums-only',
    };
  } finally {
    key.fill(0);
    if (temporaryDirectory) {
      await fsp.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
      unregisterTempDirectory(temporaryDirectory);
    }
  }
}

const USAGE = `Usage:
  node scripts/backup/aesgcm-stream.mjs encrypt --in <plaintext> --out <envelope> --key-file <key> --backup-id <id> --artifact <relative-path> [--chunk-size <bytes>]
  node scripts/backup/aesgcm-stream.mjs decrypt --in <envelope> --out <plaintext> --key-file <key> --backup-id <id> --artifact <relative-path> [--expect-sha256 <hex>] [--chunk-size <bytes>]
  node scripts/backup/aesgcm-stream.mjs verify-set --root <backup-root> --key-file <key> --backup-id <id> [--manifest <authenticated-manifest>] [--checksums <sha256sums>] [--exclude-prefix closeout/] [--chunk-size <bytes>]
  node scripts/backup/aesgcm-stream.mjs verify-nonce-set --root <backup-root> --key-file <key> --backup-id <id> --manifest <authenticated-manifest> --supplemental-index <closeout/offsite-bundle-index.json> [--include-manifest-envelope] [--reject-unlisted] [--chunk-size <bytes>]

Envelope: CRMBKP01 | version 1 | 12-byte nonce | uint32be AAD length | AAD | ciphertext | 16-byte GCM tag
AAD:      v1|backup=<BACKUP_ID>|artifact=<relative-path>|bytes=<plaintext-bytes>|sha256=<plaintext-sha256>

The key must be a 32-byte regular file with no group/other access. Output and
temporary files are created 0600 in a private directory and published with an
exclusive no-replace hard link only after all authentication checks pass.
`;

const COMMAND_OPTIONS = {
  encrypt: new Set(['in', 'out', 'key-file', 'backup-id', 'artifact', 'chunk-size']),
  decrypt: new Set([
    'in',
    'out',
    'key-file',
    'backup-id',
    'artifact',
    'expect-sha256',
    'chunk-size',
  ]),
  'verify-set': new Set([
    'root',
    'key-file',
    'backup-id',
    'manifest',
    'checksums',
    'exclude-prefix',
    'chunk-size',
  ]),
  'verify-nonce-set': new Set([
    'root',
    'key-file',
    'backup-id',
    'manifest',
    'supplemental-index',
    'include-manifest-envelope',
    'reject-unlisted',
    'chunk-size',
  ]),
};

const BOOLEAN_OPTIONS = {
  'verify-nonce-set': new Set(['include-manifest-envelope', 'reject-unlisted']),
};

const REQUIRED_OPTIONS = {
  encrypt: ['in', 'out', 'key-file', 'backup-id', 'artifact'],
  decrypt: ['in', 'out', 'key-file', 'backup-id', 'artifact'],
  'verify-set': ['root', 'key-file', 'backup-id'],
  'verify-nonce-set': [
    'root',
    'key-file',
    'backup-id',
    'manifest',
    'supplemental-index',
  ],
};

function parseCli(argv) {
  if (argv.length === 0) fail('USAGE', 'missing command');
  const command = argv[0];
  if (command === '--help' || command === '-h' || command === 'help') {
    return { command: 'help', options: {} };
  }
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) {
    fail('USAGE', `unknown command: ${command}`);
  }
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      return { command: 'help', options: {} };
    }
    if (!argument.startsWith('--') || argument === '--') {
      fail('USAGE', 'unexpected positional argument');
    }
    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals);
    if (!COMMAND_OPTIONS[command].has(name)) {
      fail('USAGE', `unknown option --${name}`);
    }
    if (Object.hasOwn(options, name)) {
      fail('USAGE', `duplicate option --${name}`);
    }
    if (BOOLEAN_OPTIONS[command] && BOOLEAN_OPTIONS[command].has(name)) {
      if (equals !== -1) fail('USAGE', `--${name} does not take a value`);
      options[name] = true;
      continue;
    }
    let value;
    if (equals !== -1) {
      value = argument.slice(equals + 1);
    } else {
      if (index + 1 >= argv.length) fail('USAGE', `missing value for --${name}`);
      index += 1;
      value = argv[index];
    }
    if (value === '') fail('USAGE', `empty value for --${name}`);
    options[name] = value;
  }
  for (const required of REQUIRED_OPTIONS[command]) {
    if (!Object.hasOwn(options, required)) {
      fail('USAGE', `--${required} is required`);
    }
  }
  return { command, options };
}

function emitJson(value, stream) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function errorSummary(operation, error) {
  if (error instanceof HelperError) {
    return {
      status: 'failed',
      operation: operation ?? null,
      error: { code: error.code, message: error.message },
    };
  }
  return {
    status: 'failed',
    operation: operation ?? null,
    error: { code: 'INTERNAL_ERROR', message: 'unexpected helper failure' },
  };
}

async function main(argv) {
  const parsed = parseCli(argv);
  if (parsed.command === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  const options = parsed.options;
  let summary;
  if (parsed.command === 'encrypt') {
    summary = await encryptFile({
      input: options.in,
      output: options.out,
      keyFile: options['key-file'],
      backupId: options['backup-id'],
      artifact: options.artifact,
      chunkSize: options['chunk-size'],
    });
  } else if (parsed.command === 'decrypt') {
    summary = await decryptFile({
      input: options.in,
      output: options.out,
      keyFile: options['key-file'],
      backupId: options['backup-id'],
      artifact: options.artifact,
      expectSha256: options['expect-sha256'],
      chunkSize: options['chunk-size'],
    });
  } else if (parsed.command === 'verify-set') {
    summary = await verifySet({
      root: options.root,
      keyFile: options['key-file'],
      backupId: options['backup-id'],
      excludePrefix: options['exclude-prefix'],
      manifestPath: options.manifest,
      checksumsPath: options.checksums,
      chunkSize: options['chunk-size'],
    });
  } else {
    summary = await verifyNonceSet({
      root: options.root,
      keyFile: options['key-file'],
      backupId: options['backup-id'],
      manifestPath: options.manifest,
      supplementalIndexPath: options['supplemental-index'],
      includeManifestEnvelope: options['include-manifest-envelope'],
      rejectUnlisted: options['reject-unlisted'],
      chunkSize: options['chunk-size'],
    });
  }
  emitJson(summary, process.stdout);
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
  const operation = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : null;
  main(process.argv.slice(2)).catch((error) => {
    cleanupTempsSync();
    emitJson(errorSummary(operation, error), process.stderr);
    process.exitCode = 1;
  });
}
