import { NextRequest, NextResponse } from 'next/server';
import { getActorContext } from '../../../../../../../lib/auth/context';
import { createAdminClient } from '../../../../../../../lib/supabase/admin';
import { APPLICATION_ROLES } from '../../../../../../../shared/constants/roles';
import { CustomerService } from '../../../../../../../features/crm/services/customer.service';
import type { ActorContext } from '../../../../../../../shared/contracts/auth';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface VerifyStageSuggestionRouteContext {
  params: Promise<{ id: string; analysisId: string }>;
  actor?: ActorContext | null;
  adminClient?: SupabaseClient;
}

/**
 * POST /api/customers/[id]/stage-suggestions/[analysisId]/verify
 *
 * Con người xác nhận hoặc từ chối đề xuất giai đoạn của AI.
 * - SALE và BOSS_ADMIN được phép xác minh.
 * - Riêng contract_signed chỉ BOSS_ADMIN được chấp nhận (RPC cũng enforce).
 * - Nếu giai đoạn khách hàng đã thay đổi kể từ lúc phân tích, trả 409.
 */
export async function POST(request: NextRequest, context: VerifyStageSuggestionRouteContext) {
  try {
    const actor = context?.actor !== undefined ? context.actor : await getActorContext();

    if (!actor || actor.profileStatus !== 'ACTIVE') {
      return NextResponse.json(
        { success: false, error: 'UNAUTHORIZED', message: 'Yêu cầu đăng nhập để thực hiện thao tác.' },
        { status: 401 }
      );
    }

    if (!actor.companyId || actor.membershipStatus !== 'ACTIVE' || !actor.role) {
      return NextResponse.json(
        { success: false, error: 'FORBIDDEN', message: 'Tài khoản không thuộc tổ chức hợp lệ.' },
        { status: 403 }
      );
    }

    if (actor.role !== APPLICATION_ROLES.SALE && actor.role !== APPLICATION_ROLES.BOSS_ADMIN) {
      return NextResponse.json(
        {
          success: false,
          error: 'ROLE_FORBIDDEN',
          message: 'Chỉ nhân viên SALE hoặc BOSS_ADMIN mới có quyền xác minh đề xuất giai đoạn.',
        },
        { status: 403 }
      );
    }

    const { id: customerId, analysisId } = await context.params;
    if (!customerId || !analysisId) {
      return NextResponse.json(
        { success: false, error: 'MISSING_PARAM', message: 'Mã khách hàng và mã đề xuất là bắt buộc.' },
        { status: 400 }
      );
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { success: false, error: 'INVALID_PAYLOAD', message: 'Dữ liệu yêu cầu không hợp lệ.' },
        { status: 400 }
      );
    }

    const rawDecision = String((body as Record<string, unknown>).decision || '').toUpperCase();
    if (rawDecision !== 'ACCEPTED' && rawDecision !== 'REJECTED') {
      return NextResponse.json(
        {
          success: false,
          error: 'INVALID_DECISION',
          message: 'Quyết định phải là ACCEPTED hoặc REJECTED.',
        },
        { status: 400 }
      );
    }

    const note =
      typeof (body as Record<string, unknown>).note === 'string'
        ? String((body as Record<string, unknown>).note).trim()
        : null;

    const adminClient = context?.adminClient || createAdminClient();
    const result = await CustomerService.verifyAiStageSuggestion({
      companyId: actor.companyId,
      customerId,
      analysisId,
      decision: rawDecision,
      verifiedBy: actor.userId,
      verifierRole: actor.role,
      note,
      client: adminClient,
    });

    if (result.suggestion.customer_id && result.suggestion.customer_id !== customerId) {
      return NextResponse.json(
        { success: false, error: 'NOT_FOUND', message: 'Không tìm thấy đề xuất AI cho khách hàng này.' },
        { status: 404 }
      );
    }

    const sanitizedCustomer = result.customer
      ? CustomerService.sanitizeForRole({ customer: result.customer }, actor.role)
      : null;

    return NextResponse.json({
      success: true,
      data: {
        suggestion: result.suggestion,
        customer: sanitizedCustomer,
        history: result.history,
      },
      message:
        rawDecision === 'ACCEPTED'
          ? 'Đã xác nhận đề xuất giai đoạn của AI.'
          : 'Đã từ chối đề xuất giai đoạn của AI.',
    });
  } catch (err: unknown) {
    const errorObj = err as { message?: string; status?: number; code?: string } | undefined;
    const status = errorObj?.status || 500;

    if (status === 400 || status === 403 || status === 404 || status === 409) {
      return NextResponse.json(
        {
          success: false,
          error: errorObj?.code || 'REQUEST_FAILED',
          message: errorObj?.message || 'Không thể xác minh đề xuất giai đoạn.',
        },
        { status }
      );
    }

    console.error('Lỗi API xác minh đề xuất giai đoạn:', err);
    return NextResponse.json(
      { success: false, error: 'DATABASE_ERROR', message: 'Lỗi xử lý dữ liệu trên hệ thống.' },
      { status: 500 }
    );
  }
}
