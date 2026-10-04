'use server';

import { z } from 'zod';
import { prepareEvidence } from './evidence';
import { sanitizeErrorMessage, OperationsError } from '../operations/server';
import { getActorContext, requireCompanyRole } from '../../lib/auth/context';
import { createAdminClient } from '../../lib/supabase/admin';
import { APPLICATION_ROLES } from '../../shared/constants/roles';
import {
    acceptInstallationAppointment,
    attachInstallationEvidence,
    completeInstallationAndHandover,
    createInstallationSchedule,
    startInstallationWork,
    updateInstallationStatus,
    verifyStorageObjectExists,
    verifyTechnicianInstallationAssignment,
} from './installation-service';
import type {
    CompleteInstallationInput,
    CreateInstallationScheduleInput,
    CreateInstallationScheduleResult,
    SettableInstallationStatus,
} from './types';

// ==============================================================================
// RUNTIME VALIDATION SCHEMAS (ZOD - P1)
// ==============================================================================
const createInstallationScheduleSchema = z.object({
    orderId: z.string().uuid({ message: 'Mã đơn hàng không hợp lệ.' }),
    technicianId: z.string().uuid({ message: 'Mã kỹ thuật viên không hợp lệ.' }),
    startTime: z.string().datetime({ message: 'Thời gian bắt đầu lắp đặt không hợp lệ.' }),
    address: z.string().min(1, 'Địa chỉ lắp đặt không được để trống.'),
    crew: z.array(z.string()).min(1, 'Danh sách đội thợ (crew) phải có ít nhất 1 người.'),
});

const acceptInstallationAppointmentSchema = z.object({
    appointmentId: z.string().uuid({ message: 'Mã lịch hẹn không hợp lệ.' }),
});

const startInstallationWorkSchema = z.object({
    installationId: z.string().uuid({ message: 'Mã công việc lắp đặt không hợp lệ.' }),
});

const updateInstallationStatusSchema = z.object({
    installationId: z.string().uuid(),
    status: z.enum([
        'SCHEDULED',
        'IN_TRANSIT',
        'INSTALLING',
        'TESTING',
        'HANDOVER_PENDING',
        'FAILED',
    ], {
        message: 'Trạng thái lắp đặt không hợp lệ hoặc không được phép cập nhật trực tiếp.',
    }),
});

const completeInstallationSchema = z.object({
    installationId: z.string().uuid(),
});

/**
 * Action: Lên lịch lắp đặt nguyên tử (Blocker 1 & 2)
 * - BOSS_ADMIN chỉ định kỹ thuật viên, thời gian, địa chỉ, đội thợ.
 * - Server tạo đồng thời Appointment (ASSIGNED) và Installation (SCHEDULED) trong 1 transaction.
 */
export async function createInstallationScheduleAction(
    input: CreateInstallationScheduleInput
): Promise<{ success: boolean; data?: CreateInstallationScheduleResult; error?: string }> {
    try {
        const parsed = createInstallationScheduleSchema.safeParse(input);
        if (!parsed.success) {
            return {
                success: false,
                error: `Dữ liệu không hợp lệ: ${parsed.error.issues.map((e) => e.message).join(', ')}`,
            };
        }

        const actor = await getActorContext();
        if (!actor?.companyId || !actor?.userId) {
            return { success: false, error: 'Chưa xác định tổ chức làm việc hoặc danh tính.' };
        }

        await requireCompanyRole(actor.companyId, [APPLICATION_ROLES.BOSS_ADMIN]);

        const data = await createInstallationSchedule(actor.companyId, parsed.data, undefined, actor.userId);
        return { success: true, data };
    } catch (err: unknown) {
        return { success: false, error: sanitizeErrorMessage(err, 'Lỗi đặt lịch lắp đặt.') };
    }
}

/**
 * Action: Kỹ thuật viên nhận việc lắp đặt (Blocker 3)
 * - Server chuyển trạng thái lịch hẹn: ASSIGNED -> ACCEPTED.
 * - Chỉ kỹ thuật viên được phân công chính xác mới có quyền nhận việc.
 */
export async function acceptInstallationAppointmentAction(
    input: { appointmentId: string }
): Promise<{ success: boolean; idempotent?: boolean; error?: string }> {
    try {
        const parsed = acceptInstallationAppointmentSchema.safeParse(input);
        if (!parsed.success) {
            return {
                success: false,
                error: `Dữ liệu không hợp lệ: ${parsed.error.issues.map((e) => e.message).join(', ')}`,
            };
        }

        const actor = await getActorContext();
        if (!actor?.companyId || !actor?.userId) {
            return { success: false, error: 'Chưa xác định tổ chức làm việc hoặc danh tính.' };
        }

        await requireCompanyRole(actor.companyId, [APPLICATION_ROLES.TECHNICIAN]);

        const result = await acceptInstallationAppointment(actor.companyId, parsed.data.appointmentId, undefined, actor);
        return { success: true, idempotent: result.idempotent };
    } catch (err: unknown) {
        return { success: false, error: sanitizeErrorMessage(err, 'Lỗi nhận việc lắp đặt.') };
    }
}

/**
 * Action: Bắt đầu công việc lắp đặt
 * - Server chuyển trạng thái lịch hẹn: ACCEPTED -> IN_PROGRESS.
 */
export async function startInstallationWorkAction(
    input: { installationId: string }
): Promise<{ success: boolean; idempotent?: boolean; error?: string }> {
    try {
        const parsed = startInstallationWorkSchema.safeParse(input);
        if (!parsed.success) {
            return {
                success: false,
                error: `Dữ liệu không hợp lệ: ${parsed.error.issues.map((e) => e.message).join(', ')}`,
            };
        }

        const actor = await getActorContext();
        if (!actor?.companyId || !actor?.userId) {
            return { success: false, error: 'Chưa xác định tổ chức làm việc hoặc danh tính.' };
        }

        await requireCompanyRole(actor.companyId, [APPLICATION_ROLES.TECHNICIAN]);

        const result = await startInstallationWork(actor.companyId, parsed.data.installationId, undefined, actor);
        return { success: true, idempotent: result.idempotent };
    } catch (err: unknown) {
        return { success: false, error: sanitizeErrorMessage(err, 'Lỗi bắt đầu công việc lắp đặt.') };
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
        const parsed = updateInstallationStatusSchema.safeParse({ installationId, status });
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

        if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
            await verifyTechnicianInstallationAssignment(actor.companyId, actor.userId, installationId);
        }

        await updateInstallationStatus(
            actor.companyId,
            parsed.data.installationId,
            parsed.data.status as SettableInstallationStatus,
            undefined,
            actor
        );
        return { success: true };
    } catch (err: unknown) {
        return { success: false, error: sanitizeErrorMessage(err, 'Lỗi cập nhật lắp đặt.') };
    }
}

/**
 * Action: Tải lên và đính kèm tài liệu nghiệm thu ủy quyền máy chủ (Server-Authorized Upload Flow - P0)
 * - Nhận file thực tế từ FormData cùng installationId và evidenceType ('PHOTO' | 'HANDOVER').
 * - Kiểm tra quyền TECHNICIAN được phân công (hoặc BOSS_ADMIN).
 * - Server generates a typed canonical object path after MIME/extension validation.
 * - Server dùng adminClient.storage.from('installation-docs').upload() để lưu file an toàn.
 * - Xác minh object tồn tại trong Storage trước khi ghi nhận path vào database.
 * - Tuyệt đối không cho phép client truyền chuỗi fileKey tùy ý.
 */
export async function uploadInstallationEvidenceAction(
    formData: FormData
): Promise<{ success: boolean; fileKey?: string; error?: string }> {
    try {
        const actor = await getActorContext();
        if (!actor?.companyId || !actor?.userId) {
            return { success: false, error: 'Chưa xác định danh tính hoặc tổ chức làm việc.' };
        }

        await requireCompanyRole(actor.companyId, [
            APPLICATION_ROLES.BOSS_ADMIN,
            APPLICATION_ROLES.TECHNICIAN,
        ]);

        const installationId = formData.get('installationId') as string;
        const rawEvidenceType = formData.get('evidenceType') as string;
        const file = formData.get('file') as File | null;

        const evidence = prepareEvidence(actor.companyId, installationId, rawEvidenceType || '', file!);
        const admin = createAdminClient();
        if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
            await verifyTechnicianInstallationAssignment(actor.companyId, actor.userId, installationId, admin);
        } else {
            const { data: inst } = await admin
                .from('installations')
                .select('appointment_id')
                .eq('company_id', actor.companyId)
                .eq('id', installationId)
                .maybeSingle();
            if (!inst) throw new OperationsError('RESOURCE_NOT_FOUND');
            const { data: appt } = await admin
                .from('appointments')
                .select('status')
                .eq('company_id', actor.companyId)
                .eq('id', inst.appointment_id)
                .maybeSingle();
            if (!appt || !['ACCEPTED', 'IN_PROGRESS'].includes(appt.status)) {
                throw new OperationsError('INVALID_STATE_TRANSITION');
            }
        }
        const canonicalPath = evidence.path;

        // Đọc nội dung tệp sang buffer
        const arrayBuffer = await file!.arrayBuffer();
        const fileBuffer = Buffer.from(arrayBuffer);

        // Upload lên Supabase Storage bucket 'installation-docs'
        const { error: uploadError } = await admin.storage
            .from('installation-docs')
            .upload(canonicalPath, fileBuffer, {
                contentType: evidence.contentType,
                upsert: false,
            });

        if (uploadError) {
            return {
                success: false,
                error: 'Tải tệp lên hệ thống lưu trữ thất bại.',
            };
        }

        // Xác minh object tồn tại trong Storage trước khi ghi nhận path vào database (P0)
        const exists = await verifyStorageObjectExists(admin, 'installation-docs', canonicalPath);
        if (!exists) {
            return {
                success: false,
                error: 'Xác minh tệp trong hệ thống lưu trữ thất bại sau khi upload.',
            };
        }

        // Ghi nhận canonical path vào cơ sở dữ liệu
        await attachInstallationEvidence(
            actor.companyId,
            {
                installationId,
                fileKey: canonicalPath,
                type: evidence.type,
            },
            admin,
            actor
        );

        return { success: true, fileKey: canonicalPath };
    } catch (err: unknown) {
        return { success: false, error: sanitizeErrorMessage(err, 'Lỗi tải lên tài liệu nghiệm thu.') };
    }
}

/**
 * Action: Nghiệm thu & hoàn tất bàn giao (Việc 31)
 * - Nếu caller là TECHNICIAN: bắt buộc kiểm tra appointments liên kết (P0).
 */
export async function completeInstallationAction(
    input: CompleteInstallationInput
): Promise<{ success: boolean; error?: string }> {
    try {
        const parsed = completeInstallationSchema.safeParse(input);
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

        if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
            await verifyTechnicianInstallationAssignment(actor.companyId, actor.userId, parsed.data.installationId);
        }

        await completeInstallationAndHandover(actor.companyId, parsed.data, undefined, actor);
        return { success: true };
    } catch (err: unknown) {
        return { success: false, error: sanitizeErrorMessage(err, 'Lỗi nghiệm thu bàn giao.') };
    }
}