import 'server-only';

import { createAdminClient } from '../../../lib/supabase/admin';
import { ACTIVE_SURVEY_ASSIGNMENT_STATUSES } from '../constants/access';

export async function fetchSurveyListPageData(actor: {
  userId: string;
  companyId: string;
  role: string;
}) {
  const adminClient = createAdminClient();

  let query = adminClient
    .from('appointments')
    .select(
      'id, company_id, customer_id, assignee_id, type, address, start_time, status, created_at, updated_at'
    )
    .eq('type', 'SURVEY')
    .eq('company_id', actor.companyId);

  if (actor.role === 'TECHNICIAN') {
    query = query.eq('assignee_id', actor.userId).in('status', [...ACTIVE_SURVEY_ASSIGNMENT_STATUSES]);
  }

  const { data: rows, error: appointmentsError } = await query.order('start_time', {
    ascending: true,
  });

  if (appointmentsError) {
    console.error('Error querying survey appointments:', appointmentsError);
  }

  const appointmentList = rows || [];

  const customerIds = Array.from(new Set(appointmentList.map((a) => a.customer_id)));
  const assigneeIds = Array.from(new Set(appointmentList.map((a) => a.assignee_id)));

  const [{ data: customerRows }, { data: assigneeRows }] = await Promise.all([
    customerIds.length > 0
      ? adminClient
          .from('customers')
          .select('id, customer_code, name')
          .in('id', customerIds)
      : Promise.resolve({ data: [] }),
    assigneeIds.length > 0
      ? adminClient
          .from('user_profiles')
          .select('id, full_name')
          .in('id', assigneeIds)
      : Promise.resolve({ data: [] }),
  ]);

  const customerMap = new Map((customerRows || []).map((c) => [c.id, c]));
  const assigneeMap = new Map((assigneeRows || []).map((u) => [u.id, u.full_name]));

  return appointmentList.map((apt) => {
    const cust = customerMap.get(apt.customer_id);
    return {
      id: apt.id,
      company_id: apt.company_id,
      customer_id: apt.customer_id,
      customer_code: cust?.customer_code || 'KH-UNKNOWN',
      customer_name: cust?.name || 'Khách hàng',
      assignee_id: apt.assignee_id,
      assignee_name: assigneeMap.get(apt.assignee_id) || 'Chưa phân công',
      type: apt.type,
      address: apt.address,
      start_time: apt.start_time,
      status: apt.status,
    };
  });
}

export async function fetchSurveyDetailPageData(appointmentId: string) {
  const adminClient = createAdminClient();

  const { data: appointment, error } = await adminClient
    .from('appointments')
    .select('id, company_id, customer_id, assignee_id, type, address, start_time, status')
    .eq('id', appointmentId)
    .maybeSingle();

  if (error || !appointment) {
    return null;
  }

  const { data: customer } = await adminClient
    .from('customers')
    .select('id, customer_code, name')
    .eq('id', appointment.customer_id)
    .eq('company_id', appointment.company_id)
    .maybeSingle();

  const safeCustomer = {
    id: appointment.customer_id,
    customer_code: customer?.customer_code || 'KH-UNKNOWN',
    name: customer?.name || 'Khách hàng',
  };

  return {
    appointment,
    customer: safeCustomer,
  };
}
