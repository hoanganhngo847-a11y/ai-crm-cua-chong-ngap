import crypto from 'node:crypto';

const MAX_SECRET_LENGTH = 512;
const MAX_ID_LENGTH = 256;
const MAX_CONTENT_LENGTH = 20_000;

export type BotcakeInboundPayload = {
  page_id?: unknown;
  pageId?: unknown;
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
};

function boundedString(value: unknown, maxLength: number): string | undefined {
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

function normalizeTimestamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    const parsed = new Date(millis);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value.trim());
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  return new Date().toISOString();
}

export function parseBotcakeInboundPayload(
  payload: BotcakeInboundPayload,
  configuredPageId: string,
): BotcakeInboundEvent {
  const message = nestedRecord(payload.message);
  const user = nestedRecord(payload.user);
  const pageId = firstString([payload.page_id, payload.pageId], MAX_ID_LENGTH);

  if (!pageId || pageId !== configuredPageId) {
    throw new Error('PAGE_NOT_CONFIGURED');
  }

  const externalUserId = firstString([
    payload.psid,
    payload.sender_id,
    payload.senderId,
    payload.external_user_id,
    payload.externalUserId,
    user?.id,
  ], MAX_ID_LENGTH);
  if (!externalUserId) throw new Error('MISSING_SENDER_ID');

  const messageId = firstString([
    payload.message_id,
    payload.messageId,
    payload.mid,
    message?.id,
    payload.id,
  ], MAX_ID_LENGTH);
  if (!messageId) throw new Error('MISSING_MESSAGE_ID');

  const content = firstString([
    payload.content,
    payload.text,
    message?.text,
    message?.content,
  ], MAX_CONTENT_LENGTH);
  if (!content) throw new Error('MISSING_CONTENT');

  const senderName = firstString([
    payload.sender_name,
    payload.senderName,
    user?.name,
    user?.full_name,
  ], 160);

  return {
    pageId,
    externalUserId,
    messageId,
    content,
    ...(senderName ? { senderName } : {}),
    timestamp: normalizeTimestamp(
      payload.timestamp ?? payload.created_at ?? payload.createdAt ?? message?.timestamp,
    ),
  };
}
