export type WarrantyTicketStatus =
    | 'OPEN'
    | 'ASSIGNED'
    | 'IN_PROGRESS'
    | 'RESOLVED'
    | 'CLOSED'
    | 'REOPENED'
    | 'CANCELLED'
    | 'FAILED';

export interface WarrantyTicketDTO {
    id: string;
    companyId: string;
    customerId: string;
    orderId: string;
    installationId: string | null;
    issue: string;
    status: WarrantyTicketStatus;
    assignedTo: string | null;
    openedAt: string;
    resolvedAt: string | null;
    notes: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface CreateWarrantyTicketInput {
    customerId: string;
    orderId: string;
    installationId?: string | null;
    issue: string;
    notes?: string | null;
}

export interface AssignWarrantyTicketInput {
    ticketId: string;
    technicianId: string;
}

export interface UpdateWarrantyStatusInput {
    ticketId: string;
    status: WarrantyTicketStatus;
    notes?: string;
}

export interface ReopenWarrantyTicketInput {
    ticketId: string;
    reason: string;
}