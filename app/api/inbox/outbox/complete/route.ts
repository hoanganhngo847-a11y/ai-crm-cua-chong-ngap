import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { InboxService } from '@/features/inbox/services/inbox.service';

export const runtime = 'nodejs';

function secureCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyWorkerSecret(request: NextRequest): { valid: boolean; errorResponse?: NextResponse } {
  if (process.env.NODE_ENV === 'production') {
    const proto = request.headers.get('x-forwarded-proto') || '';
    if (proto !== 'https' && !request.url.startsWith('https://')) {
      return {
        valid: false,
        errorResponse: NextResponse.json(
          { success: false, error: 'HTTPS_REQUIRED', message: 'Endpoint yêu cầu HTTPS.' },
          { status: 403 }
        ),
      };
    }
  }

  const configuredSecret = process.env.FB_WORKER_SECRET;
  if (!configuredSecret || !configuredSecret.trim()) {
    return {
      valid: false,
      errorResponse: NextResponse.json(
        { success: false, error: 'CONFIGURATION_ERROR', message: 'FB_WORKER_SECRET chưa được cấu hình.' },
        { status: 500 }
      ),
    };
  }

  const providedSecret =
    request.headers.get('x-worker-secret') ||
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
    '';

  if (!providedSecret || !secureCompare(providedSecret, configuredSecret)) {
    return {
      valid: false,
      errorResponse: NextResponse.json(
        { success: false, error: 'UNAUTHORIZED', message: 'Xác thực worker thất bại.' },
        { status: 401 }
      ),
    };
  }

  return { valid: true };
}

/**
 * POST /api/inbox/outbox/complete
 * Đánh dấu job SENT sau khi xác nhận message xuất hiện trên Facebook Messenger.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = verifyWorkerSecret(request);
    if (!auth.valid && auth.errorResponse) {
      return auth.errorResponse;
    }

    const body = await request.json().catch(() => null);
    if (!body || !body.job_id) {
      return NextResponse.json(
        { success: false, error: 'INVALID_PAYLOAD', message: 'Thiếu job_id.' },
        { status: 400 }
      );
    }

    const result = await InboxService.completeFacebookBrowserOutboxJob(
      body.job_id,
      body.provider_message_id
    );

    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Lỗi hệ thống';
    return NextResponse.json({ success: false, error: 'INTERNAL_ERROR', message }, { status: 500 });
  }
}
