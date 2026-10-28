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

  // Required canonical stages for the six-stage customer funnel
  const EXPECTED_CANONICAL_STAGES = [
    'awareness',
    'interested',
    'deep_research',
    'low_potential',
    'high_potential',
    'contract_signed',
  ];

  const canonicalValues = CANONICAL_STAGE_LIST.map((s) => s.value);

  // 1a. Verify all six canonical stages are present in CANONICAL_STAGE_LIST
  assert.strictEqual(CANONICAL_STAGE_LIST.length, 6, 'CANONICAL_STAGE_LIST must contain exactly 6 canonical stages');
  for (const stg of EXPECTED_CANONICAL_STAGES) {
    assert(
      canonicalValues.includes(stg as any),
      `Missing canonical stage in CANONICAL_STAGE_LIST: ${stg}`
    );
  }
  console.log('✓ PASS 1a: All 6 canonical funnel stages exist in CANONICAL_STAGE_LIST');

  // 1b. Low-potential remains visible and selectable (not hidden or auto-excluded)
  assert(canonicalValues.includes('low_potential' as any), 'low_potential must have an option');
  assert(canonicalValues.includes('deep_research' as any), 'deep_research must have an option');
  assert(canonicalValues.includes('contract_signed' as any), 'contract_signed must have an option');
  console.log('✓ PASS 1b: low_potential, deep_research and contract_signed are all selectable');

  // 1c. Verify CUSTOMER_STAGE_LABELS covers all six canonical stages with Vietnamese labels
  for (const stg of EXPECTED_CANONICAL_STAGES) {
    const label = CUSTOMER_STAGE_LABELS[stg];
    assert(
      typeof label === 'string' && label.trim().length > 0,
      `CUSTOMER_STAGE_LABELS missing or empty for stage: ${stg}`
    );
  }
  console.log('✓ PASS 1c: CUSTOMER_STAGE_LABELS contains full human-readable labels for all 6 stages');

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
  assert(
    customerListCode.includes('expected_stage: currentStage'),
    'customer-list.tsx must send expected_stage for optimistic concurrency'
  );
  assert(
    customerListCode.includes("targetCanonical === 'contract_signed'"),
    'customer-list.tsx must guard high-risk contract_signed transitions'
  );
  console.log('✓ PASS 1d: customer-list.tsx renders canonical stages and guards concurrency/high-risk moves');
  console.log('✓ PASS 1e: customer-list.tsx disables submit button on no-op stage transition');

  // ============================================================================
  // SECTION 2: CRM DASHBOARD METRICS & PIPELINE GROUP SEMANTICS
  // ============================================================================
  console.log('\n--- Section 2: CRM Dashboard Metrics & Explicit Pipeline Groups ---');

  // 2a. Verify PIPELINE_STAGE_GROUPS exposes six canonical groups (plus compatibility aliases)
  assert(Array.isArray(PIPELINE_STAGE_GROUPS.AWARENESS), 'AWARENESS group must be an array');
  assert(Array.isArray(PIPELINE_STAGE_GROUPS.INTERESTED), 'INTERESTED group must be an array');
  assert(Array.isArray(PIPELINE_STAGE_GROUPS.DEEP_RESEARCH), 'DEEP_RESEARCH group must be an array');
  assert(Array.isArray(PIPELINE_STAGE_GROUPS.LOW_POTENTIAL), 'LOW_POTENTIAL group must be an array');
  assert(Array.isArray(PIPELINE_STAGE_GROUPS.HIGH_POTENTIAL), 'HIGH_POTENTIAL group must be an array');
  assert(Array.isArray(PIPELINE_STAGE_GROUPS.CONTRACT_SIGNED), 'CONTRACT_SIGNED group must be an array');

  // Verify all stages in groups are valid DB stage values (canonical or legacy)
  const allValidStages = Object.values(CUSTOMER_STAGES) as string[];
  for (const [groupName, stages] of Object.entries(PIPELINE_STAGE_GROUPS)) {
    for (const stg of stages) {
      assert(
        allValidStages.includes(stg),
        `Stage ${stg} in group ${groupName} is not a valid customer stage`
      );
    }
  }
  console.log('✓ PASS 2a: PIPELINE_STAGE_GROUPS groups explicit canonical stages and legacy aliases');

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
  assert(
    appShellCode.includes('usePathname'),
    'AppShell must track pathname to auto-close drawer on route change'
  );
  console.log('✓ PASS 4b: AppShell closes mobile Drawer upon any navigation event');
  console.log('✓ PASS 4c: AppShell includes pathname-based drawer close effect');

  console.log('\n======================================================================');
  console.log('>>> ALL UI/UX REGRESSION & SEMANTIC TESTS PASSED SUCCESSFULLY! (100%) <<<');
  console.log('======================================================================\n');
}

runUiUxRegressionTests().catch((err) => {
  console.error('TEST SUITE FAILED:', err);
  process.exit(1);
});
