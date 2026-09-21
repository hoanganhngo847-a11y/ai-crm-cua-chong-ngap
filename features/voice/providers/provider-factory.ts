import 'server-only';
import type { CallProvider } from '../../../shared/contracts/sensitive';
import { MockAiCallProvider } from './mock-provider';
import { StringeeProvider } from './stringee-provider';

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
