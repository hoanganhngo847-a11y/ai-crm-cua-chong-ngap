import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('owner decision register preserves all 178 original IDs, keeps approvals false, and maps every pending item to exactly one batch', () => {
  const origPath = 'docs/evidence/meta-ads-safe-deployment/destructive-approval-items.json';
  const regPath = 'docs/evidence/meta-ads-owner-decisions/decision-register.json';

  const orig: Array<{ id: string; pending: boolean; approved: boolean }> = JSON.parse(
    readFileSync(origPath, 'utf8')
  );
  const reg = JSON.parse(readFileSync(regPath, 'utf8'));
  const items: Array<{
    id: string;
    pending: boolean;
    approved: boolean;
    batch_id: string;
    recommended_decision: string;
    evidence_links: string[];
  }> = reg.items;

  // 1. Total items match
  assert.equal(items.length, 178);
  assert.equal(items.length, orig.length);

  // 2. Stable IDs match in exact original order
  const origIds = orig.map((i) => i.id);
  const regIds = items.map((i) => i.id);
  assert.deepEqual(regIds, origIds);

  // 3. Pending counts match
  const origPending = orig.filter((i) => i.pending);
  const regPending = items.filter((i) => i.pending);
  assert.equal(regPending.length, 160);
  assert.equal(regPending.length, origPending.length);

  // 4. Historical prefix items not silently reclassified
  const origPrefix = orig.filter((i) => !i.pending).map((i) => i.id);
  const regPrefix = items.filter((i) => !i.pending).map((i) => i.id);
  assert.equal(regPrefix.length, 18);
  assert.deepEqual(regPrefix, origPrefix);

  // 5. No item approved
  for (const item of items) {
    assert.equal(item.approved, false, `Item ${item.id} must NOT be approved`);
  }

  // 6. Every pending item mapped to exactly one batch
  const allowedBatches = Object.keys(reg.metadata.batches);
  assert.equal(allowedBatches.length, 13);
  const batchCounts: Record<string, number> = {};
  for (const item of regPending) {
    assert.ok(
      allowedBatches.includes(item.batch_id),
      `Invalid batch ${item.batch_id} for item ${item.id}`
    );
    batchCounts[item.batch_id] = (batchCounts[item.batch_id] || 0) + 1;
  }
  const totalInBatches = Object.values(batchCounts).reduce((a, b) => a + b, 0);
  assert.equal(totalInBatches, 160);

  // 7. Allowed recommendation labels & evidence check
  const allowedRecs = new Set(['KEEP', 'REMOVE', 'REPLACE', 'DEFER', 'NEEDS EVIDENCE']);
  for (const item of items) {
    assert.ok(
      allowedRecs.has(item.recommended_decision),
      `Invalid recommendation ${item.recommended_decision} for item ${item.id}`
    );
    assert.ok(
      item.evidence_links.length > 0 || item.recommended_decision === 'NEEDS EVIDENCE',
      `Item ${item.id} must have evidence links unless marked NEEDS EVIDENCE`
    );
  }
});

