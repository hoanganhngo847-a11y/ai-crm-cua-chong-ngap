import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '../../../lib/supabase/server';
import type {
  Appointment,
  AppointmentFilters,
  AppointmentStatus,
  CreateAppointmentInput,
  SafeAssignee,
  SafeCustomer,
  UpdateAppointmentInput,
} from '../types/appointment';

/**
 * Maps application / UI appointment statuses to database canonical check constraint values.
 * Database constraint: status IN ('ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'REJECTED')
 */
export function toDbStatus(status?: AppointmentStatus): string {
  if (!status || status === 'SCHEDULED') {
    return 'ASSIGNED';
  }
  return status;
}

/**
 * Maps database canonical status to application workflow status.
 * 'ASSIGNED' and 'ACCEPTED' represent scheduled work before technician initiates site progress.
 */
export function fromDbStatus(status: string): AppointmentStatus {
  if (status === 'ASSIGNED' || status === 'ACCEPTED') {
    return 'SCHEDULED';
  }
  return status as AppointmentStatus;
}

/**
 * Normalizes raw appointment row and joins safe customer & assignee data.
 * CRITICAL SECURITY INVARIANT:
 * Guarantees zero phone number leakage. Only Customer Name, Code, and Address are exposed.
 */
function formatAppointment(
  row: {
    id: string;
    company_id: string;
    customer_id: string;
    assignee_id: string;
    type: string;
    address: string;
    start_time: string;
    status: string;
    created_at: string;
    updated_at: string;
  },
  safeCustomer?: SafeCustomer,
  safeAssignee?: SafeAssignee
): Appointment {
  return {
    id: row.id,
    company_id: row.company_id,
    customer_id: row.customer_id,
    assignee_id: row.assignee_id,
    type: row.type as 'SURVEY' | 'INSTALLATION',
    address: row.address,
    appointment_date: row.start_time,
    start_time: row.start_time,
    status: fromDbStatus(row.status),
    created_at: row.created_at,
    updated_at: row.updated_at,
    customer: safeCustomer,
    assignee: safeAssignee,
  };
}

/**
 * Resolves Supabase client (injected or default server client).
 */
async function resolveClient(client?: SupabaseClient): Promise<SupabaseClient> {
  if (client) return client;
  return await createServerClient();
}

/**
 * Verifies that the designated assignee:
 * 1. Exists in public.user_profiles with status === 'ACTIVE'.
 * 2. Has an active membership in public.company_members with:
 *    - company_id === targetCompanyId
 *    - role === 'TECHNICIAN'
 *    - status === 'ACTIVE'
 * Throws "Người được phân công phải là kỹ thuật viên đang hoạt động thuộc cùng công ty." if invalid.
 */
export async function verifyActiveCompanyTechnician(
  assigneeId: string,
  targetCompanyId: string,
  supabase: SupabaseClient
): Promise<{ id: string; full_name: string }> {
  if (!assigneeId) {
    throw new Error('Kỹ thuật viên phụ trách (assignee_id) là bắt buộc.');
  }

  // 1. Verify user profile exists and is ACTIVE
  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('id, full_name, status')
    .eq('id', assigneeId)
    .maybeSingle();

  if (profileError || !profile) {
    throw new Error('Người được phân công phải là kỹ thuật viên đang hoạt động thuộc cùng công ty.');
  }

  if (profile.status !== 'ACTIVE') {
    throw new Error('Người được phân công phải là kỹ thuật viên đang hoạt động thuộc cùng công ty.');
  }

  // 2. Verify membership in company_members: role === 'TECHNICIAN' and status === 'ACTIVE' in targetCompanyId
  const { data: membership, error: memberError } = await supabase
    .from('company_members')
    .select('id, user_id, company_id, role, status')
    .eq('user_id', assigneeId)
    .eq('company_id', targetCompanyId)
    .maybeSingle();

  if (memberError || !membership) {
    throw new Error('Người được phân công phải là kỹ thuật viên đang hoạt động thuộc cùng công ty.');
  }

  if (membership.role !== 'TECHNICIAN') {
    throw new Error('Người được phân công phải là kỹ thuật viên đang hoạt động thuộc cùng công ty.');
  }

  if (membership.status !== 'ACTIVE') {
    throw new Error('Người được phân công phải là kỹ thuật viên đang hoạt động thuộc cùng công ty.');
  }

  return {
    id: profile.id,
    full_name: profile.full_name,
  };
}

/**
 * Creates a new survey appointment linked to customer_id and technician.
 *
 * Validations:
 * - Customer must exist in the database (resolves tenant company_id).
 * - Caller-provided input.company_id is IGNORED; derived strictly from customer.company_id.
 * - Assignee must be an ACTIVE TECHNICIAN in the same company.
 * - Address and valid appointment_date are required.
 * - Enforces data privacy: returns SafeCustomer (name, customer_code, address; NO PHONE).
 */
export async function createAppointment(
  input: CreateAppointmentInput,
  client?: SupabaseClient
): Promise<Appointment> {
  const supabase = await resolveClient(client);

  // 1. Validate inputs
  if (!input.customer_id) {
    throw new Error('Mã khách hàng (customer_id) là bắt buộc.');
  }
  if (!input.assignee_id) {
    throw new Error('Kỹ thuật viên phụ trách (assignee_id) là bắt buộc.');
  }
  if (!input.address || !input.address.trim()) {
    throw new Error('Địa chỉ khảo sát là bắt buộc.');
  }
  if (!input.appointment_date) {
    throw new Error('Thời gian khảo sát (appointment_date) là bắt buộc.');
  }

  const parsedDate = new Date(input.appointment_date);
  if (isNaN(parsedDate.getTime())) {
    throw new Error('Thời gian khảo sát (appointment_date) không hợp lệ.');
  }

  // 2. Fetch customer to verify existence and derive tenant company_id
  const { data: customer, error: customerError } = await supabase
    .from('customers')
    .select('id, company_id, customer_code, name')
    .eq('id', input.customer_id)
    .maybeSingle();

  if (customerError || !customer) {
    throw new Error('Không tìm thấy hồ sơ khách hàng.');
  }

  if (!customer.company_id) {
    throw new Error('Hồ sơ khách hàng không hợp lệ (thiếu company_id).');
  }

  // Luôn derive company_id trực tiếp từ customer, KHÔNG tin input.company_id
  const companyId = customer.company_id;

  // 3. Verify assignee: Bắt buộc là kỹ thuật viên đang hoạt động thuộc cùng công ty
  const assignee = await verifyActiveCompanyTechnician(input.assignee_id, companyId, supabase);

  // Enforce type: Chỉ hỗ trợ tạo lịch hẹn loại SURVEY trong phân hệ này
  if (input.type && input.type !== 'SURVEY') {
    throw new Error('Chỉ hỗ trợ tạo lịch hẹn loại SURVEY trong phân hệ này.');
  }

  const dbStatus = toDbStatus(input.status || 'SCHEDULED');
  if (dbStatus !== 'ASSIGNED') throw new Error('Lịch khảo sát mới phải ở trạng thái ASSIGNED.');

  // 4. Insert into appointments table (luôn gán cứng type: 'SURVEY')
  const { data: newAppointment, error: insertError } = await supabase
    .from('appointments')
    .insert({
      company_id: companyId,
      customer_id: customer.id,
      assignee_id: assignee.id,
      type: 'SURVEY',
      address: input.address.trim(),
      start_time: parsedDate.toISOString(),
      status: dbStatus,
    })
    .select(
      'id, company_id, customer_id, assignee_id, type, address, start_time, status, created_at, updated_at'
    )
    .single();

  if (insertError || !newAppointment) {
    throw new Error(
      `Không thể tạo lịch khảo sát: ${insertError?.message || 'Lỗi không xác định'}`
    );
  }

  const safeCustomer: SafeCustomer = {
    id: customer.id,
    customer_code: customer.customer_code,
    name: customer.name,
    address: newAppointment.address,
  };

  const safeAssignee: SafeAssignee = {
    id: assignee.id,
    full_name: assignee.full_name,
  };

  return formatAppointment(newAppointment, safeCustomer, safeAssignee);
}

/**
 * Updates an existing appointment.
 *
 * Constraints:
 * - customer_id and type are immutable.
 * - Cannot update appointments that have reached COMPLETED or CANCELLED terminal states.
 */
export async function updateAppointment(
  appointmentId: string,
  input: UpdateAppointmentInput,
  client?: SupabaseClient
): Promise<Appointment> {
  if (!appointmentId) {
    throw new Error('Mã lịch hẹn (appointmentId) không hợp lệ.');
  }

  const supabase = await resolveClient(client);

  // 1. Fetch current appointment state
  const { data: existing, error: fetchError } = await supabase
    .from('appointments')
    .select(
      'id, company_id, customer_id, assignee_id, type, address, start_time, status, created_at, updated_at'
    )
    .eq('id', appointmentId)
    .maybeSingle();

  if (fetchError || !existing) {
    throw new Error('Không tìm thấy lịch hẹn cần cập nhật.');
  }

  if (existing.status === 'COMPLETED') {
    throw new Error('Không thể chỉnh sửa lịch hẹn đã hoàn tất khảo sát.');
  }
  if (existing.status === 'CANCELLED') {
    throw new Error('Không thể chỉnh sửa lịch hẹn đã bị hủy.');
  }

  // 2. Prepare payload
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (input.address !== undefined) {
    const trimmed = input.address.trim();
    if (!trimmed) {
      throw new Error('Địa chỉ khảo sát không được để trống.');
    }
    updates.address = trimmed;
  }

  if (input.assignee_id !== undefined) {
    if (!input.assignee_id) {
      throw new Error('Mã kỹ thuật viên không hợp lệ.');
    }
    // Verify assignee: must be ACTIVE TECHNICIAN in the same company
    await verifyActiveCompanyTechnician(input.assignee_id, existing.company_id, supabase);
    updates.assignee_id = input.assignee_id;
  }

  if (input.appointment_date !== undefined) {
    const parsedDate = new Date(input.appointment_date);
    if (isNaN(parsedDate.getTime())) {
      throw new Error('Thời gian khảo sát (appointment_date) không hợp lệ.');
    }
    updates.start_time = parsedDate.toISOString();
  }

  if (input.status !== undefined) {
    const status = toDbStatus(input.status);
    if (!['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'CANCELLED', 'REJECTED'].includes(status)) {
      throw new Error('COMPLETED chỉ được ghi qua complete_survey_atomic.');
    }
    updates.status = status;
  }

  // 3. Execute update (Conditional write: chỉ cho phép cập nhật khi lịch hẹn chưa ở trạng thái terminal)
  const { data: updated, error: updateError } = await supabase
    .from('appointments')
    .update(updates)
    .eq('id', appointmentId)
    .in('status', ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'])
    .select(
      'id, company_id, customer_id, assignee_id, type, address, start_time, status, created_at, updated_at'
    )
    .maybeSingle();

  if (updateError || !updated) {
    throw new Error(
      `Không thể cập nhật lịch hẹn: ${updateError?.message || 'Lịch hẹn đã kết thúc hoặc trạng thái không hợp lệ'}`
    );
  }

  // 4. Fetch safe customer details (NO PHONE)
  const { data: customer } = await supabase
    .from('customers')
    .select('id, customer_code, name')
    .eq('id', updated.customer_id)
    .maybeSingle();

  // 5. Fetch safe assignee details
  const { data: assignee } = await supabase
    .from('user_profiles')
    .select('id, full_name')
    .eq('id', updated.assignee_id)
    .maybeSingle();

  const safeCustomer: SafeCustomer = {
    id: updated.customer_id,
    customer_code: customer?.customer_code || 'KH-UNKNOWN',
    name: customer?.name || 'Khách hàng',
    address: updated.address,
  };

  const safeAssignee: SafeAssignee = {
    id: updated.assignee_id,
    full_name: assignee?.full_name || 'Kỹ thuật viên',
  };

  return formatAppointment(updated, safeCustomer, safeAssignee);
}

/**
 * Assigns or reassigns an appointment to a technician.
 * Bắt buộc kiểm tra:
 * - Assignee tồn tại trong hệ thống với profile status === 'ACTIVE'.
 * - Assignee có role là 'TECHNICIAN' và membership status === 'ACTIVE' trong cùng company_id của lịch hẹn.
 */
export async function assignAppointment(
  appointmentId: string,
  assigneeId: string,
  client?: SupabaseClient
): Promise<Appointment> {
  return updateAppointment(appointmentId, { assignee_id: assigneeId }, client);
}

/**
 * Cancels an appointment.
 *
 * Constraints:
 * - Cannot cancel an appointment that is already COMPLETED.
 * - Idempotent: If already CANCELLED, returns current record.
 */
export async function cancelAppointment(
  appointmentId: string,
  _reason?: string,
  client?: SupabaseClient
): Promise<Appointment> {
  if (!appointmentId) {
    throw new Error('Mã lịch hẹn (appointmentId) không hợp lệ.');
  }

  const supabase = await resolveClient(client);

  const { data: existing, error: fetchError } = await supabase
    .from('appointments')
    .select(
      'id, company_id, customer_id, assignee_id, type, address, start_time, status, created_at, updated_at'
    )
    .eq('id', appointmentId)
    .maybeSingle();

  if (fetchError || !existing) {
    throw new Error('Không tìm thấy lịch hẹn để hủy.');
  }

  if (existing.status === 'COMPLETED') {
    throw new Error('Không thể hủy lịch hẹn đã hoàn thành khảo sát.');
  }

  if (existing.status === 'CANCELLED') {
    // Already cancelled, return formatted record
    const { data: customer } = await supabase
      .from('customers')
      .select('id, customer_code, name')
      .eq('id', existing.customer_id)
      .maybeSingle();

    const { data: assignee } = await supabase
      .from('user_profiles')
      .select('id, full_name')
      .eq('id', existing.assignee_id)
      .maybeSingle();

    return formatAppointment(
      existing,
      {
        id: existing.customer_id,
        customer_code: customer?.customer_code || 'KH-UNKNOWN',
        name: customer?.name || 'Khách hàng',
        address: existing.address,
      },
      {
        id: existing.assignee_id,
        full_name: assignee?.full_name || 'Kỹ thuật viên',
      }
    );
  }

  // Update status to CANCELLED (Conditional write: chỉ cho phép hủy khi status thuộc ASSIGNED, ACCEPTED, IN_PROGRESS)
  const { data: cancelled, error: cancelError } = await supabase
    .from('appointments')
    .update({
      status: 'CANCELLED',
      updated_at: new Date().toISOString(),
    })
    .eq('id', appointmentId)
    .in('status', ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'])
    .select(
      'id, company_id, customer_id, assignee_id, type, address, start_time, status, created_at, updated_at'
    )
    .maybeSingle();

  if (cancelError || !cancelled) {
    throw new Error(
      `Không thể hủy lịch hẹn: ${cancelError?.message || 'Lịch hẹn đã kết thúc hoặc trạng thái không hợp lệ'}`
    );
  }

  const { data: customer } = await supabase
    .from('customers')
    .select('id, customer_code, name')
    .eq('id', cancelled.customer_id)
    .maybeSingle();

  const { data: assignee } = await supabase
    .from('user_profiles')
    .select('id, full_name')
    .eq('id', cancelled.assignee_id)
    .maybeSingle();

  const safeCustomer: SafeCustomer = {
    id: cancelled.customer_id,
    customer_code: customer?.customer_code || 'KH-UNKNOWN',
    name: customer?.name || 'Khách hàng',
    address: cancelled.address,
  };

  const safeAssignee: SafeAssignee = {
    id: cancelled.assignee_id,
    full_name: assignee?.full_name || 'Kỹ thuật viên',
  };

  return formatAppointment(cancelled, safeCustomer, safeAssignee);
}

/**
 * Retrieves an appointment by ID with sanitized customer information.
 */
export async function getAppointmentById(
  appointmentId: string,
  client?: SupabaseClient
): Promise<Appointment | null> {
  if (!appointmentId) return null;

  const supabase = await resolveClient(client);

  const { data: row, error } = await supabase
    .from('appointments')
    .select(
      'id, company_id, customer_id, assignee_id, type, address, start_time, status, created_at, updated_at'
    )
    .eq('id', appointmentId)
    .maybeSingle();

  if (error || !row) return null;

  const { data: customer } = await supabase
    .from('customers')
    .select('id, customer_code, name')
    .eq('id', row.customer_id)
    .maybeSingle();

  const { data: assignee } = await supabase
    .from('user_profiles')
    .select('id, full_name')
    .eq('id', row.assignee_id)
    .maybeSingle();

  const safeCustomer: SafeCustomer = {
    id: row.customer_id,
    customer_code: customer?.customer_code || 'KH-UNKNOWN',
    name: customer?.name || 'Khách hàng',
    address: row.address,
  };

  const safeAssignee: SafeAssignee = {
    id: row.assignee_id,
    full_name: assignee?.full_name || 'Kỹ thuật viên',
  };

  return formatAppointment(row, safeCustomer, safeAssignee);
}

/**
 * Retrieves a list of appointments matching the specified filters.
 * Returns appointments with sanitized customer data (name, customer_code, address).
 */
export async function getAppointments(
  filters: AppointmentFilters = {},
  client?: SupabaseClient
): Promise<Appointment[]> {
  const supabase = await resolveClient(client);

  let query = supabase
    .from('appointments')
    .select(
      'id, company_id, customer_id, assignee_id, type, address, start_time, status, created_at, updated_at'
    );

  if (filters.company_id) {
    query = query.eq('company_id', filters.company_id);
  }
  if (filters.assignee_id) {
    query = query.eq('assignee_id', filters.assignee_id);
  }
  if (filters.customer_id) {
    query = query.eq('customer_id', filters.customer_id);
  }
  if (filters.from_date) {
    query = query.gte('start_time', filters.from_date);
  }
  if (filters.to_date) {
    query = query.lte('start_time', filters.to_date);
  }

  // Handle status filter mapping
  if (filters.status) {
    if (Array.isArray(filters.status)) {
      const dbStatuses = filters.status.map(toDbStatus);
      query = query.in('status', dbStatuses);
    } else if (filters.status === 'SCHEDULED') {
      query = query.in('status', ['ASSIGNED', 'ACCEPTED']);
    } else {
      query = query.eq('status', toDbStatus(filters.status));
    }
  }

  query = query.order('start_time', { ascending: true });

  const { data: rows, error } = await query;
  if (error || !rows || rows.length === 0) {
    return [];
  }

  // Extract unique customer IDs and assignee IDs for batch lookup
  const customerIds = Array.from(new Set(rows.map((r) => r.customer_id)));
  const assigneeIds = Array.from(new Set(rows.map((r) => r.assignee_id)));

  const [{ data: customers }, { data: assignees }] = await Promise.all([
    supabase
      .from('customers')
      .select('id, customer_code, name')
      .in('id', customerIds),
    supabase
      .from('user_profiles')
      .select('id, full_name')
      .in('id', assigneeIds),
  ]);

  const customerMap = new Map((customers || []).map((c) => [c.id, c]));
  const assigneeMap = new Map((assignees || []).map((a) => [a.id, a]));

  return rows.map((row) => {
    const cust = customerMap.get(row.customer_id);
    const asgn = assigneeMap.get(row.assignee_id);

    const safeCust: SafeCustomer = {
      id: row.customer_id,
      customer_code: cust?.customer_code || 'KH-UNKNOWN',
      name: cust?.name || 'Khách hàng',
      address: row.address,
    };

    const safeAsgn: SafeAssignee = {
      id: row.assignee_id,
      full_name: asgn?.full_name || 'Kỹ thuật viên',
    };

    return formatAppointment(row, safeCust, safeAsgn);
  });
}
