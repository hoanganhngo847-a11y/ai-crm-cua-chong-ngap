'use server';

import { createClient } from '../../lib/supabase/server';
import { createAdminClient } from '../../lib/supabase/admin';
import { getActorContext } from '../../lib/auth/context';
import { verifyActorForCompany, requirePrivilegedBoss } from '../../lib/server-auth/authorize';
import { ServerAuthError, isServerAuthError } from '../../lib/server-auth/errors';
import { APPLICATION_ROLES } from '../../shared/constants/roles';
import { ZaloInboxService } from '../../features/omnichannel/zalo/inbox-service';
import type {
  SendZaloReplyResult,
  ZaloConversationItem,
  ZaloMessageItem,
} from '../../features/omnichannel/zalo/types';
import { ZaloCareCampaignService } from '../../features/care/zalo/campaign-service';
import { ZaloCareSchedulerService } from '../../features/care/zalo/scheduler-service';
import type { CareAudienceGroup } from '../../features/care/zalo/types';

// ==============================================================================
// 'use server' boundary for Zalo OA + Zalo care.
// The browser sends business identifiers only. company_id is ALWAYS derived server-side
// (from the session or from the target resource), never trusted from the client.
// ==============================================================================

type ActionResult<T> = { success: true; data: T } | { success: false; error: string; message: string };

const INBOX_ROLES = [APPLICATION_ROLES.SALE, APPLICATION_ROLES.BOSS_ADMIN];

function toFailure(err: unknown, fallback: string): { success: false; error: string; message: string } {
  if (isServerAuthError(err)) {
    return { success: false, error: err.code, message: err.message };
  }
  console.error(`[actions/zalo] ${fallback}:`, err instanceof Error ? err.message : err);
  return { success: false, error: 'INTERNAL_ERROR', message: fallback };
}

async function resolveSessionCompanyId(): Promise<string> {
  const client = await createClient();
  const actor = await getActorContext(undefined, client);
  if (!actor || actor.profileStatus !== 'ACTIVE') {
    throw new ServerAuthError('Phiên làm việc không hợp lệ. Vui lòng đăng nhập lại.', 401, 'UNAUTHENTICATED');
  }
  if (!actor.companyId || actor.membershipStatus !== 'ACTIVE') {
    throw new ServerAuthError('Bạn chưa có tư cách thành viên hoạt động.', 403, 'MEMBERSHIP_INACTIVE');
  }
  return actor.companyId;
}

/**
 * Sale / Boss replies to a Zalo conversation from the unified inbox.
 * `commandId` is generated once by the composer and reused when the user retries.
 */
export async function sendZaloReplyAction(params: {
  conversationId: string;
  content: string;
  commandId: string;
}): Promise<ActionResult<SendZaloReplyResult>> {
  try {
    const admin = createAdminClient();
    const { data: conversation } = await admin
      .from('conversations')
      .select('company_id')
      .eq('id', params.conversationId)
      .eq('channel', 'ZALO')
      .maybeSingle();
    if (!conversation?.company_id) {
      throw new ServerAuthError('Không tìm thấy hội thoại Zalo.', 404, 'RESOURCE_NOT_FOUND');
    }

    // Company derived from the resource; the session must be an ACTIVE SALE/BOSS_ADMIN of it.
    const actor = await verifyActorForCompany(conversation.company_id, { allowedRoles: INBOX_ROLES, requireAal2: false });
    const service = new ZaloInboxService({ supabase: admin });
    const result = await service.sendZaloReply(
      { conversationId: params.conversationId, content: params.content, commandId: params.commandId },
      actor
    );
    return { success: true, data: result };
  } catch (err: unknown) {
    return toFailure(err, 'Không thể gửi tin nhắn Zalo vào lúc này.');
  }
}

export async function listZaloConversationsAction(params: {
  status?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<ActionResult<ZaloConversationItem[]>> {
  try {
    const companyId = await resolveSessionCompanyId();
    await verifyActorForCompany(companyId, { allowedRoles: INBOX_ROLES, requireAal2: false });
    const service = new ZaloInboxService({ supabase: createAdminClient() });
    const data = await service.getZaloConversations({
      companyId,
      status: params.status,
      limit: Math.min(params.limit ?? 50, 200),
      offset: Math.max(params.offset ?? 0, 0),
    });
    return { success: true, data };
  } catch (err: unknown) {
    return toFailure(err, 'Không thể tải danh sách hội thoại Zalo.');
  }
}

export async function getZaloMessagesAction(params: {
  conversationId: string;
  limit?: number;
  offset?: number;
}): Promise<ActionResult<ZaloMessageItem[]>> {
  try {
    const companyId = await resolveSessionCompanyId();
    await verifyActorForCompany(companyId, { allowedRoles: INBOX_ROLES, requireAal2: false });
    const service = new ZaloInboxService({ supabase: createAdminClient() });
    const data = await service.getZaloMessagesByConversation({
      companyId,
      conversationId: params.conversationId,
      limit: Math.min(params.limit ?? 100, 500),
      offset: Math.max(params.offset ?? 0, 0),
    });
    return { success: true, data };
  } catch (err: unknown) {
    return toFailure(err, 'Không thể tải tin nhắn Zalo.');
  }
}

/**
 * BOSS_ADMIN (AAL2) connects or rotates credentials of a Zalo OA. Secrets go straight to the
 * private schema through a definer RPC and are never returned.
 */
export async function upsertZaloOaConnectionAction(params: {
  oaId: string;
  appId: string;
  appSecret: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  webhookSecret?: string;
}): Promise<ActionResult<{ configId: string }>> {
  try {
    const companyId = await resolveSessionCompanyId();
    const actor = await requirePrivilegedBoss(companyId);
    const { data, error } = await createAdminClient().rpc('zalo_upsert_oa_connection', {
      p_company_id: companyId,
      p_oa_id: params.oaId?.trim(),
      p_app_id: params.appId?.trim(),
      p_app_secret: params.appSecret,
      p_access_token: params.accessToken || null,
      p_refresh_token: params.refreshToken || null,
      p_token_expires_at: params.tokenExpiresAt || null,
      p_webhook_secret: params.webhookSecret || null,
      p_actor_user_id: actor.userId,
    });
    if (error) {
      if (error.message.includes('OWNED_BY_OTHER_COMPANY')) {
        throw new ServerAuthError('OA này đã được kết nối với doanh nghiệp khác.', 403, 'RESOURCE_FORBIDDEN');
      }
      throw new Error(error.message);
    }
    return { success: true, data: { configId: data as string } };
  } catch (err: unknown) {
    return toFailure(err, 'Không thể lưu cấu hình Zalo OA.');
  }
}

export async function setZaloOaStatusAction(params: {
  oaId: string;
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
}): Promise<ActionResult<{ updated: boolean }>> {
  try {
    const companyId = await resolveSessionCompanyId();
    const actor = await requirePrivilegedBoss(companyId);
    const { data, error } = await createAdminClient().rpc('zalo_set_oa_connection_status', {
      p_company_id: companyId,
      p_oa_id: params.oaId,
      p_status: params.status,
      p_actor_user_id: actor.userId,
    });
    if (error) throw new Error(error.message);
    return { success: true, data: { updated: Boolean(data) } };
  } catch (err: unknown) {
    return toFailure(err, 'Không thể cập nhật trạng thái Zalo OA.');
  }
}

export async function createZaloCareCampaignAction(params: {
  title: string;
  audienceGroup: CareAudienceGroup;
  messageTemplate: string;
}): Promise<ActionResult<{ campaignId: string }>> {
  try {
    const companyId = await resolveSessionCompanyId();
    await verifyActorForCompany(companyId, { allowedRoles: INBOX_ROLES, requireAal2: false });
    const campaign = await new ZaloCareCampaignService({ supabase: createAdminClient() }).createCampaign({
      companyId,
      title: params.title,
      audienceGroup: params.audienceGroup,
      messageTemplate: params.messageTemplate,
    });
    return { success: true, data: { campaignId: campaign.id } };
  } catch (err: unknown) {
    return toFailure(err, 'Không thể tạo chiến dịch chăm sóc Zalo.');
  }
}

export async function executeZaloCareCampaignAction(params: {
  campaignId: string;
}): Promise<ActionResult<{ sent: number; failed: number; uncertain: number; skipped: number; totalAudience: number }>> {
  try {
    const companyId = await resolveSessionCompanyId();
    await verifyActorForCompany(companyId, { allowedRoles: INBOX_ROLES, requireAal2: false });
    const result = await new ZaloCareCampaignService({ supabase: createAdminClient() }).executeCampaign(params.campaignId, {
      companyId,
    });
    return { success: true, data: result };
  } catch (err: unknown) {
    return toFailure(err, 'Không thể chạy chiến dịch chăm sóc Zalo.');
  }
}

/**
 * Turning a stopped schedule back on is a business decision: BOSS_ADMIN only, with a reason,
 * audited (PROJECT_MASTER §13).
 */
export async function reactivateZaloCareScheduleAction(params: {
  customerId: string;
  reason: string;
  frequencyMonths?: number;
}): Promise<ActionResult<{ scheduleId: string }>> {
  try {
    const companyId = await resolveSessionCompanyId();
    const actor = await verifyActorForCompany(companyId, { allowedRoles: [APPLICATION_ROLES.BOSS_ADMIN] });
    const schedule = await new ZaloCareSchedulerService({ supabase: createAdminClient() }).createOrUpdateSchedule({
      companyId,
      customerId: params.customerId,
      frequencyMonths: params.frequencyMonths,
      reactivation: { actorUserId: actor.userId, reason: params.reason },
    });
    return { success: true, data: { scheduleId: schedule.id } };
  } catch (err: unknown) {
    return toFailure(err, 'Không thể bật lại lịch chăm sóc.');
  }
}

export async function stopZaloCareScheduleAction(params: {
  customerId: string;
  reason: string;
}): Promise<ActionResult<{ stopped: boolean }>> {
  try {
    const companyId = await resolveSessionCompanyId();
    const actor = await verifyActorForCompany(companyId, { allowedRoles: INBOX_ROLES, requireAal2: false });
    const stopped = await new ZaloCareSchedulerService({ supabase: createAdminClient() }).stopSchedule(
      companyId,
      params.customerId,
      `BUSINESS_STOP: ${(params.reason || '').trim().slice(0, 200)}`,
      actor.userId
    );
    return { success: true, data: { stopped } };
  } catch (err: unknown) {
    return toFailure(err, 'Không thể dừng lịch chăm sóc.');
  }
}
