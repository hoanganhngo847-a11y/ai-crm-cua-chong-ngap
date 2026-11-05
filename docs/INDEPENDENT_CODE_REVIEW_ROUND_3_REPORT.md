# INDEPENDENT CODE REVIEW ROUND 3 REPORT
## Helper #6: PostgreSQL Ownership Mapping Generator & Verifier (Security Audit)

**Date of Audit:** 2026-11-02  
**Auditor Role:** Senior Principal Security Engineer (Independent Security Reviewer Round 3)  
**Target System:** Helper #6 (`scripts/backup/owner-map.mjs`, `tests/backup/owner-map.test.mjs`)  
**Repository:** `ai-crm-cua-chong-ngap`  
**Review Verdict:** **REJECTED** (Acceptance Blocker P1 Detected: `R3-P1-01`)

---

## 1. Executive Summary

This independent code review and security audit was conducted as **Round 3** of the security verification process for **Helper #6 — PostgreSQL Ownership Mapping Generator & Verifier**, following the completion of Remediation Round 2 reported in `docs/META_ADS_OWNER_MAP_REMEDIATION_REPORT_R2.md`.

In accordance with strict independent review mandates:
- The reviewer did **not** trust claims of PASS/CLOSED without independent verification.
- Zero source code or test files were modified, committed, pushed, merged, or deployed.
- All baseline and remediated SHA-256 cryptographic hashes were recalculated from disk.
- All 314 tests across Helpers #1 through #6 were independently executed and recorded.
- Deep adversarial testing was conducted against the grammar parser, metadata validators, Docker isolation gates, role case handling, and execution pipelines.

### Key Finding and Review Outcome:

While `validateMetadataIdentifier()` successfully stops injection through `sourceProjectRef` and `target` fields, the newly introduced SQL grammar gate `validatePlanSqlGrammar()` in `scripts/backup/owner-map.mjs` contains a **critical security vulnerability (R3-P1-01)**:
- Due to the greedy regex `.+` pattern and the complete absence of inline semicolon (`;`), line comment (`--`), and block comment (`/*`) detection on statement lines, an attacker can chain arbitrary SQL statements on a single line and comment out the rest of the statement.
- The blacklist check only checks keywords followed by a space (e.g. `'DROP '`), which is trivially bypassed by SQL comments (`DROP/*x*/TABLE`) or statements omitted from the blacklist (`ALTER ROLE ... PASSWORD`, `COPY ... TO PROGRAM`, `DO $$ ... $$`).
- In `handleApplyCommand`, `validatePlanSqlGrammar` validates and accepts these malicious plans as clean (`{ alterCount: 1 }`), and `psql` executes every chained statement.

Because a critical **P1 Acceptance Blocker** remains in the core security gate, the final verdict for Round 3 is **REJECTED**.

---

## 2. Repository & Workspace Identity

| Property | Value |
|---|---|
| **Repository Root** | `/Users/hoangthuy/ai-crm-cua-chong-ngap` |
| **Canonical Worktree** | `/Users/hoangthuy/.gemini/antigravity/worktrees/ai-crm-cua-chong-ngap/remediate_owner_map_security` |
| **Review Worktree** | `/Users/hoangthuy/.gemini/antigravity/worktrees/ai-crm-cua-chong-ngap/review_owner_map_security_round3` |
| **Active Branch** | `remediate_owner_map_security` / `review_owner_map_security_round3` |
| **Git Commit HEAD** | `3abe0d78a7f162f6d5cde2e9adb719ebe6963075` |
| **Commit Message** | `Merge branch 'chore/remove-legacy-backend-and-schema'` |
| **Node.js Runtime** | `v24.15.0` (Darwin arm64) |
| **Python Runtime** | `Python 3.14.6` |
| **PostgreSQL Target** | PostgreSQL 17.11 (local disposable test container `crm-dumpcheck-test`) |

---

## 3. Git Status & Workspace Integrity

### 3.1 Git Status Verification

The canonical worktree `/Users/hoangthuy/.gemini/antigravity/worktrees/ai-crm-cua-chong-ngap/remediate_owner_map_security` was verified prior to review:
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

nothing added to commit but untracked files present (use "git add" to track)
```

- **Staged changes:** 0
- **Unstaged modifications to tracked files:** 0
- **Out-of-scope files modified:** 0
- **Source preservation:** 100% untouched.

---

## 4. Cryptographic File Hash Audit (SHA-256)

All file hashes were computed independently using `shasum -a 256` and matched against the reported values:

| File Path | Baseline SHA-256 (R1) | Remediated SHA-256 (R2 Reported) | Actual Audited SHA-256 (R3 Verified) | Status |
|---|---|---|---|---|
| `scripts/backup/owner-map.mjs` | `5fac92d90e022eaebe092b993dd0adb8c02194a1a9f4db95d2a87462b7625f85` | `fc65c3103dd0c97bc39b0a2ff463d080ec29076d3763b87d271cfaf25b0f84c4` | `fc65c3103dd0c97bc39b0a2ff463d080ec29076d3763b87d271cfaf25b0f84c4` | Exact Match |
| `tests/backup/owner-map.test.mjs` | `80b1eae5434611f7e68c1ad33c24b6b95e2dd0fa0e01a323f78457be2ed0937f` | `c4fd4e519b35e8e7dfdf70211c46aa3137efa580d47afc75d8d9ffa5cc203c85` | `c4fd4e519b35e8e7dfdf70211c46aa3137efa580d47afc75d8d9ffa5cc203c85` | Exact Match |
| `docs/META_ADS_OWNER_MAP_REMEDIATION_REPORT_R2.md` | *(N/A)* | `108121f9d9fbb16aadc1e2fd34b1992b4767baa4d98529208e25ddb7ca476a91` | `108121f9d9fbb16aadc1e2fd34b1992b4767baa4d98529208e25ddb7ca476a91` | Exact Match |
| `docs/META_ADS_OWNER_MAP_REMEDIATION_REPORT.md` | `1cbbcfd5cc292757895640889ced2b890f6c6559e315d39700791b96009daf8f` | `1cbbcfd5cc292757895640889ced2b890f6c6559e315d39700791b96009daf8f` | `1cbbcfd5cc292757895640889ced2b890f6c6559e315d39700791b96009daf8f` | Exact Match (Untouched) |
| `scripts/backup/aesgcm-stream.mjs` | `64b5a22a16bbe719850cc9c91f886f6b447dc98019b2e2339f6de4b8a9ff70c4` | `64b5a22a16bbe719850cc9c91f886f6b447dc98019b2e2339f6de4b8a9ff70c4` | `64b5a22a16bbe719850cc9c91f886f6b447dc98019b2e2339f6de4b8a9ff70c4` | Exact Match (Untouched) |
| `scripts/backup/offsite-bundle.mjs` | `11773a79ca7ce264a1d0a3c61a14da30fdd3edf0443a246c06251d3a02c40d93` | `11773a79ca7ce264a1d0a3c61a14da30fdd3edf0443a246c06251d3a02c40d93` | `11773a79ca7ce264a1d0a3c61a14da30fdd3edf0443a246c06251d3a02c40d93` | Exact Match (Untouched) |
| `scripts/backup/storage-export.mjs` | `3b54cf8bf08532a8fe27c7eaef2c7eb9ab3cc504ae5902aad8543107496be5bb` | `3b54cf8bf08532a8fe27c7eaef2c7eb9ab3cc504ae5902aad8543107496be5bb` | `3b54cf8bf08532a8fe27c7eaef2c7eb9ab3cc504ae5902aad8543107496be5bb` | Exact Match (Untouched) |
| `scripts/backup/storage-restore.mjs` | `e6b37047ba738f4bfa4688880734064049baa572420cb9b1998f8dea1c63ad91` | `e6b37047ba738f4bfa4688880734064049baa572420cb9b1998f8dea1c63ad91` | `e6b37047ba738f4bfa4688880734064049baa572420cb9b1998f8dea1c63ad91` | Exact Match (Untouched) |
| `scripts/backup/safe-extract-storage.py` | `27210b129c026e910b35958b9895d6ad019732090b666965f10f9f2e3c3230d4` | `27210b129c026e910b35958b9895d6ad019732090b666965f10f9f2e3c3230d4` | `27210b129c026e910b35958b9895d6ad019732090b666965f10f9f2e3c3230d4` | Exact Match (Untouched) |
| `docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12.md` | `9055dfb82934413d2bbe730b2d94d74ed6741fa5f44e1edb1081e3a0f958b737` | `9055dfb82934413d2bbe730b2d94d74ed6741fa5f44e1edb1081e3a0f958b737` | `9055dfb82934413d2bbe730b2d94d74ed6741fa5f44e1edb1081e3a0f958b737` | Exact Match (Untouched) |
| `docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12_AMENDMENT_HELPER4.md` | `edb47d53305d79cb79478931c6a280da96b003b2b5139c7ca7867e51a30884cf` | `edb47d53305d79cb79478931c6a280da96b003b2b5139c7ca7867e51a30884cf` | `edb47d53305d79cb79478931c6a280da96b003b2b5139c7ca7867e51a30884cf` | Exact Match (Untouched) |

---

## 5. Review Findings & Adversarial Analysis

### 5.1 Verification of Round 2 Remediation Claims

| Finding | Round 2 Claim | Round 3 Independent Audit Result | Status |
|---|---|---|---|
| **R2-P1-01** (SQL Injection via Metadata) | CLOSED | `validateMetadataIdentifier` successfully protects `sourceProjectRef` and `target`. However, the secondary line-of-defense `validatePlanSqlGrammar` is bypassable (see `R3-P1-01`). | **PARTIALLY EFFECTIVE / NEW P1 IN GRAMMAR** |
| **R2-P1-02** (Docker Isolation Bypass) | CLOSED | Strict endpoint parsing (`parseAndValidateDockerEndpoint`), loopback enforcement, and context host inspect are implemented. Minor test helper probe gap identified (`R3-P2-01`). | **VERIFIED FOR CORE HELPER / MINOR TEST GAP** |
| **R2-P2-01** (Role Case Preservation) | CLOSED | PostgreSQL catalog role names retain exact casing throughout `validateRoleIdentifier()`, `extractRoleNames()`, `generateAlterOwnerStatement()`, and `handleVerifyCommand()`. | **VERIFIED & CLOSED** |
| **R2-P2-02** (Test Portability) | CLOSED | Integration test gracefully skips when test container is absent without throwing uncaught exceptions. | **VERIFIED & CLOSED** |

---

### 5.2 New Audit Findings

#### [FINDING R3-P1-01] SQL Grammar Validation Bypass via Inline Semicolon Chaining and Comment Termination in `validatePlanSqlGrammar`
- **Severity:** **P1 (Acceptance Blocker / Security Critical)**
- **File & Lines:** `scripts/backup/owner-map.mjs:833, 841-846, 868-889`
- **CWE:** CWE-89 (Improper Neutralization of Special Elements used in an SQL Command), CWE-184 (Incomplete List of Disallowed Inputs), CWE-20 (Improper Input Validation).
- **Vulnerability Description:**
  In `scripts/backup/owner-map.mjs`, `validatePlanSqlGrammar(sqlText)` was introduced in Round 2 as an essential safety gate before executing `psql` during `apply`. The function attempts to validate each line using:
  ```javascript
  const allowedAlterRegex = /^ALTER\s+(SCHEMA|TABLE|PARTITIONED\s+TABLE|FOREIGN\s+TABLE|SEQUENCE|VIEW|MATERIALIZED\s+VIEW|TYPE|DOMAIN|FUNCTION|PROCEDURE)\s+.+\s+OWNER\s+TO\s+.+;$/;
  ```
  This regex suffers from four structural flaws:
  1. **Greedy Wildcard (`.+`):** The regex allows arbitrary characters between the object type and `OWNER TO`. Because `.` matches semicolons (`;`) and comment symbols (`--`, `/*`), an attacker can insert a semicolon, end the first statement, and start an arbitrary second statement.
  2. **No Inline Semicolon Check:** `validatePlanSqlGrammar` never checks if an unquoted semicolon exists *before* the final semicolon at the end of the line. It only checks semicolons in comments that start with `--` at the beginning of the line (`if (trimmed.startsWith('--')) { if (trimmed.includes(';')) ... }`).
  3. **No Inline Comment Check:** If `--` appears anywhere else on the line (e.g. after an injected statement), it is not detected. The attacker can terminate their injected command with `--` and comment out the trailing `" OWNER TO ...;"`, making the entire line pass `allowedAlterRegex` while `psql` treats the trailing clause as a comment.
  4. **Incomplete / Fragile Blacklist:** The keyword blacklist at lines 876–887 only checks words followed by a space (e.g. `'DROP '`, `'CREATE '`). In PostgreSQL, tokens separated by comments (e.g. `DROP/*x*/TABLE` or `CREATE/*x*/ROLE`) are valid SQL and bypass `'DROP '`. Furthermore, dangerous commands like `ALTER ROLE ... PASSWORD`, `COPY ... TO PROGRAM`, and `DO $$ ... $$` are completely absent from the blacklist.

- **Impact:**
  An adversary who modifies a plan (or passes an approved hash for a crafted plan) can execute arbitrary SQL statements (such as resetting administrative passwords via `ALTER ROLE postgres PASSWORD ...`, copying execution to external programs via `COPY TO PROGRAM`, or dropping tables) inside the database transaction during `apply`.

- **Adversarial Proof of Concept & Execution Evidence:**
  The following statements were submitted directly to `validatePlanSqlGrammar`:
  ```javascript
  // Case A: Arbitrary role password alteration via inline semicolon chaining
  const payload1 = `
  BEGIN;
  ALTER TABLE "public"."tbl" OWNER TO "restore_admin"; ALTER ROLE postgres PASSWORD 'pwned'; --" OWNER TO "restore_admin";
  COMMIT;
  `.trim();
  validatePlanSqlGrammar(payload1); // OUTPUT: { alterCount: 1 } (ACCEPTED!)

  // Case B: Table dropping via space-free comment bypass
  const payload2 = `
  BEGIN;
  ALTER TABLE "public"."tbl"; DROP/*comment*/TABLE secrets; --" OWNER TO "restore_admin";
  COMMIT;
  `.trim();
  validatePlanSqlGrammar(payload2); // OUTPUT: { alterCount: 1 } (ACCEPTED!)

  // Case C: Role creation bypass
  const payload3 = `
  BEGIN;
  ALTER TABLE "public"."tbl"; CREATE/*x*/ROLE evil; --" OWNER TO "restore_admin";
  COMMIT;
  `.trim();
  validatePlanSqlGrammar(payload3); // OUTPUT: { alterCount: 1 } (ACCEPTED!)

  // Case D: Arbitrary code execution via DO block
  const payload4 = `
  BEGIN;
  ALTER TABLE "public"."tbl"; DO/*x*/$x$begin perform 1; end$x$; --" OWNER TO "restore_admin";
  COMMIT;
  `.trim();
  validatePlanSqlGrammar(payload4); // OUTPUT: { alterCount: 1 } (ACCEPTED!)
  ```
  When tested against `psql` running in container `crm-dumpcheck-test`:
  ```text
  BEGIN
  statement 1 executed
  statement 2 executed
  ROLLBACK
  ```
  `psql` executed both the initial statement and the injected secondary statement.

- **Remediation Recommendation:**
  1. Disallow any semicolons `;` in the line except for the exact trailing character:
     ```javascript
     if (trimmed.slice(0, -1).includes(';')) {
       fail('SQL_INJECTION_DETECTED', `multiple SQL statements or unquoted semicolon at line ${idx + 1}`);
     }
     ```
  2. Disallow comment tokens `--` and `/*` anywhere in statement lines (outside quoted identifiers):
     ```javascript
     if (trimmed.includes('--') || trimmed.includes('/*')) {
       fail('SQL_INJECTION_DETECTED', `prohibited comment token in statement at line ${idx + 1}`);
     }
     ```
  3. Rather than relying on a loose regex with `.+`, validate the exact structure by decomposing each ALTER line with an AST or strict identifier parser:
     `ALTER <OBJECT_TYPE> <quoted_schema>.<quoted_name>(<args>) OWNER TO <quoted_role>;`
  4. Expand keyword blacklist to include `ALTER ROLE`, `ALTER SYSTEM`, `ALTER DATABASE`, `COPY`, `DO`, `VACUUM`, `SET`, `SECURITY`, `PASS`.

---

#### [FINDING R3-P2-01] Missing Container Allowlist Enforcement in Test Helper `isDockerContainerAvailable`
- **Severity:** **P2 (Major / Test Fixture Safety Boundary Violation)**
- **File & Lines:** `tests/backup/owner-map.test.mjs:92–110`
- **Vulnerability Description:**
  `scripts/backup/owner-map.mjs` enforces `APPROVED_CONTAINERS.has(dbContainer)` inside `validateTargetIsolation()`.
  However, in `tests/backup/owner-map.test.mjs`, the preflight helper `isDockerContainerAvailable(containerName)` checks `DOCKER_HOST` and `DOCKER_CONTEXT`, but **fails to check** whether `containerName` is within `APPROVED_CONTAINERS` before invoking `runDockerPsql(containerName, 'SELECT 1;')`.
  If an unapproved container name is passed to `isDockerContainerAvailable` (e.g., if a developer or test scenario supplies a name of a non-test container), `isDockerContainerAvailable` executes `docker exec -i <unapproved_container> psql ...` directly against that container.
- **Evidence:**
  In `tests/backup/owner-map.test.mjs:2744` (test 78):
  `isDockerContainerAvailable('nonexistent-container-xyz')` executes `docker exec -i nonexistent-container-xyz psql ...`.
  Because the container does not exist, Docker CLI returns exit code 1 and it catches the error. However, if the container existed, it would execute psql on an unapproved container before any gate stopped it.
- **Remediation Recommendation:**
  Add allowlist enforcement at the top of `isDockerContainerAvailable`:
  ```javascript
  if (!APPROVED_CONTAINERS.has(containerName)) {
    return false;
  }
  ```

---

#### [FINDING R3-P3-01] Unescaped CLI Argument in `resolveDockerContextEndpoint` Allows Flag Injection
- **Severity:** **P3 (Minor / Defense-in-Depth)**
- **File & Lines:** `scripts/backup/owner-map.mjs:1179`
- **Vulnerability Description:**
  In `resolveDockerContextEndpoint`:
  ```javascript
  const stdout = execFileSync('docker', ['context', 'inspect', contextName, '--format', '{{.Endpoints.docker.Host}}'], ...);
  ```
  If `contextName` begins with a dash (e.g. `DOCKER_CONTEXT="--help"`), Docker CLI parses `contextName` as a flag rather than positional context argument.
- **Evidence:**
  Calling `resolveDockerContextEndpoint("--help")` returns the Docker help text rather than a failure. While `parseAndValidateDockerEndpoint` ultimately rejects the help text as an invalid endpoint URL (thus failing closed), the child process execution should not accept arbitrary CLI flags.
- **Remediation Recommendation:**
  Insert the standard argument separator `--` before `contextName`:
  ```javascript
  execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}', '--', contextName], ...);
  ```
  Additionally, validate that `contextName` matches `/^[a-zA-Z0-9_\-\.]+$/`.

---

#### [FINDING R3-P3-02] Duplicate Unreachable Dead Code in `extractRoleNames`
- **Severity:** **P3 (Minor / Code Quality)**
- **File & Lines:** `scripts/backup/owner-map.mjs:1004–1010`
- **Vulnerability Description:**
  Lines 1000–1002 and lines 1004–1010 have identical `if (rolesData && typeof rolesData === 'object' && Array.isArray(rolesData.roles))` conditions. Because the first block returns early, lines 1004–1010 are unreachable dead code.
- **Remediation Recommendation:**
  Remove the redundant block at lines 1004–1010.

---

## 6. Test Suite Execution & Verification

### 6.1 Syntax and Linter Verification

```text
$ node --check scripts/backup/owner-map.mjs
(Exit Code: 0 - PASS)

$ node --check tests/backup/owner-map.test.mjs
(Exit Code: 0 - PASS)

$ ./node_modules/.bin/eslint scripts/backup/owner-map.mjs tests/backup/owner-map.test.mjs
(Exit Code: 0 - PASS, 0 errors, 0 warnings)
```

### 6.2 Helper #6 Unit & Adversarial Test Suite

Executed command:
`node --test tests/backup/owner-map.test.mjs`

```text
✔ 1. Valid owner mapping: generates deterministic plan, verifies all 11 supported object types (13.27ms)
✔ 2. Missing source-owner mapping: fails closed when an inventory owner has no mapping (0.36ms)
✔ 3. Duplicate source owner in owner-map: fails closed with DUPLICATE_OWNER_MAPPING (0.13ms)
✔ 4. Unknown source owner in owner-map: fails closed when mapping defines an owner absent from inventory (0.19ms)
✔ 5. Nonexistent target role: fails closed when target role does not exist in target inventory (0.17ms)
✔ 6. Invalid project/target identity: fails closed on format, projectRef, or target mismatch (0.21ms)
✔ 7. Duplicate JSON keys: strict parser rejects root, nested, and escaped duplicate keys (0.42ms)
✔ 8. SQL injection hardening: rejects injections in schema, table, function, and role identifiers (0.15ms)
✔ 9. Function/procedure overload resolution: distinguishes overloaded functions with exact arguments (0.21ms)
✔ 10. Deterministic SQL generation: identical byte-for-byte output regardless of input array ordering (0.36ms)
✔ 11. Missing approval hash: apply fails closed when --approved-sha256 is missing (7.78ms)
✔ 12. Incorrect approval hash: apply fails closed before database connection (1.29ms)
✔ 13. Plan modified after approval: apply fails closed when plan bytes on disk are altered (2.40ms)
✔ 14. Target identity and remote host mismatch: rejects remote endpoints and mismatched targets (4.64ms)
✔ 15. Apply rollback when SQL fails: transaction atomicity ensures partial changes revert (3.36ms)
✔ 16. Post-apply owner mismatch: verify fails closed with status BLOCKED (8.65ms)
✔ 17. SECURITY DEFINER mismatch: verify detects altered prosecdef flag and sets status BLOCKED (4.47ms)
✔ 18. proconfig mismatch: verify detects altered function configuration GUCs and sets status BLOCKED (3.85ms)
✔ 19. EXECUTE ACL mismatch: verify detects altered execution privileges and sets status BLOCKED (2.52ms)
✔ 20. Unsupported object type: fails closed on unknown or disallowed object types (0.15ms)
✔ CLI integration: plan, apply, verify roundtrip via subprocess execution (100.39ms)
✔ Prohibited SQL injection: rejects DROP, CREATE ROLE, GRANT, REVOKE keywords in generated statements (0.13ms)
✔ Live PostgreSQL 17 integration: full plan -> apply -> verify cycle with live catalog and rollback (2712.63ms)
✔ P1-01: verify fails closed with MISSING_CATALOG_DETAILS when inventory contains routines but catalog is omitted (2.35ms)
✔ P1-01: verify fails closed with MISSING_TARGET_ROUTINES when offline target catalog is omitted (2.20ms)
✔ P1-01: verify fails closed with EMPTY_ROUTINES_CATALOG when inventory has routines but catalog is empty (6.03ms)
✔ P1-01: verify fails closed with MALFORMED_CATALOG_DETAILS when routines is not an array (4.02ms)
✔ P1-01: verify fails closed with MALFORMED_ROUTINE_ENTRY when routine has non-boolean securityDefiner (2.25ms)
✔ P1-01: verify detects missing routine identity in source catalog and reports status BLOCKED (3.62ms)
✔ P1-02: validateTargetIsolation blocks remote PGHOST in process environment before child execution (0.16ms)
✔ P1-02: validateTargetIsolation blocks remote PGHOSTADDR in process environment before child execution (0.07ms)
✔ P1-02: validateTargetIsolation blocks PGSERVICE and PGSERVICEFILE environment variables (0.08ms)
✔ P1-02: validateTargetIsolation blocks remote DOCKER_HOST before child execution (0.25ms)
✔ P1-02: validateTargetIsolation blocks remote DOCKER_CONTEXT before child execution (27.87ms)
✔ P1-02: validateTargetIsolation blocks arbitrary unapproved container names (0.12ms)
✔ P1-02: validateTargetIsolation rejects conflicting connection options (--db-container and --db-host) (0.05ms)
✔ P1-02: validateTargetIsolation rejects omitted dbHost for direct psql execution (fail-closed) (0.05ms)
✔ P1-02: verifyDatabaseTargetIdentity fails closed when target mismatch occurs on remote/unverified target (64.54ms)
✔ P1-02: getSanitizedChildEnv removes all libpq connection override variables (0.11ms)
✔ P1-03: verifyDisposableTestTarget refuses unmarked database target without issuing any DROP statements (0.12ms)
✔ P1-03: verifyDisposableTestTarget refuses PostgreSQL major versions older than 17 (0.09ms)
✔ P2-01: validateTargetInventory rejects duplicate objectType:identity independent of record order (0.21ms)
✔ P2-01: verify fails closed with DUPLICATE_TARGET_ROUTINE when target catalog contains duplicate routine identities (2.59ms)
✔ P2-02: handlePlanCommand without target roles marks plan as PLAN_INCOMPLETE_UNVERIFIED_ROLES and applyReady=false (2.31ms)
✔ P2-03: verifiedRoutinesCount tracks valid routine even after a preceding routine fails verification (2.16ms)
✔ P2-04: handleApplyCommand strictly requires --map option to apply plan (1.28ms)
✔ P3-01: unquoted lowercase identifier public.foo preserves lowercase (0.08ms)
✔ P3-01: unquoted mixed-case identifier public.Foo folds to lowercase public.foo matching PostgreSQL semantics (0.04ms)
✔ P3-01: quoted mixed-case identifier "public"."Foo" preserves exact case matching PostgreSQL semantics (0.05ms)
✔ P3-01: unquoted role name folds to lowercase while quoted role preserves case (0.04ms)
✔ R2-P1-01: project ref containing newline is rejected before plan generation (0.13ms)
✔ R2-P1-01: project ref containing CRLF is rejected before plan generation (0.04ms)
✔ R2-P1-01: project ref containing SQL DROP TABLE is rejected before plan generation (0.05ms)
✔ R2-P1-01: target containing newline and SQL injection is rejected before plan generation (0.57ms)
✔ R2-P1-01: project ref with Unicode line separator ( ,  , …) is rejected (0.64ms)
✔ R2-P1-01: project ref with NUL byte and control characters is rejected (0.37ms)
✔ R2-P1-01: valid project ref and target generate byte-for-byte deterministic plan (0.67ms)
✔ R2-P1-01: plan grammar validation blocks unauthorized statement during apply even if hash is forged (2.77ms)
✔ R2-P1-01: plan grammar validation rejects semicolon in SQL comment (0.13ms)
✔ R2-P1-02: DOCKER_HOST tcp://127.0.0.1.evil.example:2375 is rejected by parser (0.34ms)
✔ R2-P1-02: DOCKER_HOST tcp://localhost.attacker.invalid:2375 is rejected by parser (0.07ms)
✔ R2-P1-02: DOCKER_HOST remote IP tcp://192.168.1.100:2375 is rejected by parser (0.08ms)
✔ R2-P1-02: DOCKER_HOST ssh://remote-host is rejected by parser (0.05ms)
✔ R2-P1-02: DOCKER_CONTEXT with benign name but remote endpoint is rejected (0.09ms)
✔ R2-P1-02: DOCKER_CONTEXT with benign name but SSH endpoint is rejected (0.08ms)
✔ R2-P1-02: valid local Unix socket passes endpoint validation (0.12ms)
✔ R2-P1-02: valid loopback endpoint (127.0.0.1 and localhost) passes endpoint validation (0.28ms)
✔ R2-P1-02: unresolvable or missing Docker endpoint fails closed with rejection (0.10ms)
✔ R2-P2-01: role old_admin preserves exact lowercase (0.03ms)
✔ R2-P2-01: role Old_Admin preserves exact mixed case (not lowercased) (0.03ms)
✔ R2-P2-01: two roles co-existing with different case are preserved and mapped distinctly (0.13ms)
✔ R2-P2-01: quoted mixed-case role unquotes and preserves case (0.03ms)
✔ R2-P2-01: SQL quoting safely escapes role containing quote character (0.03ms)
✔ R2-P2-01: ownership verification with case-sensitive role matches exact case and blocks mismatch (4.42ms)
✔ R2-P2-02: isDockerContainerAvailable returns false and does not throw when Docker CLI is missing (1.15ms)
✔ R2-P2-02: isDockerContainerAvailable returns false when Docker daemon is not running (15.24ms)
✔ R2-P2-02: isDockerContainerAvailable returns false and avoids Docker command when DOCKER_HOST is remote (0.21ms)
﹣ R2-P2-02: live integration test skips cleanly when container is unavailable (28.47ms) # Container 'nonexistent-container-xyz' is not available; test skipped as intended.
ℹ tests 78
ℹ pass 77
ℹ fail 0
ℹ skipped 1
```

---

### 6.3 Full Regression Suite (Helpers #1 through #5 & Contracts)

Every regression test suite was executed independently. All 314 tests passed with zero failures across the entire backup and restore harness:

| Helper / Component | Test Suite Path | Tests Run | PASS | FAIL | SKIP | Duration |
|---|---|---|---|---|---|---|
| **Helper #1 (AES-GCM Stream)** | `tests/backup/aesgcm-stream.test.mjs` | 48 | 48 | 0 | 0 | 57.56s |
| **Helper #2 (Offsite Bundle)** | `tests/backup/offsite-bundle.test.mjs` | 19 | 19 | 0 | 0 | 6.32s |
| **Helper #3 (Bundle Contract)** | `tests/backup/validate-bundle-index-contract.test.mjs` | 12 | 12 | 0 | 0 | 0.53s |
| **Helper #4 (Storage Export)** | `tests/backup/storage-export.test.mjs` | 37 | 37 | 0 | 0 | 4.40s |
| **Helper #5 (Storage Restore)** | `tests/backup/storage-restore.test.mjs` | 45 | 45 | 0 | 0 | 1.70s |
| **Safe Extract Storage (Python)**| `tests/backup/safe-extract-storage.test.py` | 71 | 70 | 0 | 1 | 14.72s |
| **Helper #4 Runbook Amendment** | `tests/backup/helper4-runbook-amendment.integration.test.py` | 4 | 4 | 0 | 0 | 1.02s |
| **Helper #6 (Audited Owner Map)**| `tests/backup/owner-map.test.mjs` | 78 | 77 | 0 | 1 | 3.11s |
| **TOTAL** | | **314** | **312** | **0** | **2** | **89.36s** |

*Note on Skipped Tests:*
1. `tests/backup/owner-map.test.mjs`: `R2-P2-02: live integration test skips cleanly when container is unavailable` (intentional graceful skip verification).
2. `tests/backup/safe-extract-storage.test.py`: `test_old_format_tar_skipped` (legacy format compatibility skip).

---

## 7. Security Architecture & Threat Model Assessment

### 7.1 Input Validation and Identity Normalization
- **JSON Strictness:** Duplicate keys at root, nested, and Unicode-escaped keys are rejected unconditionally.
- **Object Type Whitelist:** Supported types are strictly bounded to the 11 catalog types (`schema`, `table`, `partitioned_table`, `foreign_table`, `sequence`, `view`, `materialized_view`, `type`, `domain`, `function`, `procedure`).
- **Metadata Protection:** `validateMetadataIdentifier` strictly enforces `/^[a-zA-Z0-9_\-\.]{1,128}$/` and rejects control characters, newlines, null bytes, SQL comment tokens, and DDL keywords.

### 7.2 Defense-in-Depth in Plan Application
- The plan execution pipeline implements a two-stage gate:
  1. **Pre-execution Gate:** The hash of the SQL on disk is matched against `--approved-sha256`.
  2. **Grammar Gate:** The SQL content is scanned by `validatePlanSqlGrammar`.
- **Architectural Weakness Found:** Because `validatePlanSqlGrammar` relies on an insecure regex pattern with a greedy `.+` wildcard and an incomplete blacklist, a plan with a valid hash (e.g. approved through social engineering or insider threat) that contains embedded arbitrary SQL will pass through to `psql` without being flagged.

### 7.3 Database Target Isolation
- `getSanitizedChildEnv` successfully eliminates libpq environment variables (`PGHOST`, `PGHOSTADDR`, `PGPORT`, `PGSERVICE`, `PGSERVICEFILE`, etc.).
- Direct psql execution strictly requires an explicit loopback address (`127.0.0.1`, `localhost`, `::1`).
- Container execution strictly requires the container to be in `APPROVED_CONTAINERS`.
- Rehearsal sentinel verification enforces that the target database has the `_crm_disposable_test_marker` or `disposable-test` comment, preventing accidental execution against non-rehearsal targets.

---

## 8. Deviations from Remediation Round 2 Report

1. **Deviation in Finding R2-P1-01 Closure:**
   - The Round 2 report claimed R2-P1-01 was fully closed and that `validatePlanSqlGrammar` strictly allows only `ALTER ... OWNER TO` statements.
   - Independent audit proves that `validatePlanSqlGrammar` is susceptible to semicolon injection, comment termination, and blacklist bypass, allowing inline multi-statement execution.
2. **Deviation in Test Suite Scope:**
   - The Round 2 test suite only tested single-line statement rejections (e.g., `DROP TABLE` on its own line). It completely omitted multi-statement lines, inline semicolons, inline comments, and space-free comment keywords (`DROP/*x*/TABLE`).
3. **Deviation in Test Helper Safety:**
   - `isDockerContainerAvailable` omitted the `APPROVED_CONTAINERS` check that was otherwise rigorously applied inside `owner-map.mjs`.

---

## 9. Final Review Verdict

### **VERDICT: REJECTED**

### Justification:
1. **P1 Acceptance Blocker Present:** `R3-P1-01` demonstrates that `validatePlanSqlGrammar` can be bypassed to execute arbitrary SQL statements (such as `ALTER ROLE ... PASSWORD`, `DROP/*x*/TABLE`, or `DO $$ ... $$`) during `apply`.
2. **P2 Major Issue Present:** `R3-P2-01` demonstrates that the test fixture preflight helper `isDockerContainerAvailable` probes arbitrary Docker containers with `docker exec` without verifying the container allowlist.
3. In accordance with Section 11 & 12 of the Independent Review Instructions, an audit revealing a P1/P2 blocker **must not** be accepted.

---

## 10. Required Remediation for Round 4

The Remediation Engineer must implement the following fixes before resubmitting for Round 4 review:

1. **Fix `validatePlanSqlGrammar` (P1):**
   - For every statement line, assert that `trimmed.slice(0, -1).includes(';') === false`.
   - Disallow line comment `--` and block comment `/*` on statement lines.
   - Replace greedy `.+` in `allowedAlterRegex` with strict single-token matching for object identifiers and role names.
   - Add adversarial unit tests covering:
     - Semicolons inside statement lines.
     - `--` comment termination inside statement lines.
     - `/*...*/` comment insertion inside keywords.
     - `ALTER ROLE` and other administrative statements.
2. **Fix `isDockerContainerAvailable` (P2):**
   - Add `if (!APPROVED_CONTAINERS.has(containerName)) return false;` at the beginning of `isDockerContainerAvailable`.
3. **Fix `resolveDockerContextEndpoint` (P3):**
   - Pass `--` delimiter before `contextName` in `execFileSync`.
4. **Clean up dead code in `extractRoleNames` (P3):**
   - Remove redundant `if (rolesData && ...)` block at lines 1004–1010.

*Report signed and handed over to Project Custodian.*  
*Independent Security Reviewer Round 3*
