import { redirect } from 'next/navigation';
import { getActorContext } from '../lib/auth/context';
import { APPLICATION_ROLES } from '../shared/constants/roles';

export default async function HomePage() {
  const actor = await getActorContext();

  if (!actor || actor.profileStatus !== 'ACTIVE' || !actor.companyId) {
    redirect('/login');
  }

  if (
    actor.role === APPLICATION_ROLES.BOSS_ADMIN ||
    actor.role === APPLICATION_ROLES.SALE
  ) {
    redirect('/inbox');
  }

  if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
    redirect('/account');
  }

  redirect('/crm');
}
