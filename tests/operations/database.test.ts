import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { completeInstallationAndHandover, attachInstallationEvidence, updateInstallationStatus, verifyTechnicianInstallationAssignment } from '../../features/installation/installation-service';
import { prepareEvidence } from '../../features/installation/evidence';
const container='supabase_db_ai-crm-cua-chong-ngap';
const sql=(query: string)=>execFileSync('docker',['exec','-i',container,'psql','-X','-qAt','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1'],{input:query,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const q=(v: unknown)=>`'${String(v).replaceAll("'","''")}'`;
const c=randomUUID(), other=randomUUID(), customer=randomUUID(), boss=randomUUID(), sale=randomUUID(), tech=randomUUID(), tech2=randomUUID(), policy=randomUUID(), price=randomUUID();
const actor={userId:tech,role:'TECHNICIAN'};
function concurrent(query: string) {
 return new Promise<string>((resolve,reject)=>{
  const child=spawn('docker',['exec','-i',container,'psql','-X','-qAt','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1']);
  let out='',err=''; child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',reject);child.on('close',code=>code===0?resolve(out.trim()):reject(new Error(err)));child.stdin.end(query);
 });
}
function order(status='CONTRACT_SIGNED',signed=true,signedRef: string|null=signed?'test-signed':null) {
 const id=randomUUID(), calcId=randomUUID();
 sql(`INSERT INTO public.price_calculations(id,company_id,customer_id,pricing_policy_id,policy_version,input_data,amount,status) VALUES(${q(calcId)},${q(c)},${q(customer)},${q(policy)},'test','{"width": 2, "height": 1}',100,'CALCULATED');
 INSERT INTO public.orders(id,company_id,customer_id,payment_reference,price_calculation_id,deposit_status,order_status,final_amount) VALUES(${q(id)},${q(c)},${q(customer)},${q(id)},${q(calcId)},'CONFIRMED',${q(status)},100);
 INSERT INTO public.contracts(company_id,order_id,template_version,generated_file_ref,signed_file_ref,status,contract_value) VALUES(${q(c)},${q(id)},'test','test',${signedRef!==null?q(signedRef):'NULL'},${q(signed?'SIGNED':'GENERATED')},100);`);
 return id;
}
function appt(status='ACCEPTED',type='INSTALLATION') {
 const id=randomUUID();sql(`INSERT INTO public.appointments(id,company_id,customer_id,type,start_time,assignee_id,address,status) VALUES(${q(id)},${q(c)},${q(customer)},${q(type)},now(),${q(tech)},'Test only',${q(status)});`);return id;
}

test('real local Supabase Operations gate (requires clean start/reset)',async t=>{
 const local=JSON.parse(execFileSync('npx',['supabase','status','-o','json'],{encoding:'utf8',stdio:['pipe','pipe','pipe']}));
 assert.match(local.API_URL,/^http:\/\/(127\.0\.0\.1|localhost):/);
 const admin=createClient(local.API_URL,local.SERVICE_ROLE_KEY,{auth:{persistSession:false}});
 const anon=createClient(local.API_URL,local.ANON_KEY,{auth:{persistSession:false}});
 const rpc=async(name: string,args: Record<string,unknown>)=>{
  const result=await admin.rpc(name,args);assert.equal(result.error,null,result.error?.message);return result.data;
 };
 const reject=async(name: string,args: Record<string,unknown>,message='INVALID_STATE_TRANSITION')=>{
  const {error}=await admin.rpc(name,args);assert.ok(error,'expected RPC rejection');assert.equal(error.message,message);
 };
 const create=(id: string,company=c)=>({p_company_id:company,p_order_id:id,p_actor_id:boss,p_specs:{dimensions:'200x100cm'},p_materials:{aluminum:'6063-T5'},p_deadline:'2026-10-01T00:00:00Z'});
 const progress=(id: string,status: string)=>({p_company_id:c,p_production_order_id:id,p_actor_id:boss,p_status:status});
 const qc=(id: string)=>({p_company_id:c,p_production_order_id:id,p_inspector_id:boss,p_qc_status:'PASSED'});
 const schedule=(id: string,a: string)=>({p_company_id:c,p_order_id:id,p_customer_id:customer,p_appointment_id:a,p_crew:['Test crew'],p_actor_id:boss});
 const ready=async()=>{const o=order();const p=await rpc('create_production_order_atomic',create(o));await rpc('update_production_progress_atomic',progress(p.id,'IN_PRODUCTION'));await rpc('update_production_progress_atomic',progress(p.id,'QC_IN_PROGRESS'));await rpc('record_quality_check_atomic',qc(p.id));return {o,p};};
 const installation=async()=>{
  const {o,p}=await ready();
  const sched=await rpc('create_installation_schedule_atomic',{p_company_id:c,p_order_id:o,p_actor_id:boss,p_technician_id:tech,p_start_time:'2026-10-10T08:00:00Z',p_address:'123 Fixture St',p_crew:['Test crew']});
  await rpc('accept_installation_appointment_atomic',{p_company_id:c,p_appointment_id:sched.appointment.id,p_actor_id:tech});
  return {o,p,a:sched.appointment.id,i:sched.installation};
 };
 const uploaded: string[]=[];
 const createdAuthUsers: string[]=[boss, sale, tech, tech2];
 try {
 sql(`INSERT INTO public.companies(id,name) VALUES(${q(c)},'Operations integration fixture'),(${q(other)},'Other test tenant');
 INSERT INTO public.customers(id,company_id,name,source,stage) VALUES(${q(customer)},${q(c)},'Test only','MANUAL','LEAD_NEW');
 INSERT INTO public.pricing_policies(id,company_id,version,conditions,price_rules,effective_at,status) VALUES(${q(policy)},${q(c)},'test','{"standard_materials": {"aluminum": "6063-T5"}}','{}',now(),'ACTIVE');
 INSERT INTO public.price_calculations(id,company_id,customer_id,pricing_policy_id,policy_version,input_data,amount,status) VALUES(${q(price)},${q(c)},${q(customer)},${q(policy)},'test','{"width": 2, "height": 1}',100,'CALCULATED');`);
 for(const [id,role] of [[boss,'BOSS_ADMIN'],[sale,'SALE'],[tech,'TECHNICIAN'],[tech2,'TECHNICIAN']]) sql(`INSERT INTO auth.users(id) VALUES(${q(id)}); INSERT INTO public.user_profiles(id,full_name,status) VALUES(${q(id)},'Test only','ACTIVE') ON CONFLICT(id) DO UPDATE SET status='ACTIVE'; INSERT INTO public.company_members(company_id,user_id,role,status) VALUES(${q(c)},${q(id)},${q(role)},'ACTIVE');`);
 await t.test('migration applied; bucket private, constrained and RPC grants restricted',async()=>{
  assert.equal(sql("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='20261004180001'"),'1');
  assert.equal(sql("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='20261004210001'"),'1');
  const {data,error}=await admin.storage.getBucket('installation-docs');assert.equal(error,null);assert.equal(data?.public,false);assert.equal(data?.file_size_limit,10485760);
  const funcs=JSON.parse(sql(`SELECT json_agg(json_build_object('name',proname,'safe',prosecdef AND proconfig @> ARRAY['search_path=""'],'anon',has_function_privilege('anon',oid,'execute'),'auth',has_function_privilege('authenticated',oid,'execute'),'service',has_function_privilege('service_role',oid,'execute'))) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('create_production_order_atomic','update_production_progress_atomic','record_quality_check_atomic','mutate_installation_atomic','complete_installation_atomic','update_warranty_status_atomic','create_installation_schedule_atomic','accept_installation_appointment_atomic','start_installation_work_atomic')`));
  assert.equal(funcs.length,9);for(const f of funcs){assert.ok(f.safe,f.name);assert.equal(f.anon,false);assert.equal(f.auth,false);assert.equal(f.service,true);}
  assert.equal(sql("SELECT count(*) FROM pg_proc WHERE proname='schedule_installation_atomic'"),'0');
  assert.ok((await anon.rpc('create_production_order_atomic',create(randomUUID()))).error);
 });
 await t.test('atomic production success and one audit',async()=>{
  const o=order();const p=await rpc('create_production_order_atomic',create(o));assert.equal(p.status,'RELEASED_TO_FACTORY');assert.equal(sql(`SELECT order_status FROM public.orders WHERE id=${q(o)}`),'IN_PRODUCTION');assert.equal(sql(`SELECT count(*) FROM public.audit_logs WHERE resource_id=${q(p.id)} AND action='CREATE_PRODUCTION_ORDER'`),'1');
  await reject('create_production_order_atomic',create(o));
 });
 await t.test('cancelled, unsigned and blank signed refs reject production',async()=>{
  await reject('create_production_order_atomic',create(order('CANCELLED')));
  await reject('create_production_order_atomic',create(order('CONTRACT_SIGNED',false)),'CONTRACT_NOT_SIGNED');
  await reject('create_production_order_atomic',create(order('CONTRACT_SIGNED',true,'  ')),'CONTRACT_NOT_SIGNED');
 });
 await t.test('cross-company production access rejects',async()=>{
  const args=create(order());args.p_company_id=other;await reject('create_production_order_atomic',args,'PERMISSION_DENIED');
  sql(`INSERT INTO public.company_members(company_id,user_id,role,status) VALUES(${q(other)},${q(boss)},'BOSS_ADMIN','ACTIVE')`);
  await reject('create_production_order_atomic',args,'RESOURCE_NOT_FOUND');
 });
 await t.test('concurrent production creation inserts exactly one row',async()=>{
  const o=order();const results=await Promise.all([admin.rpc('create_production_order_atomic',create(o)),admin.rpc('create_production_order_atomic',create(o))]);assert.equal(results.filter(r=>!r.error).length,1);assert.equal(sql(`SELECT count(*) FROM public.production_orders WHERE order_id=${q(o)}`),'1');
 });
 await t.test('stale/concurrent progress cannot overwrite state or duplicate audit',async()=>{
  const p=await rpc('create_production_order_atomic',create(order()));const results=await Promise.all([admin.rpc('update_production_progress_atomic',progress(p.id,'IN_PRODUCTION')),admin.rpc('update_production_progress_atomic',progress(p.id,'IN_PRODUCTION'))]);assert.equal(results.filter(r=>!r.error).length,1);
  await rpc('update_production_progress_atomic',progress(p.id,'QC_IN_PROGRESS'));
  await reject('update_production_progress_atomic',progress(p.id,'RELEASED_TO_FACTORY'));
  for(const status of ['QC_PASSED','QC_FAILED','READY_FOR_DISPATCH']) await reject('update_production_progress_atomic',progress(p.id,status));
  assert.equal(sql(`SELECT status FROM public.production_orders WHERE id=${q(p.id)}`),'QC_IN_PROGRESS');
 });
 await t.test('audit failure rolls entire production transaction back',async()=>{
  const o=order();sql(`CREATE FUNCTION public.operations_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id=${q(c)}::uuid AND NEW.action='CREATE_PRODUCTION_ORDER' THEN RAISE EXCEPTION 'TEST_AUDIT_FAILURE'; END IF; RETURN NEW; END $$; CREATE TRIGGER operations_test_audit_failure BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.operations_test_audit_failure();`);
  try {await reject('create_production_order_atomic',create(o),'TEST_AUDIT_FAILURE');assert.equal(sql(`SELECT order_status FROM public.orders WHERE id=${q(o)}`),'CONTRACT_SIGNED');assert.equal(sql(`SELECT count(*) FROM public.production_orders WHERE order_id=${q(o)}`),'0');}
  finally {sql('DROP TRIGGER operations_test_audit_failure ON public.audit_logs; DROP FUNCTION public.operations_test_audit_failure();');}
 });
 await t.test('QC valid production passes and cancelled order cannot resurrect',async()=>{
  const {o}=await ready();assert.equal(sql(`SELECT order_status FROM public.orders WHERE id=${q(o)}`),'READY_FOR_INSTALL');
  const cancelled=order();const p=await rpc('create_production_order_atomic',create(cancelled));await rpc('update_production_progress_atomic',progress(p.id,'IN_PRODUCTION'));await rpc('update_production_progress_atomic',progress(p.id,'QC_IN_PROGRESS'));sql(`UPDATE public.orders SET order_status='CANCELLED' WHERE id=${q(cancelled)}`);await reject('record_quality_check_atomic',qc(p.id));assert.equal(sql(`SELECT status FROM public.production_orders WHERE id=${q(p.id)}`),'QC_IN_PROGRESS');
 });
 await t.test('authenticated BOSS_ADMIN and SALE direct writes to INSTALLATION appointments fail closed under RLS', async () => {
  // 1. Create real authenticated Supabase clients for BOSS_ADMIN and SALE
  const bossEmail = `boss-rls-${randomUUID()}@example.test`;
  const bossPass = `BossPass-${randomUUID()}!`;
  const bossAuthRes = await admin.auth.admin.createUser({ email: bossEmail, password: bossPass, email_confirm: true });
  assert.equal(bossAuthRes.error, null);
  const bossAuthId = bossAuthRes.data.user!.id;
  createdAuthUsers.push(bossAuthId);

  const saleEmail = `sale-rls-${randomUUID()}@example.test`;
  const salePass = `SalePass-${randomUUID()}!`;
  const saleAuthRes = await admin.auth.admin.createUser({ email: saleEmail, password: salePass, email_confirm: true });
  assert.equal(saleAuthRes.error, null);
  const saleAuthId = saleAuthRes.data.user!.id;
  createdAuthUsers.push(saleAuthId);

  sql(`UPDATE public.company_members SET status='INACTIVE' WHERE company_id=${q(c)} AND user_id=${q(sale)};
  INSERT INTO public.user_profiles(id,full_name,status) VALUES(${q(bossAuthId)},'Boss Auth User','ACTIVE'),(${q(saleAuthId)},'Sale Auth User','ACTIVE') ON CONFLICT (id) DO UPDATE SET status='ACTIVE', full_name=EXCLUDED.full_name;
  INSERT INTO public.company_members(company_id,user_id,role,status) VALUES(${q(c)},${q(bossAuthId)},'BOSS_ADMIN','ACTIVE'),(${q(c)},${q(saleAuthId)},'SALE','ACTIVE');`);
  try {

  const bossAuthClient = createClient(local.API_URL, local.ANON_KEY, { auth: { persistSession: false } });
  const bossSignIn = await bossAuthClient.auth.signInWithPassword({ email: bossEmail, password: bossPass });
  assert.equal(bossSignIn.error, null);

  const saleAuthClient = createClient(local.API_URL, local.ANON_KEY, { auth: { persistSession: false } });
  const saleSignIn = await saleAuthClient.auth.signInWithPassword({ email: saleEmail, password: salePass });
  assert.equal(saleSignIn.error, null);

  // 2. Direct INSERT type=INSTALLATION denied for BOSS_ADMIN and SALE
  const bossDirectInsert = await bossAuthClient.from('appointments').insert({
    company_id: c,
    customer_id: customer,
    type: 'INSTALLATION',
    start_time: '2026-10-10T08:00:00Z',
    assignee_id: tech,
    address: 'Bypass Direct Insert',
    status: 'ASSIGNED',
  }).select();
  assert.ok(bossDirectInsert.error, 'BOSS direct INSERT type=INSTALLATION must fail');
  assert.match(bossDirectInsert.error.message, /violates row-level security policy/i);

  const saleDirectInsert = await saleAuthClient.from('appointments').insert({
    company_id: c,
    customer_id: customer,
    type: 'INSTALLATION',
    start_time: '2026-10-10T08:00:00Z',
    assignee_id: tech,
    address: 'Bypass Direct Insert',
    status: 'ASSIGNED',
  }).select();
  assert.ok(saleDirectInsert.error, 'SALE direct INSERT type=INSTALLATION must fail');
  assert.match(saleDirectInsert.error.message, /violates row-level security policy/i);

  // 3. Service-role creates canonical INSTALLATION appointment via trusted RPC
  const { o: rlsOrder } = await ready();
  const canonicalSched = await rpc('create_installation_schedule_atomic', {
    p_company_id: c,
    p_order_id: rlsOrder,
    p_actor_id: boss,
    p_technician_id: tech,
    p_start_time: '2026-10-10T08:00:00Z',
    p_address: 'Canonical Address RLS Test',
    p_crew: ['Crew RLS'],
  });
  assert.equal(canonicalSched.success, true);
  assert.equal(canonicalSched.appointment.type, 'INSTALLATION');
  assert.equal(canonicalSched.appointment.status, 'ASSIGNED');
  const installApptId = canonicalSched.appointment.id;

  // 4. Direct UPDATEs on INSTALLATION appointments fail closed (affect 0 rows under RLS)
  // - ASSIGNED -> ACCEPTED
  for (const [name, client] of [['BOSS_ADMIN', bossAuthClient], ['SALE', saleAuthClient]] as const) {
    const res = await client.from('appointments').update({ status: 'ACCEPTED' }).eq('id', installApptId).select();
    assert.equal(res.data?.length ?? 0, 0, `${name} direct UPDATE status=ACCEPTED must affect 0 rows`);
    assert.equal(sql(`SELECT status FROM public.appointments WHERE id=${q(installApptId)}`), 'ASSIGNED');
  }

  // - ASSIGNED -> IN_PROGRESS
  for (const [name, client] of [['BOSS_ADMIN', bossAuthClient], ['SALE', saleAuthClient]] as const) {
    const res = await client.from('appointments').update({ status: 'IN_PROGRESS' }).eq('id', installApptId).select();
    assert.equal(res.data?.length ?? 0, 0, `${name} direct UPDATE status=IN_PROGRESS must affect 0 rows`);
    assert.equal(sql(`SELECT status FROM public.appointments WHERE id=${q(installApptId)}`), 'ASSIGNED');
  }

  // - ASSIGNED -> COMPLETED
  for (const [name, client] of [['BOSS_ADMIN', bossAuthClient], ['SALE', saleAuthClient]] as const) {
    const res = await client.from('appointments').update({ status: 'COMPLETED' }).eq('id', installApptId).select();
    assert.equal(res.data?.length ?? 0, 0, `${name} direct UPDATE status=COMPLETED must affect 0 rows`);
    assert.equal(sql(`SELECT status FROM public.appointments WHERE id=${q(installApptId)}`), 'ASSIGNED');
  }

  // - assignee_id change
  for (const [name, client] of [['BOSS_ADMIN', bossAuthClient], ['SALE', saleAuthClient]] as const) {
    const res = await client.from('appointments').update({ assignee_id: tech2 }).eq('id', installApptId).select();
    assert.equal(res.data?.length ?? 0, 0, `${name} direct UPDATE assignee_id change must affect 0 rows`);
    assert.equal(sql(`SELECT assignee_id FROM public.appointments WHERE id=${q(installApptId)}`), tech);
  }

  // - type change: INSTALLATION -> SURVEY
  for (const [name, client] of [['BOSS_ADMIN', bossAuthClient], ['SALE', saleAuthClient]] as const) {
    const res = await client.from('appointments').update({ type: 'SURVEY' }).eq('id', installApptId).select();
    assert.equal(res.data?.length ?? 0, 0, `${name} direct UPDATE type=SURVEY must affect 0 rows`);
    assert.equal(sql(`SELECT type FROM public.appointments WHERE id=${q(installApptId)}`), 'INSTALLATION');
  }

  // 5. Existing SURVEY journey still works for BOSS and SALE
  const bossSurveyInsert = await bossAuthClient.from('appointments').insert({
    company_id: c,
    customer_id: customer,
    type: 'SURVEY',
    start_time: '2026-10-10T09:00:00Z',
    assignee_id: tech,
    address: 'Survey Address Boss',
    status: 'ASSIGNED',
  }).select().single();
  assert.equal(bossSurveyInsert.error, null);
  assert.equal(bossSurveyInsert.data.type, 'SURVEY');

  const saleSurveyInsert = await saleAuthClient.from('appointments').insert({
    company_id: c,
    customer_id: customer,
    type: 'SURVEY',
    start_time: '2026-10-10T10:00:00Z',
    assignee_id: tech,
    address: 'Survey Address Sale',
    status: 'ASSIGNED',
  }).select().single();
  assert.equal(saleSurveyInsert.error, null);
  assert.equal(saleSurveyInsert.data.type, 'SURVEY');

  // Direct UPDATE on SURVEY appointment works
  const bossUpdateSurvey = await bossAuthClient.from('appointments').update({
    address: 'Updated Survey Address Boss',
  }).eq('id', bossSurveyInsert.data.id).select().single();
  assert.equal(bossUpdateSurvey.error, null);
  assert.equal(bossUpdateSurvey.data.address, 'Updated Survey Address Boss');

  // Attempting to mutate SURVEY appointment into INSTALLATION fails closed
  for (const [name, client] of [['BOSS_ADMIN', bossAuthClient], ['SALE', saleAuthClient]] as const) {
    const mutRes = await client.from('appointments').update({
      type: 'INSTALLATION',
    }).eq('id', bossSurveyInsert.data.id).select();
    assert.ok(mutRes.error, `${name} changing SURVEY to INSTALLATION must fail RLS`);
    assert.match(mutRes.error.message, /violates row-level security policy/i);
  }
  } finally {
    sql(`DELETE FROM public.company_members WHERE company_id=${q(c)} AND user_id IN (${q(bossAuthId)}, ${q(saleAuthId)});
    UPDATE public.company_members SET status='ACTIVE' WHERE company_id=${q(c)} AND user_id=${q(sale)};`);
  }
 });

 await t.test('idempotent scheduling verifies payload match; payload mismatch fails closed', async () => {
  const { o: matchOrder } = await ready();
  const baseSched = {
    p_company_id: c,
    p_order_id: matchOrder,
    p_actor_id: boss,
    p_technician_id: tech,
    p_start_time: '2026-10-15T08:00:00Z',
    p_address: '789 Le Loi, Q.1',
    p_crew: ['Thợ 1', 'Thợ 2'],
  };

  const initial = await rpc('create_installation_schedule_atomic', baseSched);
  assert.equal(initial.success, true);
  assert.equal(initial.idempotent, false);

  // Exact same payload retry succeeds idempotently
  const exactRetry = await rpc('create_installation_schedule_atomic', baseSched);
  assert.equal(exactRetry.success, true);
  assert.equal(exactRetry.idempotent, true);
  assert.equal(exactRetry.installation.id, initial.installation.id);

  // Crew in different order (canonical crew semantics) succeeds idempotently
  const permutedCrewRetry = await rpc('create_installation_schedule_atomic', {
    ...baseSched,
    p_crew: ['Thợ 2', 'Thợ 1'],
  });
  assert.equal(permutedCrewRetry.success, true);
  assert.equal(permutedCrewRetry.idempotent, true);

  // Address with extra surrounding whitespace normalizes and succeeds idempotently
  const paddedAddressRetry = await rpc('create_installation_schedule_atomic', {
    ...baseSched,
    p_address: '  789 Le Loi, Q.1  ',
  });
  assert.equal(paddedAddressRetry.success, true);
  assert.equal(paddedAddressRetry.idempotent, true);

  // Mismatched technician fails closed
  await reject('create_installation_schedule_atomic', {
    ...baseSched,
    p_technician_id: tech2,
  }, 'INSTALLATION_SCHEDULE_ALREADY_EXISTS_WITH_DIFFERENT_PAYLOAD');

  // Mismatched start_time fails closed
  await reject('create_installation_schedule_atomic', {
    ...baseSched,
    p_start_time: '2026-10-15T14:00:00Z',
  }, 'INSTALLATION_SCHEDULE_ALREADY_EXISTS_WITH_DIFFERENT_PAYLOAD');

  // Mismatched address fails closed
  await reject('create_installation_schedule_atomic', {
    ...baseSched,
    p_address: '999 Nguyen Trai, Q.5',
  }, 'INSTALLATION_SCHEDULE_ALREADY_EXISTS_WITH_DIFFERENT_PAYLOAD');

  // Mismatched crew fails closed
  await reject('create_installation_schedule_atomic', {
    ...baseSched,
    p_crew: ['Thợ Khác'],
  }, 'INSTALLATION_SCHEDULE_ALREADY_EXISTS_WITH_DIFFERENT_PAYLOAD');

  // Blank crew member fails input validation
  await reject('create_installation_schedule_atomic', {
    ...baseSched,
    p_crew: ['   '],
  }, 'INVALID_INPUT: Tên thành viên đội thợ không được để trống.');
 });

 await t.test('concurrent scheduling with differing payloads: exactly one wins, losers fail closed', async () => {
  const { o: raceOrder } = await ready();
  const payloadA = {
    p_company_id: c,
    p_order_id: raceOrder,
    p_actor_id: boss,
    p_technician_id: tech,
    p_start_time: '2026-10-16T08:00:00Z',
    p_address: 'Race Address A',
    p_crew: ['Crew A'],
  };
  const payloadB = {
    p_company_id: c,
    p_order_id: raceOrder,
    p_actor_id: boss,
    p_technician_id: tech2,
    p_start_time: '2026-10-16T14:00:00Z',
    p_address: 'Race Address B',
    p_crew: ['Crew B'],
  };

  const calls = [
    ...Array.from({ length: 5 }, () => admin.rpc('create_installation_schedule_atomic', payloadA)),
    ...Array.from({ length: 5 }, () => admin.rpc('create_installation_schedule_atomic', payloadB)),
  ];

  const results = await Promise.all(calls);
  const successes = results.filter((r) => !r.error);
  const failures = results.filter((r) => r.error);

  assert.equal(successes.length, 5, 'Exactly 5 calls with winning payload succeed');
  assert.equal(failures.length, 5, 'Exactly 5 calls with losing payload fail closed');

  for (const failure of failures) {
    assert.equal(failure.error?.message, 'INSTALLATION_SCHEDULE_ALREADY_EXISTS_WITH_DIFFERENT_PAYLOAD');
  }

  // Exactly 1 installation and 1 appointment in DB
  assert.equal(sql(`SELECT count(*) FROM public.installations WHERE order_id=${q(raceOrder)}`), '1');
  assert.equal(sql(`SELECT count(*) FROM public.appointments WHERE company_id=${q(c)} AND address IN ('Race Address A', 'Race Address B')`), '1');

  // Verify DB state matches winning payload
  const winningAppt = sql(`SELECT address FROM public.appointments WHERE company_id=${q(c)} AND address IN ('Race Address A', 'Race Address B')`);
  if (winningAppt === 'Race Address A') {
    assert.equal(successes.every((s) => s.data?.appointment?.address === 'Race Address A'), true);
  } else {
    assert.equal(successes.every((s) => s.data?.appointment?.address === 'Race Address B'), true);
  }
 });

 await t.test('evidence attachment and progress mutation require ACCEPTED or IN_PROGRESS appointment', async () => {
  const { o: assignedOrder } = await ready();
  const assignedSched = await rpc('create_installation_schedule_atomic', {
    p_company_id: c,
    p_order_id: assignedOrder,
    p_actor_id: boss,
    p_technician_id: tech,
    p_start_time: '2026-10-18T08:00:00Z',
    p_address: 'Assigned Test Address',
    p_crew: ['Crew 1'],
  });
  const unacceptedInstId = assignedSched.installation.id;
  const unacceptedApptId = assignedSched.appointment.id;

  // Appointment is in ASSIGNED state
  assert.equal(sql(`SELECT status FROM public.appointments WHERE id=${q(unacceptedApptId)}`), 'ASSIGNED');

  // Mutation of progress while ASSIGNED fails
  await reject('mutate_installation_atomic', {
    p_company_id: c,
    p_installation_id: unacceptedInstId,
    p_actor_id: tech,
    p_status: 'IN_TRANSIT',
  }, 'INVALID_STATE_TRANSITION');

  // Evidence upload while ASSIGNED fails at DB RPC
  const dummyEvidence = prepareEvidence(c, unacceptedInstId, 'PHOTO', new File([Buffer.from('test')],'test.png',{type:'image/png'}));
  await admin.storage.from('installation-docs').upload(dummyEvidence.path, Buffer.from('test'), { contentType: dummyEvidence.contentType });
  uploaded.push(dummyEvidence.path);

  await reject('mutate_installation_atomic', {
    p_company_id: c,
    p_installation_id: unacceptedInstId,
    p_actor_id: tech,
    p_ref: dummyEvidence.path,
    p_type: 'photo',
  }, 'INVALID_STATE_TRANSITION');

  // verifyTechnicianInstallationAssignment rejects ASSIGNED appointment
  await assert.rejects(
    () => verifyTechnicianInstallationAssignment(c, tech, unacceptedInstId, admin),
    /Bạn không được phân công hoặc chưa nhận công việc này/
  );

  // Technician accepts appointment (ASSIGNED -> ACCEPTED)
  await rpc('accept_installation_appointment_atomic', {
    p_company_id: c,
    p_appointment_id: unacceptedApptId,
    p_actor_id: tech,
  });
  assert.equal(sql(`SELECT status FROM public.appointments WHERE id=${q(unacceptedApptId)}`), 'ACCEPTED');

  // Now verifyTechnicianInstallationAssignment passes
  await verifyTechnicianInstallationAssignment(c, tech, unacceptedInstId, admin);

  // Now attach evidence succeeds
  await attachInstallationEvidence(c, {
    installationId: unacceptedInstId,
    fileKey: dummyEvidence.path,
    type: 'photo',
  }, admin, actor);

  const instPhotos = sql(`SELECT photos FROM public.installations WHERE id=${q(unacceptedInstId)}`);
  assert.ok(instPhotos.includes(dummyEvidence.path));
 });
 await t.test('atomic installation scheduling, concurrency and full negative test suite', async () => {
  const { o: readyOrder } = await ready();
  const schedInput = (orderId = readyOrder, techId = tech, actorId = boss, companyId = c) => ({
    p_company_id: companyId,
    p_order_id: orderId,
    p_actor_id: actorId,
    p_technician_id: techId,
    p_start_time: '2026-10-10T08:00:00Z',
    p_address: '456 Tran Phu, Q.5',
    p_crew: ['Thợ Chính', 'Thợ Phụ'],
  });

  // 1. SALE cannot schedule installation
  await reject('create_installation_schedule_atomic', schedInput(readyOrder, tech, sale), 'PERMISSION_DENIED');

  // 2. TECHNICIAN cannot schedule arbitrary installation
  await reject('create_installation_schedule_atomic', schedInput(readyOrder, tech, tech), 'PERMISSION_DENIED');

  // 3. Cross-company Order rejected
  await reject('create_installation_schedule_atomic', schedInput(randomUUID(), tech, boss), 'RESOURCE_NOT_FOUND');

  // 4. Cross-company Technician rejected
  await reject('create_installation_schedule_atomic', schedInput(readyOrder, randomUUID(), boss), 'PERMISSION_DENIED');

  // 5. Inactive Technician rejected
  sql(`UPDATE public.company_members SET status='INACTIVE' WHERE user_id=${q(tech2)} AND company_id=${q(c)}`);
  await reject('create_installation_schedule_atomic', schedInput(readyOrder, tech2, boss), 'PERMISSION_DENIED');
  sql(`UPDATE public.company_members SET status='ACTIVE' WHERE user_id=${q(tech2)} AND company_id=${q(c)}`);

  // 6. QC not PASSED rejected
  const unpassedOrder = order();
  const unpassedProd = await rpc('create_production_order_atomic', create(unpassedOrder));
  await rpc('update_production_progress_atomic', progress(unpassedProd.id, 'IN_PRODUCTION'));
  await reject('create_installation_schedule_atomic', schedInput(unpassedOrder, tech, boss), 'INVALID_STATE_TRANSITION');

  // 7. Order not READY_FOR_INSTALL rejected (e.g. order cancelled)
  const cancelledOrder = order();
  const cancelledProd = await rpc('create_production_order_atomic', create(cancelledOrder));
  await rpc('update_production_progress_atomic', progress(cancelledProd.id, 'IN_PRODUCTION'));
  await rpc('update_production_progress_atomic', progress(cancelledProd.id, 'QC_IN_PROGRESS'));
  await rpc('record_quality_check_atomic', qc(cancelledProd.id));
  sql(`UPDATE public.orders SET order_status='CANCELLED' WHERE id=${q(cancelledOrder)}`);
  await reject('create_installation_schedule_atomic', schedInput(cancelledOrder, tech, boss), 'INVALID_STATE_TRANSITION');

  // 8. SURVEY Appointment cannot be substituted / accepted
  const surveyApptId = appt('ASSIGNED', 'SURVEY');
  await reject('accept_installation_appointment_atomic', { p_company_id: c, p_appointment_id: surveyApptId, p_actor_id: tech }, 'INVALID_INPUT');

  // 14. Concurrent schedule requests produce exactly one Appointment + Installation
  const { o: concOrder } = await ready();
  const concCalls = await Promise.all(
    Array.from({ length: 10 }, () =>
      admin.rpc('create_installation_schedule_atomic', schedInput(concOrder, tech, boss))
    )
  );
  assert.equal(concCalls.filter((r) => !r.error).length, 10, 'All 10 calls succeed');
  assert.equal(sql(`SELECT count(*) FROM public.installations WHERE order_id=${q(concOrder)}`), '1', 'Exactly 1 installation created');
  assert.equal(sql(`SELECT count(*) FROM public.appointments WHERE company_id=${q(c)} AND type='INSTALLATION' AND address='456 Tran Phu, Q.5'`), '1', 'Exactly 1 appointment created');
  const idempotentCount = concCalls.filter((r) => r.data?.idempotent === true).length;
  assert.equal(idempotentCount, 9, '9 retries resolved idempotently');

  // Happy path scheduling for lifecycle test
  const schedResult = await rpc('create_installation_schedule_atomic', schedInput(readyOrder, tech, boss));
  assert.equal(schedResult.success, true);
  assert.equal(schedResult.idempotent, false);
  assert.equal(schedResult.appointment.status, 'ASSIGNED');
  assert.equal(schedResult.installation.status, 'SCHEDULED');
  assert.equal(sql(`SELECT count(*) FROM public.audit_logs WHERE resource_id=${q(schedResult.installation.id)} AND action='SCHEDULE_INSTALLATION'`), '1');

  // 9. Technician A cannot accept Technician B appointment
  const { o: techBOrder } = await ready();
  const schedB = await rpc('create_installation_schedule_atomic', schedInput(techBOrder, tech2, boss));
  await reject('accept_installation_appointment_atomic', { p_company_id: c, p_appointment_id: schedB.appointment.id, p_actor_id: tech }, 'PERMISSION_DENIED');

  // Boss cannot impersonate technician acceptance
  await reject('accept_installation_appointment_atomic', { p_company_id: c, p_appointment_id: schedB.appointment.id, p_actor_id: boss }, 'PERMISSION_DENIED');

  // 10. Technician A cannot mutate Technician B Installation
  await reject('mutate_installation_atomic', { p_company_id: c, p_installation_id: schedB.installation.id, p_actor_id: tech, p_status: 'IN_TRANSIT' }, 'PERMISSION_DENIED');

  // 11. Handover / mutation before ACCEPTED/IN_PROGRESS fails
  await reject('mutate_installation_atomic', { p_company_id: c, p_installation_id: schedResult.installation.id, p_actor_id: tech, p_status: 'IN_TRANSIT' }, 'INVALID_STATE_TRANSITION');

  // Technician accepts appointment (ASSIGNED -> ACCEPTED)
  const acceptRes = await rpc('accept_installation_appointment_atomic', { p_company_id: c, p_appointment_id: schedResult.appointment.id, p_actor_id: tech });
  assert.equal(acceptRes.success, true);
  assert.equal(acceptRes.idempotent, false);
  assert.equal(sql(`SELECT status FROM public.appointments WHERE id=${q(schedResult.appointment.id)}`), 'ACCEPTED');

  // Idempotent retry of accept returns idempotent: true
  const retryAccept = await rpc('accept_installation_appointment_atomic', { p_company_id: c, p_appointment_id: schedResult.appointment.id, p_actor_id: tech });
  assert.equal(retryAccept.idempotent, true);

  // Technician starts work (ACCEPTED -> IN_PROGRESS)
  const startRes = await rpc('start_installation_work_atomic', { p_company_id: c, p_installation_id: schedResult.installation.id, p_actor_id: tech });
  assert.equal(startRes.success, true);
  assert.equal(startRes.idempotent, false);
  assert.equal(sql(`SELECT status FROM public.appointments WHERE id=${q(schedResult.appointment.id)}`), 'IN_PROGRESS');

  // Idempotent start returns idempotent: true
  const retryStart = await rpc('start_installation_work_atomic', { p_company_id: c, p_installation_id: schedResult.installation.id, p_actor_id: tech });
  assert.equal(retryStart.idempotent, true);

  // Also verify mutating installation with ACCEPTED appointment automatically promotes to IN_PROGRESS
  await rpc('accept_installation_appointment_atomic', { p_company_id: c, p_appointment_id: schedB.appointment.id, p_actor_id: tech2 });
  assert.equal(sql(`SELECT status FROM public.appointments WHERE id=${q(schedB.appointment.id)}`), 'ACCEPTED');
  await rpc('mutate_installation_atomic', { p_company_id: c, p_installation_id: schedB.installation.id, p_actor_id: tech2, p_status: 'IN_TRANSIT' });
  assert.equal(sql(`SELECT status FROM public.appointments WHERE id=${q(schedB.appointment.id)}`), 'IN_PROGRESS');

  // Entering INSTALLING advances order_status from READY_FOR_INSTALL to INSTALLING
  assert.equal(sql(`SELECT order_status FROM public.orders WHERE id=${q(techBOrder)}`), 'READY_FOR_INSTALL');
  await rpc('mutate_installation_atomic', { p_company_id: c, p_installation_id: schedB.installation.id, p_actor_id: tech2, p_status: 'INSTALLING' });
  assert.equal(sql(`SELECT order_status FROM public.orders WHERE id=${q(techBOrder)}`), 'INSTALLING');
 });
 const fixture=await installation();
 const photo=prepareEvidence(c,fixture.i.id,'PHOTO',new File([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')],'test.png',{type:'image/png'}));
 const handover=prepareEvidence(c,fixture.i.id,'HANDOVER',new File(['%PDF-1.4\n%%EOF'],'test.pdf',{type:'application/pdf'}));
 await t.test('trusted Storage uploads work; anon/auth cannot upload, overwrite or delete',async()=>{
  const email=`operations-${randomUUID()}@example.test`,password=`Test-${randomUUID()}!`;
  const user=await admin.auth.admin.createUser({email,password,email_confirm:true});assert.equal(user.error,null);createdAuthUsers.push(user.data.user!.id);
  const auth=createClient(local.API_URL,local.ANON_KEY,{auth:{persistSession:false}});assert.equal((await auth.auth.signInWithPassword({email,password})).error,null);
  for(const evidence of [photo,handover]) {const content=evidence.type==='photo'?Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'):Buffer.from('%PDF-1.4\n%%EOF'); const result=await admin.storage.from('installation-docs').upload(evidence.path,content,{contentType:evidence.contentType});assert.equal(result.error,null,result.error?.message);uploaded.push(evidence.path);}
  for(const client of [anon,auth]) {
   assert.ok((await client.storage.from('installation-docs').upload(`${c}/unauthorized.png`,Buffer.from('x'),{contentType:'image/png'})).error);
   assert.ok((await client.storage.from('installation-docs').update(photo.path,Buffer.from('tampered'),{contentType:'image/png'})).error);
   await client.storage.from('installation-docs').remove([photo.path]);assert.equal((await admin.storage.from('installation-docs').info(photo.path)).error,null);
   assert.ok((await client.rpc('mutate_installation_atomic',{p_company_id:c,p_installation_id:fixture.i.id,p_actor_id:tech,p_ref:photo.path,p_type:'photo'})).error);
  }
 });
 await t.test('typed evidence attaches; photo cannot be reused as handover in helper or RPC',async()=>{
  await attachInstallationEvidence(c,{installationId:fixture.i.id,fileKey:photo.path,type:'photo'},admin,actor);
  await assert.rejects(()=>attachInstallationEvidence(c,{installationId:fixture.i.id,fileKey:photo.path,type:'handover'},admin,actor));
  await reject('mutate_installation_atomic',{p_company_id:c,p_installation_id:fixture.i.id,p_actor_id:tech,p_ref:photo.path,p_type:'handover'},'INVALID_STORAGE_REF');
  await attachInstallationEvidence(c,{installationId:fixture.i.id,fileKey:handover.path,type:'handover'},admin,actor);
 });
 await t.test('unassigned technician cannot operate installation or complete it',async()=>{
  await assert.rejects(()=>updateInstallationStatus(c,fixture.i.id,'INSTALLING',admin,{userId:tech2,role:'TECHNICIAN'}));
  await reject('complete_installation_atomic',{p_company_id:c,p_installation_id:fixture.i.id,p_actor_id:tech2,p_verified_photos:[photo.path],p_verified_handover:handover.path},'PERMISSION_DENIED');
 });
 await updateInstallationStatus(c,fixture.i.id,'INSTALLING',admin,actor);await updateInstallationStatus(c,fixture.i.id,'HANDOVER_PENDING',admin,actor);
 const completion={p_company_id:c,p_installation_id:fixture.i.id,p_actor_id:tech,p_verified_photos:[photo.path],p_verified_handover:handover.path};
 await t.test('completion enforces order and appointment states inside RPC',async()=>{
  for(const status of ['CANCELLED','COMPLETED','ASSIGNED']) {sql(`UPDATE public.appointments SET status=${q(status)} WHERE id=${q(fixture.a)}`);await reject('complete_installation_atomic',completion);}
  sql(`UPDATE public.appointments SET status='ACCEPTED' WHERE id=${q(fixture.a)}`);
  for(const status of ['CANCELLED','COMPLETED','DRAFT']) {sql(`UPDATE public.orders SET order_status=${q(status)} WHERE id=${q(fixture.o)}`);await reject('complete_installation_atomic',completion);assert.equal(sql(`SELECT order_status FROM public.orders WHERE id=${q(fixture.o)}`),status);}
  sql(`UPDATE public.orders SET order_status='READY_FOR_INSTALL' WHERE id=${q(fixture.o)}`);
 });
 await t.test('missing evidence, canonical refs and snapshot changes fail closed',async()=>{
  await reject('complete_installation_atomic',{...completion,p_verified_photos:[]},'EVIDENCE_CHANGED');
  sql(`UPDATE public.installations SET photos='[]' WHERE id=${q(fixture.i.id)}`);await reject('complete_installation_atomic',completion,'MISSING_EVIDENCE');
  sql(`UPDATE public.installations SET photos=${q(JSON.stringify([photo.path]))},handover_ref=${q(photo.path)} WHERE id=${q(fixture.i.id)}`);await reject('complete_installation_atomic',{...completion,p_verified_handover:photo.path},'INVALID_STORAGE_REF');
  sql(`UPDATE public.installations SET handover_ref=${q(handover.path)} WHERE id=${q(fixture.i.id)}`);
 });
 await t.test('missing Storage object blocks trusted completion',async()=>{
  const missing=`${c}/installations/${fixture.i.id}/photo/${randomUUID()}.png`;
  sql(`UPDATE public.installations SET photos=${q(JSON.stringify([missing]))} WHERE id=${q(fixture.i.id)}`);
  await assert.rejects(()=>completeInstallationAndHandover(c,{installationId:fixture.i.id},admin,actor),/Không tìm thấy tệp/);
  assert.equal(sql(`SELECT status FROM public.installations WHERE id=${q(fixture.i.id)}`),'HANDOVER_PENDING');
  sql(`UPDATE public.installations SET photos=${q(JSON.stringify([photo.path]))} WHERE id=${q(fixture.i.id)}`);
 });
 await t.test('completion retries are idempotent with one audit and durable outbox record',async()=>{
  await Promise.all([completeInstallationAndHandover(c,{installationId:fixture.i.id},admin,actor),completeInstallationAndHandover(c,{installationId:fixture.i.id},admin,actor)]);
  await completeInstallationAndHandover(c,{installationId:fixture.i.id},admin,actor);
  assert.equal(sql(`SELECT order_status FROM public.orders WHERE id=${q(fixture.o)}`),'COMPLETED');
  assert.equal(sql(`SELECT status FROM public.installations WHERE id=${q(fixture.i.id)}`),'COMPLETED');
  assert.equal(sql(`SELECT status FROM public.appointments WHERE id=${q(fixture.a)}`),'COMPLETED');
  assert.equal(sql(`SELECT count(*) FROM public.audit_logs WHERE resource_id=${q(fixture.i.id)} AND action='COMPLETE_INSTALLATION_AND_HANDOVER'`),'1');
  assert.equal(sql(`SELECT count(*) FROM public.operations_outbox WHERE order_id=${q(fixture.o)} AND event_type='ORDER_COMPLETED'`),'1');
 });
 const ticket=randomUUID();sql(`INSERT INTO public.warranty_tickets(id,company_id,customer_id,order_id,installation_id,issue,status) VALUES(${q(ticket)},${q(c)},${q(customer)},${q(fixture.o)},${q(fixture.i.id)},'Test only','OPEN')`);
 const warranty=(operation: string,status?: string,user= boss,role='BOSS_ADMIN')=>({p_company_id:c,p_ticket_id:ticket,p_actor_id:user,p_actor_role:role,p_operation:operation,p_status:status,p_technician_id:tech,p_notes:'Test reason'});
 await t.test('warranty assignment verifies ACTIVE technician and lifecycle',async()=>{
  sql(`UPDATE public.company_members SET status='INACTIVE' WHERE user_id=${q(tech2)} AND company_id=${q(c)}`);
  await reject('update_warranty_status_atomic',{...warranty('assign'),p_technician_id:tech2},'PERMISSION_DENIED');
  sql(`UPDATE public.company_members SET status='ACTIVE' WHERE user_id=${q(tech2)} AND company_id=${q(c)}`);
  await reject('update_warranty_status_atomic',{...warranty('assign'),p_technician_id:boss},'PERMISSION_DENIED');
  await rpc('update_warranty_status_atomic',warranty('assign'));
 });
 await t.test('locked reassignment race rejects former assignee after waiting',async()=>{
  // Advisory lock is only a test barrier: wait until the other session owns the row.
  const lockId=710000+Math.floor(Math.random()*100000);
  const reassign=concurrent(`BEGIN; SELECT id FROM public.warranty_tickets WHERE id=${q(ticket)} FOR UPDATE; SELECT pg_advisory_xact_lock(${lockId}); SELECT pg_sleep(1); SET LOCAL ROLE service_role; SELECT public.update_warranty_status_atomic(${q(c)},${q(ticket)},${q(boss)},'BOSS_ADMIN','assign',NULL,${q(tech2)},NULL); COMMIT;`);
  const deadline=Date.now()+5000;
  while(sql(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=${lockId})`)!=='t'){assert.ok(Date.now()<deadline,'barrier timeout');await new Promise(r=>setTimeout(r,30));}
  await reject('update_warranty_status_atomic',warranty('update','IN_PROGRESS',tech,'TECHNICIAN'),'PERMISSION_DENIED');await reassign;
  assert.equal(sql(`SELECT assigned_to FROM public.warranty_tickets WHERE id=${q(ticket)}`),tech2);
 });
 await t.test('warranty invalid transitions and cross-tenant access reject',async()=>{
  await reject('update_warranty_status_atomic',warranty('update','CLOSED'));
  await reject('update_warranty_status_atomic',warranty('update','REOPENED'));
  await reject('update_warranty_status_atomic',{...warranty('update','IN_PROGRESS'),p_company_id:other},'RESOURCE_NOT_FOUND');
  await rpc('update_warranty_status_atomic',warranty('update','IN_PROGRESS',tech2,'TECHNICIAN'));
 });
 await t.test('resolved timestamp survives close; reopen clears; next resolve sets new timestamp',async()=>{
  await rpc('update_warranty_status_atomic',warranty('update','RESOLVED',tech2,'TECHNICIAN'));
  const resolved=sql(`SELECT resolved_at FROM public.warranty_tickets WHERE id=${q(ticket)}`);
  await reject('update_warranty_status_atomic',warranty('assign'));
  await rpc('update_warranty_status_atomic',warranty('update','CLOSED'));assert.equal(sql(`SELECT resolved_at FROM public.warranty_tickets WHERE id=${q(ticket)}`),resolved);
  await rpc('update_warranty_status_atomic',warranty('reopen'));assert.equal(sql(`SELECT resolved_at IS NULL FROM public.warranty_tickets WHERE id=${q(ticket)}`),'t');
  await rpc('update_warranty_status_atomic',warranty('assign'));await rpc('update_warranty_status_atomic',warranty('update','IN_PROGRESS',tech,'TECHNICIAN'));await rpc('update_warranty_status_atomic',warranty('update','RESOLVED',tech,'TECHNICIAN'));assert.notEqual(sql(`SELECT resolved_at FROM public.warranty_tickets WHERE id=${q(ticket)}`),resolved);
 });
 } finally {
  if(uploaded.length)await admin.storage.from('installation-docs').remove(uploaded);
  for(const table of ['operations_outbox','warranty_tickets','installations','production_orders','contracts','orders','appointments','price_calculations','pricing_policies','customers','company_members','companies']) {
   try { sql(`DELETE FROM public.${table} WHERE company_id IN (${q(c)},${q(other)}) OR id IN (${q(c)},${q(other)})`); } catch {}
  }
  for(const uid of createdAuthUsers) {
   try { await admin.auth.admin.deleteUser(uid); } catch {}
   try { sql(`DELETE FROM public.user_profiles WHERE id=${q(uid)}; DELETE FROM auth.users WHERE id=${q(uid)};`); } catch {}
  }
 }
});
