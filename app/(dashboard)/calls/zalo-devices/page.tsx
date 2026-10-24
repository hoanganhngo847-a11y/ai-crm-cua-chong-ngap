import { recordingActor } from '../../../../features/zalo-recordings/access';
import { getActorContext } from '../../../../lib/auth/context';
import { notFound, redirect } from 'next/navigation';
import DeviceManager from './DeviceManager';
import { PageHeader } from '@/components/ui/page-header';

export const dynamic = 'force-dynamic';

export default async function ZaloDevicesPage() {
  const actor = await getActorContext();
  if (!actor || actor.profileStatus !== 'ACTIVE' || actor.membershipStatus !== 'ACTIVE') redirect('/login');
  if (actor.role !== 'BOSS_ADMIN') notFound();
  if (process.env.NODE_ENV === 'production' && actor.aal !== 'aal2') redirect('/admin/mfa/verify');
  await recordingActor(true);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Cuộc gọi & Zalo', href: '/calls' },
          { label: 'Thiết bị ghi âm' },
        ]}
        title="Thiết bị ghi âm Zalo"
        description="Quản lý và cấp quyền thiết bị ghi âm Zalo Personal cho từng máy Mac của nhân sự."
      />
      <DeviceManager />
    </div>
  );
}
