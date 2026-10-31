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
export const CURRENT_SOURCE_COMMIT = '25e8f21c896fc2acb61f041f464d077c52793271';

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
  simulatedInjectedError?: 'NONE' | 'WRONG_PROJECT' | 'SOURCE_3' | 'POST_DDL';
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
    bundleSha256: sqlSha256(sql),
    sources,
  };
}

