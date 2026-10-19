import { notFound } from 'next/navigation';
import { getActorContext, requireBossAdmin } from '../../../../lib/auth/context';
import { resolveCompanyVoiceIntegration } from '../../../../features/voice/services/integration-resolver';
import { createAdminClient } from '../../../../lib/supabase/admin';
import { authorizeCustomerAccess } from '../../../../lib/server-auth/resource-access';
import { resolveBrowserBusinessTest } from '../../../../features/voice/services/browser-business-test';
import VoiceSdkTest from './VoiceSdkTest';

export default async function VoiceSdkTestPage({ searchParams }: { searchParams: Promise<{ customerId?: string; side?: string }> }) {
  const actor = await getActorContext();
  if (!actor?.companyId || actor.role !== 'BOSS_ADMIN') notFound();
  await requireBossAdmin(actor.companyId);
  const integration = await resolveCompanyVoiceIntegration(actor.companyId, 'STRINGEE');
  if (!process.env.STRINGEE_APP_TO_APP_TEST_PROJECT_ID ||
      integration?.providerAccountId !== process.env.STRINGEE_APP_TO_APP_TEST_PROJECT_ID) notFound();
  const { customerId, side } = await searchParams;
  if (side !== undefined && side !== 'A' && side !== 'B') notFound();
  let customer: { id: string; name: string; customer_code: string } | undefined;
  if (customerId) {
    const authorized = await authorizeCustomerAccess(customerId, 'CLICK_TO_CALL');
    if (authorized.customer.company_id !== actor.companyId) notFound();
    await resolveBrowserBusinessTest(actor.companyId, actor.userId, customerId);
    customer = authorized.customer;
  }
  const { data: registered } = await createAdminClient().from('voice_test_customers')
    .select('customer_id').eq('integration_id', integration!.integrationId);
  return <VoiceSdkTest customer={customer} clientSide={customer ? (side === 'B' ? 'B' : 'A') : undefined} testCustomerIds={(registered || []).map(row => row.customer_id)} />;
}
