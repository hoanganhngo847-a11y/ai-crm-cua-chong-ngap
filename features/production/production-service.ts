import 'server-only';
import { createAdminClient } from '../../lib/supabase/admin';
import type {
    CreateProductionOrderInput,
    ProductionOrderDTO,
    ProductionOrderStatus,
    QCStatus,
    RecordQualityCheckInput,
    SettableProductionStatus,
    UpdateProductionProgressInput,
} from './types';

/**
 * Chuyển đổi trạng thái hợp lệ của lệnh sản xuất (State Machine)
 */
export const VALID_PRODUCTION_TRANSITIONS: Record<ProductionOrderStatus, ProductionOrderStatus[]> = {
    PENDING_SPECS: ['RELEASED_TO_FACTORY'],
    RELEASED_TO_FACTORY: ['IN_PRODUCTION'],
    IN_PRODUCTION: ['QC_IN_PROGRESS'],
    QC_IN_PROGRESS: ['QC_PASSED', 'QC_FAILED', 'READY_FOR_DISPATCH', 'IN_PRODUCTION'],
    QC_FAILED: ['IN_PRODUCTION'],
    QC_PASSED: ['READY_FOR_DISPATCH'],
    READY_FOR_DISPATCH: ['IN_PRODUCTION'],
};

/**
 * Trạng thái cho phép thiết lập qua generic updateProductionProgress (P0)
 * Loại bỏ hoàn toàn 'QC_PASSED', 'QC_FAILED', 'READY_FOR_DISPATCH' khỏi hàm này.
 */
export const VALID_SETTABLE_PRODUCTION_TRANSITIONS: Record<ProductionOrderStatus, SettableProductionStatus[]> = {
    PENDING_SPECS: ['RELEASED_TO_FACTORY'],
    RELEASED_TO_FACTORY: ['IN_PRODUCTION'],
    IN_PRODUCTION: ['QC_IN_PROGRESS'],
    QC_IN_PROGRESS: ['IN_PRODUCTION'],
    QC_FAILED: ['IN_PRODUCTION'],
    QC_PASSED: [],
    READY_FOR_DISPATCH: ['IN_PRODUCTION'],
};

/**
 * 1. Tạo lệnh sản xuất cho xưởng (Việc 29)
 * Ràng buộc:
 * - Bắt buộc hợp đồng phải ở trạng thái SIGNED và có signed_file_ref hợp lệ.
 * - Bắt buộc kiểm tra orders.order_status: chỉ cho phép 'CONTRACT_SIGNED' hoặc 'DEPOSIT_CONFIRMED'.
 * - TUYỆT ĐỐI CHẶN nếu order_status === 'CANCELLED' hoặc đã 'IN_PRODUCTION'.
 */
export async function createProductionOrder(
    companyId: string,
    input: CreateProductionOrderInput,
    overrideAdminClient?: any
): Promise<ProductionOrderDTO> {
    const admin = overrideAdminClient || createAdminClient();

    // Kiểm tra trạng thái đơn hàng (P0)
    const { data: order, error: orderErr } = await admin
        .from('orders')
        .select('id, order_status')
        .eq('company_id', companyId)
        .eq('id', input.orderId)
        .maybeSingle();

    if (orderErr) {
        throw new Error(`Lỗi truy vấn đơn hàng: ${orderErr.message}`);
    }

    if (!order) {
        throw new Error('Không tìm thấy đơn hàng để tạo lệnh sản xuất.');
    }

    if (order.order_status === 'CANCELLED') {
        throw new Error('Không thể tạo lệnh sản xuất cho đơn hàng đã bị hủy (CANCELLED).');
    }

    if (order.order_status === 'IN_PRODUCTION') {
        throw new Error('Đơn hàng này đã có lệnh sản xuất đang chạy (IN_PRODUCTION).');
    }

    const validProductionTriggerStatuses = ['CONTRACT_SIGNED', 'DEPOSIT_CONFIRMED'];
    if (!validProductionTriggerStatuses.includes(order.order_status)) {
        throw new Error(
            `Không thể tạo lệnh sản xuất: Trạng thái đơn hàng (${order.order_status}) không hợp lệ. Chỉ cho phép khi đơn hàng ở trạng thái: ${validProductionTriggerStatuses.join(', ')}.`
        );
    }

    // Kiểm tra điều kiện hợp đồng đã ký của đơn hàng
    const { data: contract, error: contractErr } = await admin
        .from('contracts')
        .select('id, status, signed_file_ref')
        .eq('company_id', companyId)
        .eq('order_id', input.orderId)
        .eq('is_current', true)
        .maybeSingle();

    if (contractErr) {
        throw new Error(`Lỗi truy vấn hợp đồng: ${contractErr.message}`);
    }

    if (!contract || contract.status !== 'SIGNED' || !contract.signed_file_ref) {
        throw new Error(
            'Không thể tạo lệnh sản xuất: Đơn hàng chưa có hợp đồng đã ký hoặc chưa tải lên tệp hợp đồng hợp lệ.'
        );
    }

    // Kiểm tra đơn hàng đã có lệnh sản xuất chưa
    const { data: existingOrder } = await admin
        .from('production_orders')
        .select('id')
        .eq('company_id', companyId)
        .eq('order_id', input.orderId)
        .maybeSingle();

    if (existingOrder) {
        throw new Error('Đơn hàng này đã có lệnh sản xuất đang chạy.');
    }

    // Tạo lệnh sản xuất mới
    const { data: newProdOrder, error: insertErr } = await admin
        .from('production_orders')
        .insert({
            company_id: companyId,
            order_id: input.orderId,
            specs: input.specs,
            materials: input.materials,
            status: 'RELEASED_TO_FACTORY' as ProductionOrderStatus,
            deadline: input.deadline,
            qc_status: 'PENDING' as QCStatus,
        })
        .select()
        .single();

    if (insertErr || !newProdOrder) {
        throw new Error(`Tạo lệnh sản xuất thất bại: ${insertErr?.message}`);
    }

    // Cập nhật trạng thái đơn hàng chung sang IN_PRODUCTION (với rollback Fail-closed)
    const { error: orderUpdateErr } = await admin
        .from('orders')
        .update({ order_status: 'IN_PRODUCTION', updated_at: new Date().toISOString() })
        .eq('company_id', companyId)
        .eq('id', input.orderId);

    if (orderUpdateErr) {
        // Rollback lệnh sản xuất vừa tạo để đảm bảo tính nguyên tử (Fail-closed)
        await admin
            .from('production_orders')
            .delete()
            .eq('company_id', companyId)
            .eq('id', newProdOrder.id);

        throw new Error(
            `Cập nhật trạng thái đơn hàng sang IN_PRODUCTION thất bại, đã rollback lệnh sản xuất: ${orderUpdateErr.message}`
        );
    }

    return {
        id: newProdOrder.id,
        companyId: newProdOrder.company_id,
        orderId: newProdOrder.order_id,
        specs: newProdOrder.specs,
        materials: newProdOrder.materials,
        status: newProdOrder.status as ProductionOrderStatus,
        deadline: newProdOrder.deadline,
        qcStatus: newProdOrder.qc_status as QCStatus,
        createdAt: newProdOrder.created_at,
        updatedAt: newProdOrder.updated_at,
    };
}

/**
 * 2. Cập nhật tiến độ xưởng sản xuất (Việc 30)
 * Ràng buộc P0:
 * - CHẶN MÂU THUẪN TRẠNG THÁI QC & SẢN XUẤT:
 *   Loại bỏ hoàn toàn 'QC_PASSED', 'QC_FAILED', 'READY_FOR_DISPATCH' khỏi hàm generic này.
 *   Ba trạng thái trên CHỈ ĐƯỢC PHÉP thiết lập duy nhất qua hàm recordQualityCheck.
 * - BẢO ĐẢM TÍNH NGUYÊN TỬ (ATOMICITY) & AUDIT TRAIL:
 *   Nếu ghi audit thất bại, rollback trạng thái về oldStatus (Fail-closed).
 */
export async function updateProductionProgress(
    companyId: string,
    inputOrOrderId: UpdateProductionProgressInput | string,
    statusArg?: SettableProductionStatus,
    noteArg?: string,
    actorIdArg?: string,
    overrideAdminClient?: any
): Promise<void> {
    const input: UpdateProductionProgressInput =
        typeof inputOrOrderId === 'object'
            ? inputOrOrderId
            : {
                  productionOrderId: inputOrOrderId,
                  status: statusArg!,
                  note: noteArg,
                  actorId: actorIdArg,
              };

    // Chặn triệt để các trạng thái QC trong generic update (P0)
    const FORBIDDEN_GENERIC_STATUSES = ['QC_PASSED', 'QC_FAILED', 'READY_FOR_DISPATCH'];
    if (FORBIDDEN_GENERIC_STATUSES.includes(input.status as string)) {
        throw new Error(
            `INVALID_STATE_TRANSITION: Trạng thái '${input.status}' chỉ được phép thiết lập duy nhất qua quy trình kiểm tra chất lượng (recordQualityCheck).`
        );
    }

    const admin = overrideAdminClient || createAdminClient();

    // Truy vấn trạng thái hiện tại để lưu vết kiểm toán
    const { data: currentOrder, error: findErr } = await admin
        .from('production_orders')
        .select('id, status, qc_status, order_id')
        .eq('company_id', companyId)
        .eq('id', input.productionOrderId)
        .maybeSingle();

    if (findErr || !currentOrder) {
        throw new Error('RESOURCE_NOT_FOUND: Không tìm thấy lệnh sản xuất.');
    }

    const oldStatus = currentOrder.status;

    // Kiểm tra chuyển đổi trạng thái hợp lệ (State Machine - P0 & P1)
    if (oldStatus !== input.status) {
        const allowedTransitions = VALID_SETTABLE_PRODUCTION_TRANSITIONS[oldStatus as ProductionOrderStatus] || [];
        if (!allowedTransitions.includes(input.status)) {
            throw new Error(
                `INVALID_STATE_TRANSITION: Chuyển đổi trạng thái lệnh sản xuất không hợp lệ từ '${oldStatus}' sang '${input.status}'.`
            );
        }
    }

    // Cập nhật với kiểm tra affected rows (P1: .select('id').single())
    const { data: updatedRecord, error } = await admin
        .from('production_orders')
        .update({
            status: input.status,
            updated_at: new Date().toISOString(),
        })
        .eq('company_id', companyId)
        .eq('id', input.productionOrderId)
        .select('id')
        .single();

    if (error || !updatedRecord) {
        const notFoundErr = new Error('RESOURCE_NOT_FOUND: Không tìm thấy lệnh sản xuất cần cập nhật (404).');
        (notFoundErr as any).status = 404;
        throw notFoundErr;
    }

    // BẮT BUỘC ghi bản ghi kiểm toán vào bảng public.audit_logs (Sanitized: chỉ lưu from_status, to_status, qc_status, actor_id - P1)
    const { error: auditError } = await admin
        .from('audit_logs')
        .insert({
            company_id: companyId,
            user_id: input.actorId || null,
            action: 'UPDATE_PRODUCTION_PROGRESS',
            resource_type: 'production_orders',
            resource_id: input.productionOrderId,
            result: 'SUCCESS',
            metadata: {
                from_status: oldStatus,
                to_status: input.status,
                qc_status: currentOrder.qc_status,
                actor_id: input.actorId || null,
            },
        });

    if (auditError) {
        // Rollback trạng thái nếu ghi audit thất bại (Fail-closed - P0)
        await admin
            .from('production_orders')
            .update({
                status: oldStatus,
                updated_at: new Date().toISOString(),
            })
            .eq('company_id', companyId)
            .eq('id', input.productionOrderId);

        throw new Error(`Ghi nhận kiểm toán cập nhật tiến độ thất bại, đã rollback trạng thái (Fail-closed): ${auditError.message}`);
    }
}

/**
 * 3. Đánh giá chất lượng sản phẩm - QC (Việc 30)
 * Ràng buộc P0:
 * - Bắt buộc kiểm tra productionOrder.status === 'QC_IN_PROGRESS'. Nếu không ở bước này, ném lỗi cấm duyệt QC.
 * - Khi QC_PASSED -> tự động chuyển sang READY_FOR_DISPATCH và đồng bộ qc_status = 'PASSED'.
 * - Nguyên tử & Rollback: Cập nhật orders (READY_FOR_INSTALL) và ghi audit_logs fail-closed.
 */
export async function recordQualityCheck(
    companyId: string,
    inputOrOrderId: RecordQualityCheckInput | string,
    qcStatusArg?: QCStatus,
    inspectorIdArg?: string,
    notesArg?: string,
    overrideAdminClient?: any
): Promise<void> {
    const input: RecordQualityCheckInput =
        typeof inputOrOrderId === 'object'
            ? inputOrOrderId
            : {
                  productionOrderId: inputOrOrderId,
                  qcStatus: qcStatusArg!,
                  inspectorId: inspectorIdArg!,
                  notes: notesArg,
              };

    if (!input.inspectorId) {
        throw new Error('Định danh kiểm định viên (inspectorId) là bắt buộc khi xác nhận QC.');
    }

    const admin = overrideAdminClient || createAdminClient();

    // Truy vấn trạng thái hiện tại
    const { data: currentOrder, error: findErr } = await admin
        .from('production_orders')
        .select('id, status, qc_status, order_id')
        .eq('company_id', companyId)
        .eq('id', input.productionOrderId)
        .maybeSingle();

    if (findErr || !currentOrder) {
        const notFoundErr = new Error('RESOURCE_NOT_FOUND: Không tìm thấy lệnh sản xuất để kiểm tra QC (404).');
        (notFoundErr as any).status = 404;
        throw notFoundErr;
    }

    // BẮT BUỘC KIỂM TRA TRẠNG THÁI XƯỞNG (P0):
    // Chỉ cho phép duyệt QC khi lệnh sản xuất đang ở trạng thái 'QC_IN_PROGRESS'
    if (currentOrder.status !== 'QC_IN_PROGRESS') {
        throw new Error(
            `INVALID_STATE_TRANSITION: Lệnh xưởng phải ở trạng thái 'QC_IN_PROGRESS' để kiểm tra QC. Trạng thái hiện tại: '${currentOrder.status}'.`
        );
    }

    const oldStatus = currentOrder.status;
    const oldQcStatus = currentOrder.qc_status;

    // Xác định trạng thái lệnh sản xuất và qc_status đồng bộ dựa trên kết quả QC (P0)
    let nextStatus: ProductionOrderStatus;
    let dbQcStatus: QCStatus;

    if (input.qcStatus === 'PASSED') {
        nextStatus = 'READY_FOR_DISPATCH';
        dbQcStatus = 'PASSED';
    } else if (input.qcStatus === 'REWORK_REQUIRED' || input.qcStatus === 'REJECTED') {
        nextStatus = 'QC_FAILED';
        dbQcStatus = input.qcStatus;
    } else {
        throw new Error(`INVALID_INPUT: Trạng thái QC không hợp lệ: '${input.qcStatus}'.`);
    }

    // Cập nhật production_orders
    const { data: updated, error } = await admin
        .from('production_orders')
        .update({
            qc_status: dbQcStatus,
            status: nextStatus,
            updated_at: new Date().toISOString(),
        })
        .eq('company_id', companyId)
        .eq('id', input.productionOrderId)
        .select('id, order_id')
        .single();

    if (error || !updated) {
        const notFoundErr = new Error('RESOURCE_NOT_FOUND: Không tìm thấy lệnh sản xuất để kiểm tra QC (404).');
        (notFoundErr as any).status = 404;
        throw notFoundErr;
    }

    // Nếu QC Đạt, chuẩn bị sẵn sàng cho lịch lắp đặt (orders.order_status = 'READY_FOR_INSTALL')
    let orderUpdated = false;
    let previousOrderStatus: string | null = null;

    if (dbQcStatus === 'PASSED') {
        const { data: ord } = await admin
            .from('orders')
            .select('order_status')
            .eq('company_id', companyId)
            .eq('id', updated.order_id)
            .maybeSingle();

        previousOrderStatus = ord?.order_status || 'IN_PRODUCTION';

        const { error: orderUpdateErr } = await admin
            .from('orders')
            .update({ order_status: 'READY_FOR_INSTALL', updated_at: new Date().toISOString() })
            .eq('company_id', companyId)
            .eq('id', updated.order_id);

        if (orderUpdateErr) {
            // Rollback production_orders
            await admin
                .from('production_orders')
                .update({
                    qc_status: oldQcStatus,
                    status: oldStatus,
                    updated_at: new Date().toISOString(),
                })
                .eq('company_id', companyId)
                .eq('id', input.productionOrderId);

            throw new Error(`Cập nhật đơn hàng sang READY_FOR_INSTALL thất bại, đã rollback lệnh xưởng: ${orderUpdateErr.message}`);
        }
        orderUpdated = true;
    }

    // BẮT BUỘC ghi bản ghi kiểm toán vào bảng public.audit_logs (Sanitized - Fail-closed - P0 & P1)
    const { error: auditError } = await admin
        .from('audit_logs')
        .insert({
            company_id: companyId,
            user_id: input.inspectorId,
            action: 'RECORD_QUALITY_CHECK',
            resource_type: 'production_orders',
            resource_id: input.productionOrderId,
            result: 'SUCCESS',
            metadata: {
                from_status: oldStatus,
                to_status: nextStatus,
                qc_status: dbQcStatus,
                actor_id: input.inspectorId,
            },
        });

    if (auditError) {
        // Rollback cả orders và production_orders nếu ghi audit thất bại
        if (orderUpdated && previousOrderStatus) {
            await admin
                .from('orders')
                .update({ order_status: previousOrderStatus, updated_at: new Date().toISOString() })
                .eq('company_id', companyId)
                .eq('id', updated.order_id);
        }

        await admin
            .from('production_orders')
            .update({
                qc_status: oldQcStatus,
                status: oldStatus,
                updated_at: new Date().toISOString(),
            })
            .eq('company_id', companyId)
            .eq('id', input.productionOrderId);

        throw new Error(`Ghi nhận kiểm toán QC thất bại, đã rollback toàn bộ trạng thái (Fail-closed): ${auditError.message}`);
    }
}