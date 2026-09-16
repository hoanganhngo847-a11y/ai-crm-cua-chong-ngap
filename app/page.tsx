import { redirect } from 'next/navigation';
import { getActorContext } from '../lib/auth/context';
import { APPLICATION_ROLES } from '../shared/constants/roles';

export default async function HomePage() {
  const actor = await getActorContext();

  if (!actor || actor.profileStatus !== 'ACTIVE' || !actor.companyId) {
    redirect('/login');
  }

  if (actor.role === APPLICATION_ROLES.BOSS_ADMIN) {
    redirect('/admin');
  }

  if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
    redirect('/field');
  }

  redirect('/crm');
}
