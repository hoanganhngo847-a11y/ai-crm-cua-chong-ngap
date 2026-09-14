# Quy ước dữ liệu dùng chung

> Đây là hợp đồng dữ liệu ở mức kiến trúc. Tài liệu thống nhất ý nghĩa, quyền sở hữu và cách các vùng nghiệp vụ trao đổi dữ liệu; **chưa phải schema Supabase hay migration**. Khi triển khai thật, tên trường và quy tắc bảo mật dưới đây phải được giữ nhất quán hoặc được thay đổi qua quy trình review contract chung.

Tài liệu này chưa quyết định bảng Supabase chính thức, migration, RLS policy, index, foreign key cuối cùng hoặc danh sách enum cuối cùng. Các mục ghi **CẦN CHỐT KHI THIẾT KẾ SCHEMA** phải được giải quyết sau khi contract được nhóm duyệt, không được tự suy diễn thành thiết kế cơ sở dữ liệu.

## A. Nguyên tắc chung

### Phạm vi công ty

- Dữ liệu nghiệp vụ thuộc một doanh nghiệp phải được giới hạn theo `company_id`, trực tiếp trên bản ghi hoặc gián tiếp qua quan hệ cha.
- Không được cho phép người dùng đọc chéo công ty.
- Các API, truy vấn và chính sách RLS sau này phải kiểm tra phạm vi công ty ở phía máy chủ/cơ sở dữ liệu.

### Định danh và thời gian

- Trường `id` là định danh nội bộ duy nhất, ổn định và không tái sử dụng.
- Các trường có hậu tố `_id` tham chiếu đến `id` của dữ liệu liên quan.
- Thời gian phải lưu kèm múi giờ, ưu tiên UTC trong cơ sở dữ liệu và đổi sang múi giờ khi hiển thị.
- Dữ liệu trao đổi giữa các module dùng tên trường `snake_case` như trong tài liệu này.

### Dữ liệu nhạy cảm

- `Customer.phone` là dữ liệu nhạy cảm. Tài khoản SALE và TECHNICIAN không được nhận số thật từ cơ sở dữ liệu, API, log, export, lỗi hoặc dữ liệu tải trước.
- Che số ở giao diện không được xem là biện pháp phân quyền.
- Tham chiếu tệp như `recording_ref`, `generated_file_ref`, `signed_file_ref` và `photos` không được mặc định là URL công khai; việc tải tệp phải được kiểm tra quyền.
- Transcript, nội dung hội thoại, địa chỉ và bằng chứng AI có thể chứa dữ liệu cá nhân, vì vậy phải áp dụng quyền tối thiểu và lưu nhật ký truy cập phù hợp.

### Chống ghi trùng và truy vết

- Sự kiện từ hệ thống ngoài phải có khóa chống ghi trùng phù hợp, ví dụ `external_ref` hoặc `provider_ref`.
- Không ghi đè lịch sử quan trọng như bảng giá, giao dịch, hợp đồng đã ký hoặc lần thử gọi. Dùng phiên bản, trạng thái mới hoặc bản ghi bổ sung.
- Thao tác nhạy cảm phải có dấu vết ai thực hiện, lúc nào và lý do. Các trường audit chi tiết sẽ được xác định khi thiết kế schema.

### Thay đổi contract

- Thành viên sở hữu dữ liệu chịu trách nhiệm duy trì contract; người dùng dữ liệu không tự ý đổi ý nghĩa trường.
- Thêm trường tùy chọn thường là thay đổi tương thích. Xóa trường, đổi tên, đổi kiểu hoặc đổi ý nghĩa là thay đổi có thể phá tương thích và phải được thống nhất.
- Giá trị trạng thái phải dùng hằng số chung. Không tự tạo cách viết khác nhau cho cùng một trạng thái.
- Trạng thái phát sinh từ AI chỉ là gợi ý nếu contract không nói rõ được tự động quyết định.

### Quy ước trạng thái dùng chung và Định danh chuẩn hóa (Canonical Identifiers — DECIDED / FROZEN)

- Các trạng thái và kết quả nghiệp vụ phải được định nghĩa tập trung trước khi viết code.
- Không để các module dùng `DA_COC`, `da-coc`, `paid_deposit` và `DEPOSIT_PAID` cho cùng một ý nghĩa.
- Module chỉ được dùng tên trạng thái đã thống nhất trong constants/enum chung và không tự dịch hoặc đổi kiểu chữ khi lưu dữ liệu.
- **Quy tắc giá trị lưu trữ vật lý (Persisted Canonical Values):** Theo `SCHEMA DECISION 07 (FROZEN)`, toàn bộ giá trị phân loại/trạng thái trong cơ sở dữ liệu vật lý bắt buộc lưu bằng **tiếng Anh in hoa chuẩn `UPPER_SNAKE_CASE`** (ví dụ: `UNREACHABLE`, `DEPOSIT_PENDING`, `DEPOSIT_CONFIRMED`, `DRAFT`, `CONFIRMED`, `PROCESSING`, `COMPLETED`, `CANCELLED`, `FACEBOOK`, `ZALO_OA`, `HOTLINE`, `WEBSITE`).
- **Bảo toàn thuật ngữ nghiệp vụ (Business Label Mapping):** Các nhãn tiếng Việt trong tài liệu này là ngôn ngữ nghiệp vụ và nhãn hiển thị trên giao diện (UI Presentation Labels), tuyệt đối KHÔNG lưu chuỗi tiếng Việt vào cơ sở dữ liệu. Bảng ánh xạ chuẩn:
  - "KHÔNG LIÊN LẠC ĐƯỢC" $\rightarrow$ canonical database value: `UNREACHABLE`
  - "ĐÃ CỌC" $\rightarrow$ canonical database value: `DEPOSIT_CONFIRMED`
  - "CHỜ CỌC" $\rightarrow$ canonical database value: `DEPOSIT_PENDING`
  - "CHỜ XỬ LÝ" / "ĐANG XỬ LÝ" $\rightarrow$ canonical database value: `PENDING` / `PROCESSING`
  - "HOÀN THÀNH" / "HOÀN TẤT" $\rightarrow$ canonical database value: `COMPLETED`
  - "ĐÃ HỦY" $\rightarrow$ canonical database value: `CANCELLED`
- **Chuẩn hóa số điện thoại (Phone Normalization — DECIDED / FROZEN):** Theo `SCHEMA DECISION 01 (FROZEN)`, số điện thoại đầu vào từ mọi nguồn (người dùng, webhook, nhà mạng) bắt buộc phải qua hàm `normalize_phone()` chuyển về định dạng quốc tế chuẩn **E.164** (`+84XXXXXXXXX` với Việt Nam) trước khi sinh HMAC hash (`phone_hash`) hoặc lưu trữ bảo mật tại `private.customer_private_contacts`. Tuyệt đối không để số `09...` và `+849...` tạo ra hai hash khác nhau.
- Danh sách enum đã được chuẩn hóa đầy đủ tại `SUPABASE_SCHEMA_DESIGN.md`.

### Quy ước tham chiếu người dùng

- `user_id` và các trường chỉ người dùng phải tham chiếu `UserProfile.id`, trừ khi từng entity ghi rõ một lựa chọn khác cần chốt.
- `sale_user_id` dự kiến tham chiếu `UserProfile.id` của người có `CompanyMember.role = SALE` đang hoạt động trong đúng Company.
- `assigned_to` tham chiếu `UserProfile.id` khi đối tượng được giao cho một người dùng; role hợp lệ phụ thuộc loại công việc và phải được kiểm tra qua CompanyMember.
- `assignee_id` của Appointment mặc định tham chiếu `UserProfile.id` của TECHNICIAN. Nếu tương lai cần giao cho đội kỹ thuật riêng thì mô hình đội là **CẦN CHỐT KHI THIẾT KẾ SCHEMA**.
- `completed_by` của Survey tham chiếu `UserProfile.id` của TECHNICIAN thực sự hoàn tất/nhập kết quả khảo sát.
- `changed_by` cần thể hiện rõ tác nhân là user, AI hay system. Cách biểu diễn bằng nhiều trường hay một actor reference là **CẦN CHỐT KHI THIẾT KẾ SCHEMA**; nếu tác nhân là user thì định danh phải truy về `UserProfile.id`.
- Mọi tham chiếu người dùng theo ngữ cảnh công ty phải kiểm tra có `CompanyMember` đang hoạt động trong đúng Company; chỉ tồn tại `UserProfile` là chưa đủ quyền truy cập.

## 1. Company

### Mô tả và mục đích

`Company` đại diện cho một doanh nghiệp sử dụng hệ thống và là gốc phân vùng dữ liệu tenant.

- **Chủ sở hữu:** Thành viên 1.
- **Ai tạo:** Quy trình quản trị/onboarding được cấp quyền; chưa triển khai trong nhiệm vụ này.
- **Ai dùng:** Auth/authorization, mọi module nghiệp vụ, RLS và báo cáo theo công ty sau này.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh công ty. |
| `name` | Tên hiển thị chính thức của doanh nghiệp. |
| `status` | Trạng thái hoạt động của doanh nghiệp theo hằng số chung. |
| `created_at` | Thời điểm tạo. |
| `updated_at` | Thời điểm cập nhật gần nhất. |

### Liên kết

Một `Company` có nhiều `CompanyMember`, `Customer`, `Conversation`, `PricingPolicy`, `Order`, `CareCampaign`, `CareDelivery` và các dữ liệu nghiệp vụ khác thuộc công ty trực tiếp hoặc gián tiếp.

### Quy tắc cập nhật

- `id` là định danh công ty ổn định và không tái sử dụng.
- Phạm vi triển khai hiện tại có đúng một Company; kiến trúc vẫn giữ ranh giới Company để không đọc chéo tenant và có thể mở rộng an toàn.
- Mọi dữ liệu nghiệp vụ phải thuộc một Company trực tiếp bằng `company_id` hoặc gián tiếp qua quan hệ cha đã được contract cho phép.
- Không được truy cập dữ liệu của Company khác.
- Không xóa Company nếu còn dữ liệu nghiệp vụ tham chiếu. Khi cần ngừng sử dụng, ưu tiên đổi `status` và giữ lịch sử.
- Nếu cần cấu hình riêng theo doanh nghiệp, mở rộng bằng contract/thực thể cấu hình riêng; không nhét dữ liệu tùy tiện vào `Company`.

## 2. UserProfile

### Mô tả và mục đích

`UserProfile` là hồ sơ ứng dụng gắn với tài khoản đăng nhập Supabase Auth trong thiết kế sau này. Đây chỉ là contract kiến trúc, chưa tạo Supabase Auth thật.

- **Chủ sở hữu:** Thành viên 1.
- **Ai tạo:** Quy trình đồng bộ hồ sơ sau khi Auth provider tạo tài khoản hợp lệ.
- **Ai dùng:** Company membership, phân công công việc, lịch sử thay đổi, audit và hồ sơ phong cách sale.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh hồ sơ; dự kiến tham chiếu `auth.users.id` sau này. |
| `full_name` | Họ tên hiển thị trong ứng dụng. |
| `status` | Trạng thái hồ sơ ứng dụng theo hằng số chung. |
| `created_at` | Thời điểm tạo hồ sơ. |
| `updated_at` | Thời điểm cập nhật gần nhất. |

### Liên kết

Một `UserProfile` có thể có nhiều `CompanyMember`; có thể được tham chiếu bởi `Interaction.actor_user_id`, `Conversation.assigned_to`, `Appointment.assignee_id`, `Survey.completed_by`, `SalesStyleProfile.sale_user_id`, `WarrantyTicket.assigned_to`, `CustomerStageHistory.changed_by` khi tác nhân là user và `AuditLog.user_id`.

### Quy tắc cập nhật

- `id` sau này dự kiến tham chiếu `auth.users.id`; kiểu khóa và cơ chế đồng bộ là **CẦN CHỐT KHI THIẾT KẾ SCHEMA**.
- Không lưu mật khẩu, secret, token đăng nhập hoặc thông tin xác thực trong `UserProfile`.
- Auth provider chịu trách nhiệm xác thực; `UserProfile` chỉ chứa thông tin hồ sơ ứng dụng cần thiết.
- Quyền không được suy ra từ thông tin hiển thị của `UserProfile`; phải dựa trên membership, role và cơ chế authorization phía máy chủ/cơ sở dữ liệu.
- Hồ sơ không hoạt động không tự động xóa lịch sử phân công hoặc audit đã phát sinh.

## 3. CompanyMember

### Mô tả và mục đích

`CompanyMember` liên kết một `UserProfile` với một `Company` và xác định vai trò của người dùng trong công ty đó.

- **Chủ sở hữu:** Thành viên 1.
- **Ai tạo:** Quy trình quản trị thành viên được SẾP/QUẢN TRỊ hợp lệ thực hiện.
- **Ai dùng:** Auth/authorization, RLS, server-side policy, phân công người dùng và audit.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh membership. |
| `company_id` | Company mà membership thuộc về. |
| `user_id` | `UserProfile.id` của người dùng. |
| `role` | Vai trò trong Company, tối thiểu `BOSS_ADMIN`, `SALE` hoặc `TECHNICIAN`. |
| `status` | Trạng thái membership theo hằng số chung, tối thiểu phân biệt `ACTIVE` với không hoạt động. |
| `created_at` | Thời điểm tạo membership. |

### Liên kết

`CompanyMember` thuộc một `Company`, tham chiếu một `UserProfile` và dùng `role` để áp dụng contract quyền logic `AccessPolicy`.

### Quy tắc cập nhật

- Cặp `(company_id, user_id)` không được trùng.
- Tối thiểu chỉ có `BOSS_ADMIN`, `SALE` và `TECHNICIAN`. Không tự thêm role khác khi `PROJECT_MASTER.md` và nghiệp vụ chưa yêu cầu.
- `role` là nguồn chính xác định quyền nghiệp vụ của người dùng trong Company.
- Mỗi Company được có tối đa một CompanyMember đang hoạt động với `role = SALE`. Không có cơ chế chia khách hoặc tự động phân phối lead cho nhiều sale.
- Phạm vi triển khai hiện tại có một Company và Company đó có đúng một SALE hoạt động, nên toàn hệ thống hiện tại vẫn có một sale duy nhất.
- Người dùng không được tự thay role của chính mình. Mọi thay đổi role phải được ủy quyền và ghi `AuditLog`.
- Membership không hoạt động thì người dùng không được truy cập dữ liệu của Company đó, dù `UserProfile` vẫn hoạt động.
- Thay đổi membership không được xóa dấu vết các thao tác lịch sử của người dùng.

## 4. Customer

### Mô tả và mục đích

`Customer` là hồ sơ khách hàng trung tâm, dùng để hợp nhất hành trình của cùng một người từ nhiều kênh và làm điểm liên kết cho tương tác, cuộc gọi, khảo sát, đơn hàng và chăm sóc.

- **Chủ sở hữu:** Thành viên 2 (CRM / Customer 360); Thành viên 1 sở hữu quy tắc bảo mật trường nhạy cảm và RLS.
- **Ai tạo:** Luồng CRM khi tiếp nhận khách từ kênh, Hotline hoặc nhập hợp lệ; quy trình gộp danh tính có kiểm soát.
- **Ai dùng:** Các module inbox, đa kênh, voice, khảo sát, giá, đơn hàng, chăm sóc, AI và phân tích; SALE chỉ nhận phiên bản dữ liệu đã lọc quyền.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh nội bộ của khách. |
| `company_id` | `Company.id` sở hữu khách; lưu trực tiếp để phục vụ RLS, uniqueness và truy vấn tenant. |
| `customer_code` | Mã dễ đọc để sale tìm khách, ví dụ `KH-000123`; duy nhất trong Company. |
| `name` | Tên hiển thị của khách. |
| `phone` | Số điện thoại chuẩn hóa; raw phone là dữ liệu nhạy cảm. |
| `source` | Nguồn tiếp nhận ban đầu như `facebook`, `zalo`, `website`, `hotline`, `advertising`. |
| `stage` | Giai đoạn hiện tại trong hành trình khách. |
| `created_at` | Thời điểm tạo hồ sơ. |

### Liên kết

Thuộc một `Company`. Một `Customer` có thể có nhiều `CustomerStageHistory`, `Identity`, `Interaction`, `Conversation`, `Call`, `Appointment`, `Survey`, `PriceCalculation`, `Order`, `CareDelivery`, `CareSchedule`, `AIAnalysis` và `WarrantyTicket`.

### Quy tắc cập nhật

- `phone` phải được chuẩn hóa trước khi đối chiếu; không so sánh bằng chuỗi người dùng nhập thô. Thuật toán chuẩn hóa cụ thể là **CẦN CHỐT KHI THIẾT KẾ SCHEMA**.
- Khi có số, `phone` là khóa nhận diện chính sau khi chuẩn hóa. Uniqueness của số đã chuẩn hóa phải theo phạm vi `company_id`; một số không được tạo nhiều Customer chính trong cùng Company.
- Nếu phát hiện trùng, phải gộp có kiểm soát, chuyển quan hệ sang hồ sơ chính và lưu dấu vết; không xóa âm thầm lịch sử.
- `customer_code` phải duy nhất trong Company, ổn định, không tái sử dụng cho khách khác và không chứa thông tin nhạy cảm.
- Không đưa raw phone vào `metadata` của `Identity`, `AuditLog` hoặc trường linh hoạt khác để né chính sách bảo mật.
- `stage` chỉ đổi theo sự kiện nghiệp vụ hợp lệ và mỗi lần đổi phải tạo `CustomerStageHistory`; không để gợi ý AI tự ghi đè nếu chưa có quy tắc được duyệt.
- Không trả `phone` thật cho SALE hoặc TECHNICIAN. Sale tìm khách bằng `name` hoặc `customer_code` và gọi qua lệnh máy chủ bằng `customer_id`; TECHNICIAN không có quyền gọi mặc định.

## 5. CustomerStageHistory

### Mô tả và mục đích

`CustomerStageHistory` lưu lịch sử thay đổi hành trình khách để CRM có thể truy vết đầy đủ, thay vì chỉ nhìn trạng thái hiện tại trong `Customer.stage`.

- **Chủ sở hữu:** Thành viên 2; Thành viên 1 điều phối contract và bảo mật tenant.
- **Ai tạo:** Luồng CRM/automation ngay khi một thay đổi stage hợp lệ được áp dụng.
- **Ai dùng:** CRM, Customer 360, sale, AI analysis, audit và analytics.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh bản ghi lịch sử. |
| `company_id` | `Company.id` lưu trực tiếp để RLS và truy vấn lịch sử theo tenant không phụ thuộc join phức tạp. |
| `customer_id` | `Customer.id` được thay đổi stage. |
| `from_stage` | Stage trước thay đổi; có thể trống khi ghi nhận stage đầu tiên. |
| `to_stage` | Stage mới đã thực sự được áp dụng. |
| `changed_at` | Thời điểm thay đổi có hiệu lực. |
| `changed_by` | Tác nhân user/AI/system; nếu là user phải truy về `UserProfile.id`. Cách biểu diễn cuối cùng cần chốt khi thiết kế schema. |
| `reason` | Lý do thay đổi ở mức cần thiết để kiểm tra. |
| `source_ref` | Tham chiếu đến tương tác, phân tích hoặc sự kiện nguồn nếu có. |

### Liên kết

Thuộc một `Company` và một `Customer`; `changed_by` có thể liên quan `UserProfile`, AI hoặc system; `source_ref` có thể dẫn đến `Interaction`, `AIAnalysis` hoặc nguồn hợp lệ khác.

### Quy tắc cập nhật

- Dữ liệu ưu tiên append-only; không ghi đè lịch sử cũ.
- Mỗi lần `Customer.stage` thay đổi hợp lệ phải có đúng một bản ghi lịch sử tương ứng và `company_id` phải khớp Company của Customer.
- Nếu AI chỉ đưa `stage_suggestion`, chưa tạo lịch sử thay đổi cho đến khi luật nghiệp vụ cho phép stage thực sự đổi.
- `reason` và/hoặc `source_ref` phải đủ để truy vết vì sao trạng thái thay đổi, đồng thời không sao chép payload nhạy cảm không cần thiết.
- Mô hình actor cho `changed_by` là **CẦN CHỐT KHI THIẾT KẾ SCHEMA**.

## 6. Identity

### Mô tả và mục đích

`Identity` liên kết một `Customer` với danh tính ngoài hệ thống như Zalo UID, Facebook user ID, Website session hoặc số điện thoại.

- **Chủ sở hữu:** Thành viên 2 sở hữu liên kết hồ sơ; thành viên sở hữu từng kênh cung cấp danh tính nguồn; Thành viên 1 duyệt bảo mật.
- **Ai tạo:** Adapter tích hợp kênh hoặc quy trình xác minh/gộp khách.
- **Ai dùng:** CRM, inbox, các tích hợp đa kênh, chống trùng và định tuyến phản hồi.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh bản ghi danh tính. |
| `company_id` | `Company.id` lưu trực tiếp để áp dụng RLS và ràng buộc uniqueness theo tenant. |
| `customer_id` | Customer trung tâm được liên kết. |
| `channel` | Loại danh tính: `zalo`, `facebook`, `website`, `phone` hoặc loại được duyệt khác. |
| `external_id` | Định danh ở hệ thống nguồn. |
| `verified` | Danh tính đã được xác minh hay chưa. |
| `metadata` | Metadata tối thiểu cần thiết từ nguồn; không dùng làm nơi chứa dữ liệu tùy tiện. |

### Liên kết

Thuộc một `Company` và một `Customer`; có thể được đối chiếu với `Interaction` và `Conversation` theo kênh cùng mã ngoài.

### Quy tắc cập nhật

- Cặp `(company_id, channel, external_id)` phải chống liên kết trùng hoặc liên kết đồng thời với hai Customer chính. `company_id` phải khớp Company của Customer.
- Chỉ đặt `verified = true` khi có quy trình xác minh rõ ràng.
- Thay đổi liên kết Customer phải lưu lý do và dấu vết gộp/tách.
- `metadata` không được chứa raw phone nhằm né quy tắc bảo mật của `Customer.phone`.

## 7. Interaction

### Mô tả và mục đích

`Interaction` là một sự kiện tương tác đơn lẻ với khách, dùng để tạo dòng thời gian Customer 360 và làm bằng chứng cho phân tích.

- **Chủ sở hữu:** Thành viên 2 sở hữu timeline chung; module phát sinh tương tác sở hữu nội dung nguồn.
- **Ai tạo:** Tích hợp Zalo, Facebook, Website, voice, sale, kỹ thuật viên, AI hoặc automation.
- **Ai dùng:** CRM, inbox, AIAnalysis, SalesStyleProfile, chăm sóc, báo cáo và kiểm tra lịch sử.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh tương tác. |
| `company_id` | `Company.id` lưu trực tiếp để RLS, truy vấn timeline lớn và chống trùng sự kiện theo tenant. |
| `customer_id` | Khách liên quan. |
| `conversation_id` | `Conversation.id` nếu Interaction là tin nhắn thuộc inbox; cho phép null với call/note/event không thuộc hội thoại. |
| `channel` | `zalo`, `facebook`, `website`, `phone`, `ai_voice`. |
| `type` | Loại tương tác, ví dụ message, note, call event hoặc status event theo danh mục chung. |
| `direction` | `inbound` hoặc `outbound`. |
| `content` | Nội dung hoặc phần mô tả tương tác; có thể chứa dữ liệu nhạy cảm. |
| `external_ref` | Mã tham chiếu của hệ thống nguồn để chống ghi trùng/truy vết. |
| `actor_type` | Loại tác nhân: `customer` là khách; `sale` là SALE; `technician` là TECHNICIAN; `ai` là AI; `system` là tác vụ tự động của hệ thống. |
| `actor_user_id` | `UserProfile.id` của người dùng nội bộ tạo Interaction; cho phép null với tác nhân không phải người dùng nội bộ. |
| `created_at` | Thời điểm tương tác thực sự xảy ra. |

### Liên kết

Thuộc một `Company` và một `Customer`; liên kết tùy chọn đến `Conversation`, có thể liên quan đến `Call` hoặc nguồn được dẫn trong `AIAnalysis.source_refs`. Khi tác nhân là người dùng nội bộ, `actor_user_id` tham chiếu `UserProfile.id`.

### Quy tắc cập nhật

- Tương tác là lịch sử; ưu tiên append-only, không sửa nội dung nguồn sau khi đã đồng bộ.
- Dùng `external_ref` cùng phạm vi `company_id` và kênh để chống ghi hai lần. `company_id` phải khớp Company của Customer.
- Nếu có `conversation_id`, Conversation phải thuộc cùng Customer, cùng Company và có channel tương thích với Interaction.
- Interaction dạng tin nhắn trong Hộp thư tích hợp phải có `conversation_id`; call, note hoặc event không thuộc hội thoại đặt `conversation_id = null`.
- `actor_type` phải phản ánh đúng tác nhân thực hiện; không ghi tin AI, system hoặc technician thành tin sale.
- Với `actor_type = sale`, `actor_user_id` bắt buộc tham chiếu UserProfile có `CompanyMember.role = SALE`, `CompanyMember.status = ACTIVE` trong cùng Company tại thời điểm tạo Interaction.
- Với `actor_type = technician`, `actor_user_id` bắt buộc tham chiếu UserProfile có `CompanyMember.role = TECHNICIAN`, `CompanyMember.status = ACTIVE` trong cùng Company tại thời điểm tạo Interaction.
- Với `actor_type = customer` hoặc `system`, `actor_user_id = null`. Với `actor_type = ai`, `actor_user_id = null` trừ khi sau này có mô hình actor riêng được duyệt.
- Không dùng `actor_user_id` lịch sử để suy ra quyền hiện tại. Quyền phải được kiểm tra từ CompanyMember hợp lệ tại thời điểm thao tác; Interaction vẫn giữ `actor_user_id` của người đã thực hiện khi membership sau đó bị vô hiệu hóa.
- Nếu nguồn sửa/xóa tin, lưu trạng thái thay đổi theo thiết kế audit thay vì làm mất dấu vết.

## 8. Conversation

### Mô tả và mục đích

`Conversation` đại diện một hội thoại trong Hộp thư tích hợp, giúp sale xem và trả lời hội thoại Facebook/Zalo tại một nơi.

- **Chủ sở hữu:** Thành viên 2 (inbox); Thành viên 3 và 4 sở hữu đồng bộ từng kênh.
- **Ai tạo:** Adapter kênh khi nhận hội thoại lần đầu.
- **Ai dùng:** Hộp thư tích hợp, sale, quy tắc 5 phút, automation và analytics.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh hội thoại nội bộ. |
| `company_id` | Công ty sở hữu hội thoại. |
| `customer_id` | Customer trung tâm. |
| `channel` | Kênh hội thoại, trước mắt là `zalo` hoặc `facebook`. |
| `external_conversation_id` | Mã hội thoại ở hệ thống nguồn. |
| `last_message_at` | Thời điểm tin mới nhất. |
| `unread_count` | Số tin chưa đọc theo quy tắc inbox. |
| `status` | Trạng thái như mở, đang xử lý hoặc đóng theo danh mục chung. |
| `assigned_to` | `UserProfile.id` của người phụ trách khi giao cho người dùng; người này phải có `CompanyMember.status = ACTIVE` trong cùng Company. |

### Liên kết

Thuộc một `Company` và một `Customer`; chứa dòng tương tác/tin nhắn được biểu diễn bởi `Interaction`; được automation 5 phút theo dõi.

### Quy tắc cập nhật

- Cặp kênh và `external_conversation_id` phải chống tạo trùng trong công ty.
- Cập nhật `last_message_at` theo thời điểm sự kiện, không để sự kiện cũ đến muộn làm lùi thời gian.
- `unread_count` phải cập nhật nguyên tử và có thể đối soát từ tin nhắn.
- Nếu có `assigned_to`, người được giao phải có `CompanyMember.role = SALE`, `CompanyMember.status = ACTIVE` trong đúng Company theo mô hình hiện tại.
- Trước khi AI trả lời sau 5 phút, phải kiểm tra lại hội thoại chưa được sale trả lời/đang xử lý.

## 9. Call

### Mô tả và mục đích

`Call` là một cuộc gọi thật đã hoặc đang được thực hiện với khách.

- **Chủ sở hữu:** Thành viên 5 (Hotline / AI Voice).
- **Ai tạo:** Hệ thống tổng đài/Hotline hoặc dịch vụ điều phối cuộc gọi phía máy chủ.
- **Ai dùng:** Voice, CRM timeline, sale, transcript, AI phân tích và kiểm tra chất lượng.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh cuộc gọi. |
| `company_id` | `Company.id` lưu trực tiếp để xử lý webhook tổng đài, RLS và truy vấn cuộc gọi theo tenant. |
| `customer_id` | Khách được gọi hoặc gọi đến. |
| `direction` | `inbound` hoặc `outbound`. |
| `agent_type` | `ai` hoặc `sale`. |
| `started_at` | Thời điểm bắt đầu. |
| `ended_at` | Thời điểm kết thúc, có thể trống khi đang gọi. |
| `status` | Trạng thái cuộc gọi theo danh mục chung. |
| `recording_ref` | Tham chiếu bảo vệ đến bản ghi âm. |
| `transcript_status` | Trạng thái xử lý transcript. |

### Liên kết

Thuộc một `Company` và một `Customer`; có thể được một `CallAttempt` tham chiếu và có một `CallTranscript`; có thể tạo `Interaction` tóm tắt.

### Quy tắc cập nhật

- Cuộc gọi Hotline đến không làm tăng `CallAttempt.attempt_no` của quy tắc gọi lại 3 lần.
- SALE yêu cầu gọi bằng `customer_id`; raw phone chỉ được giải quyết ở máy chủ và không trả về trình duyệt.
- `company_id` phải khớp Company của Customer và được đưa vào phạm vi chống ghi trùng sự kiện tổng đài.
- Thời điểm và trạng thái được cập nhật từ sự kiện tổng đài có chống ghi trùng.
- `recording_ref` chỉ được ghi khi tệp tồn tại và quyền truy cập đã được bảo vệ.

## 10. CallAttempt

### Mô tả và mục đích

`CallAttempt` lưu từng lần thử trong quy tắc gọi lại tối đa 3 lần đối với khách để số qua kênh khác Hotline.

- **Chủ sở hữu:** Thành viên 5.
- **Ai tạo:** Automation cuộc gọi lại khi khách đủ điều kiện.
- **Ai dùng:** Voice, CRM, automation và sale để biết lịch sử liên hệ.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh lần thử. |
| `company_id` | `Company.id` lưu trực tiếp để scheduler và RLS lọc theo tenant. |
| `customer_id` | Khách cần gọi. |
| `contact_cycle_id` | Định danh logic của một chu kỳ gọi outbound tối đa ba lần. |
| `attempt_no` | Thứ tự 1, 2 hoặc 3. |
| `scheduled_at` | Thời điểm dự kiến gọi. |
| `called_at` | Thời điểm thực tế gọi. |
| `result` | Kết quả lần thử theo danh mục chung. |
| `call_id` | Cuộc gọi thật tương ứng nếu đã phát sinh. |

### Liên kết

Thuộc một `Company` và một `Customer`, tham chiếu tùy chọn đến `Call`.

### Quy tắc cập nhật

- `company_id` phải khớp Company của Customer và Call liên quan.
- Trong cùng bộ `(company_id, customer_id, contact_cycle_id)`, chỉ có `attempt_no` 1, 2, 3 và mỗi số xuất hiện tối đa một lần.
- Chu kỳ mới chỉ được tạo khi có lý do nghiệp vụ hợp lệ; không reset `attempt_no` âm thầm trong cùng chu kỳ. `contact_cycle_id` là định danh logic trên CallAttempt, chưa tạo entity ContactCycle riêng ở bước contract này.
- Lần 1 được lên lịch ngay; lần 2 sau 2–3 giờ nếu không nghe; lần 3 vào ngày hôm sau nếu vẫn không nghe.
- Chỉ tạo lần tiếp theo sau khi kết quả lần trước đủ điều kiện.
- Cuộc gọi Hotline inbound không thuộc chu kỳ outbound ba lần.
- Sau lần 3 không nghe, chu kỳ kết thúc, cập nhật khách thành **KHÔNG LIÊN LẠC ĐƯỢC** (canonical persisted value: `UNREACHABLE`) nhưng không xóa Customer.

## 11. CallTranscript

### Mô tả và mục đích

`CallTranscript` là nội dung cuộc gọi được chuyển thành chữ để xem lại, phân tích và học phong cách sale trong phạm vi cho phép.

- **Chủ sở hữu:** Thành viên 5 sở hữu transcript; Thành viên 9 sử dụng cho AI.
- **Ai tạo:** Dịch vụ speech-to-text sau khi có bản ghi âm/cuộc gọi hợp lệ.
- **Ai dùng:** Voice, CRM theo quyền, AIAnalysis, SalesStyleProfile và kiểm tra chất lượng.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `call_id` | Khóa liên kết đến cuộc gọi và định danh transcript. |
| `transcript` | Nội dung chuyển thành chữ. |
| `speakers` | Phân đoạn/người nói nếu xác định được. |
| `processed_at` | Thời điểm xử lý xong. |
| `language` | Ngôn ngữ nhận diện, ví dụ `vi`. |

### Liên kết

Quan hệ một-một với `Call`; Company được suy ra an toàn qua `Call.company_id`. Có thể được tham chiếu trong `AIAnalysis.source_refs` và nguồn huấn luyện/đúc kết `SalesStyleProfile`.

### Quy tắc cập nhật

- Chỉ xử lý khi có căn cứ sử dụng bản ghi âm phù hợp chính sách của doanh nghiệp.
- Bản sửa transcript phải có phiên bản hoặc dấu vết, không ghi đè không kiểm soát.
- Không mặc định transcript là sự thật tuyệt đối; AI phải giữ bằng chứng và độ tin cậy.
- Áp dụng quyền hạn chế vì transcript có thể chứa số điện thoại, địa chỉ và thông tin nhạy cảm.

## 12. Appointment

### Mô tả và mục đích

`Appointment` là lịch thực hiện công việc tại một thời điểm, trước mắt gồm khảo sát và lắp đặt.

- **Chủ sở hữu:** Thành viên 6 sở hữu lịch khảo sát; Thành viên 8 sở hữu lịch lắp đặt; contract chung do Thành viên 1 điều phối.
- **Ai tạo:** AI/automation đặt khảo sát, sale hoặc module vận hành theo quyền.
- **Ai dùng:** CRM, survey, installation, thông báo và analytics.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh lịch. |
| `company_id` | `Company.id` lưu trực tiếp để scheduler, phân công và RLS theo tenant. |
| `customer_id` | Khách liên quan. |
| `type` | Loại lịch: `survey` hoặc `installation`. |
| `start_time` | Thời điểm bắt đầu. |
| `assignee_id` | Mặc định là `UserProfile.id` của TECHNICIAN được giao; mô hình đội kỹ thuật riêng trong tương lai là **CẦN CHỐT KHI THIẾT KẾ SCHEMA**. |
| `address` | Địa chỉ thực hiện; là dữ liệu cần bảo vệ. |
| `status` | Trạng thái lịch. |

### Liên kết

Thuộc một `Company` và một `Customer`; trong luồng chuẩn, lịch khảo sát là nguồn của `Survey` qua `Survey.appointment_id`; lịch lắp đặt được `Installation.appointment_id` tham chiếu.

### Quy tắc cập nhật

- Không đổi loại lịch sau khi đã phát sinh nghiệp vụ liên quan; tạo lịch mới nếu cần.
- `company_id` phải khớp Company của Customer. Với lịch khảo sát, `assignee_id` phải trỏ UserProfile có `CompanyMember.role = TECHNICIAN`, `CompanyMember.status = ACTIVE` trong cùng Company và chỉ được xem công việc được giao.
- Đổi giờ, người phụ trách hoặc hủy lịch phải lưu dấu vết và kích hoạt thông báo phù hợp.
- Chỉ chuyển hoàn thành khi module phụ trách xác nhận công việc tương ứng.

## 13. Survey

### Mô tả và mục đích

`Survey` là kết quả khảo sát kỹ thuật tại công trình, cung cấp dữ liệu đo đạc thực tế cho việc tính giá và sản xuất.

- **Chủ sở hữu:** Thành viên 6.
- **Ai tạo:** Kỹ thuật viên được phân công sau khi thực hiện khảo sát.
- **Ai dùng:** Pricing, sale, order, production và CRM.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh khảo sát. |
| `customer_id` | Khách được khảo sát. |
| `appointment_id` | `Appointment.id` của lịch khảo sát nguồn; trong luồng chuẩn Survey phải truy được về Appointment này. |
| `completed_by` | `UserProfile.id` của TECHNICIAN thực sự hoàn tất/nhập kết quả khảo sát. |
| `measurements` | Bộ số đo có cấu trúc theo contract kỹ thuật. |
| `photos` | Danh sách tham chiếu ảnh được bảo vệ. |
| `site_condition` | Điều kiện hiện trường. |
| `notes` | Ghi chú kỹ thuật. |
| `completed_at` | Thời điểm hoàn tất; trống nếu chưa hoàn tất. |

### Liên kết

Thuộc `Customer` và tham chiếu lịch khảo sát nguồn bằng `appointment_id`. Appointment phải có `type = survey`, thuộc cùng Customer và cùng Company với Survey. `completed_by` tham chiếu UserProfile của kỹ thuật viên trong cùng Company. `PriceCalculation.survey_id` tiếp tục tham chiếu Survey.

### Quy tắc cập nhật

- Không đánh dấu hoàn tất nếu thiếu trường kỹ thuật bắt buộc.
- Trong luồng khảo sát chuẩn, Survey phải truy được về Appointment nguồn bằng `appointment_id`. Nếu có `appointment_id`, Appointment phải tồn tại, có `type = survey`, có `customer_id` bằng `Survey.customer_id` và thuộc cùng Company; không được liên kết lịch của Customer khác.
- `completed_by` phải có `CompanyMember.role = TECHNICIAN`, `CompanyMember.status = ACTIVE` trong đúng Company và có quyền trên Appointment/Survey tương ứng.
- `Survey.appointment_id` bắt buộc mang kiểu `uuid NOT NULL` (đã chốt tại **SCHEMA DECISION 02 — DECIDED / FROZEN**); mọi khảo sát phải gắn với lịch hẹn hợp lệ cùng Company và Customer; không cho phép orphan survey; dữ liệu legacy import nếu có phải tạo Appointment lịch sử tương ứng.
- Việc hoàn tất Survey phải có dấu vết phù hợp; TECHNICIAN không được từ Survey sửa giá, thanh toán hoặc tài chính.
- Số đo phải có đơn vị và cấu trúc thống nhất; không lưu chuỗi mô tả mơ hồ thay cho dữ liệu cần tính toán.
- Nếu sửa khảo sát đã dùng để báo giá, phải tạo phép tính giá mới và giữ kết quả cũ để truy vết.
- Ảnh không được lưu dưới dạng liên kết công khai vĩnh viễn.

## 14. PricingPolicy

### Mô tả và mục đích

`PricingPolicy` là một phiên bản khung giá do công ty nhập, chứa điều kiện và quy tắc tính giá chính thức.

- **Chủ sở hữu:** Thành viên 7; chỉ vai trò được phép quản lý giá mới được thay đổi.
- **Ai tạo:** SẾP/QUẢN TRỊ hoặc quy trình quản trị giá được ủy quyền.
- **Ai dùng:** Pricing engine, sale ở dạng kết quả được phép xem, order, contract và kiểm tra tài chính.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh chính sách. |
| `company_id` | `Company.id` sở hữu bảng giá; lưu trực tiếp để quản lý phiên bản và quyền theo tenant. |
| `version` | Phiên bản duy nhất, không đổi. |
| `conditions` | Điều kiện áp dụng có cấu trúc. |
| `price_rules` | Quy tắc tính giá có cấu trúc và được kiểm thử. |
| `effective_at` | Thời điểm bắt đầu có hiệu lực. |
| `status` | Bản nháp, đang hiệu lực hoặc ngừng hiệu lực theo danh mục chung. |

### Liên kết

Thuộc một `Company`; được `PriceCalculation.pricing_policy_id` tham chiếu, có phiên bản được snapshot tại `PriceCalculation.policy_version`, và gián tiếp ảnh hưởng `Order`, `Contract`.

### Quy tắc cập nhật

- Bắt buộc có phiên bản. Không ghi đè làm mất bảng giá cũ.
- Khi quy tắc giá thay đổi, tạo phiên bản mới; phép tính cũ tiếp tục trỏ phiên bản cũ.
- Không cho hai phiên bản cùng công ty có mã `version` trùng nhau.
- AI không được tạo hoặc sửa chính sách giá và không được tự suy diễn quy tắc ngoài `price_rules`.

## 15. PriceCalculation

### Mô tả và mục đích

`PriceCalculation` là kết quả tính giá có thể kiểm tra lại cho một khách hoặc đơn, dựa trên đầu vào và đúng phiên bản chính sách giá.

- **Chủ sở hữu:** Thành viên 7.
- **Ai tạo:** Pricing engine theo yêu cầu từ CRM, survey hoặc order.
- **Ai dùng:** Sale, CRM, order, contract và finance.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh lần tính. |
| `customer_id` | Khách được tính giá. |
| `survey_id` | Khảo sát nguồn nếu có. |
| `input_data` | Snapshot dữ liệu đầu vào dùng để tính. |
| `pricing_policy_id` | Tham chiếu logic đến `PricingPolicy.id` đã sử dụng. |
| `policy_version` | Snapshot phiên bản cụ thể của PricingPolicy tại thời điểm tính. |
| `amount` | Số tiền kết quả; chưa có giá cuối khi thiếu dữ liệu. |
| `status` | Trạng thái phép tính, gồm `NEED_INFO` khi thiếu dữ liệu. |
| `missing_fields` | Danh sách trường còn thiếu hoặc không hợp lệ. |

### Liên kết

Thuộc `Customer`, có thể tham chiếu `Survey` và tham chiếu `PricingPolicy` bằng `pricing_policy_id`; Company được suy ra an toàn qua Customer. Được `Order.price_calculation_id` tham chiếu.

### Quy tắc cập nhật

- Nếu thiếu dữ liệu, bắt buộc `status = NEED_INFO`, điền `missing_fields` và không tự tạo giá cuối.
- AI tuyệt đối không được đoán `amount`.
- Giữ snapshot `input_data` và `policy_version` cùng tham chiếu `pricing_policy_id` để tái lập kết quả.
- `pricing_policy_id` phải thuộc cùng Company với Customer; Customer, Survey và PricingPolicy tham gia phép tính phải cùng Company.
- `policy_version` phải đúng phiên bản đã dùng tại thời điểm tính; không tự đổi phép tính cũ sang phiên bản bảng giá mới khi xem lại.
- Khi đầu vào hoặc bảng giá đổi, tạo phép tính mới thay vì ghi đè kết quả đã dùng cho đơn/hợp đồng.

## 16. PaymentTransaction

### Mô tả và mục đích

`PaymentTransaction` là một giao dịch tiền thực tế nhận từ ngân hàng hoặc dịch vụ thanh toán, dùng để đối chiếu tiền cọc và các khoản thu với đơn hàng.

- **Chủ sở hữu:** Thành viên 7; Thành viên 1 sở hữu ranh giới quyền truy cập dữ liệu tài chính.
- **Ai tạo:** Webhook/adapter của ngân hàng hoặc nhà cung cấp thanh toán phía máy chủ.
- **Ai dùng:** Payment matching, order, FinanceSummary và SẾP/QUẢN TRỊ; SALE không được xem giao dịch ngân hàng tổng.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh giao dịch nội bộ. |
| `company_id` | `Company.id` lưu trực tiếp để cô lập tài chính, xử lý webhook và chống trùng đúng phạm vi tenant. |
| `provider_ref` | Mã giao dịch duy nhất từ nhà cung cấp. |
| `amount` | Số tiền giao dịch. |
| `occurred_at` | Thời điểm giao dịch xảy ra. |
| `transfer_content` | Nội dung chuyển khoản. |
| `matched_order_id` | Đơn được đối chiếu nếu có. |
| `match_confidence` | Độ tin cậy của kết quả đối chiếu. |
| `status` | Trạng thái tiếp nhận/đối chiếu/xác nhận/cần kiểm tra. |

### Liên kết

Thuộc một `Company`, có thể liên kết một `Order`; là nguồn tính `FinanceSummary.collected_amount`.

### Quy tắc cập nhật

- `provider_ref` phải có ràng buộc chống ghi trùng trong phạm vi `company_id` và nhà cung cấp/tài khoản phù hợp. Định danh nhà cung cấp/tài khoản chính thức là **CẦN CHỐT KHI THIẾT KẾ SCHEMA**.
- Đối chiếu Order bằng `payment_reference` hoặc `order_code`, sau đó kiểm tra số tiền và nội dung chuyển khoản.
- Chỉ tự xác nhận cọc khi kết quả khớp chắc chắn theo ngưỡng được duyệt; nếu không chắc, chuyển danh sách cần người có thẩm quyền kiểm tra.
- Sale không tự xác nhận cọc trong luồng chuẩn.
- Nếu có `matched_order_id`, Order phải thuộc cùng `company_id` với giao dịch.
- Không xóa hoặc sửa số tiền giao dịch nguồn; điều chỉnh phải có bản ghi/dấu vết riêng.

## 17. Order

### Mô tả và mục đích

`Order` là đơn hàng trung tâm kết nối khách, kết quả giá, thanh toán, hợp đồng và quá trình thực hiện.

- **Chủ sở hữu:** Thành viên 7.
- **Ai tạo:** Quy trình bán hàng khi khách đồng ý tiến tới đơn theo điều kiện nghiệp vụ.
- **Ai dùng:** Payment, contract, production, installation, warranty, finance, CRM và analytics.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh đơn. |
| `company_id` | `Company.id` lưu trực tiếp vì Order là aggregate gốc cho thanh toán, hợp đồng, vận hành, tài chính và RLS. |
| `customer_id` | Khách mua hàng. |
| `order_code` | Mã đơn dễ đọc, ổn định và duy nhất trong Company, ví dụ `DH-000218`. |
| `payment_reference` | Mã thanh toán duy nhất trong Company để đối chiếu chuyển khoản/QR, ví dụ `TT-DH000218`. |
| `price_calculation_id` | Kết quả tính giá được chọn. |
| `deposit_status` | Trạng thái tiền cọc. |
| `order_status` | Trạng thái toàn vòng đời đơn. |
| `final_amount` | Giá trị cuối của đơn theo thỏa thuận hợp lệ. |

### Liên kết

Thuộc một `Company` và một `Customer`, tham chiếu `PriceCalculation`; có các `PaymentTransaction`, `Contract`, `ProductionOrder`, `Installation`, `WarrantyTicket` và một `FinanceSummary`.

### Quy tắc cập nhật

- `deposit_status` chỉ đổi từ sự kiện thanh toán đã đối chiếu hoặc quyết định kiểm tra có audit; không do thao tác sale trong luồng chuẩn.
- `company_id` phải khớp Company của Customer và PriceCalculation liên quan.
- `order_code` và `payment_reference` phải duy nhất trong Company, ổn định sau khi cấp và không tái sử dụng.
- `payment_reference` không được chứa raw phone hoặc dữ liệu nhạy cảm; có thể dùng làm nội dung chuyển khoản hoặc tạo QR thanh toán.
- `final_amount` phải xuất phát từ phép tính giá/thương lượng được phê duyệt, không do AI tự thay đổi.
- Chuyển trạng thái đơn phải kiểm tra điều kiện trước; không xuống xưởng khi chưa có hợp đồng đã ký hợp lệ.
- Không xóa đơn đã phát sinh giao dịch hoặc hợp đồng.

## 18. Contract

### Mô tả và mục đích

`Contract` là hợp đồng của một đơn hàng, gồm bản sinh tự động và bản khách đã ký.

- **Chủ sở hữu:** Thành viên 7.
- **Ai tạo:** Hệ thống tạo từ mẫu sau khi xác nhận cọc; sale tải bản đã ký theo quyền.
- **Ai dùng:** Sale, order, production, finance và SẾP/QUẢN TRỊ.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh hợp đồng. |
| `order_id` | Đơn hàng liên quan. |
| `template_version` | Phiên bản mẫu hợp đồng đã dùng. |
| `generated_file_ref` | Tham chiếu bảo vệ đến hợp đồng được tạo. |
| `signed_file_ref` | Tham chiếu bảo vệ đến hợp đồng đã ký. |
| `status` | Trạng thái hợp đồng. |
| `contract_value` | Giá trị hợp đồng. |
| `created_at` | Thời điểm tạo. |
| `signed_at` | Thời điểm ký/xác nhận bản ký. |

### Liên kết

Thuộc `Order`; Company được suy ra an toàn qua `Order.company_id`. Là điều kiện tạo `ProductionOrder` và cung cấp `contract_value` cho `FinanceSummary`.

### Quy tắc cập nhật

- Chỉ tạo tự động sau khi tiền cọc được xác nhận theo quy tắc.
- Lưu `template_version`; không thay nội dung hợp đồng cũ khi mẫu thay đổi.
- Chỉ khi `signed_file_ref` hợp lệ và trạng thái xác nhận đã ký mới được chuyển xưởng.
- Không thay thế âm thầm tệp đã ký. Việc bổ sung/sửa phải có phiên bản và audit.
- `contract_value` không đồng nghĩa với tiền đã thu hoặc doanh thu hoàn thành.

## 19. ProductionOrder

### Mô tả và mục đích

`ProductionOrder` là lệnh chính thức gửi xuống xưởng để sản xuất theo thông số của đơn.

- **Chủ sở hữu:** Thành viên 8.
- **Ai tạo:** Quy trình vận hành sau khi kiểm tra hợp đồng đã ký hợp lệ.
- **Ai dùng:** Xưởng, QC, order, installation và analytics vận hành.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh lệnh sản xuất. |
| `order_id` | Đơn hàng nguồn. |
| `specs` | Snapshot thông số sản xuất đã duyệt. |
| `materials` | Vật liệu/yêu cầu vật tư có cấu trúc. |
| `status` | Trạng thái sản xuất. |
| `deadline` | Hạn hoàn thành dự kiến. |
| `qc_status` | Trạng thái kiểm tra chất lượng. |

### Liên kết

Thuộc `Order`; Company được suy ra an toàn qua `Order.company_id`. Nhận dữ liệu từ survey/đơn theo quy trình duyệt; hoàn thành để chuyển sang `Installation`.

### Quy tắc cập nhật

- Không được tạo nếu `Contract.signed_file_ref` chưa hợp lệ hoặc hợp đồng chưa ở trạng thái đã ký.
- `specs` phải là snapshot; thay đổi thông số sau khi phát hành cần quy trình thay đổi có audit.
- Chỉ chuyển hoàn thành khi điều kiện sản xuất và QC phù hợp.

## 20. Installation

### Mô tả và mục đích

`Installation` quản lý việc lắp đặt, ảnh hiện trường và bàn giao/nghiệm thu của đơn.

- **Chủ sở hữu:** Thành viên 8.
- **Ai tạo:** Module vận hành khi đơn đủ điều kiện lắp đặt.
- **Ai dùng:** Đội lắp đặt, CRM, order, finance, warranty và analytics.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh công việc lắp đặt. |
| `order_id` | Đơn hàng được lắp. |
| `appointment_id` | Lịch lắp đặt. |
| `crew` | Đội thực hiện theo cấu trúc được duyệt. |
| `status` | Trạng thái lắp đặt/bàn giao. |
| `photos` | Tham chiếu ảnh lắp đặt được bảo vệ. |
| `handover_ref` | Tham chiếu biên bản bàn giao/nghiệm thu. |
| `completed_at` | Thời điểm hoàn tất. |

### Liên kết

Thuộc `Order`, tham chiếu `Appointment`; Company được suy ra an toàn qua `Order.company_id` và phải khớp Company của Appointment. Kết quả có thể kích hoạt ghi nhận hoàn thành và `WarrantyTicket`.

### Quy tắc cập nhật

- Chỉ tạo khi sản xuất và QC đã đạt điều kiện.
- Không đánh dấu hoàn tất nếu thiếu bằng chứng bàn giao bắt buộc theo quy trình.
- Khi hoàn tất, cập nhật đơn và tài chính bằng giao dịch/luồng nhất quán; không coi việc có tiền cọc là đã hoàn thành.
- Tệp và ảnh phải được kiểm soát quyền.

## 21. FinanceSummary

### Mô tả và mục đích

`FinanceSummary` là bản tổng hợp tài chính theo từng đơn, giúp phân biệt giá trị hợp đồng, số tiền đã thu, công nợ và doanh thu hoàn thành.

- **Chủ sở hữu:** Thành viên 7; Thành viên 1 bảo vệ quyền xem tài chính.
- **Ai tạo:** Hệ thống tổng hợp từ hợp đồng, giao dịch đã xác nhận và trạng thái hoàn thành.
- **Ai dùng:** SẾP/QUẢN TRỊ, báo cáo tài chính bán hàng và analytics được cấp quyền; SALE không được xem tài chính tổng.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `order_id` | Khóa theo đơn hàng. |
| `contract_value` | Giá trị hợp đồng đã ký. |
| `collected_amount` | Tổng tiền đã thu và xác nhận. |
| `receivable_amount` | Công nợ còn phải thu. |
| `completed_revenue` | Doanh thu được ghi nhận khi đáp ứng điều kiện hoàn thành. |
| `updated_at` | Thời điểm tổng hợp gần nhất. |

### Liên kết

Quan hệ một-một với `Order`; Company được suy ra an toàn qua `Order.company_id`. Tổng hợp từ `Contract`, `PaymentTransaction` và trạng thái hoàn thành/bàn giao.

### Quy tắc cập nhật

- Phải phân biệt `contract_value`, `collected_amount` và `completed_revenue`; tiền cọc không tự động là doanh thu hoàn thành.
- `receivable_amount` được tính theo quy tắc tài chính đã duyệt, không cho người dùng nhập tùy ý.
- Bản tổng hợp phải có thể tính lại và truy ngược dữ liệu nguồn.
- Chỉ vai trò có `can_view_finance = true` mới được nhận dữ liệu tài chính đầy đủ.

## 22. CareCampaign

### Mô tả và mục đích

`CareCampaign` là một chiến dịch chăm sóc khách qua một kênh, dùng để quản lý đối tượng, nội dung và kết quả gửi.

- **Chủ sở hữu:** Thành viên 3 cho Zalo, Thành viên 4 cho Facebook; Thành viên 9 dùng số liệu phân tích.
- **Ai tạo:** Người có quyền hoặc automation đã được doanh nghiệp cấu hình.
- **Ai dùng:** Module care, CRM, sale khi khách phản hồi và analytics.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh chiến dịch. |
| `company_id` | `Company.id` lưu trực tiếp vì chiến dịch không có một Customer cha duy nhất và phải cô lập đối tượng gửi theo tenant. |
| `channel` | Kênh gửi, trước mắt `zalo` hoặc `facebook`. |
| `audience_rule` | Quy tắc chọn đối tượng có phiên bản/snapshot. |
| `message_template` | Nội dung mẫu đã duyệt. |
| `started_at` | Thời điểm bắt đầu. |
| `sent_count` | Tổng số đã gửi. |
| `delivered_count` | Tổng số đã giao thành công theo nguồn. |
| `response_count` | Tổng số phản hồi. |
| `converted_to_sale_count` | Số phản hồi được chuyển cho sale. |

### Liên kết

Thuộc một `Company`; chọn khách trong cùng Company dựa trên `Customer`/`CareSchedule`. Mỗi lượt gửi được ghi bằng `CareDelivery`; kết quả gửi có thể tạo `Interaction` và phản hồi có thể đưa hội thoại cho sale.

### Quy tắc cập nhật

- Không đưa khách có lịch đã dừng hoặc không còn đồng ý vào đối tượng gửi.
- `audience_rule` chỉ được chọn dữ liệu thuộc `company_id` của chiến dịch.
- Snapshot quy tắc đối tượng và mẫu tại thời điểm chạy để kiểm tra lại.
- `sent_count`, `delivered_count`, `response_count`, `converted_to_sale_count` là dữ liệu tổng hợp từ `CareDelivery`, phải tính/đối soát lại được; module không tự cộng tùy tiện.
- Webhook lặp phải cập nhật idempotent trên CareDelivery tương ứng, không tạo thêm lượt gửi hoặc tăng bộ đếm lần nữa.
- AI không tự tạo cam kết, giảm giá hoặc thông tin kỹ thuật trong nội dung chiến dịch.

## 23. CareDelivery

### Mô tả và mục đích

`CareDelivery` lưu một lần gửi chăm sóc cụ thể của một chiến dịch tới một Customer, làm nguồn truy vết và tổng hợp kết quả chiến dịch.

- **Chủ sở hữu:** Thành viên 3 cho Zalo, Thành viên 4 cho Facebook; Thành viên 9 sử dụng cho analytics.
- **Ai tạo:** Module care/automation khi tạo một lượt gửi hợp lệ từ CareCampaign, có thể dựa trên CareSchedule.
- **Ai dùng:** CareCampaign, CRM, tích hợp kênh, sale khi khách phản hồi và analytics.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh lượt gửi. |
| `company_id` | `Company.id` lưu trực tiếp để xử lý webhook, chống gửi trùng, RLS và thống kê tenant. |
| `campaign_id` | `CareCampaign.id` tạo lượt gửi. |
| `customer_id` | `Customer.id` nhận nội dung chăm sóc. |
| `channel` | Kênh gửi, trước mắt `zalo` hoặc `facebook`. |
| `external_message_ref` | Mã tin nhắn/lượt gửi ở hệ thống ngoài để đối soát khi có. |
| `status` | Trạng thái lượt gửi theo hằng số chung. |
| `sent_at` | Thời điểm thực sự gửi; trống nếu chưa gửi. |
| `delivered_at` | Thời điểm nguồn xác nhận đã giao; trống nếu chưa xác nhận. |
| `responded_at` | Thời điểm xác định phản hồi phù hợp của khách; trống nếu chưa có. |
| `converted_to_sale_at` | Thời điểm phản hồi thực sự được chuyển cho sale; trống nếu chưa chuyển. |
| `created_at` | Thời điểm tạo lượt gửi nội bộ. |

### Liên kết

Thuộc một `Company`, một `CareCampaign` và một `Customer`. Một CareCampaign có nhiều CareDelivery; một Customer có nhiều CareDelivery. `CareSchedule` có thể là nguồn tạo lượt gửi nhưng chưa bắt buộc liên kết cứng ở bước contract này.

### Quy tắc cập nhật

- Company của Campaign, Customer và CareDelivery phải giống nhau; `channel` phải tương thích với Campaign.
- Phải chống tạo lượt gửi trùng. Khóa idempotency nội bộ cụ thể ngoài `external_message_ref` là **CẦN CHỐT KHI THIẾT KẾ SCHEMA**.
- `external_message_ref` dùng để đối soát với kênh ngoài khi có và phải chống ánh xạ cùng một tin nguồn sang nhiều lượt gửi trong cùng Company/kênh.
- `sent_at` chỉ có khi đã gửi; `delivered_at` chỉ có khi nguồn xác nhận đã giao.
- `responded_at` chỉ có khi xác định được phản hồi phù hợp; `converted_to_sale_at` chỉ có khi phản hồi thực sự được chuyển cho sale.
- Webhook lặp phải cập nhật idempotent cùng bản ghi, không tạo CareDelivery mới hoặc làm bộ đếm CareCampaign tăng lại.
- Các bộ đếm của CareCampaign phải được tổng hợp từ CareDelivery và có thể kiểm tra lại.

## 24. CareSchedule

### Mô tả và mục đích

`CareSchedule` là lịch chăm sóc riêng của một khách trên một kênh, cho biết chu kỳ và lần gửi tiếp theo.

- **Chủ sở hữu:** Thành viên 3 cho Zalo, Thành viên 4 cho Facebook.
- **Ai tạo:** CRM/care automation khi khách đủ điều kiện hoặc người có quyền bật chăm sóc.
- **Ai dùng:** Bộ lập lịch chăm sóc, chiến dịch, CRM và sale.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh lịch. |
| `company_id` | `Company.id` lưu trực tiếp để bộ lập lịch quét theo tenant và tránh gửi chéo công ty. |
| `customer_id` | Khách được chăm sóc. |
| `channel` | `zalo` hoặc `facebook`. |
| `frequency_months` | Chu kỳ theo tháng; mặc định có thể là 1. |
| `next_send_at` | Thời điểm dự kiến gửi tiếp. |
| `enabled` | Lịch còn hoạt động hay không. |
| `stop_reason` | Lý do dừng. |

### Liên kết

Thuộc một `Company` và một `Customer`; được `CareCampaign` cùng Company hoặc automation dùng để chọn lượt gửi.

### Quy tắc cập nhật

- Có thể mặc định `frequency_months = 1` theo cấu hình doanh nghiệp.
- `company_id` phải khớp Company của Customer và chiến dịch sử dụng lịch.
- Khi khách yêu cầu ngừng hoặc doanh nghiệp tắt chăm sóc, đặt `enabled = false` và lưu `stop_reason`.
- Không tự bật lại lịch đã dừng.
- Chỉ cập nhật `next_send_at` sau khi xác định rõ kết quả lượt gửi/luật lập lịch, tránh gửi trùng.

## 25. AIAnalysis

### Mô tả và mục đích

`AIAnalysis` là một kết quả AI phân tích khách dựa trên bằng chứng xác định, phục vụ tóm tắt, gợi ý giai đoạn và hành động tiếp theo.

- **Chủ sở hữu:** Thành viên 9.
- **Ai tạo:** Pipeline AI khi có dữ liệu nguồn và quyền sử dụng phù hợp.
- **Ai dùng:** CRM, sale, automation và analytics; kết quả chỉ là gợi ý trừ khi có quy tắc tự động được duyệt.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh lần phân tích. |
| `customer_id` | Khách được phân tích. |
| `source_refs` | Danh sách tham chiếu đến nguồn đã dùng. |
| `summary` | Tóm tắt có căn cứ. |
| `stage_suggestion` | Gợi ý giai đoạn khách. |
| `stop_reason` | Lý do khách dừng/chưa tiến tiếp nếu suy ra được. |
| `objections` | Các phản đối được phát hiện. |
| `next_action` | Hành động tiếp theo được gợi ý. |
| `confidence` | Độ tin cậy theo thang đo thống nhất. |
| `evidence` | Bằng chứng ngắn gọn gắn với kết luận. |
| `model_version` | Phiên bản model/prompt hoặc pipeline đã dùng. |

### Liên kết

Thuộc `Customer`; Company được suy ra an toàn qua Customer. Tham chiếu `Interaction`, `CallTranscript` hoặc dữ liệu nguồn khác bằng `source_refs`.

### Quy tắc cập nhật

- Mỗi lần phân tích là một kết quả có phiên bản; không ghi đè mất kết quả cũ khi model hoặc nguồn thay đổi.
- Bắt buộc có `source_refs`, `confidence`, `evidence` và `model_version` để kiểm tra.
- Mọi `source_refs` phải thuộc cùng Company với Customer được phân tích.
- Không bịa dữ liệu, giá, thông số kỹ thuật, cam kết hoặc hành động của sale.
- `stage_suggestion` không tự đổi `Customer.stage` nếu chưa có luật được duyệt.
- Không dùng `confidence` như bằng chứng duy nhất cho quyết định tài chính hoặc quyền truy cập.

## 26. SalesStyleProfile

### Mô tả và mục đích

`SalesStyleProfile` mô tả phong cách giao tiếp của sale duy nhất để AI hỗ trợ trả lời nhất quán về giọng điệu mà không thay quyền quyết định của sale.

- **Chủ sở hữu:** Thành viên 9; sale và người quản trị có quyền review nội dung phù hợp.
- **Ai tạo:** Pipeline phân tích tin nhắn/cuộc gọi sale từ nguồn được phép, sau đó lưu phiên bản.
- **Ai dùng:** Automation trả lời sau 5 phút và công cụ hỗ trợ soạn thảo.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh hồ sơ phong cách. |
| `company_id` | `Company.id` lưu trực tiếp vì cùng một UserProfile có thể có membership ở nhiều Company và phong cách thuộc ngữ cảnh doanh nghiệp. |
| `sale_user_id` | `UserProfile.id` của sale duy nhất trong Company. |
| `version` | Phiên bản hồ sơ. |
| `salutation_rules` | Quy tắc xưng hô. |
| `sentence_style` | Độ dài, nhịp và cách viết câu. |
| `question_style` | Cách đặt câu hỏi. |
| `objection_style` | Cách diễn đạt khi xử lý phản đối. |
| `closing_style` | Cách diễn đạt khi chốt. |
| `examples` | Ví dụ đã chọn lọc và được phép sử dụng. |
| `updated_at` | Thời điểm cập nhật phiên bản. |

### Liên kết

Thuộc một `Company`, liên kết `UserProfile` của sale thông qua CompanyMember; được xây từ `Interaction` do sale tạo và `CallTranscript` của cuộc gọi sale trong cùng Company; được automation AI sử dụng.

### Quy tắc cập nhật

- Mỗi Company có tối đa một SALE hoạt động; `sale_user_id` phải chính là UserProfile của CompanyMember có `role = SALE`, `status = ACTIVE` trong đúng `company_id`. Vì hiện chỉ có một Company nên toàn hệ thống hiện tại có một sale duy nhất.
- Mỗi thay đổi đáng kể tạo phiên bản mới hoặc giữ lịch sử phiên bản.
- Ví dụ phải loại bỏ dữ liệu khách không cần thiết và tuân thủ quyền riêng tư.
- Hồ sơ chỉ điều khiển phong cách diễn đạt. AI vẫn không được tự giảm giá, thay điều khoản, cam kết, bịa kỹ thuật hoặc quyết định thay sale.

## 27. WarrantyTicket

### Mô tả và mục đích

`WarrantyTicket` là phiếu bảo hành/hậu mãi sau khi đơn đã được lắp đặt hoặc bàn giao, dùng để theo dõi vấn đề và kết quả xử lý.

- **Chủ sở hữu:** Thành viên 8.
- **Ai tạo:** CRM, vận hành hoặc chăm sóc sau bán khi tiếp nhận yêu cầu hợp lệ.
- **Ai dùng:** CRM, vận hành, chăm sóc sau bán và analytics.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh phiếu bảo hành. |
| `company_id` | `Company.id` lưu trực tiếp để phân công, RLS và truy vấn hậu mãi theo tenant. |
| `customer_id` | `Customer.id` yêu cầu bảo hành. |
| `order_id` | `Order.id` được bảo hành. |
| `installation_id` | `Installation.id` liên quan nếu vấn đề gắn với lần lắp đặt cụ thể. |
| `issue` | Nội dung vấn đề cần xử lý; có thể chứa dữ liệu nhạy cảm. |
| `status` | Trạng thái phiếu theo hằng số chung. |
| `assigned_to` | `UserProfile.id` của người phụ trách; mặc định là TECHNICIAN cho công việc kỹ thuật. Mô hình đội riêng là **CẦN CHỐT KHI THIẾT KẾ SCHEMA**. |
| `opened_at` | Thời điểm mở phiếu. |
| `resolved_at` | Thời điểm xử lý xong; trống khi chưa hoàn tất. |
| `notes` | Ghi chú xử lý ở mức cần thiết. |

### Liên kết

Thuộc một `Company`, một `Customer` và một `Order`; có thể tham chiếu `Installation`. `assigned_to` tham chiếu `UserProfile` có `CompanyMember.status = ACTIVE` với role phù hợp trong cùng Company; công việc kỹ thuật mặc định yêu cầu role TECHNICIAN.

### Quy tắc cập nhật

- `company_id`, Customer, Order và Installation nếu có phải cùng thuộc một Company.
- Phiếu phải liên kết được về cả Customer và Order; chỉ liên kết Installation khi đúng lần lắp đặt liên quan.
- Thay đổi trạng thái phải có lịch sử hoặc `AuditLog` phù hợp. Cách lưu lịch sử trạng thái chi tiết là **CẦN CHỐT KHI THIẾT KẾ SCHEMA**.
- Không được tự thay đổi dữ liệu hợp đồng, giá hoặc tài chính từ luồng bảo hành.
- `resolved_at` chỉ có khi phiếu thực sự được xử lý xong; nếu mở lại phải giữ dấu vết lần giải quyết trước.
- Ảnh/tệp bảo hành nếu bổ sung sau này phải dùng tham chiếu được kiểm soát quyền, không dùng URL công khai mặc định.

## 28. AccessPolicy

### Mô tả và mục đích

`AccessPolicy` là contract quyền logic mô tả quyền tối thiểu theo vai trò, làm đầu vào thống nhất cho kiểm tra quyền ở cơ sở dữ liệu, máy chủ và API. Nó không bắt buộc phải trở thành một bảng Supabase tên `access_policies`.

- **Chủ sở hữu:** Thành viên 1.
- **Ai tạo:** Chính sách nền được review; cách biểu diễn bằng code, cấu hình hoặc dữ liệu là **CẦN CHỐT KHI THIẾT KẾ SCHEMA**.
- **Ai dùng:** Auth, RLS, API, truy vấn, export, gọi khách, pricing, finance và audit.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `role` | Vai trò, tối thiểu có `BOSS_ADMIN`, `SALE` và `TECHNICIAN`. |
| `can_view_raw_phone` | Được nhận số điện thoại thật hay không. |
| `can_export_contacts` | Được xuất danh sách liên hệ hay không. |
| `can_view_finance` | Được xem dữ liệu tài chính tổng hay không. |
| `can_manage_pricing` | Được quản lý bảng giá hay không. |
| `can_call_customer` | Được yêu cầu hệ thống gọi khách hay không. |
| `audit_required` | Thao tác theo quyền này có bắt buộc audit hay không. |

### Ma trận tối thiểu

| Quyền | SẾP / QUẢN TRỊ (`BOSS_ADMIN`) | SALE (`SALE`) | KỸ THUẬT VIÊN (`TECHNICIAN`) |
| --- | --- | --- | --- |
| `can_view_raw_phone` | `true` | `false` | `false` |
| `can_export_contacts` | Theo cấu hình quản trị có kiểm soát | `false` | `false` |
| `can_view_finance` | `true` | `false` với tài chính quản trị/tổng | `false` |
| `can_manage_pricing` | `true` hoặc theo ủy quyền quản trị | `false` | `false` |
| `can_call_customer` | Theo cấu hình | `true`, nhưng chỉ qua lệnh máy chủ bằng `customer_id` | `false` |
| `audit_required` | `true` cho thao tác nhạy cảm | `true` cho gọi, chat và thao tác nhạy cảm | `true` cho thay đổi khảo sát/công việc quan trọng |

### Liên kết

`CompanyMember.role` cho biết người dùng đang có vai trò nào trong một Company; `AccessPolicy` mô tả vai trò đó có quyền logic nào. Contract này chi phối quyền đọc `Customer.phone`, `PaymentTransaction`, `FinanceSummary`, `PricingPolicy`, luồng gọi khách và các thao tác cần `AuditLog`.

### Quy tắc cập nhật

- Bắt buộc: SẾP có `can_view_raw_phone = true`; SALE và TECHNICIAN có `can_view_raw_phone = false`.
- Quyền có thể được triển khai bằng sự kết hợp của `CompanyMember.role`, RLS, server-side authorization, database view/RPC hạn chế dữ liệu và policy code; không chỉ ở giao diện.
- SALE không được nhận raw phone nhưng có thể gọi bằng `customer_id` hoặc tìm bằng `customer_code`: máy chủ kiểm tra CompanyMember/AccessPolicy, lấy số và chuyển thẳng sang tổng đài.
- Raw phone không được trả về trình duyệt của SALE hoặc TECHNICIAN trong response, lỗi, log phía client hoặc dữ liệu tải trước.
- `can_view_finance = false` của SALE nghĩa là không được xem tài chính quản trị/tổng Company. SALE vẫn được xem giá đã tính/đã báo, `Order.final_amount`, `deposit_status`, số tiền khách cần thanh toán và thông tin thương mại cần cho việc chốt trong phạm vi khách/đơn hợp lệ.
- SALE không được xem toàn bộ PaymentTransaction, giao dịch ngân hàng tổng, FinanceSummary toàn Company, báo cáo quản trị hoặc tổng doanh thu.
- TECHNICIAN chỉ được xem Appointment/Survey và dữ liệu cần thiết của công việc được giao; được xem địa chỉ khảo sát, nhập số đo/ảnh và cập nhật trạng thái. TECHNICIAN không được xem raw phone, xuất khách, xem tài chính tổng, quản lý giá, xác nhận cọc, sửa hợp đồng hoặc tự gọi khách.
- Nếu sau này TECHNICIAN cần liên hệ khách, phải có quy trình riêng được duyệt; không mặc định cấp raw phone hoặc `can_call_customer = true`.
- Mặc định từ chối khi chưa có quyền rõ ràng; thay đổi quyền phải có audit và review của Thành viên 1.
- Không đưa raw phone vào view, RPC, response, log hoặc export dành cho SALE hoặc TECHNICIAN.

## 29. AuditLog

### Mô tả và mục đích

`AuditLog` lưu dấu vết các thao tác nhạy cảm và thao tác quản trị quan trọng để kiểm tra ai đã làm gì, trên tài nguyên nào và kết quả ra sao.

- **Chủ sở hữu:** Thành viên 1.
- **Ai tạo:** Cơ sở dữ liệu, máy chủ hoặc dịch vụ tin cậy khi thực hiện thao tác cần audit; người dùng không tự tạo tùy ý.
- **Ai dùng:** SẾP/QUẢN TRỊ được cấp quyền, bảo mật, điều tra sự cố và kiểm tra tuân thủ.

### Trường chính

| Trường | Ý nghĩa |
| --- | --- |
| `id` | Định danh bản ghi audit. |
| `company_id` | `Company.id` của ngữ cảnh thao tác, lưu trực tiếp để cô lập và truy vấn audit theo tenant. |
| `user_id` | `UserProfile.id` của người thực hiện nếu tác nhân là người dùng; có thể trống với tác nhân hệ thống theo thiết kế sau này. |
| `action` | Hành động đã thực hiện theo danh mục tập trung. |
| `resource_type` | Loại tài nguyên bị tác động. |
| `resource_id` | Định danh tài nguyên bị tác động. |
| `customer_id` | `Customer.id` liên quan nếu thao tác gắn với khách. |
| `result` | Kết quả thành công, từ chối hoặc thất bại theo hằng số chung. |
| `metadata` | Metadata tối thiểu cần thiết để điều tra, không phải bản sao payload. |
| `created_at` | Thời điểm sự kiện audit xảy ra. |

### Liên kết

Thuộc một `Company`; có thể tham chiếu `UserProfile`, `Customer` và tài nguyên nghiệp vụ qua `resource_type`/`resource_id`. Cách bảo đảm tính toàn vẹn cho tham chiếu tài nguyên đa hình là **CẦN CHỐT KHI THIẾT KẾ SCHEMA**.

### Quy tắc cập nhật

- Ưu tiên append-only. Người dùng bình thường không được tự sửa hoặc xóa audit.
- Không dùng `AuditLog` làm nơi lưu raw phone, secret, token, mật khẩu hoặc toàn bộ payload nhạy cảm.
- `metadata` phải tối thiểu hóa dữ liệu cá nhân; chỉ lưu thông tin thật sự cần để truy vết.
- Nếu có `user_id` hoặc `customer_id`, đối tượng phải thuộc/có membership trong ngữ cảnh `company_id` phù hợp tại thời điểm thao tác; lịch sử vẫn được giữ khi membership sau đó ngừng hoạt động.
- Các thao tác có thể bắt buộc audit tùy `AccessPolicy` gồm gọi khách, xem dữ liệu nhạy cảm, thay quyền, xuất dữ liệu, quản lý bảng giá, xử lý ngoại lệ thanh toán và thay đổi quan trọng trong quy trình đơn hàng.
- Nhật ký cho thao tác bị từ chối hoặc thất bại cũng cần được cân nhắc; phạm vi lưu và thời hạn lưu là **CẦN CHỐT KHI THIẾT KẾ SCHEMA**.

## B. Phân loại phạm vi Company

Phân loại này định hướng contract, chưa phải quyết định cột/index/RLS cuối cùng:

- **A — Có `company_id` trực tiếp:** cần cho RLS, unique constraint, truy vấn tenant, webhook, scheduler, audit hoặc giảm join bảo mật phức tạp.
- **B — Suy ra an toàn qua quan hệ cha:** contract có một đường quan hệ bắt buộc, rõ ràng về Company; chưa lặp `company_id` nếu lợi ích chưa vượt chi phí bảo đảm nhất quán.
- **C — Cần quyết định khi thiết kế schema:** chưa đủ căn cứ để chốt cách biểu diễn hoặc bản thân contract không nhất thiết là bảng tenant.

| Entity | Nhóm | Quyết định và lý do |
| --- | --- | --- |
| `Company` | Gốc tenant | Không có `company_id`; `id` của Company chính là gốc phạm vi. |
| `UserProfile` | C | Là hồ sơ gắn Auth, có thể tham gia nhiều Company; không gắn cố định một `company_id`. Cách liên kết `auth.users.id` cần chốt. |
| `CompanyMember` | A | Cần `company_id` trực tiếp để ràng buộc membership, role và cặp duy nhất `(company_id, user_id)`. |
| `Customer` | A | Cần cho RLS và uniqueness của phone/customer_code theo Company. |
| `CustomerStageHistory` | A | Cần cho RLS và truy vấn lịch sử lớn; phải khớp Company của Customer. |
| `Identity` | A | Cần cho uniqueness `(company_id, channel, external_id)` và định tuyến danh tính theo tenant. |
| `Interaction` | A | Timeline có lưu lượng lớn và sự kiện ngoài; cần cho RLS, truy vấn và idempotency theo tenant. |
| `Conversation` | A | Đã có trực tiếp; cần cho inbox và uniqueness hội thoại ngoài theo Company. |
| `Call` | A | Cần cho webhook tổng đài, RLS và truy vấn cuộc gọi theo tenant. |
| `CallAttempt` | A | Cần cho scheduler và cô lập chu kỳ gọi lại theo tenant. |
| `CallTranscript` | B | Suy ra qua `call_id → Call.company_id`; quan hệ một-một rõ ràng. Việc lặp cột vì hiệu năng RLS cần đánh giá sau. |
| `Appointment` | A | Cần cho scheduler, phân công và kiểm tra membership theo tenant. |
| `Survey` | B | Suy ra qua Customer; trong luồng chuẩn phải tham chiếu Appointment nguồn có `type = survey`, cùng Customer và cùng Company. |
| `PricingPolicy` | A | Đã có trực tiếp; cần quản lý phiên bản và quyền giá theo Company. |
| `PriceCalculation` | B | Suy ra qua Customer; Customer, Survey và PricingPolicy phải cùng Company. |
| `PaymentTransaction` | A | Cần cô lập tài chính, xử lý webhook và chống `provider_ref` trùng đúng phạm vi. |
| `Order` | A | Là aggregate gốc cho hợp đồng, vận hành và tài chính; cần RLS/truy vấn tenant trực tiếp. |
| `Contract` | B | Suy ra qua Order bắt buộc; không có nhu cầu webhook/unique riêng đã rõ ở bước contract. |
| `ProductionOrder` | B | Suy ra qua Order bắt buộc. |
| `Installation` | B | Suy ra qua Order bắt buộc; Appointment nếu có phải cùng Company. |
| `FinanceSummary` | B | Quan hệ một-một với Order nên suy ra an toàn qua `Order.company_id`. |
| `CareCampaign` | A | Không có một Customer cha duy nhất; cần cô lập tập đối tượng gửi theo Company. |
| `CareDelivery` | A | Cần cho webhook theo kênh, chống gửi trùng, truy vấn chiến dịch, RLS và thống kê tenant. |
| `CareSchedule` | A | Cần cho scheduler quét theo tenant và ngăn gửi chéo Company. |
| `AIAnalysis` | B | Suy ra qua Customer; mọi nguồn bằng chứng phải cùng Company. |
| `SalesStyleProfile` | A | Một UserProfile có thể thuộc nhiều Company; profile phong cách phải có ngữ cảnh Company rõ ràng. |
| `WarrantyTicket` | A | Cần cho RLS, phân công và truy vấn hậu mãi theo tenant. |
| `AccessPolicy` | C | Là contract logic, không bắt buộc là bảng; cách hỗ trợ policy toàn cục hay tùy biến theo Company cần chốt. |
| `AuditLog` | A | Cần cô lập, truy vấn và lưu bằng chứng thao tác theo tenant mà không dựa vào join tài nguyên đa hình. |

Với entity nhóm A đồng thời có quan hệ cha, `company_id` trực tiếp phải khớp Company của quan hệ cha. Cơ chế bảo đảm tính nhất quán này bằng foreign key ghép, trigger hay lớp ghi dữ liệu là **CẦN CHỐT KHI THIẾT KẾ SCHEMA**.

## C. Trách nhiệm khi tích hợp giữa các module

- Module tạo dữ liệu phải kiểm tra đầu vào, chống ghi trùng và phát ra định danh ổn định.
- Module dùng dữ liệu không được suy diễn thêm quyền; chỉ nhận trường cần thiết cho công việc.
- Chuỗi phạm vi chính là `Company → Customer → Order`; người dùng truy cập Company qua `UserProfile → CompanyMember → Company`, còn quyền logic được ánh xạ từ `CompanyMember.role → AccessPolicy`.
- Lịch sử hành trình đi theo `Customer → CustomerStageHistory`; từng lượt chăm sóc đi theo `CareCampaign/Customer → CareDelivery`; hậu mãi đi theo `Order/Installation → WarrantyTicket`; audit truy về `Company`, `UserProfile`, `Customer` và tài nguyên liên quan.
- Trạng thái quan trọng như đã cọc, hợp đồng đã ký, được xuống xưởng và doanh thu hoàn thành phải dựa trên dữ liệu nguồn cùng điều kiện đã nêu, không dựa trên chuỗi hiển thị.
- Khi một sự kiện cập nhật nhiều miền, phải thiết kế để chạy lại an toàn và không nhân đôi giao dịch, tin nhắn, cuộc gọi hoặc lịch.
- Mọi thay đổi phá tương thích với tài liệu này phải nêu module bị ảnh hưởng, phương án migration và kế hoạch cập nhật người dùng dữ liệu trong Pull Request.

## D. Chưa phải schema Supabase

`DATA_CONTRACT.md` là hợp đồng dữ liệu ở mức kiến trúc. Tài liệu này chưa phải:

- Bảng Supabase chính thức.
- Migration SQL.
- RLS policy.
- Index.
- Foreign key cuối cùng.
- Enum cuối cùng.

Trình tự tiếp theo chỉ bắt đầu sau khi contract được duyệt:

`DATA_CONTRACT → thiết kế schema Supabase → thiết kế Auth → thiết kế RLS → migration → kiểm thử quyền`

Toàn bộ các yêu cầu thiết kế kiến trúc (chuẩn hóa phone E.164, `Survey.appointment_id NOT NULL`, mã native sequence, idempotency thanh toán và tin nhắn, mô hình đội thợ, danh mục canonical `UPPER_SNAKE_CASE`, storage TTL, ma trận RLS và cơ chế phân tách Raw/Sanitized Interaction) đã được giải quyết triệt để và đóng băng (**FULL DESIGN FREEZE**) tại `docs/SUPABASE_SCHEMA_DESIGN.md`, `docs/AUTH_DESIGN.md` và `docs/SUPABASE_RLS_DESIGN.md`, sẵn sàng bước vào pha triển khai Migration 001.
