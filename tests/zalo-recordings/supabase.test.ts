import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { reconcileAuthUserFixture } from '../helpers/auth-fixture';
import { cleanupCompanyFixtures, executeRawSql } from '../helpers/fixture-cleanup';
import { uploadRecording, RECORDING_BUCKET } from '../../features/zalo-recordings/upload';
import { sha256 } from '../../features/zalo-recordings/metadata';
import { audioFixture, metadataFixture, uploadRequest } from './fixture';

// Local-only integration harness. Never reads the application's production .env file.
const url=process.env.ZALO_RECORDING_TEST_URL || 'http://127.0.0.1:54321';
if(!['127.0.0.1','localhost'].includes(new URL(url).hostname)) throw new Error('Local Supabase required');
const service=process.env.ZALO_RECORDING_TEST_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const anon=process.env.ZALO_RECORDING_TEST_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});

async function main() {
  if(process.env.ZALO_RECORDING_CLEANUP_FIXTURE==='1') {
    const fixture=JSON.parse(readFileSync('/tmp/zalo-recording-ui-fixture.json','utf8'));
    await admin.storage.from(RECORDING_BUCKET).remove(fixture.paths);
    cleanupCompanyFixtures([fixture.company,fixture.other],{deleteMembers:true,deleteCompany:true});
    for(const user of fixture.users) {await admin.from('user_profiles').delete().eq('id',user);await admin.auth.admin.deleteUser(user);}
    unlinkSync('/tmp/zalo-recording-ui-fixture.json');console.log('Local browser QA fixture removed.');return;
  }
  const company=randomUUID(),other=randomUUID(),device=randomUUID(),secret=randomBytes(32).toString('base64url'),audio=audioFixture();
  const users:string[]=[],paths:string[]=[];
  let passed=false,saleEmail='';
  const password=randomBytes(24).toString('base64url')+'Aa1!';
  try {
    const {error}=await admin.from('companies').insert([{id:company,name:'Zalo recording acceptance fixture'},{id:other,name:'Zalo isolation fixture'}]);assert.ifError(error);
    const makeUser=async(role:'SALE'|'BOSS_ADMIN'|'TECHNICIAN',tenant=company)=>{
      const email=`zalo-recording-${randomUUID()}@example.test`;
      const id=await reconcileAuthUserFixture(admin,{email,password,fullName:'Recording test actor',companyId:tenant,role});users.push(id);
      const client=createClient(url,anon,{auth:{persistSession:false,autoRefreshToken:false}});
      const {error}=await client.auth.signInWithPassword({email,password});assert.ifError(error);return {id,client,email};
    };
    const boss=await makeUser('BOSS_ADMIN'),sale=await makeUser('SALE'),foreignSale=await makeUser('SALE',other),tech=await makeUser('TECHNICIAN');
    saleEmail=sale.email;
    assert.ifError((await admin.rpc('zalo_manage_device',{p_company:company,p_actor:boss.id,p_device:device,p_name:'Integration Mac',p_hash:sha256(secret),p_staff:sale.id})).error);
    const {data:customer,error:customerError}=await admin.from('customers').insert({company_id:company,name:'Lương Thắng',source:'ZALO',stage:'LEAD_NEW'}).select('id').single();assert.ifError(customerError);
    const meta=metadataFixture(device);
    const origin=process.env.ZALO_RECORDING_HTTP_ORIGIN;
    if(origin && !['localhost','127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Local HTTP origin required');
    const upload=async(m=meta,bytes=audio)=>{
      if(!origin) return uploadRecording(uploadRequest(m,bytes,secret),admin);
      const send=()=>fetch(new Request(origin+'/api/voice/zalo-personal/recordings',uploadRequest(m,bytes,secret)));
      // The native queue also retries transient transport failures with the stable session UUID.
      const response=await send().catch(()=>send());
      const result=await response.json();if(!response.ok) throw new Error(result.error);return result;
    };
    const a=await upload();assert.equal(a.duplicate,false);
    const get=async(id:string)=>{const {data,error}=await admin.from('zalo_personal_calls').select('*').eq('id',id).single();assert.ifError(error);return data!;};
    const first=await get(a.call_id);paths.push(first.recording_path);
    assert.equal(first.customer_id,null);assert.equal(first.recording_status,'READY');assert.equal(first.staff_user_id,sale.id);
    const bucket=admin.storage.from(RECORDING_BUCKET);
    const downloaded=await bucket.download(first.recording_path);assert.ifError(downloaded.error);
    assert.equal(sha256(Buffer.from(await downloaded.data!.arrayBuffer())),sha256(audio));
    const signed=await bucket.createSignedUrl(first.recording_path,60);assert.ifError(signed.error);
    const playback=await fetch(signed.data!.signedUrl);assert.equal(playback.status,200);assert.equal(sha256(Buffer.from(await playback.arrayBuffer())),sha256(audio));
    assert.notEqual((await fetch(`${url}/storage/v1/object/public/${RECORDING_BUCKET}/${first.recording_path}`)).status,200);
    assert.ok((await sale.client.storage.from(RECORDING_BUCKET).download(first.recording_path)).error);
    assert.ok((await sale.client.from('zalo_recording_devices').select('device_key_hash')).error);
    assert.ok((await sale.client.from('zalo_personal_calls').select('recording_path')).error);
    const seen=await sale.client.from('zalo_personal_calls').select('id').eq('id',a.call_id);assert.ifError(seen.error);assert.equal(seen.data!.length,1);
    for(const client of [foreignSale.client,tech.client]) {const r=await client.from('zalo_personal_calls').select('id').eq('id',a.call_id);assert.ifError(r.error);assert.equal(r.data!.length,0);}
    assert.ok((await sale.client.rpc('zalo_link_customer',{p_company:company,p_actor:sale.id,p_call:a.call_id,p_customer:customer!.id,p_remember:true})).error);
    const link=(call:string,c=customer!.id)=>admin.rpc('zalo_link_customer',{p_company:company,p_actor:sale.id,p_call:call,p_customer:c,p_remember:true});
    assert.ifError((await link(a.call_id)).error);
    assert.equal((await get(a.call_id)).customer_id,customer!.id);
    const b=await upload(metadataFixture(device));const second=await get(b.call_id);paths.push(second.recording_path);assert.equal(second.customer_id,customer!.id);
    const duplicate=await upload();assert.equal(duplicate.duplicate,true);assert.equal(duplicate.call_id,a.call_id);
    const {count}=await admin.from('zalo_personal_calls').select('id',{head:true,count:'exact'}).eq('company_id',company);assert.equal(count,2);
    const {error:sameName}=await admin.from('customers').insert({company_id:company,name:'Lương Thắng',source:'MANUAL',stage:'LEAD_NEW'});assert.ifError(sameName);
    const d=await upload(metadataFixture(device));const third=await get(d.call_id);paths.push(third.recording_path);assert.equal(third.customer_id,null);assert.equal(third.identity_ambiguous,true);
    // Actual multi-connection reservation race: only one lease holder may upload.
    const raceMeta=metadataFixture(device,'Race test');
    const params={p_device:device,p_key_hash:sha256(secret),p_metadata:raceMeta,p_checksum:sha256(audio),p_bytes:audio.length,p_fingerprint:sha256(JSON.stringify(raceMeta))};
    const races=await Promise.all(Array.from({length:4},()=>admin.rpc('zalo_reserve_recording',params)));
    races.forEach(r=>assert.ifError(r.error));assert.equal(races.filter(r=>r.data.lease).length,1);assert.equal(races.filter(r=>r.data.in_progress).length,3);
    const lease=races.find(r=>r.data.lease)!.data;
    // Simulate process death after object storage, before finalization. Expired lease recovers object without another upload.
    assert.ifError((await bucket.upload(lease.path,audio,{contentType:'audio/mp4',upsert:false})).error);paths.push(lease.path);
    executeRawSql(`UPDATE public.zalo_personal_calls SET upload_lease_until=now()-interval '1 second' WHERE id='${lease.call_id}';`);
    const recovered=await upload(raceMeta);assert.equal(recovered.call_id,lease.call_id);assert.equal((await get(lease.call_id)).recording_status,'READY');
    assert.ok((await admin.rpc('zalo_finish_recording',{p_device:device,p_key_hash:sha256(secret),p_call:lease.call_id,p_lease:lease.lease})).error);
    if(origin) {
      // Confirm the API route does not inherit the separate 12 MiB Server Action/proxy envelope.
      const padding=Buffer.alloc(13*1024*1024);padding.writeUInt32BE(padding.length,0);padding.write('free',4,'ascii');
      const large=await upload(metadataFixture(device,'Large transport fixture'),Buffer.concat([audio,padding]));
      paths.push((await get(large.call_id)).recording_path);
      assert.equal((await fetch(origin+'/api/voice/zalo-personal/recordings',{method:'POST'})).status,401);
      console.log('PASS actual HTTP route: authenticated upload, 13 MiB multipart transport, duplicate replay and unauthenticated 401.');
    }
    assert.ifError((await admin.rpc('zalo_manage_device',{p_company:company,p_actor:boss.id,p_device:device,p_name:'',p_hash:'',p_revoke:true})).error);
    await assert.rejects(uploadRecording(uploadRequest(metadataFixture(device),audio,secret),admin),/DEVICE_UNAUTHORIZED/);
    if(origin) {
      const denied=await fetch(origin+'/api/voice/zalo-personal/recordings',{method:'POST',headers:{'x-zalo-device-id':device,authorization:`Bearer ${secret}`}});
      assert.equal(denied.status,401);
    }
    console.log('PASS real Supabase: A unmatched -> manually confirmed mapping; B auto matched; C duplicate suppressed; D ambiguity protected; private signed playback; checksum; SALE/TECH/cross-tenant RLS; RPC ACL; multi-connection lease race; interrupted upload recovery; revocation. Synthetic audio, not a live Zalo call.');
    passed=true;
  } finally {
    // Include any reserved objects if an assertion failed before its path was recorded.
    const {data}=await admin.from('zalo_personal_calls').select('recording_path').eq('company_id',company);
    const allPaths=[...new Set([...paths,...(data || []).map(row=>row.recording_path)])];
    if(passed && process.env.ZALO_RECORDING_KEEP_FIXTURE==='1') {
      writeFileSync('/tmp/zalo-recording-ui-fixture.json',JSON.stringify({company,other,users,paths:allPaths,saleEmail,password}),{mode:0o600});
      console.log('Controlled local fixture retained for browser QA; credentials are not logged.');
    } else {
      if(allPaths.length) await admin.storage.from(RECORDING_BUCKET).remove(allPaths);
      cleanupCompanyFixtures([company,other],{deleteMembers:true,deleteCompany:true});
      for(const user of users) {await admin.from('user_profiles').delete().eq('id',user);await admin.auth.admin.deleteUser(user);}
    }
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
