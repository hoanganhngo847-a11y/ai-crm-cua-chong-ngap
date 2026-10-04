/**
 * P2-001 Test Fixture Isolation & Repeatability Regression Gate
 *
 * Verifies that real-database test suites run safely and repeatedly on the SAME
 * local Supabase database instance WITHOUT requiring `supabase db reset`.
 *
 * Specifically verifies:
 * 1. Historical conversations_pkey collision prevention (tests/inbox/database.test.ts run consecutively)
 * 2. Cross-suite fixture isolation (AI analysis worker vs Analytics)
 * 3. Response SLA window fixture idempotency (tests/response-sla/response-sla-db.test.ts run consecutively)
 * 4. Sales style runtime context fixture isolation (tests/sales-style/runtime-style-context.test.ts run consecutively)
 */

import { spawnSync } from 'child_process';

interface Step {
  id: string;
  name: string;
  command: string;
  args: string[];
}

const STEPS: Step[] = [
  // --- Stage 1: Historical conversations_pkey Collision Regression (tests/inbox/database.test.ts) ---
  {
    id: 'INBOX_DB_RUN_1',
    name: 'Inbox DB Fixtures — Iteration 1',
    command: 'npx',
    args: ['tsx', '--conditions=react-server', 'tests/inbox/database.test.ts'],
  },
  {
    id: 'INBOX_DB_RUN_2',
    name: 'Inbox DB Fixtures — Iteration 2 (Same DB without reset, verifying conversations_pkey isolation)',
    command: 'npx',
    args: ['tsx', '--conditions=react-server', 'tests/inbox/database.test.ts'],
  },

  // --- Stage 2: Cross-Suite Namespace Isolation (AI Worker + Analytics) ---
  {
    id: 'AI_WORKER_RUN_1',
    name: 'AI Analysis Worker — Iteration 1',
    command: 'npx',
    args: ['tsx', '--conditions=react-server', 'tests/ai-analysis/analysis-worker.test.ts'],
  },
  {
    id: 'ANALYTICS_RUN_1',
    name: 'Analytics DB Fixtures — Iteration 1',
    command: 'npx',
    args: ['tsx', '--conditions=react-server', 'tests/analytics/analytics.test.ts'],
  },
  {
    id: 'AI_WORKER_RUN_2',
    name: 'AI Analysis Worker — Iteration 2 (Verifying no cross-suite collision with Analytics)',
    command: 'npx',
    args: ['tsx', '--conditions=react-server', 'tests/ai-analysis/analysis-worker.test.ts'],
  },
  {
    id: 'ANALYTICS_RUN_2',
    name: 'Analytics DB Fixtures — Iteration 2 (Verifying repeatability on dirty DB)',
    command: 'npx',
    args: ['tsx', '--conditions=react-server', 'tests/analytics/analytics.test.ts'],
  },

  // --- Stage 3: Response SLA DB Repeatability ---
  {
    id: 'RESPONSE_SLA_DB_RUN_1',
    name: 'Response SLA DB — Iteration 1',
    command: 'npx',
    args: ['tsx', '--conditions=react-server', 'tests/response-sla/response-sla-db.test.ts'],
  },
  {
    id: 'RESPONSE_SLA_DB_RUN_2',
    name: 'Response SLA DB — Iteration 2 (Verifying window idempotency and non-HAN fixture isolation)',
    command: 'npx',
    args: ['tsx', '--conditions=react-server', 'tests/response-sla/response-sla-db.test.ts'],
  },

  // --- Stage 4: Sales Style Runtime Context Repeatability ---
  {
    id: 'SALES_STYLE_RUNTIME_RUN_1',
    name: 'Sales Style Runtime Context — Iteration 1',
    command: 'npx',
    args: ['tsx', '--conditions=react-server', 'tests/sales-style/runtime-style-context.test.ts'],
  },
  {
    id: 'SALES_STYLE_RUNTIME_RUN_2',
    name: 'Sales Style Runtime Context — Iteration 2 (Verifying no cross-suite collision with Facebook SLA)',
    command: 'npx',
    args: ['tsx', '--conditions=react-server', 'tests/sales-style/runtime-style-context.test.ts'],
  },
];

async function main() {
  console.log('================================================================');
  console.log('P2-001 FIXTURE ISOLATION & REPEATABILITY REGRESSION GATE');
  console.log('Verifying consecutive runs on the same local DB without reset');
  console.log('================================================================\n');

  let passed = 0;
  for (const step of STEPS) {
    console.log(`\n>>> [EXEC] ${step.name}`);
    const start = Date.now();
    const result = spawnSync(step.command, step.args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'test',
      },
    });

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    if (result.status !== 0) {
      console.error(`\n❌ [FAIL] ${step.name} failed with exit code ${result.status} (${duration}s)`);
      process.exit(result.status || 1);
    }

    console.log(`✓ [PASS] ${step.name} (${duration}s)`);
    passed++;
  }

  console.log('\n================================================================');
  console.log(`FIXTURE REPEATABILITY GATE PASSED: ${passed}/${STEPS.length} STEPS OK`);
  console.log('All real-DB suites executed repeatedly without primary-key collisions,');
  console.log('unique constraint violations, or cross-suite fixture contamination.');
  console.log('================================================================\n');
}

main().catch((err) => {
  console.error('Fatal regression gate runner error:', err);
  process.exit(1);
});
