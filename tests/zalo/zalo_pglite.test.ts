/**
 * Zalo OA + Zalo care — review round 3 regression suite on REAL PostgreSQL (PGlite).
 * Every migration is applied; RPCs, constraints, triggers and transactions are production SQL.
 *
 * Run: npm run test:zalo
 */
import assert from 'assert';
import crypto from 'crypto';
import { createPgliteSupabase, PgliteSupabase } from './helpers/pglite-supabase';
import {
  DatabaseZaloTokenStore,
  ZaloClient,
  ZaloInboxService,
  ZaloSyncService,
  detectCareOptOut,
  handleZaloWebhookRequest,
  sanitizeMessageContent,
} from '../../features/omnichannel/zalo';
import {
  CARE_AUDIENCE_GROUPS,
  CareScheduleStoppedError,
  ZaloCareAnalyticsService,
  ZaloCareCampaignService,
  ZaloCareSchedulerService,
} from '../../features/care/zalo';
import type { TrustedActorContext } from '../../lib/server-auth/sensitive-context';

// ------------------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------------------
const COMPANY_A = '11111111-1111-1111-1111-111111111111';
const COMPANY_B = '22222222-2222-2222-2222-222222222222';
const SALE_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const TECH_A = 'aaaaaaaa-0000-0000-0000-000000000002';
const BOSS_A = 'aaaaaaaa-0000-0000-0000-000000000003';
const SALE_B = 'bbbbbbbb-0000-0000-0000-000000000001';
const BOSS_B = 'bbbbbbbb-0000-0000-0000-000000000003';

const OA_A1 = '1000000000000000001';
const OA_A2 = '1000000000000000002';
const OA_B = '2000000000000000001';
const APP_ID = '3000000000000000001';
const WEBHOOK_SECRET_A1 = 'whsec_a1';
const WEBHOOK_SECRET_A2 = 'whsec_a2';
const WEBHOOK_SECRET_B = 'whsec_b';

function actor(userId: string, companyId: string, role: 'SALE' | 'BOSS_ADMIN' | 'TECHNICIAN'): TrustedActorContext {
  return {
    userId,
    email: `${userId}@test.local`,
    fullName: 'Test',
    profileStatus: 'ACTIVE',
    companyId,
    memberId: `${userId}-m`,
    role,
    membershipStatus: 'ACTIVE',
    aal: 'aal1',
    isMfaEnrolled: false,
    isTrustedServerVerified: true,
  };
}

// ------------------------------------------------------------------------------
// Fake Zalo OpenAPI
// ------------------------------------------------------------------------------
type SendBehavior = 'ok' | 'network' | 'reject' | 'expired' | 'http500';

class FakeZalo {
  sends: { recipient: string; text: string; token: string }[] = [];
  oauthCalls = 0;
  profileCalls = 0;
  queue: SendBehavior[] = [];
  oauthDelayMs = 0;
  private seq = 0;

  fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input.toString();
    const headers = (init?.headers || {}) as Record<string, string>;

    if (url.includes('oauth.zaloapp.com')) {
      this.oauthCalls++;
      if (this.oauthDelayMs) await new Promise((r) => setTimeout(r, this.oauthDelayMs));
      const n = this.oauthCalls;
      return new Response(JSON.stringify({ access_token: `at_refreshed_${n}`, refresh_token: `rt_refreshed_${n}`, expires_in: 90000 }), { status: 200 });
    }
    if (url.includes('/oa/getprofile')) {
      this.profileCalls++;
      return new Response(JSON.stringify({ error: 0, message: 'ok', data: { user_id: 'x', user_name: 'Trần Thị Khách 0912345678' } }), { status: 200 });
    }
    if (url.includes('/oa/message/cs')) {
      const behavior = this.queue.shift() || 'ok';
      const body = JSON.parse(String(init?.body));
      if (behavior === 'network') {
        this.sends.push({ recipient: body.recipient.user_id, text: body.message.text, token: headers.access_token });
        throw new TypeError('fetch failed: socket hang up');
      }
      if (behavior === 'http500') {
        this.sends.push({ recipient: body.recipient.user_id, text: body.message.text, token: headers.access_token });
        return new Response('upstream error', { status: 502, statusText: 'Bad Gateway' });
      }
      if (behavior === 'expired') {
        return new Response(JSON.stringify({ error: -216, message: 'Access token is invalid' }), { status: 200 });
      }
      if (behavior === 'reject') {
        return new Response(JSON.stringify({ error: -230, message: 'User has not interacted with OA in 7 days' }), { status: 200 });
      }
      this.sends.push({ recipient: body.recipient.user_id, text: body.message.text, token: headers.access_token });
      this.seq++;
      return new Response(JSON.stringify({ error: 0, message: 'Success', data: { message_id: `pm_${this.seq}` } }), { status: 200 });
    }
    throw new Error(`Unexpected URL in fake Zalo: ${url}`);
  }) as typeof fetch;
}

// ------------------------------------------------------------------------------
// Tiny runner
// ------------------------------------------------------------------------------
let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  ✗ ${name}\n    ${(err as Error).stack}`);
  }
}

function signedWebhook(payload: Record<string, unknown>, secret: string, appId = APP_ID): Request {
  const body = JSON.stringify(payload);
  const mac = crypto.createHash('sha256').update(`${appId}${body}${payload.timestamp}${secret}`).digest('hex');
  return new Request('http://localhost/api/webhooks/zalo', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-zevent-signature': mac },
    body,
  });
}

let tsCounter = 1_780_000_000_000;
function userText(oaId: string, userId: string, msgId: string, text: string) {
  tsCounter += 1000;
  return {
    app_id: APP_ID,
    oa_id: oaId,
    event_name: 'user_send_text',
    sender: { id: userId },
    recipient: { id: oaId },
    message: { msg_id: msgId, text },
    timestamp: String(tsCounter),
  };
}

async function main() {
  console.log('\n🧪 ZALO ROUND-3 SUITE ON REAL POSTGRES (PGlite, all migrations applied)\n');
  const pg: PgliteSupabase = await createPgliteSupabase();
  const { db, client } = pg;
  const zalo = new FakeZalo();
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.query<T>(sql, params)).rows[0];

  await db.exec(`
    INSERT INTO public.companies (id, name) VALUES ('${COMPANY_A}', 'Cửa Chống Ngập A'), ('${COMPANY_B}', 'Cửa Chống Ngập B');
    INSERT INTO auth.users (id, email) VALUES ('${SALE_A}','sa@x'),('${TECH_A}','ta@x'),('${BOSS_A}','ba@x'),('${SALE_B}','sb@x'),('${BOSS_B}','bb@x');
    INSERT INTO public.user_profiles (id, full_name) VALUES ('${SALE_A}','Sale A'),('${TECH_A}','Tech A'),('${BOSS_A}','Boss A'),('${SALE_B}','Sale B'),('${BOSS_B}','Boss B')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.company_members (company_id, user_id, role) VALUES
      ('${COMPANY_A}','${SALE_A}','SALE'),('${COMPANY_A}','${TECH_A}','TECHNICIAN'),('${COMPANY_A}','${BOSS_A}','BOSS_ADMIN'),
      ('${COMPANY_B}','${SALE_B}','SALE'),('${COMPANY_B}','${BOSS_B}','BOSS_ADMIN');
  `);

  const connect = async (companyId: string, boss: string, oaId: string, webhookSecret: string) => {
    const { error } = await client.rpc('zalo_upsert_oa_connection', {
      p_company_id: companyId,
      p_oa_id: oaId,
      p_app_id: APP_ID,
      p_app_secret: `app_secret_${oaId}`,
      p_access_token: `at_${oaId}`,
      p_refresh_token: `rt_${oaId}`,
      p_token_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      p_webhook_secret: webhookSecret,
      p_actor_user_id: boss,
    });
    assert.ifError(error);
  };
  await connect(COMPANY_A, BOSS_A, OA_A1, WEBHOOK_SECRET_A1);
  await connect(COMPANY_B, BOSS_B, OA_B, WEBHOOK_SECRET_B);

  const deps = { supabase: client, fetchFn: zalo.fetch };

  // ============================================================================
  console.log('#1 Production tenant wiring');
  // ============================================================================
  await test('default ZaloSyncService({supabase}) resolves a valid OA from zalo_oa_configs', async () => {
    const service = new ZaloSyncService({ supabase: client, fetchFn: zalo.fetch });
    const res = await service.handleWebhookEvent(userText(OA_A1, 'zu_wiring', 'm_wiring', 'Xin chào'));
    assert.strictEqual(res.status, 'synced');
    const customer = await one<{ company_id: string; name: string }>(`SELECT company_id, name FROM public.customers WHERE id = $1`, [res.customerId]);
    assert.strictEqual(customer.company_id, COMPANY_A);
    // #7: profile fetched through ZaloClientFactory + DB token store of THIS OA; name sanitized.
    assert.ok(customer.name.startsWith('Trần Thị Khách'), customer.name);
    assert.ok(!customer.name.includes('0912345678'), 'display name must be phone-sanitized');
    assert.ok(zalo.profileCalls >= 1);
  });

  await test('webhook handler (production deps) → valid OA 200, unknown OA 403', async () => {
    const ok = await handleZaloWebhookRequest(signedWebhook(userText(OA_A1, 'zu_route', 'm_route', 'Hỏi giá cửa'), WEBHOOK_SECRET_A1), deps);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const unknown = await handleZaloWebhookRequest(signedWebhook(userText('999', 'zu_x', 'm_x', 'x'), WEBHOOK_SECRET_A1), deps);
    assert.strictEqual(unknown.status, 403);
    assert.strictEqual(unknown.body.error, 'TENANT_NOT_FOUND');
  });

  await test('signature is verified with the OA-specific secret (other tenant secret → 401)', async () => {
    const forged = await handleZaloWebhookRequest(signedWebhook(userText(OA_A1, 'zu_f', 'm_f', 'x'), WEBHOOK_SECRET_B), deps);
    assert.strictEqual(forged.status, 401);
    const noSig = await handleZaloWebhookRequest(
      new Request('http://x', { method: 'POST', body: JSON.stringify(userText(OA_A1, 'zu_f', 'm_f2', 'x')) }),
      deps
    );
    assert.strictEqual(noSig.status, 401);
    const wrongApp = await handleZaloWebhookRequest(
      signedWebhook({ ...userText(OA_A1, 'zu_f', 'm_f3', 'x'), app_id: 'other' }, WEBHOOK_SECRET_A1, 'other'),
      deps
    );
    assert.strictEqual(wrongApp.status, 401);
  });

  await test('tenant lookup outage → 503 (Zalo retries) instead of dropping the event with 403', async () => {
    const broken = pg.withRpcOverride((fn) =>
      fn === 'zalo_resolve_oa_tenant' ? { data: null, error: { message: 'connection reset' } } : null
    );
    const res = await handleZaloWebhookRequest(signedWebhook(userText(OA_A1, 'zu_503', 'm_503', 'x'), WEBHOOK_SECRET_A1), {
      supabase: broken,
      fetchFn: zalo.fetch,
    });
    assert.strictEqual(res.status, 503);
    assert.ok(!JSON.stringify(res.body).includes('connection reset'), 'no internal detail leaked');
  });

  // ============================================================================
  console.log('#2/#3 Ingress atomicity + FAILED retry');
  // ============================================================================
  await test('duplicate delivery of a processed event is a no-op', async () => {
    const payload = userText(OA_A1, 'zu_dup', 'm_dup', 'Lần 1');
    const first = await handleZaloWebhookRequest(signedWebhook(payload, WEBHOOK_SECRET_A1), deps);
    const second = await handleZaloWebhookRequest(signedWebhook(payload, WEBHOOK_SECRET_A1), deps);
    assert.strictEqual(first.body.status, 'synced');
    assert.strictEqual(second.body.status, 'duplicate');
    const n = await one<{ n: number }>(`SELECT count(*)::int n FROM public.interactions WHERE external_ref = $1`, [
      `zalo:${COMPANY_A}:${OA_A1}:m_dup`,
    ]);
    assert.strictEqual(n.n, 1);
  });

  await test('failure inside the DB transaction rolls back EVERYTHING (incl. unread_count) and the retry is processed', async () => {
    const first = userText(OA_A1, 'zu_atomic', 'm_atomic_1', 'Tin 1');
    await handleZaloWebhookRequest(signedWebhook(first, WEBHOOK_SECRET_A1), deps);
    const conv = await one<{ id: string; unread_count: number }>(
      `SELECT id, unread_count FROM public.conversations WHERE external_conversation_id = 'zu_atomic'`
    );
    assert.strictEqual(conv.unread_count, 1);

    await db.exec(`
      CREATE FUNCTION public.test_fail_raw() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected private raw failure'; END $$;
      CREATE TRIGGER test_fail_raw BEFORE INSERT ON private.interaction_raw_contents FOR EACH ROW EXECUTE FUNCTION public.test_fail_raw();
    `);
    const second = userText(OA_A1, 'zu_atomic', 'm_atomic_2', 'Tin 2');
    const failed = await handleZaloWebhookRequest(signedWebhook(second, WEBHOOK_SECRET_A1), deps);
    assert.strictEqual(failed.status, 500);
    assert.ok(!JSON.stringify(failed.body).includes('injected'), 'error sanitized');

    const after = await one<{ unread_count: number }>(`SELECT unread_count FROM public.conversations WHERE id = $1`, [conv.id]);
    assert.strictEqual(after.unread_count, 1, 'conversation mutation rolled back');
    const ints = await one<{ n: number }>(`SELECT count(*)::int n FROM public.interactions WHERE conversation_id = $1`, [conv.id]);
    assert.strictEqual(ints.n, 1, 'no interaction left behind');
    const ev = await one<{ status: string; last_error: string }>(
      `SELECT status, last_error FROM public.zalo_ingress_events WHERE external_ref = $1`,
      [`zalo:${COMPANY_A}:${OA_A1}:m_atomic_2`]
    );
    assert.strictEqual(ev.status, 'FAILED');

    await db.exec(`DROP TRIGGER test_fail_raw ON private.interaction_raw_contents; DROP FUNCTION public.test_fail_raw();`);
    const retry = await handleZaloWebhookRequest(signedWebhook(second, WEBHOOK_SECRET_A1), deps);
    assert.strictEqual(retry.body.status, 'synced', 'FAILED event must be re-claimed, not reported duplicate');
    const final = await one<{ unread_count: number }>(`SELECT unread_count FROM public.conversations WHERE id = $1`, [conv.id]);
    assert.strictEqual(final.unread_count, 2);
    const ev2 = await one<{ status: string; retry_count: number }>(
      `SELECT status, retry_count FROM public.zalo_ingress_events WHERE external_ref = $1`,
      [`zalo:${COMPANY_A}:${OA_A1}:m_atomic_2`]
    );
    assert.deepStrictEqual([ev2.status, ev2.retry_count], ['PROCESSED', 1]);
  });

  await test('parallel deliveries of the same event: exactly one ingestion', async () => {
    const payload = userText(OA_A1, 'zu_par', 'm_par', 'song song');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => handleZaloWebhookRequest(signedWebhook(payload, WEBHOOK_SECRET_A1), deps))
    );
    const statuses = results.map((r) => r.body.status || r.body.error);
    assert.strictEqual(statuses.filter((s) => s === 'synced').length, 1, statuses.join(','));
    const n = await one<{ n: number }>(`SELECT count(*)::int n FROM public.interactions WHERE external_ref LIKE '%:m_par'`);
    assert.strictEqual(n.n, 1);
  });

  // ============================================================================
  console.log('#13 Canonical namespaced external_ref');
  // ============================================================================
  await test('same provider msg id on two OAs of one company → two interactions, canonical refs', async () => {
    await connect(COMPANY_A, BOSS_A, OA_A2, WEBHOOK_SECRET_A2);
    await handleZaloWebhookRequest(signedWebhook(userText(OA_A1, 'zu_ns1', 'same_id', 'OA1'), WEBHOOK_SECRET_A1), deps);
    await handleZaloWebhookRequest(signedWebhook(userText(OA_A2, 'zu_ns2', 'same_id', 'OA2'), WEBHOOK_SECRET_A2), deps);
    const rows = (
      await db.query<{ external_ref: string; provider_msg_id: string }>(
        `SELECT i.external_ref, r.source_metadata->>'provider_msg_id' AS provider_msg_id
         FROM public.interactions i JOIN private.interaction_raw_contents r ON r.interaction_id = i.id
         WHERE i.external_ref LIKE '%:same_id' ORDER BY 1`
      )
    ).rows;
    assert.deepStrictEqual(
      rows.map((r) => r.external_ref),
      [`zalo:${COMPANY_A}:${OA_A1}:same_id`, `zalo:${COMPANY_A}:${OA_A2}:same_id`]
    );
    assert.ok(rows.every((r) => r.provider_msg_id === 'same_id'), 'raw provider id kept in private source_metadata');
  });

  await test('public interaction is sanitized, raw phone only in private zone', async () => {
    const res = await new ZaloSyncService({ supabase: client, fetchFn: zalo.fetch }).handleWebhookEvent(
      userText(OA_A1, 'zu_phone', 'm_phone', 'SĐT em là 0912.345.678 nhé')
    );
    const row = await one<{ sanitized_content: string; raw_content: string }>(
      `SELECT i.sanitized_content, r.raw_content FROM public.interactions i JOIN private.interaction_raw_contents r ON r.interaction_id = i.id WHERE i.id = $1`,
      [res.interactionId]
    );
    assert.ok(!row.sanitized_content.includes('345.678') && !row.sanitized_content.includes('0912345678'));
    assert.ok(row.raw_content.includes('0912.345.678'));
  });

  // ============================================================================
  console.log('#4/#5/#6 Outbound trust boundary, outbox, reconciliation');
  // ============================================================================
  const convA = await one<{ id: string }>(`SELECT id FROM public.conversations WHERE external_conversation_id = 'zu_route'`);
  const inbox = new ZaloInboxService({ supabase: client, fetchFn: zalo.fetch });

  await test('missing / unverified actor is rejected (401)', async () => {
    await assert.rejects(
      inbox.sendZaloReply({ conversationId: convA.id, content: 'x', commandId: 'c0' }, undefined as unknown as TrustedActorContext),
      (e: { status?: number }) => e.status === 401
    );
    const unverified = { ...actor(SALE_A, COMPANY_A, 'SALE'), isTrustedServerVerified: false } as unknown as TrustedActorContext;
    await assert.rejects(inbox.sendZaloReply({ conversationId: convA.id, content: 'x', commandId: 'c0' }, unverified), (e: { status?: number }) => e.status === 401);
  });

  await test('TECHNICIAN is rejected; forged SALE role for a TECHNICIAN user is rejected by the DB', async () => {
    const before = zalo.sends.length;
    await assert.rejects(inbox.sendZaloReply({ conversationId: convA.id, content: 'x', commandId: 'c1' }, actor(TECH_A, COMPANY_A, 'TECHNICIAN')), (e: { status?: number }) => e.status === 403);
    await assert.rejects(inbox.sendZaloReply({ conversationId: convA.id, content: 'x', commandId: 'c1' }, actor(TECH_A, COMPANY_A, 'SALE')), (e: { status?: number }) => e.status === 403);
    assert.strictEqual(zalo.sends.length, before, 'provider never called');
  });

  await test('cross-tenant SALE cannot send into another company conversation', async () => {
    const before = zalo.sends.length;
    await assert.rejects(inbox.sendZaloReply({ conversationId: convA.id, content: 'x', commandId: 'c2' }, actor(SALE_B, COMPANY_B, 'SALE')), (e: { status?: number }) => e.status === 404);
    assert.strictEqual(zalo.sends.length, before);
  });

  await test('outbox claim failure → fail-closed, provider NOT called', async () => {
    const broken = new ZaloInboxService({
      supabase: pg.withRpcOverride((fn) => (fn === 'zalo_claim_outbound_delivery' ? { data: null, error: { message: 'disk full' } } : null)),
      fetchFn: zalo.fetch,
    });
    const before = zalo.sends.length;
    await assert.rejects(broken.sendZaloReply({ conversationId: convA.id, content: 'x', commandId: 'c3' }, actor(SALE_A, COMPANY_A, 'SALE')));
    assert.strictEqual(zalo.sends.length, before);
  });

  await test('SALE send → SENT with canonical ref; retry with same commandId never re-sends', async () => {
    const before = zalo.sends.length;
    const params = { conversationId: convA.id, content: 'Dạ báo giá cửa bên em gửi anh/chị ạ', commandId: 'cmd-send-1' };
    const r1 = await inbox.sendZaloReply(params, actor(SALE_A, COMPANY_A, 'SALE'));
    assert.strictEqual(r1.status, 'SENT', JSON.stringify(r1));
    const r2 = await inbox.sendZaloReply(params, actor(SALE_A, COMPANY_A, 'SALE'));
    assert.strictEqual(r2.status, 'ALREADY_SENT');
    assert.strictEqual(r2.interactionId, r1.interactionId);
    assert.strictEqual(zalo.sends.length, before + 1, 'exactly one provider call');
    const i = await one<{ external_ref: string; actor_user_id: string; actor_type: string }>(
      `SELECT external_ref, actor_user_id, actor_type FROM public.interactions WHERE id = $1`,
      [r1.interactionId]
    );
    assert.strictEqual(i.external_ref, `zalo:${COMPANY_A}:${OA_A1}:${r1.externalMessageId}`);
    assert.deepStrictEqual([i.actor_type, i.actor_user_id], ['SALE', SALE_A]);
  });

  await test('Zalo echo (oa_send_text) of our own message does not create a duplicate interaction', async () => {
    const r = await inbox.sendZaloReply({ conversationId: convA.id, content: 'Echo test', commandId: 'cmd-echo' }, actor(SALE_A, COMPANY_A, 'SALE'));
    tsCounter += 1000;
    const echo = {
      app_id: APP_ID,
      oa_id: OA_A1,
      event_name: 'oa_send_text',
      sender: { id: OA_A1 },
      recipient: { id: 'zu_route' },
      message: { msg_id: r.externalMessageId, text: 'Echo test' },
      timestamp: String(tsCounter),
    };
    const res = await handleZaloWebhookRequest(signedWebhook(echo, WEBHOOK_SECRET_A1), deps);
    assert.strictEqual(res.body.status, 'duplicate');
  });

  await test('network error → UNCERTAIN; retry with same commandId does NOT resend', async () => {
    zalo.queue.push('network');
    const params = { conversationId: convA.id, content: 'Timeout test', commandId: 'cmd-uncertain' };
    const before = zalo.sends.length;
    const r1 = await inbox.sendZaloReply(params, actor(SALE_A, COMPANY_A, 'SALE'));
    assert.strictEqual(r1.status, 'UNCERTAIN');
    const r2 = await inbox.sendZaloReply(params, actor(SALE_A, COMPANY_A, 'SALE'));
    assert.strictEqual(r2.status, 'UNCERTAIN');
    assert.strictEqual(zalo.sends.length, before + 1);
    const d = await one<{ status: string }>(`SELECT status FROM public.zalo_outbound_deliveries WHERE command_id = 'cmd-uncertain'`);
    assert.strictEqual(d.status, 'PROVIDER_UNCERTAIN');
  });

  await test('definite provider rejection → FAILED; same commandId retry sends once more', async () => {
    zalo.queue.push('reject');
    const params = { conversationId: convA.id, content: 'Reject test', commandId: 'cmd-reject' };
    const r1 = await inbox.sendZaloReply(params, actor(SALE_A, COMPANY_A, 'SALE'));
    assert.strictEqual(r1.status, 'FAILED');
    const r2 = await inbox.sendZaloReply(params, actor(SALE_A, COMPANY_A, 'SALE'));
    assert.strictEqual(r2.status, 'SENT');
    const d = await one<{ attempts: number }>(`SELECT attempts FROM public.zalo_outbound_deliveries WHERE command_id = 'cmd-reject'`);
    assert.strictEqual(d.attempts, 2);
  });

  await test('finalize failure after provider success → PENDING_FINALIZE; reconcile finalizes without resending', async () => {
    await db.exec(`
      CREATE FUNCTION public.test_fail_outbound() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.direction = 'OUTBOUND' THEN RAISE EXCEPTION 'injected finalize failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_fail_outbound BEFORE INSERT ON public.interactions FOR EACH ROW EXECUTE FUNCTION public.test_fail_outbound();
    `);
    const before = zalo.sends.length;
    const r = await inbox.sendZaloReply({ conversationId: convA.id, content: 'Finalize test', commandId: 'cmd-finalize' }, actor(SALE_A, COMPANY_A, 'SALE'));
    assert.strictEqual(r.status, 'PENDING_FINALIZE');
    assert.strictEqual(r.success, true, 'message did reach Zalo');
    const d1 = await one<{ status: string; provider_msg_id: string }>(
      `SELECT status, provider_msg_id FROM public.zalo_outbound_deliveries WHERE command_id = 'cmd-finalize'`
    );
    assert.strictEqual(d1.status, 'PROVIDER_SENT_PENDING_FINALIZE');
    assert.ok(d1.provider_msg_id, 'provider_msg_id persisted before finalize');

    await db.exec(`DROP TRIGGER test_fail_outbound ON public.interactions; DROP FUNCTION public.test_fail_outbound();`);
    const rec = await inbox.reconcilePendingDeliveries({ companyId: COMPANY_A });
    assert.strictEqual(rec.reconciled, 1);
    assert.strictEqual(zalo.sends.length, before + 1, 'reconcile never calls the provider');
    const d2 = await one<{ status: string; interaction_id: string }>(
      `SELECT status, interaction_id FROM public.zalo_outbound_deliveries WHERE command_id = 'cmd-finalize'`
    );
    assert.strictEqual(d2.status, 'SENT');
    assert.ok(d2.interaction_id);
  });

  await test('system worker send needs an explicit principal of the same company', async () => {
    await assert.rejects(
      inbox.sendSystemZaloReply({ conversationId: convA.id, content: 'AI', commandId: 'sys-1' }, undefined as never),
      (e: { status?: number }) => e.status === 403
    );
    await assert.rejects(
      inbox.sendSystemZaloReply(
        { conversationId: convA.id, content: 'AI', commandId: 'sys-2' },
        { kind: 'SYSTEM_WORKER', companyId: COMPANY_B, actorType: 'AI', workerName: 'test' }
      ),
      (e: { status?: number }) => e.status === 404
    );
    const ok = await inbox.sendSystemZaloReply(
      { conversationId: convA.id, content: 'AI trả lời', commandId: 'sys-3' },
      { kind: 'SYSTEM_WORKER', companyId: COMPANY_A, actorType: 'AI', workerName: 'response-sla' }
    );
    assert.strictEqual(ok.status, 'SENT');
    const i = await one<{ actor_type: string; actor_user_id: string | null }>(`SELECT actor_type, actor_user_id FROM public.interactions WHERE id = $1`, [ok.interactionId]);
    assert.deepStrictEqual([i.actor_type, i.actor_user_id], ['AI', null]);
  });

  await test('outbox public row never stores the raw phone number', async () => {
    await inbox.sendZaloReply({ conversationId: convA.id, content: 'Hotline 0987654321', commandId: 'cmd-phone' }, actor(SALE_A, COMPANY_A, 'SALE'));
    const d = await one<{ content: string }>(`SELECT content FROM public.zalo_outbound_deliveries WHERE command_id = 'cmd-phone'`);
    assert.ok(!d.content.includes('0987654321'), d.content);
  });

  // ============================================================================
  console.log('#7/#8 Per-OA credentials and token rotation');
  // ============================================================================
  await test('secrets are not in public.zalo_oa_configs', async () => {
    const cols = (await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='zalo_oa_configs'`
    )).rows.map((r) => r.column_name);
    for (const secretCol of ['app_secret', 'access_token', 'refresh_token']) assert.ok(!cols.includes(secretCol), secretCol);
  });

  await test('each OA uses its own token (no cross-tenant credential)', async () => {
    const convB = await new ZaloSyncService({ supabase: client, fetchFn: zalo.fetch }).handleWebhookEvent(userText(OA_B, 'zu_b', 'm_b', 'Công ty B'));
    const inboxB = new ZaloInboxService({ supabase: client, fetchFn: zalo.fetch });
    await inboxB.sendZaloReply({ conversationId: convB.conversationId as string, content: 'B reply', commandId: 'cmd-b' }, actor(SALE_B, COMPANY_B, 'SALE'));
    const last = zalo.sends[zalo.sends.length - 1];
    assert.strictEqual(last.token, `at_${OA_B}`);
  });

  await test('expired token (-216) → single-flight refresh, rotation audited, message sent once', async () => {
    zalo.queue.push('expired');
    zalo.oauthDelayMs = 30;
    const oauthBefore = zalo.oauthCalls;
    const store = new DatabaseZaloTokenStore(client, { leaseWaitMs: 20, leaseWaitAttempts: 50 });
    const c1 = new ZaloClient({ companyId: COMPANY_A, oaId: OA_A1, tokenStore: store, fetchFn: zalo.fetch });
    const c2 = new ZaloClient({ companyId: COMPANY_A, oaId: OA_A1, tokenStore: store, fetchFn: zalo.fetch });
    const [t1, t2] = await Promise.all([c1.refreshAccessToken(), c2.refreshAccessToken()]);
    assert.strictEqual(zalo.oauthCalls, oauthBefore + 1, 'refresh token used exactly once');
    assert.strictEqual(t1.accessToken, t2.accessToken);
    const audit = await one<{ n: number }>(`SELECT count(*)::int n FROM public.audit_logs WHERE action = 'ZALO_OA_TOKEN_ROTATED' AND result = 'SUCCESS'`);
    assert.ok(audit.n >= 1);
    zalo.oauthDelayMs = 0;

    const send = await c1.sendTextMessageWithOutcome('zu_route', 'sau khi refresh');
    assert.strictEqual(send.outcome, 'ACCEPTED');
  });

  await test('no default/empty client: ZaloClient without credentials throws', async () => {
    assert.throws(() => new ZaloClient({ companyId: COMPANY_A, oaId: OA_A1 }));
  });

  // ============================================================================
  console.log('#9 Care scheduler claim / idempotency');
  // ============================================================================
  const careCustomer = await one<{ id: string }>(`SELECT customer_id AS id FROM public.conversations WHERE external_conversation_id = 'zu_wiring'`);
  const scheduler = new ZaloCareSchedulerService({ supabase: client, fetchFn: zalo.fetch });

  await test('two concurrent workers → provider called once; schedule advanced in same tx', async () => {
    await scheduler.createOrUpdateSchedule({ companyId: COMPANY_A, customerId: careCustomer.id, nextSendAt: new Date(Date.now() - 3600_000).toISOString() });
    const before = zalo.sends.length;
    const [a, b] = await Promise.all([
      scheduler.processDueSchedules({ companyId: COMPANY_A }),
      scheduler.processDueSchedules({ companyId: COMPANY_A }),
    ]);
    assert.strictEqual(a.advanced + b.advanced, 1);
    assert.strictEqual(zalo.sends.length, before + 1);
    const s = await one<{ future: boolean }>(`SELECT next_send_at > now() AS future FROM public.care_schedules WHERE customer_id = $1`, [careCustomer.id]);
    assert.strictEqual(s.future, true);
    const d = await one<{ status: string; campaign_id: string }>(`SELECT status, campaign_id FROM public.care_deliveries WHERE customer_id = $1 AND care_schedule_id IS NOT NULL`, [careCustomer.id]);
    assert.strictEqual(d.status, 'SENT');
    assert.ok(d.campaign_id, 'schedule delivery linked to the periodic care campaign');
  });

  await test('rejected send keeps schedule due; next tick re-claims the SAME delivery (attempt 2)', async () => {
    const other = await new ZaloSyncService({ supabase: client, fetchFn: zalo.fetch }).handleWebhookEvent(userText(OA_A1, 'zu_care2', 'm_care2', 'hi'));
    await scheduler.createOrUpdateSchedule({ companyId: COMPANY_A, customerId: other.customerId as string, nextSendAt: new Date(Date.now() - 60_000).toISOString() });
    zalo.queue.push('reject');
    const r1 = await scheduler.processDueSchedules({ companyId: COMPANY_A });
    assert.strictEqual(r1.failed, 1);
    const r2 = await scheduler.processDueSchedules({ companyId: COMPANY_A });
    assert.strictEqual(r2.advanced, 1);
    const rows = (await db.query<{ status: string; attempt_count: number }>(
      `SELECT status, attempt_count FROM public.care_deliveries WHERE customer_id = $1`, [other.customerId]
    )).rows;
    assert.deepStrictEqual(rows.map((r) => [r.status, r.attempt_count]), [['SENT', 2]]);
  });

  await test('timeout (UNCERTAIN) is never resent; cycle consumed', async () => {
    const other = await new ZaloSyncService({ supabase: client, fetchFn: zalo.fetch }).handleWebhookEvent(userText(OA_A1, 'zu_care3', 'm_care3', 'hi'));
    await scheduler.createOrUpdateSchedule({ companyId: COMPANY_A, customerId: other.customerId as string, nextSendAt: new Date(Date.now() - 60_000).toISOString() });
    zalo.queue.push('http500');
    const before = zalo.sends.length;
    const r1 = await scheduler.processDueSchedules({ companyId: COMPANY_A });
    const r2 = await scheduler.processDueSchedules({ companyId: COMPANY_A });
    assert.strictEqual(r1.uncertain, 1);
    assert.strictEqual(r2.processed, 0, 'schedule no longer due');
    assert.strictEqual(zalo.sends.length, before + 1);
  });

  await test('opt-out reply stops the schedule; stopped schedule is never re-enabled implicitly', async () => {
    const res = await handleZaloWebhookRequest(signedWebhook(userText(OA_A1, 'zu_wiring', 'm_optout', 'Dừng làm phiền giúp em'), WEBHOOK_SECRET_A1), deps);
    assert.strictEqual(res.status, 200);
    const s = await one<{ enabled: boolean; stop_reason: string }>(`SELECT enabled, stop_reason FROM public.care_schedules WHERE customer_id = $1`, [careCustomer.id]);
    assert.deepStrictEqual([s.enabled, s.stop_reason], [false, 'CUSTOMER_OPT_OUT']);
    await assert.rejects(scheduler.createOrUpdateSchedule({ companyId: COMPANY_A, customerId: careCustomer.id }), CareScheduleStoppedError);
    const reactivated = await scheduler.createOrUpdateSchedule({
      companyId: COMPANY_A,
      customerId: careCustomer.id,
      reactivation: { actorUserId: BOSS_A, reason: 'Khách gọi lại xin nhận tin' },
    });
    assert.strictEqual(reactivated.enabled, true);
    const audit = await one<{ n: number }>(`SELECT count(*)::int n FROM public.audit_logs WHERE action = 'CARE_SCHEDULE_REACTIVATED'`);
    assert.strictEqual(audit.n, 1);
  });

  await test('"chuyển khoản" is NOT an opt-out (substring bug)', async () => {
    assert.strictEqual(detectCareOptOut('Em chuyển khoản cọc rồi nhé'), false);
    assert.strictEqual(detectCareOptOut('Anh Huy hỏi giá'), false);
    assert.strictEqual(detectCareOptOut('hủy đơn hàng giúp em'), false);
    assert.strictEqual(detectCareOptOut('Hủy'), true);
    assert.strictEqual(detectCareOptOut('ĐỪNG GỬI TIN NỮA'), true);
    assert.strictEqual(detectCareOptOut('Không có nhu cầu ạ'), true);
  });

  // ============================================================================
  console.log('Care campaigns, receipts, responses, analytics');
  // ============================================================================
  await test('campaign: suppression, send once, receipts → DELIVERED/READ, reply → RESPONDED, metrics', async () => {
    const lead = await new ZaloSyncService({ supabase: client, fetchFn: zalo.fetch }).handleWebhookEvent(userText(OA_A1, 'zu_camp', 'm_camp', 'Cho xin giá'));
    const stopped = await new ZaloSyncService({ supabase: client, fetchFn: zalo.fetch }).handleWebhookEvent(userText(OA_A1, 'zu_camp_stop', 'm_camp_stop', 'Không có nhu cầu'));
    await db.query(`UPDATE public.customers SET stage = 'NEGOTIATING' WHERE id = ANY($1::uuid[])`, [[lead.customerId, stopped.customerId]]);

    const campaigns = new ZaloCareCampaignService({ supabase: client, fetchFn: zalo.fetch });
    const campaign = await campaigns.createCampaign({
      companyId: COMPANY_A,
      title: 'Ưu đãi mùa mưa',
      audienceGroup: CARE_AUDIENCE_GROUPS.CONSIDERING,
      messageTemplate: 'Chào {name}, bên em có ưu đãi cửa chống ngập mùa mưa ạ.',
    });
    const audience = await campaigns.getAudienceCustomers(COMPANY_A, CARE_AUDIENCE_GROUPS.CONSIDERING);
    assert.deepStrictEqual(audience.map((a) => a.customerId), [lead.customerId], 'opted-out customer suppressed');

    const before = zalo.sends.length;
    const r1 = await campaigns.executeCampaign(campaign.id, { companyId: COMPANY_A, delayMsBetweenBatches: 0 });
    const r2 = await campaigns.executeCampaign(campaign.id, { companyId: COMPANY_A, delayMsBetweenBatches: 0 });
    assert.strictEqual(r1.sent, 1);
    assert.strictEqual(r2.sent, 0, 're-run never resends');
    assert.strictEqual(zalo.sends.length, before + 1);
    await assert.rejects(campaigns.executeCampaign(campaign.id, { companyId: COMPANY_B }), 'other tenant cannot run it');

    const delivery = await one<{ id: string; external_message_ref: string }>(`SELECT id, external_message_ref FROM public.care_deliveries WHERE campaign_id = $1`, [campaign.id]);
    const receipt = (event: string) => {
      tsCounter += 1000;
      return {
        app_id: APP_ID,
        oa_id: OA_A1,
        event_name: event,
        sender: { id: OA_A1 },
        recipient: { id: 'zu_camp' },
        message: { msg_ids: [delivery.external_message_ref] },
        timestamp: String(tsCounter),
      };
    };
    await handleZaloWebhookRequest(signedWebhook(receipt('user_received_message'), WEBHOOK_SECRET_A1), deps);
    assert.strictEqual((await one<{ status: string }>(`SELECT status FROM public.care_deliveries WHERE id = $1`, [delivery.id])).status, 'DELIVERED');
    await handleZaloWebhookRequest(signedWebhook(receipt('user_seen_message'), WEBHOOK_SECRET_A1), deps);
    assert.strictEqual((await one<{ status: string }>(`SELECT status FROM public.care_deliveries WHERE id = $1`, [delivery.id])).status, 'READ');
    await handleZaloWebhookRequest(signedWebhook(userText(OA_A1, 'zu_camp', 'm_camp_reply', 'Cho em hỏi thêm về giá'), WEBHOOK_SECRET_A1), deps);
    assert.strictEqual((await one<{ status: string }>(`SELECT status FROM public.care_deliveries WHERE id = $1`, [delivery.id])).status, 'RESPONDED');

    const metrics = await new ZaloCareAnalyticsService({ supabase: client }).calculateCampaignMetrics(campaign.id);
    assert.deepStrictEqual([metrics.sentCount, metrics.deliveredCount, metrics.responseCount], [1, 1, 1]);
    const skipped = await one<{ status: string; error_code: string }>(
      `SELECT status, error_code FROM public.care_deliveries WHERE campaign_id = $1 AND customer_id = $2`,
      [campaign.id, stopped.customerId]
    );
    assert.strictEqual(skipped, undefined, 'suppressed customer is filtered before any claim');
  });

  await test('unfollow stops care with reason ZALO_UNFOLLOWED; follow does not re-enable', async () => {
    const who = await one<{ customer_id: string }>(`SELECT customer_id FROM public.conversations WHERE external_conversation_id = 'zu_care2'`);
    const ev = (name: string) => {
      tsCounter += 1000;
      return { app_id: APP_ID, oa_id: OA_A1, event_name: name, follower: { id: 'zu_care2' }, timestamp: String(tsCounter) };
    };
    await handleZaloWebhookRequest(signedWebhook(ev('unfollow'), WEBHOOK_SECRET_A1), deps);
    await handleZaloWebhookRequest(signedWebhook(ev('follow'), WEBHOOK_SECRET_A1), deps);
    const s = await one<{ enabled: boolean; stop_reason: string }>(`SELECT enabled, stop_reason FROM public.care_schedules WHERE customer_id = $1`, [who.customer_id]);
    assert.deepStrictEqual([s.enabled, s.stop_reason], [false, 'ZALO_UNFOLLOWED']);
  });

  await test('sanitizer masks Vietnamese phone formats', async () => {
    for (const phone of ['0912345678', '0912 345 678', '+84912345678', '0912-345-678']) {
      const { sanitizedText, hasSensitiveData } = sanitizeMessageContent(`Gọi ${phone} nhé`);
      assert.ok(hasSensitiveData && !sanitizedText.includes(phone), phone);
    }
  });

  await pg.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error('Failed:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

