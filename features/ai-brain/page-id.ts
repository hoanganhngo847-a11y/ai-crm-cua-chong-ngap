import 'server-only';

const NUMERIC_ID = /^\d{1,100}$/;

function numericId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return NUMERIC_ID.test(trimmed) ? trimmed : null;
}

function metadataRecord(metadata: unknown): Record<string, unknown> | null {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : null;
}

/**
 * Resolves the Facebook Page ID for a Messenger conversation.
 *
 * Native Meta webhooks store `pageId:psid` in `external_conversation_id`.
 * Botcake conversations may store only the PSID/customer UUID, so the Page ID
 * is recovered from conversation metadata written during ingestion.
 */
export function extractMessengerPageId(
  externalConversationId: string | null | undefined,
  metadata?: unknown,
): string | null {
  if (typeof externalConversationId === 'string') {
    const [pageId, recipientId] = externalConversationId.split(':');
    if (numericId(pageId) && numericId(recipientId)) return pageId.trim();
  }

  const meta = metadataRecord(metadata);
  return numericId(meta?.page_id) ?? numericId(meta?.entry_id);
}

/**
 * Resolves the destination PSID for a Messenger conversation.
 * Prefers the canonical `pageId:psid` shape and falls back to ingestion metadata.
 */
export function extractMessengerRecipientId(
  externalConversationId: string | null | undefined,
  metadata?: unknown,
): string | null {
  if (typeof externalConversationId === 'string') {
    const [pageId, recipientId] = externalConversationId.split(':');
    if (numericId(pageId) && numericId(recipientId)) return recipientId.trim();
  }

  const meta = metadataRecord(metadata);
  return numericId(meta?.sender_id)
    ?? numericId(meta?.psid)
    ?? numericId(meta?.external_user_id)
    ?? null;
}
