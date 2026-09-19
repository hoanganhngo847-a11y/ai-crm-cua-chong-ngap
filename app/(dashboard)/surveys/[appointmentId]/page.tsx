import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { getActorContext } from '../../../../lib/auth/context';
import { createAdminClient } from '../../../../lib/supabase/admin';
import SurveyMeasurementDetailClient from './SurveyMeasurementDetailClient';

interface Props {
  params: Promise<{
    appointmentId: string;
  }>;
}

export const metadata = {
  title: 'Nhập Số Đo Khảo Sát Hiện Trường | AI CRM Cửa Chống Ngập',
  description: 'Biểu mẫu nhập số đo kỹ thuật và điều kiện hiện trường cho kỹ thuật viên.',
};

export default async function SurveyMeasurementDetailPage({ params }: Props) {
  const { appointmentId } = await params;
  const actor = await getActorContext();

  if (!actor || actor.profileStatus !== 'ACTIVE') {
    redirect('/login');
  }

  const adminClient = createAdminClient();

  // 1. Fetch appointment
  const { data: appointment, error } = await adminClient
    .from('appointments')
    .select('id, company_id, customer_id, assignee_id, type, address, start_time, status')
    .eq('id', appointmentId)
    .maybeSingle();

  if (error || !appointment) {
    notFound();
  }

  // 2. Enforce company boundary
  if (appointment.company_id !== actor.companyId) {
    redirect('/surveys');
  }

  // 3. Enforce technician assignment
  if (actor.role === 'TECHNICIAN' && appointment.assignee_id !== actor.userId) {
    redirect('/surveys');
  }

  // 4. Fetch customer details (STRICT PII: Name + Code ONLY, Zero Phone)
  const { data: customer } = await adminClient
    .from('customers')
    .select('id, customer_code, name')
    .eq('id', appointment.customer_id)
    .maybeSingle();

  const safeCustomer = {
    id: appointment.customer_id,
    customer_code: customer?.customer_code || 'KH-UNKNOWN',
    name: customer?.name || 'Khách hàng',
  };

  return (
    <div className="w-full">
      <SurveyMeasurementDetailClient
        appointment={appointment}
        customer={safeCustomer}
      />
    </div>
  );
}
