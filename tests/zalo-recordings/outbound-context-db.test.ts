import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { reconcileAuthUserFixture } from '../helpers/auth-fixture';
import { cleanupCompanyFixtures, executeRawSql } from '../helpers/fixture-cleanup';
import { RECORDING_BUCKET } from '../../features/zalo-recordings/upload';
import { sha256, type RecordingMetadata } from '../../features/zalo-recordings/metadata';
import { audioFixture, metadataFixture } from './fixture';

const url = process.env.ZALO_RECORDING_TEST_URL || 'http://127.0.0.1:54321';
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Local Supabase required');
const service = process.env.ZALO_RECORDING_TEST_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const anon = process.env.ZALO_RECORDING_TEST_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

async function main() {
  const company = randomUUID(), other = randomUUID(), paths: string[] = [], users: string[] = [];
  const saleDev = randomUUID(), saleSecret = randomBytes(32).toString('base64url');
  const bossDev = randomUUID(), bossSecret = randomBytes(32).toString('base64url');
  const sharedDev = randomUUID(), sharedSecret = randomBytes(32).toString('base64url');
  const foreignDev = randomUUID(), foreignSecret = randomBytes(32).toString('base64url');
  const audio = audioFixture(), bucket = admin.storage.from(RECORDING_BUCKET);
  const password = randomBytes(24).toString('base64url') + 'Aa1!';

  const makeMeta = (dev: string, reqId?: string, started?: Date): RecordingMetadata => {
    const start = started || new Date(), end = new Date(start.getTime() + 2000);
    return {
      ...metadataFixture(dev),
      direction: reqId ? 'OUTBOUND' : 'INBOUND',
      ...(reqId ? { crm_call_request_id: reqId } : {}),
      started_at: start.toISOString(),
      ended_at: end.toISOString(),
      duration_seconds: 2,
    };
  };

  try {
    const { error: cErr } = await admin.from('companies').insert([{ id: company, name: 'Outbound Hardening Fixture' }, { id: other, name: 'Outbound Foreign Fixture' }]);
    assert.ifError(cErr);

    const makeUser = async (role: 'SALE' | 'BOSS_ADMIN' | 'TECHNICIAN', tenant = company) => {
      const email = `outbound-${randomUUID()}@example.test`;
      const id = await reconcileAuthUserFixture(admin, { email, password, fullName: 'Outbound Actor', companyId: tenant, role });
      users.push(id);
      const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error } = await client.auth.signInWithPassword({ email, password });
      assert.ifError(error);
      return { id, client, email };
    };

    const okRpc = async (fn: string, params: Record<string, any>) => {
      const { data, error } = await admin.rpc(fn, params);
      assert.ifError(error);
      return data;
    };

    const boss = await makeUser('BOSS_ADMIN'), sale = await makeUser('SALE');
    const foreignBoss = await makeUser('BOSS_ADMIN', other), foreignSale = await makeUser('SALE', other);
    const tech = await makeUser('TECHNICIAN');

    assert.ifError((await admin.rpc('zalo_manage_device', { p_company: company, p_actor: boss.id, p_device: saleDev, p_name: 'Sale Mac', p_hash: sha256(saleSecret), p_staff: sale.id })).error);
    assert.ifError((await admin.rpc('zalo_manage_device', { p_company: company, p_actor: boss.id, p_device: bossDev, p_name: 'Boss Mac', p_hash: sha256(bossSecret), p_staff: boss.id })).error);
    assert.ifError((await admin.rpc('zalo_manage_device', { p_company: company, p_actor: boss.id, p_device: sharedDev, p_name: 'Shared Mac', p_hash: sha256(sharedSecret), p_staff: null })).error);
    assert.ifError((await admin.rpc('zalo_manage_device', { p_company: other, p_actor: foreignBoss.id, p_device: foreignDev, p_name: 'Foreign Mac', p_hash: sha256(foreignSecret), p_staff: foreignSale.id })).error);

    const { data: customer, error: custErr } = await admin.from('customers').insert({ company_id: company, name: 'Lương Thắng', source: 'ZALO', stage: 'LEAD_NEW' }).select('id').single();
    assert.ifError(custErr);

    // Case 1: Boss explicit Sale device target -> race 2 claims, strict progression, mismatch & cross-company rejection
    const { data: cr1, error: cr1Err } = await admin.rpc('zalo_create_outbound_call_request', { p_company: company, p_actor: boss.id, p_customer: customer!.id, p_device: saleDev });
    assert.ifError(cr1Err);
    const req1 = cr1.request_id;
    executeRawSql(`UPDATE public.zalo_outbound_call_requests SET phone_normalized='+84912345678' WHERE id='${req1}';`);

    const claimArgs = { p_device: saleDev, p_key_hash: sha256(saleSecret), p_request_id: req1 };
    const [cWin, cLose] = await Promise.all([admin.rpc('zalo_claim_outbound_call_request', claimArgs), admin.rpc('zalo_claim_outbound_call_request', claimArgs)]);
    const claims = [cWin, cLose];
    assert.equal(claims.filter(r => !r.error && r.data?.id === req1).length, 1);
    assert.equal(claims.filter(r => r.error && r.error.message.includes('ZALO_REQUEST_ALREADY_CLAIMED')).length, 1);
    const winClaim = claims.find(r => !r.error)!.data;
    assert.equal(winClaim.phone_normalized, '+84912345678');

    const updateStatus = (s: string) => admin.rpc('zalo_update_outbound_call_status', { p_device: saleDev, p_key_hash: sha256(saleSecret), p_request_id: req1, p_status: s });
    assert.ok((await updateStatus('CALL_TRIGGERED')).error); // Jump before CONTACT_VERIFIED forbidden
    assert.ifError((await updateStatus('OPENING_ZALO')).error);
    assert.ifError((await updateStatus('CONTACT_VERIFIED')).error);
    assert.ifError((await updateStatus('CALL_TRIGGERED')).error);
    assert.ifError((await updateStatus('CALL_DETECTED')).error);
    assert.ifError((await updateStatus('CALL_DETECTED')).error); // Idempotent same-state
    assert.ok((await updateStatus('COMPLETED')).error); // Direct client COMPLETED forbidden

    // Sale implicit request claimed by Boss device -> STAFF_MISMATCH; Cross-company device -> NOT_FOUND
    const cr2 = await okRpc('zalo_create_outbound_call_request', { p_company: company, p_actor: sale.id, p_customer: customer!.id });
    const req2 = cr2.request_id;
    executeRawSql(`UPDATE public.zalo_outbound_call_requests SET phone_normalized='+84987654321' WHERE id='${req2}';`);
    assert.ok((await admin.rpc('zalo_claim_outbound_call_request', { p_device: bossDev, p_key_hash: sha256(bossSecret), p_request_id: req2 })).error?.message.includes('ZALO_REQUEST_STAFF_MISMATCH'));
    assert.ok((await admin.rpc('zalo_claim_outbound_call_request', { p_device: foreignDev, p_key_hash: sha256(foreignSecret), p_request_id: req2 })).error);

    // Case 2: PostgREST JWT column restrictions & RLS isolation; shared device outbound staff attachment
    const { data: saleRows, error: sErr } = await sale.client.from('zalo_outbound_call_requests').select('id, status').eq('id', req2);
    assert.ifError(sErr);
    assert.equal(saleRows?.length, 1);
    const { error: phoneColErr } = await sale.client.from('zalo_outbound_call_requests').select('phone_normalized').eq('id', req2);
    assert.ok(phoneColErr?.code === '42501' || phoneColErr?.message.toLowerCase().includes('permission denied'));
    const { error: rpcPermErr } = await sale.client.rpc('zalo_create_outbound_call_request', { p_company: company, p_actor: sale.id, p_customer: customer!.id });
    assert.ok(rpcPermErr?.code === '42501' || rpcPermErr?.message.includes('42501') || rpcPermErr?.message.toLowerCase().includes('permission denied'));
    const { data: fRows, error: fErr } = await foreignSale.client.from('zalo_outbound_call_requests').select('id').eq('id', req2);
    assert.ifError(fErr);
    assert.equal(fRows?.length, 0);
    const { data: tRows, error: tErr } = await tech.client.from('zalo_outbound_call_requests').select('id').eq('id', req2);
    assert.ifError(tErr);
    assert.equal(tRows?.length, 0);

    const sReq = await okRpc('zalo_create_outbound_call_request', { p_company: company, p_actor: sale.id, p_customer: customer!.id, p_device: sharedDev });
    await okRpc('zalo_claim_outbound_call_request', { p_device: sharedDev, p_key_hash: sha256(sharedSecret), p_request_id: sReq.request_id });
    await okRpc('zalo_update_outbound_call_status', { p_device: sharedDev, p_key_hash: sha256(sharedSecret), p_request_id: sReq.request_id, p_status: 'OPENING_ZALO' });
    await okRpc('zalo_update_outbound_call_status', { p_device: sharedDev, p_key_hash: sha256(sharedSecret), p_request_id: sReq.request_id, p_status: 'CONTACT_VERIFIED' });
    await okRpc('zalo_update_outbound_call_status', { p_device: sharedDev, p_key_hash: sha256(sharedSecret), p_request_id: sReq.request_id, p_status: 'CALL_DETECTED' });
    const sMeta = makeMeta(sharedDev, sReq.request_id);
    const sRes = await okRpc('zalo_reserve_recording', { p_device: sharedDev, p_key_hash: sha256(sharedSecret), p_metadata: sMeta, p_checksum: sha256(audio), p_bytes: audio.length, p_fingerprint: sha256(JSON.stringify(sMeta)) });
    paths.push(sRes.path);
    assert.ifError((await bucket.upload(sRes.path, audio, { contentType: 'audio/mp4', upsert: false })).error);
    assert.ifError((await admin.rpc('zalo_finish_recording', { p_device: sharedDev, p_key_hash: sha256(sharedSecret), p_call: sRes.call_id, p_lease: sRes.lease })).error);
    const { data: sharedCall } = await sale.client.from('zalo_personal_calls').select('id, staff_user_id').eq('id', sRes.call_id);
    assert.equal(sharedCall?.length, 1);
    assert.equal(sharedCall[0].staff_user_id, sale.id);
    assert.equal((await foreignSale.client.from('zalo_personal_calls').select('id').eq('id', sRes.call_id)).data?.length, 0);

    // Case 3: Real race across 5 rounds: 4 parallel reserve -> 1 lease 3 in_progress, 4 parallel finish -> 1 false 3 true, audit=1, reuse rejected, exact replay
    for (let round = 0; round < 5; round++) {
      const roundCr = await okRpc('zalo_create_outbound_call_request', { p_company: company, p_actor: boss.id, p_customer: customer!.id, p_device: saleDev });
      const rId = roundCr.request_id;
      await okRpc('zalo_claim_outbound_call_request', { p_device: saleDev, p_key_hash: sha256(saleSecret), p_request_id: rId });
      await okRpc('zalo_update_outbound_call_status', { p_device: saleDev, p_key_hash: sha256(saleSecret), p_request_id: rId, p_status: 'OPENING_ZALO' });
      await okRpc('zalo_update_outbound_call_status', { p_device: saleDev, p_key_hash: sha256(saleSecret), p_request_id: rId, p_status: 'CONTACT_VERIFIED' });
      await okRpc('zalo_update_outbound_call_status', { p_device: saleDev, p_key_hash: sha256(saleSecret), p_request_id: rId, p_status: 'CALL_DETECTED' });

      const meta = makeMeta(saleDev, rId);
      const reserveParams = { p_device: saleDev, p_key_hash: sha256(saleSecret), p_metadata: meta, p_checksum: sha256(audio), p_bytes: audio.length, p_fingerprint: sha256(JSON.stringify(meta)) };
      const reserves = await Promise.all(Array.from({ length: 4 }, () => admin.rpc('zalo_reserve_recording', reserveParams)));
      reserves.forEach(r => assert.ifError(r.error));
      assert.equal(reserves.filter(r => r.data.lease).length, 1);
      assert.equal(reserves.filter(r => r.data.in_progress).length, 3);
      const lease = reserves.find(r => r.data.lease)!.data;
      paths.push(lease.path);

      assert.ifError((await bucket.upload(lease.path, audio, { contentType: 'audio/mp4', upsert: false })).error);
      const finishes = await Promise.all(Array.from({ length: 4 }, () => admin.rpc('zalo_finish_recording', { p_device: saleDev, p_key_hash: sha256(saleSecret), p_call: lease.call_id, p_lease: lease.lease })));
      finishes.forEach(r => assert.ifError(r.error));
      assert.equal(finishes.filter(r => r.data.duplicate === false).length, 1);
      assert.equal(finishes.filter(r => r.data.duplicate === true).length, 3);

      const { data: callRow } = await admin.from('zalo_personal_calls').select('*').eq('id', lease.call_id).single();
      assert.equal(callRow.customer_id, customer!.id);
      assert.equal(callRow.matching_status, 'EXACT');
      assert.equal(callRow.recording_status, 'READY');
      const { data: reqRow, error: reqError } = await admin.from('zalo_outbound_call_requests').select('status').eq('id', rId).single();
      assert.ifError(reqError);
      assert.ok(reqRow);
      assert.equal(reqRow.status, 'COMPLETED');
      const { count: auditCount } = await admin.from('audit_logs').select('id', { head: true, count: 'exact' }).eq('resource_id', lease.call_id).eq('action', 'ZALO_RECORDING_READY');
      assert.equal(auditCount, 1);

      const reuseMeta = makeMeta(saleDev, rId);
      const { error: reuseErr } = await admin.rpc('zalo_reserve_recording', { p_device: saleDev, p_key_hash: sha256(saleSecret), p_metadata: reuseMeta, p_checksum: sha256(audio), p_bytes: audio.length, p_fingerprint: sha256(JSON.stringify(reuseMeta)) });
      assert.ok(reuseErr?.message.includes('ZALO_REQUEST_REUSED'));

      const { data: replayData, error: replayErr } = await admin.rpc('zalo_reserve_recording', reserveParams);
      assert.ifError(replayErr);
      assert.equal(replayData.duplicate, true);
      assert.equal(replayData.call_id, lease.call_id);
    }

    // Case 4: Backdated request >120s past expires_at with call started within validity window succeeds; pre-claim timing rejected
    const trCr = await okRpc('zalo_create_outbound_call_request', { p_company: company, p_actor: boss.id, p_customer: customer!.id, p_device: saleDev });
    const tId = trCr.request_id;
    await okRpc('zalo_claim_outbound_call_request', { p_device: saleDev, p_key_hash: sha256(saleSecret), p_request_id: tId });
    await okRpc('zalo_update_outbound_call_status', { p_device: saleDev, p_key_hash: sha256(saleSecret), p_request_id: tId, p_status: 'OPENING_ZALO' });
    await okRpc('zalo_update_outbound_call_status', { p_device: saleDev, p_key_hash: sha256(saleSecret), p_request_id: tId, p_status: 'CONTACT_VERIFIED' });
    await okRpc('zalo_update_outbound_call_status', { p_device: saleDev, p_key_hash: sha256(saleSecret), p_request_id: tId, p_status: 'CALL_DETECTED' });
    executeRawSql(`UPDATE public.zalo_outbound_call_requests SET created_at = now() - interval '10 minutes', claimed_at = now() - interval '9 minutes', expires_at = now() - interval '5 minutes' WHERE id = '${tId}';`);

    const badTimingMeta = {
      ...metadataFixture(saleDev),
      direction: 'OUTBOUND' as const,
      crm_call_request_id: tId,
      started_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      ended_at: new Date(Date.now() - 15 * 60 * 1000 + 2000).toISOString(),
      duration_seconds: 2,
    };
    const { error: badTimingErr } = await admin.rpc('zalo_reserve_recording', { p_device: saleDev, p_key_hash: sha256(saleSecret), p_metadata: badTimingMeta, p_checksum: sha256(audio), p_bytes: audio.length, p_fingerprint: sha256(JSON.stringify(badTimingMeta)) });
    assert.ok(badTimingErr?.message.includes('ZALO_REQUEST_TIMING_INVALID'));

    const pastStart = new Date(Date.now() - 7 * 60 * 1000);
    const pastMeta = {
      ...metadataFixture(saleDev),
      direction: 'OUTBOUND' as const,
      crm_call_request_id: tId,
      started_at: pastStart.toISOString(),
      ended_at: new Date(pastStart.getTime() + 2000).toISOString(),
      duration_seconds: 2,
    };
    const pastReserve = await okRpc('zalo_reserve_recording', { p_device: saleDev, p_key_hash: sha256(saleSecret), p_metadata: pastMeta, p_checksum: sha256(audio), p_bytes: audio.length, p_fingerprint: sha256(JSON.stringify(pastMeta)) });
    paths.push(pastReserve.path);
    assert.ifError((await bucket.upload(pastReserve.path, audio, { contentType: 'audio/mp4', upsert: false })).error);
    const { data: pastFinish, error: pastFinErr } = await admin.rpc('zalo_finish_recording', { p_device: saleDev, p_key_hash: sha256(saleSecret), p_call: pastReserve.call_id, p_lease: pastReserve.lease });
    assert.ifError(pastFinErr);
    assert.equal(pastFinish.duplicate, false);

    // Case 5: Real actor revocation fail-closed with 42501
    const revCr = await okRpc('zalo_create_outbound_call_request', { p_company: company, p_actor: boss.id, p_customer: customer!.id, p_device: saleDev });
    executeRawSql(`UPDATE public.company_members SET status = 'INACTIVE' WHERE user_id = '${sale.id}' AND company_id = '${company}';`);
    const { error: revErr } = await admin.rpc('zalo_claim_outbound_call_request', { p_device: saleDev, p_key_hash: sha256(saleSecret), p_request_id: revCr.request_id });
    assert.ok(revErr?.code === '42501' || revErr?.message.includes('42501'));
    executeRawSql(`UPDATE public.company_members SET status = 'ACTIVE' WHERE user_id = '${sale.id}' AND company_id = '${company}';`);

    console.log('PASS outbound context DB hardening: atomic claim race, strict transitions, staff/device/cross-tenant isolation, 5x parallel reserve/finish concurrency, timing window proof, and actor revocation.');
  } finally {
    const { data: remainingCalls } = await admin.from('zalo_personal_calls').select('recording_path').in('company_id', [company, other]);
    const allPaths = [...new Set([...paths, ...(remainingCalls || []).map(r => r.recording_path).filter(Boolean)])];
    if (allPaths.length) await admin.storage.from(RECORDING_BUCKET).remove(allPaths);
    executeRawSql(`
      DELETE FROM public.zalo_personal_calls WHERE company_id IN ('${company}', '${other}');
      DELETE FROM public.zalo_outbound_call_requests WHERE company_id IN ('${company}', '${other}');
    `);
    cleanupCompanyFixtures([company, other], { deleteMembers: true, deleteCompany: true });
    for (const u of users) {
      await admin.from('user_profiles').delete().eq('id', u);
      await admin.auth.admin.deleteUser(u);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
