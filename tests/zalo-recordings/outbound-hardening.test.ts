import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createPgliteSupabase } from '../zalo/helpers/pglite-supabase';
import { RecordingError, sha256, type RecordingMetadata } from '../../features/zalo-recordings/metadata';
import { uploadRecording, RECORDING_BUCKET } from '../../features/zalo-recordings/upload';
import { audioFixture, metadataFixture, uploadRequest } from './fixture';
import { POST as statusPostHandler, GET as statusGetHandler } from '../../app/api/voice/zalo-personal/outbound/status/route';
import { POST as claimPostHandler } from '../../app/api/voice/zalo-personal/outbound/claim/route';

export function longAudioFixture(duration = 125): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'zalo-long-audio-'));
  try {
    const target = join(dir, 'test-long.m4a');
    execFileSync(process.env.FFMPEG_PATH || (process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg'), [
      '-v', 'error',
      '-f', 'lavfi',
      '-i', `sine=frequency=440:duration=${duration}`,
      '-af', 'pan=stereo|c0=c0|c1=c0',
      '-c:a', 'aac',
      '-ar', '48000',
      target,
    ]);
    return readFileSync(target);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runOutboundHardeningTests() {
  const h = await createPgliteSupabase();
  const db = h.db;

  const companyA = randomUUID();
  const companyB = randomUUID();

  const bossA = randomUUID();
  const saleA1 = randomUUID();
  const saleA2 = randomUUID();
  const techA = randomUUID();

  const bossB = randomUUID();
  const saleB = randomUUID();

  const customerA1 = randomUUID();
  const customerA2 = randomUUID();
  const customerB = randomUUID();

  const deviceA1 = randomUUID();
  const secretA1 = 's'.repeat(43);

  const deviceShared = randomUUID();
  const secretShared = 'd'.repeat(43);

  const deviceB = randomUUID();
  const secretB = 'b'.repeat(43);

  const audio2s = audioFixture();

  try {
    // 1. Setup tenants
    await db.query(`INSERT INTO companies(id, name) VALUES($1, 'Tenant A'), ($2, 'Tenant B')`, [companyA, companyB]);

    // Setup actors in Tenant A
    for (const [id, role] of [[bossA, 'BOSS_ADMIN'], [saleA1, 'SALE'], [saleA2, 'SALE'], [techA, 'TECHNICIAN']]) {
      await db.query('INSERT INTO auth.users(id) VALUES($1)', [id]);
      await db.query(`INSERT INTO user_profiles(id, full_name) VALUES($1, 'Actor') ON CONFLICT(id) DO NOTHING`, [id]);
      await db.query(`INSERT INTO company_members(company_id, user_id, role, status) VALUES($1, $2, $3, 'ACTIVE')`, [companyA, id, role === 'SALE' && id === saleA2 ? 'BOSS_ADMIN' : role]);
    }

    // Setup actors in Tenant B
    for (const [id, role] of [[bossB, 'BOSS_ADMIN'], [saleB, 'SALE']]) {
      await db.query('INSERT INTO auth.users(id) VALUES($1)', [id]);
      await db.query(`INSERT INTO user_profiles(id, full_name) VALUES($1, 'Actor B') ON CONFLICT(id) DO NOTHING`, [id]);
      await db.query(`INSERT INTO company_members(company_id, user_id, role, status) VALUES($1, $2, $3, 'ACTIVE')`, [companyB, id, role]);
    }

    // Customers
    await db.query(`INSERT INTO customers(id, company_id, name, source, stage) VALUES
      ($1, $2, 'Khách A1', 'ZALO', 'LEAD_NEW'),
      ($3, $2, 'Khách A2', 'ZALO', 'LEAD_NEW'),
      ($4, $5, 'Khách B', 'ZALO', 'LEAD_NEW')`,
      [customerA1, companyA, customerA2, customerB, companyB]
    );

    // Private contacts with normalized phone
    await db.query(`INSERT INTO private.customer_private_contacts(company_id, customer_id, raw_phone, normalized_phone, is_verified) VALUES
      ($1, $2, '0912345671', '+84912345671', true),
      ($1, $3, '0912345672', '+84912345672', true),
      ($4, $5, '0998765432', '+84998765432', true)`,
      [companyA, customerA1, customerA2, companyB, customerB]
    );

    // Devices
    // Device A1: bound to saleA1
    const regA1 = await h.client.rpc('zalo_manage_device', {
      p_company: companyA, p_actor: bossA, p_device: deviceA1, p_name: 'Device A1 Staff', p_hash: sha256(secretA1), p_staff: saleA1
    });
    assert.ifError(regA1.error);

    // Device Shared: in Company A, no staff bound
    const regShared = await h.client.rpc('zalo_manage_device', {
      p_company: companyA, p_actor: bossA, p_device: deviceShared, p_name: 'Device Shared', p_hash: sha256(secretShared), p_staff: null
    });
    assert.ifError(regShared.error);

    // Device B: in Company B
    const regB = await h.client.rpc('zalo_manage_device', {
      p_company: companyB, p_actor: bossB, p_device: deviceB, p_name: 'Device B', p_hash: sha256(secretB), p_staff: saleB
    });
    assert.ifError(regB.error);

    // Mock storage
    const objects = new Map<string, Buffer>();
    const admin = Object.assign(h.client, {
      storage: {
        from: () => ({
          upload: async (path: string, body: Buffer) => {
            if (objects.has(path)) return { error: { message: 'exists' } };
            objects.set(path, body);
            await db.query(`INSERT INTO storage.objects(bucket_id, name, metadata) VALUES('zalo-call-recordings', $1, $2)`, [path, JSON.stringify({ size: body.length })]);
            return { error: null };
          },
          download: async (path: string) => ({
            data: objects.has(path) ? new Blob([new Uint8Array(objects.get(path)!)]) : null,
            error: null,
          }),
        }),
      },
    }) as unknown as SupabaseClient;

    const upload = (m: RecordingMetadata, token: string, audioBytes = audio2s) =>
      uploadRecording(uploadRequest(m, audioBytes, token), admin);

    // =========================================================================
    // 1. BASELINE EXPLOIT REGRESSION (Codex reproduction)
    // Expired/FAILED/unclaimed request passed to INBOUND recording MUST FAIL CLOSED
    // =========================================================================
    const reqExploit = await h.client.rpc('zalo_create_outbound_call_request', {
      p_company: companyA, p_actor: saleA1, p_customer: customerA1
    });
    assert.ifError(reqExploit.error);
    const exploitReqId = reqExploit.data.request_id;

    // Set request to FAILED
    await db.query(`UPDATE zalo_outbound_call_requests SET status = 'FAILED', failure_reason = 'Call dropped' WHERE id = $1`, [exploitReqId]);

    // Attempt to attach this failed request to an unrelated INBOUND recording
    const inboundExploitMeta: RecordingMetadata = {
      ...metadataFixture(deviceA1, 'Unknown Caller'),
      direction: 'INBOUND',
      crm_call_request_id: exploitReqId,
    };
    await assert.rejects(
      upload(inboundExploitMeta, secretA1),
      (err: any) => err instanceof RecordingError && err.code === 'INVALID_REQUEST_ASSOCIATION',
      'INBOUND call with crm_call_request_id must fail closed with INVALID_REQUEST_ASSOCIATION'
    );

    // Verify DB: No call attached to customerA1, no recording marked READY for this request
    const exploitCallCount = (await db.query<{ count: number }>(
      `SELECT count(*)::int as count FROM zalo_personal_calls WHERE outbound_request_id = $1`,
      [exploitReqId]
    )).rows[0].count;
    assert.equal(exploitCallCount, 0, 'No call must be created for failed exploit attempt');

    // =========================================================================
    // 2. TENANT, DEVICE & STAFF SCOPING
    // =========================================================================
    // 2a. Wrong Tenant: Device B tries to claim or reserve Tenant A's request
    const reqA1 = (await h.client.rpc('zalo_create_outbound_call_request', {
      p_company: companyA, p_actor: saleA1, p_customer: customerA1
    })).data.request_id;

    const crossTenantClaim = await h.client.rpc('zalo_claim_outbound_call_request', {
      p_device: deviceB, p_key_hash: sha256(secretB), p_request_id: reqA1
    });
    assert.ok(crossTenantClaim.error, 'Cross-tenant claim must fail');
    assert.match(crossTenantClaim.error.message, /ZALO_REQUEST_NOT_FOUND/);

    const crossTenantReserve = await h.client.rpc('zalo_reserve_recording', {
      p_device: deviceB,
      p_key_hash: sha256(secretB),
      p_metadata: { ...metadataFixture(deviceB, 'Khách A1'), direction: 'OUTBOUND', crm_call_request_id: reqA1 },
      p_checksum: sha256(audio2s),
      p_bytes: audio2s.length,
      p_fingerprint: sha256('cross-tenant')
    });
    assert.ok(crossTenantReserve.error, 'Cross-tenant reserve must fail');
    assert.match(crossTenantReserve.error.message, /ZALO_REQUEST_NOT_FOUND/);

    // 2b. Wrong Staff: Device A1 is bound to saleA1. saleA2 creates a request.
    const reqSaleA2 = (await h.client.rpc('zalo_create_outbound_call_request', {
      p_company: companyA, p_actor: saleA2, p_customer: customerA2
    })).data.request_id;

    const wrongStaffClaim = await h.client.rpc('zalo_claim_outbound_call_request', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqSaleA2
    });
    assert.ok(wrongStaffClaim.error, 'Device bound to Sale 1 cannot claim Sale 2 request');
    assert.match(wrongStaffClaim.error.message, /ZALO_REQUEST_STAFF_MISMATCH/);

    // Shared device (not bound to staff) CAN claim Sale 2 request
    const sharedClaim = await h.client.rpc('zalo_claim_outbound_call_request', {
      p_device: deviceShared, p_key_hash: sha256(secretShared), p_request_id: reqSaleA2
    });
    assert.ifError(sharedClaim.error);
    assert.equal(sharedClaim.data.id, reqSaleA2);
    // Device claim retains normalized phone for dialing
    assert.equal(sharedClaim.data.phone_normalized, '+84912345672');

    // 2c. Wrong Device: Device A1 tries to update status or reserve a request claimed by Device Shared
    const wrongDeviceStatus = await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqSaleA2, p_status: 'OPENING_ZALO'
    });
    assert.ok(wrongDeviceStatus.error, 'Non-claiming device cannot update status');
    assert.match(wrongDeviceStatus.error.message, /ZALO_REQUEST_DEVICE_MISMATCH/);

    const wrongDeviceReserve = await h.client.rpc('zalo_reserve_recording', {
      p_device: deviceA1,
      p_key_hash: sha256(secretA1),
      p_metadata: { ...metadataFixture(deviceA1, 'Khách A2'), direction: 'OUTBOUND', crm_call_request_id: reqSaleA2 },
      p_checksum: sha256(audio2s),
      p_bytes: audio2s.length,
      p_fingerprint: sha256('wrong-device')
    });
    assert.ok(wrongDeviceReserve.error, 'Non-claiming device cannot reserve recording');
    assert.match(wrongDeviceReserve.error.message, /ZALO_REQUEST_DEVICE_MISMATCH/);

    // =========================================================================
    // 3. UNCLAIMED / FAILED / INBOUND / REUSED
    // =========================================================================
    // 3a. Unclaimed: Attempt to reserve recording without claiming first
    const reqUnclaimed = (await h.client.rpc('zalo_create_outbound_call_request', {
      p_company: companyA, p_actor: saleA1, p_customer: customerA1
    })).data.request_id;

    const unclaimedReserve = await h.client.rpc('zalo_reserve_recording', {
      p_device: deviceA1,
      p_key_hash: sha256(secretA1),
      p_metadata: { ...metadataFixture(deviceA1, 'Khách A1'), direction: 'OUTBOUND', crm_call_request_id: reqUnclaimed },
      p_checksum: sha256(audio2s),
      p_bytes: audio2s.length,
      p_fingerprint: sha256('unclaimed')
    });
    assert.ok(unclaimedReserve.error, 'Unclaimed request cannot be reserved');
    assert.match(unclaimedReserve.error.message, /ZALO_REQUEST_UNCLAIMED/);

    // 3b. Claim Replay: Device claims request once, then tries to claim again
    const claim1 = await h.client.rpc('zalo_claim_outbound_call_request', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqUnclaimed
    });
    assert.ifError(claim1.error);
    const claimReplay = await h.client.rpc('zalo_claim_outbound_call_request', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqUnclaimed
    });
    assert.ok(claimReplay.error, 'Claim replay must fail closed');
    assert.match(claimReplay.error.message, /ZALO_REQUEST_ALREADY_CLAIMED/);

    // 3c. State regression & invalid status progression
    await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqUnclaimed, p_status: 'OPENING_ZALO'
    });
    await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqUnclaimed, p_status: 'CONTACT_VERIFIED'
    });
    await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqUnclaimed, p_status: 'CALL_TRIGGERED'
    });

    // Backward transition from CALL_TRIGGERED -> OPENING_ZALO must fail
    const regression = await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqUnclaimed, p_status: 'OPENING_ZALO'
    });
    assert.ok(regression.error, 'State regression must fail');
    assert.match(regression.error.message, /ZALO_STATUS_TRANSITION_INVALID/);

    // Direct transition to COMPLETED via agent status RPC must fail
    const illegalComplete = await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqUnclaimed, p_status: 'COMPLETED'
    });
    assert.ok(illegalComplete.error, 'COMPLETED can only be set by trusted finish');
    assert.match(illegalComplete.error.message, /ZALO_STATUS_INVALID/);

    // Transition to FAILED is valid
    const failUpdate = await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqUnclaimed, p_status: 'FAILED', p_failure_reason: 'User busy'
    });
    assert.ifError(failUpdate.error);

    // Terminal state immutability: cannot transition from FAILED to CALL_TRIGGERED
    const terminalChange = await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqUnclaimed, p_status: 'CALL_TRIGGERED'
    });
    assert.ok(terminalChange.error, 'Terminal FAILED state is immutable');
    assert.match(terminalChange.error.message, /ZALO_STATUS_TERMINAL/);

    // Idempotent update to FAILED succeeds
    const idempotentFail = await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqUnclaimed, p_status: 'FAILED'
    });
    assert.ifError(idempotentFail.error);

    // 3d. Reused request by different local_call_id
    const reqReusable = (await h.client.rpc('zalo_create_outbound_call_request', {
      p_company: companyA, p_actor: saleA1, p_customer: customerA1
    })).data.request_id;
    assert.ifError((await h.client.rpc('zalo_claim_outbound_call_request', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqReusable
    })).error);
    assert.ifError((await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqReusable, p_status: 'OPENING_ZALO'
    })).error);
    assert.ifError((await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqReusable, p_status: 'CONTACT_VERIFIED'
    })).error);
    assert.ifError((await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqReusable, p_status: 'CALL_TRIGGERED'
    })).error);

    const reusableNow = Date.now();
    const callMeta1: RecordingMetadata = {
      ...metadataFixture(deviceA1, 'Khách A1'),
      direction: 'OUTBOUND',
      crm_call_request_id: reqReusable,
      local_call_id: randomUUID(),
      started_at: new Date(reusableNow - 2000).toISOString(),
      answered_at: new Date(reusableNow - 2000).toISOString(),
      ended_at: new Date(reusableNow).toISOString(),
      duration_seconds: 2,
    };
    const upload1 = await upload(callMeta1, secretA1);
    assert.equal(upload1.duplicate, false);

    // Now a DIFFERENT local_call_id attempts to use the same request
    const callMeta2: RecordingMetadata = {
      ...metadataFixture(deviceA1, 'Khách A1'),
      direction: 'OUTBOUND',
      crm_call_request_id: reqReusable,
      local_call_id: randomUUID(), // different local call
      started_at: new Date(reusableNow - 2000).toISOString(),
      answered_at: new Date(reusableNow - 2000).toISOString(),
      ended_at: new Date(reusableNow).toISOString(),
      duration_seconds: 2,
    };
    await assert.rejects(
      upload(callMeta2, secretA1),
      (err: any) => err instanceof RecordingError && err.code === 'REQUEST_REUSED',
      'Reusing request by a different local_call_id must fail closed with REQUEST_REUSED'
    );

    // Same local call duplicate/replay succeeds idempotently
    const duplicateUpload = await upload(callMeta1, secretA1);
    assert.equal(duplicateUpload.duplicate, true);
    assert.equal(duplicateUpload.call_id, upload1.call_id);

    // =========================================================================
    // 4. POSITIVE LONG CALL (>120s) UPLOADED AFTER EXPIRY
    // Call starts within expiry window, duration > 120s, upload happens after expires_at
    // Must SUCCEED because validity uses started_at <= expires_at
    // =========================================================================
    const reqLong = (await h.client.rpc('zalo_create_outbound_call_request', {
      p_company: companyA, p_actor: saleA1, p_customer: customerA1
    })).data.request_id;

    assert.ifError((await h.client.rpc('zalo_claim_outbound_call_request', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqLong
    })).error);
    assert.ifError((await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqLong, p_status: 'OPENING_ZALO'
    })).error);
    assert.ifError((await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqLong, p_status: 'CONTACT_VERIFIED'
    })).error);
    assert.ifError((await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqLong, p_status: 'CALL_TRIGGERED'
    })).error);

    // Synthesize 125s audio
    const longAudio = longAudioFixture(125);

    // Call started 1 minute before expiry. In DB, backdate expires_at so wall clock is expired
    // req was created at now(), expires at now() + 5m.
    // Let's set expires_at = now() - 1m, claimed_at = now() - 4m, started_at = now() - 2m (before expiry!)
    await db.query(`UPDATE zalo_outbound_call_requests SET
      created_at = now() - interval '5 minutes',
      claimed_at = now() - interval '4 minutes',
      expires_at = now() - interval '1 minute'
      WHERE id = $1`, [reqLong]
    );

    const callStartTime = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const callEndTime = new Date(Date.parse(callStartTime) + 125 * 1000).toISOString();

    const longCallMeta: RecordingMetadata = {
      schema_version: 1,
      source: 'ZALO_PERSONAL',
      local_call_id: randomUUID(),
      device_id: deviceA1,
      agent_version: '2.0.0',
      direction: 'OUTBOUND',
      remote_display_name: 'Khách A1',
      remote_identity_type: 'DISPLAY_NAME_ONLY',
      identity_confidence: 'MEDIUM',
      phone_if_visible: null,
      started_at: callStartTime,
      answered_at: callStartTime,
      ended_at: callEndTime,
      duration_seconds: 125,
      recording_file: 'long-call.m4a',
      audio_validation: { remote_non_silent: true, local_non_silent: true },
      crm_call_request_id: reqLong,
    };

    const longCallUpload = await upload(longCallMeta, secretA1, longAudio);
    assert.equal(longCallUpload.duplicate, false, 'Long call uploaded after expiry must succeed');

    const longCallRow = (await db.query<Record<string, unknown>>(
      'SELECT customer_id, matching_status, recording_status, outbound_request_id FROM zalo_personal_calls WHERE id = $1',
      [longCallUpload.call_id]
    )).rows[0];
    assert.equal(longCallRow.customer_id, customerA1);
    assert.equal(longCallRow.matching_status, 'EXACT');
    assert.equal(longCallRow.recording_status, 'READY');

    const longReqRow = (await db.query<Record<string, unknown>>(
      'SELECT status, completed_at FROM zalo_outbound_call_requests WHERE id = $1',
      [reqLong]
    )).rows[0];
    assert.equal(longReqRow.status, 'COMPLETED');
    assert.ok(longReqRow.completed_at !== null);

    // =========================================================================
    // 5. ATOMIC AUDIT ROLLBACK
    // If finish fails on audit insertion, recording stays UPLOADING and request CALL_TRIGGERED
    // =========================================================================
    const reqAuditRollback = (await h.client.rpc('zalo_create_outbound_call_request', {
      p_company: companyA, p_actor: saleA1, p_customer: customerA1
    })).data.request_id;
    assert.ifError((await h.client.rpc('zalo_claim_outbound_call_request', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqAuditRollback
    })).error);
    assert.ifError((await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqAuditRollback, p_status: 'OPENING_ZALO'
    })).error);
    assert.ifError((await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqAuditRollback, p_status: 'CONTACT_VERIFIED'
    })).error);
    assert.ifError((await h.client.rpc('zalo_update_outbound_call_status', {
      p_device: deviceA1, p_key_hash: sha256(secretA1), p_request_id: reqAuditRollback, p_status: 'CALL_TRIGGERED'
    })).error);

    const auditNow = Date.now();
    const auditMeta: RecordingMetadata = {
      ...metadataFixture(deviceA1, 'Khách A1'),
      direction: 'OUTBOUND',
      crm_call_request_id: reqAuditRollback,
      local_call_id: randomUUID(),
      started_at: new Date(auditNow - 2000).toISOString(),
      answered_at: new Date(auditNow - 2000).toISOString(),
      ended_at: new Date(auditNow).toISOString(),
      duration_seconds: 2,
    };
    const reserved = await h.client.rpc('zalo_reserve_recording', {
      p_device: deviceA1,
      p_key_hash: sha256(secretA1),
      p_metadata: auditMeta,
      p_checksum: sha256(audio2s),
      p_bytes: audio2s.length,
      p_fingerprint: sha256('audit-rollback')
    });
    assert.ifError(reserved.error);

    await db.query(
      `INSERT INTO storage.objects(bucket_id, name, metadata) VALUES('zalo-call-recordings', $1, $2)`,
      [reserved.data.path, JSON.stringify({ size: audio2s.length })]
    );

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
      const finishFail = await h.client.rpc('zalo_finish_recording', {
        p_device: deviceA1,
        p_key_hash: sha256(secretA1),
        p_call: reserved.data.call_id,
        p_lease: reserved.data.lease
      });
      assert.ok(finishFail.error, 'Finish must fail on audit failure');
      assert.match(finishFail.error.message, /INJECTED_OUTBOUND_AUDIT/);

      const rollCall = (await db.query<{ recording_status: string; customer_id: string | null }>(
        'SELECT recording_status, customer_id FROM zalo_personal_calls WHERE id = $1',
        [reserved.data.call_id]
      )).rows[0];
      assert.equal(rollCall.recording_status, 'UPLOADING', 'Recording status must remain UPLOADING upon audit rollback');
      assert.equal(rollCall.customer_id, null, 'Customer must remain unlinked upon audit rollback');

      const reqAuditStatus = (await db.query<{ status: string }>(
        'SELECT status FROM zalo_outbound_call_requests WHERE id = $1',
        [reqAuditRollback]
      )).rows[0].status;
      assert.equal(reqAuditStatus, 'CALL_TRIGGERED', 'Request status must not be changed on rollback');

      const auditCount = (await db.query<{ count: number }>(
        `SELECT count(*)::int as count FROM audit_logs WHERE resource_id = $1 AND action = 'ZALO_RECORDING_READY'`,
        [reserved.data.call_id]
      )).rows[0].count;
      assert.equal(auditCount, 0, 'No audit log entry must be present on rollback');
    } finally {
      await db.exec(`DROP TRIGGER IF EXISTS trg_fail_audit ON audit_logs; DROP FUNCTION IF EXISTS trg_fail_audit_fn();`);
    }

    // =========================================================================
    // 6. REST API COLUMN-LEVEL GRANT ON zalo_outbound_call_requests
    // Safe columns allowed for authenticated, phone_normalized is DENIED
    // =========================================================================
    await db.query(`SET ROLE authenticated`);
    await db.query(`SET request.jwt.claim.sub = '${saleA1}'`);

    // Safe columns query succeeds
    const safeSelect = await db.query(
      `SELECT id, company_id, customer_id, staff_user_id, expected_display_name, status, failure_reason, created_at FROM zalo_outbound_call_requests LIMIT 1`
    );
    assert.ok(safeSelect.rows !== undefined, 'Safe column SELECT must succeed');

    // Attempting to select phone_normalized must fail with 42501 permission denied
    await assert.rejects(
      db.query(`SELECT phone_normalized FROM zalo_outbound_call_requests LIMIT 1`),
      (err: any) => err.code === '42501',
      'Selecting phone_normalized as authenticated must fail with 42501 permission denied'
    );

    await db.query(`RESET ROLE`);

    // =========================================================================
    // 7. HTTP ROUTE HANDLER TESTS (Validation, status enforcement, phone privacy)
    // =========================================================================
    // Status POST: missing device/token -> 401
    const resNoAuth = await statusPostHandler(new Request('http://localhost/api/voice/zalo-personal/outbound/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: randomUUID(), status: 'CALL_TRIGGERED' }),
    }));
    assert.equal(resNoAuth.status, 401, 'Missing device/token headers must return 401');

    // Status POST: COMPLETED status blocked -> 400
    const resBlockedCompleted = await statusPostHandler(new Request('http://localhost/api/voice/zalo-personal/outbound/status', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-zalo-device-id': deviceA1,
        'authorization': `Bearer ${secretA1}`,
      },
      body: JSON.stringify({ request_id: randomUUID(), status: 'COMPLETED' }),
    }));
    assert.equal(resBlockedCompleted.status, 400, 'COMPLETED status from agent must return 400');
    assert.equal((await resBlockedCompleted.json()).error, 'INVALID_STATUS');

    // Status POST: Invalid status -> 400
    const resInvalidStatus = await statusPostHandler(new Request('http://localhost/api/voice/zalo-personal/outbound/status', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-zalo-device-id': deviceA1,
        'authorization': `Bearer ${secretA1}`,
      },
      body: JSON.stringify({ request_id: randomUUID(), status: 'SOME_BOGUS_STATUS' }),
    }));
    assert.equal(resInvalidStatus.status, 400);

    // Status POST: Invalid UUID -> 400
    const resInvalidUuid = await statusPostHandler(new Request('http://localhost/api/voice/zalo-personal/outbound/status', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-zalo-device-id': deviceA1,
        'authorization': `Bearer ${secretA1}`,
      },
      body: JSON.stringify({ request_id: 'not-a-uuid', status: 'CALL_TRIGGERED' }),
    }));
    assert.equal(resInvalidUuid.status, 400);

    // Claim POST: missing auth -> 401
    const resClaimNoAuth = await claimPostHandler(new Request('http://localhost/api/voice/zalo-personal/outbound/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: randomUUID() }),
    }));
    assert.equal(resClaimNoAuth.status, 401);

    // Claim POST: invalid UUID -> 400
    const resClaimBadUuid = await claimPostHandler(new Request('http://localhost/api/voice/zalo-personal/outbound/claim', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-zalo-device-id': deviceA1,
        'authorization': `Bearer ${secretA1}`,
      },
      body: JSON.stringify({ request_id: 'not-a-uuid' }),
    }));
    assert.equal(resClaimBadUuid.status, 400);

    // Status GET: missing or invalid request_id -> 400
    const resGetMissing = await statusGetHandler(new Request('http://localhost/api/voice/zalo-personal/outbound/status'));
    assert.equal(resGetMissing.status, 400);

    const resGetBadUuid = await statusGetHandler(new Request('http://localhost/api/voice/zalo-personal/outbound/status?request_id=abc'));
    assert.equal(resGetBadUuid.status, 400);

    // =========================================================================
    // 8. QUERY & ACTION LOGIC TESTS (SALE scoping & explicit phone stripping)
    // =========================================================================
    // Verify SALE scoping query: Sale 1 can only access Sale 1's request
    const sale1Query = await h.client
      .from('zalo_outbound_call_requests')
      .select('id, customer_id, staff_user_id, status, failure_reason, expected_display_name, created_at, claimed_at, completed_at')
      .eq('company_id', companyA)
      .eq('id', reqSaleA2)
      .eq('staff_user_id', saleA1)
      .maybeSingle();
    assert.equal(sale1Query.data, null, 'Sale 1 must NOT be able to view Sale 2 request');

    // Sale 2 can access Sale 2's request
    const sale2Query = await h.client
      .from('zalo_outbound_call_requests')
      .select('id, customer_id, staff_user_id, status, failure_reason, expected_display_name, created_at, claimed_at, completed_at')
      .eq('company_id', companyA)
      .eq('id', reqSaleA2)
      .eq('staff_user_id', saleA2)
      .maybeSingle();
    assert.ok(sale2Query.data !== null, 'Sale 2 can view own request');
    assert.equal('phone' in sale2Query.data!, false, 'phone must not be present in output');
    assert.equal('phone_normalized' in sale2Query.data!, false, 'phone_normalized must not be present in output');

    // Boss Admin sees across company without staff_user_id restriction
    const bossQuery = await h.client
      .from('zalo_outbound_call_requests')
      .select('id, customer_id, staff_user_id, status, failure_reason, expected_display_name, created_at, claimed_at, completed_at')
      .eq('company_id', companyA)
      .eq('id', reqSaleA2)
      .maybeSingle();
    assert.ok(bossQuery.data !== null, 'Boss can view company requests');
    assert.equal('phone' in bossQuery.data!, false, 'phone must not be present in boss output');
    assert.equal('phone_normalized' in bossQuery.data!, false, 'phone_normalized must not be present in boss output');

    console.log('PASS: outbound hardening tests (exploit baseline, tenant/device/staff isolation, claim replay, state regression, positive long call after expiry, idempotence, atomic rollback, REST phone privacy, runtime route validation)');
  } finally {
    await h.close();
  }
}

if (process.argv[1]?.endsWith('outbound-hardening.test.ts')) {
  runOutboundHardeningTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
