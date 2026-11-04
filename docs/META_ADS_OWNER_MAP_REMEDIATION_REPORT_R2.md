# Báo cáo Khắc phục Độc lập — Helper #6: PostgreSQL Owner Map (Round 3 Preparation / Remediation Round 2)

**Ngày báo cáo:** 2026-11-02  
**Tác giả:** Senior PostgreSQL & Application Security Remediation Engineer  
**Đối tượng:** Independent Security Code Reviewer Round 3, Platform & Database Custodians  
**Trạng thái:** **REMEDIATED & PASSING — READY FOR INDEPENDENT CODE REVIEW ROUND 3**

---

## 1. Thông tin Workspace, Repository Root, Worktree, Branch và HEAD

| Mục | Chi tiết |
|---|---|
| **Repository Root** | `/Users/hoangthuy/ai-crm-cua-chong-ngap` |
| **Canonical Remediation Worktree** | `/Users/hoangthuy/.gemini/antigravity/worktrees/ai-crm-cua-chong-ngap/remediate_owner_map_security` |
| **Active Branch** | `remediate_owner_map_security` |
| **Base Commit SHA** | `3abe0d78a7f162f6d5cde2e9adb719ebe6963075` (Merge branch 'chore/remove-legacy-backend-and-schema') |
| **Node.js Runtime** | `v24.15.0` (Darwin arm64) |
| **Python Runtime** | `Python 3.14.0` |
| **PostgreSQL Target** | PostgreSQL 17.11 (local disposable test container `crm-dumpcheck-test`) |

---

## 2. Git Status Trước và Sau Remediation

### 2.1 Git Status Trước Remediation

Nhánh `remediate_owner_map_security` tại commit `3abe0d78a7f162f6d5cde2e9adb719ebe6963075` ở trạng thái sạch. Các tệp tin đầu vào được đối chiếu và sao chép từ workspace remediation Round 1 (`remediate_owner_map_helper`), đảm bảo hash SHA-256 ban đầu khớp 100% với baseline quy định tại Section 1 của yêu cầu.

### 2.2 Git Status Sau Remediation

```text
On branch remediate_owner_map_security
Untracked files:
  (use "git add <file>..." to include in what will be committed)
	docs/META_ADS_OWNER_MAP_REMEDIATION_REPORT.md
	docs/META_ADS_OWNER_MAP_REMEDIATION_REPORT_R2.md
	docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12.md
	docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12_AMENDMENT_HELPER4.md
	scripts/
	tests/backup/

nothing added to commit but untracked files present
```

Tuân thủ nghiêm ngặt **Strict Safety Boundaries** (Section 9):
- **KHÔNG** `git commit`
- **KHÔNG** `git push`
- **KHÔNG** merge PR, deploy, migration, hoặc thay đổi schema production.
- Toàn bộ thay đổi chỉ nằm trong các tệp tin cho phép (`scripts/backup/owner-map.mjs`, `tests/backup/owner-map.test.mjs`, và báo cáo `docs/META_ADS_OWNER_MAP_REMEDIATION_REPORT_R2.md`).

---

## 3. Bảng Định danh SHA-256 Trước và Sau Remediation

| Tệp tin | SHA-256 Trước Remediation (Baseline) | SHA-256 Sau Remediation (Remediated) | Trạng thái |
|---|---|---|---|
| `scripts/backup/owner-map.mjs` | `5fac92d90e022eaebe092b993dd0adb8c02194a1a9f4db95d2a87462b7625f85` | `fc65c3103dd0c97bc39b0a2ff463d080ec29076d3763b87d271cfaf25b0f84c4` | Sửa đổi & Kiểm chứng |
| `tests/backup/owner-map.test.mjs` | `80b1eae5434611f7e68c1ad33c24b6b95e2dd0fa0e01a323f78457be2ed0937f` | `c4fd4e519b35e8e7dfdf70211c46aa3137efa580d47afc75d8d9ffa5cc203c85` | Bổ sung Adversarial Suites |
| `docs/META_ADS_OWNER_MAP_REMEDIATION_REPORT.md` | `1cbbcfd5cc292757895640889ced2b890f6c6559e315d39700791b96009daf8f` | `1cbbcfd5cc292757895640889ced2b890f6c6559e315d39700791b96009daf8f` | Giữ nguyên (Untouched) |
| `docs/META_ADS_OWNER_MAP_REMEDIATION_REPORT_R2.md` | *(Tạo mới)* | *(Báo cáo hiện tại)* | Báo cáo Round 2 / R3 Prep |

---

## 4. Chi tiết Các Finding, Root Cause và Biện pháp Khắc phục

### R2-P1-01 — SQL Injection Through Project Metadata

- **Mức độ:** P1 (Acceptance Blocker / Security Critical).
- **Vị trí phát hiện:** `scripts/backup/owner-map.mjs:749, 1127`.
- **Root Cause:**
  `sourceProjectRef` và `target` chỉ được kiểm tra điều kiện chuỗi không rỗng (`typeof str === 'string' && str.trim().length > 0`), mà không kiểm tra ký tự xuống dòng (`\n`, `\r\n`), ký tự điều khiển (NUL, control chars), hay Unicode line separators (`\u2028`, `\u2029`, `\u0085`).
  Hai giá trị này được đưa trực tiếp vào header SQL comments:
  ```sql
  -- Source Project: ${mapData.sourceProjectRef}
  -- Target: ${mapData.target}
  ```
  Nếu giá trị chứa `\nDROP TABLE users; --`, câu lệnh injection sẽ thoát khỏi comment và thực thi ngoài transaction `BEGIN/COMMIT`. Hơn nữa, lệnh `apply` trước đây không kiểm tra ngữ pháp (grammar) của tệp SQL trước khi nạp vào `psql`.
- **Giải pháp khắc phục:**
  1. Triển khai hàm kiểm tra metadata nghiêm ngặt `validateMetadataIdentifier(value, fieldName)`:
     - Kiểm tra độ dài: tối đa 128 ký tự.
     - Phát hiện và từ chối ngay lập tức: CR (`\r`), LF (`\n`), CRLF (`\r\n`), NUL (`\0`), control characters (`[\x00-\x1F\x7F-\x9F]`), và Unicode line/paragraph separators (`\u2028`, `\u2029`, `\u0085`, `\u000B`, `\u000C`) với mã lỗi `SQL_INJECTION_DETECTED`.
     - Từ chối các ký tự SQL nguy hiểm: chấm phẩy (`;`), comment delimiters (`--`, `/*`), dấu nháy đơn (`'`), nháy kép (`"`), backtick (`` ` ``).
     - Kiểm tra định dạng contract: strictly alphanumeric kèm dấu gạch dưới, gạch ngang và dấu chấm (`/^[a-zA-Z0-9_\-\.]{1,128}$/`).
     - Quét từ khoá DDL cấm: từ chối các chuỗi chứa `DROP`, `ALTER`, `CREATE`, `SELECT`, `INSERT`, `DELETE`, `UPDATE`, `GRANT`, `REVOKE`.
  2. Áp dụng `validateMetadataIdentifier` cho `sourceProjectRef` và `target` trong:
     - `validateOwnerMap()` (trước khi tạo plan).
     - `handlePlanCommand()`.
     - `handleApplyCommand()`.
     - `handleVerifyCommand()`.
  3. Triển khai bộ kiểm tra ngữ pháp SQL nghiêm ngặt `validatePlanSqlGrammar(sqlText)`:
     - Quét toàn bộ tệp SQL kế hoạch.
     - Nghiêm cấm null bytes và ký tự điều khiển/Unicode line breaks.
     - Chỉ chấp nhận 4 dạng dòng hợp lệ: dòng chú thích `-- ...`, dòng trống, `BEGIN;`, và các câu lệnh `ALTER (SCHEMA|TABLE|PARTITIONED TABLE|FOREIGN TABLE|SEQUENCE|VIEW|MATERIALIZED VIEW|TYPE|DOMAIN|FUNCTION|PROCEDURE) ... OWNER TO ...;`, kết thúc bằng `COMMIT;`.
     - Phát hiện và từ chối dấu chấm phẩy bên trong dòng comment (`SQL_INJECTION_DETECTED`).
     - Từ chối mọi câu lệnh nằm ngoài khối `BEGIN; ... COMMIT;`.
     - Từ chối mọi câu lệnh chứa từ khoá nguy hiểm: `DROP`, `CREATE`, `GRANT`, `REVOKE`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `EXECUTE`, `CALL`, `SUPERUSER`.
     - Kích hoạt kiểm tra ngữ pháp cả khi tạo plan (`generateOwnerMapPlan`) và trước khi thực thi apply (`handleApplyCommand`).
- **Trạng thái:** **CLOSED** (Có 9 bài test adversarial kiểm chứng).

---

### R2-P1-02 — Docker Local-Only Isolation Bypass

- **Mức độ:** P1 (Acceptance Blocker / Security Critical).
- **Vị trí phát hiện:** `scripts/backup/owner-map.mjs:934-950`; `tests/backup/owner-map.test.mjs:99-120`.
- **Root Cause:**
  Kiểm tra `DOCKER_HOST` sử dụng phương thức chuỗi con thô sơ (`dh.includes('127.0.0.1') || dh.includes('localhost')`), cho phép kẻ tấn công vượt qua bằng domain lừa đảo như `tcp://127.0.0.1.evil.example:2375` hoặc `tcp://localhost.attacker.invalid:2375`.
  Đồng thời, `DOCKER_CONTEXT` chỉ kiểm tra chuỗi tên context (từ chối nếu tên chứa `remote`, `prod`, `staging`), mà không xác minh endpoint thực tế phía sau context. Một context có tên tưởng chừng vô hại như `local_dev` nhưng trỏ tới `ssh://remote-host` hoặc remote TCP sẽ bị bỏ lọt.
- **Giải pháp khắc phục:**
  1. Triển khai bộ phân tích URL chuẩn `parseAndValidateDockerEndpoint(rawEndpoint)`:
     - Phân tích cú pháp bằng `new URL()`.
     - Chỉ chấp nhận các dạng endpoint local đã được xác minh:
       - Unix domain socket: `unix:///path/to/sock` hoặc đường dẫn tuyệt đối local socket.
       - Windows named pipe: `npipe:////./pipe/...`.
       - TCP Loopback: hostname phải chính xác tuyệt đối là `127.0.0.1`, `localhost`, `::1`, hoặc `[::1]`.
     - Từ chối mọi domain giả mạo loopback (`127.0.0.1.evil.example`, `localhost.attacker.invalid`).
     - Từ chối mọi địa chỉ IP mạng ngoài (`192.168.x.x`, `10.x.x.x`, v.v.).
     - Từ chối mọi giao thức SSH (`ssh://...`).
  2. Triển khai hàm truy xuất endpoint thực tế của Docker context `resolveDockerContextEndpoint(contextName, opts)`:
     - Đọc trực tiếp siêu dữ liệu context từ `~/.docker/contexts/meta/` (offline inspection).
     - Hoặc truy vấn `docker context inspect <context> --format '{{.Endpoints.docker.Host}}'` an toàn.
     - Hỗ trợ mock/injected `contextInspector` phục vụ kiểm thử cô lập mà không cần daemon thật.
     - Sau khi lấy được endpoint thực tế, bắt buộc chuyển qua `parseAndValidateDockerEndpoint()`. Nếu endpoint là remote hoặc không thể xác minh, fail-closed ngay lập tức với `REMOTE_DOCKER_CONTEXT_BLOCKED`.
  3. Đảm bảo môi trường thực thi của tiến trình con (`getSanitizedChildEnv`) loại bỏ toàn bộ các biến cấu hình kết nối libpq và không cho phép ghi đè các tham số cô lập.
  4. Đặt Safety Gate trước mọi lời gọi Docker invocation (kể cả availability probe và test preflight).
- **Trạng thái:** **CLOSED** (Có 9 bài test adversarial kiểm chứng).

---

### R2-P2-01 — PostgreSQL Role Case Preservation

- **Mức độ:** P2 (Correctness & Catalog Fidelity Gap).
- **Vị trí phát hiện:** `validateRoleIdentifier()`, `validateOwnerInventory()`, `validateTargetInventory()`, `validateRoutineEntry()`, `validateOwnerMap()`, `extractRoleNames()`, `generateAlterOwnerStatement()`.
- **Root Cause:**
  `validateRoleIdentifier('Old_Admin')` trước đây tự động chuyển đổi chuỗi không có ngoặc kép thành chữ thường (`trimmed.toLowerCase()`).
  Điều này làm sai lệch ngữ nghĩa khi tên role được lấy trực tiếp từ catalog của PostgreSQL (`pg_roles.rolname` hoặc `pg_proc.proowner`). Trong PostgreSQL, một role được tạo bằng cú pháp phân biệt hoa thường như `CREATE ROLE "Old_Admin";` sẽ lưu chính xác chuỗi `"Old_Admin"` trong catalog. Nếu hệ thống tự động lowercase thành `old_admin`:
  - Không thể phân biệt hai role `Old_Admin` và `old_admin` cùng tồn tại.
  - Ánh xạ role bị sai lệch hoặc ném lỗi `NONEXISTENT_TARGET_ROLE`.
  - Câu lệnh DDL sinh ra `ALTER ... OWNER TO "old_admin"` thay vì `"Old_Admin"`, bàn giao quyền sở hữu sai người dùng.
  - Quá trình verify đối chiếu giữa actual owner trong catalog (`Old_Admin`) và expected owner bị lowercase (`old_admin`) sẽ báo lỗi sai.
- **Giải pháp khắc phục:**
  1. Phân biệt rõ ràng giữa **SQL Lexical Token** và **Catalog Role Identity**:
     - Khi xử lý tên role từ catalog hoặc owner mapping: bảo toàn nguyên vẹn chữ hoa/thường (`Old_Admin` giữ nguyên là `Old_Admin`).
     - Khi unquote một identifier có ngoặc kép (ví dụ `"Old_Admin"` hoặc `"Admin""Special"`): gỡ bỏ ngoặc kép ngoài, unescape dấu ngoặc kép đôi bên trong, và bảo toàn case (`Old_Admin`, `Admin"Special`).
     - Chỉ chuyển thành lowercase khi cờ `options.isSqlToken === true` được truyền rõ ràng (đáp ứng tiêu chuẩn ngữ nghĩa token SQL thuần).
  2. Chuẩn hoá và cập nhật các hàm xử lý dữ liệu:
     - `validateOwnerInventory()`: lưu trữ `cleanSourceOwner` case-preserved vào từng bản ghi item.
     - `validateTargetInventory()`: lưu trữ `cleanOwner` case-preserved vào `targetObjectMap`.
     - `validateRoutineEntry()`: bảo toàn case của `owner` hàm/thủ tục.
     - `validateOwnerMap()`: lưu trữ mapping chính xác case cho cả `sourceOwner` và `targetOwner`.
     - `extractRoleNames()`: trích xuất danh sách role đích giữ nguyên case.
  3. Trong `generateAlterOwnerStatement()`: sử dụng `quoteIdent(targetOwner)` để tạo chuỗi SQL an toàn. `quoteIdent("Old_Admin")` sinh ra `"Old_Admin"`, đảm bảo PostgreSQL nhận diện chính xác role đích phân biệt hoa thường.
  4. Trong `handleVerifyCommand()`: đối chiếu quyền sở hữu chính xác theo từng byte chữ hoa/thường. Nếu database trả về `Old_Admin` nhưng plan kỳ vọng `old_admin`, hệ thống lập tức phát hiện `OWNER_MISMATCH` và fail-closed với `BLOCKED`.
- **Trạng thái:** **CLOSED** (Có 6 bài test case-sensitive kiểm chứng).

---

### R2-P2-02 — Docker Integration Test Portability and Safety

- **Mức độ:** P2 (Portability & Safety Gate Ordering).
- **Vị trí phát hiện:** `tests/backup/owner-map.test.mjs:87-120`.
- **Root Cause & Kiểm chứng Thực tế:**
  Kiểm tra thực tế source code cho thấy cơ chế `t.skip()` khi không có container đã được trang bị từ trước. Tuy nhiên, có một sơ hở về thứ tự thực thi: hàm probe `isDockerContainerAvailable()` gọi trực tiếp `runDockerPsql(containerName, 'SELECT 1;')` **trước khi** chạy Safety Gate `verifyDisposableTestTarget()`.
  Nếu môi trường kiểm thử có biến `DOCKER_HOST` trỏ ra remote, probe kiểm tra container sẽ vô tình thực thi lệnh `docker exec` ra máy chủ remote trước khi kịp phát hiện lỗi.
- **Giải pháp khắc phục:**
  1. Đưa cổng an toàn kiểm tra endpoint local (`parseAndValidateDockerEndpoint` và `resolveDockerContextEndpoint`) vào ngay dòng đầu tiên của `isDockerContainerAvailable()`.
  2. Nếu `DOCKER_HOST` hoặc `DOCKER_CONTEXT` không phải là local loopback đã xác minh, probe lập tức trả về `false` và từ chối gọi bất kỳ lệnh Docker CLI nào.
  3. Khi Docker CLI không được cài đặt (lỗi `ENOENT`) hoặc Docker daemon không chạy, probe bắt lỗi an toàn và trả về `false`, cho phép test tích hợp skip có lý do rõ ràng mà không làm gãy toàn bộ test suite.
  4. Kiểm chứng độc lập các bài kiểm thử unit và adversarial mocks hoàn toàn độc lập với Docker daemon.
- **Trạng thái:** **CLOSED & VERIFIED** (Có 4 bài test kiểm chứng hành vi).

---

## 5. Chi tiết Thay đổi Mã nguồn (Code Changes)

### 5.1 `scripts/backup/owner-map.mjs`

1. **Imports:** Bổ sung `os` và `execFileSync` từ `node:child_process` để phục vụ context resolution offline.
2. **`validateMetadataIdentifier(value, fieldName)`:**
   - Kiểm tra ranh giới ký tự CR, LF, CRLF, NUL, control chars, Unicode line/paragraph separators (`\u2028`, `\u2029`, `\u0085`).
   - Kiểm tra độ dài và biểu thức chính quy contract `/^[a-zA-Z0-9_\-\.]{1,128}$/`.
   - Quét từ khoá DDL injection (`DROP`, `ALTER`, `CREATE`, `SELECT`, `INSERT`, `DELETE`, `UPDATE`, `GRANT`, `REVOKE`).
3. **`validatePlanSqlGrammar(sqlText)`:**
   - Quét cấu trúc kế hoạch SQL trước khi xuất bản và trước khi thực thi apply.
   - Enforce: dòng chú thích `--`, `BEGIN;`, `ALTER ... OWNER TO ...;`, `COMMIT;`.
   - Ngăn chặn dấu chấm phẩy trong dòng comment và các câu lệnh phá hoại ngoài phạm vi.
4. **`parseAndValidateDockerEndpoint(rawEndpoint)`:**
   - Phân tích cú pháp URL chính xác cho Docker daemon.
   - Cho phép Unix sockets local, Windows named pipes local, và TCP loopbacks (`127.0.0.1`, `localhost`, `::1`).
   - Chặn domain lừa đảo, remote IPs và SSH.
5. **`resolveDockerContextEndpoint(contextName, opts)`:**
   - Đọc siêu dữ liệu từ `~/.docker/contexts/meta/` hoặc CLI inspect.
   - Hỗ trợ mock `contextInspector` phục vụ kiểm thử cô lập.
6. **`validateRoleIdentifier(role, label, options)`:**
   - Mặc định bảo toàn chữ hoa/thường cho catalog role names.
   - Hỗ trợ gỡ bỏ quoting an toàn cho quoted identifiers (`"Old_Admin"`, `"Admin""Special"`).
   - Chỉ lowercase khi có cờ `options.isSqlToken === true`.
7. **Cập nhật các command handlers:**
   - `handlePlanCommand`: validate metadata options (`target`, `sourceProjectRef`).
   - `handleApplyCommand`: validate cú pháp grammar tệp `plan.sql` trước khi nạp vào database; validate metadata target.
   - `handleVerifyCommand`: validate metadata options; đối chiếu ownership bảo toàn case chữ hoa/thường.

### 5.2 `tests/backup/owner-map.test.mjs`

1. **Safety Gate:** Cập nhật `isDockerContainerAvailable()` và `verifyDisposableTestTarget()` sử dụng `parseAndValidateDockerEndpoint` và `resolveDockerContextEndpoint`.
2. **Cập nhật Test cũ:** Điều chỉnh test P3-01 truyền `{ isSqlToken: true }` khi kiểm tra ngữ nghĩa fold lowercase của SQL parser.
3. **Bổ sung 28 bài kiểm thử chuyên sâu:**
   - 9 tests cho **R2-P1-01** (newline, CRLF, DROP TABLE injection, target newline, Unicode separators, control chars, deterministic plan, grammar validation, comment semicolon).
   - 9 tests cho **R2-P1-02** (127.0.0.1.evil domain bypass, localhost.attacker domain bypass, remote IP, SSH host, benign context pointing to remote TCP/SSH, local unix socket pass, loopback pass, unresolvable context fail-closed).
   - 6 tests cho **R2-P2-01** (`old_admin`, `Old_Admin`, dual-case co-existence and distinct mapping, quoted mixed-case, internal quote escaping, case-sensitive verify matching and mismatch blocking).
   - 4 tests cho **R2-P2-02** (missing Docker CLI ENOENT, stopped Docker daemon, remote DOCKER_HOST avoidance, clean test skip).

---

## 6. Danh mục Bài kiểm thử Tái hiện Lỗi và Bằng chứng Ngăn chặn

| Test Name | Finding Đối ứng | Trạng thái |
|---|---|---|
| `R2-P1-01: project ref containing newline is rejected before plan generation` | R2-P1-01 | PASS (`SQL_INJECTION_DETECTED`) |
| `R2-P1-01: project ref containing CRLF is rejected before plan generation` | R2-P1-01 | PASS (`SQL_INJECTION_DETECTED`) |
| `R2-P1-01: project ref containing SQL DROP TABLE is rejected before plan generation` | R2-P1-01 | PASS (`SQL_INJECTION_DETECTED`) |
| `R2-P1-01: target containing newline and SQL injection is rejected before plan generation` | R2-P1-01 | PASS (`SQL_INJECTION_DETECTED`) |
| `R2-P1-01: project ref with Unicode line separator (\u2028, \u2029, \u0085) is rejected` | R2-P1-01 | PASS (`SQL_INJECTION_DETECTED`) |
| `R2-P1-01: project ref with NUL byte and control characters is rejected` | R2-P1-01 | PASS (`SQL_INJECTION_DETECTED`) |
| `R2-P1-01: valid project ref and target generate byte-for-byte deterministic plan` | R2-P1-01 | PASS (Deterministic SHA-256) |
| `R2-P1-01: plan grammar validation blocks unauthorized statement during apply even if hash is forged` | R2-P1-01 | PASS (`UNAUTHORIZED_STATEMENT`) |
| `R2-P1-01: plan grammar validation rejects semicolon in SQL comment` | R2-P1-01 | PASS (`SQL_INJECTION_DETECTED`) |
| `R2-P1-02: DOCKER_HOST tcp://127.0.0.1.evil.example:2375 is rejected by parser` | R2-P1-02 | PASS (`REMOTE_DOCKER_HOST_BLOCKED`) |
| `R2-P1-02: DOCKER_HOST tcp://localhost.attacker.invalid:2375 is rejected by parser` | R2-P1-02 | PASS (`REMOTE_DOCKER_HOST_BLOCKED`) |
| `R2-P1-02: DOCKER_HOST remote IP tcp://192.168.1.100:2375 is rejected by parser` | R2-P1-02 | PASS (`REMOTE_DOCKER_HOST_BLOCKED`) |
| `R2-P1-02: DOCKER_HOST ssh://remote-host is rejected by parser` | R2-P1-02 | PASS (`REMOTE_DOCKER_HOST_BLOCKED`) |
| `R2-P1-02: DOCKER_CONTEXT with benign name but remote endpoint is rejected` | R2-P1-02 | PASS (`REMOTE_DOCKER_CONTEXT_BLOCKED`) |
| `R2-P1-02: DOCKER_CONTEXT with benign name but SSH endpoint is rejected` | R2-P1-02 | PASS (`REMOTE_DOCKER_CONTEXT_BLOCKED`) |
| `R2-P1-02: valid local Unix socket passes endpoint validation` | R2-P1-02 | PASS |
| `R2-P1-02: valid loopback endpoint (127.0.0.1 and localhost) passes endpoint validation` | R2-P1-02 | PASS |
| `R2-P1-02: unresolvable or missing Docker endpoint fails closed with rejection` | R2-P1-02 | PASS (`REMOTE_DOCKER_CONTEXT_BLOCKED`) |
| `R2-P2-01: role old_admin preserves exact lowercase` | R2-P2-01 | PASS (`old_admin`) |
| `R2-P2-01: role Old_Admin preserves exact mixed case (not lowercased)` | R2-P2-01 | PASS (`Old_Admin`) |
| `R2-P2-01: two roles co-existing with different case are preserved and mapped distinctly` | R2-P2-01 | PASS (2 câu lệnh DDL riêng biệt) |
| `R2-P2-01: quoted mixed-case role unquotes and preserves case` | R2-P2-01 | PASS (`ALTER ... OWNER TO "Old_Admin"`) |
| `R2-P2-01: SQL quoting safely escapes role containing quote character` | R2-P2-01 | PASS (`ALTER ... OWNER TO "Admin""Special"`) |
| `R2-P2-01: ownership verification with case-sensitive role matches exact case and blocks mismatch` | R2-P2-01 | PASS (`VERIFIED` khi trùng, `BLOCKED` khi khác case) |
| `R2-P2-02: isDockerContainerAvailable returns false and does not throw when Docker CLI is missing` | R2-P2-02 | PASS |
| `R2-P2-02: isDockerContainerAvailable returns false when Docker daemon is not running` | R2-P2-02 | PASS |
| `R2-P2-02: isDockerContainerAvailable returns false and avoids Docker command when DOCKER_HOST is remote` | R2-P2-02 | PASS (Không kích hoạt Docker) |
| `R2-P2-02: live integration test skips cleanly when container is unavailable` | R2-P2-02 | PASS (SKIPPED sạch sẽ) |

---

## 7. Kết quả Kiểm thử Hồi quy Toàn diện (Regression Test Results)

### 7.1 Helper #6 Suite (`tests/backup/owner-map.test.mjs`)

```text
$ node --test tests/backup/owner-map.test.mjs
✔ 1. Valid owner mapping: generates deterministic plan, verifies all 11 supported object types
✔ 2. Missing source-owner mapping: fails closed when an inventory owner has no mapping
✔ 3. Duplicate source owner in owner-map: fails closed with DUPLICATE_OWNER_MAPPING
✔ 4. Unknown source owner in owner-map: fails closed when mapping defines an owner absent from inventory
✔ 5. Nonexistent target role: fails closed when target role does not exist in target inventory
✔ 6. Invalid project/target identity: fails closed on format, projectRef, or target mismatch
✔ 7. Duplicate JSON keys: strict parser rejects root, nested, and escaped duplicate keys
✔ 8. SQL injection hardening: rejects injections in schema, table, function, and role identifiers
✔ 9. Function/procedure overload resolution: distinguishes overloaded functions with exact arguments
✔ 10. Deterministic SQL generation: identical byte-for-byte output regardless of input array ordering
✔ 11. Missing approval hash: apply fails closed when --approved-sha256 is missing
✔ 12. Incorrect approval hash: apply fails closed before database connection
✔ 13. Plan modified after approval: apply fails closed when plan bytes on disk are altered
✔ 14. Target identity and remote host mismatch: rejects remote endpoints and mismatched targets
✔ 15. Apply rollback when SQL fails: transaction atomicity ensures partial changes revert
✔ 16. Post-apply owner mismatch: verify fails closed with status BLOCKED
✔ 17. SECURITY DEFINER mismatch: verify detects altered prosecdef flag and sets status BLOCKED
✔ 18. proconfig mismatch: verify detects altered function configuration GUCs and sets status BLOCKED
✔ 19. EXECUTE ACL mismatch: verify detects altered execution privileges and sets status BLOCKED
✔ 20. Unsupported object type: fails closed on unknown or disallowed object types
✔ CLI integration: plan, apply, verify roundtrip via subprocess execution
✔ Prohibited SQL injection: rejects DROP, CREATE ROLE, GRANT, REVOKE keywords in generated statements
✔ Live PostgreSQL 17 integration: full plan -> apply -> verify cycle with live catalog and rollback
✔ P1-01: verify fails closed with MISSING_CATALOG_DETAILS when inventory contains routines but catalog is omitted
✔ P1-01: verify fails closed with MISSING_TARGET_ROUTINES when offline target catalog is omitted
✔ P1-01: verify fails closed with EMPTY_ROUTINES_CATALOG when inventory has routines but catalog is empty
✔ P1-01: verify fails closed with MALFORMED_CATALOG_DETAILS when routines is not an array
✔ P1-01: verify fails closed with MALFORMED_ROUTINE_ENTRY when routine has non-boolean securityDefiner
✔ P1-01: verify detects missing routine identity in source catalog and reports status BLOCKED
✔ P1-02: validateTargetIsolation blocks remote PGHOST in process environment before child execution
✔ P1-02: validateTargetIsolation blocks remote PGHOSTADDR in process environment before child execution
✔ P1-02: validateTargetIsolation blocks PGSERVICE and PGSERVICEFILE environment variables
✔ P1-02: validateTargetIsolation blocks remote DOCKER_HOST before child execution
✔ P1-02: validateTargetIsolation blocks remote DOCKER_CONTEXT before child execution
✔ P1-02: validateTargetIsolation blocks arbitrary unapproved container names
✔ P1-02: validateTargetIsolation rejects conflicting connection options (--db-container and --db-host)
✔ P1-02: validateTargetIsolation rejects omitted dbHost for direct psql execution (fail-closed)
✔ P1-02: verifyDatabaseTargetIdentity fails closed when target mismatch occurs on remote/unverified target
✔ P1-02: getSanitizedChildEnv removes all libpq connection override variables
✔ P1-03: verifyDisposableTestTarget refuses unmarked database target without issuing any DROP statements
✔ P1-03: verifyDisposableTestTarget refuses PostgreSQL major versions older than 17
✔ P2-01: validateTargetInventory rejects duplicate objectType:identity independent of record order
✔ P2-01: verify fails closed with DUPLICATE_TARGET_ROUTINE when target catalog contains duplicate routine identities
✔ P2-02: handlePlanCommand without target roles marks plan as PLAN_INCOMPLETE_UNVERIFIED_ROLES and applyReady=false
✔ P2-03: verifiedRoutinesCount tracks valid routine even after a preceding routine fails verification
✔ P2-04: handleApplyCommand strictly requires --map option to apply plan
✔ P3-01: unquoted lowercase identifier public.foo preserves lowercase
✔ P3-01: unquoted mixed-case identifier public.Foo folds to lowercase public.foo matching PostgreSQL semantics
✔ P3-01: quoted mixed-case identifier "public"."Foo" preserves exact case matching PostgreSQL semantics
✔ P3-01: unquoted role name folds to lowercase while quoted role preserves case
✔ R2-P1-01: project ref containing newline is rejected before plan generation
✔ R2-P1-01: project ref containing CRLF is rejected before plan generation
✔ R2-P1-01: project ref containing SQL DROP TABLE is rejected before plan generation
✔ R2-P1-01: target containing newline and SQL injection is rejected before plan generation
✔ R2-P1-01: project ref with Unicode line separator is rejected
✔ R2-P1-01: project ref with NUL byte and control characters is rejected
✔ R2-P1-01: valid project ref and target generate byte-for-byte deterministic plan
✔ R2-P1-01: plan grammar validation blocks unauthorized statement during apply even if hash is forged
✔ R2-P1-01: plan grammar validation rejects semicolon in SQL comment
✔ R2-P1-02: DOCKER_HOST tcp://127.0.0.1.evil.example:2375 is rejected by parser
✔ R2-P1-02: DOCKER_HOST tcp://localhost.attacker.invalid:2375 is rejected by parser
✔ R2-P1-02: DOCKER_HOST remote IP tcp://192.168.1.100:2375 is rejected by parser
✔ R2-P1-02: DOCKER_HOST ssh://remote-host is rejected by parser
✔ R2-P1-02: DOCKER_CONTEXT with benign name but remote endpoint is rejected
✔ R2-P1-02: DOCKER_CONTEXT with benign name but SSH endpoint is rejected
✔ R2-P1-02: valid local Unix socket passes endpoint validation
✔ R2-P1-02: valid loopback endpoint (127.0.0.1 and localhost) passes endpoint validation
✔ R2-P1-02: unresolvable or missing Docker endpoint fails closed with rejection
✔ R2-P2-01: role old_admin preserves exact lowercase
✔ R2-P2-01: role Old_Admin preserves exact mixed case (not lowercased)
✔ R2-P2-01: two roles co-existing with different case are preserved and mapped distinctly
✔ R2-P2-01: quoted mixed-case role unquotes and preserves case
✔ R2-P2-01: SQL quoting safely escapes role containing quote character
✔ R2-P2-01: ownership verification with case-sensitive role matches exact case and blocks mismatch
✔ R2-P2-02: isDockerContainerAvailable returns false and does not throw when Docker CLI is missing
✔ R2-P2-02: isDockerContainerAvailable returns false when Docker daemon is not running
✔ R2-P2-02: isDockerContainerAvailable returns false and avoids Docker command when DOCKER_HOST is remote
﹣ R2-P2-02: live integration test skips cleanly when container is unavailable # Container 'nonexistent-container-xyz' is not available; test skipped as intended.

Tổng kết Helper #6:
- Số bài kiểm tra: 78 tests
- PASS: 77
- FAIL: 0
- SKIP: 1 (Test chủ động kiểm chứng hành vi graceful skip khi thiếu container)
- Thời gian chạy: 2.11 s
```

### 7.2 Kiểm tra Cú pháp & ESLint

```text
$ node --check scripts/backup/owner-map.mjs && node --check tests/backup/owner-map.test.mjs
(PASS — 0 errors)

$ ./node_modules/.bin/eslint scripts/backup/owner-map.mjs tests/backup/owner-map.test.mjs
(PASS — 0 errors, 0 warnings)
```

### 7.3 Hồi quy Helpers #1–#5 và Contracts Liên quan

| Test Suite | File | Tests Run | PASS | FAIL | SKIP |
|---|---|---|---|---|---|
| **Helper #1 (AES-GCM Stream)** | `tests/backup/aesgcm-stream.test.mjs` | 48 | 48 | 0 | 0 |
| **Helper #2 (Offsite Bundle)** | `tests/backup/offsite-bundle.test.mjs` | 19 | 19 | 0 | 0 |
| **Helper #3 (Bundle Index Contract)** | `tests/backup/validate-bundle-index-contract.test.mjs` | 12 | 12 | 0 | 0 |
| **Helper #4 (Storage Export)** | `tests/backup/storage-export.test.mjs` | 37 | 37 | 0 | 0 |
| **Helper #5 (Storage Restore)** | `tests/backup/storage-restore.test.mjs` | 45 | 45 | 0 | 0 |
| **Safe Extract Storage (Python)** | `tests/backup/safe-extract-storage.test.py` | 71 | 70 | 0 | 1 |
| **Helper #4 Amendment (Python)** | `tests/backup/helper4-runbook-amendment.integration.test.py` | 4 | 4 | 0 | 0 |
| **Helper #6 (Remediated Owner Map)** | `tests/backup/owner-map.test.mjs` | 78 | 77 | 0 | 1 |
| **Tổng cộng** | | **314** | **312** | **0** | **2** |

Tất cả 312 bài kiểm tra pass tuyệt đối, 0 FAIL, 2 SKIP đã được xác nhận lý do chính đáng.

---

## 8. Rủi ro Tồn dư (Residual Risks)

1. **PostgreSQL Version Requirement:** Helper #6 yêu cầu PostgreSQL 17 trở lên do sử dụng các hàm catalog arguments hiện đại (`pg_get_function_identity_arguments`). Khi chạy trên các phiên bản cũ hơn, cổng an toàn `version_num < 170000` sẽ chủ động chặn thực thi.
2. **Local Rehearsal Container Dependency:** Lệnh apply trực tiếp và live catalog verification yêu cầu Docker local daemon cùng container được phê duyệt (`APPROVED_CONTAINERS`). Nếu môi trường kiểm thử độc lập không có Docker, toàn bộ bộ test unit và adversarial fixtures (77 tests) vẫn chạy và xác minh đầy đủ tính an toàn.

---

## 9. Các Test Không Chạy Được và Lý do (Skipped Tests)

1. `tests/backup/owner-map.test.mjs` — Test: `R2-P2-02: live integration test skips cleanly when container is unavailable`:
   - **Lý do SKIP:** Đây là test có chủ đích kiểm chứng hành vi graceful skip khi truyền container không tồn tại (`nonexistent-container-xyz`), nhằm đảm bảo hệ thống không quăng lỗi uncaught exception khi thiếu môi trường Docker.
2. `tests/backup/safe-extract-storage.test.py` — Test: `test_old_format_tar_skipped`:
   - **Lý do SKIP:** Kiểm tra tính tương thích với định dạng tar cũ không được kích hoạt trên hệ thống thử nghiệm hiện tại (thuộc bộ test có sẵn từ Helper #4).

---

## 10. Xác nhận Ranh giới An toàn và Tính Toàn vẹn Ngoài Phạm vi

Remediation Engineer xác nhận bằng lệnh `diff -u` đối chiếu trực tiếp:
- **`docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12.md`:** Khớp 100% từng byte với baseline, **KHÔNG CÓ BẤT KỲ SỰ THAY ĐỔI NÀO**.
- **`docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12_AMENDMENT_HELPER4.md`:** Khớp 100% từng byte.
- **Helper #1 (`scripts/backup/aesgcm-stream.mjs`):** Khớp 100% từng byte.
- **Helper #2 (`scripts/backup/offsite-bundle.mjs`):** Khớp 100% từng byte.
- **Helper #3 Contract Schema:** Khớp 100% từng byte.
- **Helper #4 (`scripts/backup/storage-export.mjs`):** Khớp 100% từng byte.
- **Helper #5 (`scripts/backup/storage-restore.mjs`):** Khớp 100% từng byte.
- **Safe Extract (`scripts/backup/safe-extract-storage.py`):** Khớp 100% từng byte.
- **Tuyệt đối không commit, không push, không kết nối remote / hosted endpoints.**

---

## 11. Kết luận và Bàn giao (Final Verdict)

Toàn bộ các finding từ Independent Code Review Round 2 (**R2-P1-01, R2-P1-02, R2-P2-01, R2-P2-02**) đã được khắc phục triệt để, có đầy đủ bài kiểm tra tái hiện lỗi cũ và kiểm chứng cơ chế phòng thủ mới.

**VERDICT:** **READY FOR INDEPENDENT REVIEW ROUND 3**
