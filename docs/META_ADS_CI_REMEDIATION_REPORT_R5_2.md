# Báo Cáo Khắc Phục CI & An Toàn Docker Round 5.2 (Addendum)

**Dự án:** `hoanganhngo847-a11y/ai-crm-cua-chong-ngap`<br/>
**Pull Request:** [#140](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/pull/140)<br/>
**Branch:** `integration/meta-ads-backup-restore`<br/>
**Baseline Review SHA:** `7f74235a54add569e29bdc5a34b44946da758a9b`<br/>
**Remediation Implementation SHA:** `1d3f5fb8f56bafa6a99af907051a18356ac83b6d`<br/>
**Ngày thực hiện:** 03/11/2026<br/>
**Trạng thái:** **READY FOR INDEPENDENT REVIEW** (Chờ Independent Reviewer nghiệm thu)

---

## 1. Bối cảnh & Findings từ Independent Review

Trong đợt Independent Review sau Round 5.1, kiểm tra an toàn Docker đã phát hiện hai lỗ hổng P1 liên quan đến Docker Local-Only Guard và Container Ownership Safety:

### Finding 1 (P1): Docker local-only guard chưa kiểm tra effective context
- **Hiện tượng:** Hàm `assert_local_docker()` trước đây chỉ kiểm tra hai biến môi trường `DOCKER_HOST` và `DOCKER_CONTEXT`. Nếu nhà phát triển hoặc reviewer đã chọn context từ trước bằng lệnh `docker context use <remote-context>` (ví dụ `docker context use production-remote`), nhưng trong môi trường shell không khai báo `DOCKER_HOST` hay `DOCKER_CONTEXT`, Docker CLI vẫn tự động kết nối tới remote daemon. Guard cũ hoàn toàn bỏ lọt trường hợp này, vi phạm nguyên tắc bắt buộc local-only.

### Finding 2 (P1): Cleanup có thể xóa nhầm container của hệ thống khác
- **Hiện tượng:** Trong `ci-postgres17.sh`:
  - Lệnh `start()` thực hiện `docker rm -f "${CONTAINER_NAME}"` mặc định mà không xác minh container đã tồn tại có đúng do script tạo hay không.
  - Lệnh `stop()` xóa container chỉ dựa vào tên container.
  - `stop()` và `logs()` chưa gọi `assert_local_docker()` trước khi tương tác với Docker daemon.
  - Biến `CRM_PG17_CONTAINER` có thể bị cấu hình trùng tên với database cục bộ hoặc container của dự án khác, dẫn đến nguy cơ vô tình xóa nhầm dữ liệu của developer/staging.

---

## 2. Root Cause Analysis

1. **Thiếu giải quyết Effective Docker Endpoint:** Docker CLI có cơ chế thứ bậc ưu tiên (`DOCKER_HOST` > `DOCKER_CONTEXT` > `currentContext` trong `~/.docker/config.json` / context hoạt động từ `docker context show` > `default`). Code trước đây chỉ kiểm tra khi biến môi trường tồn tại, giả định ngầm rằng nếu biến môi trường vắng mặt thì Docker context mặc định là an toàn.
2. **Thiếu định danh quyền sở hữu (Ownership Markers):** Container disposable trước đây chỉ có nhãn một chiều `--label crm.disposable-test=true` khi khởi tạo, nhưng không có metadata chi tiết (`crm.owner`, `crm.purpose`) và không có bước xác minh nhãn trước khi gọi `docker rm -f`. Bất kỳ container nào trùng tên `CONTAINER_NAME` đều bị xóa không điều kiện.

---

## 3. Danh sách File Thay đổi (Files Changed)

| File | Thay đổi chính |
|---|---|
| `scripts/backup/ci-postgres17.sh` | Viết lại `assert_local_docker()` kiểm tra effective Docker context theo đúng thứ tự ưu tiên; bổ sung `check_container_ownership()`; gọi guard trước `start`, `stop`, `logs`; gắn 3 nhãn ownership (`crm.disposable-test=true`, `crm.owner=ci-postgres17`, `crm.purpose=pg17-backup-restore-test`); chặn xóa và chặn đọc logs nếu container không xác minh được ownership. |
| `scripts/backup/owner-map.mjs` | Bổ sung hàm `resolveEffectiveDockerEndpoint()` xử lý đầy đủ thứ tự ưu tiên Docker CLI; cập nhật `validateTargetIsolation()` kiểm tra effective context cho container mode ngay cả khi không có `DOCKER_HOST`/`DOCKER_CONTEXT`. |
| `tests/backup/owner-map.test.mjs` | Cập nhật `isDockerContainerAvailable()` và `verifyDisposableTestTarget()` sử dụng `resolveEffectiveDockerEndpoint()`; bổ sung 7 test case R5.2-P1 cho effective context; tích hợp bộ test tự động Groups A & B. |
| `tests/backup/docker-safety.test.mjs` | **New file.** Bộ kiểm thử hành vi thực tế (20/20 test) sử dụng mock Docker CLI dispatching, ghi nhận log lệnh, mô phỏng đầy đủ các tình huống remote context, mất nhãn, sai nhãn, idempotency và fail-closed side effects. |
| `docs/META_ADS_CI_REMEDIATION_REPORT_R5_2.md` | **New file.** Báo cáo nghiệm thu kỹ thuật chi tiết Round 5.2. |

---

## 4. Thiết kế Effective Docker Context Validation

### 4.1. Thứ tự ưu tiên xác định Endpoint (Docker CLI Semantics)
Hàm `assert_local_docker()` trong `scripts/backup/ci-postgres17.sh` và `resolveEffectiveDockerEndpoint()` trong `scripts/backup/owner-map.mjs` tuân thủ đúng thứ bậc:

1. **Ưu tiên 1 (`DOCKER_HOST`):** Nếu `DOCKER_HOST` được khai báo và không rỗng, Docker CLI dùng trực tiếp endpoint này.
2. **Ưu tiên 2 (`DOCKER_CONTEXT`):** Nếu `DOCKER_HOST` không được khai báo, nhưng `DOCKER_CONTEXT` được khai báo, context name này được chọn.
3. **Ưu tiên 3 (Active / Default Context):** Nếu cả hai biến môi trường trên đều không có:
   - Đọc context hiện hành từ `~/.docker/config.json` (`currentContext`) hoặc `docker context show`.
   - Nếu không xác định được: **FAIL CLOSED**. Không tự động giả định là local.

### 4.2. Kiểm tra tính hợp lệ của Context Name
- Chặn tên context chứa ký tự nguy hiểm hoặc bắt đầu bằng dấu gạch ngang `-` để ngăn chặn CLI argument injection (`/^[a-zA-Z0-9_\-\.]+$/`).

### 4.3. Đọc và xác minh Endpoint thực tế
- Dùng lệnh client configuration `docker context inspect --format '{{.Endpoints.docker.Host}}' -- "<context>"` để đọc endpoint thực tế.
- **Quy tắc chấp nhận:**
  - Chỉ chấp nhận local socket: `unix://<path>`, `/<path>`, hoặc Windows named pipe `npipe://<path>`.
  - Từ chối đường dẫn rỗng (ví dụ `unix://`, `/`).
- **Quy tắc Fail-Closed:**
  - Lập tức dừng với exit code 1 nếu endpoint là `tcp://*`, `ssh://*`, `http://*`, `https://*`.
  - Lập tức dừng nếu context không tồn tại, inspect trả về lỗi hoặc endpoint rỗng.
  - Tuyệt đối không cho phép bất kỳ lệnh daemon (`docker inspect`, `docker pull`, `docker run`, `docker exec`, `docker rm`, `docker logs`) chạy trước khi guard này PASS.

---

## 5. Thiết kế Container Ownership Marker & Cleanup Safety

### 5.1. Bộ ba nhãn định danh (Ownership Labels)
Mọi container do script khởi tạo bắt buộc phải có đầy đủ 3 nhãn:
1. `crm.disposable-test=true`
2. `crm.owner=ci-postgres17`
3. `crm.purpose=pg17-backup-restore-test`

### 5.2. Hàm xác minh `check_container_ownership()`
Trả về 3 trạng thái rõ ràng:
- `0`: Container tồn tại và khớp chính xác cả 3 nhãn định danh.
- `1`: Container tồn tại nhưng thiếu nhãn hoặc sai nhãn (Foreign / Unverified Container).
- `2`: Container không tồn tại trong daemon.

### 5.3. Quy tắc an toàn theo từng hành động

#### A. Khi `start()`
1. Chạy `assert_local_docker()`.
2. Kiểm tra container hiện có:
   - Nếu container chưa tồn tại (status 2): Tiếp tục tạo mới.
   - Nếu container đã tồn tại và khớp đầy đủ ownership markers (status 0): Xóa container cũ an toàn trước khi khởi tạo lại (`docker rm -f "${CONTAINER_NAME}"`).
   - Nếu container tồn tại nhưng không xác minh được ownership (status 1): **FAIL CLOSED**, báo lỗi rõ ràng và tuyệt đối không xóa.

#### B. Khi `stop()`
1. Chạy `assert_local_docker()`.
2. Kiểm tra container:
   - Nếu container không tồn tại (status 2): Xử lý idempotent, ghi nhận và kết thúc với exit code 0.
   - Nếu container tồn tại và khớp đầy đủ ownership markers (status 0): Xóa container an toàn.
   - Nếu container tồn tại nhưng sai/thiếu nhãn (status 1): **FAIL CLOSED**, giữ nguyên container và báo lỗi.

#### C. Khi `logs()`
1. Chạy `assert_local_docker()`.
2. Kiểm tra container:
   - Nếu container tồn tại và khớp markers (status 0): Đọc logs.
   - Nếu container tồn tại nhưng không có ownership markers (status 1): **FAIL CLOSED**, từ chối đọc logs từ container không rõ nguồn gốc.
   - Nếu container không tồn tại (status 2): Thông báo không có container và kết thúc an toàn.

#### D. Database-side Marker Integrity
- Giữ nguyên toàn bộ cơ chế bảo vệ của `verifyDisposableTestTarget()`:
  - Yêu cầu PostgreSQL major version 17 (`server_version_num` khớp `^17[0-9]{4}$`).
  - Sentinel marker table `public._crm_disposable_test_marker`.
  - Database comment `crm-restore-rehearsal:disposable-test`.
  - Allowlist container `APPROVED_CONTAINERS.has(container)`.

---

## 6. Ma Trận Kiểm Thử Hồi Quy (Regression Test Matrix)

### Nhóm A: Docker Context Guard (10/10 PASS)

| Test ID | Tình huống kiểm tra | Kết quả mong đợi | Thực tế |
|---|---|---|---|
| **A01** | Default context là local Unix socket | PASS | **PASS** (exit 0) |
| **A02** | Default context là remote SSH (`ssh://...`) | FAIL CLOSED | **PASS** (exit 1, chặn remote) |
| **A03** | Default context là remote TCP (`tcp://...`) | FAIL CLOSED | **PASS** (exit 1, chặn remote) |
| **A04** | `DOCKER_CONTEXT` trỏ remote SSH | FAIL CLOSED | **PASS** (exit 1, chặn remote) |
| **A05** | `DOCKER_HOST` trỏ remote TCP | FAIL CLOSED | **PASS** (exit 1, chặn remote) |
| **A06** | Docker context không tồn tại | FAIL CLOSED | **PASS** (exit 1, context not found) |
| **A07** | Endpoint của context bị rỗng hoặc không đọc được | FAIL CLOSED | **PASS** (exit 1, unresolvable) |
| **A08** | Không khai báo `DOCKER_HOST`/`DOCKER_CONTEXT` nhưng default context là remote | FAIL CLOSED | **PASS** (exit 1, chặn default remote) |
| **A09** | Remote context gọi `stop`: xác minh không gọi `docker rm` | Không có side effect phá hủy | **PASS** (`docker rm` không được gọi) |
| **A10** | Remote context gọi `start`: xác minh không gọi `docker pull/run/exec` | Không kết nối remote daemon | **PASS** (`pull/run/exec` không được gọi) |

### Nhóm B: Container Ownership & Cleanup Safety (10/10 PASS)

| Test ID | Tình huống kiểm tra | Kết quả mong đợi | Thực tế |
|---|---|---|---|
| **B01** | Container chưa tồn tại khi gọi `start` | Tạo mới thành công với 3 nhãn | **PASS** (tạo container với nhãn chuẩn) |
| **B02** | Container cùng tên tồn tại nhưng không có label | FAIL CLOSED, không xóa | **PASS** (bảo toàn foreign container) |
| **B03** | Container có sai nhãn ownership (`crm.owner=wrong`) | FAIL CLOSED, không xóa | **PASS** (bảo toàn container sai nhãn) |
| **B04** | Container có đủ 3 nhãn ownership hợp lệ | Cho phép cleanup và recreate | **PASS** (recreate an toàn) |
| **B05** | `stop` container không thuộc script | FAIL CLOSED, không xóa | **PASS** (giữ nguyên container) |
| **B06** | `stop` container thuộc script | Xóa thành công | **PASS** (xóa container an toàn) |
| **B07** | `logs` container không thuộc script | Từ chối đọc logs | **PASS** (exit 1, chặn đọc logs) |
| **B08** | `start` khi container thiếu một phần nhãn (không trọn vẹn) | FAIL CLOSED, không xóa | **PASS** (từ chối can thiệp) |
| **B09** | `stop` khi Docker context là remote | FAIL CLOSED, không gọi `docker rm` | **PASS** (`docker rm` không được gọi) |
| **B10** | `logs` khi Docker context là remote | FAIL CLOSED, không đọc logs | **PASS** (`docker logs` không được gọi) |

### Nhóm C: Unit & Helper Integration Suite

| Suite | Phạm vi kiểm tra | Kết quả |
|---|---|---|
| `owner-map.test.mjs` (R5.2 Unit) | 7 test case mới kiểm tra `resolveEffectiveDockerEndpoint()`, thứ tự ưu tiên env, active context resolver, flag injection rejection | **7/7 PASS** |
| `owner-map.test.mjs` (Toàn bộ) | Plan, Apply, Verify, SQL Injection, Security Definer, Proconfig, Case-sensitivity | **121 PASS, 1 SKIPPED** (chỉ skip negative fixture `nonexistent-container-xyz`) |
| `tests/backup/storage-restore.test.mjs` | Helper #5: Full bucket parity, MIME normalization, path collision | **85/85 PASS** |
| `test:backup:helpers` | Toàn bộ Helpers #1–#6 | **321 PASS, 2 SKIPPED** |
| `test:backup:python` | Python safe extract & Helper 4 runbook amendment | **75/75 PASS** (71 unit + 4 integration) |
| Typecheck | `next typegen && tsc --noEmit` | **PASS** (0 errors) |
| Lint | `eslint` trên file thay đổi và toàn bộ project | **PASS** (0 errors) |
| Production Build | `next build` với CI environment | **PASS** (68/68 static & dynamic routes compiled) |
| Git Diff Check | `git diff --check` | **PASS** (0 whitespace/formatting errors) |

---

## 7. Bằng Chứng Kiểm Thử Live PostgreSQL 17 (Live Evidence)

Đã thực hiện khởi tạo container thật trên môi trường máy trạm local bằng script đã vá và chạy toàn bộ chu trình với `BACKUP_REQUIRE_LIVE_PG17=1`:

1. **Khởi tạo container:**
   ```text
   $ ./scripts/backup/ci-postgres17.sh start
   Container 'crm-dumpcheck-test' does not exist; ready to create.
   Using locally available image public.ecr.aws/supabase/postgres:17.11.0.004
   Starting disposable PostgreSQL 17 container 'crm-dumpcheck-test' from public.ecr.aws/supabase/postgres:17.11.0.004
   PostgreSQL server_version_num=170011
   PostgreSQL 17.11 on aarch64-unknown-linux-gnu, compiled by gcc (GCC) 15.2.0, 64-bit
   Disposable marker verified; PostgreSQL 17 target is ready.
   ```

2. **Xác minh nhãn ownership trên container thật:**
   ```text
   $ docker inspect --format '{{index .Config.Labels "crm.disposable-test"}}|{{index .Config.Labels "crm.owner"}}|{{index .Config.Labels "crm.purpose"}}' crm-dumpcheck-test
   true|ci-postgres17|pg17-backup-restore-test
   ```

3. **Chạy Live Integration Test với `BACKUP_REQUIRE_LIVE_PG17=1`:**
   ```text
   ✔ Live PostgreSQL 17 integration: full plan -> apply -> verify cycle with live catalog and rollback (1938.401166ms)
   ℹ tests 122
   ℹ suites 0
   ℹ pass 121
   ℹ fail 0
   ℹ cancelled 0
   ℹ skipped 1
   ℹ duration_ms 14152.739583
   ```
   *Ghi chú: Test case live integration đã thực sự chạy trong 1.938s đối với container PostgreSQL 17 thật, KHÔNG BỊ SKIP. Duy nhất 1 test skip có chủ đích là negative fixture `nonexistent-container-xyz`.*

4. **Xác nhận Teardown an toàn:**
   ```text
   $ ./scripts/backup/ci-postgres17.sh stop
   Removed disposable PostgreSQL container 'crm-dumpcheck-test'.
   ```
   *Kiểm tra `docker ps -a`: Tất cả các container khác của hệ thống (`supabase_db_ai-crm-cua-chong-ngap`, `wonderful_wilbur`, v.v.) hoàn toàn nguyên vẹn, không bị tác động.*

---

## 8. GitHub Actions Verification Runs

Cả hai quy trình CI trên GitHub Actions đều đã chạy thành công trên commit `1d3f5fb8f56bafa6a99af907051a18356ac83b6d`:

| Workflow | Run ID | Trạng thái | URL |
|---|---|---|---|
| **Backup & Restore CI (Helpers #1-#6)** | `41609878927` | **SUCCESS** (2m 17s) | [Run 41609878927](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/actions/runs/41609878927) |
| **Verify** | `41609878879` | **SUCCESS** (12m 24s) | [Run 41609878879](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/actions/runs/41609878879) |

Toàn bộ 52 steps của `Verify` workflow bao gồm live integration gate, disposable PostgreSQL 17 start/test/teardown, typecheck, lint, test omnichannel, test voice, build, và `git diff --check` đều đạt SUCCESS.

---

## 9. Remaining Risks & Mitigations

| Rủi ro còn lại | Mức độ | Biện pháp giảm thiểu |
|---|---|---|
| Người dùng cố tình chạy Docker trong môi trường không có Docker client | Thấp | Script fail-closed với thông báo `docker CLI is not available`. |
| Cấu hình `~/.docker/config.json` bị hỏng cú pháp JSON | Rất thấp | `resolveEffectiveDockerEndpoint` fallback sang `docker context show`; nếu cả hai thất bại, script fail-closed từ chối chạy. |
| Container cùng tên bị dừng đột ngột trước khi tạo marker | Rất thấp | Ownership metadata (`crm.disposable-test`, `crm.owner`, `crm.purpose`) được gắn ngay ở lệnh `docker run`, bảo đảm container dừng vẫn được nhận diện chính xác và không gây nhầm lẫn với container khác. |

---

## 10. Danh Sách Kiểm Tra Nghiệm Thu (Acceptance Checklist)

- [x] Effective Docker context được xác minh đúng theo thứ bậc Docker CLI.
- [x] Default remote context bị chặn kể cả khi không có `DOCKER_HOST`/`DOCKER_CONTEXT`.
- [x] Remote Docker endpoint luôn FAIL CLOSED.
- [x] `start()` không xóa container chưa xác minh ownership.
- [x] `stop()` không xóa container chưa xác minh ownership.
- [x] `logs()` không đọc container không xác định nguồn gốc.
- [x] Local-only guard được gọi trước mọi thao tác Docker daemon trong `start`, `stop`, `logs`.
- [x] Ownership regression tests PASS (10/10).
- [x] Remote context regression tests PASS (10/10).
- [x] Helpers #1–#6 PASS (321/321 pass).
- [x] Python backup tests PASS (75/75 pass).
- [x] Live PostgreSQL 17 PASS trên container thật, không SKIP.
- [x] Typecheck PASS (0 errors).
- [x] Lint PASS (0 errors trên files thay đổi).
- [x] Build PASS (68/68 routes compiled).
- [x] `git diff --check` PASS (0 errors).
- [x] Không ảnh hưởng PR #139, `main` hoặc Production.

---

## 11. Kết luận

Toàn bộ các finding P1 từ Independent Review đã được khắc phục triệt để với cơ chế kiểm tra effective endpoint fail-closed và container ownership 3 lớp.

Trạng thái: **READY FOR INDEPENDENT REVIEW**.
