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
  if (injected) {
    return injected;
  }

  if (process.env.NODE_ENV === 'production') {
    // Production bắt buộc có provider thật
    const provider = process.env.VOICE_PROVIDER;
    if (provider === 'STRINGEE') {
      // Import động để không bundle trong dev nếu chưa cấu hình
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { StringeeProvider } = require('./stringee-provider') as {
        StringeeProvider: new (apiKey: string, apiSecret: string) => CallProvider;
      };
      const apiKey = process.env.STRINGEE_API_KEY;
      const apiSecret = process.env.STRINGEE_API_SECRET;
      if (!apiKey || !apiSecret) {
        throw new Error(
          'STRINGEE_API_KEY và STRINGEE_API_SECRET phải được cấu hình trong production.'
        );
      }
      return new StringeeProvider(apiKey, apiSecret);
    }

    throw new Error(
      `VOICE_PROVIDER="${provider}" chưa được cấu hình hoặc không hợp lệ. ` +
        `Giá trị hợp lệ: STRINGEE. Đặt biến môi trường VOICE_PROVIDER.`
    );
  }

  // Development / CI
  return new MockAiCallProvider();
}
