import React from 'react';
import { redirect } from 'next/navigation';
import { getActorContext } from '../../../lib/auth/context';
import { createAdminClient } from '../../../lib/supabase/admin';
import SurveyListClient, { type SurveyAppointmentItem } from './SurveyListClient';

export const metadata = {
  title: 'Lịch Khảo Sát Hiện Trường | AI CRM Cửa Chống Ngập',
  description: 'Quản lý lịch khảo sát đo đạc kỹ thuật dành cho Kỹ thuật viên.',
};

export default async function SurveysPage() {
  const actor = await getActorContext();

  if (!actor || actor.profileStatus !== 'ACTIVE') {
    redirect('/login');
  }

  if (!actor.companyId || actor.membershipStatus !== 'ACTIVE') {
    redirect('/field');
  }

  const adminClient = createAdminClient();

  // 1. Fetch appointments for SURVEY type within tenant boundary
  let query = adminClient
    .from('appointments')
    .select(
      'id, company_id, customer_id, assignee_id, type, address, start_time, status, created_at, updated_at'
    )
    .eq('type', 'SURVEY')
    .eq('company_id', actor.companyId);

  // If actor is a TECHNICIAN, only display appointments assigned to them
  if (actor.role === 'TECHNICIAN') {
    query = query.eq('assignee_id', actor.userId);
  }

  const { data: rows, error: appointmentsError } = await query.order('start_time', {
    ascending: true,
  });

  if (appointmentsError) {
    console.error('Error querying survey appointments:', appointmentsError);
  }

  const appointmentList = rows || [];

  // 2. Fetch customer info in batch (STRICT: Only Name, Customer Code - ZERO PHONE)
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

  const customerMap = new Map(
    (customerRows || []).map((c) => [c.id, { customer_code: c.customer_code, name: c.name }])
  );
  const assigneeMap = new Map(
    (assigneeRows || []).map((a) => [a.id, a.full_name || 'Kỹ thuật viên'])
  );

  // 3. Format into secure items
  const items: SurveyAppointmentItem[] = appointmentList.map((app) => {
    const cust = customerMap.get(app.customer_id);
    const assigneeName = assigneeMap.get(app.assignee_id) || 'Kỹ thuật viên';

    return {
      id: app.id,
      company_id: app.company_id,
      customer_id: app.customer_id,
      customer_name: cust?.name || 'Khách hàng',
      customer_code: cust?.customer_code || 'KH-UNKNOWN',
      address: app.address,
      start_time: app.start_time,
      status: app.status as SurveyAppointmentItem['status'],
      assignee_id: app.assignee_id,
      assignee_name: assigneeName,
    };
  });

  return (
    <div className="w-full">
      <SurveyListClient
        initialAppointments={items}
        currentUserId={actor.userId}
        userRole={actor.role || 'TECHNICIAN'}
        userName={actor.fullName || actor.email}
      />
    </div>
  );
}
