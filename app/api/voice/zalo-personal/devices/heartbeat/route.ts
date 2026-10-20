import { createAdminClient } from '../../../../../../lib/supabase/admin';
import { RecordingError, sha256, UUID } from '../../../../../../features/zalo-recordings/metadata';

export const runtime = 'nodejs';

interface HeartbeatBody {
  agent_version?: string;
  zalo_running?: boolean;
  permissions?: {
    microphone?: boolean;
    screen_recording?: boolean;
    accessibility?: boolean;
  };
  loopback_ready?: boolean;
  recording_ready?: boolean;
  error_code?: string | null;
}

export async function POST(request: Request) {
  try {
    const device = request.headers.get('x-zalo-device-id') || '';
    const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{40,128})$/)?.[1];
    if (!UUID.test(device) || !token) throw new RecordingError('DEVICE_UNAUTHORIZED', 401);

    const body: HeartbeatBody = await request.json().catch(() => ({}));
    const agentVersion = typeof body.agent_version === 'string' ? body.agent_version.slice(0, 50) : '1.0.0';
    const zaloRunning = Boolean(body.zalo_running);
    const loopbackReady = Boolean(body.loopback_ready);
    const recordingReady = body.recording_ready !== undefined ? Boolean(body.recording_ready) : true;

    const micOk = Boolean(body.permissions?.microphone);
    const screenOk = Boolean(body.permissions?.screen_recording);
    const axOk = Boolean(body.permissions?.accessibility);
    const permissionsOk = micOk && screenOk && axOk;

    const permissionsDetail = {
      microphone: micOk,
      screen_recording: screenOk,
      accessibility: axOk,
      recording_ready: recordingReady,
    };

    const isHealthy = permissionsOk && loopbackReady && recordingReady;
    const agentStatus = isHealthy ? 'ONLINE' : 'DEGRADED';
    const errorCode = typeof body.error_code === 'string' ? body.error_code.slice(0, 200) : null;

    const hash = sha256(token);
    const admin = createAdminClient();
    const { data, error } = await admin.rpc('zalo_device_heartbeat', {
      p_device: device,
      p_key_hash: hash,
      p_agent_version: agentVersion,
      p_agent_status: agentStatus,
      p_zalo_running: zaloRunning,
      p_permissions_ok: permissionsOk,
      p_permissions_detail: permissionsDetail,
      p_loopback_ready: loopbackReady,
      p_error_code: errorCode,
    });

    if (error) {
      if (error.code === '42501') throw new RecordingError('DEVICE_UNAUTHORIZED', 401);
      throw new RecordingError('HEARTBEAT_FAILED', 503);
    }

    return Response.json(
      { ok: true, data },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    const known = error instanceof RecordingError;
    return Response.json(
      { ok: false, error: known ? error.code : 'HEARTBEAT_FAILED' },
      { status: known ? error.status : 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
