# Foundation Handoff

> Tài liệu bắt buộc đọc trước khi bắt đầu code module. Foundation hiện cung cấp Auth runtime, tenant authorization, RLS baseline, trusted-server helpers, private RPC, sensitive Server Actions, storage contract và security tests. Migration 001–003 đã đóng băng.

## 1. Mô hình quyền

Ba role duy nhất:

| Khả năng chính | `BOSS_ADMIN` | `SALE` | `TECHNICIAN` |
| --- | :---: | :---: | :---: |
| CRM/customer safe data | ✅ | ✅ | Chỉ job hiện hành |
| Raw phone | ✅ Trusted Server + audit | ❌ | ❌ |
| Click-to-Call | ✅ | ✅ | ❌ |
| Verbatim transcript | ✅ Privileged + audit | ❌ | ❌ |
| Payment/finance tổng | ✅ | ❌ | ❌ |
| Pricing policy gốc | ✅ | ❌ | ❌ |
| Survey/installation | ✅ | Theo nghiệp vụ | Chỉ assignment hiện hành |

Quyền canonical luôn theo chuỗi:

`authenticated → user_profiles ACTIVE → company_members ACTIVE → same Company → allowed role → resource-specific condition`

Company của tài nguyên phải derive từ DB. Không tin `company_id`, role, ownership hay assignment do browser gửi.

## 2. Chọn đúng client và trust boundary

### Supabase browser client

Chỉ dùng cho dữ liệu `public` đã có RLS phù hợp, DTO không nhạy cảm và thao tác client được contract cho phép. UI role checks chỉ để cải thiện UX, không phải authorization.

### Server Action

Dùng cho business mutation/read cần session người dùng. Input phải là business identifier/selector tối thiểu và serializable. Mỗi action là một public POST entry point: tự authenticate, authorize, validate resource và trả DTO allowlist.

### Trusted Server bắt buộc

Dùng khi chạm Service Role, private schema/RPC, raw phone, Click-to-Call, verbatim transcript, recording, signed URL, payment, privileged mutation hoặc provider secret. `SUPABASE_SERVICE_ROLE_KEY` chỉ server-side, không có tiền tố `NEXT_PUBLIC_` và **không phải authorization**.

## 3. Raw phone và Click-to-Call

`raw_phone` và `normalized_phone` nằm tại `private.customer_private_contacts`. SALE/TECH không được nhận qua JSON, props, DOM, logs, analytics, errors hoặc export.

Luồng gọi:

`browser resource ID → minimal DB lookup → derive Company → auth/profile/membership/role/scope → resolve raw phone server-side → create durable Call → mandatory audit → PBX → safe { callId, status }`

Client không gửi phone, trusted `company_id`, provider credential hoặc provider correlation ID. Audit/provider failure phải fail closed; provider error phải được chuẩn hóa an toàn.

## 4. Interaction, transcript và AI Worker

`public.interactions` chỉ chứa safe metadata và sanitized derivative cho interaction thông thường. `private.interaction_raw_contents` lưu raw source 1:1 theo `interaction_id`. `PENDING`/`FAILED` không có content cho SALE; `NOT_REQUIRED` chỉ dành cho non-text SYSTEM event. Textual `CALL_EVENT` không được dùng để phát hành transcript.

Verbatim transcript chép đúng lời nói; AI chỉ được thêm dấu câu, xuống dòng, timestamp và speaker labels. Không tóm tắt, paraphrase, bỏ câu, tự che PII, sửa ý hoặc tạo nội dung. Nếu cuộc gọi có phone/địa chỉ/số tiền, transcript vẫn giữ nguyên.

- `BOSS_ADMIN`: xem qua Trusted Server, active same-company membership, MFA/AAL2 và audit bắt buộc.
- `SALE`: cấm, kể cả cuộc gọi do chính SALE thực hiện.
- `TECHNICIAN`: cấm.
- `sanitized_content`: không bao giờ chứa verbatim transcript.
- CRM extracted data là derivative khác; Foundation chưa triển khai.

AI Worker là machine identity server-side, không giả làm human role. Worker chỉ được đọc recording/job được giao, chạy STT/diarization, ghi transcript và cập nhật processing status trong bounded scope. Không mặc định được đọc raw phone, payment, contract, user/role, arbitrary tenant/customer hay mọi recording. Service Role không tự cấp quyền.

`Worker Identity Implementation = DEFERRED TO AI/BACKGROUND PROCESSING MODULE.` Human session truyền `VOICE_TRANSCRIPTION`/`SANITIZATION_PIPELINE` tiếp tục fail closed.

### Trạng thái bảo mật transcript sau Migration 004

Migration 004 (`20260916000001_private_call_transcripts.sql`) đã chuyển hoàn toàn `public.call_transcripts` sang `private.call_transcripts`. Bảng nằm ngoài tầm nhìn PostgREST, RLS fail-closed với 0 client policies, thu hồi toàn bộ quyền direct table từ `anon` và `authenticated`. Truy cập đọc verbatim thực hiện qua bounded RPC `public.get_call_transcript(company_id, call_id)` (chỉ cấp quyền EXECUTE cho `service_role`).

- **BOSS_ADMIN**: ✅ (qua Trusted Server + active membership cùng công ty + AAL2 trong production + audit bắt buộc).
- **SALE**: ❌ (CẤM, kể cả cuộc gọi do chính SALE thực hiện).
- **TECHNICIAN**: ❌ (CẤM).
- **AI Worker**: future machine identity, server-side, least privilege, không phải human role; write path tiếp tục DEFERRED.
- Tuyệt đối không dùng `public.interactions.sanitized_content` hoặc `private.interaction_raw_contents` cho transcript.

## 5. Technician assignment

Assignment hiện hành:

- `ASSIGNED`
- `ACCEPTED`
- `IN_PROGRESS`

Assignment hết hiệu lực:

- `COMPLETED`
- `CANCELLED`
- `REJECTED`

Quyền tới Customer/Survey/Installation phải đi qua appointment hiện hành. `surveys.completed_by` chỉ là bằng chứng lịch sử, không phải authorization.

## 6. Storage

Bucket Foundation canonical:

| Bucket | TTL | Quy tắc |
| --- | ---: | --- |
| `survey-photos` | 3600s | Resource-authorized |
| `installation-docs` | 3600s | `installations.photos` / `handover_ref` |
| `contracts` | 1800s | Boss/Sale theo contract scope |
| `call-recordings` | 900s | BOSS_ADMIN only |

Browser chỉ gửi resource ID và selector allowlist. Không gửi bucket, object path, file ref, storage URL hoặc TTL. Server authorize resource trước rồi mới đọc canonical reference và sign. Không tạo fake URL; missing object/signing failure phải fail closed.

## 7. Audit

Audit bắt buộc cho raw phone, Click-to-Call, privileged transcript/raw access, thay role/membership, payment exception, pricing activation và các privileged mutation đã định nghĩa. Audit là append-only, không chứa phone, token, secret, password hoặc raw payload. Nếu hành động yêu cầu audit mà ghi audit thất bại, không trả dữ liệu và không gọi provider.

## 8. Migration policy

- Migration 001: frozen — `20260914000001_initial_schema.sql`
- Migration 002: frozen — `20260915000001_rls_foundation.sql`
- Migration 003: frozen — `20260915000002_trusted_server_private_rpc.sql`
- Migration 004: private transcript boundary — `20260916000001_private_call_transcripts.sql`
- Database change mới (nếu có): Migration 005+; phải nêu schema/constraint/index/RLS/backward compatibility và được review trước.

## 9. Những điều cấm

- Service Role trong frontend hoặc secret mang tiền tố `NEXT_PUBLIC_`.
- Raw phone ở frontend/log/error/export; direct private-table query từ browser.
- Tin role, Company, ownership, assignment hoặc storage path từ client.
- Tự thêm role mới hoặc mở rộng allowed role list theo caller input.
- Arbitrary bucket/object path/TTL; fake signed URL.
- Dùng historic assignment hoặc `completed_by` làm authorization.
- Trả provider secret/correlation ID/exception raw cho client.
- SALE hoặc TECH đọc verbatim transcript/recording.
- Dùng `sanitized_content` cho verbatim transcript.
- Biến human session thành Worker bằng purpose enum.
- Sửa Migration 001–003.

## 10. Checklist trước Pull Request

- [ ] Đã đọc `PROJECT_MASTER`, `DATA_CONTRACT`, `AUTH_DESIGN`, `SUPABASE_SCHEMA_DESIGN`, `SUPABASE_RLS_DESIGN` và tài liệu này.
- [ ] Input client chỉ gồm business identifiers/selectors tối thiểu; không có trusted Company/role/path/secret.
- [ ] Company derive từ target row; active profile/membership/role/scope được kiểm tra lại server-side.
- [ ] DTO/output/log/error không chứa phone, token, secret, raw provider error hoặc trường thừa.
- [ ] Technician access dùng assignment hiện hành; không dùng `completed_by`.
- [ ] Service Role chỉ dùng trong server-only module và luôn đứng sau authorization phù hợp.
- [ ] Sensitive action có mandatory audit và fail closed khi audit lỗi.
- [ ] Storage dùng bucket/TTL canonical và canonical DB reference sau authorization.
- [ ] Không mở đường transcript/recording cho SALE/TECH; không bypass bằng purpose enum.
- [ ] Có test happy path, wrong company, inactive user/member, wrong role, missing resource và provider/storage/audit failure.
- [ ] Chạy `npm run lint`, `npm run typecheck`, `npm run test:auth`, `npm run test:security`, `npm run build`, `git diff --check`.
- [ ] Xác nhận Migration 001–003 không đổi và không commit credentials/artifact tạm.
