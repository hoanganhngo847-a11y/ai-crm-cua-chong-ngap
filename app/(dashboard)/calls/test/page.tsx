import { notFound } from 'next/navigation';
import { getActorContext, requireBossAdmin } from '../../../../lib/auth/context';
import { resolveCompanyVoiceIntegration } from '../../../../features/voice/services/integration-resolver';
import VoiceSdkTest from './VoiceSdkTest';

export default async function VoiceSdkTestPage() {
  const actor = await getActorContext();
  if (!actor?.companyId || actor.role !== 'BOSS_ADMIN') notFound();
  await requireBossAdmin(actor.companyId);
  const integration = await resolveCompanyVoiceIntegration(actor.companyId, 'STRINGEE');
  if (!process.env.STRINGEE_APP_TO_APP_TEST_PROJECT_ID ||
      integration?.providerAccountId !== process.env.STRINGEE_APP_TO_APP_TEST_PROJECT_ID) notFound();
  return <VoiceSdkTest />;
}
