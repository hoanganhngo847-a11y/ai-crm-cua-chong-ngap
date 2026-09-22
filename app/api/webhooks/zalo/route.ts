import { NextRequest, NextResponse } from 'next/server';
import { verifyZaloWebhookSignature } from '../../../../features/omnichannel/zalo/webhook-verifier';
import { ZaloSyncService } from '../../../../features/omnichannel/zalo/sync-service';
import { ZaloWebhookPayload } from '../../../../features/omnichannel/zalo/types';

export const dynamic = 'force-dynamic';

/**
 * Zalo OA Webhook Ingestion Endpoint.
 * Receives real-time messaging events from Zalo OA (user_send_text, user_send_image, oa_send_text, etc.).
 *
 * Security & Reliability Invariants:
 * 1. Provider Verification: Fail-closed verification using HMAC SHA-256 (rejects if secret or signature is missing).
 * 2. Tenant Isolation: Maps company_id server-side based on verified OA ID (never trusts client parameters).
 * 3. Durable Idempotency: Namespaced deduplication (company_id + ZALO + oa_id + msg_id).
 * 4. Ingress & Security Zones: Sanitizes data for SALE; stores raw payload into private security zone.
 */
export async function POST(request: NextRequest) {
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
    // Reject immediately if server secret is not configured or signature is missing
    if (!appSecret || !signature) {
      return NextResponse.json(
        {
          error: -1,
          message:
            'Webhook verification failed: Missing signature or server secret configuration (Fail-closed)',
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
          { error: -1, message: 'Invalid JSON payload' },
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
      return NextResponse.json(
        { error: -1, message: 'Invalid webhook signature' },
        { status: 401 }
      );
    }

    let payload: ZaloWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as ZaloWebhookPayload;
    } catch {
      return NextResponse.json(
        { error: -1, message: 'Invalid JSON payload' },
        { status: 400 }
      );
    }

    // 2. PROCESS WEBHOOK VIA SYNC SERVICE (Enforces server-side OA mapping & Security Zones)
    const syncService = new ZaloSyncService();
    const result = await syncService.handleWebhookEvent(payload);

    return NextResponse.json({
      error: 0,
      message: 'Success',
      result,
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
    const isTenantViolation = errorMessage.includes('Tenant isolation');

    if (isTenantViolation) {
      return NextResponse.json(
        { error: -1, message: errorMessage },
        { status: 403 }
      );
    }

    console.error('Zalo Webhook processing error:', errorMessage);
    return NextResponse.json(
      { error: -1, message: errorMessage },
      { status: 500 }
    );
  }
}
