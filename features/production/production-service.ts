import 'server-only';
import { operationsRpc, type OperationsClient } from '../operations/server';
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

export async function createProductionOrder(companyId: string, input: CreateProductionOrderInput, overrideAdminClient?: OperationsClient, actorId?: string): Promise<ProductionOrderDTO> {
 const p = await operationsRpc(overrideAdminClient || createAdminClient(), 'create_production_order_atomic', {
  p_company_id: companyId, p_order_id: input.orderId, p_actor_id: actorId,
  p_specs: input.specs, p_materials: input.materials, p_deadline: input.deadline,
 });
 return { id:p.id, companyId:p.company_id, orderId:p.order_id, specs:p.specs, materials:p.materials, status:p.status, deadline:p.deadline, qcStatus:p.qc_status, createdAt:p.created_at, updatedAt:p.updated_at };
}
export async function updateProductionProgress(companyId: string, inputOrOrderId: UpdateProductionProgressInput | string, statusArg?: SettableProductionStatus, noteArg?: string, actorIdArg?: string, overrideAdminClient?: OperationsClient): Promise<void> {
 const input = typeof inputOrOrderId === 'object' ? inputOrOrderId : { productionOrderId:inputOrOrderId,status:statusArg!,note:noteArg,actorId:actorIdArg };
 await operationsRpc(overrideAdminClient || createAdminClient(), 'update_production_progress_atomic', {p_company_id:companyId,p_production_order_id:input.productionOrderId,p_actor_id:input.actorId,p_status:input.status});
}
export async function recordQualityCheck(companyId: string, inputOrOrderId: RecordQualityCheckInput | string, qcStatusArg?: QCStatus, inspectorIdArg?: string, notesArg?: string, overrideAdminClient?: OperationsClient): Promise<void> {
 const input = typeof inputOrOrderId === 'object' ? inputOrOrderId : {productionOrderId:inputOrOrderId,qcStatus:qcStatusArg!,inspectorId:inspectorIdArg!,notes:notesArg};
 await operationsRpc(overrideAdminClient || createAdminClient(),'record_quality_check_atomic',{p_company_id:companyId,p_production_order_id:input.productionOrderId,p_qc_status:input.qcStatus,p_inspector_id:input.inspectorId,p_notes:input.notes || null});
}
