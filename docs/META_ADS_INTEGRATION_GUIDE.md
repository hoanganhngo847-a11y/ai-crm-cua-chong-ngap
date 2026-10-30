# Hướng Dẫn Vận Hành & Tích Hợp Meta Ads & Lead Attribution

> Scope update, 2026-10-30: [Meta Ads Lead Attribution Final Scope](META_ADS_LEAD_ATTRIBUTION_FINAL_SCOPE.md) supersedes reporting/dashboard, Insights, ad-set sync and deployment instructions below. This document is retained as historical implementation/review context; use the final-scope metadata fields, route names and migration manifest for release.

Tài liệu này hướng dẫn chi tiết quy trình cấu hình, kết nối, đồng bộ Marketing API, tiếp nhận Lead Ads / Click-to-Messenger và giám sát hiệu quả quảng cáo trong AI CRM (`hoanganhngo847-a11y/ai-crm-cua-chong-ngap`).

---

## 1. Kiến Trúc Tổng Quan

Hệ thống tích hợp Meta Ads được thiết kế theo nguyên tắc:
1. **Multi-Tenant Isolation**: Mọi dữ liệu tài khoản quảng cáo, chiến dịch, touchpoint attribution đều được cô lập tuyệt đối theo `company_id` bằng Row Level Security (RLS).
2. **Read-Only Marketing API**: CRM chỉ đọc dữ liệu quảng cáo (chiến dịch, nhóm, quảng cáo, biểu mẫu, chỉ số báo cáo); tuyệt đối **không** tạo, sửa, bật, tắt hoặc can thiệp ngân sách Meta Ads từ CRM.
3. **Phân biệt rạch ròi Campaign Models**:
   - `meta_campaigns`: Chiến dịch quảng cáo trả phí trên Meta Ads.
   - `care_campaigns`: Chiến dịch chăm sóc / gửi tin nhắn tự động nội bộ của CRM. Hai mô hình dữ liệu này độc lập và không gộp chung.
4. **Multi-Touch Attribution**: Lưu vết cả First-Touch (điểm tiếp xúc đầu tiên), Latest-Touch (điểm tiếp xúc gần nhất) và toàn bộ chuỗi touchpoints trong bảng `lead_attribution_touchpoints`. Khi có khách hàng cũ quay lại qua quảng cáo mới, touchpoint mới được ghi nhận mà không làm mất thông tin nguồn gốc đầu tiên.
5. **No Guessing / Anti-Hallucination**: Không bao giờ tự suy đoán campaign dựa trên Page ID. Nếu tin nhắn hoặc lead không có metadata quảng cáo hợp lệ, CRM gán trạng thái `UNATTRIBUTED`.
6. **Zero-Phone & PII Security**: Số điện thoại được lưu riêng trong schema bảo mật `private.customer_private_contacts`. Mọi giao diện hiển thị, note Customer 360 và phản hồi API public đều hiển thị số đã che (`[số liên hệ đã ẩn]` hoặc mask dạng `091****678`). Access token được mã hóa chuẩn **AES-256-GCM** trước khi lưu vào database.

---

## 2. Cấu Hình Meta Developer App

### 2.1. Loại ứng dụng (App Type)
- Tạo hoặc sử dụng App loại **Business** (Doanh nghiệp) trên [Meta for Developers](https://developers.facebook.com/).

### 2.2. Các quyền tối thiểu cần cấp (Least Privilege)
Chỉ yêu cầu các quyền thực sự cần thiết, **không** yêu cầu `ads_management`:

| Scope | Mục đích | Bắt buộc |
| :--- | :--- | :--- |
| `pages_show_list` | Lấy danh sách Facebook Pages mà người dùng quản lý | Có |
| `pages_manage_metadata` | Đăng ký webhook subscription cho Page | Có |
| `pages_read_engagement` | Đọc thông tin Page cần cho kết nối | Có |
| `pages_messaging` | Tiếp nhận và gửi tin nhắn Messenger | Có |
| `ads_read` | Đọc cấu trúc chiến dịch và báo cáo chi phí từ Marketing API | Có |
| `leads_retrieval` | Truy xuất dữ liệu lead từ Instant Forms (Facebook Lead Ads) | Có |

### 2.3. Cấu hình Webhooks trên Meta Developer Dashboard
1. Truy cập mục **Webhooks** trong Meta App Dashboard.
2. Chọn đối tượng **Page**.
3. Điền Callback URL và Verify Token:
   - **Callback URL**: `https://<domain-crm-cua-ban>/api/webhooks/meta`
   - **Verify Token**: Giá trị khớp với biến môi trường `META_VERIFY_TOKEN`.
4. Đăng ký (Subscribe) các trường sự kiện sau cho Page:
   - `messages`: Tiếp nhận tin nhắn khách hàng và Click-to-Messenger referrals.
   - `messaging_postbacks`: Tiếp nhận postback nút bấm.
   - `leadgen`: Tiếp nhận sự kiện khi khách hàng submit biểu mẫu quảng cáo (Instant Forms).
5. Trong **App Review**: Cần gửi xét duyệt (App Review) cho quyền `ads_read` và `leads_retrieval` để phục vụ các tài khoản quảng cáo và Page ngoài môi trường Development.

---

## 3. Biến Môi Trường (Environment Variables)

Bổ sung các biến môi trường sau vào server hosting (Render / Vercel / Docker):

```env
# Meta Webhook & App
META_APP_SECRET=your-meta-app-secret-here
META_VERIFY_TOKEN=your-long-random-verify-token-here
META_GRAPH_VERSION=v26.0
META_MARKETING_VERSION=v26.0

# Bảo mật Token Vault (AES-256-GCM)
# Khoá 32-byte ngẫu nhiên dạng hex hoặc chuỗi bảo mật cao để mã hoá token khi lưu vào database
META_TOKEN_ENCRYPTION_KEY=<32-byte-key-as-64-hex-characters>
# Optional previous effective AES key during rotation; never the legacy passphrase
META_PREVIOUS_TOKEN_ENCRYPTION_KEY=

# Token người dùng hệ thống (System User Token) tuỳ chọn cho cron sync ngầm
META_SYSTEM_USER_TOKEN=EAAB...

# Cấu hình Page Bindings (JSON ánh xạ Page ID với Company)
META_PAGE_BINDINGS=[{"page":"1026991374010112","company":"company-uuid-1","tokenEnv":"META_PAGE_CHD_TOKEN","name":"Du học Đức CHD"}]
META_PAGE_CHD_TOKEN=EAA...

# CRON Secret cho cron job đồng bộ định kỳ
CRON_SECRET=your-random-cron-secret-32-chars
```

> [!IMPORTANT]
> `META_TOKEN_ENCRYPTION_KEY` là khoá bảo mật cực kỳ quan trọng. Không bao giờ commit vào Git hoặc public cho frontend. Nếu thay đổi khoá này mà không migrate dữ liệu, các token cũ trong vault `private.meta_ad_account_tokens` sẽ không thể giải mã.

---

## 4. Quy Trình Kết Nối OAuth & Lựa Chọn Tài Khoản

Quản trị viên cấp cao (**BOSS_ADMIN**) thực hiện:

1. Đăng nhập CRM và truy cập menu **Quản trị > Kết nối Facebook & Meta Ads** (`/admin/facebook`).
2. Nhấn nút **"Kết nối lại Meta OAuth"** (hoặc "Bắt đầu kết nối Meta").
3. Trình duyệt chuyển hướng sang giao diện Meta OAuth:
   - Đăng nhập tài khoản Facebook có quyền Admin/Advertiser trên các Ad Accounts và Pages.
   - Tích chọn cấp quyền truy cập Pages và Ad Accounts cần kết nối.
4. Sau khi Meta chuyển hướng về CRM (`/api/facebook/connect/callback`):
   - Hệ thống tự động truy vấn danh sách Pages và Ad Accounts mà người dùng có quyền quản lý.
   - Giao diện hiển thị danh sách để quản trị viên chọn cụ thể Page nào và Ad Account nào được liên kết với công ty hiện tại.
5. Khi nhấn **"Lưu cấu hình & Đăng ký Webhook"**:
   - Access token được mã hoá AES-256-GCM và lưu vào bảng `private.meta_ad_account_tokens` qua RPC chỉ dành cho `service_role`.
   - Hệ thống tự động đăng ký Page subscription cho cả `messages` và `leadgen`.
   - Tự động kích hoạt đợt đồng bộ cấu trúc quảng cáo đầu tiên ngầm dưới nền.

---

## 5. Cơ Chế Tiếp Nhận Lead & Ghi Nhận Attribution

### 5.1. Luồng Facebook Lead Ads (Instant Forms)
1. Khi khách hàng điền biểu mẫu tức thì, Meta gửi webhook sự kiện `leadgen` đến `/api/webhooks/meta`.
2. Hệ thống kiểm tra chữ ký `x-hub-signature-256` bằng `META_APP_SECRET` theo cơ chế fail-closed.
3. Webhook parser tách riêng luồng `entry.changes[field === 'leadgen']`, không đưa vào chat stream của Messenger.
4. Server dùng Page Access Token gọi Graph API `GET /v26.0/{leadgen_id}` để lấy chi tiết các câu trả lời (`field_data`), `form_id` và `field_data`; `ad_id` lấy từ webhook đã xác minh chữ ký, mapping campaign chỉ lấy từ dữ liệu Ads đã sync.
5. Số điện thoại được chuẩn hoá sang định dạng chuẩn quốc tế (`+84...`).
6. Gọi RPC `han_ingest` tạo Customer và Interaction với `p_key = page_id:leadgen:leadgen_id`. Webhook gửi lại (retry) từ Meta sẽ được xử lý idempotent, **không tạo trùng khách hàng hay tương tác**.
7. Gọi RPC `record_lead_attribution_touchpoint` ghi nhận touchpoint:
   - Nếu `leadData` đã có tên chiến dịch/quảng cáo -> snapshot trực tiếp.
   - Nếu webhook chỉ có `ad_id` -> database tự động tra cứu từ bảng `meta_ads` đã đồng bộ để điền `campaign_name_snapshot` và `ad_name_snapshot`.
   - Cập nhật snapshot First-Touch (nếu là khách mới) và Latest-Touch trên bản ghi `customers`.

### 5.2. Luồng Click-to-Messenger Ads
1. Khách hàng bấm vào quảng cáo Messenger và bắt đầu hội thoại với Page.
2. Webhook nhận tin nhắn đầu tiên có chứa trường `referral` (hoặc `messaging.referral` / `message.referral`):
   - Đọc `source = 'ADS'`, `ad_id`, `ref`, `ads_context_data` (tiêu đề quảng cáo, link ảnh).
3. Đưa thông tin referral vào payload của `han_ingest`.
4. Gọi `record_lead_attribution_touchpoint` với loại kênh `FACEBOOK_MESSENGER` và nguồn `CLICK_TO_MESSENGER`.
5. Tự động tra cứu `meta_ads` để gắn tên chiến dịch và tên quảng cáo vào cuộc trò chuyện và khách hàng.
6. Nếu khách nhắn tin tự nhiên không qua quảng cáo, nguồn được lưu là `FACEBOOK_MESSENGER` với trạng thái `UNATTRIBUTED`, tuyệt đối không gán bừa chiến dịch từ Page ID.

### 5.3. Luồng Website Lead & UTM
1. Khách hàng gửi form trên Website: API `/api/website/leads` tiếp nhận các tham số UTM hợp lệ:
   - `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `fbclid`.
2. Kiểm tra Turnstile CAPTCHA, rate limit và idempotency key.
3. Ghi nhận touchpoint kênh `WEBSITE` kèm các tham số UTM đã xác thực.

---

## 6. Đồng Bộ Cấu Trúc Quảng Cáo & Số Liệu Insights

### 6.1. Dữ liệu đồng bộ
- **Ad Accounts**: ID, tên, trạng thái, đơn vị tiền tệ (`VND`).
- **Campaigns**: ID, tên, trạng thái (`ACTIVE`, `PAUSED`, `ARCHIVED`), mục tiêu, ngân sách ngày/trọn đời.
- **Ad Sets**: ID, tên, campaign ID cha, ngân sách, trạng thái.
- **Ads**: ID, tên, ad set ID cha, campaign ID cha, tiêu đề/nội dung quảng cáo mẫu.
- **Meta Lead Forms**: ID, tên biểu mẫu, trạng thái, câu hỏi khảo sát.
- **Daily Insights**: Chi phí (Spend), lượt hiển thị (Impressions), lượt nhấp (Clicks), CTR, CPC, CPM, số lead Meta ghi nhận (`meta_leads`).

### 6.2. Cơ chế phân trang & Rate-limit Handling
- Mọi truy vấn Marketing API đều phân trang với `limit=100` và cursor `after`.
- Bộ bọc HTTP `fetchWithBackoff` tự động xử lý:
  - Khi gặp HTTP 429 hoặc Meta Error Code 17 / 613 (User/App Rate Limit reached): Tự động tạm dừng và retry theo thuật toán Exponential Backoff (1s, 2s, 4s).
  - Khi gặp Meta Error Code 190 (Token Expired / Invalidated): Dừng ngay lập tức, đánh dấu trạng thái lỗi `FAILED` trên `meta_ad_accounts` để người quản trị kết nối lại, tránh lặp vô tận.

### 6.3. Kích hoạt đồng bộ
1. **Tự động qua Cron**:
   - Endpoint: `GET /api/cron/meta-ads-sync`
   - Header: `Authorization: Bearer <CRON_SECRET>`
   - Khuyến nghị cấu hình cron job chạy 1 - 2 lần mỗi ngày (ví dụ 02:00 sáng và 14:00 chiều).
2. **Thủ công trên giao diện**:
   - Quản trị viên cấp cao nhấn nút **"Đồng bộ ngay"** trên trang `/admin/facebook` hoặc `/admin/analytics/meta-ads`.

---

## 7. Báo Cáo Hiệu Quả Quảng Cáo (Meta Ads Analytics)

Truy cập giao diện báo cáo tại **Phân tích > Báo cáo Meta Ads** (`/admin/analytics/meta-ads`).

### 7.1. Các chỉ số KPI chính
- **Tổng ngân sách đã chi tiêu (Spend)**: Lấy từ Meta Insights API theo khoảng thời gian.
- **Lượt hiển thị (Impressions) & Lượt click**: Số lần quảng cáo xuất hiện và số lần người dùng tương tác.
- **Tỷ lệ Click (CTR)**: `(Clicks / Impressions) * 100%`.
- **Số Lead từ Meta báo cáo**: Số chuyển đổi lead Meta ghi nhận.
- **Số Lead CRM thực tế tiếp nhận**: Số lượng khách hàng thực tế đã được tiếp nhận vào CRM từ kênh Meta.
- **Số Lead được Attribution chính xác**: Số lead liên kết rõ ràng với chiến dịch/quảng cáo.
- **Chi phí trên mỗi Lead (CPL)**: `Spend / Số Lead CRM`.
- **Chi phí trên Lead chất lượng (Cost per Qualified Lead)**: `Spend / Số Lead đạt giai đoạn khảo sát/hợp đồng`.

### 7.2. Xử lý an toàn toán học
Hàm RPC `get_meta_ads_performance_report` xử lý an toàn phép chia cho 0:
- Khi `leads = 0` hoặc `impressions = 0`, giá trị CPL và CTR trả về `0`, không bao giờ gây lỗi chia cho 0 (`NaN` hay `Infinity`).

---

## 8. Hướng Dẫn Gia Hạn & Xử Lý Lỗi Token

### 8.1. Token hết hạn (Lỗi 190)
- **Dấu hiệu**: Bảng tài khoản quảng cáo báo trạng thái `FAILED` với thông báo `Session has expired` hoặc `Error validating access token`.
- **Cách xử lý**:
  1. Đăng nhập CRM bằng tài khoản `BOSS_ADMIN`.
  2. Truy cập `/admin/facebook`.
  3. Bấm **"Kết nối lại Meta OAuth"** để cấp lại token mới.
  4. Sau khi cấp lại, bấm **"Đồng bộ ngay"** để khôi phục hoạt động đồng bộ.

### 8.2. Sự cố Webhook không nhận Lead Ads
- **Kiểm tra**:
  1. Vào Meta App Dashboard > Webhooks > Page. Kiểm tra xem sự kiện `leadgen` có đang gửi test event thành công không.
  2. Đảm bảo Facebook Page đã được cài đặt ứng dụng CRM trong phần **Cài đặt Trang > Tích hợp kinh doanh (Business Integrations)**.
  3. Kiểm tra log hệ thống: tìm kiếm tiền tố `[meta-webhook]` và `[lead-ads]`.

---

## 9. Danh Sách Kiểm Tra An Toàn (Production Checklist)

- [ ] Xác nhận trên môi trường phát hành: cấu hình `META_TOKEN_ENCRYPTION_KEY` an toàn (32 bytes).
- [ ] Xác nhận trên môi trường phát hành: thiết lập `META_APP_SECRET` và `META_VERIFY_TOKEN`.
- [x] Webhook `x-hub-signature-256` xác minh nghiêm ngặt, fail-closed khi sai chữ ký.
- [x] Toàn bộ dữ liệu Meta Ads có RLS cô lập theo `company_id`.
- [x] Zero-Phone compliance: không xuất hiện số điện thoại thô trên giao diện hoặc public payload.
- [x] Phân quyền chặt chẽ: chỉ `BOSS_ADMIN` mới có quyền kích hoạt đồng bộ hoặc kết nối OAuth.
- [x] Kiểm thử tự động và database: xem kết quả cuối trong runbook; chạy lại với `npm run test:meta-ads`.


### Final remediation release gate (2026-10-30)

See [META_ADS_PR139_REMEDIATION.md](META_ADS_PR139_REMEDIATION.md) for the authoritative migration/key runbook and validation record. The earlier readiness checklist does not authorize production release.

Graph/Messenger and Marketing use separate version settings. Both default to `v26.0`; Marketing accepts `v25.0`/`v26.0` only. Basic lead retrieval requests `id,created_time,form_id,field_data`. Ad identifiers arrive in the signed webhook and must map to this company's synced Ads/campaign records before attribution. Webhook-provided names and status never become attribution evidence. `ads_management` and `pages_manage_ads` are omitted from default OAuth scopes; ad-specific Lead fields are intentionally not requested.

Token RPCs are service-role only. Ordinary members can read allowed reporting tables but cannot write synced evidence or overwrite stored credentials.
