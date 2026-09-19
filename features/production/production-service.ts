import 'server-only';
import { createAdminClient } from '../../lib/supabase/admin';
import type {
    CreateProductionOrderInput,
    ProductionOrderDTO,
    ProductionOrderStatus,
    QCStatus,
    RecordQualityCheckInput,
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

    // Cập nhật trạng thái đơn hàng chung sang IN_PRODUCTION
    await admin
        .from('orders')
        .update({ order_status: 'IN_PRODUCTION', updated_at: new Date().toISOString() })
        .eq('company_id', companyId)
        .eq('id', input.orderId);

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
 * BẮT BUỘC ghi bản ghi kiểm toán vào public.audit_logs
 */
export async function updateProductionProgress(
    companyId: string,
    inputOrOrderId: UpdateProductionProgressInput | string,
    statusArg?: ProductionOrderStatus,
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

    const admin = overrideAdminClient || createAdminClient();

    // Truy vấn trạng thái hiện tại để lưu vết kiểm toán
    const { data: currentOrder, error: findErr } = await admin
        .from('production_orders')
        .select('id, status, qc_status, order_id')
        .eq('company_id', companyId)
        .eq('id', input.productionOrderId)
        .maybeSingle();

    if (findErr || !currentOrder) {
        throw new Error('Không tìm thấy lệnh sản xuất.');
    }

    const oldStatus = currentOrder.status;

    // Kiểm tra chuyển đổi trạng thái hợp lệ (State Machine - P1)
    if (oldStatus !== input.status) {
        const allowedTransitions = VALID_PRODUCTION_TRANSITIONS[oldStatus as ProductionOrderStatus] || [];
        if (!allowedTransitions.includes(input.status)) {
            throw new Error(
                `Chuyển đổi trạng thái lệnh sản xuất không hợp lệ từ '${oldStatus}' sang '${input.status}'.`
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
        const notFoundErr = new Error('Không tìm thấy lệnh sản xuất cần cập nhật (404).');
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
        throw new Error(`Ghi nhận kiểm toán cập nhật tiến độ thất bại: ${auditError.message}`);
    }
}

/**
 * 3. Đánh giá chất lượng sản phẩm - QC (Việc 30)
 * Yêu cầu: Xác nhận QC vật lý do người thật thao tác có định danh inspectorId và ghi kiểm toán.
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
        const notFoundErr = new Error('Không tìm thấy lệnh sản xuất để kiểm tra QC (404).');
        (notFoundErr as any).status = 404;
        throw notFoundErr;
    }

    const oldStatus = currentOrder.status;

    // Xác định trạng thái lệnh sản xuất dựa trên kết quả QC
    let nextStatus: ProductionOrderStatus = 'QC_IN_PROGRESS';
    if (input.qcStatus === 'PASSED') {
        nextStatus = 'READY_FOR_DISPATCH';
    } else if (input.qcStatus === 'REWORK_REQUIRED' || input.qcStatus === 'REJECTED') {
        nextStatus = 'QC_FAILED';
    }

    // Cập nhật với kiểm tra affected rows (P1: .select('id, order_id').single())
    const { data: updated, error } = await admin
        .from('production_orders')
        .update({
            qc_status: input.qcStatus,
            status: nextStatus,
            updated_at: new Date().toISOString(),
        })
        .eq('company_id', companyId)
        .eq('id', input.productionOrderId)
        .select('id, order_id')
        .single();

    if (error || !updated) {
        const notFoundErr = new Error('Không tìm thấy lệnh sản xuất để kiểm tra QC (404).');
        (notFoundErr as any).status = 404;
        throw notFoundErr;
    }

    // Nếu QC Đạt, chuẩn bị sẵn sàng cho lịch lắp đặt
    if (input.qcStatus === 'PASSED') {
        await admin
            .from('orders')
            .update({ order_status: 'READY_FOR_INSTALL', updated_at: new Date().toISOString() })
            .eq('company_id', companyId)
            .eq('id', updated.order_id);
    }

    // BẮT BUỘC ghi bản ghi kiểm toán vào bảng public.audit_logs (Sanitized: chỉ lưu from_status, to_status, qc_status, actor_id - P1)
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
                qc_status: input.qcStatus,
                actor_id: input.inspectorId,
            },
        });

    if (auditError) {
        throw new Error(`Ghi nhận kiểm toán QC thất bại: ${auditError.message}`);
    }
}