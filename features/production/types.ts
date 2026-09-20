export type ProductionOrderStatus =
    | 'PENDING_SPECS'
    | 'RELEASED_TO_FACTORY'
    | 'IN_PRODUCTION'
    | 'QC_IN_PROGRESS'
    | 'QC_PASSED'
    | 'QC_FAILED'
    | 'READY_FOR_DISPATCH';

export type SettableProductionStatus =
    | 'PENDING_SPECS'
    | 'RELEASED_TO_FACTORY'
    | 'IN_PRODUCTION'
    | 'QC_IN_PROGRESS';

export type QCStatus = 'PENDING' | 'PASSED' | 'REWORK_REQUIRED' | 'REJECTED';

export interface ProductionOrderDTO {
    id: string;
    companyId: string;
    orderId: string;
    specs: Record<string, unknown>;
    materials: Record<string, unknown>;
    status: ProductionOrderStatus;
    deadline: string;
    qcStatus: QCStatus;
    createdAt: string;
    updatedAt: string;
}

export interface CreateProductionOrderInput {
    orderId: string;
    specs: Record<string, unknown>;
    materials: Record<string, unknown>;
    deadline: string;
}

export interface UpdateProductionProgressInput {
    productionOrderId: string;
    status: SettableProductionStatus;
    note?: string;
    actorId?: string;
}

export interface RecordQualityCheckInput {
    productionOrderId: string;
    qcStatus: QCStatus;
    notes?: string;
    inspectorId: string;
}