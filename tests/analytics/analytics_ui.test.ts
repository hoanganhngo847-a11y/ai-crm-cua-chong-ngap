import * as fs from 'fs';
import * as path from 'path';
import { createClient } from '@supabase/supabase-js';
import {
  formatBasisPoints,
  formatMoneyVnd,
  formatSeconds,
  getDefaultDateRange,
  getPresetRanges,
  isValidCalendarDate,
  resolveDateRange,
} from '../../features/analytics/utils/date-range';
import {
  fetchCompanyAnalyticsDailySeries,
  fetchCompanyAnalyticsOverview,
} from '../../features/analytics/services/analytics-store';
import type {
  CompanyAnalyticsDailySeries,
  CompanyAnalyticsOverview,
} from '../../shared/contracts/analytics';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

const COMPANY_A_ID = 'c0000000-0000-0000-0000-000000000001';
const USER_BOSS_A = {
  email: 'analytics_boss_a@trusted.local',
  password: 'Password123!',
};
const USER_SALE_A = {
  email: 'analytics_sale_a@trusted.local',
  password: 'Password123!',
};

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`[PASS] ${message}`);
    passCount++;
  } else {
    console.error(`[FAIL] ${message}`);
    failCount++;
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTests() {
  console.log('==================================================');
  console.log('RUNNING M9.5B ANALYTICS DASHBOARD UI TESTS');
  console.log('==================================================\n');

  // ==============================================================
  // GROUP 1: Calendar Date Validation
  // ==============================================================
  console.log('--- TEST GROUP 1: Calendar Date Validation ---');

  // Valid dates
  assert(isValidCalendarDate('2026-09-23') === true, 'Accepts valid date 2026-09-23');
  assert(isValidCalendarDate('2026-09-01') === true, 'Accepts valid date 2026-09-01');
  assert(isValidCalendarDate('2026-02-28') === true, 'Accepts 2026-02-28 (non-leap)');
  assert(isValidCalendarDate('2024-02-29') === true, 'Accepts 2024-02-29 (leap year)');

  // Invalid non-existent dates
  assert(isValidCalendarDate('2026-02-29') === false, 'Rejects 2026-02-29 (not a leap year)');
  assert(isValidCalendarDate('2026-02-30') === false, 'Rejects 2026-02-30');
  assert(isValidCalendarDate('2026-04-31') === false, 'Rejects 2026-04-31 (April has 30 days)');
  assert(isValidCalendarDate('2026-13-01') === false, 'Rejects month 13');
  assert(isValidCalendarDate('2026-00-10') === false, 'Rejects month 00');
  assert(isValidCalendarDate('2026-05-00') === false, 'Rejects day 00');
  assert(isValidCalendarDate('2026-05-32') === false, 'Rejects day 32');

  // Malformed strings
  assert(isValidCalendarDate('abc') === false, 'Rejects "abc"');
  assert(isValidCalendarDate('01/09/2026') === false, 'Rejects DD/MM/YYYY');
  assert(isValidCalendarDate('2026-9-1') === false, 'Rejects unpadded month/day');
  assert(isValidCalendarDate('2026-09-23T00:00:00Z') === false, 'Rejects ISO timestamptz string');
  assert(isValidCalendarDate('') === false, 'Rejects empty string');

  // ==============================================================
  // GROUP 2: Default Range & Presets Calculations
  // ==============================================================
  console.log('\n--- TEST GROUP 2: Default Range & Presets Calculations ---');

  // Anchor fixed test date: 2026-09-23T12:00:00Z
  const mockNow = new Date(Date.UTC(2026, 8, 23, 12, 0, 0));

  const def = getDefaultDateRange(mockNow);
  assert(def.isDefault === true, 'Default range has isDefault === true');
  assert(def.fromStr === '2026-08-25', 'Default range from is 2026-08-25 (Aug 25 to Sep 23 = 30 days)');
  assert(def.toStr === '2026-09-23', 'Default range to is 2026-09-23');
  assert(def.rpcFrom === '2026-08-25T00:00:00.000Z', 'rpcFrom is 2026-08-25T00:00:00.000Z');
  assert(def.rpcTo === '2026-09-24T00:00:00.000Z', 'rpcTo is exclusive next day 2026-09-24T00:00:00.000Z');
  assert(def.totalDays === 30, 'Total days is 30');
  assert(def.validationError === null, 'No validation error on default');

  // Presets
  const presets = getPresetRanges(mockNow);
  assert(presets.length === 3, 'Returns 3 presets');
  assert(presets[0].label === '7 ngày' && presets[0].days === 7, 'First preset is 7 days');
  assert(presets[0].fromStr === '2026-09-17' && presets[0].toStr === '2026-09-23', '7 days range is 2026-09-17 to 2026-09-23');
  assert(presets[1].label === '30 ngày' && presets[1].days === 30, 'Second preset is 30 days');
  assert(presets[1].fromStr === '2026-08-25' && presets[1].toStr === '2026-09-23', '30 days range is 2026-08-25 to 2026-09-23');
  assert(presets[2].label === '90 ngày' && presets[2].days === 90, 'Third preset is 90 days');
  assert(presets[2].fromStr === '2026-06-26' && presets[2].toStr === '2026-09-23', '90 days range starts on 2026-06-26');

  // ==============================================================
  // GROUP 3: Date Range Resolution & Validation Constraints
  // ==============================================================
  console.log('\n--- TEST GROUP 3: Date Range Resolution & Constraints ---');

  // Valid custom range: 2026-09-01 to 2026-09-30
  const validRange = resolveDateRange('2026-09-01', '2026-09-30', mockNow);
  assert(validRange.isDefault === false, 'isDefault === false for custom range');
  assert(validRange.fromStr === '2026-09-01', 'fromStr is 2026-09-01');
  assert(validRange.toStr === '2026-09-30', 'toStr is 2026-09-30');
  assert(validRange.rpcFrom === '2026-09-01T00:00:00.000Z', 'rpcFrom is 2026-09-01T00:00:00.000Z');
  assert(validRange.rpcTo === '2026-10-01T00:00:00.000Z', 'rpcTo is 2026-10-01T00:00:00.000Z (next day exclusive)');
  assert(validRange.validationError === null, 'No validation error on valid range');

  // Single day query (from === to)
  const singleDay = resolveDateRange('2026-09-15', '2026-09-15', mockNow);
  assert(singleDay.totalDays === 1, 'Single day range totalDays === 1');
  assert(singleDay.rpcFrom === '2026-09-15T00:00:00.000Z', 'singleDay rpcFrom is 2026-09-15T00:00:00.000Z');
  assert(singleDay.rpcTo === '2026-09-16T00:00:00.000Z', 'singleDay rpcTo is 2026-09-16T00:00:00.000Z');

  // Inverted range (from > to)
  const inverted = resolveDateRange('2026-09-30', '2026-09-01', mockNow);
  assert(inverted.isDefault === true, 'Inverted range falls back to default');
  assert(inverted.validationError !== null, 'Inverted range returns validation error message');
  assert(inverted.rpcFrom === '2026-08-25T00:00:00.000Z', 'Inverted fallback rpcFrom is default');

  // Range exceeding 366 days
  const tooLong = resolveDateRange('2024-01-01', '2026-01-01', mockNow);
  assert(tooLong.isDefault === true, 'Range > 366 days falls back to default');
  assert(tooLong.validationError !== null, 'Range > 366 days returns validation error message');
  assert(tooLong.validationError!.includes('366'), 'Error message mentions 366 days limit');

  // Incomplete parameters (only from or only to)
  const onlyFrom = resolveDateRange('2026-09-01', null, mockNow);
  assert(onlyFrom.isDefault === true, 'Only from falls back to default');
  assert(onlyFrom.validationError !== null, 'Only from returns validation error message');

  const onlyTo = resolveDateRange(null, '2026-09-30', mockNow);
  assert(onlyTo.isDefault === true, 'Only to falls back to default');
  assert(onlyTo.validationError !== null, 'Only to returns validation error message');

  // Invalid date string
  const invalidDate = resolveDateRange('2026-02-30', '2026-03-05', mockNow);
  assert(invalidDate.isDefault === true, 'Invalid date 2026-02-30 falls back to default');
  assert(invalidDate.validationError !== null, 'Invalid date returns validation error message');

  // ==============================================================
  // GROUP 4: Formatting Utilities
  // ==============================================================
  console.log('\n--- TEST GROUP 4: Formatting Utilities ---');

  assert(formatMoneyVnd('40000000.00').includes('40.000.000'), 'formatMoneyVnd formats 40,000,000 VND');
  assert(formatMoneyVnd('0.00').includes('0'), 'formatMoneyVnd formats 0.00 as 0');
  assert(formatMoneyVnd(null).includes('0'), 'formatMoneyVnd formats null as 0');
  assert(formatMoneyVnd(undefined).includes('0'), 'formatMoneyVnd formats undefined as 0');

  assert(formatSeconds(45) === '45 giây', 'formatSeconds 45s');
  assert(formatSeconds(120) === '2 phút', 'formatSeconds 120s = 2 phút');
  assert(formatSeconds(125) === '2 phút 5s', 'formatSeconds 125s = 2 phút 5s');
  assert(formatSeconds(null) === '—', 'formatSeconds null = —');

  assert(formatBasisPoints(9500) === '95.0%', 'formatBasisPoints 9500 = 95.0%');
  assert(formatBasisPoints(10000) === '100.0%', 'formatBasisPoints 10000 = 100.0%');
  assert(formatBasisPoints(null) === '—', 'formatBasisPoints null = —');

  // ==============================================================
  // GROUP 5: Static Security & Banned Import Checks
  // ==============================================================
  console.log('\n--- TEST GROUP 5: Static Security & Architecture Checks ---');

  const filesToCheck = [
    'app/(dashboard)/admin/analytics/page.tsx',
    'features/analytics/components/analytics-header.tsx',
    'features/analytics/components/kpi-highlights.tsx',
    'features/analytics/components/finance-snapshot-card.tsx',
    'features/analytics/components/sla-performance-card.tsx',
    'features/analytics/components/customer-pipeline-card.tsx',
    'features/analytics/components/sales-and-operations-card.tsx',
    'features/analytics/components/daily-series-card.tsx',
    'features/analytics/utils/date-range.ts',
  ];

  for (const relPath of filesToCheck) {
    const fullPath = path.resolve(__dirname, '../../', relPath);
    assert(fs.existsSync(fullPath), `File exists: ${relPath}`);
    const content = fs.readFileSync(fullPath, 'utf8');

    // Never import admin client or service role in human dashboard
    assert(!content.includes('lib/supabase/admin'), `${relPath} does not import lib/supabase/admin`);
    assert(!content.includes('service_role'), `${relPath} does not contain service_role`);
    assert(!content.includes('SUPABASE_SERVICE_ROLE_KEY'), `${relPath} does not reference SUPABASE_SERVICE_ROLE_KEY`);
  }

  // Check page.tsx security assertions
  const pagePath = path.resolve(__dirname, '../../app/(dashboard)/admin/analytics/page.tsx');
  const pageContent = fs.readFileSync(pagePath, 'utf8');

  assert(pageContent.includes("requireBossAdmin(companyId, { requireAal2: true })"), 'page.tsx enforces requireBossAdmin with requireAal2: true');
  assert(!pageContent.includes("searchParams.companyId"), 'page.tsx does not read companyId from searchParams');
  assert(!pageContent.includes("searchParams.get('companyId')"), 'page.tsx does not accept ?companyId=');
  assert(pageContent.includes("createClient()"), 'page.tsx uses authenticated session createClient()');

  // ==============================================================
  // GROUP 6: End-to-End Analytics Service Verification with Real Fixtures
  // ==============================================================
  console.log('\n--- TEST GROUP 6: End-to-End Service Integration with Real Database ---');

  // Login as BOSS_ADMIN fixture from M9.5A
  const bossClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: bossAuth, error: bossErr } = await bossClient.auth.signInWithPassword({
    email: USER_BOSS_A.email,
    password: USER_BOSS_A.password,
  });
  assert(!bossErr && !!bossAuth.user, 'Logged in as BOSS_ADMIN fixture');

  // Use resolved range to query overview & series
  const queryRange = resolveDateRange('2026-09-01', '2026-09-30', mockNow);
  const overview = await fetchCompanyAnalyticsOverview(bossClient, {
    companyId: COMPANY_A_ID,
    from: queryRange.rpcFrom,
    to: queryRange.rpcTo,
  });
  assert(!!overview, 'Successfully fetched overview with date range');
  assert(
    new Date(overview.period.from).toISOString() === new Date(queryRange.rpcFrom).toISOString(),
    'Overview period.from matches rpcFrom'
  );
  assert(
    new Date(overview.period.to).toISOString() === new Date(queryRange.rpcTo).toISOString(),
    'Overview period.to matches rpcTo'
  );
  assert(typeof overview.customers.newCustomers === 'number', 'newCustomers is a number');
  assert(typeof overview.financeSnapshot.contractValue === 'string', 'contractValue is a string decimal');

  const dailySeries = await fetchCompanyAnalyticsDailySeries(bossClient, {
    companyId: COMPANY_A_ID,
    from: queryRange.rpcFrom,
    to: queryRange.rpcTo,
  });
  assert(Array.isArray(dailySeries), 'Daily series is an array');
  assert(dailySeries.length === 30, 'Daily series has 30 day buckets for September');
  assert(dailySeries[0].date === '2026-09-01', 'First daily bucket date is 2026-09-01');
  assert(dailySeries[29].date === '2026-09-30', 'Last daily bucket date is 2026-09-30');

  // Test that non-BOSS_ADMIN (SALE) is rejected by RPC
  const saleClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await saleClient.auth.signInWithPassword({
    email: USER_SALE_A.email,
    password: USER_SALE_A.password,
  });

  let saleRejected = false;
  try {
    await fetchCompanyAnalyticsOverview(saleClient, {
      companyId: COMPANY_A_ID,
      from: queryRange.rpcFrom,
      to: queryRange.rpcTo,
    });
  } catch {
    saleRejected = true;
  }
  assert(saleRejected === true, 'SALE role is rejected at database boundary');

  // ==============================================================
  // GROUP 7: Empty-State Safety & Architecture Invariants
  // ==============================================================
  console.log('\n--- TEST GROUP 7: Empty-State Safety & Architecture Invariants ---');

  // 1. Confirm /api/analytics does not exist
  const apiAnalyticsPath = path.resolve(__dirname, '../../app/api/analytics');
  assert(!fs.existsSync(apiAnalyticsPath), 'Route /api/analytics does NOT exist');

  // 2. Confirm admin/page.tsx has link to /admin/analytics
  const adminPagePath = path.resolve(__dirname, '../../app/(dashboard)/admin/page.tsx');
  const adminPageContent = fs.readFileSync(adminPagePath, 'utf8');
  assert(adminPageContent.includes('/admin/analytics'), 'admin/page.tsx links to /admin/analytics');
  assert(adminPageContent.includes('Analytics doanh nghiệp'), 'admin/page.tsx mentions Analytics doanh nghiệp');

  // 3. Confirm page.tsx does not leak raw database/RPC error
  assert(!pageContent.includes('err.message'), 'page.tsx does not leak err.message to browser');
  assert(!pageContent.includes('error.message'), 'page.tsx does not leak error.message to browser');
  assert(!pageContent.includes('useEffect'), 'page.tsx does not use client useEffect');
  assert(!pageContent.includes("'use client'"), 'page.tsx is strictly a Server Component');

  // 4. Test Empty Dataset rendering safety (NO NaN, NO Infinity)
  const emptyOverview: CompanyAnalyticsOverview = {
    period: { from: '2026-08-25T00:00:00.000Z', to: '2026-09-24T00:00:00.000Z' },
    customers: { newCustomers: 0, bySource: [] },
    currentStageDistribution: [],
    stageTransitions: [],
    responseSla: {
      windowsStarted: 0,
      saleResponded: 0,
      saleRespondedWithin5m: 0,
      saleRespondedAfter5m: 0,
      aiResponded: 0,
      cancelled: 0,
      stillOpen: 0,
      avgSaleResponseSeconds: null,
      avgAiResponseSeconds: null,
      saleWithin5mCount: 0,
      resolvedBySaleCount: 0,
      complianceRateBasisPoints: null,
    },
    calls: {
      totalCalls: 0,
      inboundCalls: 0,
      outboundCalls: 0,
      connectedCalls: 0,
      completedCalls: 0,
      noAnswerCalls: 0,
      failedCalls: 0,
    },
    surveys: {
      completedSurveys: 0,
      surveyAppointmentsCreated: 0,
      surveyAppointmentsCompleted: 0,
      surveyAppointmentsCancelled: 0,
    },
    orders: {
      created: 0,
      orderValueCreated: '0.00',
      byStatus: [],
    },
    financeSnapshot: {
      contractValue: '0.00',
      collectedAmount: '0.00',
      receivableAmount: '0.00',
      completedRevenue: '0.00',
      snapshotAt: '2026-09-23T12:00:00.000Z',
    },
    care: {
      careSent: 0,
      careDelivered: 0,
      careResponded: 0,
      careConvertedToSale: 0,
    },
  };
  const emptyDailySeries: CompanyAnalyticsDailySeries = [];

  // Import components dynamically to inspect element rendering
  const { KpiHighlights } = await import('../../features/analytics/components/kpi-highlights');
  const { FinanceSnapshotCard } = await import('../../features/analytics/components/finance-snapshot-card');
  const { SlaPerformanceCard } = await import('../../features/analytics/components/sla-performance-card');
  const { CustomerPipelineCard } = await import('../../features/analytics/components/customer-pipeline-card');
  const { SalesAndOperationsCard } = await import('../../features/analytics/components/sales-and-operations-card');
  const { DailySeriesCard } = await import('../../features/analytics/components/daily-series-card');

  const renderedKpi = JSON.stringify(KpiHighlights({ overview: emptyOverview }));
  const renderedFinance = JSON.stringify(FinanceSnapshotCard({ snapshot: emptyOverview.financeSnapshot }));
  const renderedSla = JSON.stringify(SlaPerformanceCard({ sla: emptyOverview.responseSla }));
  const renderedPipeline = JSON.stringify(
    CustomerPipelineCard({
      newCustomers: 0,
      bySource: [],
      currentStageDistribution: [],
      stageTransitions: [],
    })
  );
  const renderedSalesOps = JSON.stringify(
    SalesAndOperationsCard({
      orders: emptyOverview.orders,
      calls: emptyOverview.calls,
      surveys: emptyOverview.surveys,
      care: emptyOverview.care,
    })
  );
  const renderedDaily = JSON.stringify(DailySeriesCard({ series: emptyDailySeries }));

  const allRendered = [
    renderedKpi,
    renderedFinance,
    renderedSla,
    renderedPipeline,
    renderedSalesOps,
    renderedDaily,
  ].join(' ');

  assert(!allRendered.includes('NaN'), 'Empty dataset creates NO NaN in UI components');
  assert(!allRendered.includes('Infinity'), 'Empty dataset creates NO Infinity in UI components');
  assert(!allRendered.includes('-Infinity'), 'Empty dataset creates NO -Infinity in UI components');
  assert(renderedDaily.includes('Không có chuỗi dữ liệu hàng ngày'), 'Empty daily series renders empty state banner');
  assert(renderedPipeline.includes('Chưa có khách hàng mới trong kỳ'), 'Empty pipeline renders empty sources message');

  console.log('\n==================================================');
  console.log(`ANALYTICS UI TEST RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('==================================================\n');
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
