/**
 * Appointment Statuses for Survey Scheduling
 * Canonical statuses:
 * - SCHEDULED: Initial state when appointment is set with technician and customer
 * - IN_PROGRESS: Technician is on-site conducting the survey
 * - COMPLETED: Survey measurements and notes have been submitted
 * - CANCELLED: Appointment was cancelled
 *
 * Also includes database canonical statuses (ASSIGNED, ACCEPTED, REJECTED)
 * to maintain 100% interoperability with database CHECK constraints.
 */
export type AppointmentStatus =
  | 'SCHEDULED'
  | 'ASSIGNED'
  | 'ACCEPTED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'REJECTED';

export const APPOINTMENT_STATUSES = {
  SCHEDULED: 'SCHEDULED',
  ASSIGNED: 'ASSIGNED',
  ACCEPTED: 'ACCEPTED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
} as const;

/**
 * Privacy-Preserving Customer Information.
 *
 * CRITICAL SECURITY INVARIANT:
 * Per docs/PROJECT_MASTER.md (Section 14) and docs/DATA_CONTRACT.md (Section 12, 13 & 28):
 * Technicians / Survey form views must ONLY contain Customer Name, Customer Code (e.g. "KH-000123"), and Address.
 * Raw or normalized phone numbers are strictly prohibited from exposure.
 */
export interface SafeCustomer {
  id: string;
  customer_code: string;
  name: string;
  address?: string;
}

/**
 * Technician / Assignee Safe Profile
 */
export interface SafeAssignee {
  id: string;
  full_name: string;
  role?: string;
}

/**
 * Appointment Data Contract
 */
export interface Appointment {
  id: string;
  company_id: string;
  customer_id: string;
  assignee_id: string;
  type: 'SURVEY' | 'INSTALLATION';
  address: string;
  /**
   * ISO 8601 string representation of the appointment schedule.
   * Projections map directly to database column `start_time`.
   */
  appointment_date: string;
  start_time: string;
  status: AppointmentStatus;
  created_at: string;
  updated_at: string;
  /**
   * Privacy-sanitized customer record (Name, Code, Address ONLY - NO PHONE)
   */
  customer?: SafeCustomer;
  /**
   * Assigned technician / staff profile
   */
  assignee?: SafeAssignee;
}

/**
 * Input DTO for creating a new appointment
 */
export interface CreateAppointmentInput {
  customer_id: string;
  assignee_id: string;
  address: string;
  appointment_date: string; // ISO 8601 format e.g. "2026-09-20T09:00:00.000Z"
  type?: 'SURVEY' | 'INSTALLATION';
  status?: AppointmentStatus;
  company_id?: string;
}

/**
 * Input DTO for updating an existing appointment
 */
export interface UpdateAppointmentInput {
  assignee_id?: string;
  address?: string;
  appointment_date?: string;
  status?: AppointmentStatus;
}

/**
 * Filter parameters for querying appointments
 */
export interface AppointmentFilters {
  company_id?: string;
  assignee_id?: string;
  customer_id?: string;
  status?: AppointmentStatus | AppointmentStatus[];
  from_date?: string;
  to_date?: string;
}
