import React from 'react';
import { redirect } from 'next/navigation';
import { getActorContext } from '../../../lib/auth/context';
import { APPLICATION_ROLES } from '../../../shared/constants/roles';
import InboxView from '../../../features/inbox/components/inbox-view';

export const metadata = {
  title: 'Hộp thư tích hợp | AI CRM Cửa Chống Ngập',
  description: 'Quản lý hội thoại đa kênh Zalo OA và Facebook Messenger tập trung cho Sale và AI CRM',
};

interface InboxPageProps {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function InboxPage({ searchParams }: InboxPageProps) {
  const actor = await getActorContext();

  if (!actor || actor.profileStatus !== 'ACTIVE') {
    redirect('/login');
  }

  // Chỉ SALE và BOSS_ADMIN được truy cập Hộp thư đa kênh (403 với TECHNICIAN và các vai trò khác)
  if (actor.role !== APPLICATION_ROLES.BOSS_ADMIN && actor.role !== APPLICATION_ROLES.SALE) {
    return (
      <div className="p-8 max-w-xl mx-auto text-center space-y-4">
        <div className="w-16 h-16 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-400 flex items-center justify-center mx-auto">
          <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-white">Truy Cập Bị Từ Chối</h2>
        <p className="text-sm text-slate-400">
          Tài khoản của bạn mang vai trò{' '}
          <strong className="text-slate-200">
            {actor.role === APPLICATION_ROLES.TECHNICIAN ? 'KỸ THUẬT VIÊN' : actor.role}
          </strong>. Hộp thư tích hợp đa kênh dành riêng cho Chuyên viên Sale và Ban quản trị để tư vấn khách hàng.
          {actor.role === APPLICATION_ROLES.TECHNICIAN && (
            <span>
              {' '}Vui lòng truy cập{' '}
              <a href="/field" className="text-blue-400 underline hover:text-blue-300">
                Hiện trường &amp; Khảo sát
              </a>.
            </span>
          )}
        </p>
      </div>
    );
  }

  const resolvedParams = searchParams ? await searchParams : undefined;
  const initialCustomerId =
    typeof resolvedParams?.customer_id === 'string' ? resolvedParams.customer_id : null;

  return (
    <div className="inbox-page-scroll-scope">
      <InboxView
        userRole={actor.role}
        userFullName={actor.fullName}
        initialCustomerId={initialCustomerId}
      />
      <style>{`
        /* Prevent scrollIntoView() in the chat stream from moving hidden parent containers. */
        .inbox-page-scroll-scope > div:first-child {
          overflow: clip;
        }

        .inbox-page-scroll-scope > div:first-child > div:nth-child(2) {
          min-height: 0;
          overflow: clip;
        }

        .inbox-page-scroll-scope > div:first-child > div:nth-child(2) > div {
          min-height: 0;
        }
      `}</style>
    </div>
  );
}
