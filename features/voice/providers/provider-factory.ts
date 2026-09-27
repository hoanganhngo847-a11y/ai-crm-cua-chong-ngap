import 'server-only';
import type { CallProvider } from '../../../shared/contracts/sensitive';
import { MockAiCallProvider } from './mock-provider';
import { StringeeProvider } from './stringee-provider';
import { resolveCompanyVoiceIntegration } from '../services/integration-resolver';
import { ServerAuthError } from '../../../lib/server-auth/errors';

/**
 * Resolve provider instance strictly per-company from active DB integration config.
 *
 * INVARIANTS:
 * 1. Multi-tenant: mỗi company phải có credentials/configs riêng biệt.
 * 2. Không dùng global shared credentials cho các company.
 * 3. Mock provider TUYỆT ĐỐI không chạy trong production.
 * 4. Không fallback sang credentials rỗng.
 * 5. Fail-closed khi cấu hình thiếu.
 */
export async function resolveVoiceCallProviderForCompany(
  companyId: string,
  injected?: CallProvider
): Promise<CallProvider> {
  if (injected) return injected;

  const integration = await resolveCompanyVoiceIntegration(companyId, 'STRINGEE');

  if (!integration?.apiKey || !integration.apiSecret || !integration.fromNumber || !integration.answerUrl) {
    // Chỉ cho phép mock provider trong môi trường test/dev khi được bật tường minh
    if (process.env.NODE_ENV !== 'production' && (process.env.ALLOW_MOCK_VOICE_PROVIDER === 'true' || process.env.NODE_ENV === 'test')) {
      return new MockAiCallProvider();
    }
    throw new ServerAuthError(
      'Cấu hình tổng đài của doanh nghiệp chưa hợp lệ hoặc chưa được kích hoạt.',
      503,
      'CALL_PROVIDER_NOT_CONFIGURED'
    );
  }

  return new StringeeProvider(integration.apiKey, integration.apiSecret, fetch, {
    fromNumber: integration.fromNumber,
    answerUrl: integration.answerUrl,
    aiAgentUserId: integration.aiAgentUserId,
    saleAgentUserId: integration.saleAgentUserId,
  });
}

/**
 * Legacy standalone resolver — chỉ dùng cho tests hoặc script đơn lập.
 * Production bắt buộc dùng resolveVoiceCallProviderForCompany.
 */
export function resolveVoiceCallProvider(injected?: CallProvider): CallProvider {
  if (injected) return injected;

  if (process.env.NODE_ENV === 'production') {
    throw new ServerAuthError(
      'Standalone voice provider resolution is forbidden in production. Use per-company resolution.',
      500,
      'RESOURCE_FORBIDDEN'
    );
  }

  return new MockAiCallProvider();
}
