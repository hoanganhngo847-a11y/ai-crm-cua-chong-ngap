import type { SupabaseClient } from '@supabase/supabase-js';
import { ZaloClientFactory, type ZaloSendResult } from './zalo-client';

const DEFAULT_ZCAJS_TIMEOUT_MS = 20_000;
const ZCAJS_APP_ID = 'ZCAJS';

export interface ZaloTransportClient {
  sendTextMessageWithOutcome(recipientZaloId: string, text: string): Promise<ZaloSendResult>;
}

export interface ZaloTransportFactoryOptions {
  supabase?: SupabaseClient;
  fetchFn?: typeof fetch;
}

interface ZcaJsWorkerResponse {
  outcome?: 'ACCEPTED' | 'REJECTED' | 'UNCERTAIN';
  providerMessageId?: string | number | null;
  errorCode?: string;
  errorMessage?: string;
}

interface ZcaJsConfig {
  companyId: string;
  workerUrl: string;
  workerSecret: string;
}

export function getZaloTransportMode(): 'OA' | 'ZCAJS' {
  const value = (process.env.ZALO_TRANSPORT || 'OA').trim().toUpperCase();
  if (value === 'OA' || value === 'ZCAJS') return value;
  throw new Error(`Unsupported ZALO_TRANSPORT value: ${value}`);
}

function requireZcaJsConfig(companyId: string): ZcaJsConfig {
  const configuredCompanyId = (process.env.ZALO_ZCAJS_COMPANY_ID || '').trim();
  const workerUrl = (process.env.ZALO_ZCAJS_WORKER_URL || '').trim();
  const workerSecret = process.env.ZALO_ZCAJS_WORKER_SECRET || '';

  if (!configuredCompanyId || !workerUrl || !workerSecret) {
    throw new Error(
      'ZCAJS transport is enabled but ZALO_ZCAJS_COMPANY_ID, ZALO_ZCAJS_WORKER_URL or ZALO_ZCAJS_WORKER_SECRET is missing.'
    );
  }
  if (configuredCompanyId !== companyId) {
    throw new Error('ZCAJS transport is not configured for this company.');
  }

  let parsed: URL;
  try {
    parsed = new URL(workerUrl);
  } catch {
    throw new Error('ZALO_ZCAJS_WORKER_URL is not a valid URL.');
  }
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new Error('ZALO_ZCAJS_WORKER_URL must use HTTPS in production.');
  }

  return { companyId: configuredCompanyId, workerUrl: parsed.toString(), workerSecret };
}

/**
 * Internal routing alias used only by the existing durable Zalo outbox.
 * It is not a real Zalo OA id. Keeping the alias company-scoped avoids collisions
 * with real OA ids while allowing the existing DB fencing/idempotency machinery
 * to remain authoritative when the transport is ZCAJS.
 */
export function getZcaJsLogicalOaId(companyId: string): string {
  return `zcajs:${companyId}`;
}

/**
 * The current durable outbox resolves an ACTIVE row from public.zalo_oa_configs before
 * provider dispatch. In ZCAJS mode we register a non-secret logical route there.
 * No cookie, IMEI, user-agent or worker secret is stored in the database.
 */
export async function ensureZcaJsRoutingConfig(
  supabase: SupabaseClient,
  companyId: string
): Promise<string | undefined> {
  if (getZaloTransportMode() !== 'ZCAJS') return undefined;
  requireZcaJsConfig(companyId);

  const logicalOaId = getZcaJsLogicalOaId(companyId);
  const { data: existing, error: lookupError } = await supabase
    .from('zalo_oa_configs')
    .select('id, app_id, status')
    .eq('company_id', companyId)
    .eq('oa_id', logicalOaId)
    .maybeSingle();

  if (lookupError) {
    throw new Error(`Unable to verify ZCAJS routing configuration: ${lookupError.message}`);
  }

  if (existing) {
    if (existing.app_id !== ZCAJS_APP_ID) {
      throw new Error('ZCAJS logical route collides with a non-ZCAJS Zalo configuration.');
    }
    if (existing.status !== 'ACTIVE') {
      const { error: activateError } = await supabase
        .from('zalo_oa_configs')
        .update({ status: 'ACTIVE', updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .eq('company_id', companyId);
      if (activateError) {
        throw new Error(`Unable to activate ZCAJS routing configuration: ${activateError.message}`);
      }
    }
    return logicalOaId;
  }

  const { error: insertError } = await supabase.from('zalo_oa_configs').insert({
    company_id: companyId,
    oa_id: logicalOaId,
    app_id: ZCAJS_APP_ID,
    status: 'ACTIVE',
  });
  if (insertError) {
    throw new Error(`Unable to register ZCAJS routing configuration: ${insertError.message}`);
  }

  return logicalOaId;
}

export class ZcaJsTransportClient implements ZaloTransportClient {
  private readonly companyId: string;
  private readonly workerUrl: string;
  private readonly workerSecret: string;
  private readonly fetchFn: typeof fetch;

  constructor(companyId: string, options: { fetchFn?: typeof fetch } = {}) {
    const config = requireZcaJsConfig(companyId);
    this.companyId = companyId;
    this.workerUrl = config.workerUrl;
    this.workerSecret = config.workerSecret;
    this.fetchFn = options.fetchFn || fetch;
  }

  async sendTextMessageWithOutcome(recipientZaloId: string, text: string): Promise<ZaloSendResult> {
    if (!recipientZaloId?.trim() || !text?.trim()) {
      return {
        outcome: 'REJECTED',
        errorCode: 'INVALID_ARGUMENT',
        errorMessage: 'Recipient and message content are required.',
      };
    }

    let response: Response;
    try {
      response = await this.fetchFn(new URL('/v1/send', this.workerUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.workerSecret}`,
        },
        body: JSON.stringify({
          companyId: this.companyId,
          recipientZaloId: recipientZaloId.trim(),
          text,
        }),
        signal: AbortSignal.timeout(DEFAULT_ZCAJS_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      return {
        outcome: 'UNCERTAIN',
        errorCode: 'ZCAJS_WORKER_NETWORK_ERROR',
        errorMessage: error instanceof Error ? error.message : 'ZCAJS worker request failed.',
      };
    }

    let body: ZcaJsWorkerResponse | null = null;
    try {
      body = (await response.json()) as ZcaJsWorkerResponse;
    } catch {
      // An unreadable response after the request left this process is ambiguous.
    }

    if (response.ok && body?.outcome === 'ACCEPTED') {
      const providerMessageId = String(body.providerMessageId ?? '').trim();
      if (!providerMessageId) {
        return {
          outcome: 'UNCERTAIN',
          errorCode: 'MISSING_PROVIDER_MSG_ID',
          errorMessage: 'ZCAJS reported success without a stable Zalo message id.',
        };
      }
      return { outcome: 'ACCEPTED', providerMsgId: providerMessageId };
    }

    if (body?.outcome === 'REJECTED' || (response.status >= 400 && response.status < 500)) {
      return {
        outcome: 'REJECTED',
        errorCode: body?.errorCode || `HTTP_${response.status}`,
        errorMessage: body?.errorMessage || 'ZCAJS worker rejected the message.',
      };
    }

    return {
      outcome: 'UNCERTAIN',
      errorCode: body?.errorCode || `HTTP_${response.status}`,
      errorMessage: body?.errorMessage || 'ZCAJS worker delivery outcome is uncertain.',
    };
  }
}

export async function getZaloTransportClient(
  companyId: string,
  oaId: string,
  options: ZaloTransportFactoryOptions = {}
): Promise<ZaloTransportClient> {
  if (getZaloTransportMode() === 'ZCAJS') {
    const expectedLogicalOaId = getZcaJsLogicalOaId(companyId);
    if (oaId !== expectedLogicalOaId) {
      throw new Error('ZCAJS transport received an unexpected routing id.');
    }
    return new ZcaJsTransportClient(companyId, { fetchFn: options.fetchFn });
  }

  return ZaloClientFactory.getClientForOa(companyId, oaId, options);
}
