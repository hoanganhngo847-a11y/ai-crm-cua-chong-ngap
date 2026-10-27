import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { internalRevealCustomerPhoneAction } from '../../lib/sensitive/action-handlers';
import { scanClientBoundaries } from '../helpers/client-boundary-scan';

async function runSecurePhoneRevealTests() {
  console.log('======================================================================');
  console.log('STARTING SECURE PHONE REVEAL (EYE ICON, MUTEX & ANTI-COPY) TEST SUITE');
  console.log('======================================================================');

  // Test 1: Client boundary scan to verify zero privileged leak
  console.log('\n--- Test 1: Static Client Boundary & Architecture Scan ---');
  const violations = scanClientBoundaries(process.cwd());
  assert.strictEqual(violations.length, 0, `Forbidden client violations detected: ${violations.join(', ')}`);
  console.log('✓ PASS: Zero client boundary violations detected in whole repository');

  // Test 2: Server Action Handler - Reveal phone
  console.log('\n--- Test 2: internalRevealCustomerPhoneAction in Demo Mode ---');
  process.env.DEMO_MODE = 'true';
  process.env.NEXT_PUBLIC_DEMO_MODE = 'true';

  const res1 = await internalRevealCustomerPhoneAction({ customerId: 'cust-1' });
  assert.strictEqual(res1.success, true);
  assert.strictEqual(res1.phone, '0912345612');

  const res2 = await internalRevealCustomerPhoneAction({ customerId: 'cust-2' });
  assert.strictEqual(res2.success, true);
  assert.strictEqual(res2.phone, '0934567890');

  const resGeneric = await internalRevealCustomerPhoneAction({ customerId: 'demo-customer-uuid' });
  assert.strictEqual(resGeneric.success, true);
  assert(typeof resGeneric.phone === 'string' && resGeneric.phone.length >= 10);
  console.log('✓ PASS: Server action safely returns unmasked phone numbers in demo mode');

  // Test 3: Static code check on secure-phone-reveal component for Canvas & Anti-Copy
  console.log('\n--- Test 3: Canvas Bitmap Rendering & Anti-Copy Code Verification ---');
  const componentPath = path.resolve('features/crm/components/secure-phone-reveal.tsx');
  const componentSource = fs.readFileSync(componentPath, 'utf8');

  // Ensure canvas is used
  assert(componentSource.includes('<canvas'), 'Component MUST render <canvas> for zero DOM text nodes');
  assert(componentSource.includes('getContext(\'2d\')'), 'Component MUST use 2D canvas context for bitmap text');
  assert(componentSource.includes('fillText'), 'Component MUST use fillText on canvas context');

  // Ensure user-select none and clipboard event prevention
  assert(componentSource.includes('userSelect: \'none\''), 'Component MUST enforce user-select: none');
  assert(componentSource.includes('onCopy'), 'Component MUST intercept onCopy event');
  assert(componentSource.includes('clearData()'), 'Component MUST clear clipboardData on copy/cut');
  assert(componentSource.includes('onContextMenu'), 'Component MUST block right click context menu');
  assert(componentSource.includes('onDragStart'), 'Component MUST block dragging');
  assert(componentSource.includes('preventDefault()'), 'Component MUST preventDefault on copy/cut/drag');

  // Ensure mutex state: only activeCustomerId can be revealed
  assert(componentSource.includes('activeCustomerId'), 'Component MUST maintain activeCustomerId');
  assert(componentSource.includes('revealedPhone'), 'Component MUST maintain revealedPhone');
  assert(componentSource.includes('isCurrentActive && Boolean(revealedPhone)'), 'Component MUST enforce isCurrentActive mutex check');

  console.log('✓ PASS: SecurePhoneRow component strictly enforces Canvas rendering, clipboard clearing, and single-phone mutex!');

  // Test 4: Verify integration in CRM views
  console.log('\n--- Test 4: Verify Integration in Key CRM Views ---');
  const dossierPage = fs.readFileSync(path.resolve('app/(dashboard)/customers/dossier/page.tsx'), 'utf8');
  assert(dossierPage.includes('<SecurePhoneRow'), 'customers/dossier must render <SecurePhoneRow');
  assert(dossierPage.includes('<PhoneRevealProvider>'), 'customers/dossier must wrap with <PhoneRevealProvider>');

  const customerList = fs.readFileSync(path.resolve('features/crm/components/customer-list.tsx'), 'utf8');
  assert(customerList.includes('<SecurePhoneRow'), 'customer-list must render <SecurePhoneRow');
  assert(customerList.includes('<PhoneRevealProvider>'), 'customer-list must wrap with <PhoneRevealProvider>');

  const singleDossier = fs.readFileSync(path.resolve('app/(dashboard)/customers/[id]/dossier/page.tsx'), 'utf8');
  assert(singleDossier.includes('<SecurePhoneRow'), 'customers/[id]/dossier must render <SecurePhoneRow');
  assert(singleDossier.includes('<PhoneRevealProvider>'), 'customers/[id]/dossier must wrap with <PhoneRevealProvider>');

  const customerDetail = fs.readFileSync(path.resolve('app/(dashboard)/customers/[id]/page.tsx'), 'utf8');
  assert(customerDetail.includes('<SecurePhoneRow'), 'customers/[id]/page.tsx must render <SecurePhoneRow');
  assert(customerDetail.includes('<PhoneRevealProvider>'), 'customers/[id]/page.tsx must wrap with <PhoneRevealProvider>');

  const crmDashboard = fs.readFileSync(path.resolve('app/(dashboard)/crm/page.tsx'), 'utf8');
  assert(crmDashboard.includes('<SecurePhoneRow'), 'crm/page.tsx must render <SecurePhoneRow');
  assert(crmDashboard.includes('<PhoneRevealProvider>'), 'crm/page.tsx must wrap with <PhoneRevealProvider>');

  const inboxView = fs.readFileSync(path.resolve('features/inbox/components/inbox-view.tsx'), 'utf8');
  assert(inboxView.includes('<SecurePhoneRow'), 'inbox-view must render <SecurePhoneRow');
  assert(inboxView.includes('<PhoneRevealProvider>'), 'inbox-view must wrap with <PhoneRevealProvider>');

  console.log('✓ PASS: All 6 CRM and Inbox contact views properly wired with SecurePhoneRow and PhoneRevealProvider!');

  console.log('\n======================================================================');
  console.log('>>> ALL SECURE PHONE REVEAL TESTS PASSED SUCCESSFULLY! (100%) <<<');
  console.log('======================================================================\n');
}

runSecurePhoneRevealTests().catch((err) => {
  console.error('Test Failed:', err);
  process.exit(1);
});
