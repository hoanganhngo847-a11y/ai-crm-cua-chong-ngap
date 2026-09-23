'use server';

import { z } from 'zod';
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

// ==============================================================================
// RUNTIME VALIDATION SCHEMAS (ZOD - P1)
// ==============================================================================
const createWarrantyTicketSchema = z.object({
    customerId: z.string().min(1, 'Mã khách hàng (customerId) là bắt buộc.'),
    orderId: z.string().min(1, 'Mã đơn hàng (orderId) là bắt buộc.'),
    installationId: z.string().nullable().optional(),
    issue: z.string().min(1, 'Mô tả vấn đề bảo hành là bắt buộc.'),
    notes: z.string().nullable().optional(),
});

const assignWarrantyTicketSchema = z.object({
    ticketId: z.string().min(1, 'Mã phiếu bảo hành (ticketId) là bắt buộc.'),
    technicianId: z.string().min(1, 'Mã kỹ thuật viên (technicianId) là bắt buộc.'),
});

const updateWarrantyStatusSchema = z.object({
    ticketId: z.string().min(1, 'Mã phiếu bảo hành (ticketId) là bắt buộc.'),
    status: z.enum([
        'OPEN',
        'ASSIGNED',
        'IN_PROGRESS',
        'RESOLVED',
        'CLOSED',
        'REOPENED',
        'CANCELLED',
        'FAILED',
    ], {
        message: 'Trạng thái bảo hành không hợp lệ.',
    }),
    notes: z.string().optional(),
});

const reopenWarrantyTicketSchema = z.object({
    ticketId: z.string().min(1, 'Mã phiếu bảo hành (ticketId) là bắt buộc.'),
    reason: z.string().min(1, 'Lý do mở lại phiếu bảo hành là bắt buộc.'),
});

function sanitizeErrorMessage(err: unknown, defaultMsg: string): string {
    if (err instanceof AuthError) {
        throw err;
    }
    const error = err as Error;
    const msg = error.message || defaultMsg;
    if (msg.includes('relation "') || msg.includes('syntax error') || msg.includes('pg_') || msg.includes('connection refused')) {
        return 'Lỗi thao tác cơ sở dữ liệu. Vui lòng thử lại sau.';
    }
    return msg;
}

/**
 * Action: Mở phiếu bảo hành mới (Chỉ cho phép BOSS_ADMIN và SALE tiếp nhận mở ticket - P0)
 */
export async function createWarrantyTicketAction(
    input: CreateWarrantyTicketInput
): Promise<{ success: boolean; data?: WarrantyTicketDTO; error?: string }> {
    try {
        const parsed = createWarrantyTicketSchema.safeParse(input);
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

        await requireCompanyRole(actor.companyId, [
            APPLICATION_ROLES.BOSS_ADMIN,
            APPLICATION_ROLES.SALE,
        ]);

        const data = await createWarrantyTicket(actor.companyId, parsed.data);
        return { success: true, data };
    } catch (err: unknown) {
        return { success: false, error: sanitizeErrorMessage(err, 'Lỗi tạo phiếu bảo hành.') };
    }
}

/**
 * Action: Phân công Kỹ thuật viên bảo hành
 */
export async function assignWarrantyTicketAction(
    input: AssignWarrantyTicketInput
): Promise<{ success: boolean; error?: string }> {
    try {
        const parsed = assignWarrantyTicketSchema.safeParse(input);
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

        await requireCompanyRole(actor.companyId, [APPLICATION_ROLES.BOSS_ADMIN]);

        await assignWarrantyTicket(actor.companyId, parsed.data);
        return { success: true };
    } catch (err: unknown) {
        return { success: false, error: sanitizeErrorMessage(err, 'Lỗi phân công kỹ thuật viên.') };
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
        const parsed = updateWarrantyStatusSchema.safeParse(input);
        if (!parsed.success) {
            return {
                success: false,
                error: `Dữ liệu không hợp lệ: ${parsed.error.issues.map((e) => e.message).join(', ')}`,
            };
        }

        const actor = await getActorContext();
        if (!actor?.companyId || !actor?.userId) {
            return { success: false, error: 'Chưa xác định tổ chức làm việc.' };
        }

        await requireCompanyRole(actor.companyId, [
            APPLICATION_ROLES.BOSS_ADMIN,
            APPLICATION_ROLES.TECHNICIAN,
        ]);

        await updateWarrantyStatus(actor.companyId, parsed.data, undefined, actor);
        return { success: true };
    } catch (err: unknown) {
        return { success: false, error: sanitizeErrorMessage(err, 'Lỗi cập nhật bảo hành.') };
    }
}

/**
 * Action: Tái mở phiếu bảo hành
 */
export async function reopenWarrantyTicketAction(
    input: ReopenWarrantyTicketInput
): Promise<{ success: boolean; error?: string }> {
    try {
        const parsed = reopenWarrantyTicketSchema.safeParse(input);
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

        await requireCompanyRole(actor.companyId, [
            APPLICATION_ROLES.BOSS_ADMIN,
            APPLICATION_ROLES.SALE,
        ]);

        await reopenWarrantyTicket(actor.companyId, parsed.data);
        return { success: true };
    } catch (err: unknown) {
        return { success: false, error: sanitizeErrorMessage(err, 'Lỗi mở lại phiếu bảo hành.') };
    }
}