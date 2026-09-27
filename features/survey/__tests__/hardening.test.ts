import './setup';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { canAccessSurvey } from '../constants/access';
import { validateSurveyInput } from '../validations/survey.schema';
import type { CompleteSurveyInput } from '../types/survey';

const requireModule = createRequire(`${process.cwd()}/features/survey/__tests__/hardening.test.ts`);
const actor = { userId:'tech',companyId:'company',profileStatus:'ACTIVE',membershipStatus:'ACTIVE',role:'TECHNICIAN' };
const resource = { id:'appointment',company_id:'company',customer_id:'customer',assignee_id:'tech',status:'ACCEPTED',type:'SURVEY' };
const valid: CompleteSurveyInput = { appointmentId:'appointment', measurements: {
  clear_width_mm:2000,barrier_height_mm:600,anticipated_flood_height_mm:500,gate_type:'REMOVABLE_PANEL',mounting_method:'INSIDE_JAMB',
},siteCondition:{wall_material:'SOLID_BRICK',floor_material:'CONCRETE_SMOOTH',floor_evenness:'FLAT',slope_grade:'SLOPING_OUT'} };

function mockModule(id: string, exports: object) {
  const key = requireModule.resolve(id);
  requireModule.cache[key] = { id:key,filename:key,loaded:true,exports } as NodeModule;
}

test('Survey production authorization, actions, storage and UI regressions', async t => {
  let currentActor = {...actor}, appointment = {...resource};
  let storageCalls = 0, removeError = false, uploadError = false, signedPath = '', uploadedPath = '', ttl = 0;
  let existing = false, inconsistent = false;
  let assignedFilter: unknown;
  const client = {
    from: (table: string) => {
      assert.ok(['appointments','surveys'].includes(table));
      const query = {
        select: () => query, eq: (key: string, value: unknown) => { if (key==='assignee_id') assignedFilter=value; return query; },
        in: () => query, update: () => query,
        maybeSingle: async () => ({data:table==='appointments'?appointment:null,error:null}),
      }; return query;
    },
    rpc: async (name: string) => {
      if(name==='begin_survey_photo_operation') return {data:'opaque-guard',error:null};
      if(name==='end_survey_photo_operation') return {data:null,error:null};
      assert.equal(name,'complete_survey_atomic');
      return inconsistent ? {data:null,error:{code:'P0001'}} : {data:{id:'survey',isExisting:existing},error:null};
    },
    storage:{from:(bucket:string)=> {
      assert.equal(bucket,'survey-photos'); storageCalls++;
      return {
        list:async()=>({data:['OVERVIEW','BOTTOM_LEFT','BOTTOM_RIGHT'].map(slot=>({id:slot,name:`${slot}.jpg`,created_at:'2026-09-24'})),error:null}),
        remove:async(paths:string[])=>{assert.deepEqual(paths,['company/customer/appointment/OVERVIEW.jpg']);return {error:removeError?new Error('provider failure'):null};},
        upload:async(path:string,_buffer:unknown,options:{contentType:string;upsert:boolean})=>{
          uploadedPath=path;assert.equal(options.contentType,'image/png'); assert.equal(options.upsert,true);
          return {error:uploadError?new Error('provider failure'):null};
        },
        createSignedUrl:async(path:string,expires:number)=>{signedPath=path;ttl=expires;return {data:{signedUrl:'https://preview.test/image'},error:null};},
      };
    }},
  };
  mockModule('../../../lib/auth/context',{getActorContext:async(company:string)=>{assert.equal(company,appointment.company_id);return currentActor;}});
  mockModule('../../../lib/supabase/admin',{createAdminClient:()=>client});
  mockModule('next/cache',{revalidatePath:()=>{}});
  mockModule('next/navigation',{useRouter:()=>({push:()=>{}})});
  const actions=await import('../../../app/(dashboard)/surveys/actions');
  const storage=await import('../services/storage-upload.service');
  const { updateAppointment, cancelAppointment }=await import('../services/appointment.service');
  const { default:Detail, serializeSurveyDraft }=await import('../../../app/(dashboard)/surveys/[appointmentId]/SurveyMeasurementDetailClient');
  const { default:Site }=await import('../components/SiteConditionSelector');

  for(const status of ['ASSIGNED','ACCEPTED','IN_PROGRESS','COMPLETED','CANCELLED','REJECTED']) {
    await t.test(`TECH ${status}: current assignment controls reads and signed URL refresh`,async()=>{
      appointment={...resource,status}; currentActor={...actor}; storageCalls=0;
      const allowed=['ASSIGNED','ACCEPTED','IN_PROGRESS'].includes(status);
      assert.equal(canAccessSurvey(currentActor,appointment),allowed);
      const result=await actions.refreshPhotoSignedUrlAction('appointment','OVERVIEW');
      assert.equal(result.success,allowed);
      if(!allowed) assert.equal(storageCalls,0);
    });
  }
  for(const [label,changes] of Object.entries({otherAssignee:{userId:'other'},wrongCompany:{companyId:'other'},
    inactiveProfile:{profileStatus:'INACTIVE'},inactiveMember:{membershipStatus:'INACTIVE'},wrongRole:{role:'SALE'}})) {
    await t.test(`${label}: all resource operations denied before Storage`,async()=>{
      currentActor={...actor,...changes};appointment={...resource};storageCalls=0;
      assert.equal(canAccessSurvey(currentActor,appointment),false);
      assert.equal((await actions.refreshPhotoSignedUrlAction('appointment','OVERVIEW')).success,false);
      assert.equal((await actions.deleteSurveyPhotoAction('appointment','OVERVIEW')).success,false);
      assert.equal((await actions.completeSurveyAction(valid)).success,false);
      assert.equal(storageCalls,0);
    });
  }
  await t.test('Boss reads historical appointment; all terminal mutations denied including REJECTED',async()=>{
    currentActor={...actor,role:'BOSS_ADMIN'};
    for(const status of ['COMPLETED','CANCELLED','REJECTED']) {
      appointment={...resource,status};assert.equal(canAccessSurvey(currentActor,appointment),true);
      assert.equal((await actions.deleteSurveyPhotoAction('appointment','OVERVIEW')).success,false);
      assert.equal((await actions.acceptSurveyAppointmentAction('appointment')).success,false);
      assert.equal((await actions.startSurveyAppointmentAction('appointment')).success,false);
      assert.equal((await actions.cancelSurveyAppointmentAction('appointment')).success,false);
    }
    appointment={...resource};assert.equal((await actions.completeSurveyAction(valid)).success,false);
  });
  await t.test('Accept/start/cancel use current-assignee conditional writes',async()=>{
    currentActor={...actor};appointment={...resource,status:'ASSIGNED'};
    for(const fn of [actions.acceptSurveyAppointmentAction,actions.startSurveyAppointmentAction,actions.cancelSurveyAppointmentAction]) {
      assignedFilter=undefined;assert.equal((await fn('appointment')).success,true);assert.equal(assignedFilter,'tech');
    }
  });
  await t.test('Storage upload response has no canonical path; server owns path, MIME and TTL',async()=>{
    currentActor={...actor};appointment={...resource};
    const form=new FormData();form.set('appointmentId','appointment');form.set('photoSlot','OVERVIEW');
    form.set('objectPath','foreign/fake');form.set('bucket','other');form.set('expiresIn','999999');
    form.set('file',new File([new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])],'fake.jpg',{type:'text/plain'}));
    const response=await actions.uploadSurveyPhotoAction(form);
    assert.equal(response.success,true); assert.ok(!('objectPath' in response));
    assert.equal(uploadedPath,'company/customer/appointment/OVERVIEW.jpg');assert.equal(signedPath,uploadedPath);assert.equal(ttl,3600);
    uploadError=true;assert.equal((await actions.uploadSurveyPhotoAction(form)).success,false);uploadError=false;
  });
  await t.test('Delete failure is an action failure; success acknowledged only after remove',async()=>{
    removeError=true;assert.equal((await actions.deleteSurveyPhotoAction('appointment','OVERVIEW')).success,false);
    removeError=false;assert.equal((await actions.deleteSurveyPhotoAction('appointment','OVERVIEW')).success,true);
    const source=readFileSync('features/survey/components/PhotoCaptureGrid.tsx','utf8');
    assert.ok(source.indexOf('if (!res.success)',source.indexOf('const handleDeletePhoto')) < source.indexOf('delete nextPhotos'));
    assert.ok(!source.includes('objectPath'));
  });
  await t.test('Selectors reject traversal and arbitrary names',async()=>{
    for(const slot of ['../OVERVIEW','OVERVIEW/other','FRONTAGE','']) await assert.rejects(storage.getSurveyPhotoSignedUrl('appointment',slot));
  });
  await t.test('Generic update cannot set COMPLETED even with forged runtime input',async()=>{
    appointment={...resource};
    await assert.rejects(updateAppointment('appointment',{status:'COMPLETED'} as unknown as Parameters<typeof updateAppointment>[1],
      client as unknown as Parameters<typeof updateAppointment>[2]),/complete_survey_atomic/);
    appointment={...resource,status:'COMPLETED'};
    await assert.rejects(cancelAppointment('appointment','cancel',client as unknown as Parameters<typeof cancelAppointment>[2]),/hoàn thành/);
  });
  await t.test('Completion retry returns existing receipt without reopening read authorization',async()=>{
    appointment={...resource,status:'COMPLETED'};currentActor={...actor};existing=true;storageCalls=0;
    const result=await actions.completeSurveyAction({appointmentId:'appointment',measurements:{},siteCondition:{}});
    assert.equal(result.success,true);assert.equal(result.isExisting,true);assert.equal(result.surveyId,'survey');assert.equal(storageCalls,0);
    assert.equal((await actions.refreshPhotoSignedUrlAction('appointment','OVERVIEW')).success,false);
    inconsistent=true;assert.equal((await actions.completeSurveyAction(valid)).success,false);inconsistent=false;existing=false;
  });
  await t.test('Required technical values, invalid ranges/enums and no-input completion fail closed',()=>{
    assert.equal(validateSurveyInput(valid).isValid,true);
    for(const key of Object.keys(valid.measurements)) {
      const input=structuredClone(valid);delete (input.measurements as Record<string,unknown>)[key];assert.equal(validateSurveyInput(input).isValid,false,key);
    }
    for(const key of Object.keys(valid.siteCondition)) {
      const input=structuredClone(valid);delete (input.siteCondition as Record<string,unknown>)[key];assert.equal(validateSurveyInput(input).isValid,false,key);
    }
    for(const value of [NaN,Infinity,0,499,15001,500.5,'2000',true,[]]) {
      const input=structuredClone(valid);(input.measurements as Record<string,unknown>).clear_width_mm=value;assert.equal(validateSurveyInput(input).isValid,false);
    }
    assert.equal(validateSurveyInput({...valid,measurements:{...valid.measurements,gate_type:'FAKE'} } as unknown as CompleteSurveyInput).isValid,false);
  });
  await t.test('Initial detail and site UI render empty with no selected technical defaults',()=>{
    const html=renderToStaticMarkup(React.createElement(Detail,{appointment:{...resource,address:'Test',start_time:'2026-09-24'},customer:{id:'customer',name:'Test',customer_code:'TEST'}}));
    assert.ok(!html.includes('value="600"'));assert.ok(!html.includes('aria-pressed="true"'));assert.match(html,/Chưa chọn/);
    const siteHtml=renderToStaticMarkup(React.createElement(Site,{values:{},onChange:()=>{}}));
    assert.ok(!siteHtml.includes('aria-pressed="true"'));assert.match(siteHtml,/Chưa chọn/);
    const source=readFileSync('app/(dashboard)/surveys/[appointmentId]/SurveyMeasurementDetailClient.tsx','utf8');
    assert.ok(source.includes('survey_draft_v2_'));
    assert.ok(!source.includes('objectPath'));
    assert.ok(!source.includes('signedUrl: photo.signedUrl'));
  });
  await t.test('Survey local draft serialization contains no objectPath, bucket, canonical file ref, or signed URL', () => {
    const dirtyPhotos: Record<string, unknown> = {
      OVERVIEW: {
        slot: 'OVERVIEW',
        signedUrl: 'https://test-tenant.supabase.co/storage/v1/object/sign/survey-photos/company/customer/appointment/OVERVIEW.jpg?token=secret123',
        objectPath: 'company/customer/appointment/OVERVIEW.jpg',
        bucket: 'survey-photos',
        canonicalRef: 'company/customer/appointment/OVERVIEW.jpg',
        uploadedAt: '10:00:00',
        slotLabel: 'Ảnh toàn cảnh mặt tiền',
        isMandatory: true,
      },
      BOTTOM_LEFT: {
        slot: 'BOTTOM_LEFT',
        signedUrl: 'https://test-tenant.supabase.co/storage/v1/object/sign/survey-photos/company/customer/appointment/BOTTOM_LEFT.jpg?token=secret456',
        uploadedAt: '10:01:00',
        slotLabel: 'Chân tường trái',
        isMandatory: true,
      },
    };

    const draft = serializeSurveyDraft(
      'test-appointment-123',
      valid.measurements,
      valid.siteCondition,
      dirtyPhotos as unknown as Parameters<typeof serializeSurveyDraft>[3],
      '10:05:00'
    );
    const serialized = JSON.stringify(draft);

    // Verify properties strictly stripped from the returned object
    assert.equal('signedUrl' in (draft.photos?.OVERVIEW || {}), false);
    assert.equal('objectPath' in (draft.photos?.OVERVIEW || {}), false);
    assert.equal('bucket' in (draft.photos?.OVERVIEW || {}), false);
    assert.equal('canonicalRef' in (draft.photos?.OVERVIEW || {}), false);

    // Verify serialized JSON draft string has zero sensitive tokens or canonical references
    assert.equal(serialized.includes('signedUrl'), false);
    assert.equal(serialized.includes('objectPath'), false);
    assert.equal(serialized.includes('bucket'), false);
    assert.equal(serialized.includes('canonical'), false);
    assert.equal(serialized.includes('survey-photos'), false);
    assert.equal(serialized.includes('secret123'), false);
    assert.equal(serialized.includes('secret456'), false);
    assert.equal(serialized.includes('https://'), false);
    assert.equal(serialized.includes('.jpg'), false);

    // Verify only allowed non-sensitive UI fields are retained
    assert.deepEqual(Object.keys(draft.photos!.OVERVIEW).sort(), ['isMandatory', 'slot', 'slotLabel', 'uploadedAt']);
  });
});

