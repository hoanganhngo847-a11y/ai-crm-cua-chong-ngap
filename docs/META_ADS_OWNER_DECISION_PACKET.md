# TÀI LIỆU QUYẾT ĐỊNH CÁC THAY ĐỔI CƠ SỞ DỮ LIỆU DÀNH CHO CHỦ SỞ HỮU (OWNER DECISION PACKET)
## Dự án: CRM Tư Vấn Du Học & Đào Tạo Ngoại Ngữ – Triển Khai Meta Ads Integration
**Kho lưu trữ (Repository):** `hoanganhngo847-a11y/ai-crm-cua-chong-ngap`  
**Nhánh (Branch):** `meta_ads_integration` | **Pull Request:** [PR #139](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/pull/139) (Open + Draft)  
**Mục tiêu:** Cung cấp bức tranh toàn diện, bằng ngôn ngữ kinh doanh và tiếng Việt thuần túy, giúp Chủ sở hữu (Owner) hiểu rõ và ra quyết định chính xác cho 160 mục thay đổi cơ sở dữ liệu có tính chất tác động (destructive / replacement), bảo vệ an toàn tuyệt đối cho CRM tư vấn du học, kênh Facebook Messenger, Zalo OA/Cá nhân, và tích hợp chiến dịch quảng cáo Meta Ads.

---

## 1. TÓM TẮT ĐIỀU HÀNH DÀNH CHO CHỦ SỞ HỮU (EXECUTIVE SUMMARY)

Kính gửi Chủ sở hữu hệ thống CRM,

Hệ thống CRM hiện tại đang phục vụ trực tiếp cho hoạt động kinh doanh cốt lõi của doanh nghiệp:
1. **Tư vấn du học & Đào tạo ngoại ngữ:** Quản lý thông tin học viên, phụ huynh, trạng thái tư vấn và hồ sơ du học.
2. **Giao tiếp đa kênh (Omnichannel):** Trò chuyện qua Facebook Messenger, Zalo OA và Zalo cá nhân.
3. **Trợ lý AI tự động (AI Brain & Javis):** Hỗ trợ trả lời tin nhắn tự động ban đầu, phân loại nhu cầu học viên và tóm tắt cuộc gọi tư vấn.
4. **Tiếp nhận khách hàng tiềm năng từ Meta Ads (Meta Ads Lead Attribution):** Tự động thu thập Lead từ các biểu mẫu (Lead Form) trên Facebook Ads, phân bổ về đúng chiến dịch và kết nối với hồ sơ học viên.

Trong quá trình chuẩn bị đưa tính năng **Meta Ads** lên môi trường chạy thử (Staging) và môi trường thực tế (Production), đội ngũ kỹ thuật đã rà soát toàn bộ lịch sử 121 tệp mã cơ sở dữ liệu (migration). Kết quả kiểm tra ghi nhận:
- Có tổng cộng **178 mục thay đổi có tác động đến cấu trúc** (xóa bảng, xóa hàm, sửa phân quyền, thay đổi ràng buộc dữ liệu hoặc di chuyển token bảo mật).
- Trong đó, **18 mục** đã được áp dụng trước đây trên môi trường Staging hiện tại và đang hoạt động ổn định.
- Còn lại **160 mục đang chờ quyết định (Pending Items)** chưa từng được áp dụng lên Staging.
- **Hiện tại chưa có bất kỳ mục nào được tự ý phê duyệt (Tất cả đều hiển thị NOT APPROVED).**

### Kết luận quan trọng nhất dành cho Chủ sở hữu:
> [!IMPORTANT]
> **ĐỀ XUẤT CỦA ĐỘI NGŨ KỸ THUẬT: CHƯA ĐƯỢC CHẠY TOÀN BỘ 160 MỤC MỘT CÁCH TỰ ĐỘNG.**
> - **Tuyệt đối hoãn lại (DEFER)** việc xóa 14 bảng và 33 hàm thuộc nghiệp vụ "Cửa chống ngập cũ" (Gói 1 - 47 mục). Mặc dù doanh nghiệp đã ngừng kinh doanh cửa chống ngập, việc xóa dữ liệu cũ trong lúc đang triển khai Meta Ads là **rất mạo hiểm và không cần thiết**, có nguy cơ gây lỗi dây chuyền cho các tính năng khác (như lỗi hàm kiểm tra chất lượng QC và mất đường dẫn tải tài liệu cũ).
> - **Phê duyệt theo gói nghiệp vụ (Batched Decisions)** cho các tính năng phục vụ trực tiếp Du học, Facebook, Zalo, AI và Meta Ads sau khi đã kiểm tra tương thích và sao lưu dữ liệu an toàn.

---

## 2. BẢN CHẤT 160 MỤC ĐANG CHỜ PHÊ DUYỆT LÀ GÌ?

Trong ngành cơ sở dữ liệu, một thao tác được xếp vào nhóm **"Destructive / Impactful" (Có tính tác động/thay đổi)** khi nó thực hiện một trong các hành động sau:
1. **Xóa bảng hoặc xóa cột (DROP TABLE, DROP COLUMN):** Dữ liệu lưu trong bảng hoặc cột đó sẽ biến mất vĩnh viễn khỏi hệ thống nếu không có bản sao lưu (backup).
2. **Xóa hàm xử lý cũ để thay bằng hàm mới (DROP FUNCTION / CREATE OR REPLACE):** Code xử lý logic cũ bị gỡ bỏ. Nếu phần mềm hoặc đối tác bên ngoài vẫn đang gọi cú pháp cũ, hệ thống sẽ báo lỗi không tìm thấy hàm (Function Not Found).
3. **Thay đổi phân quyền bảo mật (DROP POLICY, REVOKE, RLS):** Thay đổi ai được phép xem, sửa hoặc xóa dữ liệu. Nếu làm sai, nhân viên tư vấn có thể bị mất quyền truy cập hoặc ngược lại làm lộ dữ liệu nội bộ.
4. **Thay đổi điều kiện ràng buộc dữ liệu (DROP CONSTRAINT):** Ví dụ như thay đổi danh sách trạng thái của tin nhắn gửi đi hoặc trạng thái của khách hàng trong phễu tư vấn.
5. **Di chuyển khóa bí mật (Token Migration):** Đưa mã token truy cập từ bảng thông thường vào "két sắt mã hóa" bảo mật (Supabase Vault hoặc private schema) để ngăn chặn rò rỉ thông tin ra bên ngoài.

**160 mục này KHÔNG PHẢI là một danh sách lỗi hư hỏng.** Đây là tập hợp các bước nâng cấp và tinh chỉnh mà các lập trình viên đã viết qua các phiên bản phần mềm. Tuy nhiên, vì chúng có can thiệp vào cấu trúc lưu trữ, **chủ sở hữu cần biết rõ từng nhóm phục vụ việc gì và có ảnh hưởng đến việc tư vấn tuyển sinh hay không trước khi bấm nút đồng ý.**

---

## 3. MƯỜI CÂU HỎI CỐT LÕI MÀ CHỦ SỞ HỮU CẦN ĐƯỢC GIẢI ĐÁP

Trước khi ra quyết định, Chủ sở hữu cần câu trả lời rõ ràng cho 10 câu hỏi sau:

1. **Cái gì sẽ bị xóa hoặc thay đổi?**
   - 14 bảng và 33 hàm của nghiệp vụ chống ngập cũ (khảo sát, sản xuất, lắp đặt, bảo hành).
   - 5 cột lưu token Zalo và 2 cột token Facebook dạng chữ thường (plaintext) sẽ được chuyển vào vùng bảo mật private/vault.
   - Các hàm tiếp nhận tin nhắn Zalo, hàm điều phối tin nhắn AI, hàm ghi nhận Lead Meta Ads và ràng buộc trạng thái phễu 6 giai đoạn du học sẽ được cập nhật phiên bản mới.
2. **Tại sao thay đổi này lại được đưa ra?**
   - Để làm sạch hệ thống, loại bỏ các bảng không còn kinh doanh, nâng cấp bảo mật tránh lộ token quảng cáo/Zalo, và tối ưu hóa hệ thống để AI và nhân viên tư vấn phối hợp nhịp nhàng, không tranh chấp tin nhắn của phụ huynh/học viên.
3. **Tính năng CRM nào hiện đang dùng nó?**
   - Tính năng tư vấn du học đang dùng hệ thống phễu 6 bước, quản lý lịch sử chat Messenger/Zalo, ghi âm cuộc gọi và tiếp nhận Lead từ Facebook.
   - Các bảng chống ngập cũ hiện tại không có luồng giao diện (UI) nào của mảng du học bấm vào, nhưng mã nguồn nhạy cảm (Signed URLs tải tài liệu) vẫn đang có các nhánh xử lý đọc vào bảng hợp đồng cũ.
4. **Nếu giữ lại (chưa xóa) thì có sao không?**
   - **Hoàn toàn không sao.** Giữ lại các bảng cũ chỉ tốn thêm một lượng dung lượng lưu trữ cực nhỏ trong cơ sở dữ liệu (các bảng này hiện đang có 0 bản ghi trên Staging). Việc giữ lại giúp hệ thống không bị lỗi thiếu bảng nếu vô tình có mã nguồn cũ gọi tới.
5. **Nếu xóa/thay đổi thì sao?**
   - Nếu xóa bảng chống ngập ngay lập tức: Mất vĩnh viễn cấu trúc bảng; nhân viên không thể tải lại các hợp đồng cũ nếu từng có; hàm kiểm tra chất lượng QC bị hỏng (lỗi SQLSTATE 42704).
   - Nếu thay đổi các hàm Facebook/Zalo/Meta Ads: Hệ thống sẽ chạy theo logic mới an toàn và bảo mật hơn, nhưng cần chạy đồng bộ với mã nguồn backend Render.
6. **Có ảnh hưởng tới Messenger, Zalo, Meta Ads, AI hay quản lý khách hàng không?**
   - Các mục thuộc Gói 1 và Gói 5 (nghiệp vụ chống ngập cũ) **không ảnh hưởng** tới việc chat hay lấy Lead.
   - Các mục thuộc Gói 3, 6, 8, 10, 12, 13 **ảnh hưởng trực tiếp** tới luồng gửi tin Zalo, AI trả lời Messenger, quy định xóa dữ liệu của Meta và ghi nhận Lead từ Facebook Ads. Do đó cần phê duyệt có kiểm soát.
7. **Hiện tại có dữ liệu thực tế bên trong hay không?**
   - Trên môi trường Staging: Toàn bộ 14 bảng chống ngập cũ **đều có 0 dòng dữ liệu (trống rỗng)**.
   - Trên môi trường Production: Cần kiểm tra số lượng hợp đồng hoặc liên hệ cũ trước khi tiến hành bất kỳ kế hoạch dọn dẹp nào trong tương lai.
8. **Thay đổi có thể đảo ngược (rollback) được không nếu gặp sự cố?**
   - **Không thể đảo ngược bằng lệnh thông thường** nếu đã lỡ xóa bảng hoặc xóa cột dữ liệu.
   - Cách duy nhất để khôi phục là **sử dụng bản sao lưu (backup snapshot)** của toàn bộ cơ sở dữ liệu đã chụp lại ngay trước thời điểm thực hiện.
9. **Đội ngũ kỹ thuật đề xuất phương án nào?**
   - **Tách biệt hoàn toàn:** Hoãn lại việc xóa hệ thống chống ngập cũ.
   - Chỉ áp dụng các gói di chuyển token bảo mật, cập nhật phễu 6 giai đoạn du học và kích hoạt tính năng tiếp nhận Lead Meta Ads.
10. **Quyết định cụ thể mà Chủ sở hữu phải đưa ra là gì?**
    - Ký duyệt phê duyệt theo từng **Gói quyết định (Decision Batches)** cụ thể từ Gói 1 đến Gói 13 được trình bày chi tiết dưới đây.

---

## 4. BẢNG PHÂN CHIA 13 GÓI QUYẾT ĐỊNH NGHIỆP VỤ (DECISION BATCHES)

Để Chủ sở hữu không phải đọc 160 dòng lệnh kỹ thuật rời rạc, toàn bộ các mục đã được gom nhóm chính xác thành **13 gói quyết định theo nghiệp vụ**:

| Mã Gói | Tên Gói Nghiệp Vụ | Số Mục | Mức Rủi Ro | Đề Xuất Kỹ Thuật | Có Chặn Meta Ads Staging? |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **BATCH-01** | Bảng và hàm nghiệp vụ Cửa chống ngập cũ | 47 | CAO | **DEFER (Hoãn lại)** | **KHÔNG** |
| **BATCH-02** | Hàm tính SLA phản hồi TV9 | 1 | TRUNG BÌNH | **REPLACE (Thay thế)** | **KHÔNG** |
| **BATCH-03** | Bảo mật Token Zalo OA & Ingress/Outbound | 15 | CAO | **REPLACE (Thay thế)** | **KHÔNG** |
| **BATCH-04** | Bảo mật tệp Storage & RLS Hợp đồng | 14 | TRUNG BÌNH | **REPLACE (Thay thế)** | **KHÔNG** |
| **BATCH-05** | Phân quyền Lắp đặt, Lịch hẹn & Backend cũ | 9 | TRUNG BÌNH | **DEFER (Hoãn lại)** | **KHÔNG** |
| **BATCH-06** | Rào chắn AI Sale Fencing & Điều phối tin gửi | 7 | CAO | **REPLACE (Thay thế)** | **KHÔNG** |
| **BATCH-07** | Hàng đợi gửi tin trình duyệt Facebook Browser | 5 | THẤP | **REPLACE (Thay thế)** | **KHÔNG** |
| **BATCH-08** | Tuân thủ xóa dữ liệu Meta Data Deletion | 6 | CAO | **REPLACE (Thay thế)** | **KHÔNG** |
| **BATCH-09** | Trung tâm điều khiển AI & Cảnh báo giám sát | 12 | TRUNG BÌNH | **REPLACE (Thay thế)** | **KHÔNG** |
| **BATCH-10** | Bộ lập lịch tự động kích hoạt AI Messenger | 10 | CAO | **REPLACE (Thay thế)** | **KHÔNG** |
| **BATCH-11** | Chiến dịch Zalo cá nhân & Tóm tắt cuộc gọi AI | 12 | TRUNG BÌNH | **REPLACE (Thay thế)** | **KHÔNG** |
| **BATCH-12** | Phễu 6 giai đoạn du học & AI gợi ý giai đoạn | 17 | CAO | **REPLACE (Thay thế)** | **KHÔNG** |
| **BATCH-13** | Bảo mật Token & Tiếp nhận Lead Meta Ads | 5 | CAO | **REPLACE (Thay thế)** | **CÓ (BẮT BUỘC)** |
| **TỔNG CỘNG** | **13 Gói Quyết Định** | **160** | | | |

---

## 5. ĐIỀU TRA CHI TIẾT 6 VẤN ĐỀ TRỌNG YẾU CẦN CHỦ SỞ HỮU LƯU TÂM ĐẶC BIỆT

### Vấn đề A: Kế hoạch xóa bỏ nghiệp vụ Cửa chống ngập cũ (Gói 1 - File `20261029160000_remove_legacy_flood_barrier_schema.sql`)
- **Nội dung:** Tệp này muốn xóa 14 bảng (`surveys`, `installations`, `production_orders`, `contracts`, `orders`, `price_calculations`, `pricing_policies`, `warranty_tickets`, `company_bank_accounts`, `appointments`, `finance_summaries`, `operations_outbox`, `payment_transactions`, `survey_photo_operations`) và 33 hàm liên quan.
- **Phân tích thực tế:**
  1. Doanh nghiệp đã chuyển hướng sang Du học & Ngoại ngữ, không còn dùng các bảng này cho hoạt động mới.
  2. Tuy nhiên, việc chạy tệp này vào lúc này sẽ gây lỗi hệ thống nghiêm trọng vì nó vô tình bỏ sót hàm kiểm tra chất lượng (QC) không xóa, dẫn tới lỗi biên dịch trong cơ sở dữ liệu.
  3. Mã nguồn máy chủ hiện tại (`lib/sensitive/signed-urls.ts`) vẫn còn chứa các đoạn code kiểm tra bảng `surveys` và `contracts` khi người dùng yêu cầu xem tệp hợp đồng cũ.
- **Khuyến nghị cho Chủ sở hữu:** **CHỌN DEFER (HOÃN LẠI)**. Tệp migration này chưa từng được chạy trên Staging hay Production. Hoãn lại tệp này không ảnh hưởng gì tới việc chạy quảng cáo Facebook hay lấy Lead. Đội ngũ kỹ thuật sẽ lập một đề án dọn dẹp độc lập (Clean-up Plan) vào thời điểm phù hợp sau.

### Vấn đề B: Lỗi hàm kiểm định chất lượng QC API (`record_quality_check_atomic`)
- **Hiện tượng kỹ thuật:** Khi kiểm thử chạy toàn bộ chuỗi migration trên máy nội bộ, hệ thống báo lỗi **SQLSTATE 42704: type "public.production_orders" does not exist**.
- **Giải thích cho Chủ sở hữu:**
  - Hàm `record_quality_check_atomic` là hàm ghi nhận kết quả kiểm định chất lượng sản xuất thanh chống ngập (Đạt / Cần sửa / Từ chối).
  - Tệp dọn dẹp đã xóa bảng `production_orders` nhưng lại "quên" không xóa hàm này.
  - Khi một hàm tham chiếu tới một bảng đã bị xóa, hàm đó trở thành "hàm mồ côi bị lỗi". Bất kỳ ai hay tiến trình nào chạm vào hàm này sẽ làm sập giao dịch database.
- **Giải pháp an toàn nhất:** Khi chúng ta hoãn Gói 1 (chưa xóa bảng `production_orders`), lỗi này sẽ **hoàn toàn không xảy ra**. Sau này khi dọn dẹp chính thức, kỹ thuật sẽ bổ sung lệnh xóa hàm này trong cùng một lượt.

### Vấn đề C: Rủi ro mất liên kết tải tệp tài liệu và hợp đồng lịch sử (Signed URLs)
- **Hệ thống tệp hiện tại:** Hệ thống hỗ trợ 4 loại tệp nhạy cảm:
  1. `SURVEY`: Ảnh khảo sát công trình cũ.
  2. `CONTRACT`: Bản hợp đồng (tệp PDF tạo tự động hoặc đã ký).
  3. `INSTALLATION`: Ảnh hiện trường thi công và biên bản bàn giao cũ.
  4. `RECORDING`: Tệp ghi âm cuộc gọi tư vấn du học (Đang sử dụng tích cực cho CRM du học).
- **Phân tích rủi ro:**
  - Kho lưu trữ Supabase Storage lưu tệp nhị phân độc lập với cơ sở dữ liệu. **Nếu xóa bảng trong database, tệp trên Storage KHÔNG tự mất đi.**
  - Nhưng để nhân viên tải được tệp hợp đồng hay biên bản bàn giao cũ, phần mềm bắt buộc phải đọc vào bảng `contracts` hoặc `installations` để xác minh quyền hạn rồi mới cấp link tải an toàn (Signed URL).
  - Nếu xóa bảng trong database, nhân viên sẽ bị mất hoàn toàn khả năng lấy link tải hợp đồng cũ!
- **Khuyến nghị chiến lược lưu trữ:**
  - Nhóm `RECORDING` (Ghi âm cuộc gọi) được bảo toàn 100% vì nằm trên bảng `calls` độc lập.
  - Đối với các hợp đồng cũ: Cần giữ lại bảng hoặc xuất bản lưu trữ (archive export) toàn bộ tệp và siêu dữ liệu ra ổ cứng an toàn trước khi xóa bất kỳ bảng nào.

### Vấn đề D: Thay đổi hàm tính thời gian phản hồi SLA TV9 (`resolve_response_sla_on_sale_reply`)
- **Mục đích:** CRM có tính năng đo lường: "Khi phụ huynh nhắn tin, nhân viên tư vấn mất bao nhiêu phút để trả lời?".
- **Thay đổi kỹ thuật:**
  - Bản cũ: Chấp nhận 3 tham số (Công ty, Hội thoại, Tin nhắn phản hồi của Sale).
  - Bản mới: Thêm tham số thứ 4 (Thời gian hoàn tất SLA thực tế, mặc định là NULL).
  - Ngữ nghĩa mới: Hệ thống yêu cầu tin nhắn gửi đi phải ở trạng thái "ĐÃ GỬI THÀNH CÔNG" (SENT) thì mới chốt chỉ số SLA, tránh việc nhân viên bấm gửi nhưng tin nhắn bị lỗi mạng mà vẫn được tính là đã chăm sóc khách hàng.
- **Khuyến nghị:** **CHỌN REPLACE**. Hàm mới có giá trị mặc định nên tương thích ngược với code gọi 3 tham số, nâng cao độ chính xác trong việc đánh giá hiệu quả của tư vấn viên.

### Vấn đề E: Di chuyển và bảo vệ khóa bí mật Zalo OA (`zalo_oa_configs`)
- **Mục đích:** Nâng cao an ninh cấp độ doanh nghiệp.
- **Bản chất thay đổi:**
  - Trước đây: Mã bí mật (`app_secret`), mã truy cập (`access_token`), mã làm mới (`refresh_token`) được lưu ở bảng `public.zalo_oa_configs`. Bảng công khai này có rủi ro bị lộ nếu có lỗ hổng đọc API từ phía trình duyệt.
  - Bản mới: Chuyển toàn bộ 5 cột token sang bảng nội bộ `private.zalo_oa_secrets` (ngăn chặn mọi truy cập từ bên ngoài), sau đó xóa 5 cột này ở bảng public.
- **Bảo toàn dữ liệu:** Quá trình di chuyển sao chép dữ liệu trước khi xóa cột. Không làm mất kết nối Zalo OA hiện tại của doanh nghiệp.
- **Khuyến nghị:** **CHỌN REPLACE**. Bắt buộc phải làm để bảo mật thông tin tài khoản Zalo của công ty.

### Vấn đề F: Các hàm RPC dùng chung cho Messenger, Zalo và Meta Ads
- Một số hàm xử lý tin nhắn có tên gọi lịch sử như `han_finish_send`, `han_record_data_deletion_request`, `claim_pending_outbound_deliveries`.
- Dù tiền tố tên có thể mang dấu ấn lịch sử, đây là các **hàm huyết mạch phục vụ trực tiếp việc gửi nhận tin nhắn Messenger, tiếp nhận Lead Form từ Facebook và đồng bộ trạng thái chat**.
- **Nguyên tắc bất di bất dịch:** Tuyệt đối không xóa bất kỳ hàm nào thuộc nhóm này. Toàn bộ các thay đổi đều là nâng cấp để tăng tính chịu tải và chống nghẽn hàng đợi.

---

## 6. CHI TIẾT TỪNG GÓI QUYẾT ĐỊNH VÀ PHƯƠNG ÁN XỬ LÝ

### Gói 1: BATCH-01-LEGACY-FLOOD (47 mục)
- **Danh sách ID:** `M113-S015.DO1.target1` đến `target33` (33 hàm) và `M113-S016.target1` đến `target14` (14 bảng).
- **Hành động kỹ thuật:** Xóa bảng và hàm chống ngập bằng lệnh `DROP TABLE/FUNCTION CASCADE`.
- **Nếu Chủ sở hữu ĐỒNG Ý:** Xóa sạch 14 bảng và 33 hàm; mất khả năng tra cứu hợp đồng cũ qua link bảo mật; để lại lỗi hàm QC mồ côi.
- **Nếu Chủ sở hữu TỪ CHỐI / HOÃN (Đề xuất):** Giữ nguyên hiện trạng cơ sở dữ liệu; không phát sinh lỗi; đảm bảo triển khai Meta Ads an toàn tuyệt đối.
- **Khuyến nghị:** **DEFER (HOÃN LẠI TOÀN BỘ GÓI 1)**.

### Gói 2: BATCH-02-TV9-SLA (1 mục)
- **Danh sách ID:** `M022-S020.target1` (`public.resolve_response_sla_on_sale_reply`).
- **Hành động kỹ thuật:** Cập nhật hàm tính SLA phản hồi tư vấn viên.
- **Nếu Đồng ý:** Đo lường chính xác thời gian trả lời tin nhắn của tư vấn viên dựa trên tin nhắn gửi thành công thực tế.
- **Khuyến nghị:** **REPLACE (CHẤP THUẬN THAY THẾ)**.

### Gói 3: BATCH-03-ZALO-SECRETS (15 mục)
- **Danh sách ID:** `M024-S010.ALTER1.target1`, `M025-S001.target1` đến `S004.target1`, `M025-S008.ALTER1.target1` đến `ALTER5.target1` (5 cột token), `M025-S029.ALTER1.target1`, `M025-S031.ALTER1.target1`, `M025-S033.target1`, `M025-S042.ALTER1.target1`, `M025-S051.ALTER1.target1`.
- **Hành động kỹ thuật:** Chuyển token Zalo vào két sắt bảo mật private; chuẩn hóa tiếp nhận và phản hồi tin nhắn Zalo OA.
- **Nếu Đồng ý:** Bảo vệ an toàn token Zalo của doanh nghiệp, chống lộ lọt thông tin.
- **Khuyến nghị:** **REPLACE (CHẤP THUẬN BẢO MẬT)**.

### Gói 4: BATCH-04-STORAGE-CONTRACTS (14 mục)
- **Danh sách ID:** `M026-S003.target1`, `M029-S002.target1` đến `S008.target1` (4 policies contracts), `M030-S005.target1`, `M044-S002.target1` đến `S017.target1` (8 policies storage).
- **Hành động kỹ thuật:** Chặn trình duyệt đọc/ghi trực tiếp lên kho lưu trữ Storage, bắt buộc đi qua xác thực máy chủ.
- **Nếu Đồng ý:** Tệp tài liệu học viên, hợp đồng và hồ sơ được bảo vệ nghiêm ngặt, chỉ người có thẩm quyền mới mở được.
- **Khuyến nghị:** **REPLACE (CHẤP THUẬN BẢO MẬT)**.

### Gói 5: BATCH-05-OPERATIONS-LEGACY (9 mục)
- **Danh sách ID:** `M031-S001.target1` (claim_voice_media_jobs 1 arg), `M031-S006.target1`, `M031-S007.target1`, `M043-S001.target1` đến `S007.target1` (RLS appointments), `M043-S009.target1`, `M043-S010.target1`.
- **Hành động kỹ thuật:** Tinh chỉnh các chính sách lịch hẹn khảo sát/lắp đặt cũ và loại bỏ hàm công việc thoại cũ.
- **Khuyến nghị:** **DEFER (HOÃN LẠI)** cùng với đề án dọn dẹp cũ để tránh xáo trộn không cần thiết.

### Gói 6: BATCH-06-AI-OUTBOUND-FENCING (7 mục)
- **Danh sách ID:** `M033-S001.ALTER1.target1`, `M034-S001.ALTER1.target1`, `M035-S003.target1`, `M035-S004.target1`, `M035-S010.target1`, `M035-S011.target1`, `M061-S001.ALTER1.target1`.
- **Hành động kỹ thuật:** Thiết lập rào chắn AI Fencing: AI tự động dừng trả lời nếu nhân viên tư vấn đã vào tiếp quản cuộc trò chuyện trong vòng 10 phút gần nhất.
- **Nếu Đồng ý:** Tránh tình trạng AI và tư vấn viên nói tranh nhau hoặc đưa ra thông tin không khớp với phụ huynh/học viên.
- **Khuyến nghị:** **REPLACE (CHẤP THUẬN KÍCH HOẠT)**.

### Gói 7: BATCH-07-FACEBOOK-BROWSER-QUEUE (5 mục)
- **Danh sách ID:** `M049-S004.ALTER1.target1`, `M049-S006.ALTER1.target1`, `M050-S002.ALTER1.target1`, `M050-S004.ALTER1.target1`, `M050-S006.ALTER1.target1`.
- **Hành động kỹ thuật:** Mở rộng các trạng thái gửi tin trình duyệt cho hàng đợi `outbound_deliveries`.
- **Khuyến nghị:** **REPLACE (CHẤP THUẬN)**.

### Gói 8: BATCH-08-META-DATA-DELETION (6 mục)
- **Danh sách ID:** `M054-S003.ALTER1.target1`, `M054-S010.target1`, `M054-S015.target1`, `M054-S018.target1`, `M054-S019.target1`, `M054-S021.target1`.
- **Hành động kỹ thuật:** Xử lý yêu cầu xóa dữ liệu người dùng từ Facebook (Meta Data Deletion Callback) và tạo mã xác nhận trạng thái xóa.
- **Tầm quan trọng:** Bắt buộc phải có để Meta phê duyệt ứng dụng Facebook của doanh nghiệp chạy chính thức.
- **Khuyến nghị:** **REPLACE (CHẤP THUẬN BẮT BUỘC)**.

### Gói 9: BATCH-09-AI-CONTROL-MONITORING (12 mục)
- **Danh sách ID:** `M077-S001.ALTER1.target1`, `M077-S006.target1` đến `S014.target1` (5 RLS settings), `M078-S009.target1` đến `S013.target1` (3 RLS alerts), `M079-S001.target1`, `M081-S001.target1`, `M081-S002.target1`.
- **Hành động kỹ thuật:** Cho phép người quản trị bật/tắt AI theo kênh, chỉnh độ nhạy tin cậy và theo dõi cảnh báo khi AI gặp sự cố.
- **Khuyến nghị:** **REPLACE (CHẤP THUẬN)**.

### Gói 10: BATCH-10-MESSENGER-LIVE-SCHEDULER (10 mục)
- **Danh sách ID:** `M080-S014.ALTER1.target1` đến `S018.ALTER1.target1` (4 constraints), `M080-S022.target1`, `M080-S023.target1`, `M080-S027.DO7.target1`, `M105-S014.target1`, `M105-S015.target1`, `M105-S018.DO7.target1`.
- **Hành động kỹ thuật:** Cài đặt bộ lập lịch tự động kích hoạt AI quét tin nhắn Facebook Messenger mỗi phút.
- **Điều kiện đi kèm:** Chỉ bật khi đã cấu hình đúng Render URL và Vault Secret trong phần quản trị Supabase.
- **Khuyến nghị:** **REPLACE (CHẤP THUẬN CÓ ĐIỀU KIỆN KỸ THUẬT)**.

### Gói 11: BATCH-11-ZALO-CALLS-CAMPAIGN (12 mục)
- **Danh sách ID:** `M068-S031.target1`, `M088-S001.ALTER1.target1` đến `S016.target1` (6 mục chiến dịch Zalo), `M089-S005.target1`, `M090-S006.target1`, `M095-S001.ALTER1.target1` đến `S007.ALTER1.target1` (3 mục thoại trực tiếp).
- **Hành động kỹ thuật:** Hỗ trợ chiến dịch gửi tin chăm sóc học viên Zalo hàng loạt 5 phút một lần, tự động tóm tắt ghi âm cuộc gọi tư vấn bằng AI Gemini.
- **Khuyến nghị:** **REPLACE (CHẤP THUẬN)**.

### Gói 12: BATCH-12-CUSTOMER-FUNNEL-STAGES (17 mục)
- **Danh sách ID:** `M083-S001.ALTER1.target1`, `M099-S010.target1`, `M099-S013.target1`, `M100-S001.ALTER1.target1`, `M103-S006.target1` đến `S010.DO1.target2` (4 mục), `M104-S004.ALTER1.target1` đến `S055.target1` (8 mục phễu du học).
- **Hành động kỹ thuật:** Chuẩn hóa quy trình tư vấn du học thành 6 giai đoạn rõ ràng:
  1. `NEW_LEAD`: Học viên mới đăng ký từ Web / Facebook / Zalo.
  2. `POTENTIAL`: Đã liên hệ, có nhu cầu và tài chính phù hợp.
  3. `IN_CONSULTATION`: Đang tư vấn chọn trường, chọn ngành, chọn quốc gia.
  4. `APPLICATION_SUBMITTED`: Đã ký hợp đồng dịch vụ, đang làm hồ sơ visa.
  5. `COMPLETED`: Đã có visa, chuẩn bị xuất cảnh hoặc đã nhập học.
  6. `ALUMNI_CARE`: Chăm sóc cựu học viên, hỗ trợ gia hạn hoặc giới thiệu bạn bè.
- **Tính năng AI đi kèm:** AI tự động đọc nội dung chat và ghi âm để đề xuất: "Học viên này đã chốt hợp đồng, đề xuất chuyển sang giai đoạn Đang làm hồ sơ".
- **Khuyến nghị:** **REPLACE (CHẤP THUẬN KÍCH HOẠT)**.

### Gói 13: BATCH-13-META-ADS-INTEGRATION (5 mục)
- **Danh sách ID:** `M117-S008.ALTER1.target1`, `M117-S008.ALTER2.target1`, `M118-S010.target1`, `M118-S014.target1`, `M118-S033.target1`.
- **Hành động kỹ thuật:**
  1. Chuyển Access Token tài khoản quảng cáo Facebook vào Vault bí mật, xóa cột token văn bản rõ trên bảng công khai để bảo vệ ngân sách quảng cáo và tránh bị chiếm quyền tài khoản.
  2. Cập nhật hàm tiếp nhận Lead từ Facebook Lead Ads (`claim_meta_leadgen_event` và `finalize_meta_leadgen_event`): Khi phụ huynh điền biểu mẫu trên Facebook, dữ liệu lập tức đổ về CRM, tự động tạo khách hàng mới hoặc cập nhật lịch sử nếu trùng số điện thoại, và gắn nhãn chiến dịch quảng cáo tương ứng.
  3. Giải phóng khóa đồng bộ tài khoản quảng cáo (`release_meta_ad_account_sync_lease`) để tránh xung đột dữ liệu.
- **Tầm quan trọng:** Đây là mục tiêu chính của nhánh `meta_ads_integration`.
- **Khuyến nghị:** **REPLACE (CHẤP THUẬN BẮT BUỘC ĐỂ KÍCH HOẠT META ADS)**.

---

## 7. CÁC MỤC AN TÂM HOÃN LẠI VÀ CÁC MỤC BẮT BUỘC PHẢI SỬA CHỮA

### A. Các mục an tâm hoãn lại (DEFER - Tổng cộng 56 mục)
- **Toàn bộ Gói 1 (47 mục):** Các bảng và hàm cửa chống ngập cũ trong tệp `20261029160000_remove_legacy_flood_barrier_schema.sql`.
- **Toàn bộ Gói 5 (9 mục):** Các chính sách đặt lịch thi công, lịch hẹn khảo sát và hàm vật tư cũ.
- **Lý do an tâm:** Các mục này hoàn toàn độc lập với luồng tư vấn du học và Meta Ads. Hoãn lại các mục này giúp hệ thống Staging giữ nguyên vẹn nền tảng, không phát sinh bất kỳ rủi ro nào cho khách hàng và quảng cáo.

### B. Các mục kỹ thuật phải sửa chữa / chuẩn bị trước khi áp dụng toàn diện
1. **Sửa lỗi hàm QC API:** Khi thực hiện dự án dọn dẹp sau này, phải bổ sung lệnh xóa `DROP FUNCTION IF EXISTS public.record_quality_check_atomic` để triệt tiêu lỗi SQLSTATE 42704.
2. **Cấu hình Supabase Vault Secrets:** Trước khi kích hoạt Gói 10 (Bộ lập lịch Messenger) và Gói 13 (Meta Ads), kỹ sư vận hành phải nạp đầy đủ các biến môi trường vào Supabase Vault:
   - `ai_brain_live_messenger_endpoint`
   - `ai_brain_live_messenger_cron_secret`
   - Khóa giải mã Token Meta Ads.
3. **Sao lưu dữ liệu trước khi chạy:** Thực hiện sao lưu snapshot đầy đủ của cơ sở dữ liệu Staging trước khi bấm chạy bất kỳ gói nào từ Gói 2 đến Gói 13.

---

## 8. CÁC RÀO CẢN KỸ THUẬT CÒN LẠI TRƯỚC KHI DEPLOY STAGING (REMAINING TECHNICAL BLOCKERS)

Để đảm bảo tính minh bạch, đội ngũ kỹ thuật báo cáo rõ các rào cản kỹ thuật cần giải quyết theo thứ tự:
1. **Chờ quyết định chính thức từ Chủ sở hữu:** Chủ sở hữu ký duyệt bảng phê duyệt bên dưới.
2. **PR #139 giữ nguyên trạng thái Draft:** Tiếp tục giữ Pull Request ở trạng thái Draft cho đến khi hoàn tất kiểm thử Staging an toàn.
3. **Chưa có lệnh chạy di trú tự động (No Blind Push):** Không dùng lệnh `supabase db push` tự động để tránh việc chạy nhầm tệp Gói 1 vào Staging. Phải áp dụng cơ chế di trú tuần tự có kiểm soát (Append-only Ledger Executor).
4. **Cấu hình xác thực Webhook Meta:** Xác nhận URL Webhook Meta Ads và mã xác thực `META_WEBHOOK_VERIFY_TOKEN` trên Render backend Staging.

---

## 9. BIỂU MẪU GHI NHẬN QUYẾT ĐỊNH CỦA CHỦ SỞ HỮU (OWNER DECISION RECORD)

Chủ sở hữu vui lòng đánh dấu `[X]` vào lựa chọn của mình cho từng gói nghiệp vụ bên dưới:

| Mã Gói | Tên Gói Nghiệp Vụ | Đề Xuất Kỹ Thuật | LỰA CHỌN CỦA CHỦ SỞ HỮU | Ghi Chú Của Chủ Sở Hữu |
| :--- | :--- | :---: | :---: | :--- |
| **GÓI 1** | Bảng & hàm chống ngập cũ (47 mục) | **HOÃN LẠI (DEFER)** | [ ] ĐỒNG Ý HOÃN<br>[ ] PHÊ DUYỆT XÓA | Giữ lại cấu trúc cũ, lập kế hoạch dọn dẹp sau. |
| **GÓI 2** | Hàm tính SLA phản hồi TV9 (1 mục) | **THAY THẾ (REPLACE)** | [ ] ĐỒNG Ý<br>[ ] TỪ CHỐI | Cập nhật hàm tính thời gian phản hồi chuẩn. |
| **GÓI 3** | Bảo mật Token Zalo & Ingress (15 mục) | **THAY THẾ (REPLACE)** | [ ] ĐỒNG Ý<br>[ ] TỪ CHỐI | Chuyển token Zalo vào két sắt bảo mật private. |
| **GÓI 4** | Bảo mật Storage & Hợp đồng (14 mục) | **THAY THẾ (REPLACE)** | [ ] ĐỒNG Ý<br>[ ] TỪ CHỐI | Khóa quyền đọc trực tiếp file từ trình duyệt. |
| **GÓI 5** | Phân quyền Lắp đặt & Backend cũ (9 mục) | **HOÃN LẠI (DEFER)** | [ ] ĐỒNG Ý HOÃN<br>[ ] PHÊ DUYỆT | Hoãn lại cùng gói chống ngập cũ. |
| **GÓI 6** | Rào chắn AI Sale Fencing (7 mục) | **THAY THẾ (REPLACE)** | [ ] ĐỒNG Ý<br>[ ] TỪ CHỐI | Ngăn AI nói chen khi Sale đang tư vấn. |
| **GÓI 7** | Hàng đợi gửi tin Facebook (5 mục) | **THAY THẾ (REPLACE)** | [ ] ĐỒNG Ý<br>[ ] TỪ CHỐI | Tối ưu hóa gửi tin Messenger qua browser. |
| **GÓI 8** | Xóa dữ liệu Meta Data Deletion (6 mục) | **THAY THẾ (REPLACE)** | [ ] ĐỒNG Ý<br>[ ] TỪ CHỐI | Đáp ứng bắt buộc để Meta duyệt ứng dụng. |
| **GÓI 9** | Trung tâm điều khiển AI Control (12 mục) | **THAY THẾ (REPLACE)** | [ ] ĐỒNG Ý<br>[ ] TỪ CHỐI | Cung cấp giao diện quản trị bật/tắt AI. |
| **GÓI 10** | Lập lịch AI Messenger Live (10 mục) | **THAY THẾ (REPLACE)** | [ ] ĐỒNG Ý<br>[ ] TỪ CHỐI | Kích hoạt AI trả lời Messenger tự động. |
| **GÓI 11** | Zalo cá nhân & Tóm tắt AI (12 mục) | **THAY THẾ (REPLACE)** | [ ] ĐỒNG Ý<br>[ ] TỪ CHỐI | Hỗ trợ chiến dịch Zalo và tóm tắt cuộc gọi. |
| **GÓI 12** | Phễu 6 giai đoạn du học & AI (17 mục) | **THAY THẾ (REPLACE)** | [ ] ĐỒNG Ý<br>[ ] TỪ CHỐI | Chuẩn hóa quy trình chăm sóc học viên 6 bước. |
| **GÓI 13** | Bảo mật Token & Lead Meta Ads (5 mục) | **THAY THẾ (REPLACE)** | [ ] ĐỒNG Ý<br>[ ] TỪ CHỐI | **Bắt buộc để chạy quảng cáo Facebook Meta Ads.** |

---

### Chữ ký xác nhận của Chủ sở hữu:
- **Người ra quyết định:** ........................................................................
- **Ngày ký duyệt:** ................................................................................
- **Ý kiến chỉ đạo thêm:** ........................................................................

---
*Tài liệu kỹ thuật bổ trợ và danh mục chi tiết 178 mục được lưu trữ tại file máy đọc:*  
`docs/evidence/meta-ads-owner-decisions/decision-register.json`
