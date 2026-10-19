import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPgliteSupabase } from '../zalo/helpers/pglite-supabase';
import { toStringeeTestUserIds } from '../../features/voice/providers/stringee-provider';

async function main() {
  const h = await createPgliteSupabase();
  const db = h.db;
  try {
    const tenant = randomUUID(), other = randomUUID(), boss = randomUUID(), sale = randomUUID(), tech = randomUUID();
    const customer = randomUUID(), realCustomer = randomUUID(), otherCustomer = randomUUID(), integration = randomUUID(), otherIntegration = randomUUID();
    await db.query<Record<string, unknown>>(`INSERT INTO companies(id,name) VALUES($1,'Voice test'),($2,'Other tenant')`, [tenant,other]);
    for (const [id,role] of [[boss,'BOSS_ADMIN'],[sale,'SALE'],[tech,'TECHNICIAN']]) {
      await db.query<Record<string, unknown>>(`INSERT INTO auth.users(id) VALUES($1)`,[id]);
      await db.query<Record<string, unknown>>(`INSERT INTO user_profiles(id,full_name) VALUES($1,'Test actor') ON CONFLICT(id) DO NOTHING`,[id]);
      await db.query<Record<string, unknown>>(`INSERT INTO company_members(company_id,user_id,role,status) VALUES($1,$2,$3,'ACTIVE')`,[tenant,id,role]);
    }
    for (const [id,company] of [[customer,tenant],[realCustomer,tenant],[otherCustomer,other]]) {
      await db.query<Record<string, unknown>>(`INSERT INTO customers(id,company_id,name,source,stage) VALUES($1,$2,'Test fixture','HOTLINE','LEAD_NEW')`,[id,company]);
    }
    for (const [id,company,project] of [[integration,tenant,'project-a'],[otherIntegration,other,'project-b']]) {
      await db.query<Record<string, unknown>>(`INSERT INTO voice_provider_integrations(id,company_id,provider,provider_account_id,routing_key_hash,webhook_secret_env)
        VALUES($1,$2,'STRINGEE',$3,$4,'TEST_SECRET')`,[id,company,project,'a'.repeat(63)+(company===tenant?'a':'b')]);
    }
    await db.query<Record<string, unknown>>(`INSERT INTO voice_test_customers VALUES($1,$2)`,[customer,integration]);
    const pair = toStringeeTestUserIds(`${boss}:${customer}`,tenant), request = randomUUID();
    const prepare = (c=customer,i=integration,actor=boss,req=request) => db.query<{call_id:string;attempt_id:string}>(
      `SELECT * FROM prepare_sale_voice_call_atomic($1,$2,$3,'STRINGEE',$4,$5,$6,$7)`,[tenant,c,actor,req,i,pair.A,pair.B]);
    await assert.rejects(prepare(otherCustomer));
    await assert.rejects(prepare(customer,otherIntegration));
    await assert.rejects(prepare(realCustomer));
    await assert.rejects(prepare(customer,integration,sale));
    await assert.rejects(prepare(customer,integration,tech));
    const prepared = (await prepare()).rows[0];
    assert.ok(prepared.call_id && prepared.attempt_id);
    assert.deepEqual((await prepare()).rows[0],prepared);
    await assert.rejects(prepare(customer,integration,boss,randomUUID()));
    const initial=(await db.query<Record<string, unknown>>(`SELECT c.*,a.provider_call_id AS attempt_external,a.result FROM calls c JOIN call_attempts a ON a.call_id=c.id WHERE c.id=$1`,[prepared.call_id])).rows[0];
    assert.equal(initial.initiated_by,boss);assert.equal(initial.customer_id,customer);assert.equal(initial.company_id,tenant);
    assert.equal(initial.status,'INITIATED');assert.equal(initial.direction,'OUTBOUND');assert.equal(initial.provider,'STRINGEE');
    assert.equal(initial.attempt_external,`crm_${prepared.call_id}`);
    const external='call-vn-test-business-12345678';
    const event = (status:string,key:string) => db.query<Record<string, unknown>>(`SELECT * FROM apply_voice_call_status_atomic($1,'STRINGEE',$2,$3,$4)`,[tenant,external,status,key]);
    // Race: real status arrives before the signed answer URL binds the canonical id.
    await event('RINGING','early-ring');
    assert.equal((await db.query<Record<string, unknown>>(`SELECT processed_at FROM voice_webhook_events WHERE idempotency_key='early-ring'`)).rows[0].processed_at,null);
    assert.equal((await db.query<Record<string, unknown>>(`SELECT bind_voice_browser_test_call($1,$2,$3,$4) AS id`,[otherIntegration,pair.A,pair.B,external])).rows[0].id,null);
    assert.equal((await db.query<Record<string, unknown>>(`SELECT bind_voice_browser_test_call($1,$2,$3,$4) AS id`,[integration,pair.A,pair.B,external])).rows[0].id,prepared.call_id);
    await event('INITIATED','late-created');
    assert.equal((await db.query<Record<string, unknown>>(`SELECT status FROM calls WHERE id=$1`,[prepared.call_id])).rows[0].status,'RINGING');
    await event('CONNECTED','answer');
    await event('RINGING','late-ring');
    assert.equal((await db.query<Record<string, unknown>>(`SELECT status FROM calls WHERE id=$1`,[prepared.call_id])).rows[0].status,'CONNECTED');
    await event('COMPLETED','end');
    await event('COMPLETED','end');
    await event('FAILED','late-failure');
    const final=(await db.query<Record<string, unknown>>(`SELECT c.status,c.provider_call_id,a.result,a.provider_call_id AS attempt_external FROM calls c JOIN call_attempts a ON a.call_id=c.id WHERE c.id=$1`,[prepared.call_id])).rows[0];
    assert.deepEqual(final,{status:'COMPLETED',provider_call_id:external,result:'ANSWERED',attempt_external:external});
    assert.equal((await db.query<Record<string, unknown>>(`SELECT count(*)::int AS n FROM calls`)).rows[0].n,1);
    assert.equal((await db.query<Record<string, unknown>>(`SELECT count(*)::int AS n FROM call_attempts`)).rows[0].n,1);
    assert.equal((await db.query<Record<string, unknown>>(`SELECT count(*)::int AS n FROM voice_webhook_events WHERE call_id=$1 AND processed_at IS NOT NULL`,[prepared.call_id])).rows[0].n,6);
    assert.equal((await db.query<Record<string, unknown>>(`SELECT stage FROM customers WHERE id=$1`,[customer])).rows[0].stage,'LEAD_NEW');
    await db.exec(`SET ROLE authenticated`);
    await assert.rejects(prepare());
    await assert.rejects(db.query<Record<string, unknown>>(`SELECT * FROM voice_browser_call_sessions`));
    await db.exec(`RESET ROLE`);
    console.log('PASS: all migrations, call/attempt/audit, test allowlist, tenant/role denial, early webhook reconciliation, monotonic lifecycle, idempotency, no Sale retry/stage mutation, restricted DB access.');
  } finally { await h.close(); }
}
main().catch(error=>{console.error(error);process.exit(1);});
