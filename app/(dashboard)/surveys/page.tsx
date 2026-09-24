import React from 'react';
import { redirect } from 'next/navigation';
import { getActorContext } from '../../../lib/auth/context';
import { fetchSurveyListPageData } from '../../../features/survey/services/survey-data.service';
import SurveyListClient from './SurveyListClient';

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

  if (actor.role !== 'TECHNICIAN' && actor.role !== 'BOSS_ADMIN') redirect('/field');

  const items = await fetchSurveyListPageData({
    userId: actor.userId,
    companyId: actor.companyId,
    role: actor.role,
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
