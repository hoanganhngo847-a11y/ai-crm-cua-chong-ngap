import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from 'typescript';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createPgliteSupabase } from '../zalo/helpers/pglite-supabase';
import { sha256, type RecordingMetadata } from '../../features/zalo-recordings/metadata';
import { audioFixture, metadataFixture } from './fixture';

let currentActor = { userId: '', companyId: '', role: 'SALE' as 'BOSS_ADMIN' | 'SALE' };

function rpcOk<T = any>(res: { data: T; error: any }): T {
  assert.ifError(res.error);
  return res.data;
}

function assertNoPhone(obj: any) {
  const str = JSON.stringify(obj);
  assert.equal(str.includes('+84901234567'), false, 'Found synthetic normalized phone in output');
  assert.equal(str.includes('0901234567'), false, 'Found synthetic raw phone in output');
  const inspectKeys = (val: any) => {
    if (!val || typeof val !== 'object') return;
    for (const key of Object.keys(val)) {
      assert.equal(key.toLowerCase().includes('phone'), false, `Found phone key: ${key}`);
      inspectKeys(val[key]);
    }
  };
  inspectKeys(obj);
}

async function putStorageObject(db: any, path: string, size: number) {
  await db.query(
    `INSERT INTO storage.objects(bucket_id, name, metadata) VALUES('zalo-call-recordings', $1, $2)`,
    [path, JSON.stringify({ size })]
  );
}

async function transitionToTriggered(h: any, deviceId: string, secret: string, reqId: string) {
  const hash = sha256(secret);
  rpcOk(await h.client.rpc('zalo_claim_outbound_call_request', { p_device: deviceId, p_key_hash: hash, p_request_id: reqId }));
  rpcOk(await h.client.rpc('zalo_update_outbound_call_status', { p_device: deviceId, p_key_hash: hash, p_request_id: reqId, p_status: 'OPENING_ZALO' }));
  rpcOk(await h.client.rpc('zalo_update_outbound_call_status', { p_device: deviceId, p_key_hash: hash, p_request_id: reqId, p_status: 'CONTACT_VERIFIED' }));
  rpcOk(await h.client.rpc('zalo_update_outbound_call_status', { p_device: deviceId, p_key_hash: hash, p_request_id: reqId, p_status: 'CALL_TRIGGERED' }));
}

function loadAppModule(filePath: string, adminClient: SupabaseClient) {
  const code = readFileSync(filePath, 'utf8');
  const transpiled = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const baseReq = createRequire(filePath);
  const customRequire = (spec: string) => {
    if (spec === 'server-only') return {};
    if (spec.includes('supabase/admin')) return { createAdminClient: () => adminClient };
    if (spec.includes('zalo-recordings/access')) {
      const real = baseReq(spec);
      return {
        ...real,
        recordingActor: async () => ({ ...currentActor }),
        authorizedRecording: (id: string) => real.authorizedRecording(id),
      };
    }
    return baseReq(spec);
  };
  const mod = { exports: {} as any };
  new Function('require', 'module', 'exports', transpiled)(customRequire, mod, mod.exports);
  return mod.exports;
}

export async function runOutboundContextRegressions() {
  const h = await createPgliteSupabase();
  const db = h.db;

  const companyA = randomUUID();
  const companyB = randomUUID();
  const bossA1 = randomUUID();
  const bossA2 = randomUUID();
  const saleA = randomUUID();
  const bossB = randomUUID();
  const saleB = randomUUID();

  const customerA = randomUUID();
  const customerB = randomUUID();

  const devSaleA = randomUUID();
  const devBossA = randomUUID();
  const devSharedA = randomUUID();
  const devB = randomUUID();

  const secretSale = '1'.repeat(43);
  const secretBoss = '2'.repeat(43);
  const secretShared = '3'.repeat(43);
  const secretB = '4'.repeat(43);

  const audio = audioFixture();

  try {
    // Tenants & Actors: exactly one active SALE per company
    await db.query(`INSERT INTO companies(id, name) VALUES ($1, 'Tenant A'), ($2, 'Tenant B')`, [companyA, companyB]);
    for (const [id, comp, role] of [
      [bossA1, companyA, 'BOSS_ADMIN'],
      [bossA2, companyA, 'BOSS_ADMIN'],
      [saleA, companyA, 'SALE'],
      [bossB, companyB, 'BOSS_ADMIN'],
      [saleB, companyB, 'SALE'],
    ]) {
      await db.query('INSERT INTO auth.users(id) VALUES($1)', [id]);
      await db.query(`INSERT INTO user_profiles(id, full_name) VALUES($1, 'Actor') ON CONFLICT(id) DO NOTHING`, [id]);
      await db.query(`INSERT INTO company_members(company_id, user_id, role, status) VALUES($1, $2, $3, 'ACTIVE')`, [comp, id, role]);
    }

    // Customers & Private Contacts (assert normalized phone stored)
    await db.query(
      `INSERT INTO customers(id, company_id, name, source, stage) VALUES
      ($1, $2, 'Customer A', 'MANUAL', 'LEAD_NEW'),
      ($3, $4, 'Customer B', 'MANUAL', 'LEAD_NEW')`,
      [customerA, companyA, customerB, companyB]
    );
    await db.query(
      `INSERT INTO private.customer_private_contacts(company_id, customer_id, raw_phone, normalized_phone, is_verified) VALUES
      ($1, $2, '0901234567', '+84901234567', true),
      ($3, $4, '0909876543', '+84909876543', true)`,
      [companyA, customerA, companyB, customerB]
    );
    const storedPhoneRow = (await db.query<{ normalized_phone: string }>(
      `SELECT normalized_phone FROM private.customer_private_contacts WHERE customer_id = $1`, [customerA]
    )).rows[0];
    assert.equal(storedPhoneRow.normalized_phone, '+84901234567', 'Private normalized contact phone fixture matches');

    // Register Devices & assert all setup outcomes
    rpcOk(await h.client.rpc('zalo_manage_device', { p_company: companyA, p_actor: bossA1, p_device: devSaleA, p_name: 'Dev Sale A', p_hash: sha256(secretSale), p_staff: saleA }));
    rpcOk(await h.client.rpc('zalo_manage_device', { p_company: companyA, p_actor: bossA1, p_device: devBossA, p_name: 'Dev Boss A', p_hash: sha256(secretBoss), p_staff: bossA2 }));
    rpcOk(await h.client.rpc('zalo_manage_device', { p_company: companyA, p_actor: bossA1, p_device: devSharedA, p_name: 'Dev Shared A', p_hash: sha256(secretShared), p_staff: null }));
    rpcOk(await h.client.rpc('zalo_manage_device', { p_company: companyB, p_actor: bossB, p_device: devB, p_name: 'Dev B', p_hash: sha256(secretB), p_staff: null }));

    // =========================================================================
    // CASE 1: Device targeting, staff scoping, readiness & RLS visibility
    // =========================================================================
    const bossTargetSale = await h.client.rpc('zalo_create_outbound_call_request', {
      p_company: companyA, p_actor: bossA1, p_customer: customerA, p_device: devSaleA
    });
    const bossExplicitReq = rpcOk(bossTargetSale).request_id;
    assert.ok(bossExplicitReq, 'Boss explicit Sale device target must succeed');

    const bossClaim = rpcOk(await h.client.rpc('zalo_claim_outbound_call_request', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_request_id: bossExplicitReq
    }));
    assert.equal(bossClaim.customer_id, customerA, 'Targeted devSaleA claims Boss explicit request');

    const saleReqNoDev = rpcOk(await h.client.rpc('zalo_create_outbound_call_request', {
      p_company: companyA, p_actor: saleA, p_customer: customerA
    })).request_id;
    const bossDevClaimSale = await h.client.rpc('zalo_claim_outbound_call_request', {
      p_device: devBossA, p_key_hash: sha256(secretBoss), p_request_id: saleReqNoDev
    });
    assert.ok(bossDevClaimSale.error, 'Boss device cannot claim Sale request');
    assert.match(bossDevClaimSale.error.message, /ZALO_REQUEST_STAFF_MISMATCH/);

    const saleTargetBoss = await h.client.rpc('zalo_create_outbound_call_request', {
      p_company: companyA, p_actor: saleA, p_customer: customerA, p_device: devBossA
    });
    assert.ok(saleTargetBoss.error, 'Sale cannot target device assigned to Boss/another staff');

    const crossTenantTarget = await h.client.rpc('zalo_create_outbound_call_request', {
      p_company: companyA, p_actor: bossA1, p_customer: customerA, p_device: devB
    });
    assert.ok(crossTenantTarget.error, 'Targeting cross-tenant device must fail');

    const saleReadiness = await h.client.rpc('zalo_get_devices_readiness', { p_company: companyA, p_actor: saleA });
    rpcOk(saleReadiness);
    const saleDevIds = ((saleReadiness.data as any)?.devices || []).map((d: any) => d.id);
    assert.ok(saleDevIds.includes(devSaleA) && saleDevIds.includes(devSharedA) && !saleDevIds.includes(devBossA), 'Sale only sees own and shared devices');

    const sharedReq = rpcOk(await h.client.rpc('zalo_create_outbound_call_request', {
      p_company: companyA, p_actor: saleA, p_customer: customerA, p_device: devSharedA
    })).request_id;
    await transitionToTriggered(h, devSharedA, secretShared, sharedReq);

    const nowIso1 = new Date().toISOString();
    const endIso1 = new Date(Date.now() + 2000).toISOString();
    const sharedMeta: RecordingMetadata = {
      ...metadataFixture(devSharedA, 'Customer A'),
      direction: 'OUTBOUND',
      crm_call_request_id: sharedReq,
      started_at: nowIso1,
      ended_at: endIso1,
      duration_seconds: 2,
    };
    const sharedReserved = rpcOk(await h.client.rpc('zalo_reserve_recording', {
      p_device: devSharedA, p_key_hash: sha256(secretShared), p_metadata: sharedMeta, p_checksum: sha256(audio), p_bytes: audio.length, p_fingerprint: sha256(JSON.stringify(sharedMeta))
    }));
    assert.ok(sharedReserved.path, 'Actual reserve key is path');

    await putStorageObject(db, sharedReserved.path, audio.length);
    rpcOk(await h.client.rpc('zalo_finish_recording', {
      p_device: devSharedA, p_key_hash: sha256(secretShared), p_call: sharedReserved.call_id, p_lease: sharedReserved.lease
    }));

    const callRow = (await db.query<{ staff_user_id: string }>(`SELECT staff_user_id FROM zalo_personal_calls WHERE id = $1`, [sharedReserved.call_id])).rows[0];
    assert.equal(callRow.staff_user_id, saleA, 'Shared device outbound call inherits staff_user_id from request actor');

    await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub = '${saleA}';`);
    const rlsCount = (await db.query<{ count: number }>(`SELECT count(*)::int as count FROM zalo_personal_calls WHERE id = $1`, [sharedReserved.call_id])).rows[0].count;
    assert.equal(rlsCount, 1, 'Sale sees own outbound call completed on shared device via RLS');
    await db.exec(`RESET ROLE;`);

    // =========================================================================
    // CASE 2: Strict phase progression & expiry behavior
    // =========================================================================
    const reqPhases = rpcOk(await h.client.rpc('zalo_create_outbound_call_request', {
      p_company: companyA, p_actor: saleA, p_customer: customerA, p_device: devSaleA
    })).request_id;
    rpcOk(await h.client.rpc('zalo_claim_outbound_call_request', { p_device: devSaleA, p_key_hash: sha256(secretSale), p_request_id: reqPhases }));

    const directTrigger = await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_request_id: reqPhases, p_status: 'CALL_TRIGGERED'
    });
    assert.ok(directTrigger.error, 'Jumping CLAIMED -> CALL_TRIGGERED without verification must reject');

    rpcOk(await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_request_id: reqPhases, p_status: 'OPENING_ZALO'
    }));

    const openingTrigger = await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_request_id: reqPhases, p_status: 'CALL_TRIGGERED'
    });
    assert.ok(openingTrigger.error, 'OPENING_ZALO directly to CALL_TRIGGERED must reject');

    rpcOk(await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_request_id: reqPhases, p_status: 'CONTACT_VERIFIED'
    }));

    rpcOk(await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_request_id: reqPhases, p_status: 'CALL_DETECTED'
    }));

    rpcOk(await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_request_id: reqPhases, p_status: 'CALL_TRIGGERED'
    }));
    const reqStatusRow = (await db.query<{ status: string }>(`SELECT status FROM zalo_outbound_call_requests WHERE id = $1`, [reqPhases])).rows[0];
    assert.equal(reqStatusRow.status, 'CALL_DETECTED', 'Late CALL_TRIGGERED must retain CALL_DETECTED');

    // Established DETECTED retry post-expiry retains CALL_DETECTED
    await db.query(`UPDATE zalo_outbound_call_requests SET expires_at = now() - interval '2 seconds' WHERE id = $1`, [reqPhases]);
    rpcOk(await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_request_id: reqPhases, p_status: 'CALL_DETECTED'
    }));
    const detectedProgressRow = (await db.query<{ status: string }>(`SELECT status FROM zalo_outbound_call_requests WHERE id = $1`, [reqPhases])).rows[0];
    assert.equal(detectedProgressRow.status, 'CALL_DETECTED', 'Established DETECTED call retains CALL_DETECTED on retry after expiry');

    // Separate fresh CLAIMED request expired: OPENING_ZALO must reject with ZALO_REQUEST_EXPIRED and stay CLAIMED
    const reqExpClaimed = rpcOk(await h.client.rpc('zalo_create_outbound_call_request', {
      p_company: companyA, p_actor: saleA, p_customer: customerA, p_device: devSaleA
    })).request_id;
    rpcOk(await h.client.rpc('zalo_claim_outbound_call_request', { p_device: devSaleA, p_key_hash: sha256(secretSale), p_request_id: reqExpClaimed }));
    await db.query(`UPDATE zalo_outbound_call_requests SET expires_at = now() - interval '5 seconds' WHERE id = $1`, [reqExpClaimed]);

    const expClaimedAdvance = await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_request_id: reqExpClaimed, p_status: 'OPENING_ZALO'
    });
    assert.ok(expClaimedAdvance.error, 'Expired CLAIMED request must reject status advance');
    assert.match(expClaimedAdvance.error.message, /ZALO_REQUEST_EXPIRED/);
    const reqExpClaimedRow = (await db.query<{ status: string }>(`SELECT status FROM zalo_outbound_call_requests WHERE id = $1`, [reqExpClaimed])).rows[0];
    assert.equal(reqExpClaimedRow.status, 'CLAIMED', 'Expired request retains CLAIMED status upon rejection');

    // =========================================================================
    // CASE 3: Boundary validation & legacy finish timing rejection
    // =========================================================================
    const reqEarly = rpcOk(await h.client.rpc('zalo_create_outbound_call_request', {
      p_company: companyA, p_actor: bossA1, p_customer: customerA, p_device: devSaleA
    })).request_id;
    await transitionToTriggered(h, devSaleA, secretSale, reqEarly);

    const earlyMeta: RecordingMetadata = {
      ...metadataFixture(devSaleA, 'Customer A'),
      direction: 'OUTBOUND',
      crm_call_request_id: reqEarly,
      started_at: new Date(Date.now() - 120_000).toISOString(),
      ended_at: new Date(Date.now() - 118_000).toISOString(),
      duration_seconds: 2,
    };
    const earlyReserve = await h.client.rpc('zalo_reserve_recording', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_metadata: earlyMeta, p_checksum: sha256(audio), p_bytes: audio.length, p_fingerprint: sha256(JSON.stringify(earlyMeta))
    });
    assert.ok(earlyReserve.error, 'Pre-claim recording start must be rejected at reserve');
    assert.match(earlyReserve.error.message, /TIMING_INVALID/);

    const reqLate = rpcOk(await h.client.rpc('zalo_create_outbound_call_request', {
      p_company: companyA, p_actor: bossA1, p_customer: customerA, p_device: devSaleA
    })).request_id;
    await transitionToTriggered(h, devSaleA, secretSale, reqLate);
    await db.query(`UPDATE zalo_outbound_call_requests SET expires_at = now() - interval '10 seconds' WHERE id = $1`, [reqLate]);

    const expiredMeta: RecordingMetadata = {
      ...metadataFixture(devSaleA, 'Customer A'),
      direction: 'OUTBOUND',
      crm_call_request_id: reqLate,
      started_at: new Date().toISOString(),
      ended_at: new Date(Date.now() + 2000).toISOString(),
      duration_seconds: 2,
    };
    const expiredReserve = await h.client.rpc('zalo_reserve_recording', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_metadata: expiredMeta, p_checksum: sha256(audio), p_bytes: audio.length, p_fingerprint: sha256(JSON.stringify(expiredMeta))
    });
    assert.ok(expiredReserve.error, 'Call starting after request expiry must be rejected at reserve');
    assert.match(expiredReserve.error.message, /EXPIRED/);

    const reqLegacy = rpcOk(await h.client.rpc('zalo_create_outbound_call_request', {
      p_company: companyA, p_actor: bossA1, p_customer: customerA, p_device: devSaleA
    })).request_id;
    await transitionToTriggered(h, devSaleA, secretSale, reqLegacy);

    const validMeta: RecordingMetadata = {
      ...metadataFixture(devSaleA, 'Customer A'),
      direction: 'OUTBOUND',
      crm_call_request_id: reqLegacy,
      started_at: new Date().toISOString(),
      ended_at: new Date(Date.now() + 2000).toISOString(),
      duration_seconds: 2,
    };
    const legacyReserved = rpcOk(await h.client.rpc('zalo_reserve_recording', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_metadata: validMeta, p_checksum: sha256(audio), p_bytes: audio.length, p_fingerprint: sha256(JSON.stringify(validMeta))
    }));
    await putStorageObject(db, legacyReserved.path, audio.length);

    await db.query(
      `UPDATE zalo_personal_calls
       SET started_at = now() - interval '2 minutes', ended_at = now() - interval '1 minute 58 seconds'
       WHERE id = $1`,
      [legacyReserved.call_id]
    );

    const finishTimingInvalid = await h.client.rpc('zalo_finish_recording', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_call: legacyReserved.call_id, p_lease: legacyReserved.lease
    });
    assert.ok(finishTimingInvalid.error, 'Stored start before request must fail finish');
    assert.match(finishTimingInvalid.error.message, /TIMING_INVALID/);

    const callNotReady = (await db.query<{ recording_status: string; customer_id: string | null }>(
      `SELECT recording_status, customer_id FROM zalo_personal_calls WHERE id = $1`, [legacyReserved.call_id]
    )).rows[0];
    assert.notEqual(callNotReady.recording_status, 'READY', 'Invalid call timing must never transition to READY');
    assert.equal(callNotReady.customer_id, null, 'Customer must remain unlinked on invalid timing');

    await db.query(
      `UPDATE zalo_personal_calls
       SET started_at = now() + interval '5 minutes', ended_at = now() + interval '5 minutes 2 seconds'
       WHERE id = $1`,
      [legacyReserved.call_id]
    );
    const finishExpired = await h.client.rpc('zalo_finish_recording', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_call: legacyReserved.call_id, p_lease: legacyReserved.lease
    });
    assert.ok(finishExpired.error, 'Stored start after request expiry must fail finish');
    assert.match(finishExpired.error.message, /EXPIRED/);

    // =========================================================================
    // CASE 4: Upload lease resumption, lease renewal & request failure
    // =========================================================================
    const reqResume = rpcOk(await h.client.rpc('zalo_create_outbound_call_request', {
      p_company: companyA, p_actor: bossA1, p_customer: customerA, p_device: devSaleA
    })).request_id;
    await transitionToTriggered(h, devSaleA, secretSale, reqResume);

    const resumeMeta: RecordingMetadata = {
      ...metadataFixture(devSaleA, 'Customer A'),
      direction: 'OUTBOUND',
      crm_call_request_id: reqResume,
      started_at: new Date().toISOString(),
      ended_at: new Date(Date.now() + 2000).toISOString(),
      duration_seconds: 2,
    };
    const reserve1 = rpcOk(await h.client.rpc('zalo_reserve_recording', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_metadata: resumeMeta, p_checksum: sha256(audio), p_bytes: audio.length, p_fingerprint: sha256(JSON.stringify(resumeMeta))
    }));

    // Lease expiry alone does not invalidate UUID; renew FIRST
    await db.query(`UPDATE zalo_personal_calls SET upload_lease_until = now() - interval '5 seconds' WHERE id = $1`, [reserve1.call_id]);

    const reserveRenew = rpcOk(await h.client.rpc('zalo_reserve_recording', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_metadata: resumeMeta, p_checksum: sha256(audio), p_bytes: audio.length, p_fingerprint: sha256(JSON.stringify(resumeMeta))
    }));
    assert.equal(reserveRenew.call_id, reserve1.call_id, 'Resumed reservation returns same call_id');
    assert.notEqual(reserveRenew.lease, reserve1.lease, 'Fresh lease must differ from old lease');

    // Finishing with stale old lease now fails ZALO_LEASE_LOST
    await putStorageObject(db, reserve1.path, audio.length);
    const staleFinish = await h.client.rpc('zalo_finish_recording', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_call: reserve1.call_id, p_lease: reserve1.lease
    });
    assert.ok(staleFinish.error, 'Finishing with replaced stale lease must fail');
    assert.match(staleFinish.error.message, /ZALO_LEASE_LOST/);

    // Fresh lease finishes successfully and verifies in_progress completed
    rpcOk(await h.client.rpc('zalo_finish_recording', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_call: reserveRenew.call_id, p_lease: reserveRenew.lease
    }));
    const finishedResumeCall = (await db.query<{ recording_status: string }>(
      `SELECT recording_status FROM zalo_personal_calls WHERE id = $1`, [reserveRenew.call_id]
    )).rows[0];
    assert.equal(finishedResumeCall.recording_status, 'READY', 'Resumed call with fresh lease is READY');

    // Mutate request FAILED while lease FRESH: reserve fails closed BEFORE in_progress
    const reqFailWhileFresh = rpcOk(await h.client.rpc('zalo_create_outbound_call_request', {
      p_company: companyA, p_actor: bossA1, p_customer: customerA, p_device: devSaleA
    })).request_id;
    await transitionToTriggered(h, devSaleA, secretSale, reqFailWhileFresh);

    const failFreshMeta: RecordingMetadata = {
      ...metadataFixture(devSaleA, 'Customer A'),
      direction: 'OUTBOUND',
      crm_call_request_id: reqFailWhileFresh,
      started_at: new Date().toISOString(),
      ended_at: new Date(Date.now() + 2000).toISOString(),
      duration_seconds: 2,
    };
    rpcOk(await h.client.rpc('zalo_reserve_recording', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_metadata: failFreshMeta, p_checksum: sha256(audio), p_bytes: audio.length, p_fingerprint: sha256(JSON.stringify(failFreshMeta))
    }));

    await db.query(`UPDATE zalo_outbound_call_requests SET status = 'FAILED' WHERE id = $1`, [reqFailWhileFresh]);
    const reserveFreshFailed = await h.client.rpc('zalo_reserve_recording', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_metadata: failFreshMeta, p_checksum: sha256(audio), p_bytes: audio.length, p_fingerprint: sha256(JSON.stringify(failFreshMeta))
    });
    assert.ok(reserveFreshFailed.error, 'Reserve while request is FAILED must reject');
    assert.match(reserveFreshFailed.error.message, /FAILED/);

    // =========================================================================
    // CASE 5: Atomic audit rollback, reuse prevention & duplicate finish
    // =========================================================================
    const reqAudit = rpcOk(await h.client.rpc('zalo_create_outbound_call_request', {
      p_company: companyA, p_actor: bossA1, p_customer: customerA, p_device: devSaleA
    })).request_id;
    await transitionToTriggered(h, devSaleA, secretSale, reqAudit);

    const auditMeta: RecordingMetadata = {
      ...metadataFixture(devSaleA, 'Customer A'),
      direction: 'OUTBOUND',
      crm_call_request_id: reqAudit,
      started_at: new Date().toISOString(),
      ended_at: new Date(Date.now() + 2000).toISOString(),
      duration_seconds: 2,
    };
    const auditRes = rpcOk(await h.client.rpc('zalo_reserve_recording', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_metadata: auditMeta, p_checksum: sha256(audio), p_bytes: audio.length, p_fingerprint: sha256(JSON.stringify(auditMeta))
    }));
    await putStorageObject(db, auditRes.path, audio.length);

    await db.exec(`
      CREATE OR REPLACE FUNCTION trg_fail_audit_fn() RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.action = 'ZALO_RECORDING_READY' THEN
          RAISE EXCEPTION 'INJECTED_OUTBOUND_AUDIT';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION trg_fail_audit_fn();
    `);

    try {
      const finishAuditFail = await h.client.rpc('zalo_finish_recording', {
        p_device: devSaleA, p_key_hash: sha256(secretSale), p_call: auditRes.call_id, p_lease: auditRes.lease
      });
      assert.ok(finishAuditFail.error);
      assert.match(finishAuditFail.error.message, /INJECTED_OUTBOUND_AUDIT/);

      const rollCall = (await db.query<{ recording_status: string; customer_id: string | null }>(
        `SELECT recording_status, customer_id FROM zalo_personal_calls WHERE id = $1`, [auditRes.call_id]
      )).rows[0];
      assert.equal(rollCall.recording_status, 'UPLOADING', 'Recording status must remain UPLOADING upon audit rollback');
      assert.equal(rollCall.customer_id, null, 'Customer must remain unlinked upon audit rollback');

      const rollReq = (await db.query<{ status: string }>(`SELECT status FROM zalo_outbound_call_requests WHERE id = $1`, [reqAudit])).rows[0];
      assert.equal(rollReq.status, 'CALL_TRIGGERED', 'Request status must remain CALL_TRIGGERED upon audit rollback');
    } finally {
      await db.exec(`DROP TRIGGER IF EXISTS trg_fail_audit ON audit_logs; DROP FUNCTION IF EXISTS trg_fail_audit_fn();`);
    }

    rpcOk(await h.client.rpc('zalo_finish_recording', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_call: auditRes.call_id, p_lease: auditRes.lease
    }));

    const auditCount = (await db.query<{ count: number }>(
      `SELECT count(*)::int as count FROM audit_logs WHERE resource_id = $1 AND action = 'ZALO_RECORDING_READY'`,
      [auditRes.call_id]
    )).rows[0].count;
    assert.equal(auditCount, 1, 'Exactly one audit log entry with resource_id must exist');

    // Completed request reuse with NEW local_call_id fails REUSED
    const reusedMeta: RecordingMetadata = {
      ...auditMeta,
      local_call_id: randomUUID(),
      started_at: new Date().toISOString(),
      ended_at: new Date(Date.now() + 2000).toISOString(),
    };
    const reusedReserve = await h.client.rpc('zalo_reserve_recording', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_metadata: reusedMeta, p_checksum: sha256(audio), p_bytes: audio.length, p_fingerprint: sha256(JSON.stringify(reusedMeta))
    });
    assert.ok(reusedReserve.error, 'Reusing completed request with new local_call_id must fail REUSED');
    assert.match(reusedReserve.error.message, /REUSED/);

    // Duplicate finish on already READY recording returns same call_id
    const duplicateFinish = rpcOk(await h.client.rpc('zalo_finish_recording', {
      p_device: devSaleA, p_key_hash: sha256(secretSale), p_call: auditRes.call_id, p_lease: auditRes.lease
    }));
    assert.equal(duplicateFinish.call_id, auditRes.call_id, 'Duplicate finish returns existing call_id');

    // =========================================================================
    // CASE 6: Server actions & GET route privacy & authorization scoping
    // =========================================================================
    const actionsPath = resolve(__dirname, '../../app/actions/zalo-recordings.ts');
    const routePath = resolve(__dirname, '../../app/api/voice/zalo-personal/outbound/status/route.ts');
    const actions = loadAppModule(actionsPath, h.client);
    const route = loadAppModule(routePath, h.client);

    // Boss A1 creates request -> returns raw safe {request_id,...}
    currentActor = { userId: bossA1, companyId: companyA, role: 'BOSS_ADMIN' };
    const bossCreatedAction = await actions.createZaloOutboundCall(customerA);
    assert.ok(bossCreatedAction.request_id);
    assertNoPhone(bossCreatedAction);

    // Same-company Sale accessing Boss-owned request throws RecordingError for 404
    currentActor = { userId: saleA, companyId: companyA, role: 'SALE' };
    await assert.rejects(
      () => actions.getZaloOutboundCallStatus(bossCreatedAction.request_id),
      (err: any) => err.code === 'NOT_FOUND' || err.status === 404,
      'Same-company Sale accessing Boss-owned request must throw NOT_FOUND (404)'
    );

    const sameCompSaleGetRes = await route.GET(
      new Request(`http://localhost/api/voice/zalo-personal/outbound/status?request_id=${bossCreatedAction.request_id}`)
    );
    assert.equal(sameCompSaleGetRes.status, 404, 'GET route returns 404 for same-company unowned request');

    // Cross-tenant Boss throws 404
    currentActor = { userId: bossB, companyId: companyB, role: 'BOSS_ADMIN' };
    await assert.rejects(
      () => actions.getZaloOutboundCallStatus(bossCreatedAction.request_id),
      (err: any) => err.code === 'NOT_FOUND' || err.status === 404,
      'Foreign company actor must throw NOT_FOUND (404)'
    );

    const foreignGetRes = await route.GET(
      new Request(`http://localhost/api/voice/zalo-personal/outbound/status?request_id=${bossCreatedAction.request_id}`)
    );
    assert.equal(foreignGetRes.status, 404, 'GET route returns 404 for foreign company actor');

    // Boss A1 (owner/admin) valid view returns raw {id,...} for action and {ok:true,request:...} for GET
    currentActor = { userId: bossA1, companyId: companyA, role: 'BOSS_ADMIN' };
    const bossStatusAction = await actions.getZaloOutboundCallStatus(bossCreatedAction.request_id);
    assert.equal(bossStatusAction.id, bossCreatedAction.request_id);
    assertNoPhone(bossStatusAction);

    const bossGetRes = await route.GET(
      new Request(`http://localhost/api/voice/zalo-personal/outbound/status?request_id=${bossCreatedAction.request_id}`)
    );
    assert.equal(bossGetRes.status, 200, 'Boss valid view returns 200');
    const bossGetJson = await bossGetRes.json();
    assert.equal(bossGetJson.ok, true);
    assert.equal(bossGetJson.request.id, bossCreatedAction.request_id);
    assertNoPhone(bossGetJson);

    // Sale A creates own request
    currentActor = { userId: saleA, companyId: companyA, role: 'SALE' };
    const saleCreatedAction = await actions.createZaloOutboundCall(customerA);
    assert.ok(saleCreatedAction.request_id);
    assertNoPhone(saleCreatedAction);

    const saleStatusAction = await actions.getZaloOutboundCallStatus(saleCreatedAction.request_id);
    assert.equal(saleStatusAction.id, saleCreatedAction.request_id);
    assertNoPhone(saleStatusAction);

    const saleGetRes = await route.GET(
      new Request(`http://localhost/api/voice/zalo-personal/outbound/status?request_id=${saleCreatedAction.request_id}`)
    );
    assert.equal(saleGetRes.status, 200);
    const saleGetJson = await saleGetRes.json();
    assert.equal(saleGetJson.ok, true);
    assert.equal(saleGetJson.request.id, saleCreatedAction.request_id);
    assertNoPhone(saleGetJson);

    console.log('PASS: outbound context regressions (phase transitions, negative validation, lease resumption, audit rollback, phone privacy & route authorization)');
  } finally {
    await h.close();
  }
}

if (process.argv[1]?.endsWith('outbound-context-regressions.test.ts')) {
  runOutboundContextRegressions().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
