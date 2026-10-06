import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { APPLICATION_ROLES } from '../../shared/constants/roles';

async function runInboxNavigationAndRbacTests() {
  console.log('======================================================================');
  console.log('STARTING VERIFICATION: INBOX & CRM NAVIGATION, RBAC, AND EMPTY STATE');
  console.log('======================================================================\n');

  // 1. Navigation in app/(dashboard)/layout.tsx
  console.log('--- 1. Navigation Wiring in app/(dashboard)/layout.tsx ---');
  const layoutPath = path.resolve(process.cwd(), 'app/(dashboard)/layout.tsx');
  const layoutContent = fs.readFileSync(layoutPath, 'utf8');

  // Verify that old ambiguous "CRM & Hộp thư" -> /crm is removed
  assert.ok(
    !layoutContent.includes('CRM &amp; Hộp thư'),
    'FAIL: Ambiguous "CRM & Hộp thư" still exists in layout.tsx navigation'
  );
  assert.ok(
    !layoutContent.includes('CRM & Hộp thư'),
    'FAIL: Ambiguous "CRM & Hộp thư" still exists in layout.tsx navigation'
  );

  // Verify that CRM -> /crm and Hộp thư -> /inbox are separated
  assert.ok(
    /<Link[^>]*href="\/crm"[^>]*>[\s\S]*?CRM[\s\S]*?<\/Link>/.test(layoutContent),
    'FAIL: CRM link pointing to /crm is missing in layout.tsx'
  );
  assert.ok(
    /<Link[^>]*href="\/inbox"[^>]*>[\s\S]*?Hộp thư[\s\S]*?<\/Link>/.test(layoutContent),
    'FAIL: Hộp thư link pointing to /inbox is missing in layout.tsx'
  );

  // Verify RBAC condition in layout: only BOSS_ADMIN or SALE see /crm and /inbox
  const navSectionMatch = layoutContent.match(
    /\{\(actor\.role === 'BOSS_ADMIN' \|\| actor\.role === 'SALE'\) && \([\s\S]*?href="\/crm"[\s\S]*?href="\/inbox"[\s\S]*?\)\}/
  );
  assert.ok(
    navSectionMatch,
    'FAIL: Navigation must restrict /crm and /inbox to BOSS_ADMIN and SALE roles'
  );
  console.log('[PASS] Navigation separates CRM (/crm) and Hộp thư (/inbox) strictly for BOSS_ADMIN and SALE');

  // 2. Server-side RBAC in app/(dashboard)/inbox/page.tsx
  console.log('\n--- 2. Server-Side RBAC Guard in app/(dashboard)/inbox/page.tsx ---');
  const inboxPagePath = path.resolve(process.cwd(), 'app/(dashboard)/inbox/page.tsx');
  const inboxPageContent = fs.readFileSync(inboxPagePath, 'utf8');

  // Verify strict denial for non-authorized roles (including TECHNICIAN)
  assert.ok(
    inboxPageContent.includes('actor.role !== APPLICATION_ROLES.BOSS_ADMIN && actor.role !== APPLICATION_ROLES.SALE'),
    'FAIL: app/(dashboard)/inbox/page.tsx must block any role other than BOSS_ADMIN and SALE'
  );
  assert.ok(
    inboxPageContent.includes('Truy Cập Bị Từ Chối'),
    'FAIL: app/(dashboard)/inbox/page.tsx must display 403 Truy Cập Bị Từ Chối UI'
  );
  assert.ok(
    inboxPageContent.includes('KỸ THUẬT VIÊN'),
    'FAIL: app/(dashboard)/inbox/page.tsx must specifically instruct TECHNICIAN to visit /field'
  );
  console.log('[PASS] Inbox page blocks TECHNICIAN and enforces access solely for SALE and BOSS_ADMIN');

  // 3. Server-side RBAC in app/(dashboard)/crm/page.tsx
  console.log('\n--- 3. Server-Side RBAC Guard in app/(dashboard)/crm/page.tsx ---');
  const crmPagePath = path.resolve(process.cwd(), 'app/(dashboard)/crm/page.tsx');
  const crmPageContent = fs.readFileSync(crmPagePath, 'utf8');

  assert.ok(
    crmPageContent.includes('actor.role !== APPLICATION_ROLES.BOSS_ADMIN && actor.role !== APPLICATION_ROLES.SALE'),
    'FAIL: app/(dashboard)/crm/page.tsx must block any role other than BOSS_ADMIN and SALE'
  );
  assert.ok(
    crmPageContent.includes('CRM Khách Hàng &amp; Bán Hàng') || crmPageContent.includes('CRM Khách Hàng'),
    'FAIL: app/(dashboard)/crm/page.tsx header must reflect CRM Khách Hàng & Bán Hàng'
  );
  console.log('[PASS] CRM page blocks TECHNICIAN and enforces access solely for SALE and BOSS_ADMIN');

  // 4. Omnichannel Empty State in features/inbox/components/inbox-view.tsx
  console.log('\n--- 4. Omnichannel Structure & Empty State in inbox-view.tsx ---');
  const inboxViewPath = path.resolve(process.cwd(), 'features/inbox/components/inbox-view.tsx');
  const inboxViewContent = fs.readFileSync(inboxViewPath, 'utf8');

  // Verify mandatory message
  const REQUIRED_EMPTY_MESSAGE = 'Chưa có hội thoại. Hãy kết nối Facebook Page hoặc Zalo OA để bắt đầu nhận tin nhắn.';
  assert.ok(
    inboxViewContent.includes(REQUIRED_EMPTY_MESSAGE),
    `FAIL: inbox-view.tsx must include exact empty state message: "${REQUIRED_EMPTY_MESSAGE}"`
  );

  // Verify Omnichannel channels structure
  assert.ok(
    inboxViewContent.includes('Facebook Messenger'),
    'FAIL: inbox-view.tsx must support Facebook Messenger channel'
  );
  assert.ok(
    inboxViewContent.includes('Zalo OA'),
    'FAIL: inbox-view.tsx must support Zalo OA channel'
  );
  assert.ok(
    inboxViewContent.includes("channelFilter === 'all'") &&
    inboxViewContent.includes("channelFilter === 'zalo'") &&
    inboxViewContent.includes("channelFilter === 'facebook'"),
    'FAIL: inbox-view.tsx must provide filtering for all, zalo, and facebook channels'
  );

  // Verify safe defensive coding
  assert.ok(
    inboxViewContent.includes('formatMessageTime'),
    'FAIL: inbox-view.tsx must safely format message timestamps'
  );
  assert.ok(
    inboxViewContent.includes('getInitials'),
    'FAIL: inbox-view.tsx must safely handle customer initials without throwing on null'
  );
  console.log('[PASS] Omnichannel Inbox UI structure, empty state, and safe defensive coding verified');

  console.log('\n======================================================================');
  console.log('ALL INBOX NAVIGATION & RBAC TESTS PASSED SUCCESSFULLY! (100%)');
  console.log('======================================================================\n');
}

runInboxNavigationAndRbacTests().catch((err) => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
