import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  verifyMigrationIntegrity,
  verifyFilesystemMigrations,
  verifyMigrationGitGuard,
  FROZEN_FOUNDATION_MIGRATIONS,
} from './verify-migration-integrity';

console.log('================================================================');
console.log('STARTING INVARIANT-BASED MIGRATION INTEGRITY TESTS');
console.log('================================================================\n');

let passCount = 0;
function testPass(msg: string) {
  console.log(`[PASS] ${msg}`);
  passCount++;
}

// ----------------------------------------------------------------------------
// Test 1: Real local filesystem migrations pass all invariant checks
// ----------------------------------------------------------------------------
{
  const result = verifyFilesystemMigrations();
  assert.equal(result.valid, true, `Real migrations should pass integrity check. Errors: ${result.errors.join(', ')}`);
  assert(result.filesCount >= 18, `Filesystem should have at least 18 migrations, found: ${result.filesCount}`);
  testPass(`Real filesystem migrations pass all invariant checks (${result.filesCount} migrations verified)`);
}

// ----------------------------------------------------------------------------
// Test 2: Appending valid future migrations (19th, 20th...) continues to PASS
// ----------------------------------------------------------------------------
{
  const baselineFiles = Object.keys(FROZEN_FOUNDATION_MIGRATIONS);
  const futureFiles = [
    ...baselineFiles,
    '20260928000001_operations_p0_hardening.sql',
    '20260928000002_tv9_post_merge_hardening.sql',
    '20261001000001_future_feature_one.sql',
    '20261002000001_future_feature_two.sql',
  ];

  const result = verifyMigrationIntegrity(futureFiles);
  assert.equal(result.valid, true, 'Appending valid future migrations should succeed');
  assert.equal(result.filesCount, baselineFiles.length + 4);
  testPass('Appending valid future migrations (19th, 20th+) passes without hardcoded total count');
}

// ----------------------------------------------------------------------------
// Test 3: Duplicate migration timestamp FAILS
// ----------------------------------------------------------------------------
{
  const duplicateTimestampFiles = [
    ...Object.keys(FROZEN_FOUNDATION_MIGRATIONS),
    '20260928000001_feature_a.sql',
    '20260928000001_feature_b.sql', // Duplicate timestamp
  ];

  const result = verifyMigrationIntegrity(duplicateTimestampFiles);
  assert.equal(result.valid, false, 'Duplicate timestamp should fail');
  assert(result.errors.some((e) => e.includes('Duplicate migration timestamps')), 'Expected duplicate timestamp error');
  testPass('Duplicate timestamp rejected fail-closed');
}

// ----------------------------------------------------------------------------
// Test 4: Missing canonical Foundation migration FAILS
// ----------------------------------------------------------------------------
{
  const missingFoundationFiles = [
    '20260914000001_initial_schema.sql',
    // Missing 20260915000001_rls_foundation.sql
    '20260915000002_trusted_server_private_rpc.sql',
    '20260916000001_private_call_transcripts.sql',
    '20260928000002_tv9_post_merge_hardening.sql',
  ];

  const result = verifyMigrationIntegrity(missingFoundationFiles);
  assert.equal(result.valid, false, 'Missing foundation migration should fail');
  assert(result.errors.some((e) => e.includes('Missing canonical foundation migration')), 'Expected missing foundation error');
  testPass('Missing canonical Foundation migration rejected fail-closed');
}

// ----------------------------------------------------------------------------
// Test 5: Out-of-order / non-chronological migrations FAIL
// ----------------------------------------------------------------------------
{
  const outOfOrderFiles = [
    '20260915000001_rls_foundation.sql',
    '20260914000001_initial_schema.sql', // Inverted order
    '20260915000002_trusted_server_private_rpc.sql',
    '20260916000001_private_call_transcripts.sql',
  ];

  const result = verifyMigrationIntegrity(outOfOrderFiles);
  assert.equal(result.valid, false, 'Non-chronological order should fail');
  assert(result.errors.some((e) => e.includes('deterministic ascending chronological order')), 'Expected ordering error');
  testPass('Non-chronological migration order rejected fail-closed');
}

// ----------------------------------------------------------------------------
// Test 6: Foundation frozen migration integrity violation (tampered hash) FAILS
// ----------------------------------------------------------------------------
{
  const baselineFiles = Object.keys(FROZEN_FOUNDATION_MIGRATIONS);
  const fakeResolver = (filename: string) => {
    if (filename === '20260914000001_initial_schema.sql') {
      return '-- TAMPERED CONTENT THAT DOES NOT MATCH BASELINE HASH';
    }
    return '';
  };

  const result = verifyMigrationIntegrity(baselineFiles, fakeResolver);
  assert.equal(result.valid, false, 'Tampered foundation checksum should fail');
  assert(result.errors.some((e) => e.includes('frozen integrity violated')), 'Expected checksum mismatch error');
  testPass('Foundation migration content mutation rejected via SHA-256 baseline checksum');
}

// ============================================================================
// FOCUSED ISOLATED GIT FIXTURE TESTS: MIGRATION GIT GUARD
// ============================================================================

function withTempGitFixture(
  fn: (fixture: { dir: string; migrationsDir: string; mainRef: string }) => void
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-guard-fixture-'));
  try {
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    } catch {
      execFileSync('git', ['init'], { cwd: dir });
      execFileSync('git', ['checkout', '-B', 'main'], { cwd: dir });
    }

    execFileSync('git', ['config', 'user.name', 'Fixture Author'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'author@fixture.local'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });

    const migrationsDir = path.join(dir, 'supabase', 'migrations');
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(migrationsDir, '20260914000001_initial_schema.sql'),
      '-- baseline schema',
      'utf8'
    );

    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'chore: initial baseline migration on main'], { cwd: dir });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir });

    // Checkout feature branch
    execFileSync('git', ['checkout', '-q', '-b', 'feat/test-branch'], { cwd: dir });

    fn({ dir, migrationsDir, mainRef: 'origin/main' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------------
// Test 7: Git guard: Historical migration modified (uncommitted) is rejected fail-closed
// ----------------------------------------------------------------------------
withTempGitFixture(({ dir, migrationsDir }) => {
  fs.appendFileSync(
    path.join(migrationsDir, '20260914000001_initial_schema.sql'),
    '\n-- uncommitted edit'
  );
  const result = verifyMigrationGitGuard({ cwd: dir });
  assert.equal(result.valid, false, 'Uncommitted modification to historical migration should fail');
  assert(
    result.errors.some(
      (e) =>
        e.includes('Disallowed migration modification (M)') &&
        e.includes('20260914000001_initial_schema.sql')
    ),
    'Expected error on modified historical migration'
  );
  testPass('Git guard: historical migration uncommitted modification rejected fail-closed');
});

// ----------------------------------------------------------------------------
// Test 8: Git guard: Historical migration modified (committed on branch) is rejected fail-closed
// ----------------------------------------------------------------------------
withTempGitFixture(({ dir, migrationsDir }) => {
  fs.appendFileSync(
    path.join(migrationsDir, '20260914000001_initial_schema.sql'),
    '\n-- committed edit on feature branch'
  );
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'feat: unauthorized edit to historical migration'], { cwd: dir });

  const result = verifyMigrationGitGuard({ cwd: dir });
  assert.equal(result.valid, false, 'Committed modification to historical migration on branch should fail');
  assert(
    result.errors.some(
      (e) =>
        e.includes('Disallowed migration modification (M)') &&
        e.includes('20260914000001_initial_schema.sql')
    ),
    'Expected error on committed historical migration modification'
  );
  testPass('Git guard: historical migration committed modification rejected fail-closed');
});

// ----------------------------------------------------------------------------
// Test 9: Git guard: Historical migration deletion is rejected fail-closed
// ----------------------------------------------------------------------------
withTempGitFixture(({ dir, migrationsDir }) => {
  fs.unlinkSync(path.join(migrationsDir, '20260914000001_initial_schema.sql'));

  const result = verifyMigrationGitGuard({ cwd: dir });
  assert.equal(result.valid, false, 'Deletion of historical migration should fail');
  assert(
    result.errors.some(
      (e) =>
        e.includes('Disallowed migration modification (D)') &&
        e.includes('20260914000001_initial_schema.sql')
    ),
    'Expected error on deleted historical migration'
  );
  testPass('Git guard: historical migration deletion rejected fail-closed');
});

// ----------------------------------------------------------------------------
// Test 10: Git guard: Historical migration rename is rejected fail-closed
// ----------------------------------------------------------------------------
withTempGitFixture(({ dir, migrationsDir }) => {
  fs.renameSync(
    path.join(migrationsDir, '20260914000001_initial_schema.sql'),
    path.join(migrationsDir, '20260914000002_renamed_schema.sql')
  );

  const result = verifyMigrationGitGuard({ cwd: dir });
  assert.equal(result.valid, false, 'Rename of historical migration should fail');
  assert(
    result.errors.some(
      (e) =>
        e.includes('Disallowed migration modification (D)') &&
        e.includes('20260914000001_initial_schema.sql')
    ),
    'Expected error on renamed historical migration'
  );
  testPass('Git guard: historical migration rename rejected fail-closed');
});

// ----------------------------------------------------------------------------
// Test 11: Git guard: Newly added feature migration edited after initial feature commit is allowed
// ----------------------------------------------------------------------------
withTempGitFixture(({ dir, migrationsDir }) => {
  // Commit 1 on feature branch: add new feature migration
  const featureMigrationPath = path.join(migrationsDir, '20261022173000_ai_brain_shadow_foundation.sql');
  fs.writeFileSync(featureMigrationPath, '-- initial feature migration implementation\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'feat(ai-brain): add shadow queue schema'], { cwd: dir });

  // Later edit: authorized corrections showing M vs HEAD but A vs origin/main
  fs.appendFileSync(featureMigrationPath, '-- authorized correction after code review\n', 'utf8');

  const result = verifyMigrationGitGuard({ cwd: dir });
  assert.equal(
    result.valid,
    true,
    `Authorized correction to new feature migration should pass. Errors: ${result.errors.join(', ')}`
  );
  assert.equal(result.errors.length, 0);
  assert(result.changes.some((c) => c.includes('20261022173000_ai_brain_shadow_foundation.sql')));
  testPass('Git guard: newly added feature migration edited after initial feature commit allowed');
});

// ----------------------------------------------------------------------------
// Test 12: Git guard: Valid additive migration file is allowed
// ----------------------------------------------------------------------------
withTempGitFixture(({ dir, migrationsDir }) => {
  const newMigrationPath = path.join(migrationsDir, '20261022180000_valid_additive_migration.sql');
  fs.writeFileSync(newMigrationPath, '-- valid additive migration\n', 'utf8');

  const result = verifyMigrationGitGuard({ cwd: dir });
  assert.equal(result.valid, true, `Valid additive migration should pass. Errors: ${result.errors.join(', ')}`);
  assert.equal(result.errors.length, 0);
  testPass('Git guard: valid additive file allowed');
});

// ----------------------------------------------------------------------------
// Test 13: Git guard: Missing baseline ref fails closed without fallback to HEAD
// ----------------------------------------------------------------------------
withTempGitFixture(({ dir }) => {
  const result = verifyMigrationGitGuard({
    cwd: dir,
    baseRef: 'refs/remotes/origin/nonexistent-target-branch',
  });
  assert.equal(result.valid, false, 'Missing baseline ref should fail closed');
  assert(
    result.errors.some(
      (e) =>
        e.includes('unavailable') ||
        e.includes('nonexistent-target-branch') ||
        e.includes('merge-base')
    ),
    'Expected error on missing baseline ref'
  );
  testPass('Git guard: missing baseline fails closed');
});

console.log('\n================================================================');
console.log(`MIGRATION INTEGRITY TEST RESULTS: ${passCount} PASSED, 0 FAILED`);
console.log('================================================================\n');
