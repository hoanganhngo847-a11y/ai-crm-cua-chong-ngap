# Meta Ads: CI và security remediation — 05/11/2026

Trạng thái hosted execution: **BLOCKED – HUMAN VERIFICATION REQUIRED**.
Bằng chứng local dưới đây không phải bằng chứng production readiness. GitHub Actions mới nhất nằm trong [PR #143](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/pull/143).

## Phạm vi và dependency

Điểm bắt đầu: PR #139 `1e3b441`, PR #141 `14b05f4`, PR #142 `6ead85c`.
PR #141 và #142 cùng base `meta_ads_integration`; hai file ACL trùng nhau có diff giống hệt nhau. Đã đọc diff và giữ lịch sử hai nhánh bằng merge commit `b25eefc` và `e3491fc` trên nhánh tích hợp riêng. Không merge, đóng hoặc sửa code các PR gốc. Không đụng working tree có thay đổi của người dùng.

Đề xuất: review PR #143 trước; Project Owner quyết định cách đưa các source histories và remediation commits vào `meta_ads_integration`. Chưa được dùng bundle năm migration cũ để triển khai tính năng mới.

## Các lỗi đã xác nhận và cách sửa

1. **Column ACL identity**: live extractor thiếu `schema/table/column` trong khi classifier so sánh strict baseline. Giữ sửa lỗi #141, thêm kiểm thử query PostgreSQL thật: ACL chuẩn được nhận diện, grant thêm bị chặn, fixture rollback. Phát hiện thêm relation identity guard bị đặt nhầm trong nhánh column; chuyển về nhánh relation. Không đổi ACL baseline hoặc bỏ kiểm tra grantor, grant option, missing/extra grants và duplicate entries. App-managed ACL do migration quản lý; Auth/Storage mặc định phải khớp baseline chính xác; customizations được allowlist phải được tái tạo/so sánh đầy đủ, loại không hỗ trợ vẫn BLOCKED.
2. **CLI rate limit**: log Voice trên #139 dừng tại `supabase/setup-cli@v1`, `Failed to resolve latest Supabase CLI release: rate limit exceeded`; auth/security tests chưa chạy trong run đó. Pin official setup action SHA `689adcfb80d947100a1eab127289b97d1fb07b13` (v3) và CLI `2.119.0` trong năm workflows. Action v3 cài bản npm cụ thể, fallback cùng phiên bản từ GitHub có checksum; không lookup latest. CLI v3 có breaking changes nên không nâng CLI theo latest. Không bỏ qua database validation hoặc Voice gate. Voice/Zalo gates mở rộng sang PR base `meta_ads_integration`.
3. **Conflicting Page evidence**: #142 dùng OR giữa signed binding và creative proof nên signed binding có thể che conflict của creative lúc intake. Migration bổ sung đặt conflict thành veto, lưu flag bền vững để backfill không xóa được mâu thuẫn.
4. **Retry proof promotion**: #142 dựng signed binding từ lần giao sau dù đã có immutable intake checkpoint. Retry nay chỉ dùng signed binding, conflict flags và Ad identity đã checkpoint. Thiếu proof tiếp tục pending; không nâng BACKFILL thành AT_LEAD_INTAKE.
5. **Campaign assertion fallback**: chỉ một campaign row cùng tenant chưa chứng minh campaign thuộc Ad. Lead Ads intake/retry nay cần exact company/Ad/campaign/ad-account join. Assertion-only event giữ PENDING_SYNC và raw evidence; campaign name không bị bịa. Điều chỉnh tests để thêm mapping thật trước khi kỳ vọng ATTRIBUTED, đồng thời kiểm tra campaign-only vẫn pending.
6. **Backfill concurrency/audit**: compare-and-set toàn bộ JSON context thay vì chỉ status/Page; giữ intake creative trước khi backfill để tránh mất bằng chứng hoặc cập nhật đồng thời.
7. **Incomplete deployment bundle**: bundle/reconciliation năm source bỏ sót Page guard. Cả hai builder dùng danh sách bảy source có hash pin. Original canonical ledger 21 dòng giữ nguyên; reconciliation chỉ ghi đủ các source thực sự đã thực thi.
8. **Offline bundle data guard**: `c.relkind='v_table_row'` không chọn bảng cần bảo vệ. Sửa thành `IN ('r','p')`; rehearsal có bảng đã chứa dữ liệu, cố ý UPDATE trước postflight phải báo `META_21_EXISTING_ROWS_CHANGED` và rollback toàn bộ.

## Contract và migration

Không đổi RPC signatures, TypeScript public exports, grants hoặc lịch sử migration đã có. Migration mới được tạo bằng Supabase CLI:
`20261104171905_meta_lead_evidence_conflict_guard.sql`.

Attribution context thêm optional `leadgen_page_evidence_conflict` và lưu `intake_creative_snapshot` khi backfill. Flag conflict tại intake không được tự động gỡ bởi retry/backfill. Sự kiện thiếu proof được giữ để điều tra thủ công, không bị xóa. Các mô tả cũ cho phép suy luận Lead Ads chỉ từ campaign ID được thay thế bằng exact Ad mapping requirement này.

Thứ tự selective release hiện tại:

1. `20261030090000_meta_ads_lead_attribution.sql`
2. `20261030100000_meta_ads_hardening.sql`
3. `20261030110000_meta_ads_final_remediation.sql`
4. `20261030120000_meta_ads_attribution_rpc_security.sql`
5. `20261030130000_meta_ads_phone_duplicate_history.sql`
6. `20261104150000_meta_lead_page_binding_guard.sql`
7. `20261104171905_meta_lead_evidence_conflict_guard.sql`

Hash và catalog proof được tạo từ rehearsal thật, không tự xác nhận hosted compatibility. `CURRENT_SOURCE_COMMIT` trỏ vào commit chứa source SQL/hashes của remediation (`d5e00b7`); approval phải khớp bundle mới, không tái sử dụng approval cho bundle cũ.

## Bằng chứng local tại implementation

| Kiểm tra | Kết quả |
|---|---|
| Meta Ads/attribution/creative/duplicate-phone + adversarial evidence | 54/54 PASS |
| Native PostgreSQL Meta concurrency/intake/retry | 2/2 PASS |
| Migration integrity | 17/17 PASS |
| Migration ledger/security | 4/4 PASS |
| Staging readiness, synthetic backup/restore | 13/13 PASS |
| Full chain 124 migrations, exact prefix, seven-source atomic bundle | PASS; unexpected DML rollback verified |
| Selective ledger / guarded runtime | 13/13 và 9/9 PASS |
| Backup helpers trước relation hardening | 383 PASS; 1 intentional negative-test skip |
| Python backup suites | 71 + 4 PASS |
| ACL suite sau hardening với live PostgreSQL 17.11 | 15/15 PASS |
| Auth / security / Voice / Voice business | 66/66; PASS; PASS; PASS |
| Typecheck / ESLint / Build | PASS / 0 errors, 16 existing warnings / PASS |

Lần chạy backup ban đầu với custom `CRM_PG17_CONTAINER` làm hỏng fixture giả lập container và bị allowlist từ chối. Đã chạy lại với disposable target chuẩn được kiểm tra ownership; không nới lỏng allowlist. Các fixture mới thiếu required fields/typing và metadata manifest đã được sửa trước khi công bố kết quả PASS. CI của exact final head phải được kiểm tra riêng, không kế thừa kết quả source PRs.

## Project Owner cần xác minh

- Attestation độc lập rằng người ký là Project Owner được ủy quyền, đúng project và write scope.
- Xác minh provenance/fingerprint của trusted public root qua kênh độc lập; file public key pin trong repo không tự chứng minh nguồn gốc.
- Xác nhận private key do Owner kiểm soát và lưu ngoài repository. Không gửi key vào chat/log.
- Thực hiện backup vật lý/logical theo runbook, bảo vệ và xác thực bundle; restore trên instance cô lập, kiểm chứng counts/hashes/ACL/RLS/Storage và rollback; cung cấp evidence thật được ký.
- Xác nhận production access và thủ tục triển khai riêng; phiên này không kiểm tra hoặc sử dụng quyền production.
- Review exact final code, CI và migration/bundle hashes trước khi ký approval mới.

Không tạo owner attestation, không chứng thực trust-root thay Owner, không chạy SQL hosted staging/production, không deploy, không thay dữ liệu production hoặc kết nối Meta asset thật trong phiên này.
