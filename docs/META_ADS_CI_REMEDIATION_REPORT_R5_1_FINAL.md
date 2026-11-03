# BÁO CÁO REMEDIATION ROUND 5.1 — PR #140
## FINAL GAP CLOSURE, LIVE POSTGRESQL 17 CI & INDEPENDENT REVIEW HANDOFF

**Tài liệu:** `docs/META_ADS_CI_REMEDIATION_REPORT_R5_1_FINAL.md`
**Dự án:** Meta Ads Backup/Restore Pipeline
**Repository:** `hoanganhngo847-a11y/ai-crm-cua-chong-ngap`
**PR:** #140 — `feat(backup): integrate helpers 1-6, contracts, runbook v12, and CI verification`
**Branch:** `integration/meta-ads-backup-restore` → `meta_ads_integration`
**Baseline Commit:** `b0bf2d65c0ee049e1a1a36f10f0aab23c851a06a`
**Implementation Commit:** `364d809ad449edd6c665dbe7ee55e4540987e125`
**Workspace:** `/Users/hoangthuy/.gemini/antigravity/worktrees/ai-crm-cua-chong-ngap/ci_remediation_backup_helpers`
**Ngày thực hiện:** 2026-11-03
**Môi trường local:** macOS (darwin), Node.js `v24.15.0`, npm `11.12.1`, Python `3.14.6`, Docker `29.8.0`
**Trạng thái:** **READY FOR INDEPENDENT REVIEW — không merge, không deploy Production**

---

## 1. Executive Summary

Round 5.1 đóng các gap P0/P1 còn lại của PR #140:

1. **P0 — Bucket metadata parity:** `restoreStorage` không còn coi “GET thấy bucket” là bằng chứng cấu hình đúng. Sau POST và với bucket đã tồn tại, Helper #5 đọc lại metadata và xác minh đủ năm trường `id`, `name`, `public`, `file_size_limit`, `allowed_mime_types`. Metadata thiếu, sai kiểu, sai giá trị hoặc không đầy đủ đều fail closed với `BUCKET_CONFIGURATION_MISMATCH` trước khi upload bất kỳ object nào.
2. **P0 — PostgreSQL 17 live integration:** CI không còn xanh nhờ SKIP. Hai workflow `Backup & Restore CI (Helpers #1-#6)` và `Verify` provision một container PostgreSQL 17 disposable, xác minh major version 17, chạy test plan → apply → verify → rollback thật, và fail nếu container không sẵn sàng. Test chỉ được SKIP khi chạy local ngoài CI và không đặt `BACKUP_REQUIRE_LIVE_PG17=1`.
3. **P1 — CI hardening:** thêm health check, version check, marker verification, diagnostics on failure, teardown `if: always()`, timeout, concurrency guard, `git diff --check`, và local-only Docker guard.

**Kết quả thực nghiệm:**

| Hạng mục | Kết quả thực tế |
|---|---|
| Helper #5 (`storage-restore.test.mjs`) | **85 PASS / 0 FAIL / 0 SKIP** |
| Toàn bộ JS Helpers #1–#6 | **296 tests — 295 PASS / 0 FAIL / 1 SKIP có chủ đích** |
| Python backup regression | **75 PASS / 0 FAIL** (71 + 4) |
| PostgreSQL 17 live integration (local) | **PASS** — PostgreSQL 17.11, `server_version_num=170011` |
| PostgreSQL 17 live integration (GitHub Actions) | **PASS trong cả Backup CI và Verify CI**, không SKIP |
| Negative gate: thiếu container khi bắt buộc | **FAIL đúng thiết kế**, exit 1, “refusing to skip” |
| Negative gate: local không bắt buộc | **SKIP có chủ đích**, exit 0 |
| Remote Docker guard | **FAIL đúng thiết kế**, exit 1 |
| Typecheck | **PASS**, exit 0 |
| Lint | **PASS**, exit 0, 16 warning pre-existing |
| Build | **PASS**, exit 0 khi dùng đúng env CI |
| `git diff --check` | **PASS**, exit 0 |
| GitHub Backup CI (PR) | **SUCCESS** — run `41596680444` |
| GitHub Verify CI (PR) | **SUCCESS** — run `41596680518` |
| GitHub Backup CI (push) | **SUCCESS** — run `41596675060` |

Không có FAIL trong phạm vi backup/restore. Một SKIP duy nhất là negative fixture có chủ đích của Helper #6, không phải test bị bỏ qua.

---

## 2. Findings Trước Khi Sửa

| ID | Mức độ | Finding | Bằng chứng trước sửa |
|---|---|---|---|
| R5.1-P0-01 | P0 | Sau POST chỉ kiểm tra bucket tồn tại; không xác minh metadata thực tế khớp backup source | Baseline `restoreStorage` gọi `getBucket` sau POST nhưng chỉ fail khi `!existing`; không so sánh 5 trường |
| R5.1-P0-02 | P0 | Live PostgreSQL 17 test bị SKIP trong CI khi thiếu container | Baseline `owner-map.test.mjs` gọi `t.skip(...)` vô điều kiện khi `isDockerContainerAvailable` trả false |
| R5.1-P1-01 | P1 | Bucket đã tồn tại được kiểm tra một phần, dùng ép kiểu lossy | Baseline dùng `Boolean(existing.public)`, chỉ kiểm tra `file_size_limit` khi source khác `null`, và chỉ kiểm tra MIME khi source khác `null` |
| R5.1-P1-02 | P1 | Metadata thiếu trường nullable bị coi là “unrestricted” | Baseline coi `undefined`/thiếu trường tương đương `null`; không phân biệt metadata không đầy đủ với giá trị hợp lệ |
| R5.1-P1-03 | P1 | So sánh MIME theo chuỗi thô, không theo semantics Storage API | Baseline sort và `join(',')`; không chuẩn hóa case, parameters, duplicate; không phân biệt `null` và `[]` |
| R5.1-P1-04 | P1 | `createBucket` ép kiểu trước khi gửi payload | Baseline gửi `Boolean(bucketConfig.public)` và biến non-number thành `null`, non-array thành `null` |
| R5.1-P1-05 | P1 | CI không provision PostgreSQL 17, không cleanup/diagnostics | Baseline workflow không có bước start/stop container; `backup-restore-ci.yml` timeout 15 phút |
| R5.1-P1-06 | P1 | Python backup test thiếu env trỏ tới export helper | Baseline `test:backup:python` không đặt `SAFE_EXTRACT_EXPORT_HELPER` |

Các finding R2–R5 trước đó (AES-GCM streaming, offsite bundle, safe extract, owner map, storage export) vẫn được giữ nguyên và chạy lại trong regression suite.

---

## 3. Root Cause

### 3.1. Bucket parity

Root cause là **niềm tin vào sự tồn tại thay vì niềm tin vào dữ liệu đọc lại**. Luồng cũ:

```text
GET bucket
  ├─ không có  → POST create → GET lại → chỉ kiểm tra “có tồn tại”
  └─ có        → so sánh public bằng Boolean(...)
                 so sánh file_size_limit chỉ khi source khác null
                 so sánh MIME bằng chuỗi sort/join
```

Ba lỗi hệ quả:

1. **Thiếu trường bị coi là hợp lệ:** `undefined` và `null` bị xử lý như nhau, nên metadata không đầy đủ có thể PASS.
2. **Ép kiểu che giấu sai lệch:** `Boolean('false') === true`, `typeof '1024' !== 'number'` bị biến thành `null`, mảng lẫn phần tử lạ vẫn có thể lọt.
3. **So sánh MIME không cùng semantics:** Storage API chuẩn hóa chữ hoa/thường, tham số và thứ tự; so sánh chuỗi thô tạo cả false positive lẫn false negative.

### 3.2. Live PostgreSQL 17

Root cause là **skip-based CI**: test quan trọng nhất của Helper #6 tự động SKIP khi không có container, trong khi workflow không hề tạo container. Kết quả là CI xanh nhưng integration path chưa từng chạy. Thiếu đồng thời:

- provisioning PostgreSQL 17 disposable;
- health/version verification trước test;
- cơ chế biến “không có container” thành FAIL trong CI;
- cleanup và diagnostics khi lỗi.

### 3.3. CI hardening

Workflow cũ không có timeout phù hợp, không có concurrency guard, không có bước thu log PostgreSQL khi failure, và không đặt `SAFE_EXTRACT_EXPORT_HELPER` ở cấp `package.json`. Những điểm này không trực tiếp gây sai logic nhưng làm CI khó chẩn đoán và dễ tạo green giả.

---

## 4. Các File Đã Thay Đổi

### 4.1. Implementation Commit `364d809`

| Tệp | Loại | Nội dung |
|---|---|---|
| `scripts/backup/storage-restore.mjs` | Modified | Strict bucket input validation, MIME normalization, `verifyTargetBucketParity`, read-back sau POST, gate trước object upload |
| `tests/backup/storage-restore.test.mjs` | Modified | Bổ sung/hoàn thiện regression P2-BUCKET-04/05/06; tổng 85 test Helper #5 |
| `tests/backup/owner-map.test.mjs` | Modified | Live PostgreSQL 17 test fail thay vì skip khi CI/bắt buộc |
| `scripts/backup/ci-postgres17.sh` | **New** | Provision/health/version/marker/teardown/log cho PostgreSQL 17 disposable |
| `.github/workflows/backup-restore-ci.yml` | Modified | Provision PG17, mandatory live gate, diagnostics, teardown, timeout, concurrency, `git diff --check` |
| `.github/workflows/verify.yml` | Modified | Provision PG17 trước `npm run test:backup`, diagnostics, teardown, mandatory live gate |
| `package.json` | Modified | `test:backup:python` đặt `SAFE_EXTRACT_EXPORT_HELPER=scripts/backup/storage-export.mjs` |

### 4.2. Tài liệu

| Tệp | Trạng thái |
|---|---|
| `docs/META_ADS_CI_REMEDIATION_REPORT_R5_1_FINAL.md` | **New** — báo cáo này |
| `docs/META_ADS_CI_REMEDIATION_REPORT_R2.md` … `R5.md` | Giữ nguyên, commit kèm để bảo toàn lịch sử remediation |
| `docs/META_ADS_CI_REMEDIATION_REPORT_R5_1.md` | Thêm banner **SUPERSEDED** trỏ tới báo cáo FINAL |

### 4.3. SHA-256 của các tệp thay đổi

```text
5556cd08527a8ae43af37611f2dd4044c5d9b02c1fce4d01e7710c6212d884d0  .github/workflows/backup-restore-ci.yml
c81c8a594eb85812b2013bff5aa76225644d6d7e9a5dedcc89aedb43fd5b2b64  .github/workflows/verify.yml
5b46041e59342bbd56799c7fddda1ec1b638605a3db3f6746aa197ee4ddf9870  package.json
84612104ce7cb3516620d39c0a26033f856c0f049082a46846f17b77c10291e6  scripts/backup/storage-restore.mjs
3aae412639269fa92623c557e4e4134b6a1872cfe1cbcd8da147b92c2ea80a3e  scripts/backup/ci-postgres17.sh
ba4e334c5cc26fa84dbc602ce0a8292d39b851ba3cb329df45fde45685ab5bdc  tests/backup/owner-map.test.mjs
37fcee1cc11ff6dc0cf46b4ee3d28e96dbfda6986a0066b0cf1707d98ed0ce0b  tests/backup/storage-restore.test.mjs
```

---

## 5. Giải Pháp Kỹ Thuật

### 5.1. `verifyTargetBucketParity(existing, bucket)`

Helper dùng chung, áp dụng cho **cả bucket mới tạo và bucket đã tồn tại**:

- `id`: phải là string và khớp chính xác.
- `name`: phải là string và khớp chính xác.
- `public`: phải là boolean thật; so sánh trực tiếp, không `Boolean(...)`.
- `file_size_limit`: bắt buộc có own property; chỉ chấp nhận `null` hoặc số nguyên không âm an toàn (`Number.isSafeInteger`).
- `allowed_mime_types`: bắt buộc có own property; chỉ chấp nhận `null` hoặc mảng string MIME hợp lệ.

Quy tắc quan trọng:

- **Thiếu trường nullable = metadata không đầy đủ = FAIL.** Chỉ `null` tường minh mới biểu diễn “unrestricted”.
- `null` và `[]` là hai giá trị khác nhau: `null` = không giới hạn; `[]` = allow-list rỗng.
- Mọi mismatch trả `BUCKET_CONFIGURATION_MISMATCH`; message nêu bucket và trường, không chứa credential.

### 5.2. Chuẩn hóa MIME theo semantics Supabase Storage

`normalizeMimeTypeEntry` và `normalizeAllowedMimeTypes`:

- trim khoảng trắng;
- lowercase `type` và `subtype`;
- bỏ parameters (`; charset=...`) theo parser token/quoted-string;
- từ chối wildcard không hợp lệ; chỉ chấp nhận subtype `*` đơn lẻ;
- giới hạn độ dài entry 1000 ký tự;
- loại duplicate;
- so sánh order-insensitive sau khi sort canonical;
- giữ nguyên phân biệt `null` vs `[]`.

### 5.3. Create/read-back/verify

`StorageRestoreClient.createBucket` gửi nguyên giá trị đã validate, không ép kiểu. `restoreStorage`:

```text
GET bucket
  ├─ không có → POST create → GET read-back bắt buộc
  └─ có
→ verifyTargetBucketParity(existing, bucket)
→ chỉ sau khi PASS mới upload object
```

POST response không được dùng làm bằng chứng duy nhất. Nếu read-back không thấy bucket, fail với `BUCKET_CONFIGURATION_MISMATCH`.

### 5.4. Strict input validation

`validateRestoreInputs` từ chối:

- `public` không phải boolean;
- `file_size_limit` không phải số nguyên không âm hoặc `null`;
- `allowed_mime_types` không phải mảng string MIME hợp lệ hoặc `null`;
- `name` rỗng, không phải string, hoặc quá dài.

### 5.5. Live PostgreSQL 17 bắt buộc

```js
const liveRequired =
  process.env.BACKUP_REQUIRE_LIVE_PG17 === '1' || process.env.CI === 'true';
```

- `liveRequired` và container không sẵn sàng → `assert.fail(...)`, exit 1, message “refusing to skip”.
- Local reviewer không đặt biến → SKIP kèm hướng dẫn đặt `BACKUP_REQUIRE_LIVE_PG17=1`.
- Negative fixture `nonexistent-container-xyz` vẫn SKIP có chủ đích.

### 5.6. `scripts/backup/ci-postgres17.sh`

- Guard local-only: từ chối `DOCKER_HOST`/`DOCKER_CONTEXT` trỏ remote.
- Xóa container cũ nếu có, chạy image `public.ecr.aws/supabase/postgres:17.11.0.004`.
- `--network none`; không kết nối staging/Production.
- Chờ Supabase init hand-off `PostgreSQL init process complete; ready for start up.` trước khi probe server cuối.
- `pg_isready` + `SELECT 1`, kiểm tra `server_version_num` khớp `^17[0-9]{4}$`.
- Tạo marker table/comment để xác nhận đúng database disposable.
- Hỗ trợ `start`, `stop`, `logs`; teardown idempotent.

### 5.7. CI workflow

- Job-level `BACKUP_REQUIRE_LIVE_PG17=1`.
- Start PG17 trước test; diagnostics `if: failure()`; teardown `if: always()`.
- `timeout-minutes: 20` (Backup) và `25` (Verify).
- `concurrency` nhóm theo ref, `cancel-in-progress: true`.
- `git diff --check` trong Backup CI; Verify chạy step tương ứng.
- Không in secret; chỉ dùng password disposable mặc định `localonly` cho container local.

---

## 6. Regression Tests

### 6.1. Phạm vi P2-BUCKET

| Nhóm | Số test | Nội dung |
|---|---:|---|
| `P2-BUCKET-04` | 4 | Explicit `null` hợp lệ; thiếu `file_size_limit`; thiếu `allowed_mime_types`; `null` vs `[]` |
| `P2-BUCKET-05` | 13 | Strict type cho input và target: boolean/string/number/array/null |
| `P2-BUCKET-06` | 15 | Post-create parity, missing fields, wrong id/name/public/limit/MIME, `file_size_limit: 0`, request sequence, no upload, no report, MIME normalization, existing bucket incomplete |
| **Tổng bucket tests** | **32** | Tất cả PASS |

Các test trọng yếu:

- `P2-BUCKET-06-09`: post-create GET thiếu `name` → FAIL.
- `P2-BUCKET-06-10`: post-create GET thiếu `public` → FAIL.
- `P2-BUCKET-06-11`: post-create GET thiếu `id` → FAIL.
- `P2-BUCKET-06-12`: request sequence đúng `GET (404) → POST → GET`, không có object request trước parity PASS.
- `P2-BUCKET-06-13`: MIME khác case/thứ tự/duplicate nhưng cùng semantics → PASS.
- `P2-BUCKET-06-14`: name bị đổi sau POST → FAIL.
- `P2-BUCKET-06-15`: bucket đã tồn tại thiếu `file_size_limit` → FAIL.
- `P2-BUCKET-04-02/03/04`: missing nullable field và `null` vs `[]` → FAIL đúng thiết kế.
- `P2-BUCKET-06-06/07`: không upload object, không tạo success report khi parity FAIL.

### 6.2. RED/GREEN evidence

Trong một **bản copy cách ly** tại `/private/var/folders/.../T/opencode/r5_1-final-red`, lời gọi `verifyTargetBucketParity(existing, bucket)` bị comment out. Workspace thật không bị sửa.

```text
✖ P2-BUCKET-04-02: fails closed when target GET omits file_size_limit
✖ P2-BUCKET-04-03: fails closed when target GET omits allowed_mime_types
✖ P2-BUCKET-04-04: rejects an empty MIME array when source is unrestricted null
✖ P2-BUCKET-06-12: performs POST then independent GET read-back before any object upload
✖ P2-BUCKET-06-14: fails closed when post-create GET returns a different bucket name
✖ P2-BUCKET-06-15: fails closed when an existing target bucket omits nullable metadata
ℹ tests 6
ℹ pass 0
ℹ fail 6
```

Trên source thật, 85/85 Helper #5 PASS. Điều này chứng minh các test thực sự bắt được việc bỏ parity gate, không phải test trang trí.

### 6.3. Kết quả local đầy đủ

```text
npm run test:backup
  JS:     296 tests, 17 suites, 295 pass, 0 fail, 1 skip, 0 todo
  Python: 71 tests OK + 4 tests OK = 75 pass
  Exit:   0
```

SKIP duy nhất:

```text
﹣ R2-P2-02: live integration test skips cleanly when container is unavailable
  # Container 'nonexistent-container-xyz' is not available; test skipped as intended.
```

Đây là negative fixture có chủ đích, không tính là PASS và không che giấu test bắt buộc.

---

## 7. PostgreSQL 17 Live Integration Evidence

### 7.1. Local

Container:

```text
image: public.ecr.aws/supabase/postgres:17.11.0.004
server_version_num: 170011
version: PostgreSQL 17.11 on aarch64-unknown-linux-gnu, compiled by gcc (GCC) 15.2.0, 64-bit
```

Test:

```text
✔ Live PostgreSQL 17 integration: full plan -> apply -> verify cycle with live catalog and rollback (2275.055791ms)
```

### 7.2. GitHub Actions — Backup CI run `41596680444`

```text
PostgreSQL server_version_num=170011
PostgreSQL 17.11 on x86_64-pc-linux-gnu, compiled by gcc (GCC) 15.2.0, 64-bit
Disposable marker verified; PostgreSQL 17 target is ready.
ok 32 - Live PostgreSQL 17 integration: full plan -> apply -> verify cycle with live catalog and rollback
ok 88 - R2-P2-02: live integration test skips cleanly when container is unavailable
        # SKIP Container 'nonexistent-container-xyz' is not available; test skipped as intended.
```

### 7.3. GitHub Actions — Verify CI run `41596680518`

```text
PostgreSQL server_version_num=170011
PostgreSQL 17.11 on x86_64-pc-linux-gnu, compiled by gcc (GCC) 15.2.0, 64-bit
Disposable marker verified; PostgreSQL 17 target is ready.
ok 32 - Live PostgreSQL 17 integration: full plan -> apply -> verify cycle with live catalog and rollback
```

### 7.4. Fail-not-skip verification

Khi giả lập container không sẵn sàng bằng `DOCKER_HOST=tcp://127.0.0.1:9`:

```text
$ CI=true BACKUP_REQUIRE_LIVE_PG17=1 DOCKER_HOST=tcp://127.0.0.1:9 \
    node --test --test-name-pattern='Live PostgreSQL 17 integration' tests/backup/owner-map.test.mjs
EXIT_CODE=1
✖ Live PostgreSQL 17 integration: full plan -> apply -> verify cycle with live catalog and rollback
  AssertionError: Docker container 'crm-dumpcheck-test' is not available for live PostgreSQL 17 tests.
  This test is mandatory in CI (BACKUP_REQUIRE_LIVE_PG17=1 or CI=true); refusing to skip.
ℹ tests 1
ℹ pass 0
ℹ fail 1
ℹ skipped 0
```

Khi chạy local không đặt biến bắt buộc:

```text
$ env -u CI -u BACKUP_REQUIRE_LIVE_PG17 DOCKER_HOST=tcp://127.0.0.1:9 \
    node --test --test-name-pattern='Live PostgreSQL 17 integration' tests/backup/owner-map.test.mjs
EXIT_CODE=0
﹣ Live PostgreSQL 17 integration ... # Docker container ... Set BACKUP_REQUIRE_LIVE_PG17=1 to make this a hard failure.
ℹ skipped 1
```

### 7.5. Remote Docker guard

```text
$ DOCKER_HOST=tcp://example.invalid:2375 ./scripts/backup/ci-postgres17.sh start
EXIT_CODE=1
ERROR: refusing remote DOCKER_HOST (tcp://example.invalid:2375);
live tests require the local Docker socket
```

---

## 8. CI Workflow Results

### 8.1. GitHub Actions runs cho commit `364d809`

| Workflow | Event | Run | Kết quả | Thời gian |
|---|---|---|---:|---|
| Backup & Restore CI (Helpers #1-#6) | `pull_request` | [`41596680444`](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/actions/runs/41596680444) | **SUCCESS** | 07:29:47 → 07:31:41 UTC |
| Backup & Restore CI (Helpers #1-#6) | `push` | [`41596675060`](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/actions/runs/41596675060) | **SUCCESS** | 07:29:44 → 07:31:58 UTC |
| Verify | `pull_request` | [`41596680518`](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/actions/runs/41596680518) | **SUCCESS** | 07:29:47 → 07:43:25 UTC |

### 8.2. Step-level evidence — Backup CI

```text
✓ Run npm ci
✓ Syntax & Lint Check
✓ Start disposable PostgreSQL 17 (Helper #6)
✓ Run JavaScript Helpers Tests (Helpers #1-#6)
✓ Run Python Safe Extract & Runbook Tests (Helper #4)
- PostgreSQL 17 diagnostics (on failure)   [skipped because no failure]
✓ Teardown disposable PostgreSQL 17
✓ Check whitespace errors
✓ Complete job
```

### 8.3. Step-level evidence — Verify CI

Các bước liên quan trực tiếp:

```text
✓ Start disposable PostgreSQL 17 (Helper #6)
✓ Run backup/restore regression tests (Helpers #1-#6)
- PostgreSQL 17 diagnostics (on failure)   [skipped because no failure]
✓ Teardown disposable PostgreSQL 17
✓ Run npm run typecheck
✓ Run npm run lint
✓ Run npm run build
✓ Run git diff --check
✓ Complete job
```

Toàn bộ 52 step của job `checks` đều SUCCESS. Không có step nào bị skipped ngoài diagnostics-on-failure.

### 8.4. CI test counts

```text
# tests 296
# suites 17
# pass 295
# fail 0
# cancelled 0
# skipped 1
# todo 0

Ran 71 tests ... OK
Ran 4 tests ... OK
```

`# skipped 1` là negative fixture `nonexistent-container-xyz`; live PostgreSQL 17 test là `ok 32`, không nằm trong skipped.

---

## 9. Security Review

| Hạng mục | Cách kiểm chứng | Kết quả |
|---|---|---|
| Không upload object khi parity FAIL | `P2-BUCKET-06-06`, `06-12`, `06-14`, `06-15` assert `objects.size === 0` và không có object request | **PASS** |
| Không tạo success report khi parity FAIL | `P2-BUCKET-06-07`, `06-09/10/11` assert report path `ENOENT` | **PASS** |
| Không ép kiểu boolean | `typeof public !== 'boolean'`; so sánh trực tiếp | **PASS** |
| Không ép kiểu số/array | Strict `Number.isSafeInteger`, `Array.isArray`, parser MIME | **PASS** |
| Metadata thiếu không được coi là unrestricted | `hasOwn` cho `file_size_limit` và `allowed_mime_types` | **PASS** |
| `null` khác `[]` | `P2-BUCKET-04-04` reject `[]` khi source `null` | **PASS** |
| Không lộ credential trong error | Message chỉ chứa bucket id và tên trường; không log token/password | **PASS** |
| Không kết nối Staging/Production | Container `--network none`; image disposable; không dùng production credentials | **PASS** |
| Không dùng remote Docker host | Script từ chối `DOCKER_HOST`/`DOCKER_CONTEXT` không phải local socket | **PASS** (exit 1) |
| PostgreSQL version enforcement | `server_version_num` phải khớp `^17[0-9]{4}$` | **PASS** — 170011 |
| Target identity/URL allowlist | Không thay đổi guard hiện có; regression Helper #5 PASS | **PASS** |
| SQL injection / owner map | Helper #6 regression PASS; không nới lỏng identifier validation | **PASS** |
| Object overwrite protection | Test `--no-upsert` hiện có PASS trong full suite | **PASS** |
| Secret scan trên diff | Không có credential thật mới; chuỗi JWT duy nhất là demo key đã có sẵn trong baseline `verify.yml` | **PASS** |

### 9.1. Residual dependency risk

`npm ci` báo:

```text
21 vulnerabilities (16 moderate, 4 high, 1 critical)
```

`npm audit --omit=dev`:

```text
4 vulnerabilities (3 high, 1 critical)
```

Đây là **dependency debt pre-existing**, không do thay đổi Round 5.1 tạo ra và không nằm trong phạm vi backup/restore. Không tự ý nâng dependency ngoài phạm vi PR. Cần ticket riêng và đánh giá compatibility trước khi Production.

---

## 10. Các Test PASS

### 10.1. Local

| Lệnh / nhóm | Kết quả | Exit |
|---|---|---:|
| `npm ci` | 439 packages installed | 0 |
| `npm run test:backup:helpers` (trong `test:backup`) | 296 tests — 295 pass, 0 fail, 1 intentional skip | 0 |
| `npm run test:backup:python` | 71 + 4 = 75 pass | 0 |
| `npm run test:backup` | JS + Python toàn bộ | 0 |
| Helper #5 full suite | 85 pass, 0 fail | 0 |
| `P2-BUCKET-06-09/10/11` targeted | 3 pass | 0 |
| `npm run typecheck` | `next typegen && tsc --noEmit` | 0 |
| `npm run lint` | 0 errors, 16 warnings pre-existing | 0 |
| `npm run build` với env CI | Build thành công | 0 |
| `git diff --check` | Không whitespace error | 0 |
| ESLint trên file thay đổi | Không error | 0 |
| YAML parse hai workflow | Hợp lệ | 0 |
| `bash -n scripts/backup/ci-postgres17.sh` | Hợp lệ | 0 |
| Remote Docker guard | Từ chối đúng | 1 (expected) |
| CI-required live gate thiếu container | Fail đúng, không skip | 1 (expected) |
| Local live gate thiếu container | Skip có chủ đích | 0 |

### 10.2. GitHub Actions

| Check | Kết quả |
|---|---|
| Backup Helpers (#1-#6) — PR | **SUCCESS** |
| Backup Helpers (#1-#6) — push | **SUCCESS** |
| Verify `checks` — PR | **SUCCESS** |
| Live PostgreSQL 17 integration trong CI | **PASS**, `ok 32` |
| Plan → Apply → Verify | **PASS** |
| Rollback integration | **PASS** |
| Typecheck trong CI | **SUCCESS** |
| Lint trong CI | **SUCCESS** |
| Build trong CI | **SUCCESS** |
| `git diff --check` trong CI | **SUCCESS** |

---

## 11. Các Test FAIL / SKIP

### 11.1. FAIL

**Không có FAIL** trong các suite bắt buộc ở local và trên GitHub Actions.

Các exit 1 dưới đây là **negative test có chủ đích**, không phải regression:

| Tình huống | Exit | Kết luận |
|---|---:|---|
| CI bắt buộc live PG17 nhưng container không có | 1 | Đúng thiết kế — “refusing to skip” |
| `ci-postgres17.sh` với remote `DOCKER_HOST` | 1 | Đúng thiết kế — từ chối remote Docker |
| Bản copy cách ly bỏ parity gate, chạy 6 test mới | 1 | Đúng thiết kế — 6/6 test FAIL (RED evidence) |

### 11.2. SKIP

Chỉ một SKIP trong toàn bộ JS suite:

```text
R2-P2-02: live integration test skips cleanly when container is unavailable
Container 'nonexistent-container-xyz' is not available; test skipped as intended.
```

Đây là **negative fixture** kiểm tra hành vi skip khi container không tồn tại. Nó không thay thế test live PostgreSQL 17 thật, và test thật đã chạy PASS trong cả hai workflow CI.

### 11.3. Lưu ý về build local

`npm run build` **không có** `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` sẽ fail ở bước prerender `/` và `/account`:

```text
Error: Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY.
```

Đây là yêu cầu môi trường của ứng dụng, không phải lỗi do thay đổi backup. Khi chạy với đúng env demo mà `verify.yml` cung cấp, build exit 0. Trong CI, step `npm run build` đã SUCCESS.

### 11.4. Công cụ không có sẵn

- `shellcheck` không được cài trong môi trường local; chỉ chạy `bash -n` (PASS).
- Không chạy `actionlint`; YAML được parse bằng Ruby Psych (PASS) và GitHub Actions đã thực thi thành công.

---

## 12. Git Commit SHA

| Mốc | SHA |
|---|---|
| Baseline trước Round 5.1 | `b0bf2d65c0ee049e1a1a36f10f0aab23c851a06a` |
| Implementation commit (source/test/CI) | `364d809ad449edd6c665dbe7ee55e4540987e125` |
| Commit tài liệu FINAL | Tạo ngay sau báo cáo này; xem PR #140 head |

Commit implementation đã push lên `origin/integration/meta-ads-backup-restore`, không force push, không rewrite history.

```text
364d809 fix(backup): enforce full bucket parity and live PG17 CI gate
b0bf2d6 fix(backup): remediate CI failures for helpers #4, #5, and #6
49811b6 feat(backup): integrate helpers 1-6, contracts, runbook v12, and CI verification
```

---

## 13. PR #140 Status

| Thuộc tính | Giá trị |
|---|---|
| PR | [#140](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/pull/140) |
| State | **OPEN** |
| Base | `meta_ads_integration` |
| Head | `integration/meta-ads-backup-restore` |
| Mergeable | **MERGEABLE** |
| Draft | Ban đầu `true`; chuyển Ready sau khi commit tài liệu và CI lần cuối xanh |
| Merge | **KHÔNG** — chờ Independent Review |
| Deploy | **KHÔNG** — không có deployment nào được thực hiện |

Trạng thái check trên commit `364d809`:

```text
Backup & Restore CI (Helpers #1-#6) / Backup Helpers  → SUCCESS
Backup & Restore CI (Helpers #1-#6) / Backup Helpers  → SUCCESS (push)
Verify / checks                                       → SUCCESS
```

PR #139 vẫn là Draft và **không bị sửa, không bị merge**. Branch `main` và Production không bị thay đổi.

---

## 14. Remaining Blockers

### 14.1. Trong phạm vi PR #140

**Không còn blocker kỹ thuật** cho backup/restore theo các acceptance criteria đã nêu. Live PostgreSQL 17 đã chạy thật trong CI; bucket parity fail-closed đã được kiểm chứng; toàn bộ regression pass.

### 14.2. Ngoài phạm vi PR / cần theo dõi

| Hạng mục | Mức độ | Ghi chú |
|---|---|---|
| `npm audit` production dependencies | High/Critical (pre-existing) | 4 production vulnerabilities (3 high, 1 critical); cần ticket riêng, không sửa trong PR này |
| Staging rehearsal với Supabase Storage thật | Bắt buộc trước Production | Test hiện tại dùng mock Storage API; live PG chỉ bao phủ catalog/owner-map. Cần chạy runbook trên staging theo quy trình |
| Teardown failure-path trên GitHub Actions | Thấp | Workflow dùng `if: always()`; teardown success-path đã chạy. Chưa mô phỏng một failure giữa chừng trên GitHub để quan sát teardown |
| Node 20 action deprecation warnings | Thấp | `actions/checkout@v4`, `setup-node@v4`, `setup-python@v5` bị runner ép Node 24; không ảnh hưởng kết quả |
| Independent Review | Bắt buộc | PR chưa được review độc lập; không tự tuyên bố ACCEPTED |
| Production deployment | Bắt buộc tách bước | Không thực hiện trong PR này; cần release riêng sau nghiệm thu |

---

## 15. Production Readiness Assessment

### 15.1. Kết luận

**PR #140 đạt trạng thái READY FOR INDEPENDENT REVIEW trong phạm vi Backup/Restore Helpers #1–#6.**

Các lý do:

- Bucket metadata parity được xác minh đầy đủ năm trường, fail closed trước object upload.
- Live PostgreSQL 17 integration chạy thật trong cả Backup CI và Verify CI, không SKIP.
- Plan → Apply → Verify → Rollback PASS trên PostgreSQL 17.11.
- Regression Helpers #1–#6 PASS; Python safe-extract/runbook PASS.
- Typecheck, lint, build, `git diff --check` PASS trong CI.
- Security guard cho Docker local-only, version enforcement, object upload gate, report gate đều PASS.
- Không có credential mới, không kết nối Staging/Production, không deploy.

### 15.2. Điều kiện trước khi Production

PR này **chưa phải là approval triển khai Production**. Trước khi release:

1. Independent Review chấp thuận PR #140.
2. Chạy staging rehearsal theo runbook v12 với Supabase Storage thật, bao gồm empty buckets, Unicode paths, MIME restrictions và rollback.
3. Xử lý hoặc chấp nhận rủi ro dependency `npm audit` theo quy trình security riêng.
4. Release PR #139/#140 theo quy trình được phê duyệt; không deploy trực tiếp từ branch này.
5. Xác nhận đúng Production target và có backup/rollback plan trước migration.

### 15.3. Tuyên bố cuối

> Báo cáo này chỉ ghi nhận các kết quả **đã thực thi thật** ở local và trên GitHub Actions. Không có PASS nào được suy đoán. Không merge, không deploy, không thay đổi Production database, không sửa `main`, không merge PR #139.

**Bàn giao cho Independent Review Round 5.1.**
