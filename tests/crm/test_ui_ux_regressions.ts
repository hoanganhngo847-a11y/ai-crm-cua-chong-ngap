import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  CUSTOMER_STAGES,
  CUSTOMER_STAGE_LABELS,
  CANONICAL_STAGE_LIST,
  PIPELINE_STAGE_GROUPS,
  toCanonicalStage,
} from '../../features/crm/types/customer.types';

async function runUiUxRegressionTests() {
  console.log('======================================================================');
  console.log('STARTING UI/UX REGRESSION TEST SUITE: 4 KEY FIXES & SEMANTICS AUDIT');
  console.log('======================================================================\n');

  // ============================================================================
  // SECTION 1: CUSTOMER STAGE MODAL & CANONICAL STAGES COVERAGE
  // ============================================================================
  console.log('--- Section 1: Customer Stage Modal & Canonical Stages Coverage ---');

  // Required canonical stages from database check constraint
  const EXPECTED_CANONICAL_STAGES = [
    'LEAD_NEW',
    'CONTACT_CYCLE_1',
    'CONTACT_CYCLE_2',
    'CONTACT_CYCLE_3',
    'UNREACHABLE',
    'SURVEY_REQUESTED',
    'SURVEY_SCHEDULED',
    'SURVEY_COMPLETED',
    'PRICE_CALCULATED',
    'NEED_INFO',
    'PRICE_OFFERED',
    'NEGOTIATING',
    'ORDER_CREATED',
    'DEPOSIT_CONFIRMED',
    'CONTRACT_SIGNED',
    'IN_PRODUCTION',
    'READY_FOR_INSTALL',
    'INSTALLING',
    'HANDOVER_COMPLETED',
    'WARRANTY_ACTIVE',
    'LOST',
    'CARE_NURTURING',
  ];

  const canonicalValues = CANONICAL_STAGE_LIST.map((s) => s.value);

  // 1a. Verify all expected canonical stages are present in CANONICAL_STAGE_LIST
  for (const stg of EXPECTED_CANONICAL_STAGES) {
    assert(
      canonicalValues.includes(stg as any),
      `Missing canonical stage in CANONICAL_STAGE_LIST: ${stg}`
    );
  }
  console.log('✓ PASS 1a: All 22 DB canonical stages exist in CANONICAL_STAGE_LIST');

  // 1b. Specifically verify the 4 previously-missing stages
  assert(canonicalValues.includes('PRICE_CALCULATED' as any), 'PRICE_CALCULATED must have an option');
  assert(canonicalValues.includes('NEED_INFO' as any), 'NEED_INFO must have an option');
  assert(canonicalValues.includes('WARRANTY_ACTIVE' as any), 'WARRANTY_ACTIVE must have an option');
  assert(canonicalValues.includes('CARE_NURTURING' as any), 'CARE_NURTURING must have an option');
  console.log('✓ PASS 1b: PRICE_CALCULATED, NEED_INFO, WARRANTY_ACTIVE, CARE_NURTURING all present');

  // 1c. Verify CUSTOMER_STAGE_LABELS covers all canonical stages with meaningful Vietnamese labels
  for (const stg of EXPECTED_CANONICAL_STAGES) {
    const label = CUSTOMER_STAGE_LABELS[stg];
    assert(
      typeof label === 'string' && label.trim().length > 0,
      `CUSTOMER_STAGE_LABELS missing or empty for stage: ${stg}`
    );
  }
  console.log('✓ PASS 1c: CUSTOMER_STAGE_LABELS contains full human-readable labels for all stages');

  // 1d. Statically inspect features/crm/components/customer-list.tsx
  const customerListPath = path.resolve(
    process.cwd(),
    'features/crm/components/customer-list.tsx'
  );
  const customerListCode = fs.readFileSync(customerListPath, 'utf-8');

  assert(
    customerListCode.includes('CANONICAL_STAGE_LIST.map'),
    'customer-list.tsx must map over CANONICAL_STAGE_LIST for stage select options'
  );
  assert(
    customerListCode.includes('CUSTOMER_STAGE_LABELS'),
    'customer-list.tsx must use CUSTOMER_STAGE_LABELS for display labels'
  );
  console.log('✓ PASS 1d: customer-list.tsx dynamically renders complete canonical stage options');

  // ============================================================================
  // SECTION 2: CRM DASHBOARD METRICS & PIPELINE GROUP SEMANTICS
  // ============================================================================
  console.log('\n--- Section 2: CRM Dashboard Metrics & Explicit Pipeline Groups ---');

  // 2a. Verify PIPELINE_STAGE_GROUPS contains explicit canonical groups
  assert(Array.isArray(PIPELINE_STAGE_GROUPS.NEW_LEADS), 'NEW_LEADS group must be an array');
  assert(Array.isArray(PIPELINE_STAGE_GROUPS.SURVEY), 'SURVEY group must be an array');
  assert(Array.isArray(PIPELINE_STAGE_GROUPS.PRICING), 'PRICING group must be an array');
  assert(Array.isArray(PIPELINE_STAGE_GROUPS.WON), 'WON group must be an array');

  // Verify all stages in groups are valid canonical stages
  for (const [groupName, stages] of Object.entries(PIPELINE_STAGE_GROUPS)) {
    for (const stg of stages) {
      assert(
        EXPECTED_CANONICAL_STAGES.includes(stg),
        `Stage ${stg} in group ${groupName} is not a valid canonical stage`
      );
    }
  }
  console.log('✓ PASS 2a: PIPELINE_STAGE_GROUPS groups explicit canonical stages');

  // 2b. Statically inspect app/(dashboard)/crm/page.tsx
  const crmPagePath = path.resolve(process.cwd(), 'app/(dashboard)/crm/page.tsx');
  const crmPageCode = fs.readFileSync(crmPagePath, 'utf-8');

  // Verify NO subtraction formula
  assert(
    !crmPageCode.includes('totalCustomers - newLeadsCount'),
    'crm/page.tsx must NOT contain the faulty pipeline subtraction formula'
  );
  assert(
    !crmPageCode.includes('wonOrdersCount'),
    'crm/page.tsx must NOT use wonOrdersCount for pipeline calculation'
  );

  // Verify "Tổng đơn hàng" metric label
  assert(
    crmPageCode.includes('label="Tổng đơn hàng"'),
    'crm/page.tsx must explicitly label order metric as "Tổng đơn hàng"'
  );

  // Verify fail-closed handling (value "—" and "Không tải được")
  assert(
    crmPageCode.includes("Không tải được"),
    'crm/page.tsx must render "Không tải được" when a query fails instead of fake 0'
  );
  assert(
    crmPageCode.includes("parseCountResult"),
    'crm/page.tsx must use fail-closed result parser'
  );
  console.log('✓ PASS 2b: crm/page.tsx strictly enforces fail-closed data states & explicit stage queries');

  // ============================================================================
  // SECTION 3: COMMAND PALETTE ACCESSIBILITY & FOCUS TRAP
  // ============================================================================
  console.log('\n--- Section 3: Command Palette Accessibility & Focus Trap ---');

  const commandPalettePath = path.resolve(
    process.cwd(),
    'components/ui/command-palette.tsx'
  );
  const commandPaletteCode = fs.readFileSync(commandPalettePath, 'utf-8');

  // 3a. Accessibility ARIA attributes
  assert(commandPaletteCode.includes('role="dialog"'), 'Must have role="dialog"');
  assert(commandPaletteCode.includes('aria-modal="true"'), 'Must have aria-modal="true"');
  assert(commandPaletteCode.includes('role="combobox"'), 'Must have role="combobox" on search input');
  assert(commandPaletteCode.includes('role="listbox"'), 'Must have role="listbox" on results container');
  assert(commandPaletteCode.includes('role="option"'), 'Must have role="option" on command items');
  console.log('✓ PASS 3a: Command palette has complete ARIA dialog, combobox, and listbox markup');

  // 3b. Focus Trap & Scroll Lock
  assert(
    commandPaletteCode.includes("e.key === 'Tab'"),
    'Command palette must handle Tab key for focus trapping'
  );
  assert(
    commandPaletteCode.includes('e.shiftKey'),
    'Command palette must handle Shift+Tab for backward focus cycle'
  );
  assert(
    commandPaletteCode.includes("document.body.style.overflow = 'hidden'"),
    'Command palette must lock body scroll on open'
  );
  assert(
    commandPaletteCode.includes("previousFocus.current?.focus?.()"),
    'Command palette must restore previous focus on close'
  );
  assert(
    commandPaletteCode.includes("e.key === 'Escape'"),
    'Command palette must close on Escape key'
  );
  console.log('✓ PASS 3b: Tab/Shift+Tab focus trap, scroll lock, Escape, and focus restore verified');

  // 3c. Safe Keyboard Bounds
  assert(
    commandPaletteCode.includes('if (filteredCommands.length === 0)'),
    'Command palette must guard against empty list when handling Arrow/Enter keys'
  );
  console.log('✓ PASS 3c: Empty filtered list bounds guarded against out-of-index errors');

  // ============================================================================
  // SECTION 4: MOBILE SIDEBAR DRAWER NAVIGATION & AUTO-CLOSE
  // ============================================================================
  console.log('\n--- Section 4: Mobile Sidebar Drawer Navigation & Auto-Close ---');

  const sidebarPath = path.resolve(process.cwd(), 'components/app-shell/sidebar.tsx');
  const sidebarCode = fs.readFileSync(sidebarPath, 'utf-8');

  const appShellPath = path.resolve(process.cwd(), 'components/app-shell/app-shell.tsx');
  const appShellCode = fs.readFileSync(appShellPath, 'utf-8');

  // 4a. SidebarProps onNavigate optional callback
  assert(
    sidebarCode.includes('onNavigate?: () => void'),
    'SidebarProps must declare optional onNavigate callback'
  );

  // 4b. All navigation links invoke onNavigate
  assert(
    sidebarCode.includes('<Link href="/crm" onClick={onNavigate}'),
    'Workspace logo/home link must trigger onNavigate'
  );
  assert(
    sidebarCode.includes('onClick={onNavigate}'),
    'Sidebar navigation links must trigger onNavigate'
  );
  assert(
    sidebarCode.includes('<Link\n          href="/account"\n          onClick={onNavigate}'),
    'Account footer link must trigger onNavigate'
  );
  console.log('✓ PASS 4a: Sidebar links (nav items, home logo, account footer) wired with onNavigate');

  // 4c. AppShell passes drawer close callback to mobile Sidebar
  assert(
    appShellCode.includes('onNavigate={() => setIsMobileMenuOpen(false)}'),
    'AppShell must pass drawer close callback to mobile Sidebar instance'
  );
  console.log('✓ PASS 4b: AppShell closes mobile Drawer upon any navigation event');

  console.log('\n======================================================================');
  console.log('>>> ALL UI/UX REGRESSION & SEMANTIC TESTS PASSED SUCCESSFULLY! (100%) <<<');
  console.log('======================================================================\n');
}

runUiUxRegressionTests().catch((err) => {
  console.error('TEST SUITE FAILED:', err);
  process.exit(1);
});
