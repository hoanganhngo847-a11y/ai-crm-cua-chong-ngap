import 'server-only';
import { createAdminClient } from '../../lib/supabase/admin';
import type {
    CompleteInstallationInput,
    InstallationDTO,
    InstallationStatus,
    ScheduleInstallationInput,
} from './types';

/**
 * 1. Lên lịch lắp đặt (Việc 30)
 * Điều kiện: Sản phẩm từ xưởng đã sẵn sàng chuyển đi (READY_FOR_DISPATCH).
 */
export async function scheduleInstallation(
    companyId: string,
    input: ScheduleInstallationInput
): Promise<InstallationDTO> {
    const admin = createAdminClient();

    // Kiểm tra lệnh xưởng tương ứng
    const { data: prodOrder, error: prodErr } = await admin
        .from('production_orders')
        .select('id, status')
        .eq('company_id', companyId)
        .eq('order_id', input.orderId)
        .maybeSingle();

    if (prodErr || !prodOrder) {
        throw new Error('Không tìm thấy lệnh sản xuất của đơn hàng.');
    }

    if (prodOrder.status !== 'READY_FOR_DISPATCH') {
        throw new Error('Sản phẩm chưa hoàn tất sản xuất/QC đạt để bàn giao lịch lắp đặt.');
    }

    const { data: installation, error: insertErr } = await admin
        .from('installations')
        .insert({
            company_id: companyId,
            customer_id: input.customerId,
            order_id: input.orderId,
            appointment_id: input.appointmentId,
            crew: input.crew,
            status: 'SCHEDULED' as InstallationStatus,
            photos: [],
            handover_ref: null,
        })
        .select()
        .single();

    if (insertErr || !installation) {
        throw new Error(`Tạo lịch lắp đặt thất bại: ${insertErr?.message}`);
    }

    return {
        id: installation.id,
        companyId: installation.company_id,
        customerId: installation.customer_id,
        orderId: installation.order_id,
        appointmentId: installation.appointment_id,
        crew: installation.crew as string[],
        status: installation.status as InstallationStatus,
        photos: installation.photos as string[],
        handoverRef: installation.handover_ref,
        completedAt: installation.completed_at,
        createdAt: installation.created_at,
        updatedAt: installation.updated_at,
    };
}

/**
 * 2. Cập nhật tiến độ lắp đặt hiện trường
 */
export async function updateInstallationStatus(
    companyId: string,
    installationId: string,
    status: InstallationStatus
): Promise<void> {
    const admin = createAdminClient();

    const { error } = await admin
        .from('installations')
        .update({
            status,
            updated_at: new Date().toISOString(),
        })
        .eq('company_id', companyId)
        .eq('id', installationId);

    if (error) {
        throw new Error(`Cập nhật trạng thái lắp đặt thất bại: ${error.message}`);
    }
}

/**
 * 3. Hoàn tất bàn giao & nghiệm thu (Việc 31)
 * Ràng buộc: Bắt buộc có ảnh nghiệm thu (photos) và biên bản ký (handover_ref).
 * Tự động chuyển đơn sang COMPLETED và kích hoạt ghi nhận doanh thu hoàn thành (idempotent).
 */
export async function completeInstallationAndHandover(
    companyId: string,
    input: CompleteInstallationInput
): Promise<void> {
    const admin = createAdminClient();

    if (!input.photos || input.photos.length === 0) {
        throw new Error('Nghiệm thu bắt buộc phải có ảnh chụp hiện trường đã lắp đặt.');
    }

    if (!input.handoverRef || input.handoverRef.trim() === '') {
        throw new Error('Nghiệm thu bắt buộc phải đính kèm file biên bản bàn giao có chữ ký khách hàng.');
    }

    const { data: installRecord, error: findErr } = await admin
        .from('installations')
        .select('id, order_id, status')
        .eq('company_id', companyId)
        .eq('id', input.installationId)
        .single();

    if (findErr || !installRecord) {
        throw new Error('Không tìm thấy thông tin lắp đặt.');
    }

    // Đảm bảo tính idempotent: Không kích hoạt hoàn thành nhiều lần
    if (installRecord.status === 'COMPLETED') {
        return;
    }

    const completedAt = new Date().toISOString();

    // Cập nhật bản ghi lắp đặt
    const { error: updateInstallErr } = await admin
        .from('installations')
        .update({
            status: 'COMPLETED' as InstallationStatus,
            photos: input.photos,
            handover_ref: input.handoverRef,
            completed_at: completedAt,
            updated_at: completedAt,
        })
        .eq('company_id', companyId)
        .eq('id', input.installationId);

    if (updateInstallErr) {
        throw new Error(`Cập nhật bàn giao thất bại: ${updateInstallErr.message}`);
    }

    // Cập nhật đơn hàng thành công (COMPLETED)
    const { error: updateOrderErr } = await admin
        .from('orders')
        .update({
            order_status: 'COMPLETED',
            updated_at: completedAt,
        })
        .eq('company_id', companyId)
        .eq('id', installRecord.order_id);

    if (updateOrderErr) {
        throw new Error(`Cập nhật trạng thái đơn hàng thất bại: ${updateOrderErr.message}`);
    }
}