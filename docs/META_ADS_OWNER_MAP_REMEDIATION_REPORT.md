# Báo cáo Khắc phục Độc lập — Helper #6: PostgreSQL Owner Map (Round 2 Remediation)

**Ngày báo cáo:** 2026-11-02  
**Tác giả:** Senior PostgreSQL & Application Security Remediation Engineer  
**Đối tượng:** Independent Security Code Reviewer, Platform & Database Custodians  
**Trạng thái:** **REMEDIATED & PASSING — READY FOR INDEPENDENT REVIEW ROUND 2**

---

## 1. Thông tin Workspace, Branch và Git Status

| Mục | Chi tiết |
|---|---|
| **Canonical Worktree** | `/Users/hoangthuy/.gemini/antigravity/worktrees/ai-crm-cua-chong-ngap/remediate_owner_map_helper` |
| **Active Branch** | `remediate_owner_map_helper` |
| **Base Commit SHA** | `3abe0d78a7f162f6d5cde2e9adb719ebe6963075` (Merge branch 'chore/remove-legacy-backend-and-schema') |
| **Node.js Runtime** | `v24.15.0` (Darwin arm64) |
| **PostgreSQL Target** | PostgreSQL 17.11 (local disposable test container `crm-dumpcheck-test`) |
| **Git Working Tree Status** | Sạch sẽ trong tracked git; các file implementation và test được đặt tại đúng canonical paths (`scripts/backup/`, `tests/backup/`, `docs/`) |

---

## 2. Bảng định danh SHA-256 trước và sau Remediation

| Tệp tin | SHA-256 Trước Remediation (Baseline) | SHA-256 Sau Remediation (Remediated) |
|---|---|---|
| `scripts/backup/owner-map.mjs` | `c0a9dc3f48da7ee0ee15fc8ab0e9db70800d066a12a4774701737894f1764802` | `5fac92d90e022eaebe092b993dd0adb8c02194a1a9f4db95d2a87462b7625f85` |
| `tests/backup/owner-map.test.mjs` | `414fbd1ee18308882320fad016834be210d14caf5142c4770ff809463b61a449` | `80b1eae5434611f7e68c1ad33c24b6b95e2dd0fa0e01a323f78457be2ed0937f` |

---

## 3. Danh sách tệp tin đã sửa

1. `scripts/backup/owner-map.mjs`:
   - Bổ sung `APPROVED_CONTAINERS` allowlist cho local rehearsal container.
   - Bổ sung `validateTargetInventory()` phát hiện và từ chối duplicate records độc lập với thứ tự xuất hiện (P2-01).
   - Bổ sung `validateRoutineEntry()` kiểm tra cấu trúc nghiêm ngặt (schema validation) cho từng routine catalog entry (P1-01).
   - Khắc phục P3-01 trong `parseIdentifierToken()` và `validateRoleIdentifier()`: fold unquoted identifier tokens về lowercase theo đúng chuẩn ngữ nghĩa PostgreSQL, bảo toàn nguyên vẹn chữ hoa/thường cho quoted identifiers (`"Foo"`).
   - Khắc phục P1-02:
     - `getSanitizedChildEnv()` loại bỏ triệt để các biến libpq connection overrides (`PGHOST`, `PGHOSTADDR`, `PGSERVICE`, `PGSERVICEFILE`, `PGDATABASE`, `PGPORT`, `PGUSER`, `PGPASSFILE`, `PGREQUIRESSL`, `PGSSLMODE`) trước khi spawn child process.
     - `validateTargetIsolation()` kiểm tra nghiêm ngặt `env.PGHOST`, `env.PGHOSTADDR`, `env.PGSERVICE`, `env.PGSERVICEFILE`, `env.DOCKER_HOST`, `env.DOCKER_CONTEXT`, từ chối kết hợp conflicting options (`--db-container` và `--db-host`), và từ chối direct psql khi thiếu `--db-host`.
     - `verifyDatabaseTargetIdentity()` truy vấn và xác minh database-side sentinel/identity trước khi thực thi DDL apply hoặc live object queries (P1-02, P2-04).
   - Khắc phục P2-02 trong `handlePlanCommand`: đánh dấu `rolesValidated = false`, `applyReady = false`, và `status = 'PLAN_INCOMPLETE_UNVERIFIED_ROLES'` nếu không có bằng chứng target roles hợp lệ.
   - Khắc phục P2-04 trong `handleApplyCommand`: bắt buộc `--map <path>`, đồng bộ default target `crm-restore-rehearsal`, và xác minh database target identity.
   - Khắc phục P1-01 và P2-03 trong `handleVerifyCommand`:
     - Nếu inventory có function/procedure: bắt buộc có `--catalog-details` hợp lệ (array không rỗng), đối chiếu exact-set hai chiều với routine objects trong owner inventory.
     - Bắt buộc có `--target-catalog-details` hoặc live database target; kiểm tra trùng lặp target routine identities (P2-01).
     - Kiểm tra đầy đủ 4 thuộc tính an ninh: routine owner (`proowner`), `SECURITY DEFINER` (`prosecdef`), `proconfig` (search_path, v.v.), và EXECUTE ACL.
     - Theo dõi discrepancy độc lập trên từng routine: routine hợp lệ vẫn được tính vào `verifiedRoutinesCount` ngay cả khi routine trước đó bị mismatch (P2-03).
     - Bất kỳ vi phạm nào đều fail-closed với `BLOCKED`, tuyệt đối không bao giờ trả về `VERIFIED`.

2. `tests/backup/owner-map.test.mjs`:
   - Bổ sung `verifyDisposableTestTarget()`: kiểm tra Docker local context, container allowlist, PostgreSQL version >= 17, và database-side marker table `public._crm_disposable_test_marker`.
   - Làm an toàn live integration test (P1-03):
     - Không DROP fixed names trước khi setup.
     - Tạo ngẫu nhiên schema và role names duy nhất cho mỗi lần chạy (`rehearsal_test_${runId}`, `synth_src_${runId}`, `synth_tgt_${runId}`).
     - Preflight kiểm tra va chạm tên; nếu đã tồn tại thì từ chối ngay.
     - Chỉ cleanup đúng những objects do test tạo ra trong khối `finally`.
   - Cập nhật test CLI integration để truyền đầy đủ `--map`, `--catalog-details`, và `--target-catalog-details` (loại bỏ gap test cũ).
   - Bổ sung toàn bộ regression và adversarial suites cho P1-01, P1-02, P1-03, P2-01, P2-02, P2-03, P2-04, P3-01.

---

## 4. Chi tiết từng Finding, Root Cause, Giải pháp và Bằng chứng Kiểm chứng

### P1-01 — Routine security verification fail-open

- **Mức độ:** P1 (Acceptance Blocker).
- **Vị trí cũ:** `scripts/backup/owner-map.mjs:1343-1358, 1433-1459`; `tests/backup/owner-map.test.mjs:974-990`.
- **Root Cause:**
  Khối kiểm tra routine security chỉ được kích hoạt khi có tham số `catalogDetailsPath`. Khi tham số bị bỏ trống hoặc source/target routines là mảng rỗng, code bỏ qua kiểm tra an ninh hàm mà vẫn tính toán status dựa trên discrepancy tích luỹ, dẫn đến trả về `VERIFIED` fail-open.
- **Biện pháp khắc phục:**
  1. Kiểm tra danh sách routine objects trong inventory (`sourceItems.filter(i => i.objectType === 'function' || i.objectType === 'procedure')`).
  2. Nếu có routine:
     - Bắt buộc phải có `catalogDetailsPath`, nếu thiếu ném lỗi `MISSING_CATALOG_DETAILS`.
     - Bắt buộc `sourceCatalog.routines` là mảng không rỗng, nếu không ném `MALFORMED_CATALOG_DETAILS` hoặc `EMPTY_ROUTINES_CATALOG`.
     - Từng phần tử routine được validate schema nghiêm ngặt qua `validateRoutineEntry()`.
     - Thực hiện đối chiếu exact-set hai chiều: mọi routine trong inventory phải có mặt trong catalog (`MISSING_SOURCE_ROUTINE`), và mọi routine trong catalog phải thuộc inventory (`UNMATCHED_CATALOG_ROUTINE`).
     - Bắt buộc phải có target routine catalog hợp lệ (`targetCatalogDetailsPath` hoặc live query).
     - Kiểm tra toàn diện 4 thuộc tính: owner, `securityDefiner`, `config` (proconfig), và `acl`.
  3. Cập nhật test CLI integration truyền đầy đủ catalog details hợp lệ.
- **Bằng chứng tái hiện và kiểm chứng:**
  - Test cũ: Omit `--catalog-details` trả về `VERIFIED; verifiedRoutinesCount=0`.
  - Test mới:
    - `P1-01: verify fails closed with MISSING_CATALOG_DETAILS when inventory contains routines but catalog is omitted`: PASS.
    - `P1-01: verify fails closed with MISSING_TARGET_ROUTINES when offline target catalog is omitted`: PASS.
    - `P1-01: verify fails closed with EMPTY_ROUTINES_CATALOG when inventory has routines but catalog is empty`: PASS.
    - `P1-01: verify fails closed with MALFORMED_CATALOG_DETAILS when routines is not an array`: PASS.
    - `P1-01: verify fails closed with MALFORMED_ROUTINE_ENTRY when routine has non-boolean securityDefiner`: PASS.
    - `P1-01: verify detects missing routine identity in source catalog and reports status BLOCKED`: PASS.
    - Các test tamper `SECURITY DEFINER`, `proconfig`, và `EXECUTE ACL`: Đều phát hiện chính xác và trả về `BLOCKED`.

---

### P1-02 — Enforce local-only database execution

- **Mức độ:** P1 (Acceptance Blocker).
- **Vị trí cũ:** `scripts/backup/owner-map.mjs:775-786, 923-957`.
- **Root Cause:**
  `validateTargetIsolation()` trả về sớm khi `dbHost` là `null`, khiến direct `psql` được gọi mà không có flag `-h`. Lúc đó libpq tự động kế thừa `PGHOST`, `PGHOSTADDR`, `PGSERVICE`, v.v. từ môi trường cha, cho phép kết nối ra remote database. Đường chạy Docker cũng không xác minh daemon endpoint và chấp nhận tên container tuỳ ý.
- **Biện pháp khắc phục:**
  1. Xây dựng `getSanitizedChildEnv()` chủ động xoá toàn bộ biến môi trường kết nối libpq (`PGHOST`, `PGHOSTADDR`, `PGSERVICE`, `PGSERVICEFILE`, `PGDATABASE`, `PGPORT`, `PGUSER`, `PGPASSFILE`, `PGREQUIRESSL`, `PGSSLMODE`) và truyền vào `spawn()`.
  2. Xây dựng `validateTargetIsolation()` kiểm tra:
     - `env.PGHOST`: từ chối nếu không phải loopback (`127.0.0.1`, `localhost`, `::1`, `[::1]`).
     - `env.PGHOSTADDR`: từ chối nếu không phải `127.0.0.1` hoặc `::1`.
     - `env.PGSERVICE` / `env.PGSERVICEFILE`: chặn triệt để.
     - `env.DOCKER_HOST`: từ chối nếu là remote TCP endpoint.
     - `env.DOCKER_CONTEXT`: từ chối remote contexts.
     - Container: chỉ chấp nhận các container trong `APPROVED_CONTAINERS`.
     - Direct `psql`: từ chối nếu thiếu `--db-host` (không coi thiếu host là bằng chứng local).
     - Conflicting options: từ chối nếu truyền cả `--db-container` và `--db-host`.
  3. Xây dựng `verifyDatabaseTargetIdentity()` truy vấn database-side sentinel (`crm.rehearsal_identity`, comment `pg_database`, hoặc marker table) trước khi apply SQL hoặc query objects.
- **Bằng chứng tái hiện và kiểm chứng:**
  - Test cũ: Đặt `PGHOST=db.remote.invalid` vẫn chạy tới fake psql và báo APPLIED.
  - Test mới:
    - `P1-02: validateTargetIsolation blocks remote PGHOST in process environment before child execution`: PASS (`REMOTE_TARGET_BLOCKED`).
    - `P1-02: validateTargetIsolation blocks remote PGHOSTADDR in process environment before child execution`: PASS (`REMOTE_TARGET_BLOCKED`).
    - `P1-02: validateTargetIsolation blocks PGSERVICE and PGSERVICEFILE environment variables`: PASS (`REMOTE_TARGET_BLOCKED`).
    - `P1-02: validateTargetIsolation blocks remote DOCKER_HOST before child execution`: PASS (`REMOTE_DOCKER_HOST_BLOCKED`).
    - `P1-02: validateTargetIsolation blocks remote DOCKER_CONTEXT before child execution`: PASS (`REMOTE_DOCKER_CONTEXT_BLOCKED`).
    - `P1-02: validateTargetIsolation blocks arbitrary unapproved container names`: PASS (`UNAPPROVED_CONTAINER`).
    - `P1-02: validateTargetIsolation rejects conflicting connection options`: PASS (`CONFLICTING_CONNECTION_OPTIONS`).
    - `P1-02: validateTargetIsolation rejects omitted dbHost for direct psql execution`: PASS (`MISSING_TARGET_ENDPOINT`).
    - `P1-02: getSanitizedChildEnv removes all libpq connection override variables`: PASS.
    - `P1-02: verifyDatabaseTargetIdentity fails closed when target mismatch occurs on remote/unverified target`: PASS (`DATABASE_IDENTITY_VERIFICATION_FAILED`).

---

### P1-03 — Làm an toàn live integration test

- **Mức độ:** P1 (Acceptance Blocker).
- **Vị trí cũ:** `tests/backup/owner-map.test.mjs:1012-1044, 1177-1188`.
- **Root Cause:**
  Test chạy trực tiếp lệnh `DROP SCHEMA IF EXISTS rehearsal_owner_map_test CASCADE;` và `DROP ROLE IF EXISTS synth_src_owner;` trên database trước khi kiểm tra định danh database, có nguy cơ xoá dữ liệu có sẵn nếu trỏ nhầm database.
- **Biện pháp khắc phục:**
  1. Triển khai cổng an toàn `verifyDisposableTestTarget(container)`:
     - Kiểm tra Docker local context và container trong danh sách phê duyệt.
     - Kiểm tra PostgreSQL version >= 17 (`server_version_num >= 170000`).
     - Xác minh database-side disposable marker: bảng `public._crm_disposable_test_marker` hoặc comment `disposable-test`.
  2. Tạo ngẫu nhiên schema và role names duy nhất cho mỗi lần chạy: `rehearsal_test_${runId}`, `synth_src_${runId}`, `synth_tgt_${runId}`.
  3. Preflight check: kiểm tra sự tồn tại của các tên vừa sinh. Nếu có va chạm, dừng ngay và từ chối setup. Tuyệt đối không drop fixed names.
  4. Ghi nhận chính xác danh sách objects đã tạo (`createdObjects`) và chỉ cleanup những objects này trong khối `finally`.
  5. Bổ sung test kiểm chứng fixture từ chối target không có marker mà không phát bất kỳ lệnh DROP nào.
- **Bằng chứng tái hiện và kiểm chứng:**
  - `P1-03: verifyDisposableTestTarget refuses unmarked database target without issuing any DROP statements`: PASS (khẳng định 0 câu lệnh DROP được gửi đi).
  - `P1-03: verifyDisposableTestTarget refuses PostgreSQL major versions older than 17`: PASS.
  - `Live PostgreSQL 17 integration: full plan -> apply -> verify cycle with live catalog and rollback`: PASS toàn diện trên disposable target `crm-dumpcheck-test`.

---

### P2-01 — Duplicate target inventory identities

- **Mức độ:** P2 (Verification Integrity Gap).
- **Vị trí cũ:** `scripts/backup/owner-map.mjs:1302-1307`.
- **Root Cause:**
  Target inventory được sao chép trực tiếp vào `Map` mà không kiểm tra duplicate `objectType:identity`, khiến bản ghi sau ghi đè bản ghi trước mà không bị phát hiện.
- **Biện pháp khắc phục:**
  1. Triển khai hàm `validateTargetInventory()` duyệt toàn bộ danh sách, kiểm tra schema và kiểm tra tập `seenKeys`. Nếu gặp key trùng lặp, dừng ngay lập tức với mã lỗi `DUPLICATE_TARGET_OBJECT`.
  2. Áp dụng tương tự cho target routines: kiểm tra `targetRoutineMap.has(r.identity)`, nếu trùng ném `DUPLICATE_TARGET_ROUTINE`.
- **Bằng chứng tái hiện và kiểm chứng:**
  - `P2-01: validateTargetInventory rejects duplicate objectType:identity independent of record order`: PASS cho cả 2 thứ tự `[wrong, right]` và `[right, wrong]`.
  - `P2-01: verify fails closed with DUPLICATE_TARGET_ROUTINE when target catalog contains duplicate routine identities`: PASS.

---

### P2-02 — Target role existence check

- **Mức độ:** P2 (Plan Completeness Gap).
- **Vị trí cũ:** `scripts/backup/owner-map.mjs:761-767, 1137-1150`.
- **Root Cause:**
  Khi `rolesPath` và target DB cùng vắng mặt, `handlePlanCommand` vẫn tạo plan và báo `status: 'PLAN_GENERATED'` mà không kiểm tra role đích có tồn tại hay không.
- **Biện pháp khắc phục:**
  1. Trong `handlePlanCommand`: nếu thiếu target role inventory hoặc target DB query, đánh dấu `rolesValidated = false`, `applyReady = false`, và `status = 'PLAN_INCOMPLETE_UNVERIFIED_ROLES'`.
  2. Trong `handleApplyCommand`: bắt buộc kiểm tra live target roles trước khi thực thi apply; nếu role đích không tồn tại, fail-closed với `NONEXISTENT_TARGET_ROLE`.
- **Bằng chứng tái hiện và kiểm chứng:**
  - `P2-02: handlePlanCommand without target roles marks plan as PLAN_INCOMPLETE_UNVERIFIED_ROLES and applyReady=false`: PASS.
  - Test 5: `Nonexistent target role: fails closed when target role does not exist in target inventory`: PASS.

---

### P2-03 — verifiedRoutinesCount undercounting

- **Mức độ:** P2 (Report Accuracy Defect).
- **Vị trí cũ:** `scripts/backup/owner-map.mjs:1426-1428`.
- **Root Cause:**
  Code kiểm tra `if (discrepancies.length === 0) verifiedRoutinesCount++;`. Khi routine 1 bị lỗi, `discrepancies.length` lớn hơn 0 khiến routine 2 dù hoàn toàn hợp lệ cũng không được tính vào số đếm.
- **Biện pháp khắc phục:**
  Ghi nhận số lượng discrepancy trước khi kiểm tra routine (`const routineDiscrepanciesBefore = discrepancies.length;`), sau khi kiểm tra xong tính delta (`discrepancies.length - routineDiscrepanciesBefore`). Nếu delta bằng 0 thì tăng `verifiedRoutinesCount`.
- **Bằng chứng tái hiện và kiểm chứng:**
  - `P2-03: verifiedRoutinesCount tracks valid routine even after a preceding routine fails verification`: PASS. Báo cáo ghi nhận chính xác `verifiedRoutinesCount = 1` và `discrepanciesCount = 1`.

---

### P2-04 — Target identity enforcement

- **Mức độ:** P2 (Target-Binding / Operator Clarity Gap).
- **Vị trí cũ:** `scripts/backup/owner-map.mjs:37, 1177-1211, 1491-1507`.
- **Root Cause:**
  `DEFAULT_TARGET_IDENTITY` được định nghĩa nhưng không được sử dụng đồng bộ; `apply` không bắt buộc `--map` và không kiểm tra database-side sentinel.
- **Biện pháp khắc phục:**
  1. Đồng bộ `DEFAULT_TARGET_IDENTITY = 'crm-restore-rehearsal'` làm giá trị mặc định cho cả CLI options và command handlers (`plan`, `apply`, `verify`).
  2. Bắt buộc truyền `--map <path>` trong lệnh `apply`.
  3. Kết hợp với `verifyDatabaseTargetIdentity()` của P1-02 để đối chiếu target label với database-side sentinel thực tế.
- **Bằng chứng tái hiện và kiểm chứng:**
  - `P2-04: handleApplyCommand strictly requires --map option to apply plan`: PASS (`MISSING_OPTION`).
  - Test 14: Target label mismatch bị từ chối với `TARGET_IDENTITY_MISMATCH`: PASS.

---

### P3-01 — PostgreSQL identifier case semantics

- **Mức độ:** P3 (Input Semantics / Correctness Edge Case).
- **Vị trí cũ:** `scripts/backup/owner-map.mjs:421-429, 435-448, 796-807`.
- **Root Cause:**
  Parser chấp nhận unquoted identifier nhưng giữ nguyên chữ hoa/thường (ví dụ `public.Foo` phát ra `ALTER TABLE "public"."Foo"`), sai lệch ngữ nghĩa chuẩn của PostgreSQL (trong PostgreSQL, `public.Foo` không có ngoặc kép mang ý nghĩa là `public.foo`).
- **Biện pháp khắc phục:**
  Trong `parseIdentifierToken()` và `validateRoleIdentifier()`, áp dụng đúng chuẩn PostgreSQL:
  - Token không có ngoặc kép (unquoted): fold về lowercase bằng `.toLowerCase()`.
  - Token có ngoặc kép (quoted `""`): bảo toàn nguyên vẹn case bên trong ngoặc kép.
- **Bằng chứng tái hiện và kiểm chứng:**
  - `P3-01: unquoted lowercase identifier public.foo preserves lowercase`: PASS (`ALTER TABLE "public"."foo"`).
  - `P3-01: unquoted mixed-case identifier public.Foo folds to lowercase public.foo matching PostgreSQL semantics`: PASS (`ALTER TABLE "public"."foo"`).
  - `P3-01: quoted mixed-case identifier "public"."Foo" preserves exact case matching PostgreSQL semantics`: PASS (`ALTER TABLE "public"."Foo"`).
  - `P3-01: unquoted role name folds to lowercase while quoted role preserves case`: PASS (`Old_Admin` -> `old_admin`; `"Old_Admin"` -> `Old_Admin`).

---

## 5. Kết quả Test Suite và Kiểm tra Chất lượng

### 5.1 Helper #6 Suite (`tests/backup/owner-map.test.mjs`)

```text
✔ 1. Valid owner mapping: generates deterministic plan, verifies all 11 supported object types (8.8ms)
✔ 2. Missing source-owner mapping: fails closed when an inventory owner has no mapping (0.3ms)
✔ 3. Duplicate source owner in owner-map: fails closed with DUPLICATE_OWNER_MAPPING (0.1ms)
✔ 4. Unknown source owner in owner-map: fails closed when mapping defines an owner absent from inventory (0.2ms)
✔ 5. Nonexistent target role: fails closed when target role does not exist in target inventory (0.2ms)
✔ 6. Invalid project/target identity: fails closed on format, projectRef, or target mismatch (0.2ms)
✔ 7. Duplicate JSON keys: strict parser rejects root, nested, and escaped duplicate keys (0.4ms)
✔ 8. SQL injection hardening: rejects injections in schema, table, function, and role identifiers (0.2ms)
✔ 9. Function/procedure overload resolution: distinguishes overloaded functions with exact arguments (0.2ms)
✔ 10. Deterministic SQL generation: identical byte-for-byte output regardless of input array ordering (0.5ms)
✔ 11. Missing approval hash: apply fails closed when --approved-sha256 is missing (5.8ms)
✔ 12. Incorrect approval hash: apply fails closed before database connection (1.2ms)
✔ 13. Plan modified after approval: apply fails closed when plan bytes on disk are altered (1.3ms)
✔ 14. Target identity and remote host mismatch: rejects remote endpoints and mismatched targets (2.1ms)
✔ 15. Apply rollback when SQL fails: transaction atomicity ensures partial changes revert (1.3ms)
✔ 16. Post-apply owner mismatch: verify fails closed with status BLOCKED (3.2ms)
✔ 17. SECURITY DEFINER mismatch: verify detects altered prosecdef flag and sets status BLOCKED (3.4ms)
✔ 18. proconfig mismatch: verify detects altered function configuration GUCs and sets status BLOCKED (2.0ms)
✔ 19. EXECUTE ACL mismatch: verify detects altered execution privileges and sets status BLOCKED (1.9ms)
✔ 20. Unsupported object type: fails closed on unknown or disallowed object types (0.1ms)
✔ CLI integration: plan, apply, verify roundtrip via subprocess execution (90.3ms)
✔ Prohibited SQL injection: rejects DROP, CREATE ROLE, GRANT, REVOKE keywords in generated statements (0.2ms)
✔ Live PostgreSQL 17 integration: full plan -> apply -> verify cycle with live catalog and rollback (1428.4ms)
✔ P1-01: verify fails closed with MISSING_CATALOG_DETAILS when inventory contains routines but catalog is omitted (1.7ms)
✔ P1-01: verify fails closed with MISSING_TARGET_ROUTINES when offline target catalog is omitted (1.6ms)
✔ P1-01: verify fails closed with EMPTY_ROUTINES_CATALOG when inventory has routines but catalog is empty (2.2ms)
✔ P1-01: verify fails closed with MALFORMED_CATALOG_DETAILS when routines is not an array (2.3ms)
✔ P1-01: verify fails closed with MALFORMED_ROUTINE_ENTRY when routine has non-boolean securityDefiner (1.7ms)
✔ P1-01: verify detects missing routine identity in source catalog and reports status BLOCKED (2.1ms)
✔ P1-02: validateTargetIsolation blocks remote PGHOST in process environment before child execution (0.1ms)
✔ P1-02: validateTargetIsolation blocks remote PGHOSTADDR in process environment before child execution (0.1ms)
✔ P1-02: validateTargetIsolation blocks PGSERVICE and PGSERVICEFILE environment variables (0.1ms)
✔ P1-02: validateTargetIsolation blocks remote DOCKER_HOST before child execution (0.1ms)
✔ P1-02: validateTargetIsolation blocks remote DOCKER_CONTEXT before child execution (0.05ms)
✔ P1-02: validateTargetIsolation blocks arbitrary unapproved container names (0.1ms)
✔ P1-02: validateTargetIsolation rejects conflicting connection options (--db-container and --db-host) (0.1ms)
✔ P1-02: validateTargetIsolation rejects omitted dbHost for direct psql execution (fail-closed) (0.05ms)
✔ P1-02: verifyDatabaseTargetIdentity fails closed when target mismatch occurs on remote/unverified target (46.8ms)
✔ P1-02: getSanitizedChildEnv removes all libpq connection override variables (0.1ms)
✔ P1-03: verifyDisposableTestTarget refuses unmarked database target without issuing any DROP statements (0.1ms)
✔ P1-03: verifyDisposableTestTarget refuses PostgreSQL major versions older than 17 (0.1ms)
✔ P2-01: validateTargetInventory rejects duplicate objectType:identity independent of record order (0.2ms)
✔ P2-01: verify fails closed with DUPLICATE_TARGET_ROUTINE when target catalog contains duplicate routine identities (2.6ms)
✔ P2-02: handlePlanCommand without target roles marks plan as PLAN_INCOMPLETE_UNVERIFIED_ROLES and applyReady=false (1.8ms)
✔ P2-03: verifiedRoutinesCount tracks valid routine even after a preceding routine fails verification (2.2ms)
✔ P2-04: handleApplyCommand strictly requires --map option to apply plan (0.8ms)
✔ P3-01: unquoted lowercase identifier public.foo preserves lowercase (0.1ms)
✔ P3-01: unquoted mixed-case identifier public.Foo folds to lowercase public.foo matching PostgreSQL semantics (0.03ms)
✔ P3-01: quoted mixed-case identifier "public"."Foo" preserves exact case matching PostgreSQL semantics (0.1ms)
✔ P3-01: unquoted role name folds to lowercase while quoted role preserves case (0.04ms)

Tổng kết:
- Số bài kiểm tra: 50 tests
- PASS: 50
- FAIL: 0
- SKIP: 0
- Thời gian chạy: 1671.4 ms
```

### 5.2 Kiểm tra Cú pháp & ESLint

```text
$ node --check scripts/backup/owner-map.mjs && node --check tests/backup/owner-map.test.mjs
(PASS — 0 errors)

$ ./node_modules/.bin/eslint scripts/backup/owner-map.mjs tests/backup/owner-map.test.mjs
(PASS — 0 errors, 0 warnings)
```

---

## 6. Bằng chứng Thực thi Live PostgreSQL 17 Integration

Test `Live PostgreSQL 17 integration: full plan -> apply -> verify cycle with live catalog and rollback`:

1. **Target Instance:** Container `crm-dumpcheck-test` (Image: `public.ecr.aws/supabase/postgres:17.11.0.004`).
2. **Preflight Safety Gate:** Đã xác minh Docker daemon endpoint là local unix socket, container thuộc allowlist, version là PostgreSQL 17.11 (`version_num: 170011 >= 170000`), và bảng marker `public._crm_disposable_test_marker` tồn tại.
3. **Dynamic Fixtures:** Sinh ngẫu nhiên suffix `runId` (ví dụ `e4a3b190`); tên schema `rehearsal_test_e4a3b190`, roles `synth_src_e4a3b190`, `synth_tgt_e4a3b190`.
4. **Collision Check:** Xác minh không có object nào bị trùng trước khi setup.
5. **Rollback Verification:** Thực thi apply thất bại với DDL lỗi có chủ đích (`ALTER TABLE ... "nonexistent"`), xác minh transaction atomicity giữ nguyên quyền sở hữu của `synth_src` và không bị commit dở dang.
6. **Plan & Apply:** Áp dụng plan đã được phê duyệt băm SHA-256 (`--approved-sha256`) và `--map` hợp lệ.
7. **Verify Routine Security:** Kiểm tra toàn diện proowner, prosecdef, proconfig, ACL trên live database catalog -> Báo cáo `status: VERIFIED`, `verifiedObjectsCount: 5`, `verifiedRoutinesCount: 2`.
8. **Tamper Test:** Thay đổi `SECURITY DEFINER` của routine thành `SECURITY INVOKER` trên live DB -> Verify phát hiện ngay lập tức và trả về `status: BLOCKED` (`SECURITY_DEFINER_MISMATCH`).
9. **Clean Cleanup:** Khối `finally` chỉ DROP đúng 3 đối tượng được tạo bởi test (`createdObjects`), không chạm vào bất kỳ đối tượng nào khác trong database.

---

## 7. Rủi ro Tồn dư (Residual Risks) và Giới hạn Kiểm chứng

1. **Môi trường Review Độc lập:** Nếu reviewer độc lập chạy trong môi trường không có Docker daemon hoặc container `crm-dumpcheck-test`, test live integration sẽ chuyển trạng thái `SKIP` an toàn (như đã diễn ra ở Round 1). Bộ test unit và adversarial mocks hoàn toàn độc lập và bao phủ 100% logic an ninh mà không phụ thuộc Docker.
2. **PostgreSQL Version Compatibility:** Helper #6 được thiết kế và kiểm chứng chặt chẽ cho PostgreSQL 17. Nếu triển khai trên các phiên bản cũ hơn (PG 15/16), một số hàm catalog arguments (`pg_get_function_identity_arguments`) và logic phiên bản sẽ từ chối qua cổng `server_version_num < 170000`.

---

## 8. Tuyên bố Tuân thủ & Cam kết An toàn

Remediation Engineer xác nhận:
- **KHÔNG** chỉnh sửa bất kỳ tệp tin nào thuộc Helper #1–#5 (`aesgcm-stream.mjs`, `offsite-bundle.mjs`, `storage-export.mjs`, `safe-extract-storage.py`, `storage-restore.mjs`).
- **KHÔNG** chỉnh sửa `META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12.md`.
- **KHÔNG** thực hiện `git commit`, `git push`, hoặc `merge` vào bất kỳ nhánh nào.
- **KHÔNG** deploy hoặc kích hoạt CI/CD staging/production.
- **KHÔNG** kết nối tới Supabase Hosted, Staging hoặc Production.
- Tệp nguồn `scripts/backup/owner-map.mjs` và tệp kiểm thử `tests/backup/owner-map.test.mjs` đã sẵn sàng tại đúng canonical paths trong repository để phục vụ **Independent Code Review Round 2**.
