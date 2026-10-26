import { NextRequest, NextResponse } from 'next/server';
import { ingestNormalizedEvent } from '@/features/inbox/services/inbox-ingress.service';
import {
  parseBotcakeInboundPayload,
  verifyBotcakeSecret,
  type BotcakeInboundPayload,
} from '@/features/omnichannel/botcake/webhook';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_ID_RE = /^\d{1,100}$/;
const MAX_BODY_BYTES = 128 * 1024;

function configuredPageId(): string {
  return (process.env.BOTCAKE_PAGE_ID || '').trim();
}

function configuredCompanyId(): string {
  return (process.env.BOTCAKE_COMPANY_ID || '').trim();
}

function configurationError(): NextResponse {
  return NextResponse.json(
    { success: false, error: 'BOTCAKE_NOT_CONFIGURED' },
    { status: 503 },
  );
}

function unauthorized(): NextResponse {
  return NextResponse.json(
    { success: false, error: 'UNAUTHORIZED' },
    { status: 401 },
  );
}

export async function GET(): Promise<NextResponse> {
  const pageId = configuredPageId();
  const companyId = configuredCompanyId();
  const secret = (process.env.BOTCAKE_WEBHOOK_SECRET || '').trim();

  if (!PAGE_ID_RE.test(pageId) || !UUID_RE.test(companyId) || !secret) {
    return configurationError();
  }

  return NextResponse.json({
    success: true,
    service: 'Botcake inbound webhook',
    status: 'READY',
    page_id: pageId,
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const pageId = configuredPageId();
  const companyId = configuredCompanyId();
  const configuredSecret = (process.env.BOTCAKE_WEBHOOK_SECRET || '').trim();

  if (!PAGE_ID_RE.test(pageId) || !UUID_RE.test(companyId) || !configuredSecret) {
    console.error('[botcake-webhook] Server misconfigured: missing PAGE_ID, COMPANY_ID or WEBHOOK_SECRET');
    return configurationError();
  }

  const rawHeader =
    request.headers.get('x-botcake-webhook-secret') ||
    request.headers.get('authorization') ||
    '';
  const providedSecret = rawHeader.replace(/^Bearer\s+/i, '').trim();

  console.info('[botcake-webhook] Inbound request received', {
    has_secret_header: Boolean(request.headers.get('x-botcake-webhook-secret')),
    has_auth_header: Boolean(request.headers.get('authorization')),
    content_type: request.headers.get('content-type'),
    content_length: request.headers.get('content-length'),
  });

  if (!verifyBotcakeSecret(providedSecret, configuredSecret)) {
    console.warn('[botcake-webhook] Unauthorized: secret mismatch or missing header');
    return unauthorized();
  }

  const rawBody = await request.text();
  if (!rawBody || Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    console.warn('[botcake-webhook] Invalid body size or empty body');
    return NextResponse.json(
      { success: false, error: 'INVALID_BODY' },
      { status: 400 },
    );
  }

  let payload: BotcakeInboundPayload;
  try {
    payload = JSON.parse(rawBody) as BotcakeInboundPayload;
  } catch {
    console.warn('[botcake-webhook] Invalid JSON body');
    return NextResponse.json(
      { success: false, error: 'INVALID_JSON' },
      { status: 400 },
    );
  }

  try {
    const event = parseBotcakeInboundPayload(payload, pageId);
    console.info('[botcake-webhook] Event parsed successfully', {
      pageId: event.pageId,
      senderId: event.externalUserId,
      messageId: event.messageId,
      senderName: event.senderName,
    });

    const result = await ingestNormalizedEvent({
      provider: 'FACEBOOK',
      company_id: companyId,
      external_user_id: event.externalUserId,
      sender_name: event.senderName,
      message_id: event.messageId,
      content: event.content,
      timestamp: event.timestamp,
      metadata: {
        provider: 'botcake',
        transport: 'BOTCAKE_WEBHOOK',
        page_id: event.pageId,
        external_message_id: event.messageId,
      },
    });

    if (!result.success) {
      console.error('[botcake-webhook] Ingress failed', result.error);
      return NextResponse.json(
        { success: false, error: 'INGRESS_FAILED', message: result.error },
        { status: 500 },
      );
    }

    console.info('[botcake-webhook] Message ingested successfully', {
      duplicate: result.duplicate === true,
      conversation_id: result.conversation_id,
      interaction_id: result.message_id,
    });

    return NextResponse.json({
      success: true,
      duplicate: result.duplicate === true,
      conversation_id: result.conversation_id,
      interaction_id: result.message_id,
      customer_id: result.customer_id,
      page_id: event.pageId,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'INVALID_PAYLOAD';
    const status = code === 'PAGE_NOT_CONFIGURED' ? 403 : 400;
    console.warn(`[botcake-webhook] Payload validation rejected: ${code}`);
    return NextResponse.json(
      { success: false, error: code },
      { status },
    );
  }
}
