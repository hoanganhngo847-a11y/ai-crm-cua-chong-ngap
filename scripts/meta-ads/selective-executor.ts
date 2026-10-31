/**
 * Dedicated Controlled Executor & Selective-Release Ledger for Meta Ads.
 *
 * Implements strategy (A+B):
 * - Preserves all 21 original canonical ledger records byte-for-byte.
 * - Does NOT fabricate records for the 95 unapplied canonical gap migrations.
 * - Records release metadata, hashes, fingerprints, and recovery evidence in private.selective_feature_releases.
 * - Fences ordinary migration writers (e.g. blind `supabase db push`) via a fail-closed trigger on schema_migrations.
 * - Executes in a single atomic transaction under advisory lock.
 * - Hosted execution remains BLOCKED until backup verification and owner approval.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inspectTransactionEnvelope, sqlSha256 } from './ledger-readiness';

export const TARGET_STAGING_PROJECT = 'qmhfmgkymjgoevwmkidm';
export const TARGET_POSTGRES_VERSION = '17.11';
export const EXPECTED_CANONICAL_LEDGER_COUNT = 21;
export const CURRENT_SOURCE_COMMIT = 'e51a5989143582af0885ba5ee26644a68b388995';

export const META_SOURCES = [
  '20261030090000_meta_ads_lead_attribution.sql',
  '20261030100000_meta_ads_hardening.sql',
  '20261030110000_meta_ads_final_remediation.sql',
  '20261030120000_meta_ads_attribution_rpc_security.sql',
  '20261030130000_meta_ads_phone_duplicate_history.sql',
] as const;

export const PINNED_SOURCE_HASHES: Record<string, string> = {
  '20261030090000_meta_ads_lead_attribution.sql': 'f29e10fc5655bf9e2b736b87e49589a0be5ca55cb7c0cd185422f0af9a7fd95a',
  '20261030100000_meta_ads_hardening.sql': 'e83f9ffb4a0eb4914ac8b1b6cca35674720dde8809bb30c66218eecbd2001657',
  '20261030110000_meta_ads_final_remediation.sql': '79311ef986d9d9a22be77bfafb4b602854aebab6f8a864ea726d9ac7a7cc9814',
  '20261030120000_meta_ads_attribution_rpc_security.sql': 'a06d05072823d0a057cc48d8c15230ee57da6c6f4b388a5ccce8fb51c12aa9e1',
  '20261030130000_meta_ads_phone_duplicate_history.sql': '54b36ff61749c0881f38ce257976bcacf9f679f89e6b151297220d04232c0770',
};

const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
const attributionColumns = [
  'first_campaign_name',
  'first_ad_name',
  'first_touch_at',
  'latest_campaign_name',
  'latest_ad_name',
  'latest_touch_at',
  'attribution_status',
];

export interface SelectiveExecutorOptions {
  targetProjectRef?: string;
  releaseId?: string;
  sourceCommit?: string;
  simulatedInjectedError?: 'NONE' | 'WRONG_PROJECT' | 'SOURCE_3' | 'POST_DDL' | 'WRONG_VERSION';
  sourcesOverride?: { file: string; sql: string }[];
}

export function buildSelectiveExecutorPackage(options: SelectiveExecutorOptions = {}) {
  const targetProject = options.targetProjectRef ?? TARGET_STAGING_PROJECT;
  const releaseId = options.releaseId ?? 'meta-ads-20261031-r1';
  const sourceCommit = options.sourceCommit ?? CURRENT_SOURCE_COMMIT;
  const simulatedError = options.simulatedInjectedError ?? 'NONE';

  const proof = JSON.parse(readFileSync('docs/evidence/meta-ads-21-prefix/compatibility.json', 'utf8'));
  const recorded = JSON.parse(readFileSync('docs/evidence/meta-ads-safe-deployment/staging-metadata.json', 'utf8')).data[0].snapshot.migration_history;
  assert.equal(recorded.length, EXPECTED_CANONICAL_LEDGER_COUNT, 'Staging snapshot must have 21 migrations');

  // Verify and parse the 5 Meta sources
  const sources = META_SOURCES.map((file) => {
    const override = options.sourcesOverride?.find((s) => s.file === file);
    const sql = override ? override.sql : readFileSync('supabase/migrations/' + file, 'utf8');
    const sha256 = sqlSha256(sql);
    const envelope = inspectTransactionEnvelope(sql);

    // Verify pinned hash
    if (!override) {
      assert.equal(sha256, PINNED_SOURCE_HASHES[file], `Pinned hash mismatch for ${file}`);
    }
    assert.notEqual(envelope.mode, 'REJECT', `Envelope rejected for ${file}`);
    assert.doesNotMatch(
      sql,
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(?:han_ingest|seed_messenger_pages_canary|open_response_sla_window)\s*\(/i,
      `Forbidden runtime modification detected in ${file}`
    );

    const body = envelope.mode === 'OUTER' ? sql.slice(envelope.statements[0].end, envelope.statements.at(-1)!.start) : sql;
    return { file, sha256, sql, body, statementsCount: envelope.statements.length };
  });

  const expectedLedger = recorded.map((m: { version: string; name: string; stored_sql_sha256: string }) => ({
    version: m.version,
    name: m.name,
    source_hash: m.stored_sql_sha256,
  }));
  const preLedgerFingerprint = createHash('sha256').update(JSON.stringify(expectedLedger), 'utf8').digest('hex');

  // Fingerprint query excludes selective_feature_releases so application schema matches proof.afterCatalog exactly
  const baseFingerprint = readFileSync('docs/evidence/meta-ads-safe-deployment/catalog-fingerprint.sql', 'utf8').replace(/;\s*$/, '');
  const filteredFingerprint = baseFingerprint.replace(
    'FROM objects GROUP BY category',
    "FROM objects WHERE identity NOT LIKE '%selective_feature_releases%' GROUP BY category"
  );

  const preCatalogFingerprint = createHash('sha256').update(JSON.stringify(proof.prefixCatalog), 'utf8').digest('hex');
  const postCatalogFingerprint = createHash('sha256').update(JSON.stringify(proof.afterCatalog), 'utf8').digest('hex');

  // 1. Preconditions SQL
  const preconditions = `
-- SET LOCK TIMEOUT AND TRANSACTION-LEVEL ADVISORY LOCK
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('meta-ads-selective-release',0));
LOCK TABLE supabase_migrations.schema_migrations IN SHARE MODE;

DO $preflight$
DECLARE
  actual jsonb;
  v_table_row record;
  v_target_project text := ${quote(targetProject)};
  v_expected_project text := ${quote(TARGET_STAGING_PROJECT)};
  v_release_id text := ${quote(releaseId)};
BEGIN
  -- 0. Server version enforcement: Must be PostgreSQL 17.x (baseline target 17.11)
  IF ${options.simulatedInjectedError === 'WRONG_VERSION' ? 'TRUE' : "current_setting('server_version_num')::integer < 170000 OR current_setting('server_version_num')::integer >= 180000"} THEN
    RAISE EXCEPTION 'POSTGRES_VERSION_INCOMPATIBLE: Server version % (num: %) does not match required PostgreSQL 17.x baseline (target 17.11)',
      current_setting('server_version'), current_setting('server_version_num');
  END IF;

  -- 1. Project identity guard
  IF v_target_project IS DISTINCT FROM v_expected_project THEN
    RAISE EXCEPTION 'TARGET_PROJECT_MISMATCH: Target project % does not match expected staging project %', v_target_project, v_expected_project;
  END IF;

  -- 2. Duplicate release guard
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'private' AND tablename = 'selective_feature_releases') THEN
    IF EXISTS (SELECT 1 FROM private.selective_feature_releases WHERE release_id = v_release_id) THEN
      RAISE EXCEPTION 'SELECTIVE_RELEASE_ALREADY_APPLIED: Release ID % has already been applied', v_release_id;
    END IF;
  END IF;

  -- 3. Verify exactly 21 canonical ledger entries and hashes
  SELECT jsonb_agg(jsonb_build_object(
    'version', version,
    'name', name,
    'source_hash', encode(sha256(convert_to(array_to_string(statements, E'\\n'), 'UTF8')), 'hex')
  ) ORDER BY version)
  INTO actual FROM supabase_migrations.schema_migrations;

  IF jsonb_array_length(coalesce(actual, '[]'::jsonb)) <> ${EXPECTED_CANONICAL_LEDGER_COUNT} THEN
    RAISE EXCEPTION 'CANONICAL_LEDGER_COUNT_MISMATCH: Expected ${EXPECTED_CANONICAL_LEDGER_COUNT} entries, found %', jsonb_array_length(actual);
  END IF;

  IF actual IS DISTINCT FROM ${quote(JSON.stringify(expectedLedger))}::jsonb THEN
    RAISE EXCEPTION 'META_21_LEDGER_DRIFT';
  END IF;

  -- 4. Reject unexpected existing Meta objects (tables, relations, tokens, lead events)
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'private')
      AND c.relname IN ('meta_ad_accounts', 'meta_campaigns', 'meta_ads', 'meta_lead_forms',
                        'lead_attribution_touchpoints', 'meta_ad_account_tokens', 'meta_leadgen_events')
  ) THEN
    RAISE EXCEPTION 'UNEXPECTED_EXISTING_META_OBJECTS: One or more Meta tables already exist prior to deployment';
  END IF;

  -- 5. Verify pre-deployment schema fingerprint matches exact prefix 21 catalog
  SELECT jsonb_agg(f ORDER BY category) INTO actual FROM (${filteredFingerprint}) f;
  IF actual IS DISTINCT FROM ${quote(JSON.stringify(proof.prefixCatalog))}::jsonb THEN
    RAISE EXCEPTION 'META_21_SCHEMA_OR_ACL_DRIFT';
  END IF;

  -- 6. Lock all existing application tables in SHARE MODE to block concurrent writes during checkpoint
  FOR v_table_row IN SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public','private') AND c.relkind = 'r' ORDER BY n.nspname, c.relname
  LOOP
    EXECUTE format('LOCK TABLE %I.%I IN SHARE MODE', v_table_row.nspname, v_table_row.relname);
  END LOOP;
END $preflight$;

-- Temp table checkpoints for ledger and row hash preservation verification
CREATE TEMP TABLE meta_21_rows(name text PRIMARY KEY, row_count bigint, digest text) ON COMMIT DROP;
CREATE TEMP TABLE meta_21_ledger ON COMMIT DROP AS SELECT * FROM supabase_migrations.schema_migrations;

DO $checkpoint$
DECLARE
  v_table_row record;
  excluded text[];
BEGIN
  FOR v_table_row IN SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public','private') AND c.relkind = 'r' LOOP
    excluded := CASE WHEN v_table_row.nspname = 'public' AND v_table_row.relname = 'customers'
                     THEN ARRAY[${attributionColumns.map(quote).join(',')}]
                     ELSE ARRAY[]::text[] END;
    EXECUTE format(
      'INSERT INTO meta_21_rows SELECT %L, count(*), encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) - %L::text[] ORDER BY (to_jsonb(t) - %L::text[])::text), ''[]'')::text, ''UTF8'')), ''hex'') FROM %I.%I t',
      v_table_row.nspname || '.' || v_table_row.relname, excluded, excluded, v_table_row.nspname, v_table_row.relname
    );
  END LOOP;
END $checkpoint$;
`;

  // 2. Sources execution with optional simulation
  let sourcesSql = '';
  for (let idx = 0; idx < sources.length; idx++) {
    const s = sources[idx];
    if (idx === 2 && simulatedError === 'SOURCE_3') {
      sourcesSql += `\n-- SIMULATED ERROR IN SOURCE 3\nDO $$ BEGIN RAISE EXCEPTION 'SIMULATED_FAILURE_IN_MIGRATION_3'; END $$;\n`;
    }
    sourcesSql += `\n-- SOURCE [${idx + 1}/5] ${s.file} (SHA256 ${s.sha256})\n${s.body}\n`;
  }

  // 3. Registry & Fencing DDL in the SAME transaction
  const registrySql = `
-- ============================================================================
-- PRIVATE SELECTIVE-RELEASE REGISTRY & ORDINARY MIGRATION WRITER FENCE
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE IF NOT EXISTS private.selective_feature_releases (
    release_id text PRIMARY KEY,
    feature_name text NOT NULL,
    target_project_ref text NOT NULL,
    source_commit text NOT NULL,
    bundle_sha256 text NOT NULL,
    preconditions_sha256 text NOT NULL,
    postconditions_sha256 text NOT NULL,
    sources jsonb NOT NULL,
    pre_ledger_fingerprint text NOT NULL,
    pre_catalog_fingerprint text NOT NULL,
    post_catalog_fingerprint text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    execution_status text NOT NULL,
    recovery_evidence jsonb NOT NULL,
    reconciled_to_canonical boolean NOT NULL DEFAULT false,
    reconciled_at timestamptz NULL
);

REVOKE ALL ON TABLE private.selective_feature_releases FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE private.selective_feature_releases TO service_role;

-- Insert registry record
INSERT INTO private.selective_feature_releases (
    release_id,
    feature_name,
    target_project_ref,
    source_commit,
    bundle_sha256,
    preconditions_sha256,
    postconditions_sha256,
    sources,
    pre_ledger_fingerprint,
    pre_catalog_fingerprint,
    post_catalog_fingerprint,
    execution_status,
    recovery_evidence
) VALUES (
    ${quote(releaseId)},
    'META_ADS_LEAD_ATTRIBUTION',
    ${quote(targetProject)},
    ${quote(sourceCommit)},
    ${quote(sqlSha256(sourcesSql))},
    ${quote(sqlSha256(preconditions))},
    'PENDING_POSTCONDITIONS',
    ${quote(JSON.stringify(sources.map((s) => ({ file: s.file, sha256: s.sha256, statements_count: s.statementsCount }))))}::jsonb,
    ${quote(preLedgerFingerprint)},
    ${quote(preCatalogFingerprint)},
    ${quote(postCatalogFingerprint)},
    'COMPLETED',
    jsonb_build_object(
      'canonical_ledger_entries_preserved', ${EXPECTED_CANONICAL_LEDGER_COUNT},
      'unapplied_gap_migrations_omitted', 95,
      'approved_objects_diff_count', 365,
      'advisory_lock_key', 'meta-ads-selective-release',
      'fencing_active', true
    )
);

-- Ordinary migration writer fence trigger function
CREATE OR REPLACE FUNCTION supabase_migrations.guard_selective_release_ledger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'private' AND tablename = 'selective_feature_releases'
    ) THEN
      IF EXISTS (
        SELECT 1 FROM private.selective_feature_releases WHERE NOT reconciled_to_canonical
      ) THEN
        RAISE EXCEPTION 'MIGRATION_LEDGER_FENCED: Selective feature release active. Canonical migration push is blocked until formal reconciliation.';
      END IF;
    END IF;
  ELSIF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'MIGRATION_LEDGER_IMMUTABLE: Canonical migration history is append-only and cannot be updated or deleted.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_selective_release_ledger ON supabase_migrations.schema_migrations;
CREATE TRIGGER trg_guard_selective_release_ledger
  BEFORE INSERT OR UPDATE OR DELETE ON supabase_migrations.schema_migrations
  FOR EACH ROW EXECUTE FUNCTION supabase_migrations.guard_selective_release_ledger();
`;

  // 4. Postconditions SQL
  let simulatedPostError = '';
  if (simulatedError === 'POST_DDL') {
    simulatedPostError = `\nCREATE FUNCTION public.unapproved_forbidden_injection() RETURNS void LANGUAGE sql AS 'SELECT 1;';\n`;
  }

  const postconditions = `
${simulatedPostError}
DO $postflight$
DECLARE
  actual jsonb;
  v_table_row record;
  v_count bigint;
  v_digest text;
  excluded text[];
BEGIN
  -- 1. Verify exact expected schema & permissions fingerprint (excluding selective_feature_releases)
  SELECT jsonb_agg(f ORDER BY category) INTO actual FROM (${filteredFingerprint}) f;
  IF actual IS DISTINCT FROM ${quote(JSON.stringify(proof.afterCatalog))}::jsonb THEN
    RAISE EXCEPTION 'META_21_POST_SCHEMA_OR_ACL_MISMATCH';
  END IF;

  -- 2. Verify canonical ledger table is byte-identical (0 writes, 0 deletions)
  IF EXISTS (
    (SELECT * FROM supabase_migrations.schema_migrations EXCEPT SELECT * FROM meta_21_ledger)
    UNION ALL
    (SELECT * FROM meta_21_ledger EXCEPT SELECT * FROM supabase_migrations.schema_migrations)
  ) THEN
    RAISE EXCEPTION 'META_21_LEDGER_CHANGED';
  END IF;

  -- 3. Verify existing row counts and content digests
  FOR v_table_row IN SELECT * FROM meta_21_rows LOOP
    excluded := CASE WHEN v_table_row.name = 'public.customers' THEN ARRAY[${attributionColumns.map(quote).join(',')}] ELSE ARRAY[]::text[] END;
    EXECUTE format(
      'SELECT count(*), encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) - %L::text[] ORDER BY (to_jsonb(t) - %L::text[])::text), ''[]'')::text, ''UTF8'')), ''hex'') FROM %s t',
      excluded, excluded, v_table_row.name
    ) INTO v_count, v_digest;

    IF v_count <> v_table_row.row_count OR v_digest IS DISTINCT FROM v_table_row.digest THEN
      RAISE EXCEPTION 'META_21_EXISTING_ROWS_CHANGED in %', v_table_row.name;
    END IF;
  END LOOP;

  -- 4. Verify no unexpected seed rows in new Meta tables
  IF EXISTS(SELECT 1 FROM private.meta_ad_account_tokens) OR EXISTS(SELECT 1 FROM private.meta_leadgen_events)
    OR EXISTS(SELECT 1 FROM public.meta_ad_accounts) OR EXISTS(SELECT 1 FROM public.meta_campaigns)
    OR EXISTS(SELECT 1 FROM public.meta_ads) OR EXISTS(SELECT 1 FROM public.meta_lead_forms)
    OR EXISTS(SELECT 1 FROM public.lead_attribution_touchpoints) THEN
    RAISE EXCEPTION 'META_21_UNEXPECTED_SEED_DATA';
  END IF;

  -- 5. Verify registry row exists and update postconditions SHA
  UPDATE private.selective_feature_releases
  SET postconditions_sha256 = ${quote(sqlSha256('POSTCONDITIONS_VERIFIED'))}
  WHERE release_id = ${quote(releaseId)};
END $postflight$;

SELECT 'META_SELECTIVE_RELEASE_VERIFIED' AS status,
       count(*) AS preserved_legacy_tables,
       (SELECT count(*) FROM private.selective_feature_releases WHERE release_id = ${quote(releaseId)}) AS registered_releases,
       (SELECT count(*) FROM supabase_migrations.schema_migrations) AS preserved_canonical_ledger_count
FROM meta_21_rows;
`;

  const sql = 'BEGIN;\n' + preconditions + sourcesSql + registrySql + postconditions + '\nCOMMIT;\n';

  return {
    sql,
    preconditions,
    sourcesSql,
    registrySql,
    postconditions,
    targetProject,
    releaseId,
    sourceCommit,
    expectedLedgerCount: EXPECTED_CANONICAL_LEDGER_COUNT,
    bundleSha256: sqlSha256(sourcesSql),
    packageSha256: sqlSha256(sql),
    sources,
  };
}

// ============================================================================
// 1. TARGET PROJECT & CONNECTION VERIFICATION (FAIL-CLOSED, NO LOGGED SECRETS)
// ============================================================================
export interface TargetProjectVerificationResult {
  verified: boolean;
  projectRef: string;
  hostname: string;
  isLocalTest: boolean;
  sanitizedConnectionInfo: string;
}

export function verifyTargetProjectConnection(
  connectionString: string,
  options: { allowLocalTest?: boolean; expectedProjectRef?: string } = {}
): TargetProjectVerificationResult {
  const expectedRef = options.expectedProjectRef ?? TARGET_STAGING_PROJECT;
  assert.ok(connectionString, 'Connection string is required');

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(connectionString);
  } catch {
    throw new Error('TARGET_VERIFICATION_FAILED: Invalid connection URL format. Zero credentials logged.');
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const username = decodeURIComponent(parsedUrl.username).toLowerCase();
  // Sanitize connection info without password or secrets
  const sanitizedInfo = `${username ? `${username.split('.')[0]}@` : ''}${hostname}:${parsedUrl.port || '5432'}${parsedUrl.pathname}`;

  const isLocalHost = ['localhost', '127.0.0.1', '::1', 'host.docker.internal'].includes(hostname);
  if (isLocalHost) {
    if (!options.allowLocalTest) {
      throw new Error(
        `TARGET_PROJECT_MISMATCH: Connection to local host ${hostname} is not permitted for hosted staging execution (expected ${expectedRef}).`
      );
    }
    return {
      verified: true,
      projectRef: 'local-test-fixture',
      hostname,
      isLocalTest: true,
      sanitizedConnectionInfo: sanitizedInfo,
    };
  }

  let detectedRef: string | null = null;
  // Supabase direct connection format: db.<ref>.supabase.co
  const hostMatch = hostname.match(/^db\.([a-z0-9_-]+)\.supabase\.co$/);
  if (hostMatch) {
    detectedRef = hostMatch[1];
  } else if (username.includes('.')) {
    // Supabase pooler format: postgres.<ref>
    const userParts = username.split('.');
    detectedRef = userParts[1];
  }

  if (!detectedRef) {
    throw new Error(
      `TARGET_VERIFICATION_FAILED: Could not extract valid Supabase project ref from host or username at ${sanitizedInfo}. Fail closed.`
    );
  }

  if (detectedRef !== expectedRef) {
    throw new Error(
      `TARGET_PROJECT_MISMATCH: Target project ref ${detectedRef} at ${sanitizedInfo} does not match expected staging project ref ${expectedRef}. Fail closed.`
    );
  }

  return {
    verified: true,
    projectRef: detectedRef,
    hostname,
    isLocalTest: false,
    sanitizedConnectionInfo: sanitizedInfo,
  };
}

// ============================================================================
// 2. POSTGRESQL VERSION ENFORCEMENT
// ============================================================================
export function verifyPostgresServerVersion(serverVersion: string, serverVersionNum: number) {
  if (serverVersionNum < 170000 || serverVersionNum >= 180000) {
    throw new Error(
      `POSTGRES_VERSION_INCOMPATIBLE: Server version ${serverVersion} (num: ${serverVersionNum}) does not match required PostgreSQL 17.x baseline (target ${TARGET_POSTGRES_VERSION}).`
    );
  }
  return true;
}

// ============================================================================
// 3. UNCERTAIN COMMIT RECOVERY STATE MACHINE
// ============================================================================
export type UncertainRecoveryStatus =
  | 'COMMITTED_VERIFIED'
  | 'UNCOMMITTED_CLEAN'
  | 'CORRUPTED_INCONSISTENT';

export interface ReleaseProbeDetails {
  registryTableExists: boolean;
  releaseRecordExists: boolean;
  executionStatus: string | null;
  bundleShaMatch: boolean;
  postconditionsVerified: boolean;
  metaTablesCount: number;
  expectedMetaTablesCount: number;
  canonicalLedgerCount: number;
  expectedCanonicalLedgerCount: number;
  fencingActive: boolean;
}

export interface ReleaseProbeResult {
  status: UncertainRecoveryStatus;
  releaseId: string;
  details: ReleaseProbeDetails;
  recommendation: 'DO_NOT_RERUN' | 'SAFE_TO_EXECUTE' | 'HALT_AND_INVESTIGATE';
  diagnosticSummary: string;
}

export const PROBE_RELEASE_SQL = (releaseId: string) => `
DO $probe$
DECLARE
  v_rec jsonb := NULL;
  v_reg_exists boolean := false;
  v_res jsonb;
BEGIN
  IF to_regclass('private.selective_feature_releases') IS NOT NULL THEN
    v_reg_exists := true;
    EXECUTE 'SELECT row_to_json(r)::jsonb FROM private.selective_feature_releases r WHERE release_id = ' || quote_literal(${quote(releaseId)}) INTO v_rec;
  END IF;
  SELECT jsonb_build_object(
    'registry_table_exists', v_reg_exists,
    'release_record', v_rec,
    'meta_tables_count', (
      SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'private')
        AND c.relname IN ('meta_ad_accounts', 'meta_campaigns', 'meta_ads', 'meta_lead_forms',
                          'lead_attribution_touchpoints', 'meta_ad_account_tokens', 'meta_leadgen_events')
    ),
    'canonical_ledger_count', (
      SELECT count(*) FROM supabase_migrations.schema_migrations
    ),
    'fence_trigger_exists', EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_selective_release_ledger'
    )
  ) INTO v_res;
  PERFORM set_config('meta_probe.result', v_res::text, false);
END $probe$;
SELECT current_setting('meta_probe.result');
`;

export function evaluateReleaseProbe(
  rawProbeResult: {
    registry_table_exists: boolean;
    release_record: Record<string, unknown> | null;
    meta_tables_count: number | string;
    canonical_ledger_count: number | string;
    fence_trigger_exists: boolean;
  },
  releaseId: string,
  expectedBundleSha256: string
): ReleaseProbeResult {
  const rec = rawProbeResult.release_record;
  const bundleShaMatch = rec ? rec.bundle_sha256 === expectedBundleSha256 : false;
  const postconditionsVerified = rec ? rec.postconditions_sha256 === sqlSha256('POSTCONDITIONS_VERIFIED') : false;
  const executionCompleted = rec ? rec.execution_status === 'COMPLETED' : false;

  const details: ReleaseProbeDetails = {
    registryTableExists: rawProbeResult.registry_table_exists,
    releaseRecordExists: rec !== null,
    executionStatus: rec ? String(rec.execution_status) : null,
    bundleShaMatch,
    postconditionsVerified,
    metaTablesCount: Number(rawProbeResult.meta_tables_count),
    expectedMetaTablesCount: 7,
    canonicalLedgerCount: Number(rawProbeResult.canonical_ledger_count),
    expectedCanonicalLedgerCount: EXPECTED_CANONICAL_LEDGER_COUNT,
    fencingActive: rawProbeResult.fence_trigger_exists,
  };

  // Case 1: Release record exists and all conditions match -> COMMITTED_VERIFIED
  if (
    details.releaseRecordExists &&
    executionCompleted &&
    bundleShaMatch &&
    postconditionsVerified &&
    details.metaTablesCount === 7 &&
    details.canonicalLedgerCount === EXPECTED_CANONICAL_LEDGER_COUNT &&
    details.fencingActive
  ) {
    return {
      status: 'COMMITTED_VERIFIED',
      releaseId,
      details,
      recommendation: 'DO_NOT_RERUN',
      diagnosticSummary: `Release ${releaseId} was committed and fully verified. Zero DDL re-execution required.`,
    };
  }

  // Case 2: Clean slate (transaction rolled back or never started)
  if (
    !details.releaseRecordExists &&
    details.metaTablesCount === 0 &&
    details.canonicalLedgerCount === EXPECTED_CANONICAL_LEDGER_COUNT
  ) {
    return {
      status: 'UNCOMMITTED_CLEAN',
      releaseId,
      details,
      recommendation: 'SAFE_TO_EXECUTE',
      diagnosticSummary: `Release ${releaseId} was not committed. Database is in a clean pre-deployment state. Safe to re-run.`,
    };
  }

  // Case 3: Inconsistent or corrupted state -> FAIL CLOSED
  return {
    status: 'CORRUPTED_INCONSISTENT',
    releaseId,
    details,
    recommendation: 'HALT_AND_INVESTIGATE',
    diagnosticSummary: `Release ${releaseId} is in an inconsistent state: releaseRecordExists=${details.releaseRecordExists}, metaTablesCount=${details.metaTablesCount}/7, canonicalLedgerCount=${details.canonicalLedgerCount}/${EXPECTED_CANONICAL_LEDGER_COUNT}, bundleShaMatch=${bundleShaMatch}. Rerunning migrations is BLOCKED.`,
  };
}

// ============================================================================
// 4. CANONICAL RECONCILIATION PACKAGE (DISARMS FENCE & RECORDS META MIGRATIONS)
// ============================================================================
export function buildCanonicalReconciliationPackage(options: {
  releaseId?: string;
  targetProjectRef?: string;
} = {}) {
  const targetProject = options.targetProjectRef ?? TARGET_STAGING_PROJECT;
  const releaseId = options.releaseId ?? 'meta-ads-20261031-r1';

  // Read the 5 canonical source files and verify their pinned hashes
  const metaFiles = META_SOURCES.map((file) => {
    const sql = readFileSync('supabase/migrations/' + file, 'utf8');
    const sha256 = sqlSha256(sql);
    assert.equal(sha256, PINNED_SOURCE_HASHES[file], `Pinned hash mismatch for ${file}`);
    const version = file.slice(0, 14);
    const name = file.slice(15, -4);
    return { file, version, name, sql, sha256 };
  });

  const reconciliationSql = `
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtextextended('meta-ads-selective-release', 0));
LOCK TABLE supabase_migrations.schema_migrations IN EXCLUSIVE MODE;

DO $reconcile_preflight$
BEGIN
  -- 1. Verify release exists and was COMPLETED
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'private' AND tablename = 'selective_feature_releases'
  ) THEN
    RAISE EXCEPTION 'RECONCILIATION_FAILED: private.selective_feature_releases does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM private.selective_feature_releases
    WHERE release_id = ${quote(releaseId)} AND execution_status = 'COMPLETED'
  ) THEN
    RAISE EXCEPTION 'RECONCILIATION_FAILED: Release % not found or not in COMPLETED status', ${quote(releaseId)};
  END IF;

  -- 2. Verify not already reconciled
  IF EXISTS (
    SELECT 1 FROM private.selective_feature_releases
    WHERE release_id = ${quote(releaseId)} AND reconciled_to_canonical
  ) THEN
    RAISE EXCEPTION 'ALREADY_RECONCILED: Release % has already been reconciled to canonical', ${quote(releaseId)};
  END IF;

  -- 3. Verify exactly 21 canonical records currently in ledger
  IF (SELECT count(*) FROM supabase_migrations.schema_migrations) <> ${EXPECTED_CANONICAL_LEDGER_COUNT} THEN
    RAISE EXCEPTION 'CANONICAL_LEDGER_COUNT_MISMATCH: Expected ${EXPECTED_CANONICAL_LEDGER_COUNT} records before reconciliation, found %',
      (SELECT count(*) FROM supabase_migrations.schema_migrations);
  END IF;
END $reconcile_preflight$;

-- 1. Mark release reconciled in private registry
UPDATE private.selective_feature_releases
SET reconciled_to_canonical = true,
    reconciled_at = clock_timestamp(),
    recovery_evidence = recovery_evidence || jsonb_build_object(
      'reconciled', true,
      'reconciliation_canonical_migrations_added', 5,
      'reconciliation_timestamp', clock_timestamp()
    )
WHERE release_id = ${quote(releaseId)};

-- 2. Disarm ordinary migration writer fence trigger
DROP TRIGGER IF EXISTS trg_guard_selective_release_ledger ON supabase_migrations.schema_migrations;
DROP FUNCTION IF EXISTS supabase_migrations.guard_selective_release_ledger();

-- 3. Record the 5 already-executed Meta migrations into canonical schema_migrations
${metaFiles
  .map(
    (m) => `
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES (${quote(m.version)}, ${quote(m.name)}, ARRAY[${quote(m.sql)}]);`
  )
  .join('\n')}

DO $reconcile_postflight$
BEGIN
  -- Verify ledger now contains 21 + 5 = 26 records
  IF (SELECT count(*) FROM supabase_migrations.schema_migrations) <> (${EXPECTED_CANONICAL_LEDGER_COUNT} + 5) THEN
    RAISE EXCEPTION 'RECONCILIATION_POST_COUNT_MISMATCH: Expected 26 canonical ledger records, found %',
      (SELECT count(*) FROM supabase_migrations.schema_migrations);
  END IF;
END $reconcile_postflight$;

SELECT 'META_RECONCILIATION_SUCCESSFUL' AS status,
       (SELECT count(*) FROM supabase_migrations.schema_migrations) AS total_canonical_records,
       (SELECT reconciled_to_canonical FROM private.selective_feature_releases WHERE release_id = ${quote(releaseId)}) AS reconciled;

COMMIT;
`;

  return {
    sql: reconciliationSql,
    metaFiles,
    releaseId,
    targetProject,
  };
}
