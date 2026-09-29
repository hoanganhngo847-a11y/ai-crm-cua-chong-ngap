/**
 * Zalo OA + care — integration gate against a REAL local Supabase stack (PostgREST + Postgres + Auth).
 * Complements tests/zalo/zalo_pglite.test.ts with what PGlite cannot prove:
 *   - production wiring through createAdminClient() / PostgREST (no injected client),
 *   - JWT role ACL (anon / authenticated) on Zalo tables, RPCs and the private schema,
 *   - true multi-connection concurrency on ingress, outbound and care claims.
 *
 * Prerequisite: `supabase start && supabase db reset`. Run: npm run test:zalo:db
 */
import assert from 'assert';
import crypto from 'crypto';
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

const COMPANY = 'c3000000-0000-0000-0000-000000000001';
const RUN = crypto.randomBytes(4).toString('hex');
const OA = `77${Date.now()}`;
const APP_ID = 'zalo-int-app';
const WEBHOOK_SECRET = `whsec_${RUN}`;
const SALE = { email: 'zalo_int_sale@test.local', password: 'Password123!' };
const BOSS = { email: 'zalo_int_boss@test.local', password: 'Password123!' };

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
    return new Response(JSON.stringify({ error: 0, message: 'ok', data: { user_id: 'u', user_name: 'Khách Tích Hợp' } }));
  }
  if (url.includes('/oa/message/cs')) {
    await new Promise((r) => setTimeout(r, 50));
    sends.push(String(init?.body));
    msgSeq++;
    return new Response(JSON.stringify({ error: 0, message: 'Success', data: { message_id: `int_pm_${RUN}_${msgSeq}` } }));
  }
  throw new Error(`Unexpected URL ${url}`);
}) as typeof fetch;

async function ensureUser(cfg: { email: string; password: string }, role: 'SALE' | 'BOSS_ADMIN'): Promise<string> {
  const { data: list } = await admin.auth.admin.listUsers();
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

async function main() {
  // Imported after env is set: the production code builds its own admin client from env.
  const { handleZaloWebhookRequest, ZaloInboxService } = await import('../../features/omnichannel/zalo');
  const { ZaloCareSchedulerService } = await import('../../features/care/zalo');

  console.log(`\n🧪 ZALO INTEGRATION GATE (local Supabase, run ${RUN})\n`);

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

  await test('production wiring (createAdminClient via env): valid OA 200, unknown OA 403', async () => {
    const ok = await handleZaloWebhookRequest(webhook(`zu_${RUN}_1`, `m_${RUN}_1`, 'Xin báo giá'), { fetchFn: fakeZaloFetch });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const payload = { app_id: APP_ID, oa_id: `unknown_${RUN}`, event_name: 'user_send_text', sender: { id: 'x' }, recipient: { id: 'y' }, message: { msg_id: 'z', text: 'x' }, timestamp: '1' };
    const body = JSON.stringify(payload);
    const mac = crypto.createHash('sha256').update(`${APP_ID}${body}1${WEBHOOK_SECRET}`).digest('hex');
    const unknown = await handleZaloWebhookRequest(new Request('http://x', { method: 'POST', headers: { 'x-zevent-signature': mac }, body }), { fetchFn: fakeZaloFetch });
    assert.strictEqual(unknown.status, 403);
  });

  await test('anon / authenticated cannot touch Zalo tables, RPCs or private secrets', async () => {
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

  await test('10 concurrent claims of one event → exactly one CLAIMED', async () => {
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

  await test('parallel webhook deliveries of one message → one interaction', async () => {
    const reqs = Array.from({ length: 6 }, () => webhook(`zu_${RUN}_par`, `m_${RUN}_par`, 'song song'));
    await Promise.all(reqs.map((r) => handleZaloWebhookRequest(r, { fetchFn: fakeZaloFetch })));
    const { count } = await admin
      .from('interactions')
      .select('id', { count: 'exact', head: true })
      .eq('external_ref', `zalo:${COMPANY}:${OA}:m_${RUN}_par`);
    assert.strictEqual(count, 1);
  });

  await test('parallel sends with the same commandId → provider called once', async () => {
    const { data: conv } = await admin
      .from('conversations')
      .select('id')
      .eq('company_id', COMPANY)
      .eq('external_conversation_id', `zu_${RUN}_1`)
      .single();
    const inbox = new ZaloInboxService({ fetchFn: fakeZaloFetch });
    const saleActor = {
      userId: saleId, email: SALE.email, fullName: 'SALE', profileStatus: 'ACTIVE' as const, companyId: COMPANY,
      memberId: 'm', role: 'SALE' as const, membershipStatus: 'ACTIVE' as const, aal: 'aal1' as const,
      isMfaEnrolled: false, isTrustedServerVerified: true as const,
    };
    const before = sends.length;
    const params = { conversationId: conv!.id, content: 'Báo giá đây ạ', commandId: `cmd_${RUN}` };
    const results = await Promise.all(Array.from({ length: 4 }, () => inbox.sendZaloReply(params, saleActor)));
    assert.strictEqual(sends.length, before + 1, results.map((r) => r.status).join(','));
    assert.strictEqual(results.filter((r) => r.status === 'SENT').length, 1);
  });

  await test('concurrent care workers → one send per schedule', async () => {
    const { data: conv } = await admin
      .from('conversations')
      .select('customer_id')
      .eq('company_id', COMPANY)
      .eq('external_conversation_id', `zu_${RUN}_1`)
      .single();
    await admin.from('care_schedules').upsert(
      { company_id: COMPANY, customer_id: conv!.customer_id, channel: 'ZALO', next_send_at: new Date(Date.now() - 60_000).toISOString(), enabled: true, stop_reason: null },
      { onConflict: 'company_id,customer_id,channel' }
    );
    const scheduler = new ZaloCareSchedulerService({ fetchFn: fakeZaloFetch });
    const before = sends.length;
    const results = await Promise.all(Array.from({ length: 3 }, () => scheduler.processDueSchedules({ companyId: COMPANY })));
    assert.strictEqual(results.reduce((n, r) => n + r.advanced, 0), 1);
    assert.strictEqual(sends.length, before + 1);
  });

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
