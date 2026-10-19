import 'server-only';
import { createAdminClient } from '../../../lib/supabase/admin';
import { resolveCompanyVoiceIntegration } from './integration-resolver';
import { toStringeeTestUserIds } from '../providers/stringee-provider';
import { ServerAuthError } from '../../../lib/server-auth/errors';

/** Fail closed on a test project, explicit customer registration and recording-off policy. */
export async function resolveBrowserBusinessTest(companyId: string, actorId: string, customerId: string) {
  const integration = await resolveCompanyVoiceIntegration(companyId, 'STRINGEE');
  if (!process.env.STRINGEE_APP_TO_APP_TEST_PROJECT_ID ||
      integration?.providerAccountId !== process.env.STRINGEE_APP_TO_APP_TEST_PROJECT_ID ||
      !integration.apiKey || !integration.apiSecret || process.env.VOICE_RECORDING_ENABLED === 'true') {
    throw new ServerAuthError('Chế độ thử cuộc gọi nghiệp vụ chưa được bật.', 403, 'RESOURCE_FORBIDDEN');
  }
  const { data, error } = await createAdminClient().from('voice_test_customers')
    .select('customer_id').eq('customer_id', customerId).eq('integration_id', integration.integrationId).maybeSingle();
  if (error || !data) throw new ServerAuthError('Khách hàng chưa được đăng ký cho Voice test.', 403, 'RESOURCE_FORBIDDEN');
  return { integrationId: integration.integrationId, ...toStringeeTestUserIds(actorId, companyId) };
}
