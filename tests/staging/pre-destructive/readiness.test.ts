import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { buildLedgerReadinessPlan, inspectTransactionEnvelope, sqlSha256 } from '../../../scripts/meta-ads/ledger-readiness';
import { encryptSyntheticBackup, decryptSyntheticBackup } from '../../../scripts/meta-ads/synthetic-backup';
import { randomBytes } from 'node:crypto';

test('all canonical source bytes have a reviewable transaction envelope and preserve the 21-entry mapping',()=>{
  const files=readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).map(file=>({file,sql:readFileSync('supabase/migrations/'+file,'utf8')}));
  // pull_request CI also includes base-branch migrations. Pin the historical
  // audit assertions to its exact manifest, then inspect the complete checkout.
  const manifest: {file:string;sha256:string}[]=JSON.parse(readFileSync('docs/evidence/meta-ads-pre-destructive/ledger-readiness-plan.json','utf8')).allSources;
  assert.equal(manifest.length,116);
  const audited=manifest.map(m=>{
    const source=files.find(f=>f.file===m.file);
    assert.ok(source,`audited source missing: ${m.file}`);
    assert.equal(sqlSha256(source.sql),m.sha256,`audited source changed: ${m.file}`);
    return source;
  });
  const history=JSON.parse(readFileSync('docs/evidence/meta-ads-staging/staging-history.json','utf8')).migrations;
  const before=JSON.stringify(history),plan=buildLedgerReadinessPlan(audited,history);
  assert.deepEqual(plan.errors,[]);assert.equal(plan.prefixCandidates.length,21);assert.equal(plan.pending.length,95);
  assert.equal(plan.executionAuthorized,false);assert.equal(JSON.stringify(history),before);
  assert.ok(plan.prefixCandidates.every(p=>p.requiresSchemaVerification&&!p.sourceHashIsHistoricalAttestation));
  const profiles=audited.map(f=>inspectTransactionEnvelope(f.sql));
  assert.equal(profiles.reduce((n,p)=>n+p.statements.length,0),2277);
  assert.equal(profiles.filter(p=>p.mode==='OUTER').length,24);assert.equal(profiles.filter(p=>p.mode==='NONE').length,92);
  assert.ok(profiles.every(p=>p.mode!=='REJECT'));
  const checkoutPlan=buildLedgerReadinessPlan(files,history);
  assert.deepEqual(checkoutPlan.errors,[]);
  assert.ok(plan.pending.every(p=>checkoutPlan.pending.some(c=>c.file===p.file&&c.sha256===p.sha256)));
  assert.ok(checkoutPlan.pending.every(p=>p.transactionMode!=='REJECT'));
  assert.equal(checkoutPlan.executionAuthorized,false);
  const unknown=buildLedgerReadinessPlan(files,[...history,{version:'20990101000000',name:'unknown_source'}]);
  assert.ok(unknown.errors.length>0);assert.equal(unknown.executionAuthorized,false);
});

test('transaction inspection handles bodies, strings, Unicode and nested comments without hiding intermediate commits',()=>{
  const sql="-- tiếng Việt\nBEGIN; CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN RAISE NOTICE 'COMMIT;'; END $body$; /* outer /* nested */ */ COMMIT; -- preserved";
  const r=inspectTransactionEnvelope(sql);assert.equal(r.mode,'OUTER');assert.equal(r.statements.length,3);
  assert.equal(inspectTransactionEnvelope("SELECT E'escaped\\\'COMMIT;';").statements.length,1);
  assert.equal(inspectTransactionEnvelope('BEGIN; INSERT INTO t VALUES(1); COMMIT; INSERT INTO t VALUES(2);').mode,'REJECT');
  assert.equal(inspectTransactionEnvelope('BEGIN; COMMIT; BEGIN; COMMIT;').mode,'REJECT');
  assert.equal(inspectTransactionEnvelope('CREATE INDEX CONCURRENTLY i ON t(id);').mode,'REJECT');
  assert.equal(inspectTransactionEnvelope('DROP TABLE t;').destructive,true);
  assert.throws(()=>inspectTransactionEnvelope("SELECT 'unterminated"),/UNTERMINATED/);
  assert.notEqual(sqlSha256('SELECT 1;'),sqlSha256('SELECT 1;\n'));
});

test('synthetic backup envelope authenticates ciphertext and key; never returns damaged plaintext',()=>{
  const key=randomBytes(32),data=Buffer.from('synthetic archive only');
  const encrypted=encryptSyntheticBackup(data,key);
  assert.ok(!encrypted.includes(data));assert.deepEqual(decryptSyntheticBackup(encrypted,key),data);
  assert.throws(()=>decryptSyntheticBackup(encrypted,randomBytes(32)),/AUTHENTICATION/);
  const tampered=Buffer.from(encrypted);tampered[tampered.length-1]^=1;
  assert.throws(()=>decryptSyntheticBackup(tampered,key),/AUTHENTICATION/);
  assert.throws(()=>decryptSyntheticBackup(Buffer.from('bad envelope'),key),/INVALID/);
});
