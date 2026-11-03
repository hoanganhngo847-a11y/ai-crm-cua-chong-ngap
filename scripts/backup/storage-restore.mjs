#!/usr/bin/env node
/**
 * scripts/backup/storage-restore.mjs
 *
 * Helper #5: Supabase Storage Restore & Validation (Local Rehearsal Phase)
 *
 * Authoritative References:
 * - docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12.md §B7, §B8, §B9, §B10, §R1, §R6, §9.5
 * - docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12_AMENDMENT_HELPER4.md
 *
 * Core Capabilities:
 * - Validates input bucket inventory, storage manifest, and extracted objects root
 * - Validates path safety, symlink rejection, file types, sizes, and SHA-256 checksums
 * - Detects duplicate paths, Unicode NFC/NFD collisions, and case-insensitive filesystem collisions
 * - Recreates all buckets from inventory preserving configuration (public, limits, MIME types)
 * - Restores empty buckets without skipping
 * - Fails closed on unsupported source bucket configurations (e.g. non-default versioning)
 * - Streams object bytes to Storage API with bounded chunk size (no buffering whole files in RAM)
 * - Enforces --no-upsert: refuses to overwrite existing destination objects
 * - URL-encodes each path segment for object upload
 * - Parses local.env privately, detects key format (legacy JWT vs sb_secret_...), never logs secrets
 * - Restricts restore target exclusively to local rehearsal (127.0.0.1 / localhost); blocks remote URLs
 * - Enforces strict endpoint/method allowlist; rejects redirects and unexpected HTTP methods
 * - Handles transient network/server errors with controlled exponential backoff retry
 * - Performs post-restore verification by independently downloading each object and hashing bytes
 * - Verifies bucket count, object count, sizes, and SHA-256 hashes against source manifest
 * - Generates structured atomic JSON report with detailed reconciliation and security evidence
 * - Catches termination signals (SIGINT, SIGTERM, SIGHUP) to clean up temporary files safely
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// -----------------------------------------------------------------------------
// Constants & Configuration
// -----------------------------------------------------------------------------

export const DEFAULT_CHUNK_SIZE = 64 * 1024; // 64 KiB
export const MIN_CHUNK_SIZE = 1024; // 1 KiB
export const MAX_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB
export const DEFAULT_CONCURRENCY = 4;
export const MAX_PATH_BYTES = 1024;
export const DEFAULT_TIMEOUT_MS = 30000; // 30s
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_PROJECT_REF = 'crm-restore-rehearsal';

const BUCKET_NAME_REGEX = /^[a-z0-9][a-z0-9_.-]{1,61}[a-z0-9]$/;

// -----------------------------------------------------------------------------
// Custom Error Class & Helper
// -----------------------------------------------------------------------------

export class HelperError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'HelperError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details = null) {
  throw new HelperError(code, message, details);
}

// -----------------------------------------------------------------------------
// Signal Handling & Temp File Lifecycle
// -----------------------------------------------------------------------------

const activeTempFiles = new Set();
const activeTempDirs = new Set();
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

export function cleanupAllTempsSync() {
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
// Filesystem & Platform Utilities
// -----------------------------------------------------------------------------

export async function fsyncDirectory(dirPath) {
  let handle;
  try {
    handle = await fsp.open(dirPath, fs.constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Best-effort directory sync
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export function createObjectPathCollisionGuard({ caseInsensitive = false } = {}) {
  const seenExact = new Set();
  const seenNfc = new Map();
  const seenLower = new Map();

  return function registerObjectPath(bucketId, objectPath) {
    const fullKey = `${bucketId}/${objectPath}`;

    if (seenExact.has(fullKey)) {
      fail('DUPLICATE_OBJECT', `duplicate object path declared in manifest: ${fullKey}`);
    }

    const normalizedPath = objectPath.normalize('NFC');
    const nfcKey = `${bucketId}/${normalizedPath}`;
    if (seenNfc.has(nfcKey)) {
      fail(
        'UNICODE_COLLISION',
        `Unicode normalization collision detected for object '${fullKey}' (collides with '${seenNfc.get(nfcKey)}')`,
      );
    }

    seenExact.add(fullKey);
    seenNfc.set(nfcKey, fullKey);

    if (caseInsensitive) {
      const lowerKey = `${bucketId}/${normalizedPath.toLowerCase()}`;
      if (seenLower.has(lowerKey)) {
        fail(
          'PATH_COLLISION',
          `case-insensitive path collision detected for object '${fullKey}' (collides with '${seenLower.get(lowerKey)}')`,
        );
      }
      seenLower.set(lowerKey, fullKey);
    }
  };
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

export async function publishFileAtomic(tempPath, destination) {
  try {
    await fsp.stat(tempPath);
  } catch (err) {
    fail('PUBLISH_FAILED', `cannot stat temporary file before publish: ${err.message}`);
  }

  const destParent = path.dirname(destination);
  await fsp.mkdir(destParent, { recursive: true, mode: 0o700 });

  let published = false;
  try {
    await fsp.rename(tempPath, destination);
    published = true;
  } catch (err) {
    // Cross-device fallback
    if (err && err.code === 'EXDEV') {
      const data = await fsp.readFile(tempPath);
      await fsp.writeFile(destination, data, { mode: 0o600 });
      await fsp.unlink(tempPath).catch(() => {});
      published = true;
    } else {
      fail('PUBLISH_FAILED', `atomic file publish failed: ${err.message}`);
    }
  }

  if (published) {
    unregisterTempFile(tempPath);
    await fsyncDirectory(destParent);
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

// -----------------------------------------------------------------------------
// Validation Utilities (Bucket, Path, MIME, Integrity)
// -----------------------------------------------------------------------------

export function validateBucketName(bucket) {
  if (typeof bucket !== 'string' || bucket.trim().length === 0) {
    fail('INVALID_BUCKET', 'bucket name must be a non-empty string');
  }
  if (bucket.includes('/') || bucket.includes('\\') || bucket.includes('..') || bucket.includes('\0')) {
    fail('PATH_TRAVERSAL', `bucket name contains invalid or traversal characters: ${bucket}`);
  }
  if (!BUCKET_NAME_REGEX.test(bucket)) {
    fail('INVALID_BUCKET', `bucket name '${bucket}' violates naming policy`);
  }
  return bucket;
}

// Supabase Storage normalizes bucket MIME restrictions before storing them.
// Keep the same parser here so restore-time parity compares semantic values,
// not incidental formatting (case, parameters, duplicate entries).
const MIME_TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const MIME_QUOTED_STRING = String.raw`"(?:[\t\x20\x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\t\x20-\x7e\x80-\xff])*"`;
const MIME_MEDIA_TYPE = new RegExp(String.raw`^[\t ]*(${MIME_TOKEN})/(${MIME_TOKEN})[\t ]*`);
const MIME_PARAMETER = new RegExp(
  String.raw`;[\t ]*(?:${MIME_TOKEN}=(?:${MIME_TOKEN}|${MIME_QUOTED_STRING})[\t ]*)?`,
  'y',
);

export function normalizeMimeTypeEntry(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1000) {
    return null;
  }

  const match = MIME_MEDIA_TYPE.exec(value);
  if (!match) {
    return null;
  }

  const type = match[1].toLowerCase();
  const subtype = match[2].toLowerCase();
  if (type.includes('*') || (subtype.includes('*') && subtype !== '*')) {
    return null;
  }

  let offset = match[0].length;
  while (offset < value.length) {
    MIME_PARAMETER.lastIndex = offset;
    if (!MIME_PARAMETER.test(value)) {
      return null;
    }
    offset = MIME_PARAMETER.lastIndex;
  }

  return `${type}/${subtype}`;
}

export function normalizeAllowedMimeTypes(
  mimeTypes,
  { code = 'INVALID_BUCKET', subject = 'allowed_mime_types' } = {},
) {
  const normalized = [];
  const seen = new Set();

  for (const entry of mimeTypes) {
    const parsed = normalizeMimeTypeEntry(entry);
    if (parsed === null) {
      fail(code, `${subject} contains invalid MIME type ${JSON.stringify(entry)}`);
    }
    if (!seen.has(parsed)) {
      seen.add(parsed);
      normalized.push(parsed);
    }
  }

  return normalized;
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

// -----------------------------------------------------------------------------
// Key Format Detection & Local Environment Parsing
// -----------------------------------------------------------------------------

export function detectKeyFormat(key) {
  if (typeof key !== 'string' || key.trim().length === 0) {
    fail('INVALID_KEY_FORMAT', 'key must be a non-empty string');
  }
  const trimmed = key.trim();

  // Format 1: Current Supabase secret key (sb_secret_...)
  if (trimmed.startsWith('sb_secret_')) {
    if (trimmed.length < 16) {
      fail('INVALID_KEY_FORMAT', 'sb_secret_ key is too short');
    }
    return {
      type: 'sb-secret',
      key: trimmed,
      authHeader: null, // Per spec: NEVER send Authorization: Bearer for sb_secret_
      apiKeyHeader: trimmed,
    };
  }

  // Format 2: Legacy JWT service_role key (3 base64url segments)
  const parts = trimmed.split('.');
  if (parts.length === 3) {
    try {
      const headerJson = Buffer.from(parts[0], 'base64url').toString('utf8');
      const header = JSON.parse(headerJson);
      if (header && typeof header === 'object') {
        return {
          type: 'legacy-jwt',
          key: trimmed,
          authHeader: `Bearer ${trimmed}`, // Per spec: send Authorization: Bearer for legacy JWT
          apiKeyHeader: trimmed,
        };
      }
    } catch {
      // Not a valid JWT JSON header
    }
  }

  fail(
    'INVALID_KEY_FORMAT',
    'unsupported key format: key must be either a legacy JWT service_role key or a current sb_secret_ key',
  );
}

export function parseLocalEnvContent(content) {
  if (typeof content !== 'string') {
    fail('SOURCE_INVALID', 'local.env content must be a string');
  }

  const lines = content.split('\n');
  const env = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const k = trimmed.slice(0, eqIdx).trim();
    let v = trimmed.slice(eqIdx + 1).trim();

    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[k] = v;
  }

  // Identify API URL
  const apiUrl = env.API_URL || env.SUPABASE_URL || null;

  // Identify candidate keys
  const candidateKeys = [];
  const keyNames = [
    'SERVICE_ROLE_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'LOCAL_SECRET_KEY',
    'SUPABASE_SECRET_KEY',
    'SECRET_KEY',
  ];

  for (const name of keyNames) {
    if (env[name] && typeof env[name] === 'string' && env[name].trim().length > 0) {
      candidateKeys.push({ name, value: env[name].trim() });
    }
  }

  if (candidateKeys.length === 0) {
    fail('KEY_NOT_FOUND', 'no supported service_role or secret key found in local.env');
  }

  // Verify all found keys match the same format and value (no multiple conflicting keys)
  const uniqueKeyValues = new Set(candidateKeys.map((c) => c.value));
  if (uniqueKeyValues.size > 1) {
    fail('MULTIPLE_KEYS_DETECTED', 'multiple conflicting secret keys found in local.env');
  }

  const chosenKey = candidateKeys[0].value;
  const keyInfo = detectKeyFormat(chosenKey);

  return {
    apiUrl,
    keyInfo,
    rawKeyCount: candidateKeys.length,
  };
}

export async function parseLocalEnvFile(filePath) {
  let stat;
  try {
    stat = await fsp.lstat(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      fail('SOURCE_NOT_FOUND', `local.env file not found: ${filePath}`);
    }
    fail('SOURCE_INVALID', `cannot stat local.env file: ${err.message}`);
  }

  if (stat.isSymbolicLink()) {
    fail('SYMLINK_DETECTED', `local.env must not be a symlink: ${filePath}`);
  }
  if (!stat.isFile()) {
    fail('UNSUPPORTED_FILE_TYPE', `local.env must be a regular file: ${filePath}`);
  }

  if ((stat.mode & 0o077) !== 0) {
    fail(
      'INSECURE_PERMISSIONS',
      `local.env has insecure permissions: mode 0${(stat.mode & 0o777).toString(8)} (group/other permissions must be 00)`,
    );
  }

  let content;
  try {
    content = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    fail('SOURCE_INVALID', `cannot read local.env file: ${err.message}`);
  }

  return parseLocalEnvContent(content);
}

// -----------------------------------------------------------------------------
// Target URL Safety & Allowlist Validation
// -----------------------------------------------------------------------------

export function validateTargetUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    fail('USAGE', 'target URL is required');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    fail('INVALID_TARGET', `invalid target URL: ${err.message}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail('INVALID_TARGET', `unsupported protocol in target URL: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLoopback =
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]';

  if (!isLoopback) {
    fail(
      'REMOTE_TARGET_BLOCKED',
      `remote target blocked: '${hostname}'. Only local rehearsal stack (127.0.0.1 / localhost) is permitted.`,
    );
  }

  return parsed.origin;
}

export function validateEndpointAndMethod(method, pathname) {
  const m = method.toUpperCase();
  const p = pathname.replace(/\/+/g, '/');

  // Strict Endpoint/Method Allowlist:
  // 1. GET /storage/v1/bucket
  if (m === 'GET' && p === '/storage/v1/bucket') return true;
  // 2. GET /storage/v1/bucket/:bucketId
  if (m === 'GET' && /^\/storage\/v1\/bucket\/[a-z0-9_.-]+$/.test(p)) return true;
  // 3. POST /storage/v1/bucket
  if (m === 'POST' && p === '/storage/v1/bucket') return true;
  // 4. POST /storage/v1/object/:bucket/...
  if (m === 'POST' && /^\/storage\/v1\/object\/[a-z0-9_.-]+\/.+$/.test(p)) return true;
  // 5. GET /storage/v1/object/:bucket/...
  if (m === 'GET' && /^\/storage\/v1\/object\/[a-z0-9_.-]+\/.+$/.test(p)) return true;
  // 6. GET /storage/v1/object/authenticated/:bucket/...
  if (m === 'GET' && /^\/storage\/v1\/object\/authenticated\/[a-z0-9_.-]+\/.+$/.test(p)) return true;
  // 7. GET /storage/v1/object/public/:bucket/...
  if (m === 'GET' && /^\/storage\/v1\/object\/public\/[a-z0-9_.-]+\/.+$/.test(p)) return true;
  // 8. POST /storage/v1/object/list/:bucket
  if (m === 'POST' && /^\/storage\/v1\/object\/list\/[a-z0-9_.-]+$/.test(p)) return true;

  fail('UNAPPROVED_ENDPOINT', `request ${m} ${p} is not in the endpoint/method allowlist`);
}

// -----------------------------------------------------------------------------
// Storage REST API Client
// -----------------------------------------------------------------------------

export class StorageRestoreClient {
  constructor({
    baseUrl,
    keyInfo,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
  }) {
    this.baseUrl = validateTargetUrl(baseUrl);
    this.keyInfo = keyInfo;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.totalRetries = 0;
  }

  isTransientError(err, statusCode) {
    if (statusCode === 429 || (statusCode >= 500 && statusCode <= 504)) {
      return true;
    }
    if (err && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT')) {
      return true;
    }
    return false;
  }

  async request({
    method,
    pathname,
    headers = {},
    bodyStream = null,
    createBodyStream = null,
    bodyBuffer = null,
    downloadHasher = null,
  }) {
    validateEndpointAndMethod(method, pathname);

    const fullUrl = new URL(pathname, this.baseUrl);
    const transport = fullUrl.protocol === 'https:' ? https : http;

    const baseHeaders = {
      apikey: this.keyInfo.apiKeyHeader,
      ...headers,
    };
    if (this.keyInfo.authHeader) {
      baseHeaders.Authorization = this.keyInfo.authHeader;
    }

    let attempt = 0;
    while (attempt <= this.maxRetries) {
      try {
        return await new Promise((resolve, reject) => {
          let reqStream = null;
          if (createBodyStream) {
            reqStream = createBodyStream();
          } else if (bodyStream && attempt === 0) {
            reqStream = bodyStream;
          }

          const reqOptions = {
            method: method.toUpperCase(),
            hostname: fullUrl.hostname,
            port: fullUrl.port || (fullUrl.protocol === 'https:' ? 443 : 80),
            path: fullUrl.pathname + fullUrl.search,
            headers: baseHeaders,
            timeout: this.timeoutMs,
          };

          const req = transport.request(reqOptions, (res) => {
            const statusCode = res.statusCode || 0;

            // Reject redirects strictly
            if (statusCode >= 300 && statusCode < 400) {
              res.resume();
              if (reqStream && typeof reqStream.destroy === 'function') reqStream.destroy();
              return reject(
                new HelperError(
                  'REDIRECT_REJECTED',
                  `HTTP redirect ${statusCode} to '${res.headers.location || 'unknown'}' rejected by security policy`,
                ),
              );
            }

            // Stream response if download hasher provided
            if (downloadHasher && statusCode >= 200 && statusCode < 300) {
              let bytesReceived = 0;
              res.on('data', (chunk) => {
                bytesReceived += chunk.length;
                downloadHasher.update(chunk);
              });
              res.on('end', () => {
                resolve({
                  statusCode,
                  headers: res.headers,
                  bytesReceived,
                });
              });
              res.on('error', (err) => {
                reject(err);
              });
              return;
            }

            // Standard response buffering for API JSON responses
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
              const resBody = Buffer.concat(chunks).toString('utf8');
              let parsedBody = null;
              if (resBody.trim().length > 0) {
                try {
                  parsedBody = JSON.parse(resBody);
                } catch {
                  parsedBody = resBody;
                }
              }

              if (statusCode >= 200 && statusCode < 300) {
                resolve({
                  statusCode,
                  headers: res.headers,
                  body: parsedBody,
                });
              } else {
                const errMsg =
                  parsedBody && typeof parsedBody === 'object' && parsedBody.message
                    ? parsedBody.message
                    : resBody || `HTTP ${statusCode}`;
                const err = new HelperError('API_ERROR', `Storage API error (${statusCode}): ${errMsg}`, {
                  statusCode,
                  body: parsedBody,
                });
                err.statusCode = statusCode;
                err.attempt = attempt;
                reject(err);
              }
            });
            res.on('error', (err) => {
              err.attempt = attempt;
              reject(err);
            });
          });

          req.on('timeout', () => {
            if (reqStream && typeof reqStream.destroy === 'function') reqStream.destroy();
            const err = new HelperError('API_TIMEOUT', `request timed out after ${this.timeoutMs}ms`);
            err.attempt = attempt;
            req.destroy(err);
          });

          req.on('error', (err) => {
            if (reqStream && typeof reqStream.destroy === 'function') reqStream.destroy();
            err.attempt = attempt;
            reject(err);
          });

          if (reqStream) {
            reqStream.pipe(req);
            reqStream.on('error', (streamErr) => {
              streamErr.attempt = attempt;
              req.destroy(streamErr);
            });
          } else if (bodyBuffer) {
            req.end(bodyBuffer);
          } else {
            req.end();
          }
        });
      } catch (err) {
        if (typeof err.attempt !== 'number') err.attempt = attempt;
        attempt += 1;
        const statusCode = err && err.statusCode ? err.statusCode : 0;
        if (attempt <= this.maxRetries && this.isTransientError(err, statusCode)) {
          this.totalRetries += 1;
          const backoffDelay = Math.min(1000, 50 * Math.pow(2, attempt - 1));
          await new Promise((r) => setTimeout(r, backoffDelay));
          continue;
        }
        throw err;
      }
    }
  }

  // --- Bucket Operations ---

  async getBucket(bucketId) {
    try {
      const res = await this.request({
        method: 'GET',
        pathname: `/storage/v1/bucket/${encodeURIComponent(bucketId)}`,
      });
      return res.body;
    } catch (err) {
      if (err && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async listBuckets() {
    const res = await this.request({
      method: 'GET',
      pathname: '/storage/v1/bucket',
    });
    return Array.isArray(res.body) ? res.body : [];
  }

  async createBucket(bucketConfig) {
    const payload = JSON.stringify({
      id: bucketConfig.id,
      name: bucketConfig.name || bucketConfig.id,
      public: bucketConfig.public,
      file_size_limit: bucketConfig.file_size_limit,
      allowed_mime_types: bucketConfig.allowed_mime_types,
    });

    const res = await this.request({
      method: 'POST',
      pathname: '/storage/v1/bucket',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload, 'utf8'),
      },
      bodyBuffer: Buffer.from(payload, 'utf8'),
    });
    return res.body;
  }

  // --- Object Operations ---

  encodeObjectUrlPath(bucketId, objectPath) {
    const encodedBucket = encodeURIComponent(bucketId);
    const encodedSegments = objectPath.split('/').map(encodeURIComponent).join('/');
    return `/storage/v1/object/${encodedBucket}/${encodedSegments}`;
  }

  encodeAuthenticatedObjectUrlPath(bucketId, objectPath) {
    const encodedBucket = encodeURIComponent(bucketId);
    const encodedSegments = objectPath.split('/').map(encodeURIComponent).join('/');
    return `/storage/v1/object/authenticated/${encodedBucket}/${encodedSegments}`;
  }

  async uploadObject({
    bucketId,
    objectPath,
    filePath,
    contentType,
    fileSize,
    expectedSha256 = null,
    noUpsert = true,
  }) {
    const urlPath = this.encodeObjectUrlPath(bucketId, objectPath);

    const headers = {
      'Content-Type': contentType || 'application/octet-stream',
      'Content-Length': fileSize,
    };

    if (noUpsert) {
      headers['x-upsert'] = 'false';
    }

    try {
      const res = await this.request({
        method: 'POST',
        pathname: urlPath,
        headers,
        createBodyStream: () => fs.createReadStream(filePath, { highWaterMark: DEFAULT_CHUNK_SIZE }),
      });
      return res.body;
    } catch (err) {
      if (err && (err.statusCode === 400 || err.statusCode === 409)) {
        const msg = String(err.message || '').toLowerCase();
        if (msg.includes('already exists') || msg.includes('duplicate')) {
          // If this was a retry (attempt > 0), the previous request might have succeeded on server
          // before the connection dropped (lost ACK). Verify if destination matches expected content.
          if (err.attempt > 0 && expectedSha256) {
            try {
              const check = await this.downloadAndHashObject({ bucketId, objectPath });
              if (check.bytesReceived === fileSize && check.sha256.toLowerCase() === expectedSha256.toLowerCase()) {
                return {
                  Key: `${bucketId}/${objectPath}`,
                  Id: null,
                  idempotentRecovered: true,
                };
              }
            } catch {
              // Re-verification failed, proceed to fail closed
            }
          }

          fail(
            'DESTINATION_OBJECT_EXISTS',
            `destination object already exists in bucket '${bucketId}': '${objectPath}' (refusing overwrite per --no-upsert)`,
          );
        }
      }
      throw err;
    }
  }

  async downloadAndHashObject({ bucketId, objectPath }) {
    const hasher = crypto.createHash('sha256');
    const authPath = this.encodeAuthenticatedObjectUrlPath(bucketId, objectPath);

    try {
      const res = await this.request({
        method: 'GET',
        pathname: authPath,
        downloadHasher: hasher,
      });
      return {
        bytesReceived: res.bytesReceived,
        sha256: hasher.digest('hex'),
      };
    } catch (err) {
      // Fallback to /storage/v1/object/:bucket/:path if authenticated route returned 404
      if (err && err.statusCode === 404) {
        const stdPath = this.encodeObjectUrlPath(bucketId, objectPath);
        const fallbackHasher = crypto.createHash('sha256');
        const res2 = await this.request({
          method: 'GET',
          pathname: stdPath,
          downloadHasher: fallbackHasher,
        });
        return {
          bytesReceived: res2.bytesReceived,
          sha256: fallbackHasher.digest('hex'),
        };
      }
      throw err;
    }
  }

  async listObjectsInBucket(bucketId, limit = 1000) {
    const allObjects = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const payload = JSON.stringify({
        prefix: '',
        limit,
        offset,
        sortBy: {
          column: 'name',
          order: 'asc',
        },
      });

      const res = await this.request({
        method: 'POST',
        pathname: `/storage/v1/object/list/${encodeURIComponent(bucketId)}`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload, 'utf8'),
        },
        bodyBuffer: Buffer.from(payload, 'utf8'),
      });

      const batch = Array.isArray(res.body) ? res.body : [];
      for (const item of batch) {
        allObjects.push(item);
      }

      if (batch.length < limit) {
        hasMore = false;
      } else {
        offset += batch.length;
      }
    }

    return allObjects;
  }
}

// -----------------------------------------------------------------------------
// Strict JSON Parser (Detects Duplicate Object Keys)
// -----------------------------------------------------------------------------

export function parseJsonStrict(text, code = 'JSON_PARSE_ERROR', label = 'JSON') {
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
    if (depth > 64) invalid('exceeds maximum JSON nesting depth');
    skipWhitespace();
    if (index >= length) invalid('unexpected end of JSON input');
    const char = text[index];
    if (char === '"') return parseString();
    if (char === '{') return parseObject(depth);
    if (char === '[') return parseArray(depth);
    if (char === 't') return expectLiteral('true', true);
    if (char === 'f') return expectLiteral('false', false);
    if (char === 'n') return expectLiteral('null', null);
    if (char === '-' || (char >= '0' && char <= '9')) return parseNumber();
    invalid(`unexpected character in JSON: '${char}'`);
  };

  const value = parseValue(0);
  skipWhitespace();
  if (index < length) invalid('contains trailing data after JSON value');
  return value;
}

// -----------------------------------------------------------------------------
// Pre-Restore Input Validation Engine
// -----------------------------------------------------------------------------

export async function validateRestoreInputs({
  bucketsPath,
  manifestPath,
  objectsRoot,
  _localEnvPath = null,
  _keyFile = null,
  filesystemCaseInsensitive = null,
}) {
  // 1. Verify and parse buckets.json
  let bStat;
  try {
    bStat = await fsp.lstat(bucketsPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      fail('SOURCE_NOT_FOUND', `buckets inventory file not found: ${bucketsPath}`);
    }
    fail('SOURCE_INVALID', `cannot stat buckets file: ${err.message}`);
  }
  if (bStat.isSymbolicLink()) {
    fail('SYMLINK_DETECTED', `buckets file must not be a symlink: ${bucketsPath}`);
  }
  if (!bStat.isFile()) {
    fail('UNSUPPORTED_FILE_TYPE', `buckets file must be a regular file: ${bucketsPath}`);
  }

  let rawBuckets;
  try {
    rawBuckets = await fsp.readFile(bucketsPath, 'utf8');
  } catch (err) {
    fail('SOURCE_INVALID', `cannot read buckets file: ${err.message}`);
  }

  let buckets;
  try {
    buckets = parseJsonStrict(rawBuckets, 'DUPLICATE_JSON_KEY', 'buckets.json');
    if (!Array.isArray(buckets)) {
      fail('JSON_PARSE_ERROR', 'buckets.json must contain a JSON array of bucket objects');
    }
  } catch (err) {
    if (err instanceof HelperError) throw err;
    fail('JSON_PARSE_ERROR', `malformed buckets.json: ${err.message}`);
  }

  const validatedBuckets = [];
  const seenBucketIds = new Set();
  const seenBucketNfc = new Map();

  for (const b of buckets) {
    if (!b || typeof b !== 'object') {
      fail('INVALID_BUCKET', 'bucket entry must be an object');
    }
    const bId = validateBucketName(b.id || b.name);
    if (seenBucketIds.has(bId)) {
      fail('DUPLICATE_BUCKET', `duplicate bucket declared in inventory: ${bId}`);
    }
    const nfc = bId.normalize('NFC');
    if (seenBucketNfc.has(nfc)) {
      fail(
        'UNICODE_COLLISION',
        `Unicode normalization collision detected for bucket '${bId}' (collides with '${seenBucketNfc.get(nfc)}')`,
      );
    }
    seenBucketIds.add(bId);
    seenBucketNfc.set(nfc, bId);

    // Fail closed on unsupported source bucket configurations
    if (b.type && b.type !== 'standard') {
      fail('UNSUPPORTED_BUCKET_CONFIG', `unsupported bucket type '${b.type}' for bucket '${bId}'`);
    }
    if (b.versioning_status && b.versioning_status !== 'disabled') {
      fail(
        'UNSUPPORTED_BUCKET_CONFIG',
        `unsupported bucket versioning_status '${b.versioning_status}' for bucket '${bId}' (API cannot represent versions)`,
      );
    }

    // A. Strict public validation (P2-BUCKET-05)
    let bucketPublic = false;
    if (b.public === undefined) {
      bucketPublic = false;
    } else if (typeof b.public === 'boolean') {
      bucketPublic = b.public;
    } else {
      fail(
        'INVALID_BUCKET',
        `bucket '${bId}' public attribute must be a boolean, got ${b.public === null ? 'null' : typeof b.public}`,
      );
    }

    // B. Strict file_size_limit validation (P2-BUCKET-05)
    let bucketFileSizeLimit = null;
    if (b.file_size_limit === undefined || b.file_size_limit === null) {
      bucketFileSizeLimit = null;
    } else if (
      typeof b.file_size_limit === 'number' &&
      Number.isSafeInteger(b.file_size_limit) &&
      b.file_size_limit >= 0
    ) {
      bucketFileSizeLimit = b.file_size_limit;
    } else {
      fail(
        'INVALID_BUCKET',
        `bucket '${bId}' file_size_limit must be a non-negative integer or null, got ${b.file_size_limit === null ? 'null' : typeof b.file_size_limit}`,
      );
    }

    // C. Strict allowed_mime_types validation (P2-BUCKET-05)
    let bucketAllowedMimes = null;
    if (b.allowed_mime_types === undefined || b.allowed_mime_types === null) {
      bucketAllowedMimes = null;
    } else if (Array.isArray(b.allowed_mime_types)) {
      bucketAllowedMimes = normalizeAllowedMimeTypes(b.allowed_mime_types, {
        code: 'INVALID_BUCKET',
        subject: `bucket '${bId}' allowed_mime_types`,
      });
    } else {
      fail(
        'INVALID_BUCKET',
        `bucket '${bId}' allowed_mime_types must be an array of strings or null, got ${typeof b.allowed_mime_types}`,
      );
    }

    let bucketName = bId;
    if (b.name !== undefined && b.name !== null) {
      if (typeof b.name !== 'string' || b.name.trim().length === 0 || b.name.length >= 101) {
        fail('INVALID_BUCKET', `bucket '${bId}' name must be a non-empty string shorter than 101 characters`);
      }
      bucketName = b.name;
    }

    validatedBuckets.push({
      id: bId,
      name: bucketName,
      public: bucketPublic,
      file_size_limit: bucketFileSizeLimit,
      allowed_mime_types: bucketAllowedMimes,
      type: b.type || 'standard',
      versioning_status: b.versioning_status || 'disabled',
    });
  }

  // 2. Verify and parse storage-manifest.json
  let mStat;
  try {
    mStat = await fsp.lstat(manifestPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      fail('SOURCE_NOT_FOUND', `storage manifest file not found: ${manifestPath}`);
    }
    fail('SOURCE_INVALID', `cannot stat storage manifest file: ${err.message}`);
  }
  if (mStat.isSymbolicLink()) {
    fail('SYMLINK_DETECTED', `storage manifest file must not be a symlink: ${manifestPath}`);
  }
  if (!mStat.isFile()) {
    fail('UNSUPPORTED_FILE_TYPE', `storage manifest file must be a regular file: ${manifestPath}`);
  }

  let rawManifest;
  try {
    rawManifest = await fsp.readFile(manifestPath, 'utf8');
  } catch (err) {
    fail('SOURCE_INVALID', `cannot read storage manifest file: ${err.message}`);
  }

  let manifest;
  try {
    manifest = parseJsonStrict(rawManifest, 'DUPLICATE_JSON_KEY', 'storage-manifest.json');
    if (!Array.isArray(manifest)) {
      fail('JSON_PARSE_ERROR', 'storage-manifest.json must contain a JSON array of object entries');
    }
  } catch (err) {
    if (err instanceof HelperError) throw err;
    fail('JSON_PARSE_ERROR', `malformed storage-manifest.json: ${err.message}`);
  }

  // null = probe the real destination filesystem. An explicit boolean is an
  // override for deterministic tests / callers that already know the target
  // filesystem semantics.
  const caseInsensitive = filesystemCaseInsensitive === null
    ? await isCaseInsensitiveDir(objectsRoot)
    : Boolean(filesystemCaseInsensitive);
  const registerObjectPath = createObjectPathCollisionGuard({ caseInsensitive });
  const validatedObjects = [];
  const seenObjectKeys = new Set();
  const objectsByBucket = new Map();

  for (const b of validatedBuckets) {
    objectsByBucket.set(b.id, []);
  }

  for (const obj of manifest) {
    if (!obj || typeof obj !== 'object') {
      fail('INVALID_PATH', 'object manifest entry must be an object');
    }
    if (!obj.bucket) {
      fail('INVALID_BUCKET', 'manifest object entry missing bucket');
    }
    const bId = validateBucketName(obj.bucket);
    if (!seenBucketIds.has(bId)) {
      fail('UNAUTHORIZED_BUCKET', `manifest references bucket '${bId}' which is not declared in buckets inventory`);
    }

    const objPath = validateObjectPath(obj.path || obj.name);
    const fullKey = `${bId}/${objPath}`;

    registerObjectPath(bId, objPath);
    seenObjectKeys.add(fullKey);

    if (typeof obj.size !== 'number' || obj.size < 0) {
      fail('IDENTITY_MISMATCH', `invalid size in manifest for object '${fullKey}': ${obj.size}`);
    }

    if (!obj.sha256 || typeof obj.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(obj.sha256)) {
      fail('IDENTITY_MISMATCH', `invalid sha256 checksum in manifest for object '${fullKey}'`);
    }

    const item = {
      bucket: bId,
      path: objPath,
      size: obj.size,
      sha256: obj.sha256.toLowerCase(),
      contentType: obj.contentType || obj.mimeType || 'application/octet-stream',
      objectId: obj.objectId || obj.id || null,
      version: obj.version || null,
    };

    validatedObjects.push(item);
    objectsByBucket.get(bId).push(item);
  }

  // 3. Verify extracted objects root on disk
  let rStat;
  try {
    rStat = await fsp.lstat(objectsRoot);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      fail('SOURCE_NOT_FOUND', `objects root directory not found: ${objectsRoot}`);
    }
    fail('SOURCE_INVALID', `cannot stat objects root directory: ${err.message}`);
  }
  if (rStat.isSymbolicLink()) {
    fail('SYMLINK_DETECTED', `objects root directory must not be a symlink: ${objectsRoot}`);
  }
  if (!rStat.isDirectory()) {
    fail('SOURCE_INVALID', `objects root is not a directory: ${objectsRoot}`);
  }

  // Pre-check: verify every manifest object exists on disk with exact size and SHA-256
  for (const obj of validatedObjects) {
    const fullDiskPath = path.join(objectsRoot, obj.bucket, obj.path);
    let fStat;
    try {
      fStat = await fsp.lstat(fullDiskPath);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        fail('OBJECT_NOT_FOUND', `object declared in manifest does not exist on disk: ${fullDiskPath}`);
      }
      fail('SOURCE_INVALID', `cannot stat object file: ${err.message}`);
    }

    if (fStat.isSymbolicLink()) {
      fail('SYMLINK_DETECTED', `symlink detected in object path: ${fullDiskPath}`);
    }
    if (!fStat.isFile()) {
      fail('UNSUPPORTED_FILE_TYPE', `object path is not a regular file: ${fullDiskPath}`);
    }
    if (fStat.size !== obj.size) {
      fail('SIZE_MISMATCH', `size mismatch for '${obj.bucket}/${obj.path}': manifest=${obj.size}, disk=${fStat.size}`);
    }

    // Hash check from disk stream
    const hasher = crypto.createHash('sha256');
    const readStream = fs.createReadStream(fullDiskPath, { highWaterMark: DEFAULT_CHUNK_SIZE });
    await new Promise((resolve, reject) => {
      readStream.on('data', (c) => hasher.update(c));
      readStream.on('end', resolve);
      readStream.on('error', reject);
    });
    const diskSha256 = hasher.digest('hex');
    if (diskSha256.toLowerCase() !== obj.sha256.toLowerCase()) {
      fail(
        'HASH_MISMATCH',
        `SHA-256 mismatch for '${obj.bucket}/${obj.path}': manifest=${obj.sha256}, disk=${diskSha256}`,
      );
    }

    obj.diskPath = fullDiskPath;
  }

  // Verify no unexpected objects or unauthorized directories exist on disk
  const authorizedBucketDirs = new Set(validatedBuckets.map((b) => path.join(objectsRoot, b.id)));
  const authorizedParentDirs = new Set();
  for (const obj of validatedObjects) {
    let cur = path.dirname(obj.diskPath);
    while (cur.length >= objectsRoot.length && cur !== objectsRoot) {
      authorizedParentDirs.add(cur);
      cur = path.dirname(cur);
    }
  }

  async function scanDirectory(currentDir) {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue;
      const fullPath = path.join(currentDir, entry.name);
      const stat = await fsp.lstat(fullPath);

      if (stat.isSymbolicLink()) {
        fail('SYMLINK_DETECTED', `symlink detected during directory scan: ${fullPath}`);
      }
      if (stat.isSocket() || stat.isFIFO() || stat.isCharacterDevice() || stat.isBlockDevice()) {
        fail('UNSUPPORTED_FILE_TYPE', `unsupported file type during directory scan: ${fullPath}`);
      }

      if (stat.isDirectory()) {
        const isBucketTop = currentDir === objectsRoot;
        if (isBucketTop && !authorizedBucketDirs.has(fullPath)) {
          fail('UNEXPECTED_DIRECTORY', `unauthorized directory in objects root: ${fullPath}`);
        } else if (!isBucketTop && !authorizedParentDirs.has(fullPath)) {
          fail('UNEXPECTED_DIRECTORY', `unexpected directory not belonging to manifest: ${fullPath}`);
        }
        await scanDirectory(fullPath);
      } else if (stat.isFile()) {
        const relToRoot = path.relative(objectsRoot, fullPath);
        const parts = relToRoot.split(path.sep);
        const b = parts[0];
        const oPath = parts.slice(1).join('/');
        const key = `${b}/${oPath}`;
        if (!seenObjectKeys.has(key)) {
          fail('UNEXPECTED_OBJECT', `unexpected file on disk not declared in manifest: ${fullPath}`);
        }
      }
    }
  }

  await scanDirectory(objectsRoot);

  return {
    buckets: validatedBuckets,
    objects: validatedObjects,
    objectsByBucket,
  };
}

// -----------------------------------------------------------------------------
// Target Bucket Configuration Verification (R5-01, P2-BUCKET-01, P2-BUCKET-05)
// -----------------------------------------------------------------------------

export function verifyTargetBucketParity(existing, bucket) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    fail(
      'BUCKET_CONFIGURATION_MISMATCH',
      `target bucket '${bucket.id}' returned missing or non-object metadata`,
    );
  }

  const hasOwn = (field) => Object.prototype.hasOwnProperty.call(existing, field);

  // 1. Verify id
  if (typeof existing.id !== 'string' || existing.id !== bucket.id) {
    fail(
      'BUCKET_CONFIGURATION_MISMATCH',
      `target bucket '${bucket.id}' id '${existing.id}' does not match source backup '${bucket.id}'`,
    );
  }

  // 2. Verify name
  if (typeof existing.name !== 'string' || existing.name !== bucket.name) {
    fail(
      'BUCKET_CONFIGURATION_MISMATCH',
      `target bucket '${bucket.id}' name '${existing.name}' does not match source backup '${bucket.name}'`,
    );
  }

  // 3. Verify public (Storage API always returns a boolean)
  if (typeof existing.public !== 'boolean') {
    fail(
      'BUCKET_CONFIGURATION_MISMATCH',
      `target bucket '${bucket.id}' returned non-boolean public setting: ${JSON.stringify(existing.public)}`,
    );
  }
  if (existing.public !== bucket.public) {
    fail(
      'BUCKET_CONFIGURATION_MISMATCH',
      `target bucket '${bucket.id}' public setting (${existing.public}) does not match source backup (${bucket.public})`,
    );
  }

  // 4. Verify file_size_limit. A missing field is incomplete metadata, not
  // "unlimited"; only an explicit JSON null represents the unrestricted value.
  if (!hasOwn('file_size_limit')) {
    fail(
      'BUCKET_CONFIGURATION_MISMATCH',
      `target bucket '${bucket.id}' returned incomplete metadata: missing required field 'file_size_limit'`,
    );
  }
  if (
    existing.file_size_limit !== null &&
    (typeof existing.file_size_limit !== 'number' ||
      !Number.isSafeInteger(existing.file_size_limit) ||
      existing.file_size_limit < 0)
  ) {
    fail(
      'BUCKET_CONFIGURATION_MISMATCH',
      `target bucket '${bucket.id}' returned invalid file_size_limit: ${JSON.stringify(existing.file_size_limit)}`,
    );
  }
  const sourceFileSizeLimit = bucket.file_size_limit ?? null;
  const targetFileSizeLimit = existing.file_size_limit;
  if (targetFileSizeLimit !== sourceFileSizeLimit) {
    fail(
      'BUCKET_CONFIGURATION_MISMATCH',
      `target bucket '${bucket.id}' file_size_limit (${targetFileSizeLimit}) does not match source backup (${sourceFileSizeLimit})`,
    );
  }

  // 5. Verify allowed_mime_types. The field is required, but null and [] are
  // distinct semantic values: null means no restriction, [] is an empty set.
  if (!hasOwn('allowed_mime_types')) {
    fail(
      'BUCKET_CONFIGURATION_MISMATCH',
      `target bucket '${bucket.id}' returned incomplete metadata: missing required field 'allowed_mime_types'`,
    );
  }
  let targetMimeTypes = null;
  if (existing.allowed_mime_types !== null) {
    if (!Array.isArray(existing.allowed_mime_types)) {
      fail(
        'BUCKET_CONFIGURATION_MISMATCH',
        `target bucket '${bucket.id}' returned non-array allowed_mime_types: ${JSON.stringify(existing.allowed_mime_types)}`,
      );
    }
    targetMimeTypes = normalizeAllowedMimeTypes(existing.allowed_mime_types, {
      code: 'BUCKET_CONFIGURATION_MISMATCH',
      subject: `target bucket '${bucket.id}' allowed_mime_types`,
    });
  }
  const sourceMimeTypes =
    bucket.allowed_mime_types === null
      ? null
      : normalizeAllowedMimeTypes(bucket.allowed_mime_types, {
          code: 'BUCKET_CONFIGURATION_MISMATCH',
          subject: `source bucket '${bucket.id}' allowed_mime_types`,
        });
  const canonical = (value) => (value === null ? null : [...value].sort());
  const canonicalSourceMimes = canonical(sourceMimeTypes);
  const canonicalTargetMimes = canonical(targetMimeTypes);
  if (JSON.stringify(canonicalTargetMimes) !== JSON.stringify(canonicalSourceMimes)) {
    fail(
      'BUCKET_CONFIGURATION_MISMATCH',
      `target bucket '${bucket.id}' allowed_mime_types ${JSON.stringify(canonicalTargetMimes)} do not match source backup ${JSON.stringify(canonicalSourceMimes)}`,
    );
  }
}

// -----------------------------------------------------------------------------
// Core Storage Restore Operation
// -----------------------------------------------------------------------------

export async function restoreStorage(options = {}) {
  const {
    localEnv: localEnvPath,
    keyFile,
    url: customUrl,
    projectRef = DEFAULT_PROJECT_REF,
    buckets: bucketsPath,
    manifest: manifestPath,
    objectsRoot,
    noUpsert = true,
    verifyUploadedBytes = true,
    report: reportPath,
    dryRun = false,
    concurrency = DEFAULT_CONCURRENCY,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    filesystemCaseInsensitive = null,
  } = options;

  const startTime = Date.now();
  const startTimeIso = new Date(startTime).toISOString();

  // 1. Parameter Requirements
  if (!bucketsPath) fail('USAGE', '--buckets path is required');
  if (!manifestPath) fail('USAGE', '--manifest path is required');
  if (!objectsRoot) fail('USAGE', '--objects-root path is required');

  // Key / Credentials resolution
  let resolvedKeyInfo = null;
  let resolvedBaseUrl = null;

  if (localEnvPath) {
    const envResult = await parseLocalEnvFile(path.resolve(localEnvPath));
    resolvedKeyInfo = envResult.keyInfo;
    resolvedBaseUrl = customUrl || envResult.apiUrl;
  } else if (keyFile) {
    const resolvedKeyFile = path.resolve(keyFile);
    const kStat = await fsp.lstat(resolvedKeyFile);
    if (kStat.isSymbolicLink()) fail('SYMLINK_DETECTED', `key-file must not be a symlink: ${keyFile}`);
    if (!kStat.isFile()) fail('UNSUPPORTED_FILE_TYPE', `key-file must be a regular file: ${keyFile}`);
    if ((kStat.mode & 0o077) !== 0) {
      fail(
        'INSECURE_PERMISSIONS',
        `key-file has insecure permissions: mode 0${(kStat.mode & 0o777).toString(8)} (group/other permissions must be 00)`,
      );
    }
    const keyRaw = (await fsp.readFile(resolvedKeyFile, 'utf8')).trim();
    resolvedKeyInfo = detectKeyFormat(keyRaw);
    resolvedBaseUrl = customUrl;
  } else if (dryRun) {
    // In dry-run without credentials, use synthetic loopback
    resolvedKeyInfo = {
      type: 'synthetic',
      key: 'synthetic',
      authHeader: null,
      apiKeyHeader: 'synthetic',
    };
    resolvedBaseUrl = customUrl || 'http://127.0.0.1:56321';
  } else {
    fail('USAGE', 'either --local-env or --key-file must be provided');
  }

  if (!resolvedBaseUrl) {
    fail('USAGE', 'target Storage API URL not found in local.env and not passed via --url');
  }

  // 2. Validate URL strictly against local rehearsal requirement
  const validatedUrl = validateTargetUrl(resolvedBaseUrl);

  // 3. Pre-Restore Input Validation
  const validatedInputs = await validateRestoreInputs({
    bucketsPath: path.resolve(bucketsPath),
    manifestPath: path.resolve(manifestPath),
    objectsRoot: path.resolve(objectsRoot),
    localEnvPath: localEnvPath ? path.resolve(localEnvPath) : null,
    keyFile: keyFile ? path.resolve(keyFile) : null,
    filesystemCaseInsensitive,
  });

  const { buckets, objects, objectsByBucket } = validatedInputs;

  let totalBytes = 0;
  for (const obj of objects) {
    totalBytes += obj.size;
  }

  // 4. Handle Dry-Run Mode
  if (dryRun) {
    const durationMs = Date.now() - startTime;
    const reportData = {
      status: 'ok',
      operation: 'storage-restore',
      dryRun: true,
      timestamp: {
        start: startTimeIso,
        end: new Date().toISOString(),
        durationMs,
      },
      target: {
        url: validatedUrl,
        projectRef,
        keyType: resolvedKeyInfo.type,
      },
      summary: {
        bucketCount: buckets.length,
        emptyBucketCount: buckets.filter((b) => (objectsByBucket.get(b.id) || []).length === 0).length,
        objectCount: objects.length,
        totalBytes,
        verifiedBytes: 0,
        retriesCount: 0,
      },
      buckets: buckets.map((b) => ({
        id: b.id,
        name: b.name,
        public: b.public,
        status: 'validated',
      })),
      objects: objects.map((o) => ({
        bucket: o.bucket,
        path: o.path,
        size: o.size,
        sha256: o.sha256,
        status: 'validated',
      })),
      versioning: {
        sourceVersioningPreserved: false,
        notes: 'Dry-run: validated inputs without writing to target',
      },
      security: {
        upsertDisabled: Boolean(noUpsert),
        noOverwriteEnforced: true,
        credentialsRedacted: true,
        symlinksFollowed: 0,
      },
    };

    if (reportPath) {
      await writeAtomicReport(reportPath, reportData);
    }

    return reportData;
  }

  // 5. Initialize Storage API Client
  const client = new StorageRestoreClient({
    baseUrl: validatedUrl,
    keyInfo: resolvedKeyInfo,
    timeoutMs,
    maxRetries,
  });

  // 6. Restore Buckets
  const reconciledBuckets = [];
  let emptyBucketCount = 0;

  for (const bucket of buckets) {
    const bucketObjects = objectsByBucket.get(bucket.id) || [];
    if (bucketObjects.length === 0) {
      emptyBucketCount += 1;
    }

    // Check if bucket already exists
    let existing = await client.getBucket(bucket.id);
    if (!existing) {
      // Create bucket via Storage API
      await client.createBucket(bucket);
      // R5-01: Read back bucket metadata from Storage API (never rely solely on POST response)
      existing = await client.getBucket(bucket.id);
      if (!existing) {
        fail(
          'BUCKET_CONFIGURATION_MISMATCH',
          `target bucket '${bucket.id}' not found after creation verification`,
        );
      }
    }

    // R5-01: Verify bucket configuration parity (applies equally to existing and newly created buckets)
    verifyTargetBucketParity(existing, bucket);

    reconciledBuckets.push({
      id: bucket.id,
      name: bucket.name,
      public: bucket.public,
      file_size_limit: bucket.file_size_limit,
      allowed_mime_types: bucket.allowed_mime_types,
      targetPublic: existing.public,
      status: 'restored',
    });
  }

  // 7. Restore Objects with Bounded Concurrency
  const limit = Math.max(1, Math.min(32, concurrency));
  let cursor = 0;
  const uploadResults = new Array(objects.length);

  async function uploadWorker() {
    while (cursor < objects.length) {
      const idx = cursor;
      cursor += 1;
      const obj = objects[idx];

      const res = await client.uploadObject({
        bucketId: obj.bucket,
        objectPath: obj.path,
        filePath: obj.diskPath,
        contentType: obj.contentType,
        fileSize: obj.size,
        expectedSha256: obj.sha256,
        noUpsert: Boolean(noUpsert),
      });

      uploadResults[idx] = {
        bucket: obj.bucket,
        path: obj.path,
        size: obj.size,
        contentType: obj.contentType,
        sourceSha256: obj.sha256,
        sourceObjectId: obj.objectId,
        targetObjectId: res && res.Id ? res.Id : (res && res.id ? res.id : null),
        uploadStatus: 'uploaded',
      };
    }
  }

  const workers = [];
  for (let w = 0; w < limit; w += 1) {
    workers.push(uploadWorker());
  }
  await Promise.all(workers);

  // 8. Post-Restore Verification: Independently Download & Hash Bytes
  let verifiedBytesTotal = 0;
  const verifiedObjects = [];

  if (verifyUploadedBytes) {
    for (const item of uploadResults) {
      const { bytesReceived, sha256: downloadedSha256 } = await client.downloadAndHashObject({
        bucketId: item.bucket,
        objectPath: item.path,
      });

      if (bytesReceived !== item.size) {
        fail(
          'POST_RESTORE_SIZE_MISMATCH',
          `post-restore verification size mismatch for '${item.bucket}/${item.path}': expected ${item.size}, got ${bytesReceived}`,
        );
      }

      if (downloadedSha256.toLowerCase() !== item.sourceSha256.toLowerCase()) {
        fail(
          'POST_RESTORE_HASH_MISMATCH',
          `post-restore verification SHA-256 mismatch for '${item.bucket}/${item.path}': expected ${item.sourceSha256}, got ${downloadedSha256}`,
        );
      }

      verifiedBytesTotal += bytesReceived;
      verifiedObjects.push({
        ...item,
        targetSha256: downloadedSha256,
        targetSize: bytesReceived,
        verified: true,
      });
    }
  } else {
    for (const item of uploadResults) {
      verifiedObjects.push({
        ...item,
        targetSha256: null,
        targetSize: item.size,
        verified: false,
      });
    }
  }

  // 9. Reconcile Target Object Listing & Bucket Counts
  for (const b of buckets) {
    const targetObjects = await client.listObjectsInBucket(b.id);
    const expectedObjs = objectsByBucket.get(b.id) || [];
    const expectedPaths = new Set(expectedObjs.map((o) => o.path));
    // Filter actual file items (ignore folder placeholders with id === null)
    const fileItems = targetObjects.filter((o) => o && o.id !== null);

    // Detect unauthorized orphan objects (P2-VERIFY-01)
    const orphanObjects = [];
    for (const item of fileItems) {
      if (!expectedPaths.has(item.name)) {
        orphanObjects.push(item.name);
      }
    }

    if (orphanObjects.length > 0) {
      fail(
        'ORPHAN_OBJECT_DETECTED',
        `target bucket '${b.id}' contains ${orphanObjects.length} unauthorized orphan object(s) not in manifest: ${orphanObjects.slice(0, 5).join(', ')}${orphanObjects.length > 5 ? '...' : ''}`,
      );
    }

    if (fileItems.length < expectedObjs.length) {
      fail(
        'POST_RESTORE_INCOMPLETE',
        `target bucket '${b.id}' object count (${fileItems.length}) is less than expected (${expectedObjs.length})`,
      );
    }
  }

  // 10. Generate Final Report
  const durationMs = Date.now() - startTime;
  const reportData = {
    status: 'success',
    operation: 'storage-restore',
    timestamp: {
      start: startTimeIso,
      end: new Date().toISOString(),
      durationMs,
    },
    target: {
      url: validatedUrl,
      projectRef,
      keyType: resolvedKeyInfo.type,
    },
    summary: {
      bucketCount: buckets.length,
      emptyBucketCount,
      objectCount: objects.length,
      totalBytes,
      verifiedBytes: verifiedBytesTotal,
      retriesCount: client.totalRetries,
      throughputBytesPerSec: durationMs > 0 ? (totalBytes / (durationMs / 1000)) : totalBytes,
    },
    buckets: reconciledBuckets,
    objects: verifiedObjects,
    versioning: {
      sourceVersioningPreserved: false,
      notes:
        'Supabase Storage REST API allocates new object UUIDs upon upload and does not support arbitrary ID or version restoration',
    },
    security: {
      upsertDisabled: Boolean(noUpsert),
      noOverwriteEnforced: true,
      credentialsRedacted: true,
      symlinksFollowed: 0,
    },
  };

  if (reportPath) {
    await writeAtomicReport(reportPath, reportData);
  }

  return reportData;
}

export async function writeAtomicReport(reportPath, reportData) {
  const resolvedReportPath = path.resolve(reportPath);
  const parentDir = path.dirname(resolvedReportPath);
  await fsp.mkdir(parentDir, { recursive: true, mode: 0o700 });

  const randomHex = crypto.randomBytes(8).toString('hex');
  const tempPath = path.join(parentDir, `.${path.basename(resolvedReportPath)}.tmp-${randomHex}`);
  registerTempFile(tempPath);

  try {
    const jsonStr = JSON.stringify(reportData, null, 2);
    await fsp.writeFile(tempPath, Buffer.from(jsonStr, 'utf8'), { mode: 0o600 });
    await publishFileAtomic(tempPath, resolvedReportPath);
  } catch (err) {
    try {
      await fsp.unlink(tempPath);
    } catch {
      // Best-effort cleanup
    }
    unregisterTempFile(tempPath);
    throw err;
  }
}

// -----------------------------------------------------------------------------
// CLI Argument Parsing & Main Entrypoint
// -----------------------------------------------------------------------------

export function parseCliArgs(argv) {
  const options = {
    noUpsert: true,
    verifyUploadedBytes: true,
  };
  let command = 'restore';
  let i = 0;

  if (argv.length > 0 && !argv[0].startsWith('-')) {
    command = argv[0];
    i = 1;
  }

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--no-upsert') {
      options.noUpsert = true;
      i += 1;
      continue;
    }
    if (arg === '--upsert') {
      options.noUpsert = false;
      i += 1;
      continue;
    }
    if (arg === '--verify-uploaded-bytes') {
      options.verifyUploadedBytes = true;
      i += 1;
      continue;
    }
    if (arg === '--no-verify-uploaded-bytes') {
      options.verifyUploadedBytes = false;
      i += 1;
      continue;
    }
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
      case 'local-env':
        options.localEnv = val;
        break;
      case 'key-file':
        options.keyFile = val;
        break;
      case 'key':
        fail('SECURITY_VIOLATION', 'passing secrets via --key CLI option is forbidden; use --local-env or --key-file');
      case 'url':
        options.url = val;
        break;
      case 'project-ref':
        options.projectRef = val;
        break;
      case 'buckets':
        options.buckets = val;
        break;
      case 'manifest':
        options.manifest = val;
        break;
      case 'objects-root':
        options.objectsRoot = val;
        break;
      case 'report':
        options.report = val;
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
      case 'timeout':
      case 'timeout-ms':
        options.timeoutMs = parseInt(val, 10);
        if (Number.isNaN(options.timeoutMs) || options.timeoutMs < 1) {
          fail('USAGE', `--timeout must be a positive integer, got ${val}`);
        }
        break;
      case 'max-retries':
        options.maxRetries = parseInt(val, 10);
        if (Number.isNaN(options.maxRetries) || options.maxRetries < 0) {
          fail('USAGE', `--max-retries must be a non-negative integer, got ${val}`);
        }
        break;
      default:
        fail('USAGE', `unknown option: --${key}`);
    }
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
    case 'restore':
      return await restoreStorage(options);
    case 'validate':
    case 'verify':
      return await restoreStorage({ ...options, dryRun: true });
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
          operation: 'storage-restore',
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
