# Zalo cá nhân: cầu nối AI nghe và nói trong cuộc gọi

Đây là lớp mở rộng cho Zalo cá nhân, không dùng Zalo OA và không dùng API chính thức của Zalo.

Luồng cuộc gọi đến cũng đã có trong agent: khi bật `ZALO_PERSONAL_LIVE_VOICE_AUTO_ANSWER=1`, agent tìm đúng nút **Nhận cuộc gọi/Answer** trên cửa sổ Zalo rồi mới bấm. Agent không bấm tọa độ mù và không cần biết trước số điện thoại hay tên người gọi. Nếu không tìm được nút có nhãn rõ ràng, cuộc gọi không được tự nhận.

## Luồng dễ hiểu

```text
Khách nói trong Zalo
  -> ScreenCaptureKit chỉ lấy tiếng từ cửa sổ Zalo
  -> agent đổi thành PCM 16 kHz
  -> Gemini Live nghe, suy nghĩ và tạo giọng nói
  -> agent phát PCM vào BlackHole 2ch
  -> Zalo lấy BlackHole làm microphone
  -> khách nghe AI trả lời
```

CRM vẫn là nguồn sự thật. Trước khi cấp khóa Realtime ngắn hạn, server kiểm tra:

- thiết bị đã đăng ký và token thiết bị hợp lệ;
- request gọi ra đã được thiết bị claim;
- trạng thái cuộc gọi đã là `CALL_TRIGGERED` hoặc `CALL_DETECTED`;
- đúng `company_id`, `customer_id`, nhân viên và request;
- lấy grounding giới hạn từ hồ sơ khách hàng, hội thoại gần đây, lịch sử gọi, memory đã lọc và company knowledge đã VERIFIED.

Với cuộc gọi đến từ người chưa biết, phiên vẫn được tạo theo `company_id` của thiết bị và chỉ dùng company knowledge đã VERIFIED; không tự đoán danh tính khách hàng và không đưa dữ liệu khách khác vào phiên.

Nội dung CRM được đưa vào prompt như dữ liệu tham khảo, không được coi là chỉ dẫn. AI không được tự ghi CRM, chốt giao dịch, xin OTP/mật khẩu hay bịa thông tin; việc nhạy cảm phải chuyển nhân viên.

## Trạng thái hiện tại

Tính năng tắt mặc định. Chưa có bằng chứng end-to-end với một cuộc gọi Zalo thật; local compile, local-agent regression và TypeScript typecheck chỉ là bằng chứng local. Không nên bật cho khách hàng thật trước khi kiểm tra âm thanh hai chiều và quyền chuyển nhân viên.

Server cần các biến môi trường:

```text
ZALO_PERSONAL_LIVE_VOICE_ENABLED=0
ZALO_PERSONAL_LIVE_VOICE_AUTO_ANSWER=0
GEMINI_API_KEY=<server-side secret>
GEMINI_LIVE_MODEL=gemini-2.5-flash-native-audio-preview-12-2025
```

Chỉ đổi cờ server thành `1` cho một canary được duyệt. `GEMINI_API_KEY` dài hạn không được đưa vào Mac agent; server chỉ cấp ephemeral token dùng một lần, hết hạn nhanh cho phiên Live.

Để bật auto-answer trên Mac, cần bật cả hai cờ local:

```text
ZALO_PERSONAL_LIVE_VOICE_ENABLED=1
ZALO_PERSONAL_LIVE_VOICE_AUTO_ANSWER=1
ZALO_VOICE_OUTPUT_UID='<UID BlackHole 2ch>'
```

## Chuẩn bị Mac agent

1. Cài BlackHole 2ch. Không để agent tự đổi output hệ thống.
2. Lấy UID audio device:

```bash
./local-agent/run.sh --audio-devices
```

3. Chạy agent với cờ bật live voice và UID BlackHole:

```bash
ZALO_PERSONAL_LIVE_VOICE_ENABLED=1 \
ZALO_PERSONAL_LIVE_VOICE_AUTO_ANSWER=1 \
ZALO_VOICE_OUTPUT_UID='<UID BlackHole 2ch>' \
./local-agent/run.sh
```

4. Trong phần cài đặt cuộc gọi của Zalo, chọn **BlackHole 2ch** làm microphone của Zalo. Giữ loa Zalo là tai nghe/loa vật lý để nhân viên vẫn nghe được khách.

5. Cho phép app đã ký của agent trong:

- Microphone;
- Screen & System Audio Recording;
- Accessibility.

Khi cần nhân viên nói trực tiếp, đổi microphone Zalo về mic thật hoặc tắt cờ live voice trước cuộc gọi. Việc trộn mic nhân viên + giọng AI tự động chưa được bật vì dễ tạo tiếng vọng và nói chồng.

## Chi phí

Phần code không tạo phí riêng. Gemini Live có thể chạy Free Tier nhưng vẫn có quota/rate limit; khi vượt quota thì dùng bảng giá Gemini hiện hành. BlackHole là phần mềm miễn phí. Mac chạy agent và máy chủ CRM vẫn là hạ tầng riêng của dự án.

## Gate trước khi bật thật

- test với một tài khoản Zalo nội bộ và một khách test đã được cho phép;
- xác nhận Zalo nhận tiếng từ BlackHole, khách nghe rõ, không vọng và AI ngắt được khi khách nói chen;
- xác nhận AI không trả lời khi sai tên/không có outbound binding;
- xác nhận server tắt cờ thì agent không thể xin session;
- ghi nhận session, provider error, latency và kết quả chuyển nhân viên;
- bật kill switch và giữ lại bản ghi gốc khi có lỗi.
