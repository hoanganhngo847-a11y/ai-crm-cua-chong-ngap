import { NextResponse, type NextRequest } from 'next/server';
import {
  verifyWebhookSignature,
  processCallStatusUpdate,
  processInboundCall,
  type VoiceWebhookPayload,
} from '../../../../features/voice/services/webhook-processor';

/**
 * POST /api/webhooks/voice
 *
 * Nhận event từ tổng đài / SIP provider.
 *
 * Security:
 * - Verify signature trước mọi xử lý.
 * - Dùng createAdminClient() bên trong — không dùng user session.
 * - Không trả dữ liệu nhạy cảm trong response.
 * - Chống trùng: processInboundCall kiểm tra provider_call_id.
 *
 * Event types được hỗ trợ:
 * - call.inbound          — khách gọi vào Hotline
 * - call.status_updated   — trạng thái cuộc gọi thay đổi
 * - call.completed        — cuộc gọi kết thúc (alias cho status_updated)
 * - call.recording_ready  — ghi âm đã sẵn sàng (TODO: download & store)
 *
 * Biến môi trường cần có:
 *   VOICE_WEBHOOK_SECRET  — secret dùng để xác thực webhook
 *   VOICE_PROVIDER        — 'STRINGEE' | 'MANUAL'
 *   COMPANY_ID_DEFAULT    — company_id mặc định (single-company phase)
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: 'Cannot read request body' }, { status: 400 });
  }

  // ── Verify signature ──────────────────────────────────────────────────────
  const isValid = verifyWebhookSignature(request.headers, rawBody);
  if (!isValid) {
    console.warn('[webhook/voice] Invalid signature — rejecting request');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── Parse payload ─────────────────────────────────────────────────────────
  let payload: VoiceWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as VoiceWebhookPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  // Company ID — single-company phase: lấy từ env hoặc routing token
  // Multi-tenant sau này sẽ lookup theo số Hotline hoặc routing token
  const companyId =
    process.env.COMPANY_ID_DEFAULT || payload.company_webhook_token || '';

  if (!companyId) {
    console.error('[webhook/voice] Cannot determine companyId from webhook payload');
    return NextResponse.json({ error: 'Cannot determine company' }, { status: 400 });
  }

  // ── Route theo event type ─────────────────────────────────────────────────
  try {
    const eventType = (payload.event || '').toLowerCase();

    if (eventType === 'call.inbound' || eventType === 'call_inbound') {
      const result = await processInboundCall(payload, companyId);
      return NextResponse.json({ ok: true, ...result }, { status: 200 });
    }

    if (
      eventType === 'call.status_updated' ||
      eventType === 'call.completed' ||
      eventType === 'call_completed' ||
      eventType === 'call_status_updated'
    ) {
      const result = await processCallStatusUpdate(payload);
      return NextResponse.json({ ok: true, ...result }, { status: 200 });
    }

    if (eventType === 'call.recording_ready' || eventType === 'call_recording_ready') {
      // TODO: Download recording từ provider → upload vào bucket 'call-recordings'
      // → updateCallRecordingRef(callId, companyId, internalRef)
      // Hiện tại: log và return 200 để provider không retry
      console.log(`[webhook/voice] recording_ready event received — processing TODO`);
      return NextResponse.json({ ok: true, message: 'recording_ready acknowledged' }, { status: 200 });
    }

    // Event không được nhận dạng — return 200 để tổng đài không retry
    console.log(`[webhook/voice] Unhandled event type: ${payload.event}`);
    return NextResponse.json({ ok: true, message: 'event acknowledged but not handled' }, { status: 200 });
  } catch (err) {
    const error = err as Error;
    // SECURITY: Không trả chi tiết lỗi nội bộ ra ngoài
    console.error('[webhook/voice] Processing error:', error.message);
    return NextResponse.json({ error: 'Internal processing error' }, { status: 500 });
  }
}

// GET không được hỗ trợ — trả 405
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
