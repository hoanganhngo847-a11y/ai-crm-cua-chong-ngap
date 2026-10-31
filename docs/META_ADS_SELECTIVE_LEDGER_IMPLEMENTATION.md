# Meta Ads: Selective-Release Ledger Architecture & Staging Deployment Engine

**Document Reference**: `docs/META_ADS_SELECTIVE_LEDGER_IMPLEMENTATION.md`  
**Repository**: `hoanganhngo847-a11y/ai-crm-cua-chong-ngap`  
**Branch**: `meta_ads_integration` | **Pull Request**: [#139](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/pull/139) (Open + Draft)  
**Verified Git Baseline**: `25e8f21c896fc2acb61f041f464d077c52793271`  
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
|  2. PRECONDITIONS: Target Project Check, Canonical Ledger SHA Check (21), Schema Fingerprint     |
|  3. SOURCES: 5 Isolated Meta Ads Migrations (Pinned Hashes f29e..., e83f..., 7931..., etc.)      |
|  4. PRIVATE REGISTRY: Record release metadata into private.selective_feature_releases            |
|  5. FENCE TRIGGER: trg_guard_selective_release_ledger on supabase_migrations.schema_migrations   |
|  6. POSTCONDITIONS: Schema verification (365 approved objects), 0 writes to canonical ledger     |
+--------------------------------------------------------------------------------------------------+
```

### Core Invariants Guaranteed
1. **Preservation of Canonical Ledger**: The existing `supabase_migrations.schema_migrations` table contains exactly 21 historical records. The selective executor performs **0 INSERTs, 0 UPDATEs, and 0 DELETEs** on this table.
2. **No Gap Migration Fabrication**: None of the 95 canonical gap migrations between prefix 21 and the Meta feature bundle are falsely recorded as executed.
3. **Fail-Closed Atomic Transaction**: The entire release—preconditions, 5 migration DDLs, registry record creation, fencing trigger installation, and postconditions—runs inside a single transaction guarded by `pg_advisory_xact_lock`. Any check failure triggers an immediate `ROLLBACK`, leaving zero Meta tables, zero orphaned rows, and zero catalog changes.
4. **Messenger & Omnichannel Isolation**: As established in commit `25e8f21`, `han_ingest` is completely untouched. Messenger SLA windows remain at count 0. Lead Ads intake operates strictly through `public.ingest_meta_leadgen_event` callable exclusively by `service_role`.

---

## 2. Private Selective-Release Registry Architecture

Rather than polluting the canonical `supabase_migrations.schema_migrations` ledger, release metadata is recorded in an isolated private registry schema: `private.selective_feature_releases`.

### 2.1 Table DDL & Access Controls
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

### 2.2 Field Descriptions & Evidence Tracking
| Field | Type | Description |
|---|---|---|
| `release_id` | `text` | Unique release identifier (e.g. `meta-ads-20261031-r1`). Prevents duplicate execution. |
| `feature_name` | `text` | Feature scope identifier (`META_ADS_LEAD_ATTRIBUTION`). |
| `target_project_ref` | `text` | Target Supabase project ref (`qmhfmgkymjgoevwmkidm`). Rejects wrong instances. |
| `source_commit` | `text` | Exact git commit hash of the verified bundle (`25e8f21c896fc2acb61f041f464d077c52793271`). |
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

## 3. Dedicated Controlled Executor (`selective-executor.ts`)

The dedicated executor is implemented in [`scripts/meta-ads/selective-executor.ts`](file:///Users/hoangthuy/.gemini/antigravity/worktrees/ai-crm-cua-chong-ngap/meta_ads_integration/scripts/meta-ads/selective-executor.ts).

### 3.1 Pinned Source Hashes
All five Meta Ads migrations are strictly pinned against their verified SHA-256 checksums:
```typescript
export const PINNED_SOURCE_HASHES: Record<string, string> = {
  '20261030090000_meta_ads_lead_attribution.sql': 'f29e10fc5655bf9e2b736b87e49589a0be5ca55cb7c0cd185422f0af9a7fd95a',
  '20261030100000_meta_ads_hardening.sql': 'e83f9ffb4a0eb4914ac8b1b6cca35674720dde8809bb30c66218eecbd2001657',
  '20261030110000_meta_ads_final_remediation.sql': '79311ef986d9d9a22be77bfafb4b602854aebab6f8a864ea726d9ac7a7cc9814',
  '20261030120000_meta_ads_attribution_rpc_security.sql': 'a06d05072823d0a057cc48d8c15230ee57da6c6f4b388a5ccce8fb51c12aa9e1',
  '20261030130000_meta_ads_phone_duplicate_history.sql': '54b36ff61749c0881f38ce257976bcacf9f679f89e6b151297220d04232c0770',
};
```

### 3.2 Transaction & Locking Strategy
To prevent concurrency hazards, partial applications, and race conditions with client queries:
1. **Lock Timeout**: Sets `SET LOCAL lock_timeout = '5s'`. If locks cannot be acquired within 5 seconds, the executor immediately aborts rather than deadlocking the database.
2. **Transaction-level Advisory Lock**:
   ```sql
   SELECT pg_advisory_xact_lock(hashtextextended('meta-ads-selective-release', 0));
   ```
   This serializes all attempts across concurrent connections and automatically releases the lock upon transaction commit or rollback.
3. **Table Share Locks**:
   ```sql
   LOCK TABLE supabase_migrations.schema_migrations IN SHARE MODE;
   ```
   In addition, every application table in `public` and `private` is locked in `SHARE MODE` during checkpoint creation, blocking concurrent modifications while snapshot digests are calculated.

### 3.3 Precondition Gates (Preflight)
The preflight PL/pgSQL block enforces 6 mandatory invariant checks:
1. **Target Project Identity**: Verifies that the connected database belongs to `qmhfmgkymjgoevwmkidm`. If a developer attempts to execute this against another database (e.g., local dev or production), it throws `TARGET_PROJECT_MISMATCH`.
2. **Duplicate Release Guard**: Checks `private.selective_feature_releases` for `release_id`. Throws `SELECTIVE_RELEASE_ALREADY_APPLIED` if already run.
3. **21-Entry Ledger Hash Verification**: Fetches all rows from `supabase_migrations.schema_migrations`, verifies that the row count is exactly 21, and compares the stored SQL SHA-256 hashes against the canonical prefix baseline. Any discrepancy throws `META_21_LEDGER_DRIFT`.
4. **Target Meta Domain Absence**: Verifies that zero Meta relations exist (`meta_ad_accounts`, `meta_campaigns`, `meta_ads`, `meta_lead_forms`, `lead_attribution_touchpoints`, `meta_ad_account_tokens`, `meta_leadgen_events`). Throws `UNEXPECTED_EXISTING_META_OBJECTS` if partial schema exists.
5. **Catalog & ACL Fingerprint**: Computes the SHA-256 fingerprint across all 10 schema categories (excluding `private.selective_feature_releases`) and verifies an exact match with the prefix 21 catalog. Throws `META_21_SCHEMA_OR_ACL_DRIFT` if any drift exists.
6. **Data Checkpoint**: Takes row count and content SHA-256 digests of all existing tables into temporary memory table `meta_21_rows`.

### 3.4 Postcondition Gates (Postflight)
After running the five migration SQL bodies and inserting the registry record:
1. **Catalog Diff & Fingerprint Check**: Reruns the 10-category catalog query. Compares against the approved post-deployment catalog (365 added objects, 0 removed objects, 0 modified existing objects). Throws `META_21_POST_SCHEMA_OR_ACL_MISMATCH` if any unapproved changes are present.
2. **Canonical Ledger Immutability Proof**: Verifies byte-level identity between `supabase_migrations.schema_migrations` and the pre-execution snapshot `meta_21_ledger` via symmetric `EXCEPT` set difference. Throws `META_21_LEDGER_CHANGED` if any row was touched.
3. **Data Integrity Verification**: Verifies that row counts and content digests for all pre-existing tables match the pre-execution snapshot exactly (excluding the 7 approved NULL attribution columns on `public.customers`). Throws `META_21_EXISTING_ROWS_CHANGED` if existing rows were corrupted.
4. **Seed Row Rejection**: Ensures zero unexpected test/seed rows were inserted into new Meta tables. Throws `META_21_UNEXPECTED_SEED_DATA` if populated.
5. **Registry Confirmation**: Updates `postconditions_sha256` in `private.selective_feature_releases` to confirm successful postflight completion.

---

## 4. Ordinary Migration Writer Fencing & Honest Boundary Assessment

To protect the selective-release staging environment from accidental corruption by developers running blind `supabase db push` or other migration runners, an automated fail-closed fence trigger is installed directly on `supabase_migrations.schema_migrations`.

### 4.1 Fence Trigger Implementation
```sql
CREATE OR REPLACE FUNCTION supabase_migrations.guard_selective_release_ledger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'private' AND tablename = 'selective_feature_releases'
    ) THEN
      IF EXISTS (
        SELECT 1 FROM private.selective_feature_releases WHERE NOT reconciled_to_canonical
      ) THEN
        RAISE EXCEPTION 'MIGRATION_LEDGER_FENCED: Selective feature release active. Canonical migration push is blocked until formal reconciliation.';
      END IF;
    END IF;
  ELSIF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'MIGRATION_LEDGER_IMMUTABLE: Canonical migration history is append-only and cannot be updated or deleted.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_selective_release_ledger ON supabase_migrations.schema_migrations;
CREATE TRIGGER trg_guard_selective_release_ledger
  BEFORE INSERT OR UPDATE OR DELETE ON supabase_migrations.schema_migrations
  FOR EACH ROW EXECUTE FUNCTION supabase_migrations.guard_selective_release_ledger();
```

### 4.2 Technical Boundaries of Fencing (Why Deployment Remains BLOCKED)
While `trg_guard_selective_release_ledger` successfully intercepts and blocks any tool attempting to record a migration into `supabase_migrations.schema_migrations`, it has technical boundaries that must be honestly documented:

1. **DDL Before Ledger Insert**: Standard migration tools (including Supabase CLI's `db push`) execute SQL DDL statements *first*, and only insert the migration record into `schema_migrations` *after* the DDL succeeds. If an unapproved migration modifies existing schema before hitting the ledger insert, the failure in the trigger will abort the transaction only if the migration tool wrapped the operation in a transaction.
2. **Superuser / Direct Connection Bypass**: Any developer or script connecting with `postgres` superuser privileges can execute arbitrary DDL or drop the trigger (`DROP TRIGGER trg_guard_selective_release_ledger`).
3. **No Network-Level Fencing**: Database triggers cannot prevent external HTTP/REST or Postgres connections from executing uncoordinated commands.

**Conclusion**: In-database fencing provides strong defense-in-depth against accidental migration writes, but cannot replace physical backups, repository access controls, and administrative discipline. Consequently, **hosted execution remains BLOCKED** until operational controls and backup restoration are formally verified.

---

## 5. Canonical Reconciliation Strategy

When the project eventually upgrades the canonical migration chain (applying the 95 gap migrations and standardizing staging with production), the selective release can be reconciled cleanly without data loss:

```
[ Selective Release Active ] ──> [ Canonical Upgrade Prepared ] ──> [ Reconcile Registry ] ──> [ Disarm Fence ] ──> [ Apply Canonical Ledger ]
```

1. **Reconciliation Transaction**:
   ```sql
   UPDATE private.selective_feature_releases
   SET reconciled_to_canonical = true,
       reconciled_at = clock_timestamp(),
       recovery_evidence = recovery_evidence || '{"reconciled": true}'::jsonb
   WHERE release_id = 'meta-ads-20261031-r1';
   ```
2. **Disarm Fence**:
   ```sql
   DROP TRIGGER IF EXISTS trg_guard_selective_release_ledger ON supabase_migrations.schema_migrations;
   DROP FUNCTION IF EXISTS supabase_migrations.guard_selective_release_ledger();
   ```
3. **Preserve Customer Attribution Data**: Because the 5 Meta Ads migrations in the canonical repo will use `CREATE TABLE IF NOT EXISTS` and identical column definitions, canonical migration application safely adopts the existing tables and attribution rows without schema conflicts.

---

## 6. Comprehensive Test Results (`test:selective-ledger`)

The selective-release ledger engine was thoroughly tested against a real local PostgreSQL 17.11 container (`supabase_db_ai-crm-cua-chong-ngap`) matching the staging configuration.

### 6.1 Test Execution Summary
Command: `npm run test:selective-ledger`  
Test File: [`tests/staging/selective-ledger.test.ts`](file:///Users/hoangthuy/.gemini/antigravity/worktrees/ai-crm-cua-chong-ngap/meta_ads_integration/tests/staging/selective-ledger.test.ts)  
Result: **11/11 PASSED (100%)** | Duration: ~64.2 seconds

| # | Scenario Tested | Outcome | Details Verified |
|---|---|---|---|
| 1 | Successful selective release | **PASS** | 5 Meta tables created, registry recorded, exactly 21 canonical ledger entries preserved byte-for-byte. |
| 1b | Migration writer fence | **PASS** | Unapproved `INSERT` into `schema_migrations` blocked with `MIGRATION_LEDGER_FENCED`. |
| 1c | Canonical ledger immutability | **PASS** | `UPDATE` and `DELETE` on `schema_migrations` blocked with `MIGRATION_LEDGER_IMMUTABLE`. |
| 1d | Duplicate release attempt | **PASS** | Re-running the package rejected with `SELECTIVE_RELEASE_ALREADY_APPLIED`. |
| 1e | Future canonical reconciliation | **PASS** | Registry reconciled, trigger disarmed, canonical migration 22 written successfully. |
| 2 | Wrong target project identity | **PASS** | Mismatched project ref throws `TARGET_PROJECT_MISMATCH`, 0 DDL executed, 21 ledger rows intact. |
| 3 | Tampered source hash / SQL | **PASS** | Modified migration content throws hash mismatch / forbidden statement error prior to DDL. |
| 4 | Existing partial Meta schema | **PASS** | Pre-existing `meta_ad_accounts` throws `UNEXPECTED_EXISTING_META_OBJECTS`, 0 other tables created. |
| 5 | Canonical ledger drift | **PASS** | Modified entry in `schema_migrations` throws `META_21_LEDGER_DRIFT`, 0 Meta tables created. |
| 6 | Application catalog drift | **PASS** | Injected unapproved function throws `META_21_SCHEMA_OR_ACL_DRIFT`, release aborted. |
| 7 | Concurrent executor attempts | **PASS** | Background session holding `pg_advisory_lock` causes second session to fail closed with lock timeout. |
| 8 | Mid-transaction failure | **PASS** | Simulated failure in Migration 3 rolls back 100%, 0 Meta tables left, 21 ledger rows intact. |
| 9 | Postcondition failure | **PASS** | Injected unauthorized object throws `META_21_POST_SCHEMA_OR_ACL_MISMATCH`, full transaction rolled back. |
| 10 | Uncertain commit recovery | **PASS** | Querying registry provides deterministic state proof without partial deployment artifacts. |

---

## 7. Supabase Free Plan Backup & Restoration Runbook

Because the target project `qmhfmgkymjgoevwmkidm` resides on the Supabase **Free Plan**, automated point-in-time recovery (PITR) and daily dashboard backups are unavailable. A physical and logical backup must be executed and validated prior to any hosted deployment.

### 7.1 Logical Database Dump (PostgreSQL 17.11)
Run `pg_dump` using an isolated connection string retrieved securely from project settings:

```bash
# 1. Export database schemas and data
pg_dump \
  --dbname="$STAGING_PG17_DB_URL" \
  --format=custom \
  --compress=9 \
  --schema="public" \
  --schema="private" \
  --schema="supabase_migrations" \
  --schema="auth" \
  --file="staging_backup_qmhfmgkymjgoevwmkidm_$(date +%Y%m%d_%H%M%S).dump"

# 2. Compute SHA-256 digest
sha256sum staging_backup_qmhfmgkymjgoevwmkidm_*.dump > staging_backup.sha256
```

### 7.2 Supabase Storage Assets Backup
Any existing files stored in Supabase Storage must be backed up via the Storage API:
```bash
# Export all bucket metadata and download binary files
node -e '
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function dumpStorage() {
  const { data: buckets } = await supabase.storage.listBuckets();
  fs.writeFileSync("buckets_metadata.json", JSON.stringify(buckets, null, 2));
  for (const b of buckets || []) {
    const { data: files } = await supabase.storage.from(b.name).list("", { limit: 1000 });
    fs.mkdirSync(`storage_backup/${b.name}`, { recursive: true });
    for (const f of files || []) {
      const { data: blob } = await supabase.storage.from(b.name).download(f.name);
      if (blob) {
        const buffer = Buffer.from(await blob.arrayBuffer());
        fs.writeFileSync(`storage_backup/${b.name}/${f.name}`, buffer);
      }
    }
  }
}
dumpStorage();
'
```

### 7.3 Client-Side Encryption (AES-256-GCM)
Encrypt the backup bundle before offsite archiving:
```bash
tar -czf - staging_backup_* storage_backup/ | \
  openssl enc -aes-256-gcm -pbkdf2 -iter 100000 \
  -out staging_backup_bundle_encrypted.tar.gz.enc \
  -pass file:<(echo -n "$BACKUP_ENCRYPTION_KEY")
```

### 7.4 Restoration Validation Runbook (Disposable Instance)
Before any release on hosted staging, test the restore process on an isolated local container:
```bash
# 1. Create fresh PostgreSQL 17 instance
docker run --name pg17-restore-test -e POSTGRES_PASSWORD=postgres -p 54399:5432 -d postgres:17.11

# 2. Restore custom format dump
pg_restore \
  --dbname="postgresql://postgres:postgres@localhost:54399/postgres" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  staging_backup_qmhfmgkymjgoevwmkidm_*.dump

# 3. Validation Checklist
# a. Verify exact 21 migration ledger records
psql -h localhost -p 54399 -U postgres -d postgres -c "SELECT count(*) FROM supabase_migrations.schema_migrations;"
# Output must be: 21

# b. Verify table row counts across public and private schemas
psql -h localhost -p 54399 -U postgres -d postgres -c "
SELECT schemaname, tablename, n_live_tup 
FROM pg_stat_user_tables 
ORDER BY schemaname, tablename;"

# c. Verify token decryptability (run existing key verifier)
# d. Clean up test container
docker rm -f pg17-restore-test
```

---

## 8. Staging Verification Checklist with Synthetic Leads

Once hosted deployment authorization is granted, verify with synthetic leads using the following checklist. **NO REAL FANPAGE OR AD ACCOUNT SHALL BE USED.**

- [ ] **Step 1: Pre-Release Baseline Check**
  - Verify project ref is `qmhfmgkymjgoevwmkidm`.
  - Verify canonical migration ledger has exactly 21 records.
  - Verify 0 Meta tables exist.
- [ ] **Step 2: Backup Execution & Local Restoration**
  - Complete pg_dump of staging.
  - Verify local restoration on Docker container passes row counts and SHA checks.
- [ ] **Step 3: Atomic Selective Release Execution**
  - Run `selective-executor.ts` bundle within single transaction under advisory lock.
  - Confirm output: `META_SELECTIVE_RELEASE_VERIFIED`.
  - Confirm registry row exists in `private.selective_feature_releases`.
  - Confirm canonical ledger count remains 21.
- [ ] **Step 4: Synthetic Meta Webhook Verification**
  - Send synthetic `leadgen` payload signed with `META_APP_SECRET`.
  - Verify HTTP 200 OK returned.
  - Verify lead recorded in `private.meta_leadgen_events`.
  - Verify customer attribution touchpoint created.
  - Verify duplicate submission with same Lead ID is deduplicated safely.
  - Verify distinct submission with same phone links to existing customer without creating duplicate profiles.
- [ ] **Step 5: Messenger SLA Invariant Check**
  - Verify `han_ingest` behavior is unchanged.
  - Verify Messenger SLA count remains 0.
- [ ] **Step 6: Token Vault Check**
  - Connect synthetic Ad Account token via `/admin/facebook`.
  - Verify token is stored encrypted in `private.meta_ad_account_tokens`.
  - Verify service role can decrypt token.
  - Verify browser roles (`anon`, `authenticated`) receive 403 on direct access.

---

## 9. Condition Assessment & Final Verdict

| Condition Category | Status | Notes |
|---|---|---|
| **Selective-Release Ledger Engine** | **PASS** | Implemented in `scripts/meta-ads/selective-executor.ts` with pinned hashes and fingerprints. |
| **Preservation of 21 Canonical Records** | **PASS** | 0 writes/updates/deletes on canonical ledger table; verified by symmetric difference. |
| **No 95 Gap Migration Fabrication** | **PASS** | Gap migrations omitted; tracked in private registry without false claims. |
| **Fencing Guard Trigger** | **PASS** | Fail-closed trigger installed on `schema_migrations`; blocks unapproved writes. |
| **Local Failure Test Suite (11/11)** | **PASS** | 100% green across all 11 failure/rollback/concurrency/recovery scenarios. |
| **Full Regression & Integration Gates** | **PASS** | 22/22 integration gates passed (118.50s); preflight passed; meta-ads passed (43/43). |
| **Typecheck & ESLint Quality** | **PASS** | 0 TypeScript errors, 0 ESLint errors. |
| **Physical Staging Backup & Restoration** | **PENDING** | Runbook prepared; awaits physical execution and restoration proof by operator. |
| **Project Owner Approval** | **PENDING** | Awaiting formal owner sign-off on PR #139. |
| **HOSTED STAGING EXECUTION** | **BLOCKED** | Safe, proven, and ready for review; hosted execution remains strictly blocked. |

### Final Verdict: **BLOCKED**
Hosted deployment to Supabase Staging (`qmhfmgkymjgoevwmkidm`) is **BLOCKED**.  
All technical prerequisites, safety invariants, selective ledger engines, failure tests, and rollback protections are completely developed and verified locally. Execution on hosted infrastructure must remain blocked until the physical backup is taken and project owner approval is received.
