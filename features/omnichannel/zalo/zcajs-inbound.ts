/**
 * ZCAJS inbound payload normalization.
 *
 * Kept framework-free so the personal-Zalo group/DM contract can be tested
 * without booting a Next.js route or a Supabase client.
 *
 * Two namespaces are used deliberately:
 * - direct messages keep the raw Zalo UID (historical external_refs remain valid)
 * - groups use `group:<groupId>` so a group can never collide with a customer UID
 */

export const ZALO_GROUP_THREAD_PREFIX = 'group:';
export const ZALO_GROUP_EXTERNAL_REF_PREFIX = 'zcajs:group:';
export const ZALO_IMAGE_MARKER = '[[ZALO_IMAGE]]';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GROUP_ID_RE = /^[0-9]{5,40}$/;

export interface ZcaJsGroupMember {
  id: string;
  name: string;
  avatar?: string;
  isAdmin?: boolean;
  isCreator?: boolean;
}

export interface ZcaJsInboundMessage {
  messageId: string;
  externalUserId: string;
  externalConversationId: string;
  externalRef: string;
  senderName?: string;
  senderDisplayName?: string;
  senderId?: string;
  senderNameSource?: 'profile_resolved' | 'message_dname' | 'group_info';
  content: string;
  direction: 'inbound' | 'outbound';
  isSelf: boolean;
  isGroup: boolean;
  recovered?: boolean;
  providerTimestamp?: string;
  groupId?: string;
  groupName?: string;
  totalMember?: number;
  groupAvatar?: string;
  groupMembers?: ZcaJsGroupMember[];
  membersComplete?: boolean;
  groupFetchedAt?: string;
}

export type ZcaJsInboundParseResult =
  | { ok: true; data: ZcaJsInboundMessage }
  | { ok: false; error: string };

export function sanitizeZaloDisplayName(value: unknown, maxLength = 160): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, maxLength) : undefined;
}

function normalizeThreadId(value: string): string {
  return value.trim().replace(/_0$/, '');
}

function parseBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

export function formatGroupMessageContent(
  content: string,
  senderDisplayName: string | undefined,
  isSelf: boolean
): string {
  const author = sanitizeZaloDisplayName(senderDisplayName) || (isSelf ? 'Bạn' : 'Thành viên nhóm');
  const prefix = `${author}:`;
  // Keep attachment markers at the beginning of their own line so the Inbox
  // image renderer still recognises `[[ZALO_IMAGE]]...`.
  if (content.startsWith(ZALO_IMAGE_MARKER) || content.includes('\n')) {
    return `${prefix}\n${content}`;
  }
  return `${prefix} ${content}`;
}

export function parseZcaJsInboundPayload(body: unknown): ZcaJsInboundParseResult {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'INVALID_PAYLOAD' };
  }
  const raw = body as Record<string, unknown>;

  const messageId = typeof raw.messageId === 'string' ? raw.messageId.trim() : '';
  const rawExternalUserId =
    typeof raw.externalUserId === 'string' ? normalizeThreadId(raw.externalUserId) : '';
  const rawContent = typeof raw.content === 'string' ? raw.content.trim() : '';
  const isGroup = parseBoolean(raw.isGroup) || rawExternalUserId.startsWith(ZALO_GROUP_THREAD_PREFIX);

  if (!messageId || !rawExternalUserId || !rawContent) {
    return { ok: false, error: 'MISSING_REQUIRED_FIELDS' };
  }

  let groupId: string | undefined;
  if (isGroup) {
    const candidate =
      typeof raw.groupId === 'string'
        ? raw.groupId.trim()
        : rawExternalUserId.slice(ZALO_GROUP_THREAD_PREFIX.length);
    if (!GROUP_ID_RE.test(candidate)) {
      return { ok: false, error: 'INVALID_GROUP_ID' };
    }
    groupId = candidate;
  }

  const requestedDirection =
    typeof raw.direction === 'string' ? raw.direction.trim().toLowerCase() : 'inbound';
  const direction: 'inbound' | 'outbound' = requestedDirection === 'outbound' ? 'outbound' : 'inbound';
  const isSelf = direction === 'outbound';

  const senderId = isGroup && typeof raw.senderId === 'string' && /^[0-9]{1,40}$/.test(raw.senderId)
    ? raw.senderId : undefined;
  const senderDisplayName = sanitizeZaloDisplayName(raw.senderDisplayName) ||
    sanitizeZaloDisplayName(raw.senderName) ||
    (isGroup && !isSelf && senderId ? `Thành viên ${senderId}` : undefined);
  const groupName = isGroup ? sanitizeZaloDisplayName(raw.groupName) : undefined;
  const rawSenderName = sanitizeZaloDisplayName(raw.senderName);
  const senderName = isGroup
    ? groupName || `Nhóm Zalo ${groupId!.slice(-4)}`
    : rawSenderName;

  const rawSource = typeof raw.senderNameSource === 'string' ? raw.senderNameSource.trim() : '';
  const senderNameSource = isGroup
    ? (groupName ? 'group_info' : 'message_dname')
    : rawSource === 'profile_resolved'
      ? 'profile_resolved'
      : 'message_dname';

  const externalUserId = isGroup
    ? `${ZALO_GROUP_THREAD_PREFIX}${groupId}`
    : rawExternalUserId;
  const externalRef = isGroup
    ? `${ZALO_GROUP_EXTERNAL_REF_PREFIX}${messageId}`
    : messageId;

  const content = isGroup
    ? formatGroupMessageContent(rawContent, senderDisplayName, isSelf)
    : rawContent;

  const totalMember = typeof raw.totalMember === 'number' && Number.isInteger(raw.totalMember) && raw.totalMember >= 0 ? raw.totalMember : undefined;
  const groupAvatar = typeof raw.groupAvatar === 'string' && raw.groupAvatar.trim() ? raw.groupAvatar.trim() : undefined;
  const groupMembers = Array.isArray(raw.groupMembers)
    ? (raw.groupMembers.filter((m) => m && typeof m === 'object') as Array<Record<string, unknown>>)
        .map((m) => ({
          id: String(m.id || '').trim(),
          name: String(m.name || '').trim(),
          avatar: typeof m.avatar === 'string' ? m.avatar : undefined,
          isAdmin: Boolean(m.isAdmin),
          isCreator: Boolean(m.isCreator),
        }))
        .filter((m) => Boolean(m.id))
    : undefined;

  return {
    ok: true,
    data: {
      messageId,
      externalUserId,
      externalConversationId: externalUserId,
      externalRef,
      ...(senderName ? { senderName } : {}),
      ...(senderDisplayName ? { senderDisplayName } : {}),
      ...(senderId ? { senderId } : {}),
      senderNameSource,
      content,
      direction,
      isSelf,
      isGroup,
      recovered: raw.recovered === true,
      ...(typeof raw.timestamp === 'string' && Number.isFinite(Date.parse(raw.timestamp)) ? { providerTimestamp: new Date(raw.timestamp).toISOString() } : {}),
      ...(groupId ? { groupId } : {}),
      ...(groupName ? { groupName } : {}),
      ...(totalMember !== undefined ? { totalMember } : {}),
      ...(groupAvatar ? { groupAvatar } : {}),
      ...(groupMembers ? { groupMembers } : {}),
      ...(typeof raw.membersComplete === 'boolean' ? { membersComplete: raw.membersComplete } : {}),
      ...(typeof raw.groupFetchedAt === 'string' && Number.isFinite(Date.parse(raw.groupFetchedAt)) ? { groupFetchedAt: raw.groupFetchedAt } : {}),
    },
  };
}

export function buildZcaJsSourceMetadata(message: ZcaJsInboundMessage): Record<string, unknown> {
  return {
    transport: 'ZCAJS',
    source: 'ngogiaphat/ZCAJS',
    direction: message.direction,
    observed_self_message: message.direction === 'outbound',
    is_group: message.isGroup,
    recovered: message.recovered === true,
    ...(message.providerTimestamp ? { provider_timestamp: message.providerTimestamp } : {}),
    ...(message.groupId ? { group_id: message.groupId } : {}),
    ...(message.groupName ? { group_name: message.groupName } : {}),
    ...(message.totalMember !== undefined ? { member_count: message.totalMember } : {}),
    ...(message.groupAvatar ? { group_avatar: message.groupAvatar } : {}),
    ...(message.groupMembers ? { members: message.groupMembers } : {}),
    ...(message.senderDisplayName ? { zalo_sender_name: message.senderDisplayName } : {}),
    ...(message.senderId ? { zalo_sender_id: message.senderId } : {}),
    ...(message.membersComplete !== undefined ? { members_complete: message.membersComplete } : {}),
    ...(message.groupFetchedAt ? { group_fetched_at: message.groupFetchedAt } : {}),
    ...(message.senderName
      ? {
          // The Inbox header prefers this display name for Zalo conversations.
          zalo_display_name: message.senderName,
          zalo_display_name_source: message.senderNameSource || 'message_dname',
        }
      : {}),
  };
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
