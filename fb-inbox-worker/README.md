# fb-inbox-worker (Meta Business Suite Inbox Reader MVP)

Worker Node.js sử dụng Playwright để tự động đọc tin nhắn từ **Meta Business Suite Inbox** trên máy Mac.

## ✨ Tính năng Giai đoạn 1 (MVP)
1. **Chromium Persistent Profile**: Lưu phiên đăng nhập và cookie vào thư mục `user_data/` cục bộ. Lần chạy sau không cần đăng nhập lại.
2. **Bảo mật tuyệt đối**: Không lưu trữ mật khẩu, email hay token trong mã nguồn. Người dùng tự đăng nhập và xác thực 2FA lần đầu.
3. **Thuần UI Automation**: Không gọi private GraphQL API, không đảo ngược endpoint, tuân thủ thuần giao diện web qua Playwright.
4. **Selector ổn định**: Ưu tiên ARIA roles, aria-labels, text node ngữ nghĩa, không phụ thuộc class CSS ngẫu nhiên của Facebook.
5. **Giám sát & cảnh báo thông minh**: Tự động nhận diện trạng thái chờ đăng nhập, checkpoint bảo mật 2FA, mất kết nối và tự phục hồi.
6. **Log tin nhắn trực quan**: Khi có tin nhắn / hội thoại chưa đọc, in thông tin rõ ràng ra Terminal gồm:
   - Tên Page
   - Tên khách hàng
   - Thời gian gửi
   - Nội dung tin nhắn

---

## 🚀 Hướng dẫn Cài đặt & Chạy

### 1. Cài đặt Dependencies
```bash
cd fb-inbox-worker
npm install
npx playwright install chromium
```

### 2. Chạy Worker
```bash
npm start
```

### 3. Đăng nhập lần đầu (Nếu chưa có session)
- Cửa sổ Chromium sẽ mở ra trang Meta Business Suite Inbox.
- Nếu bạn chưa đăng nhập, giao diện đăng nhập Facebook sẽ hiển thị.
- Bạn tự nhập tài khoản, mật khẩu và mã 2FA.
- Sau khi đăng nhập thành công và vào Inbox, Worker sẽ tự động bắt đầu quét tin nhắn.
- Toàn bộ session được lưu trong `user_data/` cho các lần chạy tiếp theo.

### 4. Chế độ Phân tích DOM (Inspect Mode)
Nếu cần kiểm tra cấu trúc DOM thực tế để tinh chỉnh selector:
```bash
npm run inspect
```
