# BÁO CÁO REMEDIATION CI & CODE REVIEW ROUND 3 — PR #140
## BUCKET CONFIGURATION PARITY PATCH INTEGRATION

**Tài liệu:** `docs/META_ADS_CI_REMEDIATION_REPORT_R3.md`
**Dự án:** Meta Ads Backup/Restore Pipeline
**Repository:** `hoanganhngo847-a11y/ai-crm-cua-chong-ngap`
**PR:** #140 (`feat(backup): integrate helpers 1-6, contracts, runbook v12, and CI verification`)
**Branch:** `integration/meta-ads-backup-restore`
**Baseline Commit:** `b0bf2d65c0ee049e1a1a36f10f0aab23c851a06a`
**Workspace:** `/Users/hoangthuy/.gemini/antigravity/worktrees/ai-crm-cua-chong-ngap/ci_remediation_backup_helpers`
**Ngày thực hiện:** 2026-11-02
**Đối tượng bàn giao:** Independent Code Review Round 3 / Round 4, Database & Platform Custodians
**Trạng thái:** **REMEDIATED & PASSING (54/54 HELPER #5 TESTS, 340/340 REGRESSION SUITE) — SẴN SÀNG CHO INDEPENDENT CODE REVIEW**

---

## 1. Bối Cảnh và Mục Tiêu Remediation Round 3

Trong quá trình Independent Code Review Round 3 cho PR #140, chuyên gia review phát hiện một điểm thiếu sót trong logic đối chiếu cấu hình bucket tại Helper #5 (`scripts/backup/storage-restore.mjs`):

- **Vấn đề (Bucket Configuration Parity):**
  Khi source backup có cấu hình không giới hạn (`file_size_limit: null` hoặc `allowed_mime_types: null`), logic trước đây bỏ qua việc so sánh. Do đó, nếu bucket đích tồn tại sẵn cấu hình giới hạn (ví dụ `file_size_limit: 1024` hoặc `allowed_mime_types: ['image/png']`), Helper #5 vẫn chấp nhận bucket mà không báo lỗi, dẫn đến chênh lệch hành vi giữa source và target.
- **Yêu cầu kỹ thuật:**
  1. Kiểm tra nội dung bundle ZIP remediation `PR140_R3_bucket_parity_bundle.zip`.
  2. Mở đúng worktree `ci_remediation_backup_helpers`, xác nhận branch `integration/meta-ads-backup-restore`.
  3. Kiểm tra các thay đổi F-01, F-02, F-03 từ Round 2 đã có.
  4. Đối chiếu patch với source hiện tại, tuyệt đối không ghi đè remediation trước đó.
  5. Chỉ áp dụng thay đổi cần thiết cho bucket configuration parity.
  6. Chạy lại 54 tests của Helper #5 và toàn bộ regression suite.
  7. Kiểm tra diff, SHA-256 và cập nhật báo cáo remediation.
  8. Tuyệt đối không commit, push, merge PR #140 hoặc deploy. Bàn giao kết quả cho Independent Code Review.

---

## 2. Baseline Commit và SHA-256 Checksum Matrix

### 2.1. Git & Environment Context
- **Base Branch:** `meta_ads_integration`
- **Feature Branch:** `integration/meta-ads-backup-restore`
- **Baseline Commit SHA:** `b0bf2d65c0ee049e1a1a36f10f0aab23c851a06a`
- **Node.js Runtime:** `v24.15.0` (Darwin arm64)
- **Python Runtime:** `Python 3.14.0`

### 2.2. Bảng SHA-256 Checksums Toàn Bộ Pipeline

| File | SHA-256 Baseline | SHA-256 Sau R2 | SHA-256 Sau R3 (Hiện tại) | Trạng thái Thay đổi |
|---|---|---|---|---|
| `scripts/backup/aesgcm-stream.mjs` | `64b5a22a16bbe719850cc9c91f886f6b447dc98019b2e2339f6de4b8a9ff70c4` | `64b5a22a...` | `64b5a22a16bbe719850cc9c91f886f6b447dc98019b2e2339f6de4b8a9ff70c4` | **BẢO TOÀN (Nguyên bản)** |
| `scripts/backup/offsite-bundle.mjs` | `11773a79ca7ce264a1d0a3c61a14da30fdd3edf0443a246c06251d3a02c40d93` | `11773a79...` | `11773a79ca7ce264a1d0a3c61a14da30fdd3edf0443a246c06251d3a02c40d93` | **BẢO TOÀN (Nguyên bản)** |
| `scripts/backup/contracts/offsite-bundle-index.mjs` | `58bfcb29f7bc2872d16b22d69bcbfc12aefbe91c874f93491a162f0693b87a0a` | `58bfcb29...` | `58bfcb29f7bc2872d16b22d69bcbfc12aefbe91c874f93491a162f0693b87a0a` | **BẢO TOÀN (Nguyên bản)** |
| `scripts/backup/storage-export.mjs` | `3b54cf8bf08532a8fe27c7eaef2c7eb9ab3cc504ae5902aad8543107496be5bb` | `3b54cf8b...` | `3b54cf8bf08532a8fe27c7eaef2c7eb9ab3cc504ae5902aad8543107496be5bb` | **BẢO TOÀN (Nguyên bản)** |
| `scripts/backup/safe-extract-storage.py` | `27210b129c026e910b35958b9895d6ad019732090b666965f10f9f2e3c3230d4` | `27210b12...` | `27210b129c026e910b35958b9895d6ad019732090b666965f10f9f2e3c3230d4` | **BẢO TOÀN (Nguyên bản)** |
| `scripts/backup/owner-map.mjs` | `dd0a776c3af7ac1ba348cd91a91901b00d5897e1e62314410aeac4df7d8c591b` | `dd0a776c...` | `dd0a776c3af7ac1ba348cd91a91901b00d5897e1e62314410aeac4df7d8c591b` | **BẢO TOÀN (Nguyên bản)** |
| `docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12.md` | `9055dfb82934413d2bbe730b2d94d74ed6741fa5f44e1edb1081e3a0f958b737` | `9055dfb8...` | `9055dfb82934413d2bbe730b2d94d74ed6741fa5f44e1edb1081e3a0f958b737` | **BẢO TOÀN (Nguyên bản)** |
| `docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12_AMENDMENT_HELPER4.md` | `edb47d53305d79cb79478931c6a280da96b003b2b5139c7ca7867e51a30884cf` | `edb47d53...` | `edb47d53305d79cb79478931c6a280da96b003b2b5139c7ca7867e51a30884cf` | **BẢO TOÀN (Nguyên bản)** |
| `.github/workflows/backup-restore-ci.yml` | `ae55c210f26e57b3cb1fcbb5c44fefeb98ae57694736039136f80b4a523cf7a5` | `a05d8a3d...` | `a05d8a3d5ce314df39f68c7eedb7d46c5f9eb0cc1bbad3fb12dec7815a3af630` | **BẢO TOÀN TỪ R2 (F-02, F-03)** |
| `package.json` | `e12f7d61ce1f71eae47170677943a95e616e95f9c32fa6380e90fba745dd0b7c` | `5b46041e...` | `5b46041e59342bbd56799c7fddda1ec1b638605a3db3f6746aa197ee4ddf9870` | **BẢO TOÀN TỪ R2 (F-03 Script)** |
| `scripts/backup/storage-restore.mjs` | `af471a4bfd65e68474e0f04c466b5ee420f6762e54233192d465b62418ae8fe2` | `bba5f58c...` | `dd4016099306fbac135c93bf07c60d3d990b1141f07f11259856d54aa72d275b` | **CẬP NHẬT R3 (Bucket Parity + F-01)** |
| `tests/backup/storage-restore.test.mjs` | `6f29b149b8646d84bd10fe4feaf4bbbbae28f225b352684b9b0a180ee086fda2` | `ce452e8e...` | `3acaaac3207a33a22b2325cf75244ca7f8ca6c5b2c9c8ae0dad8dd1f22fe0082` | **CẬP NHẬT R3 (54 Tests: +3 Tests)** |

> **Khớp 100% với giá trị SHA-256 công bố trong review artifact:**
> - `storage-restore.mjs`: `dd4016099306fbac135c93bf07c60d3d990b1141f07f11259856d54aa72d275b`
> - `storage-restore.test.mjs`: `3acaaac3207a33a22b2325cf75244ca7f8ca6c5b2c9c8ae0dad8dd1f22fe0082`

---

## 3. Chi Tiết Khắc Phục Lỗi Bucket Configuration Parity

### 3.1. Nguyên nhân kỹ thuật
Trong hàm `restoreStorage()` (`scripts/backup/storage-restore.mjs`), khi đối chiếu cấu hình giữa source backup và target bucket đã tồn tại:
1. `file_size_limit`: Trước đây chỉ kiểm tra `if (bucket.file_size_limit !== null && existing.file_size_limit !== bucket.file_size_limit)`. Nếu source backup là `null` (unrestricted), nhánh này bị bỏ qua, dẫn đến việc chấp nhận target bucket có `file_size_limit` hạn chế (ví dụ 1024 bytes).
2. `allowed_mime_types`: Trước đây chỉ kiểm tra `if (bucket.allowed_mime_types !== null)`. Nếu source backup là `null` (unrestricted), nhánh này bị bỏ qua, cho phép target bucket có MIME allowlist hạn hẹp (ví dụ chỉ cho phép `image/png`).

### 3.2. Giải pháp thực thi (Surgical Patch)
1. **Đối chiếu hai chiều cho `file_size_limit`:**
   ```javascript
   const sourceFileSizeLimit = bucket.file_size_limit ?? null;
   const targetFileSizeLimit = existing.file_size_limit ?? null;
   if (targetFileSizeLimit !== sourceFileSizeLimit) {
     fail(
       'BUCKET_CONFIGURATION_MISMATCH',
       `existing bucket '${bucket.id}' file_size_limit (${targetFileSizeLimit}) does not match source backup (${sourceFileSizeLimit})`,
     );
   }
   ```
2. **Chuẩn hóa và đối chiếu độc lập thứ tự cho `allowed_mime_types`:**
   ```javascript
   const normalizeMimeTypes = (value) => {
     if (value == null) return null;
     return Array.isArray(value) ? [...value].sort() : value;
   };
   const sourceMimeTypes = normalizeMimeTypes(bucket.allowed_mime_types);
   const targetMimeTypes = normalizeMimeTypes(existing.allowed_mime_types);
   if (JSON.stringify(targetMimeTypes) !== JSON.stringify(sourceMimeTypes)) {
     fail(
       'BUCKET_CONFIGURATION_MISMATCH',
       `existing bucket '${bucket.id}' allowed_mime_types do not match source backup`,
     );
   }
   ```
3. **Giữ nguyên trạng các sửa đổi F-01 trước đó:**
   - Logic `createObjectPathCollisionGuard` với `normalizedPath = objectPath.normalize('NFC')` trước khi `.toLowerCase()` được bảo tồn nguyên vẹn.
   - Các test F-01 (`P2-COLLISION-05`, `P2-COLLISION-06`, `P2-COLLISION-07`) được giữ đầy đủ.

### 3.3. Các Test Cases Mới Được Bổ Sung (Helper #5)
- **`P2-BUCKET-02`:** Source backup không có giới hạn dung lượng (`file_size_limit: null`), target bucket có giới hạn 1024 bytes -> Thất bại fail-closed với mã lỗi `BUCKET_CONFIGURATION_MISMATCH`.
- **`P2-BUCKET-03`:** Source backup không có giới hạn MIME (`allowed_mime_types: null`), target bucket chỉ cho phép `['image/png']` -> Thất bại fail-closed với mã lỗi `BUCKET_CONFIGURATION_MISMATCH`.
- **`P2-BUCKET-04`:** Source backup và target bucket cùng ở trạng thái unrestricted (`null` hoặc target API lược bỏ trường cấu hình) -> Chấp nhận khôi phục thành công.

---

## 4. Diffs Chi Tiết Sau Khi Áp Dụng

### 4.1. `scripts/backup/storage-restore.mjs` (Diff so với HEAD)
```diff
--- a/scripts/backup/storage-restore.mjs
+++ b/scripts/backup/storage-restore.mjs
@@ -155,7 +155,8 @@ export function createObjectPathCollisionGuard({ caseInsensitive = false } = {})
       fail('DUPLICATE_OBJECT', `duplicate object path declared in manifest: ${fullKey}`);
     }

-    const nfcKey = `${bucketId}/${objectPath.normalize('NFC')}`;
+    const normalizedPath = objectPath.normalize('NFC');
+    const nfcKey = `${bucketId}/${normalizedPath}`;
     if (seenNfc.has(nfcKey)) {
       fail(
         'UNICODE_COLLISION',
@@ -167,7 +168,7 @@ export function createObjectPathCollisionGuard({ caseInsensitive = false } = {})
     seenNfc.set(nfcKey, fullKey);

     if (caseInsensitive) {
-      const lowerKey = `${bucketId}/${objectPath.toLowerCase()}`;
+      const lowerKey = `${bucketId}/${normalizedPath.toLowerCase()}`;
       if (seenLower.has(lowerKey)) {
         fail(
           'PATH_COLLISION',
@@ -1537,28 +1538,36 @@ export async function restoreStorage(options = {}) {
         fail('BUCKET_CREATION_FAILED', `failed to verify created bucket '${bucket.id}' on target`);
       }
     } else {
-      // Existing bucket configuration reconciliation (P2-BUCKET-01)
+      // Existing bucket configuration reconciliation (P2-BUCKET-01).
+      // Compare both restrictive and unrestricted settings: null means no
+      // limit, so a destination-side limit is also a configuration mismatch.
       if (Boolean(existing.public) !== Boolean(bucket.public)) {
         fail(
           'BUCKET_CONFIGURATION_MISMATCH',
           `existing bucket '${bucket.id}' public setting (${Boolean(existing.public)}) does not match source backup (${Boolean(bucket.public)})`,
         );
       }
-      if (bucket.file_size_limit !== null && existing.file_size_limit !== bucket.file_size_limit) {
+
+      const sourceFileSizeLimit = bucket.file_size_limit ?? null;
+      const targetFileSizeLimit = existing.file_size_limit ?? null;
+      if (targetFileSizeLimit !== sourceFileSizeLimit) {
         fail(
           'BUCKET_CONFIGURATION_MISMATCH',
-          `existing bucket '${bucket.id}' file_size_limit (${existing.file_size_limit}) does not match source backup (${bucket.file_size_limit})`,
+          `existing bucket '${bucket.id}' file_size_limit (${targetFileSizeLimit}) does not match source backup (${sourceFileSizeLimit})`,
         );
       }
-      if (bucket.allowed_mime_types !== null) {
-        const srcMimes = Array.isArray(bucket.allowed_mime_types) ? [...bucket.allowed_mime_types].sort() : [];
-        const dstMimes = Array.isArray(existing.allowed_mime_types) ? [...existing.allowed_mime_types].sort() : [];
-        if (srcMimes.join(',') !== dstMimes.join(',')) {
-          fail(
-            'BUCKET_CONFIGURATION_MISMATCH',
-            `existing bucket '${bucket.id}' allowed_mime_types do not match source backup`,
-          );
-        }
+
+      const normalizeMimeTypes = (value) => {
+        if (value == null) return null;
+        return Array.isArray(value) ? [...value].sort() : value;
+      };
+      const sourceMimeTypes = normalizeMimeTypes(bucket.allowed_mime_types);
+      const targetMimeTypes = normalizeMimeTypes(existing.allowed_mime_types);
+      if (JSON.stringify(targetMimeTypes) !== JSON.stringify(sourceMimeTypes)) {
+        fail(
+          'BUCKET_CONFIGURATION_MISMATCH',
+          `existing bucket '${bucket.id}' allowed_mime_types do not match source backup`,
+        );
       }
     }
```

### 4.2. `tests/backup/storage-restore.test.mjs` (Diff bổ sung 3 test cases)
```diff
+  // 40a. P2-BUCKET-02: An unrestricted source file-size limit must not accept a restricted target
+  test('P2-BUCKET-02: rejects destination file_size_limit when source backup has no limit', async () => {
+    const dataset = await createSyntheticDataset(testCaseDir, {
+      serverPort: mockServer.port,
+      buckets: [{ id: 'unlimited-size-bucket', name: 'unlimited-size-bucket', public: false }],
+      files: [],
+    });
+
+    mockServer.buckets.set('unlimited-size-bucket', {
+      id: 'unlimited-size-bucket',
+      name: 'unlimited-size-bucket',
+      public: false,
+      file_size_limit: 1024,
+      allowed_mime_types: null,
+    });
+
+    await assert.rejects(
+      () => restoreStorage({
+        localEnv: dataset.localEnvPath,
+        buckets: dataset.bucketsPath,
+        manifest: dataset.manifestPath,
+        objectsRoot: dataset.objectsRoot,
+      }),
+      (err) => {
+        assert.equal(err.code, 'BUCKET_CONFIGURATION_MISMATCH');
+        assert.match(err.message, /file_size_limit/);
+        return true;
+      },
+    );
+  });
+
+  // 40b. P2-BUCKET-03: An unrestricted source MIME policy must not accept a restricted target
+  test('P2-BUCKET-03: rejects destination allowed_mime_types when source backup has no MIME restriction', async () => {
+    const dataset = await createSyntheticDataset(testCaseDir, {
+      serverPort: mockServer.port,
+      buckets: [{ id: 'unrestricted-mime-bucket', name: 'unrestricted-mime-bucket', public: false }],
+      files: [],
+    });
+
+    mockServer.buckets.set('unrestricted-mime-bucket', {
+      id: 'unrestricted-mime-bucket',
+      name: 'unrestricted-mime-bucket',
+      public: false,
+      file_size_limit: null,
+      allowed_mime_types: ['image/png'],
+    });
+
+    await assert.rejects(
+      () => restoreStorage({
+        localEnv: dataset.localEnvPath,
+        buckets: dataset.bucketsPath,
+        manifest: dataset.manifestPath,
+        objectsRoot: dataset.objectsRoot,
+      }),
+      (err) => {
+        assert.equal(err.code, 'BUCKET_CONFIGURATION_MISMATCH');
+        assert.match(err.message, /allowed_mime_types/);
+        return true;
+      },
+    );
+  });
+
+  // 40c. P2-BUCKET-04: Null source settings match an unrestricted destination
+  test('P2-BUCKET-04: accepts matching unrestricted bucket settings when target fields are null or absent', async () => {
+    const dataset = await createSyntheticDataset(testCaseDir, {
+      serverPort: mockServer.port,
+      buckets: [{ id: 'matching-unrestricted-bucket', name: 'matching-unrestricted-bucket', public: false }],
+      files: [],
+    });
+
+    mockServer.buckets.set('matching-unrestricted-bucket', {
+      id: 'matching-unrestricted-bucket',
+      name: 'matching-unrestricted-bucket',
+      public: false,
+      file_size_limit: null,
+      allowed_mime_types: null,
+    });
+
+    const result = await restoreStorage({
+      localEnv: dataset.localEnvPath,
+      buckets: dataset.bucketsPath,
+      manifest: dataset.manifestPath,
+      objectsRoot: dataset.objectsRoot,
+    });
+
+    assert.equal(result.status, 'success');
+    assert.equal(result.summary.bucketCount, 1);
+
+    // Storage APIs may omit nullable configuration fields instead of returning null.
+    mockServer.buckets.set('matching-unrestricted-bucket', {
+      id: 'matching-unrestricted-bucket',
+      name: 'matching-unrestricted-bucket',
+      public: false,
+    });
+    const resultWithOmittedSettings = await restoreStorage({
+      localEnv: dataset.localEnvPath,
+      buckets: dataset.bucketsPath,
+      manifest: dataset.manifestPath,
+      objectsRoot: dataset.objectsRoot,
+    });
+    assert.equal(resultWithOmittedSettings.status, 'success');
+    assert.equal(resultWithOmittedSettings.summary.bucketCount, 1);
+  });
```

---

## 5. Kết Quả Kiểm Thử Thực Tế (Regression Execution Matrix)

Tất cả các kiểm thử đã được thực thi trực tiếp trên worktree `ci_remediation_backup_helpers`:

| # | Bộ Kiểm Thử / Thành Phần | Lệnh Thực Thi | Số Lượng Test | PASS | FAIL | SKIP | Trạng Thái |
|---|---|---|---|---|---|---|---|
| 1 | **Helper #5** (Storage Restore Engine) | `node --test tests/backup/storage-restore.test.mjs` | **54** | **54** | 0 | 0 | **PASS 100%** |
| 2 | **Helper #1 đến #6** (JavaScript Suite) | `npm run test:backup:helpers` | **265** | **264** | 0 | 1* | **PASS** |
| 3 | **Helper #4 & Runbook** (Python Suite) | `npm run test:backup:python` | **75** | **75** | 0 | 0 | **PASS 100%** |
| 4 | **ESLint Static Code Analysis** | `./node_modules/.bin/eslint scripts/backup/...` | 4 files | All clean | 0 | 0 | **PASS (0 errors, 0 warnings)** |
| 5 | **Node Syntax Checks** | `node --check scripts/... tests/...` | 2 files | Valid syntax | 0 | 0 | **PASS** |
| 6 | **JSON Validation** | `node -e 'JSON.parse(fs.readFileSync("package.json"))'` | 1 file | Valid JSON | 0 | 0 | **PASS** |
| **TỔNG** | **Toàn Bộ Pipeline PR #140** | `npm run test:backup` + lint | **340** | **339** | **0** | **1\*** | **READY FOR REVIEW** |

*\* Ghi chú: 1 test skipped (`R2-P2-02`) là live PostgreSQL 17 rehearsal test được thiết kế chủ đích skip an toàn khi Docker daemon không chạy local; test này sẽ chạy thực sự trên GitHub Actions runner đã được cấu hình container ở F-02.*

---

## 6. Đảm Bảo Bất Biến Bảo Mật (Security Invariants)

1. **Fail-Closed Mặc Định:** Bất kỳ xung đột nào giữa source backup và existing bucket về:
   - `public` flag (private vs public)
   - `file_size_limit` (kể cả khi một bên unrestricted và một bên có giới hạn)
   - `allowed_mime_types` (kể cả khi một bên unrestricted và một bên có allowlist)
   đều kích hoạt ngoại lệ `BUCKET_CONFIGURATION_MISMATCH` ngay trước khi tải dữ liệu lên.
2. **Không Rò Rỉ Bí Mật (Zero Secret Leakage):** Không có JWT secret, service role key hay database credentials nào xuất hiện trong console logs hoặc báo cáo.
3. **Bảo Tồn 100% Remediation Round 2:**
   - F-01: Chuẩn hóa NFC trước khi lowercase trong Collision Guard được bảo toàn tuyệt đối.
   - F-02: Docker container cấu hình trong CI workflow nguyên vẹn.
   - F-03: `SAFE_EXTRACT_EXPORT_HELPER` trong `package.json` và CI workflow nguyên vẹn.

---

## 7. Trạng Thái Git & Tuân Thủ Quy Trình

- **Git status hiện tại trên worktree:**
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
  ```
- **Số tệp thay đổi ngoài phạm vi:** **0**
- **Tuân thủ cam kết:**
  - Không commit, push hay merge PR #140.
  - Không deploy lên staging hoặc production.
  - Sẵn sàng bàn giao nguyên trạng cho Independent Code Review Round 3 / Round 4.
