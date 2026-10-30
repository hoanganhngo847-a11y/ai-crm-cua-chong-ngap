const DIRECT_MESSAGE_TYPE = 0;
const GROUP_MESSAGE_TYPE = 1;
export const ZALO_IMAGE_MARKER = '[[ZALO_IMAGE]]';
// Group threads use a separate namespace so a group id can never collide with a
// customer UID in CRM identities/conversations.
export const ZALO_GROUP_THREAD_PREFIX = 'group:';
export const ZALO_GROUP_EXTERNAL_REF_PREFIX = 'zcajs:group:';

function safeHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function tryParseJson(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function collectImageCandidates(value, depth = 0, seen = new Set()) {
  if (depth > 4 || value == null) return [];
  if (typeof value === 'string') {
    const direct = safeHttpUrl(value);
    if (direct) return [direct];
    const parsed = tryParseJson(value);
    return parsed ? collectImageCandidates(parsed, depth + 1, seen) : [];
  }
  if (typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);

  const prioritizedKeys = [
    'hdUrl',
    'originUrl',
    'originalUrl',
    'imageUrl',
    'photoUrl',
    'url',
    'href',
    'src',
    'thumb',
    'thumbnail',
    'params',
  ];
  const result = [];
  for (const key of prioritizedKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      result.push(...collectImageCandidates(value[key], depth + 1, seen));
    }
  }
  return [...new Set(result)];
}

function isLikelyImagePayload(data, content) {
  const msgType = String(data?.msgType || '').toLowerCase();
  const contentType = String(content?.type || '').toLowerCase();
  return (
    /photo|image|picture/.test(msgType) ||
    /photo|image|picture/.test(contentType) ||
    Boolean(content && typeof content === 'object' && ('thumb' in content || 'thumbnail' in content))
  );
}

function attachmentCaption(content) {
  if (!content || typeof content !== 'object') return '';
  const values = [content.title, content.description]
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => !safeHttpUrl(value));
  return [...new Set(values)].join('\n');
}

function attachmentKind(data) {
  const msgType = String(data?.msgType || '').toLowerCase();
  if (/photo|image|picture/.test(msgType)) return 'image';
  if (msgType) return 'attachment';
  return '';
}

export function normalizeMessageContent(data) {
  const content = data?.content;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed) return trimmed;
    const kind = attachmentKind(data);
    if (kind === 'image') return '[Hình ảnh]';
    if (kind === 'attachment') return '[Tin nhắn đính kèm]';
    return '';
  }

  if (content == null) {
    // Some Zalo payloads describe an attachment only through msgType and omit
    // content. Dropping those would silently lose the customer's message.
    const kind = attachmentKind(data);
    if (kind === 'image') return '[Hình ảnh]';
    if (kind === 'attachment') return '[Tin nhắn đính kèm]';
    return '';
  }

  if (typeof content !== 'object') return '';

  if (isLikelyImagePayload(data, content)) {
    const [bestImageUrl] = collectImageCandidates(content);
    const caption = attachmentCaption(content);
    if (bestImageUrl) {
      return [caption, `${ZALO_IMAGE_MARKER}${bestImageUrl}`].filter(Boolean).join('\n');
    }
    return caption || '[Hình ảnh]';
  }

  const caption = attachmentCaption(content);
  if (caption) return caption;

  const [attachmentUrl] = collectImageCandidates(content);
  if (attachmentUrl) return `[Tệp đính kèm]\n${attachmentUrl}`;

  return '[Tin nhắn đính kèm]';
}

function normalizeThreadId(value) {
  return String(value ?? '').trim().replace(/_0$/, '');
}

function normalizeMessageId(data) {
  return String(data?.msgId || data?.realMsgId || data?.cliMsgId || '').trim();
}

function normalizeTimestamp(data) {
  const numericTs = Number(data?.ts);
  if (Number.isFinite(numericTs) && numericTs > 0) {
    const milliseconds = numericTs < 1_000_000_000_000 ? numericTs * 1000 : numericTs;
    const parsed = new Date(milliseconds);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function buildNormalizedMessage(message, { isGroup }) {
  if (!message) return null;

  const data = message.data || {};
  const messageId = normalizeMessageId(data);
  const rawThreadId = isGroup
    ? (message.threadId || data.idTo)
    : (message.threadId || (message.isSelf ? data.idTo : data.uidFrom));
  const threadId = normalizeThreadId(rawThreadId);
  const content = normalizeMessageContent(data);

  if (!messageId || !threadId || !content) return null;

  const externalUserId = isGroup ? `${ZALO_GROUP_THREAD_PREFIX}${threadId}` : threadId;
  const senderName = message.isSelf ? undefined : (String(data.dName || '').trim() || undefined);
  const senderNameSource = message.isSelf
    ? undefined
    : (String(data.__zaloNameSource || '').trim() || (senderName ? 'message_dname' : undefined));
  const explicitGroupName = isGroup
    ? String(message.groupName || message.__zaloGroupName || data.groupName || '').trim() || undefined
    : undefined;

  return {
    messageId,
    // Group threads live in their own namespace; direct messages keep using the
    // Zalo UID unchanged so historical dedupe/idempotency remains valid.
    externalUserId,
    externalConversationId: externalUserId,
    // Group provider msgIds are globally unique, but namespacing the CRM
    // external_ref guarantees a group message can never collide with a DM.
    externalRef: isGroup ? `${ZALO_GROUP_EXTERNAL_REF_PREFIX}${messageId}` : messageId,
    senderName,
    senderId: isGroup ? normalizeThreadId(data.uidFrom) || undefined : undefined,
    senderNameSource,
    senderDisplayName: isGroup ? senderName : undefined,
    isGroup,
    recovered: message.__zaloRecovered === true,
    groupId: isGroup ? threadId : undefined,
    groupName: explicitGroupName,
    content,
    timestamp: normalizeTimestamp(data),
    direction: message.isSelf ? 'outbound' : 'inbound',
    isSelf: Boolean(message.isSelf),
  };
}

export function normalizeDirectMessage(message) {
  if (message?.type !== undefined && message?.type !== null && Number(message.type) !== DIRECT_MESSAGE_TYPE) {
    return null;
  }
  return buildNormalizedMessage(message, { isGroup: false });
}

/**
 * Normalize any Zalo personal message, including group messages.
 * Direct messages keep the exact legacy contract (`normalizeDirectMessage`).
 */
export function normalizeZaloMessage(message) {
  if (!message) return null;
  const numericType = message.type === undefined || message.type === null ? null : Number(message.type);

  if (numericType === GROUP_MESSAGE_TYPE) {
    return buildNormalizedMessage(message, { isGroup: true });
  }
  if (numericType === null || numericType === DIRECT_MESSAGE_TYPE) {
    return buildNormalizedMessage(message, { isGroup: false });
  }
  return null;
}
