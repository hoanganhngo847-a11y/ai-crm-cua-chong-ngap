import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPgliteSupabase } from '../zalo/helpers/pglite-supabase';
import { sha256 } from '../../features/zalo-recordings/metadata';
import { POST as heartbeatHandler } from '../../app/api/voice/zalo-personal/devices/heartbeat/route';

async function main() {
  const h = await createPgliteSupabase();
  const db = h.db;
  const company = randomUUID();
  const boss = randomUUID();
  const sale1 = randomUUID();
  const sale2 = randomUUID();
  const device1 = randomUUID();
  const device2 = randomUUID();
  const secret1 = randomBytes(32).toString('base64url');
  const secret2 = randomBytes(32).toString('base64url');

  try {
    // 1. Setup tenant & users
    await db.query(`INSERT INTO companies(id, name) VALUES($1, 'Heartbeat Tenant')`, [company]);
    for (const [id, role] of [[boss, 'BOSS_ADMIN'], [sale1, 'SALE'], [sale2, 'SALE']]) {
      await db.query('INSERT INTO auth.users(id) VALUES($1)', [id]);
      await db.query(`INSERT INTO user_profiles(id, full_name) VALUES($1, 'User') ON CONFLICT(id) DO NOTHING`, [id]);
      await db.query(`INSERT INTO company_members(company_id, user_id, role, status) VALUES($1, $2, $3, 'ACTIVE')`, [company, id, role === 'SALE' && id === sale2 ? 'BOSS_ADMIN' : role]);
    }

    // 2. Register devices
    // Device 1: assigned to sale1
    const reg1 = await h.client.rpc('zalo_manage_device', {
      p_company: company,
      p_actor: boss,
      p_device: device1,
      p_name: 'MacBook Air - Sale 1',
      p_hash: sha256(secret1),
      p_staff: sale1,
    });
    assert.ifError(reg1.error);

    // Device 2: unassigned (shared)
    const reg2 = await h.client.rpc('zalo_manage_device', {
      p_company: company,
      p_actor: boss,
      p_device: device2,
      p_name: 'MacBook Pro - Shared',
      p_hash: sha256(secret2),
      p_staff: null,
    });
    assert.ifError(reg2.error);

    // 3. Test RPC: zalo_device_heartbeat with healthy payload -> ONLINE
    const hb1 = await h.client.rpc('zalo_device_heartbeat', {
      p_device: device1,
      p_key_hash: sha256(secret1),
      p_agent_version: '1.2.0',
      p_agent_status: 'ONLINE',
      p_zalo_running: true,
      p_permissions_ok: true,
      p_permissions_detail: { microphone: true, screen_recording: true, accessibility: true },
      p_loopback_ready: true,
      p_error_code: null,
    });
    assert.ifError(hb1.error);
    assert.equal(hb1.data.ok, true);
    assert.equal(hb1.data.status, 'ONLINE');

    // 4. Test RPC: missing permissions -> forced DEGRADED
    const hbDegraded = await h.client.rpc('zalo_device_heartbeat', {
      p_device: device2,
      p_key_hash: sha256(secret2),
      p_agent_version: '1.2.0',
      p_agent_status: 'ONLINE', // client claimed online but permissions false
      p_zalo_running: false,
      p_permissions_ok: false,
      p_permissions_detail: { microphone: true, screen_recording: true, accessibility: false },
      p_loopback_ready: true,
      p_error_code: 'AX_MISSING',
    });
    assert.ifError(hbDegraded.error);
    assert.equal(hbDegraded.data.ok, true);
    assert.equal(hbDegraded.data.status, 'DEGRADED');

    // 5. Test RPC: unauthorized secret -> rejected
    const hbBad = await h.client.rpc('zalo_device_heartbeat', {
      p_device: device1,
      p_key_hash: sha256('wrong-secret-token-padding-padding-padding'),
      p_agent_version: '1.2.0',
      p_agent_status: 'ONLINE',
      p_zalo_running: true,
      p_permissions_ok: true,
      p_permissions_detail: {},
      p_loopback_ready: true,
      p_error_code: null,
    });
    assert.ok(hbBad.error);
    assert.equal(hbBad.error.code, '42501');

    // 6. Test RPC: zalo_get_devices_readiness
    const readinessForSale1 = await h.client.rpc('zalo_get_devices_readiness', {
      p_company: company,
      p_actor: sale1,
    });
    assert.ifError(readinessForSale1.error);
    const devices = readinessForSale1.data.devices;
    assert.equal(devices.length, 2);

    // First device in list should be the one assigned to sale1 and ONLINE
    assert.equal(devices[0].id, device1);
    assert.equal(devices[0].is_current_staff, true);
    assert.equal(devices[0].computed_status, 'ONLINE');
    assert.equal(devices[0].agent_version, '1.2.0');

    // Second device is DEGRADED
    assert.equal(devices[1].id, device2);
    assert.equal(devices[1].computed_status, 'DEGRADED');

    // 7. Test timeout offline: simulate last_seen_at > 3 minutes ago
    await db.query(`UPDATE zalo_recording_devices SET last_seen_at = now() - interval '5 minutes' WHERE id = $1`, [device1]);
    const readinessAfterTimeout = await h.client.rpc('zalo_get_devices_readiness', {
      p_company: company,
      p_actor: sale1,
    });
    assert.ifError(readinessAfterTimeout.error);
    const devicesAfterTimeout = readinessAfterTimeout.data.devices;
    const dev1Updated = devicesAfterTimeout.find((d: any) => d.id === device1);
    assert.equal(dev1Updated.computed_status, 'OFFLINE');

    // 8. Test HTTP endpoint validation (missing headers, bad tokens)
    const reqMissingHeaders = new Request('http://localhost:3000/api/voice/zalo-personal/devices/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_version: '1.2.0' }),
    });
    const resMissing = await heartbeatHandler(reqMissingHeaders);
    assert.equal(resMissing.status, 401);

    const reqBadToken = new Request('http://localhost:3000/api/voice/zalo-personal/devices/heartbeat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-zalo-device-id': device1,
        'Authorization': 'Bearer bad-token',
      },
      body: JSON.stringify({ agent_version: '1.2.0' }),
    });
    const resBadToken = await heartbeatHandler(reqBadToken);
    assert.equal(resBadToken.status, 401);

    console.log('PASS: Heartbeat RPC, status calculation, permissions degradation, and timeout offline gate');
  } finally {
    await h.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
