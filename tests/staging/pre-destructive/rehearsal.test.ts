import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SignedUrlRequest } from '../../../shared/contracts/sensitive';
import { createAuthorizedSignedUrl, getCategoryTTL } from '../../../lib/sensitive/signed-urls';
import { sqlSha256 } from '../../../scripts/meta-ads/ledger-readiness';
import { encryptSyntheticBackup, decryptSyntheticBackup, backupDigest } from '../../../scripts/meta-ads/synthetic-backup';
import { CONTAINER, fixtureDatabase, createFixtureDatabase, dropFixtureDatabase, sql, quote, setupFixtureLedger, applySyntheticMigration, dumpFixture, restoreFixture } from './local-fixture';
import { setupSyntheticDomain, seedSyntheticDomain } from './fixtures';
import { syntheticStorageAdapter } from './storage-adapter';

test('QC compatibility, signed URLs, ledger atomicity and encrypted restore on synthetic PostgreSQL',async t=>{
  const source=fixtureDatabase('source'),restored=fixtureDatabase('restore');
  createFixtureDatabase(source);createFixtureDatabase(restored);
  const started=Date.now();
  let adapter:Awaited<ReturnType<typeof syntheticStorageAdapter>>|undefined;
  const oldEnv={url:process.env.NEXT_PUBLIC_SUPABASE_URL,key:process.env.SUPABASE_SERVICE_ROLE_KEY,node:process.env.NODE_ENV};
  const temp=mkdtempSync(join(tmpdir(),'crm-synthetic-recovery-'));
  const evidence:Record<string,unknown>={scope:'Synthetic isolated local databases only; not a staging backup or live executor proof.',source,restored,container:CONTAINER};
  try {
    setupSyntheticDomain(source);setupFixtureLedger(source);const {ids,refs}=seedSyntheticDomain(source);
    adapter=await syntheticStorageAdapter(source);
    const app=adapter;
    Object.assign(process.env,{NODE_ENV:'production'});
    const request=(category:SignedUrlRequest['category']):SignedUrlRequest=>category==='RECORDING'?{category,resourceId:ids.call}:category==='SURVEY'?{category,resourceId:ids.survey}:category==='CONTRACT'?{category,resourceId:ids.contract}:{category,resourceId:ids.installation,variant:'photo',photoIndex:0};
    const expectCode=async (req:SignedUrlRequest,actor:string|null,code:string,aal:'aal1'|'aal2'='aal2')=>{
      const before=app.state.signs;
      await assert.rejects(createAuthorizedSignedUrl(req,app.actorClient(actor,aal)),(e:unknown)=>!!e&&typeof e==='object'&&'code' in e&&e.code===code);
      assert.equal(app.state.signs,before,'denied request must not invoke signer');
    };

    await t.test('QC actual source preserves PASS/REWORK/REJECT, audit, service ACLs and tenant boundaries',()=>{
      const qc=(company=ids.company,actor=ids.boss,status='PASSED')=>`SELECT public.record_quality_check_atomic('${company}','${ids.production}',${quote(status)},'${actor}',NULL);`;
      assert.throws(()=>sql(source,'SET ROLE anon; '+qc()),/Command failed/);
      assert.throws(()=>sql(source,'SET ROLE authenticated; '+qc()),/Command failed/);
      assert.throws(()=>sql(source,'SET ROLE service_role; '+qc(ids.company,ids.sale)),/Command failed/);
      assert.throws(()=>sql(source,'SET ROLE service_role; '+qc(ids.foreign,ids.otherBoss)),/Command failed/);
      assert.throws(()=>sql(source,'SET ROLE service_role; '+qc(ids.company,ids.boss,'INVALID')),/Command failed/);
      assert.equal(sql(source,'SELECT count(*) FROM audit_logs;'),'0');
      for(const [status,production,order] of [['REWORK_REQUIRED','QC_FAILED','IN_PRODUCTION'],['REJECTED','QC_FAILED','IN_PRODUCTION'],['PASSED','READY_FOR_DISPATCH','READY_FOR_INSTALL']]) {
        sql(source,`UPDATE public.production_orders SET status='QC_IN_PROGRESS',qc_status='PENDING' WHERE id='${ids.production}'; UPDATE public.orders SET order_status='IN_PRODUCTION' WHERE id='${ids.order}';`);
        assert.deepEqual(JSON.parse(sql(source,'SET ROLE service_role; '+qc(ids.company,ids.boss,status))),{success:true});
        assert.equal(sql(source,`SELECT status FROM production_orders WHERE id='${ids.production}'`),production);
        assert.equal(sql(source,`SELECT order_status FROM orders WHERE id='${ids.order}'`),order);
      }
      assert.equal(sql(source,"SELECT count(*) FROM audit_logs WHERE action='RECORD_QUALITY_CHECK'"),'3');
      assert.throws(()=>sql(source,'SET ROLE service_role; '+qc()),/Command failed/);
      assert.equal(sql(source,'SELECT count(*) FROM audit_logs;'),'3');
    });

    await t.test('all four signed URL categories preserve their TTLs and retrieve authorized bytes',async()=>{
      for(const category of ['RECORDING','SURVEY','CONTRACT','INSTALLATION'] as const) {
        const result=await createAuthorizedSignedUrl(request(category),app.actorClient(ids.boss));
        assert.equal(result.expiresIn,getCategoryTTL(category));
        const response=await fetch(result.signedUrl);assert.equal(response.status,200);assert.match(await response.text(),/^synthetic-file-/);
      }
      const signed=await createAuthorizedSignedUrl({category:'CONTRACT',resourceId:ids.contract,variant:'signed'},app.actorClient(ids.sale));
      assert.equal(await (await fetch(signed.signedUrl)).text(),'synthetic-file-signed');
      const handover=await createAuthorizedSignedUrl({category:'INSTALLATION',resourceId:ids.installation,variant:'handover'},app.actorClient(ids.tech));
      assert.equal(await (await fetch(handover.signedUrl)).text(),'synthetic-file-handover');
      const survey=await createAuthorizedSignedUrl(request('SURVEY'),app.actorClient(ids.tech));assert.equal((await fetch(survey.signedUrl)).status,200);
      const canonicalPath=`${ids.company}/${ids.customer}/${ids.appointment}/OVERVIEW.jpg`;
      sql(source,`INSERT INTO storage.objects VALUES('${randomUUID()}','survey-photos',${quote(canonicalPath)},'synthetic-file-overview');
        UPDATE public.surveys SET photos=${quote(JSON.stringify([{slot:'OVERVIEW',objectPath:canonicalPath,uploadedAt:'2026-10-30T00:00:00Z'}]))}::jsonb WHERE id='${ids.survey}';`);
      const canonicalSurvey=await createAuthorizedSignedUrl(request('SURVEY'),app.actorClient(ids.tech));
      assert.equal(await (await fetch(canonicalSurvey.signedUrl)).text(),'synthetic-file-overview');
      sql(source,`UPDATE public.surveys SET photos=${quote(JSON.stringify([refs.survey]))}::jsonb WHERE id='${ids.survey}';`);
    });

    await t.test('authorization, foreign tenants, AAL2 and technician lifecycle fail before signing',async()=>{
      for(const category of ['RECORDING','SURVEY','CONTRACT','INSTALLATION'] as const) {
        await expectCode(request(category),null,'UNAUTHENTICATED');
        await expectCode(request(category),ids.otherBoss,category==='RECORDING'?'NOT_A_MEMBER':'RESOURCE_NOT_FOUND');
        await expectCode(request(category),ids.boss,'MFA_REQUIRED','aal1');
      }
      await expectCode(request('RECORDING'),ids.sale,'ROLE_FORBIDDEN');
      await expectCode(request('RECORDING'),ids.tech,'ROLE_FORBIDDEN');
      await expectCode(request('RECORDING'),ids.boss,'MFA_REQUIRED','aal1');
      await expectCode(request('CONTRACT'),ids.tech,'ROLE_FORBIDDEN');
      sql(source,`UPDATE public.appointments SET status='COMPLETED' WHERE id IN ('${ids.appointment}','${ids.installationAppointment}');`);
      await expectCode(request('SURVEY'),ids.tech,'ASSIGNMENT_INACTIVE');await expectCode(request('INSTALLATION'),ids.tech,'ASSIGNMENT_INACTIVE');
      sql(source,`UPDATE public.appointments SET status='ASSIGNED',assignee_id='${ids.boss}' WHERE id IN ('${ids.appointment}','${ids.installationAppointment}');`);
      await expectCode(request('INSTALLATION'),ids.tech,'ROLE_FORBIDDEN');
      sql(source,`UPDATE public.appointments SET assignee_id='${ids.tech}' WHERE id IN ('${ids.appointment}','${ids.installationAppointment}');`);
      sql(source,`UPDATE public.user_profiles SET status='INACTIVE' WHERE id='${ids.sale}';`);
      await expectCode(request('CONTRACT'),ids.sale,'USER_INACTIVE');
      sql(source,`UPDATE public.user_profiles SET status='ACTIVE' WHERE id='${ids.sale}';`);
    });

    await t.test('invalid selectors, canonical paths, missing resources, tampering and expiry never succeed empty',async()=>{
      await expectCode({category:'SURVEY',resourceId:ids.survey,photoIndex:-1},ids.boss,'INVALID_PURPOSE');
      await expectCode({category:'CONTRACT',resourceId:ids.contract,variant:'other'} as unknown as SignedUrlRequest,ids.boss,'INVALID_PURPOSE');
      await expectCode({category:'toString',resourceId:ids.call} as unknown as SignedUrlRequest,ids.boss,'INVALID_PURPOSE');
      for(const category of ['RECORDING','SURVEY','CONTRACT','INSTALLATION'] as const)await expectCode({...request(category),resourceId:randomUUID()},ids.boss,'RESOURCE_NOT_FOUND');
      for(const invalid of ['https://outside.invalid/file','../other/file','/absolute/file','a//file','a\\file','file\u001f.pdf',`${ids.foreign}/contracts/${ids.contract}/other.pdf`]) {
        sql(source,`UPDATE public.contracts SET generated_file_ref=${quote(invalid)} WHERE id='${ids.contract}';`);
        await expectCode(request('CONTRACT'),ids.boss,'SIGNED_URL_UNAVAILABLE');
      }
      sql(source,`UPDATE public.contracts SET generated_file_ref=${quote(refs.contract)} WHERE id='${ids.contract}';`);
      const result=await createAuthorizedSignedUrl(request('RECORDING'),app.actorClient(ids.boss));
      const changed=new URL(result.signedUrl);changed.searchParams.set('signature','0'.repeat(64));assert.equal((await fetch(changed)).status,403);
      app.state.now+=result.expiresIn;assert.equal((await fetch(result.signedUrl)).status,403);app.state.now-=result.expiresIn;
    });

    await t.test('native RLS, FK and trigger integrity preserve company boundaries',()=>{
      assert.equal(sql(source,`SET ROLE authenticated; SET request.jwt.claim.sub='${ids.otherBoss}'; SELECT count(*) FROM public.contracts;`),'0');
      assert.equal(sql(source,`SET ROLE authenticated; SET request.jwt.claim.sub='${ids.sale}'; SELECT count(*) FROM public.contracts;`),'1');
      assert.throws(()=>sql(source,`SET ROLE authenticated; SELECT * FROM private.token_store;`),/Command failed/);
      assert.throws(()=>sql(source,`SET ROLE authenticated; SELECT * FROM storage.objects;`),/Command failed/);
      assert.throws(()=>sql(source,`UPDATE public.contracts SET company_id='${ids.foreign}' WHERE id='${ids.contract}'`),/Command failed/);
      assert.throws(()=>sql(source,`INSERT INTO public.production_orders VALUES('${randomUUID()}','${ids.foreign}','${ids.order}','QC_IN_PROGRESS','PENDING',now());`),/Command failed/);
    });

    const migrations:Array<{canonical:string;ledger:string;name:string;sql:string;expectedHash:string;predecessor:string|null}>=[];
    await t.test('21 genuinely executed synthetic prefix files map append-only; no copied/fabricated staging history',async()=>{
      sql(source,'CREATE TABLE public.rehearsal_events(id integer PRIMARY KEY,value text);');
      for(let i=1;i<=21;i++) {
        const body=`INSERT INTO public.rehearsal_events VALUES(${i},'synthetic-prefix-${i}');`;
        const item={canonical:'200001010000'+String(i).padStart(2,'0'),ledger:'202610300700'+String(i).padStart(2,'0'),name:`synthetic_prefix_${i}`,sql:body,expectedHash:sqlSha256(body),predecessor:i===1?null:'200001010000'+String(i-1).padStart(2,'0')};
        migrations.push(item);assert.equal(await applySyntheticMigration(source,item),'APPLIED');
      }
      assert.equal(sql(source,'SELECT count(*) FROM supabase_migrations.schema_migrations;'),'21');
      assert.equal(sql(source,'SELECT count(*) FROM public.rehearsal_events;'),'21');
      const before=sql(source,"SELECT json_agg(t ORDER BY version) FROM supabase_migrations.schema_migrations t;");
      const body="-- original bytes preserved\nBEGIN;\nINSERT INTO public.rehearsal_events VALUES(22,'expanded');\nCOMMIT;\n-- tail";
      assert.equal(await applySyntheticMigration(source,{canonical:'20000101000022',ledger:'20261030110000',name:'synthetic_expand',sql:body,expectedHash:sqlSha256(body),predecessor:'20000101000021'}),'APPLIED');
      assert.equal(sql(source,"SELECT json_agg(t ORDER BY version) FROM supabase_migrations.schema_migrations t WHERE version<'20261030110000';"),before);
      assert.equal(sql(source,"SELECT source_sha256 FROM rehearsal_private.source_mapping WHERE canonical_version='20000101000022'"),sqlSha256(body));
    });

    await t.test('hash conflicts, duplicate concurrent execution and both transaction failure forms are safe',async()=>{
      const body="INSERT INTO public.rehearsal_events VALUES(23,'exactly once'); SELECT pg_sleep(0.1);";
      const item={canonical:'20000101000023',ledger:'20261030110001',name:'synthetic_concurrent',sql:body,expectedHash:sqlSha256(body),predecessor:'20000101000022'};
      const outcomes=await Promise.all(Array.from({length:8},()=>applySyntheticMigration(source,item)));
      assert.equal(outcomes.filter(x=>x==='APPLIED').length,1);assert.equal(outcomes.filter(x=>x==='ALREADY_APPLIED').length,7);
      await assert.rejects(applySyntheticMigration(source,{...item,expectedHash:'0'.repeat(64)}),/SOURCE_HASH_MISMATCH/);
      const changed=body+'\n-- changed bytes';await assert.rejects(applySyntheticMigration(source,{...item,sql:changed,expectedHash:sqlSha256(changed)}),/LEDGER_HASH_CONFLICT/);
      await assert.rejects(applySyntheticMigration(source,{...item,ledger:'20261030119999'}),/LEDGER_IDENTITY_CONFLICT/);
      // Deliberate corruption of synthetic history must be detected, not treated
      // as a successful duplicate. Restore the genuine executed fixture bytes.
      sql(source,`UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['synthetic corruption'] WHERE version=${quote(item.ledger)};`);
      await assert.rejects(applySyntheticMigration(source,item),/LEDGER_MAPPING_INCONSISTENT/);
      sql(source,`UPDATE supabase_migrations.schema_migrations SET statements=ARRAY[${quote(body)}] WHERE version=${quote(item.ledger)};`);
      assert.equal(await applySyntheticMigration(source,item),'ALREADY_APPLIED');
      for(const wrapped of [false,true]) {
        const n=wrapped?25:24,gate=`synthetic_gate_${n}`;
        const body=(wrapped?'BEGIN;\n':'')+`INSERT INTO public.rehearsal_events VALUES(${n},'retry'); INSERT INTO public.${gate} VALUES(1);`+(wrapped?'\nCOMMIT;':'');
        const item={canonical:'200001010000'+n,ledger:'202610301100'+n,name:`synthetic_retry_${n}`,sql:body,expectedHash:sqlSha256(body),predecessor:'200001010000'+(n-1)};
        await assert.rejects(applySyntheticMigration(source,item),/does not exist/);
        assert.equal(sql(source,`SELECT count(*) FROM public.rehearsal_events WHERE id=${n};`),'0');
        assert.equal(sql(source,`SELECT count(*) FROM rehearsal_private.source_mapping WHERE canonical_version='${item.canonical}';`),'0');
        sql(source,`CREATE TABLE public.${gate}(id integer PRIMARY KEY);`);
        assert.equal(await applySyntheticMigration(source,item),'APPLIED');
      }
      const broken='BEGIN; INSERT INTO public.rehearsal_events VALUES(99,\'bad\'); COMMIT; SELECT 1;';
      await assert.rejects(applySyntheticMigration(source,{canonical:'20000101000099',ledger:'20261030110099',name:'synthetic_mid_commit',sql:broken,expectedHash:sqlSha256(broken),predecessor:'20000101000025'}),/UNSUPPORTED_TRANSACTION/);
      assert.equal(sql(source,'SELECT count(*) FROM public.rehearsal_events WHERE id=99;'),'0');
      const collision="INSERT INTO public.rehearsal_events VALUES(98,'collision');";
      await assert.rejects(applySyntheticMigration(source,{canonical:'20000101000098',ledger:item.ledger,name:'synthetic_collision',sql:collision,expectedHash:sqlSha256(collision),predecessor:'20000101000025'}),/LEDGER_VERSION_COLLISION/);
      assert.equal(sql(source,'SELECT count(*) FROM public.rehearsal_events WHERE id=98;'),'0');
      const interruptedSql="INSERT INTO public.rehearsal_events VALUES(26,'interrupted'); SELECT pg_sleep(2);";
      await assert.rejects(applySyntheticMigration(source,{canonical:'20000101000027',ledger:'20261030110027',name:'synthetic_gap',sql:collision,expectedHash:sqlSha256(collision),predecessor:'20000101000026'}),/PREDECESSOR_MISMATCH/);
      const interrupted={canonical:'20000101000026',ledger:'20261030110026',name:'synthetic_interrupted',sql:interruptedSql,expectedHash:sqlSha256(interruptedSql),predecessor:'20000101000025'};
      const waiting=applySyntheticMigration(source,interrupted).then(()=>null,error=>error);
      let pid='';
      for(let attempt=0;attempt<30&&!pid;attempt++) {
        pid=sql(source,`SELECT pid FROM pg_stat_activity WHERE datname=${quote(source)} AND application_name='synthetic_migration_20000101000026' AND wait_event='PgSleep';`);
        if(!pid)await new Promise(resolve=>setTimeout(resolve,50));
      }
      assert.match(pid,/^\d+$/);
      sql(source,`SELECT pg_terminate_backend(${pid}) WHERE EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=${pid} AND datname=${quote(source)} AND application_name='synthetic_migration_20000101000026');`);
      assert.ok(await waiting instanceof Error);
      assert.equal(sql(source,'SELECT count(*) FROM public.rehearsal_events WHERE id=26;'),'0');
      assert.equal(sql(source,"SELECT count(*) FROM rehearsal_private.source_mapping WHERE canonical_version='20000101000026';"),'0');
      assert.equal(await applySyntheticMigration(source,interrupted),'APPLIED');
    });

    await t.test('installed CLI refuses application-time ledger drift in a synthetic-only workspace',()=>{
      const work=join(temp,'cli-workspace');mkdirSync(join(work,'supabase','migrations'),{recursive:true});
      writeFileSync(join(work,'supabase','config.toml'),'project_id = "synthetic-ledger-cli"\n');
      for(const m of migrations)writeFileSync(join(work,'supabase','migrations',m.canonical+'_'+m.name+'.sql'),m.sql);
      const before=sql(source,'SELECT count(*) FROM public.rehearsal_events;');
      const url=`postgresql://postgres:postgres@127.0.0.1:55322/${source}?sslmode=disable`;
      // This CLI check is opt-in on the dedicated local stack; CI uses a different port.
      if(CONTAINER==='supabase_db_crm-meta-migration-validation') {
        const result=spawnSync('supabase',['migration','up','--db-url',url,'--workdir',work],{encoding:'utf8',timeout:30_000});
        assert.notEqual(result.status,0);
        assert.match(result.stdout+result.stderr,/migration.*(not found|missing)|Remote migration versions|repair/i);
        assert.equal(sql(source,'SELECT count(*) FROM public.rehearsal_events;'),before);
        evidence.cli={tested:true,status:'DRIFT_REJECTED_WITHOUT_SQL_OR_REPAIR'};
      } else evidence.cli={tested:false,reason:'Dedicated localhost:55322 CLI target not present; native ledger assertions still run.'};
    });

    await t.test('encrypted pg_dump restores counts/hashes, history, grants, RLS, FK, trigger, sequence and app retrieval',async()=>{
      const rowSnapshot=(db:string)=>['public.companies','public.user_profiles','public.company_members','public.customers','public.appointments','public.surveys','public.orders','public.production_orders','public.installations','public.contracts','public.calls','public.audit_logs','storage.objects','private.token_store','supabase_migrations.schema_migrations','rehearsal_private.source_mapping','public.rehearsal_events'].map(table=>({table,count:sql(db,`SELECT count(*) FROM ${table}`),hash:createHash('sha256').update(sql(db,`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM ${table} t;`)).digest('hex')}));
      const before=rowSnapshot(source),sequence=sql(source,'SELECT last_value,is_called FROM public.fixture_audit_seq;');
      const archive=dumpFixture(source),key=randomBytes(32),encrypted=encryptSyntheticBackup(archive,key),path=join(temp,'synthetic-backup.aesgcm');
      writeFileSync(path,encrypted,{mode:0o600});
      assert.ok(!encrypted.includes(Buffer.from('synthetic-encrypted-placeholder')));
      const restoreStarted=Date.now();restoreFixture(restored,decryptSyntheticBackup(readFileSync(path),key));
      assert.deepEqual(rowSnapshot(restored),before);assert.equal(sql(restored,'SELECT last_value,is_called FROM public.fixture_audit_seq;'),sequence);
      assert.equal(sql(restored,"SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated"),'0');
      assert.equal(sql(restored,"SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relnamespace='public'::regnamespace AND NOT i.indisvalid"),'0');
      assert.equal(sql(restored,`SET ROLE authenticated; SET request.jwt.claim.sub='${ids.otherBoss}'; SELECT count(*) FROM contracts;`),'0');
      assert.throws(()=>sql(restored,'SET ROLE authenticated; SELECT * FROM private.token_store;'),/Command failed/);
      assert.throws(()=>sql(restored,`UPDATE contracts SET company_id='${ids.foreign}' WHERE id='${ids.contract}'`),/Command failed/);
      assert.equal(sql(restored,"SELECT has_function_privilege('authenticated','public.record_quality_check_atomic(uuid,uuid,text,uuid,text)','EXECUTE')"),'f');
      app.state.database=restored;
      for(const category of ['RECORDING','SURVEY','CONTRACT','INSTALLATION'] as const) {
        const result=await createAuthorizedSignedUrl(request(category),app.actorClient(ids.boss));assert.equal((await fetch(result.signedUrl)).status,200);
      }
      sql(restored,`UPDATE production_orders SET status='QC_IN_PROGRESS' WHERE id='${ids.production}'; UPDATE orders SET order_status='IN_PRODUCTION' WHERE id='${ids.order}';`);
      assert.deepEqual(JSON.parse(sql(restored,`SET ROLE service_role; SELECT public.record_quality_check_atomic('${ids.company}','${ids.production}','PASSED','${ids.boss}',NULL);`)),{success:true});
      evidence.backup={encrypted:true,algorithm:'AES-256-GCM',ciphertextSha256:backupDigest(encrypted),archiveBytes:archive.length,restoreMilliseconds:Date.now()-restoreStarted,verifiedTableCount:before.length,rowCountsAndHashes:before};
    });
    evidence.status='PASS';evidence.elapsedMilliseconds=Date.now()-started;
    if(process.env.CRM_PREFLIGHT_EVIDENCE_OUTPUT)writeFileSync(process.env.CRM_PREFLIGHT_EVIDENCE_OUTPUT,JSON.stringify(evidence,null,2)+'\n');
  } finally {
    if(adapter)await adapter.close();
    for(const [key,value] of [['NEXT_PUBLIC_SUPABASE_URL',oldEnv.url],['SUPABASE_SERVICE_ROLE_KEY',oldEnv.key],['NODE_ENV',oldEnv.node]] as const) {if(value===undefined)Reflect.deleteProperty(process.env,key);else Object.assign(process.env,{[key]:value});}
    dropFixtureDatabase(restored);dropFixtureDatabase(source);rmSync(temp,{recursive:true,force:true});
  }
});
