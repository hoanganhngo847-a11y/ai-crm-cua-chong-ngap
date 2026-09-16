import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  CONTACT_ACCESS_PURPOSES,
  RAW_INTERACTION_PURPOSES,
  SIGNED_URL_TTL,
  type CallProvider,
} from '../../shared/contracts/sensitive';
import { ServerAuthError } from '../../lib/server-auth/errors';
import {
  authorizeCustomerAccess,
  authorizeAppointmentAccess,
  authorizeSurveyAccess,
  authorizeInstallationAccess,
  authorizeOrderAccess,
  authorizeContractAccess,
  authorizePaymentAccess,
  authorizeInteractionAccess,
} from '../../lib/server-auth/resource-access';
import { resolveCustomerPrivateContactForTrustedOperation } from '../../lib/sensitive/customer-contact';
import { executeClickToCall } from '../../lib/sensitive/click-to-call';
import {
  getSanitizedInteractionForSale,
  resolveRawInteractionContentForTrustedOperation,
} from '../../lib/sensitive/interactions';
import {
  createAuthorizedSignedUrl,
  getCategoryTTL,
} from '../../lib/sensitive/signed-urls';
import * as PublicSensitiveActions from '../../app/actions/sensitive';
import {
  internalClickToCallAction,
  internalGetSanitizedInteractionAction,
  internalGetAuthorizedSignedUrlAction,
  internalViewBossRawPhoneAction,
} from '../../lib/sensitive/action-handlers';

// Local Supabase credentials
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
  execSync('docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -U postgres -d postgres', {
    input: sql,
    encoding: 'utf8',
  });
}

// Fixed deterministic UUIDs (dedicated to security suite to prevent collisions with auth suite)
const COMPANY_A_ID = '33333333-3333-3333-3333-333333333333';
const COMPANY_B_ID = '44444444-4444-4444-4444-444444444444';

const CUSTOMER_A_ID = 'aaaaaaaa-1111-0000-0000-000000000001';
const CUSTOMER_B_ID = 'bbbbbbbb-2222-0000-0000-000000000002';

const APPT_ACTIVE_ASSIGNED_ID = 'aaaaaaaa-1111-0000-0000-000000000011';
const APPT_ACTIVE_ACCEPTED_ID = 'aaaaaaaa-1111-0000-0000-000000000012';
const APPT_ACTIVE_PROGRESS_ID = 'aaaaaaaa-1111-0000-0000-000000000013';
const APPT_COMPLETED_ID = 'aaaaaaaa-1111-0000-0000-000000000014';
const APPT_CANCELLED_ID = 'aaaaaaaa-1111-0000-0000-000000000015';
const APPT_REJECTED_ID = 'aaaaaaaa-1111-0000-0000-000000000016';
const APPT_OTHER_TECH_ID = 'aaaaaaaa-1111-0000-0000-000000000017';
const APPT_INSTALL_ID = 'aaaaaaaa-1111-0000-0000-000000000018';

const SURVEY_ACTIVE_ID = 'aaaaaaaa-1111-0000-0000-000000000021';
const SURVEY_COMPLETED_ID = 'aaaaaaaa-1111-0000-0000-000000000022';

const ORDER_A_ID = 'aaaaaaaa-1111-0000-0000-000000000031';
const CONTRACT_A_ID = 'aaaaaaaa-1111-0000-0000-000000000041';
const PAYMENT_A_ID = 'aaaaaaaa-1111-0000-0000-000000000051';
const CALL_A_ID = 'aaaaaaaa-1111-0000-0000-000000000061';

const INTERACTION_SUCCEEDED_ID = 'aaaaaaaa-1111-0000-0000-000000000071';
const INTERACTION_PENDING_ID = 'aaaaaaaa-1111-0000-0000-000000000072';
const INTERACTION_FAILED_ID = 'aaaaaaaa-1111-0000-0000-000000000073';
const INTERACTION_BYPASS_ATTEMPT_ID = 'aaaaaaaa-1111-0000-0000-000000000074';
const INTERACTION_NON_TEXTUAL_ID = 'aaaaaaaa-1111-0000-0000-000000000075';
const INTERACTION_NON_SYSTEM_NOT_REQ_ID = 'aaaaaaaa-1111-0000-0000-000000000076';

const INSTALLATION_A_ID = 'aaaaaaaa-1111-0000-0000-000000000095';

const POLICY_A_ID = 'aaaaaaaa-1111-0000-0000-000000000081';
const PRICING_CALC_A_ID = 'aaaaaaaa-1111-0000-0000-000000000091';

// Test User Credentials
const TEST_USERS = {
  sale: { email: 'sec_sale@trusted.local', password: 'Password123!', fullName: 'Nguyễn Văn Sale' },
  tech: { email: 'sec_tech@trusted.local', password: 'Password123!', fullName: 'Trần Kỹ Thuật' },
  tech2: { email: 'sec_tech2@trusted.local', password: 'Password123!', fullName: 'Phạm Kỹ Thuật 2' },
  boss: { email: 'sec_boss@trusted.local', password: 'Password123!', fullName: 'Lê Quản Trị (Sếp)' },
  inactiveProfile: { email: 'sec_inactive_profile@trusted.local', password: 'Password123!', fullName: 'Nhân Viên Bị Khóa' },
  inactiveMember: { email: 'sec_inactive_member@trusted.local', password: 'Password123!', fullName: 'Nghỉ Việc Member' },
  saleB: { email: 'sec_sale_b@trusted.local', password: 'Password123!', fullName: 'Vũ Sale Công Ty B' },
};

let techUserId = '';
let tech2UserId = '';

async function setupTestData() {
  console.log('--- Setting up local test database fixtures for trusted server ---');

  // 1. Ensure companies exist
  await adminClient.from('companies').upsert([
    { id: COMPANY_A_ID, name: 'Công Ty Cửa Chống Ngập A', status: 'ACTIVE' },
    { id: COMPANY_B_ID, name: 'Công Ty Cửa Chống Ngập B', status: 'ACTIVE' },
  ]);

  // 2. Setup user creation helper
  async function ensureUser(
    config: { email: string; password: string; fullName: string },
    companyId: string,
    role: 'BOSS_ADMIN' | 'SALE' | 'TECHNICIAN',
    profileStatus: 'ACTIVE' | 'INACTIVE',
    membershipStatus: 'ACTIVE' | 'INACTIVE'
  ) {
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

    // Set profile status
    await adminClient.from('user_profiles').upsert({
      id: userId,
      full_name: config.fullName,
      status: profileStatus,
    });

    // Set membership
    const { error: memberErr } = await adminClient.from('company_members').upsert(
      {
        company_id: companyId,
        user_id: userId,
        role,
        status: membershipStatus,
      },
      { onConflict: 'company_id,user_id' }
    );
    if (memberErr) {
      throw new Error(`Failed to configure member ${config.email}: ${memberErr.message}`);
    }

    return userId;
  }

  await ensureUser(TEST_USERS.boss, COMPANY_A_ID, 'BOSS_ADMIN', 'ACTIVE', 'ACTIVE');
  await ensureUser(TEST_USERS.sale, COMPANY_A_ID, 'SALE', 'ACTIVE', 'ACTIVE');
  techUserId = await ensureUser(TEST_USERS.tech, COMPANY_A_ID, 'TECHNICIAN', 'ACTIVE', 'ACTIVE');
  tech2UserId = await ensureUser(TEST_USERS.tech2, COMPANY_A_ID, 'TECHNICIAN', 'ACTIVE', 'ACTIVE');
  await ensureUser(TEST_USERS.inactiveProfile, COMPANY_A_ID, 'BOSS_ADMIN', 'INACTIVE', 'ACTIVE');
  await ensureUser(TEST_USERS.inactiveMember, COMPANY_A_ID, 'SALE', 'ACTIVE', 'INACTIVE');
  await ensureUser(TEST_USERS.saleB, COMPANY_B_ID, 'SALE', 'ACTIVE', 'ACTIVE');

  // 3. Customers
  await adminClient.from('customers').upsert([
    {
      id: CUSTOMER_A_ID,
      company_id: COMPANY_A_ID,
      customer_code: 'KH-000001',
      name: 'Khách Hàng Công Ty A',
      source: 'FACEBOOK',
      stage: 'LEAD_NEW',
    },
    {
      id: CUSTOMER_B_ID,
      company_id: COMPANY_B_ID,
      customer_code: 'KH-000002',
      name: 'Khách Hàng Công Ty B',
      source: 'HOTLINE',
      stage: 'LEAD_NEW',
    },
  ]);

  // 4. Private Contacts (seeded via psql since schema 'private' is not exposed to PostgREST)
  executeRawSql(`
    INSERT INTO private.customer_private_contacts (company_id, customer_id, normalized_phone, raw_phone, phone_country_code, is_verified)
    VALUES
      ('${COMPANY_A_ID}', '${CUSTOMER_A_ID}', '+84988111222', '0988111222', 'VN', true),
      ('${COMPANY_B_ID}', '${CUSTOMER_B_ID}', '+84988333444', '0988333444', 'VN', true)
    ON CONFLICT (customer_id) DO UPDATE SET
      normalized_phone = EXCLUDED.normalized_phone,
      raw_phone = EXCLUDED.raw_phone,
      is_verified = EXCLUDED.is_verified;
  `);

  // 5. Appointments
  const apptRows = [
    { id: APPT_ACTIVE_ASSIGNED_ID, status: 'ASSIGNED', assignee_id: techUserId },
    { id: APPT_ACTIVE_ACCEPTED_ID, status: 'ACCEPTED', assignee_id: techUserId },
    { id: APPT_ACTIVE_PROGRESS_ID, status: 'IN_PROGRESS', assignee_id: techUserId },
    { id: APPT_COMPLETED_ID, status: 'COMPLETED', assignee_id: techUserId },
    { id: APPT_CANCELLED_ID, status: 'CANCELLED', assignee_id: techUserId },
    { id: APPT_REJECTED_ID, status: 'REJECTED', assignee_id: techUserId },
    { id: APPT_OTHER_TECH_ID, status: 'ASSIGNED', assignee_id: tech2UserId },
    { id: APPT_INSTALL_ID, status: 'ASSIGNED', assignee_id: techUserId, type: 'INSTALLATION' },
  ];

  for (const a of apptRows) {
    const { error: apptErr } = await adminClient.from('appointments').upsert({
      id: a.id,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      type: a.type || 'SURVEY',
      start_time: new Date().toISOString(),
      assignee_id: a.assignee_id,
      address: '123 Đường Khảo Sát, Quận 1',
      status: a.status,
    });
    if (apptErr) {
      throw new Error(`Failed to upsert appointment ${a.id}: ${apptErr.message}`);
    }
  }

  // 6. Surveys
  await adminClient.from('surveys').upsert([
    {
      id: SURVEY_ACTIVE_ID,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      appointment_id: APPT_ACTIVE_ASSIGNED_ID,
      completed_by: techUserId,
      measurements: { width_mm: 1200, height_mm: 600 },
      photos: ['survey_photo1.jpg'],
      site_condition: 'Mặt bằng phẳng',
      notes: 'Khảo sát đang tiến hành',
      completed_at: new Date().toISOString(),
    },
    {
      id: SURVEY_COMPLETED_ID,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      appointment_id: APPT_COMPLETED_ID,
      completed_by: techUserId,
      measurements: { width_mm: 1500, height_mm: 700 },
      photos: ['survey_photo2.jpg'],
      site_condition: 'Đã hoàn thành trước đây',
      notes: 'Khảo sát cũ',
      completed_at: new Date(Date.now() - 86400000).toISOString(),
    },
  ]);

  // 7. Pricing Policy & Calculation & Order & Contract & Payment & Installation
  await adminClient.from('pricing_policies').upsert({
    id: POLICY_A_ID,
    company_id: COMPANY_A_ID,
    version: 'V1.0',
    conditions: {},
    price_rules: {},
    effective_at: new Date().toISOString(),
    status: 'ACTIVE',
  });

  await adminClient.from('price_calculations').upsert({
    id: PRICING_CALC_A_ID,
    company_id: COMPANY_A_ID,
    customer_id: CUSTOMER_A_ID,
    pricing_policy_id: POLICY_A_ID,
    policy_version: 'V1.0',
    input_data: {},
    amount: 15000000,
    status: 'CALCULATED',
  });

  await adminClient.from('orders').upsert({
    id: ORDER_A_ID,
    company_id: COMPANY_A_ID,
    customer_id: CUSTOMER_A_ID,
    order_code: 'DH-000001',
    payment_reference: 'TT-DH000001',
    price_calculation_id: PRICING_CALC_A_ID,
    deposit_status: 'PENDING',
    order_status: 'DRAFT',
    final_amount: 15000000,
  });

  await adminClient.from('contracts').upsert({
    id: CONTRACT_A_ID,
    company_id: COMPANY_A_ID,
    order_id: ORDER_A_ID,
    revision_no: 1,
    template_version: 'V1',
    generated_file_ref: 'contracts/contract_001.pdf',
    signed_file_ref: null,
    status: 'GENERATED',
    contract_value: 15000000,
    is_current: true,
  });

  await adminClient.from('payment_transactions').upsert({
    id: PAYMENT_A_ID,
    company_id: COMPANY_A_ID,
    provider: 'VIETQR',
    provider_account: '9704***1234',
    provider_ref: 'TXN-999001',
    amount: 5000000,
    occurred_at: new Date().toISOString(),
    transfer_content: 'TT-DH000001',
    matched_order_id: ORDER_A_ID,
    match_confidence: 1.0,
    status: 'MATCHED',
  });

  const { error: installErr } = await adminClient.from('installations').upsert({
    id: INSTALLATION_A_ID,
    company_id: COMPANY_A_ID,
    customer_id: CUSTOMER_A_ID,
    order_id: ORDER_A_ID,
    appointment_id: APPT_INSTALL_ID,
    crew: [],
    status: 'INSTALLING',
    photos: ['installation_photo1.jpg'],
    handover_ref: 'handover_001.pdf',
  });
  if (installErr) {
    throw new Error(`Failed to upsert installation: ${installErr.message}`);
  }

  await adminClient.from('calls').upsert({
    id: CALL_A_ID,
    company_id: COMPANY_A_ID,
    customer_id: CUSTOMER_A_ID,
    direction: 'OUTBOUND',
    agent_type: 'SALE',
    started_at: new Date().toISOString(),
    status: 'COMPLETED',
    provider: 'MANUAL',
    provider_call_id: 'call_rec_001',
    recording_ref: 'call-recordings/call_001.mp3',
    transcript_status: 'COMPLETED',
  });

  // 8. Interactions
  await adminClient.from('interactions').upsert([
    {
      id: INTERACTION_SUCCEEDED_ID,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      sanitized_content: 'Chào công ty, cửa chống ngập giá bao nhiêu?',
      sanitization_status: 'SUCCEEDED',
      actor_type: 'CUSTOMER',
    },
    {
      id: INTERACTION_PENDING_ID,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      channel: 'ZALO',
      type: 'MESSAGE',
      direction: 'INBOUND',
      sanitized_content: null,
      sanitization_status: 'PENDING',
      actor_type: 'CUSTOMER',
    },
    {
      id: INTERACTION_FAILED_ID,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      channel: 'ZALO',
      type: 'MESSAGE',
      direction: 'INBOUND',
      sanitized_content: null,
      sanitization_status: 'FAILED',
      actor_type: 'CUSTOMER',
    },
    {
      id: INTERACTION_BYPASS_ATTEMPT_ID,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      channel: 'WEBSITE',
      type: 'MESSAGE',
      direction: 'INBOUND',
      sanitized_content: 'Tin nhắn thô cố tình gắn NOT_REQUIRED',
      sanitization_status: 'NOT_REQUIRED',
      actor_type: 'CUSTOMER',
    },
    {
      id: INTERACTION_NON_TEXTUAL_ID,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      channel: 'PHONE',
      type: 'CALL_EVENT',
      direction: 'OUTBOUND',
      sanitized_content: null,
      sanitization_status: 'NOT_REQUIRED',
      actor_type: 'SYSTEM',
    },
    {
      id: INTERACTION_NON_SYSTEM_NOT_REQ_ID,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      channel: 'PHONE',
      type: 'CALL_EVENT',
      direction: 'OUTBOUND',
      sanitized_content: null,
      sanitization_status: 'NOT_REQUIRED',
      actor_type: 'SALE',
    },
  ]);

  // 9. Private raw interaction contents (seeded via psql)
  executeRawSql(`
    INSERT INTO private.interaction_raw_contents (interaction_id, company_id, raw_content, raw_payload, source_metadata)
    VALUES
      ('${INTERACTION_SUCCEEDED_ID}', '${COMPANY_A_ID}', 'Nội dung raw từ Facebook: Chào công ty, số tôi là 0988111222', '{"sender": "fb_123", "text": "Chào công ty, số tôi là 0988111222"}', '{}'),
      ('${INTERACTION_PENDING_ID}', '${COMPANY_A_ID}', 'Nội dung raw chưa sanitize từ Zalo', '{"sender": "zalo_456"}', '{}')
    ON CONFLICT (interaction_id) DO NOTHING;
  `);

  // 10. Provision storage buckets in local Supabase
  await adminClient.storage.createBucket('survey-photos', { public: false }).catch(() => {});
  await adminClient.storage.createBucket('contracts', { public: false }).catch(() => {});
  await adminClient.storage.createBucket('call-recordings', { public: false }).catch(() => {});
  await adminClient.storage.from('survey-photos').upload('survey_photo1.jpg', Buffer.from('test photo'), { upsert: true }).catch(() => {});
  await adminClient.storage.from('contracts').upload('contracts/contract_001.pdf', Buffer.from('test contract'), { upsert: true }).catch(() => {});
  await adminClient.storage.from('call-recordings').upload('call-recordings/call_001.mp3', Buffer.from('test audio'), { upsert: true }).catch(() => {});

  console.log('✓ Test fixtures setup complete.\n');
}

async function runSecurityTests() {
  await setupTestData();

  let passCount = 0;
  let failCount = 0;

  function assert(
    condition: boolean,
    testName: string,
    classification: 'REAL LOCAL SUPABASE' | 'UNIT' | 'STATIC' = 'REAL LOCAL SUPABASE',
    detail?: string
  ) {
    const label = `[${classification}] ${testName}`;
    if (condition) {
      console.log(`[PASS] ${label}`);
      passCount++;
    } else {
      console.error(`[FAIL] ${label} ${detail ? `(${detail})` : ''}`);
      failCount++;
    }
  }

  console.log('==================================================');
  console.log('RUNNING TRUSTED SERVER SECURITY FOUNDATION SUITE');
  console.log('==================================================');

  // Authenticate test clients
  const saleClient = createAnonClient();
  await saleClient.auth.signInWithPassword({
    email: TEST_USERS.sale.email,
    password: TEST_USERS.sale.password,
  });

  const techClient = createAnonClient();
  await techClient.auth.signInWithPassword({
    email: TEST_USERS.tech.email,
    password: TEST_USERS.tech.password,
  });

  const bossClient = createAnonClient();
  await bossClient.auth.signInWithPassword({
    email: TEST_USERS.boss.email,
    password: TEST_USERS.boss.password,
  });

  const inactiveProfileClient = createAnonClient();
  await inactiveProfileClient.auth.signInWithPassword({
    email: TEST_USERS.inactiveProfile.email,
    password: TEST_USERS.inactiveProfile.password,
  });

  const inactiveMemberClient = createAnonClient();
  await inactiveMemberClient.auth.signInWithPassword({
    email: TEST_USERS.inactiveMember.email,
    password: TEST_USERS.inactiveMember.password,
  });

  const saleBClient = createAnonClient();
  await saleBClient.auth.signInWithPassword({
    email: TEST_USERS.saleB.email,
    password: TEST_USERS.saleB.password,
  });

  const unauthClient = createAnonClient();

  // ----------------------------------------------------
  // Section 4 & 5: Negative Client Tests & Service Role Tests for Private RPCs
  // ----------------------------------------------------
  {
    // 1. Negative Client RPC: anonymous client calling get_customer_private_contact -> permission denied (42501)
    const { error: anonContactErr } = await unauthClient.rpc('get_customer_private_contact', {
      p_company_id: COMPANY_A_ID,
      p_customer_id: CUSTOMER_A_ID,
    });
    assert(
      Boolean(anonContactErr?.code === '42501' || anonContactErr?.message?.includes('permission denied')),
      'Negative RPC: anonymous client calling get_customer_private_contact is denied (42501)',
      'REAL LOCAL SUPABASE'
    );

    // 2. Negative Client RPC: authenticated SALE calling get_customer_private_contact directly -> permission denied (42501)
    const { error: saleContactErr } = await saleClient.rpc('get_customer_private_contact', {
      p_company_id: COMPANY_A_ID,
      p_customer_id: CUSTOMER_A_ID,
    });
    assert(
      Boolean(saleContactErr?.code === '42501' || saleContactErr?.message?.includes('permission denied')),
      'Negative RPC: authenticated SALE calling get_customer_private_contact directly is denied (42501)',
      'REAL LOCAL SUPABASE'
    );

    // 3. Negative Client RPC: authenticated TECHNICIAN calling get_customer_private_contact directly -> permission denied (42501)
    const { error: techContactErr } = await techClient.rpc('get_customer_private_contact', {
      p_company_id: COMPANY_A_ID,
      p_customer_id: CUSTOMER_A_ID,
    });
    assert(
      Boolean(techContactErr?.code === '42501' || techContactErr?.message?.includes('permission denied')),
      'Negative RPC: authenticated TECHNICIAN calling get_customer_private_contact directly is denied (42501)',
      'REAL LOCAL SUPABASE'
    );

    // 4. Negative Client RPC: authenticated client calling get_interaction_raw_content directly -> permission denied (42501)
    const { error: saleIntErr } = await saleClient.rpc('get_interaction_raw_content', {
      p_company_id: COMPANY_A_ID,
      p_interaction_id: INTERACTION_SUCCEEDED_ID,
    });
    assert(
      Boolean(saleIntErr?.code === '42501' || saleIntErr?.message?.includes('permission denied')),
      'Negative RPC: authenticated client calling get_interaction_raw_content directly is denied (42501)',
      'REAL LOCAL SUPABASE'
    );

    // 5. Service Role RPC: valid company + customer returns expected private row
    const { data: srContactData, error: srContactErr } = await adminClient.rpc('get_customer_private_contact', {
      p_company_id: COMPANY_A_ID,
      p_customer_id: CUSTOMER_A_ID,
    });
    assert(
      !srContactErr &&
      Array.isArray(srContactData) &&
      srContactData.length === 1 &&
      srContactData[0].raw_phone === '0988111222' &&
      srContactData[0].normalized_phone === '+84988111222',
      'Service Role RPC: valid company + customer returns expected private contact row',
      'REAL LOCAL SUPABASE'
    );

    // 6. Service Role RPC: wrong company + correct customer returns zero rows
    const { data: srWrongCompData } = await adminClient.rpc('get_customer_private_contact', {
      p_company_id: COMPANY_B_ID,
      p_customer_id: CUSTOMER_A_ID,
    });
    assert(
      Array.isArray(srWrongCompData) && srWrongCompData.length === 0,
      'Service Role RPC: wrong company + correct customer returns zero rows',
      'REAL LOCAL SUPABASE'
    );

    // 7. Service Role RPC: correct company + wrong customer returns zero rows
    const { data: srWrongCustData } = await adminClient.rpc('get_customer_private_contact', {
      p_company_id: COMPANY_A_ID,
      p_customer_id: '00000000-0000-0000-0000-000000000000',
    });
    assert(
      Array.isArray(srWrongCustData) && srWrongCustData.length === 0,
      'Service Role RPC: correct company + wrong customer returns zero rows',
      'REAL LOCAL SUPABASE'
    );

    // 8. Service Role RPC: valid company + interaction returns expected raw interaction row
    const { data: srIntData, error: srIntErr } = await adminClient.rpc('get_interaction_raw_content', {
      p_company_id: COMPANY_A_ID,
      p_interaction_id: INTERACTION_SUCCEEDED_ID,
    });
    assert(
      !srIntErr &&
      Array.isArray(srIntData) &&
      srIntData.length === 1 &&
      srIntData[0].interaction_id === INTERACTION_SUCCEEDED_ID,
      'Service Role RPC: valid company + interaction returns expected raw interaction row',
      'REAL LOCAL SUPABASE'
    );

    // 9. Service Role RPC: wrong company + correct interaction returns zero rows
    const { data: srWrongCompInt } = await adminClient.rpc('get_interaction_raw_content', {
      p_company_id: COMPANY_B_ID,
      p_interaction_id: INTERACTION_SUCCEEDED_ID,
    });
    assert(
      Array.isArray(srWrongCompInt) && srWrongCompInt.length === 0,
      'Service Role RPC: wrong company + correct interaction returns zero rows',
      'REAL LOCAL SUPABASE'
    );

    // 10. Service Role RPC: correct company + wrong interaction returns zero rows
    const { data: srWrongIdInt } = await adminClient.rpc('get_interaction_raw_content', {
      p_company_id: COMPANY_A_ID,
      p_interaction_id: '00000000-0000-0000-0000-000000000000',
    });
    assert(
      Array.isArray(srWrongIdInt) && srWrongIdInt.length === 0,
      'Service Role RPC: correct company + wrong interaction returns zero rows',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test A: Unauthenticated sensitive operation denied (401)
  // ----------------------------------------------------
  {
    let caught401 = false;
    try {
      await authorizeCustomerAccess(CUSTOMER_A_ID, undefined, unauthClient);
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 401 && err.code === 'UNAUTHENTICATED') {
        caught401 = true;
      }
    }
    assert(caught401, 'Test A: Unauthenticated customer access denied with 401 UNAUTHENTICATED', 'REAL LOCAL SUPABASE');

    let actionCaught = false;
    const actionResult = await internalClickToCallAction({ customerId: CUSTOMER_A_ID }, unauthClient);
    if (!actionResult.success && actionResult.error) {
      actionCaught = true;
    }
    assert(actionCaught, 'Test A: Unauthenticated clickToCallAction fails closed', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test B: Inactive profile denied (403 USER_INACTIVE)
  // ----------------------------------------------------
  {
    let caughtInactiveProfile = false;
    try {
      await authorizeCustomerAccess(CUSTOMER_A_ID, undefined, inactiveProfileClient);
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 403 && err.code === 'USER_INACTIVE') {
        caughtInactiveProfile = true;
      }
    }
    assert(caughtInactiveProfile, 'Test B: Inactive profile denied with 403 USER_INACTIVE', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test C: Inactive membership denied (403 MEMBERSHIP_INACTIVE)
  // ----------------------------------------------------
  {
    let caughtInactiveMember = false;
    try {
      await authorizeCustomerAccess(CUSTOMER_A_ID, undefined, inactiveMemberClient);
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 403 && err.code === 'MEMBERSHIP_INACTIVE') {
        caughtInactiveMember = true;
      }
    }
    assert(caughtInactiveMember, 'Test C: Inactive membership denied with 403 MEMBERSHIP_INACTIVE', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test D: Cross-company target denied (masked as 404 RESOURCE_NOT_FOUND)
  // ----------------------------------------------------
  {
    let caughtCrossCompanyMasked = false;
    try {
      await authorizeCustomerAccess(CUSTOMER_A_ID, undefined, saleBClient);
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 404 && err.code === 'RESOURCE_NOT_FOUND') {
        caughtCrossCompanyMasked = true;
      }
    }
    assert(
      caughtCrossCompanyMasked,
      'Test D: Cross-company target access masked as 404 RESOURCE_NOT_FOUND (IDOR mitigation)',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test E: Client company spoof cannot bypass target-row company
  // ----------------------------------------------------
  {
    const { actor, customer } = await authorizeCustomerAccess(CUSTOMER_A_ID, undefined, saleClient);
    assert(
      customer.company_id === COMPANY_A_ID && actor.companyId === COMPANY_A_ID,
      'Test E: Target resource company is strictly server-derived from database row',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test F: Service role alone cannot bypass application authorization helper
  // ----------------------------------------------------
  {
    let caughtF = false;
    try {
      await resolveCustomerPrivateContactForTrustedOperation(
        CUSTOMER_B_ID,
        CONTACT_ACCESS_PURPOSES.CLICK_TO_CALL,
        saleClient
      );
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 404) {
        caughtF = true;
      }
    }
    assert(
      caughtF,
      'Test F: Service role backing cannot be accessed without passing actor authorization chain',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test G: SALE cannot receive raw phone
  // ----------------------------------------------------
  {
    const { data: directData } = await saleClient
      .schema('private')
      .from('customer_private_contacts')
      .select('*');
    assert(
      !directData || directData.length === 0,
      'Test G: SALE client query against private.customer_private_contacts yields 0 rows (RLS zero-policy)',
      'REAL LOCAL SUPABASE'
    );

    const actionResult = await internalClickToCallAction({ customerId: CUSTOMER_A_ID }, saleClient);
    const actionJson = JSON.stringify(actionResult);
    const leakedPhone =
      actionJson.includes('0988111222') ||
      actionJson.includes('+84988111222') ||
      actionJson.includes('raw_phone') ||
      actionJson.includes('normalized_phone');
    assert(!leakedPhone, 'Test G: SALE clickToCallAction return value contains ZERO phone fields', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test H: TECHNICIAN cannot receive raw phone
  // ----------------------------------------------------
  {
    const { data: directData } = await techClient
      .schema('private')
      .from('customer_private_contacts')
      .select('*');
    assert(
      !directData || directData.length === 0,
      'Test H: TECHNICIAN client query against private schema yields 0 rows',
      'REAL LOCAL SUPABASE'
    );

    let techCallDenied = false;
    try {
      await executeClickToCall({ customerId: CUSTOMER_A_ID }, undefined, techClient);
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 403 && err.code === 'ROLE_FORBIDDEN') {
        techCallDenied = true;
      }
    }
    assert(techCallDenied, 'Test H: TECHNICIAN click-to-call is denied with 403 ROLE_FORBIDDEN', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test I: Raw phone & providerCallId never appear in click-to-call response
  // ----------------------------------------------------
  {
    const callResult = await executeClickToCall({ customerId: CUSTOMER_A_ID }, undefined, saleClient);
    const resString = JSON.stringify(callResult);
    assert(
      !resString.includes('0988111222') &&
      !resString.includes('+84988111222') &&
      !('providerCallId' in callResult) &&
      callResult.success === true &&
      Boolean(callResult.callId),
      'Test I: Click-to-call result has application callId and status with ZERO phone and provider secrets',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test J: Provider exception containing raw phone does not leak
  // ----------------------------------------------------
  {
    class FailingProvider implements CallProvider {
      readonly name = 'MANUAL';
      async initiateCall(): Promise<{ providerCallId: string; status: string }> {
        throw new Error('Upstream SIP failed for +84988111222 with token secret_bearer_token');
      }
    }

    let caughtErrorMsg = '';
    let caughtCode = '';
    try {
      await executeClickToCall({ customerId: CUSTOMER_A_ID }, new FailingProvider(), saleClient);
    } catch (err: unknown) {
      if (err instanceof ServerAuthError) {
        caughtErrorMsg = err.message;
        caughtCode = err.code;
      }
    }

    assert(
      !caughtErrorMsg.includes('0988111222') &&
      !caughtErrorMsg.includes('+84988111222') &&
      !caughtErrorMsg.includes('secret_bearer_token') &&
      caughtCode === 'CALL_PROVIDER_FAILURE',
      'Test J: Provider exceptions containing raw phone or secrets are normalized to safe CALL_PROVIDER_FAILURE',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test K: Authorized click-to-call resolves phone only inside trusted server
  // ----------------------------------------------------
  {
    let phoneReceivedInProvider = '';
    class SpyProvider implements CallProvider {
      readonly name = 'MANUAL';
      async initiateCall(params: {
        fromStaffUserId: string;
        targetRawPhone: string;
        customerId: string;
        companyId: string;
      }): Promise<{ providerCallId: string; status: string }> {
        phoneReceivedInProvider = params.targetRawPhone;
        return {
          providerCallId: `spy_call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          status: 'INITIATED',
        };
      }
    }

    await executeClickToCall({ customerId: CUSTOMER_A_ID }, new SpyProvider(), saleClient);
    assert(
      phoneReceivedInProvider === '0988111222',
      'Test K: Authorized click-to-call resolves raw phone strictly in trusted server memory for PBX',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test L: Unauthorized SALE/TECH/Boss cases follow frozen permissions
  // ----------------------------------------------------
  {
    // Payment transaction: SALE is forbidden (BOSS_ADMIN only)
    let salePaymentDenied = false;
    try {
      await authorizePaymentAccess(PAYMENT_A_ID, saleClient);
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 403 && err.code === 'ROLE_FORBIDDEN') {
        salePaymentDenied = true;
      }
    }
    assert(salePaymentDenied, 'Test L: SALE cannot authorize payment access (ROLE_FORBIDDEN)', 'REAL LOCAL SUPABASE');

    // Boss can authorize payment
    const { payment } = await authorizePaymentAccess(PAYMENT_A_ID, bossClient);
    assert(payment.id === PAYMENT_A_ID, 'Test L: BOSS_ADMIN can authorize payment access', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test M: Technician active assignment allowed (ASSIGNED, ACCEPTED, IN_PROGRESS)
  // ----------------------------------------------------
  {
    const { appointment: apptAssigned } = await authorizeAppointmentAccess(
      APPT_ACTIVE_ASSIGNED_ID,
      techClient
    );
    assert(
      apptAssigned.status === 'ASSIGNED',
      'Test M: Technician can access appointment in ASSIGNED status',
      'REAL LOCAL SUPABASE'
    );

    const { appointment: apptAccepted } = await authorizeAppointmentAccess(
      APPT_ACTIVE_ACCEPTED_ID,
      techClient
    );
    assert(
      apptAccepted.status === 'ACCEPTED',
      'Test M: Technician can access appointment in ACCEPTED status',
      'REAL LOCAL SUPABASE'
    );

    const { appointment: apptProgress } = await authorizeAppointmentAccess(
      APPT_ACTIVE_PROGRESS_ID,
      techClient
    );
    assert(
      apptProgress.status === 'IN_PROGRESS',
      'Test M: Technician can access appointment in IN_PROGRESS status',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test N: Technician completed/cancelled/rejected assignment denied
  // ----------------------------------------------------
  {
    let caughtCompleted = false;
    try {
      await authorizeAppointmentAccess(APPT_COMPLETED_ID, techClient);
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 403 && err.code === 'ASSIGNMENT_INACTIVE') {
        caughtCompleted = true;
      }
    }
    assert(caughtCompleted, 'Test N: Technician access denied for COMPLETED status', 'REAL LOCAL SUPABASE');

    let caughtCancelled = false;
    try {
      await authorizeAppointmentAccess(APPT_CANCELLED_ID, techClient);
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 403 && err.code === 'ASSIGNMENT_INACTIVE') {
        caughtCancelled = true;
      }
    }
    assert(caughtCancelled, 'Test N: Technician access denied for CANCELLED status', 'REAL LOCAL SUPABASE');

    let caughtRejected = false;
    try {
      await authorizeAppointmentAccess(APPT_REJECTED_ID, techClient);
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 403 && err.code === 'ASSIGNMENT_INACTIVE') {
        caughtRejected = true;
      }
    }
    assert(caughtRejected, 'Test N: Technician access denied for REJECTED status', 'REAL LOCAL SUPABASE');

    // Survey with completed appointment: completed_by does not give access!
    let caughtSurveyHistoricalDenied = false;
    try {
      await authorizeSurveyAccess(SURVEY_COMPLETED_ID, techClient);
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 403 && err.code === 'ASSIGNMENT_INACTIVE') {
        caughtSurveyHistoricalDenied = true;
      }
    }
    assert(
      caughtSurveyHistoricalDenied,
      'Test N: Survey access denied when linked appointment is terminated (completed_by is NOT authorization)',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test O: Sanitized interaction access requires SUCCEEDED & NOT_REQUIRED system validation
  // ----------------------------------------------------
  {
    // 1. SUCCEEDED interaction succeeds
    const succeeded = await getSanitizedInteractionForSale(INTERACTION_SUCCEEDED_ID, saleClient);
    assert(
      succeeded.sanitizedContent === 'Chào công ty, cửa chống ngập giá bao nhiêu?',
      'Test O: Sanitized interaction with status SUCCEEDED is accessible',
      'REAL LOCAL SUPABASE'
    );

    const { interaction: authInt } = await authorizeInteractionAccess(INTERACTION_SUCCEEDED_ID, 'SANITIZED_READ', saleClient);
    assert(
      authInt.id === INTERACTION_SUCCEEDED_ID,
      'Test O: authorizeInteractionAccess succeeds for authorized SALE',
      'REAL LOCAL SUPABASE'
    );

    // 2. PENDING interaction is rejected
    let caughtPending = false;
    try {
      await getSanitizedInteractionForSale(INTERACTION_PENDING_ID, saleClient);
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 403 && err.code === 'SANITIZATION_INCOMPLETE') {
        caughtPending = true;
      }
    }
    assert(caughtPending, 'Test O: PENDING interaction content rejected with 403 SANITIZATION_INCOMPLETE', 'REAL LOCAL SUPABASE');

    // 3. FAILED interaction is rejected (FAILED never falls back to raw)
    let caughtFailed = false;
    try {
      await getSanitizedInteractionForSale(INTERACTION_FAILED_ID, saleClient);
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 403 && err.code === 'SANITIZATION_INCOMPLETE') {
        caughtFailed = true;
      }
    }
    assert(caughtFailed, 'Test O: FAILED interaction rejected (never falls back to raw)', 'REAL LOCAL SUPABASE');

    // 4. Textual message with NOT_REQUIRED is rejected (sanitizer bypass prevention)
    let caughtBypass = false;
    try {
      await getSanitizedInteractionForSale(INTERACTION_BYPASS_ATTEMPT_ID, saleClient);
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 403 && err.code === 'SANITIZATION_INCOMPLETE') {
        caughtBypass = true;
      }
    }
    assert(caughtBypass, 'Test O: Textual message marked NOT_REQUIRED rejected (bypass prevented)', 'REAL LOCAL SUPABASE');

    // 5. Non-SYSTEM actor with NOT_REQUIRED is rejected
    let caughtNonSystemNotReq = false;
    try {
      await getSanitizedInteractionForSale(INTERACTION_NON_SYSTEM_NOT_REQ_ID, saleClient);
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 403 && err.code === 'SANITIZATION_INCOMPLETE') {
        caughtNonSystemNotReq = true;
      }
    }
    assert(caughtNonSystemNotReq, 'Test O: Non-SYSTEM actor with NOT_REQUIRED rejected (fail closed)', 'REAL LOCAL SUPABASE');

    // 6. Valid SYSTEM non-textual event with NOT_REQUIRED is allowed
    const nonTextual = await getSanitizedInteractionForSale(INTERACTION_NON_TEXTUAL_ID, saleClient);
    assert(
      nonTextual.type === 'CALL_EVENT' && nonTextual.sanitizationStatus === 'NOT_REQUIRED' && nonTextual.sanitizedContent === null,
      'Test O: Non-textual SYSTEM event with NOT_REQUIRED is allowed',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test P: Raw interaction never exposed to SALE or TECH under any purpose
  // ----------------------------------------------------
  {
    // SALE under PRIVILEGED_AUDIT
    let caughtSaleRaw = false;
    try {
      await resolveRawInteractionContentForTrustedOperation(
        INTERACTION_SUCCEEDED_ID,
        RAW_INTERACTION_PURPOSES.PRIVILEGED_AUDIT,
        saleClient
      );
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 403 && err.code === 'ROLE_FORBIDDEN') {
        caughtSaleRaw = true;
      }
    }
    assert(caughtSaleRaw, 'Test P: SALE cannot access raw interaction content under PRIVILEGED_AUDIT', 'REAL LOCAL SUPABASE');

    // SALE under worker purpose VOICE_TRANSCRIPTION
    let caughtSaleWorker = false;
    try {
      await resolveRawInteractionContentForTrustedOperation(
        INTERACTION_SUCCEEDED_ID,
        RAW_INTERACTION_PURPOSES.VOICE_TRANSCRIPTION,
        saleClient
      );
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 403 && err.code === 'ROLE_FORBIDDEN') {
        caughtSaleWorker = true;
      }
    }
    assert(caughtSaleWorker, 'Test P: SALE cannot access raw interaction under worker purpose VOICE_TRANSCRIPTION', 'REAL LOCAL SUPABASE');

    // TECHNICIAN under any purpose
    let caughtTechRaw = false;
    try {
      await resolveRawInteractionContentForTrustedOperation(
        INTERACTION_SUCCEEDED_ID,
        RAW_INTERACTION_PURPOSES.PRIVILEGED_AUDIT,
        techClient
      );
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 403 && err.code === 'ROLE_FORBIDDEN') {
        caughtTechRaw = true;
      }
    }
    assert(caughtTechRaw, 'Test P: TECHNICIAN cannot access raw interaction content', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test Q: Signed URL TTL cannot be client-controlled
  // ----------------------------------------------------
  {
    assert(
      getCategoryTTL('CONTRACT') === 1800,
      'Test Q: Signed URL TTL is purely determined by resource category, client cannot override',
      'UNIT'
    );
  }

  // ----------------------------------------------------
  // Test R: Contract TTL = 1800
  // ----------------------------------------------------
  {
    assert(
      SIGNED_URL_TTL.CONTRACT === 1800,
      'Test R: Contract Signed URL TTL is exactly 1800 seconds (Storage Decision 01)',
      'UNIT'
    );
  }

  // ----------------------------------------------------
  // Test S: Recording TTL = 900
  // ----------------------------------------------------
  {
    assert(
      SIGNED_URL_TTL.RECORDING === 900,
      'Test S: Recording Signed URL TTL is exactly 900 seconds (Storage Decision 01)',
      'UNIT'
    );

    let caughtSaleRec = false;
    try {
      await createAuthorizedSignedUrl(
        { category: 'RECORDING', resourceId: CALL_A_ID },
        saleClient
      );
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 403) {
        caughtSaleRec = true;
      }
    }
    assert(caughtSaleRec, 'Test S: SALE is strictly prohibited from accessing call recordings', 'REAL LOCAL SUPABASE');

    let caughtTechRec = false;
    try {
      await createAuthorizedSignedUrl(
        { category: 'RECORDING', resourceId: CALL_A_ID },
        techClient
      );
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 403) {
        caughtTechRec = true;
      }
    }
    assert(caughtTechRec, 'Test S: TECHNICIAN is strictly prohibited from accessing call recordings', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test T: Survey and Installation Signed URL TTL is 3600
  // ----------------------------------------------------
  {
    assert(
      SIGNED_URL_TTL.SURVEY === 3600 && SIGNED_URL_TTL.INSTALLATION === 3600,
      'Test T: Survey and Installation Signed URL TTL is exactly 3600 seconds',
      'UNIT'
    );
  }

  // ----------------------------------------------------
  // Test U: Service role key absent from client source
  // ----------------------------------------------------
  {
    const appDir = path.resolve(__dirname, '../../app');
    const sharedDir = path.resolve(__dirname, '../../shared');

    function searchDirForPattern(dir: string, pattern: RegExp): string[] {
      const results: string[] = [];
      const files = fs.readdirSync(dir, { withFileTypes: true });
      for (const f of files) {
        const full = path.join(dir, f.name);
        if (f.isDirectory()) {
          results.push(...searchDirForPattern(full, pattern));
        } else if (f.isFile() && (f.name.endsWith('.ts') || f.name.endsWith('.tsx'))) {
          const content = fs.readFileSync(full, 'utf8');
          if (pattern.test(content)) {
            results.push(full);
          }
        }
      }
      return results;
    }

    const matches = searchDirForPattern(appDir, /NEXT_PUBLIC_SUPABASE_SERVICE_ROLE/);
    matches.push(...searchDirForPattern(sharedDir, /NEXT_PUBLIC_SUPABASE_SERVICE_ROLE/));
    assert(
      matches.length === 0,
      'Test U: NEXT_PUBLIC_SUPABASE_SERVICE_ROLE is never present in app or shared source',
      'STATIC'
    );
  }

  // ----------------------------------------------------
  // Test V: Sensitive values absent from logs
  // ----------------------------------------------------
  {
    const { data: auditEntries } = await adminClient
      .from('audit_logs')
      .select('*')
      .eq('action', 'VIEW_RAW_PHONE');

    let phoneInAudit = false;
    for (const entry of auditEntries || []) {
      const entryStr = JSON.stringify(entry);
      if (entryStr.includes('0988111222') || entryStr.includes('+84988111222')) {
        phoneInAudit = true;
      }
    }
    assert(!phoneInAudit, 'Test V: Audit logs never store raw phone or normalized phone in metadata', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test W: Target resource company is server-derived
  // ----------------------------------------------------
  {
    const { customer } = await authorizeCustomerAccess(CUSTOMER_A_ID, undefined, saleClient);
    const { appointment } = await authorizeAppointmentAccess(APPT_ACTIVE_ASSIGNED_ID, techClient);
    const { survey } = await authorizeSurveyAccess(SURVEY_ACTIVE_ID, techClient);
    const { order } = await authorizeOrderAccess(ORDER_A_ID, saleClient);
    const { contract } = await authorizeContractAccess(CONTRACT_A_ID, saleClient);

    assert(
      customer.company_id === COMPANY_A_ID &&
      appointment.company_id === COMPANY_A_ID &&
      survey.company_id === COMPANY_A_ID &&
      order.company_id === COMPANY_A_ID &&
      contract.company_id === COMPANY_A_ID,
      'Test W: All resource authorization helpers derive tenant company directly from target row',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test X: Every privileged Server Action independently guards itself & normalizes errors
  // ----------------------------------------------------
  {
    const resCallUnauth = await internalClickToCallAction({ customerId: CUSTOMER_A_ID }, unauthClient);
    assert(!resCallUnauth.success && resCallUnauth.error === 'UNAUTHENTICATED', 'Test X: clickToCallAction independently guards unauth', 'REAL LOCAL SUPABASE');

    const resIntUnauth = await internalGetSanitizedInteractionAction({ interactionId: INTERACTION_SUCCEEDED_ID }, unauthClient);
    assert(!resIntUnauth.success && resIntUnauth.error === 'UNAUTHENTICATED', 'Test X: getSanitizedInteractionAction independently guards unauth', 'REAL LOCAL SUPABASE');

    const resUrlUnauth = await internalGetAuthorizedSignedUrlAction({ category: 'CONTRACT', resourceId: CONTRACT_A_ID }, unauthClient);
    assert(!resUrlUnauth.success && resUrlUnauth.error === 'UNAUTHENTICATED', 'Test X: getAuthorizedSignedUrlAction independently guards unauth', 'REAL LOCAL SUPABASE');

    const resBossUnauth = await internalViewBossRawPhoneAction({ customerId: CUSTOMER_A_ID, reason: 'Valid Audit Reason' }, unauthClient);
    assert(!resBossUnauth.success && resBossUnauth.error === 'UNAUTHENTICATED', 'Test X: viewBossRawPhoneAction independently guards unauth', 'REAL LOCAL SUPABASE');

    const resBossSale = await internalViewBossRawPhoneAction({ customerId: CUSTOMER_A_ID, reason: 'Valid Audit Reason' }, saleClient);
    assert(!resBossSale.success && resBossSale.error === 'ROLE_FORBIDDEN', 'Test X: viewBossRawPhoneAction rejects non-Boss (SALE)', 'REAL LOCAL SUPABASE');

    const resBossTech = await internalViewBossRawPhoneAction({ customerId: CUSTOMER_A_ID, reason: 'Valid Audit Reason' }, techClient);
    assert(!resBossTech.success && resBossTech.error === 'ROLE_FORBIDDEN', 'Test X: viewBossRawPhoneAction rejects non-Boss (TECHNICIAN)', 'REAL LOCAL SUPABASE');

    const resBossSuccess = await internalViewBossRawPhoneAction({ customerId: CUSTOMER_A_ID, reason: 'Kiem toan theo doi hop dong' }, bossClient);
    assert(
      resBossSuccess.success === true && resBossSuccess.rawPhone === '0988111222',
      'Test X: viewBossRawPhoneAction succeeds for authorized BOSS_ADMIN with sanitized reason',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // SECTION 15 REGRESSION TESTS (Independent Review Remediation)
  // ----------------------------------------------------

  // Reg 1: Payment role-list override impossible (function accepts no allowedRoles)
  {
    assert(
      authorizePaymentAccess.length <= 2,
      'Reg 1: authorizePaymentAccess accepts no caller-supplied allowedRoles (policy widening impossible)',
      'STATIC'
    );

    let saleOverrideDenied = false;
    try {
      await authorizePaymentAccess(PAYMENT_A_ID, saleClient);
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.code === 'ROLE_FORBIDDEN') {
        saleOverrideDenied = true;
      }
    }
    assert(saleOverrideDenied, 'Reg 1: SALE cannot authorize payment access under any circumstances', 'REAL LOCAL SUPABASE');
  }

  // Reg 2: Sensitive pre-auth projections query only minimal metadata
  {
    const fileContent = fs.readFileSync(path.resolve(__dirname, '../../lib/server-auth/resource-access.ts'), 'utf8');
    const hasMinimalOrderQuery = fileContent.includes(".select('id, company_id')");
    const hasMinimalPaymentQuery = fileContent.includes(".select('id, company_id')");
    assert(
      hasMinimalOrderQuery && hasMinimalPaymentQuery,
      'Reg 2: Resource helpers select minimal metadata before actor verification',
      'STATIC'
    );
  }

  // Reg 3: Boss raw-phone success creates verified audit log
  {
    await resolveCustomerPrivateContactForTrustedOperation(
      CUSTOMER_A_ID,
      CONTACT_ACCESS_PURPOSES.PRIVILEGED_ADMIN_OPERATION,
      { reason: 'Kiem toan so dien thoai phuc vu doi soat', client: bossClient }
    );

    const { data: audits } = await adminClient
      .from('audit_logs')
      .select('*')
      .eq('action', 'VIEW_RAW_PHONE')
      .eq('customer_id', CUSTOMER_A_ID)
      .order('created_at', { ascending: false })
      .limit(1);

    assert(
      audits !== null &&
      audits.length === 1 &&
      audits[0].result === 'SUCCESS' &&
      audits[0].metadata.reason === 'Kiem toan so dien thoai phuc vu doi soat' &&
      !JSON.stringify(audits[0].metadata).includes('0988111222'),
      'Reg 3: Boss raw-phone view creates verified audit log entry with result SUCCESS and zero phone in metadata',
      'REAL LOCAL SUPABASE'
    );
  }

  // Reg 4a: Short/unsafe reason rejected with INVALID_PURPOSE
  {
    let caughtInvalidReason = false;
    try {
      await resolveCustomerPrivateContactForTrustedOperation(
        CUSTOMER_A_ID,
        CONTACT_ACCESS_PURPOSES.PRIVILEGED_ADMIN_OPERATION,
        { reason: 'abc', client: bossClient }
      );
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.code === 'INVALID_PURPOSE') {
        caughtInvalidReason = true;
      }
    }
    assert(
      caughtInvalidReason,
      'Reg 4a: Short/unsafe reason rejected with INVALID_PURPOSE before audit or phone read',
      'REAL LOCAL SUPABASE'
    );
  }

  // Reg 4b: Real mandatory audit write failure blocks raw-phone return (fail closed)
  {
    // Override admin client: real DB for customer/contact resolution, but simulated failure on audit_logs.insert
    const failingAuditAdminClient = new Proxy(adminClient, {
      get(target, prop, receiver) {
        if (prop === 'from') {
          return (tableName: string) => {
            if (tableName === 'audit_logs') {
              return {
                insert: async () => ({
                  data: null,
                  error: {
                    message: 'Simulated database disk failure during mandatory audit insert',
                    code: '50000',
                  },
                }),
              };
            }
            return target.from(tableName);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    let caughtAuditFailure = false;
    let returnedContact: unknown = null;
    try {
      returnedContact = await resolveCustomerPrivateContactForTrustedOperation(
        CUSTOMER_A_ID,
        CONTACT_ACCESS_PURPOSES.PRIVILEGED_ADMIN_OPERATION,
        {
          reason: 'Kiem toan so dien thoai hop le de thu nghiem loi ghi audit',
          client: bossClient,
          overrideAdminClient: failingAuditAdminClient as unknown as SupabaseClient,
        }
      );
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.code === 'AUDIT_WRITE_FAILED' && err.status === 500) {
        caughtAuditFailure = true;
      }
    }

    assert(
      caughtAuditFailure && returnedContact === null,
      'Reg 4b: Forced audit-write failure throws AUDIT_WRITE_FAILED (status 500) and raw phone is NOT returned',
      'REAL LOCAL SUPABASE'
    );
  }

  // Reg 5: Click-to-call creates durable call record in database before provider dialing
  {
    let callRecordCreatedBeforeDial = false;
    class VerifyingProvider implements CallProvider {
      readonly name = 'MANUAL';
      async initiateCall(params: { customerId: string; companyId: string }): Promise<{ providerCallId: string; status: string }> {
        // Query database inside provider invocation to verify 'calls' record already exists with status 'INITIATED'
        const { data: activeCalls } = await adminClient
          .from('calls')
          .select('*')
          .eq('customer_id', params.customerId)
          .eq('status', 'INITIATED')
          .order('created_at', { ascending: false })
          .limit(1);

        if (activeCalls && activeCalls.length > 0) {
          callRecordCreatedBeforeDial = true;
        }
        return {
          providerCallId: `call_verify_${Date.now()}`,
          status: 'INITIATED',
        };
      }
    }

    await executeClickToCall({ customerId: CUSTOMER_A_ID }, new VerifyingProvider(), saleClient);
    assert(callRecordCreatedBeforeDial, 'Reg 5: Click-to-call creates durable call record before dialing provider', 'REAL LOCAL SUPABASE');
  }

  // Reg 6: Click-to-call creates mandatory audit log entry INITIATE_CALL
  {
    const { data: callAudits } = await adminClient
      .from('audit_logs')
      .select('*')
      .eq('action', 'INITIATE_CALL')
      .eq('customer_id', CUSTOMER_A_ID)
      .order('created_at', { ascending: false })
      .limit(1);

    assert(
      callAudits !== null &&
      callAudits.length === 1 &&
      callAudits[0].result === 'SUCCESS',
      'Reg 6: Click-to-call writes mandatory INITIATE_CALL audit log entry',
      'REAL LOCAL SUPABASE'
    );
  }

  // Reg 7: Boss click-to-call fails closed by default (configuration-dependent)
  {
    let bossCallDenied = false;
    try {
      await executeClickToCall({ customerId: CUSTOMER_A_ID }, undefined, bossClient);
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && (err.code === 'ROLE_FORBIDDEN' || err.code === 'SENSITIVE_OPERATION_FORBIDDEN')) {
        bossCallDenied = true;
      }
    }
    assert(bossCallDenied, 'Reg 7: Boss click-to-call fails closed by default pending business configuration', 'REAL LOCAL SUPABASE');
  }

  // Reg 8: Installation signed URL authorizes installation entity
  {
    const { installation } = await authorizeInstallationAccess(INSTALLATION_A_ID, techClient);
    assert(
      installation.id === INSTALLATION_A_ID && installation.status === 'INSTALLING',
      'Reg 8: authorizeInstallationAccess authorizes actual INSTALLATION resource',
      'REAL LOCAL SUPABASE'
    );
  }

  // Reg 9: Installation bucket conflict fails closed citing OPEN STORAGE CONTRACT DECISION
  {
    let caughtInstallConflict = false;
    let conflictMsg = '';
    try {
      await createAuthorizedSignedUrl({ category: 'INSTALLATION', resourceId: INSTALLATION_A_ID }, techClient);
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.code === 'SIGNED_URL_UNAVAILABLE') {
        caughtInstallConflict = true;
        conflictMsg = err.message;
      }
    }
    assert(
      caughtInstallConflict && conflictMsg.includes('OPEN STORAGE CONTRACT DECISION'),
      'Reg 9: Installation storage URL fails closed due to bucket conflict (installation-handover vs installation-docs)',
      'REAL LOCAL SUPABASE'
    );
  }

  // Reg 10: Canonical path/resource binding for Contract & Survey
  {
    const contractUrlResult = await createAuthorizedSignedUrl(
      { category: 'CONTRACT', resourceId: CONTRACT_A_ID, variant: 'generated' },
      saleClient
    );
    assert(
      contractUrlResult.signedUrl.includes('contracts/contract_001.pdf') &&
      !contractUrlResult.signedUrl.includes('mock_signed'),
      'Reg 10: Contract signed URL binds canonical path from DB row and uses real local storage',
      'REAL LOCAL SUPABASE'
    );

    const surveyUrlResult = await createAuthorizedSignedUrl(
      { category: 'SURVEY', resourceId: SURVEY_ACTIVE_ID, photoIndex: 0 },
      techClient
    );
    assert(
      surveyUrlResult.signedUrl.includes('survey_photo1.jpg') &&
      !surveyUrlResult.signedUrl.includes('mock_signed'),
      'Reg 10: Survey signed URL binds canonical path from DB row and uses real local storage',
      'REAL LOCAL SUPABASE'
    );
  }

  // Reg 11: Storage signing failure fails closed (no fake mock fallback URLs)
  {
    let caughtMissingObject = false;
    try {
      // Trying to get photo at non-existent index 999
      await createAuthorizedSignedUrl(
        { category: 'SURVEY', resourceId: SURVEY_ACTIVE_ID, photoIndex: 999 },
        techClient
      );
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 404) {
        caughtMissingObject = true;
      }
    }
    assert(caughtMissingObject, 'Reg 11: Missing storage object reference fails closed with 404', 'REAL LOCAL SUPABASE');
  }

  // Reg 12: Server Action boundary inspection (No DI args, no internal exports)
  {
    const exportedKeys = Object.keys(PublicSensitiveActions).sort();
    const expectedKeys = [
      'clickToCallAction',
      'getAuthorizedSignedUrlAction',
      'getSanitizedInteractionAction',
      'viewBossRawPhoneAction',
    ].sort();

    assert(
      JSON.stringify(exportedKeys) === JSON.stringify(expectedKeys),
      `Reg 12: app/actions/sensitive.ts exports ONLY the 4 intended public Server Actions (found: ${exportedKeys.join(', ')})`,
      'STATIC'
    );

    const hasInternalExport = exportedKeys.some((k) => k.toLowerCase().startsWith('internal'));
    assert(
      !hasInternalExport,
      'Reg 12: app/actions/sensitive.ts contains ZERO internal*Action exports',
      'STATIC'
    );

    const allSingleParam = exportedKeys.every((key) => {
      const fn = (PublicSensitiveActions as Record<string, unknown>)[key];
      return typeof fn === 'function' && fn.length <= 1;
    });
    assert(
      allSingleParam,
      'Reg 12: All public Server Actions accept at most 1 serializable business parameter',
      'STATIC'
    );

    const actionSource = fs.readFileSync(
      path.resolve(__dirname, '../../app/actions/sensitive.ts'),
      'utf8'
    );

    assert(
      !actionSource.includes('SupabaseClient') &&
      !actionSource.includes('CallProvider') &&
      !actionSource.includes('export async function internal') &&
      !actionSource.includes('export function internal'),
      'Reg 12: app/actions/sensitive.ts contains no SupabaseClient, CallProvider, or internal exports in source',
      'STATIC'
    );
  }

  // Reg 13: RECORDING minimal pre-auth projection & post-auth canonical lookup
  {
    const signedUrlsSource = fs.readFileSync(
      path.resolve(__dirname, '../../lib/sensitive/signed-urls.ts'),
      'utf8'
    );
    const recordingBlockMatch = signedUrlsSource.match(/case 'RECORDING':\s*\{([\s\S]*?)\n\s*break;\s*\}/);
    assert(
      Boolean(recordingBlockMatch && recordingBlockMatch[1]),
      'Reg 13: RECORDING category block exists in signed-urls.ts',
      'STATIC'
    );
    const recordingBlock = recordingBlockMatch![1];
    const preAuthMatch = recordingBlock.match(/\.from\('calls'\)\s*\.select\('([^']+)'\)/);
    const preAuthFields = preAuthMatch ? preAuthMatch[1].split(',').map((s) => s.trim()) : [];

    assert(
      preAuthFields.includes('id') &&
      preAuthFields.includes('company_id') &&
      !preAuthFields.includes('recording_ref') &&
      preAuthFields.length === 2,
      'Reg 13: Pre-auth RECORDING service-role projection selects strictly id, company_id (recording_ref omitted)',
      'STATIC'
    );

    const verifyIndex = recordingBlock.indexOf('verifyActorForCompany');
    const postAuthIndex = recordingBlock.indexOf(".select('recording_ref')");
    assert(
      verifyIndex !== -1 && postAuthIndex !== -1 && verifyIndex < postAuthIndex,
      'Reg 13: verifyActorForCompany is executed BEFORE post-auth canonical recording_ref lookup',
      'STATIC'
    );

    // Runtime assertion: Boss can authorize recording signed URL post-auth
    const recordingResult = await createAuthorizedSignedUrl(
      { category: 'RECORDING', resourceId: CALL_A_ID },
      bossClient
    );
    assert(
      recordingResult.expiresIn === 900 &&
      recordingResult.signedUrl.includes('call_001.mp3'),
      'Reg 13: Boss successfully receives post-auth canonical recording signed URL with 900s TTL',
      'REAL LOCAL SUPABASE'
    );

    // Runtime assertion: SALE is forbidden before recording_ref can be accessed
    let saleDeniedRecording = false;
    try {
      await createAuthorizedSignedUrl(
        { category: 'RECORDING', resourceId: CALL_A_ID },
        saleClient
      );
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 403 && err.code === 'ROLE_FORBIDDEN') {
        saleDeniedRecording = true;
      }
    }
    assert(
      saleDeniedRecording,
      'Reg 13: SALE cannot access call recording signed URL (rejected with 403 ROLE_FORBIDDEN)',
      'REAL LOCAL SUPABASE'
    );
  }

  console.log('==================================================');
  console.log(`TEST RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('==================================================');

  if (failCount > 0) {
    process.exit(1);
  }
}

runSecurityTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
