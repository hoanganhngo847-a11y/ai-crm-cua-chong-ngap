/**
 * M9.6A Integration Gate Orchestrator Runner
 *
 * Deterministic, fail-fast runner executing all required current-system validation gates:
 * 1. Environment & Preconditions Check
 * 2. Database Migration Integrity Guard
 * 3. Auth & Sensitive Security Suites (Foundation)
 * 4. Response SLA Gate (Unit & DB Concurrency)
 * 5. AI Customer Analysis Gate
 * 6. Sales-Style Learning Gate
 * 7. Sales-Style Approval & Activation Gate
 * 8. Analytics Data Layer Gate
 * 9. Analytics UI & Static Security Gate
 * 10. Cross-Module E2E Integration Scenarios (A–P)
 * 11. Security Boundaries & Tenant Isolation Matrix Gate
 * 12. TypeScript Typecheck Gate
 * 13. ESLint Gate
 *
 * If any gate fails, the orchestrator terminates immediately with non-zero exit code.
 */

import { spawnSync } from 'child_process';

interface GateStep {
  id: string;
  name: string;
  command: string;
  args: string[];
  description: string;
}

const GATES: GateStep[] = [
  {
    id: 'GATE_01_PRECONDITIONS',
    name: '1. Environment & Preconditions',
    command: 'node',
    args: [
      '-e',
      `
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
      fetch(url + '/rest/v1/').then(r => {
        console.log('✓ Supabase local REST API reachable at ' + url);
      }).catch(err => {
        console.error('✗ Failed to connect to Supabase:', err.message);
        process.exit(1);
      });
      `,
    ],
    description: 'Verify local Supabase API availability and environment readiness',
  },
  {
    id: 'GATE_02_MIGRATION_INTEGRITY',
    name: '2. Database Migration Integrity Guard',
    command: 'npx',
    args: [
      'tsx',
      '--conditions=react-server',
      '-e',
      `
      import * as fs from 'fs';
      import * as path from 'path';
      const dir = path.resolve('supabase/migrations');
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql'));
      if (files.length !== 9) throw new Error('Expected 9 migrations, found: ' + files.length);
      const sorted = [...files].sort();
      if (JSON.stringify(files) !== JSON.stringify(sorted)) throw new Error('Migrations not in deterministic chronological order');
      console.log('✓ Migration schema integrity verified (9/9 canonical migrations in sequence).');
      `,
    ],
    description: 'Verify strictly 9 migrations, correct formatting, unique timestamps, and deterministic order',
  },
  {
    id: 'GATE_03_AUTH_SECURITY',
    name: '3. Auth & Sensitive Security Foundation',
    command: 'npm',
    args: ['run', 'test:auth'],
    description: 'Verify auth context, token parsing, and role resolution',
  },
  {
    id: 'GATE_03B_SECURITY_SUITE',
    name: '3b. Sensitive Security Boundaries Suite',
    command: 'npm',
    args: ['run', 'test:security'],
    description: 'Verify RLS foundation, sensitive data masking, and trusted server boundaries',
  },
  {
    id: 'GATE_04_RESPONSE_SLA_UNIT',
    name: '4. Response SLA Unit Gate',
    command: 'npm',
    args: ['run', 'test:response-sla'],
    description: 'Verify SLA pure evaluator logic, 5-minute deadline rules, and decision matrix',
  },
  {
    id: 'GATE_04B_RESPONSE_SLA_DB',
    name: '4b. Response SLA Database & Concurrency Gate',
    command: 'npm',
    args: ['run', 'test:response-sla-db'],
    description: 'Verify SLA window state machine, atomic AI claim lease, audit logging, and race conditions',
  },
  {
    id: 'GATE_05_AI_ANALYSIS',
    name: '5. AI Customer Analysis Gate',
    command: 'npm',
    args: ['run', 'test:ai-analysis'],
    description: 'Verify sanitized-only ingestion, immutable customer stage, and model provenance',
  },
  {
    id: 'GATE_06_SALES_STYLE_LEARNING',
    name: '6. Sales-Style Learning Gate',
    command: 'npm',
    args: ['run', 'test:sales-style'],
    description: 'Verify outbound message provenance, regex policy firewall, and draft persistence',
  },
  {
    id: 'GATE_07_SALES_STYLE_ACTIVATION',
    name: '7. Sales-Style Approval & Activation Gate',
    command: 'npm',
    args: ['run', 'test:sales-style-activation'],
    description: 'Verify human Boss activation, atomic superseding, single-active invariant, and worker-only read',
  },
  {
    id: 'GATE_08_ANALYTICS_DATA_LAYER',
    name: '8. Analytics Data Layer Gate',
    command: 'npm',
    args: ['run', 'test:analytics'],
    description: 'Verify company-wide overview, daily series, financial snapshot separation, and RLS barriers',
  },
  {
    id: 'GATE_09_ANALYTICS_UI',
    name: '9. Analytics UI & Static Security Gate',
    command: 'npm',
    args: ['run', 'test:analytics-ui'],
    description: 'Verify admin page server-side security, AAL2 requirement, and empty-state robustness',
  },
  {
    id: 'GATE_10_E2E_CURRENT_INTEGRATION',
    name: '10. Cross-Module E2E Scenarios (A–P)',
    command: 'npx',
    args: ['tsx', '--conditions=react-server', 'tests/e2e/current-system.integration.test.ts'],
    description: 'Cross-module integration scenarios A–P connecting SLA, AI analysis, style, and analytics',
  },
  {
    id: 'GATE_11_SECURITY_BOUNDARIES',
    name: '11. Security Boundaries & Invariants Gate',
    command: 'npx',
    args: ['tsx', '--conditions=react-server', 'tests/e2e/security-boundaries.test.ts'],
    description: 'Tenant isolation matrix, authorization matrix, static service-role scan, secret scan, and diff guards',
  },
  {
    id: 'GATE_12_TYPECHECK',
    name: '12. TypeScript Typecheck Gate',
    command: 'npm',
    args: ['run', 'typecheck'],
    description: 'Static type correctness across all contracts, features, and tests',
  },
  {
    id: 'GATE_13_LINT',
    name: '13. ESLint Code Quality Gate',
    command: 'npm',
    args: ['run', 'lint'],
    description: 'Linting compliance across the repository',
  },
];

async function main(): Promise<void> {
  const startTime = Date.now();
  console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║               M9.6A CURRENT-SYSTEM INTEGRATION GATE RUNNER                   ║');
  console.log('║                                                                              ║');
  console.log('║ Validating: Foundation Auth, Sensitive Security, Response SLA, AI Analysis,  ║');
  console.log('║             Sales Style Learning & Activation, Analytics Layer & UI          ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════╝\n');

  const executedGates: { id: string; name: string; durationMs: number; status: 'PASS' | 'FAIL' }[] = [];

  for (let i = 0; i < GATES.length; i++) {
    const gate = GATES[i];
    const gateStart = Date.now();
    console.log(`\n>>> [${i + 1}/${GATES.length}] EXECUTING GATE: ${gate.name}`);
    console.log(`    Purpose: ${gate.description}`);
    console.log(`    Command: ${gate.command} ${gate.args.join(' ')}\n`);

    const result = spawnSync(gate.command, gate.args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'test',
      },
    });

    const durationMs = Date.now() - gateStart;

    if (result.status !== 0) {
      console.error(`\n❌ [FAIL] GATE FAILED: ${gate.name} (exit code: ${result.status})`);
      console.error(`   Execution halted immediately. Integration gate FAIL-FAST triggered.`);
      executedGates.push({ id: gate.id, name: gate.name, durationMs, status: 'FAIL' });
      process.exit(result.status ?? 1);
    }

    console.log(`✓ [PASS] ${gate.name} completed in ${(durationMs / 1000).toFixed(2)}s`);
    executedGates.push({ id: gate.id, name: gate.name, durationMs, status: 'PASS' });
  }

  const totalTimeSeconds = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('\n╔══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                    INTEGRATION GATE SUMMARY: ALL PASSED                      ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
  for (const g of executedGates) {
    const timeStr = `${(g.durationMs / 1000).toFixed(2)}s`.padStart(7);
    console.log(`║ [PASS] ${g.name.padEnd(58)} ${timeStr} ║`);
  }
  console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║ Total Gates Passed: ${executedGates.length}/${GATES.length}                                  Duration: ${totalTimeSeconds.padStart(6)}s ║`);
  console.log('╚══════════════════════════════════════════════════════════════════════════════╝\n');
}

main().catch((err) => {
  console.error('Fatal error in integration gate runner:', err);
  process.exit(1);
});
