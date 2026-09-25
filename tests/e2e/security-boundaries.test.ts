/**
 * M9.6A Security Boundaries & Invariants Suite
 *
 * Verifies:
 * - Scenario J: Sales Style Activation Authorization (Section 16)
 * - Scenario L: Analytics Authorization & Tenant Isolation (Section 18)
 * - Scenario N: Analytics Aggregate-Only Leakage (Section 20)
 * - Scenario O: Analytics Route Static Security (Section 21)
 * - Section 6: Schema Migration Integrity Guard
 * - Section 23: Automated Tenant Isolation Matrix
 * - Section 24: Service-Role Misuse Scan
 * - Section 25: NEXT_PUBLIC Secret Scan
 * - Section 26: Private Schema Access Scan
 * - Section 27 & 28: Protected Foundation Diff Guard & Tamper Guard
 */

import 'server-only';

import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  fetchCompanyAnalyticsDailySeries,
  fetchCompanyAnalyticsOverview,
} from '../../features/analytics/services/analytics-store';
import { activateSalesStyleProfile } from '../../features/sales-style/services/sales-style-activation';
import {
  fetchActiveSalesStyleProfile,
  persistSalesStyleProfile,
} from '../../features/sales-style/services/sales-style-store';
import type { SalesStyleOutput } from '../../shared/contracts/sales-style';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const COMPANY_A_ID = 'e1000000-0000-0000-0000-000000000001';
const COMPANY_B_ID = 'e1000000-0000-0000-0000-000000000002';

const USER_BOSS_A = { email: 'boss-a-m96a@example.com', password: 'password123' };
const USER_SALE_A = { email: 'sale-a-m96a@example.com', password: 'password123' };
const USER_TECH_A = { email: 'tech-a-m96a@example.com', password: 'password123' };
const USER_BOSS_B = { email: 'boss-b-m96a@example.com', password: 'password123' };

let adminClient: SupabaseClient;
let bossAClient: SupabaseClient;
let saleAClient: SupabaseClient;
let techAClient: SupabaseClient;
let bossBClient: SupabaseClient;
let anonClient: SupabaseClient;

let bossAUserId: string;
let saleAUserId: string;
let techAUserId: string;
let bossBUserId: string;

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passCount++;
    console.log(`[PASS] ${message}`);
  } else {
    failCount++;
    console.error(`[FAIL] ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

function createAnonClient(): SupabaseClient {
  return createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function createAdminClient(): SupabaseClient {
  return createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function ensureTestUser(
  config: { email: string; password: string; fullName: string },
  companyId: string,
  role: 'BOSS_ADMIN' | 'SALE' | 'TECHNICIAN'
): Promise<string> {
  const { data: list } = await adminClient.auth.admin.listUsers();
  const existing = list?.users.find((u) => u.email === config.email);

  let userId = existing?.id;
  if (!userId) {
    const { data, error } = await adminClient.auth.admin.createUser({
      email: config.email,
      password: config.password,
      email_confirm: true,
      user_metadata: { full_name: config.fullName },
    });
    if (error || !data.user) {
      throw new Error(`Failed to create user ${config.email}: ${error?.message}`);
    }
    userId = data.user.id;
  }

  await adminClient.from('user_profiles').upsert({
    id: userId,
    full_name: config.fullName,
    status: 'ACTIVE',
  });

  await adminClient.from('company_members').upsert(
    {
      company_id: companyId,
      user_id: userId,
      role,
      status: 'ACTIVE',
    },
    { onConflict: 'company_id,user_id' }
  );

  return userId;
}

async function loginUser(creds: { email: string; password: string }): Promise<SupabaseClient> {
  const client = createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({
    email: creds.email,
    password: creds.password,
  });
  if (error) {
    throw new Error(`Login failed for ${creds.email}: ${error.message}`);
  }
  return client;
}

async function setupAuthClients(): Promise<void> {
  console.log('--- Authenticating clients for Security Boundaries Gate ---');
  adminClient = createAdminClient();
  anonClient = createAnonClient();

  // Ensure companies exist
  await adminClient.from('companies').upsert([
    { id: COMPANY_A_ID, name: 'E2E Test Company A', status: 'ACTIVE' },
    { id: COMPANY_B_ID, name: 'E2E Test Company B', status: 'ACTIVE' },
  ]);

  // Ensure users exist
  bossAUserId = await ensureTestUser({ ...USER_BOSS_A, fullName: 'Boss Admin A' }, COMPANY_A_ID, 'BOSS_ADMIN');
  saleAUserId = await ensureTestUser({ ...USER_SALE_A, fullName: 'Sale A' }, COMPANY_A_ID, 'SALE');
  techAUserId = await ensureTestUser({ ...USER_TECH_A, fullName: 'Tech A' }, COMPANY_A_ID, 'TECHNICIAN');
  bossBUserId = await ensureTestUser({ ...USER_BOSS_B, fullName: 'Boss Admin B' }, COMPANY_B_ID, 'BOSS_ADMIN');

  bossAClient = await loginUser(USER_BOSS_A);
  saleAClient = await loginUser(USER_SALE_A);
  techAClient = await loginUser(USER_TECH_A);
  bossBClient = await loginUser(USER_BOSS_B);

  const { data: uBossA } = await bossAClient.auth.getUser();
  const { data: uSaleA } = await saleAClient.auth.getUser();
  const { data: uTechA } = await techAClient.auth.getUser();
  const { data: uBossB } = await bossBClient.auth.getUser();

  bossAUserId = uBossA.user!.id;
  saleAUserId = uSaleA.user!.id;
  techAUserId = uTechA.user!.id;
  bossBUserId = uBossB.user!.id;
  void techAUserId;
  void bossBUserId;

  console.log('✓ Clients authenticated successfully.\n');
}

export async function runSecurityBoundariesGate(): Promise<void> {
  console.log('================================================================');
  console.log('RUNNING M9.6A SECURITY BOUNDARIES & INVARIANTS GATE');
  console.log('================================================================\n');

  // ============================================================================
  // SCENARIO J: Sales Style Activation Authorization (Section 16)
  // ============================================================================
  console.log('--- Scenario J: Sales Style Activation Authorization ---');
  {
    const custAuthId = 'e2900000-0000-0000-0000-000000000001';
    const convoAuthId = 'e2910000-0000-0000-0000-000000000001';
    const intSourceId = 'e3900000-0000-0000-0000-000000000001';

    await adminClient.from('interactions').delete().eq('id', intSourceId);
    await adminClient.from('conversations').delete().eq('id', convoAuthId);
    await adminClient.from('customers').delete().eq('id', custAuthId);

    const uniqueSuffix = Date.now().toString().slice(-6);
    const { error: custErr } = await adminClient.from('customers').insert({
      id: custAuthId,
      company_id: COMPANY_A_ID,
      customer_code: `KH-AUTH-${uniqueSuffix}`,
      name: 'Khách Auth A',
      source: 'ZALO',
      stage: 'LEAD_NEW',
    });
    if (custErr) throw new Error(`Customers insert failed: ${custErr.message}`);

    const { error: convoErr } = await adminClient.from('conversations').insert({
      id: convoAuthId,
      company_id: COMPANY_A_ID,
      customer_id: custAuthId,
      channel: 'ZALO',
      external_conversation_id: `auth_convo_${uniqueSuffix}`,
      status: 'OPEN',
    });
    if (convoErr) throw new Error(`Conversations insert failed: ${convoErr.message}`);

    const { error: intErr } = await adminClient.from('interactions').insert({
      id: intSourceId,
      company_id: COMPANY_A_ID,
      customer_id: custAuthId,
      conversation_id: convoAuthId,
      channel: 'ZALO',
      type: 'MESSAGE',
      direction: 'OUTBOUND',
      actor_type: 'SALE',
      actor_user_id: saleAUserId,
      sanitization_status: 'SUCCEEDED',
      sanitized_content: 'Chào anh! Dạ em gửi bảng thông số kỹ thuật tấm chắn nước.',
    });
    if (intErr) throw new Error(`Interactions insert failed: ${intErr.message}`);

    const sampleStyle: SalesStyleOutput = {
      salutationRules: {
        selfReferences: ['em'],
        customerReferences: ['anh'],
        commonOpenings: ['Dạ em chào anh ạ'],
        notes: ['Lịch sự'],
      },
      sentenceStyle: {
        preferredLength: 'SHORT',
        toneDescriptors: ['chuyên nghiệp'],
        emojiUsage: 'NONE',
        punctuationPatterns: ['chấm câu chuẩn'],
        notes: ['gọn gàng'],
      },
      questionStyle: {
        commonPatterns: ['Cửa nhà mình rộng bao nhiêu mét ạ?'],
        discoveryApproach: ['hỏi kích thước cửa'],
        followUpApproach: ['hẹn khảo sát'],
        notes: ['lắng nghe'],
      },
      objectionStyle: {
        approaches: [{ situation: 'Khách ngại khoan sàn', responseApproach: 'Tư vấn giải pháp âm sàn sạch sẽ' }],
        notes: ['tôn trọng'],
      },
      closingStyle: {
        commonClosings: ['Em cảm ơn anh đã quan tâm ạ'],
        callToActionPatterns: ['Em gửi kỹ thuật qua đo thực tế cho chuẩn nhé anh?'],
        urgencyStyle: ['Mùa mưa bão sắp đến rồi'],
        notes: ['hẹn đo thực tế'],
      },
    };

    // Create fresh draft profile for authorization checks
    const authDraft = await persistSalesStyleProfile(adminClient, {
      companyId: COMPANY_A_ID,
      saleUserId: saleAUserId,
      sourceRefs: [{ type: 'INTERACTION', id: intSourceId }],
      styleOutput: sampleStyle,
      modelVersion: 'trusted-style-model-v1',
    });

    // 1. SALE of same company -> DENIED
    let saleDenied = false;
    try {
      await activateSalesStyleProfile(saleAClient, authDraft.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      saleDenied = msg.includes('ACTOR_ROLE_NOT_BOSS_ADMIN') || msg.includes('42501');
    }
    assert(saleDenied, 'Scenario J: SALE actor denied style activation');

    // 2. TECHNICIAN of same company -> DENIED
    let techDenied = false;
    try {
      await activateSalesStyleProfile(techAClient, authDraft.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      techDenied = msg.includes('ACTOR_ROLE_NOT_BOSS_ADMIN') || msg.includes('42501');
    }
    assert(techDenied, 'Scenario J: TECHNICIAN actor denied style activation');

    // 3. ANONYMOUS session -> DENIED
    let anonDenied = false;
    try {
      await activateSalesStyleProfile(anonClient, authDraft.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      anonDenied = msg.includes('UNAUTHENTICATED') || msg.includes('42501');
    }
    assert(anonDenied, 'Scenario J: Anonymous session denied style activation');

    // 4. SERVICE_ROLE key -> DENIED (Human privileged operation only!)
    let serviceRoleDenied = false;
    try {
      await activateSalesStyleProfile(adminClient, authDraft.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      serviceRoleDenied =
        msg.includes('permission denied') ||
        msg.includes('42501') ||
        msg.includes('UNAUTHENTICATED');
    }
    assert(serviceRoleDenied, 'Scenario J: service_role key denied style activation (human privileged only)');

    // 5. Cross-company Boss (Boss B -> Company A profile) -> DENIED
    let crossBossDenied = false;
    try {
      await activateSalesStyleProfile(bossBClient, authDraft.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      crossBossDenied = msg.includes('ACTOR_MEMBERSHIP_NOT_FOUND') || msg.includes('42501');
    }
    assert(crossBossDenied, 'Scenario J: Cross-company Boss B denied activation of Company A profile');

    // 6. BOSS_ADMIN of same company -> ALLOWED
    const activated = await activateSalesStyleProfile(bossAClient, authDraft.id);
    assert(activated.generationStatus === 'ACTIVE', 'Scenario J: BOSS_ADMIN of same company successfully activates style');
    assert(activated.activatedByUserId === bossAUserId, 'Scenario J: activated_by_user_id correctly recorded');
  }

  // ============================================================================
  // SCENARIO L: Analytics Authorization & Cross-Tenant Isolation (Section 18)
  // ============================================================================
  console.log('\n--- Scenario L: Analytics Authorization & Isolation ---');
  {
    const from = '2026-09-01T00:00:00.000Z';
    const to = '2026-09-30T00:00:00.000Z';

    // 1. Boss A -> Company A: ALLOWED
    const overviewA = await fetchCompanyAnalyticsOverview(bossAClient, {
      companyId: COMPANY_A_ID,
      from,
      to,
    });
    assert(Boolean(overviewA), 'Scenario L: Boss A accessing Company A analytics is ALLOWED');

    // 2. Boss A -> Company B: DENIED (Cross-tenant barrier)
    let crossCompDenied = false;
    try {
      await fetchCompanyAnalyticsOverview(bossAClient, {
        companyId: COMPANY_B_ID,
        from,
        to,
      });
    } catch (err: unknown) {
      crossCompDenied = (err as Error).message.includes('ACTOR_MEMBERSHIP_NOT_FOUND');
    }
    assert(crossCompDenied, 'Scenario L: Boss A accessing Company B analytics is DENIED');

    // 3. Sale A -> Company A: DENIED
    let saleDenied = false;
    try {
      await fetchCompanyAnalyticsOverview(saleAClient, {
        companyId: COMPANY_A_ID,
        from,
        to,
      });
    } catch (err: unknown) {
      saleDenied = (err as Error).message.includes('ACTOR_ROLE_NOT_BOSS_ADMIN');
    }
    assert(saleDenied, 'Scenario L: Sale A accessing analytics overview is DENIED');

    // 4. Tech A -> Company A: DENIED
    let techDenied = false;
    try {
      await fetchCompanyAnalyticsOverview(techAClient, {
        companyId: COMPANY_A_ID,
        from,
        to,
      });
    } catch (err: unknown) {
      techDenied = (err as Error).message.includes('ACTOR_ROLE_NOT_BOSS_ADMIN');
    }
    assert(techDenied, 'Scenario L: Technician A accessing analytics overview is DENIED');

    // 5. Anonymous session: DENIED
    let anonDenied = false;
    try {
      await fetchCompanyAnalyticsOverview(anonClient, {
        companyId: COMPANY_A_ID,
        from,
        to,
      });
    } catch (err: unknown) {
      const msg = (err as Error).message;
      anonDenied = msg.includes('UNAUTHENTICATED') || msg.includes('permission denied');
    }
    assert(anonDenied, 'Scenario L: Anonymous session accessing analytics overview is DENIED');

    // 6. service_role execution: DENIED (REVOKE ALL FROM service_role)
    const { error: srErr } = await adminClient.rpc('get_company_analytics_overview', {
      p_company_id: COMPANY_A_ID,
      p_from: from,
      p_to: to,
    });
    assert(
      Boolean(srErr && (srErr.code === '42501' || srErr.message.includes('permission denied'))),
      'Scenario L: service_role direct execution of get_company_analytics_overview is DENIED'
    );
  }

  // ============================================================================
  // SCENARIO N: Analytics Aggregate-Only Leakage (Section 20)
  // ============================================================================
  console.log('\n--- Scenario N: Analytics Aggregate-Only Leakage ---');
  {
    const from = '2026-09-01T00:00:00.000Z';
    const to = '2026-09-30T00:00:00.000Z';

    const overview = await fetchCompanyAnalyticsOverview(bossAClient, {
      companyId: COMPANY_A_ID,
      from,
      to,
    });
    const dailySeries = await fetchCompanyAnalyticsDailySeries(bossAClient, {
      companyId: COMPANY_A_ID,
      from,
      to,
    });

    const forbiddenKeys = [
      'customer_id',
      'customerid',
      'customer_code',
      'customercode',
      'name',
      'phone',
      'raw_phone',
      'rawphone',
      'normalized_phone',
      'normalizedphone',
      'interaction_id',
      'interactionid',
      'conversation_id',
      'conversationid',
      'call_id',
      'callid',
      'order_id',
      'orderid',
      'payment_reference',
      'paymentreference',
      'recording_ref',
      'recordingref',
      'transcript',
      'provider_account',
      'provideraccount',
      'transfer_content',
      'transfercontent',
    ];

    function checkObjectKeys(obj: unknown, pathStr = ''): string[] {
      const violations: string[] = [];
      if (!obj || typeof obj !== 'object') return violations;

      for (const [k, v] of Object.entries(obj)) {
        const lowerK = k.toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (forbiddenKeys.includes(lowerK)) {
          violations.push(`Forbidden key "${k}" found at path "${pathStr}.${k}"`);
        }
        if (typeof v === 'string') {
          // Check for raw phone numbers (e.g. 0901234567 or +84901234567)
          if (/(?:^|\s)(?:\+84|0)\d{9,10}(?:$|\s)/.test(v)) {
            violations.push(`Potential phone number detected in value at "${pathStr}.${k}": "${v}"`);
          }
        } else if (typeof v === 'object' && v !== null) {
          violations.push(...checkObjectKeys(v, `${pathStr}.${k}`));
        }
      }
      return violations;
    }

    const overviewViolations = checkObjectKeys(overview, 'overview');
    const dailyViolations = checkObjectKeys(dailySeries, 'dailySeries');

    assert(overviewViolations.length === 0, `Scenario N: Analytics Overview exposes zero row-level identifiers or PII (found: ${overviewViolations.join(', ') || 'none'})`);
    assert(dailyViolations.length === 0, `Scenario N: Daily Series exposes zero row-level identifiers or PII (found: ${dailyViolations.join(', ') || 'none'})`);
  }

  // ============================================================================
  // SCENARIO O: Analytics Route Static Security (Section 21)
  // ============================================================================
  console.log('\n--- Scenario O: Analytics Route Static Security ---');
  {
    const pagePath = path.resolve(process.cwd(), 'app/(dashboard)/admin/analytics/page.tsx');
    assert(fs.existsSync(pagePath), 'Scenario O: /admin/analytics page file exists');
    const pageContent = fs.readFileSync(pagePath, 'utf8');

    // Invariant: 'server-only'
    assert(pageContent.includes("'server-only'"), "Scenario O: Page enforces 'server-only' boundary");

    // Invariant: derives companyId from actor context
    assert(pageContent.includes('getActorContext()'), 'Scenario O: Derives actor context server-side');
    assert(pageContent.includes('const companyId = actor.companyId'), 'Scenario O: Derives companyId strictly from authenticated actor');

    // Invariant: requires Boss / AAL2 MFA at page boundary
    assert(
      pageContent.includes('requireBossAdmin(companyId, { requireAal2: true })'),
      'Scenario O: Requires BOSS_ADMIN with AAL2 MFA at page boundary'
    );

    // Invariant: uses authenticated server client, NO service_role
    assert(pageContent.includes("createClient()"), 'Scenario O: Uses authenticated user server client');
    assert(!pageContent.includes('createAdminClient'), 'Scenario O: Does NOT import or use createAdminClient');
    assert(!pageContent.includes('lib/supabase/admin'), 'Scenario O: Does NOT import lib/supabase/admin');
    assert(!pageContent.includes('SUPABASE_SERVICE_ROLE_KEY'), 'Scenario O: Does NOT reference SUPABASE_SERVICE_ROLE_KEY');

    // Invariant: no /api/analytics route or client fetch
    assert(!pageContent.includes('/api/analytics'), 'Scenario O: Does NOT invoke /api/analytics');

    // Invariant: does not accept tenant selection from query params
    assert(!pageContent.includes('companyId = resolvedParams') && !pageContent.includes('searchParams.companyId'), 'Scenario O: Does not accept companyId tenant override from query params');

    // Invariant: generic error UI, no raw DB errors leaked
    assert(pageContent.includes('Không thể tải dữ liệu báo cáo thống kê'), 'Scenario O: Renders generic friendly error UI on query failure');
    assert(!pageContent.includes('{error.message}') && !pageContent.includes('{error.details}'), 'Scenario O: Does not expose raw DB error message to client');
  }

  // ============================================================================
  // SECTION 6: Migration Schema Integrity Test
  // ============================================================================
  console.log('\n--- Section 6: Schema Migration Integrity Guard ---');
  {
    const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));

    // Check filename regex: YYYYMMDDHHMMSS_name.sql
    const filenameRegex = /^\d{14}_[a-z0-9_]+\.sql$/;
    for (const file of files) {
      assert(filenameRegex.test(file), `Section 6: Migration filename "${file}" follows canonical format`);
    }

    // Check timestamp uniqueness
    const timestamps = files.map((f) => f.slice(0, 14));
    const uniqueTimestamps = new Set(timestamps);
    assert(timestamps.length === uniqueTimestamps.size, 'Section 6: All migration timestamps are strictly unique');

    // Check deterministic chronological sorting
    const sorted = [...files].sort();
    assert(JSON.stringify(files) === JSON.stringify(sorted), 'Section 6: Migration files are in deterministic ascending order');

    // Check canonical baseline migrations present
    assert(files.length >= 9, `Section 6: Canonical migrations exist (found: ${files.length})`);

    // Verify baseline migrations 001–009 names
    const expectedMigrations = [
      '20260914000001_initial_schema.sql',
      '20260915000001_rls_foundation.sql',
      '20260915000002_trusted_server_private_rpc.sql',
      '20260916000001_private_call_transcripts.sql',
      '20260922000001_response_sla_windows.sql',
      '20260922000002_ai_analysis_worker.sql',
      '20260923000001_sales_style_learning.sql',
      '20260923000002_sales_style_activation.sql',
      '20260923000003_analytics_dashboard.sql',
    ];
    for (const exp of expectedMigrations) {
      assert(files.includes(exp), `Section 6: Baseline migration "${exp}" is present`);
    }
  }

  // ============================================================================
  // SECTION 23: Tenant Isolation Matrix Automated Verification
  // ============================================================================
  console.log('\n--- Section 23: Tenant Isolation Matrix Verification ---');
  {
    /**
     * Matrix:
     * | Resource/Operation        | Boss A  | Sale A  | Tech A  | Boss B  | Anon    | service_role |
     * |---------------------------|---------|---------|---------|---------|---------|--------------|
     * | Analytics Overview        | ALLOW   | DENY    | DENY    | DENY    | DENY    | DENY         |
     * | Style Activation          | ALLOW   | DENY    | DENY    | DENY    | DENY    | DENY         |
     * | Active Style Worker Read  | DENY    | DENY    | DENY    | DENY    | DENY    | ALLOW        |
     * | AI Analysis Table Read    | ALLOW   | ALLOW   | DENY    | DENY    | DENY    | DENY*        |
     * | SLA Window Table Read     | ALLOW   | ALLOW   | DENY    | DENY    | DENY    | DENY*        |
     */

    // 1. Analytics Overview
    // Boss A: ALLOW
    const ovBossA = await fetchCompanyAnalyticsOverview(bossAClient, {
      companyId: COMPANY_A_ID,
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-30T00:00:00Z',
    });
    assert(Boolean(ovBossA), 'Matrix [Analytics, Boss A]: ALLOW');

    // Sale A: DENY
    let ovSaleDeny = false;
    try {
      await fetchCompanyAnalyticsOverview(saleAClient, { companyId: COMPANY_A_ID, from: '2026-09-01T00:00:00Z', to: '2026-09-30T00:00:00Z' });
    } catch { ovSaleDeny = true; }
    assert(ovSaleDeny, 'Matrix [Analytics, Sale A]: DENY');

    // Tech A: DENY
    let ovTechDeny = false;
    try {
      await fetchCompanyAnalyticsOverview(techAClient, { companyId: COMPANY_A_ID, from: '2026-09-01T00:00:00Z', to: '2026-09-30T00:00:00Z' });
    } catch { ovTechDeny = true; }
    assert(ovTechDeny, 'Matrix [Analytics, Tech A]: DENY');

    // Boss B: DENY
    let ovBossBDeny = false;
    try {
      await fetchCompanyAnalyticsOverview(bossBClient, { companyId: COMPANY_A_ID, from: '2026-09-01T00:00:00Z', to: '2026-09-30T00:00:00Z' });
    } catch { ovBossBDeny = true; }
    assert(ovBossBDeny, 'Matrix [Analytics, Boss B]: DENY');

    // Anon: DENY
    let ovAnonDeny = false;
    try {
      await fetchCompanyAnalyticsOverview(anonClient, { companyId: COMPANY_A_ID, from: '2026-09-01T00:00:00Z', to: '2026-09-30T00:00:00Z' });
    } catch { ovAnonDeny = true; }
    assert(ovAnonDeny, 'Matrix [Analytics, Anon]: DENY');

    // service_role: DENY
    const { error: ovSrErr } = await adminClient.rpc('get_company_analytics_overview', {
      p_company_id: COMPANY_A_ID,
      p_from: '2026-09-01T00:00:00Z',
      p_to: '2026-09-30T00:00:00Z',
    });
    assert(Boolean(ovSrErr), 'Matrix [Analytics, service_role]: DENY');

    // 2. Active Style Worker Read (get_active_sales_style_profile)
    // Boss A: DENY
    const { error: asBossErr } = await bossAClient.rpc('get_active_sales_style_profile', { p_company_id: COMPANY_A_ID, p_sale_user_id: saleAUserId });
    assert(Boolean(asBossErr), 'Matrix [Active Style Worker Read, Boss A]: DENY');

    // Sale A: DENY
    const { error: asSaleErr } = await saleAClient.rpc('get_active_sales_style_profile', { p_company_id: COMPANY_A_ID, p_sale_user_id: saleAUserId });
    assert(Boolean(asSaleErr), 'Matrix [Active Style Worker Read, Sale A]: DENY');

    // Tech A: DENY
    const { error: asTechErr } = await techAClient.rpc('get_active_sales_style_profile', { p_company_id: COMPANY_A_ID, p_sale_user_id: saleAUserId });
    assert(Boolean(asTechErr), 'Matrix [Active Style Worker Read, Tech A]: DENY');

    // Boss B: DENY
    const { error: asBossBErr } = await bossBClient.rpc('get_active_sales_style_profile', { p_company_id: COMPANY_A_ID, p_sale_user_id: saleAUserId });
    assert(Boolean(asBossBErr), 'Matrix [Active Style Worker Read, Boss B]: DENY');

    // Anon: DENY
    const { error: asAnonErr } = await anonClient.rpc('get_active_sales_style_profile', { p_company_id: COMPANY_A_ID, p_sale_user_id: saleAUserId });
    assert(Boolean(asAnonErr), 'Matrix [Active Style Worker Read, Anon]: DENY');

    // service_role: ALLOW
    const asWorkerRead = await fetchActiveSalesStyleProfile(adminClient, { companyId: COMPANY_A_ID, saleUserId: saleAUserId });
    assert(asWorkerRead !== null, 'Matrix [Active Style Worker Read, service_role]: ALLOW');

    // 3. Response SLA Windows Table Read (response_sla_windows)
    // Boss A: ALLOW
    const { data: slaBossA, error: slaBossAErr } = await bossAClient.from('response_sla_windows').select('id').eq('company_id', COMPANY_A_ID);
    assert(!slaBossAErr && Boolean(slaBossA), 'Matrix [SLA Table Read, Boss A]: ALLOW');

    // Sale A: ALLOW
    const { data: slaSaleA, error: slaSaleAErr } = await saleAClient.from('response_sla_windows').select('id').eq('company_id', COMPANY_A_ID);
    assert(!slaSaleAErr && Boolean(slaSaleA), 'Matrix [SLA Table Read, Sale A]: ALLOW');

    // Tech A: DENY (0 rows returned via RLS or error)
    const { data: slaTechA } = await techAClient.from('response_sla_windows').select('id').eq('company_id', COMPANY_A_ID);
    assert((slaTechA?.length ?? 0) === 0, 'Matrix [SLA Table Read, Tech A]: DENY (0 rows returned via RLS)');

    // Boss B: DENY (0 rows for Company A)
    const { data: slaBossB } = await bossBClient.from('response_sla_windows').select('id').eq('company_id', COMPANY_A_ID);
    assert((slaBossB?.length ?? 0) === 0, 'Matrix [SLA Table Read, Boss B]: DENY (cross-tenant RLS barrier)');

    // Anon: DENY
    const { data: slaAnon } = await anonClient.from('response_sla_windows').select('id').eq('company_id', COMPANY_A_ID);
    assert((slaAnon?.length ?? 0) === 0, 'Matrix [SLA Table Read, Anon]: DENY');

    // service_role: DENY direct table select (REVOKE ALL on response_sla_windows from service_role)
    const { error: slaSrErr } = await adminClient.from('response_sla_windows').select('id').limit(1);
    assert(Boolean(slaSrErr), 'Matrix [SLA Table Read, service_role]: DENY (REVOKE ALL from service_role)');
  }

  // ============================================================================
  // SECTION 24: Service-Role Misuse Scan
  // ============================================================================
  console.log('\n--- Section 24: Service-Role Misuse Scan ---');
  {
    // Scan human-facing files (app/, components/) for forbidden service_role usage
    const appDir = path.resolve(process.cwd(), 'app');
    const componentsDir = path.resolve(process.cwd(), 'components');

    function scanDir(dir: string): string[] {
      const violations: string[] = [];
      if (!fs.existsSync(dir)) return violations;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          violations.push(...scanDir(fullPath));
        } else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) {
          const content = fs.readFileSync(fullPath, 'utf8');
          if (content.includes('lib/supabase/admin') || content.includes('createAdminClient')) {
            violations.push(`Forbidden admin client import in human UI: ${path.relative(process.cwd(), fullPath)}`);
          }
          if (content.includes('SUPABASE_SERVICE_ROLE_KEY')) {
            violations.push(`Forbidden SUPABASE_SERVICE_ROLE_KEY reference in human UI: ${path.relative(process.cwd(), fullPath)}`);
          }
        }
      }
      return violations;
    }

    const appViolations = scanDir(appDir);
    const compViolations = scanDir(componentsDir);
    assert(appViolations.length === 0, `Section 24: Zero service-role imports in app/ directory (found: ${appViolations.join(', ') || 'none'})`);
    assert(compViolations.length === 0, `Section 24: Zero service-role imports in components/ directory (found: ${compViolations.join(', ') || 'none'})`);
  }

  // ============================================================================
  // SECTION 25: NEXT_PUBLIC Secret Scan
  // ============================================================================
  console.log('\n--- Section 25: NEXT_PUBLIC Secret Scan ---');
  {
    // Search production source & config (excluding tests, node_modules, .git, .next) for any NEXT_PUBLIC_* that looks like a secret
    const cmd = "grep -rnE 'NEXT_PUBLIC_[A-Z0-9_]*(SECRET|SERVICE_ROLE|PRIVATE|TOKEN|PASSWORD)' . --exclude-dir=tests --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next || true";
    const result = execSync(cmd, { cwd: process.cwd(), encoding: 'utf8' }).trim();
    assert(result === '', `Section 25: Zero forbidden NEXT_PUBLIC secrets detected in repository (output: "${result}")`);
  }

  // ============================================================================
  // SECTION 26: Private Schema Scan
  // ============================================================================
  console.log('\n--- Section 26: Private Schema Access Scan ---');
  {
    // Ensure non-Foundation features do NOT directly query private schema tables
    // Allowed path: Foundation (lib/sensitive/) via trusted server RPC
    const checkPaths = ['app', 'features', 'components'];
    const violations: string[] = [];

    for (const p of checkPaths) {
      const fullP = path.resolve(process.cwd(), p);
      if (!fs.existsSync(fullP)) continue;
      const cmd = `grep -rnE --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" "(private\\.(customer_private_contacts|interaction_raw_contents|call_transcripts)|from\\('(customer_private_contacts|interaction_raw_contents|call_transcripts)'\\))" ${p} || true`;
      const out = execSync(cmd, { cwd: process.cwd(), encoding: 'utf8' }).trim();
      if (out) {
        violations.push(out);
      }
    }

    assert(violations.length === 0, `Section 26: Zero direct queries to private schema tables from human UI/features (found: ${violations.join('; ') || 'none'})`);
  }

  // ============================================================================
  // SECTION 27 & 28: Protected Foundation Diff Guard & Test Count Tamper Guard
  // ============================================================================
  console.log('\n--- Section 27 & 28: Protected Foundation Diff Guard & Tamper Guard ---');
  {
    // 1. Protected directories diff guard against HEAD
    const protectedPaths = [
      'lib/auth',
      'lib/server-auth',
      'lib/sensitive',
      'lib/supabase',
      'proxy.ts',
      'supabase/migrations',
      'tests/auth',
      'tests/security',
    ];

    for (const p of protectedPaths) {
      const diffOut = execSync(`git diff HEAD -- ${p}`, { cwd: process.cwd(), encoding: 'utf8' }).trim();
      assert(diffOut === '', `Section 27: Protected path "${p}" has 0 diff against HEAD (clean)`);
    }

    // 2. Baseline test suites diff guard against HEAD
    const existingTestDirs = [
      'tests/auth',
      'tests/security',
      'tests/response-sla',
      'tests/ai-analysis',
      'tests/sales-style',
      'tests/analytics',
    ];

    for (const t of existingTestDirs) {
      const diffOut = execSync(`git diff HEAD -- ${t}`, { cwd: process.cwd(), encoding: 'utf8' }).trim();
      assert(diffOut === '', `Section 28: Existing baseline suite "${t}" is unchanged (zero tampering)`);
    }
  }

  console.log('================================================================');
  console.log(`SECURITY BOUNDARIES RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('================================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

setupAuthClients()
  .then(() => runSecurityBoundariesGate())
  .catch((err) => {
    console.error('Fatal error during security boundaries gate:', err);
    process.exit(1);
  });
