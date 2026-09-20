import 'server-only';
import { AuthError } from '../../lib/auth/context';
import { createAdminClient } from '../../lib/supabase/admin';
import type {
    AttachInstallationEvidenceInput,
    CompleteInstallationInput,
    InstallationDTO,
    InstallationStatus,
    ScheduleInstallationInput,
    SettableInstallationStatus,
} from './types';

/**
 * Kiểm tra Storage Reference hợp lệ (P0)
 * Bắt buộc phải có tiền tố đường dẫn hệ thống hợp lệ ('installation-docs/') hoặc URL hợp lệ của hệ thống,
 * tuyệt đối không chấp nhận chuỗi rác hay URL ngoài.
 */
export function isValidInstallationStorageRef(ref: string): boolean {
    if (!ref || typeof ref !== 'string') return false;
    const trimmed = ref.trim();
    if (!trimmed) return false;

    // 1. Tiền tố đường dẫn lưu trữ hợp lệ của hệ thống
    if (trimmed.startsWith('installation-docs/')) {
        return true;
    }

    // 2. Kiểm tra URL hợp lệ của hệ thống
    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return false;
        }
        // Các máy chủ cục bộ / nội bộ đáng tin cậy
        const trustedHosts = ['localhost', '127.0.0.1', 'storage.local'];
        if (trustedHosts.includes(parsed.hostname)) {
            return true;
        }
        // Supabase project storage chứa installation-docs
        if (parsed.hostname.endsWith('.supabase.co') && parsed.pathname.includes('installation-docs')) {
            return true;
        }
        // Nếu cấu hình NEXT_PUBLIC_SUPABASE_URL
        if (process.env.NEXT_PUBLIC_SUPABASE_URL) {
            try {
                const supabaseUrl = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL);
                if (parsed.hostname === supabaseUrl.hostname && parsed.pathname.includes('installation-docs')) {
                    return true;
                }
            } catch {
                // ignore
            }
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * Xác thực Kỹ thuật viên được phân công trên lịch hẹn liên kết (P0)
 */
export async function verifyTechnicianInstallationAssignment(
    companyId: string,
    userId: string,
    installationId: string,
    overrideAdminClient?: any
): Promise<void> {
    const admin = overrideAdminClient || createAdminClient();

    const { data: inst, error: instErr } = await admin
        .from('installations')
        .select('id, appointment_id')
        .eq('company_id', companyId)
        .eq('id', installationId)
        .maybeSingle();

    if (instErr || !inst) {
        throw new Error('Không tìm thấy thông tin lắp đặt.');
    }

    const { data: appt, error: apptErr } = await admin
        .from('appointments')
        .select('id, assignee_id, status')
        .eq('company_id', companyId)
        .eq('id', inst.appointment_id)
        .maybeSingle();

    const validStatuses = ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'];
    if (apptErr || !appt || appt.assignee_id !== userId || !validStatuses.includes(appt.status)) {
        throw new AuthError('Bạn không được phân công thực hiện công việc này', 403);
    }
}

/**
 * Chuyển đổi trạng thái hợp lệ của lắp đặt (State Machine - P1)
 */
export const VALID_INSTALLATION_TRANSITIONS: Record<InstallationStatus, SettableInstallationStatus[]> = {
    SCHEDULED: ['IN_TRANSIT', 'INSTALLING', 'FAILED'],
    IN_TRANSIT: ['INSTALLING', 'FAILED'],
    INSTALLING: ['TESTING', 'HANDOVER_PENDING', 'FAILED'],
    TESTING: ['HANDOVER_PENDING', 'INSTALLING', 'FAILED'],
    HANDOVER_PENDING: ['TESTING', 'INSTALLING', 'FAILED'],
    FAILED: ['SCHEDULED', 'IN_TRANSIT', 'INSTALLING'],
    COMPLETED: [],
};

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
 * Điều kiện:
 * - Sản phẩm từ xưởng đã sẵn sàng chuyển đi (READY_FOR_DISPATCH).
 * - Kiểm tra orders.order_status: bắt buộc order_status === 'READY_FOR_INSTALL' và order_status !== 'CANCELLED' (P0).
 */
export async function scheduleInstallation(
    companyId: string,
    input: ScheduleInstallationInput,
    overrideAdminClient?: any
): Promise<InstallationDTO> {
    const admin = overrideAdminClient || createAdminClient();

    // Kiểm tra trạng thái đơn hàng (P0)
    const { data: order, error: orderErr } = await admin
        .from('orders')
        .select('id, order_status')
        .eq('company_id', companyId)
        .eq('id', input.orderId)
        .maybeSingle();

    if (orderErr || !order) {
        throw new Error('Không tìm thấy thông tin đơn hàng để lên lịch lắp đặt.');
    }

    if (order.order_status === 'CANCELLED') {
        throw new Error('Không thể lên lịch lắp đặt cho đơn hàng đã bị hủy (CANCELLED).');
    }

    if (order.order_status !== 'READY_FOR_INSTALL') {
        throw new Error(
            `Đơn hàng chưa sẵn sàng lắp đặt (trạng thái hiện tại: ${order.order_status}). Chỉ cho phép khi trạng thái là 'READY_FOR_INSTALL'.`
        );
    }

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
 * 2. Cập nhật tiến độ lắp đặt hiện trường (P0 & P1)
 * - Chỉ nhận SettableInstallationStatus (Loại bỏ 'COMPLETED').
 * - Trạng thái COMPLETED chỉ được phép thiết lập duy nhất qua completeInstallationAndHandover.
 * - Kiểm tra chuyển đổi trạng thái hợp lệ.
 */
export async function updateInstallationStatus(
    companyId: string,
    installationId: string,
    status: SettableInstallationStatus,
    overrideAdminClient?: any,
    actor?: { userId: string; role?: string | null }
): Promise<void> {
    const admin = overrideAdminClient || createAdminClient();

    // Chặn cửa sau COMPLETED (P0 & P1)
    if ((status as string) === 'COMPLETED') {
        throw new Error(
            "Trạng thái 'COMPLETED' không được phép cập nhật trực tiếp. Chỉ được phép thiết lập duy nhất thông qua hàm completeInstallationAndHandover."
        );
    }

    // Nếu actor là TECHNICIAN, bắt buộc kiểm tra phân công lịch hẹn
    if (actor && actor.role === 'TECHNICIAN') {
        await verifyTechnicianInstallationAssignment(companyId, actor.userId, installationId, admin);
    }

    // Truy vấn trạng thái hiện tại
    const { data: currentInstall, error: fetchErr } = await admin
        .from('installations')
        .select('id, status')
        .eq('company_id', companyId)
        .eq('id', installationId)
        .maybeSingle();

    if (fetchErr || !currentInstall) {
        throw new Error('Không tìm thấy thông tin lắp đặt.');
    }

    const currentStatus = currentInstall.status as InstallationStatus;
    if (currentStatus === 'COMPLETED') {
        throw new Error('Không thể thay đổi trạng thái của đơn lắp đặt đã hoàn tất (COMPLETED).');
    }

    if (currentStatus !== status) {
        const allowedTransitions = VALID_INSTALLATION_TRANSITIONS[currentStatus] || [];
        if (!allowedTransitions.includes(status)) {
            throw new Error(
                `Chuyển đổi trạng thái lắp đặt không hợp lệ từ '${currentStatus}' sang '${status}'.`
            );
        }
    }

    const { data: updated, error } = await admin
        .from('installations')
        .update({
            status,
            updated_at: new Date().toISOString(),
        })
        .eq('company_id', companyId)
        .eq('id', installationId)
        .select('id')
        .single();

    if (error || !updated) {
        throw new Error(`Cập nhật trạng thái lắp đặt thất bại: ${error?.message}`);
    }
}

/**
 * 3. Đính kèm tài liệu nghiệm thu (Ảnh hiện trường / Biên bản bàn giao) (P0)
 * Bắt buộc kiểm tra quyền thợ hiện trường và lưu file reference hợp lệ vào cơ sở dữ liệu.
 */
export async function attachInstallationEvidence(
    companyId: string,
    input: AttachInstallationEvidenceInput,
    overrideAdminClient?: any,
    actor?: { userId: string; role?: string | null }
): Promise<void> {
    const admin = overrideAdminClient || createAdminClient();

    // 1. Kiểm tra Storage Reference hợp lệ (P0)
    if (!isValidInstallationStorageRef(input.fileKey)) {
        throw new Error(
            `INVALID_STORAGE_REF: File key '${input.fileKey}' không hợp lệ. Bắt buộc phải có tiền tố 'installation-docs/' hoặc URL lưu trữ hợp lệ của hệ thống.`
        );
    }

    // 2. Nếu actor là TECHNICIAN, kiểm tra phân công trên lịch hẹn liên kết (P0)
    if (actor && actor.role === 'TECHNICIAN') {
        await verifyTechnicianInstallationAssignment(companyId, actor.userId, input.installationId, admin);
    }

    // 3. Truy vấn bản ghi lắp đặt
    const { data: installRecord, error: fetchErr } = await admin
        .from('installations')
        .select('id, status, photos, handover_ref')
        .eq('company_id', companyId)
        .eq('id', input.installationId)
        .maybeSingle();

    if (fetchErr || !installRecord) {
        throw new Error('RESOURCE_NOT_FOUND: Không tìm thấy thông tin lắp đặt.');
    }

    if (installRecord.status === 'COMPLETED') {
        throw new Error('INVALID_STATE_TRANSITION: Không thể đính kèm tài liệu cho đơn lắp đặt đã hoàn tất (COMPLETED).');
    }

    const timestamp = new Date().toISOString();
    const updatePayload: Record<string, any> = { updated_at: timestamp };

    if (input.type === 'photo') {
        const currentPhotos: string[] = Array.isArray(installRecord.photos) ? [...installRecord.photos] : [];
        if (!currentPhotos.includes(input.fileKey)) {
            currentPhotos.push(input.fileKey);
        }
        updatePayload.photos = currentPhotos;
    } else if (input.type === 'handover') {
        updatePayload.handover_ref = input.fileKey;
    } else {
        throw new Error(`INVALID_INPUT: Loại bằng chứng không hợp lệ '${input.type}'. Chỉ chấp nhận 'photo' hoặc 'handover'.`);
    }

    const { data: updated, error: updateErr } = await admin
        .from('installations')
        .update(updatePayload)
        .eq('company_id', companyId)
        .eq('id', input.installationId)
        .select('id')
        .single();

    if (updateErr || !updated) {
        throw new Error(`INVALID_STATE_TRANSITION: Cập nhật tài liệu nghiệm thu thất bại: ${updateErr?.message || 'Lỗi cơ sở dữ liệu'}`);
    }
}

/**
 * 4. Hoàn tất bàn giao & nghiệm thu (Việc 31)
 * Ràng buộc:
 * - KHẮC PHỤC STORAGE EVIDENCE DO BROWSER TỰ KHAI (P0):
 *   completeInstallationAndHandover KHÔNG NHẬN photos và handoverRef từ client nữa, chỉ nhận { installationId }.
 *   Server tự truy vấn DB đọc photos và handover_ref đã lưu sẵn từ các bước upload thẩm định trước đó.
 *   Fail-closed nếu thiếu bất kỳ bằng chứng nào (!photos || photos.length === 0 || !handover_ref).
 * - KHÓA STATE MACHINE NGHIỆM THU LẮP ĐẶT (P0):
 *   Chỉ cho phép hoàn tất khi installRecord.status === 'HANDOVER_PENDING'.
 *   Kiểm tra linked appointment status ('IN_PROGRESS' | 'ACCEPTED') và order status ('READY_FOR_INSTALL' | 'INSTALLING').
 * - BẢO ĐẢM TÍNH NGUYÊN TỬ (ATOMICITY) & AUDIT TRAIL (P0):
 *   Bọc try/catch có rollback state nếu cập nhật order thất bại.
 *   Audit log ghi nhận fail-closed: nếu ghi audit thất bại, rollback toàn bộ trạng thái.
 */
export async function completeInstallationAndHandover(
    companyId: string,
    input: CompleteInstallationInput,
    overrideAdminClient?: any,
    actor?: { userId: string; role?: string | null }
): Promise<void> {
    const admin = overrideAdminClient || createAdminClient();

    // Nếu actor là TECHNICIAN, kiểm tra phân công trước (P0)
    if (actor && actor.role === 'TECHNICIAN') {
        await verifyTechnicianInstallationAssignment(companyId, actor.userId, input.installationId, admin);
    }

    // Truy vấn thông tin lắp đặt cùng các bằng chứng canonical đã lưu trong DB (P0)
    const { data: installRecord, error: findInstallErr } = await admin
        .from('installations')
        .select('id, order_id, appointment_id, status, photos, handover_ref')
        .eq('company_id', companyId)
        .eq('id', input.installationId)
        .maybeSingle();

    if (findInstallErr || !installRecord) {
        throw new Error('RESOURCE_NOT_FOUND: Không tìm thấy thông tin lắp đặt.');
    }

    // Truy vấn thông tin đơn hàng tương ứng
    const { data: order, error: findOrderErr } = await admin
        .from('orders')
        .select('id, order_status')
        .eq('company_id', companyId)
        .eq('id', installRecord.order_id)
        .maybeSingle();

    if (findOrderErr || !order) {
        throw new Error('RESOURCE_NOT_FOUND: Không tìm thấy thông tin đơn hàng tương ứng với lắp đặt.');
    }

    // Điều kiện thoát sớm: Nếu cả cài đặt và đơn hàng đều đã COMPLETED thì hoàn tất trọn vẹn (Idempotent)
    if (installRecord.status === 'COMPLETED' && order.order_status === 'COMPLETED') {
        return;
    }

    // KHÓA STATE MACHINE NGHIỆM THU LẮP ĐẶT (P0):
    // Chỉ cho phép completeInstallationAndHandover khi installRecord.status === 'HANDOVER_PENDING'
    // (hoặc trường hợp giải cứu khi installRecord đã COMPLETED nhưng order chưa COMPLETED).
    if (installRecord.status !== 'COMPLETED') {
        if (installRecord.status !== 'HANDOVER_PENDING') {
            throw new Error(
                `INVALID_STATE_TRANSITION: Chỉ cho phép nghiệm thu khi hồ sơ lắp đặt ở trạng thái 'HANDOVER_PENDING'. Trạng thái hiện tại: '${installRecord.status}'.`
            );
        }

        // Truy vấn thông tin lịch hẹn liên kết
        const { data: appointment, error: findApptErr } = await admin
            .from('appointments')
            .select('id, status')
            .eq('company_id', companyId)
            .eq('id', installRecord.appointment_id)
            .maybeSingle();

        if (findApptErr || !appointment) {
            throw new Error('RESOURCE_NOT_FOUND: Không tìm thấy thông tin lịch hẹn lắp đặt liên kết.');
        }

        // Kiểm tra trạng thái linked appointment phải là 'IN_PROGRESS' hoặc 'ACCEPTED'
        const validApptStatuses = ['IN_PROGRESS', 'ACCEPTED'];
        if (!validApptStatuses.includes(appointment.status)) {
            throw new Error(
                `INVALID_STATE_TRANSITION: Lịch hẹn liên kết phải ở trạng thái IN_PROGRESS hoặc ACCEPTED. Trạng thái hiện tại: '${appointment.status}'.`
            );
        }

        // Kiểm tra trạng thái order phải là 'READY_FOR_INSTALL' hoặc 'INSTALLING'
        const validOrderStatuses = ['READY_FOR_INSTALL', 'INSTALLING'];
        if (!validOrderStatuses.includes(order.order_status)) {
            throw new Error(
                `INVALID_STATE_TRANSITION: Đơn hàng liên kết phải ở trạng thái READY_FOR_INSTALL hoặc INSTALLING. Trạng thái hiện tại: '${order.order_status}'.`
            );
        }
    }

    // KHẮC PHỤC STORAGE EVIDENCE DO BROWSER TỰ KHAI (P0):
    // Đọc photos và handover_ref từ DB. Kiểm tra nghiêm ngặt: Nếu thiếu, fail-closed ngay lập tức!
    if (
        !installRecord.photos ||
        !Array.isArray(installRecord.photos) ||
        installRecord.photos.length === 0 ||
        !installRecord.handover_ref ||
        typeof installRecord.handover_ref !== 'string' ||
        installRecord.handover_ref.trim() === ''
    ) {
        throw new Error(
            'MISSING_EVIDENCE: Hồ sơ lắp đặt chưa có đầy đủ tài liệu nghiệm thu trong cơ sở dữ liệu (yêu cầu ảnh hiện trường và biên bản bàn giao có chữ ký).'
        );
    }

    // Thẩm định tính hợp lệ của storage reference lưu trong DB
    for (const photo of installRecord.photos) {
        if (!isValidInstallationStorageRef(photo)) {
            throw new Error(
                `INVALID_STORAGE_REF: Ảnh nghiệm thu lưu trữ không hợp lệ: "${photo}". Bắt buộc phải có tiền tố 'installation-docs/' hoặc URL lưu trữ hợp lệ của hệ thống.`
            );
        }
    }

    if (!isValidInstallationStorageRef(installRecord.handover_ref)) {
        throw new Error(
            `INVALID_STORAGE_REF: Biên bản bàn giao lưu trữ không hợp lệ: "${installRecord.handover_ref}". Bắt buộc phải có tiền tố 'installation-docs/' hoặc URL lưu trữ hợp lệ của hệ thống.`
        );
    }

    const completedAt = new Date().toISOString();
    const previousOrderStatus = order.order_status;
    let installationMarkedCompleted = false;

    // BẢO ĐẢM TÍNH NGUYÊN TỬ (ATOMICITY) & ROLLBACK (P0):
    // 1. Cập nhật installations sang COMPLETED
    if (installRecord.status !== 'COMPLETED') {
        const { data: updatedInst, error: updateInstallErr } = await admin
            .from('installations')
            .update({
                status: 'COMPLETED' as InstallationStatus,
                completed_at: completedAt,
                updated_at: completedAt,
            })
            .eq('company_id', companyId)
            .eq('id', input.installationId)
            .select('id')
            .single();

        if (updateInstallErr || !updatedInst) {
            throw new Error(`INVALID_STATE_TRANSITION: Cập nhật trạng thái nghiệm thu thất bại: ${updateInstallErr?.message || 'Lỗi DB'}`);
        }
        installationMarkedCompleted = true;
    }

    // 2. Cập nhật đơn hàng sang COMPLETED (với cơ chế Rollback nếu thất bại)
    try {
        if (order.order_status !== 'COMPLETED') {
            await dispatchOrderCompletionEvent(companyId, installRecord.order_id, admin);
        }
    } catch (orderErr: any) {
        // Rollback installations nếu cập nhật order thất bại
        if (installationMarkedCompleted) {
            await admin
                .from('installations')
                .update({
                    status: 'HANDOVER_PENDING' as InstallationStatus,
                    completed_at: null,
                    updated_at: new Date().toISOString(),
                })
                .eq('company_id', companyId)
                .eq('id', input.installationId);
        }
        throw new Error(`Cập nhật đơn hàng thất bại, đã rollback trạng thái nghiệm thu: ${orderErr?.message || orderErr}`);
    }

    // 3. Ghi audit log an toàn (Fail-Closed)
    const { error: auditError } = await admin
        .from('audit_logs')
        .insert({
            company_id: companyId,
            user_id: actor?.userId || null,
            action: 'COMPLETE_INSTALLATION_AND_HANDOVER',
            resource_type: 'installations',
            resource_id: input.installationId,
            result: 'SUCCESS',
            metadata: {
                from_status: installRecord.status,
                to_status: 'COMPLETED',
                order_id: installRecord.order_id,
                actor_id: actor?.userId || null,
            },
        });

    if (auditError) {
        // Rollback cả order và installations nếu ghi audit thất bại
        try {
            if (previousOrderStatus !== 'COMPLETED') {
                await admin
                    .from('orders')
                    .update({
                        order_status: previousOrderStatus,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('company_id', companyId)
                    .eq('id', installRecord.order_id);
            }
            if (installationMarkedCompleted) {
                await admin
                    .from('installations')
                    .update({
                        status: 'HANDOVER_PENDING' as InstallationStatus,
                        completed_at: null,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('company_id', companyId)
                    .eq('id', input.installationId);
            }
        } catch (rollbackErr) {
            console.error('Rollback thất bại sau lỗi audit log:', rollbackErr);
        }
        throw new Error(`Ghi nhận kiểm toán thất bại, đã rollback toàn bộ trạng thái (Fail-closed): ${auditError.message}`);
    }
}