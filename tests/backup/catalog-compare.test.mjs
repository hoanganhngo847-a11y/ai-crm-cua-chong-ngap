import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import {
  CATALOG_COMPARISON_FORMAT,
  extractOwnerMappingDict,
  compareCatalogDetails,
  validateCatalogSchema,
  compareStrings,
} from '../../scripts/backup/catalog-compare.mjs';

function makeIndex(overrides = {}) {
  return {
    schema: 'public',
    table: 'tbl',
    name: 'idx',
    definition: 'CREATE INDEX idx ON public.tbl(id)',
    valid: true,
    ready: true,
    live: true,
    unique: false,
    primary: false,
    ...overrides,
  };
}

function makeConstraint(overrides = {}) {
  return {
    schema: 'public',
    table: 'tbl',
    name: 'chk',
    definition: 'CHECK (1=1)',
    validated: true,
    deferrable: false,
    initiallyDeferred: false,
    ...overrides,
  };
}

function makeRoutine(overrides = {}) {
  return {
    schema: 'public',
    identity: 'public.my_func()',
    definition: 'SELECT 1;',
    owner: 'postgres',
    securityDefiner: false,
    config: null,
    acl: null,
    language: 'sql',
    comment: null,
    ...overrides,
  };
}

function makeSequence(overrides = {}) {
  return {
    schema_name: 'public',
    sequence_name: 'seq',
    last_value: 10,
    is_called: true,
    ...overrides,
  };
}

function makeRelationComment(overrides = {}) {
  return {
    schema: 'public',
    relation: 'tbl',
    comment: 'Table comment',
    ...overrides,
  };
}

function makeColumnComment(overrides = {}) {
  return {
    schema: 'public',
    relation: 'tbl',
    column: 'col',
    comment: 'Column comment',
    ...overrides,
  };
}

function makeCanonicalCatalog(overrides = {}) {
  return {
    indexes: [],
    constraints: [],
    routines: [],
    sequences: [],
    relationComments: [],
    columnComments: [],
    ...overrides,
  };
}

async function createTempDir(prefix = 'catalog-comp-test-') {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function removeTempDir(dirPath) {
  try {
    await fsp.rm(dirPath, { recursive: true, force: true });
  } catch {
    // Best-effort
  }
}

function runCli(args) {
  return new Promise((resolve) => {
    const cliPath = path.resolve('scripts/backup/catalog-compare.mjs');
    const child = spawn(process.execPath, [cliPath, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test('catalog-compare helper suite', async (t) => {
  await t.test('extractOwnerMappingDict handles various owner map formats', () => {
    const arrayFormat = [
      { sourceOwner: 'postgres', targetOwner: 'supabase_admin' },
      { sourceOwner: 'old_role', targetOwner: 'new_role' },
    ];
    assert.deepEqual(extractOwnerMappingDict(arrayFormat), {
      postgres: 'supabase_admin',
      old_role: 'new_role',
    });

    const v1Format = {
      format: 'crm-owner-map/v1',
      mappings: [{ sourceOwner: 'src1', targetOwner: 'tgt1' }],
    };
    assert.deepEqual(extractOwnerMappingDict(v1Format), { src1: 'tgt1' });

    const dictFormat = { alice: 'bob' };
    assert.deepEqual(extractOwnerMappingDict(dictFormat), { alice: 'bob' });
  });

  await t.test('identical source and target returns PASSED with 0 discrepancies', () => {
    const source = makeCanonicalCatalog({
      indexes: [
        { schema: 'public', table: 'customers', name: 'customers_pkey', definition: 'CREATE UNIQUE INDEX...', valid: true, ready: true, live: true, unique: true, primary: true },
      ],
      constraints: [
        { schema: 'public', table: 'customers', name: 'customers_pkey', definition: 'PRIMARY KEY (id)', validated: true, deferrable: false, initiallyDeferred: false },
      ],
      routines: [
        { schema: 'public', identity: 'public.test_fn()', definition: 'CREATE FUNCTION...', owner: 'postgres', securityDefiner: true, config: null, acl: null, language: 'plpgsql', comment: null },
      ],
      sequences: [
        { schema_name: 'public', sequence_name: 'test_seq', last_value: 42, is_called: true },
      ],
      relationComments: [
        { schema: 'public', relation: 'customers', comment: 'Customer records' },
      ],
      columnComments: [
        { schema: 'public', relation: 'customers', column: 'id', comment: 'Customer ID' },
      ],
    });

    const target = JSON.parse(JSON.stringify(source));
    const ownerMap = { postgres: 'postgres' };

    const report = compareCatalogDetails(source, target, ownerMap);
    assert.equal(report.status, 'PASSED');
    assert.equal(report.summary.totalDiscrepancies, 0);
    assert.equal(report.format, CATALOG_COMPARISON_FORMAT);
  });

  await t.test('normalizes owner using approved owner-map dictionary', () => {
    const source = makeCanonicalCatalog({
      routines: [
        { schema: 'public', identity: 'public.my_routine()', definition: 'CREATE FUNCTION...', owner: 'source_role', securityDefiner: false, config: null, acl: null, language: 'sql', comment: null },
      ],
    });

    const target = makeCanonicalCatalog({
      routines: [
        { schema: 'public', identity: 'public.my_routine()', definition: 'CREATE FUNCTION...', owner: 'target_role', securityDefiner: false, config: null, acl: null, language: 'sql', comment: null },
      ],
    });

    // Case 1: Owner map approves source_role -> target_role
    const reportPass = compareCatalogDetails(source, target, { source_role: 'target_role' });
    assert.equal(reportPass.status, 'PASSED');
    assert.equal(reportPass.discrepancies.length, 0);

    // Case 2: Unapproved owner difference fails closed
    const reportFail = compareCatalogDetails(source, target, { source_role: 'different_role' });
    assert.equal(reportFail.status, 'BLOCKED');
    assert.equal(reportFail.discrepancies.length, 1);
    assert.equal(reportFail.discrepancies[0].field, 'owner');
  });

  await t.test('detects index invalidity and sequence is_called mismatch', () => {
    const source = makeCanonicalCatalog({
      indexes: [
        makeIndex({ schema: 'public', table: 'tbl', name: 'idx', definition: 'CREATE INDEX...', valid: true, ready: true }),
      ],
      sequences: [
        makeSequence({ schema_name: 'public', sequence_name: 'seq', last_value: 10, is_called: true }),
      ],
    });

    const target = makeCanonicalCatalog({
      indexes: [
        makeIndex({ schema: 'public', table: 'tbl', name: 'idx', definition: 'CREATE INDEX...', valid: false, ready: true }),
      ],
      sequences: [
        makeSequence({ schema_name: 'public', sequence_name: 'seq', last_value: 10, is_called: false }),
      ],
    });

    const report = compareCatalogDetails(source, target, {});
    assert.equal(report.status, 'BLOCKED');
    assert.equal(report.discrepancies.length, 2);
    assert.ok(report.discrepancies.some((d) => d.kind === 'index' && d.field === 'valid'));
    assert.ok(report.discrepancies.some((d) => d.kind === 'sequence' && d.field === 'is_called'));
  });

  await t.test('detects all index flags (live, unique, primary) and constraint flags (deferrable, initiallyDeferred)', () => {
    const source = makeCanonicalCatalog({
      indexes: [
        { schema: 'public', table: 'tbl', name: 'idx', definition: 'CREATE INDEX...', valid: true, ready: true, live: true, unique: true, primary: true },
      ],
      constraints: [
        { schema: 'public', table: 'tbl', name: 'chk', definition: 'CHECK...', validated: true, deferrable: false, initiallyDeferred: false },
      ],
    });

    const target = makeCanonicalCatalog({
      indexes: [
        { schema: 'public', table: 'tbl', name: 'idx', definition: 'CREATE INDEX...', valid: true, ready: true, live: false, unique: false, primary: false },
      ],
      constraints: [
        { schema: 'public', table: 'tbl', name: 'chk', definition: 'CHECK...', validated: true, deferrable: true, initiallyDeferred: true },
      ],
    });

    const report = compareCatalogDetails(source, target, {});
    assert.equal(report.status, 'BLOCKED');
    // 3 index flags (live, unique, primary) + 2 constraint flags (deferrable, initiallyDeferred)
    assert.equal(report.discrepancies.length, 5);
    assert.ok(report.discrepancies.some((d) => d.kind === 'index' && d.field === 'live'));
    assert.ok(report.discrepancies.some((d) => d.kind === 'index' && d.field === 'unique'));
    assert.ok(report.discrepancies.some((d) => d.kind === 'index' && d.field === 'primary'));
    assert.ok(report.discrepancies.some((d) => d.kind === 'constraint' && d.field === 'deferrable'));
    assert.ok(report.discrepancies.some((d) => d.kind === 'constraint' && d.field === 'initiallyDeferred'));
  });

  await t.test('detects routine attribute mismatches (securityDefiner, config, acl, language, comment) and handles null-vs-present', () => {
    const source = makeCanonicalCatalog({
      routines: [
        {
          schema: 'public',
          identity: 'public.my_func()',
          definition: 'SELECT 1;',
          owner: 'postgres',
          securityDefiner: true,
          config: ['search_path=public'],
          acl: 'postgres=X/postgres',
          language: 'sql',
          comment: null, // null in source
        },
      ],
    });

    const target = makeCanonicalCatalog({
      routines: [
        {
          schema: 'public',
          identity: 'public.my_func()',
          definition: 'SELECT 2;', // definition mismatch
          owner: 'postgres',
          securityDefiner: false, // mismatch
          config: null, // mismatch
          acl: null, // mismatch
          language: 'plpgsql', // mismatch
          comment: 'has a comment now', // null-vs-present mismatch!
        },
      ],
    });

    const report = compareCatalogDetails(source, target, {});
    assert.equal(report.status, 'BLOCKED');
    assert.ok(report.discrepancies.some((d) => d.kind === 'routine' && d.field === 'definition'));
    assert.ok(report.discrepancies.some((d) => d.kind === 'routine' && d.field === 'securityDefiner'));
    assert.ok(report.discrepancies.some((d) => d.kind === 'routine' && d.field === 'config'));
    assert.ok(report.discrepancies.some((d) => d.kind === 'routine' && d.field === 'acl'));
    assert.ok(report.discrepancies.some((d) => d.kind === 'routine' && d.field === 'language'));
    assert.ok(report.discrepancies.some((d) => d.kind === 'routine' && d.field === 'comment'));
  });

  await t.test('detects missing, extra, and mismatched columnComments and extra relationComments', () => {
    const source = makeCanonicalCatalog({
      relationComments: [
        { schema: 'public', relation: 'leads', comment: 'Lead records' },
      ],
      columnComments: [
        { schema: 'public', relation: 'leads', column: 'phone', comment: 'Phone number' },
        { schema: 'public', relation: 'leads', column: 'email', comment: 'Email address' },
      ],
    });

    const target = makeCanonicalCatalog({
      relationComments: [
        { schema: 'public', relation: 'leads', comment: 'Lead records' },
        { schema: 'public', relation: 'extra_table', comment: 'Surprise table' }, // Extra relation comment
      ],
      columnComments: [
        { schema: 'public', relation: 'leads', column: 'phone', comment: 'Telephone number' }, // Mismatched text
        // email is missing in target
        { schema: 'public', relation: 'leads', column: 'extra_col', comment: 'Surprise column' }, // Extra column comment
      ],
    });

    const report = compareCatalogDetails(source, target, {});
    assert.equal(report.status, 'BLOCKED');
    // Summary checks
    assert.equal(report.summary.columnComments.sourceCount, 2);
    assert.equal(report.summary.columnComments.targetCount, 2);
    assert.equal(report.summary.relationComments.sourceCount, 1);
    assert.equal(report.summary.relationComments.targetCount, 2);

    // Discrepancy checks
    assert.ok(report.discrepancies.some((d) => d.kind === 'relationComment' && d.sourceValue === 'missing' && d.identity === 'public.extra_table'));
    assert.ok(report.discrepancies.some((d) => d.kind === 'columnComment' && d.field === 'comment' && d.identity === 'public.leads.phone'));
    assert.ok(report.discrepancies.some((d) => d.kind === 'columnComment' && d.targetValue === 'missing' && d.identity === 'public.leads.email'));
    assert.ok(report.discrepancies.some((d) => d.kind === 'columnComment' && d.sourceValue === 'missing' && d.identity === 'public.leads.extra_col'));
  });

  await t.test('detects missing and extra objects in target', () => {
    const source = makeCanonicalCatalog({
      constraints: [
        makeConstraint({ schema: 'public', table: 't1', name: 'c1', definition: 'CHECK (1=1)' }),
      ],
    });

    const target = makeCanonicalCatalog({
      constraints: [
        makeConstraint({ schema: 'public', table: 't2', name: 'c2', definition: 'CHECK (2=2)' }),
      ],
    });

    const report = compareCatalogDetails(source, target, {});
    assert.equal(report.status, 'BLOCKED');
    // c1 is missing in target, c2 is extra in target
    assert.equal(report.discrepancies.length, 2);
    assert.ok(report.discrepancies.some((d) => d.identity === 'public.t1.c1' && d.targetValue === 'missing'));
    assert.ok(report.discrepancies.some((d) => d.identity === 'public.t2.c2' && d.sourceValue === 'missing'));
  });

  await t.test('CLI execution writes report and returns correct exit code', async () => {
    const tempDir = await createTempDir();
    try {
      const srcPath = path.join(tempDir, 'source.json');
      const tgtPath = path.join(tempDir, 'target.json');
      const ownerPath = path.join(tempDir, 'owner-map.json');
      const reportPath = path.join(tempDir, 'report.json');

      const data = makeCanonicalCatalog();
      await fsp.writeFile(srcPath, JSON.stringify(data));
      await fsp.writeFile(tgtPath, JSON.stringify(data));
      await fsp.writeFile(ownerPath, JSON.stringify({}));

      const resPass = await runCli(['compare', '--source', srcPath, '--target', tgtPath, '--owner-map', ownerPath, '--report', reportPath]);
      assert.equal(resPass.code, 0);
      assert.match(resPass.stdout, /CATALOG_COMPARE PASSED/);

      const writtenReport = JSON.parse(await fsp.readFile(reportPath, 'utf8'));
      assert.equal(writtenReport.status, 'PASSED');

      // Now create discrepancy and verify non-zero exit code
      await fsp.writeFile(tgtPath, JSON.stringify({
        ...data,
        sequences: [{ schema_name: 'public', sequence_name: 'extra_seq', last_value: 1, is_called: true }],
      }));

      const resFail = await runCli(['compare', '--source', srcPath, '--target', tgtPath, '--owner-map', ownerPath, '--report', reportPath]);
      assert.notEqual(resFail.code, 0);
      assert.match(resFail.stdout, /CATALOG_COMPARE BLOCKED/);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  await t.test('Finding 4 regression: strict catalog schema validation and duplicate detection', () => {
    const valid = makeCanonicalCatalog();

    // 1. Root not an object
    assert.throws(() => validateCatalogSchema(null, 'Test'), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
    assert.throws(() => validateCatalogSchema('string', 'Test'), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
    assert.throws(() => validateCatalogSchema([], 'Test'), (err) => err.code === 'INVALID_CATALOG_SCHEMA');

    // 2. Missing required section
    const missingIndexes = { ...valid };
    delete missingIndexes.indexes;
    assert.throws(() => validateCatalogSchema(missingIndexes, 'Test'), (err) => err.code === 'INVALID_CATALOG_SCHEMA');

    // 3. Null instead of array
    const nullRoutines = { ...valid, routines: null };
    assert.throws(() => validateCatalogSchema(nullRoutines, 'Test'), (err) => err.code === 'INVALID_CATALOG_SCHEMA');

    // 4. Source and target both missing a section must fail closed, NOT pass
    const bothMissing = { ...valid };
    delete bothMissing.sequences;
    assert.throws(() => compareCatalogDetails(bothMissing, bothMissing, {}), (err) => err.code === 'INVALID_CATALOG_SCHEMA');

    // 5. Target has object with invalid schema
    const malformedIndex = makeCanonicalCatalog({
      indexes: [{ schema: 'public', table: 123, name: 'idx' }],
    });
    assert.throws(() => validateCatalogSchema(malformedIndex, 'Test'), (err) => err.code === 'INVALID_CATALOG_SCHEMA');

    // 6. Routine missing definition
    const missingDefRoutine = makeCanonicalCatalog({
      routines: [{ identity: 'public.foo()' }],
    });
    assert.throws(() => validateCatalogSchema(missingDefRoutine, 'Test'), (err) => err.code === 'INVALID_CATALOG_SCHEMA');

    // 7. Duplicate index identity
    const dupIndex = makeCanonicalCatalog({
      indexes: [
        makeIndex({ schema: 'public', table: 'users', name: 'users_idx' }),
        makeIndex({ schema: 'public', table: 'users', name: 'users_idx' }),
      ],
    });
    assert.throws(() => validateCatalogSchema(dupIndex, 'Test'), (err) => err.code === 'DUPLICATE_CATALOG_ENTRY');

    // 8. Duplicate constraint identity
    const dupConstraint = makeCanonicalCatalog({
      constraints: [
        makeConstraint({ schema: 'public', table: 'users', name: 'users_pkey' }),
        makeConstraint({ schema: 'public', table: 'users', name: 'users_pkey' }),
      ],
    });
    assert.throws(() => validateCatalogSchema(dupConstraint, 'Test'), (err) => err.code === 'DUPLICATE_CATALOG_ENTRY');

    // 9. Duplicate routine identity
    const dupRoutine = makeCanonicalCatalog({
      routines: [
        makeRoutine({ identity: 'public.do_work()' }),
        makeRoutine({ identity: 'public.do_work()' }),
      ],
    });
    assert.throws(() => validateCatalogSchema(dupRoutine, 'Test'), (err) => err.code === 'DUPLICATE_CATALOG_ENTRY');

    // 9b. Duplicate sequence identity
    const dupSeq = makeCanonicalCatalog({
      sequences: [
        makeSequence({ schema_name: 'public', sequence_name: 'seq1' }),
        makeSequence({ schema_name: 'public', sequence_name: 'seq1' }),
      ],
    });
    assert.throws(() => validateCatalogSchema(dupSeq, 'Test'), (err) => err.code === 'DUPLICATE_CATALOG_ENTRY');

    // 10. Duplicate relation comment
    const dupRelComment = makeCanonicalCatalog({
      relationComments: [
        makeRelationComment({ schema: 'public', relation: 'users', comment: 'c1' }),
        makeRelationComment({ schema: 'public', relation: 'users', comment: 'c2' }),
      ],
    });
    assert.throws(() => validateCatalogSchema(dupRelComment, 'Test'), (err) => err.code === 'DUPLICATE_CATALOG_ENTRY');

    // 11. Duplicate column comment
    const dupColComment = makeCanonicalCatalog({
      columnComments: [
        makeColumnComment({ schema: 'public', relation: 'users', column: 'email', comment: 'c1' }),
        makeColumnComment({ schema: 'public', relation: 'users', column: 'email', comment: 'c2' }),
      ],
    });
    assert.throws(() => validateCatalogSchema(dupColComment, 'Test'), (err) => err.code === 'DUPLICATE_CATALOG_ENTRY');

    // 12. P1 regression: Exhaustive field-by-field validation for all 6 catalog sections
    // Test that missing or wrong-typed required fields in source, target, or both sides ALWAYS fails closed
    const indexRequiredFields = ['schema', 'table', 'name', 'definition', 'valid', 'ready', 'live', 'unique', 'primary'];
    for (const field of indexRequiredFields) {
      const badIdx = makeIndex();
      delete badIdx[field];
      const badCatalog = makeCanonicalCatalog({ indexes: [badIdx] });
      // Missing in single catalog
      assert.throws(() => validateCatalogSchema(badCatalog, 'Source'), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
      // Missing in source during compare
      assert.throws(() => compareCatalogDetails(badCatalog, valid, {}), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
      // Missing in target during compare
      assert.throws(() => compareCatalogDetails(valid, badCatalog, {}), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
      // Missing in both during compare
      assert.throws(() => compareCatalogDetails(badCatalog, badCatalog, {}), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
    }

    const constraintRequiredFields = ['schema', 'table', 'name', 'definition', 'validated', 'deferrable', 'initiallyDeferred'];
    for (const field of constraintRequiredFields) {
      const badCon = makeConstraint();
      delete badCon[field];
      const badCatalog = makeCanonicalCatalog({ constraints: [badCon] });
      assert.throws(() => validateCatalogSchema(badCatalog, 'Source'), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
      assert.throws(() => compareCatalogDetails(badCatalog, valid, {}), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
      assert.throws(() => compareCatalogDetails(valid, badCatalog, {}), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
      assert.throws(() => compareCatalogDetails(badCatalog, badCatalog, {}), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
    }

    const routineRequiredFields = ['identity', 'definition', 'owner', 'securityDefiner', 'language'];
    for (const field of routineRequiredFields) {
      const badRtn = makeRoutine();
      delete badRtn[field];
      const badCatalog = makeCanonicalCatalog({ routines: [badRtn] });
      assert.throws(() => validateCatalogSchema(badCatalog, 'Source'), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
      assert.throws(() => compareCatalogDetails(badCatalog, valid, {}), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
      assert.throws(() => compareCatalogDetails(valid, badCatalog, {}), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
      assert.throws(() => compareCatalogDetails(badCatalog, badCatalog, {}), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
    }

    const sequenceRequiredFields = ['schema_name', 'sequence_name', 'last_value', 'is_called'];
    for (const field of sequenceRequiredFields) {
      const badSeq = makeSequence();
      delete badSeq[field];
      const badCatalog = makeCanonicalCatalog({ sequences: [badSeq] });
      assert.throws(() => validateCatalogSchema(badCatalog, 'Source'), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
      assert.throws(() => compareCatalogDetails(badCatalog, valid, {}), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
      assert.throws(() => compareCatalogDetails(valid, badCatalog, {}), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
      assert.throws(() => compareCatalogDetails(badCatalog, badCatalog, {}), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
    }

    const relCommentRequiredFields = ['schema', 'relation'];
    for (const field of relCommentRequiredFields) {
      const badRc = makeRelationComment();
      delete badRc[field];
      const badCatalog = makeCanonicalCatalog({ relationComments: [badRc] });
      assert.throws(() => validateCatalogSchema(badCatalog, 'Source'), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
      assert.throws(() => compareCatalogDetails(badCatalog, valid, {}), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
      assert.throws(() => compareCatalogDetails(valid, badCatalog, {}), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
      assert.throws(() => compareCatalogDetails(badCatalog, badCatalog, {}), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
    }

    const colCommentRequiredFields = ['schema', 'relation', 'column'];
    for (const field of colCommentRequiredFields) {
      const badCc = makeColumnComment();
      delete badCc[field];
      const badCatalog = makeCanonicalCatalog({ columnComments: [badCc] });
      assert.throws(() => validateCatalogSchema(badCatalog, 'Source'), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
      assert.throws(() => compareCatalogDetails(badCatalog, valid, {}), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
      assert.throws(() => compareCatalogDetails(valid, badCatalog, {}), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
      assert.throws(() => compareCatalogDetails(badCatalog, badCatalog, {}), (err) => err.code === 'INVALID_CATALOG_SCHEMA');
    }

    // Whitespace-only string fields must fail closed
    assert.throws(
      () => validateCatalogSchema(makeCanonicalCatalog({ indexes: [makeIndex({ schema: '   ' })] }), 'Test'),
      (err) => err.code === 'INVALID_CATALOG_SCHEMA'
    );
    assert.throws(
      () => validateCatalogSchema(makeCanonicalCatalog({ constraints: [makeConstraint({ table: '' })] }), 'Test'),
      (err) => err.code === 'INVALID_CATALOG_SCHEMA'
    );
    assert.throws(
      () => validateCatalogSchema(makeCanonicalCatalog({ routines: [makeRoutine({ identity: ' \t ' })] }), 'Test'),
      (err) => err.code === 'INVALID_CATALOG_SCHEMA'
    );
    assert.throws(
      () => validateCatalogSchema(makeCanonicalCatalog({ sequences: [makeSequence({ sequence_name: '' })] }), 'Test'),
      (err) => err.code === 'INVALID_CATALOG_SCHEMA'
    );

    // 13. compareStrings fails closed on non-string inputs
    assert.equal(compareStrings(true, {}), false);
    assert.equal(compareStrings(123, 123), false);
    assert.equal(compareStrings(null, null), true);
    assert.equal(compareStrings(undefined, null), true);
    assert.equal(compareStrings(null, 'abc'), false);
    assert.equal(compareStrings(' hello ', 'hello'), true);
  });

  await t.test('CLI rejects duplicate JSON keys (parseJsonStrict)', async () => {
    const tempDir = await createTempDir();
    try {
      const dupJsonPath = path.join(tempDir, 'dup.json');
      const validPath = path.join(tempDir, 'valid.json');
      const reportPath = path.join(tempDir, 'report.json');

      await fsp.writeFile(validPath, '{}');
      await fsp.writeFile(dupJsonPath, '{"indexes": [], "indexes": []}');

      const res = await runCli(['compare', '--source', dupJsonPath, '--target', validPath, '--owner-map', validPath, '--report', reportPath]);
      assert.notEqual(res.code, 0);
      assert.match(res.stderr, /duplicate.*key/i);
    } finally {
      await removeTempDir(tempDir);
    }
  });
});
