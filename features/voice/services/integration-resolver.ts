import 'server-only';
import { createHash } from 'node:crypto';
import { createAdminClient } from '../../../lib/supabase/admin';

export type VoiceIntegrationProvider = 'STRINGEE' | 'OPENAI_REALTIME';

export interface VoiceIntegration {
  integrationId: string;
  companyId: string;
  providerAccountId: string;
  webhookSecret: string;
  apiKey?: string;
  apiSecret?: string;
  fromNumber?: string;
  answerUrl?: string;
  aiAgentUserId?: string;
  saleAgentUserId?: string;
}

type IntegrationRow = {
  integration_id: string;
  company_id: string;
  provider_account_id: string;
  webhook_secret_env: string;
  api_key_env: string | null;
  api_secret_env: string | null;
  from_number_env: string | null;
  answer_url_env: string | null;
  ai_agent_user_env: string | null;
  sale_agent_user_env: string | null;
};

function envValue(envName: string | null, required = false): string | undefined {
  const value = envName ? process.env[envName] : undefined;
  if (required && !value) throw new Error('VOICE_INTEGRATION_ENV_MISSING');
  return value;
}

function toIntegration(row: IntegrationRow): VoiceIntegration {
  return {
    integrationId: row.integration_id,
    companyId: row.company_id,
    providerAccountId: row.provider_account_id,
    webhookSecret: envValue(row.webhook_secret_env, true)!,
    apiKey: envValue(row.api_key_env),
    apiSecret: envValue(row.api_secret_env),
    fromNumber: envValue(row.from_number_env),
    answerUrl: envValue(row.answer_url_env),
    aiAgentUserId: envValue(row.ai_agent_user_env),
    saleAgentUserId: envValue(row.sale_agent_user_env),
  };
}

/** Resolve an opaque URL token to a tenant integration without accepting company ids from the webhook. */
export async function resolveVoiceIntegration(
  provider: VoiceIntegrationProvider,
  routingToken: string
): Promise<VoiceIntegration | null> {
  if (!/^[A-Za-z0-9_-]{32,200}$/.test(routingToken)) return null;
  const routingHash = createHash('sha256').update(routingToken).digest('hex');
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('resolve_voice_provider_integration', {
    p_provider: provider,
    p_routing_key_hash: routingHash,
  });
  if (error) throw new Error('VOICE_INTEGRATION_LOOKUP_FAILED');
  const row = (Array.isArray(data) ? data[0] : data) as IntegrationRow | null;
  return row ? toIntegration(row) : null;
}

/** Resolve outbound config only after company was obtained from a claimed attempt. */
export async function resolveCompanyVoiceIntegration(
  companyId: string,
  provider: VoiceIntegrationProvider
): Promise<VoiceIntegration | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from('voice_provider_integrations')
    .select('id, company_id, provider_account_id, webhook_secret_env, api_key_env, api_secret_env, from_number_env, answer_url_env, ai_agent_user_env, sale_agent_user_env')
    .eq('company_id', companyId).eq('provider', provider).eq('active', true).maybeSingle();
  if (error) throw new Error('VOICE_INTEGRATION_LOOKUP_FAILED');
  if (!data) return null;
  return toIntegration({
    integration_id: data.id,
    company_id: data.company_id,
    provider_account_id: data.provider_account_id,
    webhook_secret_env: data.webhook_secret_env,
    api_key_env: data.api_key_env,
    api_secret_env: data.api_secret_env,
    from_number_env: data.from_number_env,
    answer_url_env: data.answer_url_env,
    ai_agent_user_env: data.ai_agent_user_env,
    sale_agent_user_env: data.sale_agent_user_env,
  });
}
