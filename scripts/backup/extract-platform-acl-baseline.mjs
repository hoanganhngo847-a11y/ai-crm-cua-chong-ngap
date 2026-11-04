#!/usr/bin/env node
/**
 * scripts/backup/extract-platform-acl-baseline.mjs
 *
 * Reproducible extraction tool for PostgreSQL 17 / Supabase Platform ACL Baseline.
 * Queries pg_catalog and information_schema on a clean Supabase PostgreSQL 17 instance
 * to generate the authoritative, deterministic baseline for all 38 platform relations
 * and 362 columns across `auth` and `storage`.
 *
 * Metadata:
 * - Engine: PostgreSQL 17.11
 * - Image: public.ecr.aws/supabase/postgres:17.11.0.002
 * - Image Digest: sha256:0450166354dc9c1d25f0322ac8b580774d4fb0184d2b087f6e4fe9499c66cf53
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const EXPECTED_POSTGRES_VERSION = '17.11';
export const EXPECTED_SUPABASE_IMAGE = 'public.ecr.aws/supabase/postgres:17.11.0.002';
export const EXPECTED_IMAGE_DIGEST =
  'sha256:0450166354dc9c1d25f0322ac8b580774d4fb0184d2b087f6e4fe9499c66cf53';
export const EXPECTED_RELATION_COUNT = 38;
export const EXPECTED_COLUMN_COUNT = 362;

export const SQL_RELATIONS = `
SELECT
  n.nspname || '.' || c.relname as identity,
  n.nspname as schema,
  c.relname as table,
  c.relacl IS NULL as acl_is_null,
  coalesce((
    SELECT json_agg(json_build_object(
      'grantee', CASE x.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
      'grantor', pg_get_userbyid(x.grantor),
      'privilegeType', x.privilege_type,
      'isGrantable', x.is_grantable
    ) ORDER BY x.grantee, x.grantor, x.privilege_type, x.is_grantable)
    FROM aclexplode(c.relacl) AS x
  ), '[]'::json) as entries
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('auth', 'storage') AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
ORDER BY identity
`;

export const SQL_COLUMNS = `
SELECT
  n.nspname || '.' || c.relname || '.' || a.attname as identity,
  n.nspname as schema,
  c.relname as table,
  a.attname as column,
  a.attacl IS NULL as acl_is_null,
  coalesce((
    SELECT json_agg(json_build_object(
      'grantee', CASE x.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
      'grantor', pg_get_userbyid(x.grantor),
      'privilegeType', x.privilege_type,
      'isGrantable', x.is_grantable
    ) ORDER BY x.grantee, x.grantor, x.privilege_type, x.is_grantable)
    FROM aclexplode(a.attacl) AS x
  ), '[]'::json) as entries
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('auth', 'storage')
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY identity
`;

export function extractBaselineFromContainer(containerName = 'supabase_db_ai-crm-cua-chong-ngap') {
  const queryPsql = (sql) => {
    const raw = execFileSync(
      'docker',
      [
        'exec',
        '-i',
        containerName,
        'psql',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-XqAt',
        '-c',
        `SELECT json_agg(t) FROM (${sql}) t;`,
      ],
      { encoding: 'utf8' }
    ).trim();
    return JSON.parse(raw || '[]');
  };

  const relationsList = queryPsql(SQL_RELATIONS);
  const columnsList = queryPsql(SQL_COLUMNS);

  if (relationsList.length !== EXPECTED_RELATION_COUNT) {
    throw new Error(
      `Relation count mismatch: expected ${EXPECTED_RELATION_COUNT}, got ${relationsList.length}`
    );
  }
  if (columnsList.length !== EXPECTED_COLUMN_COUNT) {
    throw new Error(
      `Column count mismatch: expected ${EXPECTED_COLUMN_COUNT}, got ${columnsList.length}`
    );
  }

  const relationsDict = {};
  for (const r of relationsList) {
    relationsDict[r.identity] = {
      schema: r.schema,
      table: r.table,
      aclIsNull: r.acl_is_null,
      entries: r.entries,
    };
  }

  const columnsDict = {};
  for (const c of columnsList) {
    columnsDict[c.identity] = {
      schema: c.schema,
      table: c.table,
      column: c.column,
      aclIsNull: c.acl_is_null,
      entries: c.entries,
    };
  }

  const payloadToHash = JSON.stringify({ relations: relationsDict, columns: columnsDict });
  const outputSha256 = createHash('sha256').update(payloadToHash, 'utf8').digest('hex');

  const baseline = {
    _metadata: {
      format: 'crm-platform-acl-baseline/v2',
      postgresVersion: EXPECTED_POSTGRES_VERSION,
      supabaseImage: EXPECTED_SUPABASE_IMAGE,
      imageDigest: EXPECTED_IMAGE_DIGEST,
      totalRelations: relationsList.length,
      totalColumns: columnsList.length,
      extractionScript: 'scripts/backup/extract-platform-acl-baseline.mjs',
      outputSha256,
    },
    relations: relationsDict,
    columns: columnsDict,
    // Maintain top-level relation keys for backwards compatibility with v1 lookups
    ...relationsDict,
  };

  return baseline;
}

if (process.argv[1]?.endsWith('extract-platform-acl-baseline.mjs')) {
  try {
    const outPath = path.resolve(__dirname, 'platform-acl-baseline.json');
    const container = process.argv[2] || 'supabase_db_ai-crm-cua-chong-ngap';
    const baseline = extractBaselineFromContainer(container);
    fs.writeFileSync(outPath, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
    console.log(`Successfully generated platform ACL baseline at ${outPath}`);
    console.log(`Relations: ${baseline._metadata.totalRelations}, Columns: ${baseline._metadata.totalColumns}`);
    console.log(`Output SHA256: ${baseline._metadata.outputSha256}`);
  } catch (err) {
    console.error('Extraction failed:', err.message);
    process.exit(1);
  }
}
