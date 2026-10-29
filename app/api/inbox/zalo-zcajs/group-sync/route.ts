import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ success: false, error: 'UNAUTHORIZED' }, { status: 401 });
    }

    const { data: member } = await supabase
      .from('company_members')
      .select('company_id, role')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!member?.company_id) {
      return NextResponse.json({ success: false, error: 'NO_COMPANY' }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId.trim() : '';

    if (!conversationId) {
      return NextResponse.json({ success: false, error: 'MISSING_CONVERSATION_ID' }, { status: 400 });
    }

    const adminClient = createAdminClient();
    const { data: conv, error: convErr } = await adminClient
      .from('conversations')
      .select('id, company_id, customer_id, channel, metadata, external_conversation_id')
      .eq('id', conversationId)
      .eq('company_id', member.company_id)
      .maybeSingle();

    if (convErr || !conv) {
      return NextResponse.json({ success: false, error: 'CONVERSATION_NOT_FOUND' }, { status: 404 });
    }

    const metadata = (conv.metadata as Record<string, unknown>) || {};
    const isGroup = Boolean(metadata.is_group);
    const rawGroupId =
      typeof metadata.group_id === 'string'
        ? metadata.group_id
        : String(conv.external_conversation_id || '').replace(/^group:/, '');

    if (!isGroup && !conv.external_conversation_id?.startsWith('group:')) {
      return NextResponse.json({ success: false, error: 'NOT_A_GROUP' }, { status: 400 });
    }

    const workerUrl = (process.env.ZALO_ZCAJS_WORKER_URL || '').trim().replace(/\/$/, '');
    const workerSecret = process.env.ZALO_ZCAJS_WORKER_SECRET || '';

    let liveGroup: Record<string, unknown> | null = null;
    if (workerUrl && workerSecret && rawGroupId) {
      try {
        const workerResp = await fetch(
          `${workerUrl}/v1/group-details?groupId=${encodeURIComponent(rawGroupId)}&companyId=${encodeURIComponent(member.company_id)}`,
          {
            headers: {
              'x-worker-secret': workerSecret,
            },
            signal: AbortSignal.timeout(6000),
          }
        );
        if (workerResp.ok) {
          const workerData = await workerResp.json();
          if (workerData?.success && workerData.group) {
            liveGroup = workerData.group;
          }
        }
      } catch (workerErr) {
        console.warn('[group-sync] worker lookup failed:', workerErr instanceof Error ? workerErr.message : 'timeout');
      }
    }

    if (liveGroup) {
      const groupName = typeof liveGroup.groupName === 'string' ? liveGroup.groupName.trim() : (metadata.group_name as string);
      const totalMember = typeof liveGroup.totalMember === 'number' ? liveGroup.totalMember : (metadata.member_count as number);
      const members = Array.isArray(liveGroup.members) ? liveGroup.members : (metadata.members as unknown[]);
      const avatar = typeof liveGroup.avatar === 'string' ? liveGroup.avatar : (metadata.group_avatar as string);

      const nextMetadata: Record<string, unknown> = {
        ...metadata,
        is_group: true,
        group_id: rawGroupId,
        ...(groupName ? { group_name: groupName, zalo_display_name: groupName } : {}),
        ...(totalMember ? { member_count: totalMember } : {}),
        ...(members ? { members } : {}),
        ...(avatar ? { group_avatar: avatar } : {}),
        zalo_display_name_updated_at: new Date().toISOString(),
      };

      await adminClient
        .from('conversations')
        .update({ metadata: nextMetadata })
        .eq('id', conv.id)
        .eq('company_id', member.company_id);

      if (conv.customer_id && groupName) {
        await adminClient
          .from('customers')
          .update({ name: groupName })
          .eq('id', conv.customer_id)
          .eq('company_id', member.company_id);
      }

      return NextResponse.json({
        success: true,
        group: {
          groupId: rawGroupId,
          groupName: groupName || 'Nhóm Zalo',
          totalMember: totalMember || 0,
          members: members || [],
          avatar,
        },
      });
    }

    // Fallback to existing metadata
    return NextResponse.json({
      success: true,
      group: {
        groupId: rawGroupId,
        groupName: (metadata.group_name as string) || (metadata.zalo_display_name as string) || 'Nhóm Zalo',
        totalMember: (metadata.member_count as number) || (Array.isArray(metadata.members) ? metadata.members.length : 0),
        members: Array.isArray(metadata.members) ? metadata.members : [],
        avatar: (metadata.group_avatar as string) || undefined,
      },
    });
  } catch (error) {
    console.error('[group-sync] error:', error);
    return NextResponse.json({ success: false, error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
