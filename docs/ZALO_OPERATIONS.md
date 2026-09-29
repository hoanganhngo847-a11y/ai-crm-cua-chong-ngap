# Zalo OA & chăm sóc Zalo — vận hành và bất biến

Phạm vi: Thành viên 3 (`features/omnichannel/zalo`, `features/care/zalo`, `app/api/webhooks/zalo`, `app/api/cron/zalo-care`, `app/actions/zalo.ts`).
Migration: `supabase/migrations/20260929000001_zalo_round3_remediation.sql`.

## 1. Kết nối OA (BOSS_ADMIN + MFA)

- `upsertZaloOaConnectionAction` gọi RPC `zalo_upsert_oa_connection`. `app_secret`, `access_token`, `refresh_token` và `webhook_secret` chỉ nằm trong `private.zalo_oa_secrets`, không trả về client. Mỗi thao tác đều ghi audit `ZALO_OA_CONNECTION_UPSERTED`, metadata không chứa secret.
- `public.zalo_oa_configs` chỉ chứa metadata: `company_id`, `oa_id`, `app_id`, `status`, `secret_ref_id`.
- Một OA chỉ thuộc về một Company. Nếu kết nối OA đang thuộc Company khác, thao tác bị chặn.
- Rotation token là single-flight: `zalo_begin_token_refresh` → gọi OAuth → `zalo_complete_token_refresh`. Mỗi lần rotation ghi audit `ZALO_OA_TOKEN_ROTATED` với kết quả SUCCESS hoặc FAILED.

## 2. Webhook ingress

Thứ tự xử lý: parse payload → resolve tenant theo `oa_id` → xác thực HMAC bằng secret của đúng OA đó → claim → một transaction DB duy nhất.

| Tình huống | HTTP |
| --- | --- |
| Thiếu hoặc sai chữ ký, `app_id` lệch | 401 |
| OA không tồn tại hoặc không ACTIVE | 403 `TENANT_NOT_FOUND` |
| Tra tenant lỗi (DB) | 503, để Zalo retry |
| Event đang có worker khác xử lý (lease còn hạn) | 429 |
| Lỗi pipeline | 500 `ZALO_WEBHOOK_PROCESSING_FAILED`, event chuyển FAILED |

State machine của `zalo_ingress_events`:

- `PROCESSED` → trả về duplicate.
- `FAILED`, hoặc `CLAIMED` đã hết lease → claim lại, `retry_count + 1`, cấp claim token mới.
- `CLAIMED` còn lease → BUSY.

Chỉ bên đang giữ claim token mới được process hoặc fail event.

`zalo_process_ingress_message` thực hiện trong cùng một transaction: customer/identity (có advisory lock theo từng Zalo user), conversation (`unread_count`), interaction, `private.interaction_raw_contents`, đánh dấu care delivery RESPONDED, opt-out và PROCESSED.

`external_ref` chuẩn có dạng `zalo:{company_id}:{oa_id}:{provider_msg_id}`. ID gốc của provider nằm trong `source_metadata.provider_msg_id`. Webhook echo `oa_send_*` cho tin do CRM gửi được nhận diện là duplicate.

Các event trạng thái:

- `user_received_message` → care delivery chuyển DELIVERED.
- `user_seen_message` → chuyển READ.
- `unfollow` → dừng chăm sóc với lý do `ZALO_UNFOLLOWED`.
- `follow` không tự bật lại lịch đã dừng.

## 3. Gửi tin (outbox)

- Người dùng: `sendZaloReplyAction` lấy Company từ hội thoại, rồi `verifyActorForCompany` kiểm tra actor là SALE hoặc BOSS_ADMIN. RPC tiếp tục kiểm tra lại membership và role trong DB.
- System worker (AI, SYSTEM): `sendSystemZaloReply` với `ZaloSystemPrincipal { kind: 'SYSTEM_WORKER', companyId, actorType, workerName }`.
- `commandId` là bắt buộc. Composer sinh một lần và dùng lại khi người dùng bấm gửi lại. Unique theo `(company_id, channel, command_id)`.

| Trạng thái delivery | Ý nghĩa | Gửi lại? |
| --- | --- | --- |
| SENDING (còn lease) | Đang gửi | Không (BUSY) |
| FAILED | Zalo từ chối chắc chắn (4xx, error ≠ 0, thiếu token) | Có, cùng commandId |
| PROVIDER_SENT_PENDING_FINALIZE | Zalo đã nhận, CRM chưa ghi xong | Không. Cron finalize lại |
| PROVIDER_UNCERTAIN | Timeout, 5xx hoặc worker chết giữa chừng | **Không bao giờ tự gửi lại**, cần người kiểm tra |
| SENT | Đã ghi interaction | Không (ALREADY_SENT) |

Nội dung gốc của tin gửi đi nằm trong `private.zalo_outbound_payloads`. Cột `content` ở bảng public chỉ chứa bản đã che số điện thoại.

## 4. Chăm sóc định kỳ và chiến dịch

- Cron `/api/cron/zalo-care` (15 phút một lần, `Authorization: Bearer $CRON_SECRET`) gồm hai việc: `processDueSchedules` và `reconcilePendingDeliveries`.
- `care_claim_schedule_delivery` lock lịch chăm sóc, mỗi `(schedule, ngày mục tiêu)` chỉ có một delivery. Delivery luôn gắn vào campaign hệ thống `PERIODIC_SCHEDULE` của Company.
- Khi FAILED, hệ thống claim lại đúng delivery đó (`attempt_count + 1`, tối đa 3 lần), rồi chuyển SKIPPED `MAX_ATTEMPTS_EXCEEDED`.
- Khi UNCERTAIN, hệ thống không gửi lại mà bỏ qua chu kỳ đó để tránh gửi trùng tin chăm sóc cho khách.
- `next_send_at` chỉ được đẩy lên trong `care_complete_delivery`, cùng transaction với SENT.
- Lịch đã dừng (opt-out, unfollow, doanh nghiệp tắt) chỉ được bật lại qua `reactivateZaloCareScheduleAction` (BOSS_ADMIN, bắt buộc có lý do, có audit `CARE_SCHEDULE_REACTIVATED`).
- Nhận diện opt-out khớp nguyên từ trên văn bản đã bỏ dấu. "chuyển khoản" hay "hủy đơn" **không** bị tính là opt-out.

## 5. Kiểm thử

- `npm run test:zalo`: chạy toàn bộ migration và RPC thật trên PGlite (PostgreSQL WASM), không cần Docker.
- `npm run test:zalo:db`: chạy trên Supabase local (`supabase start && supabase db reset`). Kiểm tra wiring qua PostgREST, ACL theo JWT role và concurrency thật.
- CI: `.github/workflows/zalo-ci.yml`.

## 6. Thay đổi vùng dùng chung (cần Thành viên 1 review)

- `public.care_deliveries`: thêm status `SENDING` và `UNCERTAIN`, thêm cột `claim_token`, `oa_id`, `error_code`, `error_message`. Tương thích ngược, analytics vẫn đếm theo timestamp như trước.
- `public.care_campaigns`: thêm unique index một phần cho campaign `PERIODIC_SCHEDULE`.
- `vercel.json`: thêm cron `/api/cron/zalo-care`.
- `package.json`: thêm devDependency `@electric-sql/pglite` và script `test:zalo:db`, bỏ `test:zalo:inbox`.
