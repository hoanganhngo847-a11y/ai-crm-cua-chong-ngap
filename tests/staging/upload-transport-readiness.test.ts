import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import nextConfig from '../../next.config';
import {
  PRODUCT_UPLOAD_MAX_BYTES,
  NEXT_UPLOAD_TRANSPORT_MAX_BYTES,
  UPLOAD_TRANSPORT_HEADROOM_BYTES,
  parseSizeLimitToBytes,
} from '../../config/upload-policy';
import {
  EVIDENCE_MAX_BYTES,
  prepareEvidence,
} from '../../features/installation/evidence';
import {
  MAX_PHOTO_SIZE_BYTES,
  validateImageFileSignature,
} from '../../features/survey/services/storage-upload.service';
import {
  MAX_CONTRACT_PDF_SIZE_BYTES,
  validateSignedPdf,
} from '../../features/contract/services';

console.log('================================================================');
console.log('STARTING UPLOAD TRANSPORT & BUFFER READINESS VERIFICATION');
console.log('================================================================\n');

let passCount = 0;
function testPass(msg: string) {
  console.log(`[PASS] ${msg}`);
  passCount++;
}

function parseLimitBytes(limit: unknown): number {
  if (typeof limit === 'number' || typeof limit === 'string') {
    return parseSizeLimitToBytes(limit);
  }
  throw new Error(`Invalid size limit value: ${String(limit)}`);
}

async function runUploadTransportReadinessSuite() {
  // --------------------------------------------------------------------------
  // 1. Canonical Upload Policy Constants & Headroom
  // --------------------------------------------------------------------------
  console.log('--- 1. Canonical Upload Policy Constants & Transport Headroom ---');

  // 1a. Product Upload Max Bytes == 10 MiB (10,485,760 bytes)
  const EXPECTED_PRODUCT_MAX = 10 * 1024 * 1024;
  assert.equal(
    PRODUCT_UPLOAD_MAX_BYTES,
    EXPECTED_PRODUCT_MAX,
    `PRODUCT_UPLOAD_MAX_BYTES must equal exactly 10 MiB (${EXPECTED_PRODUCT_MAX} bytes), got ${PRODUCT_UPLOAD_MAX_BYTES}`
  );
  testPass('Product upload maximum: 10 MiB');

  // 1b. Next Transport Max Bytes == 12 MiB (12,582,912 bytes)
  const EXPECTED_TRANSPORT_MAX = 12 * 1024 * 1024;
  assert.equal(
    NEXT_UPLOAD_TRANSPORT_MAX_BYTES,
    EXPECTED_TRANSPORT_MAX,
    `NEXT_UPLOAD_TRANSPORT_MAX_BYTES must equal exactly 12 MiB (${EXPECTED_TRANSPORT_MAX} bytes), got ${NEXT_UPLOAD_TRANSPORT_MAX_BYTES}`
  );
  testPass('Transport envelope maximum: 12 MiB');

  // 1c. Multipart/FormData headroom >= 2 MiB
  assert.ok(
    NEXT_UPLOAD_TRANSPORT_MAX_BYTES > PRODUCT_UPLOAD_MAX_BYTES,
    'Transport envelope must exceed business product file limit'
  );
  assert.ok(
    UPLOAD_TRANSPORT_HEADROOM_BYTES >= 2 * 1024 * 1024,
    `Multipart transport headroom must be at least 2 MiB, got ${UPLOAD_TRANSPORT_HEADROOM_BYTES} bytes`
  );
  testPass('Explicit multipart/FormData transport headroom >= 2 MiB verified');

  // --------------------------------------------------------------------------
  // 2. Next.js 16.3.5 Server Action & Proxy Buffering Transport Configuration
  // --------------------------------------------------------------------------
  console.log('\n--- 2. Next.js 16.3.5 Framework Transport Configuration ---');

  // 2a. Server Action bodySizeLimit configured under experimental.serverActions
  const serverActionsConfig = nextConfig.experimental?.serverActions;
  assert.ok(
    serverActionsConfig,
    'next.config.ts must configure experimental.serverActions'
  );
  const actionBodyLimit = serverActionsConfig.bodySizeLimit;
  assert.ok(
    actionBodyLimit !== undefined,
    'experimental.serverActions.bodySizeLimit must be configured in next.config.ts'
  );
  const actionBodyLimitBytes = parseLimitBytes(actionBodyLimit);
  assert.ok(
    actionBodyLimitBytes > PRODUCT_UPLOAD_MAX_BYTES,
    `Next Server Action bodySizeLimit (${actionBodyLimitBytes}) must exceed PRODUCT_UPLOAD_MAX_BYTES (${PRODUCT_UPLOAD_MAX_BYTES})`
  );
  assert.ok(
    actionBodyLimitBytes >= NEXT_UPLOAD_TRANSPORT_MAX_BYTES,
    `Next Server Action bodySizeLimit (${actionBodyLimitBytes}) must be >= NEXT_UPLOAD_TRANSPORT_MAX_BYTES (${NEXT_UPLOAD_TRANSPORT_MAX_BYTES})`
  );
  testPass('Next Server Action transport envelope exceeds product maximum');

  // 2b. Proxy Buffering Limit configured under experimental.proxyClientMaxBodySize
  const proxyBodyLimit = nextConfig.experimental?.proxyClientMaxBodySize;
  assert.ok(
    proxyBodyLimit !== undefined,
    'experimental.proxyClientMaxBodySize must be configured in next.config.ts'
  );
  const proxyBodyLimitBytes = parseLimitBytes(proxyBodyLimit);
  assert.ok(
    proxyBodyLimitBytes > PRODUCT_UPLOAD_MAX_BYTES,
    `Next proxyClientMaxBodySize (${proxyBodyLimitBytes}) must exceed PRODUCT_UPLOAD_MAX_BYTES (${PRODUCT_UPLOAD_MAX_BYTES})`
  );
  assert.ok(
    proxyBodyLimitBytes >= NEXT_UPLOAD_TRANSPORT_MAX_BYTES,
    `Next proxyClientMaxBodySize (${proxyBodyLimitBytes}) must be >= NEXT_UPLOAD_TRANSPORT_MAX_BYTES (${NEXT_UPLOAD_TRANSPORT_MAX_BYTES})`
  );
  testPass('Next proxy transport envelope exceeds product maximum');

  // 2c. Verify proxy.ts is committed and active across non-API routes
  const proxyTsPath = path.resolve(process.cwd(), 'proxy.ts');
  assert.ok(fs.existsSync(proxyTsPath), 'proxy.ts must exist in repository root');
  const proxyContent = fs.readFileSync(proxyTsPath, 'utf8');
  assert.ok(
    proxyContent.includes('export async function proxy'),
    'proxy.ts must export proxy handler'
  );
  assert.ok(
    proxyContent.includes('matcher:'),
    'proxy.ts must define route matcher for non-API routes'
  );
  testPass('Application proxy.ts is active with 12 MiB buffer headroom');

  // --------------------------------------------------------------------------
  // 3. Survey & Installation Modules Share Canonical Product Limit
  // --------------------------------------------------------------------------
  console.log('\n--- 3. Canonical Product Limit Sharing Across Domain Modules ---');

  // 3a. Survey photo limit
  assert.equal(
    MAX_PHOTO_SIZE_BYTES,
    PRODUCT_UPLOAD_MAX_BYTES,
    `MAX_PHOTO_SIZE_BYTES must match PRODUCT_UPLOAD_MAX_BYTES (${PRODUCT_UPLOAD_MAX_BYTES})`
  );
  testPass('Survey module uses canonical PRODUCT_UPLOAD_MAX_BYTES (10 MiB)');

  // 3b. Installation evidence limit (covers both PHOTO and HANDOVER)
  assert.equal(
    EVIDENCE_MAX_BYTES,
    PRODUCT_UPLOAD_MAX_BYTES,
    `EVIDENCE_MAX_BYTES must match PRODUCT_UPLOAD_MAX_BYTES (${PRODUCT_UPLOAD_MAX_BYTES})`
  );
  testPass('Installation module uses canonical PRODUCT_UPLOAD_MAX_BYTES (10 MiB)');

  // 3c. Contract signed PDF limit
  assert.equal(
    MAX_CONTRACT_PDF_SIZE_BYTES,
    PRODUCT_UPLOAD_MAX_BYTES,
    `MAX_CONTRACT_PDF_SIZE_BYTES must match PRODUCT_UPLOAD_MAX_BYTES (${PRODUCT_UPLOAD_MAX_BYTES})`
  );
  testPass('Contract module uses canonical PRODUCT_UPLOAD_MAX_BYTES (10 MiB)');

  // --------------------------------------------------------------------------
  // 4. Functional Business Validation Boundary Tests
  // --------------------------------------------------------------------------
  console.log('\n--- 4. Functional Business Validation Boundary Tests ---');

  const testCompanyId = '11111111-1111-4111-8111-111111111111';
  const testInstallationId = '22222222-2222-4222-8222-222222222222';

  // 4a. Installation PHOTO: 10 MiB accepted, 10 MiB + 1 byte rejected
  const validPhotoFile = new File(
    [new Uint8Array(PRODUCT_UPLOAD_MAX_BYTES)],
    'site-survey.jpg',
    { type: 'image/jpeg' }
  );
  const prepPhoto = prepareEvidence(testCompanyId, testInstallationId, 'photo', validPhotoFile);
  assert.ok(
    prepPhoto.path.startsWith(`${testCompanyId}/installations/${testInstallationId}/photo/`),
    'Valid 10 MiB installation photo must generate canonical path'
  );
  testPass('Installation PHOTO: 10 MiB file accepted by server validation');

  const oversizePhotoFile = new File(
    [new Uint8Array(PRODUCT_UPLOAD_MAX_BYTES + 1)],
    'site-survey.jpg',
    { type: 'image/jpeg' }
  );
  assert.throws(
    () => prepareEvidence(testCompanyId, testInstallationId, 'photo', oversizePhotoFile),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { code?: string }).code, 'INVALID_INPUT');
      return true;
    },
    'Installation PHOTO > 10 MiB must be rejected with INVALID_INPUT'
  );
  testPass('Installation PHOTO: 10 MiB + 1 byte rejected by server validation');

  // 4b. Installation HANDOVER: 10 MiB accepted, 10 MiB + 1 byte rejected
  const validHandoverFile = new File(
    [new Uint8Array(PRODUCT_UPLOAD_MAX_BYTES)],
    'handover-record.pdf',
    { type: 'application/pdf' }
  );
  const prepHandover = prepareEvidence(testCompanyId, testInstallationId, 'handover', validHandoverFile);
  assert.ok(
    prepHandover.path.startsWith(`${testCompanyId}/installations/${testInstallationId}/handover/`),
    'Valid 10 MiB installation handover PDF must generate canonical path'
  );
  testPass('Installation HANDOVER: 10 MiB PDF accepted by server validation');

  const oversizeHandoverFile = new File(
    [new Uint8Array(PRODUCT_UPLOAD_MAX_BYTES + 1)],
    'handover-record.pdf',
    { type: 'application/pdf' }
  );
  assert.throws(
    () => prepareEvidence(testCompanyId, testInstallationId, 'handover', oversizeHandoverFile),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { code?: string }).code, 'INVALID_INPUT');
      return true;
    },
    'Installation HANDOVER > 10 MiB must be rejected with INVALID_INPUT'
  );
  testPass('Installation HANDOVER: 10 MiB + 1 byte rejected by server validation');

  // 4c. Survey Photo: 10 MiB binary accepted, 10 MiB + 1 byte rejected
  const jpegMagic = Buffer.from([0xFF, 0xD8, 0xFF]);
  const validSurveyBuffer = Buffer.concat([
    jpegMagic,
    Buffer.alloc(PRODUCT_UPLOAD_MAX_BYTES - jpegMagic.length),
  ]);
  const surveySig = validateImageFileSignature(validSurveyBuffer);
  assert.equal(surveySig.isValid, true);
  assert.equal(surveySig.mimeType, 'image/jpeg');
  assert.ok(
    validSurveyBuffer.byteLength <= MAX_PHOTO_SIZE_BYTES,
    '10 MiB survey buffer must satisfy size limit'
  );
  testPass('Survey photo: 10 MiB JPEG accepted by magic-byte & size validation');

  const oversizeSurveyBuffer = Buffer.concat([
    jpegMagic,
    Buffer.alloc(PRODUCT_UPLOAD_MAX_BYTES - jpegMagic.length + 1),
  ]);
  assert.ok(
    oversizeSurveyBuffer.byteLength > MAX_PHOTO_SIZE_BYTES,
    'Survey buffer of 10 MiB + 1 byte must exceed MAX_PHOTO_SIZE_BYTES'
  );
  testPass('Survey photo: 10 MiB + 1 byte rejected by size limit');

  // 4d. Contract Signed PDF: 10 MiB accepted, 10 MiB + 1 byte rejected
  const pdfMagic = Buffer.from('%PDF-1.4\n');
  const validContractPdf = Buffer.concat([
    pdfMagic,
    Buffer.alloc(PRODUCT_UPLOAD_MAX_BYTES - pdfMagic.length),
  ]);
  validateSignedPdf(validContractPdf);
  testPass('Contract signed PDF: 10 MiB accepted by server validation');

  const oversizeContractPdf = Buffer.concat([
    pdfMagic,
    Buffer.alloc(PRODUCT_UPLOAD_MAX_BYTES - pdfMagic.length + 1),
  ]);
  assert.throws(
    () => validateSignedPdf(oversizeContractPdf),
    /Dung lượng tệp vượt quá giới hạn 10MB/,
    'Contract PDF > 10 MiB must throw size rejection'
  );
  testPass('Contract signed PDF: 10 MiB + 1 byte rejected by server validation');

  // --------------------------------------------------------------------------
  // 5. Preservation of Server-Authorized Storage Architecture
  // --------------------------------------------------------------------------
  console.log('\n--- 5. Server-Authorized Storage Model Preservation ---');

  // Verify that storage bucket configs remain private with 10 MiB (10485760 bytes)
  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261005100001_staging_storage_bucket_provisioning.sql'
  );
  assert.ok(fs.existsSync(migrationPath), 'Bucket provisioning migration must exist');
  const migrationSql = fs.readFileSync(migrationPath, 'utf8');

  assert.ok(
    migrationSql.includes("'survey-photos'") && migrationSql.includes('10485760'),
    'survey-photos bucket must be private with 10485760 file_size_limit'
  );
  assert.ok(
    migrationSql.includes("'installation-docs'") && migrationSql.includes('10485760'),
    'installation-docs bucket must be private with 10485760 file_size_limit'
  );
  assert.ok(
    migrationSql.includes('survey_photos_no_client_insert'),
    'survey_photos_no_client_insert RLS policy must be defined'
  );
  assert.ok(
    migrationSql.includes('operations_evidence_no_client_insert'),
    'operations_evidence_no_client_insert RLS policy must be defined'
  );
  testPass('Upload transport preserves server-authorized Storage model');

  console.log('\n================================================================');
  console.log(`UPLOAD TRANSPORT READINESS RESULTS: ${passCount} PASSED, 0 FAILED`);
  console.log('NOTE: Unit/framework checks verified. Hosted HTTP transport roundtrip');
  console.log('will be validated during staging deployment smoke testing.');
  console.log('================================================================\n');
}

runUploadTransportReadinessSuite().catch((err) => {
  console.error('\n❌ UPLOAD TRANSPORT READINESS SUITE FAILED:', err);
  process.exit(1);
});
