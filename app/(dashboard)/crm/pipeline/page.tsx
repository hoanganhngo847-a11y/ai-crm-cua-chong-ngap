import React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getActorContext } from '../../../../lib/auth/context';
import { APPLICATION_ROLES } from '../../../../shared/constants/roles';
import CustomerPipelineBoard from '../../../../features/crm/components/customer-pipeline-board';
import { PageHeader } from '../../../../components/ui/page-header';
import { Button } from '../../../../components/ui/button';
import { ArrowLeft } from 'lucide-react';

export const metadata = {
  title: 'Phễu khách hàng 6 giai đoạn | AI CRM',
  description: 'Kanban và Funnel dùng chung một nguồn dữ liệu cho sáu giai đoạn khách hàng.',
};

export default async function CrmPipelinePage() {
  const actor = await getActorContext();

  if (!actor || actor.profileStatus !== 'ACTIVE') {
    redirect('/login');
  }

  if (actor.role !== APPLICATION_ROLES.BOSS_ADMIN && actor.role !== APPLICATION_ROLES.SALE) {
    redirect('/field');
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Phễu khách hàng"
        description="Chọn giai đoạn để cập nhật, kèm bằng chứng khi cần."
        secondaryActions={
          <Link href="/crm">
            <Button variant="outline" size="sm" leftIcon={<ArrowLeft className="w-3.5 h-3.5" />}>
              Về CRM tổng quan
            </Button>
          </Link>
        }
      />

      <CustomerPipelineBoard userRole={actor.role} />
    </div>
  );
}
