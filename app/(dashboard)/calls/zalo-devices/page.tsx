import { recordingActor } from '../../../../features/zalo-recordings/access';
import { getActorContext } from '../../../../lib/auth/context';
import { notFound, redirect } from 'next/navigation';
import DeviceManager from './DeviceManager';
export const dynamic = 'force-dynamic';
export default async function ZaloDevicesPage() {
  const actor = await getActorContext();
  if (!actor || actor.profileStatus !== 'ACTIVE' || actor.membershipStatus !== 'ACTIVE') redirect('/login');
  if (actor.role !== 'BOSS_ADMIN') notFound();
  if (process.env.NODE_ENV === 'production' && actor.aal !== 'aal2') redirect('/admin/mfa/verify');
  await recordingActor(true);
  return <div className="space-y-4"><h1 className="text-2xl font-semibold">Thiết bị ghi âm Zalo</h1><DeviceManager /></div>;
}
