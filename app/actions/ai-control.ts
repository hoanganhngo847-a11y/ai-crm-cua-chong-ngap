'use server';

import { revalidatePath } from 'next/cache';
import { getActorContext, requireBossAdmin } from '../../lib/auth/context';
import { createAdminClient } from '../../lib/supabase/admin';
import { APPLICATION_ROLES } from '../../shared/constants/roles';
import {
  getAiPipelineMetrics,
  getSystemHealthStatus,
  evaluateAlertConditions,
  type AiPipelineMetrics,
  type SystemHealthStatus,
  type AiMonitoringAlert,
} from '../../features/ai-brain/monitoring';

export type LiveChannel = 'ZALO' | 'MESSENGER' | 'VOICE';
export type VoiceMode = 'OFF' | 'TEST' | 'LIVE';
export type ModelRoutingProfile = 'STANDARD' | 'FAST' | 'QUALITY';

export interface AiMonitoringDashboardState {
  metrics: AiPipelineMetrics;
  health: SystemHealthStatus;
  alerts: AiMonitoringAlert[];
}

export interface ChannelLiveSetting {
  company_id: string;
  channel: LiveChannel;
  enabled: boolean;
  min_confidence: number;
  voice_mode: VoiceMode;
  model_routing_profile: ModelRoutingProfile;
  updated_at: string;
}

export interface HandoverCaseItem {
  id: string;
  company_id: string;
  customer_id: string;
  conversation_id: string;
  source_interaction_id: string;
  reason: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  status: 'OPEN' | 'CLAIMED' | 'RESOLVED' | 'DISMISSED';
  assigned_to: string | null;
  assigned_name?: string | null;
  brain_turn_id: string | null;
  created_at: string;
  claimed_at: string | null;
  resolved_at: string | null;
  customer?: {
    id: string;
    name: string;
    customer_code: string;
  } | null;
}

export interface AiDeliveryItem {
  id: string;
  company_id: string;
  customer_id: string;
  conversation_id: string;
  channel: string;
  send_status: 'PENDING' | 'PROCESSING' | 'SENT' | 'SKIPPED' | 'FAILED';
  decision: 'RESPOND' | 'HANDOVER' | 'NO_REPLY' | 'ERROR' | null;
  confidence: number | null;
  error_code: string | null;
  external_message_id: string | null;
  sent_at: string | null;
  completed_at: string | null;
  created_at: string;
  customer?: {
    id: string;
    name: string;
  } | null;
}

export interface AiControlState {
  companyId: string;
  isBossAdmin: boolean;
  settings: Record<LiveChannel, ChannelLiveSetting>;
  handoverCounts: {
    total: number;
    open: number;
    claimed: number;
    resolved: number;
  };
  handoverCases: HandoverCaseItem[];
  deliveryCounts: {
    total: number;
    sent: number;
    handover: number;
    skipped: number;
    failed: number;
    avgConfidence: number;
  };
  deliveries: AiDeliveryItem[];
  monitoring: AiMonitoringDashboardState;
}

const DEFAULT_CHANNELS: readonly LiveChannel[] = ['ZALO', 'MESSENGER', 'VOICE'];

async function requireAuthorizedActor() {
  const actor = await getActorContext();
  if (!actor || !actor.companyId || actor.membershipStatus !== 'ACTIVE') {
    throw new Error('Không xác định được tổ chức hoạt động.');
  }
  if (actor.role !== APPLICATION_ROLES.BOSS_ADMIN && actor.role !== APPLICATION_ROLES.SALE) {
    throw new Error('Chỉ Ban Quản trị hoặc Tư vấn viên Sale được truy cập AI Control Center.');
  }
  return {
    ...actor,
    companyId: actor.companyId as string,
  };
}

export async function getAiControlState(): Promise<AiControlState> {
  const actor = await requireAuthorizedActor();
  const client = createAdminClient();
  const companyId = actor.companyId;

  // 1. Fetch live settings for all channels
  const { data: rawSettings } = await client
    .from('ai_brain_live_settings')
    .select('company_id,channel,enabled,min_confidence,voice_mode,model_routing_profile,updated_at')
    .eq('company_id', companyId);

  const settingsMap: Record<LiveChannel, ChannelLiveSetting> = {
    ZALO: {
      company_id: companyId,
      channel: 'ZALO',
      enabled: false,
      min_confidence: 0.850,
      voice_mode: 'OFF',
      model_routing_profile: 'STANDARD',
      updated_at: new Date().toISOString(),
    },
    MESSENGER: {
      company_id: companyId,
      channel: 'MESSENGER',
      enabled: false,
      min_confidence: 0.850,
      voice_mode: 'OFF',
      model_routing_profile: 'STANDARD',
      updated_at: new Date().toISOString(),
    },
    VOICE: {
      company_id: companyId,
      channel: 'VOICE',
      enabled: false,
      min_confidence: 0.850,
      voice_mode: 'OFF',
      model_routing_profile: 'STANDARD',
      updated_at: new Date().toISOString(),
    },
  };

  for (const row of rawSettings || []) {
    if (DEFAULT_CHANNELS.includes(row.channel as LiveChannel)) {
      settingsMap[row.channel as LiveChannel] = {
        company_id: companyId,
        channel: row.channel as LiveChannel,
        enabled: Boolean(row.enabled),
        min_confidence: Number(row.min_confidence) || 0.850,
        voice_mode: (row.voice_mode as VoiceMode) || 'OFF',
        model_routing_profile: (row.model_routing_profile as ModelRoutingProfile) || 'STANDARD',
        updated_at: row.updated_at,
      };
    }
  }

  // 2. Fetch Handover Cases
  const { data: rawCases } = await client
    .from('ai_handover_cases')
    .select(`
      id, company_id, customer_id, conversation_id, source_interaction_id,
      reason, priority, status, assigned_to, brain_turn_id,
      created_at, claimed_at, resolved_at,
      customer:customers(id, name, customer_code),
      assigned_profile:user_profiles!assigned_to(full_name)
    `)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(100);

  interface RawCaseRow {
    id: string;
    company_id: string;
    customer_id: string;
    conversation_id: string;
    source_interaction_id: string;
    reason: string;
    priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
    status: 'OPEN' | 'CLAIMED' | 'RESOLVED' | 'DISMISSED';
    assigned_to: string | null;
    brain_turn_id: string | null;
    created_at: string;
    claimed_at: string | null;
    resolved_at: string | null;
    customer?: { id: string; name: string; customer_code: string } | null;
    assigned_profile?: { full_name: string | null } | null;
  }

  const handoverCases: HandoverCaseItem[] = ((rawCases || []) as unknown as RawCaseRow[]).map((row) => ({
    id: row.id,
    company_id: row.company_id,
    customer_id: row.customer_id,
    conversation_id: row.conversation_id,
    source_interaction_id: row.source_interaction_id,
    reason: row.reason,
    priority: row.priority,
    status: row.status,
    assigned_to: row.assigned_to,
    assigned_name: row.assigned_profile?.full_name || null,
    brain_turn_id: row.brain_turn_id,
    created_at: row.created_at,
    claimed_at: row.claimed_at,
    resolved_at: row.resolved_at,
    customer: row.customer ? {
      id: row.customer.id,
      name: row.customer.name,
      customer_code: row.customer.customer_code,
    } : null,
  }));

  const handoverCounts = {
    total: handoverCases.length,
    open: handoverCases.filter((c) => c.status === 'OPEN').length,
    claimed: handoverCases.filter((c) => c.status === 'CLAIMED').length,
    resolved: handoverCases.filter((c) => c.status === 'RESOLVED').length,
  };

  // 3. Fetch Deliveries
  const { data: rawDeliveries } = await client
    .from('ai_brain_live_deliveries')
    .select(`
      id, company_id, customer_id, conversation_id, channel,
      send_status, decision, confidence, error_code,
      external_message_id, sent_at, completed_at, created_at,
      customer:customers(id, name)
    `)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(100);

  interface RawDeliveryRow {
    id: string;
    company_id: string;
    customer_id: string;
    conversation_id: string;
    channel: string;
    send_status: 'PENDING' | 'PROCESSING' | 'SENT' | 'SKIPPED' | 'FAILED';
    decision: 'RESPOND' | 'HANDOVER' | 'NO_REPLY' | 'ERROR' | null;
    confidence: number | null;
    error_code: string | null;
    external_message_id: string | null;
    sent_at: string | null;
    completed_at: string | null;
    created_at: string;
    customer?: { id: string; name: string } | null;
  }

  const deliveries: AiDeliveryItem[] = ((rawDeliveries || []) as unknown as RawDeliveryRow[]).map((row) => ({
    id: row.id,
    company_id: row.company_id,
    customer_id: row.customer_id,
    conversation_id: row.conversation_id,
    channel: row.channel,
    send_status: row.send_status,
    decision: row.decision,
    confidence: row.confidence !== null ? Number(row.confidence) : null,
    error_code: row.error_code,
    external_message_id: row.external_message_id,
    sent_at: row.sent_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
    customer: row.customer ? {
      id: row.customer.id,
      name: row.customer.name,
    } : null,
  }));

  const confidences = deliveries
    .map((d) => d.confidence)
    .filter((c): c is number => typeof c === 'number' && Number.isFinite(c));
  const avgConfidence = confidences.length > 0
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : 0;

  const deliveryCounts = {
    total: deliveries.length,
    sent: deliveries.filter((d) => d.send_status === 'SENT').length,
    handover: deliveries.filter((d) => d.decision === 'HANDOVER').length,
    skipped: deliveries.filter((d) => d.send_status === 'SKIPPED').length,
    failed: deliveries.filter((d) => d.send_status === 'FAILED').length,
    avgConfidence: Math.round(avgConfidence * 1000) / 1000,
  };

  // 4. Fetch Monitoring Data (metrics, health, active alerts)
  const monitoring = await getAiMonitoringDashboardDataInternal(client, companyId, { timeWindow: '24h' });

  return {
    companyId,
    isBossAdmin: actor.role === APPLICATION_ROLES.BOSS_ADMIN,
    settings: settingsMap,
    handoverCounts,
    handoverCases,
    deliveryCounts,
    deliveries,
    monitoring,
  };
}

export async function updateAiChannelSettingAction(formData: FormData) {
  const actor = await requireAuthorizedActor();
  await requireBossAdmin(actor.companyId);

  const channelRaw = String(formData.get('channel') || '').toUpperCase();
  if (!DEFAULT_CHANNELS.includes(channelRaw as LiveChannel)) {
    throw new Error('Kênh không hợp lệ.');
  }
  const channel = channelRaw as LiveChannel;

  const enabled = formData.get('enabled') === 'true' || formData.get('enabled') === 'on';
  const minConfidenceRaw = parseFloat(String(formData.get('min_confidence') || '0.85'));
  const minConfidence = Number.isFinite(minConfidenceRaw) && minConfidenceRaw >= 0 && minConfidenceRaw <= 1
    ? minConfidenceRaw
    : 0.85;

  const voiceModeRaw = String(formData.get('voice_mode') || 'OFF').toUpperCase();
  const voiceMode: VoiceMode = ['OFF', 'TEST', 'LIVE'].includes(voiceModeRaw)
    ? (voiceModeRaw as VoiceMode)
    : 'OFF';

  const routingProfileRaw = String(formData.get('model_routing_profile') || 'STANDARD').toUpperCase();
  const routingProfile: ModelRoutingProfile = ['STANDARD', 'FAST', 'QUALITY'].includes(routingProfileRaw)
    ? (routingProfileRaw as ModelRoutingProfile)
    : 'STANDARD';

  const client = createAdminClient();
  const { error } = await client
    .from('ai_brain_live_settings')
    .upsert({
      company_id: actor.companyId,
      channel,
      enabled,
      min_confidence: minConfidence,
      voice_mode: voiceMode,
      model_routing_profile: routingProfile,
      updated_at: new Date().toISOString(),
    });

  if (error) {
    throw new Error(`Không thể cập nhật cấu hình kênh: ${error.message}`);
  }

  revalidatePath('/admin/ai');
  return { success: true };
}

export async function emergencyKillSwitchAction() {
  const actor = await requireAuthorizedActor();
  await requireBossAdmin(actor.companyId);

  const client = createAdminClient();
  const { data: count, error } = await client.rpc('emergency_disable_ai', {
    p_company_id: actor.companyId,
  });

  if (error) {
    throw new Error(`Không thể tắt khẩn cấp AI: ${error.message}`);
  }

  revalidatePath('/admin/ai');
  return { success: true, disabledCount: count };
}

export async function claimHandoverCaseAction(caseId: string) {
  const actor = await requireAuthorizedActor();
  const client = createAdminClient();

  const { data: success, error } = await client.rpc('claim_ai_handover_case', {
    p_company_id: actor.companyId,
    p_case_id: caseId,
    p_user_id: actor.userId,
  });

  if (error || !success) {
    throw new Error(error?.message || 'Không thể tiếp nhận ca chuyển giao.');
  }

  revalidatePath('/admin/ai');
  return { success: true };
}

export async function resolveHandoverCaseAction(caseId: string) {
  const actor = await requireAuthorizedActor();
  const client = createAdminClient();

  const { data: success, error } = await client.rpc('resolve_ai_handover_case', {
    p_company_id: actor.companyId,
    p_case_id: caseId,
    p_user_id: actor.userId,
  });

  if (error || !success) {
    throw new Error(error?.message || 'Không thể hoàn tất ca chuyển giao.');
  }

  revalidatePath('/admin/ai');
  return { success: true };
}

export async function resumeAiConversationAction(conversationId: string) {
  const actor = await requireAuthorizedActor();
  const client = createAdminClient();

  const { data: success, error } = await client.rpc('resume_ai_conversation', {
    p_company_id: actor.companyId,
    p_conversation_id: conversationId,
    p_user_id: actor.userId,
  });

  if (error || !success) {
    throw new Error(error?.message || 'Không thể khôi phục tự động trả lời AI.');
  }

  revalidatePath('/admin/ai');
  return { success: true };
}

async function getAiMonitoringDashboardDataInternal(
  client: ReturnType<typeof createAdminClient>,
  companyId: string,
  options: {
    channel?: string;
    timeWindow?: '1h' | '24h' | '7d' | '30d';
  } = {}
): Promise<AiMonitoringDashboardState> {
  const [metrics, health] = await Promise.all([
    getAiPipelineMetrics(client, companyId, options),
    getSystemHealthStatus(client),
  ]);
  const alertsResult = await evaluateAlertConditions(client, companyId, { metrics, health });

  return {
    metrics,
    health,
    alerts: [...alertsResult.activeAlerts],
  };
}

export async function getAiMonitoringDashboardData(options: {
  channel?: string;
  timeWindow?: '1h' | '24h' | '7d' | '30d';
} = {}): Promise<AiMonitoringDashboardState> {
  const actor = await requireAuthorizedActor();
  const client = createAdminClient();
  return getAiMonitoringDashboardDataInternal(client, actor.companyId, options);
}

export async function acknowledgeAlertAction(alertId: string) {
  const actor = await requireAuthorizedActor();
  await requireBossAdmin(actor.companyId);
  const client = createAdminClient();

  const { data: success, error } = await client.rpc('acknowledge_ai_monitoring_alert', {
    p_company_id: actor.companyId,
    p_alert_id: alertId,
    p_user_id: actor.userId,
  });

  if (error || !success) {
    throw new Error(error?.message || 'Không thể xác nhận cảnh báo.');
  }

  revalidatePath('/admin/ai');
  return { success: true };
}

export async function resolveAlertAction(alertId: string) {
  const actor = await requireAuthorizedActor();
  await requireBossAdmin(actor.companyId);
  const client = createAdminClient();

  const { data: success, error } = await client.rpc('resolve_ai_monitoring_alert', {
    p_company_id: actor.companyId,
    p_alert_id: alertId,
    p_user_id: actor.userId,
  });

  if (error || !success) {
    throw new Error(error?.message || 'Không thể đánh dấu đã xử lý cảnh báo.');
  }

  revalidatePath('/admin/ai');
  return { success: true };
}

export async function triggerAlertEvaluationAction(): Promise<AiMonitoringDashboardState> {
  const actor = await requireAuthorizedActor();
  const client = createAdminClient();
  return getAiMonitoringDashboardDataInternal(client, actor.companyId, { timeWindow: '1h' });
}
