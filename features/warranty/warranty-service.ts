import 'server-only';
import { AuthError } from '../../lib/auth/context';
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
 * 1. Tiếp nhận và mở phiếu bảo hành (Việc 32)
 * Ràng buộc: Phiếu gắn chính xác với khách hàng, đơn hàng và lần lắp đặt (nếu có).
 * Bắt buộc đơn hàng phải hoàn tất nghiệm thu và bàn giao (order_status === 'COMPLETED').
 * Tuyệt đối không can thiệp vào giá trị đơn hàng, giao dịch cọc hay doanh thu.
 */
export async function createWarrantyTicket(
    companyId: string,
    input: CreateWarrantyTicketInput,
    overrideAdminClient?: any
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
        throw new Error('Không tìm thấy đơn hàng tương ứng với khách hàng để tạo bảo hành.');
    }

    if (order.order_status !== 'COMPLETED') {
        throw new Error(
            'Chỉ đơn hàng đã hoàn tất nghiệm thu và bàn giao (COMPLETED) mới đủ điều kiện mở phiếu bảo hành.'
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
        throw new Error(`Tạo phiếu bảo hành thất bại: ${insertErr?.message}`);
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

/**
 * 2. Phân công Kỹ thuật viên xử lý bảo hành (Việc 32)
 * Ràng buộc P1: technicianId phải tồn tại trong company_members với status = 'ACTIVE' và role = 'TECHNICIAN'.
 */
export async function assignWarrantyTicket(
    companyId: string,
    input: AssignWarrantyTicketInput,
    overrideAdminClient?: any
): Promise<void> {
    const admin = overrideAdminClient || createAdminClient();

    // Xác minh gán quyền Kỹ thuật viên (P1)
    const { data: member, error: memberErr } = await admin
        .from('company_members')
        .select('id, user_id, role, status')
        .eq('company_id', companyId)
        .eq('user_id', input.technicianId)
        .maybeSingle();

    if (memberErr || !member) {
        throw new Error('Kỹ thuật viên không tồn tại trong công ty.');
    }

    if (member.status !== 'ACTIVE' || member.role !== 'TECHNICIAN') {
        throw new Error('Chỉ được phân công cho nhân viên có vai trò TECHNICIAN đang hoạt động (ACTIVE).');
    }

    const { data: updated, error } = await admin
        .from('warranty_tickets')
        .update({
            assigned_to: input.technicianId,
            status: 'ASSIGNED' as WarrantyTicketStatus,
            updated_at: new Date().toISOString(),
        })
        .eq('company_id', companyId)
        .eq('id', input.ticketId)
        .select('id')
        .single();

    if (error || !updated) {
        throw new Error(`Phân công kỹ thuật viên bảo hành thất bại: ${error?.message || 'Không tìm thấy phiếu'}`);
    }
}

/**
 * 3. Cập nhật tiến độ xử lý bảo hành (Việc 32)
 * Ràng buộc P0: Nếu actor là TECHNICIAN, bắt buộc kiểm tra ticket.assigned_to === actor.userId.
 */
export async function updateWarrantyStatus(
    companyId: string,
    input: UpdateWarrantyStatusInput,
    overrideAdminClient?: any,
    actor?: { userId: string; role?: string | null }
): Promise<void> {
    const admin = overrideAdminClient || createAdminClient();

    // Giới hạn quyền TECHNICIAN: Chỉ được cập nhật ticket được phân công cho mình (P0)
    if (actor && actor.role === 'TECHNICIAN') {
        const { data: ticket, error: ticketErr } = await admin
            .from('warranty_tickets')
            .select('id, assigned_to')
            .eq('company_id', companyId)
            .eq('id', input.ticketId)
            .maybeSingle();

        if (ticketErr || !ticket) {
            throw new Error('Không tìm thấy phiếu bảo hành.');
        }

        if (ticket.assigned_to !== actor.userId) {
            throw new AuthError('Bạn không được phân công thực hiện phiếu bảo hành này', 403);
        }
    }

    const updatePayload: Record<string, unknown> = {
        status: input.status,
        updated_at: new Date().toISOString(),
    };

    if (input.status === 'RESOLVED' || input.status === 'CLOSED') {
        updatePayload.resolved_at = new Date().toISOString();
    }

    if (input.notes) {
        updatePayload.notes = input.notes;
    }

    const { data: updated, error } = await admin
        .from('warranty_tickets')
        .update(updatePayload)
        .eq('company_id', companyId)
        .eq('id', input.ticketId)
        .select('id')
        .single();

    if (error || !updated) {
        throw new Error(`Cập nhật trạng thái bảo hành thất bại: ${error?.message || 'Không tìm thấy phiếu'}`);
    }
}

/**
 * 4. Tái mở phiếu bảo hành khi phát sinh lỗi lại (Việc 32)
 * Ràng buộc P1 (State Machine): Chỉ cho phép reopenWarrantyTicket khi ticket đang ở trạng thái 'RESOLVED' hoặc 'CLOSED'.
 */
export async function reopenWarrantyTicket(
    companyId: string,
    input: ReopenWarrantyTicketInput,
    overrideAdminClient?: any
): Promise<void> {
    const admin = overrideAdminClient || createAdminClient();

    const { data: currentTicket, error: fetchErr } = await admin
        .from('warranty_tickets')
        .select('id, status, notes')
        .eq('company_id', companyId)
        .eq('id', input.ticketId)
        .single();

    if (fetchErr || !currentTicket) {
        throw new Error('Không tìm thấy phiếu bảo hành để mở lại.');
    }

    if (currentTicket.status !== 'RESOLVED' && currentTicket.status !== 'CLOSED') {
        throw new Error(
            `Không thể mở lại phiếu bảo hành ở trạng thái '${currentTicket.status}'. Chỉ cho phép mở lại khi phiếu đã ở trạng thái 'RESOLVED' hoặc 'CLOSED'.`
        );
    }

    const timestamp = new Date().toISOString();
    const appendNote = `\n[${timestamp}] REOPEN: ${input.reason}`;
    const updatedNotes = currentTicket.notes
        ? `${currentTicket.notes}${appendNote}`
        : appendNote.trim();

    const { data: updated, error } = await admin
        .from('warranty_tickets')
        .update({
            status: 'REOPENED' as WarrantyTicketStatus,
            resolved_at: null,
            notes: updatedNotes,
            updated_at: timestamp,
        })
        .eq('company_id', companyId)
        .eq('id', input.ticketId)
        .select('id')
        .single();

    if (error || !updated) {
        throw new Error(`Mở lại phiếu bảo hành thất bại: ${error?.message || 'Không tìm thấy phiếu'}`);
    }
}