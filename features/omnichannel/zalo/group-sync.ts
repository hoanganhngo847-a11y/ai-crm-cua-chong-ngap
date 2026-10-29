import type { SupabaseClient } from '@supabase/supabase-js';
import { parseZcaJsInboundPayload } from './zcajs-inbound';

export async function syncZaloGroup(options: {
  client: SupabaseClient;
  companyId: string;
  conversationId: string;
  workerUrl: string;
  workerSecret: string;
  fetchImpl?: typeof fetch;
}) {
  const { client, companyId, conversationId, workerUrl, workerSecret, fetchImpl = fetch } = options;
  const { data: conversation, error } = await client.from('conversations')
    .select('id, metadata, channel, external_conversation_id')
    .eq('id', conversationId).eq('company_id', companyId).eq('channel', 'ZALO').maybeSingle();
  if (error) throw new Error('GROUP_READ_FAILED');
  if (!conversation) return { success: false, error: 'CONVERSATION_NOT_FOUND', status: 404 };
  const match = /^group:([0-9]{5,40})$/.exec(conversation.external_conversation_id || '');
  if (!match) return { success: false, error: 'NOT_A_GROUP', status: 400 };
  const groupId = match[1];
  let metadata = (conversation.metadata || {}) as Record<string, unknown>;
  let stale = true;
  if (workerUrl && workerSecret) {
    try {
      const response = await fetchImpl(`${workerUrl.replace(/\/$/, '')}/v1/group-details?groupId=${groupId}&companyId=${encodeURIComponent(companyId)}&refresh=1`, {
        headers: { 'x-worker-secret': workerSecret },
        signal: AbortSignal.timeout(25000),
        cache: 'no-store',
      });
      const body = await response.json();
      if (response.ok && body?.success === true && body.group?.groupId === groupId) {
        const parsed = parseZcaJsInboundPayload({
          messageId: 'group-refresh', externalUserId: `group:${groupId}`, content: 'metadata',
          groupName: body.group.groupName, totalMember: body.group.totalMember,
          groupMembers: body.group.members, groupAvatar: body.group.avatar,
          membersComplete: body.group.membersComplete, groupFetchedAt: body.group.fetchedAt,
        });
        if (parsed.ok) {
          const group = parsed.data;
          const { data, error: writeError } = await client.rpc('sync_zalo_group_metadata', {
            p_company_id: companyId, p_conversation_id: conversationId,
            p_group: {
              group_name: group.groupName, member_count: group.totalMember,
              members: group.groupMembers, group_avatar: group.groupAvatar,
              members_complete: group.membersComplete, group_fetched_at: group.groupFetchedAt,
            },
          });
          if (writeError || !data) throw new Error('GROUP_WRITE_FAILED');
          metadata = data;
          stale = false;
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'GROUP_WRITE_FAILED') throw error;
      // Provider downtime returns the last known snapshot, clearly marked stale.
    }
  }
  return {
    success: true, stale,
    group: {
      groupId,
      groupName: typeof metadata.group_name === 'string' ? metadata.group_name : (metadata.zalo_display_name || 'Nhóm Zalo'),
      totalMember: typeof metadata.member_count === 'number' ? metadata.member_count : null,
      members: Array.isArray(metadata.members) ? metadata.members : [],
      avatar: metadata.group_avatar,
      membersComplete: metadata.members_complete === true,
      fetchedAt: metadata.group_fetched_at,
    },
  };
}
