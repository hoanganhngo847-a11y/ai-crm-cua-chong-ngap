import { createAdminClient } from '../../../../../../lib/supabase/admin';
import { authorizedRecording } from '../../../../../../features/zalo-recordings/access';
import { RecordingError, UUID } from '../../../../../../features/zalo-recordings/metadata';
import { processTargetedZaloTranscriptionJob, retryZaloTranscriptionJob } from '../../../../../../features/zalo-transcription/service';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { callId } = body;
    if (!callId || !UUID.test(callId)) {
      throw new RecordingError('INVALID_CALL_ID', 400);
    }

    const { actor, call } = await authorizedRecording(callId);
    const admin = createAdminClient();

    const result = await retryZaloTranscriptionJob(actor.companyId, actor.userId, call.id, admin);
    if (result?.transcription_id) {
      await processTargetedZaloTranscriptionJob(result.transcription_id, {
        companyId: actor.companyId,
        client: admin,
      }).catch((err) => {
        console.error('[transcriptions/retry] Targeted job error:', err);
      });
    }

    return Response.json(
      { ok: true, data: result },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    const known = error instanceof RecordingError;
    const status = known ? error.status : 503;
    const code = known ? error.message : 'INTERNAL_ERROR';
    return Response.json(
      { error: code },
      { status, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
