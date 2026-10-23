import test from 'node:test';
import assert from 'node:assert/strict';
import { dossierContextSchema, validateDossierSnapshot } from '../../features/customer-360/contracts';
import { context, snapshot } from './fixture';
import { normalizeEmail, normalizeIdentity, resolveCustomerIdentities } from '../../features/customer-360/identity';
import { sanitizeDossierText, listFilters, listCustomersForActor, customerForActor, type DossierActor } from '../../features/customer-360/service';
import { processDossierRefresh } from '../../features/customer-360/worker';
import type { SupabaseClient } from '@supabase/supabase-js';
import { dossierLeadScore } from '../../features/customer-360/scoring';

process.env.PHONE_HASH_SECRET = 'synthetic-c360-local-hash-secret';
test('valid structured snapshot preserves all evidence', () => {
  assert.deepEqual(validateDossierSnapshot(snapshot, context), snapshot);
});
for (const field of ['birthYear','age','school','gpa','address','leadScore','chainOfThought','reasoning','followUpAt','assignedSale','lifecycleStage']) {
  test(`model authority/unsupported field ${field} is rejected`, () => {
    assert.throws(() => validateDossierSnapshot({ ...snapshot, [field]: 'fabricated' }, context));
  });
}
test('hallucinated personal facts and fake references are rejected', () => {
  assert.throws(() => validateDossierSnapshot({ ...snapshot, summary: { text: 'Sinh năm 1998 tại Hà Nội', sourceId: context.sources[0].id } }, context), /UNSUPPORTED/);
  assert.throws(() => validateDossierSnapshot({ ...snapshot, nextActions: [{ action: 'CONTACT_CUSTOMER', sourceId: 'other-tenant' }] }, context), /UNSUPPORTED/);
  assert.throws(() => validateDossierSnapshot({ ...snapshot, evidence: [] }, context), /EVIDENCE/);
});
test('unknowns remain null/empty, not invented', () => {
  const empty = { ...snapshot, summary: null, currentSituation: null, intent: [], objections: [], nextActions: [], evidence: [] };
  assert.equal(validateDossierSnapshot(empty, { ...context, sources: [] }).summary, null);
});
test('context accepts bounded sources only', () => {
  assert.throws(() => dossierContextSchema.parse({ ...context, sources: Array(31).fill(context.sources[0]) }));
  assert.throws(() => dossierContextSchema.parse({ ...context, sql: 'execute' }));
});
test('normalization uses existing phone HMAC; email is canonical and names are never keys', () => {
  assert.equal(normalizeIdentity('PHONE','0912 345 678').key, normalizeIdentity('PHONE','+84912345678').key);
  assert.equal(normalizeEmail('  TEST@Example.COM '), 'test@example.com');
  assert.match(normalizeIdentity('EMAIL','TEST@Example.COM').key, /^[a-f0-9]{64}$/);
  assert.throws(() => normalizeIdentity('ZALO','Nguyễn Văn A'));
  assert.throws(() => normalizeEmail('foo@invalid'));
});
test('PII is masked and credential-bearing notes are rejected before model input', () => {
  assert.ok(!sanitizeDossierText('Gọi tôi 0912345678 test@example.com')?.includes('0912345678'));
  assert.ok(!sanitizeDossierText('Gọi tôi 0912345678 test@example.com')?.includes('test@example.com'));
  assert.equal(sanitizeDossierText('Mật khẩu là bí mật'), null);
  assert.equal(sanitizeDossierText('OTP 123456'), null);
});
const actor = { companyId: context.companyId, userId: 'cc360000-0000-4000-8000-000000000009', role: 'SALE' } as DossierActor;
test('list/search/filter/pagination use tenant-bound RPC and sale receives no transcript-derived AI', async () => {
  let args: Record<string, unknown> | undefined;
  const db = { rpc: async (_name: string, parameters: Record<string, unknown>) => { args = parameters; return { data: { items: [], total: 0, page: 2, pageSize: 25 }, error: null }; } } as unknown as SupabaseClient;
  await listCustomersForActor(db, actor, { search: '0912345678', page: 2, channel: 'ZALO', sort: 'contact', hot: '1' });
  assert.equal(args?.p_company_id, context.companyId); assert.equal(args?.p_search, '+84912345678');
  assert.equal(args?.p_include_ai, false); assert.equal(args?.p_page, 2); assert.equal(args?.p_channel, 'ZALO');
});
test('list fails closed on query failure, never a silent zero', async () => {
  await assert.rejects(listCustomersForActor({ rpc: async () => ({ data: null, error: { code: 'failed' } }) } as unknown as SupabaseClient, actor, {}), /UNAVAILABLE/);
  for (const bad of [{ page: 0 }, { page: 10001 }, { companyId: 'untrusted' }, { sort: 'sql' }]) assert.equal(listFilters.safeParse(bad).success, false);
});
test('cross-tenant/nonexistent detail returns 404; DB error stays unavailable', async () => {
  const eqs: unknown[] = [];
  const query = { select: () => query, eq: (...args: unknown[]) => { eqs.push(args); return query; }, maybeSingle: async () => ({ data: null, error: null }) };
  await assert.rejects(customerForActor({ from: () => query } as unknown as SupabaseClient, actor, context.customerId), error => (error as { status: number }).status === 404);
  assert.deepEqual(eqs[0], ['company_id', context.companyId]);
});
function identityDb(rows: unknown[], calls: Record<string, unknown>[]) {
  const q = { select: () => q, eq: (key: string, value: string) => { assert.equal(key, 'company_id'); assert.equal(value, context.companyId); return q; }, in: async () => ({ data: rows, error: null }) };
  return { from: () => q, rpc: async (_name: string, args: Record<string, unknown>) => { calls.push(args); return { data: { status: 'CONFLICT' }, error: null }; } } as unknown as SupabaseClient;
}
test('exact provider ID and multiple identities resolve one existing customer', async () => {
  const db = identityDb([{ channel: 'ZALO', external_id: 'account:uid', customer_id: context.customerId, verified: true }, { channel: 'FACEBOOK', external_id: 'page:psid', customer_id: context.customerId, verified: true }], []);
  assert.deepEqual(await resolveCustomerIdentities(db, context.companyId, [{ type: 'ZALO', value: 'account:uid', verified: false }, { type: 'FACEBOOK', value: 'page:psid', verified: false }]), { status: 'EXACT', customerId: context.customerId });
});
test('unverified phone only suggests; verified phone exact-links', async () => {
  const row = { channel: 'PHONE', external_id: normalizeIdentity('PHONE','0912345678').key, customer_id: context.customerId, verified: true };
  assert.equal((await resolveCustomerIdentities(identityDb([row], []), context.companyId, [{ type: 'PHONE', value: '0912345678', verified: false }])).status, 'SUGGESTION');
  assert.equal((await resolveCustomerIdentities(identityDb([row], []), context.companyId, [{ type: 'PHONE', value: '0912345678', verified: true }])).status, 'EXACT');
});
test('identity conflict never auto-merges and is recorded', async () => {
  const calls: Record<string, unknown>[] = [];
  const rows = [{ channel: 'ZALO', external_id: 'account:uid', customer_id: context.customerId }, { channel: 'FACEBOOK', external_id: 'page:psid', customer_id: actor.userId }];
  const result = await resolveCustomerIdentities(identityDb(rows, calls), context.companyId, [{ type: 'ZALO', value: 'account:uid', verified: true }, { type: 'FACEBOOK', value: 'page:psid', verified: true }]);
  assert.deepEqual(result, { status: 'CONFLICT', customerId: null }); assert.equal(calls.length, 1);
});
test('default-OFF worker never claims or calls provider', async () => {
  delete process.env.CUSTOMER_DOSSIER_ENABLED;
  assert.deepEqual(await processDossierRefresh({ db: { rpc: () => { throw new Error('MUST_NOT_CALL'); } } as unknown as SupabaseClient }), { status: 'DISABLED' });
});
test('lead score uses documented CRM rubric, unknown without engagement, and never a model score', () => {
  const now = Date.parse('2026-10-23T11:00:00Z');
  assert.equal(dossierLeadScore(context, now), 20);
  assert.equal(dossierLeadScore({ ...context, sources: [] }, now), null);
  assert.equal(dossierLeadScore({ ...context, stage: 'LOST' }, now), 0);
  assert.equal(dossierLeadScore({ ...context, stage: 'PRICE_OFFERED', sources: [{ ...context.sources[0], text: 'Tôi đồng ý mua cửa.' }] }, now), 80);
});
