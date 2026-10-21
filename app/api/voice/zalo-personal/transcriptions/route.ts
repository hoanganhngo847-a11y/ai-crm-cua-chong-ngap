import { createAdminClient } from '../../../../../lib/supabase/admin';
import { authorizedRecording } from '../../../../../features/zalo-recordings/access';
import { RecordingError, UUID } from '../../../../../features/zalo-recordings/metadata';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const callId = url.searchParams.get('callId') || '';
    if (!UUID.test(callId)) {
      throw new RecordingError('INVALID_CALL_ID', 400);
    }

    const { actor, call } = await authorizedRecording(callId);
    const admin = createAdminClient();

    const { data: tx, error: txError } = await admin
      .from('zalo_call_transcriptions')
      .select('id,company_id,call_id,customer_id,status,provider,language,raw_channel_layout,channels_silent,started_at,completed_at,error_code,full_transcript,created_at')
      .eq('company_id', actor.companyId)
      .eq('call_id', call.id)
      .maybeSingle();

    if (txError) {
      throw new RecordingError('TRANSCRIPTION_UNAVAILABLE', 503);
    }

    if (!tx) {
      return Response.json(
        {
          ok: true,
          data: {
            call_id: call.id,
            status: (call as { transcript_status?: string }).transcript_status || 'NOT_STARTED',
            utterances: [],
            full_transcript: null,
          },
        },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    let utterances: Array<Record<string, unknown>> = [];
    if (tx.status === 'COMPLETED') {
      const { data: utts, error: uttsError } = await admin
        .from('zalo_call_transcript_utterances')
        .select('id,sequence,speaker_role,channel,start_ms,end_ms,text,confidence')
        .eq('transcription_id', tx.id)
        .eq('company_id', actor.companyId)
        .order('sequence', { ascending: true });

      if (uttsError) {
        throw new RecordingError('TRANSCRIPTION_UTTERANCES_UNAVAILABLE', 503);
      }
      utterances = utts || [];

      await admin.from('audit_logs').insert({
        company_id: actor.companyId,
        user_id: actor.userId,
        action: 'ZALO_TRANSCRIPTION_VIEW',
        resource_type: 'ZALO_CALL',
        resource_id: call.id,
        customer_id: call.customer_id,
        result: 'SUCCESS',
        metadata: { transcription_id: tx.id },
      });
    }

    return Response.json(
      {
        ok: true,
        data: {
          ...tx,
          utterances,
        },
      },
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
