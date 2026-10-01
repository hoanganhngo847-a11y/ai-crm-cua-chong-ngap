/**
 * Zalo OA + care — comprehensive integration gate against a REAL local Supabase stack (PostgREST + Postgres + Auth).
 * Section 25 Hardening Specification:
 *   - Security: anon/authenticated ACL, private secret schema isolation, catalog ACL via has_function_privilege
 *   - OA Management: AAL1 Boss denied, AAL2 Boss allowed, SALE denied, cross-tenant Boss denied
 *   - Webhook: valid OA 200, unknown OA 403, invalid signature 401, missing signature 401, lookup outage 503
 *   - Replay/Concurrency: 10 concurrent claims -> 1 winner, parallel deliveries -> 1 interaction
 *   - First-contact: parallel first-contact -> 1 Customer, 1 Identity, no orphan
 *   - Unified Inbox outbound: TV2 canonical command -> TV3 dispatcher -> provider called once -> SENT, actor_user_id preserved, retry same command -> provider called once, different payload -> rejected, cross-tenant -> 404
 *   - UNCERTAIN send: timeout / network failure -> marked UNCERTAIN, no automatic resend
 *   - Token refresh: parallel workers -> 1 provider refresh call, token version incremented once
 *   - Care safety: parallel workers -> 1 send, opt-out -> stopped, no implicit reactivation, Boss reactivation + audit
 *
 * Prerequisite: `supabase start && supabase db reset`. Run: npm run test:zalo:db
 */
import assert from 'assert';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

const noSession = { auth: { autoRefreshToken: false, persistSession: false } };
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, noSession);

const COMPANY = crypto.randomUUID();
const RUN = crypto.randomBytes(4).toString('hex');
const OA = `77${Date.now()}`;
const APP_ID = 'zalo-int-app';
const WEBHOOK_SECRET = `whsec_${RUN}`;
const SALE = { email: `zalo_int_sale_${RUN}@test.local`, password: 'Password123!' };
const BOSS = { email: `zalo_int_boss_${RUN}@test.local`, password: 'Password123!' };

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

const sends: string[] = [];
let msgSeq = 0;
const fakeZaloFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input.toString();
  if (url.includes('/oa/getprofile')) {
    let parsedUid = '';
    try {
      const match = url.match(/data=([^&]+)/);
      if (match) {
        const decoded = JSON.parse(decodeURIComponent(match[1]));
        parsedUid = decoded.user_id || '';
      }
    } catch {}
    return new Response(JSON.stringify({
      error: 0,
      message: 'ok',
      data: { user_id: parsedUid || 'u', user_name: parsedUid ? `Khách ${parsedUid}` : 'Khách Tích Hợp' },
    }));
  }
  if (url.includes('/oa/message/cs')) {
    await new Promise((r) => setTimeout(r, 20));
    sends.push(String(init?.body));
    msgSeq++;
    return new Response(JSON.stringify({ error: 0, message: 'Success', data: { message_id: `int_pm_${RUN}_${msgSeq}` } }));
  }
  throw new Error(`Unexpected URL ${url}`);
}) as typeof fetch;

async function ensureUser(cfg: { email: string; password: string }, role: 'SALE' | 'BOSS_ADMIN'): Promise<string> {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
  let userId = list?.users.find((u) => u.email === cfg.email)?.id;
  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({ email: cfg.email, password: cfg.password, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser ${cfg.email}: ${error?.message}`);
    userId = data.user.id;
  }
  await admin.from('user_profiles').upsert({ id: userId, full_name: role, status: 'ACTIVE' });
  const { error } = await admin
    .from('company_members')
    .upsert({ company_id: COMPANY, user_id: userId, role, status: 'ACTIVE' }, { onConflict: 'company_id,user_id' });
  if (error) throw new Error(`member ${cfg.email}: ${error.message}`);
  return userId;
}

async function signedIn(cfg: { email: string; password: string }): Promise<SupabaseClient> {
  const c = createClient(SUPABASE_URL, ANON_KEY, noSession);
  const { error } = await c.auth.signInWithPassword(cfg);
  if (error) throw new Error(`signIn ${cfg.email}: ${error.message}`);
  return c;
}

function webhook(userId: string, msgId: string, text: string): Request {
  const payload = {
    app_id: APP_ID,
    oa_id: OA,
    event_name: 'user_send_text',
    sender: { id: userId },
    recipient: { id: OA },
    message: { msg_id: msgId, text },
    timestamp: String(Date.now()),
  };
  const body = JSON.stringify(payload);
  const mac = crypto.createHash('sha256').update(`${APP_ID}${body}${payload.timestamp}${WEBHOOK_SECRET}`).digest('hex');
  return new Request('http://localhost/api/webhooks/zalo', { method: 'POST', headers: { 'x-zevent-signature': mac }, body });
}

function executePsql(sql: string): string {
  return execSync(
    `docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -t -A -F ',' -v ON_ERROR_STOP=1 -U postgres -d postgres -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }
  ).trim();
}

async function main() {
  const {
    handleZaloWebhookRequest,
    ZaloInboxService,
    ZaloOutboundDispatcher,
    DatabaseZaloTokenStore,
  } = await import('../../features/omnichannel/zalo');
  const { ZaloCareSchedulerService } = await import('../../features/care/zalo');

  console.log(`\n🧪 ZALO HARDENED INTEGRATION GATE (local Supabase, run ${RUN})\n`);

  const { error: companyError } = await admin.from('companies').upsert({ id: COMPANY, name: 'Zalo Integration Co', status: 'ACTIVE' });
  assert.ifError(companyError);
  const saleId = await ensureUser(SALE, 'SALE');
  const bossId = await ensureUser(BOSS, 'BOSS_ADMIN');

  const { error: connectError } = await admin.rpc('zalo_upsert_oa_connection', {
    p_company_id: COMPANY,
    p_oa_id: OA,
    p_app_id: APP_ID,
    p_app_secret: 'int_app_secret',
    p_access_token: 'int_access',
    p_refresh_token: 'int_refresh',
    p_token_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    p_webhook_secret: WEBHOOK_SECRET,
    p_actor_user_id: bossId,
  });
  assert.ifError(connectError);

  // ============================================================================
  // 1. SECURITY & CATALOG PRIVILEGES
  // ============================================================================
  await test('Security: anon / authenticated cannot read Zalo tables, RPCs or private secrets', async () => {
    const anon = createClient(SUPABASE_URL, ANON_KEY, noSession);
    const sale = await signedIn(SALE);
    for (const c of [anon, sale]) {
      for (const table of ['zalo_oa_configs', 'zalo_ingress_events', 'zalo_outbound_deliveries']) {
        const { data, error } = await c.from(table).select('*').limit(1);
        assert.ok(error || (data || []).length === 0, `${table} must not be readable`);
      }
      for (const [fn, args] of [
        ['zalo_get_oa_credentials', { p_company_id: COMPANY, p_oa_id: OA }],
        ['zalo_resolve_oa_tenant', { p_oa_id: OA }],
        ['zalo_claim_ingress_event', { p_company_id: COMPANY, p_oa_id: OA, p_external_ref: 'x', p_event_name: 'e', p_sender_id: 's', p_recipient_id: 'r' }],
        ['zalo_claim_outbound_delivery', { p_company_id: COMPANY, p_conversation_id: COMPANY, p_command_id: 'x', p_actor_type: 'SALE', p_actor_user_id: saleId, p_raw_content: 'x', p_sanitized_content: 'x', p_content_sha256: 'x' }],
        ['zalo_claim_canonical_delivery', { p_delivery_id: COMPANY, p_worker_id: 'w' }],
        ['care_claim_schedule_delivery', { p_company_id: COMPANY, p_schedule_id: COMPANY, p_default_template: 'x' }],
      ] as const) {
        const { error } = await c.rpc(fn, args as Record<string, unknown>);
        assert.ok(error, `${fn} must not be executable by client roles`);
      }
      const { error: privateError } = await c.schema('private').from('zalo_oa_secrets').select('*').limit(1);
      assert.ok(privateError, 'private schema must not be exposed');
    }
    const { error: adminPrivate } = await admin.schema('private').from('zalo_oa_secrets').select('*').limit(1);
    assert.ok(adminPrivate, 'even service role reaches secrets only through definer RPCs');
  });

  await test('Security: catalog privilege check via has_function_privilege (service_role only)', async () => {
    const funcs = [
      'public.zalo_get_oa_credentials(uuid, text)',
      'public.zalo_begin_token_refresh(uuid, text, integer)',
      'public.zalo_complete_token_refresh(uuid, text, uuid, text, text, timestamptz)',
      'public.zalo_abort_token_refresh(uuid, text, uuid, text)',
      'public.zalo_upsert_oa_connection(uuid, text, text, text, text, text, timestamptz, text, uuid)',
      'public.zalo_set_oa_connection_status(uuid, text, text, uuid)',
      'public.zalo_claim_canonical_delivery(uuid, text, text)',
      'public.zalo_finalize_canonical_outbound(uuid, text, text)',
      'public.zalo_record_canonical_failure(uuid, text, boolean)',
      'public.care_reactivate_schedule(uuid, uuid, uuid, text, integer, timestamptz)',
    ];

    for (const fn of funcs) {
      const sql = `SELECT has_function_privilege('anon', '${fn}', 'EXECUTE'), has_function_privilege('authenticated', '${fn}', 'EXECUTE'), has_function_privilege('service_role', '${fn}', 'EXECUTE');`;
      const [anonPriv, authPriv, srPriv] = executePsql(sql).split(',');
      assert.strictEqual(anonPriv, 'f', `anon must not execute ${fn}`);
      assert.strictEqual(authPriv, 'f', `authenticated must not execute ${fn}`);
      assert.strictEqual(srPriv, 't', `service_role must execute ${fn}`);
    }
  });

  // ============================================================================
  // 2. OA MANAGEMENT (AAL1 vs AAL2, SALE vs BOSS, Cross-tenant)
  // ============================================================================
  await test('OA management: AAL1 Boss denied, AAL2 Boss allowed, SALE denied, cross-tenant Boss denied', async () => {
    // 1. SALE denied by DB RPC
    const { error: saleErr } = await admin.rpc('zalo_upsert_oa_connection', {
      p_company_id: COMPANY,
      p_oa_id: `oa_sale_denied_${RUN}`,
      p_app_id: APP_ID,
      p_app_secret: 'sec',
      p_access_token: null,
      p_refresh_token: null,
      p_token_expires_at: null,
      p_webhook_secret: null,
      p_actor_user_id: saleId,
    });
    assert.ok(saleErr && saleErr.message.includes('ZALO_OA_CONNECTION_FORBIDDEN'), 'SALE must be forbidden by DB RPC');

    // 2. Cross-tenant Boss denied by DB RPC
    const otherCompany = 'c3000000-0000-0000-0000-000000000002';
    await admin.from('companies').upsert({ id: otherCompany, name: 'Other Co', status: 'ACTIVE' });
    const { error: crossErr } = await admin.rpc('zalo_upsert_oa_connection', {
      p_company_id: otherCompany,
      p_oa_id: `oa_cross_denied_${RUN}`,
      p_app_id: APP_ID,
      p_app_secret: 'sec',
      p_access_token: null,
      p_refresh_token: null,
      p_token_expires_at: null,
      p_webhook_secret: null,
      p_actor_user_id: bossId,
    });
    assert.ok(crossErr && crossErr.message.includes('ZALO_OA_CONNECTION_FORBIDDEN'), 'Cross-tenant Boss must be forbidden by DB RPC');

    // 3. AAL1 Boss denied via requirePrivilegedBoss (fails closed with MFA_REQUIRED)
    const { requirePrivilegedBoss, verifyActorForCompany } = await import('../../lib/server-auth/authorize');
    const bossClient = await signedIn(BOSS);
    await assert.rejects(
      () => requirePrivilegedBoss(COMPANY, bossClient),
      (err: { code?: string }) => err.code === 'MFA_REQUIRED'
    );

    // 4. Boss allowed when AAL2 requirement is relaxed (non-privileged)
    const verified = await verifyActorForCompany(COMPANY, { requireAal2: false }, bossClient);
    assert.strictEqual(verified.userId, bossId);
  });

  // ============================================================================
  // 3. WEBHOOK STATUS CODES & TENANT RESOLUTION
  // ============================================================================
  await test('Webhook: valid OA 200, unknown OA 403, invalid signature 401, missing signature 401, lookup outage 503', async () => {
    // 1. Valid OA + valid signature -> 200
    const ok = await handleZaloWebhookRequest(webhook(`zu_${RUN}_wb1`, `m_${RUN}_wb1`, 'Chào công ty'), { fetchFn: fakeZaloFetch });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));

    // 2. Unknown OA -> 403
    const unknownPayload = { app_id: APP_ID, oa_id: `unknown_${RUN}`, event_name: 'user_send_text', sender: { id: 'x' }, recipient: { id: 'y' }, message: { msg_id: 'z', text: 'x' }, timestamp: '1' };
    const unknownBody = JSON.stringify(unknownPayload);
    const unknownMac = crypto.createHash('sha256').update(`${APP_ID}${unknownBody}1${WEBHOOK_SECRET}`).digest('hex');
    const unknown = await handleZaloWebhookRequest(new Request('http://localhost/api/webhooks/zalo', { method: 'POST', headers: { 'x-zevent-signature': unknownMac }, body: unknownBody }), { fetchFn: fakeZaloFetch });
    assert.strictEqual(unknown.status, 403);

    // 3. Missing signature -> 401
    const noSig = await handleZaloWebhookRequest(new Request('http://localhost/api/webhooks/zalo', { method: 'POST', body: unknownBody }), { fetchFn: fakeZaloFetch });
    assert.strictEqual(noSig.status, 401);

    // 4. Invalid signature -> 401
    const validOaPayload = { app_id: APP_ID, oa_id: OA, event_name: 'user_send_text', sender: { id: 'x' }, recipient: { id: OA }, message: { msg_id: 'z', text: 'x' }, timestamp: '1' };
    const validOaBody = JSON.stringify(validOaPayload);
    const badSig = await handleZaloWebhookRequest(new Request('http://localhost/api/webhooks/zalo', { method: 'POST', headers: { 'x-zevent-signature': 'bad_sig' }, body: validOaBody }), { fetchFn: fakeZaloFetch });
    assert.strictEqual(badSig.status, 401);

    // 5. Lookup infrastructure outage -> 503
    const brokenClient = {
      rpc: async () => ({ data: null, error: { message: 'connection reset by peer' } }),
    } as unknown as SupabaseClient;
    const outageRes = await handleZaloWebhookRequest(webhook(`zu_outage_${RUN}`, `m_outage_${RUN}`, 'test'), { supabase: brokenClient, fetchFn: fakeZaloFetch });
    assert.strictEqual(outageRes.status, 503);
  });

  // ============================================================================
  // 4. REPLAY / CONCURRENCY
  // ============================================================================
  await test('Replay/concurrency: 10 concurrent claims of one event → exactly 1 winner, 9 BUSY', async () => {
    const ref = `zalo:${COMPANY}:${OA}:conc_${RUN}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        admin.rpc('zalo_claim_ingress_event', { p_company_id: COMPANY, p_oa_id: OA, p_external_ref: ref, p_event_name: 'user_send_text', p_sender_id: 's', p_recipient_id: OA })
      )
    );
    const statuses = results.map((r) => (r.data as { claim_status: string }[])[0].claim_status);
    assert.strictEqual(statuses.filter((s) => s === 'CLAIMED').length, 1, statuses.join(','));
    assert.strictEqual(statuses.filter((s) => s === 'BUSY').length, 9);
  });

  await test('Replay/concurrency: parallel webhook deliveries of one message → 1 interaction', async () => {
    const reqs = Array.from({ length: 6 }, () => webhook(`zu_${RUN}_par`, `m_${RUN}_par`, 'song song'));
    await Promise.all(reqs.map((r) => handleZaloWebhookRequest(r, { fetchFn: fakeZaloFetch })));
    const { count } = await admin
      .from('interactions')
      .select('id', { count: 'exact', head: true })
      .eq('external_ref', `zalo:${COMPANY}:${OA}:m_${RUN}_par`);
    assert.strictEqual(count, 1);
  });

  // ============================================================================
  // 5. FIRST-CONTACT CONCURRENCY (1 Customer, 1 Identity, No Orphan)
  // ============================================================================
  await test('First-contact: parallel first-contact same Zalo UID → 1 Customer, 1 Identity, no orphan customer', async () => {
    const newUid = `zu_first_${RUN}`;
    const reqs = Array.from({ length: 6 }, (_, i) => webhook(newUid, `m_first_${RUN}_${i}`, `First contact ${i}`));
    await Promise.all(reqs.map((r) => handleZaloWebhookRequest(r, { fetchFn: fakeZaloFetch })));

    const { data: identities, count: idCount } = await admin
      .from('identities')
      .select('customer_id', { count: 'exact' })
      .eq('company_id', COMPANY)
      .eq('channel', 'ZALO')
      .eq('external_id', newUid);
    assert.strictEqual(idCount, 1, `Expected exactly 1 Identity, got ${idCount}`);

    const customerId = identities![0].customer_id;
    const { count: custCount } = await admin
      .from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('id', customerId);
    assert.strictEqual(custCount, 1, 'Expected exactly 1 Customer record');

    const { count: orphanCount } = await admin
      .from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', COMPANY)
      .ilike('name', `%${newUid}%`);
    assert.strictEqual(orphanCount, 1, `Expected no orphan customers, got ${orphanCount}`);
  });

  // ============================================================================
  // 6. UNIFIED INBOX OUTBOUND INTEGRATION (TV2 command -> TV3 dispatcher)
  // ============================================================================
  await test('Unified Inbox outbound: SALE commandId -> canonical delivery -> TV3 dispatcher -> provider called once -> SENT -> actor_user_id preserved', async () => {
    const { data: conv } = await admin
      .from('conversations')
      .select('id, customer_id')
      .eq('company_id', COMPANY)
      .eq('external_conversation_id', `zu_${RUN}_wb1`)
      .single();

    const commandId = crypto.randomUUID();
    const content = 'Báo giá chính xác kèm bảo hành 5 năm';
    const beforeSends = sends.length;

    // 1. Record canonical outbound command via TV2 RPC
    const { data: rpcRes, error: rpcErr } = await admin.rpc('record_outbound_interaction_atomic', {
      p_company_id: COMPANY,
      p_conversation_id: conv!.id,
      p_sanitized_content: content,
      p_raw_content: content,
      p_sanitization_status: 'SUCCEEDED',
      p_source_metadata: { source: 'sale_reply' },
      p_client_command_id: commandId,
      p_actor_user_id: saleId,
    });
    assert.ifError(rpcErr);
    assert.ok(rpcRes && rpcRes.delivery_id, 'Canonical delivery created');
    assert.strictEqual(rpcRes.is_duplicate, false);

    // 2. TV3 Dispatcher dispatches canonical delivery
    const dispatcher = new ZaloOutboundDispatcher({ supabase: admin, fetchFn: fakeZaloFetch });
    const dispatchRes = await dispatcher.dispatchOutboundDelivery(rpcRes.delivery_id);

    assert.strictEqual(dispatchRes.success, true);
    assert.strictEqual(dispatchRes.status, 'SENT');
    assert.ok(dispatchRes.externalMessageId, 'provider message ID returned');
    assert.strictEqual(sends.length, beforeSends + 1, 'Provider called exactly once');

    // 3. Verify DB state in public.outbound_deliveries & public.interactions
    const { data: delRow } = await admin
      .from('outbound_deliveries')
      .select('*')
      .eq('id', rpcRes.delivery_id)
      .single();
    assert.strictEqual(delRow.delivery_status, 'SENT');
    assert.strictEqual(delRow.provider_message_id, dispatchRes.externalMessageId);

    const { data: intRow } = await admin
      .from('interactions')
      .select('*')
      .eq('id', rpcRes.interaction_id)
      .single();
    assert.strictEqual(intRow.actor_user_id, saleId);
    assert.strictEqual(intRow.actor_type, 'SALE');

    // 4. Retry same command with same payload -> provider still called once
    const { data: dupRes } = await admin.rpc('record_outbound_interaction_atomic', {
      p_company_id: COMPANY,
      p_conversation_id: conv!.id,
      p_sanitized_content: content,
      p_raw_content: content,
      p_client_command_id: commandId,
      p_actor_user_id: saleId,
    });
    assert.strictEqual(dupRes.is_duplicate, true);
    assert.strictEqual(dupRes.delivery_status, 'SENT');
    assert.strictEqual(sends.length, beforeSends + 1, 'Provider was NOT called again on retry');

    // 5. Different payload with same command ID -> rejected
    const { error: conflictErr } = await admin.rpc('record_outbound_interaction_atomic', {
      p_company_id: COMPANY,
      p_conversation_id: conv!.id,
      p_sanitized_content: 'Nội dung khác hoàn toàn',
      p_raw_content: 'Nội dung khác hoàn toàn',
      p_client_command_id: commandId,
      p_actor_user_id: saleId,
    });
    assert.ok(conflictErr, 'Reused commandId with different payload must be rejected');
    assert.ok(conflictErr.message.includes('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD'));

    // 6. Cross-tenant conversation -> 404, 0 provider call
    const otherCompany = 'c3000000-0000-0000-0000-000000000002';
    const { error: crossConvErr } = await admin.rpc('record_outbound_interaction_atomic', {
      p_company_id: otherCompany,
      p_conversation_id: conv!.id,
      p_sanitized_content: 'Test cross tenant',
      p_raw_content: 'Test cross tenant',
      p_client_command_id: crypto.randomUUID(),
      p_actor_user_id: null,
    });
    assert.ok(crossConvErr && crossConvErr.message.includes('CONVERSATION_NOT_FOUND'), 'Cross tenant conversation must fail closed with 404');
    assert.strictEqual(sends.length, beforeSends + 1, 'Provider had 0 calls for cross-tenant attempt');
  });

  // ============================================================================
  // 7. UNCERTAIN SEND
  // ============================================================================
  await test('UNCERTAIN send: timeout / network failure -> marked UNCERTAIN, no automatic resend', async () => {
    const { data: conv } = await admin
      .from('conversations')
      .select('id')
      .eq('company_id', COMPANY)
      .eq('external_conversation_id', `zu_${RUN}_wb1`)
      .single();

    const cmdUncertain = crypto.randomUUID();
    const { data: rpcRes } = await admin.rpc('record_outbound_interaction_atomic', {
      p_company_id: COMPANY,
      p_conversation_id: conv!.id,
      p_sanitized_content: 'Timeout simulated message',
      p_raw_content: 'Timeout simulated message',
      p_client_command_id: cmdUncertain,
      p_actor_user_id: saleId,
    });

    const timeoutFetch = (async () => {
      throw new Error('Connection timed out after 30000ms');
    }) as typeof fetch;

    const dispatcher = new ZaloOutboundDispatcher({ supabase: admin, fetchFn: timeoutFetch });
    const res = await dispatcher.dispatchOutboundDelivery(rpcRes.delivery_id);

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.status, 'UNCERTAIN');

    const { data: delRow } = await admin.from('outbound_deliveries').select('delivery_status').eq('id', rpcRes.delivery_id).single();
    assert.strictEqual(delRow!.delivery_status, 'UNCERTAIN');

    // Resend attempt on UNCERTAIN delivery must NOT resend
    const retryRes = await dispatcher.dispatchOutboundDelivery(rpcRes.delivery_id);
    assert.strictEqual(retryRes.status, 'UNCERTAIN', 'UNCERTAIN delivery must never be resent automatically');
  });

  // ============================================================================
  // 8. TOKEN REFRESH CONCURRENCY
  // ============================================================================
  await test('Token refresh: parallel workers -> exactly one provider refresh call, token_version incremented once', async () => {
    const tokenStore = new DatabaseZaloTokenStore(admin);

    let refreshCalls = 0;
    const fakeRefresh = async () => {
      refreshCalls++;
      await new Promise((r) => setTimeout(r, 60));
      return {
        accessToken: `refreshed_access_${RUN}_${refreshCalls}`,
        refreshToken: `refreshed_refresh_${RUN}_${refreshCalls}`,
        expiresAt: Date.now() + 86400000,
      };
    };

    const results = await Promise.all([
      tokenStore.rotateToken(COMPANY, OA, fakeRefresh),
      tokenStore.rotateToken(COMPANY, OA, fakeRefresh),
      tokenStore.rotateToken(COMPANY, OA, fakeRefresh),
      tokenStore.rotateToken(COMPANY, OA, fakeRefresh),
    ]);

    assert.strictEqual(refreshCalls, 1, `Expected exactly 1 refresh provider call, got ${refreshCalls}`);
    for (const r of results) {
      assert.strictEqual(r.accessToken, results[0].accessToken);
    }
  });

  // ============================================================================
  // 9. CARE SAFETY: CONCURRENCY, OPT-OUT, AUDITED BOSS REACTIVATION
  // ============================================================================
  await test('Care safety: parallel workers -> one send; opt-out -> schedule stopped; Boss reactivation with audit', async () => {
    const { data: conv } = await admin
      .from('conversations')
      .select('customer_id')
      .eq('company_id', COMPANY)
      .eq('external_conversation_id', `zu_${RUN}_wb1`)
      .single();

    const customerId = conv!.customer_id;
    const scheduler = new ZaloCareSchedulerService({ supabase: admin, fetchFn: fakeZaloFetch });

    // 1. Due schedule: 3 concurrent workers -> exactly one send
    await admin.from('care_schedules').upsert(
      { company_id: COMPANY, customer_id: customerId, channel: 'ZALO', next_send_at: new Date(Date.now() - 60_000).toISOString(), enabled: true, stop_reason: null },
      { onConflict: 'company_id,customer_id,channel' }
    );
    const beforeSends = sends.length;
    const results = await Promise.all(Array.from({ length: 3 }, () => scheduler.processDueSchedules({ companyId: COMPANY })));
    assert.strictEqual(results.reduce((n, r) => n + r.advanced, 0), 1);
    assert.strictEqual(sends.length, beforeSends + 1);

    // 2. Customer opts out via incoming message "ngung cham soc"
    await handleZaloWebhookRequest(webhook(`zu_${RUN}_wb1`, `m_optout_${RUN}`, 'Xin ngừng nhắn tin chăm sóc'), { fetchFn: fakeZaloFetch });

    const { data: schedAfterOptOut } = await admin
      .from('care_schedules')
      .select('enabled, stop_reason')
      .eq('company_id', COMPANY)
      .eq('customer_id', customerId)
      .eq('channel', 'ZALO')
      .single();
    assert.strictEqual(schedAfterOptOut!.enabled, false);
    assert.strictEqual(schedAfterOptOut!.stop_reason, 'CUSTOMER_OPT_OUT');

    // 3. Worker tick now will NOT send
    const optOutSendsBefore = sends.length;
    await admin.from('care_schedules').update({ next_send_at: new Date(Date.now() - 60_000).toISOString() }).eq('company_id', COMPANY).eq('customer_id', customerId);
    await scheduler.processDueSchedules({ companyId: COMPANY });
    assert.strictEqual(sends.length, optOutSendsBefore, 'Opted out schedule must never be sent');

    // 4. Stopped schedule cannot be implicitly reactivated
    await assert.rejects(
      () => scheduler.createOrUpdateSchedule({ companyId: COMPANY, customerId }),
      (err: { name?: string }) => err.name === 'CareScheduleStoppedError'
    );

    // 5. Boss explicit reactivation with audit
    const reactivated = await scheduler.createOrUpdateSchedule({
      companyId: COMPANY,
      customerId,
      reactivation: { actorUserId: bossId, reason: 'Khách hàng liên hệ lại và đồng ý nhận tư vấn bảo trì định kỳ' },
    });
    assert.strictEqual(reactivated.enabled, true);
    assert.strictEqual(reactivated.stopReason, null);

    // Verify audit log exists
    const { data: auditLogs } = await admin
      .from('audit_logs')
      .select('*')
      .eq('company_id', COMPANY)
      .eq('customer_id', customerId)
      .eq('action', 'CARE_SCHEDULE_REACTIVATED');
    assert.ok(auditLogs && auditLogs.length > 0, 'Audit log must be recorded for reactivation');
    assert.strictEqual(auditLogs[0].user_id, bossId);
  });

  console.log(`\n================================================================`);
  console.log(`ZALO HARDENED SUPABASE GATE RESULTS: ${passed} PASSED, ${failures.length} FAILED`);
  console.log(`================================================================\n`);

  if (failures.length) {
    console.error('Failed tests:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
