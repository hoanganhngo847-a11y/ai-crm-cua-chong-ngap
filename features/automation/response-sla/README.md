# Response SLA Module (5-Phút Phản Hồi)

Module quản lý cam kết thời gian phản hồi (Service Level Agreement - SLA) 5 phút đối với các tin nhắn đến từ khách hàng trong Hộp thư tích hợp (Omnichannel Inbox).

---

## 1. Business Flow

Quy trình phản hồi tin nhắn theo `PROJECT_MASTER.md`:

```text
Customer inbound MESSAGE
  → Mở SLA Window (started_at = thời điểm tin nhắn đầu tiên, deadline_at = started_at + 300s)
  → Đếm ngược 5 phút chờ Sale phản hồi
  → Nếu Sale phản hồi trong vòng 5 phút:
      Đóng SLA Window (state = SALE_RESPONDED) → AI tuyệt đối không trả lời
  → Nếu quá 5 phút Sale chưa phản hồi:
      Đủ điều kiện cho phép bước AI evaluation xem xét trả lời (decision = ALLOW_AI_REPLY)
```

---

## 2. Canonical Source

Định danh và theo dõi SLA chỉ dựa trên các nguồn dữ liệu chuẩn hóa của hệ thống:

* `public.conversations`
* `public.interactions`

### Customer Message Hợp Lệ (Trigger mở SLA)

Một interaction kích hoạt mở hoặc duy trì SLA window phải thỏa mãn:

```text
type = MESSAGE
direction = INBOUND
actor_type = CUSTOMER
conversation_id != null
```

### Sale Response Hợp Lệ (Resolve SLA)

Một interaction được tính là phản hồi của Sale để hoàn thành SLA window phải thỏa mãn:

```text
type = MESSAGE
direction = OUTBOUND
actor_type = SALE
cùng conversation_id
```

*Lưu ý:* Tin nhắn của AI (`actor_type = AI`) **không bao giờ** được coi là Sale response.

---

## 3. Current Foundation Limitation

Theo schema và migration hiện tại của Foundation:

* `Conversation.channel` hiện chỉ hỗ trợ:
  * `FACEBOOK`
  * `ZALO`
* **Tuyệt đối không** tự ý nhét `WEBSITE` hoặc `HOTLINE` vào bảng `Conversation` khi schema cơ sở dữ liệu chưa mở rộng. Hotline/Click-to-Call được quản lý riêng qua bảng `Call`, còn tương tác Website chưa thuộc phạm vi inbox hội thoại hiện tại.

---

## 4. Important Invariants

1. **Một Conversation chỉ có tối đa một SLA window ở trạng thái `OPEN`**:
   * Khi khách gửi nhiều tin nhắn liên tiếp trước khi Sale kịp trả lời:
     ```text
     14:00 Customer: Alo
     14:01 Customer: Tôi cần tư vấn
     14:02 Customer: Nhà tôi rộng 3m
     ```
     Hệ thống chỉ duy trì **duy nhất 1 SLA window**:
     ```text
     started_at = 14:00
     deadline_at = 14:05 (đúng 300 giây)
     ```
   * **Không reset deadline.**
   * **Không tạo thêm SLA window.**
   * Sau khi Sale phản hồi hợp lệ, window hiện tại kết thúc (`SALE_RESPONDED`). Chỉ khi khách nhắn tiếp sau đó mới mở window mới.
   * Mốc thời gian nghiệp vụ chính thức duy nhất là **5 phút (300 giây)**. Không tự thêm quy tắc trung gian như "3 phút WARNING".

2. **Hết 5 phút không đồng nghĩa được gửi AI ngay lập tức**:
   * Quyết định `ALLOW_AI_REPLY` từ pure evaluator chỉ xác nhận điều kiện thời gian và trạng thái snapshot tại thời điểm đánh giá.
   * Trước khi AI gửi tin thật (ở các milestone sau), bắt buộc phải có bước **atomic claim / recheck** trạng thái hội thoại trực tiếp trên server để triệt tiêu race condition (tránh AI và Sale gửi đồng thời).
   * Mọi quyết định gửi hay hủy phải có audit log đầy đủ.

---

## 5. Pure Evaluator Specification (M9.1)

Trong milestone M9.1:
* Domain contract được định nghĩa tại `shared/contracts/response-sla.ts`.
* Logic tính deadline và đánh giá SLA được thực hiện thuần túy bằng hàm thuần (pure function) tại `features/automation/response-sla/services/evaluate-response-sla.ts`.
* **Tuyệt đối không** gọi database, Supabase client, Service Role key, hay dịch vụ OpenAI bên ngoài trong pure evaluator.

---

## 6. Durable Response SLA Windows & Atomic AI Claim (M9.2)

Trong milestone M9.2, toàn bộ state của Response SLA được bền vững hóa (persisted) trong PostgreSQL và được bảo vệ bằng các RPC giao dịch nguyên tử (`SECURITY DEFINER`), loại bỏ race condition giữa Sale và AI.

### Persistence Model (`public.response_sla_windows`)

Bảng dữ liệu bền vững `public.response_sla_windows` lưu trữ chu kỳ đếm ngược 5 phút:

| Cột | Kiểu | Ràng buộc / Ý nghĩa |
| --- | --- | --- |
| `id` | `uuid` | Khóa chính tự sinh (`gen_random_uuid()`). |
| `company_id` | `uuid` | Phân vùng tenant (`REFERENCES public.companies(id)`). |
| `conversation_id` | `uuid` | Hội thoại liên kết. |
| `customer_id` | `uuid` | Khách hàng liên kết. |
| `trigger_interaction_id` | `uuid` | Tin nhắn inbound customer kích hoạt cửa sổ SLA (`REFERENCES public.interactions(id)`). |
| `started_at` | `timestamptz` | Thời điểm tin nhắn khách đầu tiên đến. |
| `deadline_at` | `timestamptz` | Bắt buộc `started_at + interval '5 minutes'`. |
| `state` | `text` | `'OPEN'`, `'SALE_RESPONDED'`, `'AI_RESPONDED'`, `'CANCELLED'`. |
| `resolved_at` | `timestamptz` | `NULL` khi `OPEN`, `NOT NULL` khi đã resolve. |
| `sale_response_interaction_id` | `uuid` | Tin nhắn Sale trả lời giải tỏa SLA (`REFERENCES public.interactions(id)`). |
| `ai_response_interaction_id` | `uuid` | Tin nhắn AI phản hồi giải tỏa SLA (milestone sau). |
| `ai_claimed_at` | `timestamptz` | Thời điểm AI worker claim thành công. |
| `ai_claim_id` | `uuid` | Định danh claim của AI worker. |
| `ai_claim_expires_at` | `timestamptz` | Thời điểm hết hạn lease của AI claim (phục hồi khi worker crash). |

### Ràng Buộc Toàn Vẹn State (Harden State Integrity)

Bảng áp dụng các CHECK constraints nghiêm ngặt:

```sql
CONSTRAINT chk_response_sla_deadline
  CHECK (deadline_at = started_at + interval '5 minutes'),

CONSTRAINT chk_response_sla_state_resolution
  CHECK (
    (state = 'OPEN'
      AND resolved_at IS NULL
      AND sale_response_interaction_id IS NULL
      AND ai_response_interaction_id IS NULL)
    OR
    (state = 'SALE_RESPONDED'
      AND resolved_at IS NOT NULL
      AND sale_response_interaction_id IS NOT NULL
      AND ai_response_interaction_id IS NULL)
    OR
    (state = 'AI_RESPONDED'
      AND resolved_at IS NOT NULL
      AND ai_response_interaction_id IS NOT NULL
      AND sale_response_interaction_id IS NULL)
    OR
    (state = 'CANCELLED'
      AND resolved_at IS NOT NULL
      AND sale_response_interaction_id IS NULL
      AND ai_response_interaction_id IS NULL)
  ),

CONSTRAINT chk_response_sla_ai_claim
  CHECK (
    (ai_claimed_at IS NULL AND ai_claim_id IS NULL AND ai_claim_expires_at IS NULL)
    OR
    (ai_claimed_at IS NOT NULL AND ai_claim_id IS NOT NULL AND ai_claim_expires_at IS NOT NULL AND ai_claim_expires_at > ai_claimed_at)
  )
```

### Ràng Buộc Độc Nhất Single-Open (Partial Unique Index)

Để đảm bảo bất biến mỗi Conversation chỉ có tối đa một SLA window ở trạng thái `OPEN`:

```sql
CREATE UNIQUE INDEX uq_response_sla_windows_single_open
  ON public.response_sla_windows (company_id, conversation_id)
  WHERE state = 'OPEN';
```

Chỉ số này ngăn chặn triệt để trường hợp hai tin nhắn đến đồng thời tạo ra hai window trùng lặp.

### Cơ Chế RPC-Only Mutation (Cấm Trực Tiếp DML Từ Service Role)

Để đảm bảo automation state không bị ghi đè tùy tiện:

```sql
REVOKE ALL ON TABLE public.response_sla_windows FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.response_sla_windows TO authenticated;
GRANT ALL ON TABLE public.response_sla_windows TO postgres;
```

Cả browser (`anon`, `authenticated`) lẫn backend (`service_role`) đều **không có quyền trực tiếp INSERT, UPDATE, hoặc DELETE** vào bảng. Mọi thay đổi trạng thái bắt buộc phải đi qua các bounded `SECURITY DEFINER` RPCs được cấp `EXECUTE` cho `service_role`.

### Quan Hệ Khóa Ngoại và Ranh Giới Tenant Của Interaction

`public.interactions` sử dụng khóa chính đơn UUID `id` (theo kiến trúc Foundation 001). Quan hệ tenant (`company_id`, `customer_id`, `conversation_id`) giữa window và interaction được kiểm tra và đảm bảo nghiêm ngặt tại tầng logic giao dịch của bounded RPCs mà không cần thay đổi schema Foundation đã đóng băng.

### Vòng Đời Cửa Sổ & Recoverable Claim Lease

```text
[Customer Inbound]
       │
       ▼
 [OPEN Window]  <── (Tin nhắn tiếp theo từ khách trả về window hiện tại, deadline KHÔNG đổi)
       │
       ├─── [Sale Replying Before/After Deadline] ──> [SALE_RESPONDED] (SLA hoàn tất)
       │
       └─── [Deadline Passed + No Sale Reply]
                 │
                 ▼
          [AI Atomic Claim] ──> conversation: AI_HANDLING, window: OPEN (claimed với lease 2 phút)
                 │
                 ├─── [Worker Crash / Timeout (> 2 phút)] ──> [Atomic Reclaim by Another Worker]
                 │
                 └───> (Milestone sau: AI Dispatch Message -> AI_RESPONDED)
```

### Quy Trình RPC Nguyên Tử

1. **`open_response_sla_window(p_company_id, p_conversation_id, p_trigger_interaction_id)`**:
   - Xác thực Conversation và Interaction (đúng tenant, đúng khách, `MESSAGE`, `INBOUND`, `CUSTOMER`).
   - Nếu đã có window `OPEN`: trả về ngay window hiện tại (idempotent, không đổi `started_at`, không đổi `deadline_at`).
   - Nếu chưa có: chèn window mới với `started_at = interaction.created_at` và `deadline_at = interaction.created_at + interval '5 minutes'`. Bắt ngoại lệ `unique_violation` khi có nhiều luồng cùng chèn để trả về window chiến thắng một cách an toàn.

2. **`resolve_response_sla_on_sale_reply(p_company_id, p_conversation_id, p_sale_interaction_id)`**:
   - Xác thực tương tác của Sale (`MESSAGE`, `OUTBOUND`, `SALE`, đúng company/conversation).
   - Khóa bản ghi window `OPEN` bằng `SELECT ... FOR UPDATE`.
   - Nếu không có window `OPEN`: trả về rỗng (no-op an toàn).
   - Nếu có: cập nhật `state = 'SALE_RESPONDED'`, `sale_response_interaction_id = p_sale_interaction_id`, `resolved_at = interaction.created_at`. Nếu hội thoại đang ở `AI_HANDLING`, tự động hoàn trả `status = 'OPEN'` để nhường quyền xử lý cho Sale.

3. **`claim_response_sla_for_ai(p_company_id, p_window_id)`**:
   - Khóa bản ghi window `FOR UPDATE`.
   - Kiểm tra cô lập tenant: nếu sai công ty, ghi audit `DENIED` và từ chối.
   - Kiểm tra trạng thái window: phải là `OPEN`, `deadline_at <= now()`.
   - **Xử lý Recoverable Lease**: Nếu đã có claim nhưng `ai_claim_expires_at > now()`, từ chối với lý do `ALREADY_CLAIMED`. Nếu claim cũ đã hết hạn (`ai_claim_expires_at <= now()`), cho phép **reclaim nguyên tử**.
   - Khóa và kiểm tra `conversations`: trạng thái không được là `CLOSED`. (Nếu là fresh claim, không được là `AI_HANDLING`).
   - **Re-check Interaction mới nhất**: truy vấn trực tiếp xem Sale đã gửi tin `OUTBOUND MESSAGE` từ lúc `started_at` tới nay chưa. Nếu Sale đã gửi: tự động chuyển window thành `SALE_RESPONDED`, ghi audit `DENIED` (`SALE_ALREADY_RESPONDED`), không cho AI claim.
   - Thực hiện claim / reclaim: sinh `ai_claim_id`, cập nhật `ai_claimed_at = now()`, `ai_claim_expires_at = now() + 2 minutes`, chuyển conversation sang `AI_HANDLING`.
   - Ghi audit log `RESPONSE_SLA_AI_CLAIM` trong cùng transaction: ghi rõ decision là `CLAIMED` hoặc `RECLAIMED`. Nếu ghi audit thất bại, toàn bộ thao tác **rollback toàn diện (fail-closed)**.

### Đảm Bảo Đồng Thời (Concurrency Guarantees)

- **2 AI Worker claim cùng lúc:** Nhờ cơ chế `SELECT ... FOR UPDATE` trên PostgreSQL, worker thứ nhất khóa dòng và claim thành công. Worker thứ hai phải chờ transaction hoàn tất; khi unblock, dữ liệu đã có lease còn hiệu lực, worker thứ hai lập tức bị từ chối với lý do `ALREADY_CLAIMED`.
- **2 AI Worker reclaim cùng lúc khi lease hết hạn:** Worker 1 khóa dòng, reclaim thành công và gia hạn lease mới `expires_at = now() + 2m`. Worker 2 khi unblock thấy lease mới đang active $\rightarrow$ bị từ chối với lý do `ALREADY_CLAIMED`.
- **Sale trả lời sát giờ AI claim:** Nếu Sale đã gửi tin nhắn trước khi claim, RPC kiểm tra lịch sử interaction ngay trong transaction claim, đóng window thành `SALE_RESPONDED` và từ chối AI. Nếu Sale gửi ngay sau khi AI claim, RPC `resolve_response_sla_on_sale_reply` ghi nhận `SALE_RESPONDED` và reset trạng thái conversation, khiến bước gửi AI tiếp theo (M9.3) tự động hủy bỏ.

### Nhật Ký Kiểm Tra Bắt Buộc (Audit Logging)

- Mọi quyết định AI claim (thành công, reclaim, hoặc bị từ chối) đều được ghi vào `public.audit_logs`.
- Action: `RESPONSE_SLA_AI_CLAIM`.
- Resource: `RESPONSE_SLA_WINDOW` (ID window và customer ID).
- Metadata chỉ chứa safe identifiers và decisions (`CLAIMED`, `RECLAIMED`, `NOT_DUE`, `SALE_ALREADY_RESPONDED`, `ALREADY_CLAIMED`, `CONVERSATION_CLOSED`, `AI_ALREADY_HANDLING`). Tuyệt đối không log nội dung tin nhắn, số điện thoại, token, hay transcript.
- Tính nguyên tử: Bắt buộc ghi audit trong cùng transaction với claim. Nếu ghi audit lỗi, transaction rollback hoàn toàn.

### Ranh Giới Phạm Vi M9.2 (What M9.2 Still Does NOT Do)

> [!IMPORTANT]
> **AI CLAIM != AI MESSAGE SENT**
>
> Trong milestone M9.2:
> * Hệ thống **chưa** gửi bất kỳ tin nhắn AI nào.
> * **Không** gọi API OpenAI để sinh nội dung phản hồi.
> * **Không** gửi webhook/tin nhắn qua nhà cung cấp Facebook Messenger hay Zalo OA.
> * **Không** tạo cron job hoặc background scheduler chạy ngầm.
> * **Không** xây dựng UI Dashboard.
>
> Việc sinh nội dung và dispatch tin nhắn AI thực tế thuộc phạm vi các milestone tiếp theo.
