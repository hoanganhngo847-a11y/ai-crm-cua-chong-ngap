import crypto from 'node:crypto';

const MAX_SECRET_LENGTH = 512;
const MAX_ID_LENGTH = 256;
const MAX_CONTENT_LENGTH = 20_000;
const MAX_EVENT_TYPE_LENGTH = 64;
const PLACEHOLDER_RE = /^\{\{\s*[^{}]+\s*\}\}$/;
const PAGE_PREFIX_RE = /^(?:fb|facebook|page|messenger|pancake)[_:]/i;

export type BotcakeTransport = 'PANCAKE_WEBHOOK' | 'JSON_API';

export type BotcakeInboundPayload = {
  page_id?: unknown;
  pageId?: unknown;
  event_type?: unknown;
  data?: unknown;
  psid?: unknown;
  sender_id?: unknown;
  senderId?: unknown;
  external_user_id?: unknown;
  externalUserId?: unknown;
  message_id?: unknown;
  messageId?: unknown;
  mid?: unknown;
  id?: unknown;
  text?: unknown;
  content?: unknown;
  message?: unknown;
  sender_name?: unknown;
  senderName?: unknown;
  user?: unknown;
  customer?: unknown;
  timestamp?: unknown;
  created_at?: unknown;
  createdAt?: unknown;
  [key: string]: unknown;
};

export type BotcakeInboundEvent = {
  pageId: string;
  externalUserId: string;
  messageId: string;
  content: string;
  senderName?: string;
  timestamp: string;
  transport: BotcakeTransport;
  providerConversationId?: string;
};

export type BotcakeIgnoredReason =
  | 'NOT_MESSAGING_EVENT'
  | 'COMMENT'
  | 'OUTBOUND'
  | 'REMOVED'
  | 'NO_MESSAGE';

export type BotcakeParseResult =
  | { kind: 'message'; event: BotcakeInboundEvent }
  | { kind: 'ignored'; reason: BotcakeIgnoredReason };

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const clean = String(value).trim();
    return clean && clean.length <= maxLength ? clean : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const clean = value.trim();
  return clean && clean.length <= maxLength ? clean : undefined;
}

function nestedRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(values: unknown[], maxLength: number): string | undefined {
  for (const value of values) {
    const result = boundedString(value, maxLength);
    if (result) return result;
  }
  return undefined;
}

export function normalizeBotcakePageId(value: string): string {
  return value.trim().replace(PAGE_PREFIX_RE, '');
}

function isUnresolvedPlaceholder(value: string): boolean {
  return PLACEHOLDER_RE.test(value.trim());
}

function requireResolved(value: string | undefined, field: string): string {
  if (!value) throw new Error(`MISSING_${field.toUpperCase()}`);
  if (isUnresolvedPlaceholder(value)) {
    throw new Error(`UNRESOLVED_TEMPLATE_VARIABLE:${field}`);
  }
  return value;
}

export function verifyBotcakeSecret(
  provided: string | null | undefined,
  configured: string | null | undefined,
): boolean {
  const actual = boundedString(provided, MAX_SECRET_LENGTH);
  const expected = boundedString(configured, MAX_SECRET_LENGTH);
  if (!actual || !expected) return false;

  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function timestampString(value: string): string | undefined {
  const clean = value.trim();
  if (!clean) return undefined;

  // Pancake documents `inserted_at` as UTC but its wire format omits the zone
  // (for example 2024-12-25T11:06:07.000000). Appending Z avoids the server's
  // local timezone changing the conversation ordering.
  const withSeparator = clean.includes(' ') && !clean.includes('T')
    ? clean.replace(' ', 'T')
    : clean;
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(withSeparator)
    ? withSeparator
    : `${withSeparator}Z`;

  const parsed = new Date(withZone);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    const parsed = new Date(millis);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  if (typeof value === 'string') {
    const parsed = timestampString(value);
    if (parsed) return parsed;
  }

  return new Date().toISOString();
}

function parsePancakeMessaging(
  payload: BotcakeInboundPayload,
  configuredPageId: string,
): BotcakeParseResult {
  const root = payload as Record<string, unknown>;
  const data = nestedRecord(root.data);
  const message = nestedRecord(data?.message);
  const conversation = nestedRecord(data?.conversation);
  const eventType = firstString([root.event_type], MAX_EVENT_TYPE_LENGTH)?.toLowerCase();

  const pageId = normalizeBotcakePageId(
    firstString([root.page_id, data?.page_id, message?.page_id], MAX_ID_LENGTH) || '',
  );
  if (!pageId || pageId !== configuredPageId) {
    throw new Error('PAGE_NOT_CONFIGURED');
  }

  if (eventType && eventType !== 'messaging') {
    return { kind: 'ignored', reason: 'NOT_MESSAGING_EVENT' };
  }

  if (!message) return { kind: 'ignored', reason: 'NO_MESSAGE' };

  const messageType = firstString([message.type, conversation?.type], 32)?.toUpperCase();
  if (messageType === 'COMMENT') return { kind: 'ignored', reason: 'COMMENT' };
  if (message.is_removed === true || message.is_hidden === true) {
    return { kind: 'ignored', reason: 'REMOVED' };
  }

  const from = nestedRecord(message.from) || nestedRecord(conversation?.from);
  const conversationFrom = nestedRecord(conversation?.from);
  const senderId = firstString([from?.id, conversationFrom?.id], MAX_ID_LENGTH);
  if (!senderId) throw new Error('MISSING_SENDER_ID');

  // Outbound page messages can arrive on the same `messaging` event. The
  // conversation's `from` is the customer, so a different message author is a
  // page/staff reply, not a new inbound message.
  const conversationSenderId = firstString([conversationFrom?.id], MAX_ID_LENGTH);
  if (
    normalizeBotcakePageId(senderId) === pageId
    || (conversationSenderId && senderId !== conversationSenderId)
  ) {
    return { kind: 'ignored', reason: 'OUTBOUND' };
  }

  const messageId = firstString([message.id, message.message_id], MAX_ID_LENGTH);
  if (!messageId) throw new Error('MISSING_MESSAGE_ID');

  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const content = firstString(
    [message.message, message.original_message, conversation?.snippet],
    MAX_CONTENT_LENGTH,
  ) || (attachments.length > 0 ? '[Tệp đính kèm]' : undefined);
  if (!content) throw new Error('MISSING_CONTENT');

  const senderName = firstString([from?.name, conversationFrom?.name], 160);
  const providerConversationId = firstString(
    [message.conversation_id, conversation?.id],
    MAX_ID_LENGTH,
  );

  return {
    kind: 'message',
    event: {
      pageId,
      externalUserId: senderId,
      messageId,
      content,
      ...(senderName ? { senderName } : {}),
      timestamp: normalizeTimestamp(
        message.inserted_at ?? root.timestamp ?? conversation?.updated_at,
      ),
      transport: 'PANCAKE_WEBHOOK',
      ...(providerConversationId ? { providerConversationId } : {}),
    },
  };
}

function parseJsonApiPayload(
  payload: BotcakeInboundPayload,
  configuredPageId: string,
): BotcakeParseResult {
  const message = nestedRecord(payload.message);
  const user = nestedRecord(payload.user);
  const customer = nestedRecord(payload.customer);

  const pageId = normalizeBotcakePageId(
    firstString([payload.page_id, payload.pageId], MAX_ID_LENGTH) || '',
  );
  if (!pageId || pageId !== configuredPageId) {
    throw new Error('PAGE_NOT_CONFIGURED');
  }

  const externalUserId = requireResolved(
    firstString([
      payload.psid,
      payload.sender_id,
      payload.senderId,
      customer?.psid,
      customer?.id,
      user?.id,
      payload.external_user_id,
      payload.externalUserId,
    ], MAX_ID_LENGTH),
    'sender_id',
  );

  const messageId = requireResolved(
    firstString([
      payload.message_id,
      payload.messageId,
      payload.mid,
      message?.mid,
      message?.id,
      payload.id,
    ], MAX_ID_LENGTH),
    'message_id',
  );

  const content = firstString([
    payload.content,
    payload.text,
    message?.text,
    message?.content,
  ], MAX_CONTENT_LENGTH);
  if (!content) throw new Error('MISSING_CONTENT');

  const combinedCustomerName = customer
    ? [customer.first_name, customer.last_name]
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .join(' ')
        .trim() || undefined
    : undefined;

  const rawSenderName = firstString([
    payload.sender_name,
    payload.senderName,
    customer?.name,
    customer?.full_name,
    combinedCustomerName,
    user?.name,
    user?.full_name,
  ], 160);
  const senderName = rawSenderName && !isUnresolvedPlaceholder(rawSenderName)
    ? rawSenderName
    : undefined;

  return {
    kind: 'message',
    event: {
      pageId,
      externalUserId,
      messageId,
      content,
      ...(senderName ? { senderName } : {}),
      timestamp: normalizeTimestamp(
        payload.timestamp ?? payload.created_at ?? payload.createdAt ?? message?.timestamp,
      ),
      transport: 'JSON_API',
    },
  };
}

/**
 * Parse either a Pancake/Botcake messaging webhook (preferred) or the legacy
 * Botcake Flow JSON API body.
 *
 * The Pancake webhook is the only Botcake transport that carries the actual
 * message ID, text, sender and timestamp for every inbound message. The Flow
 * JSON API block only exposes customer fields, so it cannot be used as a
 * message-sync transport.
 */
export function parseBotcakeWebhookPayload(
  payload: BotcakeInboundPayload,
  configuredPageId: string,
): BotcakeParseResult {
  const root = payload as Record<string, unknown>;
  const hasPancakeShape = Boolean(root.event_type || nestedRecord(root.data)?.message);
  const configured = normalizeBotcakePageId(configuredPageId);

  if (!configured) throw new Error('PAGE_NOT_CONFIGURED');

  return hasPancakeShape
    ? parsePancakeMessaging(payload, configured)
    : parseJsonApiPayload(payload, configured);
}

/**
 * Backwards-compatible message-only parser. Throws IGNORED_EVENT for events
 * that are valid Pancake deliveries but are not inbound customer messages.
 */
export function parseBotcakeInboundPayload(
  payload: BotcakeInboundPayload,
  configuredPageId: string,
): BotcakeInboundEvent {
  const result = parseBotcakeWebhookPayload(payload, configuredPageId);
  if (result.kind === 'ignored') {
    throw new Error(`IGNORED_EVENT:${result.reason}`);
  }
  return result.event;
}
