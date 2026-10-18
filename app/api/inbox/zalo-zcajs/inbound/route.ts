import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { ingestNormalizedEvent } from '@/features/inbox/services/inbox-ingress.service';
import {
  ensureZcaJsRoutingConfig,
  getZaloTransportMode,
} from '@/features/omnichannel/zalo/zcajs-client';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secureCompare(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && crypto.timingSafeEqual(aBuffer, bBuffer);
}

function unauthorized() {
  return NextResponse.json({ success: false, error: 'UNAUTHORIZED' }, { status: 401 });
}

export async function POST(request: NextRequest) {
  try {
    if (getZaloTransportMode() !== 'ZCAJS') {
      return NextResponse.json(
        { success: false, error: 'ZCAJS_TRANSPORT_DISABLED' },
        { status: 503 }
      );
    }

    if (process.env.NODE_ENV === 'production') {
      const proto = request.headers.get('x-forwarded-proto') || '';
      if (proto !== 'https' && !request.url.startsWith('https://')) {
        return NextResponse.json({ success: false, error: 'HTTPS_REQUIRED' }, { status: 403 });
      }
    }

    const configuredSecret = process.env.ZALO_ZCAJS_WORKER_SECRET || '';
    if (!configuredSecret) {
      return NextResponse.json(
        { success: false, error: 'ZCAJS_SECRET_NOT_CONFIGURED' },
        { status: 503 }
      );
    }

    const providedSecret =
      request.headers.get('x-worker-secret') ||
      request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
      '';
    if (!providedSecret || !secureCompare(providedSecret, configuredSecret)) {
      return unauthorized();
    }

    const companyId = (process.env.ZALO_ZCAJS_COMPANY_ID || '').trim();
    if (!UUID_RE.test(companyId)) {
      return NextResponse.json(
        { success: false, error: 'ZCAJS_COMPANY_NOT_CONFIGURED' },
        { status: 503 }
      );
    }

    const body = await request.json().catch(() => null) as
      | {
          messageId?: unknown;
          externalUserId?: unknown;
          senderName?: unknown;
          content?: unknown;
          timestamp?: unknown;
        }
      | null;

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ success: false, error: 'INVALID_PAYLOAD' }, { status: 400 });
    }

    const messageId = typeof body.messageId === 'string' ? body.messageId.trim() : '';
    const externalUserId = typeof body.externalUserId === 'string' ? body.externalUserId.trim() : '';
    const senderName = typeof body.senderName === 'string' ? body.senderName.trim() : undefined;
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    const timestamp = typeof body.timestamp === 'string' ? body.timestamp.trim() : '';

    if (!messageId || !externalUserId || !content) {
      return NextResponse.json(
        { success: false, error: 'MISSING_REQUIRED_FIELDS' },
        { status: 400 }
      );
    }

    const supabase = createAdminClient();
    await ensureZcaJsRoutingConfig(supabase, companyId);

    const result = await ingestNormalizedEvent(
      {
        provider: 'ZALO',
        company_id: companyId,
        external_user_id: externalUserId,
        sender_name: senderName || `Khách Zalo ${externalUserId.slice(-4)}`,
        message_id: messageId,
        content,
        timestamp: timestamp || new Date().toISOString(),
        metadata: {
          transport: 'ZCAJS',
          source: 'ngogiaphat/ZCAJS',
        },
      },
      { client: supabase }
    );

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: 'INGRESS_FAILED', message: result.error },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      duplicate: result.duplicate === true,
      conversationId: result.conversation_id,
      interactionId: result.message_id,
      customerId: result.customer_id,
    });
  } catch (error: unknown) {
    console.error(
      '[ZCAJS inbound] processing failed:',
      error instanceof Error ? error.message : 'unknown error'
    );
    return NextResponse.json(
      { success: false, error: 'INTERNAL_ERROR' },
      { status: 500 }
    );
  }
}
