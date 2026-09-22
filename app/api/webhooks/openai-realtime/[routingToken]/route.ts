import OpenAI from 'openai';
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminClient } from '../../../../../lib/supabase/admin';
import { resolveVoiceIntegration } from '../../../../../features/voice/services/integration-resolver';

export const runtime = 'nodejs';
type Context = { params: Promise<{ routingToken: string }> };

const DEFAULT_INSTRUCTIONS = `Bạn là trợ lý Hotline của công ty cửa chống ngập.
Luôn nói tiếng Việt, lịch sự, ngắn gọn và không khẳng định giá khi chưa khảo sát.
Hỏi tên khách, loại cửa, kích thước ước tính, mức ngập, số ô cửa, địa chỉ và thời gian khảo sát.
Không tự suy đoán và không đọc lại số điện thoại. Xác nhận thông tin trước khi kết thúc.`;

async function setEventStatus(
  eventId: string,
  companyId: string,
  status: 'ACCEPTED' | 'FAILED',
  errorCode?: string
) {
  const admin = createAdminClient();
  await admin.from('openai_realtime_events').update({
    status, error_code: errorCode || null, processed_at: new Date().toISOString(),
  }).eq('event_id', eventId).eq('company_id', companyId);
}

export async function POST(request: NextRequest, context: Context): Promise<NextResponse> {
  const { routingToken } = await context.params;
  const integration = await resolveVoiceIntegration('OPENAI_REALTIME', routingToken);
  if (!integration) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!integration.apiKey) return NextResponse.json({ error: 'Realtime voice is not configured' }, { status: 503 });

  const rawBody = await request.text();
  const client = new OpenAI({ apiKey: integration.apiKey, webhookSecret: integration.webhookSecret });
  let event: Awaited<ReturnType<typeof client.webhooks.unwrap>>;
  try { event = await client.webhooks.unwrap(rawBody, request.headers); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }
  if (event.type !== 'realtime.call.incoming') {
    return NextResponse.json({ ok: true, handled: false });
  }

  const admin = createAdminClient();
  const { error: insertError } = await admin.from('openai_realtime_events').insert({
    event_id: event.id,
    company_id: integration.companyId,
    openai_call_id: event.data.call_id,
    status: 'PROCESSING',
  });
  if (insertError) {
    if (insertError.code !== '23505') return NextResponse.json({ error: 'Cannot persist event' }, { status: 500 });
    const { data: existing } = await admin.from('openai_realtime_events')
      .select('status, last_attempt_at, company_id').eq('event_id', event.id).maybeSingle();
    if (existing?.company_id !== integration.companyId) {
      return NextResponse.json({ error: 'Event tenant mismatch' }, { status: 403 });
    }
    const stale = existing?.status === 'PROCESSING' &&
      Date.parse(existing.last_attempt_at) < Date.now() - 2 * 60 * 1000;
    if (existing?.status !== 'FAILED' && !stale) return NextResponse.json({ ok: true, duplicate: true });
    const { data: reclaimed } = await admin.from('openai_realtime_events')
      .update({
        status: 'PROCESSING', error_code: null, processed_at: null,
        last_attempt_at: new Date().toISOString(),
      })
      .eq('event_id', event.id).eq('company_id', integration.companyId)
      .eq('status', existing?.status || 'FAILED')
      .eq('last_attempt_at', existing?.last_attempt_at || '')
      .select('event_id').maybeSingle();
    if (!reclaimed) return NextResponse.json({ ok: true, duplicate: true });
  }

  try {
    await client.realtime.calls.accept(event.data.call_id, {
      type: 'realtime',
      model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1',
      instructions: process.env.OPENAI_REALTIME_INSTRUCTIONS || DEFAULT_INSTRUCTIONS,
      output_modalities: ['audio'],
      audio: { output: { voice: process.env.OPENAI_REALTIME_VOICE || 'marin', speed: 1 } },
      max_output_tokens: 700,
    });
    await setEventStatus(event.id, integration.companyId, 'ACCEPTED');
    return NextResponse.json({ ok: true });
  } catch {
    await setEventStatus(event.id, integration.companyId, 'FAILED', 'REALTIME_ACCEPT_FAILED');
    return NextResponse.json({ error: 'Cannot accept call' }, { status: 502 });
  }
}
