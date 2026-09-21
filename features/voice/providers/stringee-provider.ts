import 'server-only';
import type { CallProvider } from '../../../shared/contracts/sensitive';

/**
 * Stringee VoIP Provider Adapter — STUB
 *
 * Đây là skeleton để tích hợp Stringee khi có API key thật.
 * Hiện tại mọi cuộc gọi đều throw NotImplemented.
 *
 * Khi tích hợp thật, cần:
 *   - STRINGEE_API_KEY (env)
 *   - STRINGEE_API_SECRET (env)
 *   - STRINGEE_FROM_NUMBER — số Hotline đã đăng ký với Stringee
 *
 * Tài liệu: https://developer.stringee.com/docs/voice-api
 *
 * SECURITY NOTE: Stringee là SIP/VoIP — sale nghe qua softphone/headset.
 * Số khách hiển thị ở phía Stringee nhưng KHÔNG xuất hiện trên giao diện CRM.
 * Xem disclaimer trong CallToCustomerButton.tsx.
 */
export class StringeeProvider implements CallProvider {
  readonly name = 'STRINGEE' as const;

  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly fromNumber: string;

  constructor(apiKey: string, apiSecret: string) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.fromNumber = process.env.STRINGEE_FROM_NUMBER || '';

    if (!this.fromNumber) {
      throw new Error('STRINGEE_FROM_NUMBER phải được cấu hình.');
    }
  }

  async initiateCall(params: {
    fromStaffUserId: string;
    targetRawPhone: string;
    customerId: string;
    companyId: string;
  }): Promise<{ providerCallId: string; status: string }> {
    // TODO: Implement Stringee REST API call
    // POST https://api.stringee.com/v1/call2/callout
    // Headers: X-STRINGEE-AUTH: <JWT>
    // Body: { from: { type: 'external', number: fromNumber, alias: 'AI CRM' },
    //         to:   { type: 'external', number: params.targetRawPhone },
    //         answer_url: process.env.STRINGEE_ANSWER_URL }
    //
    // SECURITY: targetRawPhone được truyền vào hàm này trong bộ nhớ server.
    // Không bao giờ log params.targetRawPhone.
    // Nếu Stringee trả lỗi, bắt exception và throw generic error (không leak phone).

    void params; // suppress lint — remove when implemented
    void this.apiKey;
    void this.apiSecret;

    throw new Error(
      'StringeeProvider chưa được triển khai. ' +
        'Cài đặt VOICE_PROVIDER=STRINGEE, STRINGEE_API_KEY, STRINGEE_API_SECRET, ' +
        'STRINGEE_FROM_NUMBER và hoàn thiện Stringee REST integration.'
    );
  }
}

/**
 * Ghi chú về che số điện thoại với Stringee:
 *
 * ✅ Số khách KHÔNG xuất hiện trên giao diện CRM (web).
 * ✅ Số khách KHÔNG có trong API response, log server, hay JSON gửi về browser.
 *
 * ⚠️  Stringee softphone / app có thể hiển thị số khách cho sale trong giao diện của Stringee.
 * ⚠️  Nếu sale dùng điện thoại vật lý kết nối SIP thì nhật ký cuộc gọi trên điện thoại
 *     sẽ có số khách — CRM KHÔNG THỂ ngăn chặn điều này.
 *
 * Để che số tuyệt đối: cấu hình Stringee để số khách bị mask ở phía Stringee
 * trước khi hiển thị cho agent (tính năng "number masking" của Stringee).
 */
