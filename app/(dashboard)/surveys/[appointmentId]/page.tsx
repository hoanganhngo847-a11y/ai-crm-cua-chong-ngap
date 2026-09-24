import React from 'react';
import { canAccessSurvey } from '../../../../features/survey/constants/access';
import { redirect, notFound } from 'next/navigation';
import { getActorContext } from '../../../../lib/auth/context';
import { fetchSurveyDetailPageData } from '../../../../features/survey/services/survey-data.service';
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

  const data = await fetchSurveyDetailPageData(appointmentId);
  if (!data || !data.appointment) {
    notFound();
  }

  const actor = await getActorContext(data.appointment.company_id);
  if (!canAccessSurvey(actor, data.appointment)) redirect('/surveys');

  return (
    <div className="w-full">
      <SurveyMeasurementDetailClient
        appointment={data.appointment}
        customer={data.customer}
      />
    </div>
  );
}
