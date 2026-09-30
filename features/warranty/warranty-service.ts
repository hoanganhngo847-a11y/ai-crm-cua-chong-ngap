import 'server-only';
import { operationsRpc, type OperationsClient, type OperationsActor } from '../operations/server';
import { createAdminClient } from '../../lib/supabase/admin';
import type {
    AssignWarrantyTicketInput,
    CreateWarrantyTicketInput,
    ReopenWarrantyTicketInput,
    UpdateWarrantyStatusInput,
    WarrantyTicketDTO,
    WarrantyTicketStatus,
} from './types';

/**
 * Bản đồ chuyển đổi trạng thái hợp lệ của phiếu bảo hành (State Machine - P1)
 */
export const VALID_WARRANTY_TRANSITIONS: Record<WarrantyTicketStatus, WarrantyTicketStatus[]> = {
    OPEN: ['ASSIGNED', 'CANCELLED'],
    ASSIGNED: ['IN_PROGRESS', 'OPEN', 'CANCELLED'],
    IN_PROGRESS: ['RESOLVED', 'FAILED'],
    RESOLVED: ['CLOSED', 'REOPENED'],
    CLOSED: ['REOPENED'],
    REOPENED: ['ASSIGNED', 'IN_PROGRESS'],
    CANCELLED: [],
    FAILED: [],
};

/**
 * 1. Tiếp nhận và mở phiếu bảo hành (Việc 32)
 * Ràng buộc: Phiếu gắn chính xác với khách hàng, đơn hàng và lần lắp đặt (nếu có).
 * Bắt buộc đơn hàng phải hoàn tất nghiệm thu và bàn giao (order_status === 'COMPLETED').
 * Tuyệt đối không can thiệp vào giá trị đơn hàng, giao dịch cọc hay doanh thu.
 */
export async function createWarrantyTicket(
    companyId: string,
    input: CreateWarrantyTicketInput,
    overrideAdminClient?: OperationsClient,
    actorId?: string
): Promise<WarrantyTicketDTO> {
    const admin = overrideAdminClient || createAdminClient();

    const ticket = await operationsRpc(admin, 'create_warranty_ticket_atomic', {
        p_company_id: companyId,
        p_actor_id: actorId,
        p_customer_id: input.customerId,
        p_order_id: input.orderId,
        p_installation_id: input.installationId || null,
        p_issue: input.issue,
        p_notes: input.notes || null,
    });

    return {
        id: ticket.id,
        companyId: ticket.company_id,
        customerId: ticket.customer_id,
        orderId: ticket.order_id,
        installationId: ticket.installation_id,
        issue: ticket.issue,
        status: ticket.status as WarrantyTicketStatus,
        assignedTo: ticket.assigned_to,
        openedAt: ticket.opened_at,
        resolvedAt: ticket.resolved_at,
        notes: ticket.notes,
        createdAt: ticket.created_at,
        updatedAt: ticket.updated_at,
    };
}

export async function assignWarrantyTicket(companyId: string,input: AssignWarrantyTicketInput,overrideAdminClient?: OperationsClient,actor?: OperationsActor): Promise<void> {
 await operationsRpc(overrideAdminClient || createAdminClient(),'update_warranty_status_atomic',{p_company_id:companyId,p_ticket_id:input.ticketId,p_actor_id:actor?.userId,p_actor_role:actor?.role,p_operation:'assign',p_technician_id:input.technicianId});
}
export async function updateWarrantyStatus(companyId: string,input: UpdateWarrantyStatusInput,overrideAdminClient?: OperationsClient,actor?: OperationsActor): Promise<void> {
 await operationsRpc(overrideAdminClient || createAdminClient(),'update_warranty_status_atomic',{p_company_id:companyId,p_ticket_id:input.ticketId,p_actor_id:actor?.userId,p_actor_role:actor?.role,p_operation:'update',p_status:input.status,p_notes:input.notes});
}
export async function reopenWarrantyTicket(companyId: string,input: ReopenWarrantyTicketInput,overrideAdminClient?: OperationsClient,actor?: OperationsActor): Promise<void> {
 await operationsRpc(overrideAdminClient || createAdminClient(),'update_warranty_status_atomic',{p_company_id:companyId,p_ticket_id:input.ticketId,p_actor_id:actor?.userId,p_actor_role:actor?.role,p_operation:'reopen',p_notes:input.reason});
}
