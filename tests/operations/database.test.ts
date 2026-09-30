import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { completeInstallationAndHandover, attachInstallationEvidence, updateInstallationStatus } from '../../features/installation/installation-service';
import { prepareEvidence } from '../../features/installation/evidence';
const container='supabase_db_ai-crm-cua-chong-ngap';
const sql=(query: string)=>execFileSync('docker',['exec','-i',container,'psql','-X','-qAt','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1'],{input:query,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const q=(v: unknown)=>`'${String(v).replaceAll("'","''")}'`;
const c=randomUUID(), other=randomUUID(), customer=randomUUID(), boss=randomUUID(), tech=randomUUID(), tech2=randomUUID(), policy=randomUUID(), price=randomUUID();
const actor={userId:tech,role:'TECHNICIAN'};
function concurrent(query: string) {
 return new Promise<string>((resolve,reject)=>{
  const child=spawn('docker',['exec','-i',container,'psql','-X','-qAt','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1']);
  let out='',err=''; child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',reject);child.on('close',code=>code===0?resolve(out.trim()):reject(new Error(err)));child.stdin.end(query);
 });
}
function order(status='CONTRACT_SIGNED',signed=true,signedRef: string|null=signed?'test-signed':null) {
 const id=randomUUID();
 sql(`INSERT INTO public.orders(id,company_id,customer_id,payment_reference,price_calculation_id,deposit_status,order_status,final_amount) VALUES(${q(id)},${q(c)},${q(customer)},${q(id)},${q(price)},'CONFIRMED',${q(status)},100);
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
 const installation=async()=>{const {o,p}=await ready();const a=appt();const i=await rpc('schedule_installation_atomic',schedule(o,a));return {o,p,a,i};};
 const uploaded: string[]=[];
 let authUser: string|undefined;
 try {
 sql(`INSERT INTO public.companies(id,name) VALUES(${q(c)},'Operations integration fixture'),(${q(other)},'Other test tenant');
 INSERT INTO public.customers(id,company_id,name,source,stage) VALUES(${q(customer)},${q(c)},'Test only','MANUAL','LEAD_NEW');
 INSERT INTO public.pricing_policies(id,company_id,version,conditions,price_rules,effective_at,status) VALUES(${q(policy)},${q(c)},'test','{"standard_materials": {"aluminum": "6063-T5"}}','{}',now(),'ACTIVE');
 INSERT INTO public.price_calculations(id,company_id,customer_id,pricing_policy_id,policy_version,input_data,amount,status) VALUES(${q(price)},${q(c)},${q(customer)},${q(policy)},'test','{"width": 2, "height": 1}',100,'CALCULATED');`);
 for(const [id,role] of [[boss,'BOSS_ADMIN'],[tech,'TECHNICIAN'],[tech2,'TECHNICIAN']]) sql(`INSERT INTO auth.users(id) VALUES(${q(id)}); INSERT INTO public.user_profiles(id,full_name,status) VALUES(${q(id)},'Test only','ACTIVE') ON CONFLICT(id) DO UPDATE SET status='ACTIVE'; INSERT INTO public.company_members(company_id,user_id,role,status) VALUES(${q(c)},${q(id)},${q(role)},'ACTIVE');`);
 await t.test('migration applied; bucket private, constrained and RPC grants restricted',async()=>{
  assert.equal(sql("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='20260928000001'"),'1');
  const {data,error}=await admin.storage.getBucket('installation-docs');assert.equal(error,null);assert.equal(data?.public,false);assert.equal(data?.file_size_limit,10485760);
  const funcs=JSON.parse(sql(`SELECT json_agg(json_build_object('name',proname,'safe',prosecdef AND proconfig @> ARRAY['search_path=""'],'anon',has_function_privilege('anon',oid,'execute'),'auth',has_function_privilege('authenticated',oid,'execute'),'service',has_function_privilege('service_role',oid,'execute'))) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('create_production_order_atomic','update_production_progress_atomic','record_quality_check_atomic','schedule_installation_atomic','mutate_installation_atomic','complete_installation_atomic','update_warranty_status_atomic')`));
  assert.equal(funcs.length,7);for(const f of funcs){assert.ok(f.safe,f.name);assert.equal(f.anon,false);assert.equal(f.auth,false);assert.equal(f.service,true);}
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
 await t.test('schedule valid lifecycle; cancelled/completed/rejected/wrong type appointments reject',async()=>{
  const {o}=await ready();for(const status of ['CANCELLED','COMPLETED','REJECTED','IN_PROGRESS'])await reject('schedule_installation_atomic',schedule(o,appt(status)));
  await reject('schedule_installation_atomic',schedule(o,appt('ACCEPTED','SURVEY')));
  const i=await rpc('schedule_installation_atomic',schedule(o,appt('ASSIGNED')));assert.equal(i.status,'SCHEDULED');
  const {o:cancelled}=await ready();sql(`UPDATE public.orders SET order_status='CANCELLED' WHERE id=${q(cancelled)}`);await reject('schedule_installation_atomic',schedule(cancelled,appt()));
 });
 const fixture=await installation();
 const photo=prepareEvidence(c,fixture.i.id,'PHOTO',new File([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')],'test.png',{type:'image/png'}));
 const handover=prepareEvidence(c,fixture.i.id,'HANDOVER',new File(['%PDF-1.4\n%%EOF'],'test.pdf',{type:'application/pdf'}));
 await t.test('trusted Storage uploads work; anon/auth cannot upload, overwrite or delete',async()=>{
  const email=`operations-${randomUUID()}@example.test`,password=`Test-${randomUUID()}!`;
  const user=await admin.auth.admin.createUser({email,password,email_confirm:true});assert.equal(user.error,null);authUser=user.data.user!.id;
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
  if(authUser)await admin.auth.admin.deleteUser(authUser);
  for(const table of ['operations_outbox','warranty_tickets','installations','production_orders','contracts','orders','appointments','price_calculations','pricing_policies','customers','company_members']) {
   try { sql(`DELETE FROM public.${table} WHERE company_id IN (${q(c)},${q(other)})`); } catch {}
  }
 }
});
