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
 * POST /api/inbox/outbox/resolve-reconciled
 * Cập nhật kết quả đối soát sau khi worker kiểm tra thread Facebook:
 * - resolution = 'SENT': Đã tìm thấy tin nhắn gửi thành công trước khi crash -> mark SENT
 * - resolution = 'RETRY': Xác nhận chưa gửi -> chuyển sang RETRY an toàn
 * - resolution = 'RECONCILE_REQUIRED': Không đủ bằng chứng -> đánh dấu RECONCILE_REQUIRED, không gửi lại
 */
export async function POST(request: NextRequest) {
  try {
    const auth = verifyWorkerSecret(request);
    if (!auth.valid && auth.errorResponse) {
      return auth.errorResponse;
    }

    const body = await request.json().catch(() => ({}));
    const { job_id, resolution, provider_message_id, error } = body;

    if (!job_id || typeof job_id !== 'string') {
      return NextResponse.json(
        { success: false, error: 'INVALID_JOB_ID', message: 'job_id là bắt buộc.' },
        { status: 400 }
      );
    }

    if (!resolution || !['SENT', 'RETRY', 'RECONCILE_REQUIRED'].includes(resolution)) {
      return NextResponse.json(
        { success: false, error: 'INVALID_RESOLUTION', message: 'resolution phải là SENT, RETRY hoặc RECONCILE_REQUIRED.' },
        { status: 400 }
      );
    }

    const result = await InboxService.resolveReconciledFacebookBrowserJob(
      job_id,
      resolution,
      provider_message_id || undefined,
      error || undefined
    );

    return NextResponse.json({
      success: result.success,
      jobId: result.jobId,
      status: result.status,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Lỗi hệ thống';
    return NextResponse.json({ success: false, error: 'INTERNAL_ERROR', message }, { status: 500 });
  }
}
