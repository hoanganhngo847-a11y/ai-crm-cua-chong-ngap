import { createAdminClient } from '../../../../../../lib/supabase/admin';
import { RecordingError, sha256, UUID } from '../../../../../../features/zalo-recordings/metadata';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const device = request.headers.get('x-zalo-device-id') || '';
    const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{40,128})$/)?.[1];
    if (!UUID.test(device) || !token) throw new RecordingError('DEVICE_UNAUTHORIZED', 401);

    const body = await request.json().catch(() => ({}));
    const requestId = body?.request_id;
    if (!requestId || typeof requestId !== 'string' || !UUID.test(requestId)) {
      throw new RecordingError('INVALID_REQUEST', 400);
    }

    const hash = sha256(token);
    const admin = createAdminClient();
    const { data, error } = await admin.rpc('zalo_claim_outbound_call_request', {
      p_device: device,
      p_key_hash: hash,
      p_request_id: requestId,
    });

    if (error) {
      if (error.code === '42501') throw new RecordingError('DEVICE_UNAUTHORIZED', 401);
      if (error.message?.includes('ZALO_REQUEST_EXPIRED')) throw new RecordingError('REQUEST_EXPIRED', 410);
      if (error.message?.includes('ZALO_REQUEST_ALREADY_CLAIMED')) throw new RecordingError('REQUEST_ALREADY_CLAIMED', 409);
      if (error.message?.includes('ZALO_REQUEST_NOT_FOUND')) throw new RecordingError('REQUEST_NOT_FOUND', 404);
      throw new RecordingError('CLAIM_UNAVAILABLE', 503);
    }

    return Response.json({ ok: true, request: data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const known = error instanceof RecordingError;
    return Response.json(
      { ok: false, error: known ? error.code : 'CLAIM_UNAVAILABLE' },
      { status: known ? error.status : 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
