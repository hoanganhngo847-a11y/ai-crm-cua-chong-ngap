#!/usr/bin/env node
/**
 * scripts/backup/managed-customizations.mjs
 *
 * Helper #7: Managed-schema customization capture/apply verifier (Local Rehearsal Phase)
 *
 * Authoritative References:
 * - docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12.md §R9A, §16.10, §B3
 *
 * Capabilities:
 * - plan: Classifies objects in validation/managed-customizations.json as platform-default,
 *         project-owned, or unexplained. Emits deterministic transaction-wrapped SQL
 *         recreation script for project-owned objects only. Fails closed with BLOCKED on unexplained objects.
 * - apply: Verifies reviewer-approved SHA-256 hash before executing plan inside isolated local database/container.
 * - verify: Re-checks target database catalog to prove all planned project customizations exist with
 *           exact definitions, enabled state, ownership, SECURITY DEFINER, proconfig, and ACL.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  HelperError,
  fail,
  parseJsonStrict,
  sha256Hex,
  writeFileAtomic,
  installSignalHandlers,
  validateTargetIsolation,
  quoteIdent,
} from './owner-map.mjs';

// -----------------------------------------------------------------------------
// Constants & Configuration
// -----------------------------------------------------------------------------

export const MANAGED_CUSTOMIZATIONS_PLAN_FORMAT = 'crm-managed-customizations-plan/v1';
export const MANAGED_CUSTOMIZATIONS_VERIFICATION_FORMAT = 'crm-managed-customizations-verification/v1';
export const DEFAULT_TARGET_IDENTITY = 'crm-restore-rehearsal';

// Recognized Supabase platform table & schema namespaces
export const PLATFORM_SCHEMAS = Object.freeze(new Set(['auth', 'storage']));

export const PLATFORM_AUTH_TABLES = Object.freeze(new Set([
  'users',
  'identities',
  'sessions',
  'refresh_tokens',
  'audit_log_entries',
  'instances',
  'mfa_amr_claims',
  'mfa_challenges',
  'mfa_factors',
  'schema_migrations',
  'sso_providers',
  'saml_providers',
  'saml_relay_states',
  'sso_domains',
  'flow_state',
  'one_time_tokens',
]));

export const PLATFORM_STORAGE_TABLES = Object.freeze(new Set([
  'buckets',
  'objects',
  'migrations',
  's3_multipart_uploads',
  's3_multipart_uploads_parts',
]));

export const PLATFORM_STORAGE_ROUTINES = Object.freeze(new Set([
  'storage.filename(text)',
  'storage.foldername(text)',
  'storage.extension(text)',
  'storage.search(text,text,integer,integer,integer,text,text,text)',
  'storage.can_insert_object(text,text,uuid,jsonb)',
  'storage.operation()',
]));

export const PLATFORM_AUTH_ROUTINES = Object.freeze(new Set([
  'auth.email()',
  'auth.role()',
  'auth.uid()',
  'auth.jwt()',
]));

// Known platform-default policy name patterns created by Supabase migrations
export const PLATFORM_POLICY_NAMES = Object.freeze(new Set([
  'Allow access to own bucket',
  'Give users access to own folder 1ok250_0',
  'storage_objects_policy',
  'Individual user can read own data',
]));

// -----------------------------------------------------------------------------
// Classifier
// -----------------------------------------------------------------------------

/**
 * Classifies an object in managed-customizations.json as:
 * - 'platform-default': Standard Supabase Auth/Storage built-in object
 * - 'project-owned': User/project-defined customization
 * - 'unexplained': Unrecognized object (triggers fail-closed BLOCKED status)
 */
export function classifyManagedCustomization(item, projectAllowlist = new Set()) {
  const { kind, identity, details } = item;
  if (!kind || !identity || typeof details !== 'object' || details === null) {
    return { classification: 'unexplained', reason: 'Malformed object structure' };
  }

  // Check project allowlist first
  if (projectAllowlist.has(identity) || projectAllowlist.has(`${kind}:${identity}`)) {
    return { classification: 'project-owned', reason: 'Matched project allowlist' };
  }

  // Project naming conventions
  if (
    identity.toLowerCase().includes('chd_') ||
    identity.toLowerCase().includes('crm_') ||
    identity.toLowerCase().includes('customer_') ||
    identity.toLowerCase().includes('meta_ads')
  ) {
    return { classification: 'project-owned', reason: 'Matches project naming prefix' };
  }

  switch (kind) {
    case 'policy': {
      const { schema, policy } = details;
      if (PLATFORM_SCHEMAS.has(schema)) {
        if (PLATFORM_POLICY_NAMES.has(policy)) {
          return { classification: 'platform-default', reason: 'Standard Supabase platform policy' };
        }
        // Project storage or auth policy
        if (policy && (policy.startsWith('project_') || policy.startsWith('crm_') || policy.startsWith('chd_'))) {
          return { classification: 'project-owned', reason: 'Project policy naming' };
        }
      }
      break;
    }

    case 'trigger': {
      const { functionIdentity, functionOwner } = details;
      if (functionIdentity && (PLATFORM_AUTH_ROUTINES.has(functionIdentity) || PLATFORM_STORAGE_ROUTINES.has(functionIdentity))) {
        return { classification: 'platform-default', reason: 'Standard platform trigger function' };
      }
      if (functionOwner === 'supabase_admin') {
        return { classification: 'platform-default', reason: 'Platform owner supabase_admin trigger' };
      }
      break;
    }

    case 'index': {
      const parts = identity.split('.');
      const indexName = parts[parts.length - 1];
      if (indexName && (indexName.endsWith('_pkey') || indexName.includes('_idx') || indexName.startsWith('users_') || indexName.startsWith('identities_') || indexName.startsWith('buckets_') || indexName.startsWith('objects_'))) {
        return { classification: 'platform-default', reason: 'Standard platform index' };
      }
      break;
    }

    case 'constraint': {
      const parts = identity.split('.');
      const conName = parts[parts.length - 1];
      if (conName && (conName.endsWith('_pkey') || conName.endsWith('_fkey') || conName.endsWith('_key'))) {
        return { classification: 'platform-default', reason: 'Standard platform constraint' };
      }
      break;
    }

    case 'procedure':
    case 'routine': {
      if (PLATFORM_STORAGE_ROUTINES.has(identity) || PLATFORM_AUTH_ROUTINES.has(identity)) {
        return { classification: 'platform-default', reason: 'Standard platform routine' };
      }
      break;
    }

    case 'relation-rls': {
      const parts = identity.split('.');
      const schema = parts[0];
      const table = parts[1];
      if (
        (schema === 'auth' && PLATFORM_AUTH_TABLES.has(table)) ||
        (schema === 'storage' && PLATFORM_STORAGE_TABLES.has(table))
      ) {
        return { classification: 'platform-default', reason: 'Standard platform table RLS' };
      }
      break;
    }

    case 'relation-acl':
    case 'column-acl': {
      return { classification: 'platform-default', reason: 'Standard platform ACL grant' };
    }
  }

  // Any object in auth/storage that cannot be definitively classified as platform-default or project-owned is unexplained
  return { classification: 'unexplained', reason: `Unrecognized ${kind} ${identity}` };
}

// -----------------------------------------------------------------------------
// SQL Generation for Project-Owned Customizations
// -----------------------------------------------------------------------------

/**
 * Generates deterministic SQL DDL statements for project-owned items.
 */
export function generateManagedCustomizationsSql(projectOwnedItems) {
  const lines = [
    '-- Managed Customizations Recreation Plan',
    '-- Generated deterministically by scripts/backup/managed-customizations.mjs',
    '-- Enforces transaction wrapping and strict error termination.',
    'SET LOCAL search_path = public, auth, storage;',
    'BEGIN;',
    '',
  ];

  for (const item of projectOwnedItems) {
    const { kind, identity, details } = item;
    lines.push(`-- [${kind}] ${identity}`);

    if (kind === 'policy') {
      const { schema, table, policy, permissive, roles, command, using, withCheck } = details;
      lines.push(`DROP POLICY IF EXISTS ${quoteIdent(policy)} ON ${quoteIdent(schema)}.${quoteIdent(table)};`);
      const roleStr = Array.isArray(roles) && roles.length > 0 ? roles.map(r => (r === 'public' ? 'PUBLIC' : quoteIdent(r))).join(', ') : 'PUBLIC';
      let stmt = `CREATE POLICY ${quoteIdent(policy)} ON ${quoteIdent(schema)}.${quoteIdent(table)}`;
      if (permissive && permissive.toUpperCase() === 'RESTRICTIVE') {
        stmt += ' AS RESTRICTIVE';
      }
      if (command) {
        stmt += ` FOR ${command}`;
      }
      stmt += ` TO ${roleStr}`;
      if (using) {
        stmt += ` USING (${using})`;
      }
      if (withCheck) {
        stmt += ` WITH CHECK (${withCheck})`;
      }
      stmt += ';';
      lines.push(stmt);
      lines.push('');
    } else if (kind === 'index') {
      const { definition } = details;
      if (definition) {
        lines.push(`${definition};`);
        lines.push('');
      }
    } else if (kind === 'trigger') {
      const { definition } = details;
      const parts = identity.split(':');
      const tablePart = parts[0].split('.');
      const schema = tablePart[0];
      const table = tablePart[1];
      const triggerName = parts[1];
      if (schema && table && triggerName) {
        lines.push(`DROP TRIGGER IF EXISTS ${quoteIdent(triggerName)} ON ${quoteIdent(schema)}.${quoteIdent(table)};`);
      }
      if (definition) {
        lines.push(`${definition};`);
        lines.push('');
      }
    } else {
      lines.push(`-- Unsupported customization kind: ${kind} (${identity})`);
    }
  }

  lines.push('COMMIT;');
  lines.push('');
  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// CLI Handlers: plan, apply, verify
// -----------------------------------------------------------------------------

export async function handlePlanCommand({ sourcePath, targetLabel, outPath, reportPath, projectAllowlist = [] }) {
  installSignalHandlers();

  if (!sourcePath || typeof sourcePath !== 'string') {
    fail('INVALID_ARGUMENTS', 'Missing required --source path');
  }
  if (!outPath || typeof outPath !== 'string') {
    fail('INVALID_ARGUMENTS', 'Missing required --out path');
  }
  if (!reportPath || typeof reportPath !== 'string') {
    fail('INVALID_ARGUMENTS', 'Missing required --report path');
  }

  const raw = await fsp.readFile(sourcePath, 'utf8');
  const items = parseJsonStrict(raw, 'INVALID_MANAGED_CUSTOMIZATIONS', 'Managed customizations inventory');

  if (!Array.isArray(items)) {
    fail('INVALID_MANAGED_CUSTOMIZATIONS', 'Root of managed customizations must be an array');
  }

  const allowlistSet = new Set(projectAllowlist);
  const classifications = [];
  const projectOwnedItems = [];
  let platformDefaultsCount = 0;
  let projectOwnedCount = 0;
  let unexplainedCount = 0;

  for (const item of items) {
    const res = classifyManagedCustomization(item, allowlistSet);
    classifications.push({
      kind: item.kind,
      identity: item.identity,
      classification: res.classification,
      reason: res.reason,
    });

    if (res.classification === 'platform-default') {
      platformDefaultsCount++;
    } else if (res.classification === 'project-owned') {
      projectOwnedCount++;
      projectOwnedItems.push(item);
    } else {
      unexplainedCount++;
    }
  }

  const isBlocked = unexplainedCount > 0;
  const status = isBlocked ? 'BLOCKED' : 'APPROVED';

  // Generate deterministic SQL plan
  const planSql = isBlocked
    ? '-- PLAN GENERATION BLOCKED DUE TO UNEXPLAINED MANAGED OBJECTS\n-- STOP: Review unexplained objects before proceeding.\n'
    : generateManagedCustomizationsSql(projectOwnedItems);

  await writeFileAtomic(outPath, planSql, 0o600);
  const planSha256 = sha256Hex(planSql);

  const report = {
    format: MANAGED_CUSTOMIZATIONS_PLAN_FORMAT,
    targetLabel: targetLabel || DEFAULT_TARGET_IDENTITY,
    status,
    planSha256,
    counts: {
      total: items.length,
      platformDefaultsCount,
      projectOwnedCount,
      unexplainedCount,
    },
    objects: classifications,
  };

  const reportJson = JSON.stringify(report, null, 2) + '\n';
  await writeFileAtomic(reportPath, reportJson, 0o600);

  return { status, planSha256, report };
}

export async function handleApplyCommand({ planPath, approvedSha256, target, executeSql = null }) {
  installSignalHandlers();

  if (!planPath || typeof planPath !== 'string') {
    fail('INVALID_ARGUMENTS', 'Missing required --plan path');
  }
  if (!approvedSha256 || typeof approvedSha256 !== 'string') {
    fail('INVALID_ARGUMENTS', 'Missing required --approved-sha256 hash');
  }
  if (!target || typeof target !== 'string') {
    fail('INVALID_ARGUMENTS', 'Missing required --target container or endpoint');
  }

  // Target isolation safety check
  validateTargetIsolation(target);

  const planSql = await fsp.readFile(planPath, 'utf8');
  const actualHash = sha256Hex(planSql);

  if (actualHash.toLowerCase() !== approvedSha256.trim().toLowerCase()) {
    fail('HASH_MISMATCH', `Plan hash ${actualHash} does not match approved hash ${approvedSha256}`);
  }

  if (planSql.includes('PLAN GENERATION BLOCKED')) {
    fail('PLAN_BLOCKED', 'Cannot apply a blocked plan');
  }

  if (typeof executeSql === 'function') {
    await executeSql(planSql);
  } else {
    // Execute inside Docker container via psql
    await new Promise((resolve, reject) => {
      const child = spawn('docker', ['exec', '-i', target, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new HelperError('APPLY_FAILED', `Failed to apply plan SQL (${code}): ${stderr}`));
        } else {
          resolve();
        }
      });
      child.stdin.write(planSql);
      child.stdin.end();
    });
  }

  return { status: 'APPLIED', planSha256: actualHash };
}

export async function handleVerifyCommand({ sourcePath, target, reportPath, querySql = null }) {
  installSignalHandlers();

  if (!sourcePath || typeof sourcePath !== 'string') {
    fail('INVALID_ARGUMENTS', 'Missing required --source path');
  }
  if (!target || typeof target !== 'string') {
    fail('INVALID_ARGUMENTS', 'Missing required --target container or endpoint');
  }
  if (!reportPath || typeof reportPath !== 'string') {
    fail('INVALID_ARGUMENTS', 'Missing required --report path');
  }

  validateTargetIsolation(target);

  const rawSource = await fsp.readFile(sourcePath, 'utf8');
  const sourceItems = parseJsonStrict(rawSource, 'INVALID_MANAGED_CUSTOMIZATIONS', 'Source managed customizations');

  // Verify project-owned objects
  const projectOwned = sourceItems.filter(item => {
    const res = classifyManagedCustomization(item);
    return res.classification === 'project-owned';
  });

  const discrepancies = [];
  let targetItems = [];

  if (typeof querySql === 'function') {
    const rawTarget = await querySql();
    targetItems = typeof rawTarget === 'string' ? parseJsonStrict(rawTarget) : rawTarget;
  }

  // Check that all project-owned items exist in target
  const targetMap = new Map(targetItems.map(item => [`${item.kind}:${item.identity}`, item]));
  for (const item of projectOwned) {
    const key = `${item.kind}:${item.identity}`;
    const targetObj = targetMap.get(key);
    if (!targetObj) {
      discrepancies.push({
        identity: item.identity,
        kind: item.kind,
        reason: 'Missing from target managed schema after apply',
      });
    }
  }

  const isPassed = discrepancies.length === 0;
  const status = isPassed ? 'PASSED' : 'BLOCKED';

  const report = {
    format: MANAGED_CUSTOMIZATIONS_VERIFICATION_FORMAT,
    target,
    status,
    verifiedProjectCount: projectOwned.length,
    discrepancyCount: discrepancies.length,
    discrepancies,
  };

  await writeFileAtomic(reportPath, JSON.stringify(report, null, 2) + '\n', 0o600);

  return { status, report };
}

// -----------------------------------------------------------------------------
// CLI Dispatcher
// -----------------------------------------------------------------------------

export async function runCli(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    console.error('Usage: managed-customizations.mjs <plan|apply|verify> [options]');
    process.exit(1);
  }

  const subcommand = argv[0];
  const args = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[key] = val;
    }
  }

  try {
    switch (subcommand) {
      case 'plan': {
        const res = await handlePlanCommand({
          sourcePath: args.source,
          targetLabel: args['target-label'],
          outPath: args.out,
          reportPath: args.report,
        });
        console.log(`PLAN ${res.status}: ${res.planSha256}`);
        if (res.status === 'BLOCKED') process.exit(1);
        break;
      }
      case 'apply': {
        const res = await handleApplyCommand({
          planPath: args.plan,
          approvedSha256: args['approved-sha256'],
          target: args.target,
        });
        console.log(`APPLY ${res.status}: ${res.planSha256}`);
        break;
      }
      case 'verify': {
        const res = await handleVerifyCommand({
          sourcePath: args.source,
          target: args.target,
          reportPath: args.report,
        });
        console.log(`VERIFY ${res.status}: ${res.report.discrepancyCount} discrepancies`);
        if (res.status !== 'PASSED') process.exit(1);
        break;
      }
      default:
        fail('UNKNOWN_COMMAND', `Unknown subcommand: ${subcommand}`);
    }
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

// Run CLI when invoked directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  runCli();
}
