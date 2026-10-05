import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createClient } from '@supabase/supabase-js';

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
  // 1. Vercel deployment cron configuration
  // --------------------------------------------------------------------------
  console.log('--- 1. Vercel Cron Configuration ---');
  const vercelJsonPath = path.resolve(process.cwd(), 'vercel.json');
  assert.ok(fs.existsSync(vercelJsonPath), 'vercel.json must exist');

  const vercelConfig = JSON.parse(fs.readFileSync(vercelJsonPath, 'utf8'));
  assert.ok(Array.isArray(vercelConfig.crons), 'vercel.json must define a "crons" array');

  const cronRoutes = new Map<string, string>();
  for (const cron of vercelConfig.crons) {
    cronRoutes.set(cron.path, cron.schedule);
  }

  const REQUIRED_CRONS = [
    '/api/cron/response-sla-worker',
    '/api/cron/voice-scheduler',
    '/api/cron/zalo-care',
  ];

  for (const route of REQUIRED_CRONS) {
    assert.ok(cronRoutes.has(route), `Missing required cron route in vercel.json: ${route}`);
  }

  // Response SLA worker must run at least every 5 minutes (preferred every minute "* * * * *")
  const slaSchedule = cronRoutes.get('/api/cron/response-sla-worker');
  assert.ok(slaSchedule, 'Response SLA worker schedule must be defined');
  testPass(`All canonical cron routes scheduled in vercel.json (response-sla-worker: "${slaSchedule}")`);

  // Verify cron route handler files exist
  for (const route of REQUIRED_CRONS) {
    const routeFilePath = path.resolve(process.cwd(), 'app' + route + '/route.ts');
    assert.ok(fs.existsSync(routeFilePath), `Route implementation file must exist: ${routeFilePath}`);
  }
  testPass('All scheduled cron route handler files exist in app/api/cron/');

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
      allowed_mime_types: string[];
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
    'contract-documents': {
      public: false,
      file_size_limit: 10485760, // 10 MiB
      allowed_mime_types: ['application/pdf'],
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
      `Bucket "${bucketId}" correctly configured (private, 10MiB limit${
        expected.allowed_mime_types ? `, MIMEs: ${expected.allowed_mime_types.join(', ')}` : ''
      })`
    );
  }

  // --------------------------------------------------------------------------
  // 4. Storage write authority and client bypass prevention
  // --------------------------------------------------------------------------
  console.log('\n--- 4. Storage Client Write Authority Restrictions ---');
  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });

  const testFilePayload = Buffer.from('unauthorized-payload');

  for (const bucketId of ['survey-photos', 'installation-docs', 'contract-documents', 'contracts']) {
    // Direct anon upload attempt must be rejected by restrictive policy
    const { error: uploadError } = await anonClient.storage
      .from(bucketId)
      .upload(`probe-${Date.now()}.bin`, testFilePayload, { contentType: 'application/octet-stream' });

    assert.ok(
      uploadError,
      `Direct client upload to private bucket "${bucketId}" MUST fail closed under restrictive RLS`
    );
    testPass(`Direct client upload to "${bucketId}" rejected fail-closed`);
  }

  // Verify service-role client CAN upload and create signed URL
  const probePath = `staging-probe-${Date.now()}.jpg`;
  const { error: adminUploadErr } = await adminClient.storage
    .from('survey-photos')
    .upload(probePath, Buffer.from('fake-jpeg-bytes'), { contentType: 'image/jpeg' });
  assert.equal(adminUploadErr, null, `Admin upload to survey-photos failed: ${adminUploadErr?.message}`);

  const { data: signedData, error: signErr } = await adminClient.storage
    .from('survey-photos')
    .createSignedUrl(probePath, 60);
  assert.equal(signErr, null, `Admin createSignedUrl failed: ${signErr?.message}`);
  assert.ok(signedData?.signedUrl, 'Signed URL should be returned for authorized admin');

  // Cleanup probe file
  await adminClient.storage.from('survey-photos').remove([probePath]);
  testPass('Authorized server/service-role upload and signed URL generation succeed');

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
