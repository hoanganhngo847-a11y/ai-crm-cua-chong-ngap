import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { reconcileMigrationLedger } from '../../scripts/meta-ads/migration-ledger';

const a = '20260914000001_initial_schema.sql';
const b = '20260915000001_rls_foundation.sql';
test('MCP apply timestamps are matched by unique names and require schema proof', () => {
  const result = reconcileMigrationLedger([a,b], [{version:'20261030063323',name:'initial_schema'}]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.recorded[0].requiresSchemaVerification, true);
  assert.equal(result.recorded[0].canonicalVersion, '20260914000001');
  assert.deepEqual(result.pending, [b]);
  assert.equal(result.schemaVerificationRequired, true);
});
test('ambiguous versions/names, unknown entries and skipped predecessors fail closed', () => {
  assert.ok(reconcileMigrationLedger([a,b], [{version:'20260914000001',name:'rls_foundation'}]).errors.includes('VERSION_NAME_CONFLICT:20260914000001'));
  assert.ok(reconcileMigrationLedger([a,b], [{version:'20261030063323',name:'rls_foundation'}]).errors.includes('NON_PREFIX_HISTORY:rls_foundation'));
  assert.ok(reconcileMigrationLedger([a,a.replace('initial_schema','other')], []).errors.includes('DUPLICATE_FILE_VERSION'));
  assert.ok(reconcileMigrationLedger([a,a.replace('20260914000001','20260914000002')], []).errors.includes('AMBIGUOUS_FILE_NAME'));
  assert.ok(reconcileMigrationLedger([a], [{version:'20261030063323',name:'unknown'}]).errors.length);
  assert.ok(reconcileMigrationLedger([a], [{version:'20261030063323',name:'initial_schema'},{version:'20261030063323',name:'initial_schema'}]).errors.includes('AMBIGUOUS_HISTORY_NAME'));
});
test('captured staging ledger is the first canonical prefix; names never cause activation replay', () => {
  const files = readdirSync('supabase/migrations').filter(f => f.endsWith('.sql'));
  const history = JSON.parse(readFileSync('docs/evidence/meta-ads-staging/staging-history.json','utf8')).migrations;
  const result = reconcileMigrationLedger(files, history);
  assert.deepEqual(result.errors, []);
  assert.ok(result.recorded.every(m => m.requiresSchemaVerification));
  assert.equal(result.recorded.at(-1)?.name, 'operations_p0_hardening');
  assert.equal(result.pending[0], '20260928000002_tv9_post_merge_hardening.sql');
  assert.ok(!result.pending.some(file => file.endsWith('_sales_style_activation.sql')));
  const remote = JSON.parse(readFileSync('docs/evidence/meta-ads-staging/staging-prefix-catalog.json','utf8'));
  const local = JSON.parse(readFileSync('docs/evidence/meta-ads-staging/local-prefix-catalog.json','utf8'));
  assert.deepEqual(local,remote,'captured live staging catalog must match the canonical prefix');
});
