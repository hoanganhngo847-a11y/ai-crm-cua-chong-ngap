import 'server-only';
import OpenAI from 'openai';
import { createAdminClient } from '../../../lib/supabase/admin';
import { resolveVoiceIntegration } from './integration-resolver';

const DEFAULT_INSTRUCTIONS = `Bạn là trợ lý Hotline của công ty cửa chống ngập.
Luôn nói tiếng Việt, lịch sự, ngắn gọn và không khẳng định giá khi chưa khảo sát.
Hỏi tên khách, loại cửa, kích thước ước tính, mức ngập, số ô cửa, địa chỉ và thời gian khảo sát.
Không tự suy đoán và không đọc lại số điện thoại. Xác nhận thông tin trước khi kết thúc.`;

async function setEventStatus(
  eventId: string,
  companyId: string,
  status: 'ACCEPTED' | 'FAILED',
  errorCode?: string
): Promise<void> {
  const admin = createAdminClient();
  await admin.from('openai_realtime_events').update({
    status,
    error_code: errorCode || null,
    processed_at: new Date().toISOString(),
  }).eq('event_id', eventId).eq('company_id', companyId);
}

export interface RealtimeWebhookResult {
  status: number;
  body: Record<string, unknown>;
}

export async function handleOpenAiRealtimeWebhook(
  routingToken: string,
  rawBody: string,
  headers: Headers
): Promise<RealtimeWebhookResult> {
  const traceId = `rt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const integration = await resolveVoiceIntegration('OPENAI_REALTIME', routingToken);
  if (!integration) {
    return { status: 404, body: { error: 'NOT_FOUND', trace_id: traceId } };
  }
  if (!integration.apiKey) {
    return { status: 503, body: { error: 'PROVIDER_NOT_CONFIGURED', trace_id: traceId } };
  }

  const client = new OpenAI({ apiKey: integration.apiKey, webhookSecret: integration.webhookSecret });
  let event: Awaited<ReturnType<typeof client.webhooks.unwrap>>;
  try {
    event = await client.webhooks.unwrap(rawBody, headers);
  } catch {
    return { status: 401, body: { error: 'UNAUTHORIZED', trace_id: traceId } };
  }

  if (event.type !== 'realtime.call.incoming') {
    return { status: 200, body: { ok: true, handled: false } };
  }

  const admin = createAdminClient();
  const { error: insertError } = await admin.from('openai_realtime_events').insert({
    event_id: event.id,
    company_id: integration.companyId,
    openai_call_id: event.data.call_id,
    status: 'PROCESSING',
  });

  if (insertError) {
    if (insertError.code !== '23505') {
      console.error(`[realtime-handler] trace=${traceId} cannot persist event:`, insertError.message);
      return { status: 500, body: { error: 'PERSISTENCE_FAILED', trace_id: traceId } };
    }
    const { data: existing } = await admin.from('openai_realtime_events')
      .select('status, last_attempt_at, company_id').eq('event_id', event.id).maybeSingle();
    if (existing?.company_id !== integration.companyId) {
      return { status: 403, body: { error: 'TENANT_MISMATCH', trace_id: traceId } };
    }
    const stale = existing?.status === 'PROCESSING' &&
      Date.parse(existing.last_attempt_at) < Date.now() - 2 * 60 * 1000;
    if (existing?.status !== 'FAILED' && !stale) {
      return { status: 200, body: { ok: true, duplicate: true } };
    }
    const { data: reclaimed } = await admin.from('openai_realtime_events')
      .update({
        status: 'PROCESSING',
        error_code: null,
        processed_at: null,
        last_attempt_at: new Date().toISOString(),
      })
      .eq('event_id', event.id).eq('company_id', integration.companyId)
      .eq('status', existing?.status || 'FAILED')
      .eq('last_attempt_at', existing?.last_attempt_at || '')
      .select('event_id').maybeSingle();
    if (!reclaimed) {
      return { status: 200, body: { ok: true, duplicate: true } };
    }
  }

  try {
    await client.realtime.calls.accept(event.data.call_id, {
      type: 'realtime',
      model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1',
      instructions: process.env.OPENAI_REALTIME_INSTRUCTIONS || DEFAULT_INSTRUCTIONS,
      output_modalities: ['audio'],
      audio: { output: { voice: (process.env.OPENAI_REALTIME_VOICE || 'marin') as 'marin', speed: 1 } },
      max_output_tokens: 700,
    });
    await setEventStatus(event.id, integration.companyId, 'ACCEPTED');
    return { status: 200, body: { ok: true } };
  } catch (acceptErr) {
    console.error(`[realtime-handler] trace=${traceId} accept call failed:`, (acceptErr as Error).message);
    await setEventStatus(event.id, integration.companyId, 'FAILED', 'REALTIME_ACCEPT_FAILED');
    return { status: 502, body: { error: 'CALL_ACCEPT_FAILED', trace_id: traceId } };
  }
}
