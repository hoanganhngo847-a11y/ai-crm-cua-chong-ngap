import assert from 'node:assert';
import { NextRequest } from 'next/server';
import { InboxService } from '../../features/inbox/services/inbox.service';
import { GET as inboxGetHandler, POST as inboxPostHandler } from '../../app/api/inbox/route';
import { APPLICATION_ROLES } from '../../shared/constants/roles';
import type { ActorContext } from '../../shared/contracts/auth';
import type { Conversation, InboxMessage } from '../../features/inbox/types/inbox.types';

async function runInboxTenantIsolationTests() {
  process.env.DEMO_MODE = 'true';
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
  assert.strictEqual(dataPostOwn.data.delivery_status, 'PENDING_DISPATCH', 'delivery_status must be PENDING_DISPATCH');
  assert.strictEqual(dataPostOwn.data.raw_content, undefined, 'raw_content must NOT be present in response DTO');
  assert.strictEqual(
    dataPostOwn.message,
    'Tiếp nhận tin nhắn thành công, đang xếp hàng gửi đến khách hàng',
    'Response message must reflect outbound dispatch queue status'
  );
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
  // ============================================================================
  // SECTION 5: CANONICAL DATABASE PERSISTENCE & SECURITY ISOLATION (NON-DEMO MODE)
  // ============================================================================
  console.log('\n--- Section 5: Canonical Database Persistence & Security Isolation ---');
  delete process.env.DEMO_MODE; // Non-demo mode (Production persistence)

  let queriedPrivateSchema = false;
  const mockDbCalls: { table?: string; action?: string; company_id?: string; schema?: string; record?: any; fnName?: string; params?: any }[] = [];

  const mockDbClient: any = {
    simulateAuditError: false,
    schema: (s: string) => {
      if (s === 'private') queriedPrivateSchema = true;
      return {
        from: (t: string) => ({
          select: (cols?: string) => ({
            in: (col: string, vals: any[]) => ({
              eq: (col2: string, val2: any) => Promise.resolve({
                data: [{ interaction_id: 'int-1', raw_content: 'Raw phone 0912345678' }],
                error: null,
              }),
            }),
          }),
          insert: (record: any) => {
            mockDbCalls.push({ table: t, action: 'insert_private', schema: s, record });
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
    from: (table: string) => ({
      select: (cols?: string) => ({
        eq: (col: string, val: string) => {
          mockDbCalls.push({ table, action: 'select', company_id: val });
          return {
            eq: (col2: string, val2: string) => ({
              order: () => {
                const resPromise: any = Promise.resolve({
                  data: [{
                    id: 'int-1',
                    company_id: val,
                    customer_id: 'cust-1',
                    conversation_id: 'conv-1',
                    channel: 'ZALO',
                    type: 'MESSAGE',
                    direction: 'INBOUND',
                    sanitized_content: 'Số đã làm sạch 09******78',
                    sanitization_status: 'SUCCEEDED',
                    actor_type: 'CUSTOMER',
                    created_at: new Date().toISOString(),
                  }],
                  error: null,
                });
                resPromise.limit = () => resPromise;
                return resPromise;
              },
              maybeSingle: () => {
                if (table === 'conversations') {
                  return Promise.resolve({
                    data: {
                      id: val2,
                      company_id: val,
                      customer_id: 'cust-1',
                      channel: 'ZALO',
                      unread_count: 1,
                      status: 'OPEN',
                    },
                    error: null,
                  });
                }
                return Promise.resolve({ data: null, error: null });
              },
            }),
            in: () => ({
              order: () => Promise.resolve({ data: [], error: null }),
            }),
            order: () => Promise.resolve({
              data: [
                {
                  id: 'conv-db-1',
                  company_id: val,
                  customer_id: 'cust-1',
                  channel: 'ZALO',
                  external_conversation_id: 'ext-1',
                  last_message_at: new Date().toISOString(),
                  unread_count: 0,
                  status: 'OPEN',
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  customers: {
                    id: 'cust-1',
                    name: 'Khách hàng DB',
                    customer_code: 'KH-000001',
                    stage: 'LEAD_NEW',
                    source: 'ZALO',
                  },
                },
              ],
              error: null,
            }),
          };
        },
      }),
      insert: (record: any) => {
        mockDbCalls.push({ table, action: 'insert', record });
        if (table === 'audit_logs' && mockDbClient.simulateAuditError) {
          const errObj = { error: new Error('Postgres audit_logs deadlocked (Simulated audit failure)') };
          return {
            ...errObj,
            select: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: errObj.error }),
            }),
            then: (resolve: any) => resolve(errObj),
          };
        }
        return {
          error: null,
          select: () => ({
            maybeSingle: () => Promise.resolve({
              data: { id: 'cust-1', name: 'Khách mới', customer_code: 'KH-000001', stage: 'LEAD_NEW' },
              error: null,
            }),
          }),
          then: (resolve: any) => resolve({ error: null }),
        };
      },
      update: (fields: any) => ({
        eq: (col: string, val: string) => ({
          eq: (col2: string, val2: string) => {
            mockDbCalls.push({ table, action: 'update', company_id: val2 });
            return Promise.resolve({ error: null });
          },
        }),
      }),
    }),
    rpc: async (fnName: string, params: any) => {
      mockDbCalls.push({ action: 'rpc', fnName, params });
      if (fnName === 'get_interaction_raw_content') {
        return {
          data: [{
            interaction_id: params.p_interaction_id,
            company_id: params.p_company_id,
            raw_content: 'Raw phone 0912345678',
          }],
          error: null,
        };
      }
      if (fnName === 'record_outbound_interaction_atomic') {
        if ((mockDbClient as any).simulateOutboundError) {
          return { data: null, error: new Error('Postgres disk error on raw_contents insert (Database Rollback)') };
        }
        if (params.p_conversation_id === 'conv-cross-tenant') {
          return { data: null, error: { message: 'CONVERSATION_NOT_FOUND', code: 'P0002' } };
        }
        return {
          data: {
            interaction_id: 'int-rpc-outbound-1',
            conversation_id: params.p_conversation_id,
            customer_id: 'cust-1',
            channel: 'ZALO',
            delivery_id: 'del-rpc-outbound-1',
            delivery_status: 'PENDING_DISPATCH',
          },
          error: null,
        };
      }
      if (fnName === 'claim_pending_outbound_deliveries') {
        return {
          data: [
            {
              id: 'del-rpc-outbound-1',
              company_id: params.p_company_id,
              conversation_id: 'conv-1',
              interaction_id: 'int-rpc-outbound-1',
              channel: 'ZALO',
              delivery_status: 'QUEUED',
              retry_count: 0,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
          error: null,
        };
      }
      return { data: null, error: null };
    },
  };

  // 5a. getConversations in DB mode filters strictly by companyId
  const dbConvs = await InboxService.getConversations(companyA, undefined, undefined, mockDbClient);
  assert.strictEqual(dbConvs.length, 1);
  assert.strictEqual(dbConvs[0].company_id, companyA);
  console.log('✓ PASS 5a: getConversations queries DB with strict company_id filter');

  // 5b. getMessagesByConversationId for SALE: queries ONLY public.interactions, never queries private schema, zero audit log
  queriedPrivateSchema = false;
  mockDbCalls.length = 0;
  const dbMsgsSale = await InboxService.getMessagesByConversationId(companyA, 'conv-1', APPLICATION_ROLES.SALE, mockDbClient);
  assert.strictEqual(dbMsgsSale.length, 1);
  assert.strictEqual(dbMsgsSale[0].sanitized_content, 'Số đã làm sạch 09******78');
  assert.strictEqual(dbMsgsSale[0].raw_content, undefined, 'raw_content must be undefined for SALE in DB mode');
  assert.strictEqual(queriedPrivateSchema, false, 'SALE query must NEVER access private schema');
  assert(!mockDbCalls.some((c) => c.action === 'rpc' && c.fnName === 'get_interaction_raw_content'), 'SALE query must NEVER call get_interaction_raw_content RPC');
  assert(!mockDbCalls.some((c) => c.table === 'audit_logs'), 'SALE query must NEVER trigger audit log insert');
  console.log('✓ PASS 5b: getMessagesByConversationId for SALE queries only public.interactions without private schema and zero audit log');

  // 5c. getMessagesByConversationId for BOSS_ADMIN: calls canonical RPC get_interaction_raw_content and writes audit log
  queriedPrivateSchema = false;
  mockDbCalls.length = 0;
  const dbMsgsBoss = await InboxService.getMessagesByConversationId(companyA, 'conv-1', APPLICATION_ROLES.BOSS_ADMIN, mockDbClient, { userId: 'boss-user-id' });
  assert.strictEqual(dbMsgsBoss.length, 1);
  assert.strictEqual(dbMsgsBoss[0].raw_content, 'Raw phone 0912345678');
  assert.strictEqual(queriedPrivateSchema, false, 'BOSS_ADMIN query must NEVER directly access private schema');
  const rpcCall = mockDbCalls.find((c) => c.action === 'rpc' && c.fnName === 'get_interaction_raw_content');
  assert(rpcCall, 'BOSS_ADMIN query must call canonical RPC get_interaction_raw_content');
  assert.strictEqual(rpcCall.params.p_company_id, companyA);
  assert.strictEqual(rpcCall.params.p_interaction_id, 'int-1');
  const auditCall = mockDbCalls.find((c) => c.table === 'audit_logs');
  assert(auditCall, 'BOSS_ADMIN query must record audit log in public.audit_logs');
  const auditRecord = Array.isArray(auditCall.record) ? auditCall.record[0] : auditCall.record;
  assert.strictEqual(auditRecord.action, 'VIEW_RAW_INTERACTION');
  assert.strictEqual(auditRecord.resource_id, 'int-1');
  assert.strictEqual(auditRecord.company_id, companyA);
  console.log('✓ PASS 5c: getMessagesByConversationId for BOSS_ADMIN calls canonical RPC and successfully writes audit log with ZERO private schema access');

  // 5c-1. Fail-Closed: When audit log write fails, BOSS_ADMIN is BLOCKED (throws 500 AUDIT_WRITE_FAILED)
  mockDbClient.simulateAuditError = true;
  let auditWriteError: any = null;
  try {
    await InboxService.getMessagesByConversationId(companyA, 'conv-1', APPLICATION_ROLES.BOSS_ADMIN, mockDbClient, { userId: 'boss-user-id' });
  } catch (err: any) {
    auditWriteError = err;
  }
  assert(auditWriteError, 'Must throw when audit write fails');
  assert.strictEqual(auditWriteError.status, 500, 'Must throw 500 status on audit failure');
  assert.strictEqual(auditWriteError.code, 'AUDIT_WRITE_FAILED', 'Must throw AUDIT_WRITE_FAILED code');
  console.log('✓ PASS 5c-1: Service level Fail-Closed: Audit failure throws 500 AUDIT_WRITE_FAILED and blocks raw_content');

  // 5c-2. Route level Fail-Closed: GET /api/inbox returns 500 AUDIT_WRITE_FAILED when audit insert fails
  const reqBossAuditFail = new NextRequest('http://localhost:3000/api/inbox?conversation_id=conv-1', { method: 'GET' });
  const resBossAuditFail = await inboxGetHandler(reqBossAuditFail, {
    actor: userBossCompanyA,
    supabaseClient: mockDbClient,
  });
  assert.strictEqual(resBossAuditFail.status, 500, 'Route must return 500 on audit failure');
  const dataBossAuditFail = await resBossAuditFail.json();
  assert.strictEqual(dataBossAuditFail.success, false);
  assert.strictEqual(dataBossAuditFail.error, 'AUDIT_WRITE_FAILED');
  assert.strictEqual(dataBossAuditFail.data, undefined, 'Must NEVER return raw data on audit write failure');
  console.log('✓ PASS 5c-2: Route level Fail-Closed: GET /api/inbox returns 500 AUDIT_WRITE_FAILED without exposing raw content');

  // 5c-3. Route level Happy Path: GET /api/inbox for BOSS_ADMIN with successful audit log
  mockDbClient.simulateAuditError = false;
  mockDbCalls.length = 0;
  queriedPrivateSchema = false;
  const reqBossAuditSuccess = new NextRequest('http://localhost:3000/api/inbox?conversation_id=conv-1', { method: 'GET' });
  const resBossAuditSuccess = await inboxGetHandler(reqBossAuditSuccess, {
    actor: userBossCompanyA,
    supabaseClient: mockDbClient,
  });
  assert.strictEqual(resBossAuditSuccess.status, 200);
  const dataBossAuditSuccess = await resBossAuditSuccess.json();
  assert.strictEqual(dataBossAuditSuccess.success, true);
  assert.strictEqual(dataBossAuditSuccess.data.messages[0].raw_content, 'Raw phone 0912345678');
  assert.strictEqual(queriedPrivateSchema, false, 'Route level GET for BOSS_ADMIN must NEVER query private schema');
  assert(mockDbCalls.some((c) => c.action === 'rpc' && c.fnName === 'get_interaction_raw_content'), 'Must call RPC get_interaction_raw_content');
  assert(mockDbCalls.some((c) => c.table === 'audit_logs'), 'Must record audit log in route level GET for BOSS_ADMIN');
  console.log('✓ PASS 5c-3: Route level: BOSS_ADMIN accesses raw_content via canonical RPC with audit log recorded');

  // 5c-4. Route level SALE: GET /api/inbox for SALE receives zero raw_content and zero audit log
  mockDbCalls.length = 0;
  queriedPrivateSchema = false;
  const reqSaleRoute = new NextRequest('http://localhost:3000/api/inbox?conversation_id=conv-1', { method: 'GET' });
  const resSaleRoute = await inboxGetHandler(reqSaleRoute, {
    actor: userSaleCompanyA,
    supabaseClient: mockDbClient,
  });
  assert.strictEqual(resSaleRoute.status, 200);
  const dataSaleRoute = await resSaleRoute.json();
  assert.strictEqual(dataSaleRoute.success, true);
  assert.strictEqual(dataSaleRoute.data.messages[0].raw_content, undefined);
  assert.strictEqual(dataSaleRoute.data.messages[0].sanitized_content, 'Số đã làm sạch 09******78');
  assert.strictEqual(queriedPrivateSchema, false, 'SALE query must NEVER query private schema');
  assert(!mockDbCalls.some((c) => c.action === 'rpc' && c.fnName === 'get_interaction_raw_content'), 'SALE route request must NEVER call get_interaction_raw_content RPC');
  assert(!mockDbCalls.some((c) => c.table === 'audit_logs'), 'SALE route request must NEVER record audit log');
  console.log('✓ PASS 5c-4: Route level: SALE receives only sanitized_content with zero audit trail');

  // 5d. sendMessage in DB mode calls RPC record_outbound_interaction_atomic
  mockDbCalls.length = 0;
  const dbSentMsg = await InboxService.sendMessage(
    {
      conversation_id: 'conv-1',
      company_id: companyA,
      content: 'Tin nhắn gửi khách số 0912345678',
      sender_type: 'sale',
    },
    companyA,
    mockDbClient
  );
  assert.strictEqual(dbSentMsg.sanitized_content, 'Tin nhắn gửi khách số 09******78');
  assert.strictEqual(dbSentMsg.delivery_status, 'PENDING_DISPATCH', 'delivery_status must be PENDING_DISPATCH');
  assert.strictEqual(dbSentMsg.raw_content, undefined, 'raw_content must NOT be present in dbSentMsg DTO');
  assert(mockDbCalls.some((c) => c.action === 'rpc' && c.fnName === 'record_outbound_interaction_atomic'), 'Must call RPC record_outbound_interaction_atomic');
  console.log('✓ PASS 5d: sendMessage persists to conversations, interactions, and private.interaction_raw_contents via atomic RPC');

  // 5e. sendMessage Fail-Closed on RPC error (Raw content failure rolls back entire transaction)
  (mockDbClient as any).simulateOutboundError = true;
  await assert.rejects(
    async () => {
      await InboxService.sendMessage(
        {
          conversation_id: 'conv-1',
          company_id: companyA,
          content: 'Tin nhắn rollback test',
          sender_type: 'sale',
        },
        companyA,
        mockDbClient
      );
    },
    /Không thể gửi tin nhắn: Thao tác Atomic RPC thất bại \(Fail-Closed\)/,
    'Must fail closed when RPC fails'
  );
  (mockDbClient as any).simulateOutboundError = false;
  console.log('✓ PASS 5e: Outbound atomic persistence fails closed and rolls back on failure');

  // 5f. claimPendingDeliveries locks and claims outbox deliveries
  const claimedDeliveries = await InboxService.claimPendingDeliveries(
    companyA,
    'worker-test-1',
    10,
    mockDbClient
  );
  assert.strictEqual(claimedDeliveries.length, 1);
  assert.strictEqual(claimedDeliveries[0].delivery_status, 'QUEUED');
  assert.strictEqual(claimedDeliveries[0].company_id, companyA);
  assert(mockDbCalls.some((c) => c.action === 'rpc' && c.fnName === 'claim_pending_outbound_deliveries'), 'Must call RPC claim_pending_outbound_deliveries');
  console.log('✓ PASS 5f: claimPendingDeliveries locks and claims outbox deliveries for Outbox Worker');

  // Restore DEMO_MODE for downstream safety
  process.env.DEMO_MODE = 'true';

  console.log('\n======================================================================');
  console.log('ALL P0 INBOX TENANT ISOLATION TESTS PASSED SUCCESSFULLY! (100%)');
  console.log('======================================================================\n');
}

runInboxTenantIsolationTests().catch((err) => {
  console.error('TEST SUITE FAILED:', err);
  process.exit(1);
});
