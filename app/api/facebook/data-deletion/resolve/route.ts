import { NextResponse } from 'next/server';
import { getActorContext, requireBossAdmin } from '@/lib/auth/context';
import { isMetaReviewerMfaExempt } from '@/lib/auth/meta-review';
import {
    errorResponse,
    resolveManualDataDeletion,
} from '@/features/omnichannel/facebook/server';

export const runtime = 'nodejs';

export async function POST(request: Request) {
    try {
        let body: Record<string, unknown> | null = null;
        try {
            body = (await request.json()) as Record<string, unknown>;
        } catch {
            return NextResponse.json(
                { success: false, error: 'INVALID_JSON', message: 'Yêu cầu định dạng JSON hợp lệ.' },
                { status: 400 }
            );
        }

        const confirmationCode = String(body?.confirmation_code || body?.confirmationCode || '').trim();
        const action = String(body?.action || '').trim().toUpperCase() as 'APPROVE' | 'REJECT';
        const customerId = body?.customer_id || body?.customerId ? String(body.customer_id || body.customerId).trim() : null;
        const reason = body?.reason ? String(body.reason).trim() : null;
        const requestedCompanyId = body?.company_id || body?.companyId ? String(body.company_id || body.companyId).trim() : undefined;

        if (!confirmationCode) {
            return NextResponse.json(
                { success: false, error: 'INVALID_REQUEST', message: 'Mã xác nhận (confirmation_code) là bắt buộc.' },
                { status: 400 }
            );
        }

        if (action !== 'APPROVE' && action !== 'REJECT') {
            return NextResponse.json(
                { success: false, error: 'INVALID_ACTION', message: 'Action phải là APPROVE hoặc REJECT.' },
                { status: 400 }
            );
        }

        if (action === 'APPROVE' && !customerId) {
            return NextResponse.json(
                { success: false, error: 'INVALID_ACTION', message: 'customer_id là bắt buộc khi chọn APPROVE.' },
                { status: 400 }
            );
        }

        // 1. Authenticate actor
        const actor = await getActorContext(requestedCompanyId);
        if (!actor?.userId || !actor?.companyId) {
            return NextResponse.json(
                { success: false, error: 'UNAUTHORIZED', message: 'Yêu cầu đăng nhập quản trị viên.' },
                { status: 401 }
            );
        }

        // 2. Authorize BOSS_ADMIN of the target company
        try {
            await requireBossAdmin(actor.companyId, {
                requireAal2: !isMetaReviewerMfaExempt(actor.userId),
            });
        } catch (authErr: unknown) {
            const errObj = authErr as { code?: string; message?: string; status?: number } | null;
            return NextResponse.json(
                { success: false, error: errObj?.code || 'ACCESS_DENIED', message: errObj?.message || 'Chỉ BOSS_ADMIN mới có quyền giải quyết yêu cầu xóa dữ liệu thủ công.' },
                { status: errObj?.status || 403 }
            );
        }

        // 3. Execute trusted resolution through service role
        const result = await resolveManualDataDeletion({
            companyId: actor.companyId,
            confirmationCode,
            action,
            customerId,
            reason,
            adminUserId: actor.userId,
        });

        return NextResponse.json({
            success: true,
            data: result,
        });
    } catch (error) {
        return errorResponse(error);
    }
}
