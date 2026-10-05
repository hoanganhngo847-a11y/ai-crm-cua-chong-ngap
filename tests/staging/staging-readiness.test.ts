import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { GET as responseSlaWorker } from '../../app/api/cron/response-sla-worker/route';
import { GET as voiceScheduler } from '../../app/api/cron/voice-scheduler/route';
import { GET as zaloCare } from '../../app/api/cron/zalo-care/route';

console.log('================================================================');
console.log('STARTING STAGING READINESS GATE VERIFICATION');
console.log('================================================================\n');

let passCount = 0;
function testPass(msg: string) {
  console.log(`[PASS] ${msg}`);
  passCount++;
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

async function runStagingReadinessGate() {
  // --------------------------------------------------------------------------
  // 1. Vercel Hobby Compatibility & External Scheduler Manifest
  // --------------------------------------------------------------------------
  console.log('--- 1. Vercel Hobby Compatibility & External Scheduler Manifest ---');

  // 1a. Vercel Hobby Compatibility: vercel.json must NOT define Vercel-native crons
  const vercelJsonPath = path.resolve(process.cwd(), 'vercel.json');
  assert.ok(fs.existsSync(vercelJsonPath), 'vercel.json must exist');

  const vercelConfig = JSON.parse(fs.readFileSync(vercelJsonPath, 'utf8'));
  assert.ok(
    !vercelConfig.crons || (Array.isArray(vercelConfig.crons) && vercelConfig.crons.length === 0),
    'vercel.json must NOT define Vercel-native high-frequency crons for Vercel Hobby compatibility. Found "crons" array with active jobs.'
  );
  testPass('Vercel Hobby config contains no native high-frequency cron jobs');

  // 1b. External Scheduler Manifest: config/external-scheduler.json
  const schedulerJsonPath = path.resolve(process.cwd(), 'config/external-scheduler.json');
  assert.ok(fs.existsSync(schedulerJsonPath), 'config/external-scheduler.json must exist');

  const schedulerConfig = JSON.parse(fs.readFileSync(schedulerJsonPath, 'utf8'));
  assert.equal(
    schedulerConfig.provider,
    'cron-job.org',
    `Expected scheduler provider "cron-job.org", got "${schedulerConfig.provider}"`
  );
  testPass('External scheduler provider: cron-job.org');

  assert.ok(Array.isArray(schedulerConfig.jobs), 'external-scheduler.json must define a "jobs" array');

  const REQUIRED_EXTERNAL_JOBS: Record<string, { cadence: string; method: string }> = {
    '/api/cron/response-sla-worker': { cadence: '* * * * *', method: 'GET' },
    '/api/cron/voice-scheduler': { cadence: '*/5 * * * *', method: 'GET' },
    '/api/cron/zalo-care': { cadence: '*/15 * * * *', method: 'GET' },
  };

  const jobMap = new Map<string, { name: string; path: string; schedule: string; method: string }>();
  for (const job of schedulerConfig.jobs) {
    jobMap.set(job.path, job);
  }

  for (const [route, expected] of Object.entries(REQUIRED_EXTERNAL_JOBS)) {
    const job = jobMap.get(route);
    assert.ok(job, `Missing job entry in config/external-scheduler.json for ${route}`);
    assert.equal(
      job.schedule,
      expected.cadence,
      `Schedule cadence mismatch for ${route}: expected "${expected.cadence}", got "${job?.schedule}"`
    );
    assert.equal(
      job.method,
      expected.method,
      `HTTP method mismatch for ${route}: expected "${expected.method}", got "${job?.method}"`
    );

    const routeFilePath = path.resolve(process.cwd(), 'app' + route + '/route.ts');
    assert.ok(
      fs.existsSync(routeFilePath),
      `Route implementation file must exist: ${routeFilePath}`
    );

    const jobName = route.replace('/api/cron/', '');
    testPass(`${jobName} cadence: ${expected.cadence}`);
  }

  testPass('All external scheduler route handler files exist in app/api/cron/');

  // 1c. Fail-Closed Authorization Verification for Cron Endpoints
  console.log('\n--- 1c. Cron Endpoints Fail-Closed Authorization ---');
  const cronEndpointDefs = [
    { name: 'response-sla-worker', path: '/api/cron/response-sla-worker', handler: responseSlaWorker },
    { name: 'voice-scheduler', path: '/api/cron/voice-scheduler', handler: voiceScheduler },
    { name: 'zalo-care', path: '/api/cron/zalo-care', handler: zaloCare },
  ];

  const TEST_CRON_SECRET = 'staging-cron-secret-fail-closed-readiness-probe';
  const env = process.env as Record<string, string | undefined>;
  const originalEnvCronSecret = env.CRON_SECRET;
  const originalNodeEnv = env.NODE_ENV;

  try {
    for (const route of cronEndpointDefs) {
      env.CRON_SECRET = TEST_CRON_SECRET;
      delete env.NODE_ENV;

      // 1. Missing Authorization header -> 401
      const reqMissing = new NextRequest(`http://localhost${route.path}`);
      const resMissing = await route.handler(reqMissing);
      assert.equal(resMissing.status, 401, `${route.name} must reject missing Authorization with 401`);

      // 2. Wrong Bearer token -> 401
      const reqWrong = new NextRequest(`http://localhost${route.path}`, {
        headers: { authorization: 'Bearer wrong-bearer-token' },
      });
      const resWrong = await route.handler(reqWrong);
      assert.equal(resWrong.status, 401, `${route.name} must reject wrong Bearer token with 401`);

      // 3. Fake bypass headers without valid token -> 401
      const reqBypass = new NextRequest(`http://localhost${route.path}`, {
        headers: {
          'user-agent': 'vercel-cron/1.0',
          'x-vercel-cron-schedule': '* * * * *',
          'x-forwarded-for': '127.0.0.1',
        },
      });
      const resBypass = await route.handler(reqBypass);
      assert.equal(resBypass.status, 401, `${route.name} must reject fake bypass headers with 401`);

      // 4. Missing CRON_SECRET in production -> 503 fail-closed
      delete env.CRON_SECRET;
      env.NODE_ENV = 'production';
      const reqNoSecret = new NextRequest(`http://localhost${route.path}`);
      const resNoSecret = await route.handler(reqNoSecret);
      assert.equal(resNoSecret.status, 503, `${route.name} must fail closed with 503 when CRON_SECRET is unconfigured in production`);

      // 5. Authorized request with correct staging CRON_SECRET -> reaches worker
      env.CRON_SECRET = TEST_CRON_SECRET;
      env.NODE_ENV = 'production';
      const reqValid = new NextRequest(`http://localhost${route.path}`, {
        headers: { authorization: `Bearer ${TEST_CRON_SECRET}` },
      });
      const resValid = await route.handler(reqValid);
      assert.notEqual(resValid.status, 401, `${route.name} must not reject valid Bearer token with 401`);
      assert.notEqual(resValid.status, 503, `${route.name} must not return 503 when configured and authorized`);
      testPass(`${route.name} fail-closed auth verified (rejects missing/invalid/spoofed with 401, reaches worker on valid Bearer)`);
    }
  } finally {
    env.CRON_SECRET = originalEnvCronSecret;
    env.NODE_ENV = originalNodeEnv;
  }

  // --------------------------------------------------------------------------
  // 2. Environment contract (.env.example)
  // --------------------------------------------------------------------------
  console.log('\n--- 2. Environment Contract (.env.example) ---');
  const envExamplePath = path.resolve(process.cwd(), '.env.example');
  assert.ok(fs.existsSync(envExamplePath), '.env.example must exist');
  const envExampleContent = fs.readFileSync(envExamplePath, 'utf8');

  const REQUIRED_ENV_VARS = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'CRON_SECRET',
    'WEBHOOK_SECRET',
    'PHONE_IDENTITY_HMAC_SECRET',
    'META_APP_SECRET',
    'META_VERIFY_TOKEN',
    'META_GRAPH_VERSION',
    'META_PAGE_ID',
    'META_PAGE_ACCESS_TOKEN',
    'META_PAGE_BINDINGS',
    'OMNICHANNEL_COMPANY_ID',
    'WEBSITE_ORIGIN',
    'WEBSITE_RATE_SECRET',
    'TURNSTILE_SECRET_KEY',
    'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
    'ZALO_APP_ID',
    'ZALO_WEBHOOK_SECRET',
  ];

  for (const envVar of REQUIRED_ENV_VARS) {
    const regex = new RegExp(`(?:^|#\\s*)${envVar}=`, 'm');
    assert.ok(
      regex.test(envExampleContent),
      `Required environment variable "${envVar}" is missing from .env.example`
    );
  }
  testPass(`.env.example documents all ${REQUIRED_ENV_VARS.length} mandatory staging environment variables`);

  // Verify server-only secrets are never exposed with NEXT_PUBLIC_
  const FORBIDDEN_PUBLIC_SECRETS = [
    'NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY',
    'NEXT_PUBLIC_CRON_SECRET',
    'NEXT_PUBLIC_WEBHOOK_SECRET',
    'NEXT_PUBLIC_PHONE_IDENTITY_HMAC_SECRET',
    'NEXT_PUBLIC_META_APP_SECRET',
    'NEXT_PUBLIC_META_PAGE_ACCESS_TOKEN',
    'NEXT_PUBLIC_ZALO_WEBHOOK_SECRET',
    'NEXT_PUBLIC_TURNSTILE_SECRET_KEY',
  ];

  for (const forbidden of FORBIDDEN_PUBLIC_SECRETS) {
    assert.ok(
      !envExampleContent.includes(forbidden),
      `Forbidden public secret exposure found in .env.example: ${forbidden}`
    );
  }
  testPass('No server-only secrets are exposed with NEXT_PUBLIC_ prefix');

  // --------------------------------------------------------------------------
  // 3. Supabase private Storage buckets & configurations
  // --------------------------------------------------------------------------
  console.log('\n--- 3. Supabase Private Storage Buckets & Policies ---');
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: buckets, error: bucketsErr } = await adminClient.storage.listBuckets();
  assert.equal(bucketsErr, null, `Failed to list storage buckets: ${bucketsErr?.message}`);
  assert.ok(Array.isArray(buckets), 'Expected buckets array from storage');

  const bucketMap = new Map(buckets.map((b) => [b.id, b]));

  const REQUIRED_BUCKETS: Record<
    string,
    {
      public: boolean;
      file_size_limit: number;
      allowed_mime_types: string[] | null;
    }
  > = {
    'survey-photos': {
      public: false,
      file_size_limit: 10485760, // 10 MiB
      allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp'],
    },
    'installation-docs': {
      public: false,
      file_size_limit: 10485760, // 10 MiB
      allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    },
    contracts: {
      public: false,
      file_size_limit: 10485760, // 10 MiB
      allowed_mime_types: null,
    },
  };

  for (const [bucketId, expected] of Object.entries(REQUIRED_BUCKETS)) {
    const bucket = bucketMap.get(bucketId);
    assert.ok(bucket, `Required storage bucket "${bucketId}" does not exist in Supabase`);
    assert.equal(
      bucket.public,
      expected.public,
      `Bucket "${bucketId}" public flag mismatch: expected ${expected.public}, got ${bucket.public}`
    );
    assert.equal(
      bucket.file_size_limit,
      expected.file_size_limit,
      `Bucket "${bucketId}" file_size_limit mismatch: expected ${expected.file_size_limit}, got ${bucket.file_size_limit}`
    );

    if (expected.allowed_mime_types !== null) {
      const actualMimes = (bucket.allowed_mime_types || []).slice().sort();
      const expectedMimes = expected.allowed_mime_types.slice().sort();
      assert.deepEqual(
        actualMimes,
        expectedMimes,
        `Bucket "${bucketId}" allowed_mime_types mismatch: expected ${JSON.stringify(
          expectedMimes
        )}, got ${JSON.stringify(actualMimes)}`
      );
    }

    testPass(
      `Bucket "${bucketId}" correctly configured (private, 10MiB limit${expected.allowed_mime_types ? `, MIMEs: ${expected.allowed_mime_types.join(', ')}` : ''
      })`
    );
  }

  // Ensure orphan contract-documents is NOT provisioned
  assert.ok(!bucketMap.has('contract-documents'), 'Orphan bucket "contract-documents" must NOT exist (canonical is "contracts")');
  testPass('Orphan bucket "contract-documents" is not provisioned (canonical is "contracts")');

  // --------------------------------------------------------------------------
  // 4. Storage write authority and client bypass prevention (RLS verification)
  // --------------------------------------------------------------------------
  console.log('\n--- 4. Storage Client Write Authority Restrictions (Valid-MIME RLS Proof) ---');
  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });

  const BUCKET_PROBE_SPECS = [
    {
      bucketId: 'survey-photos',
      fileName: `probe-${Date.now()}.jpg`,
      contentType: 'image/jpeg',
      payload: Buffer.from('\xFF\xD8\xFF\xE0\x00\x10JFIF\x00\x01\x01\x01\x00\x60\x00\x60\x00\x00\xFF\xDB\x00\x43\x00probe-bytes'),
    },
    {
      bucketId: 'installation-docs',
      fileName: `probe-${Date.now()}.jpg`,
      contentType: 'image/jpeg',
      payload: Buffer.from('\xFF\xD8\xFF\xE0\x00\x10JFIF\x00\x01\x01\x01\x00\x60\x00\x60\x00\x00\xFF\xDB\x00\x43\x00probe-bytes'),
    },
    {
      bucketId: 'contracts',
      fileName: `probe-${Date.now()}.pdf`,
      contentType: 'application/pdf',
      payload: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF'),
    },
  ];

  // 4a. Anonymous user direct upload with VALID MIME must be rejected by RLS (not MIME)
  for (const spec of BUCKET_PROBE_SPECS) {
    const { error: anonError } = await anonClient.storage
      .from(spec.bucketId)
      .upload(`anon-${spec.fileName}`, spec.payload, { contentType: spec.contentType });

    assert.ok(
      anonError,
      `Direct anon upload to private bucket "${spec.bucketId}" MUST fail closed under restrictive RLS`
    );
    assert.notEqual(
      (anonError as any)?.statusCode,
      '415',
      `Anon upload to "${spec.bucketId}" was rejected by 415 InvalidMimeType instead of RLS policy`
    );
    assert.ok(
      anonError.message.includes('row-level security') ||
        (anonError as any)?.code === 'AccessDenied' ||
        (anonError as any)?.statusCode === '403',
      `Expected RLS authorization rejection for anon on "${spec.bucketId}", got: ${anonError.message}`
    );
    testPass(`Direct anon upload to "${spec.bucketId}" rejected by RLS using valid MIME (${spec.contentType})`);
  }

  // 4b. Authenticated ordinary user direct upload with VALID MIME must be rejected by RLS
  const testUserEmail = `staging-readiness-${Date.now()}@example.test`;
  const testUserPassword = `StagingPass-${Date.now()}!`;
  const { data: createdUser, error: createUserErr } = await adminClient.auth.admin.createUser({
    email: testUserEmail,
    password: testUserPassword,
    email_confirm: true,
  });
  assert.equal(createUserErr, null, `Failed to create ordinary test user: ${createUserErr?.message}`);
  assert.ok(createdUser?.user?.id, 'Expected user id');

  try {
    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    });
    const { error: signInErr } = await authClient.auth.signInWithPassword({
      email: testUserEmail,
      password: testUserPassword,
    });
    assert.equal(signInErr, null, `Sign-in failed for ordinary test user: ${signInErr?.message}`);

    for (const spec of BUCKET_PROBE_SPECS) {
      const { error: authError } = await authClient.storage
        .from(spec.bucketId)
        .upload(`auth-${spec.fileName}`, spec.payload, { contentType: spec.contentType });

      assert.ok(
        authError,
        `Direct authenticated user upload to private bucket "${spec.bucketId}" MUST fail closed under restrictive RLS`
      );
      assert.notEqual(
        (authError as any)?.statusCode,
        '415',
        `Authenticated upload to "${spec.bucketId}" was rejected by 415 InvalidMimeType instead of RLS policy`
      );
      assert.ok(
        authError.message.includes('row-level security') ||
          (authError as any)?.code === 'AccessDenied' ||
          (authError as any)?.statusCode === '403',
        `Expected RLS authorization rejection for ordinary authenticated user on "${spec.bucketId}", got: ${authError.message}`
      );
      testPass(
        `Direct authenticated user upload to "${spec.bucketId}" rejected by RLS using valid MIME (${spec.contentType})`
      );
    }
  } finally {
    if (createdUser?.user?.id) {
      await adminClient.auth.admin.deleteUser(createdUser.user.id);
    }
  }

  // 4c. SQL-level restrictive policy assertions on storage.objects
  const { executeRawSql } = await import('../helpers/fixture-cleanup');
  const policiesRaw = executeRawSql(
    `SELECT policyname FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND permissive = 'RESTRICTIVE';`
  );
  for (const policyName of [
    'survey_photos_no_client_insert',
    'survey_photos_no_client_update',
    'survey_photos_no_client_delete',
    'operations_evidence_no_client_insert',
    'operations_evidence_no_client_update',
    'operations_evidence_no_client_delete',
    'contracts_no_client_insert',
    'contracts_no_client_update',
    'contracts_no_client_delete',
  ]) {
    assert.ok(policiesRaw.includes(policyName), `Expected restrictive policy "${policyName}" to exist on storage.objects`);
  }
  assert.ok(!policiesRaw.includes('contract_documents_no_client_insert'), 'Orphan policy contract_documents_no_client_insert must not exist');
  testPass('All SQL restrictive RLS policies for runtime buckets verified on storage.objects');

  // 4d. Authorized service-role server upload and signed URL generation succeed
  for (const spec of BUCKET_PROBE_SPECS) {
    const adminPath = `admin-${spec.fileName}`;
    const { error: adminUploadErr } = await adminClient.storage
      .from(spec.bucketId)
      .upload(adminPath, spec.payload, { contentType: spec.contentType });
    assert.equal(adminUploadErr, null, `Admin upload to ${spec.bucketId} failed: ${adminUploadErr?.message}`);

    const { data: signedData, error: signErr } = await adminClient.storage
      .from(spec.bucketId)
      .createSignedUrl(adminPath, 60);
    assert.equal(signErr, null, `Admin createSignedUrl for ${spec.bucketId} failed: ${signErr?.message}`);
    assert.ok(signedData?.signedUrl, `Signed URL should be returned for ${spec.bucketId}`);

    await adminClient.storage.from(spec.bucketId).remove([adminPath]);
    testPass(`Authorized service-role upload and signed URL generation succeed for "${spec.bucketId}"`);
  }

  // --------------------------------------------------------------------------
  // 5. Canonical external webhook ingress endpoints
  // --------------------------------------------------------------------------
  console.log('\n--- 5. Canonical External Callback Routes ---');
  const CANONICAL_CALLBACK_ROUTES = [
    { name: 'Facebook / Meta', path: 'app/api/webhooks/meta/route.ts' },
    { name: 'Zalo OA', path: 'app/api/webhooks/zalo/route.ts' },
    { name: 'Website Lead Form', path: 'app/api/website/leads/route.ts' },
    { name: 'Payment / Bank Transfer', path: 'app/api/webhooks/payment/route.ts' },
    { name: 'Voice Provider', path: 'app/api/webhooks/voice/[routingToken]/route.ts' },
    { name: 'OpenAI Realtime', path: 'app/api/webhooks/openai-realtime/[routingToken]/route.ts' },
  ];

  for (const route of CANONICAL_CALLBACK_ROUTES) {
    const fullPath = path.resolve(process.cwd(), route.path);
    assert.ok(fs.existsSync(fullPath), `Canonical callback endpoint "${route.name}" must exist at ${route.path}`);
    testPass(`Canonical callback endpoint "${route.name}" exists (${route.path})`);
  }

  console.log('\n================================================================');
  console.log(`STAGING READINESS GATE RESULTS: ${passCount} PASSED, 0 FAILED`);
  console.log('================================================================\n');
}

runStagingReadinessGate().catch((err) => {
  console.error('\n❌ STAGING READINESS GATE FAILED:', err);
  process.exit(1);
});
