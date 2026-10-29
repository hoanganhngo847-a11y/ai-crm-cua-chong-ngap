import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { ingestNormalizedEvent } from '@/features/inbox/services/inbox-ingress.service';
import { sanitizePhoneInText } from '@/features/crm/utils/phone-sanitizer';
import {
  ensureZcaJsRoutingConfig,
  getZaloTransportMode,
} from '@/features/omnichannel/zalo/zcajs-client';
import {
  buildZcaJsSourceMetadata,
  parseZcaJsInboundPayload,
} from '@/features/omnichannel/zalo/zcajs-inbound';

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

async function persistZaloGroupMetadata(
  supabase: ReturnType<typeof createAdminClient>,
  companyId: string,
  conversationId: string | undefined,
  customerId: string | undefined,
  externalUserId: string,
  event: import('@/features/omnichannel/zalo/zcajs-inbound').ZcaJsInboundMessage,
  observedAt: string
): Promise<void> {
  if (!conversationId) return;

  const { data: conversation, error: readError } = await supabase
    .from('conversations')
    .select('metadata, customer_id')
    .eq('id', conversationId)
    .eq('company_id', companyId)
    .eq('channel', 'ZALO')
    .maybeSingle();

  if (readError || !conversation) return;

  const currentMetadata =
    conversation.metadata && typeof conversation.metadata === 'object' && !Array.isArray(conversation.metadata)
      ? (conversation.metadata as Record<string, unknown>)
      : {};

  const existingGroupName = typeof currentMetadata.group_name === 'string' ? currentMetadata.group_name.trim() : '';
  const newGroupName = event.groupName ? normalizeZaloDisplayName(event.groupName) : undefined;
  const finalGroupName = newGroupName || existingGroupName || event.senderName || `Nhóm Zalo ${event.groupId?.slice(-4) || ''}`;

  const nextMetadata: Record<string, unknown> = {
    ...currentMetadata,
    is_group: true,
    group_id: event.groupId || currentMetadata.group_id,
    group_name: finalGroupName,
    zalo_display_name: finalGroupName,
    zalo_display_name_source: newGroupName ? 'group_info' : (currentMetadata.zalo_display_name_source || 'message_dname'),
    zalo_display_name_updated_at: observedAt,
    ...(event.totalMember ? { member_count: event.totalMember } : {}),
    ...(event.groupAvatar ? { group_avatar: event.groupAvatar } : {}),
    ...(event.groupMembers && event.groupMembers.length > 0 ? { members: event.groupMembers } : {}),
  };

  await supabase
    .from('conversations')
    .update({ metadata: nextMetadata })
    .eq('id', conversationId)
    .eq('company_id', companyId)
    .eq('channel', 'ZALO');

  const targetCustomerId = customerId || conversation.customer_id;
  if (targetCustomerId && finalGroupName) {
    await supabase
      .from('customers')
      .update({ name: finalGroupName })
      .eq('id', targetCustomerId)
      .eq('company_id', companyId);
  }

  if (finalGroupName && externalUserId) {
    await supabase
      .from('identities')
      .update({ display_name: finalGroupName, updated_at: observedAt })
      .eq('company_id', companyId)
      .eq('channel', 'ZALO')
      .eq('external_id', externalUserId);
  }
}

async function applyZaloDisplayName(
  supabase: ReturnType<typeof createAdminClient>,
  companyId: string,
  externalUserId: string,
  displayName: string | undefined,
  displayNameSource: string | undefined
): Promise<void> {
  const cleanName = normalizeZaloDisplayName(displayName);
  if (!cleanName || !/^[0-9]{5,40}$/.test(externalUserId)) return;

  const { error } = await supabase.rpc('apply_zalo_display_name', {
    p_company: companyId,
    p_external_id: externalUserId,
    p_display_name: cleanName,
    p_source: displayNameSource || 'message_dname',
  });

  if (error) {
    // Display-name propagation is fail-soft: the message itself must never be lost
    // because a denormalized CRM projection could not be refreshed.
    console.warn('[ZCAJS inbound] could not apply Zalo display name:', error.message);
  }
}

async function pauseZaloGroupAi(
  supabase: ReturnType<typeof createAdminClient>,
  companyId: string,
  conversationId: string | undefined
): Promise<void> {
  if (!conversationId) return;
  const { error } = await supabase
    .from('conversations')
    .update({ ai_mode: 'PAUSED', updated_at: new Date().toISOString() })
    .eq('id', conversationId)
    .eq('company_id', companyId)
    .eq('channel', 'ZALO');
  if (error) {
    // Group conversations must never become an automatic AI target. The AI live
    // enqueue trigger also refuses metadata.is_group, so this is defense in depth.
    console.warn('[ZCAJS inbound] could not pause AI for Zalo group:', error.message);
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

    const body = await request.json().catch(() => null);
    const parsed = parseZcaJsInboundPayload(body);
    if (!parsed.ok) {
      return NextResponse.json(
        { success: false, error: parsed.error },
        { status: 400 }
      );
    }

    const event = parsed.data;
    const timestamp =
      body && typeof body === 'object' && typeof (body as { timestamp?: unknown }).timestamp === 'string'
        ? ((body as { timestamp: string }).timestamp).trim()
        : '';
    const normalizedObservedAt = normalizeTimestamp(timestamp);
    const sourceMetadata = buildZcaJsSourceMetadata(event);

    const supabase = createAdminClient();
    await ensureZcaJsRoutingConfig(supabase, companyId);

    // Self-listener messages are observations of messages already sent from the native Zalo account.
    // Persist them as SENT/OUTBOUND interactions only. Never enqueue them for provider dispatch again.
    if (event.direction === 'outbound') {
      const { data, error } = await supabase.rpc('record_observed_zcajs_outbound_atomic', {
        p_company_id: companyId,
        p_external_conversation_id: event.externalConversationId,
        p_provider_msg_id: event.messageId,
        p_sanitized_content: sanitizePhoneInText(event.content),
        p_raw_content: event.content,
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
      const conversationId =
        typeof result.conversation_id === 'string' ? result.conversation_id : undefined;
      if (event.isGroup) {
        await pauseZaloGroupAi(supabase, companyId, conversationId);
        await persistZaloGroupMetadata(
          supabase,
          companyId,
          conversationId,
          typeof result.customer_id === 'string' ? result.customer_id : undefined,
          event.externalConversationId,
          event,
          normalizedObservedAt
        );
      }

      return NextResponse.json({
        success: true,
        duplicate: result.is_duplicate === true,
        conversationId,
        interactionId: typeof result.interaction_id === 'string' ? result.interaction_id : undefined,
        customerId: typeof result.customer_id === 'string' ? result.customer_id : undefined,
        direction: 'outbound',
        isGroup: event.isGroup,
      });
    }

    const result = await ingestNormalizedEvent(
      {
        provider: 'ZALO',
        company_id: companyId,
        external_user_id: event.externalUserId,
        external_conversation_id: event.externalConversationId,
        sender_name: event.senderName || `Khách Zalo ${event.externalUserId.slice(-4)}`,
        message_id: event.externalRef,
        content: event.content,
        timestamp: normalizedObservedAt,
        metadata: {
          channel: 'zalo',
          // The raw Zalo msgId is kept for diagnostics; external_ref owns dedupe.
          provider_message_id: event.messageId,
          ...sourceMetadata,
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

    if (event.isGroup) {
      await persistZaloGroupMetadata(
        supabase,
        companyId,
        result.conversation_id,
        result.customer_id,
        event.externalUserId,
        event,
        normalizedObservedAt
      );
      // Groups are observational in the CRM: never let AI answer a whole group.
      await pauseZaloGroupAi(supabase, companyId, result.conversation_id);
    } else {
      await persistZaloConversationDisplayName(
        supabase,
        companyId,
        result.conversation_id,
        event.senderName,
        event.senderNameSource,
        normalizedObservedAt
      );
      await applyZaloDisplayName(
        supabase,
        companyId,
        event.externalUserId,
        event.senderName,
        event.senderNameSource
      );
    }

    return NextResponse.json({
      success: true,
      duplicate: result.duplicate === true,
      conversationId: result.conversation_id,
      interactionId: result.message_id,
      customerId: result.customer_id,
      direction: 'inbound',
      isGroup: event.isGroup,
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
