#!/usr/bin/env node
/**
 * scripts/backup/storage-export.mjs
 *
 * Helper #3: Supabase Storage Export (Local Synthetic Phase)
 *
 * Contract references:
 * - docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12.md §B7, §B8, §B9, §B10, §R1, §R6
 *
 * Core capabilities:
 * - Inventories storage buckets and objects
 * - Streams raw binary bytes without text decoding or memory buffering
 * - Computes SHA-256 over exact raw bytes
 * - Preserves bucket identity, safe relative paths, sizes, and MIME metadata
 * - Enforces path traversal prevention, symlink rejection, unsupported file type detection
 * - Detects duplicate object paths and metadata identity mismatches
 * - Guarantees snapshot consistency (fails on concurrent mutation / append / truncation)
 * - Guarantees atomic publication (staging directories, temp files, no overwrite)
 * - Emits machine-readable JSON output and structured explicit error codes
 * - Redacts sensitive details and never logs secret keys or object contents
 * - Enforces fail-closed boundary: hosted Supabase Storage provider adapter is BLOCKED
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// -----------------------------------------------------------------------------
// Constants & Defaults
// -----------------------------------------------------------------------------

export const DEFAULT_CHUNK_SIZE = 64 * 1024; // 64 KiB
export const MIN_CHUNK_SIZE = 1024; // 1 KiB
export const MAX_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB
export const DEFAULT_CONCURRENCY = 4;
export const MAX_PATH_BYTES = 1024;

const MIME_EXTENSION_MAP = Object.freeze({
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.bin': 'application/octet-stream',
});

// -----------------------------------------------------------------------------
// Error Handling
// -----------------------------------------------------------------------------

export class HelperError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HelperError';
    this.code = code;
  }
}

export function fail(code, message) {
  throw new HelperError(code, message);
}

// -----------------------------------------------------------------------------
// Temp File / Directory Lifecycle & Signal Cleanups
// -----------------------------------------------------------------------------

const activeTempFiles = new Set();
const activeTempDirs = new Set();
const activeRollbackJournals = new Set();
let signalsInstalled = false;

export function registerTempFile(filePath) {
  activeTempFiles.add(filePath);
}

export function unregisterTempFile(filePath) {
  activeTempFiles.delete(filePath);
}

export function registerTempDir(dirPath) {
  activeTempDirs.add(dirPath);
}

export function unregisterTempDir(dirPath) {
  activeTempDirs.delete(dirPath);
}

export function rollbackJournalSync(journal) {
  while (journal && journal.length > 0) {
    const entry = journal.pop();
    try {
      const st = fs.lstatSync(entry.path);
      // Strictly verify device and inode before removing
      if (st.dev === entry.dev && st.ino === entry.ino) {
        if (entry.type === 'directory') {
          fs.rmSync(entry.path, { recursive: true, force: true });
        } else if (entry.type === 'file') {
          fs.unlinkSync(entry.path);
        }
      }
    } catch {
      // Best-effort rollback
    }
  }
}

export async function rollbackJournal(journal) {
  while (journal && journal.length > 0) {
    const entry = journal.pop();
    try {
      const st = await fsp.lstat(entry.path);
      // Strictly verify device and inode before removing
      if (st.dev === entry.dev && st.ino === entry.ino) {
        if (entry.type === 'directory') {
          await fsp.rm(entry.path, { recursive: true, force: true });
        } else if (entry.type === 'file') {
          await fsp.unlink(entry.path);
        }
        await fsyncDirectory(path.dirname(entry.path));
      }
    } catch {
      // Best-effort rollback
    }
  }
}

export function cleanupAllTempsSync() {
  for (const journal of activeRollbackJournals) {
    try {
      rollbackJournalSync(journal);
    } catch {
      // Best-effort cleanup
    }
  }
  activeRollbackJournals.clear();

  for (const f of activeTempFiles) {
    try {
      fs.unlinkSync(f);
    } catch {
      // Best-effort cleanup
    }
  }
  activeTempFiles.clear();

  for (const d of activeTempDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
  activeTempDirs.clear();
}

export function installSignalHandlers() {
  if (signalsInstalled) return;
  signalsInstalled = true;

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      cleanupAllTempsSync();
      process.exit(128 + 15);
    });
  }
  process.on('exit', () => {
    cleanupAllTempsSync();
  });
}

// -----------------------------------------------------------------------------
// Validation Utilities
// -----------------------------------------------------------------------------

export function validateBucketName(bucket) {
  if (typeof bucket !== 'string' || bucket.trim().length === 0) {
    fail('INVALID_BUCKET', 'bucket name must be a non-empty string');
  }
  if (bucket.includes('/') || bucket.includes('\\') || bucket.includes('..') || bucket.includes('\0')) {
    fail('PATH_TRAVERSAL', `bucket name contains invalid or traversal characters: ${bucket}`);
  }
  if (!/^[a-z0-9][a-z0-9_.-]{1,61}[a-z0-9]$/.test(bucket)) {
    fail('INVALID_BUCKET', `bucket name '${bucket}' violates naming policy`);
  }
  return bucket;
}

export function validateObjectPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    fail('INVALID_PATH', 'object path must be a non-empty string');
  }
  if (rawPath.includes('\0')) {
    fail('INVALID_PATH', 'object path must not contain null bytes');
  }
  if (rawPath.startsWith('/') || rawPath.startsWith('\\')) {
    fail('PATH_TRAVERSAL', `object path must not be absolute: ${rawPath}`);
  }
  if (rawPath.includes('\\')) {
    fail('INVALID_PATH', `object path must use forward slashes: ${rawPath}`);
  }

  const segments = rawPath.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg === '' || seg === '.') {
      fail('INVALID_PATH', `object path contains empty or dot segment: ${rawPath}`);
    }
    if (seg === '..') {
      fail('PATH_TRAVERSAL', `object path contains traversal segment: ${rawPath}`);
    }
  }

  if (Buffer.byteLength(rawPath, 'utf8') > MAX_PATH_BYTES) {
    fail('INVALID_PATH', `object path exceeds maximum length of ${MAX_PATH_BYTES} bytes: ${rawPath}`);
  }

  return rawPath;
}

export function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_EXTENSION_MAP[ext] || 'application/octet-stream';
}

export async function fsyncDirectory(dirPath) {
  let handle;
  try {
    handle = await fsp.open(dirPath, fs.constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Best effort on platforms that do not support directory sync
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export async function isCaseInsensitiveDir(dirPath) {
  try {
    const parentDir = path.resolve(dirPath);
    await fsp.mkdir(parentDir, { recursive: true, mode: 0o700 });
    const probeName = `.case-probe-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const upperPath = path.join(parentDir, probeName);
    const lowerPath = path.join(parentDir, probeName.toLowerCase());
    await fsp.writeFile(upperPath, 'probe', { mode: 0o600 });
    try {
      await fsp.access(lowerPath);
      return true;
    } catch {
      return false;
    } finally {
      await fsp.unlink(upperPath).catch(() => {});
    }
  } catch {
    return process.platform === 'darwin' || process.platform === 'win32';
  }
}

export async function publishDirectoryNoReplace(tempDir, destination) {
  let tempStat;
  try {
    tempStat = await fsp.stat(tempDir);
  } catch (err) {
    fail('PUBLISH_FAILED', `cannot stat temporary directory before publish: ${err.message}`);
  }

  // 1. Atomically claim destination directory using fsp.mkdir (O_CREAT | O_EXCL semantics)
  let claimed = false;
  try {
    await fsp.mkdir(destination, { mode: 0o700 });
    claimed = true;
  } catch (err) {
    if (err && (err.code === 'EEXIST' || err.code === 'EISDIR')) {
      fail('OUTPUT_EXISTS', `destination path already exists: ${destination}`);
    }
    fail('PUBLISH_FAILED', `cannot create destination directory: ${err.message}`);
  }

  // 2. Atomically rename tempDir over the claimed empty directory
  try {
    await fsp.rename(tempDir, destination);
  } catch (err) {
    if (claimed) {
      await fsp.rmdir(destination).catch(() => {});
    }
    fail('PUBLISH_FAILED', `atomic directory publication failed: ${err.message}`);
  }

  // 3. Verify destination inode matches the staged directory
  let destStat;
  try {
    destStat = await fsp.stat(destination);
  } catch (err) {
    fail('PUBLISH_FAILED', `cannot stat destination directory after publish: ${err.message}`);
  }

  if (destStat.dev !== tempStat.dev || destStat.ino !== tempStat.ino) {
    fail('PUBLISH_FAILED', `published directory inode mismatch: ${destination}`);
  }

  unregisterTempDir(tempDir);
  await fsyncDirectory(path.dirname(destination));

  return {
    type: 'directory',
    path: destination,
    dev: destStat.dev,
    ino: destStat.ino,
  };
}

export async function publishFileNoReplace(tempPath, destination) {
  let tempStat;
  try {
    tempStat = await fsp.stat(tempPath);
  } catch (err) {
    fail('PUBLISH_FAILED', `cannot stat temporary file before publish: ${err.message}`);
  }

  let linkSucceeded = false;
  try {
    await fsp.link(tempPath, destination);
    linkSucceeded = true;
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      fail('OUTPUT_EXISTS', `destination path already exists: ${destination}`);
    }
    // Cross-device fallback with atomic O_CREAT | O_EXCL open
    if (err && err.code === 'EXDEV') {
      let handle;
      try {
        handle = await fsp.open(
          destination,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
          0o600,
        );
      } catch (openErr) {
        if (openErr && openErr.code === 'EEXIST') {
          fail('OUTPUT_EXISTS', `destination path already exists: ${destination}`);
        }
        fail('PUBLISH_FAILED', `cannot create destination file: ${openErr.message}`);
      }
      try {
        const data = await fsp.readFile(tempPath);
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      linkSucceeded = true;
    } else {
      fail('PUBLISH_FAILED', `atomic publication failed: ${err.message}`);
    }
  }

  if (linkSucceeded) {
    try {
      await fsp.unlink(tempPath);
    } catch {
      // Best-effort unlink
    }
    unregisterTempFile(tempPath);
    await fsyncDirectory(path.dirname(destination));
  }

  let destStat;
  try {
    destStat = await fsp.stat(destination);
  } catch (err) {
    fail('PUBLISH_FAILED', `cannot stat destination file after publish: ${err.message}`);
  }

  return {
    type: 'file',
    path: destination,
    dev: destStat.dev,
    ino: destStat.ino,
  };
}

export async function publishNoReplace(tempPath, destination) {
  return await publishFileNoReplace(tempPath, destination);
}

// -----------------------------------------------------------------------------
// Streaming Raw Bytes with Snapshot Mutation Protection
// -----------------------------------------------------------------------------

export async function streamObjectBytes({
  sourcePath,
  destPath,
  expectedSize,
  expectedSha256,
  chunkSize = DEFAULT_CHUNK_SIZE,
}) {
  let statBefore;
  try {
    statBefore = await fsp.lstat(sourcePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      fail('OBJECT_NOT_FOUND', `source file not found: ${sourcePath}`);
    }
    fail('SOURCE_INVALID', `cannot stat source file: ${err.message}`);
  }

  if (statBefore.isSymbolicLink()) {
    fail('SYMLINK_DETECTED', `symlink detected in source: ${sourcePath}`);
  }
  if (!statBefore.isFile()) {
    fail('UNSUPPORTED_FILE_TYPE', `unsupported file type in source: ${sourcePath}`);
  }
  if (expectedSize !== undefined && expectedSize !== null && statBefore.size !== expectedSize) {
    fail('IDENTITY_MISMATCH', `object size mismatch: expected ${expectedSize}, got ${statBefore.size} for ${sourcePath}`);
  }

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let srcHandle;
  let dstHandle;

  try {
    srcHandle = await fsp.open(sourcePath, flags);
    const fstatBefore = await srcHandle.stat();
    if (
      fstatBefore.ino !== statBefore.ino ||
      fstatBefore.dev !== statBefore.dev ||
      fstatBefore.size !== statBefore.size ||
      fstatBefore.mtimeMs !== statBefore.mtimeMs
    ) {
      fail('SOURCE_MUTATED', `source file modified between stat and open: ${sourcePath}`);
    }

    if (destPath) {
      try {
        dstHandle = await fsp.open(
          destPath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
          0o600,
        );
      } catch (openErr) {
        if (openErr && openErr.code === 'EEXIST') {
          fail('PATH_COLLISION', `destination filesystem path collision for object: ${destPath}`);
        }
        throw openErr;
      }
      await dstHandle.chmod(0o600);
    }

    const hasher = crypto.createHash('sha256');
    const buffer = Buffer.alloc(chunkSize);
    let bytesReadTotal = 0;
    let readPos = 0;

    while (readPos < statBefore.size) {
      const bytesToRead = Math.min(buffer.length, statBefore.size - readPos);
      const { bytesRead } = await srcHandle.read(buffer, 0, bytesToRead, readPos);
      if (bytesRead === 0) {
        fail(
          'SOURCE_MUTATED',
          `unexpected early EOF at offset ${readPos} (expected ${statBefore.size}): ${sourcePath}`,
        );
      }
      const chunk = buffer.subarray(0, bytesRead);
      hasher.update(chunk);
      if (dstHandle) {
        await dstHandle.write(chunk, 0, bytesRead);
      }
      bytesReadTotal += bytesRead;
      readPos += bytesRead;
    }

    // Check if the source file was appended during or after the loop
    const { bytesRead: extraBytes } = await srcHandle.read(buffer, 0, 1, readPos);
    if (extraBytes > 0) {
      fail('SOURCE_MUTATED', `source file appended during read (expected ${statBefore.size}): ${sourcePath}`);
    }

    // Check handle fstat after read
    const fstatAfter = await srcHandle.stat();
    if (fstatAfter.size !== statBefore.size || fstatAfter.mtimeMs !== statBefore.mtimeMs) {
      fail('SOURCE_MUTATED', `source file modified during read: ${sourcePath}`);
    }

    if (dstHandle) {
      await dstHandle.sync();
    }

    const computedSha256 = hasher.digest('hex');
    if (expectedSha256 && computedSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      fail(
        'IDENTITY_MISMATCH',
        `object sha256 mismatch: expected ${expectedSha256}, got ${computedSha256} for ${sourcePath}`,
      );
    }

    // Final lstat check to verify path wasn't unlinked, mutated or replaced with symlink
    try {
      const statAfter = await fsp.lstat(sourcePath);
      if (statAfter.isSymbolicLink()) {
        fail('SYMLINK_DETECTED', `source file replaced with symlink during read: ${sourcePath}`);
      }
      if (statAfter.ino !== statBefore.ino || statAfter.dev !== statBefore.dev) {
        fail('SOURCE_MUTATED', `source file inode replaced during read: ${sourcePath}`);
      }
      if (statAfter.size !== statBefore.size || statAfter.mtimeMs !== statBefore.mtimeMs) {
        fail('SOURCE_MUTATED', `source file metadata changed during read: ${sourcePath}`);
      }
    } catch (err) {
      if (err instanceof HelperError) throw err;
      if (err && err.code === 'ENOENT') {
        fail('SOURCE_MUTATED', `source file removed during read: ${sourcePath}`);
      }
      fail('SOURCE_INVALID', `cannot stat source file after read: ${err.message}`);
    }

    return {
      size: bytesReadTotal,
      sha256: computedSha256,
    };
  } finally {
    if (srcHandle) await srcHandle.close().catch(() => {});
    if (dstHandle) await dstHandle.close().catch(() => {});
  }
}

// -----------------------------------------------------------------------------
// Local Synthetic Storage Adapter
// -----------------------------------------------------------------------------

export class SyntheticStorageAdapter {
  constructor({ sourceDir }) {
    if (typeof sourceDir !== 'string' || sourceDir.trim().length === 0) {
      fail('USAGE', '--source-dir is required for synthetic adapter');
    }
    this.sourceDir = path.resolve(sourceDir);
    this.caseInsensitive = null;
  }

  async init() {
    let stat;
    try {
      stat = await fsp.lstat(this.sourceDir);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        fail('SOURCE_NOT_FOUND', `source directory does not exist: ${this.sourceDir}`);
      }
      fail('SOURCE_INVALID', `cannot access source directory: ${err.message}`);
    }
    if (stat.isSymbolicLink()) {
      fail('SYMLINK_DETECTED', `source directory must not be a symlink: ${this.sourceDir}`);
    }
    if (!stat.isDirectory()) {
      fail('SOURCE_INVALID', `source directory is not a directory: ${this.sourceDir}`);
    }
    if (this.caseInsensitive === null) {
      this.caseInsensitive = await isCaseInsensitiveDir(this.sourceDir);
    }
  }

  async listBuckets(filterBuckets = null) {
    await this.init();
    const bucketsFile = path.join(this.sourceDir, 'buckets.json');
    let buckets = [];

    let hasBucketsFile = false;
    try {
      const bStat = await fsp.lstat(bucketsFile);
      if (bStat.isSymbolicLink()) {
        fail('SYMLINK_DETECTED', `buckets.json must not be a symlink: ${bucketsFile}`);
      }
      if (!bStat.isFile()) {
        fail('UNSUPPORTED_FILE_TYPE', `buckets.json must be a regular file: ${bucketsFile}`);
      }
      hasBucketsFile = true;
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        fail('SOURCE_INVALID', `cannot stat buckets.json: ${err.message}`);
      }
    }

    if (hasBucketsFile) {
      let raw;
      try {
        raw = await fsp.readFile(bucketsFile, 'utf8');
      } catch (err) {
        fail('SOURCE_INVALID', `cannot read buckets.json: ${err.message}`);
      }
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
          fail('JSON_PARSE_ERROR', 'buckets.json must contain a JSON array of bucket objects');
        }
        buckets = parsed;
      } catch (err) {
        if (err instanceof HelperError) throw err;
        fail('JSON_PARSE_ERROR', `malformed buckets.json: ${err.message}`);
      }
    } else {
      // Discover buckets from top-level directories
      let entries;
      try {
        entries = await fsp.readdir(this.sourceDir, { withFileTypes: true });
      } catch (err) {
        fail('SOURCE_INVALID', `cannot read source directory: ${err.message}`);
      }

      for (const entry of entries) {
        const entryPath = path.join(this.sourceDir, entry.name);
        const eStat = await fsp.lstat(entryPath);
        if (eStat.isSymbolicLink()) {
          fail('SYMLINK_DETECTED', `symlink detected in source directory: ${entryPath}`);
        }
        if (eStat.isSocket() || eStat.isFIFO() || eStat.isCharacterDevice() || eStat.isBlockDevice()) {
          fail('UNSUPPORTED_FILE_TYPE', `unsupported file type in source directory: ${entryPath}`);
        }
        if (eStat.isDirectory()) {
          if (entry.name.startsWith('.')) continue; // ignore hidden/temp dirs
          validateBucketName(entry.name);
          buckets.push({
            id: entry.name,
            name: entry.name,
            public: false,
            file_size_limit: null,
            allowed_mime_types: null,
            type: 'standard',
            versioning_status: 'disabled',
            created_at: null,
            updated_at: null,
          });
        }
      }
    }

    // Validate and normalize bucket list
    const seenBucketIds = new Set();
    const normalizedBuckets = [];

    for (const b of buckets) {
      if (!b || typeof b !== 'object') {
        fail('INVALID_BUCKET', 'bucket entry must be an object');
      }
      const bId = b.id || b.name;
      validateBucketName(bId);
      if (seenBucketIds.has(bId)) {
        fail('DUPLICATE_OBJECT', `duplicate bucket declared: ${bId}`);
      }
      seenBucketIds.add(bId);

      normalizedBuckets.push({
        id: bId,
        name: b.name || bId,
        public: Boolean(b.public),
        file_size_limit: typeof b.file_size_limit === 'number' ? b.file_size_limit : null,
        allowed_mime_types: Array.isArray(b.allowed_mime_types) ? b.allowed_mime_types : null,
        type: b.type || 'standard',
        versioning_status: b.versioning_status || 'disabled',
        created_at: b.created_at || null,
        updated_at: b.updated_at || null,
      });
    }

    normalizedBuckets.sort((a, b) => a.id.localeCompare(b.id));

    if (filterBuckets && filterBuckets.length > 0) {
      const filterSet = new Set(filterBuckets);
      for (const wanted of filterSet) {
        if (!seenBucketIds.has(wanted)) {
          fail('BUCKET_NOT_FOUND', `requested filter bucket not found: ${wanted}`);
        }
      }
      return normalizedBuckets.filter((b) => filterSet.has(b.id));
    }

    return normalizedBuckets;
  }

  async listObjects(bucketId) {
    validateBucketName(bucketId);
    const bucketDir = path.join(this.sourceDir, bucketId);
    const objectsFile = path.join(this.sourceDir, 'objects.json');

    let hasObjectsFile = false;
    try {
      const oStat = await fsp.lstat(objectsFile);
      if (oStat.isSymbolicLink()) {
        fail('SYMLINK_DETECTED', `objects.json must not be a symlink: ${objectsFile}`);
      }
      if (!oStat.isFile()) {
        fail('UNSUPPORTED_FILE_TYPE', `objects.json must be a regular file: ${objectsFile}`);
      }
      hasObjectsFile = true;
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        fail('SOURCE_INVALID', `cannot stat objects.json: ${err.message}`);
      }
    }

    if (hasObjectsFile) {
      let raw;
      try {
        raw = await fsp.readFile(objectsFile, 'utf8');
      } catch (err) {
        fail('SOURCE_INVALID', `cannot read objects.json: ${err.message}`);
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
          fail('JSON_PARSE_ERROR', 'objects.json must contain a JSON array of object records');
        }
      } catch (err) {
        if (err instanceof HelperError) throw err;
        fail('JSON_PARSE_ERROR', `malformed objects.json: ${err.message}`);
      }

      const bucketObjects = [];
      const seenExactPaths = new Set();
      const seenNfcPaths = new Map();
      const seenCasePaths = new Map();

      for (const obj of parsed) {
        if (!obj || typeof obj !== 'object') {
          fail('INVALID_PATH', 'object entry must be an object');
        }
        if (!obj.bucket) {
          fail('INVALID_BUCKET', 'object entry in objects.json missing bucket field');
        }
        validateBucketName(obj.bucket);
        if (obj.bucket !== bucketId) continue;

        const objPath = validateObjectPath(obj.path || obj.name);
        if (seenExactPaths.has(objPath)) {
          fail('DUPLICATE_OBJECT', `duplicate object path in bucket ${bucketId}: ${objPath}`);
        }
        const nfcKey = objPath.normalize('NFC');
        if (seenNfcPaths.has(nfcKey)) {
          const orig = seenNfcPaths.get(nfcKey);
          fail('UNICODE_COLLISION', `Unicode normalization collision detected in bucket '${bucketId}': '${objPath}' collides with '${orig}' under NFC/NFD equivalence`);
        }
        const caseKey = nfcKey.toLowerCase();
        if (this.caseInsensitive && seenCasePaths.has(caseKey)) {
          const orig = seenCasePaths.get(caseKey);
          fail('PATH_COLLISION', `case-insensitive filesystem collision in bucket '${bucketId}': '${objPath}' collides with '${orig}' on case-insensitive filesystem`);
        }
        seenExactPaths.add(objPath);
        seenNfcPaths.set(nfcKey, objPath);
        seenCasePaths.set(caseKey, objPath);

        const fullPath = path.join(bucketDir, objPath);
        let fStat;
        try {
          fStat = await fsp.lstat(fullPath);
        } catch (err) {
          if (err && err.code === 'ENOENT') {
            fail('OBJECT_NOT_FOUND', `object declared in metadata does not exist on disk: ${fullPath}`);
          }
          fail('SOURCE_INVALID', `cannot inspect object file: ${err.message}`);
        }

        if (fStat.isSymbolicLink()) {
          fail('SYMLINK_DETECTED', `symlink detected in object path: ${fullPath}`);
        }
        if (!fStat.isFile()) {
          fail('UNSUPPORTED_FILE_TYPE', `object path is not a regular file: ${fullPath}`);
        }

        const expectedSize = typeof obj.size === 'number' ? obj.size : fStat.size;
        if (fStat.size !== expectedSize) {
          fail('IDENTITY_MISMATCH', `object size mismatch: metadata says ${expectedSize}, file is ${fStat.size}`);
        }

        const mime = obj.contentType || obj.mimeType || guessMimeType(objPath);

        bucketObjects.push({
          bucket: bucketId,
          path: objPath,
          sourcePath: fullPath,
          objectId: obj.objectId || obj.id || null,
          size: fStat.size,
          contentType: mime,
          mimeType: mime,
          etag: obj.etag || null,
          version: obj.version || null,
          expectedSha256: obj.sha256 || null,
          createdAt: obj.createdAt || obj.created_at || null,
          updatedAt: obj.updatedAt || obj.updated_at || null,
          lastAccessedAt: obj.lastAccessedAt || obj.last_accessed_at || null,
          metadata: obj.metadata || null,
        });
      }

      bucketObjects.sort((a, b) => a.path.localeCompare(b.path));
      return bucketObjects;
    }

    // Filesystem scan fallback
    let dirStat;
    try {
      dirStat = await fsp.lstat(bucketDir);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        // Empty bucket with no directory
        return [];
      }
      fail('SOURCE_INVALID', `cannot stat bucket directory: ${err.message}`);
    }

    if (dirStat.isSymbolicLink()) {
      fail('SYMLINK_DETECTED', `bucket directory must not be a symlink: ${bucketDir}`);
    }
    if (!dirStat.isDirectory()) {
      fail('SOURCE_INVALID', `bucket path is not a directory: ${bucketDir}`);
    }

    const objects = [];
    const seenExactPaths = new Set();
    const seenNfcPaths = new Map();
    const seenCasePaths = new Map();
    const isCaseInsensitive = this.caseInsensitive;

    async function walk(currentDir) {
      const entries = await fsp.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.DS_Store' || entry.name.startsWith('.tmp-') || entry.name.startsWith('.case-probe-')) continue;
        const fullPath = path.join(currentDir, entry.name);
        const stat = await fsp.lstat(fullPath);

        if (stat.isSymbolicLink()) {
          fail('SYMLINK_DETECTED', `symlink detected during directory scan: ${fullPath}`);
        }
        if (stat.isSocket() || stat.isFIFO() || stat.isCharacterDevice() || stat.isBlockDevice()) {
          fail('UNSUPPORTED_FILE_TYPE', `unsupported file type during directory scan: ${fullPath}`);
        }

        if (stat.isDirectory()) {
          await walk(fullPath);
        } else if (stat.isFile()) {
          const relPath = path.relative(bucketDir, fullPath);
          const normalizedPath = validateObjectPath(relPath);

          if (seenExactPaths.has(normalizedPath)) {
            fail('DUPLICATE_OBJECT', `duplicate object path in bucket ${bucketId}: ${normalizedPath}`);
          }
          const nfcKey = normalizedPath.normalize('NFC');
          if (seenNfcPaths.has(nfcKey)) {
            const orig = seenNfcPaths.get(nfcKey);
            fail('UNICODE_COLLISION', `Unicode normalization collision detected in bucket '${bucketId}': '${normalizedPath}' collides with '${orig}' under NFC/NFD equivalence`);
          }
          const caseKey = nfcKey.toLowerCase();
          if (isCaseInsensitive && seenCasePaths.has(caseKey)) {
            const orig = seenCasePaths.get(caseKey);
            fail('PATH_COLLISION', `case-insensitive filesystem collision in bucket '${bucketId}': '${normalizedPath}' collides with '${orig}' on case-insensitive filesystem`);
          }
          seenExactPaths.add(normalizedPath);
          seenNfcPaths.set(nfcKey, normalizedPath);
          seenCasePaths.set(caseKey, normalizedPath);

          const mime = guessMimeType(normalizedPath);
          objects.push({
            bucket: bucketId,
            path: normalizedPath,
            sourcePath: fullPath,
            objectId: null,
            size: stat.size,
            contentType: mime,
            mimeType: mime,
            etag: null,
            version: null,
            expectedSha256: null,
            createdAt: stat.birthtime?.toISOString() || null,
            updatedAt: stat.mtime?.toISOString() || null,
            lastAccessedAt: null,
            metadata: null,
          });
        }
      }
    }

    await walk(bucketDir);
    objects.sort((a, b) => a.path.localeCompare(b.path));
    return objects;
  }
}

// -----------------------------------------------------------------------------
// Supabase Live Storage Provider Adapter (FAIL-CLOSED)
// -----------------------------------------------------------------------------

export class SupabaseStorageAdapter {
  constructor() {
    fail(
      'PROVIDER_BLOCKED',
      'Live Supabase Storage provider adapter is BLOCKED: requires live environment clearance, write fence, and reviewed read-only credentials (not permitted in local synthetic phase)',
    );
  }
}

// -----------------------------------------------------------------------------
// Core Storage Export Procedure
// -----------------------------------------------------------------------------

export async function exportStorage(options = {}) {
  const {
    url,
    keyFile,
    adapter: requestedAdapter,
    sourceDir,
    syntheticDir,
    out: outDir,
    buckets: bucketsFilePath,
    manifest: manifestFilePath,
    bucket: filterBucketsArg,
    dryRun = false,
    chunkSize = DEFAULT_CHUNK_SIZE,
    concurrency = DEFAULT_CONCURRENCY,
  } = options;

  // 1. Adapter Boundary & Fail-Closed Live Provider Enforcement
  if (url || requestedAdapter === 'supabase' || requestedAdapter === 'live') {
    fail(
      'PROVIDER_BLOCKED',
      'Live Supabase Storage provider adapter is BLOCKED: requires live environment clearance, write fence, and reviewed read-only credentials (not permitted in local synthetic phase)',
    );
  }

  const effectiveSourceDir = sourceDir || syntheticDir;
  if (!effectiveSourceDir) {
    fail('USAGE', '--source-dir (or --synthetic-dir) is required for storage export in local synthetic phase');
  }

  if (chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
    fail('USAGE', `--chunk-size must be between ${MIN_CHUNK_SIZE} and ${MAX_CHUNK_SIZE} bytes`);
  }

  // Parse bucket filters
  let filterBuckets = null;
  if (filterBucketsArg) {
    if (Array.isArray(filterBucketsArg)) {
      filterBuckets = filterBucketsArg.flatMap((b) => b.split(',')).map((b) => b.trim()).filter(Boolean);
    } else if (typeof filterBucketsArg === 'string') {
      filterBuckets = filterBucketsArg.split(',').map((b) => b.trim()).filter(Boolean);
    }
  }

  // In non-dry-run mode, require out, buckets, manifest
  if (!dryRun) {
    if (!outDir) fail('USAGE', '--out is required');
    if (!bucketsFilePath) fail('USAGE', '--buckets is required');
    if (!manifestFilePath) fail('USAGE', '--manifest is required');
  }

  const startTime = Date.now();
  const resolvedOutDir = outDir ? path.resolve(outDir) : null;
  const resolvedBucketsPath = bucketsFilePath ? path.resolve(bucketsFilePath) : null;
  const resolvedManifestPath = manifestFilePath ? path.resolve(manifestFilePath) : null;

  if (resolvedBucketsPath && resolvedManifestPath && resolvedBucketsPath === resolvedManifestPath) {
    fail('USAGE', '--buckets and --manifest must be distinct paths');
  }
  if (resolvedOutDir && resolvedBucketsPath && (resolvedBucketsPath === resolvedOutDir || resolvedBucketsPath.startsWith(resolvedOutDir + path.sep))) {
    fail('USAGE', '--buckets path cannot be inside or equal to --out directory');
  }
  if (resolvedOutDir && resolvedManifestPath && (resolvedManifestPath === resolvedOutDir || resolvedManifestPath.startsWith(resolvedOutDir + path.sep))) {
    fail('USAGE', '--manifest path cannot be inside or equal to --out directory');
  }

  // 2. Refuse existing outputs (No-Overwrite Rule)
  if (!dryRun) {
    try {
      await fsp.access(resolvedOutDir);
      fail('OUTPUT_EXISTS', `output directory already exists: ${resolvedOutDir}`);
    } catch (err) {
      if (err instanceof HelperError) throw err;
      // ENOENT is expected
    }

    try {
      await fsp.access(resolvedBucketsPath);
      fail('OUTPUT_EXISTS', `output buckets file already exists: ${resolvedBucketsPath}`);
    } catch (err) {
      if (err instanceof HelperError) throw err;
    }

    try {
      await fsp.access(resolvedManifestPath);
      fail('OUTPUT_EXISTS', `output manifest file already exists: ${resolvedManifestPath}`);
    } catch (err) {
      if (err instanceof HelperError) throw err;
    }
  }

  // 3. Initialize Adapter & Inventory
  const adapter = new SyntheticStorageAdapter({ sourceDir: effectiveSourceDir });
  const buckets = await adapter.listBuckets(filterBuckets);

  const manifestEntries = [];
  const allObjectsToExport = [];
  let totalBytes = 0;

  for (const bucket of buckets) {
    const objects = await adapter.listObjects(bucket.id);
    for (const obj of objects) {
      totalBytes += obj.size;
      allObjectsToExport.push(obj);
    }
  }

  // 4. Dry-Run Mode
  if (dryRun) {
    // Perform dry-run byte hashing & verification in-memory without publishing files
    for (const obj of allObjectsToExport) {
      const { size, sha256 } = await streamObjectBytes({
        sourcePath: obj.sourcePath,
        destPath: null,
        expectedSize: obj.size,
        expectedSha256: obj.expectedSha256,
        chunkSize,
      });

      manifestEntries.push({
        bucket: obj.bucket,
        path: obj.path,
        objectId: obj.objectId,
        size,
        contentType: obj.contentType,
        mimeType: obj.mimeType,
        sha256,
        etag: obj.etag,
        version: obj.version,
        createdAt: obj.createdAt,
        updatedAt: obj.updatedAt,
        lastAccessedAt: obj.lastAccessedAt,
        metadata: obj.metadata,
      });
    }

    manifestEntries.sort((a, b) => {
      const cmp = a.bucket.localeCompare(b.bucket);
      return cmp !== 0 ? cmp : a.path.localeCompare(b.path);
    });

    return {
      status: 'ok',
      operation: 'storage-export',
      adapter: 'synthetic',
      dryRun: true,
      bucketCount: buckets.length,
      objectCount: manifestEntries.length,
      totalBytes,
      durationMs: Date.now() - startTime,
      buckets,
      manifest: manifestEntries,
      versioningSupported: false,
    };
  }

  // 5. Normal Export Mode: Setup Atomic Temporary Staging Structures
  const outParent = path.dirname(resolvedOutDir);
  await fsp.mkdir(outParent, { recursive: true, mode: 0o700 });

  const randomHex = crypto.randomBytes(8).toString('hex');
  const tempOutDir = path.join(outParent, `.${path.basename(resolvedOutDir)}.tmp-${randomHex}`);
  await fsp.mkdir(tempOutDir, { mode: 0o700 });
  await fsp.chmod(tempOutDir, 0o700);
  registerTempDir(tempOutDir);

  const bucketsParent = path.dirname(resolvedBucketsPath);
  await fsp.mkdir(bucketsParent, { recursive: true, mode: 0o700 });
  const tempBucketsFile = path.join(
    bucketsParent,
    `.${path.basename(resolvedBucketsPath)}.tmp-${randomHex}`,
  );
  registerTempFile(tempBucketsFile);

  const manifestParent = path.dirname(resolvedManifestPath);
  await fsp.mkdir(manifestParent, { recursive: true, mode: 0o700 });
  const tempManifestFile = path.join(
    manifestParent,
    `.${path.basename(resolvedManifestPath)}.tmp-${randomHex}`,
  );
  registerTempFile(tempManifestFile);

  const invocationJournal = [];
  activeRollbackJournals.add(invocationJournal);

  try {
    // Create bucket directories in staging tree
    for (const bucket of buckets) {
      const stagingBucketDir = path.join(tempOutDir, bucket.id);
      await fsp.mkdir(stagingBucketDir, { recursive: true, mode: 0o700 });
      await fsp.chmod(stagingBucketDir, 0o700);
    }

    // Export objects with bounded concurrency and streaming
    const limit = Math.max(1, Math.min(32, concurrency));
    let cursor = 0;

    async function worker() {
      while (cursor < allObjectsToExport.length) {
        const idx = cursor;
        cursor += 1;
        const obj = allObjectsToExport[idx];

        const destObjPath = path.join(tempOutDir, obj.bucket, obj.path);
        const destParentDir = path.dirname(destObjPath);
        await fsp.mkdir(destParentDir, { recursive: true, mode: 0o700 });
        // Ensure all parent directories up to tempOutDir are 0700
        let cur = destParentDir;
        while (cur !== tempOutDir && cur.startsWith(tempOutDir)) {
          await fsp.chmod(cur, 0o700);
          cur = path.dirname(cur);
        }

        const { size, sha256 } = await streamObjectBytes({
          sourcePath: obj.sourcePath,
          destPath: destObjPath,
          expectedSize: obj.size,
          expectedSha256: obj.expectedSha256,
          chunkSize,
        });

        manifestEntries[idx] = {
          bucket: obj.bucket,
          path: obj.path,
          objectId: obj.objectId,
          size,
          contentType: obj.contentType,
          mimeType: obj.mimeType,
          sha256,
          etag: obj.etag,
          version: obj.version,
          createdAt: obj.createdAt,
          updatedAt: obj.updatedAt,
          lastAccessedAt: obj.lastAccessedAt,
          metadata: obj.metadata,
        };
      }
    }

    const workers = [];
    for (let w = 0; w < limit; w += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);

    // Canonical sort for manifest entries: bucket ASC, path ASC
    manifestEntries.sort((a, b) => {
      const cmp = a.bucket.localeCompare(b.bucket);
      return cmp !== 0 ? cmp : a.path.localeCompare(b.path);
    });

    // Write buckets.json to temp
    const bucketsJsonContent = JSON.stringify(buckets, null, 2);
    await fsp.writeFile(tempBucketsFile, Buffer.from(bucketsJsonContent, 'utf8'), {
      mode: 0o600,
      flag: 'wx',
    });
    await fsp.chmod(tempBucketsFile, 0o600);

    // Write storage-manifest.json to temp
    const manifestJsonContent = JSON.stringify(manifestEntries, null, 2);
    await fsp.writeFile(tempManifestFile, Buffer.from(manifestJsonContent, 'utf8'), {
      mode: 0o600,
      flag: 'wx',
    });
    await fsp.chmod(tempManifestFile, 0o600);

    // 6. Atomic Publication (No-Overwrite Guarantee with Inode Verification and Rollback Protection)
    // Check destination paths before starting multi-output promotion
    try {
      await fsp.access(resolvedOutDir);
      fail('OUTPUT_EXISTS', `destination path already exists: ${resolvedOutDir}`);
    } catch (err) {
      if (err instanceof HelperError) throw err;
    }
    try {
      await fsp.access(resolvedBucketsPath);
      fail('OUTPUT_EXISTS', `destination path already exists: ${resolvedBucketsPath}`);
    } catch (err) {
      if (err instanceof HelperError) throw err;
    }
    try {
      await fsp.access(resolvedManifestPath);
      fail('OUTPUT_EXISTS', `destination path already exists: ${resolvedManifestPath}`);
    } catch (err) {
      if (err instanceof HelperError) throw err;
    }

    // Publish 1: bytes directory
    const outEntry = await publishDirectoryNoReplace(tempOutDir, resolvedOutDir);
    invocationJournal.push(outEntry);

    // Publish 2: buckets.json
    const bucketsEntry = await publishFileNoReplace(tempBucketsFile, resolvedBucketsPath);
    invocationJournal.push(bucketsEntry);

    // Publish 3: storage-manifest.json
    const manifestEntry = await publishFileNoReplace(tempManifestFile, resolvedManifestPath);
    invocationJournal.push(manifestEntry);

    // All three outputs verified and committed successfully!
    invocationJournal.length = 0;
    activeRollbackJournals.delete(invocationJournal);

    return {
      status: 'ok',
      operation: 'storage-export',
      adapter: 'synthetic',
      dryRun: false,
      bucketCount: buckets.length,
      objectCount: manifestEntries.length,
      totalBytes,
      durationMs: Date.now() - startTime,
      bucketsPath: resolvedBucketsPath,
      manifestPath: resolvedManifestPath,
      outDir: resolvedOutDir,
      filterBuckets,
      versioningSupported: false,
    };
  } catch (err) {
    await rollbackJournal(invocationJournal);
    activeRollbackJournals.delete(invocationJournal);
    cleanupAllTempsSync();
    throw err;
  }
}

// -----------------------------------------------------------------------------
// CLI Argument Parsing & Direct Invocation
// -----------------------------------------------------------------------------

function parseCliArgs(argv) {
  const options = {
    filterBuckets: [],
  };
  let command = 'export';
  let i = 0;

  if (argv.length > 0 && !argv[0].startsWith('-')) {
    command = argv[0];
    i = 1;
  }

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
      i += 1;
      continue;
    }

    let key;
    let val;

    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        key = arg.slice(2, eqIdx);
        val = arg.slice(eqIdx + 1);
        i += 1;
      } else {
        key = arg.slice(2);
        i += 1;
        if (i < argv.length && !argv[i].startsWith('--')) {
          val = argv[i];
          i += 1;
        } else {
          val = 'true';
        }
      }
    } else {
      fail('USAGE', `unexpected argument: ${arg}`);
    }

    switch (key) {
      case 'url':
        options.url = val;
        break;
      case 'key-file':
        options.keyFile = val;
        break;
      case 'adapter':
        options.adapter = val;
        break;
      case 'source-dir':
        options.sourceDir = val;
        break;
      case 'synthetic-dir':
        options.syntheticDir = val;
        break;
      case 'out':
        options.out = val;
        break;
      case 'buckets':
        options.buckets = val;
        break;
      case 'manifest':
        options.manifest = val;
        break;
      case 'bucket':
        options.filterBuckets.push(val);
        break;
      case 'concurrency':
        options.concurrency = parseInt(val, 10);
        if (Number.isNaN(options.concurrency) || options.concurrency < 1) {
          fail('USAGE', `--concurrency must be a positive integer, got ${val}`);
        }
        break;
      case 'chunk-size':
        options.chunkSize = parseInt(val, 10);
        if (Number.isNaN(options.chunkSize) || options.chunkSize < 1) {
          fail('USAGE', `--chunk-size must be a positive integer, got ${val}`);
        }
        break;
      default:
        fail('USAGE', `unknown option: --${key}`);
    }
  }

  if (options.filterBuckets.length > 0) {
    options.bucket = options.filterBuckets;
  }

  return { command, options };
}

function emitJson(obj, stream = process.stdout) {
  stream.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseCliArgs(argv);

  switch (command) {
    case 'export':
      return await exportStorage(options);
    case 'inventory':
      return await exportStorage({ ...options, dryRun: true });
    default:
      fail('USAGE', `unknown command: ${command}`);
  }
}

if (isDirectInvocation()) {
  installSignalHandlers();
  main().then(
    (res) => {
      emitJson(res, process.stdout);
      process.exit(0);
    },
    (err) => {
      cleanupAllTempsSync();
      const code = err instanceof HelperError ? err.code : 'UNKNOWN';
      emitJson(
        {
          status: 'error',
          operation: 'storage-export',
          error: {
            code,
            message: err.message,
          },
        },
        process.stderr,
      );
      process.exit(1);
    },
  );
}
