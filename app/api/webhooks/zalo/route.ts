import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { verifyZaloWebhookSignature } from '../../../../features/omnichannel/zalo/webhook-verifier';
import { ZaloSyncService } from '../../../../features/omnichannel/zalo/sync-service';
import { ZaloWebhookPayload } from '../../../../features/omnichannel/zalo/types';
import { TenantResolutionError } from '../../../../features/omnichannel/zalo/oa-mapping';

export const dynamic = 'force-dynamic';

/**
 * Zalo OA Webhook Ingestion Endpoint.
 * Receives real-time messaging events from Zalo OA (user_send_text, user_send_image, oa_send_text, etc.).
 *
 * Security & Reliability Invariants:
 * 1. Provider Verification: Fail-closed verification using HMAC SHA-256 (rejects if secret or signature is missing).
 * 2. Tenant Isolation: Maps company_id server-side based on verified OA ID (never trusts client parameters).
 * 3. Durable Idempotency: Namespaced deduplication claim via DB unique constraint.
 * 4. Ingress & Security Zones: Sanitizes data for SALE; records raw payload into private security zone without swallowing errors.
 * 5. Safe Error Sanitization: Never leaks database schema, vendor traces, or internal exceptions in HTTP responses.
 */
export async function POST(request: NextRequest) {
  const traceId = crypto.randomUUID();

  try {
    const rawBody = await request.text();
    const signature =
      request.headers.get('x-zevent-signature') ||
      request.headers.get('X-ZEvent-Signature') ||
      request.headers.get('mac') ||
      '';

    const appId = process.env.ZALO_APP_ID || '';
    const appSecret = process.env.ZALO_APP_SECRET || process.env.ZALO_WEBHOOK_SECRET || '';

    // 1. FAIL-CLOSED PROVIDER VERIFICATION:
    if (!appSecret || !signature) {
      console.warn(`[Zalo Webhook Security Warning] Missing signature or server secret. Trace: ${traceId}`);
      return NextResponse.json(
        {
          error: 'UNAUTHORIZED',
          message: 'Webhook verification failed: Missing signature or server secret configuration (Fail-closed)',
          trace_id: traceId,
        },
        { status: 401 }
      );
    }

    // Extract timestamp from header or payload
    let timestamp = request.headers.get('x-zevent-timestamp') || '';
    if (!timestamp) {
      try {
        const parsed = JSON.parse(rawBody);
        timestamp = parsed.timestamp || '';
      } catch {
        return NextResponse.json(
          {
            error: 'INVALID_PAYLOAD',
            message: 'Malformed JSON payload',
            trace_id: traceId,
          },
          { status: 400 }
        );
      }
    }

    const isValid = verifyZaloWebhookSignature({
      rawBody,
      timestamp,
      signature,
      appId,
      appSecret,
    });

    if (!isValid) {
      console.warn(`[Zalo Webhook Security Warning] Invalid HMAC signature. Trace: ${traceId}`);
      return NextResponse.json(
        {
          error: 'INVALID_SIGNATURE',
          message: 'Webhook signature verification failed',
          trace_id: traceId,
        },
        { status: 401 }
      );
    }

    let payload: ZaloWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as ZaloWebhookPayload;
    } catch {
      return NextResponse.json(
        {
          error: 'INVALID_PAYLOAD',
          message: 'Malformed JSON payload',
          trace_id: traceId,
        },
        { status: 400 }
      );
    }

    // 2. PROCESS WEBHOOK VIA SYNC SERVICE (Atomic Ingress Pipeline & Idempotency Claim)
    const syncService = new ZaloSyncService();
    const result = await syncService.handleWebhookEvent(payload);

    return NextResponse.json({
      error: 0,
      message: 'Success',
      result,
      trace_id: traceId,
    });
  } catch (error: unknown) {
    if (error instanceof TenantResolutionError) {
      console.warn(`[Zalo Webhook Tenant Warning] ${error.message}. Trace: ${traceId}`);
      return NextResponse.json(
        {
          error: 'TENANT_NOT_FOUND',
          trace_id: traceId,
        },
        { status: error.httpStatus }
      );
    }

    // Sanitize internal server errors: Never leak raw database queries, table names, or vendor stack traces
    const internalErrorMessage = error instanceof Error ? error.message : 'Unknown internal error';
    console.error(`[Zalo Webhook Processing Error] Trace: ${traceId}, Detail: ${internalErrorMessage}`);

    return NextResponse.json(
      {
        error: 'ZALO_WEBHOOK_PROCESSING_FAILED',
        trace_id: traceId,
      },
      { status: 500 }
    );
  }
}
