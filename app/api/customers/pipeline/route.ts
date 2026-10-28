import { NextRequest, NextResponse } from 'next/server';
import { getActorContext } from '../../../../lib/auth/context';
import { createAdminClient } from '../../../../lib/supabase/admin';
import { APPLICATION_ROLES } from '../../../../shared/constants/roles';
import { CustomerService } from '../../../../features/crm/services/customer.service';
import {
  CUSTOMER_SOURCES,
  tryToCanonicalStage,
  type CustomerSource,
} from '../../../../features/crm/types/customer.types';
import type { ActorContext } from '../../../../shared/contracts/auth';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PipelineRouteContext {
  actor?: ActorContext | null;
  adminClient?: SupabaseClient;
}

const VALID_SOURCES = new Set<string>(Object.values(CUSTOMER_SOURCES));

function parseIsoDate(value: string | null): { value: string | null; valid: boolean } {
  if (!value) return { value: null, valid: true };
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return { value: null, valid: false };
  return { value: new Date(timestamp).toISOString(), valid: true };
}

/**
 * GET /api/customers/pipeline
 *
 * Nguồn dữ liệu duy nhất cho Kanban và Funnel.
 * - Tenant được suy ra từ actor context, không nhận company_id từ client.
 * - TECHNICIAN bị từ chối.
 * - Trả về counts + customers + distribution percentages.
 */
export async function GET(request: NextRequest, context?: unknown) {
  try {
    const typedContext = context as PipelineRouteContext | undefined;
    const actor =
      typedContext?.actor !== undefined ? typedContext.actor : await getActorContext();

    if (!actor || actor.profileStatus !== 'ACTIVE') {
      return NextResponse.json(
        { success: false, error: 'UNAUTHORIZED', message: 'Yêu cầu đăng nhập để truy cập.' },
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
          message: 'Chỉ nhân viên SALE hoặc BOSS_ADMIN mới có quyền xem phễu khách hàng.',
        },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search')?.trim() || null;
    const sourceParam = searchParams.get('source')?.trim().toUpperCase() || null;
    const stageParam = searchParams.get('stage')?.trim() || null;
    const fromParam = searchParams.get('from');
    const toParam = searchParams.get('to');

    if (sourceParam && !VALID_SOURCES.has(sourceParam)) {
      return NextResponse.json(
        { success: false, error: 'INVALID_SOURCE', message: 'Nguồn khách hàng không hợp lệ.' },
        { status: 400 }
      );
    }

    const canonicalStage = stageParam ? tryToCanonicalStage(stageParam) : null;
    if (stageParam && !canonicalStage) {
      return NextResponse.json(
        { success: false, error: 'INVALID_STAGE', message: 'Giai đoạn khách hàng không hợp lệ.' },
        { status: 400 }
      );
    }

    const from = parseIsoDate(fromParam);
    const to = parseIsoDate(toParam);
    if (!from.valid || !to.valid) {
      return NextResponse.json(
        { success: false, error: 'INVALID_DATE_RANGE', message: 'Khoảng thời gian không hợp lệ.' },
        { status: 400 }
      );
    }
    if (from.value && to.value && Date.parse(from.value) > Date.parse(to.value)) {
      return NextResponse.json(
        { success: false, error: 'INVALID_DATE_RANGE', message: 'Ngày bắt đầu phải trước ngày kết thúc.' },
        { status: 400 }
      );
    }

    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '200', 10) || 200, 1), 500);
    const adminClient = typedContext?.adminClient || createAdminClient();

    const pipeline = await CustomerService.getPipeline({
      companyId: actor.companyId,
      role: actor.role,
      search,
      source: sourceParam as CustomerSource | null,
      stage: canonicalStage,
      from: from.value,
      to: to.value,
      limit,
      client: adminClient,
    });

    return NextResponse.json({ success: true, data: pipeline });
  } catch (err: unknown) {
    console.error('Lỗi API pipeline khách hàng:', err);
    return NextResponse.json(
      { success: false, error: 'DATABASE_ERROR', message: 'Lỗi xử lý dữ liệu trên hệ thống.' },
      { status: 500 }
    );
  }
}
