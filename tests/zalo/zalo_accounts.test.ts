import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createPgliteSupabase } from './helpers/pglite-supabase';
import { parseZaloCredentials, encryptZaloCredentials, decryptZaloCredentials, credentialsFingerprint } from '../../features/omnichannel/zalo/accounts/credentials';
import { assertZaloAccountAdmin, listZaloAccounts, saveZaloAccount, toggleZaloAccount } from '../../features/omnichannel/zalo/accounts/service';
import { scopeZaloThread, splitZaloThread } from '../../features/omnichannel/zalo/accounts/scope';
import type { ActorContext } from '../../shared/contracts/auth';
import { isZaloAccountOriginAllowed } from '../../features/omnichannel/zalo/accounts/origin';

const company = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const boss = '20000000-0000-4000-8000-000000000001';
const raw = (value = 'test-session') => ({ label: 'Zalo tư vấn 02', cookie: JSON.stringify({ cookies: [{ name: 'zpsid', value, domain: '.zalo.me' }, { name: 'unrelated', value: 'discard', domain: '.example.com' }] }), imei: 'test-browser-imei-123', userAgent: 'Mozilla/5.0 (test-browser)' });
const actor: ActorContext = { userId: boss, companyId: company, memberId: boss, fullName: 'Boss', email: 'boss@test.local', role: 'BOSS_ADMIN', profileStatus: 'ACTIVE', membershipStatus: 'ACTIVE', aal: 'aal2', isMfaEnrolled: true };

async function main() {
  process.env.ZALO_ACCOUNT_CRM_ORIGIN = 'https://crm.example.com';
  assert.equal(isZaloAccountOriginAllowed(new Request('http://localhost:10000/api/accounts', { headers: { origin: 'https://crm.example.com' } })), true, 'public HTTPS origin works behind internal HTTP proxy');
  assert.equal(isZaloAccountOriginAllowed(new Request('http://localhost:10000/api/accounts', { headers: { origin: 'https://evil.example.com' } })), false);
  assert.equal(isZaloAccountOriginAllowed(new Request('http://localhost:10000/api/accounts', { headers: { origin: 'http://crm.example.com' } })), false);
  assert.equal(isZaloAccountOriginAllowed(new Request('http://localhost:10000/api/accounts')), false);
  process.env.DEMO_MODE = 'false';
  process.env.ZALO_ACCOUNT_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  const credentials = parseZaloCredentials(raw());
  assert.equal(JSON.parse(credentials.cookie).cookies.length, 1);
  assert.throws(() => parseZaloCredentials({ ...raw(), cookie: '{bad' }));
  assert.throws(() => parseZaloCredentials({ ...raw(), imei: 'null' }));
  assert.throws(() => parseZaloCredentials({ ...raw(), userAgent: 'bad\r\nheader' }));
  const encrypted = encryptZaloCredentials(company, boss, credentials);
  assert.deepEqual(decryptZaloCredentials(company, boss, encrypted), credentials);
  assert.throws(() => decryptZaloCredentials(other, boss, encrypted));
  assert.throws(() => decryptZaloCredentials(company, other, encrypted));
  assert.throws(() => decryptZaloCredentials(company, boss, { ...encrypted, tag: randomBytes(16).toString('base64') }));
  assert.equal(credentialsFingerprint(credentials), credentialsFingerprint(parseZaloCredentials(raw())));
  for (const change of [{ aal: 'aal1' }, { role: 'SALE' }, { profileStatus: 'SUSPENDED' }, { membershipStatus: 'INACTIVE' }, { companyId: null }]) {
    assert.throws(() => assertZaloAccountAdmin({ ...actor, ...change } as ActorContext));
  }
  const pg = await createPgliteSupabase();
  const { db, client } = pg;
  try {
    await db.exec(`INSERT INTO public.companies(id,name) VALUES ('${company}','Accounts test'),('${other}','Other');
      INSERT INTO auth.users(id,email) VALUES ('${boss}','boss@test.local');
      INSERT INTO public.user_profiles(id,full_name) VALUES ('${boss}','Boss') ON CONFLICT(id) DO NOTHING;
      INSERT INTO public.company_members(company_id,user_id,role) VALUES ('${company}','${boss}','BOSS_ADMIN');
      INSERT INTO public.ai_brain_live_settings(company_id,channel,enabled) VALUES ('${company}','ZALO',true);`);
    const id = await saveZaloAccount(actor, raw(), client);
    const id2 = await saveZaloAccount(actor, raw('second-session'), client);
    await saveZaloAccount(actor, raw('third-session'), client);
    await assert.rejects(saveZaloAccount(actor, raw('fourth-session'), client), /đủ 3/);
    const listed = await listZaloAccounts(company, client);
    assert.equal(listed.length, 3);
    assert.equal(JSON.stringify(listed).includes('ciphertext'), false);
    assert.equal(JSON.stringify(listed).includes('test-session'), false);
    assert.deepEqual(await listZaloAccounts(other, client), []);
    await assert.rejects(saveZaloAccount({ ...actor, companyId: other }, { ...raw(), id }, client));
    const runtime = (await client.rpc('get_zalo_runtime_accounts', { p_company_id: company })).data;
    assert.deepEqual(decryptZaloCredentials(company, id, runtime.find((a: { id: string }) => a.id === id).encrypted_credentials), credentials);
    const report = (accountId: string | null, uid: string | null, revision = 1) => client.rpc('report_zalo_account_runtime', { p_company_id: company, p_id: accountId, p_revision: revision, p_status: 'CONNECTED', p_provider_uid: uid });
    assert.match((await report(id, '222222')).error!.message, /LEGACY_NOT_READY/);
    assert.equal((await report(null, '111111')).error, null);
    assert.match((await report(id, '111111')).error!.message, /DUPLICATE/);
    assert.equal((await report(id, '222222')).data, true);
    assert.match((await report(id2, '222222')).error!.message, /DUPLICATE/);
    assert.match((await report(id, '333333')).error!.message, /IDENTITY_CHANGED/);
    assert.equal((await report(id, '222222', 99)).data, false);
    await toggleZaloAccount(actor, id, false, client);
    assert.equal((await client.rpc('get_zalo_runtime_accounts', { p_company_id: company })).data.length, 2);
    assert.equal((await report(id, '222222')).data, false);
    await toggleZaloAccount(actor, id, true, client);
    assert.equal((await report(id, '222222', 3)).data, true);
    for (const accountId of [id, id2]) {
      const thread = scopeZaloThread(accountId, 'group:987654321');
      assert.equal(splitZaloThread(thread).accountId, accountId);
      const response = await client.rpc('ingest_zcajs_message_atomic', { p_company_id: company, p_channel: 'ZALO', p_external_user_id: thread, p_sender_name: 'Nhóm thử', p_external_conversation_id: thread, p_external_ref: `account:${accountId}:same-message`, p_sanitized_content: 'Test', p_raw_content: 'Test', p_source_metadata: { transport: 'ZCAJS', is_group: true, group_id: '987654321', zalo_account_id: accountId, zalo_account_name: 'Tư vấn' } });
      assert.equal(response.error, null, JSON.stringify(response.error));
      const convId = response.data[0].conversation_id;
      assert.equal((await db.query<{ ai_mode: string }>('SELECT ai_mode FROM public.conversations WHERE id=$1', [convId])).rows[0].ai_mode, 'PAUSED');
      const sync = await client.rpc('sync_zalo_group_metadata', { p_company_id: company, p_conversation_id: convId, p_group: { group_name: 'Nhóm đúng', member_count: 7, members: [] } });
      assert.equal(sync.error, null, JSON.stringify(sync.error));
      assert.equal(sync.data.group_id, '987654321');
      const observed = await client.rpc('record_observed_zcajs_outbound_atomic', { p_company_id: company, p_external_conversation_id: thread, p_provider_msg_id: `account:${accountId}:same-outbound`, p_sanitized_content: 'Native outbound', p_raw_content: 'Native outbound', p_source_metadata: { transport: 'ZCAJS', is_group: true, zalo_account_id: accountId } });
      assert.equal(observed.error, null, JSON.stringify(observed.error));
    }
    const directThread = scopeZaloThread(id, '12345678');
    const direct = await client.rpc('ingest_zcajs_message_atomic', { p_company_id: company, p_channel: 'ZALO', p_external_user_id: directThread, p_external_conversation_id: directThread, p_external_ref: `account:${id}:direct`, p_sender_name: 'Khách thử', p_sanitized_content: 'Question', p_raw_content: 'Question', p_source_metadata: { transport: 'ZCAJS', zalo_account_id: id } });
    assert.equal(direct.error, null, JSON.stringify(direct.error));
    assert.equal((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.ai_brain_live_deliveries')).rows[0].n, 0, 'new account never auto-replies during onboarding');
    assert.equal((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.conversations')).rows[0].n, 3, 'same group in two accounts stays separate');
    await db.query("INSERT INTO public.zalo_oa_configs(company_id,oa_id,app_id,status) VALUES ($1,'zcajs-test','zcajs','ACTIVE')", [company]);
    const outbound = await client.rpc('record_outbound_interaction_atomic', { p_company_id: company, p_conversation_id: direct.data[0].conversation_id, p_sanitized_content: 'Reply', p_raw_content: 'Reply', p_actor_user_id: boss });
    assert.equal(outbound.error, null, JSON.stringify(outbound.error));
    const claimed = await client.rpc('zalo_claim_canonical_delivery', { p_delivery_id: outbound.data.delivery_id, p_worker_id: 'account-test', p_override_oa_id: 'zcajs-test' });
    assert.equal(claimed.error, null, JSON.stringify(claimed.error));
    assert.equal(claimed.data[0].recipient_zalo_uid, directThread, 'outbox preserves sender account namespace');
    await db.exec('GRANT SELECT,UPDATE ON public.conversations TO service_role');
    await db.exec('BEGIN; SET LOCAL ROLE service_role;');
    try {
      await db.query("UPDATE public.conversations SET metadata=metadata||'{\"zalo_display_name\":\"Refreshed by service role\"}'::jsonb WHERE external_conversation_id=$1", [directThread]);
      await db.exec('COMMIT');
    } catch (error) { await db.exec('ROLLBACK'); throw error; }
    await assert.rejects(db.query("UPDATE public.conversations SET metadata=jsonb_build_object('zalo_account_id',$1::text) WHERE external_conversation_id=$2", [id2, directThread]), /SCOPE_MISMATCH/);
    for (const fn of ['get_zalo_runtime_accounts(uuid)', 'list_zalo_accounts(uuid)']) {
      assert.equal((await db.query<{ allowed: boolean }>('SELECT has_function_privilege(\'authenticated\',$1,\'EXECUTE\') AS allowed', [fn])).rows[0].allowed, false);
    }
    assert.equal((await db.query<{ allowed: boolean }>("SELECT has_table_privilege('authenticated','private.zalo_accounts','SELECT') AS allowed")).rows[0].allowed, false);
    console.log('PASS Zalo account encryption, authorization, lifecycle, SQL isolation and group ingestion');
  } finally { await pg.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
