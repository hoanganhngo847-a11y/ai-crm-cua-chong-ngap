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
    overrideAdminClient?: OperationsClient
): Promise<WarrantyTicketDTO> {
    const admin = overrideAdminClient || createAdminClient();

    // Xác minh đơn hàng hợp lệ thuộc công ty
    const { data: order, error: orderErr } = await admin
        .from('orders')
        .select('id, customer_id, order_status')
        .eq('company_id', companyId)
        .eq('customer_id', input.customerId)
        .eq('id', input.orderId)
        .maybeSingle();

    if (orderErr || !order) {
        throw new Error('RESOURCE_NOT_FOUND: Không tìm thấy đơn hàng tương ứng với khách hàng để tạo bảo hành.');
    }

    if (order.order_status !== 'COMPLETED') {
        throw new Error(
            'INVALID_STATE_TRANSITION: Chỉ đơn hàng đã hoàn tất nghiệm thu và bàn giao (COMPLETED) mới đủ điều kiện mở phiếu bảo hành.'
        );
    }

    // Tự động tìm installation_id nếu chưa truyền vào
    let resolvedInstallationId = input.installationId || null;
    if (!resolvedInstallationId) {
        const { data: installRecord } = await admin
            .from('installations')
            .select('id')
            .eq('company_id', companyId)
            .eq('order_id', input.orderId)
            .maybeSingle();

        if (installRecord) {
            resolvedInstallationId = installRecord.id;
        }
    }

    const { data: ticket, error: insertErr } = await admin
        .from('warranty_tickets')
        .insert({
            company_id: companyId,
            customer_id: input.customerId,
            order_id: input.orderId,
            installation_id: resolvedInstallationId,
            issue: input.issue,
            status: 'OPEN' as WarrantyTicketStatus,
            assigned_to: null,
            notes: input.notes || null,
            opened_at: new Date().toISOString(),
        })
        .select()
        .single();

    if (insertErr || !ticket) {
        throw new Error('INVALID_STATE_TRANSITION: Tạo phiếu bảo hành thất bại.');
    }

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
