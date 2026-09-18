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
 * 1. Tạo lệnh sản xuất cho xưởng (Việc 29)
 * Ràng buộc: Bắt buộc hợp đồng phải ở trạng thái SIGNED và có signed_file_ref hợp lệ.
 */
export async function createProductionOrder(
    companyId: string,
    input: CreateProductionOrderInput,
    overrideAdminClient?: any
): Promise<ProductionOrderDTO> {
    const admin = overrideAdminClient || createAdminClient();

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

    const { error } = await admin
        .from('production_orders')
        .update({
            status: input.status,
            updated_at: new Date().toISOString(),
        })
        .eq('company_id', companyId)
        .eq('id', input.productionOrderId);

    if (error) {
        throw new Error(`Cập nhật tiến độ sản xuất thất bại: ${error.message}`);
    }

    // BẮT BUỘC ghi bản ghi kiểm toán vào bảng public.audit_logs
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
                old_status: oldStatus,
                new_status: input.status,
                note: input.note || null,
                qc_status: currentOrder.qc_status,
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
        throw new Error('Không tìm thấy lệnh sản xuất để kiểm tra QC.');
    }

    const oldStatus = currentOrder.status;
    const oldQcStatus = currentOrder.qc_status;

    // Xác định trạng thái lệnh sản xuất dựa trên kết quả QC
    let nextStatus: ProductionOrderStatus = 'QC_IN_PROGRESS';
    if (input.qcStatus === 'PASSED') {
        nextStatus = 'READY_FOR_DISPATCH';
    } else if (input.qcStatus === 'REWORK_REQUIRED' || input.qcStatus === 'REJECTED') {
        nextStatus = 'QC_FAILED';
    }

    const { data: updated, error } = await admin
        .from('production_orders')
        .update({
            qc_status: input.qcStatus,
            status: nextStatus,
            updated_at: new Date().toISOString(),
        })
        .eq('company_id', companyId)
        .eq('id', input.productionOrderId)
        .select('order_id')
        .single();

    if (error || !updated) {
        throw new Error(`Ghi nhận kiểm tra QC thất bại: ${error?.message}`);
    }

    // Nếu QC Đạt, chuẩn bị sẵn sàng cho lịch lắp đặt
    if (input.qcStatus === 'PASSED') {
        await admin
            .from('orders')
            .update({ order_status: 'READY_FOR_INSTALL', updated_at: new Date().toISOString() })
            .eq('company_id', companyId)
            .eq('id', updated.order_id);
    }

    // BẮT BUỘC ghi bản ghi kiểm toán vào bảng public.audit_logs
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
                old_status: oldStatus,
                new_status: nextStatus,
                old_qc_status: oldQcStatus,
                qc_status: input.qcStatus,
                notes: input.notes || null,
            },
        });

    if (auditError) {
        throw new Error(`Ghi nhận kiểm toán QC thất bại: ${auditError.message}`);
    }
}