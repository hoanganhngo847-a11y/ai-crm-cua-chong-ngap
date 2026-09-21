# AI CRM Cửa Chống Ngập — Tài liệu Bàn giao Toàn phần

> Cập nhật: 2026-09-21 · Nhánh chính: `main` · Nhánh đang làm: `feature/voice-hotline` (chưa commit)  
> Repo: `f:\Code\ai-crm-cua-chong-ngap`  
> Stack: **Next.js 16.3.5 (App Router, Turbopack)** · **Supabase** · **TypeScript strict** · **Tailwind CSS**

---

## 1. Bức tranh toàn cảnh dự án

### Mục tiêu kinh doanh
Hệ thống AI CRM đa kênh cho doanh nghiệp sản xuất cửa chống ngập theo đơn hàng.  
- 4 nhân viên sale → **1 sale duy nhất**, AI lo phần lặp lại
- AI xử lý: inbox đa kênh, gọi ra theo chu kỳ, báo giá sơ bộ, lịch khảo sát, chăm sóc sau bán
- Sale tập trung: tư vấn sâu, thương lượng, chốt đơn

### 9 phân hệ (theo thành viên)

| # | Nhánh | Phân hệ | Trạng thái |
|---|---|---|---|
| 1 | `feature/foundation-auth` | Nền tảng, đăng nhập, phân quyền, Supabase, RLS | ✅ **MERGED vào main** |
| 2 | `feature/crm-customer360` | CRM, Customer 360, Hộp thư tích hợp | ❌ Chưa làm |
| 3 | `feature/zalo-care` | Zalo OA, chăm sóc Zalo | ❌ Chưa làm |
| 4 | `feature/facebook-website` | Facebook Messenger, Website | ❌ Chưa làm |
| 5 | `feature/voice-hotline` | Hotline, AI Voice, gọi ra, ghi âm, transcript | 🔶 **Đang làm — chưa commit** |
| 6 | `feature/survey` | Lịch khảo sát, kỹ thuật nhập số đo | ❌ Chưa làm |
| 7 | `feature/pricing-payment-contract` | Bảng giá, thanh toán, hợp đồng, đơn hàng | ❌ Chưa làm |
| 8 | `feature/operations-after-sales` | Sản xuất, lắp đặt, bàn giao, bảo hành | ❌ Chưa làm |
| 9 | `feature/ai-style-analytics` | AI phân tích, học phong cách sale, tự động hóa, thống kê | ❌ Chưa làm |

---

## 2. Foundation đã HOÀN THÀNH (Đừng sửa)

### Các file ĐÓNG BĂNG — Không được sửa đổi

```
supabase/migrations/20260914000001_initial_schema.sql   ← Migration 001 (ĐÓNG BĂNG)
supabase/migrations/20260914000002_rls_policies.sql      ← Migration 002 (ĐÓNG BĂNG)
supabase/migrations/20260914000003_storage.sql           ← Migration 003 (ĐÓNG BĂNG)
supabase/migrations/20260914000004_private_transcripts.sql ← Migration 004 (ĐÓNG BĂNG)

lib/auth/           ← Toàn bộ thư mục — ĐÓNG BĂNG
lib/sensitive/      ← Toàn bộ thư mục — ĐÓNG BĂNG
lib/server-auth/    ← Toàn bộ thư mục — ĐÓNG BĂNG
app/actions/sensitive.ts  ← ĐÓNG BĂNG
shared/constants/roles.ts ← ĐÓNG BĂNG
shared/contracts/auth.ts  ← ĐÓNG BĂNG
shared/contracts/sensitive.ts ← ĐÓNG BĂNG
```

> ⚠️ **CRITICAL**: Nếu cần sửa các file trên, phải tạo PR giải thích lý do và ảnh hưởng.

### Foundation đã có sẵn để tái sử dụng

| Function / Action | File | Dùng cho |
|---|---|---|
| `clickToCallAction(params)` | `app/actions/sensitive.ts` | Nút GỌI KHÁCH — không reimpl |
| `getAuthorizedSignedUrlAction({ category:'RECORDING', resourceId:callId })` | `app/actions/sensitive.ts` | BOSS_ADMIN nghe ghi âm |
| `getCallTranscriptAction({ callId })` | `app/actions/sensitive.ts` | BOSS_ADMIN xem transcript (AAL2) |
| `requireActiveMember(companyId, client)` | `lib/auth/context.ts` | Xác thực user + role |
| `requireBossAdmin(companyId, client)` | `lib/auth/context.ts` | Chỉ cho BOSS_ADMIN |
| `getActorContext(companyId?, client?)` | `lib/auth/context.ts` | Lấy thông tin actor (không throw) |
| `createAdminClient()` | `lib/supabase/admin.ts` | Server-side với service_role |
| `createClient()` | `lib/supabase/server.ts` | Server-side với user session |
| `ServerAuthError` | `lib/server-auth/errors.ts` | Throw lỗi chuẩn |

### DB Schema quan trọng (từ migrations)

```sql
-- Bảng chính
public.customers          -- stage: LEAD_NEW, CONTACT_CYCLE_1/2/3, UNREACHABLE, ...
public.calls              -- direction: INBOUND|OUTBOUND, agent_type: AI|SALE
                          -- provider: MANUAL|STRINGEE|VIETTEL|TWILIO|VINFON
public.call_attempts      -- attempt_no: 1|2|3
                          -- result: PENDING|NO_ANSWER|BUSY|ANSWERED|FAILED|CANCELLED
                          -- contact_cycle_id UUID
public.interactions       -- channel: HOTLINE|PHONE|AI_VOICE|FACEBOOK|ZALO
                          -- type: CALL_EVENT|MESSAGE|NOTE
public.company_members    -- role: BOSS_ADMIN|SALE|TECHNICIAN
public.user_profiles
public.audit_logs
public.customer_stage_histories

-- Private (service_role only)
private.customer_private_contacts   -- raw_phone (KHÔNG BAO GIỜ expose ra client)
private.call_transcripts            -- transcript verbatim (BOSS_ADMIN + AAL2 only)

-- RPC
public.get_customer_private_contact(p_company_id, p_customer_id)  -- trả raw_phone
public.get_call_transcript(company_id, call_id)  -- service_role only
```

### Error codes hợp lệ (ServerAuthErrorCode)

```typescript
'UNAUTHENTICATED' | 'USER_INACTIVE' | 'MEMBERSHIP_INACTIVE' | 'NOT_A_MEMBER' |
'ROLE_FORBIDDEN' | 'RESOURCE_NOT_FOUND' | 'RESOURCE_FORBIDDEN' | 'MFA_REQUIRED' |
'SENSITIVE_OPERATION_FORBIDDEN' | 'PROVIDER_FAILURE' | 'INVALID_PURPOSE' |
'SANITIZATION_INCOMPLETE' | 'ASSIGNMENT_INACTIVE' | 'AUDIT_WRITE_FAILED' |
'CALL_PROVIDER_FAILURE' | 'CALL_PROVIDER_NOT_CONFIGURED' |
'SIGNED_URL_UNAVAILABLE' | 'INTERNAL_ERROR'
```

### Proxy — Route được bảo vệ (sau voice module)

```typescript
// proxy.ts — isProtectedRoute
pathname.startsWith('/admin')   ||
pathname.startsWith('/crm')     ||
pathname.startsWith('/field')   ||
pathname.startsWith('/account') ||
pathname.startsWith('/calls')    // ← Thêm bởi voice module
```

---

## 3. Phân hệ Voice/Hotline — ĐÃ LÀM (chưa commit)

### git status hiện tại

```
M  app/(dashboard)/layout.tsx         ← Thêm link "Cuộc gọi" nav (BOSS_ADMIN + SALE)
M  proxy.ts                           ← Thêm /calls vào isProtectedRoute
?? app/(dashboard)/calls/             ← Toàn bộ thư mục UI mới
?? app/actions/voice.ts               ← 6 server actions
?? app/api/cron/voice-scheduler/      ← Cron endpoint
?? app/api/webhooks/voice/            ← Webhook endpoint
?? features/voice/providers/          ← MockProvider + StringeeStub
?? features/voice/services/           ← 4 services
?? shared/contracts/voice.ts          ← DTOs
?? tests/voice/                       ← 3 test files, 32/32 pass
```

### Kết quả kiểm tra

- ✅ TypeScript: **0 errors** (`Finished TypeScript in 1645ms`)
- ✅ Tests: **32/32 pass**
  - `tests/voice/call_cycle.test.ts` — 10/10
  - `tests/voice/webhook_security.test.ts` — 10/10
  - `tests/voice/call_history_permissions.test.ts` — 12/12

### Quy tắc kinh doanh đã implement

| Quy tắc | Nơi implement |
|---|---|
| Inbound Hotline **KHÔNG** tạo call_attempts | `webhook-processor.ts#processInboundCall()` |
| Lần 1 ngay, lần 2 +2.5h, lần 3 sáng hôm sau 09:00 VN | `call-attempt-scheduler.ts#scheduleRetryAttempt()` |
| Sau 3 lần → UNREACHABLE, không xóa khách | `call-attempt-scheduler.ts#markCustomerUnreachable()` |
| Phone không bao giờ ra khỏi server | `call-dispatcher.ts` — rawPhone trong memory |
| Audit FAIL CLOSED trước khi gọi provider | `call-dispatcher.ts` — audit fail → FAILED |
| SALE: hasRecording=null, transcriptStatus=null | `call-history.ts#getCallHistoryForSale()` |
| TECHNICIAN bị cấm mọi nơi | Mọi action + page |
| Disclaimer SIM khi MANUAL provider | `CallToCustomerButton.tsx` |
| Chống ghi trùng webhook (provider_call_id) | `webhook-processor.ts#processInboundCall()` |

### Biến môi trường cần thêm vào `.env.local`

```env
VOICE_PROVIDER=MOCK                   # MOCK | STRINGEE | VIETTEL | TWILIO | VINFON
STRINGEE_API_KEY=...
STRINGEE_API_SECRET=...
STRINGEE_FROM_NUMBER=+84xxxxxxxxx
STRINGEE_ANSWER_URL=https://domain.com/api/webhooks/voice
VOICE_WEBHOOK_SECRET=...
CRON_SECRET=...
COMPANY_ID_DEFAULT=...               # UUID company mặc định
NEXT_PUBLIC_VOICE_PROVIDER=MANUAL
```

### Việc còn cần làm để voice module hoàn chỉnh 100%

- [ ] **Commit + tạo PR** vào `feature/voice-hotline`
- [ ] Implement Stringee REST API trong `features/voice/providers/stringee-provider.ts` (lines 32–53)
- [ ] Implement handler `call.recording_ready`: download từ provider → upload bucket → gọi `updateCallRecordingRef()`
- [ ] Normalize phone E.164 trong `processInboundCall()` trước khi query `normalized_phone`
- [ ] Cấu hình Vercel Cron: schedule `*/5 * * * *` → `/api/cron/voice-scheduler`
- [ ] Đăng ký webhook URL với Stringee/tổng đài thật
- [ ] Viết `tests/voice/call_dispatch.test.ts` (còn trong plan, chưa viết)

---

## 4. Phần chưa làm — 7 phân hệ còn lại

### Phân hệ 2 — CRM & Customer 360 (`feature/crm-customer360`)

Thư mục: `features/crm/`, `app/(dashboard)/crm/`

- Trang danh sách khách (`/crm`) — filter theo stage, source, search
- Trang hồ sơ khách (`/crm/[customerId]`) — Customer 360 view
- Hộp thư tích hợp (`/crm/inbox`) — Facebook Messenger + Zalo OA chung 1 màn hình
  - Sale xem hội thoại, biết kênh nguồn, trả lời trong app
  - Tin chưa đọc, tin đang chờ
- Quy tắc 5 phút: thông báo sale → chờ 5 phút → AI chen nếu sale không trả lời
  - Ghi log mọi quyết định AI gửi/không gửi
- `Conversation` = thread, `Interaction` = từng message/event

### Phân hệ 3 — Zalo OA (`feature/zalo-care`)

Thư mục: `features/omnichannel/zalo/`, `features/care/zalo/`

- Webhook nhận tin nhắn từ Zalo OA → lưu `Interaction`
- Gửi tin nhắn ra Zalo OA (reply)
- AI tự động trả lời (quy tắc 5 phút)
- Chăm sóc định kỳ qua Zalo (1 tháng/lần)
  - Dừng khi khách yêu cầu hoặc doanh nghiệp tắt
  - `CareDelivery` record mỗi lượt gửi

### Phân hệ 4 — Facebook Messenger & Website (`feature/facebook-website`)

Thư mục: `features/omnichannel/facebook/`, `features/omnichannel/website/`

- Webhook Facebook Messenger Page Subscription
- Gửi message ra Messenger
- AI tự động trả lời (quy tắc 5 phút)
- Nhận form website → tạo Customer → trigger chu kỳ gọi outbound

### Phân hệ 6 — Khảo sát (`feature/survey`)

Thư mục: `features/survey/`, `app/(dashboard)/field/`

- Trang lịch khảo sát cho TECHNICIAN (`/field`)
- Nhận lịch từ `Appointment.assignee_id`
- Nhập kết quả, số đo, ảnh sau khảo sát
- `Survey.completed_by` = technician ID
- TECHNICIAN chỉ xem lịch được giao, không xem dữ liệu khách ngoài phạm vi

### Phân hệ 7 — Báo giá, Thanh toán, Hợp đồng (`feature/pricing-payment-contract`)

Thư mục: `features/pricing/`, `features/payment/`, `features/contract/`, `features/order/`

**Báo giá:**
- `PricingPolicy` có version — KHÔNG tự đổi phiên bản
- Thiếu thông tin → `NEED_INFO`, nêu trường thiếu
- **AI TUYỆT ĐỐI KHÔNG TỰ NGHĨ RA GIÁ**

**Thanh toán:**
- Webhook từ ngân hàng/payment gateway
- Tìm Order theo `payment_reference` hoặc `order_code`
- Chống ghi trùng `provider_ref`
- Không để sale tự bấm xác nhận cọc

**Hợp đồng:**
- Tự động từ mẫu có version
- `signed_file_ref` bắt buộc trước khi tạo `ProductionOrder`
- File đã ký không được thay thế âm thầm

### Phân hệ 8 — Sản xuất, Lắp đặt, Bảo hành (`feature/operations-after-sales`)

Thư mục: `features/production/`, `features/installation/`, `features/warranty/`

- Luồng bắt buộc: `Hợp đồng ký → ProductionOrder → Sản xuất → Lắp đặt → Bàn giao`
- `WarrantyTicket` liên kết Customer + Order + Installation
- Bảo hành không tự sửa giá/hợp đồng/doanh thu

### Phân hệ 9 — AI Phân tích, Học phong cách, Analytics (`feature/ai-style-analytics`)

Thư mục: `features/sales-style/`, `features/automation/`, `features/analytics/`

**Học phong cách sale:**
- Đọc transcript + tin nhắn của sale
- Học cách xưng hô, độ dài câu, xử lý phản đối, chốt
- Profile có version, nguồn được duyệt
- **Không tự giảm giá, không tự thay đổi điều khoản**

**Quy tắc 5 phút:**
- Thông báo sale → chờ 5 phút → AI được phép gửi
- Kiểm tra trạng thái hội thoại ngay trước khi AI gửi
- Log mọi quyết định

**Analytics (BOSS_ADMIN):**
- Dashboard doanh thu, lead, conversion
- Tổng hợp từ `CareDelivery`, `PaymentTransaction`, `Orders`

---

## 5. Quy tắc bắt buộc cho AI tiếp tục

### Bảo mật — KHÔNG được vi phạm

```
❌ raw_phone KHÔNG bao giờ ra client (JSON, log, URL, error message)
❌ KHÔNG trust company_id từ client — derive từ DB
❌ KHÔNG dùng user session cho webhook/cron — dùng createAdminClient()
❌ KHÔNG lưu recording URL từ provider vào DB — chỉ internal storage ref
❌ TECHNICIAN không được gọi khách, không xem raw phone
❌ KHÔNG tự sửa migration đã apply
❌ SALE không được xem recording, transcript
```

### Pattern bắt buộc

```typescript
// Lấy companyId từ server — không từ client
const client = await createClient();
const actor = await getActorContext(undefined, client);
const companyId = actor.companyId; // ✅

// requireActiveMember nhận string bắt buộc, không undefined
const member = await requireActiveMember(companyId, client);

// Audit TRƯỚC thao tác nhạy cảm — FAIL CLOSED
const { error: auditError } = await adminClient.from('audit_logs').insert({...});
if (auditError) {
  // Rollback + throw — KHÔNG tiếp tục
  await adminClient.from('calls').update({ status: 'FAILED' }).eq('id', callId);
  throw new ServerAuthError('...', 500, 'AUDIT_WRITE_FAILED');
}

// Test file: dùng async function, không top-level await
async function runTests() { ... }
runTests().catch((err) => { console.error(err); process.exit(1); });
```

### Cách chạy test

```bash
# Test voice (không cần DB)
npx tsx --conditions=react-server tests/voice/call_cycle.test.ts
npx tsx --conditions=react-server tests/voice/webhook_security.test.ts
npx tsx --conditions=react-server tests/voice/call_history_permissions.test.ts

# Test auth (cần Supabase local chạy)
npx tsx --conditions=react-server tests/auth/auth_runtime.test.ts

# TypeScript check
npm run build 2>&1 | Select-String "error TS"   # nếu không có output = PASS
```

### Lưu ý Next.js (quan trọng)

Theo `AGENTS.md` trong repo: **Phải đọc `node_modules/next/dist/docs/` trước khi viết route/API/Server Action mới.**

---

## 6. Git — Lệnh commit voice module

```bash
cd f:\Code\ai-crm-cua-chong-ngap
git checkout -b feature/voice-hotline
git add .
git commit -m "feat(voice): implement voice/hotline module

- 3-attempt outbound call cycle (immediate, +2.5h, next day 09:00 VN)
- AI inbound Hotline handler (no call_attempts, no 3-attempt rule)
- Webhook processor with signature verification
- Cron scheduler for pending attempts
- Role-split call history (SALE: no recording/transcript)
- GỌI KHÁCH button with SIM disclaimer
- 32/32 tests pass, 0 TypeScript errors"
```

---

*Tài liệu tạo ngày 2026-09-21. Cập nhật thủ công khi merge phân hệ mới.*
