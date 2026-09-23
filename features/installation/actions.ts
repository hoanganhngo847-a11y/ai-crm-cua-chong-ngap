'use server';

import { z } from 'zod';
import { AuthError, getActorContext, requireCompanyRole } from '../../lib/auth/context';
import { createAdminClient } from '../../lib/supabase/admin';
import { APPLICATION_ROLES } from '../../shared/constants/roles';
import {
    attachInstallationEvidence,
    completeInstallationAndHandover,
    isValidCanonicalInstallationStorageRef,
    scheduleInstallation,
    updateInstallationStatus,
    verifyStorageObjectExists,
    verifyTechnicianInstallationAssignment,
} from './installation-service';
import type {
    AttachInstallationEvidenceInput,
    CompleteInstallationInput,
    InstallationDTO,
    ScheduleInstallationInput,
    SettableInstallationStatus,
} from './types';

// ==============================================================================
// RUNTIME VALIDATION SCHEMAS (ZOD - P1)
// ==============================================================================
const scheduleInstallationSchema = z.object({
    customerId: z.string().min(1, 'Mã khách hàng (customerId) là bắt buộc.'),
    orderId: z.string().min(1, 'Mã đơn hàng (orderId) là bắt buộc.'),
    appointmentId: z.string().min(1, 'Mã lịch hẹn (appointmentId) là bắt buộc.'),
    crew: z.array(z.string()).min(1, 'Danh sách đội thợ (crew) phải có ít nhất 1 người.'),
});

const updateInstallationStatusSchema = z.object({
    installationId: z.string().min(1, 'Mã lắp đặt (installationId) là bắt buộc.'),
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
    installationId: z.string().min(1, 'Mã lắp đặt (installationId) là bắt buộc.'),
});

const attachInstallationEvidenceSchema = z.object({
    installationId: z.string().min(1, 'Mã lắp đặt (installationId) là bắt buộc.'),
    fileKey: z.string().min(1, 'Đường dẫn fileKey là bắt buộc.'),
    type: z.enum(['photo', 'handover', 'PHOTO', 'HANDOVER'], {
        message: 'Loại bằng chứng chỉ chấp nhận photo hoặc handover.',
    }),
});

function sanitizeErrorMessage(err: unknown, defaultMsg: string): string {
    if (err instanceof AuthError) {
        throw err;
    }
    const error = err as Error;
    const msg = error.message || defaultMsg;
    if (
        msg.includes('relation "') ||
        msg.includes('syntax error') ||
        msg.includes('pg_') ||
        msg.includes('connection refused')
    ) {
        return 'Lỗi thao tác cơ sở dữ liệu. Vui lòng thử lại sau.';
    }
    return msg;
}

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

        const data = await scheduleInstallation(actor.companyId, parsed.data);
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
 * - Server TỰ ĐỘNG sinh canonical path chuẩn hóa: `${companyId}/installations/${installationId}/${evidenceType.toLowerCase()}_${Date.now()}_${crypto.randomUUID()}.${ext}`.
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

        if (!installationId || typeof installationId !== 'string' || installationId.trim() === '') {
            return { success: false, error: 'Mã lắp đặt (installationId) là bắt buộc.' };
        }

        const normalizedType = rawEvidenceType?.trim().toUpperCase();
        if (normalizedType !== 'PHOTO' && normalizedType !== 'HANDOVER') {
            return {
                success: false,
                error: `Loại bằng chứng không hợp lệ '${rawEvidenceType}'. Chỉ chấp nhận 'PHOTO' hoặc 'HANDOVER'.`,
            };
        }

        if (!file || typeof file.size !== 'number' || file.size === 0) {
            return { success: false, error: 'Tệp chứng từ tải lên không hợp lệ hoặc có dung lượng 0 bytes.' };
        }

        // Kiểm tra phân công Kỹ thuật viên (assignee)
        if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
            await verifyTechnicianInstallationAssignment(actor.companyId, actor.userId, installationId);
        }

        // Server TỰ ĐỘNG sinh canonical path chuẩn hóa (P0)
        const fileExt = file.name && file.name.includes('.')
            ? file.name.split('.').pop()!.toLowerCase().replace(/[^a-z0-9]/g, '')
            : normalizedType === 'PHOTO' ? 'jpg' : 'pdf';
        const safeExt = fileExt || (normalizedType === 'PHOTO' ? 'jpg' : 'pdf');

        const canonicalPath = `${actor.companyId}/installations/${installationId}/${normalizedType.toLowerCase()}_${Date.now()}_${crypto.randomUUID()}.${safeExt}`;

        const admin = createAdminClient();

        // Đọc nội dung tệp sang buffer
        const arrayBuffer = await file.arrayBuffer();
        const fileBuffer = Buffer.from(arrayBuffer);

        // Upload lên Supabase Storage bucket 'installation-docs'
        const { error: uploadError } = await admin.storage
            .from('installation-docs')
            .upload(canonicalPath, fileBuffer, {
                contentType: file.type || 'application/octet-stream',
                upsert: false,
            });

        if (uploadError) {
            return {
                success: false,
                error: `Tải tệp lên hệ thống lưu trữ thất bại: ${uploadError.message}`,
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
                type: normalizedType.toLowerCase() as 'photo' | 'handover',
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
 * Action: Đính kèm tài liệu nghiệm thu (Khóa chặn fileKey tùy ý - P0)
 * Bắt buộc kiểm tra fileKey phải tuân thủ nghiêm ngặt canonical structure của installation và tồn tại trong bucket.
 */
export async function attachInstallationEvidenceAction(
    input: AttachInstallationEvidenceInput
): Promise<{ success: boolean; error?: string }> {
    try {
        const parsed = attachInstallationEvidenceSchema.safeParse(input);
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

        // Khóa triệt để client truyền chuỗi fileKey tùy ý (P0)
        if (!isValidCanonicalInstallationStorageRef(actor.companyId, parsed.data.installationId, parsed.data.fileKey)) {
            return {
                success: false,
                error: `INVALID_STORAGE_REF: Không cho phép client truyền fileKey tùy ý. Bắt buộc phải thuộc cấu trúc '${actor.companyId}/installations/${parsed.data.installationId}/' và tải lên qua Server Action.`,
            };
        }

        if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
            await verifyTechnicianInstallationAssignment(actor.companyId, actor.userId, parsed.data.installationId);
        }

        const admin = createAdminClient();

        // Xác minh object thực sự tồn tại trong bucket
        const exists = await verifyStorageObjectExists(admin, 'installation-docs', parsed.data.fileKey);
        if (!exists) {
            return {
                success: false,
                error: `STORAGE_OBJECT_NOT_FOUND: Tệp bằng chứng "${parsed.data.fileKey}" không tồn tại trong Storage bucket.`,
            };
        }

        await attachInstallationEvidence(
            actor.companyId,
            {
                installationId: parsed.data.installationId,
                fileKey: parsed.data.fileKey,
                type: parsed.data.type.toLowerCase() as 'photo' | 'handover',
            },
            admin,
            actor
        );
        return { success: true };
    } catch (err: unknown) {
        return { success: false, error: sanitizeErrorMessage(err, 'Lỗi đính kèm tài liệu nghiệm thu.') };
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