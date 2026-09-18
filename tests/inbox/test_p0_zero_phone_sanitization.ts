import assert from 'node:assert';
import { NextRequest } from 'next/server';
import { InboxService } from '../../features/inbox/services/inbox.service';
import { sanitizePhoneInText } from '../../features/crm/utils/phone-sanitizer';
import { GET as inboxGetHandler } from '../../app/api/inbox/route';
import { APPLICATION_ROLES } from '../../shared/constants/roles';
import type { ActorContext } from '../../shared/contracts/auth';
import type { Conversation, InboxMessage } from '../../features/inbox/types/inbox.types';

async function runZeroPhoneSanitizationTests() {
  console.log('======================================================================');
  console.log('STARTING P0 TEST SUITE: ZERO-PHONE SANITIZATION IN MESSAGES & TIMELINE');
  console.log('======================================================================');

  // ============================================================================
  // SECTION 1: UNIT TEST FOR sanitizePhoneInText
  // ============================================================================
  console.log('\n--- Section 1: Unit Test sanitizePhoneInText ---');

  // 1a. Standard 10-digit Vietnamese phone
  const text1 = 'Alo số tôi 0912345678 nhé shop';
  const sanitized1 = sanitizePhoneInText(text1);
  assert.strictEqual(sanitized1, 'Alo số tôi 09******78 nhé shop');
  assert(!sanitized1.includes('0912345678'), 'Raw phone must not appear');
  console.log('✓ PASS 1a: Standard 10-digit phone in text masked to 09******78');

  // 1b. International E.164 (+84) phone in text
  const text2 = 'Liên hệ lại cho tôi theo số +84934567890';
  const sanitized2 = sanitizePhoneInText(text2);
  assert.strictEqual(sanitized2, 'Liên hệ lại cho tôi theo số 09******90');
  assert(!sanitized2.includes('0934567890'), 'Raw phone must not appear');
  assert(!sanitized2.includes('+84'), '+84 prefix must be masked cleanly');
  console.log('✓ PASS 1b: International +84 phone in text masked to 09******90');

  // 1c. 84 prefix without plus
  const text3 = 'Khách báo số 84987654321';
  const sanitized3 = sanitizePhoneInText(text3);
  assert.strictEqual(sanitized3, 'Khách báo số 09******21');
  console.log('✓ PASS 1c: 84 prefix phone in text masked to 09******21');

  // 1d. Phone with dots and hyphens
  const text4 = 'Gọi số 0912.345.678 hoặc 0988-123-456';
  const sanitized4 = sanitizePhoneInText(text4);
  assert.strictEqual(sanitized4, 'Gọi số 09******78 hoặc 09******56');
  console.log('✓ PASS 1d: Formatted phone numbers with dots/hyphens masked');

  // 1e. Non-phone text preserved
  const text5 = 'Báo giá kích thước 2.5m x 0.6m giá 9500000 đ';
  const sanitized5 = sanitizePhoneInText(text5);
  assert.strictEqual(sanitized5, text5, 'Technical measurements and prices must not be corrupted');
  console.log('✓ PASS 1e: Non-phone numbers, prices, and measurements preserved intact');

  // ============================================================================
  // SECTION 2: SERVICE LAYER (getMessagesByConversationId)
  // ============================================================================
  console.log('\n--- Section 2: InboxService.getMessagesByConversationId Sanitization ---');

  const testCompanyId = '00000000-0000-0000-0000-000000000001';
  const testConvId = 'conv-test-sanitize';
  const rawSensitiveMessage = 'Alo số tôi 0912345678, liên hệ gấp';

  const testConv: Conversation = {
    id: testConvId,
    company_id: testCompanyId,
    customer_id: 'cust-sanitize-1',
    customer_name: 'Anh Nam Test',
    customer_code: 'KH-TEST-001',
    customer_phone: '0912345678',
    channel: 'facebook',
    last_message: rawSensitiveMessage,
    last_message_at: '2026-09-18T12:00:00Z',
    unread_count: 1,
    status: 'OPEN',
    updated_at: '2026-09-18T12:00:00Z',
    created_at: '2026-09-18T11:00:00Z',
  };

  const testMsgs: Record<string, InboxMessage[]> = {
    [testConvId]: [
      {
        id: 'msg-sens-1',
        company_id: testCompanyId,
        conversation_id: testConvId,
        customer_id: 'cust-sanitize-1',
        channel: 'facebook',
        sender_type: 'customer',
        sender_name: 'Anh Nam Test',
        content: rawSensitiveMessage,
        created_at: '2026-09-18T12:00:00Z',
        direction: 'inbound',
      },
    ],
  };

  InboxService.resetInboxStore([testConv], testMsgs);

  // 2a. Caller is SALE: message content is sanitized
  const msgsForSale = await InboxService.getMessagesByConversationId(
    testCompanyId,
    testConvId,
    APPLICATION_ROLES.SALE
  );
  assert.strictEqual(msgsForSale.length, 1);
  assert.strictEqual(msgsForSale[0].content, 'Alo số tôi 09******78, liên hệ gấp');
  const jsonSale = JSON.stringify(msgsForSale);
  assert(!jsonSale.includes('0912345678'), 'Raw phone 0912345678 must not appear anywhere in SALE payload');
  console.log('✓ PASS 2a: getMessagesByConversationId sanitizes content to 09******78 for SALE');

  // 2b. Caller is BOSS_ADMIN: message content retains original raw text
  const msgsForBoss = await InboxService.getMessagesByConversationId(
    testCompanyId,
    testConvId,
    APPLICATION_ROLES.BOSS_ADMIN
  );
  assert.strictEqual(msgsForBoss.length, 1);
  assert.strictEqual(msgsForBoss[0].content, rawSensitiveMessage);
  assert(msgsForBoss[0].content.includes('0912345678'), 'BOSS_ADMIN receives verbatim content');
  console.log('✓ PASS 2b: getMessagesByConversationId preserves verbatim content for BOSS_ADMIN');

  // ============================================================================
  // SECTION 3: SERVICE LAYER (getCustomerTimeline)
  // ============================================================================
  console.log('\n--- Section 3: InboxService.getCustomerTimeline Sanitization ---');

  // 3a. Caller is SALE: timeline event descriptions and titles are sanitized
  const timelineForSale = await InboxService.getCustomerTimeline(
    'cust-sanitize-1',
    testCompanyId,
    APPLICATION_ROLES.SALE
  );
  assert(timelineForSale.length > 0, 'Timeline must return events');
  const messageEventForSale = timelineForSale.find((e) => e.id === 'msg-sens-1');
  assert(messageEventForSale, 'Message event must be present in timeline');
  assert.strictEqual(messageEventForSale.description, 'Alo số tôi 09******78, liên hệ gấp');
  const timelineJsonSale = JSON.stringify(timelineForSale);
  assert(!timelineJsonSale.includes('0912345678'), 'Raw phone must never appear in SALE timeline JSON');
  console.log('✓ PASS 3a: getCustomerTimeline sanitizes descriptions for SALE');

  // 3b. Caller is BOSS_ADMIN: timeline retains raw phone
  const timelineForBoss = await InboxService.getCustomerTimeline(
    'cust-sanitize-1',
    testCompanyId,
    APPLICATION_ROLES.BOSS_ADMIN
  );
  const messageEventForBoss = timelineForBoss.find((e) => e.id === 'msg-sens-1');
  assert(messageEventForBoss, 'Message event must be present');
  assert.strictEqual(messageEventForBoss.description, rawSensitiveMessage);
  console.log('✓ PASS 3b: getCustomerTimeline preserves raw phone in descriptions for BOSS_ADMIN');

  // ============================================================================
  // SECTION 4: SERVICE LAYER (getConversations & getConversationById)
  // ============================================================================
  console.log('\n--- Section 4: InboxService.getConversations & getConversationById Sanitization ---');

  // 4a. getConversations for SALE: last_message & customer_phone sanitized
  const convsForSale = await InboxService.getConversations(
    testCompanyId,
    undefined,
    APPLICATION_ROLES.SALE
  );
  assert.strictEqual(convsForSale[0].last_message, 'Alo số tôi 09******78, liên hệ gấp');
  assert.strictEqual(convsForSale[0].customer_phone, '09******78');
  assert(!JSON.stringify(convsForSale).includes('0912345678'));
  console.log('✓ PASS 4a: getConversations masks last_message & customer_phone for SALE');

  // 4b. getConversationById for SALE: last_message & customer_phone sanitized
  const convDetailForSale = await InboxService.getConversationById(
    testCompanyId,
    testConvId,
    APPLICATION_ROLES.SALE
  );
  assert(convDetailForSale);
  assert.strictEqual(convDetailForSale.last_message, 'Alo số tôi 09******78, liên hệ gấp');
  assert.strictEqual(convDetailForSale.customer_phone, '09******78');
  console.log('✓ PASS 4b: getConversationById masks last_message & customer_phone for SALE');

  // 4c. getConversationById for BOSS_ADMIN: keeps unmasked last_message & phone
  const convDetailForBoss = await InboxService.getConversationById(
    testCompanyId,
    testConvId,
    APPLICATION_ROLES.BOSS_ADMIN
  );
  assert(convDetailForBoss);
  assert.strictEqual(convDetailForBoss.last_message, rawSensitiveMessage);
  assert.strictEqual(convDetailForBoss.customer_phone, '0912345678');
  console.log('✓ PASS 4c: getConversationById preserves raw data for BOSS_ADMIN');

  // ============================================================================
  // SECTION 5: API ROUTE GET /api/inbox END-TO-END SANITIZATION
  // ============================================================================
  console.log('\n--- Section 5: GET /api/inbox Route End-to-End Sanitization ---');

  const actorSale: ActorContext = {
    userId: 'user-sale-test',
    companyId: testCompanyId,
    memberId: 'mem-sale-test',
    role: APPLICATION_ROLES.SALE,
    fullName: 'Sale Test User',
    email: 'sale@test.vn',
    profileStatus: 'ACTIVE',
    membershipStatus: 'ACTIVE',
    aal: 'aal1',
    isMfaEnrolled: false,
  };

  const actorBoss: ActorContext = {
    userId: 'user-boss-test',
    companyId: testCompanyId,
    memberId: 'mem-boss-test',
    role: APPLICATION_ROLES.BOSS_ADMIN,
    fullName: 'Boss Admin User',
    email: 'boss@test.vn',
    profileStatus: 'ACTIVE',
    membershipStatus: 'ACTIVE',
    aal: 'aal1',
    isMfaEnrolled: false,
  };

  // 5a. SALE calls GET /api/inbox?conversation_id=...
  const reqSale = new NextRequest(
    `http://localhost:3000/api/inbox?conversation_id=${testConvId}`,
    { method: 'GET' }
  );
  const resSale = await inboxGetHandler(reqSale, { actor: actorSale });
  assert.strictEqual(resSale.status, 200);
  const dataSale = await resSale.json();
  const rawPayloadSale = JSON.stringify(dataSale);

  assert.strictEqual(dataSale.data.messages[0].content, 'Alo số tôi 09******78, liên hệ gấp');
  assert.strictEqual(dataSale.data.conversation.last_message, 'Alo số tôi 09******78, liên hệ gấp');
  assert.strictEqual(dataSale.data.conversation.customer_phone, '09******78');
  assert(
    !rawPayloadSale.includes('0912345678'),
    'CRITICAL: Raw phone string 0912345678 must NOT appear anywhere in the SALE HTTP response!'
  );
  console.log('✓ PASS 5a: GET /api/inbox returns fully sanitized response for SALE (Zero-Phone in JSON & state)');

  // 5b. BOSS_ADMIN calls GET /api/inbox?conversation_id=...
  const reqBoss = new NextRequest(
    `http://localhost:3000/api/inbox?conversation_id=${testConvId}`,
    { method: 'GET' }
  );
  const resBoss = await inboxGetHandler(reqBoss, { actor: actorBoss });
  assert.strictEqual(resBoss.status, 200);
  const dataBoss = await resBoss.json();

  assert.strictEqual(dataBoss.data.messages[0].content, rawSensitiveMessage);
  assert.strictEqual(dataBoss.data.conversation.last_message, rawSensitiveMessage);
  assert.strictEqual(dataBoss.data.conversation.customer_phone, '0912345678');
  console.log('✓ PASS 5b: GET /api/inbox returns verbatim raw messages for BOSS_ADMIN');

  console.log('\n======================================================================');
  console.log('ALL P0 ZERO-PHONE IN-MESSAGE SANITIZATION TESTS PASSED! (100%)');
  console.log('======================================================================\n');
}

runZeroPhoneSanitizationTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
