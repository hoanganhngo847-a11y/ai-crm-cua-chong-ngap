import test from 'node:test';
import assert from 'node:assert/strict';
import { createJavisBrainServer } from '../../services/javis-brain/server';
import { JavisRuntimeBackend } from '../../services/javis-brain/model';
import { JavisBrainProvider } from '../../features/ai-brain/javis-provider';
import { processDossierRefresh } from '../../features/customer-360/worker';
import type { DossierContext } from '../../features/customer-360/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { POST } from '../../app/api/cron/customer-dossier/route';
import { context, snapshot } from './fixture';

const token = 'synthetic-c360-service-token-000000000000';
test('existing Javis service and adapter support grounded dossier with auth and contract validation', async () => {
  let calls = 0;
  const server = createJavisBrainServer({ authToken: token, onAuditLog: () => undefined,
    modelBackend: { generate: async () => { throw new Error('TURN_NOT_EXPECTED'); }, generateDossier: async () => { calls++; return snapshot; } } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const adapter = new JavisBrainProvider({ baseUrl: 'https://javis.test', authToken: token, fetchImpl: (input, init) => fetch(String(input).replace('https://javis.test', url), init) });
    assert.deepEqual(await adapter.runDossier(context, { signal: AbortSignal.timeout(2000) }), snapshot);
    assert.equal(calls, 1);
    const noAuth = await fetch(`${url}/v1/brain/dossier`, { method: 'POST', body: JSON.stringify(context) }); assert.equal(noAuth.status, 401);
    const malformed = await fetch(`${url}/v1/brain/dossier`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-AI-Brain-Contract': 'v1', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...context, execute: 'sql' }) });
    assert.equal(malformed.status, 400); assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('Javis runtime dossier rejects natural-language/malformed and fabricated output; uses fresh read-only session', async () => {
  let responseText = 'I think the customer was born in 1998';
  const sessions: string[] = [];
  const runtime = new JavisRuntimeBackend({ baseUrl: 'https://runtime.test', internalToken: token, customFetch: async (_input, init) => {
    const body = new URLSearchParams(String(init?.body)); sessions.push(body.get('session') || '');
    assert.match(body.get('message') || '', /READ_ONLY/);
    return Response.json({ ok: true, text: responseText });
  } });
  await assert.rejects(runtime.generateDossier(context, { signal: AbortSignal.timeout(2000) }));
  responseText = JSON.stringify({ ...snapshot, summary: { text: 'Sinh năm 1998', sourceId: context.sources[0].id } });
  await assert.rejects(runtime.generateDossier(context, { signal: AbortSignal.timeout(2000) }), /UNSUPPORTED/);
  responseText = JSON.stringify(snapshot);
  assert.deepEqual(await runtime.generateDossier(context, { signal: AbortSignal.timeout(2000) }), snapshot);
  assert.equal(new Set(sessions).size, 3);
});
test('adapter rejects oversized and malformed response envelope', async () => {
  for (const body of ['a'.repeat(25 * 1024), JSON.stringify({ ok: true, version: 'dossier-v1', snapshot, reasoning: 'bad' })]) {
    const adapter = new JavisBrainProvider({ baseUrl: 'https://javis.test', authToken: token, fetchImpl: async () => new Response(body) });
    await assert.rejects(adapter.runDossier(context, { signal: AbortSignal.timeout(2000) }), /ADAPTER/);
  }
});
function workerDb(finishes: Record<string, unknown>[]) {
  const results: Record<string, unknown> = {
    customers: { name: 'Synthetic Customer', stage: 'LEAD_NEW', updated_at: '2026-10-23T10:00:00Z' },
    interactions: [{ id: 'cc360000-0000-4000-8000-000000000003', sanitized_content: context.sources[0].text, created_at: context.sources[0].at, direction: 'INBOUND' }],
    zalo_call_transcriptions: [], customer_ai_snapshots: [], customer_dossier_profiles: null,
  };
  return { rpc: async (name: string, args: Record<string, unknown>) => {
    if (name === 'c360_claim_refresh') return { data: [{ company_id: context.companyId, customer_id: context.customerId, claimed_version: 1, lock_token: context.customerId }], error: null };
    finishes.push(args); return { data: args.p_snapshot !== null, error: null };
  }, from: (table: string) => {
    const result = { data: results[table], error: null };
    const q: Record<string, unknown> = { then: (resolve: (r: unknown) => unknown) => Promise.resolve(resolve(result)) };
    for (const key of ['select','eq','in','not','order','limit','single','maybeSingle']) q[key] = () => q;
    return q;
  } } as unknown as SupabaseClient;
}
test('worker validates before persistence, freezes source authority, and preserves prior snapshot on AI failure', async () => {
  process.env.CUSTOMER_DOSSIER_ENABLED = 'true';
  try {
    for (const fail of [false, true]) {
      const finishes: Record<string, unknown>[] = [];
      const result = await processDossierRefresh({ db: workerDb(finishes), provider: { runDossier: async (c: DossierContext) => {
        assert.ok(Object.isFrozen(c) && Object.isFrozen(c.sources[0]));
        if (fail) return { ...snapshot, summary: { text: 'Fabricated school and GPA', sourceId: context.sources[0].id } };
        return snapshot;
      } } });
      assert.equal(result.status, fail ? 'FAILED' : 'COMPLETED');
      assert.equal(finishes.length, 1);
      assert.deepEqual(finishes[0].p_snapshot, fail ? null : snapshot);
    }
  } finally { delete process.env.CUSTOMER_DOSSIER_ENABLED; }
});
test('cron authenticates first and rejects unknown/duplicate selectors', async () => {
  process.env.CRON_SECRET = token;
  try {
    assert.equal((await POST(new Request('http://localhost/api/cron/customer-dossier?company_id=bad', { method: 'POST' }))).status, 401);
    assert.equal((await POST(new Request('http://localhost/api/cron/customer-dossier?limit=1&limit=2', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }))).status, 400);
  } finally { delete process.env.CRON_SECRET; }
});
