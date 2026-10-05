import { strict as assert } from 'node:assert';
import { NextRequest } from 'next/server';
import { GET as responseSlaWorker } from '../../app/api/cron/response-sla-worker/route';
import { GET as voiceScheduler } from '../../app/api/cron/voice-scheduler/route';
import { GET as zaloCare } from '../../app/api/cron/zalo-care/route';

console.log('================================================================');
console.log('STARTING CRON ENDPOINT AUTHORIZATION VERIFICATION');
console.log('================================================================\n');

let passCount = 0;
function testPass(msg: string) {
  console.log(`[PASS] ${msg}`);
  passCount++;
}

// Ensure Supabase test credentials exist for worker execution
process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

async function runCronAuthorizationSuite() {
  const cronRoutes = [
    { name: 'response-sla-worker', path: '/api/cron/response-sla-worker', handler: responseSlaWorker },
    { name: 'voice-scheduler', path: '/api/cron/voice-scheduler', handler: voiceScheduler },
    { name: 'zalo-care', path: '/api/cron/zalo-care', handler: zaloCare },
  ];

  const TEST_SECRET = 'staging-cron-secret-fail-closed-test-471038291048';
  const env = process.env as Record<string, string | undefined>;
  const originalEnv = env.CRON_SECRET;
  const originalNodeEnv = env.NODE_ENV;

  try {
    for (const route of cronRoutes) {
      console.log(`--- Verifying ${route.name} (${route.path}) ---`);

      // 1. Missing Authorization header -> 401 Unauthorized
      env.CRON_SECRET = TEST_SECRET;
      delete env.NODE_ENV;

      const reqMissing = new NextRequest(`http://localhost${route.path}`);
      const resMissing = await route.handler(reqMissing);
      assert.equal(
        resMissing.status,
        401,
        `Expected 401 Unauthorized for missing auth header on ${route.name}, got ${resMissing.status}`
      );
      testPass(`${route.name} rejects missing Authorization header with 401`);

      // 2. Wrong Bearer token -> 401 Unauthorized
      const reqWrong = new NextRequest(`http://localhost${route.path}`, {
        headers: { authorization: 'Bearer wrong-bearer-token' },
      });
      const resWrong = await route.handler(reqWrong);
      assert.equal(
        resWrong.status,
        401,
        `Expected 401 Unauthorized for wrong Bearer token on ${route.name}, got ${resWrong.status}`
      );
      testPass(`${route.name} rejects wrong Bearer token with 401`);

      // 3. Fake bypass headers without valid Bearer token -> 401 Unauthorized
      const reqBypass = new NextRequest(`http://localhost${route.path}`, {
        headers: {
          'user-agent': 'vercel-cron/1.0',
          'x-vercel-cron-schedule': '* * * * *',
          'x-forwarded-for': '127.0.0.1',
        },
      });
      const resBypass = await route.handler(reqBypass);
      assert.equal(
        resBypass.status,
        401,
        `Expected 401 Unauthorized when fake bypass headers provided on ${route.name}, got ${resBypass.status}`
      );
      testPass(`${route.name} does not weaken auth on User-Agent/IP/Vercel headers (returns 401)`);

      // 4. Missing CRON_SECRET in production -> 503 fail-closed
      delete env.CRON_SECRET;
      env.NODE_ENV = 'production';
      const reqNoSecret = new NextRequest(`http://localhost${route.path}`);
      const resNoSecret = await route.handler(reqNoSecret);
      assert.equal(
        resNoSecret.status,
        503,
        `Expected 503 Service Unavailable when CRON_SECRET is unconfigured in production on ${route.name}, got ${resNoSecret.status}`
      );
      testPass(`${route.name} fails closed (503) when CRON_SECRET is unconfigured in production`);

      // 5. Authorized request with correct staging CRON_SECRET -> reaches worker
      env.CRON_SECRET = TEST_SECRET;
      env.NODE_ENV = 'production';
      const reqValid = new NextRequest(`http://localhost${route.path}`, {
        headers: { authorization: `Bearer ${TEST_SECRET}` },
      });
      const resValid = await route.handler(reqValid);
      assert.notEqual(
        resValid.status,
        401,
        `Authorized request with valid staging CRON_SECRET must not be rejected with 401 on ${route.name}`
      );
      assert.notEqual(
        resValid.status,
        503,
        `Authorized request with valid staging CRON_SECRET must not return 503 on ${route.name}`
      );
      testPass(`${route.name} accepts valid staging CRON_SECRET and reaches worker execution (passes auth)`);
    }

    console.log('\n================================================================');
    console.log(`CRON ENDPOINT AUTHORIZATION RESULTS: ${passCount} PASSED, 0 FAILED`);
    console.log('================================================================\n');
  } finally {
    env.CRON_SECRET = originalEnv;
    env.NODE_ENV = originalNodeEnv;
  }
}

runCronAuthorizationSuite().catch((err) => {
  console.error('\n❌ CRON AUTHORIZATION SUITE FAILED:', err);
  process.exit(1);
});
