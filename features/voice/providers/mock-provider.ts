import 'server-only';
import type { CallProvider } from '../../../shared/contracts/sensitive';

/**
 * Mock AI outbound call provider — chỉ dùng cho local dev và CI.
 *
 * INVARIANT: Provider này KHÔNG BAO GIỜ được dùng trong production.
 * Trong production, nếu không có provider thật → CALL_PROVIDER_NOT_CONFIGURED.
 *
 * Tái sử dụng interface CallProvider từ shared/contracts/sensitive.ts.
 * Tên provider = 'MANUAL' — khớp với CHECK constraint trên bảng calls.
 */
export class MockAiCallProvider implements CallProvider {
  readonly name = 'MANUAL' as const;

  async initiateCall(params: {
    fromStaffUserId: string;
    targetRawPhone: string;
    customerId: string;
    companyId: string;
  }): Promise<{ providerCallId: string; status: string }> {
    // Sinh providerCallId giả — không log phone
    const providerCallId = `mock_ai_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    // Giả lập delay tổng đài
    await new Promise((resolve) => setTimeout(resolve, 50));

    console.log(
      `[MockAiCallProvider] Outbound call initiated for customer=${params.customerId}` +
        ` companyId=${params.companyId}` +
        ` — phone REDACTED in logs`
    );

    return {
      providerCallId,
      status: 'INITIATED',
    };
  }
}

/**
 * Tạo AI call provider phù hợp với môi trường.
 *
 * Production: phải có provider thật — throws nếu chưa cấu hình.
 * Development/CI: trả về MockAiCallProvider.
 */
export function resolveAiCallProvider(injected?: CallProvider): CallProvider {
  // Compatibility wrapper for callers created before provider-factory.ts.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { resolveVoiceCallProvider } = require('./provider-factory') as {
    resolveVoiceCallProvider: (provider?: CallProvider) => CallProvider;
  };
  return resolveVoiceCallProvider(injected);
}
