# AI Customer Analysis Core (Milestone M9.3)

## 1. Mục tiêu
Hệ thống **AI Customer Analysis Core** phân tích hành trình khách hàng dựa trên bằng chứng thực tế từ các tương tác hội thoại đã được làm sạch (sanitized interactions). Kết quả phân tích giúp duy nhất 1 nhân viên SALE và ban lãnh đạo (BOSS_ADMIN) nhanh chóng nắm bắt nhu cầu, lý do ngập ngừng, các phản đối và gợi ý hành động tiếp theo mà không làm lộ thông tin nhạy cảm hoặc can thiệp sai lệch vào quy trình nghiệp vụ.

---

## 2. Nguồn dữ liệu được phép và Dữ liệu bị cấm

### Nguồn dữ liệu được phép (Strict MESSAGE Eligibility)
Trong Milestone M9.3, AI Analysis chỉ được phép tiêu thụ dữ liệu phái sinh an toàn từ:
* `public.interactions` với điều kiện nghiêm ngặt:
  * `company_id = target_company_id` (cùng doanh nghiệp).
  * `customer_id = target_customer_id` (cùng khách hàng).
  * `type = 'MESSAGE'` (chỉ sử dụng tương tác dạng tin nhắn; cấm `CALL_EVENT`, `NOTE`, `STATUS_EVENT`).
  * `sanitization_status = 'SUCCEEDED'` (đã làm sạch thành công).
  * `sanitized_content IS NOT NULL` (nội dung đã làm sạch không rỗng).
* Thông tin ngữ cảnh khách hàng an toàn từ `public.customers`:
  * `customer_id`, `customer_code`, `name`, `source`, `stage`.

### Dữ liệu bị cấm tuyệt đối
AI Worker và mô hình phân tích **tuyệt đối không được truy cập hay xử lý**:
* Số điện thoại thật (`raw_phone`, `normalized_phone`, `private.customer_private_contacts`).
* Dữ liệu tương tác thô (`private.interaction_raw_contents`).
* Bản ghi bóc băng cuộc gọi gốc (`private.call_transcripts`).
* Tệp ghi âm cuộc gọi (`call-recordings` bucket, `recording_ref`).
* Dữ liệu thanh toán thô, số tài khoản ngân hàng, webhook payloads (`payment_transactions`).
* Provider secrets, API credentials, internal system tokens.

---

## 3. Kiến trúc Bounded Worker RPC & Table ACL

Để tuân thủ nguyên tắc Least Privilege và cô lập tenant, `public.ai_analyses` áp dụng mô hình **RPC-only persistence**:

```text
service_role worker
       ↓
get_ai_analysis_input RPC  ──>  Đọc latest N sanitized MESSAGE interactions
       ↓
AI Model Execution & Strict Validator
       ↓
record_ai_analysis RPC    ──>  Kiểm tra tenant + source_refs + trusted provenance + append-only insert
       ↓
public.ai_analyses
```

### Table ACL (Migration 006)
* `REVOKE ALL ON TABLE public.ai_analyses FROM service_role;`
* `REVOKE INSERT, UPDATE, DELETE ON TABLE public.ai_analyses FROM PUBLIC, anon, authenticated;`
* `service_role` bị thu hồi toàn bộ quyền direct table (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) trên `ai_analyses`.
* Mọi hành vi ghi bắt buộc phải thông qua RPC `public.record_ai_analysis` (`SECURITY DEFINER` với `SET search_path = ''`).

### RPC 1: `public.get_ai_analysis_input`
* **Quyền:** Chỉ `service_role` được EXECUTE.
* **Tham số:** `p_company_id uuid`, `p_customer_id uuid`, `p_limit integer DEFAULT 50` (giới hạn 1..100).
* **Kiểm tra an toàn & Thuật toán chọn:**
  * Xác thực Customer tồn tại và thuộc đúng `company_id` (fail closed với `TENANT_MISMATCH` 42501 hoặc `CUSTOMER_NOT_FOUND` P0002).
  * **Latest-N Selection:** Chọn N tương tác mới nhất trước (`ORDER BY created_at DESC, id DESC LIMIT v_limit`), sau đó sắp xếp lại theo trình tự thời gian tăng dần (`ORDER BY created_at ASC, id ASC`) để model nhận đúng dòng chảy hội thoại.
  * Chỉ chiếu các cột đã làm sạch, không join bảng private hay phone.

### RPC 2: `public.record_ai_analysis`
* **Quyền:** Chỉ `service_role` được EXECUTE.
* **Tham số:** `p_company_id`, `p_customer_id`, `p_source_refs`, `p_summary`, `p_stage_suggestion`, `p_stop_reason`, `p_objections`, `p_next_action`, `p_confidence`, `p_evidence`, `p_model_version`.
* **Kiểm tra an toàn & DB-Side Validation:**
  * Validate Customer thuộc đúng Company.
  * Validate `confidence` thuộc khoảng `0.00 <= confidence <= 1.00`.
  * Validate `summary`: chuỗi không rỗng, độ dài $\le 2000$ ký tự.
  * Validate `evidence`: chuỗi không rỗng, độ dài $\le 5000$ ký tự.
  * Validate `model_version`: chuỗi không rỗng, độ dài $\le 100$ ký tự (trusted provenance).
  * Validate `stop_reason` và `next_action`: `NULL` hoặc $\le 1000$ ký tự.
  * Validate `objections`: JSON array, tối đa 20 phần tử, mỗi phần tử là chuỗi không rỗng $\le 500$ ký tự.
  * Validate `stage_suggestion` phải nằm trong allowlist 22 canonical stages (hoặc `NULL`).
  * Validate cấu trúc `source_refs`: mảng JSON chứa các phần tử `{ "type": "INTERACTION", "id": "<uuid>" }`.
  * Xác thực từng ID trong `source_refs`:
    * Tồn tại trong `public.interactions`.
    * Cùng Company và Customer.
    * `type = 'MESSAGE'` (cấm các loại khác).
    * `sanitization_status = 'SUCCEEDED'`.
    * `sanitized_content IS NOT NULL`.
  * Cấm chứa các trường nhạy cảm trong `source_refs` (như `content`, `phone`, `transcript`).
  * Thực hiện ghi `INSERT` (append-only).
  * **TUYỆT ĐỐI KHÔNG SỬA `customers.stage`** và **KHÔNG TẠO `customer_stage_histories`**.

---

## 4. Ranh giới Model, Trusted Provenance & Quy tắc Prompt

### Trusted Model Provenance
Model version không do LLM tự khai hay tự sinh. Architecture quy định:
```ts
export interface AiAnalysisModel {
  readonly modelVersion: string;
  analyze(input: AiAnalysisInput): Promise<unknown>;
}
```
* Đầu ra của model (`AiCustomerAnalysisOutput`) hoàn toàn **không** chứa `modelVersion`.
* Pipeline tự động liên kết `model.modelVersion` từ runtime môi trường máy chủ tin cậy và truyền vào `record_ai_analysis` RPC. Bất kỳ giá trị `modelVersion` nào do LLM cố tình trả về đều bị loại bỏ.

### Server-Only Boundary
Tất cả các module truy cập database trực tiếp bằng `service_role` (như `ai-analysis-store.ts`) đều được bảo vệ bằng:
```ts
import 'server-only';
```
đảm bảo mã và private RPC callers không bao giờ bị đưa vào client bundle.

### Quy tắc an toàn Prompt (System Instructions)
1. **Chỉ phân tích bằng chứng:** Phân tích hoàn toàn dựa trên các tương tác được cung cấp.
2. **Nghiêm cấm bịa đặt (Zero Hallucination):**
   * Không tự bịa giá, kích thước cửa, thông số kỹ thuật hay nhu cầu.
   * Không tự ý giảm giá, thương lượng hay thay đổi điều khoản.
   * Không tự xác nhận tiền cọc hoặc hợp đồng.
   * Không cam kết thay cho doanh nghiệp.
3. **Khi thiếu bằng chứng:**
   * Gán `confidence` thấp (0.10 - 0.40).
   * Đặt `stageSuggestion = 'NEED_INFO'` hoặc `null`.
   * Đặt `nextAction` yêu cầu khảo sát hoặc bổ sung thông tin từ khách.

---

## 5. Bất biến Nghiệp vụ: Stage Suggestion vs Stage Mutation

* **Bất biến cốt lõi:**
  $$\text{stage\_suggestion} \neq \text{stage mutation}$$
* Kết quả phân tích của AI chỉ đóng vai trò là bản ghi nhận định và gợi ý (informational evidence).
* Pipeline phân tích **không bao giờ** cập nhật cột `public.customers.stage`.
* Pipeline phân tích **không bao giờ** ghi nhận bản ghi chuyển giai đoạn vào `public.customer_stage_histories`.

---

## 6. Phân quyền hiển thị (Row Level Security)

Bảng `public.ai_analyses` được bảo vệ bởi RLS:
* **`BOSS_ADMIN`**: Được quyền `SELECT` các bản ghi phân tích thuộc Company của mình.
* **`SALE`**: Được quyền `SELECT` các bản ghi phân tích thuộc Company của mình để phục vụ tư vấn và chốt đơn.
* **`TECHNICIAN`**: Có 0 SELECT policy $\rightarrow$ Hoàn toàn bị cấm xem phân tích AI.
* **`service_role` Direct Query**: Đã bị thu hồi toàn bộ quyền trực tiếp trên bảng.
