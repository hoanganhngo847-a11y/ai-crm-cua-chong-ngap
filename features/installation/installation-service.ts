import 'server-only';
import { createAdminClient } from '../../lib/supabase/admin';
import type {
    CompleteInstallationInput,
    InstallationDTO,
    InstallationStatus,
    ScheduleInstallationInput,
} from './types';

/**
 * Phát tín hiệu hoàn tất đơn hàng cho phân hệ Tài chính/Đơn hàng (Thành viên 7).
 * Cập nhật orders.order_status = 'COMPLETED' và ghi nhận log sự kiện rõ ràng.
 * TUYỆT ĐỐI KHÔNG tự sửa số tiền thu (collected_amount) hay doanh thu hoàn thành (completed_revenue)
 * tuân thủ quy tắc Tab 03: Thành viên 7 là nơi duy nhất kết chuyển completed_revenue.
 */
export async function dispatchOrderCompletionEvent(
    companyId: string,
    orderId: string,
    overrideAdminClient?: any
): Promise<void> {
    const admin = overrideAdminClient || createAdminClient();
    const completedAt = new Date().toISOString();

    const { error: updateOrderErr } = await admin
        .from('orders')
        .update({
            order_status: 'COMPLETED',
            updated_at: completedAt,
        })
        .eq('company_id', companyId)
        .eq('id', orderId);

    if (updateOrderErr) {
        throw new Error(`Cập nhật trạng thái đơn hàng thất bại: ${updateOrderErr.message}`);
    }

    console.log(
        `[EVENT:ORDER_COMPLETED] Đơn hàng ${orderId} thuộc công ty ${companyId} đã hoàn tất nghiệm thu và bàn giao lúc ${completedAt}. Phát tín hiệu sang Thành viên 7 ghi nhận doanh thu.`
    );
}

/**
 * 1. Lên lịch lắp đặt (Việc 30)
 * Điều kiện: Sản phẩm từ xưởng đã sẵn sàng chuyển đi (READY_FOR_DISPATCH).
 */
export async function scheduleInstallation(
    companyId: string,
    input: ScheduleInstallationInput,
    overrideAdminClient?: any
): Promise<InstallationDTO> {
    const admin = overrideAdminClient || createAdminClient();

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
    status: InstallationStatus,
    overrideAdminClient?: any
): Promise<void> {
    const admin = overrideAdminClient || createAdminClient();

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
 * Khắc phục lỗi kẹt trạng thái đơn hàng (Resilient Idempotency):
 * - Truy vấn đồng thời cả installations và orders.
 * - Thoát sớm nếu cả installRecord và order đều COMPLETED.
 * - Nếu installRecord đã COMPLETED nhưng order bị kẹt trạng thái cũ (do sự cố mạng trước đó),
 *   hệ thống tự động tiếp tục chạy bù cập nhật order.order_status = 'COMPLETED'.
 * - Kích hoạt dispatchOrderCompletionEvent để chuyển trạng thái đơn hàng sang COMPLETED.
 */
export async function completeInstallationAndHandover(
    companyId: string,
    input: CompleteInstallationInput,
    overrideAdminClient?: any
): Promise<void> {
    const admin = overrideAdminClient || createAdminClient();

    if (!input.photos || input.photos.length === 0) {
        throw new Error('Nghiệm thu bắt buộc phải có ảnh chụp hiện trường đã lắp đặt.');
    }

    if (!input.handoverRef || input.handoverRef.trim() === '') {
        throw new Error('Nghiệm thu bắt buộc phải đính kèm file biên bản bàn giao có chữ ký khách hàng.');
    }

    // Truy vấn thông tin lắp đặt
    const { data: installRecord, error: findInstallErr } = await admin
        .from('installations')
        .select('id, order_id, status')
        .eq('company_id', companyId)
        .eq('id', input.installationId)
        .maybeSingle();

    if (findInstallErr || !installRecord) {
        throw new Error('Không tìm thấy thông tin lắp đặt.');
    }

    // Truy vấn thông tin đơn hàng tương ứng
    const { data: order, error: findOrderErr } = await admin
        .from('orders')
        .select('id, order_status')
        .eq('company_id', companyId)
        .eq('id', installRecord.order_id)
        .maybeSingle();

    if (findOrderErr || !order) {
        throw new Error('Không tìm thấy thông tin đơn hàng tương ứng với lắp đặt.');
    }

    // Điều kiện thoát sớm: Nếu cả cài đặt và đơn hàng đều đã COMPLETED thì hoàn tất trọn vẹn (Idempotent)
    if (installRecord.status === 'COMPLETED' && order.order_status === 'COMPLETED') {
        return;
    }

    const completedAt = new Date().toISOString();

    // Nếu cài đặt chưa hoàn tất, cập nhật bản ghi lắp đặt
    if (installRecord.status !== 'COMPLETED') {
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
    }

    // Nếu order chưa COMPLETED (kể cả khi installRecord đã COMPLETED do lỗi mạng ở lần chạy trước),
    // hệ thống tiếp tục chạy bù bước hoàn tất đơn hàng qua dispatchOrderCompletionEvent
    if (order.order_status !== 'COMPLETED') {
        await dispatchOrderCompletionEvent(companyId, installRecord.order_id, admin);
    }
}