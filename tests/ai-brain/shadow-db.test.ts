import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// 0. Environment & Fail-Closed Local URL Validation
// ---------------------------------------------------------------------------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !serviceKey || !anonKey) {
  throw new Error(
    'AI Brain shadow DB test requires local Supabase env: ' +
    'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_ANON_KEY',
  );
}

const parsedUrl = new URL(url);
if (!['localhost', '127.0.0.1'].includes(parsedUrl.hostname)) {
  throw new Error(`Fail-closed: local Supabase URL required (localhost/127.0.0.1), got: ${parsedUrl.hostname}`);
}

const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

// Deterministic Fixture IDs
const FIXTURE_COMPANY_A_ID = '00000000-0000-4000-8000-000000000088';
const FIXTURE_COMPANY_B_ID = '00000000-0000-4000-8000-000000000089';
const FIXTURE_CUSTOMER_A_ID = '00000000-0000-4000-8000-000000000090';
const FIXTURE_CUSTOMER_B_ID = '00000000-0000-4000-8000-000000000091';
const FIXTURE_CONVO_A_FB_ID = '00000000-0000-4000-8000-000000000092';
const FIXTURE_CONVO_A_ZL_ID = '00000000-0000-4000-8000-000000000093';
const FIXTURE_CONVO_B_FB_ID = '00000000-0000-4000-8000-000000000094';

let fixturePromise: Promise<void> | null = null;

async function provisionFixture(): Promise<void> {
  const companyInsert = await service
    .from('companies')
    .upsert(
      [
        { id: FIXTURE_COMPANY_A_ID, name: 'AI Brain Shadow Fixture A', status: 'ACTIVE' },
        { id: FIXTURE_COMPANY_B_ID, name: 'AI Brain Shadow Fixture B', status: 'ACTIVE' },
      ],
      { onConflict: 'id', ignoreDuplicates: true },
    );
  assert.ifError(companyInsert.error);

  const customerInsert = await service
    .from('customers')
    .upsert(
      [
        {
          id: FIXTURE_CUSTOMER_A_ID,
          company_id: FIXTURE_COMPANY_A_ID,
          customer_code: 'AI-SHADOW-CUST-A',
          name: 'AI Brain Shadow Customer A',
          source: 'MANUAL',
          stage: 'LEAD_NEW',
        },
        {
          id: FIXTURE_CUSTOMER_B_ID,
          company_id: FIXTURE_COMPANY_B_ID,
          customer_code: 'AI-SHADOW-CUST-B',
          name: 'AI Brain Shadow Customer B',
          source: 'MANUAL',
          stage: 'LEAD_NEW',
        },
      ],
      { onConflict: 'id', ignoreDuplicates: true },
    );
  assert.ifError(customerInsert.error);

  const conversationInsert = await service
    .from('conversations')
    .upsert(
      [
        {
          id: FIXTURE_CONVO_A_FB_ID,
          company_id: FIXTURE_COMPANY_A_ID,
          customer_id: FIXTURE_CUSTOMER_A_ID,
          channel: 'FACEBOOK',
          external_conversation_id: 'ext-fb-shadow-a',
          status: 'OPEN',
        },
        {
          id: FIXTURE_CONVO_A_ZL_ID,
          company_id: FIXTURE_COMPANY_A_ID,
          customer_id: FIXTURE_CUSTOMER_A_ID,
          channel: 'ZALO',
          external_conversation_id: 'ext-zl-shadow-a',
          status: 'OPEN',
        },
        {
          id: FIXTURE_CONVO_B_FB_ID,
          company_id: FIXTURE_COMPANY_B_ID,
          customer_id: FIXTURE_CUSTOMER_B_ID,
          channel: 'FACEBOOK',
          external_conversation_id: 'ext-fb-shadow-b',
          status: 'OPEN',
        },
      ],
      { onConflict: 'id', ignoreDuplicates: true },
    );
  assert.ifError(conversationInsert.error);
}

async function ensureFixtures(): Promise<void> {
  fixturePromise ??= provisionFixture();
  await fixturePromise;
}

/**
 * Creates an authenticated user client with password < 72 bytes.
 */
async function createAuthenticatedFixtureClient(): Promise<{ client: SupabaseClient; userId: string }> {
  const email = `shadow-${randomUUID()}@example.test`;
  const password = `Pass!${randomUUID().replace(/-/g, '').slice(0, 16)}`; // Strict < 72 bytes
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(created.error);
  assert.ok(created.data.user?.id);

  const client = createClient(url!, anonKey!, { auth: { persistSession: false, autoRefreshToken: false } });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signedIn.error);
  assert.ok(signedIn.data.session);

  return { client, userId: created.data.user.id };
}

/**
 * Drains and marks existing runs as SKIPPED to ensure determinism without DELETE.
 * Strictly scoped to fixture companies to prevent mutating any other tenant queue.
 */
async function drainPendingRuns(): Promise<void> {
  const res = await service
    .from('ai_brain_shadow_runs')
    .update({
      status: 'SKIPPED',
      completed_at: new Date().toISOString(),
      locked_at: null,
      lock_token: null,
    })
    .in('company_id', [FIXTURE_COMPANY_A_ID, FIXTURE_COMPANY_B_ID])
    .in('status', ['PENDING', 'PROCESSING', 'FAILED']);
  assert.ifError(res.error);
}

function getValidatedContainer(): string {
  const container = process.env.SUPABASE_DB_CONTAINER || 'supabase_db_ai-crm-cua-chong-ngap';
  if (!/^[a-zA-Z0-9_.-]+$/.test(container)) {
    throw new Error(`Invalid SUPABASE_DB_CONTAINER name: ${container}`);
  }
  return container;
}

/**
 * Runs psql command inside Supabase local container for transactional timestamp adjustment or metadata verification.
 * Uses execFileSync with explicit argument vector (no shell execution) and validated container name.
 */
function executeRawSql(sql: string): string {
  const validatedContainer = getValidatedContainer();
  return execFileSync(
    'docker',
    ['exec', '-i', validatedContainer, 'psql', '-X', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'],
    { input: sql, encoding: 'utf8', timeout: 10000 },
  );
}

// Ensure settings for owned fixtures are disabled after the suite completes
after(async () => {
  await drainPendingRuns();
  const settingsCleanup = await service
    .from('ai_brain_shadow_settings')
    .update({ enabled: false })
    .in('company_id', [FIXTURE_COMPANY_A_ID, FIXTURE_COMPANY_B_ID]);
  assert.ifError(settingsCleanup.error);
});

// ---------------------------------------------------------------------------
// A: Default-off No Settings; Disabled / Wrong Tenant / Wrong Channel No Enqueue
// ---------------------------------------------------------------------------
test('A: Default-off no settings; disabled / wrong tenant / wrong channel no enqueue', async () => {
  await ensureFixtures();

  // 1. Default-off with no settings entry at all for fresh company
  const freshCompanyId = randomUUID();
  const freshCustomerId = randomUUID();
  const freshConvoId = randomUUID();

  const cInsert = await service.from('companies').insert({ id: freshCompanyId, name: 'Default Off Co', status: 'ACTIVE' });
  assert.ifError(cInsert.error);

  const custInsert = await service.from('customers').insert({
    id: freshCustomerId,
    company_id: freshCompanyId,
    customer_code: `CODE-${randomUUID().slice(0, 8)}`,
    name: 'Default Off Cust',
    source: 'MANUAL',
    stage: 'LEAD_NEW',
  });
  assert.ifError(custInsert.error);

  const convInsert = await service.from('conversations').insert({
    id: freshConvoId,
    company_id: freshCompanyId,
    customer_id: freshCustomerId,
    channel: 'FACEBOOK',
    external_conversation_id: `ext-${randomUUID()}`,
    status: 'OPEN',
  });
  assert.ifError(convInsert.error);

  const interaction1 = await service
    .from('interactions')
    .insert({
      company_id: freshCompanyId,
      customer_id: freshCustomerId,
      conversation_id: freshConvoId,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitization_status: 'SUCCEEDED',
      sanitized_content: 'Message when no settings configured',
    })
    .select('id')
    .single();
  assert.ifError(interaction1.error);

  const runs1 = await service.from('ai_brain_shadow_runs').select('id').eq('source_interaction_id', interaction1.data.id);
  assert.ifError(runs1.error);
  assert.equal(runs1.data.length, 0, 'Must NOT enqueue when no settings exist');

  // 2. Disabled explicitly (enabled = false)
  const setInsert = await service.from('ai_brain_shadow_settings').insert({
    company_id: freshCompanyId,
    channel: 'MESSENGER',
    enabled: false,
  });
  assert.ifError(setInsert.error);

  const interaction2 = await service
    .from('interactions')
    .insert({
      company_id: freshCompanyId,
      customer_id: freshCustomerId,
      conversation_id: freshConvoId,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitization_status: 'SUCCEEDED',
      sanitized_content: 'Message when settings enabled=false',
    })
    .select('id')
    .single();
  assert.ifError(interaction2.error);

  const runs2 = await service.from('ai_brain_shadow_runs').select('id').eq('source_interaction_id', interaction2.data.id);
  assert.ifError(runs2.error);
  assert.equal(runs2.data.length, 0, 'Must NOT enqueue when settings enabled=false');

  // 3. Wrong tenant: settings enabled for Company B, but interaction is for Company A
  const sB = await service
    .from('ai_brain_shadow_settings')
    .upsert({ company_id: FIXTURE_COMPANY_B_ID, channel: 'MESSENGER', enabled: true }, { onConflict: 'company_id,channel' });
  assert.ifError(sB.error);

  const sA = await service
    .from('ai_brain_shadow_settings')
    .upsert({ company_id: FIXTURE_COMPANY_A_ID, channel: 'MESSENGER', enabled: false }, { onConflict: 'company_id,channel' });
  assert.ifError(sA.error);

  const interaction3 = await service
    .from('interactions')
    .insert({
      company_id: FIXTURE_COMPANY_A_ID,
      customer_id: FIXTURE_CUSTOMER_A_ID,
      conversation_id: FIXTURE_CONVO_A_FB_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitization_status: 'SUCCEEDED',
      sanitized_content: 'Message for tenant with disabled settings',
    })
    .select('id')
    .single();
  assert.ifError(interaction3.error);

  const runs3 = await service.from('ai_brain_shadow_runs').select('id').eq('source_interaction_id', interaction3.data.id);
  assert.ifError(runs3.error);
  assert.equal(runs3.data.length, 0, 'Must NOT enqueue across tenant boundaries');

  // 4. Wrong channel: settings enabled for ZALO only, interaction arrives on FACEBOOK
  const sZalo = await service
    .from('ai_brain_shadow_settings')
    .upsert({ company_id: FIXTURE_COMPANY_A_ID, channel: 'ZALO', enabled: true }, { onConflict: 'company_id,channel' });
  assert.ifError(sZalo.error);

  const sFb = await service
    .from('ai_brain_shadow_settings')
    .upsert({ company_id: FIXTURE_COMPANY_A_ID, channel: 'MESSENGER', enabled: false }, { onConflict: 'company_id,channel' });
  assert.ifError(sFb.error);

  const interaction4 = await service
    .from('interactions')
    .insert({
      company_id: FIXTURE_COMPANY_A_ID,
      customer_id: FIXTURE_CUSTOMER_A_ID,
      conversation_id: FIXTURE_CONVO_A_FB_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitization_status: 'SUCCEEDED',
      sanitized_content: 'FB interaction when only ZALO is enabled',
    })
    .select('id')
    .single();
  assert.ifError(interaction4.error);

  const runs4 = await service.from('ai_brain_shadow_runs').select('id').eq('source_interaction_id', interaction4.data.id);
  assert.ifError(runs4.error);
  assert.equal(runs4.data.length, 0, 'Must NOT enqueue when channel does not match enabled settings');
});

// ---------------------------------------------------------------------------
// B: PostgREST ACL: anon/auth Denied, service S/I/U Succeeds, .delete Fails
// ---------------------------------------------------------------------------
test('B: Both tables anon/auth select code 42501 denied, service select/insert/update succeeds, .delete code 42501 fails', async () => {
  await ensureFixtures();
  const authFixture = await createAuthenticatedFixtureClient();

  try {
    // 1. ai_brain_shadow_settings ACL
    const anonSelSettings = await anon.from('ai_brain_shadow_settings').select('*').limit(1);
    assert.ok(anonSelSettings.error, 'anon must be denied SELECT on settings');
    assert.equal(anonSelSettings.error?.code, '42501');

    const authSelSettings = await authFixture.client.from('ai_brain_shadow_settings').select('*').limit(1);
    assert.ok(authSelSettings.error, 'authenticated must be denied SELECT on settings');
    assert.equal(authSelSettings.error?.code, '42501');

    const sInsertSettings = await service
      .from('ai_brain_shadow_settings')
      .upsert({ company_id: FIXTURE_COMPANY_A_ID, channel: 'MESSENGER', enabled: true }, { onConflict: 'company_id,channel' });
    assert.ifError(sInsertSettings.error);

    const sSelSettings = await service
      .from('ai_brain_shadow_settings')
      .select('enabled')
      .eq('company_id', FIXTURE_COMPANY_A_ID)
      .eq('channel', 'MESSENGER')
      .single();
    assert.ifError(sSelSettings.error);
    assert.equal(sSelSettings.data?.enabled, true);

    const sUpdSettings = await service
      .from('ai_brain_shadow_settings')
      .update({ enabled: false })
      .eq('company_id', FIXTURE_COMPANY_A_ID)
      .eq('channel', 'MESSENGER');
    assert.ifError(sUpdSettings.error);

    const sDelSettings = await service
      .from('ai_brain_shadow_settings')
      .delete()
      .eq('company_id', FIXTURE_COMPANY_A_ID)
      .eq('channel', 'MESSENGER');
    assert.ok(sDelSettings.error, 'service_role must NOT have DELETE grant on settings');
    assert.equal(sDelSettings.error?.code, '42501');

    // 2. ai_brain_shadow_runs ACL
    const anonSelRuns = await anon.from('ai_brain_shadow_runs').select('*').limit(1);
    assert.ok(anonSelRuns.error, 'anon must be denied SELECT on runs');
    assert.equal(anonSelRuns.error?.code, '42501');

    const authSelRuns = await authFixture.client.from('ai_brain_shadow_runs').select('*').limit(1);
    assert.ok(authSelRuns.error, 'authenticated must be denied SELECT on runs');
    assert.equal(authSelRuns.error?.code, '42501');

    // Create a dummy interaction to test direct service_role runs operations
    const dummyInteraction = await service
      .from('interactions')
      .insert({
        company_id: FIXTURE_COMPANY_A_ID,
        customer_id: FIXTURE_CUSTOMER_A_ID,
        conversation_id: FIXTURE_CONVO_A_FB_ID,
        channel: 'FACEBOOK',
        type: 'NOTE', // Won't trigger automatic enqueue
        direction: 'INBOUND',
        actor_type: 'CUSTOMER',
        sanitization_status: 'NOT_REQUIRED',
      })
      .select('id')
      .single();
    assert.ifError(dummyInteraction.error);

    const runInsert = await service
      .from('ai_brain_shadow_runs')
      .insert({
        company_id: FIXTURE_COMPANY_A_ID,
        customer_id: FIXTURE_CUSTOMER_A_ID,
        conversation_id: FIXTURE_CONVO_A_FB_ID,
        source_interaction_id: dummyInteraction.data.id,
        channel: 'MESSENGER',
        status: 'PENDING',
      })
      .select('id')
      .single();
    assert.ifError(runInsert.error);
    assert.ok(runInsert.data?.id);

    const runSelect = await service
      .from('ai_brain_shadow_runs')
      .select('id,status')
      .eq('id', runInsert.data.id)
      .single();
    assert.ifError(runSelect.error);
    assert.equal(runSelect.data?.status, 'PENDING');

    const runUpdate = await service
      .from('ai_brain_shadow_runs')
      .update({ status: 'SKIPPED', completed_at: new Date().toISOString() })
      .eq('id', runInsert.data.id);
    assert.ifError(runUpdate.error);

    const runDelete = await service
      .from('ai_brain_shadow_runs')
      .delete()
      .eq('id', runInsert.data.id);
    assert.ok(runDelete.error, 'service_role must NOT have DELETE grant on runs');
    assert.equal(runDelete.error?.code, '42501');
  } finally {
    await authFixture.client.auth.signOut();
    await service.auth.admin.deleteUser(authFixture.userId);
  }
});

// ---------------------------------------------------------------------------
// C: FACEBOOK Interaction Enqueue Mapping
// ---------------------------------------------------------------------------
test('C: FACEBOOK interaction -> MESSENGER / PENDING / attempts 0', async () => {
  await ensureFixtures();
  await drainPendingRuns();

  const setRes = await service
    .from('ai_brain_shadow_settings')
    .upsert({ company_id: FIXTURE_COMPANY_A_ID, channel: 'MESSENGER', enabled: true }, { onConflict: 'company_id,channel' });
  assert.ifError(setRes.error);

  const interaction = await service
    .from('interactions')
    .insert({
      company_id: FIXTURE_COMPANY_A_ID,
      customer_id: FIXTURE_CUSTOMER_A_ID,
      conversation_id: FIXTURE_CONVO_A_FB_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitization_status: 'SUCCEEDED',
      sanitized_content: 'Hello via Facebook customer message',
    })
    .select('id')
    .single();
  assert.ifError(interaction.error);

  const runQuery = await service
    .from('ai_brain_shadow_runs')
    .select('*')
    .eq('source_interaction_id', interaction.data.id)
    .single();
  assert.ifError(runQuery.error);

  const run = runQuery.data;
  assert.equal(run.channel, 'MESSENGER');
  assert.equal(run.status, 'PENDING');
  assert.equal(run.attempts, 0);
  assert.equal(run.company_id, FIXTURE_COMPANY_A_ID);
  assert.equal(run.customer_id, FIXTURE_CUSTOMER_A_ID);
  assert.equal(run.conversation_id, FIXTURE_CONVO_A_FB_ID);
  assert.equal(run.lock_token, null);
  assert.equal(run.locked_at, null);
  assert.equal(run.completed_at, null);

  // Complete run to keep queue clear
  const cleanUpd = await service
    .from('ai_brain_shadow_runs')
    .update({ status: 'SKIPPED', completed_at: new Date().toISOString() })
    .eq('id', run.id);
  assert.ifError(cleanUpd.error);
});

// ---------------------------------------------------------------------------
// D: ZALO Interaction Enqueue Mapping
// ---------------------------------------------------------------------------
test('D: ZALO interaction -> ZALO / PENDING / attempts 0', async () => {
  await ensureFixtures();
  await drainPendingRuns();

  const setRes = await service
    .from('ai_brain_shadow_settings')
    .upsert({ company_id: FIXTURE_COMPANY_A_ID, channel: 'ZALO', enabled: true }, { onConflict: 'company_id,channel' });
  assert.ifError(setRes.error);

  const interaction = await service
    .from('interactions')
    .insert({
      company_id: FIXTURE_COMPANY_A_ID,
      customer_id: FIXTURE_CUSTOMER_A_ID,
      conversation_id: FIXTURE_CONVO_A_ZL_ID,
      channel: 'ZALO',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitization_status: 'SUCCEEDED',
      sanitized_content: 'Hello via Zalo customer message',
    })
    .select('id')
    .single();
  assert.ifError(interaction.error);

  const runQuery = await service
    .from('ai_brain_shadow_runs')
    .select('*')
    .eq('source_interaction_id', interaction.data.id)
    .single();
  assert.ifError(runQuery.error);

  const run = runQuery.data;
  assert.equal(run.channel, 'ZALO');
  assert.equal(run.status, 'PENDING');
  assert.equal(run.attempts, 0);
  assert.equal(run.company_id, FIXTURE_COMPANY_A_ID);
  assert.equal(run.customer_id, FIXTURE_CUSTOMER_A_ID);
  assert.equal(run.conversation_id, FIXTURE_CONVO_A_ZL_ID);

  const cleanUpd = await service
    .from('ai_brain_shadow_runs')
    .update({ status: 'SKIPPED', completed_at: new Date().toISOString() })
    .eq('id', run.id);
  assert.ifError(cleanUpd.error);
});

// ---------------------------------------------------------------------------
// E: Ineligible Interactions Must NOT Enqueue
// ---------------------------------------------------------------------------
test('E: No enqueue outbound / noncustomer / non-MESSAGE / unsanitized / blank / WEBSITE', async () => {
  await ensureFixtures();
  await drainPendingRuns();

  // Enable settings for both channels
  const setRes = await service
    .from('ai_brain_shadow_settings')
    .upsert([
      { company_id: FIXTURE_COMPANY_A_ID, channel: 'MESSENGER', enabled: true },
      { company_id: FIXTURE_COMPANY_A_ID, channel: 'ZALO', enabled: true },
    ], { onConflict: 'company_id,channel' });
  assert.ifError(setRes.error);

  const testCases = [
    // 1. OUTBOUND direction
    {
      label: 'OUTBOUND direction',
      data: {
        company_id: FIXTURE_COMPANY_A_ID,
        customer_id: FIXTURE_CUSTOMER_A_ID,
        conversation_id: FIXTURE_CONVO_A_FB_ID,
        channel: 'FACEBOOK',
        type: 'MESSAGE',
        direction: 'OUTBOUND',
        actor_type: 'CUSTOMER',
        sanitization_status: 'SUCCEEDED',
        sanitized_content: 'Outbound customer message',
      },
    },
    // 2. Non-CUSTOMER actor types
    ...['SALE', 'AI', 'SYSTEM', 'TECHNICIAN'].map((actor) => ({
      label: `Actor type ${actor}`,
      data: {
        company_id: FIXTURE_COMPANY_A_ID,
        customer_id: FIXTURE_CUSTOMER_A_ID,
        conversation_id: FIXTURE_CONVO_A_FB_ID,
        channel: 'FACEBOOK',
        type: 'MESSAGE',
        direction: 'INBOUND',
        actor_type: actor,
        sanitization_status: 'SUCCEEDED',
        sanitized_content: `Inbound from ${actor}`,
      },
    })),
    // 3. Non-MESSAGE types
    ...['STATUS_EVENT', 'CALL_EVENT', 'NOTE'].map((type) => ({
      label: `Interaction type ${type}`,
      data: {
        company_id: FIXTURE_COMPANY_A_ID,
        customer_id: FIXTURE_CUSTOMER_A_ID,
        conversation_id: FIXTURE_CONVO_A_FB_ID,
        channel: 'FACEBOOK',
        type,
        direction: 'INBOUND',
        actor_type: 'CUSTOMER',
        sanitization_status: 'SUCCEEDED',
        sanitized_content: `Event of type ${type}`,
      },
    })),
    // 4. Non-SUCCEEDED sanitization status
    ...['PENDING', 'FAILED', 'NOT_REQUIRED'].map((status) => ({
      label: `Sanitization status ${status}`,
      data: {
        company_id: FIXTURE_COMPANY_A_ID,
        customer_id: FIXTURE_CUSTOMER_A_ID,
        conversation_id: FIXTURE_CONVO_A_FB_ID,
        channel: 'FACEBOOK',
        type: 'MESSAGE',
        direction: 'INBOUND',
        actor_type: 'CUSTOMER',
        sanitization_status: status,
        sanitized_content: status === 'SUCCEEDED' ? 'Content' : null,
      },
    })),
    // 5. Blank or null sanitized_content
    {
      label: 'Null sanitized_content with SUCCEEDED status',
      data: {
        company_id: FIXTURE_COMPANY_A_ID,
        customer_id: FIXTURE_CUSTOMER_A_ID,
        conversation_id: FIXTURE_CONVO_A_FB_ID,
        channel: 'FACEBOOK',
        type: 'MESSAGE',
        direction: 'INBOUND',
        actor_type: 'CUSTOMER',
        sanitization_status: 'SUCCEEDED',
        sanitized_content: null,
      },
    },
    {
      label: 'Empty string sanitized_content',
      data: {
        company_id: FIXTURE_COMPANY_A_ID,
        customer_id: FIXTURE_CUSTOMER_A_ID,
        conversation_id: FIXTURE_CONVO_A_FB_ID,
        channel: 'FACEBOOK',
        type: 'MESSAGE',
        direction: 'INBOUND',
        actor_type: 'CUSTOMER',
        sanitization_status: 'SUCCEEDED',
        sanitized_content: '',
      },
    },
    {
      label: 'Whitespace-only sanitized_content',
      data: {
        company_id: FIXTURE_COMPANY_A_ID,
        customer_id: FIXTURE_CUSTOMER_A_ID,
        conversation_id: FIXTURE_CONVO_A_FB_ID,
        channel: 'FACEBOOK',
        type: 'MESSAGE',
        direction: 'INBOUND',
        actor_type: 'CUSTOMER',
        sanitization_status: 'SUCCEEDED',
        sanitized_content: '   \n\t  ',
      },
    },
    // 6. Unsupported channel (e.g. WEBSITE)
    {
      label: 'Unsupported channel WEBSITE',
      data: {
        company_id: FIXTURE_COMPANY_A_ID,
        customer_id: FIXTURE_CUSTOMER_A_ID,
        conversation_id: FIXTURE_CONVO_A_FB_ID,
        channel: 'WEBSITE',
        type: 'MESSAGE',
        direction: 'INBOUND',
        actor_type: 'CUSTOMER',
        sanitization_status: 'SUCCEEDED',
        sanitized_content: 'Website message',
      },
    },
  ];

  for (const tc of testCases) {
    const inserted = await service.from('interactions').insert(tc.data).select('id').single();
    assert.ifError(inserted.error);

    const run = await service.from('ai_brain_shadow_runs').select('id').eq('source_interaction_id', inserted.data.id);
    assert.ifError(run.error);
    assert.equal(run.data.length, 0, `Expected NO shadow run for case: ${tc.label}`);
  }
});

// ---------------------------------------------------------------------------
// F: Re-sanitization Update Dedupes
// ---------------------------------------------------------------------------
test('F: Re-sanitization update dedupes (ON CONFLICT source_interaction_id DO NOTHING)', async () => {
  await ensureFixtures();
  await drainPendingRuns();

  const setRes = await service
    .from('ai_brain_shadow_settings')
    .upsert({ company_id: FIXTURE_COMPANY_A_ID, channel: 'MESSENGER', enabled: true }, { onConflict: 'company_id,channel' });
  assert.ifError(setRes.error);

  // 1. Initial insert with SUCCEEDED status
  const interaction = await service
    .from('interactions')
    .insert({
      company_id: FIXTURE_COMPANY_A_ID,
      customer_id: FIXTURE_CUSTOMER_A_ID,
      conversation_id: FIXTURE_CONVO_A_FB_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitization_status: 'SUCCEEDED',
      sanitized_content: 'Initial text before resanitization',
    })
    .select('id')
    .single();
  assert.ifError(interaction.error);

  const initialRuns = await service
    .from('ai_brain_shadow_runs')
    .select('id,attempts')
    .eq('source_interaction_id', interaction.data.id);
  assert.ifError(initialRuns.error);
  assert.equal(initialRuns.data.length, 1);
  const initialRunId = initialRuns.data[0].id;

  // 2. Update interaction with modified sanitized_content triggering the trigger again
  const updateResult = await service
    .from('interactions')
    .update({ sanitized_content: 'Resanitized updated text from customer' })
    .eq('id', interaction.data.id);
  assert.ifError(updateResult.error);

  const postUpdateRuns = await service
    .from('ai_brain_shadow_runs')
    .select('id,attempts')
    .eq('source_interaction_id', interaction.data.id);
  assert.ifError(postUpdateRuns.error);
  assert.equal(postUpdateRuns.data.length, 1, 'Deduping must keep exactly 1 run row');
  assert.equal(postUpdateRuns.data[0].id, initialRunId, 'Run ID must remain unchanged');

  const cleanUpd = await service
    .from('ai_brain_shadow_runs')
    .update({ status: 'SKIPPED', completed_at: new Date().toISOString() })
    .eq('id', initialRunId);
  assert.ifError(cleanUpd.error);
});

// ---------------------------------------------------------------------------
// G: Claim & Finish Token Fencing, Stale Reclaim, Backoff, Timeout Expiry
// ---------------------------------------------------------------------------
test('G: Right/wrong/expired/old token fencing; stale reclaim new token; due/backoff; expired attempt 5 timeout', async () => {
  await ensureFixtures();
  await drainPendingRuns();

  const setRes = await service
    .from('ai_brain_shadow_settings')
    .upsert({ company_id: FIXTURE_COMPANY_A_ID, channel: 'MESSENGER', enabled: true }, { onConflict: 'company_id,channel' });
  assert.ifError(setRes.error);

  // --- Sub-test 1: Claim and right/wrong token fencing ---
  const interactionG1 = await service
    .from('interactions')
    .insert({
      company_id: FIXTURE_COMPANY_A_ID,
      customer_id: FIXTURE_CUSTOMER_A_ID,
      conversation_id: FIXTURE_CONVO_A_FB_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitization_status: 'SUCCEEDED',
      sanitized_content: 'G1 test content',
    })
    .select('id')
    .single();
  assert.ifError(interactionG1.error);

  const tokenA = randomUUID();
  const claimRes = await service.rpc('claim_ai_brain_shadow_runs', { p_limit: 1, p_lock_token: tokenA });
  assert.ifError(claimRes.error);
  assert.equal(claimRes.data?.length, 1);
  const claimedRun = claimRes.data[0];
  assert.equal(claimedRun.source_interaction_id, interactionG1.data.id);
  assert.equal(claimedRun.attempts, 1);

  // Wrong token fencing: attempting to finish with wrong token returns false
  const wrongToken = randomUUID();
  const finishWrong = await service.rpc('finish_ai_brain_shadow_run', {
    p_id: claimedRun.id,
    p_lock_token: wrongToken,
    p_status: 'COMPLETED',
    p_decision: 'RESPOND',
    p_draft: 'Draft with wrong token',
  });
  assert.ifError(finishWrong.error);
  assert.equal(finishWrong.data, false, 'Wrong token finish must return false');

  // Verify DB state is still PROCESSING with tokenA
  const checkRunA = await service
    .from('ai_brain_shadow_runs')
    .select('status,lock_token')
    .eq('id', claimedRun.id)
    .single();
  assert.ifError(checkRunA.error);
  assert.equal(checkRunA.data?.status, 'PROCESSING');
  assert.equal(checkRunA.data?.lock_token, tokenA);

  // Right token finish
  const finishRight = await service.rpc('finish_ai_brain_shadow_run', {
    p_id: claimedRun.id,
    p_lock_token: tokenA,
    p_status: 'COMPLETED',
    p_decision: 'RESPOND',
    p_draft: 'Valid finished response draft',
    p_confidence: 0.95,
    p_handover_required: false,
    p_provider: 'test-provider',
    p_model: 'test-model',
    p_latency_ms: 125,
  });
  assert.ifError(finishRight.error);
  assert.equal(finishRight.data, true, 'Right token finish must return true');

  // Verify completed run DB state
  const checkCompleted = await service
    .from('ai_brain_shadow_runs')
    .select('status,lock_token,locked_at,completed_at,draft,confidence')
    .eq('id', claimedRun.id)
    .single();
  assert.ifError(checkCompleted.error);
  assert.equal(checkCompleted.data?.status, 'COMPLETED');
  assert.equal(checkCompleted.data?.lock_token, null);
  assert.equal(checkCompleted.data?.locked_at, null);
  assert.ok(checkCompleted.data?.completed_at);
  assert.equal(checkCompleted.data?.draft, 'Valid finished response draft');
  assert.equal(Number(checkCompleted.data?.confidence), 0.95);

  // Old token fencing: calling finish again returns false
  const finishOld = await service.rpc('finish_ai_brain_shadow_run', {
    p_id: claimedRun.id,
    p_lock_token: tokenA,
    p_status: 'COMPLETED',
    p_decision: 'RESPOND',
  });
  assert.ifError(finishOld.error);
  assert.equal(finishOld.data, false, 'Old token replay on completed run must return false');

  // --- Sub-test 2: Stale lock reclaim with new token & expiry-before-reclaim fencing ---
  await drainPendingRuns();

  const interactionG2 = await service
    .from('interactions')
    .insert({
      company_id: FIXTURE_COMPANY_A_ID,
      customer_id: FIXTURE_CUSTOMER_A_ID,
      conversation_id: FIXTURE_CONVO_A_FB_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitization_status: 'SUCCEEDED',
      sanitized_content: 'G2 stale reclaim content',
    })
    .select('id')
    .single();
  assert.ifError(interactionG2.error);

  const tokenStaleOld = randomUUID();
  const claimG2 = await service.rpc('claim_ai_brain_shadow_runs', { p_limit: 1, p_lock_token: tokenStaleOld });
  assert.ifError(claimG2.error);
  assert.equal(claimG2.data?.length, 1);
  const runG2Id = claimG2.data[0].id;

  // Simulate stale lock (> 5 minutes ago)
  const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  const staleUpd = await service
    .from('ai_brain_shadow_runs')
    .update({ locked_at: sixMinAgo })
    .eq('id', runG2Id);
  assert.ifError(staleUpd.error);

  // Expiry-before-reclaim fencing: worker with correct OLD token attempts finish on expired lock -> must return false and leave DB unchanged
  const finishBeforeReclaim = await service.rpc('finish_ai_brain_shadow_run', {
    p_id: runG2Id,
    p_lock_token: tokenStaleOld,
    p_status: 'COMPLETED',
    p_decision: 'RESPOND',
    p_draft: 'Draft attempted after expiry but before reclaim',
  });
  assert.ifError(finishBeforeReclaim.error);
  assert.equal(finishBeforeReclaim.data, false, 'Finish on expired lock before reclaim must return false');

  const checkUnchanged = await service
    .from('ai_brain_shadow_runs')
    .select('status,lock_token,locked_at,completed_at,draft')
    .eq('id', runG2Id)
    .single();
  assert.ifError(checkUnchanged.error);
  assert.equal(checkUnchanged.data?.status, 'PROCESSING', 'Status must remain PROCESSING');
  assert.equal(checkUnchanged.data?.lock_token, tokenStaleOld, 'lock_token must remain old token');
  assert.equal(checkUnchanged.data?.completed_at, null, 'completed_at must remain null');
  assert.equal(checkUnchanged.data?.draft, null, 'draft must remain null');

  // New worker claims stale run with tokenStaleNew
  const tokenStaleNew = randomUUID();
  const reclaimG2 = await service.rpc('claim_ai_brain_shadow_runs', { p_limit: 1, p_lock_token: tokenStaleNew });
  assert.ifError(reclaimG2.error);
  assert.equal(reclaimG2.data?.length, 1);
  assert.equal(reclaimG2.data[0].id, runG2Id);
  assert.equal(reclaimG2.data[0].attempts, 2, 'Attempts must increment on reclaim');

  // Old worker attempts to finish with tokenStaleOld -> returns false
  const finishOldStale = await service.rpc('finish_ai_brain_shadow_run', {
    p_id: runG2Id,
    p_lock_token: tokenStaleOld,
    p_status: 'COMPLETED',
  });
  assert.ifError(finishOldStale.error);
  assert.equal(finishOldStale.data, false, 'Stale token must be fenced out');

  // New worker finishes with tokenStaleNew -> succeeds
  const finishNew = await service.rpc('finish_ai_brain_shadow_run', {
    p_id: runG2Id,
    p_lock_token: tokenStaleNew,
    p_status: 'COMPLETED',
    p_decision: 'RESPOND',
    p_draft: 'Reclaimed draft',
  });
  assert.ifError(finishNew.error);
  assert.equal(finishNew.data, true, 'New lock holder must finish successfully');

  // --- Sub-test 3: Due backoff when attempts < 5 ---
  await drainPendingRuns();

  const interactionG3 = await service
    .from('interactions')
    .insert({
      company_id: FIXTURE_COMPANY_A_ID,
      customer_id: FIXTURE_CUSTOMER_A_ID,
      conversation_id: FIXTURE_CONVO_A_FB_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitization_status: 'SUCCEEDED',
      sanitized_content: 'G3 backoff test content',
    })
    .select('id')
    .single();
  assert.ifError(interactionG3.error);

  const tokenG3 = randomUUID();
  const claimG3 = await service.rpc('claim_ai_brain_shadow_runs', { p_limit: 1, p_lock_token: tokenG3 });
  assert.ifError(claimG3.error);
  assert.equal(claimG3.data?.length, 1);
  const runG3Id = claimG3.data[0].id;

  // Finish as FAILED; available_at will be set to now() + 30 * attempts (30s in future)
  const finishFailed = await service.rpc('finish_ai_brain_shadow_run', {
    p_id: runG3Id,
    p_lock_token: tokenG3,
    p_status: 'FAILED',
    p_error_code: 'BRAIN_PROVIDER_ERROR',
  });
  assert.ifError(finishFailed.error);
  assert.equal(finishFailed.data, true);

  const checkFailed = await service
    .from('ai_brain_shadow_runs')
    .select('status,available_at,attempts')
    .eq('id', runG3Id)
    .single();
  assert.ifError(checkFailed.error);
  assert.ok(checkFailed.data);
  assert.equal(checkFailed.data.status, 'FAILED');
  assert.ok(new Date(checkFailed.data.available_at).getTime() > Date.now(), 'available_at must be in the future');

  // Immediate claim attempt must find nothing due
  const claimTooEarly = await service.rpc('claim_ai_brain_shadow_runs', { p_limit: 1, p_lock_token: randomUUID() });
  assert.ifError(claimTooEarly.error);
  assert.equal(claimTooEarly.data?.length, 0, 'Must NOT claim before available_at');

  // Fast-forward available_at to the past
  const pastAvailable = new Date(Date.now() - 2000).toISOString();
  const updAvailable = await service
    .from('ai_brain_shadow_runs')
    .update({ available_at: pastAvailable })
    .eq('id', runG3Id);
  assert.ifError(updAvailable.error);

  // Now claim succeeds and attempts increments to 2
  const tokenG3Retry = randomUUID();
  const claimRetry = await service.rpc('claim_ai_brain_shadow_runs', { p_limit: 1, p_lock_token: tokenG3Retry });
  assert.ifError(claimRetry.error);
  assert.equal(claimRetry.data?.length, 1);
  assert.equal(claimRetry.data[0].id, runG3Id);
  assert.equal(claimRetry.data[0].attempts, 2);

  const cleanG3 = await service
    .from('ai_brain_shadow_runs')
    .update({ status: 'SKIPPED', completed_at: new Date().toISOString(), locked_at: null, lock_token: null })
    .eq('id', runG3Id);
  assert.ifError(cleanG3.error);

  // --- Sub-test 4: Expired attempt 5 ends in FAILED / BRAIN_TIMEOUT (no attempt bump, repeat idempotent) ---
  await drainPendingRuns();

  const interactionG4 = await service
    .from('interactions')
    .insert({
      company_id: FIXTURE_COMPANY_A_ID,
      customer_id: FIXTURE_CUSTOMER_A_ID,
      conversation_id: FIXTURE_CONVO_A_FB_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitization_status: 'SUCCEEDED',
      sanitized_content: 'G4 max attempt timeout content',
    })
    .select('id')
    .single();
  assert.ifError(interactionG4.error);

  const runG4Query = await service
    .from('ai_brain_shadow_runs')
    .select('id')
    .eq('source_interaction_id', interactionG4.data.id)
    .single();
  assert.ifError(runG4Query.error);

  const tokenMax = randomUUID();
  // Simulate run stuck in PROCESSING at attempt 5 with expired lock (> 5 min ago)
  const updG4 = await service
    .from('ai_brain_shadow_runs')
    .update({
      status: 'PROCESSING',
      attempts: 5,
      lock_token: tokenMax,
      locked_at: sixMinAgo,
    })
    .eq('id', runG4Query.data.id);
  assert.ifError(updG4.error);

  // Running claim triggers the expired_final CTE which marks it FAILED / BRAIN_TIMEOUT without bumping attempts
  const claimCleaner = await service.rpc('claim_ai_brain_shadow_runs', { p_limit: 1, p_lock_token: randomUUID() });
  assert.ifError(claimCleaner.error);
  assert.equal(claimCleaner.data?.length, 0, 'Run at attempt 5 must not be claimed');

  const checkFinal = await service
    .from('ai_brain_shadow_runs')
    .select('status,error_code,locked_at,lock_token,completed_at,attempts')
    .eq('id', runG4Query.data.id)
    .single();
  assert.ifError(checkFinal.error);
  assert.equal(checkFinal.data?.status, 'FAILED');
  assert.equal(checkFinal.data?.error_code, 'BRAIN_TIMEOUT');
  assert.equal(checkFinal.data?.locked_at, null);
  assert.equal(checkFinal.data?.lock_token, null);
  assert.ok(checkFinal.data?.completed_at);
  assert.equal(checkFinal.data?.attempts, 5, 'Expired final attempt must NOT increment counter');

  // Repeat claim call must be idempotent: does not change state or increment attempts
  const claimCleaner2 = await service.rpc('claim_ai_brain_shadow_runs', { p_limit: 1, p_lock_token: randomUUID() });
  assert.ifError(claimCleaner2.error);
  assert.equal(claimCleaner2.data?.length, 0, 'Repeat claim must remain 0');

  const checkFinalRepeat = await service
    .from('ai_brain_shadow_runs')
    .select('status,error_code,locked_at,lock_token,completed_at,attempts')
    .eq('id', runG4Query.data.id)
    .single();
  assert.ifError(checkFinalRepeat.error);
  assert.equal(checkFinalRepeat.data?.status, 'FAILED');
  assert.equal(checkFinalRepeat.data?.error_code, 'BRAIN_TIMEOUT');
  assert.equal(checkFinalRepeat.data?.attempts, 5, 'Attempts must remain 5 on repeated claim sweeps');

  // --- Sub-test 5: Invalid claim RPC parameters rejected ---
  const invalidLimit0 = await service.rpc('claim_ai_brain_shadow_runs', { p_limit: 0, p_lock_token: randomUUID() });
  assert.ok(invalidLimit0.error, 'p_limit = 0 must be rejected');

  const invalidLimit11 = await service.rpc('claim_ai_brain_shadow_runs', { p_limit: 11, p_lock_token: randomUUID() });
  assert.ok(invalidLimit11.error, 'p_limit = 11 must be rejected');

  const invalidNullToken = await service.rpc('claim_ai_brain_shadow_runs', { p_limit: 1, p_lock_token: null as any });
  assert.ok(invalidNullToken.error, 'null lock_token must be rejected');

  // --- Sub-test 6: PENDING with future available_at is not claimed ---
  const intFuture = await service
    .from('interactions')
    .insert({
      company_id: FIXTURE_COMPANY_A_ID,
      customer_id: FIXTURE_CUSTOMER_A_ID,
      conversation_id: FIXTURE_CONVO_A_FB_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitization_status: 'SUCCEEDED',
      sanitized_content: 'Future pending message',
    })
    .select('id')
    .single();
  assert.ifError(intFuture.error);

  const futureRunQuery = await service
    .from('ai_brain_shadow_runs')
    .select('id')
    .eq('source_interaction_id', intFuture.data.id)
    .single();
  assert.ifError(futureRunQuery.error);

  const futureTime = new Date(Date.now() + 60 * 1000).toISOString();
  const setFutureRes = await service
    .from('ai_brain_shadow_runs')
    .update({ available_at: futureTime })
    .eq('id', futureRunQuery.data.id);
  assert.ifError(setFutureRes.error);

  const claimFuture = await service.rpc('claim_ai_brain_shadow_runs', { p_limit: 1, p_lock_token: randomUUID() });
  assert.ifError(claimFuture.error);
  assert.equal(claimFuture.data?.length, 0, 'PENDING run with future available_at must not be claimed');

  const cleanFuture = await service
    .from('ai_brain_shadow_runs')
    .update({ status: 'SKIPPED', completed_at: new Date().toISOString() })
    .eq('id', futureRunQuery.data.id);
  assert.ifError(cleanFuture.error);

  // --- Sub-test 7: PENDING and FAILED runs with attempts=5 are not claimed ---
  const intMaxPending = await service
    .from('interactions')
    .insert({
      company_id: FIXTURE_COMPANY_A_ID,
      customer_id: FIXTURE_CUSTOMER_A_ID,
      conversation_id: FIXTURE_CONVO_A_FB_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitization_status: 'SUCCEEDED',
      sanitized_content: 'Max pending message',
    })
    .select('id')
    .single();
  assert.ifError(intMaxPending.error);

  const runMaxPending = await service
    .from('ai_brain_shadow_runs')
    .select('id')
    .eq('source_interaction_id', intMaxPending.data.id)
    .single();
  assert.ifError(runMaxPending.error);

  const pastTime = new Date(Date.now() - 5000).toISOString();
  const updMaxPending = await service
    .from('ai_brain_shadow_runs')
    .update({ attempts: 5, available_at: pastTime })
    .eq('id', runMaxPending.data.id);
  assert.ifError(updMaxPending.error);

  const claimMaxPending = await service.rpc('claim_ai_brain_shadow_runs', { p_limit: 1, p_lock_token: randomUUID() });
  assert.ifError(claimMaxPending.error);
  assert.equal(claimMaxPending.data?.length, 0, 'PENDING run with attempts=5 must not be claimed');

  const updMaxFailed = await service
    .from('ai_brain_shadow_runs')
    .update({ status: 'FAILED', attempts: 5, available_at: pastTime, completed_at: new Date().toISOString() })
    .eq('id', runMaxPending.data.id);
  assert.ifError(updMaxFailed.error);

  const claimMaxFailed = await service.rpc('claim_ai_brain_shadow_runs', { p_limit: 1, p_lock_token: randomUUID() });
  assert.ifError(claimMaxFailed.error);
  assert.equal(claimMaxFailed.data?.length, 0, 'FAILED run with attempts=5 must not be claimed');

  const cleanMax = await service
    .from('ai_brain_shadow_runs')
    .update({ status: 'SKIPPED', completed_at: new Date().toISOString() })
    .eq('id', runMaxPending.data.id);
  assert.ifError(cleanMax.error);
});

// ---------------------------------------------------------------------------
// H: NO DELETE, Composite FK Scope Fencing, Unauthorized RPC, RLS Metadata
// ---------------------------------------------------------------------------
test('H: Both tables NO DELETE; composite FK rejects cross-scope; unauthorized RPC denied; metadata checks', async () => {
  await ensureFixtures();
  await drainPendingRuns();

  const authFixture = await createAuthenticatedFixtureClient();

  try {
    // 1. service_role has NO DELETE grant on both tables
    const delSettings = await service
      .from('ai_brain_shadow_settings')
      .delete()
      .eq('company_id', FIXTURE_COMPANY_A_ID);
    assert.ok(delSettings.error, 'service_role DELETE on settings must fail');
    assert.equal(delSettings.error?.code, '42501');

    const delRuns = await service
      .from('ai_brain_shadow_runs')
      .delete()
      .eq('company_id', FIXTURE_COMPANY_A_ID);
    assert.ok(delRuns.error, 'service_role DELETE on runs must fail');
    assert.equal(delRuns.error?.code, '42501');

    // 2. Composite FK rejects cross-customer, cross-conversation, and cross-company source
    const dummyInteraction = await service
      .from('interactions')
      .insert({
        company_id: FIXTURE_COMPANY_A_ID,
        customer_id: FIXTURE_CUSTOMER_A_ID,
        conversation_id: FIXTURE_CONVO_A_FB_ID,
        channel: 'FACEBOOK',
        type: 'NOTE',
        direction: 'INBOUND',
        actor_type: 'CUSTOMER',
        sanitization_status: 'NOT_REQUIRED',
      })
      .select('id')
      .single();
  assert.ifError(dummyInteraction.error);

    // A) Mismatched customer on conversation reference
    const crossCustRun = await service.from('ai_brain_shadow_runs').insert({
      company_id: FIXTURE_COMPANY_A_ID,
      customer_id: FIXTURE_CUSTOMER_B_ID, // Mismatched customer!
      conversation_id: FIXTURE_CONVO_A_FB_ID,
      source_interaction_id: dummyInteraction.data.id,
      channel: 'MESSENGER',
    });
    assert.ok(crossCustRun.error, 'Composite FK must reject mismatched customer_id');
    assert.equal(crossCustRun.error?.code, '23503');

    // B) Mismatched conversation on source_interaction reference
    const crossConvoRun = await service.from('ai_brain_shadow_runs').insert({
      company_id: FIXTURE_COMPANY_A_ID,
      customer_id: FIXTURE_CUSTOMER_A_ID,
      conversation_id: FIXTURE_CONVO_A_ZL_ID, // Mismatched convo vs interaction!
      source_interaction_id: dummyInteraction.data.id,
      channel: 'MESSENGER',
    });
    assert.ok(crossConvoRun.error, 'Composite FK must reject mismatched conversation_id on source interaction');
    assert.equal(crossConvoRun.error?.code, '23503');

    // C) True cross-company source reference rejection
    const crossCompanyRun = await service.from('ai_brain_shadow_runs').insert({
      company_id: FIXTURE_COMPANY_B_ID,
      customer_id: FIXTURE_CUSTOMER_B_ID,
      conversation_id: FIXTURE_CONVO_B_FB_ID,
      source_interaction_id: dummyInteraction.data.id, // Belongs to Company A!
      channel: 'MESSENGER',
    });
    assert.ok(crossCompanyRun.error, 'Composite FK must reject cross-company source_interaction_id');
    assert.equal(crossCompanyRun.error?.code, '23503');

    // 3. Unauthorized EXECUTE denied on claim and finish RPCs
    const anonClaim = await anon.rpc('claim_ai_brain_shadow_runs', { p_limit: 1, p_lock_token: randomUUID() });
    assert.ok(anonClaim.error, 'anon must NOT execute claim_ai_brain_shadow_runs');
    assert.equal(anonClaim.error?.code, '42501');

    const authClaim = await authFixture.client.rpc('claim_ai_brain_shadow_runs', { p_limit: 1, p_lock_token: randomUUID() });
    assert.ok(authClaim.error, 'authenticated must NOT execute claim_ai_brain_shadow_runs');
    assert.equal(authClaim.error?.code, '42501');

    const anonFinish = await anon.rpc('finish_ai_brain_shadow_run', {
      p_id: randomUUID(),
      p_lock_token: randomUUID(),
      p_status: 'COMPLETED',
    });
    assert.ok(anonFinish.error, 'anon must NOT execute finish_ai_brain_shadow_run');
    assert.equal(anonFinish.error?.code, '42501');

    const authFinish = await authFixture.client.rpc('finish_ai_brain_shadow_run', {
      p_id: randomUUID(),
      p_lock_token: randomUUID(),
      p_status: 'COMPLETED',
    });
    assert.ok(authFinish.error, 'authenticated must NOT execute finish_ai_brain_shadow_run');
    assert.equal(authFinish.error?.code, '42501');

    // 4. Unique owner claim race with Promise.all
    const intH1 = await service
      .from('interactions')
      .insert({
        company_id: FIXTURE_COMPANY_A_ID,
        customer_id: FIXTURE_CUSTOMER_A_ID,
        conversation_id: FIXTURE_CONVO_A_FB_ID,
        channel: 'FACEBOOK',
        type: 'MESSAGE',
        direction: 'INBOUND',
        actor_type: 'CUSTOMER',
        sanitization_status: 'SUCCEEDED',
        sanitized_content: 'Concurrent message 1',
      })
      .select('id')
      .single();
    assert.ifError(intH1.error);

    const intH2 = await service
      .from('interactions')
      .insert({
        company_id: FIXTURE_COMPANY_A_ID,
        customer_id: FIXTURE_CUSTOMER_A_ID,
        conversation_id: FIXTURE_CONVO_A_FB_ID,
        channel: 'FACEBOOK',
        type: 'MESSAGE',
        direction: 'INBOUND',
        actor_type: 'CUSTOMER',
        sanitization_status: 'SUCCEEDED',
        sanitized_content: 'Concurrent message 2',
      })
      .select('id')
      .single();
    assert.ifError(intH2.error);

    const lockWorker1 = randomUUID();
    const lockWorker2 = randomUUID();

    const [claim1, claim2] = await Promise.all([
      service.rpc('claim_ai_brain_shadow_runs', { p_limit: 1, p_lock_token: lockWorker1 }),
      service.rpc('claim_ai_brain_shadow_runs', { p_limit: 1, p_lock_token: lockWorker2 }),
    ]);
    assert.ifError(claim1.error);
    assert.ifError(claim2.error);
    assert.equal(claim1.data?.length, 1);
    assert.equal(claim2.data?.length, 1);

    // Each racing claim worker must have claimed a distinct run
    assert.notEqual(claim1.data[0].id, claim2.data[0].id);

    const skipUpd = await service
      .from('ai_brain_shadow_runs')
      .update({ status: 'SKIPPED', completed_at: new Date().toISOString(), locked_at: null, lock_token: null })
      .in('id', [claim1.data[0].id, claim2.data[0].id]);
    assert.ifError(skipUpd.error);

    // 5. Metadata verification via local psql: RLS enabled & exact empty search_path
    const rlsSql = `
      SELECT c.relname, c.relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('ai_brain_shadow_settings', 'ai_brain_shadow_runs')
      ORDER BY c.relname;
    `;
    const rlsResult = executeRawSql(rlsSql).trim().split('\n');
    assert.deepEqual(rlsResult, [
      'ai_brain_shadow_runs|t',
      'ai_brain_shadow_settings|t',
    ]);

    const procSql = `
      SELECT
        p.proname,
        p.prosecdef,
        (p.proconfig = ARRAY['search_path=""']) AS has_exact_empty_search_path
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('enqueue_ai_brain_shadow_run', 'claim_ai_brain_shadow_runs', 'finish_ai_brain_shadow_run')
      ORDER BY p.proname;
    `;
    const procResult = executeRawSql(procSql).trim().split('\n');
    assert.deepEqual(procResult, [
      'claim_ai_brain_shadow_runs|t|t',
      'enqueue_ai_brain_shadow_run|t|t',
      'finish_ai_brain_shadow_run|t|t',
    ], 'All queue functions must be SECURITY DEFINER with exact empty search_path');

    // 6. Verify PUBLIC, anon, and authenticated EXECUTE privileges are completely absent via DB ACL
    const aclSql = `
      SELECT
        p.proname,
        EXISTS (
          SELECT 1
          FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
        ) AS public_exec,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('enqueue_ai_brain_shadow_run', 'claim_ai_brain_shadow_runs', 'finish_ai_brain_shadow_run')
      ORDER BY p.proname;
    `;
    const aclResult = executeRawSql(aclSql).trim().split('\n');
    assert.deepEqual(aclResult, [
      'claim_ai_brain_shadow_runs|f|f|f',
      'enqueue_ai_brain_shadow_run|f|f|f',
      'finish_ai_brain_shadow_run|f|f|f',
    ], 'PUBLIC, anon, and authenticated must NOT have EXECUTE on any shadow function (including trigger)');
  } finally {
    await authFixture.client.auth.signOut();
    await service.auth.admin.deleteUser(authFixture.userId);
  }
});

// ---------------------------------------------------------------------------
// I: Native psql Held-Row-Lock Proof of SKIP LOCKED
// ---------------------------------------------------------------------------
test('I: Native psql held-row-lock proves SKIP LOCKED without hanging CI', async () => {
  await ensureFixtures();
  await drainPendingRuns();

  const settingRes = await service
    .from('ai_brain_shadow_settings')
    .upsert({ company_id: FIXTURE_COMPANY_A_ID, channel: 'MESSENGER', enabled: true }, { onConflict: 'company_id,channel' });
  assert.ifError(settingRes.error);

  // Insert two pending interactions in order
  const int1 = await service
    .from('interactions')
    .insert({
      company_id: FIXTURE_COMPANY_A_ID,
      customer_id: FIXTURE_CUSTOMER_A_ID,
      conversation_id: FIXTURE_CONVO_A_FB_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitization_status: 'SUCCEEDED',
      sanitized_content: 'Held lock test 1',
    })
    .select('id')
    .single();
  assert.ifError(int1.error);

  const int2 = await service
    .from('interactions')
    .insert({
      company_id: FIXTURE_COMPANY_A_ID,
      customer_id: FIXTURE_CUSTOMER_A_ID,
      conversation_id: FIXTURE_CONVO_A_FB_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitization_status: 'SUCCEEDED',
      sanitized_content: 'Held lock test 2',
    })
    .select('id')
    .single();
  assert.ifError(int2.error);

  const run1 = await service
    .from('ai_brain_shadow_runs')
    .select('id')
    .eq('source_interaction_id', int1.data.id)
    .single();
  assert.ifError(run1.error);

  const run2 = await service
    .from('ai_brain_shadow_runs')
    .select('id')
    .eq('source_interaction_id', int2.data.id)
    .single();
  assert.ifError(run2.error);

  const validatedContainer = getValidatedContainer();
  // Spawn psql with explicit argument vector (no shell execution)
  const psqlProc = spawn(
    'docker',
    ['exec', '-i', validatedContainer, 'psql', '-X', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  let stdoutBuffer = '';
  const barrierPromise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timeout waiting for psql lock barrier'));
    }, 5000);

    psqlProc.stdout.setEncoding('utf8');
    psqlProc.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      if (stdoutBuffer.includes('LOCKED_BARRIER')) {
        clearTimeout(timer);
        resolve();
      }
    });

    psqlProc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    psqlProc.on('exit', (code) => {
      if (!stdoutBuffer.includes('LOCKED_BARRIER')) {
        clearTimeout(timer);
        reject(new Error(`psql exited early with code ${code}`));
      }
    });
  });

  try {
    // Begin transaction, acquire FOR UPDATE lock on run1, and output barrier
    psqlProc.stdin.write(`BEGIN;\nSELECT id FROM public.ai_brain_shadow_runs WHERE id = '${run1.data.id}' FOR UPDATE;\nSELECT 'LOCKED_BARRIER';\n`);

    // Wait for deterministic output barrier
    await barrierPromise;

    // With run1 locked by another backend, claim RPC with SKIP LOCKED must skip run1 and claim run2 immediately
    const claimToken = randomUUID();
    const claimRes = await service
      .rpc('claim_ai_brain_shadow_runs', { p_limit: 1, p_lock_token: claimToken })
      .abortSignal(AbortSignal.timeout(5000));
    assert.ifError(claimRes.error);
    assert.equal(claimRes.data?.length, 1);
    assert.equal(claimRes.data[0].id, run2.data.id, 'claim RPC must SKIP LOCKED row (run1) and return run2');
  } finally {
    try {
      psqlProc.stdin.write('ROLLBACK;\n\\q\n');
      psqlProc.stdin.end();
    } catch {
      // ignore write errors if process already ended
    }

    if (psqlProc.exitCode === null && psqlProc.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            psqlProc.kill('SIGKILL');
          } catch {
            // ignore
          }
          resolve();
        }, 2000);

        const onEnd = () => {
          clearTimeout(timer);
          resolve();
        };
        psqlProc.once('close', onEnd);
        psqlProc.once('exit', onEnd);
      });
    }

    const cleanUpd = await service
      .from('ai_brain_shadow_runs')
      .update({ status: 'SKIPPED', completed_at: new Date().toISOString(), locked_at: null, lock_token: null })
      .in('id', [run1.data.id, run2.data.id])
      .abortSignal(AbortSignal.timeout(5000));
    assert.ifError(cleanUpd.error);
  }
});
