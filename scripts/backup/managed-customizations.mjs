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
 *         recreation script for supported project-owned objects (policy, index, trigger, routine).
 *         Fails closed with BLOCKED if any unexplained OR unsupported customization exists.
 * - apply: Verifies reviewer-approved SHA-256 hash before executing plan inside isolated local database/container.
 * - verify: Re-checks target database catalog (via live query or target inventory) to prove all
 *           planned project customizations exist with exact definitions, enabled state, ownership,
 *           SECURITY DEFINER, proconfig, and ACL.
 */

import fsp from 'node:fs/promises';
import fs from 'node:fs';
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

// Supported kinds for safe deterministic SQL recreation
export const SUPPORTED_RECREATION_KINDS = Object.freeze(new Set([
  'policy',
  'index',
  'trigger',
  'routine',
  'procedure',
]));

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

// Approved standard Supabase platform roles for ACL verification
export const APPROVED_PLATFORM_ROLES = Object.freeze(new Set([
  'postgres',
  'supabase_admin',
  'supabase_auth_admin',
  'supabase_storage_admin',
  'authenticator',
  'anon',
  'authenticated',
  'service_role',
  'dashboard_user',
  'pg_monitor',
  'pg_read_all_settings',
  'pg_read_all_stats',
  'pg_stat_scan_tables',
  'PUBLIC',
]));

// Known platform-default policy name patterns created by Supabase migrations
export const PLATFORM_POLICY_NAMES = Object.freeze(new Set([
  'Allow access to own bucket',
  'Give users access to own folder 1ok250_0',
  'storage_objects_policy',
  'Individual user can read own data',
]));

// Verbatim B3 extraction query for live target verification
export const MANAGED_CUSTOMIZATIONS_QUERY_SQL = `
WITH items AS (
  SELECT 'policy'::text AS kind,
         format('%I.%I:%s', schemaname, tablename, policyname) AS identity,
         jsonb_build_object(
           'schema', schemaname, 'table', tablename, 'policy', policyname,
           'permissive', permissive, 'roles', to_jsonb(roles), 'command', cmd,
           'using', qual, 'withCheck', with_check
         ) AS details
  FROM pg_policies
  WHERE schemaname IN ('auth', 'storage')
  UNION ALL
  SELECT 'trigger', format('%I.%I:%I', n.nspname, c.relname, t.tgname),
         jsonb_build_object(
           'definition', pg_get_triggerdef(t.oid, true),
           'enabled', t.tgenabled,
           'functionIdentity', p.oid::regprocedure::text,
           'functionDefinition', pg_get_functiondef(p.oid),
           'functionOwner', pg_get_userbyid(p.proowner),
           'securityDefiner', p.prosecdef,
           'functionConfig', p.proconfig,
           'functionAcl', p.proacl::text
         )
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE NOT t.tgisinternal AND n.nspname IN ('auth', 'storage')
  UNION ALL
  SELECT 'index', format('%I.%I:%I', n.nspname, c.relname, idx.relname),
         jsonb_build_object(
           'definition', pg_get_indexdef(i.indexrelid),
           'valid', i.indisvalid, 'ready', i.indisready, 'live', i.indislive,
           'unique', i.indisunique, 'primary', i.indisprimary
         )
  FROM pg_index i
  JOIN pg_class idx ON idx.oid = i.indexrelid
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('auth', 'storage')
  UNION ALL
  SELECT 'constraint', format('%I.%I:%I', n.nspname, c.relname, con.conname),
         jsonb_build_object(
           'definition', pg_get_constraintdef(con.oid, true),
           'validated', con.convalidated, 'deferrable', con.condeferrable,
           'initiallyDeferred', con.condeferred
         )
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('auth', 'storage')
  UNION ALL
  SELECT CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'routine' END,
         format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)),
         jsonb_build_object(
           'definition', pg_get_functiondef(p.oid),
           'owner', pg_get_userbyid(p.proowner), 'securityDefiner', p.prosecdef,
           'config', p.proconfig, 'acl', p.proacl::text,
           'language', l.lanname, 'comment', obj_description(p.oid, 'pg_proc')
         )
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname IN ('auth', 'storage') AND p.prokind IN ('f', 'p')
  UNION ALL
  SELECT 'relation-rls', format('%I.%I', n.nspname, c.relname),
         jsonb_build_object(
           'rlsEnabled', c.relrowsecurity,
           'rlsForced', c.relforcerowsecurity,
           'owner', pg_get_userbyid(c.relowner),
           'comment', obj_description(c.oid, 'pg_class')
         )
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('auth', 'storage') AND c.relkind IN ('r', 'p', 'v', 'm')
  UNION ALL
  SELECT 'relation-acl', format('%I.%I', n.nspname, c.relname),
         jsonb_build_object(
           'aclIsNull', c.relacl IS NULL,
           'aclRaw', c.relacl::text,
           'entries', coalesce((
             SELECT jsonb_agg(jsonb_build_object(
               'grantee', CASE x.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
               'grantor', pg_get_userbyid(x.grantor),
               'privilegeType', x.privilege_type,
               'isGrantable', x.is_grantable
             ) ORDER BY x.grantee, x.grantor, x.privilege_type, x.is_grantable)
             FROM aclexplode(c.relacl) AS x
           ), '[]'::jsonb)
         )
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('auth', 'storage') AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  UNION ALL
  SELECT 'column-acl', format('%I.%I.%I', n.nspname, c.relname, a.attname),
         jsonb_build_object(
           'aclIsNull', a.attacl IS NULL,
           'aclRaw', a.attacl::text,
           'entries', coalesce((
             SELECT jsonb_agg(jsonb_build_object(
               'grantee', CASE x.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
               'grantor', pg_get_userbyid(x.grantor),
               'privilegeType', x.privilege_type,
               'isGrantable', x.is_grantable
             ) ORDER BY x.grantee, x.grantor, x.privilege_type, x.is_grantable)
             FROM aclexplode(a.attacl) AS x
           ), '[]'::jsonb)
         )
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('auth', 'storage')
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND a.attnum > 0 AND NOT a.attisdropped
)
SELECT coalesce(
  jsonb_agg(jsonb_build_object('kind', kind, 'identity', identity, 'details', details)
            ORDER BY kind, identity),
  '[]'::jsonb
)::text
FROM items;
`.trim();

// -----------------------------------------------------------------------------
// Classifier (Strict Fail-Closed)
// -----------------------------------------------------------------------------

const BASELINE_PATH = new URL('./platform-acl-baseline.json', import.meta.url);
let platformAclBaseline = null;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateAclEntryList(entries, label) {
  if (!Array.isArray(entries)) return { valid: false, reason: `${label} entries must be an array` };
  const seen = new Set();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (
      !isPlainObject(entry) ||
      !isNonEmptyString(entry.grantee) ||
      !isNonEmptyString(entry.grantor) ||
      !isNonEmptyString(entry.privilegeType) ||
      typeof entry.isGrantable !== 'boolean' ||
      Object.keys(entry).sort().join('|') !== ['grantee', 'grantor', 'isGrantable', 'privilegeType'].sort().join('|')
    ) {
      return { valid: false, reason: `${label} ACL entry ${index} has invalid fields or non-boolean isGrantable` };
    }
    const key = canonicalEntryKey(entry);
    if (seen.has(key)) return { valid: false, reason: `${label} contains duplicate ACL entry '${key}'` };
    seen.add(key);
  }
  return { valid: true };
}

export function validatePlatformAclBaseline(baseline) {
  const metadata = baseline?._metadata;
  if (
    !isPlainObject(baseline) ||
    !isPlainObject(metadata) ||
    metadata.format !== 'crm-platform-acl-baseline/v2' ||
    metadata.postgresVersion !== '17.11' ||
    metadata.supabaseImage !== 'public.ecr.aws/supabase/postgres:17.11.0.002' ||
    metadata.imageDigest !== 'sha256:0450166354dc9c1d25f0322ac8b580774d4fb0184d2b087f6e4fe9499c66cf53' ||
    !Number.isInteger(metadata.totalRelations) ||
    !Number.isInteger(metadata.totalColumns) ||
    metadata.extractionScript !== 'scripts/backup/extract-platform-acl-baseline.mjs' ||
    typeof metadata.outputSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(metadata.outputSha256) ||
    !isPlainObject(baseline.relations) ||
    !isPlainObject(baseline.columns)
  ) {
    fail('INVALID_PLATFORM_ACL_BASELINE', 'Platform ACL baseline metadata, pinned image provenance, or top-level schema is invalid');
  }

  const relationEntries = Object.entries(baseline.relations);
  const columnEntries = Object.entries(baseline.columns);
  if (
    relationEntries.length !== metadata.totalRelations ||
    columnEntries.length !== metadata.totalColumns ||
    metadata.totalRelations !== 38 ||
    metadata.totalColumns !== 362
  ) {
    fail('INVALID_PLATFORM_ACL_BASELINE', 'Platform ACL baseline relation/column coverage count mismatch');
  }

  const actualDigest = sha256Hex(JSON.stringify({ relations: baseline.relations, columns: baseline.columns }));
  if (actualDigest !== metadata.outputSha256.toLowerCase()) {
    fail('INVALID_PLATFORM_ACL_BASELINE', 'Platform ACL baseline content digest mismatch');
  }

  for (const [identity, entry] of relationEntries) {
    if (
      !isPlainObject(entry) ||
      !isNonEmptyString(entry.schema) ||
      !isNonEmptyString(entry.table) ||
      identity !== `${entry.schema}.${entry.table}` ||
      typeof entry.aclIsNull !== 'boolean' ||
      Object.keys(entry).sort().join('|') !== ['schema', 'table', 'aclIsNull', 'entries'].sort().join('|')
    ) {
      fail('INVALID_PLATFORM_ACL_BASELINE', `Invalid relation ACL baseline identity/schema: ${identity}`);
    }
    const checked = validateAclEntryList(entry.entries, `Relation ${identity}`);
    if (!checked.valid) fail('INVALID_PLATFORM_ACL_BASELINE', checked.reason);
    if (JSON.stringify(baseline[identity]) !== JSON.stringify(entry)) {
      fail('INVALID_PLATFORM_ACL_BASELINE', `Legacy relation alias differs from canonical baseline: ${identity}`);
    }
  }

  for (const [identity, entry] of columnEntries) {
    if (
      !isPlainObject(entry) ||
      !isNonEmptyString(entry.schema) ||
      !isNonEmptyString(entry.table) ||
      !isNonEmptyString(entry.column) ||
      identity !== `${entry.schema}.${entry.table}.${entry.column}` ||
      typeof entry.aclIsNull !== 'boolean' ||
      Object.keys(entry).sort().join('|') !== ['schema', 'table', 'column', 'aclIsNull', 'entries'].sort().join('|')
    ) {
      fail('INVALID_PLATFORM_ACL_BASELINE', `Invalid column ACL baseline identity/schema: ${identity}`);
    }
    const checked = validateAclEntryList(entry.entries, `Column ${identity}`);
    if (!checked.valid) fail('INVALID_PLATFORM_ACL_BASELINE', checked.reason);
  }

  const allowedTopLevel = new Set(['_metadata', 'relations', 'columns', ...Object.keys(baseline.relations)]);
  if (Object.keys(baseline).some((key) => !allowedTopLevel.has(key))) {
    fail('INVALID_PLATFORM_ACL_BASELINE', 'Platform ACL baseline contains unexpected top-level keys');
  }
  return baseline;
}

function deepFreeze(value) {
  if (isPlainObject(value) || Array.isArray(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function getPlatformAclBaseline() {
  if (!platformAclBaseline) {
    const parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    validatePlatformAclBaseline(parsed);
    platformAclBaseline = deepFreeze(parsed);
  }
  return platformAclBaseline;
}

export function canonicalEntryKey(entry) {
  if (
    !isPlainObject(entry) ||
    !isNonEmptyString(entry.grantee) ||
    !isNonEmptyString(entry.grantor) ||
    !isNonEmptyString(entry.privilegeType) ||
    typeof entry.isGrantable !== 'boolean'
  ) {
    throw new TypeError('ACL entry requires non-empty grantee, grantor, privilegeType, and boolean isGrantable');
  }
  return `${entry.grantee}|${entry.grantor}|${entry.privilegeType}|${entry.isGrantable}`;
}

/**
 * Classifies relation-acl and column-acl using exact per-object platform baseline.
 * Fails closed on any unauthorized permission, unexpected grant, missing baseline grant,
 * grant option tampering, non-null column ACL, or unknown relation.
 */
export function classifyAclCustomization(item, projectAllowlist = new Set()) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { classification: 'unexplained', reason: 'Malformed ACL object' };
  const { kind, identity, details } = item;
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return { classification: 'unexplained', reason: 'Malformed ACL details' };
  }

  // Check allowlist
  if (projectAllowlist.has(identity) || projectAllowlist.has(`${kind}:${identity}`)) {
    return { classification: 'project-owned', reason: 'Matched project allowlist' };
  }

  if (kind === 'column-acl') {
    let baseline;
    try { baseline = getPlatformAclBaseline(); } catch (error) {
      return { classification: 'unexplained', reason: `Platform ACL baseline validation failed: ${error.message}` };
    }
    const columnsBaseline = baseline.columns;
    const baselineObj = columnsBaseline[identity];
    if (!baselineObj) {
      return {
        classification: 'unexplained',
        reason: `Column ${identity} is not in platform ACL baseline (unrecognized or extra column)`,
      };
    }

    if (details.schema !== baselineObj.schema || details.table !== baselineObj.table || details.column !== baselineObj.column) {
      return { classification: 'unexplained', reason: `Column identity metadata mismatch on ${identity}` };
    }
    if (details.schema !== baselineObj.schema || details.table !== baselineObj.table) {
      return { classification: 'unexplained', reason: `Relation identity metadata mismatch on ${identity}` };
    }
    if (typeof details.aclIsNull !== 'boolean' || !Array.isArray(details.entries)) {
      return {
        classification: 'unexplained',
        reason: `Missing required ACL metadata fields on column ${identity}`,
      };
    }

    if (details.aclIsNull !== baselineObj.aclIsNull) {
      return {
        classification: 'unexplained',
        reason: `Column ACL nullability mismatch on ${identity}: expected aclIsNull=${baselineObj.aclIsNull}, got ${details.aclIsNull}`,
      };
    }

    const actualEntries = details.entries;
    const baselineEntries = baselineObj.entries;
    const actualValidation = validateAclEntryList(actualEntries, `Column ${identity}`);
    if (!actualValidation.valid) return { classification: 'unexplained', reason: actualValidation.reason };
    const actualSet = new Set(actualEntries.map(canonicalEntryKey));
    const baselineSet = new Set(baselineEntries.map(canonicalEntryKey));

    if (actualSet.size !== actualEntries.length) {
      return {
        classification: 'unexplained',
        reason: `Duplicate column ACL entries detected on ${identity}`,
      };
    }

    for (const entry of actualEntries) {
      const key = canonicalEntryKey(entry);
      if (!baselineSet.has(key)) {
        return {
          classification: 'unexplained',
          reason: `Unexpected column ACL entry '${key}' on ${identity}`,
        };
      }
    }

    for (const entry of baselineEntries) {
      const key = canonicalEntryKey(entry);
      if (!actualSet.has(key)) {
        return {
          classification: 'unexplained',
          reason: `Missing expected baseline column ACL entry '${key}' on ${identity}`,
        };
      }
    }

    return {
      classification: 'platform-default',
      reason: 'Exact match with verified platform column ACL baseline',
    };
  }

  if (kind === 'relation-acl') {
    let baseline;
    try { baseline = getPlatformAclBaseline(); } catch (error) {
      return { classification: 'unexplained', reason: `Platform ACL baseline validation failed: ${error.message}` };
    }
    const relationsBaseline = baseline.relations;
    const baselineObj = relationsBaseline[identity];
    if (!baselineObj) {
      return {
        classification: 'unexplained',
        reason: `Relation ${identity} is not in platform ACL baseline`,
      };
    }

    if (typeof details.aclIsNull !== 'boolean' || !Array.isArray(details.entries)) {
      return {
        classification: 'unexplained',
        reason: `Missing required ACL metadata fields on relation ${identity}`,
      };
    }

    if (details.aclIsNull !== baselineObj.aclIsNull) {
      return {
        classification: 'unexplained',
        reason: `ACL nullability mismatch on ${identity}: expected aclIsNull=${baselineObj.aclIsNull}, got ${details.aclIsNull}`,
      };
    }

    const actualEntries = details.entries;
    const baselineEntries = baselineObj.entries;
    const actualValidation = validateAclEntryList(actualEntries, `Relation ${identity}`);
    if (!actualValidation.valid) return { classification: 'unexplained', reason: actualValidation.reason };

    const baselineSet = new Set(baselineEntries.map(canonicalEntryKey));
    const actualSet = new Set(actualEntries.map(canonicalEntryKey));

    if (actualSet.size !== actualEntries.length) {
      return {
        classification: 'unexplained',
        reason: `Duplicate ACL entries detected on ${identity}`,
      };
    }

    // Check for unexpected extra entries (e.g. DELETE granted to authenticated)
    for (const entry of actualEntries) {
      const key = canonicalEntryKey(entry);
      if (!baselineSet.has(key)) {
        return {
          classification: 'unexplained',
          reason: `Unexpected ACL entry '${key}' on ${identity}`,
        };
      }
    }

    // Check for missing baseline entries
    for (const entry of baselineEntries) {
      const key = canonicalEntryKey(entry);
      if (!actualSet.has(key)) {
        return {
          classification: 'unexplained',
          reason: `Missing expected baseline ACL entry '${key}' on ${identity}`,
        };
      }
    }

    return {
      classification: 'platform-default',
      reason: 'Exact match with verified platform relation ACL baseline',
    };
  }

  return { classification: 'unexplained', reason: `Unknown ACL kind ${kind}` };
}

/**
 * Classifies an object in managed-customizations.json as:
 * - 'platform-default': Standard Supabase Auth/Storage built-in object
 * - 'project-owned': User/project-defined customization
 * - 'unexplained': Unrecognized object (triggers fail-closed BLOCKED status)
 */
export function classifyManagedCustomization(item, projectAllowlist = new Set()) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { classification: 'unexplained', reason: 'Malformed object structure' };
  const { kind, identity, details } = item;
  if (typeof kind !== 'string' || !kind.trim() || typeof identity !== 'string' || !identity.trim() || typeof details !== 'object' || details === null || Array.isArray(details)) {
    return { classification: 'unexplained', reason: 'Malformed object structure' };
  }

  // Check project allowlist first
  if (projectAllowlist.has(identity) || projectAllowlist.has(`${kind}:${identity}`)) {
    return { classification: 'project-owned', reason: 'Matched project allowlist' };
  }

  // Project naming conventions (only for customization kinds that can be project-owned)
  if (
    kind !== 'relation-acl' &&
    kind !== 'column-acl' &&
    (
      identity.toLowerCase().includes('chd_') ||
      identity.toLowerCase().includes('crm_') ||
      identity.toLowerCase().includes('customer_') ||
      identity.toLowerCase().includes('meta_ads')
    )
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
      return classifyAclCustomization(item, projectAllowlist);
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
 * Enforces transaction ordering: BEGIN comes before SET LOCAL.
 */
export function generateManagedCustomizationsSql(projectOwnedItems) {
  const lines = [
    '-- Managed Customizations Recreation Plan',
    '-- Generated deterministically by scripts/backup/managed-customizations.mjs',
    '-- Enforces transaction wrapping and strict error termination.',
    'BEGIN;',
    'SET LOCAL search_path = public, auth, storage;',
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
    } else if (kind === 'routine' || kind === 'procedure') {
      const { definition, owner } = details;
      if (definition) {
        lines.push(`${definition};`);
      }
      if (owner) {
        lines.push(`ALTER ${kind.toUpperCase()} ${identity} OWNER TO ${quoteIdent(owner)};`);
      }
      lines.push('');
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
  const unsupportedItems = [];
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
      // Check if this kind is supported for SQL recreation
      if (!SUPPORTED_RECREATION_KINDS.has(item.kind)) {
        unsupportedItems.push({
          kind: item.kind,
          identity: item.identity,
          reason: `Recreation for kind '${item.kind}' is not supported; manual review required`,
        });
      } else {
        projectOwnedItems.push(item);
      }
    } else {
      unexplainedCount++;
    }
  }

  const unsupportedCount = unsupportedItems.length;
  // Plan is BLOCKED if there are unexplained items OR unsupported project-owned items
  const isBlocked = unexplainedCount > 0 || unsupportedCount > 0;
  const status = isBlocked ? 'BLOCKED' : 'APPROVED';

  // Generate deterministic SQL plan
  let planSql = '';
  if (isBlocked) {
    const reasons = [];
    if (unexplainedCount > 0) reasons.push(`${unexplainedCount} unexplained object(s)`);
    if (unsupportedCount > 0) reasons.push(`${unsupportedCount} unsupported project-owned kind(s)`);
    planSql = `-- PLAN GENERATION BLOCKED DUE TO ${reasons.join(' AND ').toUpperCase()}\n-- STOP: Review unexplained and unsupported objects before proceeding.\n`;
  } else {
    planSql = generateManagedCustomizationsSql(projectOwnedItems);
  }

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
      unsupportedCount,
    },
    unsupportedObjects: unsupportedItems,
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

export function compareStringsStrict(v1, v2) {
  const isNullish1 = v1 === null || v1 === undefined;
  const isNullish2 = v2 === null || v2 === undefined;
  if (isNullish1 && isNullish2) return true;
  if (isNullish1 !== isNullish2) return false;
  return String(v1).trim() === String(v2).trim();
}

export function normalizeRolesArray(roles) {
  if (!roles) return [];
  if (Array.isArray(roles)) {
    return roles.map(r => String(r).toLowerCase()).sort();
  }
  return [String(roles).toLowerCase()];
}

export function normalizeConfigArray(config) {
  if (!config) return [];
  if (Array.isArray(config)) {
    return config.map(c => String(c).trim()).sort();
  }
  return [String(config).trim()];
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

function isNullableStringArray(value) {
  return value === null || isNonEmptyStringArray(value);
}

function isNullableStringOrStringArray(value) {
  return value === null ||
    (typeof value === 'string' && value.trim().length > 0) ||
    isNonEmptyStringArray(value);
}

export function validateCustomizationDetails(kind, identity, details, label = 'item') {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return { valid: false, reason: `${label} '${identity}' details must be a non-null object` };
  }

  switch (kind) {
    case 'policy': {
      if (typeof details.schema !== 'string' || !details.schema.trim()) {
        return { valid: false, reason: `${label} policy '${identity}' missing non-empty string schema` };
      }
      if (typeof details.table !== 'string' || !details.table.trim()) {
        return { valid: false, reason: `${label} policy '${identity}' missing non-empty string table` };
      }
      if (typeof details.policy !== 'string' || !details.policy.trim()) {
        return { valid: false, reason: `${label} policy '${identity}' missing non-empty string policy` };
      }
      if (!['PERMISSIVE', 'RESTRICTIVE'].includes(details.permissive)) {
        return { valid: false, reason: `${label} policy '${identity}' has invalid permissive mode` };
      }
      if (!isNonEmptyStringArray(details.roles) || new Set(details.roles).size !== details.roles.length) {
        return { valid: false, reason: `${label} policy '${identity}' roles must be unique non-empty strings` };
      }
      if (!['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(details.command)) {
        return { valid: false, reason: `${label} policy '${identity}' has invalid command` };
      }
      if (!('using' in details) || (details.using !== null && (typeof details.using !== 'string' || !details.using.trim()))) {
        return { valid: false, reason: `${label} policy '${identity}' missing nullable string using` };
      }
      if (!('withCheck' in details) || (details.withCheck !== null && (typeof details.withCheck !== 'string' || !details.withCheck.trim()))) {
        return { valid: false, reason: `${label} policy '${identity}' missing nullable string withCheck` };
      }
      return { valid: true };
    }

    case 'index': {
      if (typeof details.definition !== 'string' || !details.definition.trim()) {
        return { valid: false, reason: `${label} index '${identity}' missing string definition` };
      }
      if (typeof details.valid !== 'boolean') {
        return { valid: false, reason: `${label} index '${identity}' missing boolean valid` };
      }
      if (typeof details.ready !== 'boolean') {
        return { valid: false, reason: `${label} index '${identity}' missing boolean ready` };
      }
      if (typeof details.live !== 'boolean') {
        return { valid: false, reason: `${label} index '${identity}' missing boolean live` };
      }
      if (typeof details.unique !== 'boolean') {
        return { valid: false, reason: `${label} index '${identity}' missing boolean unique` };
      }
      if (typeof details.primary !== 'boolean') {
        return { valid: false, reason: `${label} index '${identity}' missing boolean primary` };
      }
      return { valid: true };
    }

    case 'trigger': {
      if (typeof details.definition !== 'string' || !details.definition.trim()) {
        return { valid: false, reason: `${label} trigger '${identity}' missing string definition` };
      }
      if (!['O', 'D', 'R', 'A'].includes(details.enabled)) {
        return { valid: false, reason: `${label} trigger '${identity}' has invalid enabled state` };
      }
      if (typeof details.functionIdentity !== 'string' || !details.functionIdentity.trim()) {
        return { valid: false, reason: `${label} trigger '${identity}' missing string functionIdentity` };
      }
      if (typeof details.functionDefinition !== 'string' || !details.functionDefinition.trim()) {
        return { valid: false, reason: `${label} trigger '${identity}' missing non-empty string functionDefinition` };
      }
      if (typeof details.functionOwner !== 'string' || !details.functionOwner.trim()) {
        return { valid: false, reason: `${label} trigger '${identity}' missing string functionOwner` };
      }
      if (typeof details.securityDefiner !== 'boolean') {
        return { valid: false, reason: `${label} trigger '${identity}' missing boolean securityDefiner` };
      }
      if (!('functionConfig' in details) || !isNullableStringArray(details.functionConfig)) {
        return { valid: false, reason: `${label} trigger '${identity}' missing nullable array functionConfig` };
      }
      if (!('functionAcl' in details) || !isNullableStringOrStringArray(details.functionAcl)) {
        return { valid: false, reason: `${label} trigger '${identity}' missing nullable array/string functionAcl` };
      }
      return { valid: true };
    }

    case 'routine':
    case 'procedure': {
      if (typeof details.definition !== 'string' || !details.definition.trim()) {
        return { valid: false, reason: `${label} ${kind} '${identity}' missing string definition` };
      }
      if (typeof details.owner !== 'string' || !details.owner.trim()) {
        return { valid: false, reason: `${label} ${kind} '${identity}' missing string owner` };
      }
      if (typeof details.securityDefiner !== 'boolean') {
        return { valid: false, reason: `${label} ${kind} '${identity}' missing boolean securityDefiner` };
      }
      if (!('config' in details) || !isNullableStringArray(details.config)) {
        return { valid: false, reason: `${label} ${kind} '${identity}' missing nullable array config` };
      }
      if (!('acl' in details) || !isNullableStringOrStringArray(details.acl)) {
        return { valid: false, reason: `${label} ${kind} '${identity}' missing nullable array/string acl` };
      }
      if (typeof details.language !== 'string' || !details.language.trim()) {
        return { valid: false, reason: `${label} ${kind} '${identity}' missing string language` };
      }
      if (!('comment' in details) || (details.comment !== null && typeof details.comment !== 'string')) {
        return { valid: false, reason: `${label} ${kind} '${identity}' missing nullable string comment` };
      }
      return { valid: true };
    }

    default: {
      return { valid: false, reason: `Unsupported customization kind '${kind}' for schema validation` };
    }
  }
}

/**
 * Performs deep, field-by-field verification of a project-owned customization object
 * against its restored target counterpart.
 * Validates schema on both source and target beforehand, failing closed on any missing
 * or invalid fields without defaulting or loose coercion.
 */
export function deepCompareCustomizationItem(sourceItem, targetItem) {
  const discrepancies = [];
  const { kind, identity } = sourceItem;

  // 1. Validate source details
  const srcValid = validateCustomizationDetails(kind, identity, sourceItem?.details, 'Source');
  if (!srcValid.valid) {
    discrepancies.push({
      identity,
      kind,
      field: 'schema_validation',
      sourceValue: 'invalid',
      targetValue: 'unverified',
      reason: srcValid.reason,
    });
    return discrepancies;
  }

  // 2. Validate target details
  const tgtValid = validateCustomizationDetails(kind, identity, targetItem?.details, 'Target');
  if (!tgtValid.valid) {
    discrepancies.push({
      identity,
      kind,
      field: 'schema_validation',
      sourceValue: 'valid',
      targetValue: 'invalid',
      reason: tgtValid.reason,
    });
    return discrepancies;
  }

  const s = sourceItem.details;
  const t = targetItem.details;

  const check = (field, sVal, tVal, reason, customEqual = null) => {
    let isEq = false;
    if (customEqual) {
      isEq = customEqual(sVal, tVal);
    } else {
      if (sVal === null && tVal === null) isEq = true;
      else if (typeof sVal === 'string' && typeof tVal === 'string') isEq = sVal.trim() === tVal.trim();
      else isEq = false;
    }
    if (!isEq) {
      discrepancies.push({
        identity,
        kind,
        field,
        sourceValue: sVal,
        targetValue: tVal,
        reason,
      });
    }
  };

  const checkBool = (field, sVal, tVal, reason) => {
    if (typeof sVal !== 'boolean' || typeof tVal !== 'boolean' || sVal !== tVal) {
      discrepancies.push({
        identity,
        kind,
        field,
        sourceValue: sVal,
        targetValue: tVal,
        reason,
      });
    }
  };

  switch (kind) {
    case 'policy': {
      check('permissive', s.permissive, t.permissive, 'Policy permissive mode mismatch', (a, b) => (typeof a === 'string' && typeof b === 'string' && a.toUpperCase() === b.toUpperCase()));
      check('roles', s.roles, t.roles, 'Policy roles mismatch', (a, b) => JSON.stringify(normalizeRolesArray(a)) === JSON.stringify(normalizeRolesArray(b)));
      check('command', s.command, t.command, 'Policy command mismatch', (a, b) => (typeof a === 'string' && typeof b === 'string' && a.toUpperCase() === b.toUpperCase()));
      check('using', s.using, t.using, 'Policy using expression mismatch');
      check('withCheck', s.withCheck, t.withCheck, 'Policy withCheck expression mismatch');
      break;
    }

    case 'index': {
      check('definition', s.definition, t.definition, 'Index definition mismatch');
      checkBool('valid', s.valid, t.valid, 'Target index validity mismatch');
      checkBool('ready', s.ready, t.ready, 'Target index ready state mismatch');
      checkBool('live', s.live, t.live, 'Target index live state mismatch');
      checkBool('unique', s.unique, t.unique, 'Target index unique flag mismatch');
      checkBool('primary', s.primary, t.primary, 'Target index primary flag mismatch');
      break;
    }

    case 'trigger': {
      check('definition', s.definition, t.definition, 'Trigger definition mismatch');
      check('enabled', s.enabled, t.enabled, 'Trigger enabled state mismatch');
      check('functionIdentity', s.functionIdentity, t.functionIdentity, 'Trigger function identity mismatch');
      check('functionDefinition', s.functionDefinition, t.functionDefinition, 'Trigger function definition mismatch');
      check('functionOwner', s.functionOwner, t.functionOwner, 'Trigger function owner mismatch');
      checkBool('securityDefiner', s.securityDefiner, t.securityDefiner, 'Trigger function SECURITY DEFINER mismatch');
      check('functionConfig', s.functionConfig, t.functionConfig, 'Trigger function config mismatch', (a, b) => {
        if (a === null && b === null) return true;
        if (!Array.isArray(a) || !Array.isArray(b)) return false;
        return JSON.stringify(normalizeConfigArray(a)) === JSON.stringify(normalizeConfigArray(b));
      });
      check('functionAcl', s.functionAcl, t.functionAcl, 'Trigger function ACL mismatch', (a, b) => {
        if (a === null && b === null) return true;
        if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify(a.map(String).sort()) === JSON.stringify(b.map(String).sort());
        if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
        return false;
      });
      break;
    }

    case 'routine':
    case 'procedure': {
      check('definition', s.definition, t.definition, `${kind} definition mismatch`);
      check('owner', s.owner, t.owner, `${kind} owner mismatch`);
      checkBool('securityDefiner', s.securityDefiner, t.securityDefiner, `${kind} SECURITY DEFINER mismatch`);
      check('config', s.config, t.config, `${kind} config mismatch`, (a, b) => {
        if (a === null && b === null) return true;
        if (!Array.isArray(a) || !Array.isArray(b)) return false;
        return JSON.stringify(normalizeConfigArray(a)) === JSON.stringify(normalizeConfigArray(b));
      });
      check('acl', s.acl, t.acl, `${kind} ACL mismatch`, (a, b) => {
        if (a === null && b === null) return true;
        if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify(a.map(String).sort()) === JSON.stringify(b.map(String).sort());
        if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
        return false;
      });
      check('language', s.language, t.language, `${kind} language mismatch`);
      check('comment', s.comment, t.comment, `${kind} comment mismatch`);
      break;
    }

    default: {
      discrepancies.push({
        identity,
        kind,
        field: 'kind_support',
        sourceValue: kind,
        targetValue: kind,
        reason: `Customization kind '${kind}' is not supported for verification`,
      });
      break;
    }
  }

  return discrepancies;
}

function managedItemKey(item) {
  if (
    !item || typeof item !== 'object' || Array.isArray(item) ||
    typeof item.kind !== 'string' || !item.kind.trim() ||
    typeof item.identity !== 'string' || !item.identity.trim()
  ) return null;
  return `${item.kind}:${item.identity}`;
}

export async function handleVerifyCommand({ sourcePath, target, reportPath, targetInventoryPath = null, querySql = null, projectAllowlist = [] }) {
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

  if (!Array.isArray(sourceItems)) {
    fail('INVALID_MANAGED_CUSTOMIZATIONS', 'Source managed customizations must be an array');
  }

  const allowlistSet = new Set(projectAllowlist);
  const discrepancies = [];
  const projectOwned = [];
  const sourceSeen = new Set();

  // Source inventory is evidence: malformed, duplicate, or unexplained entries must block.
  for (const item of sourceItems) {
    const key = managedItemKey(item);
    if (!key) {
      discrepancies.push({ identity: item?.identity ?? null, kind: item?.kind ?? null, field: 'source_schema', reason: 'Source inventory contains a malformed identity or object' });
      continue;
    }
    if (sourceSeen.has(key)) {
      discrepancies.push({ identity: item.identity, kind: item.kind, field: 'duplicate_source_identity', reason: `Source inventory contains duplicate identity '${key}'` });
      continue;
    }
    sourceSeen.add(key);
    const classification = classifyManagedCustomization(item, allowlistSet);
    if (classification.classification === 'project-owned') projectOwned.push(item);
    else if (classification.classification === 'unexplained') {
      discrepancies.push({ identity: item.identity, kind: item.kind, field: 'source_unexplained', reason: `Source contains unexplained object: ${classification.reason}` });
    }
  }
  let targetItems = null;

  try {
    if (typeof querySql === 'function') {
      const rawTarget = await querySql();
      targetItems = typeof rawTarget === 'string' ? parseJsonStrict(rawTarget) : rawTarget;
    } else if (targetInventoryPath) {
      const rawTarget = await fsp.readFile(targetInventoryPath, 'utf8');
      targetItems = parseJsonStrict(rawTarget, 'INVALID_TARGET_INVENTORY', 'Target managed customizations inventory');
    } else {
      // Query target container directly via docker exec psql
      const rawTarget = await new Promise((resolve, reject) => {
        const child = spawn('docker', ['exec', '-i', target, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code !== 0) {
            reject(new HelperError('TARGET_QUERY_FAILED', `Failed to query target managed customizations (${code}): ${stderr}`));
          } else {
            resolve(stdout);
          }
        });
        child.stdin.write(MANAGED_CUSTOMIZATIONS_QUERY_SQL);
        child.stdin.end();
      });
      targetItems = parseJsonStrict(rawTarget, 'INVALID_TARGET_INVENTORY', 'Target managed customizations query output');
    }
  } catch (err) {
    if (err instanceof HelperError && err.code === 'INVALID_TARGET_INVENTORY') {
      throw err;
    }
    fail('TARGET_EVIDENCE_MISSING', `Failed to obtain target managed customizations inventory: ${err.message}`);
  }

  if (!Array.isArray(targetItems)) {
    fail('TARGET_EVIDENCE_MISSING', 'Verification requires verified target inventory data array');
  }

  // Reject malformed and duplicate target identities before constructing lookup maps.
  const targetMap = new Map();
  const targetSeen = new Set();
  const verifiedTargetItems = [];
  for (const item of targetItems) {
    const key = managedItemKey(item);
    if (!key) {
      discrepancies.push({ identity: item?.identity ?? null, kind: item?.kind ?? null, field: 'target_schema', reason: 'Target inventory contains a malformed identity or object' });
      continue;
    }
    if (targetSeen.has(key)) {
      discrepancies.push({ identity: item.identity, kind: item.kind, field: 'duplicate_target_identity', reason: `Target inventory contains duplicate identity '${key}'` });
      continue;
    }
    targetSeen.add(key);
    targetMap.set(key, item);
    verifiedTargetItems.push(item);
  }

  // 1. Check that all project-owned items exist in target and match all attributes exactly
  const sourceProjectKeySet = new Set(projectOwned.map(item => `${item.kind}:${item.identity}`));

  for (const item of projectOwned) {
    const key = `${item.kind}:${item.identity}`;
    const targetObj = targetMap.get(key);
    if (!targetObj) {
      discrepancies.push({
        identity: item.identity,
        kind: item.kind,
        field: 'existence',
        sourceValue: 'present',
        targetValue: 'missing',
        reason: 'Missing from target managed schema after apply',
      });
      continue;
    }

    // Deep compare all required attributes for this object kind
    const itemDiscrepancies = deepCompareCustomizationItem(item, targetObj);
    discrepancies.push(...itemDiscrepancies);
  }

  // 2. Check for extra unexpected project-owned customizations or unexplained objects on target
  for (const targetItem of verifiedTargetItems) {
    const tKey = `${targetItem.kind}:${targetItem.identity}`;
    const tClass = classifyManagedCustomization(targetItem, allowlistSet);
    if (tClass.classification === 'project-owned') {
      if (!sourceProjectKeySet.has(tKey)) {
        discrepancies.push({
          identity: targetItem.identity,
          kind: targetItem.kind,
          field: 'extra_object',
          sourceValue: 'missing',
          targetValue: 'present',
          reason: `Extra unexpected project-owned ${targetItem.kind} found on target`,
        });
      }
    } else if (tClass.classification === 'unexplained') {
      discrepancies.push({
        identity: targetItem.identity,
        kind: targetItem.kind,
        field: 'unexplained_object',
        sourceValue: 'absent',
        targetValue: 'unexplained',
        reason: `Target contains unexplained object: ${tClass.reason}`,
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
          targetInventoryPath: args['target-inventory'],
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
