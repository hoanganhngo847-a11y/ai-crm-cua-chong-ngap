import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../../lib/supabase/admin';

export interface UpsertOaConnectionParams {
  companyId: string;
  oaId: string;
  appId: string;
  appSecret: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  webhookSecret?: string;
  actorUserId?: string;
}

export async function upsertZaloOaConnection(
  params: UpsertOaConnectionParams,
  client?: SupabaseClient
): Promise<string> {
  const supabase = client || createAdminClient();
  const { data, error } = await supabase.rpc('zalo_upsert_oa_connection', {
    p_company_id: params.companyId,
    p_oa_id: params.oaId?.trim(),
    p_app_id: params.appId?.trim(),
    p_app_secret: params.appSecret,
    p_access_token: params.accessToken || null,
    p_refresh_token: params.refreshToken || null,
    p_token_expires_at: params.tokenExpiresAt || null,
    p_webhook_secret: params.webhookSecret || null,
    p_actor_user_id: params.actorUserId || null,
  });
  if (error) {
    throw error;
  }
  return data as string;
}

export async function setZaloOaConnectionStatus(
  params: {
    companyId: string;
    oaId: string;
    status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
    actorUserId?: string;
  },
  client?: SupabaseClient
): Promise<boolean> {
  const supabase = client || createAdminClient();
  const { data, error } = await supabase.rpc('zalo_set_oa_connection_status', {
    p_company_id: params.companyId,
    p_oa_id: params.oaId,
    p_status: params.status,
    p_actor_user_id: params.actorUserId || null,
  });
  if (error) {
    throw error;
  }
  return Boolean(data);
}
