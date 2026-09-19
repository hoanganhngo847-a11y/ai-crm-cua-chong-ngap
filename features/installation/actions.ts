'use server';

import { AuthError, getActorContext, requireCompanyRole } from '../../lib/auth/context';
import { APPLICATION_ROLES } from '../../shared/constants/roles';
import {
    completeInstallationAndHandover,
    scheduleInstallation,
    updateInstallationStatus,
    verifyTechnicianInstallationAssignment,
} from './installation-service';
import type {
    CompleteInstallationInput,
    InstallationDTO,
    ScheduleInstallationInput,
    SettableInstallationStatus,
} from './types';

/**
 * Action: Lên lịch lắp đặt
 */
export async function scheduleInstallationAction(
    input: ScheduleInstallationInput
): Promise<{ success: boolean; data?: InstallationDTO; error?: string }> {
    try {
        const actor = await getActorContext();
        if (!actor?.companyId) {
            return { success: false, error: 'Chưa xác định tổ chức làm việc.' };
        }

        await requireCompanyRole(actor.companyId, [APPLICATION_ROLES.BOSS_ADMIN]);

        const data = await scheduleInstallation(actor.companyId, input);
        return { success: true, data };
    } catch (err: unknown) {
        const error = err as Error;
        return { success: false, error: error.message || 'Lỗi đặt lịch lắp đặt.' };
    }
}

/**
 * Action: Cập nhật trạng thái lắp đặt
 * - Ràng buộc: SettableInstallationStatus (Loại bỏ COMPLETED).
 * - Nếu caller là TECHNICIAN: bắt buộc kiểm tra appointments liên kết (P0).
 */
export async function updateInstallationStatusAction(
    installationId: string,
    status: SettableInstallationStatus
): Promise<{ success: boolean; error?: string }> {
    try {
        const actor = await getActorContext();
        if (!actor?.companyId || !actor?.userId) {
            return { success: false, error: 'Chưa xác định tổ chức làm việc.' };
        }

        await requireCompanyRole(actor.companyId, [
            APPLICATION_ROLES.BOSS_ADMIN,
            APPLICATION_ROLES.TECHNICIAN,
        ]);

        if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
            await verifyTechnicianInstallationAssignment(actor.companyId, actor.userId, installationId);
        }

        await updateInstallationStatus(actor.companyId, installationId, status, undefined, actor);
        return { success: true };
    } catch (err: unknown) {
        if (err instanceof AuthError) {
            throw err;
        }
        const error = err as Error;
        return { success: false, error: error.message || 'Lỗi cập nhật lắp đặt.' };
    }
}

/**
 * Action: Nghiệm thu & hoàn tất bàn giao
 * - Nếu caller là TECHNICIAN: bắt buộc kiểm tra appointments liên kết (P0).
 */
export async function completeInstallationAction(
    input: CompleteInstallationInput
): Promise<{ success: boolean; error?: string }> {
    try {
        const actor = await getActorContext();
        if (!actor?.companyId || !actor?.userId) {
            return { success: false, error: 'Chưa xác định tổ chức làm việc.' };
        }

        await requireCompanyRole(actor.companyId, [
            APPLICATION_ROLES.BOSS_ADMIN,
            APPLICATION_ROLES.TECHNICIAN,
        ]);

        if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
            await verifyTechnicianInstallationAssignment(actor.companyId, actor.userId, input.installationId);
        }

        await completeInstallationAndHandover(actor.companyId, input, undefined, actor);
        return { success: true };
    } catch (err: unknown) {
        if (err instanceof AuthError) {
            throw err;
        }
        const error = err as Error;
        return { success: false, error: error.message || 'Lỗi nghiệm thu bàn giao.' };
    }
}