'use server';

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
    ProductionOrderStatus,
    QCStatus,
} from './types';

/**
 * Action: Tạo lệnh sản xuất
 */
export async function createProductionOrderAction(
    input: CreateProductionOrderInput
): Promise<{ success: boolean; data?: ProductionOrderDTO; error?: string }> {
    try {
        const actor = await getActorContext();
        if (!actor?.companyId) {
            return { success: false, error: 'Chưa xác định tổ chức làm việc.' };
        }

        // Chỉ Quản trị viên (Sếp) mới được phê duyệt lệnh xuống xưởng
        await requireCompanyRole(actor.companyId, [APPLICATION_ROLES.BOSS_ADMIN]);

        const data = await createProductionOrder(actor.companyId, input);
        return { success: true, data };
    } catch (err: unknown) {
        const error = err as Error;
        return { success: false, error: error.message || 'Lỗi tạo lệnh xưởng.' };
    }
}

/**
 * Action: Cập nhật tiến độ xưởng
 */
export async function updateProductionProgressAction(
    productionOrderId: string,
    status: ProductionOrderStatus
): Promise<{ success: boolean; error?: string }> {
    try {
        const actor = await getActorContext();
        if (!actor?.companyId) {
            return { success: false, error: 'Chưa xác định tổ chức làm việc.' };
        }

        await requireCompanyRole(actor.companyId, [
            APPLICATION_ROLES.BOSS_ADMIN,
            APPLICATION_ROLES.TECHNICIAN,
        ]);

        await updateProductionProgress(actor.companyId, productionOrderId, status);
        return { success: true };
    } catch (err: unknown) {
        const error = err as Error;
        return { success: false, error: error.message || 'Lỗi cập nhật tiến độ.' };
    }
}

/**
 * Action: Xác nhận kết quả QC
 */
export async function recordQualityCheckAction(
    productionOrderId: string,
    qcStatus: QCStatus
): Promise<{ success: boolean; error?: string }> {
    try {
        const actor = await getActorContext();
        if (!actor?.companyId) {
            return { success: false, error: 'Chưa xác định tổ chức làm việc.' };
        }

        await requireCompanyRole(actor.companyId, [
            APPLICATION_ROLES.BOSS_ADMIN,
            APPLICATION_ROLES.TECHNICIAN,
        ]);

        await recordQualityCheck(actor.companyId, productionOrderId, qcStatus);
        return { success: true };
    } catch (err: unknown) {
        const error = err as Error;
        return { success: false, error: error.message || 'Lỗi xác nhận QC.' };
    }
}