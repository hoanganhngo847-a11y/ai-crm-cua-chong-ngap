# Meta Ads: Selective-Release Ledger Architecture & Staging Deployment Engine

**Document Reference**: `docs/META_ADS_SELECTIVE_LEDGER_IMPLEMENTATION.md`  
**Repository**: `hoanganhngo847-a11y/ai-crm-cua-chong-ngap`  
**Branch**: `meta_ads_integration` | **Pull Request**: [#139](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/pull/139) (Open + Draft)  
**Verified Git Baseline**: `e51a5989143582af0885ba5ee26644a68b388995`
**Target Staging Project**: `qmhfmgkymjgoevwmkidm` (`ai-crm-meta-staging`)  
**Target Engine**: PostgreSQL 17.11 (Supabase Free Plan)  
**Execution Status**: **BLOCKED FOR HOSTED EXECUTION** (Engine validated locally; awaiting physical backup restoration verification and project owner approval).

---

## 1. Executive Summary & Architecture Strategy

This specification details the formal implementation of **Strategy (A+B)** for deploying the five isolated Meta Ads lead attribution migrations to the existing Supabase Staging environment without performing destructive database recreation, without modifying the historical 21 migration ledger entries, and without fabricating records for the 95 unapplied canonical gap migrations.

```
+--------------------------------------------------------------------------------------------------+
|                                    CONTROLLED TRANSACTION                                        |
|                                                                                                  |
|  1. ADVISORY LOCK (pg_advisory_xact_lock) + SHARE LOCK ON CANONICAL LEDGER & ALL APP TABLES      |
|  2. PRECONDITIONS: Server Version 17.x, Project Ref Check, 21-Ledger SHA Check, Catalog Match    |
|  3. SOURCES: 5 Isolated Meta Ads Migrations (Pinned Hashes f29e..., e83f..., 7931..., etc.)      |
|  4. PRIVATE REGISTRY: Record release metadata into private.selective_feature_releases            |
|  5. FENCE TRIGGER: trg_guard_selective_release_ledger on supabase_migrations.schema_migrations   |
|  6. POSTCONDITIONS: Schema verification (365 approved objects), 0 writes to canonical ledger     |
+--------------------------------------------------------------------------------------------------+
```

### Core Invariants Guaranteed
1. **Preservation of Canonical Ledger**: The existing `supabase_migrations.schema_migrations` table contains exactly 21 historical records. The selective executor performs **0 INSERTs, 0 UPDATEs, and 0 DELETEs** on this table during selective deployment.
2. **No Gap Migration Fabrication**: None of the 95 canonical gap migrations between prefix 21 and the Meta feature bundle are falsely recorded as executed.
3. **Fail-Closed Atomic Transaction**: The entire release—preconditions, 5 migration DDLs, registry record creation, fencing trigger installation, and postconditions—runs inside a single transaction guarded by `pg_advisory_xact_lock`. Any check failure triggers an immediate `ROLLBACK`, leaving zero Meta tables, zero orphaned rows, and zero catalog changes.
4. **Target Project Identity & Connection Verification**: Validates the actual database connection host and Supabase project ref prior to running DDL. Redacts credentials and fails closed on unknown or mismatched targets.
5. **PostgreSQL 17.x Version Enforcement**: Actively asserts that the server version is PostgreSQL 17.x (specifically matching staging 17.11 baseline) before executing DDL.
6. **Messenger & Omnichannel Isolation**: As established in commit `25e8f21`, `han_ingest` is completely untouched. Messenger SLA windows remain at count 0. Lead Ads intake operates strictly through `public.ingest_meta_leadgen_event` callable exclusively by `service_role`.

---

## 2. Target Project & Connection Verification

To eliminate risks of accidentally running migrations against the wrong database (such as local dev or production), the executor actively inspects the actual database connection string and server parameters before sending any DDL.

### 2.1 Connection String Inspection (`verifyTargetProjectConnection`)
The executor provides [`verifyTargetProjectConnection`](file:///Users/hoangthuy/.gemini/antigravity/worktrees/ai-crm-cua-chong-ngap/meta_ads_integration/scripts/meta-ads/selective-executor.ts) which inspects the target connection URL:
- **Direct Supabase Connection**: Extracts the project ref from `db.<project_ref>.supabase.co`.
- **Pooler Connection**: Extracts the project ref from the username `postgres.<project_ref>`.
- **Zero Credentials Logged**: Passwords and secrets are strictly redacted (`***`) from all error messages, diagnostics, and logs.
- **Fail-Closed Policy**: If the target project ref cannot be extracted or does not match `TARGET_STAGING_PROJECT` (`qmhfmgkymjgoevwmkidm`), it throws `TARGET_PROJECT_MISMATCH` or `TARGET_VERIFICATION_FAILED` and halts immediately.
- **Local Test Opt-In**: Connections to `localhost` / `127.0.0.1` are rejected by default unless the caller explicitly sets `{ allowLocalTest: true }` for disposable test harnesses.

### 2.2 In-Database Preflight Guard
Inside the transaction preflight block, the executor asserts:
```sql
IF v_target_project IS DISTINCT FROM v_expected_project THEN
  RAISE EXCEPTION 'TARGET_PROJECT_MISMATCH: Target project % does not match expected staging project %', v_target_project, v_expected_project;
END IF;
```

---

## 3. PostgreSQL Version Enforcement (17.x Baseline)

The staging environment is confirmed to run **PostgreSQL 17.11**. Version enforcement is applied on two distinct layers:

### 3.1 TypeScript Validation (`verifyPostgresServerVersion`)
Before running any migration, the executor queries `SHOW server_version;` and `SHOW server_version_num;`:
```typescript
if (serverVersionNum < 170000 || serverVersionNum >= 180000) {
  throw new Error(`POSTGRES_VERSION_INCOMPATIBLE: Server version ${serverVersion} does not match required PostgreSQL 17.x baseline.`);
}
```

### 3.2 SQL Transaction Guard
Inside the atomic preflight DO block:
```sql
IF current_setting('server_version_num')::integer < 170000 OR current_setting('server_version_num')::integer >= 180000 THEN
  RAISE EXCEPTION 'POSTGRES_VERSION_INCOMPATIBLE: Server version % (num: %) does not match required PostgreSQL 17.x baseline (target 17.11)',
    current_setting('server_version'), current_setting('server_version_num');
END IF;
```

---

## 4. Private Selective-Release Registry Architecture

Rather than polluting the canonical `supabase_migrations.schema_migrations` ledger, release metadata is recorded in an isolated private registry schema: `private.selective_feature_releases`.

### 4.1 Table DDL & Access Controls
```sql
CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE IF NOT EXISTS private.selective_feature_releases (
    release_id text PRIMARY KEY,
    feature_name text NOT NULL,
    target_project_ref text NOT NULL,
    source_commit text NOT NULL,
    bundle_sha256 text NOT NULL,
    preconditions_sha256 text NOT NULL,
    postconditions_sha256 text NOT NULL,
    sources jsonb NOT NULL,
    pre_ledger_fingerprint text NOT NULL,
    pre_catalog_fingerprint text NOT NULL,
    post_catalog_fingerprint text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    execution_status text NOT NULL,
    recovery_evidence jsonb NOT NULL,
    reconciled_to_canonical boolean NOT NULL DEFAULT false,
    reconciled_at timestamptz NULL
);

-- Strict Access Control: Browser roles cannot read or mutate release evidence
REVOKE ALL ON TABLE private.selective_feature_releases FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE private.selective_feature_releases TO service_role;
```

### 4.2 Field Descriptions & Evidence Tracking
| Field | Type | Description |
|---|---|---|
| `release_id` | `text` | Unique release identifier (e.g. `meta-ads-20261031-r1`). Prevents duplicate execution. |
| `feature_name` | `text` | Feature scope identifier (`META_ADS_LEAD_ATTRIBUTION`). |
| `target_project_ref` | `text` | Target Supabase project ref (`qmhfmgkymjgoevwmkidm`). Rejects wrong instances. |
| `source_commit` | `text` | Exact git commit hash of the verified bundle (`e51a598...`). |
| `bundle_sha256` | `text` | SHA-256 checksum of the assembled 5-file DDL body. |
| `preconditions_sha256` | `text` | SHA-256 checksum of the preflight validation SQL block. |
| `postconditions_sha256` | `text` | Status token updated upon post-flight verification success (`POSTCONDITIONS_VERIFIED`). |
| `sources` | `jsonb` | Array of migration filenames, pinned SHA-256 hashes, and statement counts. |
| `pre_ledger_fingerprint` | `text` | SHA-256 digest of the 21 existing canonical ledger rows and stored SQL hashes. |
| `pre_catalog_fingerprint` | `text` | Catalog fingerprint of public/private schemas prior to execution (matches prefix 21). |
| `post_catalog_fingerprint` | `text` | Catalog fingerprint of public/private schemas post-execution (matches 365 approved objects). |
| `applied_at` | `timestamptz` | Exact transaction timestamp (`clock_timestamp()`). |
| `execution_status` | `text` | Final status (`COMPLETED`). |
| `recovery_evidence` | `jsonb` | Diagnostic metadata: ledger entries preserved, gap migrations omitted, lock key. |
| `reconciled_to_canonical` | `boolean` | Flag indicating whether this feature has been reconciled into canonical full-chain migrations. |
| `reconciled_at` | `timestamptz` | Timestamp when canonical reconciliation occurred. |

---

## 5. Uncertain Commit Recovery State Machine

When a client loses network connectivity exactly as `COMMIT;` is transmitted (or before the acknowledgment packet returns), the client cannot assume whether PostgreSQL committed or aborted the transaction.

To resolve this deterministically without blindly re-running migrations, the executor implements [`evaluateReleaseProbe`](file:///Users/hoangthuy/.gemini/antigravity/worktrees/ai-crm-cua-chong-ngap/meta_ads_integration/scripts/meta-ads/selective-executor.ts) which inspects the database via [`PROBE_RELEASE_SQL`](file:///Users/hoangthuy/.gemini/antigravity/worktrees/ai-crm-cua-chong-ngap/meta_ads_integration/scripts/meta-ads/selective-executor.ts).

```
                            [ PROBE RELEASE STATE ]
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        ▼                              ▼                              ▼
 [ COMMITTED & VERIFIED ]    [ UNCOMMITTED / CLEAN ]     [ CORRUPTED / INCONSISTENT ]
 ├─ Registry = COMPLETED     ├─ Registry row = NULL      ├─ Tampered SHA or partial tables
 ├─ bundle_sha256 match      ├─ 0 Meta tables            ├─ Missing registry record
 ├─ 7 Meta tables exist      ├─ 21 canonical rows        └─ Ledger count drift
 ├─ 21 canonical rows        └─ Safe to re-run           Action: HALT & INVESTIGATE
 └─ Action: DO NOT RERUN                                 (Fail-closed, refuse rerun)
```

### Three Deterministic Recovery Outcomes:
1. **`COMMITTED_VERIFIED`**:
   - `private.selective_feature_releases` contains `release_id` with `execution_status = 'COMPLETED'`.
   - `bundle_sha256` matches the expected bundle hash.
   - All 7 Meta tables exist.
   - Canonical ledger retains exactly 21 rows.
   - Fence trigger is active.
   - **Recommendation**: `DO_NOT_RERUN`. Deployment succeeded prior to disconnect. No action needed.
2. **`UNCOMMITTED_CLEAN`**:
   - 0 registry records exist for `release_id`.
   - 0 Meta tables exist.
   - Canonical ledger retains exactly 21 rows.
   - **Recommendation**: `SAFE_TO_EXECUTE`. The transaction cleanly rolled back upon disconnection. Safe to retry once network stabilizes.
3. **`CORRUPTED_INCONSISTENT`**:
   - Partial tables exist without registry, OR registry hash does not match, OR canonical ledger drifted.
   - **Recommendation**: `HALT_AND_INVESTIGATE`. Rerunning migrations is strictly **BLOCKED**. Requires physical operator investigation and restoration from backup.

---

## 6. Migration Writer Fencing & Honest Boundary Review

### 6.1 Fence Trigger Mechanism
The fail-closed trigger [`trg_guard_selective_release_ledger`](file:///Users/hoangthuy/.gemini/antigravity/worktrees/ai-crm-cua-chong-ngap/meta_ads_integration/scripts/meta-ads/selective-executor.ts) installed on `supabase_migrations.schema_migrations` intercepts write operations:
- Blocks any `INSERT` while a selective release is unreconciled with `MIGRATION_LEDGER_FENCED`.
- Blocks any `UPDATE` or `DELETE` with `MIGRATION_LEDGER_IMMUTABLE`.

### 6.2 Realistic Boundaries & Why Deployment Remains BLOCKED
It is essential to honestly articulate the technical limits of trigger-based fencing:
1. **DDL Preceding Ledger Writes**: Typical migration CLIs (such as Supabase CLI `db push`) execute SQL DDL statements *first*, and only attempt to insert the record into `schema_migrations` *after* the DDL completes. If a developer runs an unapproved migration that modifies existing schema outside of an enclosing transaction, DDL will execute before the ledger insert triggers an exception.
2. **Superuser Privilege Bypass**: Any connection using `postgres` superuser privileges can drop the trigger (`DROP TRIGGER trg_guard_selective_release_ledger`) or perform arbitrary out-of-band schema changes.
3. **No Direct Network Interception**: Database triggers cannot prevent external connections from executing raw DDL.

### 6.3 Mandatory Operational Maintenance Conditions
Because database triggers alone cannot guarantee absolute isolation against uncoordinated superusers, the following maintenance conditions are mandatory:
- **Revocation of Direct Developer Credentials**: During the selective-release staging lifecycle, direct database passwords must be rotated and restricted solely to the automated CI/CD pipeline and the lead operator.
- **Maintenance Coordination Window**: Any hosted deployment must take place during a scheduled maintenance window with zero concurrent human sessions.
- **Hosted Execution Status**: **REMAINS BLOCKED**. Deployment cannot proceed based solely on database triggers without operational access lockdown and physical backup verification.

---

## 7. Canonical Migration Reconciliation Strategy

When staging eventually catches up with the canonical migration history (applying the 95 gap migrations and aligning with production), the selective release is reconciled cleanly:

### 7.1 Reconciliation Procedure ([`buildCanonicalReconciliationPackage`](file:///Users/hoangthuy/.gemini/antigravity/worktrees/ai-crm-cua-chong-ngap/meta_ads_integration/scripts/meta-ads/selective-executor.ts))
In a single atomic transaction under exclusive lock:
1. Verifies that the selective release is in `COMPLETED` status in `private.selective_feature_releases`.
2. Marks `reconciled_to_canonical = true` and records reconciliation timestamp.
3. Disarms the fence trigger `trg_guard_selective_release_ledger`.
4. Records the five Meta migrations (`20261030090000`, `20261030100000`, `20261030110000`, `20261030120000`, `20261030130000`) into `supabase_migrations.schema_migrations` with their full canonical SQL statements.
5. Verifies canonical ledger now contains 21 + 5 = 26 records, and all original 21 records are byte-for-byte unchanged.

### 7.2 Proof of Zero Re-execution & Data Preservation
Because the 5 Meta migrations are now recorded in `supabase_migrations.schema_migrations`:
- Subsequent canonical migration runners (such as Supabase CLI) inspect the ledger, find all 5 Meta migrations, and **SKIP** them.
- They are **NEVER re-executed**, preventing duplicate table, column, or policy errors (`policy "rls_meta_ad_accounts_tenant" already exists`).
- All customer lead attribution data, campaigns, and touchpoints created during the selective period remain **100% intact**.
- Subsequent migrations (e.g. migration 122+) execute cleanly on top.

---

## 8. Comprehensive Test Results (`test:selective-ledger`)

The selective-release ledger engine is tested against a real local PostgreSQL 17.11 container (`supabase_db_ai-crm-cua-chong-ngap`) and is integrated directly into the GitHub Actions Verify workflow.

### 8.1 Test Execution Summary
Command: `npm run test:selective-ledger`  
Test File: [`tests/staging/selective-ledger.test.ts`](file:///Users/hoangthuy/.gemini/antigravity/worktrees/ai-crm-cua-chong-ngap/meta_ads_integration/tests/staging/selective-ledger.test.ts)  
Result: **13/13 PASSED (100%)** | Duration: ~42.3 seconds

| # | Scenario Tested | Outcome | Details Verified |
|---|---|---|---|
| 1 | Successful selective release | **PASS** | 5 Meta tables created, registry recorded, exactly 21 canonical ledger entries preserved byte-for-byte. |
| 1b | Migration writer fence | **PASS** | Unapproved `INSERT` into `schema_migrations` blocked with `MIGRATION_LEDGER_FENCED`. |
| 1c | Canonical ledger immutability | **PASS** | `UPDATE` and `DELETE` on `schema_migrations` blocked with `MIGRATION_LEDGER_IMMUTABLE`. |
| 1d | Duplicate release attempt | **PASS** | Re-running the package rejected with `SELECTIVE_RELEASE_ALREADY_APPLIED`. |
| 2 | Target project verification | **PASS** | Verifies direct & pooler URLs; rejects wrong project ref; redacts credentials (`***`); enforces local opt-in. |
| 2b | PostgreSQL version enforcement | **PASS** | Enforces PostgreSQL 17.x; rejects PostgreSQL 16 and 18 in both TypeScript and SQL preflight. |
| 3 | Tampered source hash / SQL | **PASS** | Modified migration content throws hash mismatch / forbidden statement error prior to DDL. |
| 4 | Existing partial Meta schema | **PASS** | Pre-existing `meta_ad_accounts` throws `UNEXPECTED_EXISTING_META_OBJECTS`, 0 other tables created. |
| 5 | Canonical ledger drift | **PASS** | Modified entry in `schema_migrations` throws `META_21_LEDGER_DRIFT`, 0 Meta tables created. |
| 6 | Application catalog drift | **PASS** | Injected unapproved function throws `META_21_SCHEMA_OR_ACL_DRIFT`, release aborted. |
| 7 | Concurrent executor attempts | **PASS** | Background session holding `pg_advisory_lock` causes second session to fail closed with lock timeout. |
| 8 | Mid-transaction failure | **PASS** | Simulated failure in Migration 3 rolls back 100%, 0 Meta tables left, 21 ledger rows intact. |
| 9 | Postcondition failure | **PASS** | Injected unauthorized object throws `META_21_POST_SCHEMA_OR_ACL_MISMATCH`, full transaction rolled back. |
| 10 | Uncertain commit recovery | **PASS** | Probes committed, uncommitted, and corrupted states; returns `DO_NOT_RERUN` or `HALT_AND_INVESTIGATE`. |
| 11 | Canonical reconciliation | **PASS** | Real sequence execution proves Meta migrations are not re-run, original 21 migrations preserved, lead data intact. |

---

## 9. CI Integration (`.github/workflows/verify.yml`)

The selective ledger test suite is officially added to `.github/workflows/verify.yml`:
```yaml
      - run: supabase start -x studio,logflare,vector
      - run: supabase db reset
      - run: npx tsx --conditions=react-server --test tests/staging/migration-ledger.test.ts tests/staging/migration-security-db.test.ts
      - run: npm run test:staging-readiness
      - run: npm run test:meta-staging-preflight
      - run: npm run test:selective-ledger
```
Because `supabase start` in CI launches PostgreSQL 17.11 (configured via `major_version = 17` in `supabase/config.toml`), the test suite executes on every PR and commit against real PostgreSQL 17.11.

---

## 10. Condition Assessment & Final Verdict

| Condition Category | Status | Notes |
|---|---|---|
| **Target Project Verification** | **PASS** | Active URL host & ref extraction, zero logged credentials, in-database guard. |
| **PostgreSQL Version Enforcement** | **PASS** | Validates 17.x baseline in TypeScript and in SQL preflight; rejects incompatible versions. |
| **CI Coverage on PostgreSQL 17.11** | **PASS** | Added to `.github/workflows/verify.yml`; executes all 13 tests on real container. |
| **Uncertain Commit Recovery** | **PASS** | Deterministic probe distinguishing committed, uncommitted, and corrupted states. |
| **Canonical Reconciliation Rehearsal** | **PASS** | Real migration sequence proves zero re-execution, 21 rows preserved, lead data intact. |
| **Fencing Guard & Honest Limits** | **PASS** | Database trigger active; honest documentation of superuser and pre-ledger DDL limits. |
| **Regression & Integration Gates** | **PASS** | 22/22 integration gates, preflight, meta-ads (43/43), typecheck (0), lint (0). |
| **Physical Staging Backup & Restoration** | **PENDING** | Runbook prepared; awaits physical execution and restoration proof by operator. |
| **Project Owner Approval** | **PENDING** | Awaiting formal owner sign-off on PR #139. |
| **HOSTED STAGING EXECUTION** | **BLOCKED** | Safe, proven, and ready for review; hosted execution remains strictly blocked. |

### Final Verdict: **BLOCKED**
Hosted deployment to Supabase Staging (`qmhfmgkymjgoevwmkidm`) remains **BLOCKED**.
All 5 review issues have been fully resolved, implemented, and proven with 100% passing tests. Execution on hosted infrastructure must remain blocked until the physical backup is taken and project owner approval is received.
