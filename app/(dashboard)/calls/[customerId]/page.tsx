import React from 'react';
import Link from 'next/link';
import { authorizeCustomerAccess } from '../../../../lib/server-auth/resource-access';
import { resolveBrowserBusinessTest } from '../../../../features/voice/services/browser-business-test';
import { redirect, notFound } from 'next/navigation';
import { getActorContext } from '../../../../lib/auth/context';
import { getCallHistoryAction, getContactCycleStatusAction } from '../../../actions/voice';
import CallHistoryTable from '../components/CallHistoryTable';
import CallToCustomerButton from '../components/CallToCustomerButton';
import ZaloCallButton from '../components/ZaloCallButton';
import ZaloRecordingHistory from '../components/ZaloRecordingHistory';
import { PageHeader } from '../../../../components/ui/page-header';
import { EmptyState } from '../../../../components/ui/empty-state';
import { Button } from '../../../../components/ui/button';
import { Card } from '../../../../components/ui/card';
import { TestTube } from 'lucide-react';

interface Props {
  params: Promise<{ customerId: string }>;
}

export default async function CustomerCallsPage({ params }: Props) {
  const { customerId } = await params;
  const actor = await getActorContext();

  if (!actor || actor.profileStatus !== 'ACTIVE') {
    redirect('/login');
  }

  if (!actor.companyId || actor.membershipStatus !== 'ACTIVE') {
    redirect('/login');
  }

  if (actor.role === 'TECHNICIAN') {
    return (
      <EmptyState
        type="permission"
        title="Truy Cập Bị Từ Chối"
        description="Kỹ thuật viên không có quyền xem lịch sử cuộc gọi."
        action={{
          label: 'Về trang Hiện trường',
          href: '/field',
        }}
      />
    );
  }

  const isBossAdmin = actor.role === 'BOSS_ADMIN';

  const [historyResult, _cycleResult] = await Promise.all([
    getCallHistoryAction({ customerId, page: 1, pageSize: 20 }),
    getContactCycleStatusAction({ customerId }),
  ]);

  if (!historyResult.success && historyResult.error?.includes('RESOURCE_NOT_FOUND')) {
    notFound();
  }

  const { customer } = await authorizeCustomerAccess(customerId, 'CLICK_TO_CALL');
  if (customer.company_id !== actor.companyId) notFound();

  let businessTestEnabled = false;
  if (isBossAdmin) {
    try {
      await resolveBrowserBusinessTest(actor.companyId, actor.userId, customerId);
      businessTestEnabled = true;
    } catch {
      // Not registered test
    }
  }

  const customerName = customer.name;
  const customerCode = customer.customer_code;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        title={customerName}
        description={`Lịch sử cuộc gọi, chu kỳ liên hệ và ghi âm Zalo của khách hàng ${customerCode ? `[${customerCode}]` : ''}`}
        breadcrumbs={[
          { label: 'Cuộc gọi', href: '/calls' },
          { label: customerName, isCurrent: true },
        ]}
        primaryAction={
          (actor.role === 'BOSS_ADMIN' || actor.role === 'SALE') ? (
            <div className="flex items-center gap-2">
              <ZaloCallButton
                customerId={customerId}
                customerName={customerName}
              />
              <CallToCustomerButton
                customerId={customerId}
                customerCode={customerCode}
                customerName={customerName}
                provider={process.env.NEXT_PUBLIC_VOICE_PROVIDER || 'MANUAL'}
              />
            </div>
          ) : undefined
        }
        secondaryActions={
          businessTestEnabled ? (
            <Link href={`/calls/test?customerId=${customerId}`}>
              <Button variant="outline" size="sm" leftIcon={<TestTube className="w-3.5 h-3.5" />}>
                Thử Web SDK (Client B)
              </Button>
            </Link>
          ) : undefined
        }
      />

      {/* Zalo Recordings for this customer */}
      <ZaloRecordingHistory customerId={customerId} />

      {/* Call History Table */}
      {historyResult.success && historyResult.data ? (
        <CallHistoryTable
          initialItems={historyResult.data.items}
          total={historyResult.data.total}
          currentPage={historyResult.data.page}
          pageSize={historyResult.data.pageSize}
          isBossAdmin={isBossAdmin}
        />
      ) : (
        <Card className="p-8">
          <EmptyState
            type="error"
            title="Không thể tải lịch sử cuộc gọi"
            description={historyResult.error || 'Đã xảy ra lỗi khi tải dữ liệu cuộc gọi.'}
          />
        </Card>
      )}
    </div>
  );
}
