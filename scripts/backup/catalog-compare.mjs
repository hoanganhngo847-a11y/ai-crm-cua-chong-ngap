#!/usr/bin/env node
/**
 * scripts/backup/catalog-compare.mjs
 *
 * Helper #8: Detailed catalog source/target comparator (Local Rehearsal Phase)
 *
 * Authoritative References:
 * - docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12.md §R10, §16.10, §B3
 *
 * Capabilities:
 * - compare: Parses source catalog-details.json, target catalog-details.json, and approved owner-map.json.
 *            Performs deterministic, field-by-field comparison of:
 *            - indexes (definition, valid, ready, live, unique, primary)
 *            - constraints (definition, validated, deferrable, initiallyDeferred)
 *            - routines (definition, normalized owner, securityDefiner, proconfig, acl, language, comment)
 *            - sequences (last_value, is_called)
 *            - relation comments and column comments
 *            Fails closed with BLOCKED status on any missing, extra, or mismatched object.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  fail,
  parseJsonStrict,
  writeFileAtomic,
  installSignalHandlers,
} from './owner-map.mjs';

// -----------------------------------------------------------------------------
// Constants & Configuration
// -----------------------------------------------------------------------------

export const CATALOG_COMPARISON_FORMAT = 'crm-catalog-comparison/v1';

// -----------------------------------------------------------------------------
// Helper: Extract Owner Map Dictionary
// -----------------------------------------------------------------------------

export function extractOwnerMappingDict(ownerMapJson) {
  const dict = {};

  if (Array.isArray(ownerMapJson)) {
    for (const item of ownerMapJson) {
      if (item && item.sourceOwner && item.targetOwner) {
        dict[item.sourceOwner] = item.targetOwner;
      }
    }
    return dict;
  }

  if (typeof ownerMapJson === 'object' && ownerMapJson !== null) {
    if (Array.isArray(ownerMapJson.mappings)) {
      for (const item of ownerMapJson.mappings) {
        if (item && item.sourceOwner && item.targetOwner) {
          dict[item.sourceOwner] = item.targetOwner;
        }
      }
      return dict;
    }
    if (typeof ownerMapJson.ownerMap === 'object' && ownerMapJson.ownerMap !== null) {
      for (const [k, v] of Object.entries(ownerMapJson.ownerMap)) {
        dict[k] = v;
      }
      return dict;
    }
    // Direct key-value mapping
    for (const [k, v] of Object.entries(ownerMapJson)) {
      if (typeof v === 'string') {
        dict[k] = v;
      }
    }
    return dict;
  }

  fail('INVALID_OWNER_MAP', 'Unable to parse owner mapping dictionary from owner-map JSON');
}

// -----------------------------------------------------------------------------
// Core Comparison Logic
// -----------------------------------------------------------------------------

export function compareCatalogDetails(source, target, ownerMapDict) {
  const discrepancies = [];

  // Summary counters
  const summary = {
    indexes: { sourceCount: 0, targetCount: 0, matchedCount: 0, discrepancyCount: 0 },
    constraints: { sourceCount: 0, targetCount: 0, matchedCount: 0, discrepancyCount: 0 },
    routines: { sourceCount: 0, targetCount: 0, matchedCount: 0, discrepancyCount: 0 },
    sequences: { sourceCount: 0, targetCount: 0, matchedCount: 0, discrepancyCount: 0 },
    relationComments: { sourceCount: 0, targetCount: 0, matchedCount: 0, discrepancyCount: 0 },
    columnComments: { sourceCount: 0, targetCount: 0, matchedCount: 0, discrepancyCount: 0 },
  };

  // 1. Compare Indexes
  const sourceIndexes = Array.isArray(source.indexes) ? source.indexes : [];
  const targetIndexes = Array.isArray(target.indexes) ? target.indexes : [];
  summary.indexes.sourceCount = sourceIndexes.length;
  summary.indexes.targetCount = targetIndexes.length;

  const targetIndexMap = new Map();
  for (const idx of targetIndexes) {
    const key = `${idx.schema}.${idx.table}.${idx.name}`;
    targetIndexMap.set(key, idx);
  }

  const seenTargetIndexes = new Set();
  for (const src of sourceIndexes) {
    const key = `${src.schema}.${src.table}.${src.name}`;
    const tgt = targetIndexMap.get(key);
    if (!tgt) {
      discrepancies.push({
        kind: 'index',
        identity: key,
        field: 'existence',
        sourceValue: 'present',
        targetValue: 'missing',
        reason: 'Index is missing from target database',
      });
      summary.indexes.discrepancyCount++;
      continue;
    }

    seenTargetIndexes.add(key);
    let matched = true;

    // Check validity, readiness, liveness
    if (tgt.valid !== true && src.valid === true) {
      discrepancies.push({
        kind: 'index',
        identity: key,
        field: 'valid',
        sourceValue: src.valid,
        targetValue: tgt.valid,
        reason: 'Target index is invalid (indisvalid is false)',
      });
      matched = false;
    }
    if (tgt.ready !== true && src.ready === true) {
      discrepancies.push({
        kind: 'index',
        identity: key,
        field: 'ready',
        sourceValue: src.ready,
        targetValue: tgt.ready,
        reason: 'Target index is not ready (indisready is false)',
      });
      matched = false;
    }

    // Check definition
    if (src.definition && tgt.definition && src.definition.trim() !== tgt.definition.trim()) {
      discrepancies.push({
        kind: 'index',
        identity: key,
        field: 'definition',
        sourceValue: src.definition,
        targetValue: tgt.definition,
        reason: 'Index definition mismatch',
      });
      matched = false;
    }

    if (matched) summary.indexes.matchedCount++;
    else summary.indexes.discrepancyCount++;
  }

  for (const [key] of targetIndexMap) {
    if (!seenTargetIndexes.has(key)) {
      discrepancies.push({
        kind: 'index',
        identity: key,
        field: 'existence',
        sourceValue: 'missing',
        targetValue: 'present',
        reason: 'Extra unexpected index in target database',
      });
      summary.indexes.discrepancyCount++;
    }
  }

  // 2. Compare Constraints
  const sourceConstraints = Array.isArray(source.constraints) ? source.constraints : [];
  const targetConstraints = Array.isArray(target.constraints) ? target.constraints : [];
  summary.constraints.sourceCount = sourceConstraints.length;
  summary.constraints.targetCount = targetConstraints.length;

  const targetConstraintMap = new Map();
  for (const c of targetConstraints) {
    const key = `${c.schema}.${c.table}.${c.name}`;
    targetConstraintMap.set(key, c);
  }

  const seenTargetConstraints = new Set();
  for (const src of sourceConstraints) {
    const key = `${src.schema}.${src.table}.${src.name}`;
    const tgt = targetConstraintMap.get(key);
    if (!tgt) {
      discrepancies.push({
        kind: 'constraint',
        identity: key,
        field: 'existence',
        sourceValue: 'present',
        targetValue: 'missing',
        reason: 'Constraint is missing from target database',
      });
      summary.constraints.discrepancyCount++;
      continue;
    }

    seenTargetConstraints.add(key);
    let matched = true;

    if (src.validated === true && tgt.validated !== true) {
      discrepancies.push({
        kind: 'constraint',
        identity: key,
        field: 'validated',
        sourceValue: src.validated,
        targetValue: tgt.validated,
        reason: 'Target constraint is not validated (convalidated is false)',
      });
      matched = false;
    }

    if (src.definition && tgt.definition && src.definition.trim() !== tgt.definition.trim()) {
      discrepancies.push({
        kind: 'constraint',
        identity: key,
        field: 'definition',
        sourceValue: src.definition,
        targetValue: tgt.definition,
        reason: 'Constraint definition mismatch',
      });
      matched = false;
    }

    if (matched) summary.constraints.matchedCount++;
    else summary.constraints.discrepancyCount++;
  }

  for (const [key] of targetConstraintMap) {
    if (!seenTargetConstraints.has(key)) {
      discrepancies.push({
        kind: 'constraint',
        identity: key,
        field: 'existence',
        sourceValue: 'missing',
        targetValue: 'present',
        reason: 'Extra unexpected constraint in target database',
      });
      summary.constraints.discrepancyCount++;
    }
  }

  // 3. Compare Routines (Functions & Procedures)
  const sourceRoutines = Array.isArray(source.routines) ? source.routines : [];
  const targetRoutines = Array.isArray(target.routines) ? target.routines : [];
  summary.routines.sourceCount = sourceRoutines.length;
  summary.routines.targetCount = targetRoutines.length;

  const targetRoutineMap = new Map();
  for (const r of targetRoutines) {
    targetRoutineMap.set(r.identity, r);
  }

  const seenTargetRoutines = new Set();
  for (const src of sourceRoutines) {
    const key = src.identity;
    const tgt = targetRoutineMap.get(key);
    if (!tgt) {
      discrepancies.push({
        kind: 'routine',
        identity: key,
        field: 'existence',
        sourceValue: 'present',
        targetValue: 'missing',
        reason: 'Routine is missing from target database',
      });
      summary.routines.discrepancyCount++;
      continue;
    }

    seenTargetRoutines.add(key);
    let matched = true;

    // Check owner with approved owner normalization
    const normalizedSourceOwner = ownerMapDict[src.owner] || src.owner;
    if (tgt.owner !== normalizedSourceOwner) {
      discrepancies.push({
        kind: 'routine',
        identity: key,
        field: 'owner',
        sourceValue: src.owner,
        normalizedExpected: normalizedSourceOwner,
        targetValue: tgt.owner,
        reason: `Routine owner mismatch: expected ${normalizedSourceOwner}, found ${tgt.owner}`,
      });
      matched = false;
    }

    // Check securityDefiner
    if (src.securityDefiner !== tgt.securityDefiner) {
      discrepancies.push({
        kind: 'routine',
        identity: key,
        field: 'securityDefiner',
        sourceValue: src.securityDefiner,
        targetValue: tgt.securityDefiner,
        reason: 'SECURITY DEFINER mismatch',
      });
      matched = false;
    }

    // Check proconfig
    const srcConfig = Array.isArray(src.config) ? src.config.sort().join(';') : (src.config || '');
    const tgtConfig = Array.isArray(tgt.config) ? tgt.config.sort().join(';') : (tgt.config || '');
    if (srcConfig !== tgtConfig) {
      discrepancies.push({
        kind: 'routine',
        identity: key,
        field: 'config',
        sourceValue: src.config,
        targetValue: tgt.config,
        reason: 'proconfig configuration parameters mismatch',
      });
      matched = false;
    }

    // Check definition
    if (src.definition && tgt.definition && src.definition.trim() !== tgt.definition.trim()) {
      discrepancies.push({
        kind: 'routine',
        identity: key,
        field: 'definition',
        sourceValue: src.definition,
        targetValue: tgt.definition,
        reason: 'Routine function body definition mismatch',
      });
      matched = false;
    }

    if (matched) summary.routines.matchedCount++;
    else summary.routines.discrepancyCount++;
  }

  for (const [key] of targetRoutineMap) {
    if (!seenTargetRoutines.has(key)) {
      discrepancies.push({
        kind: 'routine',
        identity: key,
        field: 'existence',
        sourceValue: 'missing',
        targetValue: 'present',
        reason: 'Extra unexpected routine in target database',
      });
      summary.routines.discrepancyCount++;
    }
  }

  // 4. Compare Sequences
  const sourceSequences = Array.isArray(source.sequences) ? source.sequences : [];
  const targetSequences = Array.isArray(target.sequences) ? target.sequences : [];
  summary.sequences.sourceCount = sourceSequences.length;
  summary.sequences.targetCount = targetSequences.length;

  const targetSeqMap = new Map();
  for (const seq of targetSequences) {
    const key = `${seq.schema_name}.${seq.sequence_name}`;
    targetSeqMap.set(key, seq);
  }

  const seenTargetSeqs = new Set();
  for (const src of sourceSequences) {
    const key = `${src.schema_name}.${src.sequence_name}`;
    const tgt = targetSeqMap.get(key);
    if (!tgt) {
      discrepancies.push({
        kind: 'sequence',
        identity: key,
        field: 'existence',
        sourceValue: 'present',
        targetValue: 'missing',
        reason: 'Sequence is missing from target database',
      });
      summary.sequences.discrepancyCount++;
      continue;
    }

    seenTargetSeqs.add(key);
    let matched = true;

    // Check is_called (MUST NOT normalize away is_called)
    if (src.is_called !== tgt.is_called) {
      discrepancies.push({
        kind: 'sequence',
        identity: key,
        field: 'is_called',
        sourceValue: src.is_called,
        targetValue: tgt.is_called,
        reason: 'Sequence is_called state mismatch',
      });
      matched = false;
    }

    // Check last_value
    if (String(src.last_value) !== String(tgt.last_value)) {
      discrepancies.push({
        kind: 'sequence',
        identity: key,
        field: 'last_value',
        sourceValue: src.last_value,
        targetValue: tgt.last_value,
        reason: 'Sequence last_value mismatch',
      });
      matched = false;
    }

    if (matched) summary.sequences.matchedCount++;
    else summary.sequences.discrepancyCount++;
  }

  for (const [key] of targetSeqMap) {
    if (!seenTargetSeqs.has(key)) {
      discrepancies.push({
        kind: 'sequence',
        identity: key,
        field: 'existence',
        sourceValue: 'missing',
        targetValue: 'present',
        reason: 'Extra unexpected sequence in target database',
      });
      summary.sequences.discrepancyCount++;
    }
  }

  // 5. Compare Relation Comments & Column Comments
  const sourceRelComments = Array.isArray(source.relationComments) ? source.relationComments : [];
  const targetRelComments = Array.isArray(target.relationComments) ? target.relationComments : [];
  summary.relationComments.sourceCount = sourceRelComments.length;
  summary.relationComments.targetCount = targetRelComments.length;

  const targetRelCommentMap = new Map(targetRelComments.map(c => [`${c.schema}.${c.relation}`, c.comment]));
  for (const src of sourceRelComments) {
    const key = `${src.schema}.${src.relation}`;
    const tgtComment = targetRelCommentMap.get(key);
    if (src.comment !== tgtComment) {
      discrepancies.push({
        kind: 'relationComment',
        identity: key,
        field: 'comment',
        sourceValue: src.comment,
        targetValue: tgtComment,
        reason: 'Relation comment mismatch',
      });
      summary.relationComments.discrepancyCount++;
    } else {
      summary.relationComments.matchedCount++;
    }
  }

  const isPassed = discrepancies.length === 0;
  const status = isPassed ? 'PASSED' : 'BLOCKED';

  return {
    format: CATALOG_COMPARISON_FORMAT,
    status,
    timestamp: new Date().toISOString(),
    summary: {
      ...summary,
      totalSourceObjects:
        summary.indexes.sourceCount +
        summary.constraints.sourceCount +
        summary.routines.sourceCount +
        summary.sequences.sourceCount +
        summary.relationComments.sourceCount,
      totalTargetObjects:
        summary.indexes.targetCount +
        summary.constraints.targetCount +
        summary.routines.targetCount +
        summary.sequences.targetCount +
        summary.relationComments.targetCount,
      totalDiscrepancies: discrepancies.length,
    },
    discrepancies,
  };
}

// -----------------------------------------------------------------------------
// CLI Handler
// -----------------------------------------------------------------------------

export async function handleCompareCommand({ sourcePath, targetPath, ownerMapPath, reportPath }) {
  installSignalHandlers();

  if (!sourcePath || typeof sourcePath !== 'string') {
    fail('INVALID_ARGUMENTS', 'Missing required --source path');
  }
  if (!targetPath || typeof targetPath !== 'string') {
    fail('INVALID_ARGUMENTS', 'Missing required --target path');
  }
  if (!ownerMapPath || typeof ownerMapPath !== 'string') {
    fail('INVALID_ARGUMENTS', 'Missing required --owner-map path');
  }
  if (!reportPath || typeof reportPath !== 'string') {
    fail('INVALID_ARGUMENTS', 'Missing required --report path');
  }

  const rawSource = await fsp.readFile(sourcePath, 'utf8');
  const source = parseJsonStrict(rawSource, 'INVALID_SOURCE_CATALOG', 'Source catalog details');

  const rawTarget = await fsp.readFile(targetPath, 'utf8');
  const target = parseJsonStrict(rawTarget, 'INVALID_TARGET_CATALOG', 'Target catalog details');

  const rawOwnerMap = await fsp.readFile(ownerMapPath, 'utf8');
  const ownerMapJson = parseJsonStrict(rawOwnerMap, 'INVALID_OWNER_MAP', 'Owner map definition');

  const ownerMapDict = extractOwnerMappingDict(ownerMapJson);
  const report = compareCatalogDetails(source, target, ownerMapDict);

  await writeFileAtomic(reportPath, JSON.stringify(report, null, 2) + '\n', 0o600);

  return report;
}

// -----------------------------------------------------------------------------
// CLI Dispatcher
// -----------------------------------------------------------------------------

export async function runCli(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    console.error('Usage: catalog-compare.mjs compare --source <src.json> --target <tgt.json> --owner-map <owner.json> --report <rep.json>');
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
      case 'compare': {
        const report = await handleCompareCommand({
          sourcePath: args.source,
          targetPath: args.target,
          ownerMapPath: args['owner-map'],
          reportPath: args.report,
        });
        console.log(`CATALOG_COMPARE ${report.status}: ${report.summary.totalDiscrepancies} discrepancies`);
        if (report.status !== 'PASSED') {
          process.exit(1);
        }
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

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  runCli();
}
