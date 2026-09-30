'use server';

import { z } from 'zod';
import { sanitizeErrorMessage } from '../operations/server';
import { getActorContext, requireCompanyRole } from '../../lib/auth/context';
import { APPLICATION_ROLES } from '../../shared/constants/roles';
import {
    createProductionOrder,
    recordQualityCheck,
    updateProductionProgress,
} from './production-service';
import type {
    CreateProductionOrderInput,
    ProductionOrderDTO,
    QCStatus,
    SettableProductionStatus,
} from './types';

// ==============================================================================
// RUNTIME VALIDATION SCHEMAS (ZOD - P1)
// ==============================================================================
const createProductionOrderSchema = z.object({
    orderId: z.uuid(),
    specs: z.record(z.string(), z.unknown()).refine((val) => Object.keys(val).length > 0, {
        message: 'Thông số kỹ thuật không được rỗng',
    }),
    materials: z.record(z.string(), z.unknown()).refine((val) => Object.keys(val).length > 0, {
        message: 'Thông tin vật tư không được rỗng',
    }),
    deadline: z.iso.datetime({ offset: true }),
});

const updateProductionProgressSchema = z.object({
    productionOrderId: z.uuid(),
    status: z.enum([
        'RELEASED_TO_FACTORY',
        'IN_PRODUCTION',
        'QC_IN_PROGRESS',
    ], {
        message: 'Trạng thái tiến độ xưởng không hợp lệ hoặc thuộc quyền hạn của bước QC.',
    }),
    note: z.string().optional(),
});

const recordQualityCheckSchema = z.object({
    productionOrderId: z.uuid(),
    qcStatus: z.enum(['PASSED', 'REWORK_REQUIRED', 'REJECTED'], {
        message: 'Kết quả kiểm tra QC chỉ chấp nhận PASSED, REWORK_REQUIRED hoặc REJECTED.',
    }),
    notes: z.string().optional(),
});


/**
 * Action: Tạo lệnh sản xuất (Việc 29)
 */
export async function createProductionOrderAction(
    input: CreateProductionOrderInput
): Promise<{ success: boolean; data?: ProductionOrderDTO; error?: string }> {
    try {
        const parsed = createProductionOrderSchema.safeParse(input);
        if (!parsed.success) {
            return {
                success: false,
                error: `Dữ liệu không hợp lệ: ${parsed.error.issues.map((e) => e.message).join(', ')}`,
            };
        }

        const actor = await getActorContext();
        if (!actor?.companyId) {
            return { success: false, error: 'Chưa xác định tổ chức làm việc.' };
        }

        // Chỉ Quản trị viên (Sếp) mới được phê duyệt lệnh xuống xưởng
        await requireCompanyRole(actor.companyId, [APPLICATION_ROLES.BOSS_ADMIN]);

        const data = await createProductionOrder(actor.companyId, parsed.data, undefined, actor.userId);
        return { success: true, data };
    } catch (err: unknown) {
        return { success: false, error: sanitizeErrorMessage(err, 'Lỗi tạo lệnh xưởng.') };
    }
}

/**
 * Action: Cập nhật tiến độ xưởng (Việc 30)
 */
export async function updateProductionProgressAction(
    productionOrderId: string,
    status: SettableProductionStatus,
    note?: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const parsed = updateProductionProgressSchema.safeParse({ productionOrderId, status, note });
        if (!parsed.success) {
            return {
                success: false,
                error: `Dữ liệu không hợp lệ: ${parsed.error.issues.map((e) => e.message).join(', ')}`,
            };
        }

        const actor = await getActorContext();
        if (!actor?.companyId || !actor?.userId) {
            return { success: false, error: 'Chưa xác định tổ chức hoặc người thực hiện.' };
        }

        await requireCompanyRole(actor.companyId, [APPLICATION_ROLES.BOSS_ADMIN]);

        await updateProductionProgress(actor.companyId, {
            productionOrderId: parsed.data.productionOrderId,
            status: parsed.data.status as SettableProductionStatus,
            note: parsed.data.note,
            actorId: actor.userId,
        });
        return { success: true };
    } catch (err: unknown) {
        return { success: false, error: sanitizeErrorMessage(err, 'Lỗi cập nhật tiến độ.') };
    }
}

/**
 * Action: Xác nhận kết quả QC (Việc 30)
 */
export async function recordQualityCheckAction(
    productionOrderId: string,
    qcStatus: QCStatus,
    notes?: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const parsed = recordQualityCheckSchema.safeParse({ productionOrderId, qcStatus, notes });
        if (!parsed.success) {
            return {
                success: false,
                error: `Dữ liệu không hợp lệ: ${parsed.error.issues.map((e) => e.message).join(', ')}`,
            };
        }

        const actor = await getActorContext();
        if (!actor?.companyId || !actor?.userId) {
            return { success: false, error: 'Chưa xác định tổ chức hoặc người thực hiện.' };
        }

        await requireCompanyRole(actor.companyId, [APPLICATION_ROLES.BOSS_ADMIN]);

        await recordQualityCheck(actor.companyId, {
            productionOrderId: parsed.data.productionOrderId,
            qcStatus: parsed.data.qcStatus as QCStatus,
            inspectorId: actor.userId,
            notes: parsed.data.notes,
        });
        return { success: true };
    } catch (err: unknown) {
        return { success: false, error: sanitizeErrorMessage(err, 'Lỗi xác nhận QC.') };
    }
}