'use server';

import { getActorContext, requireCompanyRole } from '../../lib/auth/context';
import { APPLICATION_ROLES } from '../../shared/constants/roles';
import {
    completeInstallationAndHandover,
    scheduleInstallation,
    updateInstallationStatus,
} from './installation-service';
import type {
    CompleteInstallationInput,
    InstallationDTO,
    InstallationStatus,
    ScheduleInstallationInput,
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
 */
export async function updateInstallationStatusAction(
    installationId: string,
    status: InstallationStatus
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

        await updateInstallationStatus(actor.companyId, installationId, status);
        return { success: true };
    } catch (err: unknown) {
        const error = err as Error;
        return { success: false, error: error.message || 'Lỗi cập nhật lắp đặt.' };
    }
}

/**
 * Action: Nghiệm thu & hoàn tất bàn giao
 */
export async function completeInstallationAction(
    input: CompleteInstallationInput
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

        await completeInstallationAndHandover(actor.companyId, input);
        return { success: true };
    } catch (err: unknown) {
        const error = err as Error;
        return { success: false, error: error.message || 'Lỗi nghiệm thu bàn giao.' };
    }
}