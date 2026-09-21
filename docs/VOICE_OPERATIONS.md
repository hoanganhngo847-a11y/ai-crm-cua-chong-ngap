# Voice/Hotline — cấu hình và kiểm thử vận hành

## Kiến trúc

- Stringee Call API làm lớp PSTN/SIP; CRM chỉ phụ thuộc `CallProvider`.
- Supabase bucket private `call-recordings` giữ bản ghi; DB chỉ giữ object path nội bộ.
- `voice_media_jobs` xử lý recording/transcript/trích xuất intake bất đồng bộ, retry tối đa 5 lần.
- OpenAI Realtime SIP trả lời bằng tiếng Việt; webhook nhận cuộc gọi tại `/api/webhooks/openai-realtime`.
- OpenAI Audio Transcriptions là adapter mặc định; model được chọn bằng `OPENAI_TRANSCRIPTION_MODEL`.
- Sau transcript, Responses API trích xuất trường intake theo JSON Schema; request đặt `store=false`.
- Chỉ BOSS_ADMIN + AAL2 được lấy signed URL 15 phút và transcript verbatim.

Tài liệu: [Stringee outbound](https://developer.stringee.com/docs/rest-api-reference/call-rest-api-make-outbound-call), [Stringee signature](https://developer.stringee.com/docs/validating-requests-are-coming-from-stringee), [OpenAI transcription](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create).

## Cấu hình

1. Apply lần lượt migration `20260921000001_voice_media_pipeline.sql` và `20260921000002_openai_realtime.sql`.
2. Chép nhóm biến Voice trong `.env.example` sang môi trường triển khai.
3. Trên Stringee Dashboard, cấu hình Event URL và Answer URL thành `https://<domain>/api/webhooks/voice`, bật recording và dùng signing secret trùng `VOICE_WEBHOOK_SECRET`.
4. Tạo Stringee user/SIP endpoint cho sale rồi cấu hình `STRINGEE_SALE_AGENT_USER_ID`.
5. Tạo OpenAI Project webhook trỏ tới `https://<domain>/api/webhooks/openai-realtime`, đăng ký event `realtime.call.incoming`, rồi chép signing secret vào `OPENAI_WEBHOOK_SECRET`.
6. Route leg AI từ Stringee qua SBC/SIP bridge tới `sip:<OPENAI_PROJECT_ID>@sip.api.openai.com;transport=tls`. Gán Stringee user đầu bridge vào `STRINGEE_AI_AGENT_USER_ID`. Stringee SCCO chỉ route Hotline tới internal user, nên bridge/SBC là thành phần bắt buộc; không dùng điện thoại sale làm AI endpoint.
7. Chọn `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_VOICE`; prompt mặc định đã hỏi tên, loại cửa, kích thước, mức ngập, số ô, địa chỉ và lịch khảo sát.
8. Vercel Cron đã đặt lịch `*/5 * * * *`; request cần `Authorization: Bearer $CRON_SECRET`.

Luồng SIP: `PSTN -> Stringee Hotline -> STRINGEE_AI_AGENT_USER_ID/SBC -> OpenAI SIP -> webhook accept`.
Webhook OpenAI được xác minh bằng SDK chính thức và chống xử lý trùng theo event id. SIP headers không được lưu.

## Gọi thử

### Hotline inbound

1. Gọi `STRINGEE_FROM_NUMBER` từ số chưa có trong CRM.
2. Xác nhận cuộc gọi tới `STRINGEE_AI_AGENT_USER_ID`, SBC chuyển tiếp đến OpenAI SIP và bot chào bằng tiếng Việt.
3. Xác nhận Customer nguồn `HOTLINE`, Call `INBOUND/AI`, Interaction `HOTLINE/CALL_EVENT` được tạo.
4. Xác nhận không có `call_attempts` mới.
5. Sau khi có recording, pipeline chuyển lời rồi tự trích xuất các trường cửa đã whitelist. `survey_requested=true` tạo một request chưa phân công trong `voice_call_intakes` để phân hệ Survey xếp lịch sau. Webhook `call.intake_completed` vẫn được giữ để tương thích agent/SBC tùy biến.

### Sale click-to-call

1. SALE tìm tên hoặc mã `KH-000123`, bấm **GỌI KHÁCH**.
2. Stringee gọi khách và nối với `STRINGEE_SALE_AGENT_USER_ID`.
3. DevTools Network/Console không có số thật; response chỉ có `callId`, `status`.
4. Chế độ MANUAL phải hiện cảnh báo SIM không bảo đảm che số.

### Chu kỳ ba lần

- Lần 1 gọi ngay; lần 2 sau 2,5 giờ; lần 3 lúc 09:00 ngày hôm sau theo Asia/Ho_Chi_Minh.
- Sau lần 3 thất bại, customer thành `UNREACHABLE` và không bị xóa.
- Cron chỉ lấy attempt chưa có `called_at`/`call_id`; unique index chỉ cho một attempt PENDING mỗi khách.

## Recording và transcript

Khi call hoàn tất, hệ thống enqueue opaque recording ID, tải bằng JWT server-side, giới hạn 25 MiB, upload private Storage rồi chuyển lời. Lỗi thiếu recording, lỗi tải, lỗi transcript hoặc lỗi trích xuất intake đều được retry theo exponential backoff. URL provider không được lưu DB hoặc trả về trình duyệt.

## Kiểm tra trước merge

```powershell
npm run typecheck
npm run test:voice
npm run build
```

CI không thể xác nhận PSTN thật; bước đó cần Stringee credentials, số Hotline và hai SIP endpoint hoạt động.

## Checklist nghiệm thu hạ tầng

- Gọi số Hotline thật và nghe lời chào AI hai chiều.
- Gọi lặp webhook OpenAI/Stringee cùng event id và xác nhận chỉ có một call/intake.
- Tắt recording tạm thời, xác nhận job retry rồi phục hồi khi recording xuất hiện.
- Dùng transcript provider lỗi, xác nhận `transcript_status=FAILED` sau lần cuối và không có object public.
- Đăng nhập SALE, tìm `Nguyễn Văn A`/`KH-000123`, kiểm tra Network/Console không có số thật.
- Đăng nhập BOSS_ADMIN+AAL2 mới mở được recording/transcript; SALE và TECHNICIAN bị từ chối.
