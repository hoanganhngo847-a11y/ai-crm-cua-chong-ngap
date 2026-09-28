import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { prepareEvidence, isValidCanonicalInstallationStorageRef, EVIDENCE_MAX_BYTES } from '../../features/installation/evidence';
import { sanitizeErrorMessage, operationsRpc, type OperationsClient } from '../../features/operations/server';
import { AuthError } from '../../lib/auth/context';
import { createProductionOrderAction } from '../../features/production/actions';
import { scheduleInstallationAction } from '../../features/installation/actions';
import { assignWarrantyTicketAction } from '../../features/warranty/actions';
const company=randomUUID(), installation=randomUUID();
test('photo formats are allowlisted and paths generated with evidence type', () => {
 for(const [mime,ext] of [['image/jpeg','jpeg'],['image/png','png'],['image/webp','webp']]) {
  const result=prepareEvidence(company,installation,'PHOTO',new File(['test'],`test.${ext}`,{type:mime}));
  assert.equal(result.type,'photo');
  assert.ok(isValidCanonicalInstallationStorageRef(company,installation,result.path,'photo'));
  assert.equal(isValidCanonicalInstallationStorageRef(company,installation,result.path,'handover'),false);
 }
});
test('handover requires PDF, photo cannot become handover', () => {
 assert.throws(()=>prepareEvidence(company,installation,'HANDOVER',new File(['x'],'x.jpg',{type:'image/jpeg'})));
 const result=prepareEvidence(company,installation,'HANDOVER',new File(['%PDF-1.4'],'x.pdf',{type:'application/pdf'}));
 assert.ok(isValidCanonicalInstallationStorageRef(company,installation,result.path,'handover'));
});
test('MIME and extension must both match type', () => {
 for(const [name,mime] of [['x.html','image/jpeg'],['x.exe','image/jpeg'],['x.js','image/png'],['x.pdf','application/pdf'],['x.jpg','text/html'],['x.png','image/jpeg']])
  assert.throws(()=>prepareEvidence(company,installation,'PHOTO',new File(['x'],name,{type:mime})));
});
test('empty, oversized, malformed UUID and missing file reject', () => {
 for(const file of [new File([],'x.jpg',{type:'image/jpeg'}),new File([new Uint8Array(EVIDENCE_MAX_BYTES+1)],'x.jpg',{type:'image/jpeg'})]) assert.throws(()=>prepareEvidence(company,installation,'photo',file));
 assert.throws(()=>prepareEvidence(company,'bad','photo',new File(['x'],'x.jpg',{type:'image/jpeg'})));
 assert.throws(()=>prepareEvidence(company,installation,'photo',null as unknown as File));
});
test('canonical validation rejects external URL, wrong tenant and traversal', () => {
 const path=prepareEvidence(company,installation,'photo',new File(['x'],'x.jpg',{type:'image/jpeg'})).path;
 for(const ref of [`https://other.supabase.co/${path}`,`installation-docs/${path}`,path.replace(company,randomUUID()),`${company}/installations/${installation}/photo/../handover/a.pdf`]) assert.equal(isValidCanonicalInstallationStorageRef(company,installation,ref),false);
});
test('error surface never reflects arbitrary DB/storage details', () => {
 for(const message of ['duplicate key violates unique constraint secret','service_role token=secret','storage internal detail','INVALID_STATE_TRANSITION: secret']) assert.equal(sanitizeErrorMessage(new Error(message),'safe'),'safe');
 assert.throws(()=>sanitizeErrorMessage(new AuthError('forbidden',403),'safe'),AuthError);
});
test('missing RPC fails closed without any table mutation', async () => {
 const client={rpc:async()=>({data:null,error:{code:'PGRST202',message:'missing function'}}),from:()=>assert.fail('fallback table mutation')} as unknown as OperationsClient;
 await assert.rejects(()=>operationsRpc(client,'create_production_order_atomic',{}),/Thao tác không thành công/);
});
test('UUID and datetime inputs reject before any authentication/database access', async () => {
 assert.equal((await createProductionOrderAction({orderId:'bad',deadline:'tomorrow',specs:{},materials:{}})).success,false);
 assert.equal((await createProductionOrderAction({orderId:randomUUID(),deadline:'2026-02-30',specs:{},materials:{}})).success,false);
 assert.equal((await scheduleInstallationAction({customerId:'bad',orderId:randomUUID(),appointmentId:randomUUID(),crew:['team']})).success,false);
 assert.equal((await assignWarrantyTicketAction({ticketId:randomUUID(),technicianId:'bad'})).success,false);
});
test('no public action accepts existing fileKey; no compensating rollback remains', () => {
 assert.doesNotMatch(readFileSync('features/installation/actions.ts','utf8'),/export async function attachInstallationEvidenceAction/);
 for(const file of ['features/production/production-service.ts','features/installation/installation-service.ts']) assert.doesNotMatch(readFileSync(file,'utf8'),/executeFallback|dispatchOrderCompletionEvent/);
});
