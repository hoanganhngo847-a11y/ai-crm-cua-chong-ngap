# HƯỚNG DẪN DEMO HỆ THỐNG AI CRM & FACEBOOK MESSENGER TRÊN MACBOOK

> **Dành cho buổi thuyết trình trực tiếp với Giảng viên**  
> **Kiến trúc:** Dual-Flow Omnichannel (Inbound & Outbound) sử dụng Playwright Worker chạy trực tiếp trên macOS kết nối Production CRM trên Render và Supabase.

---

## 🏗️ Sơ đồ Kiến trúc Hoạt động

```
[Chiều Inbound]
Khách hàng nhắn tin Facebook Messenger
       ↓
Hộp thư Meta Business Suite (Page: MD Tech Cửa Chống Ngập)
       ↓
Local Playwright Worker (MacBook - Caffeinate - Headed Chromium)
       ↓ (POST /api/inbox/browser-sync kèm x-worker-secret)
CRM Production trên Render (https://ai-crm-cua-chong-ngap.onrender.com)
       ↓ (Atomic RPC ingest_provider_message_atomic)
Supabase PostgreSQL Production

[Chiều Outbound]
Nhân viên Sale trả lời trong CRM Inbox (/inbox)
       ↓
Tạo Outbox Job (status: PENDING, delivery_status: PENDING_DISPATCH)
       ↓
Worker MacBook định kỳ poll (POST /api/inbox/outbox/claim - FOR UPDATE SKIP LOCKED)
       ↓ (status chuyển PROCESSING)
Tự động định vị đúng Thread, nhập tin nhắn, gửi trên Meta Business Suite
       ↓
Xác nhận Outbound Bubble mới xuất hiện (Anti-False-Positive verification)
       ↓ (POST /api/inbox/outbox/complete)
Cập nhật trạng thái SENT & sent_at trong CRM / Supabase
       ↓
Khách hàng nhận được tin nhắn trên Facebook Messenger
```

---

## A. Chuẩn bị Trước khi Gặp Giảng viên (Pre-Demo)

1. **Cắm sạc MacBook** (đảm bảo hiệu năng CPU tối đa).
2. **Kết nối WiFi / Internet ổn định**.
3. **Mở Terminal tại thư mục dự án:**
   ```bash
   cd /Users/hoangthuy/ai-crm-cua-chong-ngap
   ```
4. **Chạy kiểm tra toàn diện tự động (Preflight Check):**
   ```bash
   npm run demo:preflight
   ```
   *Kỳ vọng:* Mọi mục kiểm tra (Internet, CRM Render, Token Secret, Page ID, Profile Dir, Chromium) đều báo `PASS ✅`.

5. **Khởi động Worker chế độ Demo:**
   ```bash
   npm run demo:start
   ```
   *Tiến trình được bảo vệ bởi `caffeinate -dimsu` chống sleep Mac khi đóng nắp/chờ.*  
   *Cửa sổ trình duyệt Chromium sẽ tự động hiển thị trên màn hình Mac.*

6. **Kiểm tra trạng thái sẵn sàng:**
   ```bash
   npm run demo:status
   ```
   *Kỳ vọng đầu ra:*
   ```text
   === FACEBOOK CRM DEMO STATUS ===

   Mac worker: RUNNING (PID xxxxx)
   CRM production: ONLINE
   Local health: HEALTHY
   Meta Inbox: READY
   Facebook session: VALID
   Page ID: 1389294167596309
   Poll interval: 5000ms
   Pending outbox: 0

   READY FOR DEMO ✅
   ```

7. **Mở sẵn 2 cửa sổ trên màn hình MacBook:**
   - **Nửa màn hình trái:** Trình duyệt cá nhân mở CRM Inbox: `https://ai-crm-cua-chong-ngap.onrender.com/inbox`
   - **Nửa màn hình phải:** Cửa sổ Chromium của Worker đang mở Meta Business Suite Inbox (để giảng viên thấy cơ chế tương tác thời gian thực).

---

## B. Kịch bản Demo 1: Chiều Khách Nhắn Đến (Inbound)

1. Mở điện thoại hoặc trình duyệt khác dùng **tài khoản Facebook khách hàng**.
2. Nhắn một tin nhắn bất kỳ tới Page **"MD Tech Cửa Chống Ngập"**, ví dụ:
   > *"Tôi cần tư vấn cửa chống ngập cho nhà phố mặt tiền 4m."*
3. **Chỉ cho giảng viên thấy trên màn hình Mac:**
   - Sau khoảng 3–5 giây, cửa sổ Chromium của Worker phát hiện tin nhắn mới trong Meta Inbox.
   - Terminal/Log hiển thị sự kiện Inbound Sync thành công (`200 OK`).
   - Trên trang CRM Inbox (`https://ai-crm-cua-chong-ngap.onrender.com/inbox`), cuộc trò chuyện lập tức xuất hiện kèm thông tin khách hàng, nhãn kênh `FACEBOOK`, nguồn `facebook_browser`.
   - Idempotency bảo vệ: Cho giảng viên xem dù worker quét lại nhiều chu kỳ sau đó, số lượng tin nhắn không bao giờ bị nhân đôi (Zero duplicate).

---

## C. Kịch bản Demo 2: Chiều Nhân Viên Phản Hồi (Outbound)

1. Tại giao diện **CRM Inbox**, chọn cuộc trò chuyện vừa nhận.
2. Nhập câu trả lời tư vấn trong khung chat, ví dụ:
   > *"Chào bạn, bên em có dòng cửa chống ngập tự động và tháo lắp bằng hợp kim nhôm, em xin phép gửi báo giá sơ bộ nhé!"*
3. Bấm **Gửi tin nhắn**:
   - Giao diện CRM chuyển trạng thái tin nhắn thành **"Đang gửi"** (`PENDING_DISPATCH`) ngay lập tức mà không bị đơ hoặc chặn giao diện.
   - Nhắc giảng viên nhìn sang cửa sổ Chromium của Worker:
     - Worker claim outbox job atomic.
     - Worker định vị chính xác thread khách hàng theo Customer FB ID (không dựa vào tên hiển thị để tránh nhầm lẫn).
     - Worker tự động gõ nội dung và gửi tin nhắn.
     - Worker xác nhận bong bóng tin nhắn màu xanh xuất hiện trong khung chat Meta.
     - Hoàn tất job, CRM Inbox chuyển trạng thái sang **"Đã gửi"** (`SENT`).
4. Mở Messenger trên máy khách hàng cho giảng viên thấy tin nhắn đã tới nơi an toàn.

---

## D. Kịch bản Demo 3: Cơ chế Chống Lỗi & Độ Bền Vững (Fault-Tolerance)

Nếu giảng viên hỏi sâu về kiến trúc và độ tin cậy:
1. **Thử tắt Worker:**
   ```bash
   npm run demo:stop
   ```
2. **Khởi động lại Worker:**
   ```bash
   npm run demo:start
   ```
3. **Chứng minh:**
   - Không bị mất phiên đăng nhập Facebook nhờ Local Persistent Profile (`user_data/`).
   - Các tin nhắn cũ đã gửi (`SENT`) tuyệt đối không bị gửi lặp lại (Zero duplicate outbound).
   - Single-instance lock: Nếu gõ lại `npm run demo:start` khi worker đang chạy, hệ thống sẽ cảnh báo `WORKER_ALREADY_RUNNING` chứ không tạo 2 tiến trình xung đột.

---

## E. Kết Thúc Demo

Sau khi hoàn thành phần trình bày, tắt worker để giải phóng tài nguyên:
```bash
npm run demo:stop
```

---

## 🛠️ Tóm tắt Lệnh Thao tác Nhanh

| Lệnh | Ý nghĩa |
|---|---|
| `npm run demo:preflight` | Kiểm tra tất cả điều kiện kết nối & môi trường trước demo |
| `npm run demo:start` | Khởi chạy Worker trên Mac (bảo vệ chống sleep bởi caffeinate) |
| `npm run demo:status` | Kiểm tra nhanh trạng thái: Worker, CRM, Meta Inbox, Outbox queue |
| `npm run demo:stop` | Tắt Worker an toàn |
