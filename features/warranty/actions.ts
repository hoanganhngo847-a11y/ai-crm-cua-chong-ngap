'use server';

import { AuthError, getActorContext, requireCompanyRole } from '../../lib/auth/context';
import { APPLICATION_ROLES } from '../../shared/constants/roles';
import {
    assignWarrantyTicket,
    createWarrantyTicket,
    reopenWarrantyTicket,
    updateWarrantyStatus,
} from './warranty-service';
import type {
    AssignWarrantyTicketInput,
    CreateWarrantyTicketInput,
    ReopenWarrantyTicketInput,
    UpdateWarrantyStatusInput,
    WarrantyTicketDTO,
} from './types';

/**
 * Action: Mở phiếu bảo hành mới (Chỉ cho phép BOSS_ADMIN và SALE tiếp nhận mở ticket - P0)
 */
export async function createWarrantyTicketAction(
    input: CreateWarrantyTicketInput
): Promise<{ success: boolean; data?: WarrantyTicketDTO; error?: string }> {
    try {
        const actor = await getActorContext();
        if (!actor?.companyId) {
            return { success: false, error: 'Chưa xác định tổ chức làm việc.' };
        }

        await requireCompanyRole(actor.companyId, [
            APPLICATION_ROLES.BOSS_ADMIN,
            APPLICATION_ROLES.SALE,
        ]);

        const data = await createWarrantyTicket(actor.companyId, input);
        return { success: true, data };
    } catch (err: unknown) {
        if (err instanceof AuthError) {
            throw err;
        }
        const error = err as Error;
        return { success: false, error: error.message || 'Lỗi tạo phiếu bảo hành.' };
    }
}

/**
 * Action: Phân công Kỹ thuật viên bảo hành
 */
export async function assignWarrantyTicketAction(
    input: AssignWarrantyTicketInput
): Promise<{ success: boolean; error?: string }> {
    try {
        const actor = await getActorContext();
        if (!actor?.companyId) {
            return { success: false, error: 'Chưa xác định tổ chức làm việc.' };
        }

        await requireCompanyRole(actor.companyId, [APPLICATION_ROLES.BOSS_ADMIN]);

        await assignWarrantyTicket(actor.companyId, input);
        return { success: true };
    } catch (err: unknown) {
        const error = err as Error;
        return { success: false, error: error.message || 'Lỗi phân công kỹ thuật viên.' };
    }
}

/**
 * Action: Cập nhật trạng thái bảo hành
 * - Nếu caller là TECHNICIAN: bắt buộc kiểm tra ticket.assigned_to === actor.userId (P0).
 */
export async function updateWarrantyStatusAction(
    input: UpdateWarrantyStatusInput
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

        await updateWarrantyStatus(actor.companyId, input, undefined, actor);
        return { success: true };
    } catch (err: unknown) {
        if (err instanceof AuthError) {
            throw err;
        }
        const error = err as Error;
        return { success: false, error: error.message || 'Lỗi cập nhật bảo hành.' };
    }
}

/**
 * Action: Tái mở phiếu bảo hành
 */
export async function reopenWarrantyTicketAction(
    input: ReopenWarrantyTicketInput
): Promise<{ success: boolean; error?: string }> {
    try {
        const actor = await getActorContext();
        if (!actor?.companyId) {
            return { success: false, error: 'Chưa xác định tổ chức làm việc.' };
        }

        await requireCompanyRole(actor.companyId, [
            APPLICATION_ROLES.BOSS_ADMIN,
            APPLICATION_ROLES.SALE,
        ]);

        await reopenWarrantyTicket(actor.companyId, input);
        return { success: true };
    } catch (err: unknown) {
        const error = err as Error;
        return { success: false, error: error.message || 'Lỗi mở lại phiếu bảo hành.' };
    }
}