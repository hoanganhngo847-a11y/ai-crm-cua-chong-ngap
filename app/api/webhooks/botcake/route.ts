import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { ingestNormalizedEvent } from '@/features/inbox/services/inbox-ingress.service';
import {
  parseBotcakeWebhookPayload,
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

function fingerprint(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function requestSecret(request: NextRequest): { value: string; source: 'header' | 'query' | 'none' } {
  const header =
    request.headers.get('x-botcake-webhook-secret') ||
    request.headers.get('authorization') ||
    '';
  const headerSecret = header.replace(/^Bearer\s+/i, '').trim();
  if (headerSecret) return { value: headerSecret, source: 'header' };

  // Pancake's page Webhook settings accept a URL but not custom headers. The
  // secret may therefore be supplied as ?token=... or ?secret=.... The URL is
  // never logged by this handler.
  const query = new URL(request.url).searchParams;
  const querySecret = (query.get('token') || query.get('secret') || '').trim();
  return querySecret
    ? { value: querySecret, source: 'query' }
    : { value: '', source: 'none' };
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
    transport: 'PANCAKE_WEBHOOK',
    accepts: ['PANCAKE_WEBHOOK', 'JSON_API'],
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

  const secret = requestSecret(request);

  console.info('[botcake-webhook] Inbound request received', {
    has_secret_header: request.headers.get('x-botcake-webhook-secret') !== null,
    has_auth_header: request.headers.get('authorization') !== null,
    has_secret_query: secret.source === 'query',
    content_type: request.headers.get('content-type'),
    content_length: request.headers.get('content-length'),
  });

  if (!verifyBotcakeSecret(secret.value, configuredSecret)) {
    console.warn('[botcake-webhook] Unauthorized: secret mismatch or missing credential');
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
    const parsed = parseBotcakeWebhookPayload(payload, pageId);

    if (parsed.kind === 'ignored') {
      console.info('[botcake-webhook] Event ignored', { reason: parsed.reason });
      return NextResponse.json({
        success: true,
        ignored: true,
        reason: parsed.reason,
      });
    }

    const event = parsed.event;
    console.info('[botcake-webhook] Event parsed successfully', {
      transport: event.transport,
      page_id: event.pageId,
      sender_fingerprint: fingerprint(event.externalUserId),
      message_fingerprint: fingerprint(event.messageId),
      has_sender_name: Boolean(event.senderName),
    });

    const result = await ingestNormalizedEvent({
      provider: 'FACEBOOK',
      company_id: companyId,
      external_user_id: event.externalUserId,
      external_conversation_id: `${event.pageId}:${event.externalUserId}`,
      sender_name: event.senderName,
      message_id: event.messageId,
      content: event.content,
      timestamp: event.timestamp,
      metadata: {
        provider: 'botcake',
        transport: event.transport,
        page_id: event.pageId,
        external_message_id: event.messageId,
        ...(event.providerConversationId
          ? { provider_conversation_id: event.providerConversationId }
          : {}),
      },
    });

    if (!result.success) {
      console.error('[botcake-webhook] Ingress failed', {
        error: result.error,
      });
      return NextResponse.json(
        { success: false, error: 'INGRESS_FAILED', message: result.error },
        { status: 500 },
      );
    }

    console.info('[botcake-webhook] Message ingested successfully', {
      transport: event.transport,
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
      transport: event.transport,
    });
  } catch (error) {
    const rawCode = error instanceof Error ? error.message : 'INVALID_PAYLOAD';
    const [code, field] = rawCode.split(':', 2);
    const status = code === 'PAGE_NOT_CONFIGURED'
      ? 403
      : code === 'UNRESOLVED_TEMPLATE_VARIABLE'
        ? 422
        : 400;

    console.warn('[botcake-webhook] Payload validation rejected', {
      code,
      ...(field ? { field } : {}),
    });

    return NextResponse.json(
      {
        success: false,
        error: code,
        ...(field ? { field } : {}),
      },
      { status },
    );
  }
}
