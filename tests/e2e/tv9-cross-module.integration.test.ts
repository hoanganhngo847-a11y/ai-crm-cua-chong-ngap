import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  openResponseSlaWindow,
  resolveResponseSlaOnSaleReply,
  claimResponseSlaForAi,
} from '../../features/automation/response-sla/services/response-sla-store';
import {
  fetchAiAnalysisInput,
} from '../../features/ai-analysis/services/ai-analysis-store';
import {
  runCustomerAnalysisPipeline,
  FakeDeterministicAiModel,
} from '../../features/ai-analysis/services/ai-analysis-engine';
import {
  fetchSalesStyleLearningInput,
  persistSalesStyleProfile,
} from '../../features/sales-style/services/sales-style-store';
import { activateSalesStyleProfile } from '../../features/sales-style/services/sales-style-activation';
import {
  fetchCompanyAnalyticsOverview,
} from '../../features/analytics/services/analytics-store';
import type { SalesStyleOutput } from '../../shared/contracts/sales-style';

// Supabase Local Configuration
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

// Dedicated UUIDs for Cross-Module Integration Suite
const COMPANY_XM_A = 'd1000000-0000-0000-0000-000000000001';
const COMPANY_XM_B = 'd1000000-0000-0000-0000-000000000002';

const USER_XM_BOSS_A = { email: 'xm_boss_a@test.local', password: 'Password123!', fullName: 'XM Sếp A' };
const USER_XM_SALE_A = { email: 'xm_sale_a@test.local', password: 'Password123!', fullName: 'XM Sale A' };
const USER_XM_TECH_A = { email: 'xm_tech_a@test.local', password: 'Password123!', fullName: 'XM Tech A' };
const USER_XM_BOSS_B = { email: 'xm_boss_b@test.local', password: 'Password123!', fullName: 'XM Sếp B' };

let bossAUserId: string;
let saleAUserId: string;
let techAUserId: string;

let bossAClient: SupabaseClient;
let saleAClient: SupabaseClient;
let techAClient: SupabaseClient;
let bossBClient: SupabaseClient;

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

async function loginUser(config: { email: string; password: string }): Promise<SupabaseClient> {
  const client = createAnonClient();
  const { data, error } = await client.auth.signInWithPassword({
    email: config.email,
    password: config.password,
  });
  if (error || !data.session) {
    throw new Error(`Failed to sign in as ${config.email}: ${error?.message}`);
  }
  return client;
}

async function runCrossModuleSuite() {
  console.log('================================================================');
  console.log('STARTING TV9 CROSS-MODULE INTEGRATION TESTS');
  console.log('Verifying AI Analysis, Sales Style, Response SLA, and Analytics');
  console.log('across Omnichannel (Facebook/Website), Operations, Survey, Voice');
  console.log('================================================================');

  // 1. Companies
  const { error: compErr } = await adminClient.from('companies').upsert([
    { id: COMPANY_XM_A, name: 'Cross-Module Company A', status: 'ACTIVE' },
    { id: COMPANY_XM_B, name: 'Cross-Module Company B', status: 'ACTIVE' },
  ]);
  if (compErr) throw new Error(`Companies upsert failed: ${compErr.message}`);

  // 2. Users & Logins
  bossAUserId = await ensureTestUser(USER_XM_BOSS_A, COMPANY_XM_A, 'BOSS_ADMIN');
  saleAUserId = await ensureTestUser(USER_XM_SALE_A, COMPANY_XM_A, 'SALE');
  techAUserId = await ensureTestUser(USER_XM_TECH_A, COMPANY_XM_A, 'TECHNICIAN');
  await ensureTestUser(USER_XM_BOSS_B, COMPANY_XM_B, 'BOSS_ADMIN');

  bossAClient = await loginUser(USER_XM_BOSS_A);
  saleAClient = await loginUser(USER_XM_SALE_A);
  techAClient = await loginUser(USER_XM_TECH_A);
  bossBClient = await loginUser(USER_XM_BOSS_B);

  // ----------------------------------------------------------------------------
  // SECTION 1: AI Analysis & Omnichannel (Facebook/Website Ingestion)
  // ----------------------------------------------------------------------------
  console.log('\n--- Section 1: AI Analysis & Omnichannel (Facebook) ---');
  let fbCustomerId: string;
  let fbConvoId: string;
  let fbInboundIntId: string;

  {
    // 1.1 Ingest Facebook customer message via real han_ingest RPC
    const runSeed = Date.now().toString().slice(-6);
    const intakeOccurred = new Date().toISOString();
    const { data: ingestData, error: ingestErr } = await adminClient.rpc('han_ingest', {
      p_company: COMPANY_XM_A,
      p_channel: 'FACEBOOK',
      p_external: `10001:${runSeed}`,
      p_key: `fb_mid_xm_${runSeed}`,
      p_name: 'Nguyễn Văn Facebook',
      p_phone: '+84912345678',
      p_content: 'Tôi muốn lắp cửa chống ngập 3m tại Nguyễn Khuyến, SĐT của tôi là 0912345678',
      p_safe: 'Tôi muốn lắp cửa chống ngập 3m tại Nguyễn Khuyến, SĐT của tôi là [REDACTED_PHONE]',
      p_safe_status: 'SUCCEEDED',
      p_occurred: intakeOccurred,
      p_payload: {
        raw_sender: `10001:${runSeed}`,
        raw_recipient: 'fb_page_xm_999',
        webhook_token: 'secret_meta_webhook_token_xyz',
      },
    });

    if (ingestErr) throw new Error(`han_ingest failed: ${ingestErr.message}`);
    const ingestRow = ingestData as { status: string; interaction_id: string };
    fbInboundIntId = ingestRow.interaction_id;

    assert(Boolean(fbInboundIntId), 'han_ingest created interaction in public.interactions');

    // Query interaction to get customer_id and conversation_id
    const { data: intRow, error: intErr } = await adminClient
      .from('interactions')
      .select('customer_id, conversation_id')
      .eq('id', fbInboundIntId)
      .single();

    if (intErr || !intRow) throw new Error(`Failed to query ingested interaction: ${intErr?.message}`);
    fbCustomerId = intRow.customer_id;
    fbConvoId = intRow.conversation_id;

    assert(Boolean(fbCustomerId), 'Interaction has valid customer_id');
    assert(Boolean(fbConvoId), 'Interaction has valid conversation_id');

    // 1.2 Fetch bounded AI Analysis input via get_ai_analysis_input
    const aiInput = await fetchAiAnalysisInput(adminClient, {
      companyId: COMPANY_XM_A,
      customerId: fbCustomerId,
    });

    assert(aiInput.sources.length === 1, 'AI analysis fetched Facebook message from public.interactions');
    assert(aiInput.sources[0].interactionId === fbInboundIntId, 'Source ID matches ingested interaction');
    assert(aiInput.sources[0].channel === 'FACEBOOK', 'Source channel is FACEBOOK');
    assert(aiInput.sources[0].content.includes('[REDACTED_PHONE]'), 'Source content is sanitized derivative');

    // 1.3 Verify raw phone, raw payload, and webhook secrets are ABSENT
    const serialized = JSON.stringify(aiInput);
    assert(!serialized.includes('0912345678'), 'AI input DTO contains ZERO raw phone numbers');
    assert(!serialized.includes('secret_meta_webhook_token_xyz'), 'AI input DTO contains ZERO webhook secrets');
    assert(!('raw_content' in aiInput.sources[0]), 'raw_content is completely absent from AI input DTO');

    // 1.4 Run AI Customer Analysis pipeline
    const testModel = new FakeDeterministicAiModel('gemini-1.5-flash-xm', {
      summary: 'Khách hàng quan tâm lắp cửa chống ngập 3m tại phố Nguyễn Khuyến.',
      stageSuggestion: 'SURVEY_REQUESTED',
      stopReason: null,
      objections: [],
      nextAction: 'Xếp lịch khảo sát thực địa tại Nguyễn Khuyến',
      confidence: 0.90,
      evidence: 'Khách yêu cầu: Tôi muốn lắp cửa chống ngập 3m tại Nguyễn Khuyến',
    });

    const analysisRecord = await runCustomerAnalysisPipeline({
      model: testModel,
      companyId: COMPANY_XM_A,
      customerId: fbCustomerId,
      client: adminClient,
    });

    assert(Boolean(analysisRecord.id), 'AI analysis record persisted successfully');
    assert(analysisRecord.modelVersion === 'gemini-1.5-flash-xm', 'Trusted modelVersion persisted');
    assert(analysisRecord.stageSuggestion === 'SURVEY_REQUESTED', 'Suggested stage is SURVEY_REQUESTED');

    // 1.5 Critical Invariant: Zero CRM stage mutation
    const { data: custRow } = await adminClient
      .from('customers')
      .select('stage')
      .eq('id', fbCustomerId)
      .single();
    assert(custRow?.stage === 'LEAD_NEW', 'Customer.stage is untouched by AI Analysis (remains LEAD_NEW)');
  }

  // ----------------------------------------------------------------------------
  // SECTION 2: Sales Style Learning & Omnichannel (Facebook)
  // ----------------------------------------------------------------------------
  console.log('\n--- Section 2: Sales Style Learning & Omnichannel ---');
  let fbOutboundIntId: string;
  {
    // 2.1 Sale A sends an outbound Facebook message
    const { data: outInt, error: outErr } = await adminClient
      .from('interactions')
      .insert({
        company_id: COMPANY_XM_A,
        customer_id: fbCustomerId,
        conversation_id: fbConvoId,
        channel: 'FACEBOOK',
        type: 'MESSAGE',
        direction: 'OUTBOUND',
        actor_type: 'SALE',
        actor_user_id: saleAUserId,
        sanitization_status: 'SUCCEEDED',
        sanitized_content: 'Dạ em chào anh! Em gửi anh hình ảnh mẫu cửa chống ngập tự động bên em thi công thực tế ạ.',
        sanitizer_version: 'han-bounded-v2',
        created_at: new Date('2026-09-20T10:03:00Z').toISOString(),
      })
      .select('id')
      .single();

    if (outErr) throw new Error(`Outbound interaction insert failed: ${outErr.message}`);
    fbOutboundIntId = outInt.id;

    // 2.2 Fetch style learning input for Sale A
    const styleInput = await fetchSalesStyleLearningInput(adminClient, {
      companyId: COMPANY_XM_A,
      saleUserId: saleAUserId,
    });

    assert(styleInput.sources.length >= 1, 'Sale A has outbound learning sources');
    const matchedSource = styleInput.sources.find((s) => s.interactionId === fbOutboundIntId);
    assert(Boolean(matchedSource), 'Facebook outbound message included in sales style learning');
    assert(matchedSource?.channel === 'FACEBOOK', 'Source channel is FACEBOOK');

    // 2.3 Persist style profile with provenance-only examples
    const styleOutput: SalesStyleOutput = {
      salutationRules: {
        selfReferences: ['em'],
        customerReferences: ['anh'],
        commonOpenings: ['Dạ em chào anh!'],
        notes: ['Lịch sự, tôn trọng'],
      },
      sentenceStyle: {
        preferredLength: 'MEDIUM',
        toneDescriptors: ['chuyên nghiệp'],
        emojiUsage: 'LOW',
        punctuationPatterns: ['ạ.'],
        notes: ['Rõ ràng'],
      },
      questionStyle: {
        commonPatterns: ['Cửa rộng bao nhiêu ạ?'],
        discoveryApproach: ['Khảo sát kích thước cửa'],
        followUpApproach: ['Nhắc lịch khảo sát'],
        notes: ['Tập trung kỹ thuật'],
      },
      objectionStyle: {
        approaches: [
          {
            situation: 'Khách phân vân',
            responseApproach: 'Chia sẻ ảnh thi công thực tế',
          },
        ],
        notes: ['Nhẹ nhàng'],
      },
      closingStyle: {
        commonClosings: ['Em cảm ơn anh!'],
        callToActionPatterns: ['Em gửi kỹ thuật qua hỗ trợ anh nhé'],
        urgencyStyle: ['Mùa mưa đang đến'],
        notes: ['Chốt lịch hẹn'],
      },
    };

    const draftProfile = await persistSalesStyleProfile(adminClient, {
      companyId: COMPANY_XM_A,
      saleUserId: saleAUserId,
      sourceRefs: [{ type: 'INTERACTION', id: fbOutboundIntId }],
      styleOutput,
      modelVersion: 'gemini-1.5-pro-xm',
    });

    assert(draftProfile.generationStatus === 'DRAFT', 'Profile initial status is DRAFT');
    assert(draftProfile.examples.length === 1, 'Profile has exactly 1 derived example');
    assert(draftProfile.examples[0].interaction_id === fbOutboundIntId, 'Example contains interaction_id');
    assert(draftProfile.examples[0].channel === 'FACEBOOK', 'Example contains channel');
    assert(!('content' in draftProfile.examples[0]), 'Example contains ZERO message body or content');

    // 2.4 Activation Role Authorization: Only BOSS_ADMIN can activate
    let saleDenied = false;
    try {
      await activateSalesStyleProfile(saleAClient, draftProfile.id);
    } catch {
      saleDenied = true;
    }
    assert(saleDenied, 'SALE cannot activate Sales Style profile');

    let techDenied = false;
    try {
      await activateSalesStyleProfile(techAClient, draftProfile.id);
    } catch {
      techDenied = true;
    }
    assert(techDenied, 'TECHNICIAN cannot activate Sales Style profile');

    let crossBossDenied = false;
    try {
      await activateSalesStyleProfile(bossBClient, draftProfile.id);
    } catch {
      crossBossDenied = true;
    }
    assert(crossBossDenied, 'Boss B from Company B cannot activate Company A profile');

    // Boss A activates profile
    const activeProfile = await activateSalesStyleProfile(bossAClient, draftProfile.id);
    assert(activeProfile.generationStatus === 'ACTIVE', 'Boss A successfully activated profile');
    assert(activeProfile.activatedByUserId === bossAUserId, 'activated_by_user_id is recorded');
  }

  // ----------------------------------------------------------------------------
  // SECTION 3: Response SLA & Facebook Semantics
  // ----------------------------------------------------------------------------
  console.log('\n--- Section 3: Response SLA with Facebook Semantics ---');
  {
    // 3.1 Open Response SLA window for Facebook inbound message
    const slaWindow = await openResponseSlaWindow({
      companyId: COMPANY_XM_A,
      conversationId: fbConvoId,
      triggerInteractionId: fbInboundIntId,
    });

    assert(slaWindow.state === 'OPEN', 'Response SLA window opened on Facebook message');
    assert(slaWindow.conversationId === fbConvoId, 'Window bound to Facebook conversation');
    assert(slaWindow.triggerInteractionId === fbInboundIntId, 'Window bound to trigger interaction');

    // 3.2 Duplicate inbound message returns existing window without resetting deadline
    const dupWindow = await openResponseSlaWindow({
      companyId: COMPANY_XM_A,
      conversationId: fbConvoId,
      triggerInteractionId: fbInboundIntId,
    });
    assert(dupWindow.id === slaWindow.id, 'Duplicate inbound message returns same window ID');
    assert(dupWindow.deadlineAt === slaWindow.deadlineAt, 'Deadline is unchanged on duplicate inbound message');

    // 3.3 Outbound Facebook reply resolves window to SALE_RESPONDED
    const resolvedWindow = await resolveResponseSlaOnSaleReply({
      companyId: COMPANY_XM_A,
      conversationId: fbConvoId,
      saleInteractionId: fbOutboundIntId,
    });

    assert(resolvedWindow !== null, 'SLA window resolved on Sale reply');
    assert(resolvedWindow?.state === 'SALE_RESPONDED', 'Window state transitioned to SALE_RESPONDED');
    assert(resolvedWindow?.saleResponseInteractionId === fbOutboundIntId, 'Linked sale response interaction');

    // 3.4 Subsequent AI claim attempt is denied
    const claimRes = await claimResponseSlaForAi({
      companyId: COMPANY_XM_A,
      windowId: slaWindow.id,
    });
    assert(claimRes.claimed === false, 'AI claim is denied after Sale responded');
    assert(claimRes.decision === 'SALE_ALREADY_RESPONDED', 'Claim decision is SALE_ALREADY_RESPONDED');
  }

  // ----------------------------------------------------------------------------
  // SECTION 4: Analytics Cross-Module Aggregation & Authorization
  // ----------------------------------------------------------------------------
  console.log('\n--- Section 4: Analytics with Operations, Surveys, Calls & Finance ---');
  {
    // Create cross-module data
    // 4.0 Pricing policy & calculations needed by foreign keys
    const runTimestamp = Date.now();
    const policyId = crypto.randomUUID();
    const calc1Id  = crypto.randomUUID();
    const calc2Id  = crypto.randomUUID();
    const order1Id = crypto.randomUUID();
    const order2Id = crypto.randomUUID();

    const { error: polErr } = await adminClient.from('pricing_policies').insert({
      id: policyId,
      company_id: COMPANY_XM_A,
      version: `V-XM-${runTimestamp}`,
      conditions: {},
      price_rules: {},
      effective_at: new Date('2026-01-01T00:00:00Z').toISOString(),
      status: 'ACTIVE',
    });
    if (polErr) throw new Error(`Pricing policy insert failed: ${polErr.message}`);

    const { error: calcErr } = await adminClient.from('price_calculations').insert([
      {
        id: calc1Id,
        company_id: COMPANY_XM_A,
        customer_id: fbCustomerId,
        pricing_policy_id: policyId,
        policy_version: `V-XM-${runTimestamp}`,
        input_data: {},
        amount: 25000000.00,
        status: 'CALCULATED',
      },
      {
        id: calc2Id,
        company_id: COMPANY_XM_A,
        customer_id: fbCustomerId,
        pricing_policy_id: policyId,
        policy_version: `V-XM-${runTimestamp}`,
        input_data: {},
        amount: 15000000.00,
        status: 'CALCULATED',
      },
    ]);
    if (calcErr) throw new Error(`Price calculations insert failed: ${calcErr.message}`);

    const { error: ordErr } = await adminClient.from('orders').insert([
      {
        id: order1Id,
        company_id: COMPANY_XM_A,
        customer_id: fbCustomerId,
        order_code: `ORD-XM-${runTimestamp}-1`,
        payment_reference: `PAY-XM-${runTimestamp}-1`,
        price_calculation_id: calc1Id,
        deposit_status: 'CONFIRMED',
        order_status: 'READY_FOR_INSTALL',
        final_amount: 25000000.00,
        created_at: new Date('2026-09-21T09:00:00Z').toISOString(),
      },
      {
        id: order2Id,
        company_id: COMPANY_XM_A,
        customer_id: fbCustomerId,
        order_code: `ORD-XM-${runTimestamp}-2`,
        payment_reference: `PAY-XM-${runTimestamp}-2`,
        price_calculation_id: calc2Id,
        deposit_status: 'CONFIRMED',
        order_status: 'COMPLETED',
        final_amount: 15000000.00,
        created_at: new Date('2026-09-22T14:00:00Z').toISOString(),
      },
    ]);
    if (ordErr) throw new Error(`Orders insert failed: ${ordErr.message}`);

    const apptId = crypto.randomUUID();
    const { error: apptErr } = await adminClient.from('appointments').insert([
      {
        id: apptId,
        company_id: COMPANY_XM_A,
        customer_id: fbCustomerId,
        type: 'SURVEY',
        start_time: new Date('2026-09-20T14:00:00Z').toISOString(),
        assignee_id: techAUserId,
        address: '123 Phố Huế, Hà Nội',
        status: 'COMPLETED',
        created_at: new Date('2026-09-20T08:00:00Z').toISOString(),
        updated_at: new Date('2026-09-20T16:00:00Z').toISOString(),
      },
    ]);
    if (apptErr) throw new Error(`Appointments insert failed: ${apptErr.message}`);

    const { error: survErr } = await adminClient.from('surveys').insert([
      {
        id: crypto.randomUUID(),
        appointment_id: apptId,
        company_id: COMPANY_XM_A,
        customer_id: fbCustomerId,
        completed_by: techAUserId,
        measurements: { clear_width_mm: 3200, barrier_height_mm: 800 },
        photos: [],
        site_condition: 'CONCRETE_EVEN',
        completed_at: new Date('2026-09-20T16:00:00Z').toISOString(),
      },
    ]);
    if (survErr) throw new Error(`Surveys insert failed: ${survErr.message}`);

    const { error: callErr } = await adminClient.from('calls').insert([
      {
        id: crypto.randomUUID(),
        company_id: COMPANY_XM_A,
        customer_id: fbCustomerId,
        direction: 'INBOUND',
        agent_type: 'SALE',
        status: 'COMPLETED',
        transcript_status: 'COMPLETED',
        started_at: new Date('2026-09-20T09:00:00Z').toISOString(),
        ended_at: new Date('2026-09-20T09:05:00Z').toISOString(),
      },
    ]);
    if (callErr) throw new Error(`Calls insert failed: ${callErr.message}`);

    const campaignId = crypto.randomUUID();
    const { error: campErr } = await adminClient.from('care_campaigns').insert({
      id: campaignId,
      company_id: COMPANY_XM_A,
      channel: 'FACEBOOK',
      audience_rule: {},
      message_template: 'Chăm sóc định kỳ',
      started_at: new Date('2026-09-10T00:00:00Z').toISOString(),
    });
    if (campErr) throw new Error(`Care campaigns insert failed: ${campErr.message}`);

    const { error: careErr } = await adminClient.from('care_deliveries').insert([
      {
        id: crypto.randomUUID(),
        company_id: COMPANY_XM_A,
        campaign_id: campaignId,
        customer_id: fbCustomerId,
        idempotency_key: `care-fb-${Date.now()}`,
        channel: 'FACEBOOK',
        status: 'CONVERTED_TO_SALE',
        sent_at: new Date('2026-09-20T07:00:00Z').toISOString(),
        delivered_at: new Date('2026-09-20T07:02:00Z').toISOString(),
        converted_to_sale_at: new Date('2026-09-20T10:00:00Z').toISOString(),
      },
    ]);
    if (careErr) throw new Error(`Care deliveries insert failed: ${careErr.message}`);

    await adminClient.from('finance_summaries').delete().eq('company_id', COMPANY_XM_A);

    const { error: finErr } = await adminClient.from('finance_summaries').upsert([
      {
        order_id: order1Id,
        company_id: COMPANY_XM_A,
        contract_value: 25000000.00,
        collected_amount: 25000000.00,
        receivable_amount: 0.00,
        completed_revenue: 0.00,
      },
      {
        order_id: order2Id,
        company_id: COMPANY_XM_A,
        contract_value: 15000000.00,
        collected_amount: 0.00,
        receivable_amount: 15000000.00,
        completed_revenue: 15000000.00,
      },
    ]);
    if (finErr) throw new Error(`Finance summaries upsert failed: ${finErr.message}`);

    // 4.1 Boss A retrieves analytics overview
    const overview = await fetchCompanyAnalyticsOverview(bossAClient, {
      companyId: COMPANY_XM_A,
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T00:00:00.000Z',
    });

    assert(overview.customers.newCustomers >= 1, 'Analytics counts Facebook customer');
    assert(overview.orders.created >= 2, 'Analytics counts Operations orders');
    assert(Number(overview.orders.orderValueCreated) >= 40000000.00, 'Analytics aggregates order value');

    const statuses = new Set(overview.orders.byStatus.map((s) => s.status));
    assert(statuses.has('READY_FOR_INSTALL'), 'Orders byStatus includes Operations READY_FOR_INSTALL');
    assert(statuses.has('COMPLETED'), 'Orders byStatus includes Operations COMPLETED');

    assert(overview.surveys.completedSurveys >= 1, 'Analytics counts completed surveys');
    assert(overview.surveys.surveyAppointmentsCompleted >= 1, 'Analytics counts completed survey appointments');
    assert(overview.calls.totalCalls >= 1, 'Analytics counts voice calls');
    assert(overview.care.careConvertedToSale >= 1, 'Analytics counts care converted to sale');

    assert(overview.financeSnapshot.contractValue === '40000000.00', 'Finance snapshot contract value matches');
    assert(overview.financeSnapshot.collectedAmount === '25000000.00', 'Finance snapshot collected amount matches');

    // 4.2 Role boundary: SALE denied access to Analytics / Finance snapshot
    let saleDenied = false;
    try {
      await fetchCompanyAnalyticsOverview(saleAClient, {
        companyId: COMPANY_XM_A,
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-30T00:00:00.000Z',
      });
    } catch {
      saleDenied = true;
    }
    assert(saleDenied, 'SALE cannot access Company Analytics Overview (Finance confidentiality)');

    // 4.3 Role boundary: TECHNICIAN denied access
    let techDenied = false;
    try {
      await fetchCompanyAnalyticsOverview(techAClient, {
        companyId: COMPANY_XM_A,
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-30T00:00:00.000Z',
      });
    } catch {
      techDenied = true;
    }
    assert(techDenied, 'TECHNICIAN cannot access Company Analytics Overview');

    // 4.4 Cross-Company isolation: Boss B denied access to Company A Analytics
    let crossBossDenied = false;
    try {
      await fetchCompanyAnalyticsOverview(bossBClient, {
        companyId: COMPANY_XM_A,
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-30T00:00:00.000Z',
      });
    } catch {
      crossBossDenied = true;
    }
    assert(crossBossDenied, 'Boss B cannot access Company A Analytics (cross-tenant barrier)');
  }

  console.log('\n================================================================');
  console.log(`CROSS-MODULE INTEGRATION RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('================================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

runCrossModuleSuite().catch((err) => {
  console.error('[FATAL] Cross-Module Suite crashed:', err);
  process.exit(1);
});
