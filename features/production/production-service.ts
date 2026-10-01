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

export interface CanonicalProductionFactsResult {
  canRelease: boolean;
  reason?: string;
  specs?: Record<string, unknown>;
  materials?: Record<string, unknown>;
  contractSigned: boolean;
}

/**
 * Server-authoritative derivation of canonical production technical specs and materials.
 * Browser is NEVER permitted to decide manufacturing facts.
 */
export async function deriveCanonicalProductionFacts(
  companyId: string,
  orderId: string,
  overrideClient?: OperationsClient
): Promise<CanonicalProductionFactsResult> {
  const admin = overrideClient || createAdminClient();

  // 1. Fetch order
  const { data: order, error: orderErr } = await admin
    .from('orders')
    .select('id, company_id, customer_id, order_status, price_calculation_id')
    .eq('id', orderId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (orderErr || !order) {
    return { canRelease: false, reason: 'RESOURCE_NOT_FOUND: Đơn hàng không tồn tại', contractSigned: false };
  }

  // 2. Fetch current signed contract
  const { data: contract } = await admin
    .from('contracts')
    .select('id, status, signed_file_ref, is_current')
    .eq('order_id', orderId)
    .eq('company_id', companyId)
    .eq('is_current', true)
    .maybeSingle();

  const isContractSigned = Boolean(
    contract &&
    contract.status === 'SIGNED' &&
    contract.signed_file_ref &&
    contract.signed_file_ref.trim().length > 0
  );

  if (!isContractSigned) {
    return {
      canRelease: false,
      reason: 'CONTRACT_NOT_SIGNED: Đơn hàng chưa có hợp đồng đã ký kết hợp lệ',
      contractSigned: false,
    };
  }

  // 3. Fetch calculation
  const { data: calc } = await admin
    .from('price_calculations')
    .select('id, survey_id, pricing_policy_id, input_data, status, amount')
    .eq('id', order.price_calculation_id)
    .eq('company_id', companyId)
    .maybeSingle();

  if (!calc || calc.status !== 'CALCULATED') {
    return {
      canRelease: false,
      reason: 'NEED_INFO: Bảng tính giá chưa hoàn thiện hoặc thiếu dữ liệu tính toán',
      contractSigned: true,
    };
  }

  // 4. Fetch policy
  const { data: policy } = await admin
    .from('pricing_policies')
    .select('id, conditions, price_rules')
    .eq('id', calc.pricing_policy_id)
    .eq('company_id', companyId)
    .maybeSingle();

  // 5. Fetch survey if bound
  let surveyData: { measurements?: Record<string, unknown> } | null = null;
  if (calc.survey_id) {
    const { data: s } = await admin
      .from('surveys')
      .select('id, measurements')
      .eq('id', calc.survey_id)
      .eq('company_id', companyId)
      .maybeSingle();
    surveyData = s;
  }

  // Derive canonical materials
  let canonicalMaterials: Record<string, unknown> | null = null;
  const sm = surveyData?.measurements?.materials;
  const im = calc.input_data?.materials;
  const pm1 = policy?.conditions?.materials || policy?.conditions?.standard_materials;
  const pm2 = policy?.price_rules?.materials || policy?.price_rules?.standard_materials;

  if (sm && typeof sm === 'object' && Object.keys(sm).length > 0) {
    canonicalMaterials = sm as Record<string, unknown>;
  } else if (im && typeof im === 'object' && Object.keys(im).length > 0) {
    canonicalMaterials = im as Record<string, unknown>;
  } else if (pm1 && typeof pm1 === 'object' && Object.keys(pm1).length > 0) {
    canonicalMaterials = pm1 as Record<string, unknown>;
  } else if (pm2 && typeof pm2 === 'object' && Object.keys(pm2).length > 0) {
    canonicalMaterials = pm2 as Record<string, unknown>;
  }

  if (!canonicalMaterials || Object.keys(canonicalMaterials).length === 0) {
    return {
      canRelease: false,
      reason: 'NEED_INFO: Thiếu đặc tả danh mục vật tư chuẩn từ khảo sát/chính sách giá',
      contractSigned: true,
    };
  }

  // Derive canonical specs
  let cwMm: number | null = null;
  let bhMm: number | null = null;

  if (surveyData?.measurements) {
    const m = surveyData.measurements;
    cwMm = m.clear_width_mm ? Number(m.clear_width_mm) : null;
    bhMm = m.barrier_height_mm ? Number(m.barrier_height_mm) : null;
  } else if (calc.input_data) {
    const inp = calc.input_data;
    cwMm = inp.clear_width_mm ? Number(inp.clear_width_mm) : inp.width ? Number(inp.width) : null;
    bhMm = inp.barrier_height_mm ? Number(inp.barrier_height_mm) : inp.height ? Number(inp.height) : null;
  }

  if (!cwMm || !bhMm || cwMm <= 0 || bhMm <= 0) {
    return {
      canRelease: false,
      reason: 'NEED_INFO: Thiếu kích thước chuẩn (clear_width_mm hoặc barrier_height_mm)',
      contractSigned: true,
    };
  }

  const dimStr = `${cwMm}x${bhMm}mm`;
  const canonicalSpecs: Record<string, unknown> = {
    dimensions: dimStr,
    clear_width_mm: cwMm,
    barrier_height_mm: bhMm,
  };

  const gateType = surveyData?.measurements?.gate_type || calc.input_data?.gate_type;
  if (gateType) canonicalSpecs.gate_type = gateType;

  const mountingMethod = surveyData?.measurements?.mounting_method || calc.input_data?.mounting_method;
  if (mountingMethod) canonicalSpecs.mounting_method = mountingMethod;

  return {
    canRelease: true,
    specs: canonicalSpecs,
    materials: canonicalMaterials,
    contractSigned: true,
  };
}

export interface ProductionDashboardOrderDTO {
  id: string;
  orderCode: string;
  customerName: string;
  customerCode?: string;
  finalAmount: number;
  orderStatus: string;
  canRelease: boolean;
  releaseBlockReason?: string;
  canonicalSpecs?: Record<string, unknown>;
  canonicalMaterials?: Record<string, unknown>;
  isContractSigned: boolean;
}

export interface ProductionDashboardDTO {
  productionOrders: Array<ProductionOrderDTO & { orderCode: string; customerName: string }>;
  eligibleOrders: ProductionDashboardOrderDTO[];
}

export async function getProductionDashboardData(
  companyId: string,
  overrideClient?: OperationsClient
): Promise<ProductionDashboardDTO> {
  const admin = overrideClient || createAdminClient();

  // 1. Fetch existing production orders
  const { data: prodOrders, error: _pErr } = await admin
    .from('production_orders')
    .select(`
      id,
      company_id,
      order_id,
      specs,
      materials,
      status,
      deadline,
      qc_status,
      created_at,
      updated_at,
      orders (
        id,
        order_code,
        customers (
          name
        )
      )
    `)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });

  interface ProdOrderJoinRow {
    id: string;
    company_id: string;
    order_id: string;
    specs: Record<string, unknown>;
    materials: Record<string, unknown>;
    status: ProductionOrderStatus;
    deadline: string;
    qc_status: QCStatus;
    created_at: string;
    updated_at: string;
    orders?: {
      id?: string;
      order_code?: string;
      customers?: { name?: string };
    };
  }

  const productionOrders = ((prodOrders || []) as unknown as ProdOrderJoinRow[]).map((p) => ({
    id: p.id,
    companyId: p.company_id,
    orderId: p.order_id,
    specs: p.specs,
    materials: p.materials,
    status: p.status,
    deadline: p.deadline,
    qcStatus: p.qc_status,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    orderCode: p.orders?.order_code || p.order_id.slice(0, 8),
    customerName: p.orders?.customers?.name || 'Khách hàng',
  }));

  // 2. Fetch eligible orders not yet in production
  const { data: candidateOrders } = await admin
    .from('orders')
    .select(`
      id,
      order_code,
      customer_id,
      final_amount,
      order_status,
      customers (
        name,
        customer_code
      )
    `)
    .eq('company_id', companyId)
    .in('order_status', ['CONTRACT_SIGNED', 'DEPOSIT_CONFIRMED'])
    .order('created_at', { ascending: false });

  const existingOrderIds = new Set(productionOrders.map((p) => p.orderId));
  const eligibleOrders: ProductionDashboardOrderDTO[] = [];

  for (const o of candidateOrders || []) {
    if (existingOrderIds.has(o.id)) continue;

    const facts = await deriveCanonicalProductionFacts(companyId, o.id, admin);
    const cust = (o.customers as { name?: string; customer_code?: string }) || {};

    eligibleOrders.push({
      id: o.id,
      orderCode: o.order_code,
      customerName: cust.name || 'Khách hàng',
      customerCode: cust.customer_code,
      finalAmount: Number(o.final_amount || 0),
      orderStatus: o.order_status,
      canRelease: facts.canRelease,
      releaseBlockReason: facts.reason,
      canonicalSpecs: facts.specs,
      canonicalMaterials: facts.materials,
      isContractSigned: facts.contractSigned,
    });
  }

  return {
    productionOrders,
    eligibleOrders,
  };
}
