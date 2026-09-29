import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../../lib/supabase/admin';
import { verifyZaloWebhookSignature } from './webhook-verifier';
import { ZaloSyncService, classifyZaloEvent } from './sync-service';
import {
  TenantLookupUnavailableError,
  TenantResolutionError,
  ZaloOAMappingService,
  ZaloOATenant,
} from './oa-mapping';
import { ZaloWebhookPayload } from './types';

export interface ZaloWebhookHandlerDeps {
  supabase?: SupabaseClient;
  fetchFn?: typeof fetch;
  env?: Partial<Record<'ZALO_APP_ID' | 'ZALO_APP_SECRET' | 'ZALO_WEBHOOK_SECRET', string>>;
}

export interface ZaloWebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Framework-agnostic Zalo webhook handler (the Next.js route only adapts Request/Response).
 * Production wiring: one service-role client shared by tenant resolution, ingress RPCs and the
 * per-OA ZaloClientFactory — the same wiring the tests exercise.
 *
 * Order: parse → resolve tenant by OA → verify HMAC with THAT OA's secret → ingest.
 * Errors never leak DB/provider internals; details go to logs with a trace id.
 */
export async function handleZaloWebhookRequest(
  request: Request,
  deps: ZaloWebhookHandlerDeps = {}
): Promise<ZaloWebhookResponse> {
  const traceId = crypto.randomUUID();
  const env = deps.env ?? process.env;

  try {
    const rawBody = await request.text();
    const signature =
      request.headers.get('x-zevent-signature') || request.headers.get('mac') || '';

    if (!signature) {
      console.warn(`[Zalo Webhook] Missing signature. Trace: ${traceId}`);
      return { status: 401, body: { error: 'UNAUTHORIZED', trace_id: traceId } };
    }

    let payload: ZaloWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as ZaloWebhookPayload;
    } catch {
      return { status: 400, body: { error: 'INVALID_PAYLOAD', trace_id: traceId } };
    }

    const supabase = deps.supabase ?? createAdminClient();
    const resolver = new ZaloOAMappingService(supabase);
    const classified = classifyZaloEvent(payload);
    const oaId = classified.kind === 'IGNORED' ? payload.oa_id || payload.recipient?.id || '' : classified.oaId;

    const tenant: ZaloOATenant = await resolver.resolveTenant(oaId);

    // Per-OA secret first; the single-OA env secret is a legacy fallback only.
    const appSecret = tenant.webhookSecret || env.ZALO_WEBHOOK_SECRET || env.ZALO_APP_SECRET || '';
    const appId = tenant.appId || env.ZALO_APP_ID || '';
    if (!appSecret) {
      console.error(`[Zalo Webhook] No webhook secret configured for OA ${tenant.oaId}. Trace: ${traceId}`);
      return { status: 401, body: { error: 'UNAUTHORIZED', trace_id: traceId } };
    }
    if (payload.app_id && tenant.appId && payload.app_id !== tenant.appId) {
      console.warn(`[Zalo Webhook] app_id does not match OA configuration. Trace: ${traceId}`);
      return { status: 401, body: { error: 'INVALID_SIGNATURE', trace_id: traceId } };
    }

    const timestamp = request.headers.get('x-zevent-timestamp') || String(payload.timestamp ?? '');
    const isValid = verifyZaloWebhookSignature({ rawBody, timestamp, signature, appId, appSecret });
    if (!isValid) {
      console.warn(`[Zalo Webhook] Invalid HMAC signature. Trace: ${traceId}`);
      return { status: 401, body: { error: 'INVALID_SIGNATURE', trace_id: traceId } };
    }

    const syncService = new ZaloSyncService({ supabase, oaMappingResolver: resolver, fetchFn: deps.fetchFn });
    const result = await syncService.handleWebhookEvent(payload, tenant);

    if (result.status === 'busy') {
      return { status: 429, body: { error: 'EVENT_BUSY_RETRY_LATER', trace_id: traceId } };
    }
    return { status: 200, body: { error: 0, message: 'Success', status: result.status, trace_id: traceId } };
  } catch (error: unknown) {
    if (error instanceof TenantResolutionError) {
      console.warn(`[Zalo Webhook Tenant] ${error.message}. Trace: ${traceId}`);
      return { status: error.httpStatus, body: { error: 'TENANT_NOT_FOUND', trace_id: traceId } };
    }
    if (error instanceof TenantLookupUnavailableError) {
      console.error(`[Zalo Webhook Tenant Lookup] ${error.message}. Trace: ${traceId}`);
      return { status: 503, body: { error: 'TEMPORARILY_UNAVAILABLE', trace_id: traceId } };
    }

    const detail = error instanceof Error ? error.message : 'Unknown internal error';
    console.error(`[Zalo Webhook Processing Error] Trace: ${traceId}, Detail: ${detail}`);
    return { status: 500, body: { error: 'ZALO_WEBHOOK_PROCESSING_FAILED', trace_id: traceId } };
  }
}
