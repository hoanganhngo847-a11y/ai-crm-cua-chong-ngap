import OpenAI from 'openai';
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminClient } from '../../../../lib/supabase/admin';

export const runtime = 'nodejs';

const DEFAULT_INSTRUCTIONS = `Bạn là trợ lý Hotline của công ty cửa chống ngập.
Luôn nói tiếng Việt, lịch sự, ngắn gọn và không khẳng định giá khi chưa khảo sát.
Hãy chào khách, hỏi lần lượt: tên khách, loại cửa/vị trí cần lắp, chiều rộng và chiều cao ước tính,
mức ngập dự kiến, số lượng ô cửa, địa chỉ khảo sát, thời gian khảo sát mong muốn và ghi chú.
Xác nhận lại thông tin quan trọng trước khi kết thúc. Nếu khách chưa biết kích thước thì bỏ qua,
không tự suy đoán. Không đọc lại số điện thoại của khách. Thông báo nhân viên sẽ xác nhận lịch khảo sát.`;

async function setEventStatus(eventId: string, status: 'ACCEPTED' | 'FAILED', errorCode?: string) {
  const admin = createAdminClient();
  await admin.from('openai_realtime_events').update({
    status,
    error_code: errorCode || null,
    processed_at: new Date().toISOString(),
  }).eq('event_id', eventId);
}

/** OpenAI webhook: verify raw body, deduplicate by webhook event id, then accept SIP. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  const webhookSecret = process.env.OPENAI_WEBHOOK_SECRET;
  const companyId = process.env.COMPANY_ID_DEFAULT;
  if (!apiKey || !webhookSecret || !companyId) {
    return NextResponse.json({ error: 'Realtime voice is not configured' }, { status: 503 });
  }

  const rawBody = await request.text();
  const client = new OpenAI({ apiKey, webhookSecret });
  let event: Awaited<ReturnType<typeof client.webhooks.unwrap>>;
  try {
    event = await client.webhooks.unwrap(rawBody, request.headers);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (event.type !== 'realtime.call.incoming') {
    return NextResponse.json({ ok: true, handled: false });
  }

  const admin = createAdminClient();
  const { error: insertError } = await admin.from('openai_realtime_events').insert({
    event_id: event.id,
    company_id: companyId,
    openai_call_id: event.data.call_id,
    status: 'PROCESSING',
  });

  if (insertError) {
    if (insertError.code !== '23505') {
      return NextResponse.json({ error: 'Cannot persist event' }, { status: 500 });
    }
    const { data: existing } = await admin.from('openai_realtime_events')
      .select('status, last_attempt_at').eq('event_id', event.id).maybeSingle();
    const stale = existing?.status === 'PROCESSING' &&
      Date.parse(existing.last_attempt_at) < Date.now() - 2 * 60 * 1000;
    if (existing?.status !== 'FAILED' && !stale) {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    const { data: reclaimed } = await admin.from('openai_realtime_events')
      .update({
        status: 'PROCESSING', error_code: null, processed_at: null,
        last_attempt_at: new Date().toISOString(),
      })
      .eq('event_id', event.id).eq('status', existing?.status || 'FAILED')
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
      audio: {
        output: {
          voice: process.env.OPENAI_REALTIME_VOICE || 'marin',
          speed: 1,
        },
      },
      max_output_tokens: 700,
    });
    await setEventStatus(event.id, 'ACCEPTED');
    return NextResponse.json({ ok: true });
  } catch {
    await setEventStatus(event.id, 'FAILED', 'REALTIME_ACCEPT_FAILED');
    return NextResponse.json({ error: 'Cannot accept call' }, { status: 502 });
  }
}
