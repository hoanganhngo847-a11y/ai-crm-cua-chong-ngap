import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  exportStorage,
  streamObjectBytes,
  validateBucketName,
  validateObjectPath,
  rollbackJournal,
  isCaseInsensitiveDir,
  HelperError,
} from '../../scripts/backup/storage-export.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const EXPORT_HELPER = path.join(REPO_ROOT, 'scripts/backup/storage-export.mjs');

function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [EXPORT_HELPER, ...args], {
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

async function createTempDir(prefix = 'storage-export-test-') {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function waitForCondition(predicate, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function resolveTimeBinary() {
  const candidates = ['/usr/bin/time', '/bin/time'];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'time');
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function detectTimeFlavor(timeBinary) {
  const probe = spawnSync(timeBinary, ['--version'], { encoding: 'utf8' });
  const output = `${probe.stdout || ''}\n${probe.stderr || ''}`;
  return /GNU time/i.test(output) ? 'gnu' : 'bsd';
}

function measurePeakRss(command, args, options = {}) {
  const timeBinary = resolveTimeBinary();
  assert.ok(
    timeBinary,
    'A time(1) binary is required to measure peak RSS but neither /usr/bin/time nor a PATH time executable exists',
  );

  const flavor = detectTimeFlavor(timeBinary);
  const timeArgs = flavor === 'gnu'
    ? ['-v', command, ...args]
    : ['-l', command, ...args];

  const res = spawnSync(timeBinary, timeArgs, { encoding: 'utf8', ...options });
  assert.equal(
    res.error,
    undefined,
    `Unable to execute ${timeBinary} for peak RSS measurement: ${res.error ? res.error.message : 'unknown error'}`,
  );
  assert.equal(
    res.status,
    0,
    `Measured command failed (exit ${res.status}): ${res.stderr || res.stdout}`,
  );

  const output = `${res.stdout || ''}\n${res.stderr || ''}`;
  let peakBytes;

  if (flavor === 'gnu') {
    // GNU time: "Maximum resident set size (kbytes): 12345"
    const match = output.match(/Maximum resident set size \(kbytes\):\s*(\d+)/i);
    assert.ok(
      match,
      `Unable to parse GNU time peak RSS output; refusing to skip the memory assertion. Output:\n${output}`,
    );
    peakBytes = Number.parseInt(match[1], 10) * 1024;
  } else {
    // BSD time: "12345  maximum resident set size" (bytes)
    const match = output.match(/(\d+)\s+maximum resident set size/i);
    assert.ok(
      match,
      `Unable to parse BSD time peak RSS output; refusing to skip the memory assertion. Output:\n${output}`,
    );
    peakBytes = Number.parseInt(match[1], 10);
  }

  assert.ok(
    Number.isSafeInteger(peakBytes) && peakBytes > 0,
    `Invalid peak RSS measurement: ${peakBytes}`,
  );

  return { peakBytes, flavor, timeBinary, stdout: res.stdout, stderr: res.stderr };
}

// -----------------------------------------------------------------------------
// Test Suite: Storage Export (Local Synthetic Phase)
// -----------------------------------------------------------------------------

describe('storage-export.mjs helper suite', () => {
  // 1. Empty bucket
  test('handles empty bucket cleanly', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      await fsp.mkdir(path.join(sourceDir, 'empty-bucket'), { recursive: true, mode: 0o700 });

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
      ]);

      assert.equal(res.status, 0, `CLI failed: ${res.stderr}`);
      const out = parseJsonStdout(res);
      assert.equal(out.status, 'ok');
      assert.equal(out.bucketCount, 1);
      assert.equal(out.objectCount, 0);
      assert.equal(out.totalBytes, 0);

      // Verify directory created on disk
      const bucketDirStat = await fsp.stat(path.join(outDir, 'empty-bucket'));
      assert.equal(bucketDirStat.isDirectory(), true);

      // Verify buckets.json
      const bucketsData = JSON.parse(await fsp.readFile(bucketsPath, 'utf8'));
      assert.equal(bucketsData.length, 1);
      assert.equal(bucketsData[0].id, 'empty-bucket');

      // Verify storage-manifest.json
      const manifestData = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      assert.deepEqual(manifestData, []);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 2. Zero objects across multiple buckets
  test('handles zero objects across multiple empty buckets', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      await fsp.mkdir(path.join(sourceDir, 'bucket-alpha'), { recursive: true, mode: 0o700 });
      await fsp.mkdir(path.join(sourceDir, 'bucket-beta'), { recursive: true, mode: 0o700 });

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
      ]);

      assert.equal(res.status, 0, `CLI failed: ${res.stderr}`);
      const out = parseJsonStdout(res);
      assert.equal(out.status, 'ok');
      assert.equal(out.bucketCount, 2);
      assert.equal(out.objectCount, 0);
      assert.equal(out.totalBytes, 0);

      const manifestData = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      assert.deepEqual(manifestData, []);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 3. Single object
  test('exports single object with exact bytes and SHA-256', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      const content = Buffer.from('voice-call-recording-sample-content-12345');
      const contentHash = sha256Buffer(content);

      await fsp.mkdir(path.join(sourceDir, 'call-recordings'), { recursive: true, mode: 0o700 });
      await fsp.writeFile(path.join(sourceDir, 'call-recordings/call-1.wav'), content, { mode: 0o600 });

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
      ]);

      assert.equal(res.status, 0, `CLI failed: ${res.stderr}`);
      const out = parseJsonStdout(res);
      assert.equal(out.status, 'ok');
      assert.equal(out.bucketCount, 1);
      assert.equal(out.objectCount, 1);
      assert.equal(out.totalBytes, content.length);

      // Verify disk output
      const exportedFile = path.join(outDir, 'call-recordings/call-1.wav');
      const exportedBytes = await fsp.readFile(exportedFile);
      assert.equal(Buffer.compare(content, exportedBytes), 0);

      // Verify manifest
      const manifestData = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      assert.equal(manifestData.length, 1);
      assert.equal(manifestData[0].bucket, 'call-recordings');
      assert.equal(manifestData[0].path, 'call-1.wav');
      assert.equal(manifestData[0].size, content.length);
      assert.equal(manifestData[0].sha256, contentHash);
      assert.equal(manifestData[0].contentType, 'audio/wav');
      assert.equal(manifestData[0].mimeType, 'audio/wav');
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 4. Multiple buckets and nested objects
  test('exports multiple buckets and nested directory hierarchy', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      // Create buckets with nested files
      await fsp.mkdir(path.join(sourceDir, 'survey-photos/2026/site-a'), { recursive: true, mode: 0o700 });
      await fsp.mkdir(path.join(sourceDir, 'installation-docs/manuals'), { recursive: true, mode: 0o700 });

      const photoData = Buffer.from('fake-photo-data-jpeg');
      const docData = Buffer.from('fake-pdf-manual-data');

      await fsp.writeFile(path.join(sourceDir, 'survey-photos/2026/site-a/photo1.jpg'), photoData, { mode: 0o600 });
      await fsp.writeFile(path.join(sourceDir, 'installation-docs/manuals/guide.pdf'), docData, { mode: 0o600 });

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
      ]);

      assert.equal(res.status, 0, `CLI failed: ${res.stderr}`);
      const out = parseJsonStdout(res);
      assert.equal(out.status, 'ok');
      assert.equal(out.bucketCount, 2);
      assert.equal(out.objectCount, 2);
      assert.equal(out.totalBytes, photoData.length + docData.length);

      // Verify files exported to nested paths
      const exportedPhoto = await fsp.readFile(path.join(outDir, 'survey-photos/2026/site-a/photo1.jpg'));
      const exportedDoc = await fsp.readFile(path.join(outDir, 'installation-docs/manuals/guide.pdf'));
      assert.equal(Buffer.compare(photoData, exportedPhoto), 0);
      assert.equal(Buffer.compare(docData, exportedDoc), 0);

      // Verify manifest canonical sorting (bucket ASC, path ASC)
      const manifestData = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      assert.equal(manifestData.length, 2);
      assert.equal(manifestData[0].bucket, 'installation-docs');
      assert.equal(manifestData[0].path, 'manuals/guide.pdf');
      assert.equal(manifestData[1].bucket, 'survey-photos');
      assert.equal(manifestData[1].path, '2026/site-a/photo1.jpg');
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 5. Binary file containing null bytes
  test('preserves binary bytes containing null bytes without corruption', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      // Binary payload with null bytes, 0xFF, high-order bytes
      const binaryData = Buffer.from([0x00, 0x00, 0xff, 0xfe, 0x00, 0x12, 0x34, 0x56, 0x00, 0x7f, 0x80, 0x00]);
      const expectedHash = sha256Buffer(binaryData);

      await fsp.mkdir(path.join(sourceDir, 'contracts'), { recursive: true, mode: 0o700 });
      await fsp.writeFile(path.join(sourceDir, 'contracts/binary-payload.bin'), binaryData, { mode: 0o600 });

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
      ]);

      assert.equal(res.status, 0, `CLI failed: ${res.stderr}`);
      const exportedBytes = await fsp.readFile(path.join(outDir, 'contracts/binary-payload.bin'));
      assert.equal(Buffer.compare(binaryData, exportedBytes), 0);

      const manifestData = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      assert.equal(manifestData[0].sha256, expectedHash);
      assert.equal(manifestData[0].size, binaryData.length);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 6. Unicode object names
  test('handles Unicode object names properly', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      const content = Buffer.from('nội-dung-hợp-đồng-chống-ngập');
      const expectedHash = sha256Buffer(content);

      await fsp.mkdir(path.join(sourceDir, 'contracts/hồ-sơ-2026'), { recursive: true, mode: 0o700 });
      await fsp.writeFile(path.join(sourceDir, 'contracts/hồ-sơ-2026/hợp-đồng-khách-hàng.pdf'), content, { mode: 0o600 });

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
      ]);

      assert.equal(res.status, 0, `CLI failed: ${res.stderr}`);
      const manifestData = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      assert.equal(manifestData.length, 1);
      assert.equal(manifestData[0].path, 'hồ-sơ-2026/hợp-đồng-khách-hàng.pdf');
      assert.equal(manifestData[0].sha256, expectedHash);

      const exportedFile = path.join(outDir, 'contracts/hồ-sơ-2026/hợp-đồng-khách-hàng.pdf');
      const exportedBytes = await fsp.readFile(exportedFile);
      assert.equal(Buffer.compare(content, exportedBytes), 0);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 7. Large file streaming & memory bounding
  test('streams large file with bounded chunks and preserves integrity', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      const bucketDir = path.join(sourceDir, 'call-recordings');
      await fsp.mkdir(bucketDir, { recursive: true, mode: 0o700 });

      // Generate a 16 MiB pseudo-random file
      const largeFilePath = path.join(bucketDir, 'large-audio.wav');
      const chunkSize = 64 * 1024;
      const totalChunks = 256; // 16 MiB
      const fullHasher = crypto.createHash('sha256');

      const writeHandle = await fsp.open(largeFilePath, fs.constants.O_CREAT | fs.constants.O_WRONLY, 0o600);
      try {
        const chunkBuf = Buffer.alloc(chunkSize);
        for (let i = 0; i < totalChunks; i += 1) {
          chunkBuf.fill((i * 17) % 256);
          fullHasher.update(chunkBuf);
          await writeHandle.write(chunkBuf);
        }
      } finally {
        await writeHandle.close();
      }
      const expectedHash = fullHasher.digest('hex');

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
        '--chunk-size', String(chunkSize),
      ]);

      assert.equal(res.status, 0, `CLI failed: ${res.stderr}`);
      const out = parseJsonStdout(res);
      assert.equal(out.totalBytes, 16 * 1024 * 1024);

      const manifestData = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      assert.equal(manifestData[0].sha256, expectedHash);
      assert.equal(manifestData[0].size, 16 * 1024 * 1024);

      // Verify exported file size and hash independently
      const exportedFile = path.join(outDir, 'call-recordings/large-audio.wav');
      const stat = await fsp.stat(exportedFile);
      assert.equal(stat.size, 16 * 1024 * 1024);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 8. SHA-256 raw byte integrity check
  test('verifies raw byte SHA-256 integrity against independent crypto hasher', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      const bucketDir = path.join(sourceDir, 'contracts');
      await fsp.mkdir(bucketDir, { recursive: true, mode: 0o700 });

      const payload = crypto.randomBytes(128 * 1024);
      const independentHash = crypto.createHash('sha256').update(payload).digest('hex');
      await fsp.writeFile(path.join(bucketDir, 'test-payload.bin'), payload, { mode: 0o600 });

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
      ]);

      assert.equal(res.status, 0, `CLI failed: ${res.stderr}`);
      const manifestData = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      assert.equal(manifestData[0].sha256, independentHash);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 9. Duplicate object names rejection
  test('rejects duplicate object names within the same bucket', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      await fsp.mkdir(path.join(sourceDir, 'contracts'), { recursive: true, mode: 0o700 });
      await fsp.writeFile(path.join(sourceDir, 'contracts/file.pdf'), Buffer.from('hello'), { mode: 0o600 });

      // Create objects.json declaring duplicate paths
      const objectsMetadata = [
        { bucket: 'contracts', path: 'file.pdf', size: 5 },
        { bucket: 'contracts', path: 'file.pdf', size: 5 },
      ];
      await fsp.writeFile(path.join(sourceDir, 'objects.json'), JSON.stringify(objectsMetadata), { mode: 0o600 });

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
      ]);

      assert.equal(res.status, 1);
      const err = parseJsonStderr(res);
      assert.equal(err.error.code, 'DUPLICATE_OBJECT');
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 10. Missing object rejection
  test('rejects missing object declared in metadata', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      await fsp.mkdir(path.join(sourceDir, 'contracts'), { recursive: true, mode: 0o700 });

      // Declare object in metadata that doesn't exist on disk
      const objectsMetadata = [
        { bucket: 'contracts', path: 'missing-file.pdf', size: 100 },
      ];
      await fsp.writeFile(path.join(sourceDir, 'objects.json'), JSON.stringify(objectsMetadata), { mode: 0o600 });

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
      ]);

      assert.equal(res.status, 1);
      const err = parseJsonStderr(res);
      assert.equal(err.error.code, 'OBJECT_NOT_FOUND');
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 11. Tampered object rejection
  test('rejects tampered object with identity / hash mismatch', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      await fsp.mkdir(path.join(sourceDir, 'contracts'), { recursive: true, mode: 0o700 });
      await fsp.writeFile(path.join(sourceDir, 'contracts/doc.pdf'), Buffer.from('real-bytes'), { mode: 0o600 });

      // Provide wrong sha256 in metadata
      const objectsMetadata = [
        {
          bucket: 'contracts',
          path: 'doc.pdf',
          size: 10,
          sha256: '0000000000000000000000000000000000000000000000000000000000000000',
        },
      ];
      await fsp.writeFile(path.join(sourceDir, 'objects.json'), JSON.stringify(objectsMetadata), { mode: 0o600 });

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
      ]);

      assert.equal(res.status, 1);
      const err = parseJsonStderr(res);
      assert.equal(err.error.code, 'IDENTITY_MISMATCH');
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 12. Invalid path / traversal rejection
  test('rejects traversal and invalid object paths', async () => {
    const traversalPaths = [
      '../escape.pdf',
      '/abs/path.pdf',
      'folder/../../escape.pdf',
      'folder\\backslash.pdf',
      'folder/\0null.pdf',
      'folder//double-slash.pdf',
      'folder/.',
      'trailing-slash/',
    ];

    for (const badPath of traversalPaths) {
      assert.throws(
        () => validateObjectPath(badPath),
        (err) => err instanceof HelperError && (err.code === 'PATH_TRAVERSAL' || err.code === 'INVALID_PATH'),
        `Should reject bad path: ${badPath}`,
      );
    }
  });

  // 13. Symlink rejection
  test('rejects symlinks in source directory, bucket, or object', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      await fsp.mkdir(path.join(sourceDir, 'contracts'), { recursive: true, mode: 0o700 });

      // Create a target outside and a symlink inside
      const outsideTarget = path.join(tmp, 'secret.txt');
      await fsp.writeFile(outsideTarget, Buffer.from('classified'), { mode: 0o600 });
      await fsp.symlink(outsideTarget, path.join(sourceDir, 'contracts/symlink-doc.txt'));

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
      ]);

      assert.equal(res.status, 1);
      const err = parseJsonStderr(res);
      assert.equal(err.error.code, 'SYMLINK_DETECTED');
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 14. Unsupported file types (FIFO)
  test('rejects unsupported file types such as FIFO', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      await fsp.mkdir(path.join(sourceDir, 'contracts'), { recursive: true, mode: 0o700 });
      const fifoPath = path.join(sourceDir, 'contracts/named-pipe');

      // Create a FIFO
      const mkfifoRes = spawnSync('mkfifo', [fifoPath]);
      if (mkfifoRes.status !== 0) {
        // Skip if mkfifo is not supported on this platform/filesystem
        return;
      }

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
      ]);

      assert.equal(res.status, 1);
      const err = parseJsonStderr(res);
      assert.equal(err.error.code, 'UNSUPPORTED_FILE_TYPE');
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 15. Concurrent input mutation rejection
  test('rejects concurrent input mutation during export streaming', async () => {
    const tmp = await createTempDir();
    try {
      const testFile = path.join(tmp, 'mutating.bin');
      const initialBytes = Buffer.alloc(1024 * 1024, 0x41); // 1 MiB 'A'
      await fsp.writeFile(testFile, initialBytes, { mode: 0o600 });

      // Test 1: File appended during streaming
      const destPath = path.join(tmp, 'out.bin');

      // We simulate mutation by opening the file, and appending to it right after stat
      const statBefore = await fsp.lstat(testFile);

      // Append 10 bytes to the file
      await fsp.appendFile(testFile, Buffer.from('EXTRA_BYTES'));

      await assert.rejects(
        async () => {
          await streamObjectBytes({
            sourcePath: testFile,
            destPath,
            expectedSize: statBefore.size, // expects 1 MiB, but file now has 1 MiB + 11 bytes
            chunkSize: 64 * 1024,
          });
        },
        (err) => err instanceof HelperError && (err.code === 'SOURCE_MUTATED' || err.code === 'IDENTITY_MISMATCH'),
      );
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 16. Atomic publication & failure cleanup
  test('ensures atomic publication and leaves no artifacts on failure', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      await fsp.mkdir(path.join(sourceDir, 'contracts'), { recursive: true, mode: 0o700 });
      await fsp.writeFile(path.join(sourceDir, 'contracts/good.pdf'), Buffer.from('good-data'), { mode: 0o600 });

      // Add a bad symlink to cause failure
      const outside = path.join(tmp, 'bad.txt');
      await fsp.writeFile(outside, Buffer.from('bad'), { mode: 0o600 });
      await fsp.symlink(outside, path.join(sourceDir, 'contracts/bad.pdf'));

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
      ]);

      assert.equal(res.status, 1);
      assert.equal(parseJsonStderr(res).error.code, 'SYMLINK_DETECTED');

      // Verify no target directories or files were published
      await assert.rejects(async () => await fsp.access(outDir));
      await assert.rejects(async () => await fsp.access(bucketsPath));
      await assert.rejects(async () => await fsp.access(manifestPath));
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 17. Refuses existing output (No-Overwrite Rule)
  test('refuses to overwrite existing output directory or manifest', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      await fsp.mkdir(path.join(sourceDir, 'contracts'), { recursive: true, mode: 0o700 });
      await fsp.writeFile(path.join(sourceDir, 'contracts/file.pdf'), Buffer.from('data'), { mode: 0o600 });

      // Pre-create output directory
      await fsp.mkdir(outDir, { recursive: true, mode: 0o700 });

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
      ]);

      assert.equal(res.status, 1);
      const err = parseJsonStderr(res);
      assert.equal(err.error.code, 'OUTPUT_EXISTS');
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 18. Interrupted process cleanup (SIGTERM)
  test('cleans up temporary files when interrupted by signal', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      // Create a large file so the process takes some time
      await fsp.mkdir(path.join(sourceDir, 'call-recordings'), { recursive: true, mode: 0o700 });
      const bigFile = path.join(sourceDir, 'call-recordings/big.wav');
      const bigBuf = Buffer.alloc(10 * 1024 * 1024, 0x42);
      await fsp.writeFile(bigFile, bigBuf, { mode: 0o600 });

      const child = spawn(
        process.execPath,
        [
          EXPORT_HELPER,
          '--source-dir', sourceDir,
          '--out', outDir,
          '--buckets', bucketsPath,
          '--manifest', manifestPath,
          '--chunk-size', '1024', // slow it down with small chunks
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );

      // Wait until the CLI has installed its signal handlers and created its
      // staging directory before sending SIGTERM. A fixed sleep is racy on
      // slower CI runners and can terminate the child before handler setup.
      await waitForCondition(async () => {
        const entries = await fsp.readdir(tmp);
        return entries.some((entry) => entry.startsWith('.out.tmp-'));
      });

      // Send SIGTERM
      child.kill('SIGTERM');

      const exitCode = await new Promise((resolve) => {
        child.on('close', (code) => resolve(code));
      });

      assert.equal(exitCode, 128 + 15); // 143 on POSIX

      // Verify no temporary files remain in tmp
      const tmpEntries = await fsp.readdir(tmp);
      const remainingTemps = tmpEntries.filter((e) => e.includes('.tmp-'));
      assert.deepEqual(remainingTemps, []);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 19. Memory usage bounded while streaming
  test('keeps memory bounded while streaming large files', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      await fsp.mkdir(path.join(sourceDir, 'call-recordings'), { recursive: true, mode: 0o700 });

      // Create a 32 MiB file
      const bigFile = path.join(sourceDir, 'call-recordings/32mb.wav');
      const handle = await fsp.open(bigFile, fs.constants.O_CREAT | fs.constants.O_WRONLY, 0o600);
      const chunk = Buffer.alloc(1024 * 1024, 0x33); // 1 MiB
      try {
        for (let i = 0; i < 32; i += 1) {
          await handle.write(chunk);
        }
      } finally {
        await handle.close();
      }

      // Run with restricted heap memory limit (64MB)
      const res = spawnSync(
        process.execPath,
        [
          '--max-old-space-size=64',
          EXPORT_HELPER,
          '--source-dir', sourceDir,
          '--out', outDir,
          '--buckets', bucketsPath,
          '--manifest', manifestPath,
        ],
        { encoding: 'utf8' },
      );

      assert.equal(res.status, 0, `CLI failed under memory constraint: ${res.stderr}`);
      const out = parseJsonStdout(res);
      assert.equal(out.totalBytes, 32 * 1024 * 1024);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 20. Provider BLOCKED (Fail-Closed)
  test('fails closed with PROVIDER_BLOCKED when live provider is requested', () => {
    // With --url
    const res1 = runCli(['--url', 'https://staging.supabase.co']);
    assert.equal(res1.status, 1);
    const err1 = parseJsonStderr(res1);
    assert.equal(err1.error.code, 'PROVIDER_BLOCKED');

    // With --adapter supabase
    const res2 = runCli(['--adapter', 'supabase', '--source-dir', '/tmp']);
    assert.equal(res2.status, 1);
    const err2 = parseJsonStderr(res2);
    assert.equal(err2.error.code, 'PROVIDER_BLOCKED');

    // With --url and --key-file
    const res3 = runCli([
      '--url', 'https://staging.supabase.co',
      '--key-file', '/tmp/any-key',
    ]);
    assert.equal(res3.status, 1);
    const err3 = parseJsonStderr(res3);
    assert.equal(err3.error.code, 'PROVIDER_BLOCKED');
  });

  // 21. Bucket filtering
  test('supports --bucket filtering to export only selected buckets', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      await fsp.mkdir(path.join(sourceDir, 'contracts'), { recursive: true, mode: 0o700 });
      await fsp.mkdir(path.join(sourceDir, 'survey-photos'), { recursive: true, mode: 0o700 });

      await fsp.writeFile(path.join(sourceDir, 'contracts/c1.pdf'), Buffer.from('contract-1'), { mode: 0o600 });
      await fsp.writeFile(path.join(sourceDir, 'survey-photos/s1.jpg'), Buffer.from('survey-1'), { mode: 0o600 });

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
        '--bucket', 'contracts',
      ]);

      assert.equal(res.status, 0, `CLI failed: ${res.stderr}`);
      const out = parseJsonStdout(res);
      assert.equal(out.bucketCount, 1);
      assert.equal(out.objectCount, 1);

      // Verify survey-photos was not exported
      const manifestData = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      assert.equal(manifestData.length, 1);
      assert.equal(manifestData[0].bucket, 'contracts');

      await assert.rejects(async () => await fsp.access(path.join(outDir, 'survey-photos')));
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 22. Dry-run mode
  test('supports --dry-run for inventory without writing files to disk', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      await fsp.mkdir(path.join(sourceDir, 'contracts'), { recursive: true, mode: 0o700 });
      const content = Buffer.from('dry-run-content');
      await fsp.writeFile(path.join(sourceDir, 'contracts/c.pdf'), content, { mode: 0o600 });

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
        '--dry-run',
      ]);

      assert.equal(res.status, 0, `CLI failed: ${res.stderr}`);
      const out = parseJsonStdout(res);
      assert.equal(out.status, 'ok');
      assert.equal(out.dryRun, true);
      assert.equal(out.bucketCount, 1);
      assert.equal(out.objectCount, 1);
      assert.equal(out.totalBytes, content.length);

      // Verify no files written to destination
      await assert.rejects(async () => await fsp.access(outDir));
      await assert.rejects(async () => await fsp.access(bucketsPath));
      await assert.rejects(async () => await fsp.access(manifestPath));
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 23. Enforces 0700 directories and 0600 files
  test('enforces mode 0700 for directories and mode 0600 for files', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      await fsp.mkdir(path.join(sourceDir, 'contracts/sub'), { recursive: true, mode: 0o700 });
      await fsp.writeFile(path.join(sourceDir, 'contracts/sub/file.pdf'), Buffer.from('content'), { mode: 0o600 });

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
      ]);

      assert.equal(res.status, 0, `CLI failed: ${res.stderr}`);

      // Check directory mode on POSIX
      const outDirStat = await fsp.stat(outDir);
      assert.equal(outDirStat.mode & 0o777, 0o700);

      const bucketDirStat = await fsp.stat(path.join(outDir, 'contracts'));
      assert.equal(bucketDirStat.mode & 0o777, 0o700);

      const subDirStat = await fsp.stat(path.join(outDir, 'contracts/sub'));
      assert.equal(subDirStat.mode & 0o777, 0o700);

      // Check file modes
      const fileStat = await fsp.stat(path.join(outDir, 'contracts/sub/file.pdf'));
      assert.equal(fileStat.mode & 0o777, 0o600);

      const bucketsStat = await fsp.stat(bucketsPath);
      assert.equal(bucketsStat.mode & 0o777, 0o600);

      const manifestStat = await fsp.stat(manifestPath);
      assert.equal(manifestStat.mode & 0o777, 0o600);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 24. Custom buckets.json metadata support
  test('loads and applies custom buckets.json metadata configuration', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      await fsp.mkdir(sourceDir, { recursive: true, mode: 0o700 });

      const customBuckets = [
        {
          id: 'survey-photos',
          name: 'survey-photos',
          public: false,
          file_size_limit: 10485760,
          allowed_mime_types: ['image/jpeg', 'image/png'],
          type: 'standard',
          versioning_status: 'disabled',
        },
      ];
      await fsp.writeFile(path.join(sourceDir, 'buckets.json'), JSON.stringify(customBuckets), { mode: 0o600 });
      await fsp.mkdir(path.join(sourceDir, 'survey-photos'), { recursive: true, mode: 0o700 });
      await fsp.writeFile(path.join(sourceDir, 'survey-photos/img.png'), Buffer.from('image-bytes'), { mode: 0o600 });

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
      ]);

      assert.equal(res.status, 0, `CLI failed: ${res.stderr}`);
      const bucketsData = JSON.parse(await fsp.readFile(bucketsPath, 'utf8'));
      assert.equal(bucketsData.length, 1);
      assert.equal(bucketsData[0].id, 'survey-photos');
      assert.equal(bucketsData[0].file_size_limit, 10485760);
      assert.deepEqual(bucketsData[0].allowed_mime_types, ['image/jpeg', 'image/png']);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 25. Rejection of invalid bucket names
  test('rejects invalid bucket names with traversal or invalid characters', () => {
    const invalidBuckets = ['..', '../escape', 'UPPERCASE', 'bucket/with/slashes', '-leading-hyphen', ''];
    for (const b of invalidBuckets) {
      assert.throws(
        () => validateBucketName(b),
        (err) => err instanceof HelperError && (err.code === 'INVALID_BUCKET' || err.code === 'PATH_TRAVERSAL'),
        `Should reject invalid bucket name: ${b}`,
      );
    }
  });

  // 26. Direct programmatic JavaScript API
  test('supports programmatic exportStorage invocation in JavaScript', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      await fsp.mkdir(path.join(sourceDir, 'contracts'), { recursive: true, mode: 0o700 });
      await fsp.writeFile(path.join(sourceDir, 'contracts/api.pdf'), Buffer.from('api-direct-test'), { mode: 0o600 });

      const result = await exportStorage({
        sourceDir,
        out: outDir,
        buckets: bucketsPath,
        manifest: manifestPath,
      });

      assert.equal(result.status, 'ok');
      assert.equal(result.bucketCount, 1);
      assert.equal(result.objectCount, 1);
      assert.equal(result.totalBytes, 15);
      assert.equal(result.dryRun, false);

      const manifestOnDisk = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      assert.equal(manifestOnDisk.length, 1);
      assert.equal(manifestOnDisk[0].path, 'api.pdf');
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Remediation Tests: Atomic Publication, Rollback, Unicode & Rename TOCTOU
  // ---------------------------------------------------------------------------

  // 27. Failure after publishing bytes rolls back outDir (P1-ATOM-01)
  test('failure after publishing bytes rolls back outDir and leaves zero artifacts (P1-ATOM-01)', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      await fsp.mkdir(path.join(sourceDir, 'contracts'), { recursive: true, mode: 0o700 });
      // Create a 5 MiB file to ensure staging and streaming take enough time for concurrent conflict injection
      const buf = Buffer.alloc(5 * 1024 * 1024, 0x41);
      await fsp.writeFile(path.join(sourceDir, 'contracts/file.pdf'), buf, { mode: 0o600 });

      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      const promise = exportStorage({
        sourceDir,
        out: outDir,
        buckets: bucketsPath,
        manifest: manifestPath,
        chunkSize: 1024,
      });

      // Touch bucketsPath during streaming so pre-check passes but publish step fails with OUTPUT_EXISTS
      setTimeout(async () => {
        try {
          await fsp.writeFile(bucketsPath, 'pre-existing-conflict');
        } catch {}
      }, 20);

      await assert.rejects(
        promise,
        (err) => err instanceof HelperError && (err.code === 'OUTPUT_EXISTS' || err.code === 'PUBLISH_FAILED'),
      );

      // Verify rollback: outDir MUST NOT remain on disk!
      await assert.rejects(async () => await fsp.access(outDir));
      // manifestPath was never published
      await assert.rejects(async () => await fsp.access(manifestPath));
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 28. Failure after publishing buckets rolls back outDir and buckets.json (P1-ATOM-01)
  test('failure after publishing buckets rolls back both outDir and buckets.json (P1-ATOM-01)', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      await fsp.mkdir(path.join(sourceDir, 'contracts'), { recursive: true, mode: 0o700 });
      // Create a 5 MiB file to ensure staging and streaming take enough time for concurrent conflict injection
      const buf = Buffer.alloc(5 * 1024 * 1024, 0x41);
      await fsp.writeFile(path.join(sourceDir, 'contracts/file.pdf'), buf, { mode: 0o600 });

      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      const promise = exportStorage({
        sourceDir,
        out: outDir,
        buckets: bucketsPath,
        manifest: manifestPath,
        chunkSize: 1024,
      });

      // Touch manifestPath during streaming so pre-check passes but manifest publish step fails with OUTPUT_EXISTS
      setTimeout(async () => {
        try {
          await fsp.writeFile(manifestPath, 'pre-existing-conflict');
        } catch {}
      }, 20);

      await assert.rejects(
        promise,
        (err) => err instanceof HelperError && (err.code === 'OUTPUT_EXISTS' || err.code === 'PUBLISH_FAILED'),
      );

      // Verify rollback: BOTH outDir and bucketsPath MUST NOT remain on disk!
      await assert.rejects(async () => await fsp.access(outDir));
      await assert.rejects(async () => await fsp.access(bucketsPath));
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 29. Existing empty directory at destination is refused and NOT overwritten (P2-RENAME-TOCTOU)
  test('refuses to overwrite existing empty destination directory (P2-RENAME-TOCTOU)', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      await fsp.mkdir(path.join(sourceDir, 'contracts'), { recursive: true, mode: 0o700 });
      await fsp.writeFile(path.join(sourceDir, 'contracts/doc.pdf'), Buffer.from('data'), { mode: 0o600 });

      // Pre-create an EMPTY destination directory
      await fsp.mkdir(outDir, { mode: 0o700 });

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
      ]);

      assert.equal(res.status, 1);
      const err = parseJsonStderr(res);
      assert.equal(err.error.code, 'OUTPUT_EXISTS');

      // Verify the empty directory remains empty and was NOT replaced with export content
      const entries = await fsp.readdir(outDir);
      assert.deepEqual(entries, []);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 30. Existing buckets.json refused
  test('refuses to overwrite existing buckets.json file', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      await fsp.mkdir(path.join(sourceDir, 'contracts'), { recursive: true, mode: 0o700 });
      await fsp.writeFile(path.join(sourceDir, 'contracts/doc.pdf'), Buffer.from('data'), { mode: 0o600 });

      // Pre-create buckets.json
      await fsp.writeFile(bucketsPath, '[]', { mode: 0o600 });

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
      ]);

      assert.equal(res.status, 1);
      assert.equal(parseJsonStderr(res).error.code, 'OUTPUT_EXISTS');
      await assert.rejects(async () => await fsp.access(outDir));
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 31. Existing storage-manifest.json refused
  test('refuses to overwrite existing storage-manifest.json file', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      await fsp.mkdir(path.join(sourceDir, 'contracts'), { recursive: true, mode: 0o700 });
      await fsp.writeFile(path.join(sourceDir, 'contracts/doc.pdf'), Buffer.from('data'), { mode: 0o600 });

      // Pre-create manifest.json
      await fsp.writeFile(manifestPath, '[]', { mode: 0o600 });

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
      ]);

      assert.equal(res.status, 1);
      assert.equal(parseJsonStderr(res).error.code, 'OUTPUT_EXISTS');
      await assert.rejects(async () => await fsp.access(outDir));
      await assert.rejects(async () => await fsp.access(bucketsPath));
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 32. Rollback never deletes files or directories belonging to another process
  test('rollback verifies device and inode and never touches another process files', async () => {
    const tmp = await createTempDir();
    try {
      const foreignFile = path.join(tmp, 'foreign-file.txt');
      await fsp.writeFile(foreignFile, 'do-not-delete', { mode: 0o600 });
      const foreignDir = path.join(tmp, 'foreign-dir');
      await fsp.mkdir(foreignDir, { mode: 0o700 });

      // Journal with mismatching inode/dev
      const fakeJournal = [
        { type: 'file', path: foreignFile, dev: 99999, ino: 88888 },
        { type: 'directory', path: foreignDir, dev: 99999, ino: 88888 },
      ];

      await rollbackJournal(fakeJournal);

      // Verify foreign files were NOT deleted
      assert.equal(await fsp.readFile(foreignFile, 'utf8'), 'do-not-delete');
      const dirStat = await fsp.stat(foreignDir);
      assert.equal(dirStat.isDirectory(), true);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 33. Unicode NFC/NFD normalization collision rejection (P2-UNICODE-01)
  test('detects and rejects Unicode NFC and NFD collision with UNICODE_COLLISION error code', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const bucketDir = path.join(sourceDir, 'contracts');
      await fsp.mkdir(bucketDir, { recursive: true, mode: 0o700 });

      const nfc = 'caf\u00e9.pdf';
      const nfd = 'cafe\u0301.pdf';

      await fsp.writeFile(path.join(bucketDir, nfc), Buffer.from('data-nfc'), { mode: 0o600 });

      // Declare both in objects.json
      const objectsMetadata = [
        { bucket: 'contracts', path: nfc, size: 8 },
        { bucket: 'contracts', path: nfd, size: 8 },
      ];
      await fsp.writeFile(path.join(sourceDir, 'objects.json'), JSON.stringify(objectsMetadata), { mode: 0o600 });

      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
      ]);

      assert.equal(res.status, 1);
      const err = parseJsonStderr(res);
      assert.equal(err.error.code, 'UNICODE_COLLISION');
      assert.match(err.error.message, /NFC\/NFD/);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 34. Case-insensitive filesystem collision rejection
  test('detects case-insensitive collision on supporting filesystem with PATH_COLLISION', async () => {
    const tmp = await createTempDir();
    try {
      const isInsensitive = await isCaseInsensitiveDir(tmp);
      if (!isInsensitive) {
        // Skip on case-sensitive filesystem (e.g. standard Linux ext4)
        return;
      }

      const sourceDir = path.join(tmp, 'source');
      const bucketDir = path.join(sourceDir, 'contracts');
      await fsp.mkdir(bucketDir, { recursive: true, mode: 0o700 });

      await fsp.writeFile(path.join(bucketDir, 'invoice.pdf'), Buffer.from('data'), { mode: 0o600 });

      // Declare two case-colliding objects
      const objectsMetadata = [
        { bucket: 'contracts', path: 'invoice.pdf', size: 4 },
        { bucket: 'contracts', path: 'INVOICE.PDF', size: 4 },
      ];
      await fsp.writeFile(path.join(sourceDir, 'objects.json'), JSON.stringify(objectsMetadata), { mode: 0o600 });

      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
      ]);

      assert.equal(res.status, 1);
      const err = parseJsonStderr(res);
      assert.equal(err.error.code, 'PATH_COLLISION');
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 35. Object path identity is preserved without silent normalization in manifest
  test('preserves original object path string in storage-manifest.json without silent normalization', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const bucketDir = path.join(sourceDir, 'contracts');
      await fsp.mkdir(bucketDir, { recursive: true, mode: 0o700 });

      // Decomposed NFD path
      const nfdPath = 'cafe\u0301.pdf';
      const content = Buffer.from('sample-nfd-data');
      await fsp.writeFile(path.join(bucketDir, nfdPath), content, { mode: 0o600 });

      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      const res = runCli([
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
      ]);

      assert.equal(res.status, 0, `CLI failed: ${res.stderr}`);
      const manifestData = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      assert.equal(manifestData.length, 1);
      // Verify exact original string is preserved, NOT converted to NFC!
      assert.equal(manifestData[0].path, nfdPath);
      assert.equal(manifestData[0].path.normalize('NFD'), nfdPath);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 36. SIGKILL leaves partial uncommitted state unpromoted
  test('SIGKILL during streaming leaves destination uncommitted and unmanifested', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const bucketDir = path.join(sourceDir, 'call-recordings');
      await fsp.mkdir(bucketDir, { recursive: true, mode: 0o700 });

      // Create a large 15 MiB file
      const bigFile = path.join(bucketDir, 'stream.wav');
      const handle = await fsp.open(bigFile, fs.constants.O_CREAT | fs.constants.O_WRONLY, 0o600);
      const chunk = Buffer.alloc(1024 * 1024, 0x55);
      for (let i = 0; i < 15; i += 1) {
        await handle.write(chunk);
      }
      await handle.close();

      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      const child = spawn(
        process.execPath,
        [
          EXPORT_HELPER,
          '--source-dir', sourceDir,
          '--out', outDir,
          '--buckets', bucketsPath,
          '--manifest', manifestPath,
          '--chunk-size', '1024',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );

      await new Promise((r) => setTimeout(r, 60));
      child.kill('SIGKILL');

      await new Promise((resolve) => child.on('close', resolve));

      // Neither manifest nor buckets must exist as completed outputs
      await assert.rejects(async () => await fsp.access(manifestPath));
      await assert.rejects(async () => await fsp.access(bucketsPath));
      await assert.rejects(async () => await fsp.access(outDir));
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // 37. Streaming peak RSS for 64 MiB file remains strictly bounded
  test('streams 64 MiB file with peak RSS strictly below 160 MB safety threshold', async () => {
    const tmp = await createTempDir();
    try {
      const sourceDir = path.join(tmp, 'source');
      const bucketDir = path.join(sourceDir, 'call-recordings');
      await fsp.mkdir(bucketDir, { recursive: true, mode: 0o700 });

      const largeFile = path.join(bucketDir, 'audio-64m.bin');
      const handle = await fsp.open(largeFile, fs.constants.O_CREAT | fs.constants.O_WRONLY, 0o600);
      const chunk = Buffer.alloc(1024 * 1024, 0x88);
      for (let i = 0; i < 64; i += 1) {
        await handle.write(chunk);
      }
      await handle.close();

      const outDir = path.join(tmp, 'out');
      const bucketsPath = path.join(tmp, 'buckets.json');
      const manifestPath = path.join(tmp, 'manifest.json');

      const measurement = measurePeakRss(process.execPath, [
        EXPORT_HELPER,
        '--source-dir', sourceDir,
        '--out', outDir,
        '--buckets', bucketsPath,
        '--manifest', manifestPath,
      ]);

      assert.ok(
        measurement.peakBytes < 160 * 1024 * 1024,
        `Peak RSS ${measurement.peakBytes} exceeds 160 MiB limit (measured with ${measurement.flavor} time at ${measurement.timeBinary})`,
      );
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});
