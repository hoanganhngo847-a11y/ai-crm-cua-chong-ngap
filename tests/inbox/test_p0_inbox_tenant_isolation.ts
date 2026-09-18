import assert from 'node:assert';
import { NextRequest } from 'next/server';
import { InboxService } from '../../features/inbox/services/inbox.service';
import { GET as inboxGetHandler, POST as inboxPostHandler } from '../../app/api/inbox/route';
import { APPLICATION_ROLES } from '../../shared/constants/roles';
import type { ActorContext } from '../../shared/contracts/auth';
import type { Conversation, InboxMessage } from '../../features/inbox/types/inbox.types';

async function runInboxTenantIsolationTests() {
  console.log('======================================================================');
  console.log('STARTING P0 TEST SUITE: OMNICHANNEL INBOX ABSOLUTE TENANT ISOLATION');
  console.log('======================================================================');

  const companyA = '11111111-1111-1111-1111-111111111111';
  const companyB = '22222222-2222-2222-2222-222222222222';

  const userSaleCompanyA: ActorContext = {
    userId: 'user-sale-a',
    companyId: companyA,
    memberId: 'mem-sale-a',
    role: APPLICATION_ROLES.SALE,
    fullName: 'Sale Công ty A',
    email: 'sale@companya.vn',
    profileStatus: 'ACTIVE',
    membershipStatus: 'ACTIVE',
    aal: 'aal1',
    isMfaEnrolled: false,
  };

  const userBossCompanyA: ActorContext = {
    userId: 'user-boss-a',
    companyId: companyA,
    memberId: 'mem-boss-a',
    role: APPLICATION_ROLES.BOSS_ADMIN,
    fullName: 'Boss Admin Công ty A',
    email: 'boss@companya.vn',
    profileStatus: 'ACTIVE',
    membershipStatus: 'ACTIVE',
    aal: 'aal1',
    isMfaEnrolled: false,
  };

  const userSaleCompanyB: ActorContext = {
    userId: 'user-sale-b',
    companyId: companyB,
    memberId: 'mem-sale-b',
    role: APPLICATION_ROLES.SALE,
    fullName: 'Sale Công ty B (Attacker)',
    email: 'sale@companyb.vn',
    profileStatus: 'ACTIVE',
    membershipStatus: 'ACTIVE',
    aal: 'aal1',
    isMfaEnrolled: false,
  };

  const userTechCompanyA: ActorContext = {
    userId: 'user-tech-a',
    companyId: companyA,
    memberId: 'mem-tech-a',
    role: APPLICATION_ROLES.TECHNICIAN,
    fullName: 'Kỹ thuật viên A',
    email: 'tech@companya.vn',
    profileStatus: 'ACTIVE',
    membershipStatus: 'ACTIVE',
    aal: 'aal1',
    isMfaEnrolled: false,
  };

  // Seed sample data for testing
  const seedConvs: Conversation[] = [
    {
      id: 'conv-a-1',
      company_id: companyA,
      customer_id: 'cust-a-1',
      customer_name: 'Khách hàng của Công ty A',
      customer_code: 'KH-A-000001',
      customer_phone: '0912345678',
      channel: 'facebook',
      last_message: 'Tôi muốn lắp cửa chống ngập tại cơ sở A',
      last_message_at: '2026-09-18T10:00:00Z',
      unread_count: 1,
      status: 'OPEN',
      updated_at: '2026-09-18T10:00:00Z',
      created_at: '2026-09-18T09:00:00Z',
    },
    {
      id: 'conv-b-1',
      company_id: companyB,
      customer_id: 'cust-b-1',
      customer_name: 'Khách hàng của Công ty B',
      customer_code: 'KH-B-000001',
      customer_phone: '0987654321',
      channel: 'zalo',
      last_message: 'Cần tư vấn báo giá bên công ty B',
      last_message_at: '2026-09-18T11:00:00Z',
      unread_count: 0,
      status: 'OPEN',
      updated_at: '2026-09-18T11:00:00Z',
      created_at: '2026-09-18T10:30:00Z',
    },
  ];

  const seedMsgs: Record<string, InboxMessage[]> = {
    'conv-a-1': [
      {
        id: 'msg-a-1',
        company_id: companyA,
        conversation_id: 'conv-a-1',
        customer_id: 'cust-a-1',
        channel: 'facebook',
        sender_type: 'customer',
        sender_name: 'Khách hàng của Công ty A',
        content: 'Tôi muốn lắp cửa chống ngập tại cơ sở A',
        created_at: '2026-09-18T10:00:00Z',
        direction: 'inbound',
      },
    ],
    'conv-b-1': [
      {
        id: 'msg-b-1',
        company_id: companyB,
        conversation_id: 'conv-b-1',
        customer_id: 'cust-b-1',
        channel: 'zalo',
        sender_type: 'customer',
        sender_name: 'Khách hàng của Công ty B',
        content: 'Cần tư vấn báo giá bên công ty B',
        created_at: '2026-09-18T11:00:00Z',
        direction: 'inbound',
      },
    ],
  };

  // Reset store before tests
  InboxService.resetInboxStore(seedConvs, seedMsgs);

  // ============================================================================
  // SECTION 1: DIRECT SERVICE LEVEL TENANT ISOLATION
  // ============================================================================
  console.log('\n--- Section 1: InboxService Direct Tenant Isolation ---');

  // 1a. getConversations: Company B must NOT see Company A's conversations
  const convsB = await InboxService.getConversations(companyB);
  assert.strictEqual(convsB.length, 1, 'Company B must only see 1 conversation');
  assert.strictEqual(convsB[0].id, 'conv-b-1');
  assert.strictEqual(convsB[0].company_id, companyB);
  assert(!convsB.some((c) => c.company_id === companyA), 'Company A conversations must NEVER leak to Company B');
  console.log('✓ PASS 1a: getConversations filters strictly by companyId');

  // 1b. getConversationById: Company B requesting Company A's conversation returns null
  const crossConv = await InboxService.getConversationById(companyB, 'conv-a-1');
  assert.strictEqual(crossConv, null, 'getConversationById across tenants must return null');
  console.log('✓ PASS 1b: getConversationById prevents cross-tenant lookup');

  // 1c. getMessagesByConversationId: Company B requesting Company A's messages throws 404 NOT_FOUND
  let messageCrossError: any = null;
  try {
    await InboxService.getMessagesByConversationId(companyB, 'conv-a-1');
  } catch (err) {
    messageCrossError = err;
  }
  assert(messageCrossError, 'getMessagesByConversationId must throw error on cross-tenant access');
  assert.strictEqual(messageCrossError.status, 404, 'Must throw 404 status');
  assert.strictEqual(messageCrossError.code, 'NOT_FOUND', 'Must throw NOT_FOUND code');
  console.log('✓ PASS 1c: getMessagesByConversationId fails closed with 404 on cross-tenant access');

  // 1d. sendMessage: Company B attempting to send message to Company A's conversation throws 404 NOT_FOUND
  let sendCrossError: any = null;
  try {
    await InboxService.sendMessage(
      {
        conversation_id: 'conv-a-1',
        company_id: companyB,
        content: 'Malicious attempt from Company B',
        sender_type: 'sale',
      },
      companyB
    );
  } catch (err) {
    sendCrossError = err;
  }
  assert(sendCrossError, 'sendMessage must throw on cross-tenant target');
  assert.strictEqual(sendCrossError.status, 404, 'Must throw 404 status');
  assert.strictEqual(sendCrossError.code, 'NOT_FOUND', 'Must throw NOT_FOUND code');

  // Verify no messages were added to Company A's conversation
  const msgsA = await InboxService.getMessagesByConversationId(companyA, 'conv-a-1');
  assert.strictEqual(msgsA.length, 1, 'Company A conversation messages must remain untampered');
  console.log('✓ PASS 1d: sendMessage strictly prevents cross-tenant mutation and fails closed with 404');

  // 1e. getCustomerTimeline: Company B requesting Company A customer timeline returns empty
  const timelineB = await InboxService.getCustomerTimeline('cust-a-1', companyB);
  assert.strictEqual(timelineB.length, 0, 'Customer timeline across tenants must return empty');
  console.log('✓ PASS 1e: getCustomerTimeline does not leak cross-tenant events');

  // ============================================================================
  // SECTION 2: API ROUTE GET /api/inbox TENANT ISOLATION & ZERO-PHONE
  // ============================================================================
  console.log('\n--- Section 2: GET /api/inbox Route Tenant Isolation & Zero-Phone ---');

  // 2a. Company A user accessing Company A conversation: 200 OK
  const reqGetOwn = new NextRequest('http://localhost:3000/api/inbox?conversation_id=conv-a-1', {
    method: 'GET',
  });
  const resGetOwn = await inboxGetHandler(reqGetOwn, { actor: userSaleCompanyA });
  assert.strictEqual(resGetOwn.status, 200);
  const dataGetOwn = await resGetOwn.json();
  assert.strictEqual(dataGetOwn.success, true);
  assert.strictEqual(dataGetOwn.data.conversation.id, 'conv-a-1');
  // SALE role: phone must be masked
  assert.strictEqual(dataGetOwn.data.conversation.customer_phone, '09******78');
  assert.strictEqual(dataGetOwn.data.messages.length, 1);
  console.log('✓ PASS 2a: Valid tenant GET returns 200 and masks phone for SALE');

  // 2b. BOSS_ADMIN from Company A: phone is unmasked
  const resGetBoss = await inboxGetHandler(reqGetOwn, { actor: userBossCompanyA });
  assert.strictEqual(resGetBoss.status, 200);
  const dataGetBoss = await resGetBoss.json();
  assert.strictEqual(dataGetBoss.data.conversation.customer_phone, '0912345678');
  console.log('✓ PASS 2b: BOSS_ADMIN receives unmasked phone in Inbox detail');

  // 2c. Company B user attempting to access Company A conversation: 404 NOT_FOUND
  const reqCrossGet = new NextRequest('http://localhost:3000/api/inbox?conversation_id=conv-a-1', {
    method: 'GET',
  });
  const resCrossGet = await inboxGetHandler(reqCrossGet, { actor: userSaleCompanyB });
  assert.strictEqual(resCrossGet.status, 404, 'Cross-tenant GET must return 404');
  const dataCrossGet = await resCrossGet.json();
  assert.strictEqual(dataCrossGet.success, false);
  assert.strictEqual(dataCrossGet.error, 'NOT_FOUND');
  console.log('✓ PASS 2c: Cross-tenant GET /api/inbox?conversation_id=... is BLOCKED with 404 NOT_FOUND');

  // 2d. Client query param spoofing attempt: Company B sends ?company_id=companyA
  const reqSpoofedGet = new NextRequest(
    `http://localhost:3000/api/inbox?company_id=${companyA}`,
    { method: 'GET' }
  );
  const resSpoofedGet = await inboxGetHandler(reqSpoofedGet, { actor: userSaleCompanyB });
  assert.strictEqual(resSpoofedGet.status, 200);
  const dataSpoofedGet = await resSpoofedGet.json();
  assert.strictEqual(dataSpoofedGet.success, true);
  // Must return only Company B's conversations (1 item), ignoring spoofed param!
  assert.strictEqual(dataSpoofedGet.data.length, 1);
  assert.strictEqual(dataSpoofedGet.data[0].id, 'conv-b-1');
  assert.strictEqual(dataSpoofedGet.data[0].company_id, companyB);
  console.log('✓ PASS 2d: Query param company_id spoofing completely IGNORED');

  // ============================================================================
  // SECTION 3: API ROUTE POST /api/inbox MUTATION ISOLATION
  // ============================================================================
  console.log('\n--- Section 3: POST /api/inbox Route Mutation Isolation ---');

  // 3a. Company A user sending message to Company A conversation: 201 Created
  const reqPostOwn = new NextRequest('http://localhost:3000/api/inbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversation_id: 'conv-a-1',
      content: 'Chào bạn, chúng tôi đã ghi nhận yêu cầu đo đạc.',
    }),
  });
  const resPostOwn = await inboxPostHandler(reqPostOwn, { actor: userSaleCompanyA });
  assert.strictEqual(resPostOwn.status, 201);
  const dataPostOwn = await resPostOwn.json();
  assert.strictEqual(dataPostOwn.success, true);
  assert.strictEqual(dataPostOwn.data.company_id, companyA);
  assert.strictEqual(dataPostOwn.data.conversation_id, 'conv-a-1');
  console.log('✓ PASS 3a: Valid tenant POST sends message successfully (201)');

  // 3b. Company B user attempting to send message to Company A conversation: 404 NOT_FOUND
  const reqCrossPost = new NextRequest('http://localhost:3000/api/inbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversation_id: 'conv-a-1',
      content: 'Hack attempt: inject message into tenant A',
    }),
  });
  const resCrossPost = await inboxPostHandler(reqCrossPost, { actor: userSaleCompanyB });
  assert.strictEqual(resCrossPost.status, 404, 'Cross-tenant POST must return 404');
  const dataCrossPost = await resCrossPost.json();
  assert.strictEqual(dataCrossPost.success, false);
  assert.strictEqual(dataCrossPost.error, 'NOT_FOUND');
  console.log('✓ PASS 3b: Cross-tenant POST /api/inbox is BLOCKED with 404 NOT_FOUND');

  // 3c. Client body spoofing attempt: Company B sends company_id = companyA in body
  const reqSpoofedBodyPost = new NextRequest('http://localhost:3000/api/inbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversation_id: 'conv-a-1',
      company_id: companyA, // Attacker sends Company A ID in body
      content: 'Hack attempt with spoofed company_id in body',
    }),
  });
  const resSpoofedBodyPost = await inboxPostHandler(reqSpoofedBodyPost, { actor: userSaleCompanyB });
  assert.strictEqual(resSpoofedBodyPost.status, 404, 'Spoofed body company_id must be ignored and blocked with 404');
  const dataSpoofedBodyPost = await resSpoofedBodyPost.json();
  assert.strictEqual(dataSpoofedBodyPost.success, false);
  assert.strictEqual(dataSpoofedBodyPost.error, 'NOT_FOUND');
  console.log('✓ PASS 3c: Body company_id spoofing completely IGNORED and blocked');

  // ============================================================================
  // SECTION 4: RBAC CONTROLS (TECHNICIAN BLOCKED, UNAUTH BLOCKED)
  // ============================================================================
  console.log('\n--- Section 4: RBAC & Authentication Checks ---');

  // 4a. TECHNICIAN attempting GET /api/inbox: 403 ROLE_FORBIDDEN
  const reqTechGet = new NextRequest('http://localhost:3000/api/inbox', { method: 'GET' });
  const resTechGet = await inboxGetHandler(reqTechGet, { actor: userTechCompanyA });
  assert.strictEqual(resTechGet.status, 403);
  const dataTechGet = await resTechGet.json();
  assert.strictEqual(dataTechGet.error, 'ROLE_FORBIDDEN');
  console.log('✓ PASS 4a: TECHNICIAN role blocked from GET /api/inbox (403)');

  // 4b. TECHNICIAN attempting POST /api/inbox: 403 ROLE_FORBIDDEN
  const reqTechPost = new NextRequest('http://localhost:3000/api/inbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversation_id: 'conv-a-1',
      content: 'Tech trying to send message',
    }),
  });
  const resTechPost = await inboxPostHandler(reqTechPost, { actor: userTechCompanyA });
  assert.strictEqual(resTechPost.status, 403);
  const dataTechPost = await resTechPost.json();
  assert.strictEqual(dataTechPost.error, 'ROLE_FORBIDDEN');
  console.log('✓ PASS 4b: TECHNICIAN role blocked from POST /api/inbox (403)');

  // 4c. Unauthenticated user: 401 UNAUTHORIZED
  const resUnauthGet = await inboxGetHandler(reqGetOwn, { actor: null });
  assert.strictEqual(resUnauthGet.status, 401);
  const dataUnauthGet = await resUnauthGet.json();
  assert.strictEqual(dataUnauthGet.error, 'UNAUTHORIZED');
  console.log('✓ PASS 4c: Unauthenticated request blocked with 401 UNAUTHORIZED');

  // 4d. Active session with mock Supabase client querying company_members
  const mockSupabaseCompanyB = {
    auth: {
      getUser: async () => ({
        data: { user: { id: 'user-supabase-b' } },
        error: null,
      }),
    },
    from: (table: string) => ({
      select: () => ({
        eq: (col: string, val: string) => ({
          eq: (col2: string, val2: string) => ({
            maybeSingle: async () => {
              if (table === 'company_members' || table === 'members') {
                return {
                  data: {
                    company_id: companyB,
                    role: APPLICATION_ROLES.SALE,
                    status: 'ACTIVE',
                  },
                  error: null,
                };
              }
              return { data: null, error: null };
            },
          }),
        }),
      }),
    }),
  };

  const reqSupabaseDb = new NextRequest('http://localhost:3000/api/inbox?conversation_id=conv-a-1', {
    method: 'GET',
  });
  const resSupabaseDb = await inboxGetHandler(reqSupabaseDb, {
    supabaseClient: mockSupabaseCompanyB as any,
  });
  assert.strictEqual(resSupabaseDb.status, 404, 'DB-derived membership of Company B must block Company A conv with 404');
  console.log('✓ PASS 4d: Database-derived membership correctly enforces tenant isolation');

  console.log('\n======================================================================');
  console.log('ALL P0 INBOX TENANT ISOLATION TESTS PASSED SUCCESSFULLY! (100%)');
  console.log('======================================================================\n');
}

runInboxTenantIsolationTests().catch((err) => {
  console.error('TEST SUITE FAILED:', err);
  process.exit(1);
});
