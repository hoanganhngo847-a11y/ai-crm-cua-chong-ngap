/** Offline package builder. No database/network client, credentials or executor. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { inspectTransactionEnvelope, sqlSha256 } from './ledger-readiness';

export const META_21_SOURCES = [
    '20261030090000_meta_ads_lead_attribution.sql',
    '20261030100000_meta_ads_hardening.sql',
    '20261030110000_meta_ads_final_remediation.sql',
    '20261030120000_meta_ads_attribution_rpc_security.sql',
    '20261030130000_meta_ads_phone_duplicate_history.sql',
] as const;
const evidence='docs/evidence/meta-ads-21-prefix';
const quote=(s:string)=>`'${s.replaceAll("'","''")}'`;
const columns=['first_campaign_name','first_ad_name','first_touch_at','latest_campaign_name','latest_ad_name','latest_touch_at','attribution_status'];

export function prepareMeta21Package() {
    const current=JSON.parse(readFileSync('docs/evidence/meta-ads-final-scope/migration-manifest.json','utf8'));
    const proof=JSON.parse(readFileSync(`${evidence}/compatibility.json`,'utf8'));
    const recorded=JSON.parse(readFileSync('docs/evidence/meta-ads-safe-deployment/staging-metadata.json','utf8')).data[0].snapshot.migration_history;
    const fingerprint=readFileSync('docs/evidence/meta-ads-safe-deployment/catalog-fingerprint.sql','utf8').replace(/;\s*$/,'');
    const sources=META_21_SOURCES.map(file=>{
        const sql=readFileSync('supabase/migrations/'+file,'utf8');
        const sha256=sqlSha256(sql), envelope=inspectTransactionEnvelope(sql);
        assert.equal(current.allSources.find((m:{file:string})=>m.file===file)?.sha256,sha256);
        assert.notEqual(envelope.mode,'REJECT');
        assert.doesNotMatch(sql,/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(?:han_ingest|seed_messenger_pages_canary|open_response_sla_window)\s*\(/i);
        return {file,sha256,sql,body:envelope.mode==='OUTER'?sql.slice(envelope.statements[0].end,envelope.statements.at(-1)!.start):sql};
    });
    const expectedLedger=recorded.map((m:{version:string;name:string;stored_sql_sha256:string})=>({version:m.version,name:m.name,source_hash:m.stored_sql_sha256}));
    const preconditions=`-- Review/rehearsal input only. Hosted deployment is BLOCKED pending ledger integration review.
-- Must run in the SAME transaction as the five sources and postconditions.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('meta-ads-21-prefix-package',0));
LOCK TABLE supabase_migrations.schema_migrations IN SHARE MODE;
DO $preflight$ DECLARE actual jsonb; v_table_row record; BEGIN
  SELECT jsonb_agg(jsonb_build_object('version',version,'name',name,
    'source_hash',encode(sha256(convert_to(array_to_string(statements,E'\\n'),'UTF8')),'hex')) ORDER BY version)
    INTO actual FROM supabase_migrations.schema_migrations;
  IF actual IS DISTINCT FROM ${quote(JSON.stringify(expectedLedger))}::jsonb THEN RAISE EXCEPTION 'META_21_LEDGER_DRIFT'; END IF;
  SELECT jsonb_agg(f ORDER BY category) INTO actual FROM (${fingerprint}) f;
  IF actual IS DISTINCT FROM ${quote(JSON.stringify(proof.prefixCatalog))}::jsonb THEN RAISE EXCEPTION 'META_21_SCHEMA_OR_ACL_DRIFT'; END IF;
  -- Block concurrent application writes during count/hash preservation checks.
  FOR v_table_row IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private') AND c.relkind='v_table_row' ORDER BY n.nspname,c.relname
  LOOP EXECUTE format('LOCK TABLE %I.%I IN SHARE MODE',v_table_row.nspname,v_table_row.relname); END LOOP;
END $preflight$;
CREATE TEMP TABLE meta_21_rows(name text PRIMARY KEY, row_count bigint, digest text) ON COMMIT DROP;
CREATE TEMP TABLE meta_21_ledger ON COMMIT DROP AS SELECT * FROM supabase_migrations.schema_migrations;
DO $checkpoint$ DECLARE v_table_row record; excluded text[]; BEGIN
  FOR v_table_row IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private') AND c.relkind='v_table_row' LOOP
    excluded:=CASE WHEN v_table_row.nspname='public' AND v_table_row.relname='customers' THEN ARRAY[${columns.map(quote).join(',')}] ELSE ARRAY[]::text[] END;
    EXECUTE format('INSERT INTO meta_21_rows SELECT %L,count(*),encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) - %L::text[] ORDER BY (to_jsonb(t) - %L::text[])::text),''[]'')::text,''UTF8'')),''hex'') FROM %I.%I t',
      v_table_row.nspname||'.'||v_table_row.relname,excluded,excluded,v_table_row.nspname,v_table_row.relname);
  END LOOP;
END $checkpoint$;
`;
    const postconditions=`DO $postflight$ DECLARE actual jsonb; v_table_row record; v_count bigint; v_digest text; excluded text[]; BEGIN
  SELECT jsonb_agg(f ORDER BY category) INTO actual FROM (${fingerprint}) f;
  IF actual IS DISTINCT FROM ${quote(JSON.stringify(proof.afterCatalog))}::jsonb THEN RAISE EXCEPTION 'META_21_POST_SCHEMA_OR_ACL_MISMATCH'; END IF;
  IF EXISTS((SELECT * FROM supabase_migrations.schema_migrations EXCEPT SELECT * FROM meta_21_ledger)
    UNION ALL (SELECT * FROM meta_21_ledger EXCEPT SELECT * FROM supabase_migrations.schema_migrations)) THEN RAISE EXCEPTION 'META_21_LEDGER_CHANGED'; END IF;
  FOR v_table_row IN SELECT * FROM meta_21_rows LOOP
    excluded:=CASE WHEN v_table_row.name='public.customers' THEN ARRAY[${columns.map(quote).join(',')}] ELSE ARRAY[]::text[] END;
    EXECUTE format('SELECT count(*),encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) - %L::text[] ORDER BY (to_jsonb(t) - %L::text[])::text),''[]'')::text,''UTF8'')),''hex'') FROM %s t',excluded,excluded,v_table_row.name) INTO v_count,v_digest;
    IF v_count<>v_table_row.row_count OR v_digest IS DISTINCT FROM v_table_row.digest THEN RAISE EXCEPTION 'META_21_EXISTING_ROWS_CHANGED'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM private.meta_ad_account_tokens) OR EXISTS(SELECT 1 FROM private.meta_leadgen_events)
    OR EXISTS(SELECT 1 FROM public.meta_ad_accounts) OR EXISTS(SELECT 1 FROM public.meta_campaigns)
    OR EXISTS(SELECT 1 FROM public.meta_ads) OR EXISTS(SELECT 1 FROM public.meta_lead_forms)
    OR EXISTS(SELECT 1 FROM public.lead_attribution_touchpoints) THEN RAISE EXCEPTION 'META_21_UNEXPECTED_SEED_DATA'; END IF;
END $postflight$;
-- Return counts only, never token/ciphertext values or row digests.
SELECT 'META_21_POSTCONDITIONS_VERIFIED' AS status,count(*) AS preserved_legacy_tables FROM meta_21_rows;
`;
    const sql='BEGIN;\n'+preconditions+sources.map(s=>`\n-- SOURCE ${s.file} SHA256 ${s.sha256}\n${s.body}\n`).join('')+postconditions+'\nCOMMIT;\n';
    assert.equal(inspectTransactionEnvelope(sql).mode,'OUTER');
    const manifest={referenceCommit:'3bc50257883957f05cd1fedbd8f57358e058dcee',executionAuthorized:false,
        status:'BLOCKED',reason:'SQL compatibility is proven; existing deployment tooling requires a canonical prefix. No selective-release ledger integration is implemented or validated.',
        canonicalLedgerWrites:0,unrelatedGapMigrationsExecuted:0,omittedCanonicalMigrations:95,
        ledgerStrategy:'Keep the 21 real recorded rows untouched. This is a rehearsal bundle, not a supabase db push input. A separately reviewed selective-release registry and future canonical reconciliation are required before hosted execution.',
        sources:sources.map(({file,sha256})=>({file:'sources/'+file,repositorySource:'supabase/migrations/'+file,sha256})),
        bundleSha256:sqlSha256(sql),preconditionsSha256:sqlSha256(preconditions),postconditionsSha256:sqlSha256(postconditions),
        expectedObjects:proof.catalogDiff.map((c:{key:string})=>c.key),
        expectedMetaRows:0,existingRows:'Exact counts and hashes preserved, excluding only the seven approved attribution columns on customers.',
        tokenVerification:'Exact prefix has no Meta token/account rows. Any existing/partial Meta objects or schema drift stops before DDL. Populated token transfers require the separate offline key verifier before and after; protections from 3bc5025 are unchanged.'};
    return {manifest,sql,preconditions,postconditions,sources};
}

if(process.argv[1]?.endsWith('prepare-21-prefix-package.ts')) {
    const output=process.argv[2];
    assert.ok(output,'An explicit output directory is required; builder never executes SQL.');
    const target=resolve(output);
    assert.notEqual(target,resolve('.'));
    const pack=prepareMeta21Package();
    mkdirSync(join(target,'sources'),{recursive:true});
    for(const source of pack.sources) writeFileSync(join(target,'sources',source.file),source.sql);
    writeFileSync(join(target,'package.json'),JSON.stringify(pack.manifest,null,2)+'\n');
    writeFileSync(join(target,'ordered-bundle.sql'),pack.sql);
    writeFileSync(join(target,'00-preconditions.sql'),pack.preconditions);
    writeFileSync(join(target,'90-postconditions.sql'),pack.postconditions);
    console.info(JSON.stringify({status:pack.manifest.status,executionAuthorized:false,sources:pack.sources.length,output:target}));
}
