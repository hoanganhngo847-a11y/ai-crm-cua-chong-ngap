import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createPgliteSupabase } from '../zalo/helpers/pglite-supabase';
import { normalizeDisplayName, suggestionName, validateM4a, validateMetadata, sha256 } from '../../features/zalo-recordings/metadata';
import { uploadRecording } from '../../features/zalo-recordings/upload';
import { audioFixture, metadataFixture, uploadRequest } from './fixture';

async function main() {
  const audio=audioFixture(),device=randomUUID(),secret='a'.repeat(43),meta=metadataFixture(device);
  assert.equal(normalizeDisplayName('  Lương   Thắng '),'lương thắng');
  assert.equal(normalizeDisplayName('Lương Thắng'),normalizeDisplayName('Lương Thắng'));
  assert.equal(suggestionName('Lương Thắng'),'luong thang');
  validateM4a(audio,2);validateMetadata(meta,device);
  for(const patch of [{company_id:randomUUID()},{staff_id:randomUUID()},{remote_display_name:'Zalo Call'},{remote_identity_type:'UID'},{direction:'GUESSED'},
    {duration_seconds:NaN},{duration_seconds:9000},{ended_at:'2099-01-01T00:00:00Z'},{answered_at:'2020-01-01T00:00:00Z'},{recording_file:'../../file.m4a'},{phone_if_visible:'0912345678'},
    {audio_validation:{remote_non_silent:'true',local_non_silent:true}}]) assert.throws(()=>validateMetadata({...meta,...patch},device));
  assert.throws(()=>validateM4a(Buffer.from('not audio'),2));assert.throws(()=>validateM4a(audio,100));
  const h=await createPgliteSupabase(),db=h.db;
  const company=randomUUID(),other=randomUUID(),boss=randomUUID(),sale=randomUUID(),sale2=randomUUID(),tech=randomUUID(),customer=randomUUID(),foreign=randomUUID();
  try {
    await db.query(`INSERT INTO companies(id,name) VALUES($1,'Zalo fixture'),($2,'Other')`,[company,other]);
    for(const [id,role] of [[boss,'BOSS_ADMIN'],[sale,'SALE'],[sale2,'SALE'],[tech,'TECHNICIAN']]) {
      await db.query('INSERT INTO auth.users(id) VALUES($1)',[id]);
      await db.query(`INSERT INTO user_profiles(id,full_name) VALUES($1,'Fixture') ON CONFLICT(id) DO NOTHING`,[id]);
      // Foundation allows one ACTIVE Sale; use boss for second staff access denial fixture.
      await db.query(`INSERT INTO company_members(company_id,user_id,role,status) VALUES($1,$2,$3,'ACTIVE')`,[company,id,role==='SALE' && id===sale2?'BOSS_ADMIN':role]);
    }
    await db.query(`INSERT INTO customers(id,company_id,name,source,stage) VALUES($1,$2,'Lương Thắng','ZALO','LEAD_NEW'),($3,$4,'Lương Thắng','MANUAL','LEAD_NEW')`,[customer,company,foreign,other]);
    const managed=await h.client.rpc('zalo_manage_device',{p_company:company,p_actor:boss,p_device:device,p_name:'Fixture Mac',p_hash:sha256(secret),p_staff:sale});
    assert.ifError(managed.error);
    const objects=new Map<string,Buffer>();let writes=0;
    const admin=Object.assign(h.client,{storage:{from:()=>({
      upload:async(path:string,body:Buffer)=>{if(objects.has(path)) return {error:{message:'exists'}};objects.set(path,body);writes++;
        await db.query(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('zalo-call-recordings',$1,$2)`,[path,JSON.stringify({size:body.length})]);return {error:null};},
      download:async(path:string)=>({data:objects.has(path)?new Blob([new Uint8Array(objects.get(path)!)]):null,error:null})
    })}}) as unknown as SupabaseClient;
    const upload=(m=meta,token=secret)=>uploadRecording(uploadRequest(m,audio,token),admin);
    await assert.rejects(upload(meta,'b'.repeat(43)),/DEVICE_UNAUTHORIZED/);
    const a=await upload();assert.equal(a.duplicate,false);
    const row=()=>db.query<Record<string,unknown>>('SELECT * FROM zalo_personal_calls WHERE id=$1',[a.call_id]).then(r=>r.rows[0]);
    assert.equal((await row()).customer_id,null);assert.equal((await row()).matching_status,'SUGGESTED');assert.equal((await row()).staff_user_id,sale);
    assert.equal((await row()).channel,'ZALO_PERSONAL');assert.equal((await row()).source,'LOCAL_AGENT');
    assert.equal((await row()).recording_sha256,sha256(audio));
    const duplicate=await upload();assert.equal(duplicate.duplicate,true);assert.equal(duplicate.call_id,a.call_id);assert.equal(writes,1);
    await assert.rejects(upload({...meta,direction:'OUTBOUND'}),/IDEMPOTENCY_CONFLICT/);
    const link=(call:string,selected:string|null=customer,remember=true,newName:string|null=null,actor=sale)=>h.client.rpc('zalo_link_customer',{p_company:company,p_actor:actor,p_call:call,p_customer:selected,p_remember:remember,p_new_name:newName});
    assert.ok((await link(a.call_id,foreign)).error);assert.ok((await link(a.call_id,customer,true,null,tech)).error);
    assert.ifError((await link(a.call_id)).error);
    assert.equal((await row()).customer_id,customer);
    const b=await upload(metadataFixture(device));
    assert.equal((await db.query<{customer_id:string}>('SELECT customer_id FROM zalo_personal_calls WHERE id=$1',[b.call_id])).rows[0].customer_id,customer);
    // New same-name CRM customer makes the next call require confirmation despite one saved mapping.
    const secondCustomer=randomUUID();await db.query(`INSERT INTO customers(id,company_id,name,source,stage) VALUES($1,$2,'Lương Thắng','ZALO','LEAD_NEW')`,[secondCustomer,company]);
    const d=await upload(metadataFixture(device));
    const ambiguous=(await db.query<Record<string,unknown>>('SELECT customer_id,identity_ambiguous FROM zalo_personal_calls WHERE id=$1',[d.call_id])).rows[0];
    assert.equal(ambiguous.customer_id,null);assert.equal(ambiguous.identity_ambiguous,true);
    assert.ifError((await link(d.call_id,secondCustomer)).error);
    assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM zalo_customer_identity_mappings WHERE needs_confirmation')).rows[0].n,2);
    const next=await upload(metadataFixture(device));assert.equal((await db.query<{customer_id:null}>('SELECT customer_id FROM zalo_personal_calls WHERE id=$1',[next.call_id])).rows[0].customer_id,null);
    const unknown=await upload(metadataFixture(device,null));
    const created=await link(unknown.call_id,null,false,'New no-phone customer');assert.ifError(created.error);
    const retried=await link(unknown.call_id,null,false,'New no-phone customer');assert.equal(retried.data.customer_id,created.data.customer_id);
    assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM private.customer_private_contacts WHERE customer_id=$1',[created.data.customer_id])).rows[0].n,0);
    // Audit failure rolls back customer creation + call attachment atomically.
    const before=(await db.query<{n:number}>('SELECT count(*)::int n FROM customers')).rows[0].n;
    const failure=await upload(metadataFixture(device,'Atomic failure'));
    await db.exec(`CREATE FUNCTION pg_temp.fail_zalo_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'INJECTED'; END $$;
      CREATE TRIGGER fail_zalo_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_zalo_audit();`);
    assert.ok((await link(failure.call_id,null,true,'Atomic failure')).error);
    await db.exec('DROP TRIGGER fail_zalo_audit ON audit_logs');
    assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM customers')).rows[0].n,before);
    // RLS and ACL tests use real PostgreSQL roles, not application mocks.
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${sale}',false);`);
    assert.ok((await db.query('SELECT id FROM zalo_personal_calls')).rows.length>0);
    await assert.rejects(db.query('SELECT device_key_hash FROM zalo_recording_devices'));
    await assert.rejects(db.query('SELECT recording_path FROM zalo_personal_calls'));
    await assert.rejects(db.query(`SELECT zalo_link_customer($1,$2,$3,$4,null,true)`,[company,sale,a.call_id,customer]));
    await db.exec(`SELECT set_config('request.jwt.claim.sub','${tech}',false);`);
    assert.equal((await db.query('SELECT id FROM zalo_personal_calls')).rows.length,0);
    await db.exec('RESET ROLE');
    await db.query('UPDATE zalo_recording_devices SET active=false WHERE id=$1',[device]);
    await assert.rejects(upload(metadataFixture(device)),/DEVICE_UNAUTHORIZED/);
    assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM voice_media_jobs')).rows[0].n,0);
    assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM calls')).rows[0].n,0);
    console.log('PASS: metadata/container, unknown caller, suggestions, manual mapping, second-call auto match, duplicate upload, conflicting names, no-phone creation, atomic audit rollback, RLS/ACL, revocation, no Stringee/AI jobs');
  } finally {await h.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
