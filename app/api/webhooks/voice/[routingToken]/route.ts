import { NextResponse, type NextRequest } from 'next/server';
import {
  verifyWebhookSignature,
  processCallStatusUpdate,
  processInboundCall,
  normalizeVoiceWebhookPayload,
  bindStringeeCallId,
  processCallIntake,
  type VoiceWebhookPayload,
} from '../../../../../features/voice/services/webhook-processor';
import { processRecordingReady } from '../../../../../features/voice/services/media-pipeline';
import { resolveVoiceIntegration } from '../../../../../features/voice/services/integration-resolver';

type Context = { params: Promise<{ routingToken: string }> };

export async function POST(request: NextRequest, context: Context): Promise<NextResponse> {
  const { routingToken } = await context.params;
  const integration = await resolveVoiceIntegration('STRINGEE', routingToken);
  if (!integration) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let rawBody: string;
  try { rawBody = await request.text(); }
  catch { return NextResponse.json({ error: 'Cannot read request body' }, { status: 400 }); }
  if (!verifyWebhookSignature(request.headers, rawBody, integration.webhookSecret, 'STRINGEE')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let payload: VoiceWebhookPayload;
  try { payload = normalizeVoiceWebhookPayload(JSON.parse(rawBody) as VoiceWebhookPayload); }
  catch { return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 }); }
  if (String(payload.project_id ?? payload.projectId ?? '') !== integration.providerAccountId) {
    return NextResponse.json({ error: 'Provider account mismatch' }, { status: 403 });
  }

  try {
    const eventType = (payload.event || '').toLowerCase();
    if (eventType === 'call.inbound' || eventType === 'call_inbound') {
      return NextResponse.json({ ok: true, ...await processInboundCall(payload, integration.companyId, 'STRINGEE') });
    }
    if (['call.status_updated', 'call.completed', 'call_completed', 'call_status_updated'].includes(eventType)) {
      return NextResponse.json({ ok: true, ...await processCallStatusUpdate(payload, integration.companyId, 'STRINGEE') });
    }
    if (eventType === 'call.recording_ready' || eventType === 'call_recording_ready') {
      return NextResponse.json({ ok: true, ...await processRecordingReady(payload, integration.companyId, 'STRINGEE') });
    }
    if (eventType === 'call.intake_completed' || eventType === 'call_intake_completed') {
      return NextResponse.json({ ok: true, ...await processCallIntake(payload, integration.companyId, 'STRINGEE') });
    }
    return NextResponse.json({ ok: true, handled: false });
  } catch {
    return NextResponse.json({ error: 'Internal processing error' }, { status: 500 });
  }
}

export async function GET(request: NextRequest, context: Context): Promise<NextResponse> {
  const { routingToken } = await context.params;
  const integration = await resolveVoiceIntegration('STRINGEE', routingToken);
  if (!integration) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const url = new URL(request.url);
  if (!verifyWebhookSignature(request.headers, `${url.pathname}${url.search}`, integration.webhookSecret, 'STRINGEE')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (url.searchParams.get('projectId') !== integration.providerAccountId) {
    return NextResponse.json({ error: 'Provider account mismatch' }, { status: 403 });
  }

  const fromInternal = url.searchParams.get('fromInternal') === 'true';
  const stringeeCallId = url.searchParams.get('callId') || url.searchParams.get('uuid') || '';
  const correlationId = url.searchParams.get('crmCorrelationId') || '';
  if (correlationId) {
    if (stringeeCallId) await bindStringeeCallId(correlationId, stringeeCallId, integration.companyId);
    const agentUserId = url.searchParams.get('agentUserId') || '';
    if (![integration.aiAgentUserId, integration.saleAgentUserId].filter(Boolean).includes(agentUserId)) {
      return NextResponse.json({ error: 'Invalid agent' }, { status: 400 });
    }
    return NextResponse.json([{
      action: 'connect',
      from: { type: 'external', number: integration.fromNumber || '', alias: 'AI CRM' },
      to: { type: 'internal', number: agentUserId, alias: 'CRM Agent' },
    }]);
  }
  if (fromInternal) return NextResponse.json({ error: 'Missing correlation' }, { status: 400 });

  const inbound = await processInboundCall({
    event: 'call.inbound', provider_call_id: stringeeCallId,
    from_number: url.searchParams.get('from') || undefined,
    to_number: url.searchParams.get('to') || undefined, direction: 'inbound',
  }, integration.companyId, 'STRINGEE');
  if (!inbound.handled) {
    return NextResponse.json([{ action: 'talk', text: 'Xin lỗi, tổng đài đang bận. Vui lòng gọi lại sau.' }]);
  }
  if (!integration.aiAgentUserId) {
    return NextResponse.json([{ action: 'talk', text: 'Xin lỗi, tổng đài đang bận. Vui lòng gọi lại sau.' }]);
  }
  return NextResponse.json([{
    action: 'connect',
    from: { type: 'external', number: url.searchParams.get('from') || '', alias: 'Hotline' },
    to: { type: 'internal', number: integration.aiAgentUserId, alias: 'AI Hotline' },
  }]);
}
