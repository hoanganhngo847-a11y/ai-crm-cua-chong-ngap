# Luật tổng của dự án AI CRM đa kênh

> Tài liệu này là nguồn tham chiếu chung cho toàn bộ nhóm. Mọi thiết kế, dữ liệu, API và Pull Request phải tuân theo các nguyên tắc dưới đây. Khi yêu cầu mới mâu thuẫn với tài liệu này, nhóm phải thống nhất và cập nhật tài liệu trước khi triển khai.

## 1. Mục tiêu phần mềm

Phần mềm là hệ thống AI CRM đa kênh quản lý toàn bộ hành trình khách hàng cho doanh nghiệp sản xuất cửa chống ngập theo đơn đặt hàng.

### Trước khi có hệ thống

Khoảng 4 nhân viên sale phải cùng thực hiện nhiều việc lặp lại:

- Trực tin nhắn.
- Gọi khách.
- Hỏi nhu cầu.
- Theo dõi khách.
- Ghi dữ liệu vào Google Sheet.
- Đặt lịch khảo sát.
- Nhắc lại và chăm sóc khách.

### Sau khi có hệ thống

AI xử lý phần lớn công việc lặp lại. Doanh nghiệp chỉ còn **1 sale duy nhất**, tập trung vào:

- Tư vấn sâu.
- Thương lượng.
- Chốt đơn.

Phần mềm phải đồng thời giảm khối lượng công việc thủ công và giúp doanh nghiệp tăng doanh thu. Tự động hóa không được đánh đổi tính đúng đắn, an toàn dữ liệu hoặc trải nghiệm khách hàng.

## 2. Nguồn khách

Khách hàng có thể đến từ:

- Facebook Fanpage / Messenger.
- Zalo OA.
- Website.
- Hotline.
- Quảng cáo.

Mọi nguồn phải được đưa về một hồ sơ khách hàng trung tâm là `Customer`.

- Số điện thoại là khóa nhận diện chính khi hệ thống đã có số; phải được chuẩn hóa trước khi đối chiếu, không so sánh bằng chuỗi nhập thô.
- Một khách xuất hiện ở nhiều kênh nhưng có cùng số điện thoại phải được gộp về cùng một `Customer`.
- Khi chưa có số điện thoại, hệ thống có thể tạm nhận diện bằng danh tính theo kênh. Việc gộp phải có bằng chứng và lưu dấu vết, không được gộp chỉ dựa trên suy đoán.
- Dữ liệu nhận diện theo từng kênh được lưu bằng `Identity`, không tạo hồ sơ khách chính trùng lặp.

## 3. Hộp thư tích hợp

Phần mềm phải có một màn hình chung cho **Facebook Messenger và Zalo OA**.

Sale có thể:

- Xem hội thoại.
- Biết hội thoại đến từ kênh nào.
- Xem tin chưa đọc.
- Trả lời trực tiếp trong phần mềm.

Sale không cần mở riêng Facebook và Zalo. Mỗi tin nhắn phải giữ được kênh nguồn, mã tham chiếu bên ngoài, người gửi và thời điểm để phục vụ đồng bộ, chống ghi trùng và kiểm tra lịch sử.

`Conversation` là thread/hội thoại trong Hộp thư tích hợp. `Interaction` là từng sự kiện hoặc tin nhắn. Mọi Interaction dạng tin nhắn thuộc inbox phải liên kết được về đúng Conversation; Interaction dạng cuộc gọi, ghi chú hoặc sự kiện không thuộc hội thoại có thể không có liên kết này.

## 4. Quy tắc cuộc gọi

### Khách chủ động gọi Hotline

- AI nhận cuộc gọi ngay.
- Cuộc gọi đến này không tính vào quy tắc gọi lại 3 lần.

### Khách để số qua Facebook, Zalo, Website hoặc quảng cáo

1. **Lần 1:** gọi ngay.
2. Nếu không nghe, **lần 2:** gọi sau 2–3 giờ.
3. Nếu vẫn không nghe, **lần 3:** gọi vào ngày hôm sau.
4. Sau 3 lần không nghe, chuyển trạng thái thành **KHÔNG LIÊN LẠC ĐƯỢC**.

Không được xóa khách sau ba lần gọi không thành công. Hồ sơ vẫn được giữ lại để chăm sóc sau này. Mỗi lần thử gọi phải được ghi riêng bằng `CallAttempt`; cuộc gọi thực tế được ghi bằng `Call`.

Ba lần gọi thuộc cùng một chu kỳ liên hệ, được nhận diện bằng `contact_cycle_id`. Trong cùng Company, Customer và chu kỳ, mỗi `attempt_no` từ 1 đến 3 chỉ được xuất hiện tối đa một lần. Không được âm thầm đặt lại số lần gọi trong cùng chu kỳ.

- Chu kỳ mới chỉ được bắt đầu khi có lý do nghiệp vụ hợp lệ, ví dụ khách quay lại sau một khoảng thời gian.
- Cuộc gọi Hotline inbound không thuộc chu kỳ outbound ba lần.
- Sau lần 3 thất bại, chu kỳ kết thúc và Customer vẫn được giữ để chăm sóc.

## 5. Khảo sát và báo giá

- Nếu khách cung cấp đủ thông số, hệ thống dùng đúng phiên bản bảng giá của công ty và tính theo quy tắc cố định.
- Nếu thiếu thông tin, AI không được đoán giá. Kết quả phải chuyển thành **CẦN KIỂM TRA THÔNG TIN** (`NEED_INFO`) và nêu rõ trường còn thiếu.
- Nếu khách không biết đo, AI đặt lịch khảo sát. Kỹ thuật viên đến địa điểm, nhập số đo vào hệ thống, hệ thống tính giá và chuyển khách cho sale chốt.
- Mọi kết quả giá phải truy ngược được dữ liệu đầu vào, `PricingPolicy` đã dùng, phiên bản bảng giá và kết quả tính.
- Không tự chuyển phép tính cũ sang bảng giá mới. Khi dữ liệu hoặc giá thay đổi, phải tạo kết quả tính giá mới và giữ lịch sử cũ.

Lịch khảo sát mặc định được giao qua `Appointment.assignee_id` cho `UserProfile` có `CompanyMember.role = TECHNICIAN`, membership đang hoạt động và thuộc cùng Company. Survey phải ghi nhận kỹ thuật viên hoàn tất bằng `completed_by`. Kỹ thuật viên chỉ được thao tác Appointment/Survey được giao và không được sửa dữ liệu giá hoặc tài chính.

**AI tuyệt đối không được tự nghĩ ra giá.**

## 6. Sale duy nhất

Trong phạm vi triển khai hiện tại, hệ thống có 1 Company và Company đó có đúng 1 SALE hoạt động. Về kiến trúc, **mỗi Company được phép có tối đa 1 `CompanyMember` đang hoạt động với `role = SALE`**.

Không có Sale A/Sale B/Sale C, không có cơ chế chia khách và không tự động phân phối lead cho nhiều sale. Vì dự án hiện tại chỉ có một Company nên toàn hệ thống hiện tại vẫn có đúng 1 sale duy nhất.

Khách được chuyển cho sale khi:

- Đã có giá.
- Có ý định mua.
- Muốn thương lượng.
- Hỏi giảm giá.
- Muốn ký hợp đồng.
- Phản hồi chiến dịch chăm sóc.

Sale tập trung vào tư vấn, thương lượng và chốt. Các quy trình tự động không được tạo nhiều người phụ trách sale hoặc phân khách cho tài khoản sale khác trong cùng Company.

## 7. Quy tắc 5 phút

Luồng xử lý khi khách phản hồi:

1. Khách nhắn.
2. Hệ thống thông báo cho sale và bắt đầu chờ 5 phút.
3. Nếu sale trả lời trong thời gian chờ, AI không trả lời nữa.
4. Nếu sau 5 phút sale chưa trả lời, AI được phép hỗ trợ trả lời theo phong cách sale trong phạm vi được phép.
5. Khi sale đang xử lý, AI không được chen vào.

Hệ thống phải kiểm tra trạng thái hội thoại ngay trước khi AI gửi để tránh gửi đồng thời với sale. Việc AI quyết định gửi hoặc không gửi phải có nhật ký kiểm tra.

## 8. AI học phong cách sale

AI được đọc tin nhắn và nội dung cuộc gọi của sale để học:

- Cách xưng hô.
- Độ dài câu.
- Cách hỏi.
- Cách xử lý phản đối.
- Cách giải thích.
- Cách chốt.

AI không được:

- Tự giảm giá.
- Tự thay đổi điều khoản.
- Tự cam kết thay doanh nghiệp.
- Tự bịa thông tin kỹ thuật.
- Tự quyết định thay sale.

Hồ sơ phong cách phải có phiên bản, ví dụ nguồn đã được duyệt và có thể kiểm tra lại. Phong cách chỉ ảnh hưởng cách diễn đạt, không được vượt qua chính sách giá, quyền hạn hoặc dữ liệu thực tế.

## 9. Tiền cọc

Khách chuyển tiền trực tiếp vào tài khoản công ty. Luồng chuẩn:

1. Khách đồng ý đặt hàng, hệ thống tạo `Order`.
2. Hệ thống cấp `order_code` ổn định và `payment_reference` duy nhất trong Company.
3. Hệ thống tạo yêu cầu hoặc QR thanh toán; không dùng raw phone làm mã thanh toán.
4. Khách chuyển khoản.
5. Ngân hàng hoặc dịch vụ thanh toán gửi webhook/sự kiện.
6. Hệ thống tìm Order theo `payment_reference` hoặc `order_code`, rồi kiểm tra số tiền và nội dung chuyển khoản.
7. Nếu khớp đủ chắc chắn, hệ thống tự chuyển trạng thái thành **ĐÃ CỌC**.
8. Nếu không chắc chắn, giao dịch vào danh sách cần người có quyền kiểm tra.

Không để sale tự bấm xác nhận cọc bằng tay trong luồng chuẩn. Sự kiện thanh toán phải chống ghi trùng bằng `provider_ref`; giao dịch và Order được đối chiếu phải thuộc cùng Company; mọi quyết định đối chiếu và điều chỉnh phải có dấu vết kiểm tra.

## 10. Hợp đồng

- Sau khi xác nhận cọc, hệ thống tạo hợp đồng tự động từ mẫu có phiên bản.
- Sau khi khách ký, sale tải hoặc scan hợp đồng đã ký lên hệ thống.
- Chỉ khi có `signed_file_ref` hợp lệ và trạng thái hợp đồng phù hợp mới được tạo lệnh xuống xưởng.

Tệp đã ký phải được bảo vệ quyền truy cập, không được thay thế âm thầm và phải truy ngược được người tải lên cùng thời điểm tải.

## 11. Xưởng và bàn giao

Luồng nghiệp vụ bắt buộc:

`Hợp đồng đã ký → ProductionOrder → Sản xuất → Lắp đặt → Bàn giao/nghiệm thu → Đơn hoàn thành`

Mỗi bước phải có trạng thái rõ ràng. Không được bỏ qua điều kiện hợp đồng đã ký trước khi tạo `ProductionOrder`.

### Bảo hành và hậu mãi

Luồng hậu mãi:

`Hoàn thành lắp đặt/bàn giao → phát sinh yêu cầu → tạo WarrantyTicket → giao kỹ thuật/người phụ trách → xử lý → hoàn tất → giữ lịch sử`

WarrantyTicket phải liên kết được với Customer và Order; nếu liên quan lần lắp đặt cụ thể thì liên kết Installation. Luồng bảo hành không được tự thay giá, sửa hợp đồng, sửa giao dịch hoặc sửa doanh thu.

## 12. Tài chính

Hệ thống phải phân biệt rõ:

- **Giá trị hợp đồng (`contract_value`):** tổng giá trị đã thỏa thuận trong hợp đồng.
- **Tiền đã thu (`collected_amount`):** tổng tiền thực tế đã nhận và xác nhận.
- **Công nợ (`receivable_amount`):** số tiền khách còn phải thanh toán.
- **Doanh thu hoàn thành (`completed_revenue`):** doanh thu chỉ được ghi nhận theo điều kiện hoàn thành do doanh nghiệp quy định.

Không coi tiền cọc và doanh thu là cùng một khái niệm. Các số tổng hợp phải truy ngược được giao dịch và đơn hàng nguồn.

## 13. Chăm sóc khách hàng

Khách chưa mua và khách cũ vẫn có thể được chăm sóc qua:

- Zalo OA.
- Facebook Messenger.

Hệ thống có thể gửi định kỳ mỗi 1 tháng. Phải dừng khi khách yêu cầu ngừng hoặc doanh nghiệp tắt chăm sóc. Trạng thái dừng và lý do dừng phải được lưu; không tự bật lại lịch đã dừng nếu chưa có quyết định hợp lệ.

Mỗi lượt gửi tới từng Customer phải được truy vết riêng bằng `CareDelivery`. Các số liệu đã gửi, đã giao, đã phản hồi và đã chuyển sale của chiến dịch phải được tổng hợp lại từ những lượt gửi này, không được để từng module tự cộng tùy tiện.

## 14. Phân quyền tài khoản

Có tối thiểu ba vai trò: **SẾP / QUẢN TRỊ (`BOSS_ADMIN`)**, **SALE** và **KỸ THUẬT VIÊN (`TECHNICIAN`)**. Không tự thêm role khác khi nghiệp vụ chưa yêu cầu.

### SẾP / QUẢN TRỊ

Được phép:

- Xem số điện thoại thật.
- Xem dữ liệu khách đầy đủ.
- Xem thanh toán.
- Xem doanh thu và báo cáo.
- Quản lý cấu hình quan trọng.
- Gọi khách qua Click-to-Call bảo mật.
- Xem verbatim transcript qua Trusted Server, với MFA/AAL2 theo chính sách privileged access và audit bắt buộc.

### SALE

- Không được nhận số điện thoại thật.
- Không được xuất danh sách số điện thoại.
- Không được xem giao dịch ngân hàng tổng.
- Không được xem tài chính tổng.
- Được xem tên khách và `customer_code`.
- Được xem lịch sử khách cần thiết cho việc chốt.
- Được chat với khách.
- Được gọi khách qua hệ thống.
- Không được xem trực tiếp verbatim transcript hoặc bản ghi âm gốc, kể cả cuộc gọi do chính SALE thực hiện.

`can_view_finance = false` của SALE có nghĩa là không được xem tài chính quản trị/tổng toàn Company, không phải cấm mọi thông tin tiền. Trong phạm vi khách/đơn cần xử lý, SALE được xem:

- Giá đã tính và giá đã báo.
- `Order.final_amount` và `deposit_status`.
- Số tiền khách cần thanh toán.
- Thông tin thương mại cần thiết để tư vấn và chốt.

SALE không được xem toàn bộ `PaymentTransaction`, lịch sử giao dịch ngân hàng tổng, `FinanceSummary` toàn Company, báo cáo tài chính quản trị, tổng doanh thu hoặc dữ liệu ngân hàng không liên quan trực tiếp đến nhiệm vụ chốt khách.

### KỸ THUẬT VIÊN

Được phép trong phạm vi công việc được giao:

- Nhận và xem lịch khảo sát.
- Xem thông tin cần thiết để đến khảo sát, gồm địa chỉ khảo sát.
- Nhập kết quả, số đo và ảnh khảo sát.
- Cập nhật trạng thái công việc được giao.

KỸ THUẬT VIÊN không được:

- Xem raw phone nếu chưa có quy trình nghiệp vụ riêng được duyệt.
- Xuất danh sách khách hoặc xem dữ liệu khách ngoài công việc được giao.
- Xem tài chính tổng, `PaymentTransaction` tổng hoặc báo cáo doanh thu.
- Quản lý `PricingPolicy`, tự sửa giá hoặc tự xác nhận tiền cọc.
- Tự sửa hợp đồng.
- Tự gọi khách hoặc nhận raw phone để liên hệ.

Mặc định TECHNICIAN có `can_view_raw_phone = false`, `can_export_contacts = false`, `can_view_finance = false`, `can_manage_pricing = false`, `can_call_customer = false`. Nếu sau này kỹ thuật viên cần liên hệ khách, phải dùng quy trình riêng được duyệt và không mặc định cho xem số thật.

Không được chỉ che số bằng giao diện. Máy chủ, API và cơ sở dữ liệu phải bảo đảm tài khoản SALE và TECHNICIAN không nhận `raw phone`, kể cả trong JSON, log, lỗi, dữ liệu tải trước, export hoặc kết quả truy vấn. Khi triển khai Supabase, quyền này phải được bảo vệ bằng thiết kế bảng/view/function phù hợp và RLS, không dựa riêng vào frontend.

## 15. Click-to-Call bảo mật

`BOSS_ADMIN` và `SALE` được gọi khách; `TECHNICIAN` bị từ chối. Người gọi tìm khách bằng tên hoặc `customer_code`, ví dụ:

- `Nguyễn Văn A`
- `KH-000123`

Khi người có quyền bấm **GỌI KHÁCH**, trình duyệt chỉ gửi `customer_id` (hoặc `interaction_id` khi luồng nghiệp vụ cần). Máy chủ tự derive Company từ tài nguyên trong DB, xác thực user/profile/membership/role/scope, tìm số điện thoại thật trong vùng được bảo vệ, ghi Call và audit bắt buộc, rồi chuyển trực tiếp cho hệ thống Hotline/tổng đài.

Số điện thoại thật không được trả về trình duyệt. API không được tin `company_id`, phone, storage path hoặc provider credential do client gửi và không đưa số thật vào URL, response, log hoặc thông báo lỗi.

### 15.1. Verbatim transcript và AI Worker

- AI chép lại nguyên văn nội dung đã nói; được thêm dấu câu, xuống dòng, timestamp và speaker labels nhưng không tóm tắt, paraphrase, tự che PII, bỏ câu, sửa ý hoặc tạo thêm lời nói.
- Verbatim transcript là dữ liệu nhạy cảm: `BOSS_ADMIN` được xem qua Trusted Server có MFA/AAL2 và audit bắt buộc; `SALE` và `TECHNICIAN` bị cấm.
- `public.interactions.sanitized_content` không phải nơi lưu hoặc phát hành verbatim call transcript. CRM extracted data là sản phẩm nghiệp vụ khác và chưa được triển khai trong Foundation Finalization.
- AI Worker là machine identity server-side, không giả làm `BOSS_ADMIN`, `SALE` hay `TECHNICIAN`; Service Role không tự tạo authorization. Worker chỉ được đọc recording/job được giao và ghi kết quả trong phạm vi tài nguyên đã được ràng buộc.
- Cơ chế machine credential/job identity cụ thể được hoãn sang module AI/background processing; user session không được biến thành worker chỉ bằng cách truyền một `purpose` enum.

## 16. Kiến trúc thư mục dự kiến

```text
app/
  (auth)/
  (dashboard)/
  api/

features/
  crm/
  inbox/
  omnichannel/
    zalo/
    facebook/
    website/
  care/
    zalo/
    facebook/
  voice/
  survey/
  pricing/
  payment/
  contract/
  order/
  production/
  installation/
  warranty/
  ai-analysis/
  sales-style/
  automation/
  analytics/

shared/
  components/
  contracts/
  constants/
  utils/

lib/
  auth/
  supabase/
  integrations/

supabase/
  migrations/

docs/

tests/
  e2e/
```

Nguyên tắc tổ chức:

- `app/` chỉ tổ chức route, layout và API của Next.js App Router. `(auth)` và `(dashboard)` là route group, không xuất hiện trong URL.
- `features/` chứa code theo từng miền nghiệp vụ và do thành viên phụ trách miền đó sở hữu.
- `shared/` chỉ chứa thành phần, contract, hằng số và tiện ích thật sự dùng chung, không đặt logic đặc thù của một feature vào đây.
- `lib/` chứa hạ tầng và adapter dùng chung như xác thực, Supabase và tích hợp ngoài.
- `supabase/migrations/` chứa migration bất biến, có thứ tự; không sửa migration đã áp dụng trên môi trường dùng chung.
- `tests/e2e/` chứa kiểm thử luồng xuyên hệ thống.
- Ở giai đoạn nền hiện tại chỉ tạo khung thư mục, chưa tạo code nghiệp vụ giả cho các feature.

## 17. Vùng sở hữu của 9 thành viên

| Thành viên | Vùng sở hữu | Nhánh |
| --- | --- | --- |
| 1 | Nền tảng, đăng nhập, phân quyền, Supabase, RLS, `shared`, tài liệu kiến trúc | `feature/foundation-auth` |
| 2 | CRM, Customer 360, Hộp thư tích hợp, hành trình khách | `feature/crm-customer360` |
| 3 | Zalo OA, chăm sóc Zalo | `feature/zalo-care` |
| 4 | Facebook Messenger, Website | `feature/facebook-website` |
| 5 | Hotline, AI Voice, cuộc gọi sale, ghi âm, transcript | `feature/voice-hotline` |
| 6 | Lịch khảo sát, kỹ thuật nhập số đo | `feature/survey` |
| 7 | Bảng giá, thanh toán, hợp đồng, đơn hàng, tài chính bán hàng | `feature/pricing-payment-contract` |
| 8 | Sản xuất, lắp đặt, bàn giao, bảo hành | `feature/operations-after-sales` |
| 9 | AI phân tích, học phong cách sale, tự động hóa 5 phút, thống kê, kiểm thử toàn hệ thống | `feature/ai-style-analytics` |

## 18. Quy tắc vùng code

Mỗi thành viên được tự do sửa vùng mình sở hữu. Không tự ý sửa:

- Vùng của thành viên khác.
- Dữ liệu dùng chung.
- Phân quyền.
- Cấu hình nền.
- Middleware.
- Các tệp hạ tầng chung.

Nếu cần sửa vùng dùng chung, Pull Request phải giải thích:

- Sửa tệp nào.
- Vì sao cần sửa.
- Ảnh hưởng thành viên nào.
- Thay đổi có phá tương thích hay không; nếu có, kế hoạch chuyển đổi là gì.

Contract dùng chung phải ưu tiên tương thích ngược. Không đổi tên hoặc xóa trường đang được dùng nếu chưa thống nhất với các thành viên bị ảnh hưởng.

## 19. Quy tắc Git

Không ai được code trực tiếp trên `main`.

Quy trình làm việc:

`main → tạo branch riêng → code → test → cập nhật main vào branch → tạo Pull Request → kiểm tra → merge`

Quy tắc bắt buộc:

- Không push trực tiếp lên `main`.
- Mỗi Pull Request nên tập trung vào một phạm vi rõ ràng.
- Phải chạy các kiểm tra phù hợp trước khi đề nghị review.
- Không commit khóa bí mật, `.env.local`, dữ liệu khách thật, bản ghi cuộc gọi thật hoặc tệp build.
- Thay đổi schema, contract chung hoặc quyền truy cập cần được thành viên sở hữu nền tảng xem xét.

## 20. Company và quyền truy cập theo doanh nghiệp

`Company` là doanh nghiệp sử dụng hệ thống và là gốc cô lập dữ liệu. Mọi dữ liệu nghiệp vụ phải thuộc một Company trực tiếp hoặc gián tiếp; không được đọc chéo dữ liệu giữa các Company.

Người dùng truy cập Company theo quan hệ:

`UserProfile → CompanyMember → Company`

`CompanyMember` xác định role của người dùng trong Company. Chỉ tồn tại UserProfile không tạo ra quyền truy cập; membership phải đang hoạt động và mọi kiểm tra quyền phải áp dụng đúng ngữ cảnh Company.

Đây là nguyên tắc nghiệp vụ/kiến trúc tổng, không phải thiết kế bảng, foreign key hoặc RLS SQL.

## 21. Audit thao tác nhạy cảm

Các thao tác nhạy cảm và quản trị quan trọng phải có audit phù hợp, gồm:

- Thay role hoặc membership.
- Xem/thao tác dữ liệu nhạy cảm.
- Gọi khách.
- Xuất dữ liệu.
- Quản lý bảng giá.
- Xử lý ngoại lệ thanh toán.
- Thay đổi quan trọng trong quy trình đơn hàng.

Audit không được lưu raw phone, mật khẩu, token, secret hoặc toàn bộ payload nhạy cảm không cần thiết. Nhật ký phải tối thiểu hóa dữ liệu cá nhân, giữ đủ bằng chứng truy vết và không cho người dùng bình thường tự sửa/xóa.

## 22. Quan hệ giữa tài liệu kiến trúc và dữ liệu

- `PROJECT_MASTER.md` là luật nghiệp vụ và kiến trúc tổng của dự án.
- `DATA_CONTRACT.md` là quy ước dữ liệu dùng chung giữa các phân hệ.
- Hai tài liệu phải nhất quán. Nếu thay đổi nghiệp vụ làm thay đổi contract dữ liệu, phải cập nhật và review cả hai trước khi viết code.

`DATA_CONTRACT.md` chưa phải schema Supabase, migration, RLS, index, foreign key cuối cùng hoặc enum cuối cùng. Chỉ sau khi contract được duyệt mới chuyển sang thiết kế Supabase thật.
