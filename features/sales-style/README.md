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

- **RPC-Only Table:** Toàn bộ quyền `INSERT`, `UPDATE`, `DELETE` đối với bảng `public.sales_style_profiles` bị thu hồi từ `service_role`, `authenticated`, `anon`, và `PUBLIC`. Mọi thao tác ghi phải thông qua các RPC chạy dưới quyền `SECURITY DEFINER` (`record_sales_style_profile`, `activate_sales_style_profile`).
- **Chính sách đọc RLS (`SELECT`):**
  - `BOSS_ADMIN`: Được xem toàn bộ style profile của các Sale trong cùng Company.
  - `SALE`: Chỉ được xem style profile của chính bản thân (`sale_user_id = auth.uid()`).
  - `TECHNICIAN`: Hoàn toàn không có quyền xem (`0 rows`).
- **Ghi nhật ký kiểm toán (Mandatory Audit Logging):**
  - Mọi thao tác tạo profile thành công đều ghi vào `public.audit_logs` với action `SALES_STYLE_PROFILE_GENERATED`.
  - Mọi thao tác kích hoạt profile thành công đều ghi vào `public.audit_logs` với action `SALES_STYLE_PROFILE_ACTIVATED`.
  - Mọi thao tác hạ cấp profile ACTIVE cũ đều ghi với action `SALES_STYLE_PROFILE_SUPERSEDED`.
  - Nếu ghi nhật ký kiểm toán thất bại, giao dịch DB lập tức rollback toàn bộ.

---

## 7. Quy trình Duyệt & Kích hoạt hồ sơ (M9.4B: Approval & Activation)

### 7.1 Vòng đời trạng thái 3 giai đoạn (Lifecycle State Machine)

```text
DRAFT
  ↓ BOSS_ADMIN approval (RPC activate_sales_style_profile)
ACTIVE
  ↓ newer approved profile for the same Sale
SUPERSEDED
```

- **`DRAFT`**: Profile vừa được sinh bởi pipeline M9.4A. Chưa có hiệu lực runtime.
  - `generation_status = 'DRAFT'`
  - `activated_at IS NULL`, `activated_by_user_id IS NULL`
  - `superseded_at IS NULL`, `superseded_by_profile_id IS NULL`
- **`ACTIVE`**: Profile chính thức được BOSS_ADMIN duyệt cho Sale. Duy nhất tối đa 1 profile ACTIVE / Sale.
  - `generation_status = 'ACTIVE'`
  - `activated_at IS NOT NULL`, `activated_by_user_id IS NOT NULL`
  - `superseded_at IS NULL`, `superseded_by_profile_id IS NULL`
- **`SUPERSEDED`**: Profile ACTIVE cũ bị thay thế bởi profile ACTIVE mới hơn của cùng Sale. Lịch sử bất biến.
  - `generation_status = 'SUPERSEDED'`
  - `activated_at IS NOT NULL`, `activated_by_user_id IS NOT NULL`
  - `superseded_at IS NOT NULL`, `superseded_by_profile_id IS NOT NULL`

Ràng buộc toàn vẹn cơ sở dữ liệu `chk_sales_style_profile_lifecycle` từ chối fail-closed mọi bản ghi vi phạm trạng thái kết hợp trên.

### 7.2 Hard Invariants: Tối đa 1 ACTIVE profile per Sale & Tính toàn vẹn Lineage (Lineage Integrity)

Một partial unique index được thiết lập trực tiếp tại tầng cơ sở dữ liệu:
```sql
CREATE UNIQUE INDEX uq_sales_style_profiles_active_sale
  ON public.sales_style_profiles (company_id, sale_user_id)
  WHERE generation_status = 'ACTIVE';
```
Đây là safety net vật lý độc lập với mã nguồn ứng dụng, ngăn chặn triệt để tình trạng hai profile ACTIVE cùng tồn tại cho một Sale.

Đồng thời, cấu trúc kế thừa lineage (`superseded_by_profile_id`) được bảo vệ bằng các ràng buộc khóa ngoại phức hợp (composite foreign key) và kiểm tra phản xạ:
- `UNIQUE (company_id, sale_user_id, id)`
- `FOREIGN KEY (company_id, sale_user_id, superseded_by_profile_id) REFERENCES public.sales_style_profiles (company_id, sale_user_id, id) ON DELETE RESTRICT`: Ngăn chặn tuyệt đối việc liên kết lineage xuyên công ty (cross-company) hoặc xuyên nhân viên Sale (cross-sale).
- `CHECK (superseded_by_profile_id IS NULL OR superseded_by_profile_id <> id)`: Ngăn chặn tuyệt đối một profile tự kế thừa/thay thế chính mình (anti-reflexive self-supersede).

### 7.3 Tái thẩm định Provenance và An toàn khi Kích hoạt (Provenance Revalidation & Safety Firewall)

> [!IMPORTANT]
> ### `ACTIVE => PROFILE ĐÃ QUA TOÀN BỘ PROVENANCE & SAFETY INVARIANTS`
> Không tin tưởng một profile chỉ vì row đó đang mang trạng thái `DRAFT`. Trước khi chuyển trạng thái `DRAFT → ACTIVE`, RPC `activate_sales_style_profile` thực hiện quy trình kiểm tra phòng thủ đa tầng (defense-in-depth):
> 1. **Kiểm tra `model_version`:** Bắt buộc `IS NOT NULL`, sau khi trim không được rỗng, độ dài `<= 100`. Lỗi: `PROFILE_PROVENANCE_INVALID`.
> 2. **Kiểm tra `source_refs`:** Phải là JSONB array từ 1 đến 200 items, không trùng lặp UUID, đúng shape `INTERACTION` và không chứa bất kỳ trường nhạy cảm nào (`content`, `phone`, `transcript`, ...). Lỗi: `PROFILE_PROVENANCE_INVALID`.
> 3. **Tái thẩm định từng tương tác nguồn:** Truy vấn trực tiếp bảng `public.interactions` đảm bảo cùng `company_id`, `actor_type = 'SALE'`, `actor_user_id = target_sale_user_id`, `direction = 'OUTBOUND'`, `type = 'MESSAGE'`, `sanitization_status = 'SUCCEEDED'`, và `sanitized_content` không rỗng. Lỗi: `PROFILE_SOURCE_INVALID`.
> 4. **Tường lửa chính sách kinh doanh (Business-Policy Firewall):** Quét lại toàn bộ các đối tượng style (`salutation_rules`, `sentence_style`, `question_style`, `objection_style`, `closing_style`) qua biểu thức chính quy DB. Nếu phát hiện vi phạm chính sách giá, chiết khấu %, tiền cọc, cam kết hợp đồng thì lập tức từ chối kích hoạt. Lỗi: `PROFILE_STYLE_POLICY_UNSAFE`.
> 5. **Quy tắc an toàn cho `examples` (Legacy/Untrusted DRAFT Protection):** Cột `examples` được chấp nhận là mảng rỗng `[]` hoặc mảng tối đa 5 phần tử chỉ chứa đúng 3 khóa metadata: `interaction_id`, `channel`, `created_at`. Tuyệt đối cấm các trường nhạy cảm (`content`, `sanitized_content`, `message_text`, `phone`, `transcript`, `recording`, `raw_payload`, `token`) hoặc các trường tùy ý khác. Lỗi: `PROFILE_EXAMPLES_UNSAFE`.

### 7.4 Quyền kích hoạt là Thao tác Đặc quyền Con người (Human Privileged Action)

- **`activation is a human privileged action`**: Kích hoạt profile phải được thực hiện bởi người dùng thật có vai trò `BOSS_ADMIN` cùng công ty thông qua phiên đăng nhập được xác thực (`auth.uid()`).
- **`service_role cannot approve/activate profiles`**: Quyền `EXECUTE` hàm `activate_sales_style_profile` bị thu hồi khỏi `service_role`, `anon`, và `PUBLIC`. Service role không được phép giả danh lãnh đạo để duyệt profile.
- **Chuỗi xác thực chuẩn tắc (Canonical Human Authorization Chain):**
  `authenticated session → auth.uid() → active user_profile → active company membership → same Company as target profile → role BOSS_ADMIN → valid resource state → atomic mutation → mandatory audit`.
- **Tái kiểm tra Sale tại thời điểm duyệt (Target Sale Revalidation):** Tại thời điểm duyệt, hệ thống kiểm tra lại tài khoản Sale mục tiêu vẫn đang tồn tại, trạng thái `ACTIVE` và giữ vai trò `SALE`. Nếu Sale đã bị vô hiệu hóa hoặc chuyển role, việc kích hoạt bị từ chối fail-closed.
- **Cấm hồi sinh SUPERSEDED (No Historical Resurrection):** Profile đã `SUPERSEDED` không thể được kích hoạt trở lại. Nếu muốn sử dụng lại phong cách cũ, quy trình sinh phải tạo ra một bản `DRAFT` mới.

### 7.5 An toàn đồng thời (Concurrency Safety)

Để xử lý nguy cơ race condition khi hai quản trị viên cùng kích hoạt hai bản `DRAFT` khác nhau của cùng một nhân viên Sale:
- RPC kích hoạt khóa dòng thành viên của Sale (`public.company_members FOR UPDATE`) đóng vai trò mutex trên mỗi Sale.
- Tất cả các yêu cầu kích hoạt cho cùng một Sale được xếp hàng tuần tự hóa (serialized execution).
- Giao dịch khóa profile ACTIVE hiện hành (nếu có), chuyển nó sang `SUPERSEDED`, kích hoạt target thành `ACTIVE`, ghi nhật ký kiểm toán, và commit nguyên tử.
- Kết quả sau bất kỳ luồng chạy đồng thời nào: luôn có **chính xác 1 ACTIVE profile** và profile còn lại ở trạng thái `SUPERSEDED`.

### 7.6 Bounded Runtime Read RPC cho AI Worker

- Khi AI auto-reply runtime cần lấy phong cách giao tiếp của Sale, AI Worker (`service_role`) gọi bounded read RPC:
  ```sql
  public.get_active_sales_style_profile(p_company_id uuid, p_sale_user_id uuid)
  ```
- **Ranh giới an toàn tuyệt đối:**
  - Chỉ trả về tối đa 1 dòng profile `ACTIVE` của đúng Sale và đúng Công ty.
  - Loại bỏ hoàn toàn `source_refs` và `examples` để ngăn ngừa rò rỉ nội dung tin nhắn nhạy cảm vào runtime.
  - Không cho phép gọi trực tiếp qua PostgREST (`anon`/`authenticated` bị REVOKE `EXECUTE`).

---

## 8. Phạm vi chưa triển khai (Deferred Scope)

1. Học phong cách từ cuộc gọi âm thanh / voice call transcript (hoãn sang milestone có derivative approved).
2. Tích hợp AI tự động trả lời khách hàng sau cửa sổ 5 phút (Response SLA window).
3. Xây dựng giao diện Analytics / Dashboard quản lý phong cách Sale.
