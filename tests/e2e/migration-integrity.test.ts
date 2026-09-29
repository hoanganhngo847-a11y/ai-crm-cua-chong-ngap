import { strict as assert } from 'assert';
import {
  verifyMigrationIntegrity,
  verifyFilesystemMigrations,
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

console.log('\n================================================================');
console.log(`MIGRATION INTEGRITY TEST RESULTS: ${passCount} PASSED, 0 FAILED`);
console.log('================================================================\n');
