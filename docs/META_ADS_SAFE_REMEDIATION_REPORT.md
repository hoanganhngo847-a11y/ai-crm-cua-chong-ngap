# Meta Ads staging — safe remediation

Ngày kiểm tra: 31/10/2026 (Asia/Ho_Chi_Minh). PR #139, nhánh `meta_ads_integration`; baseline `012e776ca5258848b421cc8a9b4ed58712a3babe`.

**Phạm vi sửa đã hoàn thành trên fixture local; staging hiện tại chưa đủ điều kiện triển khai.** Không chạy migration hosted, reset Supabase, merge, deploy, đổi secret/cấu hình production hoặc gửi dữ liệu tới Meta. Không yêu cầu xử lý/phê duyệt toàn bộ 160 mục. Kết quả GitHub sau push phải đọc tại đúng head của PR; báo cáo kết quả CI cuối cùng kèm theo bàn giao.

## A. Lỗi và đối chiếu phạm vi

Đã đối chiếu 5 mục Gói 13 trong decision packet/register với DDL, RPC, RLS, TypeScript và kiểm thử:

| Mục trong snapshot quyết định | Mã nguồn sở hữu | Kết luận / xử lý |
| --- | --- | --- |
| `M117-S008.ALTER1.target1`: `meta_ad_accounts.access_token` | Migration `20261030100000`, OAuth `app/api/facebook/connect/select/route.ts`, `features/omnichannel/facebook/token-vault.ts` | Migration cũ có thể ghi đè kho riêng và xóa nguồn trước khi đối chiếu; đã thêm transaction, khóa bảng, kiểm tra nguồn/xung đột/bản sao. |
| `M117-S008.ALTER2.target1`: `token_expires_at` | Cùng migration và RPC store/get token | So sánh chính xác hạn dùng bằng `IS DISTINCT FROM`, giữ `NULL`; dừng nếu hạn dùng tồn tại mà không có token hoặc nguồn thiếu một trong hai cột. |
| `M118-S010.target1`: `claim_meta_leadgen_event` | Migration `20261030100000` và `20261030110000`; `features/omnichannel/facebook/lead-ads.ts` | Claim mới đã atomic và fenced bằng UUID. Giữ nguyên logic, kiểm chứng cạnh tranh thật bằng các kết nối PostgreSQL độc lập; thu hẹp EXECUTE ngay từ migration hardening. |
| `M118-S014.target1`: `finalize_meta_leadgen_event` | Cùng hai migration và TypeScript trên | SQL ba trạng thái khiến lease `NULL` có thể vượt kiểm tra thời hạn. Đã từ chối lease `NULL`, kiểm chứng dữ liệu không bị finalize. |
| `M118-S033.target1`: `release_meta_ad_account_sync_lease` | Cùng hai migration; `features/omnichannel/facebook/marketing-sync.ts` | Bản cuối đã yêu cầu đúng token, tenant và lease còn hạn. Giữ nguyên logic; chặn authenticated từ migration đầu và bổ sung test cạnh tranh, hết hạn, chủ cũ, tenant khác, replay, SUCCESS/FAILED. |

Các ID trên là vị trí của **snapshot baseline**, không phải số thứ tự statement sau bản sửa. Manifest lưu cả hash baseline và hash hiện tại. Không tái sinh/xóa danh mục quyết định cũ và không đánh dấu mục nào được phép triển khai.

**CI:** đọc log thật của cả ba job. Cùng lỗi gốc: 4 `require()` tại dòng 3–6 của `docs/evidence/meta-ads-dependency-audit/scan_repository.cjs` vi phạm `@typescript-eslint/no-require-imports`. Voice/Zalo dừng ở lint; Verify dừng tại bước ESLint số 13 trong integration gate. Thay bằng `import()` động trong hàm async, giữ đường dẫn `.cjs`, `__dirname`, parser và đầu ra. Không đổi ESLint, workflow, security gate, test Voice hoặc Zalo.

Decision packet cũ gọi kho token là Supabase Vault và mô tả cột cũ là plaintext. Thực tế OAuth mã hóa AES-256-GCM ở server, lưu ciphertext qua RPC vào bảng `private.meta_ad_account_tokens`; khóa nằm trong biến môi trường server. Chỉ sửa đoạn Meta và nơi đặt khóa trong packet.

## B. File sửa

1. `supabase/migrations/20261030100000_meta_ads_hardening.sql` — chuyển token/hạn dùng có kiểm chứng, rollback và ACL.
2. `supabase/migrations/20261030110000_meta_ads_final_remediation.sql` — chặn finalize khi thiếu lease.
3. `tests/omnichannel/meta_ads_db.integration.test.ts` — kiểm thử PostgreSQL cho token, 3 RPC và quyền.
4. `docs/evidence/meta-ads-dependency-audit/scan_repository.cjs` — sửa đúng 4 import gây CI lỗi.
5. `docs/evidence/meta-ads-final-scope/migration-manifest.json` — hash/envelope hiện tại của đúng 2 migration chưa triển khai, giữ hash cũ và `executionAuthorized: false`.
6. `tests/staging/safe-deployment.test.ts` — đối chiếu hash bản sửa với hash snapshot được lưu; giữ mọi assertion về schema, pipeline và chặn deployment.
7. `docs/META_ADS_OWNER_DECISION_PACKET.md` — làm rõ 5 mục Meta và cách quản lý khóa.
8. Báo cáo này và `docs/evidence/meta-ads-safe-remediation/local-validation.txt` — bằng chứng kiểm thử không chứa token/khóa.

Ba dòng trống có sẵn trong worktree ở packet, `generate_owner_decisions.py` và `owner-decisions-consistency.test.ts` được giữ ở working tree, không đưa vào commit sửa lỗi.

Không sửa mã nguồn CRM tuyển sinh, học viên, Messenger, Zalo, Voice, AI, Storage, phễu hay module cửa chống ngập. Các suite sẵn có có thể kiểm tra chúng để phát hiện hồi quy.

## C. Migration thay đổi và an toàn dữ liệu

Kiểm tra ledger chỉ đọc ngày 31/10: staging `qmhfmgkymjgoevwmkidm` có 21 mục, demo/production `yrauljxzyklhisxijeim` có 102 mục; cả hai chưa có 5 migration Meta. Trên staging, truy vấn `to_regclass` / `to_regprocedure` xác nhận chưa có bảng account, kho token hay claim RPC. Không lấy token hoặc secret hosted.

Chỉ sửa hai migration chưa triển khai nêu trên. Không thêm migration mới và không sửa migration lịch sử đã áp dụng.

`20261030100000` nay bao bọc toàn bộ bằng `BEGIN`/`COMMIT`, `lock_timeout = '5s'` và khóa hai bảng `ACCESS EXCLUSIVE` trong lúc chuyển. Kiểm tra trước khi copy:

- Hai cột nguồn cùng tồn tại hoặc cùng không tồn tại.
- Token khác `NULL` có dạng base64url và tối thiểu kích thước envelope; nguồn trống/sai dạng hoặc expiry không có token phải dừng.
- Mọi hàng vault đã có phải khớp nguyên ciphertext và expiry, không ghi đè khác biệt.

Sau `INSERT ... ON CONFLICT DO NOTHING`, đối chiếu từng cặp `(company_id, ad_account_id)` cùng ciphertext và hạn dùng. Chỉ khi không có hàng thiếu/sai mới xóa hai cột nguồn trong cùng transaction. Bất kỳ lỗi nào rollback; thông báo chỉ có mã lỗi cố định, không in giá trị token. ID và liên kết account, tên, trạng thái, dữ liệu khách hàng không bị viết lại. Không thêm `CASCADE`.

**Giới hạn:** định dạng base64url không chứng minh một ciphertext giải mã được. Trước bất kỳ triển khai có dữ liệu, vận hành phải kiểm tra toàn bộ ciphertext nguồn và vault bằng `scripts/meta-ads/verify-token-key.ts` trong môi trường server bảo mật, sau copy kiểm tra lại số lượng, đối chiếu và giải mã. Khóa chỉ truyền qua env; ciphertext qua stdin; công cụ chỉ in trạng thái/số lượng. Không đưa khóa vào SQL, Git hoặc log. Không xoay khóa trong đợt sửa này.

## D. Kiểm thử local

Các test dùng dữ liệu tổng hợp. Native PostgreSQL tạo database ngẫu nhiên riêng trong Docker local rồi dọn đúng các database đó; không reset database hiện hữu. Danh sách từng test PASS nằm trong [local-validation.txt](evidence/meta-ads-safe-remediation/local-validation.txt).

| Lệnh / kiểm tra | Kết quả |
| --- | --- |
| `npm run test:meta-ads` | 43/43 PASS: token/redaction, key rotation/offline verifier, webhook, attribution và idempotency. |
| `npm run test:meta-ads:db` | 2/2 PASS; các assertion bao gồm chuyển/giải mã token, expiry, rollback schema thiếu/nguồn sai/xung đột/copy thiếu, bảo toàn hàng CRM, 8 claim cạnh tranh, 6 sync lease cạnh tranh và recovery webhook thật qua route + SQL. Chỉ Graph/HTTP adapter là test double. |
| `npm run test:migration-integrity` | 17 kiểm tra PASS; giữ kiểm tra checksum, lịch sử, timestamp và rename allowlist. |
| `npm run test:meta-staging-preflight` | 1/1 PASS; tái hiện prefix 21, chuỗi 121 migration và bộ 5 Meta trên PostgreSQL local. PASS ở đây bao gồm assertion chứng minh shortcut vẫn không an toàn để triển khai. |
| `npm run test:staging-readiness` | 13/13 PASS; giữ kiểm tra ledger, transaction, phân quyền và backup/restore tổng hợp. |
| Owner decision consistency + migration ledger + migration security DB | 5/5 PASS; không đổi 178 ID, 160 pending hay trạng thái approved=false. |
| Scanner smoke trong Git fixture tạm | PASS; chạy được CommonJS entrypoint, import TypeScript, tạo JSON và nhận diện lời gọi RPC. |
| `npm run typecheck` | PASS. |
| `npm run lint` | PASS, 0 lỗi / 14 cảnh báo có sẵn. |
| `npm run build` với các biến local của Verify workflow | PASS. Lần chạy đầu thiếu URL/anon key local và đã dừng đúng kiểm tra cấu hình; không sửa ứng dụng để bỏ qua kiểm tra đó. |
| `git diff --cached --check` | Chạy trước commit; các dòng trống có sẵn không đưa vào index. |

## E. GitHub Actions

| Workflow tại baseline | Log đã đọc | Nguyên nhân |
| --- | --- | --- |
| Verify — FAILURE | [run 41098303926](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/actions/runs/41098303926), job `124209710580` | integration gate → ESLint → 4 import của scanner. |
| Voice security gate — FAILURE | [run 41098304089](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/actions/runs/41098304089), job `124209710783` | ESLint → cùng 4 import; các bước sau bị skip. |
| Zalo OA & care gate — FAILURE | [run 41098303946](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/actions/runs/41098303946), job `124209709891` | ESLint → cùng 4 import; các bước sau bị skip. |
| ZCAJS Integration CI | SUCCESS ở baseline | Không sửa workflow. |
| Personal Zalo campaign gate | SUCCESS ở baseline | Không sửa workflow. |

Push commit sửa lỗi lên chính PR để tạo một lượt **toàn bộ workflow**, gồm cả những workflow vốn đã PASS. Kết quả cuối phiên phải nêu từng workflow và đúng SHA; không gọi test bị skip là PASS, không dùng thành công của baseline khác để chứng minh head mới. [Danh sách runs của PR](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/actions?query=branch%3Ameta_ads_integration).

## F. Rủi ro / chặn còn lại

1. **Không thể chứng nhận deploy lên staging hiện tại bằng shortcut 5 Meta migration.** Fixture chứng minh prefix 21 thiếu các thành phần của schema mới; bộ Meta hiện có thay đổi đường SLA Messenger (số SLA từ 0 thành 1) và tạo `seed_messenger_pages_canary` nhưng chưa có trigger/helper/table cần thiết. Bằng chứng tại `tests/staging/safe-deployment.test.ts`, các assertion `sla_count`, `seed_triggers`, `latentCanaryProbe`; định nghĩa dùng chung có sẵn ở `20261030110000_meta_ads_final_remediation.sql`. Bản sửa này không thay đổi các hàm Messenger đó. Đây là dependency cần báo cáo trước khi xin mở rộng, không phải lý do triển khai toàn bộ pending chain.
2. Full-chain fixture vẫn giữ assertion về QC RPC phụ thuộc bảng cũ đã bị xóa. Không sửa QC, module cũ hoặc yêu cầu phê duyệt 160 mục để làm Meta xanh.
3. Chưa có bằng chứng backup/restore **dữ liệu staging thật**, kiểm thử restore trên dữ liệu tổng hợp không thay thế được bằng chứng này.
4. Chưa xác minh hosted Auth/Meta/secret đầy đủ, quyền Meta/App Review, subscription, quan hệ asset và lead thực trên test asset được cho phép. Không dùng Page/Form thật đã nối production để thử.
5. Chưa đọc/giải mã token thật, chưa chứng minh live OAuth, Graph hay webhook công khai. Fixture và CI không thay thế nghiệm thu hosted.
6. Khóa bảng có thể làm migration hết `lock_timeout` nếu đang có giao dịch. Khi đó dừng/rollback và xử lý cửa sổ bảo trì, không bỏ timeout để chạy mù.

## G. Xác nhận bảo toàn

- Không có hosted write, production migration/reset/delete, đổi khóa, mất kết nối do thao tác vận hành, merge hay deployment trong đợt này. Chỉ đọc ledger/catalog; vì vậy không có thay đổi dữ liệu/token hosted từ tác vụ này.
- Trong PostgreSQL fixture, token giải mã về đúng giá trị gốc, ciphertext và expiry bằng nhau trước/sau; account ID/liên kết và hàng khách hàng giữ nguyên. Đã chủ động gây lỗi copy và xung đột để xác nhận nguồn/vault còn nguyên sau rollback.
- Schema cuối không có `access_token`/`token_expires_at` trên account công khai. Bảng riêng bật RLS; browser roles không có SELECT, không có EXECUTE token RPC hoặc 3 RPC mục tiêu; service_role vẫn có EXECUTE. Finalizer cũ không còn overload không có claim token.
- Không có khóa thật hardcode hoặc thêm vào Git, không có token thật trong báo cáo/bằng chứng. AES-256-GCM và cơ chế khóa cũ đã được kiểm thử bằng giá trị tổng hợp. Bảo toàn/giải mã **token hosted thật** vẫn là kiểm tra trước triển khai, chưa được tuyên bố nghiệm thu.

## H. Bước staging tiếp theo

1. Xác nhận CI của đúng commit bàn giao đều PASS và review đúng 2 migration/hash cùng 5 hạng mục. Giữ PR Open + Draft, không merge/deploy trong tác vụ này.
2. Chọn staging cô lập có schema tương thích, hoặc lập một thay đổi dependency cụ thể để tách tác động Messenger khỏi bundle Meta; báo cáo code và xin phạm vi riêng trước khi sửa. Không `db push` toàn bộ pending chain và không yêu cầu phê duyệt blanket 160 mục.
3. Lập checkpoint backup/restore thực của staging mục tiêu; chạy preflight chỉ đọc, kiểm tra RLS/EXECUTE và đối chiếu token/expiry cùng offline verifier trước/sau. Nếu dữ liệu không khớp hoặc không giải mã được, dừng, không xóa cột và không đổi kết nối Facebook.
4. Chỉ sau báo cáo kiểm tra và quyền triển khai riêng mới áp dụng bundle đã review lên staging. Sau đó nghiệm thu bằng asset test cô lập: chữ ký webhook, replay cùng Lead ID, cạnh tranh claim/sync, retry lỗi từng phần, một khách hàng với nhiều lead, quyền tenant và kiểm tra không lộ token.

Không có bước nào trong đề xuất này tự cấp quyền chạy migration hay deploy staging/production.
