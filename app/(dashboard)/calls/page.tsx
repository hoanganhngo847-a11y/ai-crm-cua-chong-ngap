import React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getActorContext } from '../../../lib/auth/context';
import { getCompanyCallHistoryAction } from '../../actions/voice';
import CallHistoryTable from './components/CallHistoryTable';
import CustomerCallSearch from './components/CustomerCallSearch';
import ZaloRecordingHistory from './components/ZaloRecordingHistory';
import { PageHeader } from '../../../components/ui/page-header';
import { EmptyState } from '../../../components/ui/empty-state';
import { Button } from '../../../components/ui/button';
import { Card } from '../../../components/ui/card';
import { Smartphone, TestTube } from 'lucide-react';

export default async function CallsPage() {
  const actor = await getActorContext();

  if (!actor || actor.profileStatus !== 'ACTIVE') {
    redirect('/login');
  }

  if (!actor.companyId || actor.membershipStatus !== 'ACTIVE') {
    redirect('/login');
  }

  // TECHNICIAN không có quyền xem trang này
  if (actor.role === 'TECHNICIAN') {
    return (
      <EmptyState
        type="permission"
        title="Truy Cập Bị Từ Chối"
        description="Kỹ thuật viên không có quyền xem lịch sử cuộc gọi trong hệ thống."
        action={{
          label: 'Về trang Hiện trường',
          href: '/field',
        }}
      />
    );
  }

  const isBossAdmin = actor.role === 'BOSS_ADMIN';
  const result = await getCompanyCallHistoryAction({ page: 1, pageSize: 20 });

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        title="Lịch Sử Cuộc Gọi & Ghi Âm"
        description={
          isBossAdmin
            ? 'Toàn bộ cuộc gọi — AI gọi ra, Hotline gọi vào, Sale gọi khách.'
            : 'Cuộc gọi trong hệ thống — tìm khách và bấm GỌI KHÁCH để liên hệ.'
        }
        breadcrumbs={[
          { label: 'CRM', href: '/crm' },
          { label: 'Cuộc gọi & Ghi âm', isCurrent: true },
        ]}
        secondaryActions={
          isBossAdmin ? (
            <div className="flex items-center gap-2">
              <Link href="/calls/zalo-devices">
                <Button variant="outline" size="sm" leftIcon={<Smartphone className="w-3.5 h-3.5" />}>
                  Thiết bị Zalo
                </Button>
              </Link>
              {process.env.STRINGEE_APP_TO_APP_TEST_PROJECT_ID && (
                <Link href="/calls/test">
                  <Button variant="outline" size="sm" leftIcon={<TestTube className="w-3.5 h-3.5" />}>
                    Kiểm tra Web SDK
                  </Button>
                </Link>
              )}
            </div>
          ) : undefined
        }
      />

      {/* Customer Call Search */}
      <CustomerCallSearch provider={(process.env.VOICE_PROVIDER || 'MANUAL').toUpperCase()} />

      {/* Zalo Recordings */}
      <ZaloRecordingHistory />

      {/* Company Call History Table */}
      {result.success && result.data ? (
        <CallHistoryTable
          initialItems={result.data.items}
          total={result.data.total}
          currentPage={result.data.page}
          pageSize={result.data.pageSize}
          isBossAdmin={isBossAdmin}
        />
      ) : (
        <Card className="p-8">
          <EmptyState
            type="error"
            title="Không thể tải lịch sử cuộc gọi"
            description={result.error || 'Đã xảy ra lỗi khi truy vấn dữ liệu.'}
          />
        </Card>
      )}
    </div>
  );
}
