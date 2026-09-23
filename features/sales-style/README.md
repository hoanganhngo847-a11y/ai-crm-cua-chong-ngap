# Sales Style Learning Core (M9.4A)

Module này chịu trách nhiệm trích xuất và quản lý hồ sơ phong cách giao tiếp (tone, diction, phrasing) của nhân viên SALE duy nhất trong doanh nghiệp từ các tin nhắn gửi đi đã được kiểm duyệt/làm sạch (sanitized outbound messages).

---

## 1. Tuyên ngôn cốt lõi (Core Principles)

> [!IMPORTANT]
> ### `STYLE PROFILE != BUSINESS POLICY`
> Hồ sơ phong cách chỉ điều khiển **cách diễn đạt**, nhịp điệu và ngữ điệu câu từ. Hồ sơ phong cách tuyệt đối **KHÔNG ĐƯỢC PHÉP** thay thế, học lén hay ghi đè các chính sách nghiệp vụ:
> - Giá sản phẩm, công thức tính giá, bảng giá công ty (`PricingPolicy`).
> - Tỷ lệ giảm giá hoặc chiết khấu thương mại.
> - Quyền hạn cam kết hợp đồng hoặc điều khoản bảo hành.
> - Trạng thái tiền cọc (`deposit_confirmed`) hoặc quy trình thanh toán.
> - Bịa đặt thông số kỹ thuật, kích thước cửa hoặc cam kết giao hàng khi chưa có chứng cứ khảo sát.

> [!CAUTION]
> ### `SANITIZED != BUSINESS-POLICY-SAFE`
> Một tin nhắn đã được làm sạch (sanitized outbound message) khử PII của khách hàng, nhưng **vẫn có thể chứa ngôn từ nghiệp vụ vi phạm** (ví dụ: *"Anh giảm 10%, khách cọc 5 triệu nhé"*).
> - Mô hình có thể dùng tin nhắn đó làm ngữ cảnh để học CÁCH XƯNG HÔ/DIỄN ĐẠT (form), nhưng tuyệt đối KHÔNG ĐƯỢC sinh ra các quy tắc nghiệp vụ (chính sách giảm 10% hay cọc 5 triệu).
> - Bộ lọc nội dung (Business-policy Content Firewall) hoạt động đúp cả ở TypeScript validator và tại tầng cơ sở dữ liệu (`record_sales_style_profile` RPC) để từ chối fail-closed bất kỳ hồ sơ nào chứa từ ngữ chính sách (tiền tệ, giảm giá, %, đặt cọc, thanh toán, hợp đồng, bảo hành, cam kết).

> [!WARNING]
> ### `DRAFT PROFILE != ACTIVE AI BEHAVIOR`
> Trong Milestone M9.4A, mọi hồ sơ phong cách được sinh ra đều ở trạng thái `DRAFT`.
> - Không có profile nào được tự động kích hoạt (`ACTIVE`).
> - Không dùng bất kỳ profile nào để tự động gửi tin nhắn cho khách hàng.
> - Mọi thao tác đều mang tính chất chuẩn bị dữ liệu và kiểm định provenance.

---

## 2. Tiêu chuẩn nguồn tương tác (Source Eligibility)

M9.4A áp dụng bộ lọc nguồn cực kỳ khắt khe tại tầng cơ sở dữ liệu (Bounded RPC `get_sales_style_learning_input`):

| Tiêu chí | Điều kiện bắt buộc | Rationale an toàn |
| :--- | :--- | :--- |
| **Bảng nguồn** | `public.interactions` | Không bao giờ đọc trực tiếp từ schema `private` |
| **Công ty** | `company_id = target_company_id` | Phân lập tenant tuyệt đối |
| **Loại tác nhân** | `actor_type = 'SALE'` | Chỉ học phong cách của nhân sự Sale |
| **Định danh Sale** | `actor_user_id = target_sale_user_id` | Đảm bảo không học lẫn lộn giữa các nhân viên |
| **Chiều gửi** | `direction = 'OUTBOUND'` | Chỉ học lời nói do chính Sale gửi ra cho khách |
| **Loại tương tác** | `type = 'MESSAGE'` | Chỉ học từ tin nhắn văn bản, loại bỏ ghi chú/cuộc gọi |
| **Trạng thái làm sạch** | `sanitization_status = 'SUCCEEDED'` | Đã qua pipeline khử PII/dữ liệu nhạy cảm |
| **Nội dung** | `sanitized_content IS NOT NULL` | Bỏ qua các sự kiện rỗng nội dung |

---

## 3. Ranh giới quyền riêng tư (Privacy Boundary)

Hệ thống tuân thủ nghiêm ngặt các rào cản riêng tư đã định nghĩa tại `docs/FOUNDATION_HANDOFF.md`:
- **Cấm đọc schema private:** Tuyệt đối không đọc `private.interaction_raw_contents`, `private.call_transcripts`, `private.customer_private_contacts`.
- **Cấm dữ liệu định danh khách hàng:** Bounded Read RPC không trả về số điện thoại (`phone`), tên khách hàng, mã khách hàng hay các trường riêng tư không cần thiết cho việc học phong cách ngôn ngữ.
- **Tạm hoãn Call Transcripts:** Việc học phong cách từ nội dung cuộc gọi (`private.call_transcripts`) được bảo lưu cho các milestone tương lai khi đã có pipeline derivative được duyệt. M9.4A chỉ học từ sanitized message.

---

## 4. Cấu trúc hồ sơ phong cách chuẩn (Canonical Profile Structure)

Hồ sơ `public.sales_style_profiles` bao gồm 5 nhóm thuộc tính chuẩn hóa:

1. **`salutationRules`**:
   - `selfReferences`: Cách Sale tự xưng hô (ví dụ: `['em', 'mình']`).
   - `customerReferences`: Cách Sale xưng hô với khách (ví dụ: `['anh', 'chị']`).
   - `commonOpenings`: Lời chào đầu câu phổ biến.
   - `notes`: Ghi chú về cách chào hỏi.
2. **`sentenceStyle`**:
   - `preferredLength`: Độ dài câu ưa thích (`'SHORT' | 'MEDIUM' | 'LONG' | 'MIXED'`).
   - `toneDescriptors`: Tính từ mô tả giọng điệu (ví dụ: `['nhiệt tình', 'ngắn gọn']`).
   - `emojiUsage`: Tần suất dùng biểu tượng cảm xúc (`'NONE' | 'LOW' | 'MEDIUM' | 'HIGH'`).
   - `punctuationPatterns`: Thói quen dùng dấu câu.
   - `notes`: Ghi chú về nhịp điệu.
3. **`questionStyle`**:
   - `commonPatterns`: Mẫu câu hỏi thường dùng.
   - `discoveryApproach`: Cách hỏi khai thác nhu cầu và độ ngập nước.
   - `followUpApproach`: Cách hỏi theo dõi tiến trình.
   - `notes`: Ghi chú câu hỏi.
4. **`objectionStyle`**:
   - `approaches`: Mảng các đối tượng `{ situation, responseApproach }` mô tả tình huống phản đối và cách tiếp cận (ví dụ: giải thích độ bền vật liệu Inox 304 khi khách chê đắt).
   - `notes`: Ghi chú xử lý từ chối.
5. **`closingStyle`**:
   - `commonClosings`: Cách chào kết thúc tin nhắn.
   - `callToActionPatterns`: Cách kêu gọi hành động (đặt lịch đo khảo sát).
   - `urgencyStyle`: Cách tạo tính cấp thiết (mùa mưa ngập sắp tới) mà không bịa khuyến mãi.
   - `notes`: Ghi chú chốt đơn.

---

## 5. Kiến trúc Provenance và Nguồn tin cậy (Trusted Provenance)

Mọi dữ liệu định danh, phiên bản và chứng cứ ví dụ **đều do Trusted Server / Database sinh ra**, loại trừ hoàn toàn việc tin tưởng đầu ra từ mô hình AI (LLM):

1. **Sinh phiên bản (`version`):**
   - Format do DB RPC sinh: `ssp_<uuid>`.
   - Đáp ứng ràng buộc `UNIQUE (company_id, version)` trên toàn công ty.
   - Không cho phép LLM tự đặt version.
2. **Phiên bản mô hình (`model_version`):**
   - Lấy trực tiếp từ runtime adapter / engine môi trường tin cậy (`model.modelVersion`).
   - LLM không được quyền tự xưng phiên bản.
3. **Trích xuất ví dụ (`examples`):**
   - **`examples store provenance metadata, not message bodies`**: Cột `examples` chỉ lưu trữ metadata nguồn kiểm chứng (`interaction_id`, `channel`, `created_at`), tuyệt đối KHÔNG lưu trữ nội dung tin nhắn (`content` hay `sanitized_content`).
   - Trích xuất tối đa 5 tham chiếu nguồn hợp lệ trực tiếp từ database (`LIMIT 5`).
   - Bất kỳ văn bản ví dụ nào do LLM tự bịa ra đều bị loại bỏ fail-closed.
4. **Tham chiếu nguồn (`source_refs`):**
   - Lưu trữ danh sách `[{ type: 'INTERACTION', id: uuid }]`.
   - Mọi `id` phải được kiểm tra tồn tại, cùng tenant, cùng sale_user_id, OUTBOUND, MESSAGE, và SUCCEEDED.

---

## 6. Phân quyền và Bảo mật (ACL & RLS)

- **RPC-Only Table:** Toàn bộ quyền `INSERT`, `UPDATE`, `DELETE` đối với bảng `public.sales_style_profiles` bị thu hồi từ `service_role`, `authenticated`, `anon`, và `PUBLIC`. Mọi thao tác ghi phải thông qua RPC `record_sales_style_profile` chạy dưới quyền `SECURITY DEFINER`.
- **Chính sách đọc RLS (`SELECT`):**
  - `BOSS_ADMIN`: Được xem toàn bộ style profile của các Sale trong cùng Company.
  - `SALE`: Chỉ được xem style profile của chính bản thân (`sale_user_id = auth.uid()`).
  - `TECHNICIAN`: Hoàn toàn không có quyền xem (`0 rows`).
- **Ghi nhật ký kiểm toán (Mandatory Audit Logging):**
  - Mọi thao tác tạo profile thành công đều ghi vào `public.audit_logs` với action `SALES_STYLE_PROFILE_GENERATED`.
  - Nếu ghi nhật ký kiểm toán thất bại, giao dịch DB lập tức rollback toàn bộ.

---

## 7. Phạm vi chưa triển khai trong M9.4A (Deferred Scope)

1. Học phong cách từ cuộc gọi âm thanh / voice call transcript (hoãn sang milestone có derivative approved).
2. Kích hoạt hồ sơ thành trạng thái `ACTIVE` cho sản xuất.
3. Sử dụng hồ sơ phong cách để AI tự động trả lời khách hàng sau cửa sổ 5 phút (SLA window).
4. Xây dựng giao diện Analytics / Dashboard quản lý phong cách Sale.
