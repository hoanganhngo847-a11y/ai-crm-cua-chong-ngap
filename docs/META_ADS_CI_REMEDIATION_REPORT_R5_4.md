# Báo Cáo Khắc Phục CI & An Toàn Docker Round 5.4 (Addendum)

**Dự án:** `hoanganhngo847-a11y/ai-crm-cua-chong-ngap`<br/>
**Pull Request:** [#140](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/pull/140)<br/>
**Branch:** `integration/meta-ads-backup-restore`<br/>
**Base Branch:** `meta_ads_integration`<br/>
**Baseline PR Head SHA:** `198221970472eb8bc38ccf955d31a8a349c72ad2`<br/>
**Remediation Implementation SHA:** `ea51dd4ecb1762a4e951be5366181df62a078f2f`<br/>
**PR Head SHA:** `ea51dd4ecb1762a4e951be5366181df62a078f2f`<br/>
**GitHub Actions Runs:**
- Backup & Restore CI (PR): [41630089793](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/actions/runs/41630089793) (SUCCESS)
- Verify CI (PR): [41630089794](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/actions/runs/41630089794) (SUCCESS)
- Backup & Restore CI (Push): [41630081604](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/actions/runs/41630081604) (SUCCESS)<br/>
**Ngày thực hiện:** 03/11/2026<br/>
**Trạng thái kết luận:** **ROUND 5.4 — PASS**

---

## 1. Mục Tiêu & Bối Cảnh

Sau Round 5.3, toàn bộ kiểm thử GitHub Actions CI trên PR #140 đã đạt SUCCESS. Tuy nhiên, Independent Review đã phát hiện 3 vấn đề kỹ thuật cần được khắc phục triệt để trước khi nghiệm thu:

1. **Finding P1 — `DOCKER_CONFIG` path fidelity (`owner-map.mjs`, `tests/backup/owner-map.test.mjs`):**
   - Hàm `getDockerConfigRoot()` thực hiện `.trim()` trên giá trị `DOCKER_CONFIG` trước khi gọi `path.resolve()`.
   - Trong Docker CLI (Go implementation: `os.Getenv("DOCKER_CONFIG")`), đường dẫn biến môi trường được sử dụng nguyên trạng (verbatim), không thực hiện trim khoảng trắng đầu/cuối của filesystem path. Việc helper trim có thể khiến helper kiểm tra một thư mục cấu hình nhưng Docker CLI subprocess lại sử dụng một thư mục cấu hình khác khi tên thư mục có chứa khoảng trắng.
   - Cần đảm bảo tính toàn vẹn (fidelity) cho cả `DOCKER_CONFIG` và `HOME`, chỉ fallback sang `~/.docker` khi biến không được thiết lập hoặc có giá trị rỗng `""`. Tuyệt đối không fallback sang `HOME/.docker` khi `DOCKER_CONFIG` được chỉ định nhưng không tồn tại.

2. **Finding P2 — Docker cleanup failure handling (`ci-postgres17.sh`, `tests/backup/docker-safety.test.mjs`):**
   - Trong `stop()`, lệnh xóa container đang sử dụng `docker rm -f "${CONTAINER_NAME}" ... || true`.
   - Cú pháp `|| true` nuốt trọn mọi mã lỗi khi xóa container thất bại (permission denied, daemon error, locked container), dẫn đến việc script in thông báo `Removed disposable PostgreSQL container...` và trả exit code 0 giả mạo (fake cleanup success).
   - Yêu cầu: Phải kiểm tra exit code của `docker rm -f`. Nếu xóa thất bại, phải trả exit code khác 0 (`die`) và tuyệt đối không in thông báo đã xóa.

3. **Finding P2 — Inspect label failure classification (`ci-postgres17.sh`, `tests/backup/docker-safety.test.mjs`):**
   - Các lệnh truy vấn từng label sở hữu riêng biệt đang sử dụng `|| true`.
   - Nếu `docker inspect` metadata thành công nhưng một lệnh lấy label thất bại (ví dụ lỗi định dạng Go template hoặc timeout), biến label sẽ rỗng và hệ thống phân loại nhầm thành FOREIGN (status 1) thay vì ERROR (status 3).
   - Yêu cầu: Đọc toàn bộ 3 label trong 1 lệnh `docker inspect` nguyên tử duy nhất không có `|| true`. Phân biệt rành mạch giữa FOREIGN (metadata hợp lệ nhưng thiếu/sai marker) và ERROR (lỗi daemon/inspect).

---

## 2. Chi Tiết Khắc Phục (Root Cause & Implementation)

### 2.1. Khắc Phục Finding P1: Bảo Toàn Trọn Vẹn Đường Dẫn (`DOCKER_CONFIG` & `HOME` Path Fidelity)

**File thay đổi:**
- [`scripts/backup/owner-map.mjs`](file:///Users/hoangthuy/.gemini/antigravity/worktrees/ai-crm-cua-chong-ngap/fix_docker_guard_ownership/scripts/backup/owner-map.mjs)
- [`scripts/backup/ci-postgres17.sh`](file:///Users/hoangthuy/.gemini/antigravity/worktrees/ai-crm-cua-chong-ngap/fix_docker_guard_ownership/scripts/backup/ci-postgres17.sh)

**Các biện pháp kỹ thuật:**
1. **Loại bỏ hoàn toàn `.trim()` trên đường dẫn filesystem:**
   - Trong `getDockerConfigRoot(env)`: Kiểm tra `String(env.DOCKER_CONFIG) !== ''`. Giữ nguyên nguyên trạng chuỗi đường dẫn (kể cả leading/trailing space) và đưa vào `path.resolve(rawConfig)`.
   - Đối với `HOME`: Giữ nguyên nguyên trạng đường dẫn `HOME` mà không gọi `.trim()`.
2. **Tuân thủ đúng Docker CLI Semantics đối với chuỗi rỗng:**
   - Khi `DOCKER_CONFIG` không được thiết lập (`undefined` hoặc `null`) hoặc có giá trị chuỗi rỗng `""`, hệ thống mặc định về `path.join(homeDir, '.docker')` với cờ `isCustom: false`.
   - Khi `DOCKER_CONFIG` được chỉ định bất kỳ giá trị không rỗng nào: Đánh dấu `isCustom: true`.
3. **Cấm tuyệt đối fallback sang `HOME/.docker` khi `DOCKER_CONFIG` không tồn tại:**
   - Trong `owner-map.mjs`: Nếu `configRoot.isCustom` và thư mục không tồn tại trên đĩa, `resolveEffectiveDockerEndpoint` trả về lỗi `DOCKER_CONFIG_DIR_NOT_FOUND` và fail closed ngay lập tức.
   - Trong `ci-postgres17.sh`: Trong hàm `assert_local_docker()`, bổ sung kiểm tra nghiêm ngặt:
     ```bash
     if [[ -n "${DOCKER_CONFIG:-}" ]]; then
       if [[ ! -d "${DOCKER_CONFIG}" ]]; then
         die "specified DOCKER_CONFIG directory '${DOCKER_CONFIG}' does not exist; refusing to continue"
       fi
     fi
     ```
     Nếu `DOCKER_CONFIG` được chỉ định nhưng không phải là thư mục hợp lệ, script lập tức dừng với exit 1, không tiếp tục thực thi bất kỳ thao tác Docker nào.
4. **Đồng bộ hóa môi trường giữa Helper và Docker CLI Subprocess:**
   - Xây dựng hàm `buildDockerExecEnv(env)` để chuẩn hóa environment map truyền vào các lệnh subprocess `docker context inspect` và `docker context show`, đảm bảo Docker CLI subprocess nhận đúng đường dẫn `DOCKER_CONFIG` chính xác từng ký tự với helper.

---

### 2.2. Khắc Phục Finding P2: Xử Lý Triệt Để Lỗi Cleanup Container (`docker rm`)

**File thay đổi:**
- [`scripts/backup/ci-postgres17.sh`](file:///Users/hoangthuy/.gemini/antigravity/worktrees/ai-crm-cua-chong-ngap/fix_docker_guard_ownership/scripts/backup/ci-postgres17.sh)

**Các biện pháp kỹ thuật:**
1. **Trong hàm `stop()`:**
   - Loại bỏ hoàn toàn `|| true`.
   - Kiểm tra trực tiếp mã thoát của `docker rm -f "${CONTAINER_NAME}"`:
     ```bash
     if [[ "${status}" -eq 0 ]]; then
       if ! docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1; then
         die "failed to remove disposable PostgreSQL container '${CONTAINER_NAME}'; cleanup unsuccessful"
       fi
       log "Removed disposable PostgreSQL container '${CONTAINER_NAME}'."
     ...
     ```
   - Chỉ in thông báo `Removed...` khi lệnh `docker rm -f` thành công với exit code 0.
   - Nếu `docker rm -f` thất bại, gọi hàm `die` để in lỗi ra stderr và dừng với mã lỗi 1.
2. **Trong hàm `start()` (Recreate owned container):**
   - Loại bỏ việc bỏ qua lỗi xóa stale container.
   - Nếu xóa stale container thất bại, abort quá trình recreate ngay lập tức với `die` để ngăn ngừa việc ghi đè không an toàn.
3. **Bảo toàn tính Idempotent:**
   - Khi container không tồn tại (status 2), `stop()` thông báo `Disposable PostgreSQL container '...' not present; nothing to remove.` và trả về exit code 0.
   - Người dùng có thể retry `stop` an toàn nhiều lần.

---

### 2.3. Khắc Phục Finding P2: Kiểm Tra Nhãn Sở Hữu Nguyên Tử (Atomic 3-Label Inspection)

**File thay đổi:**
- [`scripts/backup/ci-postgres17.sh`](file:///Users/hoangthuy/.gemini/antigravity/worktrees/ai-crm-cua-chong-ngap/fix_docker_guard_ownership/scripts/backup/ci-postgres17.sh)

**Các biện pháp kỹ thuật:**
1. **Loại bỏ các truy vấn nhãn rời rạc có `|| true`:**
   - Thay thế việc gọi `docker inspect` nhiều lần bằng 1 lệnh duy nhất lấy cả 3 nhãn phân cách bằng dấu pipe `|`:
     ```bash
     local labels_raw
     if ! labels_raw="$(docker inspect --type container --format '{{index .Config.Labels "crm.disposable-test"}}|{{index .Config.Labels "crm.owner"}}|{{index .Config.Labels "crm.purpose"}}' "${container}" 2>/dev/null)"; then
       return 3 # Container exists in list, but metadata/label inspect failed -> ERROR (status 3)
     fi

     labels_raw="$(printf '%s' "${labels_raw}" | tr -d '\r\n')"
     local expected_labels="${LABEL_DISPOSABLE_VALUE}|${LABEL_OWNER_VALUE}|${LABEL_PURPOSE_VALUE}"

     if [[ "${labels_raw}" == "${expected_labels}" ]]; then
       return 0 # verified owned container
     fi

     return 1 # foreign / unverified container
     ```
2. **Phân loại chính xác 4 trạng thái (Contract Preservation):**
   - **Status 0 (OWNED):** Container tồn tại VÀ cả 3 nhãn khớp chính xác: `true|ci-postgres17|pg17-backup-restore-test`.
   - **Status 1 (FOREIGN):** Container tồn tại, inspect đọc được nhãn thành công nhưng giá trị nhãn không khớp hoặc thiếu nhãn.
   - **Status 2 (NOT_FOUND):** Container chắc chắn không có trong danh sách `docker ps -a`.
   - **Status 3 (ERROR):** Lỗi kết nối Docker daemon trong `docker ps` HOẶC lệnh `docker inspect` trả mã lỗi khác 0. Không bao giờ biến inspect error thành FOREIGN.

---

## 3. Ma Trận Kiểm Thử Hồi Quy & Kết Quả Thực Nghiệm

### 3.1. Nhóm Unit Tests Path Fidelity trong `tests/backup/owner-map.test.mjs`

Bổ sung 8 test cases chuyên biệt kiểm tra path fidelity và cơ chế không fallback:

| Test ID | Nội dung kiểm thử | Kết quả |
| :--- | :--- | :--- |
| `R5.4-P1-01` | `getDockerConfigRoot` với đường dẫn bình thường | **PASS** |
| `R5.4-P1-02` | `getDockerConfigRoot` với trailing space (`cfg-trailing `) bảo toàn nguyên vẹn khoảng trắng | **PASS** |
| `R5.4-P1-03` | `getDockerConfigRoot` với leading space (` cfg-leading`) bảo toàn nguyên vẹn khoảng trắng | **PASS** |
| `R5.4-P1-04` | Hai thư mục cấu hình chỉ khác nhau bởi khoảng trắng (`cfg-pair` vs `cfg-pair `) resolve chính xác context & endpoint của từng thư mục tương ứng | **PASS** |
| `R5.4-P1-05` | Config root không tồn tại -> Fail closed với lỗi `DOCKER_CONFIG_DIR_NOT_FOUND`, không fallback sang HOME | **PASS** |
| `R5.4-P1-06` | `DOCKER_CONFIG=""` (chuỗi rỗng) mặc định sang `HOME/.docker` theo đúng Docker CLI semantics | **PASS** |
| `R5.4-P1-07` | `HOME` có khoảng trắng trong đường dẫn được bảo toàn nguyên vẹn không bị trim | **PASS** |
| `R5.4-P1-08` | Khi `HOME` có cấu hình hợp lệ nhưng `DOCKER_CONFIG` trỏ tới đường dẫn không tồn tại -> Không fallback sang HOME, trả lỗi `DOCKER_CONFIG_DIR_NOT_FOUND` | **PASS** |

*Kết quả chạy kiểm thử:*
```text
✔ R5.4-P1: getDockerConfigRoot normal path (3.6ms)
✔ R5.4-P1: getDockerConfigRoot with trailing space preserves exact path fidelity without trimming (1.0ms)
✔ R5.4-P1: getDockerConfigRoot with leading space preserves exact path fidelity without trimming (0.8ms)
✔ R5.4-P1: two config directories differing only by whitespace resolve to distinct contexts and endpoints (3.3ms)
✔ R5.4-P1: config root does not exist fails closed without fallback to HOME (0.1ms)
✔ R5.4-P1: DOCKER_CONFIG empty string defaults to HOME/.docker per Docker CLI semantics (0.05ms)
✔ R5.4-P1: HOME with spaces in path preserves exact directory without trimming (0.05ms)
✔ R5.4-P1: no fallback to HOME/.docker when DOCKER_CONFIG is specified (4.4ms)
ℹ tests 8, pass 8, fail 0
```

---

### 3.2. Nhóm Kiểm Thử An Toàn Docker trong `tests/backup/docker-safety.test.mjs`

Mở rộng bộ test mock CLI lên 40 kịch bản toàn diện (bổ sung B11, B12, B13, C11, C12, C13):

| Nhóm | Số Test | Mô tả phạm vi | Kết quả |
| :--- | :---: | :--- | :--- |
| **Nhóm A** | 10 | Docker Precedence: `DOCKER_CONTEXT > DOCKER_HOST > default context` | **10/10 PASS** |
| **Nhóm B** | 13 | `DOCKER_CONFIG` Isolation, Path Fidelity (trailing/leading space, non-existent, pair test) | **13/13 PASS** |
| **Nhóm C** | 13 | 4-State Verification, Atomic Label Inspect, Cleanup Failure (`failRm=true`), Idempotency | **13/13 PASS** |
| **Nhóm D** | 4 | Zero Remote Daemon Side Effects (chứng minh không gọi `pull`, `run`, `exec`, `rm`, `logs`) | **4/4 PASS** |

**Bằng chứng kiểm thử cụ thể cho Finding P2 (C11, C12, C13):**
- **Test C11:** Container tồn tại, đủ 3 ownership labels, `failRm=true` -> Script `stop` trả mã lỗi 1, in thông báo `cleanup unsuccessful` ra stderr, stdout tuyệt đối KHÔNG chứa `Removed disposable PostgreSQL container`.
- **Test C12:** Container tồn tại nhưng `failLabelInspect=true` (lỗi template/inspect) -> Script phân loại chính xác thành status 3 (ERROR) từ chối clean up, KHÔNG bao giờ phân loại nhầm thành status 1 (FOREIGN).
- **Test C13:** `start` khi recreate container hợp lệ nhưng `failRm=true` -> Script abort recreate ngay lập tức với mã lỗi 1, không tiếp tục `run` container.

*Kết quả chạy toàn bộ 40 test an toàn Docker:*
```text
ℹ tests 40
ℹ suites 0
ℹ pass 40
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 23849ms
```

---

### 3.3. Kiểm Thử Tích Hợp Toàn Bộ Codebase (Local Quality Gates)

1. **Kiểm tra cú pháp Shell & JS:**
   - `bash -n scripts/backup/ci-postgres17.sh`: **PASS** (exit code 0)
   - `node --check scripts/backup/owner-map.mjs tests/backup/owner-map.test.mjs tests/backup/docker-safety.test.mjs`: **PASS** (exit code 0)
2. **Toàn bộ helper test suite (`npm run test:backup:helpers`):**
   - Tổng cộng 356 test cases: **354 PASS**, 0 FAIL, 2 SKIPPED (skippable live pg17 targets).
3. **Toàn bộ Python backup test suite (`npm run test:backup:python`):**
   - 75 tests: **75 PASS** (OK trong 5.4s).
4. **TypeScript Typecheck (`npm run typecheck`):**
   - `next typegen && tsc --noEmit`: **PASS** (0 errors).
5. **Linting (`npm run lint`):**
   - `eslint`: **PASS** (0 errors, 16 warnings tiền định từ các module ngoài phạm vi).
6. **Production Build (`npm run build`):**
   - `next build`: **PASS** (Biên dịch thành công tất cả 68 static/dynamic routes).
7. **Kiểm tra định dạng git (`git diff --check`):**
   - **PASS** (0 trailing whitespace hoặc format error).
8. **Live PostgreSQL 17 Integration (Local Docker Engine):**
   - Khởi động container: `./scripts/backup/ci-postgres17.sh start` -> Server PG 17.11 sẵn sàng trong 3.2s.
   - Chạy test tích hợp trực tiếp: `BACKUP_REQUIRE_LIVE_PG17=1 node --test --test-name-pattern="Live PostgreSQL 17 integration" tests/backup/owner-map.test.mjs` -> **PASS** (1677ms).
   - Dọn dẹp container: `./scripts/backup/ci-postgres17.sh stop` -> **PASS** (`Removed disposable PostgreSQL container 'crm-dumpcheck-test'`).
   - Dọn dẹp lặp lại (Idempotent stop): `./scripts/backup/ci-postgres17.sh stop` -> **PASS** (`Disposable PostgreSQL container 'crm-dumpcheck-test' not present; nothing to remove.`).

---

## 4. Bằng Chứng Không Tác Động Remote Daemon (Zero Side Effects)

Nhóm test D (D01 – D04) và B12 đã chứng minh:
1. Khi cấu hình trỏ tới remote Docker endpoint (`tcp://`, `ssh://`, hoặc context trỏ remote endpoint):
   - Mọi thao tác daemon (`pull`, `run`, `exec`, `rm`, `logs`, container `inspect`) bị chặn tuyệt đối trước khi bất kỳ kết nối mạng nào được tạo ra.
2. Khi `DOCKER_CONFIG` được chỉ định đường dẫn không tồn tại:
   - Script fail closed lập tức ở cấp độ filesystem guard trước khi gọi bất kỳ lệnh inspect daemon nào.
3. Không gửi bất kỳ gói tin nào tới môi trường staging hay production.

---

## 5. Kết Luận Nghiệm Thu Round 5.4

Toàn bộ các finding P1 và P2 từ Independent Review đã được khắc phục hoàn toàn với nguyên tắc:
- **FIX ONLY — NO REFACTOR:** Chỉ chỉnh sửa đúng 4 file trong phạm vi cho phép (`ci-postgres17.sh`, `owner-map.mjs`, `docker-safety.test.mjs`, `owner-map.test.mjs`).
- **Path Fidelity:** Bảo toàn nguyên vẹn ký tự đường dẫn, loại bỏ `.trim()`, đồng bộ hoàn toàn giữa helper và Docker CLI subprocess.
- **Fail Closed:** Cleanup container thất bại lập tức báo lỗi, không nuốt lỗi; atomic inspect phân biệt rạch ròi ERROR (status 3) và FOREIGN (status 1).

**TRẠNG THÁI CUỐI CÙNG: ROUND 5.4 — PASS**
