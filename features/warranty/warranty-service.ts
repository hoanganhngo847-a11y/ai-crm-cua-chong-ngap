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

export interface WarrantyDashboardTicketItem {
  id: string;
  customerId: string;
  customerName: string;
  customerCode: string;
  orderId: string;
  orderCode: string;
  installationId: string | null;
  issue: string;
  status: WarrantyTicketStatus;
  assignedTo: string | null;
  assignedTechnicianName: string | null;
  openedAt: string;
  resolvedAt: string | null;
  notes: string | null;
  createdAt: string;
}

export interface WarrantyEligibleOrder {
  id: string;
  code: string;
  customerId: string;
  customerName: string;
  customerCode: string;
}

export interface WarrantyTechnicianOption {
  userId: string;
  fullName: string;
}

export interface WarrantyDashboardData {
  tickets: WarrantyDashboardTicketItem[];
  eligibleOrders: WarrantyEligibleOrder[];
  technicians: WarrantyTechnicianOption[];
  role: string;
  userId: string;
}

export async function getWarrantyDashboardData(
  companyId: string,
  userId: string,
  role: string,
  overrideAdminClient?: OperationsClient
): Promise<WarrantyDashboardData> {
  const admin = overrideAdminClient || createAdminClient();

  // 1. Fetch tickets
  let ticketQuery = admin
    .from('warranty_tickets')
    .select(`
      id,
      customer_id,
      order_id,
      installation_id,
      issue,
      status,
      assigned_to,
      opened_at,
      resolved_at,
      notes,
      created_at,
      customers (
        name,
        customer_code
      ),
      orders (
        order_code
      )
    `)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });

  if (role === 'TECHNICIAN') {
    ticketQuery = ticketQuery.eq('assigned_to', userId);
  }

  const { data: rawTickets, error: ticketError } = await ticketQuery;
  if (ticketError) throw new Error('Không thể tải danh sách phiếu bảo hành');

  // Map technician user names if any
  const assignedIds = Array.from(
    new Set((rawTickets || []).map((t: Record<string, unknown>) => t.assigned_to as string | null).filter(Boolean))
  ) as string[];
  const techMap = new Map<string, string>();
  if (assignedIds.length > 0) {
    const { data: profiles } = await admin
      .from('user_profiles')
      .select('id, full_name')
      .in('id', assignedIds);
    (profiles || []).forEach((p: { id: string; full_name: string }) => techMap.set(p.id, p.full_name));
  }

  const tickets: WarrantyDashboardTicketItem[] = (rawTickets || []).map((t: Record<string, unknown>) => {
    const cust = t.customers as { name?: string; customer_code?: string } | null;
    const ord = t.orders as { order_code?: string } | null;
    const assigned = (t.assigned_to as string) || null;

    return {
      id: String(t.id),
      customerId: String(t.customer_id),
      customerName: cust?.name || 'Khách hàng',
      customerCode: cust?.customer_code || '',
      orderId: String(t.order_id),
      orderCode: ord?.order_code || '',
      installationId: (t.installation_id as string) || null,
      issue: String(t.issue || ''),
      status: t.status as WarrantyTicketStatus,
      assignedTo: assigned,
      assignedTechnicianName: assigned ? techMap.get(assigned) || 'Kỹ thuật viên' : null,
      openedAt: String(t.opened_at || ''),
      resolvedAt: (t.resolved_at as string) || null,
      notes: (t.notes as string) || null,
      createdAt: String(t.created_at || ''),
    };
  });

  // 2. Fetch eligible completed orders (for BOSS_ADMIN & SALE to create tickets)
  let eligibleOrders: WarrantyEligibleOrder[] = [];
  if (['BOSS_ADMIN', 'SALE'].includes(role)) {
    const { data: rawOrders } = await admin
      .from('orders')
      .select(`
        id,
        order_code,
        customer_id,
        customers (
          name,
          customer_code
        )
      `)
      .eq('company_id', companyId)
      .eq('order_status', 'COMPLETED')
      .order('created_at', { ascending: false });

    eligibleOrders = (rawOrders || []).map((o: Record<string, unknown>) => {
      const cust = o.customers as { name?: string; customer_code?: string } | null;
      return {
        id: String(o.id),
        code: String(o.order_code || ''),
        customerId: String(o.customer_id),
        customerName: cust?.name || 'Khách hàng',
        customerCode: cust?.customer_code || '',
      };
    });
  }

  // 3. Fetch technician options (for BOSS_ADMIN assignment)
  let technicians: WarrantyTechnicianOption[] = [];
  if (role === 'BOSS_ADMIN') {
    const { data: rawTechs } = await admin
      .from('company_members')
      .select(`
        user_id,
        user_profiles (
          id,
          full_name
        )
      `)
      .eq('company_id', companyId)
      .eq('role', 'TECHNICIAN')
      .eq('status', 'ACTIVE');

    technicians = (rawTechs || []).map((m: Record<string, unknown>) => {
      const prof = m.user_profiles as { full_name?: string } | null;
      return {
        userId: String(m.user_id),
        fullName: prof?.full_name || 'Kỹ thuật viên',
      };
    });
  }

  return {
    tickets,
    eligibleOrders,
    technicians,
    role,
    userId,
  };
}
