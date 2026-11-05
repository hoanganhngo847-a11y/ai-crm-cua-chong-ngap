# BÁO CÁO REMEDIATION CI & CODE REVIEW ROUND 5 — PR #140
## HELPER #5: POST-CREATE BUCKET PARITY VERIFICATION & ACCEPTANCE FIX

**Tài liệu:** `docs/META_ADS_CI_REMEDIATION_REPORT_R5.md`
**Dự án:** Meta Ads Backup/Restore Pipeline
**Repository:** `hoanganhngo847-a11y/ai-crm-cua-chong-ngap`
**PR:** #140 (`feat(backup): integrate helpers 1-6, contracts, runbook v12, and CI verification`)
**Branch:** `integration/meta-ads-backup-restore`
**Baseline Commit:** `b0bf2d65c0ee049e1a1a36f10f0aab23c851a06a`
**Workspace:** `/Users/hoangthuy/.gemini/antigravity/worktrees/ai-crm-cua-chong-ngap/ci_remediation_backup_helpers`
**Ngày thực hiện:** 2026-11-03
**Đối tượng bàn giao:** Independent Code Review Round 5, Platform & Database Custodians
**Trạng thái Remediation Round 5:** **READY FOR INDEPENDENT REVIEW — không tự tuyên bố ACCEPTED**

> **CORRECTION NOTICE — Round 5.1 (2026-11-03):** Báo cáo này đã được chỉnh sửa theo finding **R5.1-02**.
> - Mô tả `Boolean(...)` trong Mục 3.1 là **logic cũ trước remediation**, không phải logic hiện tại. Source hiện tại dùng kiểm tra kiểu nghiêm ngặt (`typeof existing.public === 'boolean'` và so sánh trực tiếp).
> - `.github/workflows/backup-restore-ci.yml` và `package.json` là thay đổi **đã tồn tại từ Round 2**, không phải thay đổi của Round 5/5.1.
> - Số liệu test, regression và checksum hiện hành của Round 5.1 được ghi tại `docs/META_ADS_CI_REMEDIATION_REPORT_R5_1.md`.

---

## 1. Baseline Branch, HEAD và Workspace

| Mục | Chi tiết |
|---|---|
| **Repository** | `hoanganhngo847-a11y/ai-crm-cua-chong-ngap` |
| **Workspace Worktree** | `/Users/hoangthuy/.gemini/antigravity/worktrees/ai-crm-cua-chong-ngap/ci_remediation_backup_helpers` |
| **Branch yêu cầu** | `integration/meta-ads-backup-restore` |
| **Base Commit SHA** | `b0bf2d65c0ee049e1a1a36f10f0aab23c851a06a` |
| **Node.js Runtime** | `v24.15.0` (Darwin arm64) |
| **Python Runtime** | `Python 3.14.0` |

---

## 2. Danh Sách Các Tệp Đã Chỉnh Sửa

### 2.1. Tệp được chỉnh sửa trong Round 5

Tuân thủ nghiêm ngặt phạm vi cho phép của Round 5, chỉ có đúng hai tệp sau được chỉnh sửa:

1. `scripts/backup/storage-restore.mjs` (Helper #5 source)
2. `tests/backup/storage-restore.test.mjs` (Helper #5 test suite & mock storage server)

Các tệp thuộc Helper #1–#4, Helper #6, Runbook v12, database migrations và cấu hình production hoàn toàn **nguyên bản** và không bị thay đổi trong Round 5.

### 2.2. Thay đổi đã tồn tại từ Round 2 (không thuộc Round 5/5.1)

So với baseline commit `b0bf2d6`, working tree còn hiển thị hai tệp đã bị sửa bởi **Round 2** và không được Round 3, 4, 5 hay 5.1 chạm tới:

1. `.github/workflows/backup-restore-ci.yml` — thay đổi F-02/F-03 của Round 2 (disposable PostgreSQL 17 container, syntax/ESLint cho Helper #5, `SAFE_EXTRACT_EXPORT_HELPER`).
2. `package.json` — thay đổi F-03 của Round 2 (thêm `SAFE_EXTRACT_EXPORT_HELPER` vào script `test:backup:python`).

Hai tệp này giữ nguyên SHA-256 qua các Round 3–5.1. Việc chúng xuất hiện trong `git status` là do các thay đổi Round 2 chưa được commit, **không phải** thay đổi mới của Round 5.

---

## 3. Phân Tích Nguyên Nhân Cốt Lõi và Biện Pháp Khắc Phục (Root Cause & Remediation)

### 3.1. Finding R5-01 (Mức độ P2): Missing Post-Create Bucket Configuration Verification

#### Logic cũ trước remediation (nguyên nhân lỗi)

Trong `restoreStorage()`, khi bucket chưa tồn tại trên target (`!existing`), Helper #5 gọi `client.createBucket(bucket)`, sau đó chỉ gọi `await client.getBucket(bucket.id)` để kiểm tra **sự tồn tại**, không đối chiếu metadata thực tế sau khi tạo (`id`, `name`, `public`, `file_size_limit`, `allowed_mime_types`). Vì vậy bucket vừa tạo hoàn toàn không được xác minh cấu hình trước khi upload object.

Với bucket đã tồn tại, logic cũ chỉ kiểm tra một phần và có ép kiểu ngầm định:
- `public`: so sánh bằng `Boolean(existing.public) !== Boolean(bucket.public)`, khiến chuỗi `"false"` bị coi là `true` và che giấu lỗi kiểu dữ liệu.
- `file_size_limit`: chỉ so sánh khi source khác `null`.
- `allowed_mime_types`: chỉ so sánh khi source khác `null`, không kiểm tra kiểu từng phần tử.
- `id` và `name`: không được kiểm tra.

Hệ quả: nếu Storage API trả về thiếu trường hoặc sai kiểu, restore vẫn có thể tiếp tục upload object vào bucket có cấu hình sai lệch mà không fail-closed.

#### Logic hiện tại sau remediation

1. Xây dựng hàm độc lập `verifyTargetBucketParity(existing, bucket)` kiểm chứng nghiêm ngặt 5 thuộc tính:
   - `id`: Bắt buộc là chuỗi và khớp chính xác.
   - `name`: Bắt buộc là chuỗi và khớp chính xác.
   - `public`: Bắt buộc `typeof existing.public === 'boolean'`, sau đó so sánh trực tiếp `existing.public !== bucket.public`. **Không dùng `Boolean(...)` và không có ép kiểu ngầm định.**
   - `file_size_limit`: Bắt buộc là số nguyên an toàn không âm hoặc `null`/`undefined` (unrestricted), đối chiếu nullish (`existing.file_size_limit ?? null` với `bucket.file_size_limit ?? null`).
   - `allowed_mime_types`: Bắt buộc là mảng các chuỗi MIME hợp lệ theo RFC media regex hoặc `null`/`undefined` (unrestricted), đối chiếu mảng đã chuẩn hóa và sắp xếp (`sort()`).
2. Tái cấu trúc luồng tạo bucket trong `restoreStorage()`:
   - Gọi `client.createBucket(bucket)` qua Storage API POST.
   - Đọc lại trực tiếp metadata từ Storage API qua `GET /storage/v1/bucket/:id`; không dựa riêng vào body response của lệnh POST.
   - Bắt buộc chạy `verifyTargetBucketParity(existing, bucket)` cho **cả bucket vừa tạo mới lẫn bucket đã tồn tại từ trước**.
3. Fail-closed: nếu metadata bị thiếu, sai kiểu hoặc không khớp backup, ném ngay `BUCKET_CONFIGURATION_MISMATCH` với message nêu rõ trường không hợp lệ.
4. Quy trình dừng tại Bước 6 (Restore Buckets), bảo đảm **không upload bất kỳ object nào** (Bước 7) và **không ghi report thành công** (Bước 8).
5. Không tự động sửa lỗi cấu hình bằng PATCH/PUT hoặc ghi đè bucket.

### 3.2. Finding R5-02: Missing Regression Coverage
- **Root Cause:**
  Chưa có các test case tái hiện trường hợp POST tạo bucket thành công nhưng GET đọc lại trả về metadata sai lệch (`public`, `file_size_limit`, `allowed_mime_types`, `id/name`), cũng như chưa chứng minh được việc không upload object và không tạo report khi xác minh thất bại.
- **Remediation:**
  Bổ sung 8 synthetic regression tests có tên và mục đích rõ ràng (nối tiếp sau `P2-BUCKET-05-13`):
  - `P2-BUCKET-06-01`: POST tạo thành công nhưng GET trả về `public` sai -> fail closed với `BUCKET_CONFIGURATION_MISMATCH`.
  - `P2-BUCKET-06-02`: POST tạo thành công nhưng GET trả về `file_size_limit` sai -> fail closed với `BUCKET_CONFIGURATION_MISMATCH`.
  - `P2-BUCKET-06-03`: POST tạo thành công nhưng GET trả về `allowed_mime_types` sai -> fail closed với `BUCKET_CONFIGURATION_MISMATCH`.
  - `P2-BUCKET-06-04`: POST tạo thành công nhưng GET trả về thiếu metadata hoặc sai `id/name` -> fail closed với `BUCKET_CONFIGURATION_MISMATCH`.
  - `P2-BUCKET-06-05`: POST tạo thành công và GET trả về cấu hình khớp hoàn toàn -> PASS `status: 'success'`.
  - `P2-BUCKET-06-06`: Chứng minh không upload bất kỳ object nào lên target API khi xác minh metadata thất bại (`assert.equal(mockServer.objects.size, 0)`).
  - `P2-BUCKET-06-07`: Chứng minh không tạo file báo cáo restore khi xác minh metadata thất bại (kiểm tra `ENOENT`).
  - `P2-BUCKET-06-08`: Chứng minh `file_size_limit: 0` được bảo toàn xuyên suốt quá trình tạo và xác minh bucket.

> **Bổ sung Round 5.1 (R5.1-01):** 3 test độc lập `P2-BUCKET-06-09`, `06-10`, `06-11` kiểm tra post-create GET thiếu lần lượt `name`, `public`, `id`; mỗi test xác nhận `BUCKET_CONFIGURATION_MISMATCH`, message nêu đúng trường, không upload object và không tạo success report. Chi tiết tại `docs/META_ADS_CI_REMEDIATION_REPORT_R5_1.md`. Các test `P2-BUCKET-06-01` đến `06-08` được giữ nguyên.

### 3.3. Finding R5-03: Mock Server Mishandles Zero
- **Root Cause:**
  Trong lớp `MockStorageServer` (`tests/backup/storage-restore.test.mjs`), trình xử lý POST tạo bucket sử dụng biểu thức:
  `file_size_limit: body.file_size_limit || null`
  Biểu thức này đánh giá số `0` là falsy, âm thầm chuyển đổi `file_size_limit: 0` thành `null` (biến giới hạn 0-byte thành không giới hạn).
- **Remediation:**
  Thay thế toán tử logic OR (`||`) bằng toán tử nullish coalescing (`??`):
  ```javascript
  file_size_limit: body.file_size_limit ?? null,
  allowed_mime_types: body.allowed_mime_types ?? null,
  ```
  Đồng thời bổ sung regression test `P2-BUCKET-06-08` để xác minh giá trị `0` được bảo toàn nguyên vẹn kiểu số `0`.

---

## 4. Kết Quả Kiểm Thử Trước và Sau Remediation

| Giai đoạn | Tổng số test Helper #5 | Kết quả | Ghi chú |
|---|---|---|---|
| **Trước Round 5 (Round 4 baseline)** | 67 tests | 67 PASS, 0 FAIL | Chưa có xác minh cấu hình sau khi tạo bucket (`POST -> GET`); `file_size_limit: 0` bị mock server chuyển thành `null`. |
| **Sau Round 5** | **75 tests** | **75 PASS, 0 FAIL** | 8 tests mới (`P2-BUCKET-06-01` đến `06-08`) đều **PASS 100%**. Toàn bộ 67 tests trước đó được bảo toàn nguyên vẹn. |
| **Sau Round 5.1 (hiện hành)** | **78 tests** | **78 PASS, 0 FAIL** | Thêm `P2-BUCKET-06-09` đến `06-11`; toàn bộ 75 test cũ được giữ nguyên. |

Chi tiết thực thi suite `storage-restore.test.mjs` sau Round 5.1:
```text
✔ storage-restore.mjs helper suite (1439.84125ms)
ℹ tests 78
ℹ suites 1
ℹ pass 78
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1523.802542
```

---

## 5. Kết Quả Static Analysis (Syntax Check & ESLint)

1. **Node.js Syntax Check:**
   ```bash
   node --check scripts/backup/storage-restore.mjs
   node --check tests/backup/storage-restore.test.mjs
   ```
   **Kết quả:** Exit code 0, không có lỗi cú pháp.

2. **ESLint:**
   ```bash
   ./node_modules/.bin/eslint scripts/backup/storage-restore.mjs tests/backup/storage-restore.test.mjs
   ```
   **Kết quả:** Exit code 0, 0 warning, 0 error. Tuân thủ 100% quy chuẩn linter của repository.

3. **JSON Structure Integrity:**
   ```bash
   node -e 'JSON.parse(require("fs").readFileSync("package.json", "utf8"))'
   ```
   **Kết quả:** Hợp lệ.

---

## 6. Kết Quả Toàn Bộ Regression Suite (Helpers #1–#6)

### 6.1. JavaScript Helpers Regression Suite (`npm run test:backup:helpers`)
Thực thi toàn bộ bộ test của 6 JS helpers:
- `tests/backup/aesgcm-stream.test.mjs` (Helper #1)
- `tests/backup/offsite-bundle.test.mjs` (Helper #2)
- `tests/backup/validate-bundle-index-contract.test.mjs` (Helper #3 Contract)
- `tests/backup/storage-export.test.mjs` (Helper #4 JS side)
- `tests/backup/storage-restore.test.mjs` (Helper #5)
- `tests/backup/owner-map.test.mjs` (Helper #6)

```text
ℹ tests 289
ℹ suites 17
ℹ pass 287
ℹ fail 0
ℹ cancelled 0
ℹ skipped 2
ℹ todo 0
ℹ duration_ms 33896.0885
```
**Kết quả:** **287 PASS / 0 FAIL / 2 SKIPPED** (Round 5.1). Hai skip là các test Helper #6 phụ thuộc Docker/PostgreSQL 17 và được thiết kế để skip khi container không có; đây là skip có chủ đích, không phải test bị suy yếu.

### 6.2. Python Regression Suite (`npm run test:backup:python`)
Thực thi kiểm thử Python cho Safe Extract và Runbook Amendment:
- `tests/backup/safe-extract-storage.test.py` (Helper #4 Python safe extract: 71 tests)
- `tests/backup/helper4-runbook-amendment.integration.test.py` (Helper #4 runbook integration: 4 tests)

```text
Ran 71 tests in 4.698s
OK
Ran 4 tests in 0.736s
OK
```
**Kết quả:** **75 PASS / 0 FAIL**.

**Tổng cộng toàn bộ hệ thống kiểm thử tự động (Round 5.1):** **362 PASS / 0 FAIL / 2 SKIPPED có chủ đích**. Không có bất kỳ test nào bị xóa hoặc suy yếu so với các vòng trước.

---

## 7. Đánh Giá Tác Động Bảo Mật (Security Impact Assessment)

Các nguyên tắc an ninh bất biến (Security Invariants) được bảo đảm tuyệt đối:

1. **Fail-Closed Validation:**
   Mọi dữ liệu metadata không hợp lệ, thiếu trường bắt buộc, hoặc không khớp với source backup đều khiến tiến trình restore dừng ngay lập tức với mã lỗi rõ ràng (`BUCKET_CONFIGURATION_MISMATCH`, `INVALID_BUCKET`).
2. **Không Rò Rỉ Bí Mật (No Secret Leakage):**
   Không ghi log token, URL chứa secret, hoặc API key trong toàn bộ quá trình xác minh cấu hình hay khi gặp lỗi.
3. **Chặn Tuyệt Đối Remote Target & HTTP Redirects:**
   Nguyên tắc chặn hostname ngoài localhost/127.0.0.1 và từ chối các mã phản hồi chuyển hướng HTTP 3xx vẫn giữ nguyên hiệu lực.
4. **Không Ghi Đè Object (No Overwrite / No Upsert):**
   Các cờ an toàn `--no-upsert` và kiểm tra object tồn tại vẫn được duy trì nghiêm ngặt.
5. **Zero Upload on Mismatch:**
   Chứng minh thực nghiệm qua test `P2-BUCKET-06-06`: khi xác minh metadata bucket thất bại, không có bất kỳ request HTTP upload object nào được gửi tới server.
6. **Zero Success Report on Mismatch:**
   Chứng minh thực nghiệm qua test `P2-BUCKET-06-07`: tệp báo cáo thành công hoàn toàn không được tạo ra khi có lỗi bucket parity.
7. **Bảo Toàn Môi Trường Nội Bộ (Local Synthetic Only):**
   100% quá trình kiểm thử thực hiện trên mock local server nội bộ của Node.js, không phát sinh bất kỳ request ra ngoài mạng hoặc tới Supabase Production.

---

## 8. Bảng Băm SHA-256 Kiểm Soát Tính Toàn Vẹn Tệp (File Checksums)

| Tệp tin | SHA-256 Sau Round 5 | Trạng thái |
|---|---|---|
| `scripts/backup/aesgcm-stream.mjs` | `64b5a22a16bbe719850cc9c91f886f6b447dc98019b2e2339f6de4b8a9ff70c4` | BẢO TOÀN (Nguyên bản) |
| `scripts/backup/offsite-bundle.mjs` | `11773a79ca7ce264a1d0a3c61a14da30fdd3edf0443a246c06251d3a02c40d93` | BẢO TOÀN (Nguyên bản) |
| `scripts/backup/contracts/offsite-bundle-index.mjs` | `58bfcb29f7bc2872d16b22d69bcbfc12aefbe91c874f93491a162f0693b87a0a` | BẢO TOÀN (Nguyên bản) |
| `scripts/backup/storage-export.mjs` | `3b54cf8bf08532a8fe27c7eaef2c7eb9ab3cc504ae5902aad8543107496be5bb` | BẢO TOÀN (Nguyên bản) |
| `scripts/backup/safe-extract-storage.py` | `27210b129c026e910b35958b9895d6ad019732090b666965f10f9f2e3c3230d4` | BẢO TOÀN (Nguyên bản) |
| `scripts/backup/owner-map.mjs` | `dd0a776c3af7ac1ba348cd91a91901b00d5897e1e62314410aeac4df7d8c591b` | BẢO TOÀN (Nguyên bản) |
| `docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12.md` | `9055dfb82934413d2bbe730b2d94d74ed6741fa5f44e1edb1081e3a0f958b737` | BẢO TOÀN (Nguyên bản) |
| `docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12_AMENDMENT_HELPER4.md` | `edb47d53305d79cb79478931c6a280da96b003b2b5139c7ca7867e51a30884cf` | BẢO TOÀN (Nguyên bản) |
| `.github/workflows/backup-restore-ci.yml` | `a05d8a3d5ce314df39f68c7eedb7d46c5f9eb0cc1bbad3fb12dec7815a3af630` | BẢO TOÀN (Từ R2) |
| `package.json` | `5b46041e59342bbd56799c7fddda1ec1b638605a3db3f6746aa197ee4ddf9870` | BẢO TOÀN (Từ R2) |
| `scripts/backup/storage-restore.mjs` | `1a26f3ce529d7696be27918363136066dc7563bdc2f34c2eff6e68140bfe28fb` | **SỬA ĐỔI (R5-01 Fix)** |
| `tests/backup/storage-restore.test.mjs` | `39cb249cefea0a5ce6d33ecbd9b7d6c64627adcfcaa14f6b6dadd744c1328ba3` | **SỬA ĐỔI (R5-02, R5-03 & R5.1-01: 78 tests)** |

> **Lưu ý phân loại:** `.github/workflows/backup-restore-ci.yml` và `package.json` giữ nguyên hash từ Round 2; chúng chỉ xuất hiện trong `git status` vì thay đổi Round 2 chưa commit. Round 5/5.1 không chỉnh sửa hai tệp này.

---

## 9. Git Status Hiện Tại

```text
On branch integration/meta-ads-backup-restore
Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
	modified:   .github/workflows/backup-restore-ci.yml
	modified:   package.json
	modified:   scripts/backup/storage-restore.mjs
	modified:   tests/backup/storage-restore.test.mjs

Untracked files:
  (use "git add <file>..." to include in what will be committed)
	docs/META_ADS_CI_REMEDIATION_REPORT_R2.md
	docs/META_ADS_CI_REMEDIATION_REPORT_R3.md
	docs/META_ADS_CI_REMEDIATION_REPORT_R4.md
	docs/META_ADS_CI_REMEDIATION_REPORT_R5.md
	docs/META_ADS_CI_REMEDIATION_REPORT_R5_1.md

no changes added to commit (use "git add" and/or "git commit -a")
```

- Hai tệp `.github/workflows/backup-restore-ci.yml` và `package.json` là thay đổi từ Round 2, không thuộc Round 5/5.1.
- Không commit, không push, không merge PR #140, không deploy.

---

## 10. Giới Hạn và Rủi Ro Còn Tồn Tại (Residual Risks)

1. **Storage API GET Trả Về Thiếu Trường Tùy Chọn:**
   Khi target API trả về bucket metadata mà không có trường `file_size_limit` hoặc `allowed_mime_types` (hoặc trả về `null`), hàm kiểm tra chuẩn hóa về `null` đại diện cho unrestricted. Nếu source backup có thiết lập giới hạn cụ thể (ví dụ 10MB), sự bất đối xứng này sẽ lập tức kích hoạt `BUCKET_CONFIGURATION_MISMATCH`, bảo vệ an toàn cho dữ liệu.
2. **Khác biệt sắp xếp MIME Types:**
   Hàm đối chiếu đã tự động áp dụng `sort()` trước khi so sánh chuỗi JSON của `allowed_mime_types`, loại trừ khả năng false positive do khác biệt thứ tự phần tử giữa client và server.

---

## 11. Kết Luận Bàn Giao

Các finding của Round 5 (**R5-01**, **R5-02**, **R5-03**) đã được khắc phục và kiểm chứng nghiêm ngặt. Các finding của Round 5.1 (**R5.1-01**, **R5.1-02**) được đóng tại `docs/META_ADS_CI_REMEDIATION_REPORT_R5_1.md`.

Theo Acceptance Criteria quy định tại Mục 9:
**KẾT QUẢ:** **READY FOR INDEPENDENT REVIEW — không tự tuyên bố ACCEPTED**.
Toàn bộ mã nguồn, kiểm thử, diff và báo cáo đã sẵn sàng bàn giao cho **Independent Code Review Round 5.1**.
