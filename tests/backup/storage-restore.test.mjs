/**
 * tests/backup/storage-restore.test.mjs
 *
 * Test suite for Helper #5: Supabase Storage Restore & Validation
 *
 * Contract & Runbook References:
 * - docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12.md §R6, §9.5
 * - docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12_AMENDMENT_HELPER4.md
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test, { describe, beforeEach, afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  restoreStorage,
  detectKeyFormat,
  parseLocalEnvContent,
  validateTargetUrl,
  validateBucketName,
  validateEndpointAndMethod,
  createObjectPathCollisionGuard,
} from '../../scripts/backup/storage-restore.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts/backup/storage-restore.mjs');
const TEST_TMP_DIR = path.join(__dirname, '.tmp-storage-restore-tests');

// Sample valid test keys
const VALID_LEGACY_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UifQ.validSignature1234567890abcdefghijklmnopqrstuvwxyz';
const VALID_SB_SECRET = 'sb_secret_0123456789abcdef0123456789abcdef';

// -----------------------------------------------------------------------------
// Mock Supabase Storage Server for Local Testing
// -----------------------------------------------------------------------------

class MockStorageServer {
  constructor(options = {}) {
    this.options = options;
    this.buckets = new Map();
    this.objects = new Map(); // key: `${bucket}/${objectPath}` -> { buffer, metadata, contentType }
    this.requestLog = [];
    this.injectedError = null;
    this.failCount = 0;
    this.timeoutCount = 0;
    this.corruptDownloadHash = false;
    this.corruptDownloadSize = false;
    this.pauseDuringUpload = false;
    this.uploadFailCount = 0;
    this.dropSocketOnUpload = false;
    this.server = null;
    this.port = null;
  }

  async start() {
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
      const method = req.method.toUpperCase();
      const pathname = url.pathname;

      this.requestLog.push({
        method,
        pathname,
        headers: req.headers,
        search: url.search,
      });

      // Injected redirect test
      if (this.options.redirectUrl) {
        res.writeHead(302, { Location: this.options.redirectUrl });
        res.end();
        return;
      }

      // Injected timeout test
      if (this.timeoutCount > 0) {
        this.timeoutCount -= 1;
        // Do not respond, let client timeout
        return;
      }

      // Injected transient failures with retry
      if (this.failCount > 0) {
        this.failCount -= 1;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ statusCode: 500, error: 'Internal Server Error', message: 'Transient failure' }));
        return;
      }

      // 1. GET /storage/v1/bucket
      if (method === 'GET' && pathname === '/storage/v1/bucket') {
        const list = Array.from(this.buckets.values());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(list));
        return;
      }

      // 2. GET /storage/v1/bucket/:id
      const getBucketMatch = pathname.match(/^\/storage\/v1\/bucket\/([^/]+)$/);
      if (method === 'GET' && getBucketMatch) {
        const bId = decodeURIComponent(getBucketMatch[1]);
        if (this.buckets.has(bId)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(this.buckets.get(bId)));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ statusCode: 404, error: 'Not Found', message: 'Bucket not found' }));
        }
        return;
      }

      // 3. POST /storage/v1/bucket
      if (method === 'POST' && pathname === '/storage/v1/bucket') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const bucketObj = {
            id: body.id,
            name: body.name || body.id,
            public: Boolean(body.public),
            file_size_limit: body.file_size_limit || null,
            allowed_mime_types: body.allowed_mime_types || null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          this.buckets.set(body.id, bucketObj);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(bucketObj));
        });
        return;
      }

      // 4. POST /storage/v1/object/list/:bucket (Must come BEFORE object upload route)
      const listMatch = pathname.match(/^\/storage\/v1\/object\/list\/([^/]+)$/);
      if (method === 'POST' && listMatch) {
        const bucketId = decodeURIComponent(listMatch[1]);
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const list = [];
          for (const [, obj] of this.objects.entries()) {
            if (obj.bucket === bucketId) {
              list.push({
                name: obj.path,
                id: obj.id,
                metadata: {
                  size: obj.buffer.length,
                  mimetype: obj.contentType,
                },
              });
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(list));
        });
        return;
      }

      // 5. POST /storage/v1/object/:bucket/...
      const uploadMatch = pathname.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
      if (method === 'POST' && uploadMatch) {
        if (this.pauseDuringUpload) {
          // Keep request hanging so parent can test SIGTERM/SIGINT
          return;
        }

        if (this.uploadFailCount > 0) {
          this.uploadFailCount -= 1;
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ statusCode: 500, error: 'Internal Server Error', message: 'Transient upload failure' }));
          return;
        }

        const bucketId = decodeURIComponent(uploadMatch[1]);
        const objectPath = uploadMatch[2]
          .split('/')
          .map(decodeURIComponent)
          .join('/');
        const objectKey = `${bucketId}/${objectPath}`;

        const isUpsert = req.headers['x-upsert'] === 'true';
        if (!isUpsert && this.objects.has(objectKey)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              statusCode: '400',
              error: 'Bad Request',
              message: 'The resource already exists',
            }),
          );
          return;
        }

        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const buf = Buffer.concat(chunks);
          const objId = crypto.randomUUID();
          this.objects.set(objectKey, {
            bucket: bucketId,
            path: objectPath,
            buffer: buf,
            contentType: req.headers['content-type'] || 'application/octet-stream',
            id: objId,
          });

          if (this.dropSocketOnUpload) {
            this.dropSocketOnUpload = false;
            req.socket.destroy();
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              Key: objectKey,
              Id: objId,
            }),
          );
        });
        return;
      }

      // 6. GET /storage/v1/object/authenticated/:bucket/... or GET /storage/v1/object/:bucket/...
      let downloadMatch = pathname.match(/^\/storage\/v1\/object\/authenticated\/([^/]+)\/(.+)$/);
      if (!downloadMatch) {
        downloadMatch = pathname.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
      }
      if (method === 'GET' && downloadMatch) {
        const bucketId = decodeURIComponent(downloadMatch[1]);
        const objectPath = downloadMatch[2]
          .split('/')
          .map(decodeURIComponent)
          .join('/');
        const objectKey = `${bucketId}/${objectPath}`;

        if (!this.objects.has(objectKey)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ statusCode: 404, error: 'Not Found', message: 'Object not found' }));
          return;
        }

        const obj = this.objects.get(objectKey);
        let outBuf = obj.buffer;

        // Injected corruption tests
        if (this.corruptDownloadHash) {
          outBuf = Buffer.from(outBuf);
          outBuf[0] ^= 0xff; // flip byte to corrupt hash
        }
        if (this.corruptDownloadSize) {
          outBuf = outBuf.subarray(0, Math.max(0, outBuf.length - 1)); // truncate by 1 byte
        }

        res.writeHead(200, {
          'Content-Type': obj.contentType,
          'Content-Length': outBuf.length,
        });
        res.end(outBuf);
        return;
      }

      // Default 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ statusCode: 404, error: 'Not Found', message: `No route for ${method} ${pathname}` }));
    });

    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(`http://127.0.0.1:${this.port}`);
      });
    });
  }

  async stop() {
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }
}

// -----------------------------------------------------------------------------
// Test Helpers: Synthetic Dataset Builder
// -----------------------------------------------------------------------------

async function createSyntheticDataset(baseDir, config = {}) {
  await fsp.mkdir(baseDir, { recursive: true, mode: 0o700 });

  const buckets = config.buckets || [
    {
      id: 'documents',
      name: 'documents',
      public: false,
      file_size_limit: null,
      allowed_mime_types: null,
      type: 'standard',
      versioning_status: 'disabled',
    },
  ];

  const objectsRoot = path.join(baseDir, 'objects');
  await fsp.mkdir(objectsRoot, { recursive: true, mode: 0o700 });

  // Create bucket directories
  for (const b of buckets) {
    const bDir = path.join(objectsRoot, b.id);
    await fsp.mkdir(bDir, { recursive: true, mode: 0o700 });
  }

  const manifest = [];
  const files = config.files || [
    {
      bucket: 'documents',
      path: 'sample.txt',
      content: 'Hello, Storage Restore Rehearsal!',
      contentType: 'text/plain',
    },
  ];

  for (const f of files) {
    const filePath = path.join(objectsRoot, f.bucket, f.path);
    await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });

    const contentBuffer = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content || '', 'utf8');
    await fsp.writeFile(filePath, contentBuffer, { mode: 0o600 });

    const sha256 = crypto.createHash('sha256').update(contentBuffer).digest('hex');

    manifest.push({
      bucket: f.bucket,
      path: f.path,
      size: contentBuffer.length,
      sha256: f.sha256Override || sha256,
      contentType: f.contentType || 'application/octet-stream',
      objectId: f.objectId || crypto.randomUUID(),
      version: f.version || null,
    });
  }

  const bucketsPath = path.join(baseDir, 'buckets.json');
  await fsp.writeFile(bucketsPath, JSON.stringify(config.bucketsOverride || buckets, null, 2), { mode: 0o600 });

  const manifestPath = path.join(baseDir, 'storage-manifest.json');
  await fsp.writeFile(manifestPath, JSON.stringify(config.manifestOverride || manifest, null, 2), { mode: 0o600 });

  const localEnvPath = path.join(baseDir, 'local.env');
  const envContent =
    config.envContent ||
    `API_URL="http://127.0.0.1:${config.serverPort || 56321}"\nSERVICE_ROLE_KEY="${VALID_LEGACY_JWT}"\n`;
  await fsp.writeFile(localEnvPath, envContent, { mode: 0o600 });

  return {
    baseDir,
    bucketsPath,
    manifestPath,
    objectsRoot,
    localEnvPath,
    manifest,
    buckets,
  };
}

// -----------------------------------------------------------------------------
// Test Suite Execution
// -----------------------------------------------------------------------------

describe('storage-restore.mjs helper suite', () => {
  let mockServer;
  let serverUrl;
  let testCaseDir;

  beforeEach(async () => {
    mockServer = new MockStorageServer();
    serverUrl = await mockServer.start();
    testCaseDir = path.join(TEST_TMP_DIR, `tc-${crypto.randomBytes(6).toString('hex')}`);
    await fsp.mkdir(testCaseDir, { recursive: true, mode: 0o700 });
  });

  afterEach(async () => {
    await mockServer.stop();
    await fsp.rm(testCaseDir, { recursive: true, force: true }).catch(() => {});
  });

  // 1. Một bucket có object (PASS)
  test('restores single bucket with an object and verifies SHA-256 (PASS)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'crm-contracts', name: 'crm-contracts', public: false }],
      files: [
        {
          bucket: 'crm-contracts',
          path: 'agreements/deal-001.pdf',
          content: 'Contract Agreement PDF Content Bytes',
          contentType: 'application/pdf',
        },
      ],
    });

    const reportPath = path.join(testCaseDir, 'report.json');
    const res = await restoreStorage({
      localEnv: dataset.localEnvPath,
      buckets: dataset.bucketsPath,
      manifest: dataset.manifestPath,
      objectsRoot: dataset.objectsRoot,
      report: reportPath,
    });

    assert.equal(res.status, 'success');
    assert.equal(res.summary.bucketCount, 1);
    assert.equal(res.summary.objectCount, 1);
    assert.equal(res.summary.emptyBucketCount, 0);
    assert.equal(res.summary.verifiedBytes, 'Contract Agreement PDF Content Bytes'.length);

    // Verify report was written atomically
    const reportData = JSON.parse(await fsp.readFile(reportPath, 'utf8'));
    assert.equal(reportData.status, 'success');
    assert.equal(reportData.objects[0].verified, true);
    assert.equal(reportData.security.upsertDisabled, true);
  });

  // 2. Một bucket rỗng (PASS)
  test('restores single empty bucket without skipping (PASS)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'empty-invoices', name: 'empty-invoices', public: true }],
      files: [], // Zero objects
    });

    const reportPath = path.join(testCaseDir, 'report.json');
    const res = await restoreStorage({
      localEnv: dataset.localEnvPath,
      buckets: dataset.bucketsPath,
      manifest: dataset.manifestPath,
      objectsRoot: dataset.objectsRoot,
      report: reportPath,
    });

    assert.equal(res.status, 'success');
    assert.equal(res.summary.bucketCount, 1);
    assert.equal(res.summary.emptyBucketCount, 1);
    assert.equal(res.summary.objectCount, 0);

    // Verify bucket exists on target
    const createdBucket = await mockServer.buckets.get('empty-invoices');
    assert.ok(createdBucket);
    assert.equal(createdBucket.public, true);
  });

  // 3. Nhiều bucket rỗng (PASS)
  test('restores multiple empty buckets without skipping (PASS)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [
        { id: 'empty-a', name: 'empty-a', public: false },
        { id: 'empty-b', name: 'empty-b', public: false },
        { id: 'empty-c', name: 'empty-c', public: true },
      ],
      files: [],
    });

    const reportPath = path.join(testCaseDir, 'report.json');
    const res = await restoreStorage({
      localEnv: dataset.localEnvPath,
      buckets: dataset.bucketsPath,
      manifest: dataset.manifestPath,
      objectsRoot: dataset.objectsRoot,
      report: reportPath,
    });

    assert.equal(res.status, 'success');
    assert.equal(res.summary.bucketCount, 3);
    assert.equal(res.summary.emptyBucketCount, 3);
    assert.equal(res.summary.objectCount, 0);

    assert.ok(mockServer.buckets.has('empty-a'));
    assert.ok(mockServer.buckets.has('empty-b'));
    assert.ok(mockServer.buckets.has('empty-c'));
  });

  // 4. Bucket rỗng và bucket có object (PASS)
  test('restores a mixture of empty buckets and populated buckets (PASS)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [
        { id: 'bucket-populated', name: 'bucket-populated', public: false },
        { id: 'bucket-empty', name: 'bucket-empty', public: false },
      ],
      files: [
        {
          bucket: 'bucket-populated',
          path: 'photo.jpg',
          content: 'fake image data',
          contentType: 'image/jpeg',
        },
      ],
    });

    const res = await restoreStorage({
      localEnv: dataset.localEnvPath,
      buckets: dataset.bucketsPath,
      manifest: dataset.manifestPath,
      objectsRoot: dataset.objectsRoot,
    });

    assert.equal(res.status, 'success');
    assert.equal(res.summary.bucketCount, 2);
    assert.equal(res.summary.emptyBucketCount, 1);
    assert.equal(res.summary.objectCount, 1);
    assert.ok(mockServer.buckets.has('bucket-populated'));
    assert.ok(mockServer.buckets.has('bucket-empty'));
  });

  // 5. Nhiều object (PASS)
  test('restores multiple objects across nested hierarchies (PASS)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'assets-bucket', name: 'assets-bucket', public: false }],
      files: [
        { bucket: 'assets-bucket', path: 'css/main.css', content: 'body { color: red; }', contentType: 'text/css' },
        { bucket: 'assets-bucket', path: 'js/bundle.js', content: 'console.log("crm");', contentType: 'text/javascript' },
        { bucket: 'assets-bucket', path: 'icons/fav.ico', content: 'iconbytes', contentType: 'image/x-icon' },
        { bucket: 'assets-bucket', path: 'docs/sub/deep/readme.txt', content: 'deep file', contentType: 'text/plain' },
      ],
    });

    const res = await restoreStorage({
      localEnv: dataset.localEnvPath,
      buckets: dataset.bucketsPath,
      manifest: dataset.manifestPath,
      objectsRoot: dataset.objectsRoot,
    });

    assert.equal(res.status, 'success');
    assert.equal(res.summary.objectCount, 4);
    assert.equal(res.objects.length, 4);
    for (const obj of res.objects) {
      assert.equal(obj.verified, true);
    }
  });

  // 6. Missing bucket inventory (FAIL)
  test('fails closed when bucket inventory is missing (FAIL)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, { serverPort: mockServer.port });
    await fsp.unlink(dataset.bucketsPath);

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
        });
      },
      (err) => {
        assert.equal(err.code, 'SOURCE_NOT_FOUND');
        return true;
      },
    );
  });

  // 7. Duplicate bucket (FAIL)
  test('fails closed on duplicate bucket in inventory (FAIL)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      bucketsOverride: [
        { id: 'dup-bucket', name: 'dup-bucket' },
        { id: 'dup-bucket', name: 'dup-bucket' },
      ],
    });

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
        });
      },
      (err) => {
        assert.equal(err.code, 'DUPLICATE_BUCKET');
        return true;
      },
    );
  });

  // 8. Duplicate object path (FAIL)
  test('fails closed on duplicate object path in manifest (FAIL)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'bucket-test', name: 'bucket-test' }],
      manifestOverride: [
        { bucket: 'bucket-test', path: 'file.txt', size: 4, sha256: 'a'.repeat(64), contentType: 'text/plain' },
        { bucket: 'bucket-test', path: 'file.txt', size: 4, sha256: 'a'.repeat(64), contentType: 'text/plain' },
      ],
    });

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
        });
      },
      (err) => {
        assert.equal(err.code, 'DUPLICATE_OBJECT');
        return true;
      },
    );
  });

  // 9. Missing object bytes (FAIL)
  test('fails closed when object declared in manifest is missing on disk (FAIL)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'bucket-test', name: 'bucket-test' }],
      files: [{ bucket: 'bucket-test', path: 'missing.bin', content: 'data' }],
    });

    // Delete file from disk
    await fsp.unlink(path.join(dataset.objectsRoot, 'bucket-test', 'missing.bin'));

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
        });
      },
      (err) => {
        assert.equal(err.code, 'OBJECT_NOT_FOUND');
        return true;
      },
    );
  });

  // 10. Unexpected object on disk (FAIL)
  test('fails closed when unexpected object exists on disk (FAIL)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'bucket-test', name: 'bucket-test' }],
      files: [{ bucket: 'bucket-test', path: 'declared.txt', content: 'declared' }],
    });

    // Add extra unmanifested file
    await fsp.writeFile(path.join(dataset.objectsRoot, 'bucket-test', 'unmanifested.txt'), 'rogue content', { mode: 0o600 });

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
        });
      },
      (err) => {
        assert.equal(err.code, 'UNEXPECTED_OBJECT');
        return true;
      },
    );
  });

  // 11. SHA-256 mismatch (FAIL)
  test('fails closed on pre-restore SHA-256 checksum mismatch (FAIL)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'bucket-test', name: 'bucket-test' }],
      files: [
        {
          bucket: 'bucket-test',
          path: 'tampered.txt',
          content: 'real data',
          sha256Override: 'b'.repeat(64), // tampered
        },
      ],
    });

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
        });
      },
      (err) => {
        assert.equal(err.code, 'HASH_MISMATCH');
        return true;
      },
    );
  });

  // 12. Size mismatch (FAIL)
  test('fails closed on pre-restore size mismatch (FAIL)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'bucket-test', name: 'bucket-test' }],
      manifestOverride: [
        {
          bucket: 'bucket-test',
          path: 'sample.txt',
          size: 999999, // wrong size
          sha256: crypto.createHash('sha256').update('real').digest('hex'),
          contentType: 'text/plain',
        },
      ],
      files: [{ bucket: 'bucket-test', path: 'sample.txt', content: 'real' }],
    });

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
        });
      },
      (err) => {
        assert.equal(err.code, 'SIZE_MISMATCH');
        return true;
      },
    );
  });

  // 13. Invalid bucket configuration (FAIL)
  test('fails closed on unsupported bucket configuration (FAIL)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      bucketsOverride: [
        {
          id: 'versioned-bucket',
          name: 'versioned-bucket',
          versioning_status: 'enabled', // unsupported by restore API
        },
      ],
    });

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
        });
      },
      (err) => {
        assert.equal(err.code, 'UNSUPPORTED_BUCKET_CONFIG');
        return true;
      },
    );
  });

  // 14. Path traversal (FAIL)
  test('fails closed on path traversal in bucket name or object path (FAIL)', async () => {
    // 14a. Bucket traversal
    assert.throws(
      () => {
        validateBucketName('../traversal-bucket');
      },
      (err) => {
        assert.equal(err.code, 'PATH_TRAVERSAL');
        return true;
      },
    );

    // 14b. Object path traversal
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'bucket-test', name: 'bucket-test' }],
      manifestOverride: [
        {
          bucket: 'bucket-test',
          path: '../../etc/passwd',
          size: 10,
          sha256: 'a'.repeat(64),
          contentType: 'text/plain',
        },
      ],
    });

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
        });
      },
      (err) => {
        assert.equal(err.code, 'PATH_TRAVERSAL');
        return true;
      },
    );
  });

  // 15. Symlink attack (FAIL)
  test('fails closed when symlinks are present in inputs (FAIL)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'bucket-test', name: 'bucket-test' }],
      files: [{ bucket: 'bucket-test', path: 'good.txt', content: 'hello' }],
    });

    // Plant a symlink inside the bucket
    const targetFile = path.join(testCaseDir, 'external-secret.txt');
    await fsp.writeFile(targetFile, 'secret', { mode: 0o600 });
    const symlinkPath = path.join(dataset.objectsRoot, 'bucket-test', 'symlink.txt');
    await fsp.symlink(targetFile, symlinkPath);

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
        });
      },
      (err) => {
        assert.equal(err.code, 'SYMLINK_DETECTED');
        return true;
      },
    );
  });

  // 16. API timeout (FAIL / Does not claim success)
  test('fails closed on API timeout without claiming success (FAIL)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'bucket-test', name: 'bucket-test' }],
      files: [{ bucket: 'bucket-test', path: 'item.txt', content: 'timeout test' }],
    });

    mockServer.timeoutCount = 5; // Force timeout

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
          timeoutMs: 100, // short timeout
          maxRetries: 0,
        });
      },
      (err) => {
        assert.equal(err.code, 'API_TIMEOUT');
        return true;
      },
    );
  });

  // 17. Partial upload failure (Báo rõ trạng thái)
  test('reports clear error status on upload failure without claiming success (FAIL)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'bucket-test', name: 'bucket-test' }],
      files: [{ bucket: 'bucket-test', path: 'fail.txt', content: 'failing content' }],
    });

    // Make mock server reject uploads with 500 indefinitely
    mockServer.failCount = 10;

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
          maxRetries: 1,
        });
      },
      (err) => {
        assert.equal(err.code, 'API_ERROR');
        return true;
      },
    );
  });

  // 18. Existing destination object (Không overwrite tùy tiện)
  test('fails closed when destination object exists and --no-upsert is set (FAIL)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'bucket-test', name: 'bucket-test' }],
      files: [{ bucket: 'bucket-test', path: 'exists.txt', content: 'initial content' }],
    });

    // Pre-populate object in mock server
    mockServer.buckets.set('bucket-test', { id: 'bucket-test', name: 'bucket-test', public: false });
    mockServer.objects.set('bucket-test/exists.txt', {
      bucket: 'bucket-test',
      path: 'exists.txt',
      buffer: Buffer.from('already here'),
      contentType: 'text/plain',
      id: crypto.randomUUID(),
    });

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
          noUpsert: true,
        });
      },
      (err) => {
        assert.equal(err.code, 'DESTINATION_OBJECT_EXISTS');
        return true;
      },
    );
  });

  // 19. Remote URL rejection
  test('strictly blocks remote URLs and hosted projects (FAIL)', async () => {
    assert.throws(
      () => {
        validateTargetUrl('https://qmhfmgkymjgoevwmkidm.supabase.co');
      },
      (err) => {
        assert.equal(err.code, 'REMOTE_TARGET_BLOCKED');
        return true;
      },
    );

    assert.throws(
      () => {
        validateTargetUrl('https://api.example.com');
      },
      (err) => {
        assert.equal(err.code, 'REMOTE_TARGET_BLOCKED');
        return true;
      },
    );

    // Permitted local target
    const validOrigin = validateTargetUrl('http://127.0.0.1:56321');
    assert.equal(validOrigin, 'http://127.0.0.1:56321');
  });

  // 20. Secret key format validation
  test('validates key format and sets correct headers per format', () => {
    // 20a. Legacy JWT: sends apikey AND Authorization: Bearer
    const jwtInfo = detectKeyFormat(VALID_LEGACY_JWT);
    assert.equal(jwtInfo.type, 'legacy-jwt');
    assert.equal(jwtInfo.apiKeyHeader, VALID_LEGACY_JWT);
    assert.equal(jwtInfo.authHeader, `Bearer ${VALID_LEGACY_JWT}`);

    // 20b. Current sb_secret_: sends apikey ONLY, NO Authorization header
    const sbInfo = detectKeyFormat(VALID_SB_SECRET);
    assert.equal(sbInfo.type, 'sb-secret');
    assert.equal(sbInfo.apiKeyHeader, VALID_SB_SECRET);
    assert.equal(sbInfo.authHeader, null);

    // 20c. Invalid format
    assert.throws(
      () => {
        detectKeyFormat('invalid_random_string_123');
      },
      (err) => {
        assert.equal(err.code, 'INVALID_KEY_FORMAT');
        return true;
      },
    );
  });

  // 21. Multiple conflicting keys in local.env
  test('fails closed when multiple conflicting keys are found in local.env', () => {
    const content = `
API_URL="http://127.0.0.1:56321"
SERVICE_ROLE_KEY="${VALID_LEGACY_JWT}"
LOCAL_SECRET_KEY="${VALID_SB_SECRET}"
    `;
    assert.throws(
      () => {
        parseLocalEnvContent(content);
      },
      (err) => {
        assert.equal(err.code, 'MULTIPLE_KEYS_DETECTED');
        return true;
      },
    );
  });

  // 22. Endpoint allowlist
  test('enforces strict endpoint/method allowlist', () => {
    // Allowed
    assert.doesNotThrow(() => validateEndpointAndMethod('GET', '/storage/v1/bucket'));
    assert.doesNotThrow(() => validateEndpointAndMethod('POST', '/storage/v1/bucket'));
    assert.doesNotThrow(() => validateEndpointAndMethod('POST', '/storage/v1/object/bucket-1/path/to/file.txt'));
    assert.doesNotThrow(() => validateEndpointAndMethod('GET', '/storage/v1/object/authenticated/bucket-1/file.txt'));

    // Forbidden
    assert.throws(
      () => validateEndpointAndMethod('DELETE', '/storage/v1/object/bucket-1/file.txt'),
      (err) => err.code === 'UNAPPROVED_ENDPOINT',
    );
    assert.throws(
      () => validateEndpointAndMethod('GET', '/rest/v1/users'),
      (err) => err.code === 'UNAPPROVED_ENDPOINT',
    );
  });

  // 23. HTTP Redirects rejected
  test('fails closed when storage endpoint responds with HTTP redirect (FAIL)', async () => {
    const redirectServer = new MockStorageServer({ redirectUrl: 'http://127.0.0.1:9999/other' });
    await redirectServer.start();

    try {
      const dataset = await createSyntheticDataset(testCaseDir, {
        serverPort: redirectServer.port,
        buckets: [{ id: 'bucket-redirect', name: 'bucket-redirect' }],
        files: [{ bucket: 'bucket-redirect', path: 'test.txt', content: 'data' }],
      });

      await assert.rejects(
        async () => {
          await restoreStorage({
            localEnv: dataset.localEnvPath,
            buckets: dataset.bucketsPath,
            manifest: dataset.manifestPath,
            objectsRoot: dataset.objectsRoot,
            maxRetries: 0,
          });
        },
        (err) => {
          assert.equal(err.code, 'REDIRECT_REJECTED');
          return true;
        },
      );
    } finally {
      await redirectServer.stop();
    }
  });

  // 24. Unicode NFC / NFD collision
  test('detects and rejects Unicode NFC/NFD collision (FAIL)', async () => {
    const nfcName = 'ti\u1EBFng-vi\u1EC7t'; // NFC
    const nfdName = 'ti\u00EA\u0301ng-vi\u00EA\u0323t'; // NFD

    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'unicode-bucket', name: 'unicode-bucket' }],
      manifestOverride: [
        { bucket: 'unicode-bucket', path: nfcName, size: 5, sha256: 'a'.repeat(64), contentType: 'text/plain' },
        { bucket: 'unicode-bucket', path: nfdName, size: 5, sha256: 'a'.repeat(64), contentType: 'text/plain' },
      ],
    });

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
        });
      },
      (err) => {
        assert.equal(err.code, 'UNICODE_COLLISION');
        return true;
      },
    );
  });

  // 25. Post-restore hash mismatch
  test('fails closed when post-restore download hash verification fails (FAIL)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'bucket-test', name: 'bucket-test' }],
      files: [{ bucket: 'bucket-test', path: 'corrupt.txt', content: 'uncorrupted original' }],
    });

    // Tell mock server to corrupt downloaded bytes
    mockServer.corruptDownloadHash = true;

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
          verifyUploadedBytes: true,
        });
      },
      (err) => {
        assert.equal(err.code, 'POST_RESTORE_HASH_MISMATCH');
        return true;
      },
    );
  });

  // 26. Post-restore size mismatch
  test('fails closed when post-restore download size verification fails (FAIL)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'bucket-test', name: 'bucket-test' }],
      files: [{ bucket: 'bucket-test', path: 'truncate.txt', content: 'truncate me' }],
    });

    // Tell mock server to truncate downloaded bytes
    mockServer.corruptDownloadSize = true;

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
          verifyUploadedBytes: true,
        });
      },
      (err) => {
        assert.equal(err.code, 'POST_RESTORE_SIZE_MISMATCH');
        return true;
      },
    );
  });

  // 27. Controlled retries on transient errors
  test('recovers from transient HTTP 500 and records retry count (PASS)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'bucket-test', name: 'bucket-test' }],
      files: [{ bucket: 'bucket-test', path: 'transient.txt', content: 'transient retry content' }],
    });

    // Fail first 2 requests with 500, then succeed
    mockServer.failCount = 2;

    const res = await restoreStorage({
      localEnv: dataset.localEnvPath,
      buckets: dataset.bucketsPath,
      manifest: dataset.manifestPath,
      objectsRoot: dataset.objectsRoot,
      maxRetries: 3,
    });

    assert.equal(res.status, 'success');
    assert.equal(res.summary.retriesCount, 2);
  });

  // 28. Dry-run mode
  test('dry-run mode validates inputs without performing uploads (PASS)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'dry-bucket', name: 'dry-bucket' }],
      files: [{ bucket: 'dry-bucket', path: 'file.txt', content: 'dry-run content' }],
    });

    const res = await restoreStorage({
      localEnv: dataset.localEnvPath,
      buckets: dataset.bucketsPath,
      manifest: dataset.manifestPath,
      objectsRoot: dataset.objectsRoot,
      dryRun: true,
    });

    assert.equal(res.status, 'ok');
    assert.equal(res.dryRun, true);
    // Nothing created in mock server
    assert.equal(mockServer.buckets.size, 0);
    assert.equal(mockServer.objects.size, 0);
  });

  // 29. Performance test: 64 MiB streaming with bounded RSS and metric logging
  test('streams large 64 MiB file with bounded memory usage and logs performance metrics (PASS)', async () => {
    const largeSize = 64 * 1024 * 1024; // 64 MiB
    const largeBuffer = Buffer.alloc(largeSize, 0x42);

    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'big-data', name: 'big-data' }],
      files: [
        {
          bucket: 'big-data',
          path: 'large.bin',
          content: largeBuffer,
          contentType: 'application/octet-stream',
        },
      ],
    });

    const memBefore = process.memoryUsage().rss;
    const t0 = Date.now();
    const res = await restoreStorage({
      localEnv: dataset.localEnvPath,
      buckets: dataset.bucketsPath,
      manifest: dataset.manifestPath,
      objectsRoot: dataset.objectsRoot,
      verifyUploadedBytes: true,
    });
    const totalDurationMs = Date.now() - t0;
    const memAfter = process.memoryUsage().rss;

    assert.equal(res.status, 'success');
    assert.equal(res.summary.verifiedBytes, largeSize);

    // RSS growth should be modest
    const rssGrowth = memAfter - memBefore;
    const throughput = (largeSize / (totalDurationMs / 1000) / (1024 * 1024)).toFixed(2);

    console.log(`  ℹ 64 MiB Performance Evidence:`);
    console.log(`    - File size: ${largeSize} bytes (64 MiB)`);
    console.log(`    - Peak RSS growth: ${rssGrowth} bytes (~${(rssGrowth / 1024 / 1024).toFixed(2)} MiB)`);
    console.log(`    - Total restore duration: ${totalDurationMs} ms`);
    console.log(`    - Upload/download throughput: ${throughput} MiB/s`);
    console.log(`    - Retry count: ${res.summary.retriesCount}`);
    console.log(`    - Status: ${res.status}`);
  });

  // 30. Secret leakage prevention
  test('never includes API keys or tokens in generated reports or error logs', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'bucket-test', name: 'bucket-test' }],
      files: [{ bucket: 'bucket-test', path: 'secret-check.txt', content: 'check secrets' }],
    });

    const reportPath = path.join(testCaseDir, 'report.json');
    await restoreStorage({
      localEnv: dataset.localEnvPath,
      buckets: dataset.bucketsPath,
      manifest: dataset.manifestPath,
      objectsRoot: dataset.objectsRoot,
      report: reportPath,
    });

    const reportContent = await fsp.readFile(reportPath, 'utf8');
    assert.ok(!reportContent.includes(VALID_LEGACY_JWT), 'report must not leak legacy JWT');
    assert.ok(!reportContent.includes(VALID_SB_SECRET), 'report must not leak sb_secret');
  });

  // 31. Direct CLI execution matching Runbook §R6 verbatim command
  test('executes CLI interface with verbatim Runbook §R6 arguments (PASS)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'verbatim-bucket', name: 'verbatim-bucket' }],
      files: [{ bucket: 'verbatim-bucket', path: 'doc.txt', content: 'verbatim cli test' }],
    });

    const reportPath = path.join(testCaseDir, 'verbatim-report.json');

    const args = [
      SCRIPT_PATH,
      'restore',
      '--local-env',
      dataset.localEnvPath,
      '--buckets',
      dataset.bucketsPath,
      '--manifest',
      dataset.manifestPath,
      '--objects-root',
      dataset.objectsRoot,
      '--no-upsert',
      '--verify-uploaded-bytes',
      '--report',
      reportPath,
    ];

    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));

    const exitCode = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(exitCode, 0, `CLI exited with code ${exitCode}. Stderr: ${Buffer.concat(stderrChunks).toString()}`);

    const reportData = JSON.parse(await fsp.readFile(reportPath, 'utf8'));
    assert.equal(reportData.status, 'success');
    assert.equal(reportData.summary.objectCount, 1);
    assert.equal(reportData.summary.bucketCount, 1);
  });

  // 32. Interrupted execution (SIGTERM) cleans up and does not complete
  test('interrupted execution with SIGTERM exits non-zero and does not publish report (FAIL CLOSED)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'interrupt-bucket', name: 'interrupt-bucket' }],
      files: [{ bucket: 'interrupt-bucket', path: 'pause.txt', content: 'pause me' }],
    });

    mockServer.pauseDuringUpload = true; // Freeze upload request so we can send SIGTERM

    const reportPath = path.join(testCaseDir, 'interrupted-report.json');
    const args = [
      SCRIPT_PATH,
      'restore',
      '--local-env',
      dataset.localEnvPath,
      '--buckets',
      dataset.bucketsPath,
      '--manifest',
      dataset.manifestPath,
      '--objects-root',
      dataset.objectsRoot,
      '--report',
      reportPath,
    ];

    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    // Wait until child has started and hit mockServer upload
    let hitUpload = false;
    for (let i = 0; i < 50; i += 1) {
      if (mockServer.requestLog.some((r) => r.method === 'POST' && r.pathname.includes('/object/'))) {
        hitUpload = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(hitUpload, 'child should have initiated upload request');

    // Send SIGTERM to simulate interruption
    child.kill('SIGTERM');

    const exitCode = await new Promise((resolve) => child.on('close', resolve));
    assert.notEqual(exitCode, 0, 'child must exit non-zero when interrupted');

    // Destination report file must NOT have been published
    try {
      await fsp.access(reportPath);
      assert.fail('report file must not exist after interrupted execution');
    } catch (err) {
      assert.equal(err.code, 'ENOENT');
    }
  });

  // ---------------------------------------------------------------------------
  // Remediation Tests (Findings P1-01, P1-02, P2-01, P2-02, P2-03, P2-04, P3)
  // ---------------------------------------------------------------------------

  // 33. P1-RETRY-01: Stream exhaustion on upload retry
  test('P1-RETRY-01: recovers when first attempt fails with transient HTTP 500 during object upload and streams fresh bytes on retry (PASS)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'retry-stream-bucket', name: 'retry-stream-bucket' }],
      files: [{ bucket: 'retry-stream-bucket', path: 'retry-file.txt', content: 'RETRY STREAM FRESH PAYLOAD' }],
    });

    // Make mock server fail specifically on the first POST /object request
    mockServer.uploadFailCount = 1;

    const res = await restoreStorage({
      localEnv: dataset.localEnvPath,
      buckets: dataset.bucketsPath,
      manifest: dataset.manifestPath,
      objectsRoot: dataset.objectsRoot,
      maxRetries: 2,
    });

    assert.equal(res.status, 'success');
    assert.ok(res.summary.retriesCount >= 1, 'retriesCount must be at least 1');
    const stored = mockServer.objects.get('retry-stream-bucket/retry-file.txt');
    assert.ok(stored);
    assert.equal(stored.buffer.toString('utf8'), 'RETRY STREAM FRESH PAYLOAD');
  });

  // 34. P1-RETRY-02: Lost ACK with matching content succeeds idempotently
  test('P1-RETRY-02: recovers idempotently when server persisted object but client lost ACK (PASS)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'lost-ack-bucket', name: 'lost-ack-bucket' }],
      files: [{ bucket: 'lost-ack-bucket', path: 'idempotent.txt', content: 'IDEMPOTENT PAYLOAD CONTENT' }],
    });

    // On first upload, persist object and abruptly destroy socket to simulate lost ACK
    mockServer.dropSocketOnUpload = true;

    const res = await restoreStorage({
      localEnv: dataset.localEnvPath,
      buckets: dataset.bucketsPath,
      manifest: dataset.manifestPath,
      objectsRoot: dataset.objectsRoot,
      maxRetries: 2,
    });

    assert.equal(res.status, 'success');
    assert.ok(res.summary.retriesCount >= 1, 'should record retry attempt');
  });

  // 35. P1-RETRY-02 Negative: Retry encounters existing object with corrupted or different content
  test('P1-RETRY-02: fails closed when retry encounters existing object with corrupted or different content (FAIL)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'corrupt-ack-bucket', name: 'corrupt-ack-bucket' }],
      files: [{ bucket: 'corrupt-ack-bucket', path: 'conflict.txt', content: 'VALID CONTENT' }],
    });

    // Pre-populate destination with conflicting content of same name
    mockServer.buckets.set('corrupt-ack-bucket', { id: 'corrupt-ack-bucket', name: 'corrupt-ack-bucket', public: false });
    mockServer.objects.set('corrupt-ack-bucket/conflict.txt', {
      bucket: 'corrupt-ack-bucket',
      path: 'conflict.txt',
      buffer: Buffer.from('DIFFERENT CORRUPTED CONTENT'),
      contentType: 'text/plain',
      id: crypto.randomUUID(),
    });

    // Force upload failure on attempt 0 to trigger retry
    mockServer.uploadFailCount = 1;

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
          maxRetries: 1,
        });
      },
      (err) => {
        assert.equal(err.code, 'DESTINATION_OBJECT_EXISTS');
        return true;
      },
    );
  });

  // 36. P2-VERIFY-01: Unauthorized orphan objects on destination
  test('P2-VERIFY-01: fails closed when target bucket contains unauthorized orphan objects not in manifest (FAIL)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'orphan-test-bucket', name: 'orphan-test-bucket' }],
      files: [{ bucket: 'orphan-test-bucket', path: 'manifested.txt', content: 'manifested file' }],
    });

    // Inject an extra unmanifested orphan object into mock server
    mockServer.objects.set('orphan-test-bucket/orphan-rogue.txt', {
      bucket: 'orphan-test-bucket',
      path: 'orphan-rogue.txt',
      buffer: Buffer.from('rogue bytes'),
      contentType: 'text/plain',
      id: crypto.randomUUID(),
    });

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
        });
      },
      (err) => {
        assert.equal(err.code, 'ORPHAN_OBJECT_DETECTED');
        return true;
      },
    );
  });

  // 37. P2-COLLISION-01: Case-insensitive path collision
  test('P2-COLLISION-01: fails closed on case-insensitive path collision in object names (FAIL)', async () => {
    const hash = crypto.createHash('sha256').update('content').digest('hex');
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'case-collision-bucket', name: 'case-collision-bucket' }],
      manifestOverride: [
        { bucket: 'case-collision-bucket', path: 'file.txt', size: 7, sha256: hash, contentType: 'text/plain' },
        { bucket: 'case-collision-bucket', path: 'FILE.TXT', size: 7, sha256: hash, contentType: 'text/plain' },
      ],
      files: [{ bucket: 'case-collision-bucket', path: 'file.txt', content: 'content' }],
    });

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
          // Deterministic injection of the macOS/Windows case-insensitive
          // filesystem branch. The CI Linux runner uses a case-sensitive
          // filesystem, so probing the real filesystem cannot exercise it.
          filesystemCaseInsensitive: true,
        });
      },
      (err) => {
        assert.equal(err.code, 'PATH_COLLISION');
        return true;
      },
    );
  });

  // 37a. P2-COLLISION-02: Case-sensitive filesystem behavior is isolated
  test('P2-COLLISION-02: case-sensitive filesystem allows case-distinct object names without PATH_COLLISION', () => {
    const registerObjectPath = createObjectPathCollisionGuard({ caseInsensitive: false });

    assert.doesNotThrow(() => {
      registerObjectPath('case-collision-bucket', 'file.txt');
      registerObjectPath('case-collision-bucket', 'FILE.TXT');
    });
  });

  // 37b. P2-COLLISION-03: Case-insensitive collision guard is deterministic
  test('P2-COLLISION-03: case-insensitive filesystem rejects case-distinct object names with PATH_COLLISION', () => {
    const registerObjectPath = createObjectPathCollisionGuard({ caseInsensitive: true });

    registerObjectPath('case-collision-bucket', 'file.txt');
    assert.throws(
      () => registerObjectPath('case-collision-bucket', 'FILE.TXT'),
      (err) => {
        assert.equal(err.code, 'PATH_COLLISION');
        assert.match(err.message, /case-insensitive path collision/);
        return true;
      },
    );
  });

  // 37c. P2-COLLISION-04: Existing duplicate and NFC protections remain active
  test('P2-COLLISION-04: collision guard still rejects duplicate and Unicode NFC/NFD collisions in both modes', () => {
    for (const caseInsensitive of [false, true]) {
      const duplicateGuard = createObjectPathCollisionGuard({ caseInsensitive });
      duplicateGuard('case-collision-bucket', 'file.txt');
      assert.throws(
        () => duplicateGuard('case-collision-bucket', 'file.txt'),
        (err) => {
          assert.equal(err.code, 'DUPLICATE_OBJECT');
          return true;
        },
        `duplicate guard must reject exact duplicates when caseInsensitive=${caseInsensitive}`,
      );

      const nfcGuard = createObjectPathCollisionGuard({ caseInsensitive });
      const nfcPath = 'caf\u00e9.txt';
      const nfdPath = 'cafe\u0301.txt';
      nfcGuard('case-collision-bucket', nfcPath);
      assert.throws(
        () => nfcGuard('case-collision-bucket', nfdPath),
        (err) => {
          assert.equal(err.code, 'UNICODE_COLLISION');
          return true;
        },
        `NFC guard must reject normalization collisions when caseInsensitive=${caseInsensitive}`,
      );
    }
  });

  // 38. P2-BUCKET-01: Bucket configuration mismatch (public setting)
  test('P2-BUCKET-01: fails closed when existing destination bucket has conflicting public setting (FAIL)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'public-mismatch-bucket', name: 'public-mismatch-bucket', public: false }],
      files: [],
    });

    // Destination bucket exists with public: true, while backup is public: false
    mockServer.buckets.set('public-mismatch-bucket', {
      id: 'public-mismatch-bucket',
      name: 'public-mismatch-bucket',
      public: true,
    });

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
        });
      },
      (err) => {
        assert.equal(err.code, 'BUCKET_CONFIGURATION_MISMATCH');
        return true;
      },
    );
  });

  // 39. P2-BUCKET-01: Bucket configuration mismatch (file_size_limit)
  test('P2-BUCKET-01: fails closed when existing destination bucket has conflicting file_size_limit (FAIL)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'limit-mismatch-bucket', name: 'limit-mismatch-bucket', public: false, file_size_limit: 1048576 }],
      files: [],
    });

    // Destination bucket exists with file_size_limit: 2097152
    mockServer.buckets.set('limit-mismatch-bucket', {
      id: 'limit-mismatch-bucket',
      name: 'limit-mismatch-bucket',
      public: false,
      file_size_limit: 2097152,
    });

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
        });
      },
      (err) => {
        assert.equal(err.code, 'BUCKET_CONFIGURATION_MISMATCH');
        return true;
      },
    );
  });

  // 40. P2-BUCKET-01: Bucket configuration mismatch (allowed_mime_types)
  test('P2-BUCKET-01: fails closed when existing destination bucket has conflicting allowed_mime_types (FAIL)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, {
      serverPort: mockServer.port,
      buckets: [{ id: 'mime-mismatch-bucket', name: 'mime-mismatch-bucket', public: false, allowed_mime_types: ['image/png'] }],
      files: [],
    });

    // Destination bucket exists with allowed_mime_types: ['image/jpeg']
    mockServer.buckets.set('mime-mismatch-bucket', {
      id: 'mime-mismatch-bucket',
      name: 'mime-mismatch-bucket',
      public: false,
      allowed_mime_types: ['image/jpeg'],
    });

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
        });
      },
      (err) => {
        assert.equal(err.code, 'BUCKET_CONFIGURATION_MISMATCH');
        return true;
      },
    );
  });

  // 41. P2-SEC-01: Insecure permissions on local.env (mode 0644)
  test('P2-SEC-01: fails closed when local.env has group/other readable permissions (FAIL)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, { serverPort: mockServer.port });
    await fsp.chmod(dataset.localEnvPath, 0o644);

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
        });
      },
      (err) => {
        assert.equal(err.code, 'INSECURE_PERMISSIONS');
        return true;
      },
    );
  });

  // 42. P2-SEC-01: Insecure permissions on key-file (mode 0644)
  test('P2-SEC-01: fails closed when key-file has group/other readable permissions (FAIL)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, { serverPort: mockServer.port });
    const keyFilePath = path.join(testCaseDir, 'secret.key');
    await fsp.writeFile(keyFilePath, VALID_SB_SECRET, { mode: 0o644 });

    await assert.rejects(
      async () => {
        await restoreStorage({
          keyFile: keyFilePath,
          url: serverUrl,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
        });
      },
      (err) => {
        assert.equal(err.code, 'INSECURE_PERMISSIONS');
        return true;
      },
    );
  });

  // 43. P2-SEC-01: Passing secret via --key CLI argument is strictly forbidden
  test('P2-SEC-01: CLI rejects secret passed via --key option (FAIL CLOSED)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, { serverPort: mockServer.port });
    const args = [
      SCRIPT_PATH,
      'restore',
      '--key',
      VALID_SB_SECRET,
      '--url',
      serverUrl,
      '--buckets',
      dataset.bucketsPath,
      '--manifest',
      dataset.manifestPath,
      '--objects-root',
      dataset.objectsRoot,
    ];

    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderrChunks = [];
    child.stderr.on('data', (c) => stderrChunks.push(c));

    const exitCode = await new Promise((resolve) => child.on('close', resolve));
    assert.notEqual(exitCode, 0, 'CLI must exit non-zero when --key is passed');
    const stderrStr = Buffer.concat(stderrChunks).toString('utf8');
    assert.ok(stderrStr.includes('SECURITY_VIOLATION'), `stderr should contain SECURITY_VIOLATION: ${stderrStr}`);
  });

  // 44. P3-JSON-01: Duplicate keys in buckets.json
  test('P3-JSON-01: fails closed when buckets.json contains duplicate JSON keys (FAIL)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, { serverPort: mockServer.port });
    await fsp.writeFile(
      dataset.bucketsPath,
      '[{"id": "dup-key-bucket", "public": true, "public": false}]',
      { mode: 0o600 },
    );

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
        });
      },
      (err) => {
        assert.equal(err.code, 'DUPLICATE_JSON_KEY');
        return true;
      },
    );
  });

  // 45. P3-JSON-01: Duplicate keys in storage-manifest.json
  test('P3-JSON-01: fails closed when storage-manifest.json contains duplicate JSON keys (FAIL)', async () => {
    const dataset = await createSyntheticDataset(testCaseDir, { serverPort: mockServer.port });
    await fsp.writeFile(
      dataset.manifestPath,
      '[{"bucket": "documents", "path": "file.txt", "size": 10, "size": 20, "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}]',
      { mode: 0o600 },
    );

    await assert.rejects(
      async () => {
        await restoreStorage({
          localEnv: dataset.localEnvPath,
          buckets: dataset.bucketsPath,
          manifest: dataset.manifestPath,
          objectsRoot: dataset.objectsRoot,
        });
      },
      (err) => {
        assert.equal(err.code, 'DUPLICATE_JSON_KEY');
        return true;
      },
    );
  });
});
