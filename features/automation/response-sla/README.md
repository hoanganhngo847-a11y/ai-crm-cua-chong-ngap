# Response SLA Module (5-Phút Phản Hồi)

Module quản lý cam kết thời gian phản hồi (Service Level Agreement - SLA) 5 phút đối với các tin nhắn đến từ khách hàng trong Hộp thư tích hợp (Omnichannel Inbox).

---

## 1. Business Flow

Quy trình phản hồi tin nhắn theo `PROJECT_MASTER.md`:

```text
Customer inbound MESSAGE
  → Mở SLA Window (started_at = thời điểm tin nhắn đầu tiên, deadline_at = started_at + 300s)
  → Đếm ngược 5 phút chờ Sale phản hồi
  → Nếu Sale phản hồi trong vòng 5 phút:
      Đóng SLA Window (state = SALE_RESPONDED) → AI tuyệt đối không trả lời
  → Nếu quá 5 phút Sale chưa phản hồi:
      Đủ điều kiện cho phép bước AI evaluation xem xét trả lời (decision = ALLOW_AI_REPLY)
```

---

## 2. Canonical Source

Định danh và theo dõi SLA chỉ dựa trên các nguồn dữ liệu chuẩn hóa của hệ thống:

* `public.conversations`
* `public.interactions`

### Customer Message Hợp Lệ (Trigger mở SLA)

Một interaction kích hoạt mở hoặc duy trì SLA window phải thỏa mãn:

```text
type = MESSAGE
direction = INBOUND
actor_type = CUSTOMER
conversation_id != null
```

### Sale Response Hợp Lệ (Resolve SLA)

Một interaction được tính là phản hồi của Sale để hoàn thành SLA window phải thỏa mãn:

```text
type = MESSAGE
direction = OUTBOUND
actor_type = SALE
cùng conversation_id
```

*Lưu ý:* Tin nhắn của AI (`actor_type = AI`) **không bao giờ** được coi là Sale response.

---

## 3. Current Foundation Limitation

Theo schema và migration hiện tại của Foundation:

* `Conversation.channel` hiện chỉ hỗ trợ:
  * `FACEBOOK`
  * `ZALO`
* **Tuyệt đối không** tự ý nhét `WEBSITE` hoặc `HOTLINE` vào bảng `Conversation` khi schema cơ sở dữ liệu chưa mở rộng. Hotline/Click-to-Call được quản lý riêng qua bảng `Call`, còn tương tác Website chưa thuộc phạm vi inbox hội thoại hiện tại.

---

## 4. Important Invariants

1. **Một Conversation chỉ có tối đa một SLA window ở trạng thái `OPEN`**:
   * Khi khách gửi nhiều tin nhắn liên tiếp trước khi Sale kịp trả lời:
     ```text
     14:00 Customer: Alo
     14:01 Customer: Tôi cần tư vấn
     14:02 Customer: Nhà tôi rộng 3m
     ```
     Hệ thống chỉ duy trì **duy nhất 1 SLA window**:
     ```text
     started_at = 14:00
     deadline_at = 14:05 (đúng 300 giây)
     ```
   * **Không reset deadline.**
   * **Không tạo thêm SLA window.**
   * Sau khi Sale phản hồi hợp lệ, window hiện tại kết thúc (`SALE_RESPONDED`). Chỉ khi khách nhắn tiếp sau đó mới mở window mới.
   * Mốc thời gian nghiệp vụ chính thức duy nhất là **5 phút (300 giây)**. Không tự thêm quy tắc trung gian như "3 phút WARNING".

2. **Hết 5 phút không đồng nghĩa được gửi AI ngay lập tức**:
   * Quyết định `ALLOW_AI_REPLY` từ pure evaluator chỉ xác nhận điều kiện thời gian và trạng thái snapshot tại thời điểm đánh giá.
   * Trước khi AI gửi tin thật (ở các milestone sau), bắt buộc phải có bước **atomic claim / recheck** trạng thái hội thoại trực tiếp trên server để triệt tiêu race condition (tránh AI và Sale gửi đồng thời).
   * Mọi quyết định gửi hay hủy phải có audit log đầy đủ.

---

## 5. Pure Evaluator Specification (M9.1)

Trong milestone M9.1:
* Domain contract được định nghĩa tại `shared/contracts/response-sla.ts`.
* Logic tính deadline và đánh giá SLA được thực hiện thuần túy bằng hàm thuần (pure function) tại `features/automation/response-sla/services/evaluate-response-sla.ts`.
* **Tuyệt đối không** gọi database, Supabase client, Service Role key, hay dịch vụ OpenAI bên ngoài trong pure evaluator.
