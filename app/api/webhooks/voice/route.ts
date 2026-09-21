import { NextResponse, type NextRequest } from 'next/server';
import {
  verifyWebhookSignature,
  processCallStatusUpdate,
  processInboundCall,
  normalizeVoiceWebhookPayload,
  bindStringeeCallId,
  processCallIntake,
  type VoiceWebhookPayload,
} from '../../../../features/voice/services/webhook-processor';
import { processRecordingReady } from '../../../../features/voice/services/media-pipeline';

/**
 * POST /api/webhooks/voice
 *
 * Nhận event từ tổng đài / SIP provider.
 *
 * Security:
 * - Verify signature trước mọi xử lý.
 * - Dùng createAdminClient() bên trong — không dùng user session.
 * - Không trả dữ liệu nhạy cảm trong response.
 * - Chống trùng: processInboundCall kiểm tra provider_call_id.
 *
 * Event types được hỗ trợ:
 * - call.inbound          — khách gọi vào Hotline
 * - call.status_updated   — trạng thái cuộc gọi thay đổi
 * - call.completed        — cuộc gọi kết thúc (alias cho status_updated)
 * - call.recording_ready  — enqueue tải recording và chuyển lời bất đồng bộ
 *
 * Biến môi trường cần có:
 *   VOICE_WEBHOOK_SECRET  — secret dùng để xác thực webhook
 *   VOICE_PROVIDER        — 'STRINGEE' | 'MANUAL'
 *   COMPANY_ID_DEFAULT    — company_id mặc định (single-company phase)
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: 'Cannot read request body' }, { status: 400 });
  }

  // ── Verify signature ──────────────────────────────────────────────────────
  const isValid = verifyWebhookSignature(request.headers, rawBody);
  if (!isValid) {
    console.warn('[webhook/voice] Invalid signature — rejecting request');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── Parse payload ─────────────────────────────────────────────────────────
  let payload: VoiceWebhookPayload;
  try {
    payload = normalizeVoiceWebhookPayload(JSON.parse(rawBody) as VoiceWebhookPayload);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  // Company ID — single-company phase: lấy từ env hoặc routing token
  // Multi-tenant sau này sẽ lookup theo số Hotline hoặc routing token
  const companyId = process.env.COMPANY_ID_DEFAULT || '';

  if (!companyId) {
    console.error('[webhook/voice] Cannot determine companyId from webhook payload');
    return NextResponse.json({ error: 'Cannot determine company' }, { status: 400 });
  }

  // ── Route theo event type ─────────────────────────────────────────────────
  try {
    const eventType = (payload.event || '').toLowerCase();

    if (eventType === 'call.inbound' || eventType === 'call_inbound') {
      const result = await processInboundCall(payload, companyId);
      return NextResponse.json({ ok: true, ...result }, { status: 200 });
    }

    if (
      eventType === 'call.status_updated' ||
      eventType === 'call.completed' ||
      eventType === 'call_completed' ||
      eventType === 'call_status_updated'
    ) {
      const result = await processCallStatusUpdate(payload);
      return NextResponse.json({ ok: true, ...result }, { status: 200 });
    }

    if (eventType === 'call.recording_ready' || eventType === 'call_recording_ready') {
      const result = await processRecordingReady(payload, companyId);
      return NextResponse.json({ ok: true, ...result }, { status: 200 });
    }

    if (eventType === 'call.intake_completed' || eventType === 'call_intake_completed') {
      const result = await processCallIntake(payload, companyId);
      return NextResponse.json({ ok: true, ...result }, { status: 200 });
    }

    // Event không được nhận dạng — return 200 để tổng đài không retry
    console.log(`[webhook/voice] Unhandled event type: ${payload.event}`);
    return NextResponse.json({ ok: true, message: 'event acknowledged but not handled' }, { status: 200 });
  } catch (err) {
    const error = err as Error;
    // SECURITY: Không trả chi tiết lỗi nội bộ ra ngoài
    console.error('[webhook/voice] Processing error:', error.message);
    return NextResponse.json({ error: 'Internal processing error' }, { status: 500 });
  }
}

// GET không được hỗ trợ — trả 405
export async function GET(request: NextRequest): Promise<NextResponse> {
  if ((process.env.VOICE_PROVIDER || '').toUpperCase() !== 'STRINGEE') {
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  }

  // Stringee signs GET answer_url requests over the complete Request-URI.
  const url = new URL(request.url);
  if (!verifyWebhookSignature(request.headers, `${url.pathname}${url.search}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const companyId = process.env.COMPANY_ID_DEFAULT || '';
  if (!companyId) return NextResponse.json({ error: 'Cannot determine company' }, { status: 400 });

  const fromInternal = url.searchParams.get('fromInternal') === 'true';
  const stringeeCallId = url.searchParams.get('callId') || url.searchParams.get('uuid') || '';
  const correlationId = url.searchParams.get('crmCorrelationId') || '';

  // REST callout answer_url carries our non-sensitive correlation and agent ids.
  if (correlationId) {
    if (stringeeCallId) await bindStringeeCallId(correlationId, stringeeCallId, companyId);
    const agentUserId = url.searchParams.get('agentUserId') || '';
    const allowedAgents = [
      process.env.STRINGEE_AI_AGENT_USER_ID,
      process.env.STRINGEE_SALE_AGENT_USER_ID,
    ].filter(Boolean);
    if (!allowedAgents.includes(agentUserId)) {
      return NextResponse.json({ error: 'Invalid agent' }, { status: 400 });
    }
    return NextResponse.json([{
      action: 'connect',
      from: { type: 'external', number: process.env.STRINGEE_FROM_NUMBER || '', alias: 'AI CRM' },
      to: { type: 'internal', number: agentUserId, alias: 'CRM Agent' },
    }]);
  }

  if (fromInternal) return NextResponse.json({ error: 'Missing correlation' }, { status: 400 });

  await processInboundCall({
    event: 'call.inbound',
    provider_call_id: stringeeCallId,
    from_number: url.searchParams.get('from') || undefined,
    to_number: url.searchParams.get('to') || undefined,
    direction: 'inbound',
  }, companyId);

  const aiAgentUserId = process.env.STRINGEE_AI_AGENT_USER_ID;
  if (!aiAgentUserId) {
    return NextResponse.json([{ action: 'talk', text: 'Xin lỗi, tổng đài đang bận. Vui lòng gọi lại sau.' }]);
  }
  return NextResponse.json([{
    action: 'connect',
    from: { type: 'external', number: url.searchParams.get('from') || '', alias: 'Hotline' },
    to: { type: 'internal', number: aiAgentUserId, alias: 'AI Hotline' },
  }]);
}
