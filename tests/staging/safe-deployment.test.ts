/** Read-only preflight evidence + disposable local PostgreSQL only.
 * No connection strings, remote executor, history repair, or hosted writes.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { PLATFORM_STUBS } from '../zalo/helpers/pglite-supabase';
import { inspectTransactionEnvelope, sqlSha256 } from '../../scripts/meta-ads/ledger-readiness';

const output = 'docs/evidence/meta-ads-safe-deployment';
const project = readFileSync('supabase/config.toml','utf8').match(/^project_id\s*=\s*"([\w-]+)"/m)?.[1];
assert.ok(project);
const container = `supabase_db_${project}`;
const prefix = `crm_safe_${randomUUID().replaceAll('-','')}`;
const databases = ['prefix','full','meta'].map(s=>`${prefix}_${s}`);
function local(db: string) {
    assert.ok(db==='postgres' || new RegExp(`^${prefix}_(prefix|full|meta)$`).test(db), 'disposable local databases only');
}
function sql(db:string,query:string) {
    local(db);
    return execFileSync('docker',['exec','-i',container,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],{
        input:query,encoding:'utf8',maxBuffer:64*1024*1024,stdio:['pipe','pipe','pipe'],timeout:120_000,
    }).trim();
}
const q=(s:string)=>`'${s.replaceAll("'","''")}'`;
const files=readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort();
const historical=JSON.parse(readFileSync(`${output}/staging-metadata.json`,'utf8')).data[0].snapshot;
const inventory=JSON.parse(readFileSync(`${output}/migration-inventory.json`,'utf8'));
const currentManifest=JSON.parse(readFileSync('docs/evidence/meta-ads-final-scope/migration-manifest.json','utf8'));
const fingerprint=readFileSync(`${output}/catalog-fingerprint.sql`,'utf8').replace(/;\s*$/,'');
const catalog=(db:string)=>JSON.parse(sql(db,`SELECT json_agg(t) FROM (${fingerprint}) t;`));
const objects=(db:string):Record<string,string>=>JSON.parse(sql(db,`SELECT coalesce(jsonb_object_agg(identity,definition),'{}') FROM (
    SELECT 'table:'||n.nspname||'.'||c.relname identity,md5(concat_ws('|',c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.relacl)) definition
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p','v','S')
    UNION ALL SELECT 'column:'||n.nspname||'.'||c.relname||'.'||a.attname,md5(concat_ws('|',format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)))
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL SELECT 'function:'||n.nspname||'.'||p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid)||coalesce(p.proacl::text,''))
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','private') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
    UNION ALL SELECT 'trigger:'||n.nspname||'.'||c.relname||'.'||t.tgname,md5(pg_get_triggerdef(t.oid,true))
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private') AND NOT t.tgisinternal
    UNION ALL SELECT 'policy:'||schemaname||'.'||tablename||'.'||policyname,md5(concat_ws('|',permissive,roles::text,cmd,qual,with_check)) FROM pg_policies WHERE schemaname IN ('public','private')
    UNION ALL SELECT 'index:'||n.nspname||'.'||c.relname,md5(pg_get_indexdef(i.indexrelid)) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private')
    UNION ALL SELECT 'constraint:'||n.nspname||'.'||c.conrelid::regclass::text||'.'||c.conname,md5(pg_get_constraintdef(c.oid,true)) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname IN ('public','private')
) s;`));
function apply(db:string,file:string) {
    const source=readFileSync(`supabase/migrations/${file}`,'utf8');
    const envelope=inspectTransactionEnvelope(source);
    assert.notEqual(envelope.mode,'REJECT');
    const start=Date.now();
    try {
        sql(db,envelope.mode==='NONE'?`BEGIN;\n${source}\nCOMMIT;`:source);
        return {file,sha256:sqlSha256(source),transactionMode:envelope.mode,status:'APPLIED_LOCAL_ONLY',elapsedMs:Date.now()-start};
    } catch(error) {
        return {file,sha256:sqlSha256(source),transactionMode:envelope.mode,status:'FAILED_LOCAL',elapsedMs:Date.now()-start,error:error instanceof Error?error.message:String(error)};
    }
}
function watched(db:string) {
    return JSON.parse(sql(db,`SELECT jsonb_build_object(
      'seed_functions',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='seed_messenger_pages_canary'),
      'seed_triggers',(SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE p.proname='seed_messenger_pages_canary' AND NOT t.tgisinternal),
      'sla_signature',to_regprocedure('public.open_response_sla_window(uuid,uuid,uuid)')::text,
      'canary_table',to_regclass('public.ai_brain_live_canary_allowlist')::text,
      'canary_settings',to_regclass('public.ai_brain_live_settings')::text,
      'page_helper',to_regprocedure('public.ai_messenger_page_id(text,jsonb)')::text,
      'meta_events',to_regclass('private.meta_leadgen_events')::text,
      'touchpoints',to_regclass('public.lead_attribution_touchpoints')::text,
      'zalo_oa_configs',to_regclass('public.zalo_oa_configs')::text,
      'cron_job',to_regclass('cron.job')::text,
      'pg_cron_installed',EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron'),
      'pg_net_installed',EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_net'));`));
}
function probe(db:string,body:string) {
    // Every case, including failed DML and function definitions, rolls back.
    return JSON.parse(sql(db,`BEGIN;
      CREATE TEMP TABLE fixture_result(value jsonb);
      DO $fixture$ DECLARE v jsonb; token uuid; c uuid; i uuid; detail text; context text;
      BEGIN
        INSERT INTO public.companies(id,name,status) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Local preflight fixture','ACTIVE');
        ${body}
        INSERT INTO fixture_result VALUES(jsonb_build_object('ok',true,'result',v,'customer_count',(SELECT count(*) FROM public.customers),'interaction_count',(SELECT count(*) FROM public.interactions),'sla_count',(SELECT count(*) FROM public.response_sla_windows)));
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS detail=MESSAGE_TEXT,context=PG_EXCEPTION_CONTEXT;
        INSERT INTO fixture_result VALUES(jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'error',detail,'context',context));
      END $fixture$;
      SELECT value FROM fixture_result; ROLLBACK;`));
}
const han=(channel:string,external:string|null)=>`v:=public.han_ingest('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',${q(channel)},${external?q(external):'NULL'},'synthetic-key','Synthetic customer',NULL,'Synthetic content','Synthetic content','SUCCEEDED','2026-10-30T00:00:00Z','{}');`;
const lead=`
    INSERT INTO public.meta_campaigns(company_id,ad_account_id,meta_campaign_id,name,status) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','act_synthetic','synthetic_campaign','Synthetic campaign','ACTIVE');
    INSERT INTO public.meta_ads(company_id,ad_account_id,meta_campaign_id,meta_ad_id,name,status) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','act_synthetic','synthetic_campaign','synthetic_ad','Synthetic ad','ACTIVE');
    v:=public.claim_meta_leadgen_event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','7777777777777777','88001');
    token:=(v->>'claim_token')::uuid;
    v:=public.ingest_meta_leadgen_event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','88001',token,
        '{"name":"Synthetic Meta customer","phone":"+843000000011","content":"Synthetic content","lead_data":{"id":"88001"},"payload":{"crm_lead_ads":true}}');
    c:=(v->>'customer_id')::uuid; i:=(v->>'interaction_id')::uuid;
    PERFORM public.record_lead_attribution_touchpoint(p_company=>'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',p_customer=>c,p_interaction=>i,p_meta_ad_id=>'synthetic_ad',p_meta_leadgen_id=>'88001');
    PERFORM public.mark_lead_attribution_phone_match('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','88001',v->>'phone_match_status',(v->>'is_duplicate_phone')::boolean);
    PERFORM public.finalize_meta_leadgen_event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','88001',token,'PROCESSED');
    v:=jsonb_build_object('ingest',v,'campaign',(SELECT campaign_name_snapshot FROM public.lead_attribution_touchpoints WHERE meta_leadgen_id='88001'),'status',(SELECT status FROM private.meta_leadgen_events WHERE leadgen_id='88001'));`;

test('exact staging prefix, full chain and Meta-only shortcut on disposable PostgreSQL',()=>{
    assert.equal(inventory.migrations.length,121,'the reviewed snapshot contains exactly 121 files');
    assert.ok(files.length>=121);
    for(const source of inventory.migrations) {
        const remediation=currentManifest.safeRemediation.sources.find((s:{file:string})=>s.file===source.file);
        if(remediation) {
            assert.match(source.file,/^202610301[01]0000_meta_ads_/);
            assert.equal(source.sha256,remediation.previousSha256,'retain the original audit snapshot and its exact hash');
        }
        assert.equal(sqlSha256(readFileSync(`supabase/migrations/${source.file}`,'utf8')),remediation?.sha256||source.sha256);
    }
    assert.equal(historical.migration_history.length,21);
    assert.equal(inventory.pending_count,100);
    const result:Record<string,any>={sourceCommit:'bdb4ee6b4a42d6e875e96926a6f53c1938f4ccc8',scope:'New disposable local databases only; no remote executor/history writes or real backup.',container,databases,tests:{},migrationFailures:[]};
    try {
        for(const db of databases) {
            sql('postgres',`CREATE DATABASE ${db};`);
            sql(db,PLATFORM_STUBS.replace(/CREATE ROLE[^;]+;/g,''));
            // Observed Supabase postgres defaults, captured read-only; not part of the 21 application files.
            sql(db,`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;
              ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon,authenticated,service_role;
              ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon,authenticated,service_role;`);
        }
        result.postgresVersion=sql(databases[0],'SHOW server_version;');
        const prefixRuns=files.slice(0,21).map((file,index)=>{
            const source=readFileSync(`supabase/migrations/${file}`,'utf8');
            const recorded=historical.migration_history[index];
            assert.equal(file.replace(/^\d+_|\.sql$/g,''),recorded.name);
            assert.equal(sqlSha256(source),recorded.stored_sql_sha256,'prefix source must equal actual stored staging SQL');
            const run=apply(databases[0],file);
            assert.equal(run.status,'APPLIED_LOCAL_ONLY',JSON.stringify(run));
            return {...run,recordedVersion:recorded.version};
        });
        const remote=JSON.parse(readFileSync(`${output}/staging-catalog.json`,'utf8'));
        const localCatalog=catalog(databases[0]);
        const differences=remote.filter((r:any)=>JSON.stringify(r)!==JSON.stringify(localCatalog.find((l:any)=>l.category===r.category)));
        result.tests.A={migrations:prefixRuns,catalog:localCatalog,remoteDifferences:differences,watched:watched(databases[0]),messenger:probe(databases[0],han('FACEBOOK','7777777777777777:9999999999')),website:probe(databases[0],han('WEBSITE',null))};
        assert.deepEqual(differences,[], 'all application catalog and effective-role grant fingerprints must match staging');
        assert.equal(result.tests.A.watched.seed_functions,0);
        assert.equal(result.tests.A.watched.seed_triggers,0);

        const fullRuns=[];
        const losses=[];
        for(const file of files) {
            let syntheticSeed:any;
            if(file==='20261029160000_remove_legacy_flood_barrier_schema.sql') {
                sql(databases[1],`INSERT INTO public.companies(id,name,status) VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Synthetic removal fixture','ACTIVE');
                  INSERT INTO public.customers(id,company_id,name,source,stage) VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Synthetic survivor','WEBSITE','LEAD_NEW');
                  INSERT INTO public.pricing_policies(company_id,version,conditions,price_rules,effective_at,status) VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','SYNTHETIC-ONLY','{}','{}',now(),'DRAFT');`);
                syntheticSeed={pricingRows:sql(databases[1],'SELECT count(*) FROM public.pricing_policies;'),customerRows:sql(databases[1],'SELECT count(*) FROM public.customers;')};
            }
            const destructive=inventory.migrations.find((m:any)=>m.file===file)?.categories.includes('E');
            const before=destructive?objects(databases[1]):null;
            const run=apply(databases[1],file);fullRuns.push(run);
            if(run.status!=='APPLIED_LOCAL_ONLY') {result.migrationFailures.push(run);break;}
            if(before) {
                const after=objects(databases[1]);
                losses.push({file,syntheticSeed,removed:Object.keys(before).filter(k=>!(k in after)),changed:Object.keys(before).filter(k=>k in after&&after[k]!==before[k]),added:Object.keys(after).filter(k=>!(k in before))});
            }
        }
        result.tests.B={migrations:fullRuns,destructiveBoundaryChanges:losses,watched:watched(databases[1]),catalog:catalog(databases[1]),
            survivingCustomers:sql(databases[1],'SELECT count(*) FROM public.customers;'),
            retainedQc:sql(databases[1],"SELECT to_regprocedure('public.record_quality_check_atomic(uuid,uuid,text,uuid,text)')::text;"),
            qcRuntime:probe(databases[1],"PERFORM public.record_quality_check_atomic('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','cccccccc-cccc-4ccc-8ccc-cccccccccccc','PASSED','dddddddd-dddd-4ddd-8ddd-dddddddddddd',NULL); v:='{}';"),
            messenger:probe(databases[1],han('FACEBOOK','7777777777777777:9999999999')),website:probe(databases[1],han('WEBSITE',null)),meta:probe(databases[1],lead)};
        assert.equal(fullRuns.length,files.length);
        assert.equal(result.migrationFailures.length,0);
        assert.equal(result.tests.B.messenger.ok,true);
        assert.equal(result.tests.B.website.ok,true);
        assert.equal(result.tests.B.meta.ok,true);
        assert.equal(result.tests.B.meta.result.status,'PROCESSED');
        assert.equal(result.tests.B.meta.result.campaign,'Synthetic campaign');

        for(const file of files.slice(0,21)) assert.equal(apply(databases[2],file).status,'APPLIED_LOCAL_ONLY');
        const beforeMeta=objects(databases[2]);
        const metaFiles:string[]=inventory.migrations.map((m:{file:string})=>m.file).filter((f:string)=>/^20261030\d{6}_meta_ads_/.test(f));
        assert.equal(metaFiles.length,5);
        const metaRuns=metaFiles.map(file=>apply(databases[2],file));
        const afterMeta=objects(databases[2]);
        result.tests.C={migrations:metaRuns,watched:watched(databases[2]),catalog:catalog(databases[2]),messenger:probe(databases[2],han('FACEBOOK','7777777777777777:9999999999')),website:probe(databases[2],han('WEBSITE',null)),meta:probe(databases[2],lead),
            latentCanaryProbe:probe(databases[2],`CREATE TRIGGER preflight_canary AFTER INSERT ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.seed_messenger_pages_canary(); ${han('FACEBOOK','7777777777777777:9999999999')}`),
            objectsChanged:Object.keys(beforeMeta).filter(k=>afterMeta[k]!==beforeMeta[k]),unsupportedHistory:'No ledger entry is written by these local probes. Successful CREATE does not authorize skipping 95 other pending canonical files.'};
        assert.ok(metaRuns.every(r=>r.status==='APPLIED_LOCAL_ONLY'),JSON.stringify(metaRuns));
        assert.equal(result.tests.C.watched.seed_functions,1);
        assert.equal(result.tests.C.watched.seed_triggers,0,'creating trigger function does not create a trigger');
        assert.equal(result.tests.C.watched.canary_table,null);
        assert.equal(result.tests.C.meta.ok,true);
        assert.equal(result.tests.C.meta.result.status,'PROCESSED');
        assert.equal(result.tests.C.meta.result.campaign,'Synthetic campaign');
        assert.equal(result.tests.A.messenger.sla_count,0);
        assert.equal(result.tests.C.messenger.sla_count,1,'the Meta-only shortcut changes the shared Messenger SLA path');
        assert.equal(result.tests.C.latentCanaryProbe.ok,false,'the missing canary prerequisites remain latent until a trigger is attached; probe rolls back');
    } finally {
        result.completedAt=new Date().toISOString();
        result.databasesRemoved=[];
        for(const db of databases) {
            try {sql('postgres',`DROP DATABASE IF EXISTS ${db} WITH (FORCE);`);result.databasesRemoved.push(db);} catch { /* record incomplete cleanup */ }
        }
        if(process.env.CRM_SAFE_PREFLIGHT_EVIDENCE==='1') writeFileSync(`${output}/local-reproduction.json`,JSON.stringify(result,null,2)+'\n');
        console.log(JSON.stringify({tests:Object.fromEntries(Object.entries(result.tests).map(([name,t]:[string,any])=>[name,{migrations:t.migrations?.length,watched:t.watched,messenger:t.messenger?.ok,website:t.website?.ok,meta:t.meta?.ok}])),migrationFailures:result.migrationFailures.length}));
    }
});
