import assert from 'node:assert/strict';

export type LocalSql = (database: string, query: string) => string;
const schemas = "('public','private','auth','storage','supabase_migrations')";
export const attributionColumns = ['first_campaign_name','first_ad_name','first_touch_at','latest_campaign_name','latest_ad_name','latest_touch_at','attribution_status'];
const metaTables = new Set(['public.meta_ad_accounts','public.meta_campaigns','public.meta_ads','public.meta_lead_forms','public.lead_attribution_touchpoints','private.meta_ad_account_tokens','private.meta_leadgen_events']);
const metaFunctions = new Set(['store_meta_ad_account_token','get_meta_ad_account_token','claim_meta_leadgen_event','finalize_meta_leadgen_event','acquire_meta_ad_account_sync_lease','release_meta_ad_account_sync_lease','ingest_meta_leadgen_event','record_lead_attribution_touchpoint','mark_lead_attribution_phone_match','retry_pending_lead_attribution'].map(n=>'public.'+n));
interface CatalogObject { kind: string; identity: string; owner: string; definition: string }

// Include definitions AND effective ACLs, policies, validation/enable flags,
// defaults, sequences and schema/default grants. Storage/Auth are watched too.
export function catalogObjects(sql: LocalSql, db: string): CatalogObject[] {
    return JSON.parse(sql(db,`SELECT coalesce(jsonb_agg(o ORDER BY kind,identity),'[]') FROM (
      SELECT 'relation' kind,n.nspname||'.'||c.relname identity,n.nspname||'.'||c.relname owner,
        concat_ws('|',c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.relacl,c.reloptions,
          CASE WHEN c.relkind='v' THEN pg_get_viewdef(c.oid,true) END) definition
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ${schemas} AND c.relkind IN ('r','p','v','S')
      UNION ALL SELECT 'column',n.nspname||'.'||c.relname||'.'||a.attname,n.nspname||'.'||c.relname,
        concat_ws('|',format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,a.attacl,pg_get_expr(d.adbin,d.adrelid))
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
        WHERE n.nspname IN ${schemas} AND c.relkind IN ('r','p','v') AND a.attnum>0 AND NOT a.attisdropped
      UNION ALL SELECT 'function',n.nspname||'.'||p.oid::regprocedure::text,n.nspname||'.'||p.proname,
        pg_get_functiondef(p.oid)||coalesce(p.proacl::text,'')||coalesce(obj_description(p.oid,'pg_proc'),'')
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ${schemas}
        AND p.prokind IN ('f','p') AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
      UNION ALL SELECT 'trigger',n.nspname||'.'||c.relname||'.'||t.tgname,n.nspname||'.'||c.relname,pg_get_triggerdef(t.oid,true)||'|'||t.tgenabled::text
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ${schemas} AND NOT t.tgisinternal
      UNION ALL SELECT 'policy',schemaname||'.'||tablename||'.'||policyname,schemaname||'.'||tablename,concat_ws('|',permissive,roles,cmd,qual,with_check)
        FROM pg_policies WHERE schemaname IN ${schemas}
      UNION ALL SELECT 'index',n.nspname||'.'||c.relname,tn.nspname||'.'||t.relname,pg_get_indexdef(i.indexrelid)||'|'||i.indisvalid
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace tn ON tn.oid=t.relnamespace WHERE n.nspname IN ${schemas}
      UNION ALL SELECT 'constraint',n.nspname||'.'||t.relname||'.'||c.conname,n.nspname||'.'||t.relname,pg_get_constraintdef(c.oid,true)||'|'||c.convalidated
        FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname IN ${schemas}
      UNION ALL SELECT 'schema_grant',n.nspname||':'||r.role||':'||p.privilege,n.nspname,has_schema_privilege(r.role,n.oid,p.privilege)::text
        FROM pg_namespace n CROSS JOIN (VALUES('anon'),('authenticated'),('service_role'))r(role)
        CROSS JOIN(VALUES('USAGE'),('CREATE'))p(privilege) WHERE n.nspname IN ${schemas}
      UNION ALL SELECT 'table_grant',n.nspname||'.'||c.relname||':'||r.role||':'||p.privilege,n.nspname||'.'||c.relname,has_table_privilege(r.role,c.oid,p.privilege)::text
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN(VALUES('anon'),('authenticated'),('service_role'))r(role)
        CROSS JOIN(VALUES('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'))p(privilege)
        WHERE n.nspname IN ${schemas} AND c.relkind IN ('r','p','v')
      UNION ALL SELECT 'function_grant',n.nspname||'.'||p.oid::regprocedure::text||':'||r.role,n.nspname||'.'||p.proname,has_function_privilege(r.role,p.oid,'EXECUTE')::text
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN(VALUES('anon'),('authenticated'),('service_role'))r(role)
        WHERE n.nspname IN ${schemas} AND p.prokind IN ('f','p')
      UNION ALL SELECT 'default_grant',coalesce(n.nspname,'*')||':'||d.defaclrole::regrole::text||':'||d.defaclobjtype::text,coalesce(n.nspname,'*'),d.defaclacl::text
        FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE n.nspname IN ${schemas} OR d.defaclnamespace=0
      UNION ALL SELECT 'sequence',n.nspname||'.'||c.relname,n.nspname||'.'||c.relname,concat_ws('|',s.seqtypid::regtype,s.seqstart,s.seqincrement,s.seqmax,s.seqmin,s.seqcache,s.seqcycle)
        FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ${schemas}
      UNION ALL SELECT 'type',n.nspname||'.'||t.typname,n.nspname||'.'||t.typname,concat_ws('|',t.typtype,t.typbasetype::regtype,t.typnotnull,t.typdefault,t.typacl,
        (SELECT string_agg(e.enumlabel,',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid))
        FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname IN ${schemas} AND t.typtype IN ('e','d')
    )o;`));
}

export function assertAllowedCatalogDiff(before: CatalogObject[], after: CatalogObject[]) {
    const old = new Map(before.map(o=>[o.kind+':'+o.identity,o]));
    const current = new Map(after.map(o=>[o.kind+':'+o.identity,o]));
    const changes = [...new Set([...old.keys(),...current.keys()])].sort().filter(key=>JSON.stringify(old.get(key))!==JSON.stringify(current.get(key)))
        .map(key=>({key,before:old.get(key)||null,after:current.get(key)||null}));
    for (const change of changes) {
        const a=change.after, b=change.before;
        const allowed=a && !b && (
            metaTables.has(a.owner) || (['function','function_grant'].includes(a.kind)&&metaFunctions.has(a.owner)) ||
            (a.kind==='column'&&a.owner==='public.customers'&&attributionColumns.some(c=>a.identity==='public.customers.'+c))
        );
        assert.ok(allowed,`Forbidden catalog change: ${change.key}`);
    }
    assert.equal(changes.filter(c=>c.after?.kind==='function').length,metaFunctions.size,'exactly the ten reviewed Meta RPCs, no overloads/helpers');
    assert.deepEqual(new Set(changes.filter(c=>c.after?.kind==='function').map(c=>c.after!.owner)),metaFunctions);
    assert.equal(changes.filter(c=>c.after?.kind==='relation').length,metaTables.size,'exactly seven Meta tables');
    return changes;
}

// Compare actual payloads and every pre-existing public/private table after the
// same Messenger/Website sequence. Each probe rolls back. Only generated UUIDs
// and the exact transaction timestamp are normalized; event timestamps, row
// multiplicity, statuses, content, return keys, grants and associations remain.
export function legacyObservableProbe(sql: LocalSql, db: string) {
    const company='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const cust='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', owner='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const calls=[
        ['messenger-new','FACEBOOK',"'7777777777777777:9999999999'",'msg-new','Fresh Messenger','NULL'],
        ['messenger-replay','FACEBOOK',"'7777777777777777:9999999999'",'msg-new','Fresh Messenger','NULL'],
        ['messenger-phone-conflict','FACEBOOK',"'7777777777777777:1111111111'",'msg-conflict','Existing Messenger',"'+843000000011'"],
        ['website-known-phone','WEBSITE','NULL','web-known','Website known phone',"'+843000000011'"],
        ['website-new','WEBSITE','NULL','web-new','Fresh Website','NULL'],
        ['website-replay','WEBSITE','NULL','web-new','Fresh Website','NULL'],
        ['idempotency-conflict','WEBSITE','NULL','web-new','Changed Website','NULL'],
        ['malformed-identity','FACEBOOK',"'bad'",'bad-id','Malformed','NULL'],
        ['invalid-phone','WEBSITE','NULL','bad-phone','Invalid phone',"'0300000011'"],
        ['zalo-on-shared-api','ZALO',"'zalo-id'",'zalo','Zalo unsupported here','NULL'],
    ];
    const callSql=(channel:string,external:string,key:string,name:string,phone:string)=>`public.han_ingest('${company}','${channel}',${external},'${key}','${name}',${phone},'Synthetic content','Synthetic content','SUCCEEDED','2026-10-30T00:00:00Z','{}')`;
    const entries=calls.map(([label,channel,external,key,name,phone])=>`BEGIN
      SET LOCAL ROLE service_role;
      v:=${callSql(channel,external,key,name,phone)};
      RESET ROLE;
      INSERT INTO observed VALUES('${label}',v);
      EXCEPTION WHEN OTHERS THEN INSERT INTO observed VALUES('${label}',jsonb_build_object('sqlstate',SQLSTATE,'error',SQLERRM)); END;`).join('\n');
    const denied=['anon','authenticated'].map(role=>`BEGIN SET LOCAL ROLE ${role}; v:=${callSql('WEBSITE','NULL','forbidden-'+role,'Forbidden','NULL')}; RESET ROLE;
      INSERT INTO observed VALUES('${role}',v);
      EXCEPTION WHEN OTHERS THEN INSERT INTO observed VALUES('${role}',jsonb_build_object('sqlstate',SQLSTATE,'error',SQLERRM)); END;`).join('\n');
    const data=JSON.parse(sql(db,`BEGIN;
      DO $$ BEGIN PERFORM setval('public.customer_code_seq',800000,false); END $$;
      CREATE TEMP TABLE observed(label text,value jsonb);
      CREATE TEMP TABLE observed_rows(name text,rows jsonb);
      INSERT INTO public.companies(id,name,status) VALUES('${company}','Legacy compatibility fixture','ACTIVE');
      INSERT INTO public.customers(id,company_id,customer_code,name,source,stage) VALUES
        ('${cust}','${company}','KH-FIXED-M','Existing Messenger','FACEBOOK','LEAD_NEW'),
        ('${owner}','${company}','KH-FIXED-P','Phone owner','FACEBOOK','LEAD_NEW');
      INSERT INTO public.identities(company_id,customer_id,channel,external_id) VALUES('${company}','${cust}','FACEBOOK','7777777777777777:1111111111');
      INSERT INTO private.customer_private_contacts(company_id,customer_id,normalized_phone,raw_phone) VALUES('${company}','${owner}','+843000000011','+843000000011');
      DO $probe$ DECLARE v jsonb; r record; BEGIN ${entries} ${denied}
        FOR r IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname IN ('public','private') AND c.relkind='r'
          AND c.relname NOT IN ('meta_ad_accounts','meta_campaigns','meta_ads','meta_lead_forms','lead_attribution_touchpoints','meta_ad_account_tokens','meta_leadgen_events')
        LOOP EXECUTE format('INSERT INTO observed_rows SELECT %L,coalesce(jsonb_agg(to_jsonb(t) - %L::text[]),''[]'') FROM %I.%I t',
          r.nspname||'.'||r.relname,CASE WHEN r.nspname='public' AND r.relname='customers' THEN ARRAY[${attributionColumns.map(c=>"'"+c+"'").join(',')}] ELSE ARRAY[]::text[] END,r.nspname,r.relname); END LOOP;
      END $probe$;
      SELECT jsonb_build_object('transactionTime',now(),'returns',(SELECT jsonb_object_agg(label,value) FROM observed),
        'tables',(SELECT jsonb_object_agg(name,rows) FROM observed_rows)); ROLLBACK;`));
    const ids=new Map<string,string>();
    const tables=data.tables as Record<string,Record<string,unknown>[]>;
    for (const table of ['public.customers','public.conversations','public.interactions','public.identities','public.customer_stage_histories','public.audit_logs','private.customer_private_contacts']) {
        for (const row of tables[table]||[]) {
            if(typeof row.id!=='string') continue;
            const key=row.name||row.external_conversation_id||row.external_ref||row.external_id||row.normalized_phone||
                [ids.get(String(row.customer_id))||row.customer_id,row.action,row.from_stage,row.to_stage,row.reason].join(':');
            ids.set(row.id,table+':'+key);
        }
    }
    const normalize=(v:unknown):unknown=>{
        if(typeof v==='string') return ids.get(v)||(v===data.transactionTime?'<transaction-time>':v);
        if(Array.isArray(v)) return v.map(normalize).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
        if(v&&typeof v==='object') return Object.fromEntries(Object.entries(v).filter(([k])=>k!=='transactionTime').sort(([a],[b])=>a.localeCompare(b)).map(([k,val])=>[k,normalize(val)]));
        return v;
    };
    const result=normalize(data) as typeof data;
    assert.deepEqual(Object.keys(result.returns['messenger-new']).sort(),['interaction_id','status']);
    assert.deepEqual(Object.keys(result.returns['website-new']).sort(),['interaction_id','status']);
    assert.equal(result.returns.anon.sqlstate,'42501');
    assert.equal(result.returns.authenticated.sqlstate,'42501');
    assert.equal(result.returns['idempotency-conflict'].error,'IDEMPOTENCY_CONFLICT');
    assert.equal(result.tables['private.han_outbox'].length,0);
    assert.equal(result.tables['public.care_deliveries'].length,0);
    return result;
}
