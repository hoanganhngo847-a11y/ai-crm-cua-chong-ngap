import { createAdminClient } from '../../../../../../lib/supabase/admin';
import { RecordingError, sha256, UUID } from '../../../../../../features/zalo-recordings/metadata';
import { recordingActor } from '../../../../../../features/zalo-recordings/access';

export const runtime = 'nodejs';

// POST: Called by Mac agent to update status
export async function POST(request: Request) {
  try {
    const device = request.headers.get('x-zalo-device-id') || '';
    const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{40,128})$/)?.[1];
    if (!UUID.test(device) || !token) throw new RecordingError('DEVICE_UNAUTHORIZED', 401);

    const body = await request.json().catch(() => ({}));
    const { request_id, status, failure_reason } = body;
    if (!request_id || !UUID.test(request_id) || typeof status !== 'string') {
      throw new RecordingError('INVALID_REQUEST', 400);
    }

    const validStatuses = ['OPENING_ZALO', 'CONTACT_VERIFIED', 'CALL_TRIGGERED', 'CALL_DETECTED', 'COMPLETED', 'FAILED'];
    if (!validStatuses.includes(status)) throw new RecordingError('INVALID_STATUS', 400);

    const hash = sha256(token);
    const admin = createAdminClient();
    const { data, error } = await admin.rpc('zalo_update_outbound_call_status', {
      p_device: device,
      p_key_hash: hash,
      p_request_id: request_id,
      p_status: status,
      p_failure_reason: failure_reason ? String(failure_reason).slice(0, 500) : null,
    });

    if (error) {
      if (error.code === '42501') throw new RecordingError('DEVICE_UNAUTHORIZED', 401);
      throw new RecordingError('STATUS_UPDATE_FAILED', 503);
    }

    return Response.json({ ok: true, data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const known = error instanceof RecordingError;
    return Response.json(
      { ok: false, error: known ? error.code : 'STATUS_UPDATE_FAILED' },
      { status: known ? error.status : 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

// GET: Called by CRM frontend to poll request status
export async function GET(request: Request) {
  try {
    const actor = await recordingActor();
    const { searchParams } = new URL(request.url);
    const requestId = searchParams.get('request_id');
    if (!requestId || !UUID.test(requestId)) throw new RecordingError('INVALID_REQUEST', 400);

    const admin = createAdminClient();
    const { data, error } = await admin
      .from('zalo_outbound_call_requests')
      .select('id, customer_id, status, failure_reason, expected_display_name, phone_normalized, created_at, claimed_at, completed_at')
      .eq('company_id', actor.companyId)
      .eq('id', requestId)
      .maybeSingle();

    if (error || !data) throw new RecordingError('NOT_FOUND', 404);
    return Response.json({ ok: true, request: data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const known = error instanceof RecordingError;
    return Response.json(
      { ok: false, error: known ? error.code : 'UNAVAILABLE' },
      { status: known ? error.status : 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
