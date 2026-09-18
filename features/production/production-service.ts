import 'server-only';
import { createAdminClient } from '../../lib/supabase/admin';
import type {
    CreateProductionOrderInput,
    ProductionOrderDTO,
    ProductionOrderStatus,
    QCStatus,
} from './types';

/**
 * 1. Tạo lệnh sản xuất cho xưởng (Việc 29)
 * Ràng buộc: Bắt buộc hợp đồng phải ở trạng thái SIGNED và có signed_file_ref hợp lệ.
 */
export async function createProductionOrder(
    companyId: string,
    input: CreateProductionOrderInput
): Promise<ProductionOrderDTO> {
    const admin = createAdminClient();

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
 */
export async function updateProductionProgress(
    companyId: string,
    productionOrderId: string,
    status: ProductionOrderStatus
): Promise<void> {
    const admin = createAdminClient();

    const { error } = await admin
        .from('production_orders')
        .update({
            status,
            updated_at: new Date().toISOString(),
        })
        .eq('company_id', companyId)
        .eq('id', productionOrderId);

    if (error) {
        throw new Error(`Cập nhật tiến độ sản xuất thất bại: ${error.message}`);
    }
}

/**
 * 3. Đánh giá chất lượng sản phẩm - QC (Việc 30)
 * Yêu cầu: Xác nhận QC vật lý do người thật thao tác.
 */
export async function recordQualityCheck(
    companyId: string,
    productionOrderId: string,
    qcStatus: QCStatus
): Promise<void> {
    const admin = createAdminClient();

    // Xác định trạng thái lệnh sản xuất dựa trên kết quả QC
    let nextStatus: ProductionOrderStatus = 'QC_IN_PROGRESS';
    if (qcStatus === 'PASSED') {
        nextStatus = 'READY_FOR_DISPATCH';
    } else if (qcStatus === 'REWORK_REQUIRED' || qcStatus === 'REJECTED') {
        nextStatus = 'QC_FAILED';
    }

    const { data: updated, error } = await admin
        .from('production_orders')
        .update({
            qc_status: qcStatus,
            status: nextStatus,
            updated_at: new Date().toISOString(),
        })
        .eq('company_id', companyId)
        .eq('id', productionOrderId)
        .select('order_id')
        .single();

    if (error || !updated) {
        throw new Error(`Ghi nhận kiểm tra QC thất bại: ${error?.message}`);
    }

    // Nếu QC Đạt, chuẩn bị sẵn sàng cho lịch lắp đặt
    if (qcStatus === 'PASSED') {
        await admin
            .from('orders')
            .update({ order_status: 'READY_FOR_INSTALL', updated_at: new Date().toISOString() })
            .eq('company_id', companyId)
            .eq('id', updated.order_id);
    }
}