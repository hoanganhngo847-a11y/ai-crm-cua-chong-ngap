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
 *            - relation comments and column comments (detects missing, extra, and text differences)
 *            Handles null vs present mismatches properly across all fields.
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

  // Helper for string comparison (handles null/undefined vs string)
  const compareStrings = (val1, val2) => {
    const s1 = typeof val1 === 'string' ? val1.trim() : null;
    const s2 = typeof val2 === 'string' ? val2.trim() : null;
    return s1 === s2;
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
    if (tgt.valid !== src.valid) {
      discrepancies.push({
        kind: 'index',
        identity: key,
        field: 'valid',
        sourceValue: src.valid,
        targetValue: tgt.valid,
        reason: `Target index validity mismatch (expected ${src.valid}, found ${tgt.valid})`,
      });
      matched = false;
    }
    if (tgt.ready !== src.ready) {
      discrepancies.push({
        kind: 'index',
        identity: key,
        field: 'ready',
        sourceValue: src.ready,
        targetValue: tgt.ready,
        reason: `Target index ready state mismatch (expected ${src.ready}, found ${tgt.ready})`,
      });
      matched = false;
    }
    if (tgt.live !== src.live) {
      discrepancies.push({
        kind: 'index',
        identity: key,
        field: 'live',
        sourceValue: src.live,
        targetValue: tgt.live,
        reason: `Target index live state mismatch (expected ${src.live}, found ${tgt.live})`,
      });
      matched = false;
    }
    if (tgt.unique !== src.unique) {
      discrepancies.push({
        kind: 'index',
        identity: key,
        field: 'unique',
        sourceValue: src.unique,
        targetValue: tgt.unique,
        reason: `Target index unique flag mismatch (expected ${src.unique}, found ${tgt.unique})`,
      });
      matched = false;
    }
    if (tgt.primary !== src.primary) {
      discrepancies.push({
        kind: 'index',
        identity: key,
        field: 'primary',
        sourceValue: src.primary,
        targetValue: tgt.primary,
        reason: `Target index primary flag mismatch (expected ${src.primary}, found ${tgt.primary})`,
      });
      matched = false;
    }

    // Check definition (properly handling null vs string)
    if (!compareStrings(src.definition, tgt.definition)) {
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

    if (src.validated !== tgt.validated) {
      discrepancies.push({
        kind: 'constraint',
        identity: key,
        field: 'validated',
        sourceValue: src.validated,
        targetValue: tgt.validated,
        reason: `Target constraint validated mismatch (expected ${src.validated}, found ${tgt.validated})`,
      });
      matched = false;
    }
    if (src.deferrable !== tgt.deferrable) {
      discrepancies.push({
        kind: 'constraint',
        identity: key,
        field: 'deferrable',
        sourceValue: src.deferrable,
        targetValue: tgt.deferrable,
        reason: `Target constraint deferrable mismatch (expected ${src.deferrable}, found ${tgt.deferrable})`,
      });
      matched = false;
    }
    if (src.initiallyDeferred !== tgt.initiallyDeferred) {
      discrepancies.push({
        kind: 'constraint',
        identity: key,
        field: 'initiallyDeferred',
        sourceValue: src.initiallyDeferred,
        targetValue: tgt.initiallyDeferred,
        reason: `Target constraint initiallyDeferred mismatch (expected ${src.initiallyDeferred}, found ${tgt.initiallyDeferred})`,
      });
      matched = false;
    }

    // Check definition (null vs string)
    if (!compareStrings(src.definition, tgt.definition)) {
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
    const srcConfig = Array.isArray(src.config) ? src.config.slice().sort().join(';') : (src.config || null);
    const tgtConfig = Array.isArray(tgt.config) ? tgt.config.slice().sort().join(';') : (tgt.config || null);
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

    // Check ACL
    if (!compareStrings(src.acl, tgt.acl)) {
      discrepancies.push({
        kind: 'routine',
        identity: key,
        field: 'acl',
        sourceValue: src.acl,
        targetValue: tgt.acl,
        reason: 'Routine ACL privileges mismatch',
      });
      matched = false;
    }

    // Check language
    if (!compareStrings(src.language, tgt.language)) {
      discrepancies.push({
        kind: 'routine',
        identity: key,
        field: 'language',
        sourceValue: src.language,
        targetValue: tgt.language,
        reason: 'Routine implementation language mismatch',
      });
      matched = false;
    }

    // Check comment
    if (!compareStrings(src.comment, tgt.comment)) {
      discrepancies.push({
        kind: 'routine',
        identity: key,
        field: 'comment',
        sourceValue: src.comment,
        targetValue: tgt.comment,
        reason: 'Routine comment description mismatch',
      });
      matched = false;
    }

    // Check definition (null vs string)
    if (!compareStrings(src.definition, tgt.definition)) {
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

  // 5. Compare Relation Comments
  const sourceRelComments = Array.isArray(source.relationComments) ? source.relationComments : [];
  const targetRelComments = Array.isArray(target.relationComments) ? target.relationComments : [];
  summary.relationComments.sourceCount = sourceRelComments.length;
  summary.relationComments.targetCount = targetRelComments.length;

  const targetRelCommentMap = new Map();
  for (const c of targetRelComments) {
    targetRelCommentMap.set(`${c.schema}.${c.relation}`, c.comment);
  }

  const seenTargetRelComments = new Set();
  for (const src of sourceRelComments) {
    const key = `${src.schema}.${src.relation}`;
    const tgtComment = targetRelCommentMap.get(key);
    seenTargetRelComments.add(key);

    if (tgtComment === undefined) {
      discrepancies.push({
        kind: 'relationComment',
        identity: key,
        field: 'existence',
        sourceValue: 'present',
        targetValue: 'missing',
        reason: 'Relation comment is missing in target database',
      });
      summary.relationComments.discrepancyCount++;
    } else if (!compareStrings(src.comment, tgtComment)) {
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

  for (const [key, tgtComment] of targetRelCommentMap) {
    if (!seenTargetRelComments.has(key)) {
      discrepancies.push({
        kind: 'relationComment',
        identity: key,
        field: 'existence',
        sourceValue: 'missing',
        targetValue: tgtComment,
        reason: 'Extra unexpected relation comment in target database',
      });
      summary.relationComments.discrepancyCount++;
    }
  }

  // 6. Compare Column Comments
  const sourceColComments = Array.isArray(source.columnComments) ? source.columnComments : [];
  const targetColComments = Array.isArray(target.columnComments) ? target.columnComments : [];
  summary.columnComments.sourceCount = sourceColComments.length;
  summary.columnComments.targetCount = targetColComments.length;

  const targetColCommentMap = new Map();
  for (const c of targetColComments) {
    targetColCommentMap.set(`${c.schema}.${c.relation}.${c.column}`, c.comment);
  }

  const seenTargetColComments = new Set();
  for (const src of sourceColComments) {
    const key = `${src.schema}.${src.relation}.${src.column}`;
    const tgtComment = targetColCommentMap.get(key);
    seenTargetColComments.add(key);

    if (tgtComment === undefined) {
      discrepancies.push({
        kind: 'columnComment',
        identity: key,
        field: 'existence',
        sourceValue: 'present',
        targetValue: 'missing',
        reason: 'Column comment is missing in target database',
      });
      summary.columnComments.discrepancyCount++;
    } else if (!compareStrings(src.comment, tgtComment)) {
      discrepancies.push({
        kind: 'columnComment',
        identity: key,
        field: 'comment',
        sourceValue: src.comment,
        targetValue: tgtComment,
        reason: 'Column comment mismatch',
      });
      summary.columnComments.discrepancyCount++;
    } else {
      summary.columnComments.matchedCount++;
    }
  }

  for (const [key, tgtComment] of targetColCommentMap) {
    if (!seenTargetColComments.has(key)) {
      discrepancies.push({
        kind: 'columnComment',
        identity: key,
        field: 'existence',
        sourceValue: 'missing',
        targetValue: tgtComment,
        reason: 'Extra unexpected column comment in target database',
      });
      summary.columnComments.discrepancyCount++;
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
        summary.relationComments.sourceCount +
        summary.columnComments.sourceCount,
      totalTargetObjects:
        summary.indexes.targetCount +
        summary.constraints.targetCount +
        summary.routines.targetCount +
        summary.sequences.targetCount +
        summary.relationComments.targetCount +
        summary.columnComments.targetCount,
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
