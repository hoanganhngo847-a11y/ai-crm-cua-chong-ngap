import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { ingestNormalizedEvent } from '@/features/inbox/services/inbox-ingress.service';
import { sanitizePhoneInText } from '@/features/crm/utils/phone-sanitizer';
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

function normalizeTimestamp(value: string): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function normalizeZaloDisplayName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, 160) : undefined;
}

async function persistZaloConversationDisplayName(
  supabase: ReturnType<typeof createAdminClient>,
  companyId: string,
  conversationId: string | undefined,
  displayName: string | undefined,
  displayNameSource: string | undefined,
  observedAt: string
): Promise<void> {
  const cleanName = normalizeZaloDisplayName(displayName);
  if (!conversationId || !cleanName) return;

  const { data: conversation, error: readError } = await supabase
    .from('conversations')
    .select('metadata')
    .eq('id', conversationId)
    .eq('company_id', companyId)
    .eq('channel', 'ZALO')
    .maybeSingle();

  if (readError || !conversation) {
    console.warn(
      '[ZCAJS inbound] could not read conversation metadata for display-name sync:',
      readError?.message || 'conversation not found'
    );
    return;
  }

  const currentMetadata =
    conversation.metadata && typeof conversation.metadata === 'object' && !Array.isArray(conversation.metadata)
      ? (conversation.metadata as Record<string, unknown>)
      : {};
  const nextMetadata: Record<string, unknown> = {
    ...currentMetadata,
    zalo_display_name: cleanName,
    zalo_display_name_source: displayNameSource || 'message_dname',
    zalo_display_name_updated_at: observedAt,
  };

  const { error: updateError } = await supabase
    .from('conversations')
    .update({ metadata: nextMetadata })
    .eq('id', conversationId)
    .eq('company_id', companyId)
    .eq('channel', 'ZALO');

  if (updateError) {
    console.warn(
      '[ZCAJS inbound] could not persist Zalo display name:',
      updateError.message
    );
  }
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
          senderNameSource?: unknown;
          content?: unknown;
          timestamp?: unknown;
          direction?: unknown;
          isSelf?: unknown;
        }
      | null;

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ success: false, error: 'INVALID_PAYLOAD' }, { status: 400 });
    }

    const messageId = typeof body.messageId === 'string' ? body.messageId.trim() : '';
    const externalUserId = typeof body.externalUserId === 'string' ? body.externalUserId.trim() : '';
    const senderName = normalizeZaloDisplayName(
      typeof body.senderName === 'string' ? body.senderName : undefined
    );
    const rawSenderNameSource =
      typeof body.senderNameSource === 'string' ? body.senderNameSource.trim() : '';
    const senderNameSource =
      rawSenderNameSource === 'profile_resolved' ? 'profile_resolved' : 'message_dname';
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    const timestamp = typeof body.timestamp === 'string' ? body.timestamp.trim() : '';
    const normalizedObservedAt = normalizeTimestamp(timestamp);
    const requestedDirection = typeof body.direction === 'string' ? body.direction.trim().toLowerCase() : 'inbound';
    const direction = requestedDirection === 'outbound' ? 'outbound' : 'inbound';

    if (!messageId || !externalUserId || !content) {
      return NextResponse.json(
        { success: false, error: 'MISSING_REQUIRED_FIELDS' },
        { status: 400 }
      );
    }

    const supabase = createAdminClient();
    await ensureZcaJsRoutingConfig(supabase, companyId);

    const sourceMetadata = {
      transport: 'ZCAJS',
      source: 'ngogiaphat/ZCAJS',
      direction,
      observed_self_message: direction === 'outbound',
      ...(senderName ? { zalo_display_name: senderName } : {}),
      ...(senderName ? { zalo_display_name_source: senderNameSource } : {}),
    };

    // Self-listener messages are observations of messages already sent from the native Zalo account.
    // Persist them as SENT/OUTBOUND interactions only. Never enqueue them for provider dispatch again.
    if (direction === 'outbound') {
      const { data, error } = await supabase.rpc('record_observed_zcajs_outbound_atomic', {
        p_company_id: companyId,
        p_external_conversation_id: externalUserId,
        p_provider_msg_id: messageId,
        p_sanitized_content: sanitizePhoneInText(content),
        p_raw_content: content,
        p_source_metadata: sourceMetadata,
        p_timestamp: normalizedObservedAt,
      });

      if (error) {
        console.error('[ZCAJS inbound] observed outbound persistence failed:', error.message);
        return NextResponse.json(
          { success: false, error: 'OBSERVED_OUTBOUND_PERSIST_FAILED' },
          { status: 500 }
        );
      }

      const result = (data || {}) as Record<string, unknown>;
      return NextResponse.json({
        success: true,
        duplicate: result.is_duplicate === true,
        conversationId: typeof result.conversation_id === 'string' ? result.conversation_id : undefined,
        interactionId: typeof result.interaction_id === 'string' ? result.interaction_id : undefined,
        customerId: typeof result.customer_id === 'string' ? result.customer_id : undefined,
        direction: 'outbound',
      });
    }

    const result = await ingestNormalizedEvent(
      {
        provider: 'ZALO',
        company_id: companyId,
        external_user_id: externalUserId,
        sender_name: senderName || `Khách Zalo ${externalUserId.slice(-4)}`,
        message_id: messageId,
        content,
        timestamp: normalizedObservedAt,
        metadata: sourceMetadata,
      },
      { client: supabase }
    );

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: 'INGRESS_FAILED', message: result.error },
        { status: 500 }
      );
    }

    await persistZaloConversationDisplayName(
      supabase,
      companyId,
      result.conversation_id,
      senderName,
      senderNameSource,
      normalizedObservedAt
    );

    return NextResponse.json({
      success: true,
      duplicate: result.duplicate === true,
      conversationId: result.conversation_id,
      interactionId: result.message_id,
      customerId: result.customer_id,
      direction: 'inbound',
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
