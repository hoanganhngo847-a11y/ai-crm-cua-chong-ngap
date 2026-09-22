import 'server-only';
import type { CallProvider } from '../../../shared/contracts/sensitive';
import { MockAiCallProvider } from './mock-provider';
import { StringeeProvider } from './stringee-provider';
import { resolveCompanyVoiceIntegration } from '../services/integration-resolver';

export function resolveVoiceCallProvider(injected?: CallProvider): CallProvider {
  if (injected) return injected;

  const configured = process.env.VOICE_PROVIDER?.toUpperCase();
  if (configured === 'STRINGEE') {
    const apiKey = process.env.STRINGEE_API_KEY;
    const apiSecret = process.env.STRINGEE_API_SECRET;
    if (!apiKey || !apiSecret) throw new Error('Stringee credentials are not configured.');
    return new StringeeProvider(apiKey, apiSecret);
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('A production voice provider is not configured.');
  }
  return new MockAiCallProvider();
}

export async function resolveVoiceCallProviderForCompany(
  companyId: string,
  injected?: CallProvider
): Promise<CallProvider> {
  if (injected) return injected;
  const integration = await resolveCompanyVoiceIntegration(companyId, 'STRINGEE');
  if (!integration?.apiKey || !integration.apiSecret || !integration.fromNumber || !integration.answerUrl) {
    if (process.env.NODE_ENV !== 'production') return new MockAiCallProvider();
    throw new Error('A company voice provider is not configured.');
  }
  return new StringeeProvider(integration.apiKey, integration.apiSecret, fetch, {
    fromNumber: integration.fromNumber,
    answerUrl: integration.answerUrl,
    aiAgentUserId: integration.aiAgentUserId,
    saleAgentUserId: integration.saleAgentUserId,
  });
}
