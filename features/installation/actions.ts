'use server';

import { z } from 'zod';
import { prepareEvidence } from './evidence';
import { sanitizeErrorMessage } from '../operations/server';
import { getActorContext, requireCompanyRole } from '../../lib/auth/context';
import { createAdminClient } from '../../lib/supabase/admin';
import { APPLICATION_ROLES } from '../../shared/constants/roles';
import {
    attachInstallationEvidence,
    completeInstallationAndHandover,
    scheduleInstallation,
    updateInstallationStatus,
    verifyStorageObjectExists,
    verifyTechnicianInstallationAssignment,
} from './installation-service';
import type {
    CompleteInstallationInput,
    InstallationDTO,
    ScheduleInstallationInput,
    SettableInstallationStatus,
} from './types';

// ==============================================================================
// RUNTIME VALIDATION SCHEMAS (ZOD - P1)
// ==============================================================================
const scheduleInstallationSchema = z.object({
    customerId: z.uuid(),
    orderId: z.uuid(),
    appointmentId: z.uuid(),
    crew: z.array(z.string()).min(1, 'Danh sách đội thợ (crew) phải có ít nhất 1 người.'),
});

const updateInstallationStatusSchema = z.object({
    installationId: z.uuid(),
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
    installationId: z.uuid(),
});

/**
 * Action: Lên lịch lắp đặt (Việc 30)
 */
export async function scheduleInstallationAction(
    input: ScheduleInstallationInput
): Promise<{ success: boolean; data?: InstallationDTO; error?: string }> {
    try {
        const parsed = scheduleInstallationSchema.safeParse(input);
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

        const data = await scheduleInstallation(actor.companyId, parsed.data, undefined, actor.userId);
        return { success: true, data };
    } catch (err: unknown) {
        return { success: false, error: sanitizeErrorMessage(err, 'Lỗi đặt lịch lắp đặt.') };
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
        if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
            await verifyTechnicianInstallationAssignment(actor.companyId, actor.userId, installationId);
        }
        const canonicalPath = evidence.path;
        const admin = createAdminClient();

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