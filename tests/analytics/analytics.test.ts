import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
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

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function createAnonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function executeRawSql(sql: string) {
  execSync('docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -v ON_ERROR_STOP=1 -U postgres -d postgres', {
    input: sql,
    encoding: 'utf8',
  });
}

// Deterministic UUID fixtures for Analytics tests
const COMPANY_A_ID = 'c0000000-0000-0000-0000-000000000001';
const COMPANY_B_ID = 'c0000000-0000-0000-0000-000000000002';
const COMPANY_EMPTY_ID = 'c0000000-0000-0000-0000-000000000003';

const POLICY_1 = 'c8000000-0000-0000-0000-000000000001';
const CALC_1 = 'c8100000-0000-0000-0000-000000000001';
const CALC_2 = 'c8100000-0000-0000-0000-000000000002';
const CALC_OLD = 'c8100000-0000-0000-0000-000000000003';
const ORDER_1 = 'c9000000-0000-0000-0000-000000000001';
const ORDER_2 = 'c9000000-0000-0000-0000-000000000002';
const ORDER_OLD = 'c9000000-0000-0000-0000-000000000003';
const CAMPAIGN_1 = 'ca000000-0000-0000-0000-000000000001';

// User credentials
const USER_BOSS_A = { email: 'analytics_boss_a@trusted.local', password: 'Password123!', fullName: 'Analytics Sếp A' };
const USER_INACT_BOSS_A = { email: 'analytics_inact_boss_a@trusted.local', password: 'Password123!', fullName: 'Analytics Inactive Sếp A' };
const USER_SALE_A = { email: 'analytics_sale_a@trusted.local', password: 'Password123!', fullName: 'Analytics Sale A' };
const USER_TECH_A = { email: 'analytics_tech_a@trusted.local', password: 'Password123!', fullName: 'Analytics Tech A' };
const USER_BOSS_B = { email: 'analytics_boss_b@trusted.local', password: 'Password123!', fullName: 'Analytics Sếp B' };

let bossAUserId: string;
let techAUserId: string;

let bossAClient: SupabaseClient;
let inactBossAClient: SupabaseClient;
let saleAClient: SupabaseClient;
let techAClient: SupabaseClient;
let bossBClient: SupabaseClient;
let anonClient: SupabaseClient;

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

async function ensureUser(
  config: { email: string; password: string; fullName: string },
  companyId: string,
  role: 'BOSS_ADMIN' | 'SALE' | 'TECHNICIAN',
  status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE'
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
      throw new Error(`Failed to create ${config.email}: ${error?.message}`);
    }
    userId = data.user.id;
  }

  await adminClient.from('user_profiles').upsert({
    id: userId,
    full_name: config.fullName,
    status: 'ACTIVE',
  });

  const { error: memberErr } = await adminClient.from('company_members').upsert(
    {
      company_id: companyId,
      user_id: userId,
      role,
      status,
    },
    { onConflict: 'company_id,user_id' }
  );
  if (memberErr) {
    throw new Error(`Failed to configure member ${config.email}: ${memberErr.message}`);
  }

  return userId;
}

// Period test bounds: September 10, 2026 to September 20, 2026 UTC
const TEST_FROM = '2026-09-10T00:00:00.000Z';
const TEST_TO = '2026-09-20T00:00:00.000Z';

async function setupDatabaseFixtures() {
  console.log('--- Setting up Analytics test fixtures ---');

  // 1. Companies
  await adminClient.from('companies').upsert([
    { id: COMPANY_A_ID, name: 'Công ty Cửa Chống Ngập Analytics A', status: 'ACTIVE' },
    { id: COMPANY_B_ID, name: 'Công ty Cửa Chống Ngập Analytics B', status: 'ACTIVE' },
    { id: COMPANY_EMPTY_ID, name: 'Công ty Cửa Chống Ngập Empty C', status: 'ACTIVE' },
  ]);

  // 2. Users & Members
  bossAUserId = await ensureUser(USER_BOSS_A, COMPANY_A_ID, 'BOSS_ADMIN', 'ACTIVE');
  await ensureUser(USER_INACT_BOSS_A, COMPANY_A_ID, 'BOSS_ADMIN', 'INACTIVE');
  await ensureUser(USER_SALE_A, COMPANY_A_ID, 'SALE', 'ACTIVE');
  techAUserId = await ensureUser(USER_TECH_A, COMPANY_A_ID, 'TECHNICIAN', 'ACTIVE');
  await ensureUser(USER_BOSS_B, COMPANY_B_ID, 'BOSS_ADMIN', 'ACTIVE');

  // Ensure Boss A also has a valid membership in Empty Company as BOSS_ADMIN for empty dataset testing
  await adminClient.from('company_members').upsert(
    {
      company_id: COMPANY_EMPTY_ID,
      user_id: bossAUserId,
      role: 'BOSS_ADMIN',
      status: 'ACTIVE',
    },
    { onConflict: 'company_id,user_id' }
  );

  // Authenticate user clients
  bossAClient = createAnonClient();
  await bossAClient.auth.signInWithPassword({ email: USER_BOSS_A.email, password: USER_BOSS_A.password });

  inactBossAClient = createAnonClient();
  await inactBossAClient.auth.signInWithPassword({ email: USER_INACT_BOSS_A.email, password: USER_INACT_BOSS_A.password });

  saleAClient = createAnonClient();
  await saleAClient.auth.signInWithPassword({ email: USER_SALE_A.email, password: USER_SALE_A.password });

  techAClient = createAnonClient();
  await techAClient.auth.signInWithPassword({ email: USER_TECH_A.email, password: USER_TECH_A.password });

  bossBClient = createAnonClient();
  await bossBClient.auth.signInWithPassword({ email: USER_BOSS_B.email, password: USER_BOSS_B.password });

  anonClient = createAnonClient();

  // Clean existing analytics test data for Company A
  executeRawSql(`
    DELETE FROM public.finance_summaries WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}', '${COMPANY_EMPTY_ID}');
    DELETE FROM public.orders WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}', '${COMPANY_EMPTY_ID}');
    ALTER TABLE public.price_calculations DISABLE TRIGGER trg_price_calculations_immutability;
    DELETE FROM public.price_calculations WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}', '${COMPANY_EMPTY_ID}');
    ALTER TABLE public.price_calculations ENABLE TRIGGER trg_price_calculations_immutability;
    DELETE FROM public.pricing_policies WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}', '${COMPANY_EMPTY_ID}');
    DELETE FROM public.surveys WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}', '${COMPANY_EMPTY_ID}');
    DELETE FROM public.appointments WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}', '${COMPANY_EMPTY_ID}');
    DELETE FROM public.care_deliveries WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}', '${COMPANY_EMPTY_ID}');
    DELETE FROM public.care_campaigns WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}', '${COMPANY_EMPTY_ID}');
    DELETE FROM public.calls WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}', '${COMPANY_EMPTY_ID}');
    DELETE FROM public.response_sla_windows WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}', '${COMPANY_EMPTY_ID}');
    DELETE FROM public.interactions WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}', '${COMPANY_EMPTY_ID}');
    DELETE FROM public.conversations WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}', '${COMPANY_EMPTY_ID}');
    ALTER TABLE public.customer_stage_histories DISABLE TRIGGER trg_append_only_stage_histories;
    DELETE FROM public.customer_stage_histories WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}', '${COMPANY_EMPTY_ID}');
    ALTER TABLE public.customer_stage_histories ENABLE TRIGGER trg_append_only_stage_histories;
    DELETE FROM public.customers WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}', '${COMPANY_EMPTY_ID}');
  `);

  console.log('--- Seeding deterministic test fixtures for Company A ---');

  // Customer IDs
  const CUST_FB = 'c1000000-0000-0000-0000-000000000001';
  const CUST_ZL = 'c1000000-0000-0000-0000-000000000002';
  const CUST_HL = 'c1000000-0000-0000-0000-000000000003';
  const CUST_OLD = 'c1000000-0000-0000-0000-000000000004'; // Created before [from, to)

  // Seed Customers
  executeRawSql(`
    INSERT INTO public.customers (id, company_id, customer_code, name, source, stage, created_at)
    VALUES
      ('${CUST_FB}', '${COMPANY_A_ID}', 'KH-A-FB', 'Khách FB Trong Kỳ', 'FACEBOOK', 'LEAD_NEW', '2026-09-12T10:00:00Z'),
      ('${CUST_ZL}', '${COMPANY_A_ID}', 'KH-A-ZL', 'Khách Zalo Trong Kỳ', 'ZALO', 'SURVEY_COMPLETED', '2026-09-14T15:00:00Z'),
      ('${CUST_HL}', '${COMPANY_A_ID}', 'KH-A-HL', 'Khách Hotline Trong Kỳ', 'HOTLINE', 'ORDER_CREATED', '2026-09-18T08:00:00Z'),
      ('${CUST_OLD}', '${COMPANY_A_ID}', 'KH-A-OLD', 'Khách Cũ Ngoài Kỳ', 'WEBSITE', 'CONTRACT_SIGNED', '2026-08-01T12:00:00Z');
  `);

  // Seed Stage Transitions
  executeRawSql(`
    INSERT INTO public.customer_stage_histories (company_id, customer_id, from_stage, to_stage, actor_type, reason, changed_at)
    VALUES
      ('${COMPANY_A_ID}', '${CUST_ZL}', 'LEAD_NEW', 'SURVEY_REQUESTED', 'USER', 'Khảo sát', '2026-09-13T10:00:00Z'),
      ('${COMPANY_A_ID}', '${CUST_ZL}', 'SURVEY_REQUESTED', 'SURVEY_COMPLETED', 'USER', 'Xong đo đạc', '2026-09-14T16:00:00Z'),
      ('${COMPANY_A_ID}', '${CUST_HL}', 'LEAD_NEW', 'PRICE_OFFERED', 'USER', 'Báo giá', '2026-09-18T09:00:00Z'),
      ('${COMPANY_A_ID}', '${CUST_HL}', 'PRICE_OFFERED', 'ORDER_CREATED', 'USER', 'Chốt đơn', '2026-09-19T11:00:00Z'),
      ('${COMPANY_A_ID}', '${CUST_OLD}', 'ORDER_CREATED', 'CONTRACT_SIGNED', 'USER', 'Ký hợp đồng ngoài kỳ', '2026-08-15T09:00:00Z');
  `);

  // Seed Conversations & Interactions for SLA
  const CONVO_1 = 'c2000000-0000-0000-0000-000000000001';
  const CONVO_2 = 'c2000000-0000-0000-0000-000000000002';
  const CONVO_3 = 'c2000000-0000-0000-0000-000000000003';
  const CONVO_4 = 'c2000000-0000-0000-0000-000000000004';
  const CONVO_5 = 'c2000000-0000-0000-0000-000000000005';

  executeRawSql(`
    INSERT INTO public.conversations (id, company_id, customer_id, channel, external_conversation_id, status)
    VALUES
      ('${CONVO_1}', '${COMPANY_A_ID}', '${CUST_FB}', 'FACEBOOK', 'ext_convo_1', 'OPEN'),
      ('${CONVO_2}', '${COMPANY_A_ID}', '${CUST_ZL}', 'ZALO', 'ext_convo_2', 'OPEN'),
      ('${CONVO_3}', '${COMPANY_A_ID}', '${CUST_HL}', 'ZALO', 'ext_convo_3', 'OPEN'),
      ('${CONVO_4}', '${COMPANY_A_ID}', '${CUST_FB}', 'FACEBOOK', 'ext_convo_4', 'OPEN'),
      ('${CONVO_5}', '${COMPANY_A_ID}', '${CUST_ZL}', 'ZALO', 'ext_convo_5', 'OPEN');
  `);

  // Interactions
  const INT_TRIG_1 = 'c3000000-0000-0000-0000-000000000001';
  const INT_RESP_1 = 'c3000000-0000-0000-0000-000000000002';
  const INT_TRIG_2 = 'c3000000-0000-0000-0000-000000000003';
  const INT_RESP_2 = 'c3000000-0000-0000-0000-000000000004';
  const INT_TRIG_3 = 'c3000000-0000-0000-0000-000000000005';
  const INT_RESP_3 = 'c3000000-0000-0000-0000-000000000006';
  const INT_TRIG_4 = 'c3000000-0000-0000-0000-000000000007';
  const INT_TRIG_5 = 'c3000000-0000-0000-0000-000000000008';

  executeRawSql(`
    INSERT INTO public.interactions (id, company_id, customer_id, conversation_id, direction, type, channel, sanitization_status, actor_type)
    VALUES
      ('${INT_TRIG_1}', '${COMPANY_A_ID}', '${CUST_FB}', '${CONVO_1}', 'INBOUND', 'MESSAGE', 'FACEBOOK', 'SUCCEEDED', 'CUSTOMER'),
      ('${INT_RESP_1}', '${COMPANY_A_ID}', '${CUST_FB}', '${CONVO_1}', 'OUTBOUND', 'MESSAGE', 'FACEBOOK', 'SUCCEEDED', 'SALE'),
      ('${INT_TRIG_2}', '${COMPANY_A_ID}', '${CUST_ZL}', '${CONVO_2}', 'INBOUND', 'MESSAGE', 'ZALO', 'SUCCEEDED', 'CUSTOMER'),
      ('${INT_RESP_2}', '${COMPANY_A_ID}', '${CUST_ZL}', '${CONVO_2}', 'OUTBOUND', 'MESSAGE', 'ZALO', 'SUCCEEDED', 'SALE'),
      ('${INT_TRIG_3}', '${COMPANY_A_ID}', '${CUST_HL}', '${CONVO_3}', 'INBOUND', 'MESSAGE', 'ZALO', 'SUCCEEDED', 'CUSTOMER'),
      ('${INT_RESP_3}', '${COMPANY_A_ID}', '${CUST_HL}', '${CONVO_3}', 'OUTBOUND', 'MESSAGE', 'ZALO', 'SUCCEEDED', 'AI'),
      ('${INT_TRIG_4}', '${COMPANY_A_ID}', '${CUST_FB}', '${CONVO_4}', 'INBOUND', 'MESSAGE', 'FACEBOOK', 'SUCCEEDED', 'CUSTOMER'),
      ('${INT_TRIG_5}', '${COMPANY_A_ID}', '${CUST_ZL}', '${CONVO_5}', 'INBOUND', 'MESSAGE', 'ZALO', 'SUCCEEDED', 'CUSTOMER');
  `);

  // Seed Response SLA Windows
  // 1: SALE within 5m (duration: 120s)
  // 2: SALE after 5m (duration: 400s)
  // 3: AI responded (duration: 300s)
  // 4: CANCELLED
  // 5: OPEN
  executeRawSql(`
    INSERT INTO public.response_sla_windows (
      id, company_id, conversation_id, customer_id, trigger_interaction_id,
      started_at, deadline_at, state, resolved_at, sale_response_interaction_id, ai_response_interaction_id
    ) VALUES
      ('c4000000-0000-0000-0000-000000000001', '${COMPANY_A_ID}', '${CONVO_1}', '${CUST_FB}', '${INT_TRIG_1}',
       '2026-09-12T10:00:00Z', '2026-09-12T10:05:00Z', 'SALE_RESPONDED', '2026-09-12T10:02:00Z', '${INT_RESP_1}', NULL),
      ('c4000000-0000-0000-0000-000000000002', '${COMPANY_A_ID}', '${CONVO_2}', '${CUST_ZL}', '${INT_TRIG_2}',
       '2026-09-13T11:00:00Z', '2026-09-13T11:05:00Z', 'SALE_RESPONDED', '2026-09-13T11:06:40Z', '${INT_RESP_2}', NULL),
      ('c4000000-0000-0000-0000-000000000003', '${COMPANY_A_ID}', '${CONVO_3}', '${CUST_HL}', '${INT_TRIG_3}',
       '2026-09-14T09:00:00Z', '2026-09-14T09:05:00Z', 'AI_RESPONDED', '2026-09-14T09:05:00Z', NULL, '${INT_RESP_3}'),
      ('c4000000-0000-0000-0000-000000000004', '${COMPANY_A_ID}', '${CONVO_4}', '${CUST_FB}', '${INT_TRIG_4}',
       '2026-09-15T14:00:00Z', '2026-09-15T14:05:00Z', 'CANCELLED', '2026-09-15T14:01:00Z', NULL, NULL),
      ('c4000000-0000-0000-0000-000000000005', '${COMPANY_A_ID}', '${CONVO_5}', '${CUST_ZL}', '${INT_TRIG_5}',
       '2026-09-16T16:00:00Z', '2026-09-16T16:05:00Z', 'OPEN', NULL, NULL, NULL);
  `);

  // Seed Calls
  executeRawSql(`
    INSERT INTO public.calls (id, company_id, customer_id, direction, agent_type, status, transcript_status, started_at)
    VALUES
      ('c5000000-0000-0000-0000-000000000001', '${COMPANY_A_ID}', '${CUST_FB}', 'INBOUND', 'SALE', 'COMPLETED', 'COMPLETED', '2026-09-12T10:00:00Z'),
      ('c5000000-0000-0000-0000-000000000002', '${COMPANY_A_ID}', '${CUST_ZL}', 'OUTBOUND', 'SALE', 'CONNECTED', 'PENDING', '2026-09-13T11:00:00Z'),
      ('c5000000-0000-0000-0000-000000000003', '${COMPANY_A_ID}', '${CUST_HL}', 'OUTBOUND', 'SALE', 'NO_ANSWER', 'FAILED', '2026-09-14T09:00:00Z'),
      ('c5000000-0000-0000-0000-000000000004', '${COMPANY_A_ID}', '${CUST_FB}', 'INBOUND', 'AI', 'FAILED', 'FAILED', '2026-09-15T14:00:00Z');
  `);

  // Seed Appointments & Surveys
  const APPT_1 = 'c6000000-0000-0000-0000-000000000001';
  executeRawSql(`
    INSERT INTO public.appointments (id, company_id, customer_id, type, start_time, assignee_id, address, status, created_at, updated_at)
    VALUES
      ('${APPT_1}', '${COMPANY_A_ID}', '${CUST_ZL}', 'SURVEY', '2026-09-14T10:00:00Z', '${techAUserId}', '123 Đường Bưởi', 'COMPLETED', '2026-09-13T08:00:00Z', '2026-09-14T11:00:00Z');

    INSERT INTO public.surveys (id, company_id, customer_id, appointment_id, completed_by, measurements, site_condition, completed_at)
    VALUES
      ('c7000000-0000-0000-0000-000000000001', '${COMPANY_A_ID}', '${CUST_ZL}', '${APPT_1}', '${techAUserId}', '{"width": 3.5, "height": 0.8}'::jsonb, 'Mặt bằng chuẩn', '2026-09-14T11:00:00Z');
  `);

  // Seed Pricing Policies, Price Calculations, Orders, & Finance Summaries
  executeRawSql(`
    INSERT INTO public.pricing_policies (id, company_id, version, conditions, price_rules, effective_at, status)
    VALUES
      ('${POLICY_1}', '${COMPANY_A_ID}', 'V2026.1', '{}'::jsonb, '{}'::jsonb, '2026-01-01T00:00:00Z', 'ACTIVE');

    INSERT INTO public.price_calculations (id, company_id, customer_id, pricing_policy_id, policy_version, input_data, amount, status)
    VALUES
      ('${CALC_1}', '${COMPANY_A_ID}', '${CUST_ZL}', '${POLICY_1}', 'V2026.1', '{}'::jsonb, 15000000.00, 'CALCULATED'),
      ('${CALC_2}', '${COMPANY_A_ID}', '${CUST_HL}', '${POLICY_1}', 'V2026.1', '{}'::jsonb, 25000000.00, 'CALCULATED'),
      ('${CALC_OLD}', '${COMPANY_A_ID}', '${CUST_OLD}', '${POLICY_1}', 'V2026.1', '{}'::jsonb, 50000000.00, 'CALCULATED');

    -- Order 1: in period, 15,000,000
    -- Order 2: in period, 25,000,000
    -- Order Old: before period (August), 50,000,000
    INSERT INTO public.orders (id, company_id, customer_id, order_code, payment_reference, price_calculation_id, deposit_status, order_status, final_amount, created_at)
    VALUES
      ('${ORDER_1}', '${COMPANY_A_ID}', '${CUST_ZL}', 'ORD-A-001', 'PAY-REF-001', '${CALC_1}', 'CONFIRMED', 'DEPOSIT_CONFIRMED', 15000000.00, '2026-09-15T10:00:00Z'),
      ('${ORDER_2}', '${COMPANY_A_ID}', '${CUST_HL}', 'ORD-A-002', 'PAY-REF-002', '${CALC_2}', 'PENDING', 'DRAFT', 25000000.00, '2026-09-18T14:00:00Z'),
      ('${ORDER_OLD}', '${COMPANY_A_ID}', '${CUST_OLD}', 'ORD-A-OLD', 'PAY-REF-OLD', '${CALC_OLD}', 'CONFIRMED', 'COMPLETED', 50000000.00, '2026-08-10T10:00:00Z');

    -- Finance summaries snapshot (as of now, company-wide)
    -- Total contract_value: 15m + 25m + 50m = 90,000,000
    -- Total collected_amount: 15m + 0 + 50m = 65,000,000
    -- Total receivable_amount: 0 + 25m + 0 = 25,000,000
    -- Total completed_revenue: 0 + 0 + 50m = 50,000,000
    INSERT INTO public.finance_summaries (order_id, company_id, contract_value, collected_amount, receivable_amount, completed_revenue)
    VALUES
      ('${ORDER_1}', '${COMPANY_A_ID}', 15000000.00, 15000000.00, 0.00, 0.00),
      ('${ORDER_2}', '${COMPANY_A_ID}', 25000000.00, 0.00, 25000000.00, 0.00),
      ('${ORDER_OLD}', '${COMPANY_A_ID}', 50000000.00, 50000000.00, 0.00, 50000000.00);
  `);

  // Seed Care Deliveries
  executeRawSql(`
    INSERT INTO public.care_campaigns (id, company_id, channel, audience_rule, message_template, started_at, sent_count)
    VALUES
      ('${CAMPAIGN_1}', '${COMPANY_A_ID}', 'ZALO', '{}'::jsonb, 'Bảo dưỡng cửa chống ngập', '2026-09-10T00:00:00Z', 9999);

    -- Deliveries in period
    INSERT INTO public.care_deliveries (id, company_id, campaign_id, customer_id, idempotency_key, channel, status, sent_at, delivered_at, responded_at, converted_to_sale_at)
    VALUES
      ('cb000000-0000-0000-0000-000000000001', '${COMPANY_A_ID}', '${CAMPAIGN_1}', '${CUST_FB}', 'care-idem-1', 'ZALO', 'CONVERTED_TO_SALE',
       '2026-09-11T09:00:00Z', '2026-09-11T09:01:00Z', '2026-09-11T10:00:00Z', '2026-09-11T15:00:00Z'),
      ('cb000000-0000-0000-0000-000000000002', '${COMPANY_A_ID}', '${CAMPAIGN_1}', '${CUST_ZL}', 'care-idem-2', 'ZALO', 'RESPONDED',
       '2026-09-12T09:00:00Z', '2026-09-12T09:01:00Z', '2026-09-12T11:00:00Z', NULL),
      ('cb000000-0000-0000-0000-000000000003', '${COMPANY_A_ID}', '${CAMPAIGN_1}', '${CUST_HL}', 'care-idem-3', 'ZALO', 'DELIVERED',
       '2026-09-13T09:00:00Z', '2026-09-13T09:01:00Z', NULL, NULL);
  `);

  console.log('--- Database fixtures successfully prepared ---');
}

async function runTests() {
  await setupDatabaseFixtures();

  // ============================================================================
  // TEST GROUP 1: Security Boundary & Role Authorization (Fail-Closed)
  // ============================================================================
  console.log('\n--- TEST GROUP 1: Security & Role Authorization ---');

  // Test 1: BOSS_ADMIN of Company A can query overview
  {
    const overview = await fetchCompanyAnalyticsOverview(bossAClient, {
      companyId: COMPANY_A_ID,
      from: TEST_FROM,
      to: TEST_TO,
    });
    assert(!!overview, 'Test 1: BOSS_ADMIN of Company A can fetch analytics overview');
    assert(new Date(overview.period.from).toISOString() === new Date(TEST_FROM).toISOString(), 'Test 1: Overview period.from matches input');
    assert(new Date(overview.period.to).toISOString() === new Date(TEST_TO).toISOString(), 'Test 1: Overview period.to matches input');
  }

  // Test 2: BOSS_ADMIN of Company A can query daily series
  {
    const series = await fetchCompanyAnalyticsDailySeries(bossAClient, {
      companyId: COMPANY_A_ID,
      from: TEST_FROM,
      to: TEST_TO,
    });
    assert(Array.isArray(series), 'Test 2: BOSS_ADMIN can fetch daily time-series');
    assert(series.length === 10, `Test 2: Daily series has exactly 10 day buckets (got ${series.length})`);
  }

  // Test 3: SALE user is rejected
  {
    let caught = false;
    try {
      await fetchCompanyAnalyticsOverview(saleAClient, {
        companyId: COMPANY_A_ID,
        from: TEST_FROM,
        to: TEST_TO,
      });
    } catch (err: unknown) {
      caught = true;
      assert((err as Error).message.includes('ACTOR_ROLE_NOT_BOSS_ADMIN'), 'Test 3: SALE user rejected with ACTOR_ROLE_NOT_BOSS_ADMIN');
    }
    assert(caught, 'Test 3: SALE user must throw');
  }

  // Test 4: TECHNICIAN user is rejected
  {
    let caught = false;
    try {
      await fetchCompanyAnalyticsOverview(techAClient, {
        companyId: COMPANY_A_ID,
        from: TEST_FROM,
        to: TEST_TO,
      });
    } catch (err: unknown) {
      caught = true;
      assert((err as Error).message.includes('ACTOR_ROLE_NOT_BOSS_ADMIN'), 'Test 4: TECHNICIAN rejected with ACTOR_ROLE_NOT_BOSS_ADMIN');
    }
    assert(caught, 'Test 4: TECHNICIAN user must throw');
  }

  // Test 5: Unauthenticated / anon is rejected
  {
    let caught = false;
    try {
      await fetchCompanyAnalyticsOverview(anonClient, {
        companyId: COMPANY_A_ID,
        from: TEST_FROM,
        to: TEST_TO,
      });
    } catch (err: unknown) {
      caught = true;
      const msg = (err as Error).message;
      assert(
        msg.includes('UNAUTHENTICATED') || msg.includes('permission denied'),
        'Test 5: Anonymous client rejected with UNAUTHENTICATED or permission denied'
      );
    }
    assert(caught, 'Test 5: Anonymous client must throw');
  }

  // Test 6: Inactive BOSS_ADMIN is rejected
  {
    let caught = false;
    try {
      await fetchCompanyAnalyticsOverview(inactBossAClient, {
        companyId: COMPANY_A_ID,
        from: TEST_FROM,
        to: TEST_TO,
      });
    } catch (err: unknown) {
      caught = true;
      assert((err as Error).message.includes('ACTOR_MEMBERSHIP_INACTIVE'), 'Test 6: Inactive BOSS_ADMIN rejected with ACTOR_MEMBERSHIP_INACTIVE');
    }
    assert(caught, 'Test 6: Inactive BOSS_ADMIN must throw');
  }

  // Test 7: Cross-Company Access Denied (Boss B accessing Company A)
  {
    let caught = false;
    try {
      await fetchCompanyAnalyticsOverview(bossBClient, {
        companyId: COMPANY_A_ID,
        from: TEST_FROM,
        to: TEST_TO,
      });
    } catch (err: unknown) {
      caught = true;
      assert((err as Error).message.includes('ACTOR_MEMBERSHIP_NOT_FOUND'), 'Test 7: Cross-company access rejected with ACTOR_MEMBERSHIP_NOT_FOUND');
    }
    assert(caught, 'Test 7: Cross-company access must throw');
  }

  // Test 8: service_role key cannot execute human analytics RPC (REVOKE check)
  {
    const { error: ovErr } = await adminClient.rpc('get_company_analytics_overview', {
      p_company_id: COMPANY_A_ID,
      p_from: TEST_FROM,
      p_to: TEST_TO,
    });
    assert(
      !!ovErr && (ovErr.code === '42501' || ovErr.message.includes('permission denied')),
      `Test 8: service_role execution rejected on overview RPC (code: ${ovErr?.code})`
    );

    const { error: dsErr } = await adminClient.rpc('get_company_analytics_daily_series', {
      p_company_id: COMPANY_A_ID,
      p_from: TEST_FROM,
      p_to: TEST_TO,
    });
    assert(
      !!dsErr && (dsErr.code === '42501' || dsErr.message.includes('permission denied')),
      `Test 8: service_role execution rejected on daily series RPC (code: ${dsErr?.code})`
    );
  }

  // ============================================================================
  // TEST GROUP 2: Date-Range Contract & Technical Bounds
  // ============================================================================
  console.log('\n--- TEST GROUP 2: Date-Range Contract & Technical Bounds ---');

  // Test 9: from >= to rejected
  {
    let caught = false;
    try {
      await fetchCompanyAnalyticsOverview(bossAClient, {
        companyId: COMPANY_A_ID,
        from: '2026-09-20T00:00:00Z',
        to: '2026-09-10T00:00:00Z',
      });
    } catch (err: unknown) {
      caught = true;
      assert((err as Error).message.includes('Analytics period start (from) must be strictly before end (to)'), 'Test 9: from > to rejected by store');
    }
    assert(caught, 'Test 9: from > to must throw');

    // Also verify at database RPC level
    const { error } = await bossAClient.rpc('get_company_analytics_overview', {
      p_company_id: COMPANY_A_ID,
      p_from: '2026-09-20T00:00:00Z',
      p_to: '2026-09-10T00:00:00Z',
    });
    assert(!!error && error.message.includes('INVALID_ANALYTICS_RANGE'), 'Test 9: from > to rejected at DB level (INVALID_ANALYTICS_RANGE)');
  }

  // Test 10: Range > 366 days rejected
  {
    let caught = false;
    try {
      await fetchCompanyAnalyticsOverview(bossAClient, {
        companyId: COMPANY_A_ID,
        from: '2025-01-01T00:00:00Z',
        to: '2026-02-15T00:00:00Z', // > 400 days
      });
    } catch (err: unknown) {
      caught = true;
      assert((err as Error).message.includes('cannot exceed 366 days'), 'Test 10: Range > 366 days rejected by store');
    }
    assert(caught, 'Test 10: Range > 366 days must throw');

    // Verify at database level
    const { error } = await bossAClient.rpc('get_company_analytics_overview', {
      p_company_id: COMPANY_A_ID,
      p_from: '2025-01-01T00:00:00Z',
      p_to: '2026-02-15T00:00:00Z',
    });
    assert(!!error && error.message.includes('INVALID_ANALYTICS_RANGE'), 'Test 10: Range > 366 days rejected at DB level (INVALID_ANALYTICS_RANGE)');
  }

  // Test 11: Null/missing dates rejected at DB level
  {
    const { error: err1 } = await bossAClient.rpc('get_company_analytics_overview', {
      p_company_id: COMPANY_A_ID,
      p_from: null,
      p_to: TEST_TO,
    });
    assert(!!err1 && err1.message.includes('INVALID_ANALYTICS_RANGE'), 'Test 11: NULL from rejected at DB level');

    const { error: err2 } = await bossAClient.rpc('get_company_analytics_overview', {
      p_company_id: COMPANY_A_ID,
      p_from: TEST_FROM,
      p_to: null,
    });
    assert(!!err2 && err2.message.includes('INVALID_ANALYTICS_RANGE'), 'Test 11: NULL to rejected at DB level');
  }

  // ============================================================================
  // TEST GROUP 3: Empty Company Semantics (Zeroes, Decimals, Nulls, Arrays)
  // ============================================================================
  console.log('\n--- TEST GROUP 3: Empty Dataset Semantics ---');

  {
    const emptyOverview = await fetchCompanyAnalyticsOverview(bossAClient, {
      companyId: COMPANY_EMPTY_ID,
      from: TEST_FROM,
      to: TEST_TO,
    });

    assert(emptyOverview.customers.newCustomers === 0, 'Test 13: Empty newCustomers is 0');
    assert(Array.isArray(emptyOverview.customers.bySource) && emptyOverview.customers.bySource.length === 0, 'Test 13: Empty bySource is []');
    assert(Array.isArray(emptyOverview.currentStageDistribution) && emptyOverview.currentStageDistribution.length === 0, 'Test 13: Empty currentStageDistribution is []');
    assert(Array.isArray(emptyOverview.stageTransitions) && emptyOverview.stageTransitions.length === 0, 'Test 13: Empty stageTransitions is []');

    assert(emptyOverview.responseSla.windowsStarted === 0, 'Test 13: Empty windowsStarted is 0');
    assert(emptyOverview.responseSla.saleResponded === 0, 'Test 13: Empty saleResponded is 0');
    assert(emptyOverview.responseSla.avgSaleResponseSeconds === null, 'Test 13: Empty avgSaleResponseSeconds is null');
    assert(emptyOverview.responseSla.avgAiResponseSeconds === null, 'Test 13: Empty avgAiResponseSeconds is null');
    assert(emptyOverview.responseSla.complianceRateBasisPoints === null, 'Test 13: Empty complianceRateBasisPoints is null');

    assert(emptyOverview.calls.totalCalls === 0, 'Test 13: Empty totalCalls is 0');
    assert(emptyOverview.surveys.completedSurveys === 0, 'Test 13: Empty completedSurveys is 0');

    assert(emptyOverview.orders.created === 0, 'Test 13: Empty orders.created is 0');
    assert(emptyOverview.orders.orderValueCreated === '0.00', 'Test 13: Empty orderValueCreated is "0.00"');
    assert(Array.isArray(emptyOverview.orders.byStatus) && emptyOverview.orders.byStatus.length === 0, 'Test 13: Empty orders.byStatus is []');

    assert(emptyOverview.financeSnapshot.contractValue === '0.00', 'Test 13: Empty contractValue is "0.00"');
    assert(emptyOverview.financeSnapshot.collectedAmount === '0.00', 'Test 13: Empty collectedAmount is "0.00"');
    assert(emptyOverview.financeSnapshot.receivableAmount === '0.00', 'Test 13: Empty receivableAmount is "0.00"');
    assert(emptyOverview.financeSnapshot.completedRevenue === '0.00', 'Test 13: Empty completedRevenue is "0.00"');
    assert(typeof emptyOverview.financeSnapshot.snapshotAt === 'string', 'Test 13: snapshotAt is a valid string');

    assert(emptyOverview.care.careSent === 0, 'Test 13: Empty careSent is 0');
    assert(emptyOverview.care.careConvertedToSale === 0, 'Test 13: Empty careConvertedToSale is 0');

    // Empty daily series
    const emptySeries = await fetchCompanyAnalyticsDailySeries(bossAClient, {
      companyId: COMPANY_EMPTY_ID,
      from: TEST_FROM,
      to: TEST_TO,
    });
    assert(emptySeries.length === 10, 'Test 14: Empty daily series generates 10 day buckets');
    assert(
      emptySeries.every(
        (b) =>
          b.newCustomers === 0 &&
          b.ordersCreated === 0 &&
          b.orderValueCreated === '0.00' &&
          b.slaWindowsStarted === 0 &&
          b.saleWithin5m === 0 &&
          b.aiResponded === 0 &&
          b.careConvertedToSale === 0
      ),
      'Test 14: All buckets in empty series have 0 counts and "0.00" amounts'
    );
  }

  // ============================================================================
  // TEST GROUP 4: Half-Open Interval [from, to) Boundary Precision
  // ============================================================================
  console.log('\n--- TEST GROUP 4: Boundary Precision [from, to) ---');

  // Insert customers with precise timestamps relative to [TEST_FROM, TEST_TO)
  // TEST_FROM = 2026-09-10T00:00:00.000Z
  // TEST_TO   = 2026-09-20T00:00:00.000Z
  const CUST_BND_BEFORE = 'c1000000-0000-0000-0000-000000000010';
  const CUST_BND_EXACT_FROM = 'c1000000-0000-0000-0000-000000000011';
  const CUST_BND_EXACT_TO = 'c1000000-0000-0000-0000-000000000012';
  const CUST_BND_AFTER = 'c1000000-0000-0000-0000-000000000013';

  executeRawSql(`
    INSERT INTO public.customers (id, company_id, customer_code, name, source, stage, created_at)
    VALUES
      ('${CUST_BND_BEFORE}', '${COMPANY_A_ID}', 'KH-BND-BEF', 'Khách 1ms Trước From', 'MANUAL', 'LEAD_NEW', '2026-09-09T23:59:59.999Z'),
      ('${CUST_BND_EXACT_FROM}', '${COMPANY_A_ID}', 'KH-BND-FROM', 'Khách Đúng From', 'MANUAL', 'LEAD_NEW', '2026-09-10T00:00:00.000Z'),
      ('${CUST_BND_EXACT_TO}', '${COMPANY_A_ID}', 'KH-BND-TO', 'Khách Đúng To', 'MANUAL', 'LEAD_NEW', '2026-09-20T00:00:00.000Z'),
      ('${CUST_BND_AFTER}', '${COMPANY_A_ID}', 'KH-BND-AFT', 'Khách 1ms Sau To', 'MANUAL', 'LEAD_NEW', '2026-09-20T00:00:00.001Z');
  `);

  {
    const overview = await fetchCompanyAnalyticsOverview(bossAClient, {
      companyId: COMPANY_A_ID,
      from: TEST_FROM,
      to: TEST_TO,
    });

    const manualSource = overview.customers.bySource.find((s) => s.source === 'MANUAL');
    assert(manualSource?.count === 1, `Test 15-18: Exactly 1 MANUAL customer counted in [from, to) (got ${manualSource?.count})`);
  }

  // ============================================================================
  // TEST GROUP 5: Customer & Pipeline Stage Semantics
  // ============================================================================
  console.log('\n--- TEST GROUP 5: Customer & Pipeline Stage Semantics ---');

  {
    const overview = await fetchCompanyAnalyticsOverview(bossAClient, {
      companyId: COMPANY_A_ID,
      from: TEST_FROM,
      to: TEST_TO,
    });

    // We have:
    // CUST_FB (2026-09-12): FACEBOOK (in period)
    // CUST_ZL (2026-09-14): ZALO (in period)
    // CUST_HL (2026-09-18): HOTLINE (in period)
    // CUST_BND_EXACT_FROM (2026-09-10): MANUAL (in period)
    // Total in period = 4 new customers
    assert(overview.customers.newCustomers === 4, `Test 19: newCustomers in period is 4 (got ${overview.customers.newCustomers})`);

    const sources = new Map(overview.customers.bySource.map((s) => [s.source, s.count]));
    assert(sources.get('FACEBOOK') === 1, 'Test 20: bySource FACEBOOK = 1');
    assert(sources.get('ZALO') === 1, 'Test 20: bySource ZALO = 1');
    assert(sources.get('HOTLINE') === 1, 'Test 20: bySource HOTLINE = 1');
    assert(sources.get('MANUAL') === 1, 'Test 20: bySource MANUAL = 1');

    // currentStageDistribution: snapshot of ALL customers in Company A
    // Total customers in Company A: 4 in period + 1 old + 1 bef + 1 to + 1 aft = 8 customers
    const stages = new Map(overview.currentStageDistribution.map((st) => [st.stage, st.count]));
    const totalCurrentCust = overview.currentStageDistribution.reduce((sum, st) => sum + st.count, 0);
    assert(totalCurrentCust === 8, `Test 21: currentStageDistribution contains all 8 company customers (got ${totalCurrentCust})`);
    assert(stages.get('CONTRACT_SIGNED') === 1, 'Test 21: Old customer outside period is included in currentStageDistribution snapshot');

    // stageTransitions: events in [TEST_FROM, TEST_TO)
    // In period transitions:
    // CUST_ZL: LEAD_NEW -> SURVEY_REQUESTED (09-13)
    // CUST_ZL: SURVEY_REQUESTED -> SURVEY_COMPLETED (09-14)
    // CUST_HL: LEAD_NEW -> PRICE_OFFERED (09-18)
    // CUST_HL: PRICE_OFFERED -> ORDER_CREATED (09-19)
    // CUST_OLD transition was in August (excluded)
    const transitions = new Map(overview.stageTransitions.map((t) => [t.toStage, t.count]));
    assert(transitions.get('SURVEY_REQUESTED') === 1, 'Test 22: stageTransitions to SURVEY_REQUESTED = 1');
    assert(transitions.get('SURVEY_COMPLETED') === 1, 'Test 22: stageTransitions to SURVEY_COMPLETED = 1');
    assert(transitions.get('PRICE_OFFERED') === 1, 'Test 22: stageTransitions to PRICE_OFFERED = 1');
    assert(transitions.get('ORDER_CREATED') === 1, 'Test 22: stageTransitions to ORDER_CREATED = 1');
    assert(!transitions.has('CONTRACT_SIGNED'), 'Test 22: Transition outside period is excluded');
  }

  // ============================================================================
  // TEST GROUP 6: Response SLA Analytics
  // ============================================================================
  console.log('\n--- TEST GROUP 6: Response SLA Analytics ---');

  {
    const overview = await fetchCompanyAnalyticsOverview(bossAClient, {
      companyId: COMPANY_A_ID,
      from: TEST_FROM,
      to: TEST_TO,
    });

    const sla = overview.responseSla;
    assert(sla.windowsStarted === 5, `Test 23: windowsStarted = 5 (got ${sla.windowsStarted})`);
    assert(sla.saleResponded === 2, `Test 23: saleResponded = 2 (got ${sla.saleResponded})`);
    assert(sla.saleRespondedWithin5m === 1, `Test 23: saleRespondedWithin5m = 1 (got ${sla.saleRespondedWithin5m})`);
    assert(sla.saleRespondedAfter5m === 1, `Test 23: saleRespondedAfter5m = 1 (got ${sla.saleRespondedAfter5m})`);
    assert(sla.aiResponded === 1, `Test 23: aiResponded = 1 (got ${sla.aiResponded})`);
    assert(sla.cancelled === 1, `Test 23: cancelled = 1 (got ${sla.cancelled})`);
    assert(sla.stillOpen === 1, `Test 23: stillOpen = 1 (got ${sla.stillOpen})`);

    // Average durations:
    // Window 1: 120s
    // Window 2: 400s
    // Avg sale = (120 + 400) / 2 = 260.0s
    assert(sla.avgSaleResponseSeconds === 260.0, `Test 24: avgSaleResponseSeconds = 260.0 (got ${sla.avgSaleResponseSeconds})`);

    // Window 3 (AI): 300s
    assert(sla.avgAiResponseSeconds === 300.0, `Test 24: avgAiResponseSeconds = 300.0 (got ${sla.avgAiResponseSeconds})`);

    // Compliance rate: 1 within 5m out of 2 resolved by sale = 5000 basis points
    assert(sla.complianceRateBasisPoints === 5000, `Test 25: complianceRateBasisPoints = 5000 (got ${sla.complianceRateBasisPoints})`);
  }

  // ============================================================================
  // TEST GROUP 7: Calls & Surveys Analytics
  // ============================================================================
  console.log('\n--- TEST GROUP 7: Calls & Surveys Analytics ---');

  {
    const overview = await fetchCompanyAnalyticsOverview(bossAClient, {
      companyId: COMPANY_A_ID,
      from: TEST_FROM,
      to: TEST_TO,
    });

    const calls = overview.calls;
    assert(calls.totalCalls === 4, `Test 26: totalCalls = 4 (got ${calls.totalCalls})`);
    assert(calls.inboundCalls === 2, `Test 26: inboundCalls = 2 (got ${calls.inboundCalls})`);
    assert(calls.outboundCalls === 2, `Test 26: outboundCalls = 2 (got ${calls.outboundCalls})`);
    assert(calls.connectedCalls === 1, `Test 26: connectedCalls = 1 (got ${calls.connectedCalls})`);
    assert(calls.completedCalls === 1, `Test 26: completedCalls = 1 (got ${calls.completedCalls})`);
    assert(calls.noAnswerCalls === 1, `Test 26: noAnswerCalls = 1 (got ${calls.noAnswerCalls})`);
    assert(calls.failedCalls === 1, `Test 26: failedCalls = 1 (got ${calls.failedCalls})`);

    const surveys = overview.surveys;
    assert(surveys.completedSurveys === 1, `Test 27: completedSurveys = 1 (got ${surveys.completedSurveys})`);
    assert(surveys.surveyAppointmentsCreated === 1, `Test 27: surveyAppointmentsCreated = 1 (got ${surveys.surveyAppointmentsCreated})`);
    assert(surveys.surveyAppointmentsCompleted === 1, `Test 27: surveyAppointmentsCompleted = 1 (got ${surveys.surveyAppointmentsCompleted})`);
  }

  // ============================================================================
  // TEST GROUP 8: Commercial Orders & Finance Semantics
  // ============================================================================
  console.log('\n--- TEST GROUP 8: Commercial Orders & Finance Semantics ---');

  {
    const overview = await fetchCompanyAnalyticsOverview(bossAClient, {
      companyId: COMPANY_A_ID,
      from: TEST_FROM,
      to: TEST_TO,
    });

    // Orders in period:
    // Order 1 (09-15): 15,000,000
    // Order 2 (09-18): 25,000,000
    // Total in period = 2 orders, orderValueCreated = "40000000.00"
    // Order Old (08-10): excluded from period created!
    assert(overview.orders.created === 2, `Test 28: orders.created in period is 2 (got ${overview.orders.created})`);
    assert(
      overview.orders.orderValueCreated === '40000000.00',
      `Test 29: orderValueCreated is "40000000.00" (got ${overview.orders.orderValueCreated})`
    );

    const statusMap = new Map(overview.orders.byStatus.map((s) => [s.status, s.count]));
    assert(statusMap.get('DEPOSIT_CONFIRMED') === 1, 'Test 30: byStatus DEPOSIT_CONFIRMED = 1');
    assert(statusMap.get('DRAFT') === 1, 'Test 30: byStatus DRAFT = 1');

    // Finance Snapshot:
    // MUST BE COMPANY-WIDE, NOT FILTERED BY PERIOD!
    // Total: Order 1 (15m) + Order 2 (25m) + Order Old (50m) = 90,000,000 contract value
    // collectedAmount: 15m + 50m = 65,000,000
    // receivableAmount: 25,000,000
    // completedRevenue: 50,000,000
    const fin = overview.financeSnapshot;
    assert(
      fin.contractValue === '90000000.00',
      `Test 31: Finance snapshot contractValue includes old order (expected 90000000.00, got ${fin.contractValue})`
    );
    assert(
      fin.collectedAmount === '65000000.00',
      `Test 32: collectedAmount is "65000000.00" (got ${fin.collectedAmount})`
    );
    assert(
      fin.receivableAmount === '25000000.00',
      `Test 32: receivableAmount is "25000000.00" (got ${fin.receivableAmount})`
    );
    assert(
      fin.completedRevenue === '50000000.00',
      `Test 32: completedRevenue is "50000000.00" (got ${fin.completedRevenue})`
    );
  }

  // ============================================================================
  // TEST GROUP 9: Care Campaign Deliveries Analytics
  // ============================================================================
  console.log('\n--- TEST GROUP 9: Care Campaign Deliveries Analytics ---');

  {
    const overview = await fetchCompanyAnalyticsOverview(bossAClient, {
      companyId: COMPANY_A_ID,
      from: TEST_FROM,
      to: TEST_TO,
    });

    const care = overview.care;
    assert(care.careSent === 3, `Test 33: careSent = 3 (got ${care.careSent})`);
    assert(care.careDelivered === 3, `Test 33: careDelivered = 3 (got ${care.careDelivered})`);
    assert(care.careResponded === 2, `Test 33: careResponded = 2 (got ${care.careResponded})`);
    assert(care.careConvertedToSale === 1, `Test 33: careConvertedToSale = 1 (got ${care.careConvertedToSale})`);

    // Verify unverified care_campaigns sent_count (9999) was completely ignored
    assert(care.careSent !== 9999, 'Test 34: Ignored care_campaigns.sent_count = 9999');
  }

  // ============================================================================
  // TEST GROUP 10: Daily Time-Series Analytics
  // ============================================================================
  console.log('\n--- TEST GROUP 10: Daily Time-Series Analytics ---');

  {
    const series = await fetchCompanyAnalyticsDailySeries(bossAClient, {
      companyId: COMPANY_A_ID,
      from: TEST_FROM,
      to: TEST_TO,
    });

    assert(series.length === 10, `Test 35: 10 daily buckets generated (got ${series.length})`);
    assert(series[0].date === '2026-09-10', 'Test 35: First bucket date is 2026-09-10');
    assert(series[9].date === '2026-09-19', 'Test 35: Last bucket date is 2026-09-19');

    // On 2026-09-11: careConvertedToSale = 1
    const day0911 = series.find((d) => d.date === '2026-09-11');
    assert(day0911?.careConvertedToSale === 1, 'Test 36: 2026-09-11 has careConvertedToSale = 1');

    // On 2026-09-12: newCustomers = 1 (CUST_FB), slaWindowsStarted = 1, saleWithin5m = 1
    const day0912 = series.find((d) => d.date === '2026-09-12');
    assert(day0912?.newCustomers === 1, 'Test 36: 2026-09-12 has newCustomers = 1');
    assert(day0912?.slaWindowsStarted === 1, 'Test 36: 2026-09-12 has slaWindowsStarted = 1');
    assert(day0912?.saleWithin5m === 1, 'Test 36: 2026-09-12 has saleWithin5m = 1');

    // On 2026-09-15: ordersCreated = 1, orderValueCreated = "15000000.00"
    const day0915 = series.find((d) => d.date === '2026-09-15');
    assert(day0915?.ordersCreated === 1, 'Test 36: 2026-09-15 has ordersCreated = 1');
    assert(day0915?.orderValueCreated === '15000000.00', `Test 36: 2026-09-15 has orderValueCreated = 15000000.00 (got ${day0915?.orderValueCreated})`);

    // On 2026-09-18: ordersCreated = 1, orderValueCreated = "25000000.00"
    const day0918 = series.find((d) => d.date === '2026-09-18');
    assert(day0918?.ordersCreated === 1, 'Test 36: 2026-09-18 has ordersCreated = 1');
    assert(day0918?.orderValueCreated === '25000000.00', `Test 36: 2026-09-18 has orderValueCreated = 25000000.00 (got ${day0918?.orderValueCreated})`);

    // On 2026-09-17: zero activity day
    const day0917 = series.find((d) => d.date === '2026-09-17');
    assert(day0917?.newCustomers === 0, 'Test 37: 2026-09-17 has newCustomers = 0');
    assert(day0917?.ordersCreated === 0, 'Test 37: 2026-09-17 has ordersCreated = 0');
    assert(day0917?.orderValueCreated === '0.00', 'Test 37: 2026-09-17 has orderValueCreated = "0.00"');
    assert(day0917?.slaWindowsStarted === 0, 'Test 37: 2026-09-17 has slaWindowsStarted = 0');
  }

  // ============================================================================
  // TEST GROUP 11: End-to-End Server Store Typing & Integration
  // ============================================================================
  console.log('\n--- TEST GROUP 11: End-to-End Server Store Integration ---');

  {
    const overview: CompanyAnalyticsOverview = await fetchCompanyAnalyticsOverview(bossAClient, {
      companyId: COMPANY_A_ID,
      from: TEST_FROM,
      to: TEST_TO,
    });
    assert(typeof overview.period.from === 'string', 'Test 38: Typed overview has period.from');
    assert(typeof overview.financeSnapshot.snapshotAt === 'string', 'Test 38: Typed overview has financeSnapshot.snapshotAt');

    const series: CompanyAnalyticsDailySeries = await fetchCompanyAnalyticsDailySeries(bossAClient, {
      companyId: COMPANY_A_ID,
      from: TEST_FROM,
      to: TEST_TO,
    });
    assert(Array.isArray(series), 'Test 39: Typed series is an array');
    assert(typeof series[0].date === 'string', 'Test 39: Typed series items have date string');
  }

  // ============================================================================
  // TEST GROUP 12: Partial-Day [from, to) Precision for Daily Time-Series
  // ============================================================================
  console.log('\n--- TEST GROUP 12: Partial-Day [from, to) Precision for Daily Time-Series ---');

  // Specific fixture range requested:
  // from = 2026-09-01T12:00:00Z
  // to   = 2026-09-02T12:00:00Z
  //
  // Fixture events:
  // 2026-09-01 11:59:59Z -> EXCLUDE
  // 2026-09-01 12:00:00Z -> INCLUDE bucket 2026-09-01
  // 2026-09-01 23:59:59Z -> INCLUDE bucket 2026-09-01
  // 2026-09-02 00:00:00Z -> INCLUDE bucket 2026-09-02
  // 2026-09-02 11:59:59Z -> INCLUDE bucket 2026-09-02
  // 2026-09-02 12:00:00Z -> EXCLUDE
  //
  // Daily buckets must strictly adhere to intersection [max(day_start, p_from), min(day_end, p_to))

  const PARTIAL_FROM = '2026-09-01T12:00:00.000Z';
  const PARTIAL_TO = '2026-09-02T12:00:00.000Z';

  const TS_PD_EXCL_1 = '2026-09-01T11:59:59.000Z'; // EXCLUDE
  const TS_PD_INCL_1 = '2026-09-01T12:00:00.000Z'; // INCLUDE 2026-09-01
  const TS_PD_INCL_2 = '2026-09-01T23:59:59.000Z'; // INCLUDE 2026-09-01
  const TS_PD_INCL_3 = '2026-09-02T00:00:00.000Z'; // INCLUDE 2026-09-02
  const TS_PD_INCL_4 = '2026-09-02T11:59:59.000Z'; // INCLUDE 2026-09-02
  const TS_PD_EXCL_2 = '2026-09-02T12:00:00.000Z'; // EXCLUDE

  const CALC_PD_PREFIX = 'c8100000-0000-0000-0000-00000000002';
  const CUST_PD_PREFIX = 'c1000000-0000-0000-0000-00000000002';
  const ORDER_PD_PREFIX = 'c9000000-0000-0000-0000-00000000002';
  const CONVO_PD_PREFIX = 'c2000000-0000-0000-0000-00000000002';
  const INT_PD_PREFIX = 'c3000000-0000-0000-0000-00000000002';
  const SLA_PD_PREFIX = 'c4000000-0000-0000-0000-00000000002';
  const CARE_PD_PREFIX = 'cb000000-0000-0000-0000-00000000002';

  const pdTimestamps = [
    { id: '1', ts: TS_PD_EXCL_1, expectedBucket: null },
    { id: '2', ts: TS_PD_INCL_1, expectedBucket: '2026-09-01' },
    { id: '3', ts: TS_PD_INCL_2, expectedBucket: '2026-09-01' },
    { id: '4', ts: TS_PD_INCL_3, expectedBucket: '2026-09-02' },
    { id: '5', ts: TS_PD_INCL_4, expectedBucket: '2026-09-02' },
    { id: '6', ts: TS_PD_EXCL_2, expectedBucket: null },
  ];

  executeRawSql(`
    INSERT INTO public.customers (id, company_id, customer_code, name, source, stage, created_at)
    VALUES
      ${pdTimestamps.map((t) => `('${CUST_PD_PREFIX}${t.id}', '${COMPANY_A_ID}', 'KH-PD-${t.id}', 'KH PD ${t.id}', 'ZALO', 'LEAD_NEW', '${t.ts}')`).join(',\n      ')};

    INSERT INTO public.price_calculations (id, company_id, customer_id, pricing_policy_id, policy_version, input_data, amount, status)
    VALUES
      ${pdTimestamps.map((t) => `('${CALC_PD_PREFIX}${t.id}', '${COMPANY_A_ID}', '${CUST_PD_PREFIX}${t.id}', '${POLICY_1}', 'V2026.1', '{}'::jsonb, 1000000.00, 'CALCULATED')`).join(',\n      ')};

    INSERT INTO public.orders (id, company_id, customer_id, order_code, payment_reference, price_calculation_id, deposit_status, order_status, final_amount, created_at)
    VALUES
      ${pdTimestamps.map((t) => `('${ORDER_PD_PREFIX}${t.id}', '${COMPANY_A_ID}', '${CUST_PD_PREFIX}${t.id}', 'ORD-PD-${t.id}', 'PAY-PD-${t.id}', '${CALC_PD_PREFIX}${t.id}', 'CONFIRMED', 'COMPLETED', 1000000.00, '${t.ts}')`).join(',\n      ')};

    INSERT INTO public.conversations (id, company_id, customer_id, channel, external_conversation_id, status)
    VALUES
      ${pdTimestamps.map((t) => `('${CONVO_PD_PREFIX}${t.id}', '${COMPANY_A_ID}', '${CUST_PD_PREFIX}${t.id}', 'ZALO', 'ext_pd_${t.id}', 'OPEN')`).join(',\n      ')};

    INSERT INTO public.interactions (id, company_id, customer_id, conversation_id, direction, type, channel, sanitization_status, actor_type, created_at)
    VALUES
      ${pdTimestamps.map((t) => `('${INT_PD_PREFIX}${t.id}', '${COMPANY_A_ID}', '${CUST_PD_PREFIX}${t.id}', '${CONVO_PD_PREFIX}${t.id}', 'INBOUND', 'MESSAGE', 'ZALO', 'SUCCEEDED', 'CUSTOMER', '${t.ts}')`).join(',\n      ')};

    INSERT INTO public.response_sla_windows (
      id, company_id, conversation_id, customer_id, trigger_interaction_id,
      started_at, deadline_at, state, resolved_at
    ) VALUES
      ${pdTimestamps.map((t) => `('${SLA_PD_PREFIX}${t.id}', '${COMPANY_A_ID}', '${CONVO_PD_PREFIX}${t.id}', '${CUST_PD_PREFIX}${t.id}', '${INT_PD_PREFIX}${t.id}', '${t.ts}', ('${t.ts}'::timestamptz + interval '5 minutes'), 'OPEN', NULL)`).join(',\n      ')};

    INSERT INTO public.care_deliveries (
      id, company_id, campaign_id, customer_id, idempotency_key, channel, status, sent_at, converted_to_sale_at
    ) VALUES
      ${pdTimestamps.map((t) => `('${CARE_PD_PREFIX}${t.id}', '${COMPANY_A_ID}', '${CAMPAIGN_1}', '${CUST_PD_PREFIX}${t.id}', 'care-idem-pd-${t.id}', 'ZALO', 'CONVERTED_TO_SALE', '${t.ts}', '${t.ts}')`).join(',\n      ')};
  `);

  {
    const pdSeries = await fetchCompanyAnalyticsDailySeries(bossAClient, {
      companyId: COMPANY_A_ID,
      from: PARTIAL_FROM,
      to: PARTIAL_TO,
    });

    assert(pdSeries.length === 2, `Test 40: Exactly 2 daily buckets generated for [2026-09-01T12:00:00Z, 2026-09-02T12:00:00Z) (got ${pdSeries.length})`);
    assert(pdSeries[0].date === '2026-09-01', 'Test 40: First bucket date is 2026-09-01');
    assert(pdSeries[1].date === '2026-09-02', 'Test 40: Second bucket date is 2026-09-02');

    // Bucket 2026-09-01:
    // 11:59:59Z excluded (< from), 12:00:00Z and 23:59:59Z included => exactly 2
    const b1 = pdSeries[0];
    assert(b1.newCustomers === 2, `Test 41: 2026-09-01 bucket has exactly 2 newCustomers (got ${b1.newCustomers}, T1 excluded, T2+T3 included)`);
    assert(b1.ordersCreated === 2, `Test 41: 2026-09-01 bucket has exactly 2 ordersCreated (got ${b1.ordersCreated})`);
    assert(b1.orderValueCreated === '2000000.00', `Test 41: 2026-09-01 bucket orderValueCreated is "2000000.00" (got ${b1.orderValueCreated})`);
    assert(b1.slaWindowsStarted === 2, `Test 41: 2026-09-01 bucket has exactly 2 slaWindowsStarted (got ${b1.slaWindowsStarted})`);
    assert(b1.careConvertedToSale === 2, `Test 41: 2026-09-01 bucket has exactly 2 careConvertedToSale (got ${b1.careConvertedToSale})`);

    // Bucket 2026-09-02:
    // 00:00:00Z and 11:59:59Z included, 12:00:00Z excluded (>= to) => exactly 2
    const b2 = pdSeries[1];
    assert(b2.newCustomers === 2, `Test 42: 2026-09-02 bucket has exactly 2 newCustomers (got ${b2.newCustomers}, T4+T5 included, T6 excluded)`);
    assert(b2.ordersCreated === 2, `Test 42: 2026-09-02 bucket has exactly 2 ordersCreated (got ${b2.ordersCreated})`);
    assert(b2.orderValueCreated === '2000000.00', `Test 42: 2026-09-02 bucket orderValueCreated is "2000000.00" (got ${b2.orderValueCreated})`);
    assert(b2.slaWindowsStarted === 2, `Test 42: 2026-09-02 bucket has exactly 2 slaWindowsStarted (got ${b2.slaWindowsStarted})`);
    assert(b2.careConvertedToSale === 2, `Test 42: 2026-09-02 bucket has exactly 2 careConvertedToSale (got ${b2.careConvertedToSale})`);

    // Overview comparison to ensure both RPCs evaluate identical half-open bounds
    const pdOverview = await fetchCompanyAnalyticsOverview(bossAClient, {
      companyId: COMPANY_A_ID,
      from: PARTIAL_FROM,
      to: PARTIAL_TO,
    });
    assert(pdOverview.customers.newCustomers === 4, `Test 43: Overview newCustomers matches sum of daily buckets (4, got ${pdOverview.customers.newCustomers})`);
    assert(pdOverview.orders.created === 4, `Test 43: Overview orders.created matches sum of daily buckets (4, got ${pdOverview.orders.created})`);
    assert(pdOverview.orders.orderValueCreated === '4000000.00', `Test 43: Overview orderValueCreated matches sum of daily buckets ("4000000.00", got ${pdOverview.orders.orderValueCreated})`);
    assert(pdOverview.responseSla.windowsStarted === 4, `Test 43: Overview sla windows matches sum of daily buckets (4, got ${pdOverview.responseSla.windowsStarted})`);
    assert(pdOverview.care.careConvertedToSale === 4, `Test 43: Overview care converted matches sum of daily buckets (4, got ${pdOverview.care.careConvertedToSale})`);
  }

  // ============================================================================
  // TEST GROUP 13: Aggregate-Only Leakage Tests (Zero Row-Level Exposure)
  // ============================================================================
  console.log('\n--- TEST GROUP 13: Aggregate-Only Leakage Tests ---');

  const FORBIDDEN_LEAKAGE_KEYS = [
    'customer_id',
    'customerId',
    'customer_code',
    'customerCode',
    'name',
    'phone',
    'raw_phone',
    'normalized_phone',
    'interaction_id',
    'conversation_id',
    'call_id',
    'order_id',
    'payment_reference',
    'recording_ref',
    'transcript',
    'provider_account',
    'transfer_content',
  ];

  function extractAllKeys(obj: unknown): string[] {
    const keys = new Set<string>();
    function recurse(curr: unknown) {
      if (curr === null || typeof curr !== 'object') return;
      if (Array.isArray(curr)) {
        for (const item of curr) recurse(item);
      } else {
        for (const [k, v] of Object.entries(curr as Record<string, unknown>)) {
          keys.add(k);
          recurse(v);
        }
      }
    }
    recurse(obj);
    return Array.from(keys);
  }

  {
    const overview = await fetchCompanyAnalyticsOverview(bossAClient, {
      companyId: COMPANY_A_ID,
      from: TEST_FROM,
      to: TEST_TO,
    });
    const overviewKeys = extractAllKeys(overview);
    for (const forbidden of FORBIDDEN_LEAKAGE_KEYS) {
      assert(!overviewKeys.includes(forbidden), `Test 44: Overview does not contain sensitive key "${forbidden}"`);
    }

    const overviewJsonStr = JSON.stringify(overview);
    for (const forbidden of FORBIDDEN_LEAKAGE_KEYS) {
      assert(!overviewJsonStr.includes(`"${forbidden}"`), `Test 44: Overview JSON string does not contain serialized "${forbidden}"`);
    }

    const series = await fetchCompanyAnalyticsDailySeries(bossAClient, {
      companyId: COMPANY_A_ID,
      from: TEST_FROM,
      to: TEST_TO,
    });
    const seriesKeys = extractAllKeys(series);
    for (const forbidden of FORBIDDEN_LEAKAGE_KEYS) {
      assert(!seriesKeys.includes(forbidden), `Test 45: Daily series does not contain sensitive key "${forbidden}"`);
    }

    const seriesJsonStr = JSON.stringify(series);
    for (const forbidden of FORBIDDEN_LEAKAGE_KEYS) {
      assert(!seriesJsonStr.includes(`"${forbidden}"`), `Test 45: Daily series JSON string does not contain serialized "${forbidden}"`);
    }

    // Static test migration file: ensure zero references to private schema and forbidden tables
    const migrationPath = path.resolve(__dirname, '../../supabase/migrations/20260923000003_analytics_dashboard.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    assert(!migrationSql.includes('private.customer_private_contacts'), 'Test 46: Migration does not query private.customer_private_contacts');
    assert(!migrationSql.includes('private.interaction_raw_contents'), 'Test 46: Migration does not query private.interaction_raw_contents');
    assert(!migrationSql.includes('private.call_transcripts'), 'Test 46: Migration does not query private.call_transcripts');
    assert(!migrationSql.includes('payment_transactions'), 'Test 46: Migration does not query payment_transactions');
    assert(!migrationSql.toLowerCase().includes('from private.'), 'Test 46: Migration does not read from private schema');
    assert(!migrationSql.toLowerCase().includes('join private.'), 'Test 46: Migration does not join private schema');
  }

  // ============================================================================
  // TEST GROUP 14: Finance Snapshot Timestamp Semantics & Invariance
  // ============================================================================
  console.log('\n--- TEST GROUP 14: Finance Snapshot Timestamp Semantics & Invariance ---');

  {
    // Test 47: Range changes but finance snapshot remains invariant (company-wide, not period-filtered)
    const overviewRange1 = await fetchCompanyAnalyticsOverview(bossAClient, {
      companyId: COMPANY_A_ID,
      from: '2026-09-10T00:00:00.000Z',
      to: '2026-09-20T00:00:00.000Z',
    });

    const overviewRange2 = await fetchCompanyAnalyticsOverview(bossAClient, {
      companyId: COMPANY_A_ID,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-05T00:00:00.000Z',
    });

    // Orders in period are different
    assert(overviewRange1.orders.created !== overviewRange2.orders.created, 'Test 47: Different periods have different period-filtered orders count');

    // But financeSnapshot MUST be identical
    assert(
      overviewRange1.financeSnapshot.contractValue === overviewRange2.financeSnapshot.contractValue,
      'Test 47: contractValue is identical across different time ranges'
    );
    assert(
      overviewRange1.financeSnapshot.collectedAmount === overviewRange2.financeSnapshot.collectedAmount,
      'Test 47: collectedAmount is identical across different time ranges'
    );
    assert(
      overviewRange1.financeSnapshot.receivableAmount === overviewRange2.financeSnapshot.receivableAmount,
      'Test 47: receivableAmount is identical across different time ranges'
    );
    assert(
      overviewRange1.financeSnapshot.completedRevenue === overviewRange2.financeSnapshot.completedRevenue,
      'Test 47: completedRevenue is identical across different time ranges'
    );

    // Test 48: snapshotAt semantics - represents query generation time, not max(updated_at)
    const snapshotAtTime = Date.parse(overviewRange1.financeSnapshot.snapshotAt);
    assert(!isNaN(snapshotAtTime), 'Test 48: snapshotAt is a valid parseable ISO timestamp');
    const ageSeconds = Math.abs(Date.now() - snapshotAtTime) / 1000;
    assert(ageSeconds < 120, `Test 48: snapshotAt is generated in current transaction/statement (< 120s ago, got ${ageSeconds.toFixed(1)}s)`);

    // Static test migration file: ensure snapshotAt uses statement_timestamp() and not MAX(updated_at)
    const migrationPath = path.resolve(__dirname, '../../supabase/migrations/20260923000003_analytics_dashboard.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    assert(migrationSql.includes("'snapshotAt', statement_timestamp()"), "Test 49: Migration uses statement_timestamp() for financeSnapshot.snapshotAt");
    assert(!migrationSql.includes("MAX(updated_at)"), "Test 49: Migration does not use MAX(updated_at) as snapshotAt");

    // Test 50: Daily series does not contain finance fields
    const series = await fetchCompanyAnalyticsDailySeries(bossAClient, {
      companyId: COMPANY_A_ID,
      from: TEST_FROM,
      to: TEST_TO,
    });
    for (const bucket of series) {
      assert(!('contractValue' in bucket), 'Test 50: Daily bucket does not contain contractValue');
      assert(!('collectedAmount' in bucket), 'Test 50: Daily bucket does not contain collectedAmount');
      assert(!('receivableAmount' in bucket), 'Test 50: Daily bucket does not contain receivableAmount');
      assert(!('completedRevenue' in bucket), 'Test 50: Daily bucket does not contain completedRevenue');
      assert(!('snapshotAt' in bucket), 'Test 50: Daily bucket does not contain snapshotAt');
    }

    // Test 51: Overview money values return decimal strings (format /^\d+\.\d{2}$/)
    const decimalRegex = /^\d+\.\d{2}$/;
    assert(decimalRegex.test(overviewRange1.orders.orderValueCreated), `Test 51: orders.orderValueCreated is decimal string (got ${overviewRange1.orders.orderValueCreated})`);
    assert(decimalRegex.test(overviewRange1.financeSnapshot.contractValue), `Test 51: financeSnapshot.contractValue is decimal string (got ${overviewRange1.financeSnapshot.contractValue})`);
    assert(decimalRegex.test(overviewRange1.financeSnapshot.collectedAmount), `Test 51: financeSnapshot.collectedAmount is decimal string (got ${overviewRange1.financeSnapshot.collectedAmount})`);
    assert(decimalRegex.test(overviewRange1.financeSnapshot.receivableAmount), `Test 51: financeSnapshot.receivableAmount is decimal string (got ${overviewRange1.financeSnapshot.receivableAmount})`);
    assert(decimalRegex.test(overviewRange1.financeSnapshot.completedRevenue), `Test 51: financeSnapshot.completedRevenue is decimal string (got ${overviewRange1.financeSnapshot.completedRevenue})`);

    // Test 52: Zero state returns "0.00"
    const emptyOverview = await fetchCompanyAnalyticsOverview(bossAClient, {
      companyId: COMPANY_EMPTY_ID,
      from: TEST_FROM,
      to: TEST_TO,
    });
    assert(emptyOverview.orders.orderValueCreated === '0.00', 'Test 52: Empty orderValueCreated is "0.00"');
    assert(emptyOverview.financeSnapshot.contractValue === '0.00', 'Test 52: Empty contractValue is "0.00"');
    assert(emptyOverview.financeSnapshot.collectedAmount === '0.00', 'Test 52: Empty collectedAmount is "0.00"');
    assert(emptyOverview.financeSnapshot.receivableAmount === '0.00', 'Test 52: Empty receivableAmount is "0.00"');
    assert(emptyOverview.financeSnapshot.completedRevenue === '0.00', 'Test 52: Empty completedRevenue is "0.00"');
  }

  console.log(`\n==================================================`);
  console.log(`ANALYTICS TEST RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log(`==================================================\n`);
}

runTests().catch((err) => {
  console.error('Test execution fatal error:', err);
  process.exit(1);
});
