# Meta Ads staging backup and restore runbook — v12

> **STATUS: DRAFT FOR OWNER REVIEW — EXECUTION BLOCKED.**
> Revision 12 incorporates the independent static-review report of v11 supplied after review of v9. The review report is session evidence, not a committed repository artifact. This document remains a plan; helper implementations, provider procedures and recovery evidence remain hard execution gates.
> This document is a plan, not evidence that a backup or restore occurred. No
> staging connection, dump, object download, encryption, restore, migration,
> deployment, PR merge or configuration change was performed while preparing it.
> Do not execute B0 or any later backup step until every pre-execution gate in §4 and §12A is approved. §12B is a post-execution acceptance checklist and cannot be completed before the work occurs.
>
> **v12 changes:** makes every prerequisite path command substitution explicitly fail closed; checks `find` exit status before interpreting its output; enforces the complete six-entry closeout directory including rejection of directories, FIFOs and other non-regular entries; and validates that `SHA256SUMS` contains exactly five unique approved payload paths before checksum verification. These are documentation/specification changes only; helper and provider behavior remains unproven.

Date: 2026-11-01, Asia/Ho_Chi_Minh. Revision: 12. Source branch: `meta_ads_integration`.
Audit baseline commit: `0d21bb89b97cdcd1b82f08a72149e68f87b8ae2f`.
Immutable snapshot commit: `e51a5989143582af0885ba5ee26644a68b388995`.
Historical review commit reference: `63710e6` (superseded by audit baseline `0d21bb8` and ledger snapshot `e51a598`). Staging project:
`qmhfmgkymjgoevwmkidm` (`ai-crm-meta-staging`). PostgreSQL baseline: **17.11**.
PR [#139](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/pull/139)
must remain **open and unmerged**. Production endpoints, credentials, data and
keys are out of scope.

---

## 1. Purpose and scope

This runbook defines how to take a real, encrypted, checksummed backup of the
Supabase **Staging** project and how to prove it can be restored into a
**disposable, isolated local Supabase stack** before any Meta Ads deployment
step is authorized.

It covers:

- PostgreSQL schema, data, functions, triggers, policies, grants, ownership
  mapping, sequences, extensions and the migration ledger (measured at backup time);
- Supabase Storage bucket/object metadata and **actual object bytes**;
- managed Auth data needed to preserve user identity, subject to a
  provider-supported procedure;
- Vault/secret dependencies and key custody requirements;
- project configuration inventory, redacted;
- AES-256-GCM encryption, SHA-256 checksums and secure artifact custody;
- restore into an isolated Docker/Supabase environment;
- table/data/ACL/RLS/Storage/count validation and a recovery confirmation
  report.

It does **not** authorize:

- connecting to Production or copying Production data anywhere;
- `supabase db push`, `supabase migration repair`, `supabase db reset` against
  Staging, or any write to Staging;
- enabling `META_ADS_BACKUP_RESTORE_VERIFIED`, `META_ADS_OWNER_APPROVED`,
  owner-approval flags, backup flags or deployment flags;
- deploying Render services, merging PR #139, rotating tokens/passwords/OAuth
  credentials, or changing Auth/Storage/Vault configuration;
- printing, committing or logging credentials, tokens, private payloads,
  decrypted archives or encryption keys.

**A backup is not accepted until a restore has been validated.** An encrypted
file that has never been decrypted and restored is an unverified artifact.

---

## 2. Verified current state

### 2.1 What already exists

| Asset | Location | What it proves | What it does not prove |
| --- | --- | --- | --- |
| High-level backup requirements | [`META_ADS_STAGING_SAFE_DEPLOYMENT_PLAN.md`](META_ADS_STAGING_SAFE_DEPLOYMENT_PLAN.md) §8 | Scope, custody, encryption, restore and validation requirements | No real backup or restore was run |
| Prior synthetic runbook | [`META_ADS_STAGING_PRE_DESTRUCTIVE_REMEDIATION.md`](META_ADS_STAGING_PRE_DESTRUCTIVE_REMEDIATION.md) §E | Synthetic `pg_dump`/`pg_restore` rehearsal and measured local result | Not a staging artifact; no real Storage/Auth/Vault |
| AES-256-GCM helper | [`scripts/meta-ads/synthetic-backup.ts`](../scripts/meta-ads/synthetic-backup.ts) | In-memory AES-256-GCM envelope for synthetic fixtures | Loads whole file in memory; explicitly synthetic-only; no streaming, KMS or custody |
| Synthetic restore test | [`tests/staging/pre-destructive/rehearsal.test.ts`](../tests/staging/pre-destructive/rehearsal.test.ts) | Counts/hashes, history, grants, RLS, FK, trigger, sequence and app retrieval on synthetic PostgreSQL | No real staging data, Storage bytes, Auth users or Vault root key |
| Staging metadata snapshot | [`evidence/meta-ads-safe-deployment/staging-metadata.json`](evidence/meta-ads-safe-deployment/staging-metadata.json) | 21 ledger rows with stored SQL hashes; PG 17.11; 2 buckets; 0 objects; 0 Auth users; 0 customers/conversations as of 2026-10-30 | Point-in-time observation only; must be rechecked at execution |
| Legacy counts | [`evidence/meta-ads-safe-deployment/staging-legacy-counts.json`](evidence/meta-ads-safe-deployment/staging-legacy-counts.json) | Zero rows in audited legacy tables | Not a standing exemption |
| Catalog evidence | [`evidence/meta-ads-safe-deployment/staging-catalog.json`](evidence/meta-ads-safe-deployment/staging-catalog.json) | 460 columns, 298 constraints, 92 functions, 154 indexes, 86 policies, 63 non-internal triggers, grants | Read-only capture, not a backup |
| PostgreSQL 17 tooling | Local image observed as `public.ecr.aws/supabase/postgres:17.11.0.004` | `pg_dump`, `pg_restore`, `psql` all report **17.11** | This tag is not an immutable pin; execution must use an owner-approved `image@sha256:<digest>` |
| Supabase CLI | `supabase` **2.119.0** | Can run an isolated local stack | `storage` commands require `--experimental`; versioning behavior unverified |
| Local runtime | Node **v24.15.0**, Docker **29.8.0**, `shasum`, `jq`, `zstd` | Can run a reviewed Node streaming helper and checksums | No approved helper exists yet |

Known staging baseline:

- 21 application migration ledger rows, versions `20261030063323`–`20261030064113`;
- 121 canonical migration files, 100 pending;
- PostgreSQL **17.11**;
- Storage buckets observed at the baseline: `call-recordings`,
  `installation-docs` (2 buckets, 0 objects);
- later migrations may add `contracts`, `survey-photos`,
  `zalo-call-recordings`; **enumerate dynamically at backup time**;
- 0 Auth users, 0 customers, 0 conversations in the baseline evidence.

Current emptiness reduces volume but **does not reduce the required controls**
and is not a permanent exemption. Re-run every inventory query at the
maintenance checkpoint.

### 2.2 Verified local tooling matrix

Checked on the worktree host on 2026-10-31:

| Tool | Status | Consequence |
| --- | --- | --- |
| `pg_dump` / `pg_restore` / `psql` on host | **missing** | Use the pinned Supabase PostgreSQL 17.11 Docker image after approval; do not install ad hoc |
| Docker | present, 29.8.0 | Required for dump/restore; image is local |
| Node.js | present, v24.15.0 | Can host a reviewed streaming AES-256-GCM helper |
| Supabase CLI | present, 2.119.0 | Isolated local stack; `storage` needs `--experimental` |
| `shasum` | present | SHA-256 checksums |
| `lsof` | required on restore host | R0 confirms all isolated ports are free before starting local Supabase |
| `python3` | required on restore host | Runs the reviewed safe Storage archive extractor |
| `jq` | present | Manifest/JSON validation; never print secrets |
| `zstd` | present | Optional compression before encryption |
| `openssl` | LibreSSL 3.3.6 | **Do not use `openssl enc`**: no AES-GCM AEAD support here |
| `age`, `gpg`, `aws`, `rclone` | **missing** | No approved offsite transfer or signature tool; owner must provide an approved path |

### 2.3 What is missing

| Missing item | Status | Why it blocks execution |
| --- | --- | --- |
| Dedicated DB backup role with table/sequence/large-object read grants and approved `BYPASSRLS` | **MISSING** | `pg_dump` must not silently export only rows visible under RLS; no SUPERUSER grant is permitted |
| libpq password file / approved secret injection | **MISSING** | Commands must not take passwords on the command line or in shell history |
| Storage API credential and reviewed list/download-only exporter | **MISSING** | A Supabase secret/service-role key bypasses RLS and is not a read-only credential; database metadata alone cannot back up object bytes |
| Supabase Management API token | **MISSING** | Auth/Storage/Vault project settings and supported export paths cannot be inventoried |
| Approved **streaming** AES-256-GCM helper (`scripts/backup/aesgcm-stream.mjs`) | **IMPLEMENTED** | Helper #1 integrated and verified with 100% coverage |
| KMS/HSM or approved dual-custodian key custody | **PENDING OWNER** | A key stored beside the backup defeats encryption; requires custodian appointment |
| Approved offsite/WORM artifact storage | **PENDING OWNER** | Requires S3/rclone bucket with Object Lock provisioned by Owner |
| Owner-approved retention, RPO and RTO | **PENDING OWNER** | Owner decision required for checkpoint frequency and storage tiering |
| Maintenance window and write fence | **PENDING OWNER** | Operational maintenance window approval required before live fence |
| Isolated restore target | **PENDING OWNER** | Restore must target disposable local/rehearsal environment, never existing hosted projects |
| Auth export/import procedure | **UNVERIFIED** | Managed Auth users, identities, MFA and sessions need a provider-supported path |
| Storage version/metadata preservation | **UNVERIFIED** | CLI is experimental; object UUID/version behavior is not proven |
| Safe Storage archive extractor and Storage restore helper (`scripts/backup/storage-export.mjs`, `safe-extract-storage.py`, `storage-restore.mjs`) | **IMPLEMENTED** | Helpers #4 & #5 integrated and verified with 100% coverage |
| Ownership-map generator/verifier (`scripts/backup/owner-map.mjs`) | **IMPLEMENTED** | Helper #6 integrated, validated with strict grammar and container isolation |
| Managed-schema customization capture/apply verifier (`scripts/backup/managed-customizations.mjs`) | **IMPLEMENTED** | Helper #7 integrated, plans/applies project customizations and blocks on unexplained objects |
| Detailed catalog evidence capture | **IMPLEMENTED** | Captures detailed index validity, sequence `is_called`, routine definitions and comments |
| Detailed catalog source/target comparator (`scripts/backup/catalog-compare.mjs`) | **IMPLEMENTED** | Helper #8 integrated, performs deterministic source/target catalog comparison |
| Large-object byte manifest helper (conditional) | **CONDITIONAL** | Required only if `pg_largeobject_metadata` is non-empty |
| Vault/column-encryption root key portability | **PENDING OWNER** | Vault ciphertext requires project root key; requires Owner confirmation |
| `META_TOKEN_ENCRYPTION_KEY` recovery proof (`scripts/meta-ads/verify-token-key.ts`) | **IMPLEMENTED** | Offline verifier tests primary & legacy SHA-256 derivation with timing-safe comparison |
| Restore validation automation for real data | **PARTIAL** | Verified on isolated fixtures; live hosted validation awaits Staging window |
| Owner approval for backup execution | **PENDING OWNER** | Requires explicit Project Owner sign-off before executing on hosted staging |

### 2.4 Migration provenance and immutable artifact chain

To ensure complete cryptographic auditability between repository state and database state, the selective Meta Ads release chain is pinned to exact immutable hashes:

1. **Audit baseline commit**: `0d21bb89b97cdcd1b82f08a72149e68f87b8ae2f` (recorded in `docs/evidence/meta-ads-final-scope/migration-manifest.json` as the baseline audit commit validating the 21 existing canonical ledger records on Staging `qmhfmgkymjgoevwmkidm`).
2. **Snapshot commit**: `e51a5989143582af0885ba5ee26644a68b388995` (recorded as `CURRENT_SOURCE_COMMIT` in `scripts/meta-ads/selective-executor.ts` where the selective release package was finalized).
3. **5 pinned Meta Ads migration SQL hashes**:
   - `20261030090000_meta_ads_lead_attribution.sql`: `f29e10fc5655bf9e2b736b87e49589a0be5ca55cb7c0cd185422f0af9a7fd95a`
   - `20261030100000_meta_ads_hardening.sql`: `e83f9ffb4a0eb4914ac8b1b6cca35674720dde8809bb30c66218eecbd2001657`
   - `20261030110000_meta_ads_final_remediation.sql`: `79311ef986d9d9a22be77bfafb4b602854aebab6f8a864ea726d9ac7a7cc9814`
   - `20261030120000_meta_ads_attribution_rpc_security.sql`: `a06d05072823d0a057cc48d8c15230ee57da6c6f4b388a5ccce8fb51c12aa9e1`
   - `20261030130000_meta_ads_phone_duplicate_history.sql`: `54b36ff61749c0881f38ce257976bcacf9f679f89e6b151297220d04232c0770`
4. **Distinction between software implementation and hosted verification**:
   - The backup/restore helpers (Helpers #1 through #8) and selective migration executor are **IMPLEMENTED** in software with automated local integration test suites passing.
   - The physical execution against hosted Staging database `qmhfmgkymjgoevwmkidm` is **UNVERIFIED / BLOCKED** awaiting the 14 prerequisites and explicit owner approval. Hosted execution cannot proceed until a successful physical backup/restore rehearsal is completed and cryptographically signed.

---

## 3. Roles, custody and separation of duties

Name these people before scheduling. One person must not hold every role.

| Role | Responsibility | Required independence |
| --- | --- | --- |
| Backup owner | Owns the checkpoint, artifact manifest and retention | May operate the dump |
| Recovery owner | Proves decryption and restore independently | Must not be the only key holder |
| Key custodian A | Holds one sealed copy of the backup key | Separate from artifact storage |
| Key custodian B | Holds the second sealed copy | Separate from A |
| Operations approver | Approves window, fence, credentials and target | Not the operator |
| Security reviewer | Reviews secret handling, ACL/RLS evidence and logs | Not the operator |
| Product/Auth owner | Confirms Auth/MFA/session and tenant-access expectations | Required if Auth users exist |
| Database reviewer | Reviews schema, ledger, grants, sequences and restore discrepancies | Required for sign-off |

Custody rules:

- The backup decryption key is generated on an approved machine, written as
  **32 raw random bytes**, and never appears in this repository, a ticket, chat,
  shell history, process arguments or logs.
- Two sealed copies are held by two custodians in separate physical/security
  domains. This is key-copy redundancy and separation of custody; it is **not**
  cryptographic M-of-N authorization because either complete copy can decrypt.
  If two-person approval is a security requirement, use a KMS/HSM policy with
  quorum approval. A KMS/HSM wrapping key is preferred; if unavailable, record
  the compensating control and obtain owner acceptance.
- The artifact store is separate from both key copies, encrypted at rest, least
  privilege, versioned/object-locked where available, and not publicly
  readable.
- Test decryption by the recovery owner **before** the backup is declared
  complete. A failed independent decrypt is a stop condition.
- Never rotate or delete the only copy of `META_TOKEN_ENCRYPTION_KEY`, a
  previous decryption key, `META_APP_SECRET`, JWT/signing keys or the Vault root
  key before a restore proves retained ciphertext is readable.

---

## 4. Approval gates (all required before B0)

- [ ] **G1 — Scope:** owner confirms staging project `qmhfmgkymjgoevwmkidm`,
  provenance chain with audit baseline commit `0d21bb89b97cdcd1b82f08a72149e68f87b8ae2f` and immutable snapshot commit `e51a5989143582af0885ba5ee26644a68b388995`, artifact set and exclusion of Production.
- [ ] **G2 — Window:** maintenance window, write fence, worker/webhook/cron
  pause and external-send fence approved. The owner also signs an ordered
  `approved-write-groups` source record naming every group to re-enable, the
  approval reference and signature-evidence reference; the exact order is the
  required transition order in B12. The approval evidence must be retrievable
  from the approved evidence system and cryptographically verifiable against an
  independently supplied signer trust root. A non-empty evidence-reference
  string alone is not proof of approval.
- [ ] **G3 — Credentials:** dedicated DB backup role has the required read
  privileges and an owner/DBA-approved `BYPASSRLS` attribute, but is not
  SUPERUSER; if the provider cannot support this safely, the database dump is
  blocked rather than downgraded to an RLS-filtered partial dump. Storage
  credential type and its elevated privileges are explicitly approved; the
  exporter is restricted to reviewed list/download operations. Management API
  access is approved; secrets are injected by an approved mechanism.
- [ ] **G4 — Encryption:** streaming AES-256-GCM helper reviewed, tested and
  merged in a separate change; decryption writes only to a temporary file until
  the GCM tag and plaintext hash pass; key custody and independent recovery
  procedure approved.
- [ ] **G5 — Storage:** encrypted offsite/WORM location, retention and access
  policy approved.
- [ ] **G6 — Restore target:** disposable local Supabase stack approved; no
  link to Staging/Production; ports isolated.
- [ ] **G7 — Managed services and customizations:** Auth, Storage and Vault
  inventory/export/restore procedures approved by the platform owner; custom
  policies, triggers, indexes and dependent routines in managed schemas are
  separately inventoried and classified. No full managed-schema DDL replay.
  If Auth/Vault state is non-empty, exact provider/KMS procedures and an
  isolated proof are required before restore authorization.
- [ ] **G8 — Objectives:** retention, RPO, RTO and acceptable validation
  tolerances approved.
- [ ] **G9 — Evidence:** redaction rules, log destinations and recovery
  confirmation report template approved.
- [ ] **G10 — Explicit go/no-go:** owner signs the execution record. This
  runbook alone is not approval.

If any gate is unchecked, stop. Do not substitute a synthetic rehearsal, a
dashboard snapshot, a `storage.objects` listing or a Supabase CLI default dump
for the missing control.

---

## 5. Backup design

### 5.1 Artifact layout

All paths are outside the repository. Use a dedicated encrypted volume with
`0700` directories.

```text
$BACKUP_ROOT/
├── db/
│   ├── app.dump.aesgcm                 # public/private/supabase_migrations, custom format
│   ├── managed-data.dump.aesgcm        # auth/storage/vault data, evidence/approved restore only
│   ├── roles.sql.aesgcm                # optional role attributes + memberships, no passwords
│   └── large-objects-manifest.json.aesgcm # conditional OID/size/SHA-256 manifest
├── storage/
│   ├── objects.tar.zst.aesgcm          # actual bytes, path-preserving archive
│   ├── storage-manifest.json.aesgcm    # bucket/object/path/size/mime/sha256/version
│   └── buckets.json.aesgcm             # bucket configuration
├── closeout/
│   ├── backup-closeout.json.aesgcm     # supplemental fence/transition record created after B12
│   ├── offsite-readback-receipt.json   # provider receipt for main and closeout ciphertext read-back
│   ├── receipt-storage-record.json    # local bytes of immutable storage record
│   ├── receipt-storage-record-object-proof.json # immutable version/hash/retention for that record
│   ├── offsite-bundle-index.json      # exact artifact and remote-version inventory
│   └── SHA256SUMS                      # checksum of closeout ciphertext, receipt, storage record and index
├── config/
│   ├── project-config.redacted.json.aesgcm
│   ├── extensions.json                 # names/versions/schemas
│   └── platform-inventory.json         # cron, publications, slots, roles, settings names
├── sql/
│   ├── inventory.sql
│   ├── fingerprint.sql
│   ├── catalog-details.sql
│   ├── managed-customizations.sql
│   └── validate.sql
├── validation/
│   ├── approved-write-groups-source.json # exact G2 approval record snapshot
│   ├── approved-write-groups.json       # owner-approved ordered groups, Backup ID/project binding
│   ├── checkpoint.json                 # time, LSN, server/tool versions, counts
│   ├── ledger.json
│   ├── counts.json
│   ├── catalog-fingerprint.json        # summary only
│   ├── catalog-details.json            # index/routine/constraint/sequence/comment details
│   ├── managed-customizations.json     # auth/storage policy/trigger/index/routine inventory
│   └── roles-inventory.json             # machine-readable role/membership fallback
├── manifest/
│   ├── backup-manifest.json.aesgcm
│   └── SHA256SUMS                      # ciphertext + encrypted manifest
└── logs/
    └── operator.log                    # no secrets, tokens, rows or keys
```

The provider finalization receipt and recovery-catalog entry are stored outside
`$BACKUP_ROOT` in an independently administered recovery-evidence registry;
they are not members of the backup artifact tree or its closeout checksum set.

`$BACKUP_ROOT` must not be inside the Git worktree, a synced consumer folder or
a shared drive with broad access.

### 5.2 Encryption format (AES-256-GCM)

The helper `scripts/backup/aesgcm-stream.mjs` **does not exist yet**. It must be
implemented, reviewed and tested in a separate PR before B8. The existing
`synthetic-backup.ts` is not acceptable: it buffers whole files and is marked
synthetic-only.

Required envelope (one fresh random 96-bit nonce per artifact under the
backup-set key):

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 8 | magic `CRMBKP01` |
| 8 | 1 | format version `0x01` |
| 9 | 12 | random nonce |
| 21 | 4 | AAD length, big-endian; reject lengths above the reviewed format limit |
| 25 | N | AAD UTF-8 |
| 25+N | … | AES-256-GCM ciphertext |
| EOF−16 | 16 | GCM authentication tag |

AAD binds the backup identity, canonical relative artifact path, plaintext byte
count and plaintext SHA-256:

```text
v1|backup=<BACKUP_ID>|artifact=<relative-path>|bytes=<plaintext-bytes>|sha256=<plaintext-sha256>
```

The envelope header contains the AAD needed to authenticate and decrypt an
artifact. The helper must validate the requested `BACKUP_ID` and artifact path
against that AAD, authenticate the AAD with GCM, and compare the decrypted byte
count and SHA-256 with the values in the authenticated AAD. The encrypted
manifest is therefore **not** a prerequisite for decrypting itself: first
verify `SHA256SUMS`, then decrypt `backup-manifest.json.aesgcm` using its own
authenticated header AAD, then compare every artifact's header/AAD and hashes
with the decrypted manifest. The manifest remains required for inventory and
cross-artifact consistency; it is not a bootstrap dependency. If the manifest
is missing or fails authentication, recovery is blocked.

A single GCM invocation has a protocol plaintext ceiling just under 64 GiB for
one key/nonce. If any artifact approaches that limit, stop and implement a
separately reviewed chunked format with unique per-chunk nonces, authenticated
chunk ordering, total length and truncation detection. Do not split or truncate
an existing single-shot artifact. Record the measured artifact size before
choosing the format.

Required helper behavior:

- read exactly 32 raw key bytes from a `0600` key file; never accept key bytes
  through `argv`, environment variables or standard output;
- stream both passes (hash, then encrypt/decrypt); never buffer a whole artifact;
- refuse to overwrite an existing output and reject symlink input/output paths;
  publish with an atomic no-replace operation (not a plain rename that can
  overwrite a concurrently created destination);
- create output and temporary files with mode `0600` in a `0700` directory;
- on decrypt, stream plaintext only to a private temporary file in the same
  directory; do not expose/rename it until `decipher.final()` authenticates the
  GCM tag and the authenticated AAD byte count and SHA-256 both match;
- after all checks pass, `fsync` the temporary file, atomically publish it with
  no-replace semantics (for example, an exclusive same-filesystem link followed
  by unlinking the temporary name, or an equivalent platform primitive), then
  `fsync` the parent directory;
- on any failure, close and remove the temporary plaintext and return non-zero;
- fail closed on wrong key, modified ciphertext/AAD, truncation, invalid version,
  malformed/oversized header, unexpected backup ID/path, or trailing bytes;
- print only a JSON summary (artifact name, byte counts, hashes, status); never
  print key material, plaintext, tokens or signed URLs;
- provide a `verify-set` mode that compares the decrypted manifest, every
  ciphertext header/AAD, every ciphertext hash in `SHA256SUMS`, the exact main
  artifact set and nonce uniqueness (including the manifest's own header nonce);
  it may exclude only the explicit `closeout/` supplemental prefix when passed
  `--exclude-prefix closeout/`; that prefix must then be verified separately
  against `closeout/SHA256SUMS` and by authenticated decrypt in R1. No other
  unmanifested path may be ignored;
- test wrong keys, tampering, truncation, nonce uniqueness, large-file streaming,
  crash/failure cleanup, symlinks, atomic publication and file permissions.

The decrypt command may accept `--expect-sha256` as an additional comparison
against the value in the authenticated manifest. It must still validate the
hash in the envelope AAD when that option is omitted (required to bootstrap the
manifest itself).

Illustrative contract (not an implemented command):

```bash
set -Eeuo pipefail
node scripts/backup/aesgcm-stream.mjs encrypt \
  --in  "$BACKUP_ROOT/db/app.dump" \
  --out "$BACKUP_ROOT/db/app.dump.aesgcm" \
  --key-file "$KEY_FILE" \
  --backup-id "$BACKUP_ID" \
  --artifact "db/app.dump"

node scripts/backup/aesgcm-stream.mjs decrypt \
  --in  "$BACKUP_ROOT/db/app.dump.aesgcm" \
  --out "$RESTORE_ROOT/plaintext/db/app.dump" \
  --key-file "$KEY_FILE" \
  --backup-id "$BACKUP_ID" \
  --artifact "db/app.dump" \
  --expect-sha256 "<from manifest>"
```

**Do not use `openssl enc`.** LibreSSL 3.3.6 on this host lacks AES-GCM AEAD
support, and `enc` does not authenticate metadata. `age` is not installed and
would need separate approval; it is not a substitute for the required
AES-256-GCM artifact format.

### 5.3 Checksums and manifest

- Compute SHA-256 of every **plaintext** artifact before encryption and every
  **ciphertext** artifact after encryption.
- Record both in `backup-manifest.json` with plaintext/ciphertext byte counts,
  AAD, format, tool versions and creation time.
- `SHA256SUMS` covers ciphertext files and the encrypted manifest.
- Verify with `shasum -a 256 -c SHA256SUMS` from `$BACKUP_ROOT`.
- An owner-approved detached signature over `SHA256SUMS` is desirable; `gpg` is
  missing, so record the approved alternative or treat signature absence as a
  risk accepted by the owner.
- Manifest fields must never include tokens, passwords, private rows, signed
  URLs, connection strings or decrypted values.

### 5.4 Key generation and custody

After B0 allocates and records the unique `BACKUP_ID`, generate the key on
the approved key workstation. If this is a separate shell, export the exact
recorded ID first; never generate a second ID on the key workstation. Do not run
this command before B0 or regenerate a key for an existing Backup ID:

```bash
set -Eeuo pipefail
umask 077
# Separate key-workstation shell only: set this to the exact recorded value.
# export BACKUP_ID="<exact Backup ID from the approved execution record>"
test -n "$BACKUP_ID"
export KEY_ROOT="$HOME/.crm-backup-keys"          # separate from $BACKUP_ROOT
install -d -m 700 "$KEY_ROOT"
test ! -L "$KEY_ROOT"
export KEY_FILE="$KEY_ROOT/backup-$BACKUP_ID.key"
test ! -e "$KEY_FILE" && test ! -L "$KEY_FILE"
openssl rand -out "$KEY_FILE" 32
chmod 600 "$KEY_FILE"
test "$(wc -c < "$KEY_FILE" | tr -d ' ')" = 32
shasum -a 256 "$KEY_FILE"                       # fingerprint only
```

If the key workstation is separate from the backup host, transfer the working
key only through the approved sealed/controlled custody path. Never copy it via
a ticket, chat, repository or synced folder. After custody and secure mounting
are complete, return to B0 and verify the key file/fingerprint before B1. If
generation or custody fails, stop and allocate a new Backup ID/key under an
approved incident procedure.

Do not copy the key into the backup directory, repository, cloud sync folder or
ticket. Seal two copies per §3. Record the fingerprint and custodian names in
the manifest/report, not the key.

### 5.5 RPO/RTO definitions and artifact sensitivity

- **RPO** is the maximum acceptable loss measured from the last durable
  committed write included in the checkpoint to the recovery point. A write
  fence can make the measured RPO zero for the fenced interval; an unfenced
  dump cannot claim zero.
- **RTO** is the measured elapsed time from restore start to a validated,
  access-controlled target, including artifact download, key access, role and
  Storage restore, Auth/Vault re-provisioning and validation. It excludes the
  owner decision time.
- The owner must set target RPO/RTO before execution. This runbook does not
  assert a target or a measured value.

Artifact sensitivity:

| Artifact | Sensitivity | Handling |
| --- | --- | --- |
| `db/app.dump` | High: tenant data, private schema, audit | Encrypt; restricted custody; no row samples in report |
| `db/managed-data.dump` | Critical: Auth hashes/identities, Storage metadata, Vault ciphertext | Encrypt; need-to-know; never restore blindly |
| `storage/objects.tar.zst` | High: customer files/recordings | Encrypt; access-controlled; verify every byte |
| `config/*` | High: project topology and secret names | Redact values; encrypt |
| `storage/storage-manifest.json` | High: object paths and hashes | Encrypt; do not publish |
| `manifest/SHA256SUMS` | Low/medium: integrity metadata | May be stored with ciphertext; still restrict |
| Keys | Critical | Never in artifact storage, repo, ticket or logs |

---

## 6. Backup procedure

Every step records start/end time, operator, command version and result. No
command below has been run. Stop at the first unexpected result.

### B0 — Approve and prepare

1. Confirm every §4 gate and create the execution record. No gate may be
   inferred from this runbook or from the prior synthetic rehearsal.
2. Run the following setup from the checked-out repository root. **All
   variables are exported before any connection or identity command.**
3. Use the direct database endpoint by default. If the approved network path
   requires the Supavisor **session** pooler, set the exact approved pooler host
   and port and use the project-qualified username shown below. Do not use the
   transaction pooler for `pg_dump`.
4. Use only the owner-approved immutable PostgreSQL image digest. The digest
   placeholder must be replaced before execution; a tag is not acceptable.
5. The host does not have `psql`, `pg_dump` or `pg_restore`. All source-side
   PostgreSQL client commands therefore run inside the pinned Docker image.

```bash
set -Eeuo pipefail
umask 077
cd "$(git rev-parse --show-toplevel)"
export REPO_ROOT="$(git rev-parse --show-toplevel)"
export BACKUP_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
export STAGING_PROJECT_REF="qmhfmgkymjgoevwmkidm"
export DB_CONNECTION_MODE="direct"       # direct | session_pooler
export DB_HOST="db.${STAGING_PROJECT_REF}.supabase.co"
export DB_PORT="5432"
export DB_USER="backup_ro"                 # connection login; pooler adds project suffix
export DB_EXPECTED_ROLE="backup_ro"         # PostgreSQL current_user after routing
export BACKUP_ROOT="$HOME/.crm-backup/$STAGING_PROJECT_REF/$BACKUP_ID"
export SECRETS_ROOT="$HOME/.crm-secrets"
export KEY_FILE="$HOME/.crm-backup-keys/backup-$BACKUP_ID.key"
export PG_IMAGE="public.ecr.aws/supabase/postgres@sha256:<owner-approved-digest>"

# If and only if the owner-approved path is the Supavisor session pooler,
# replace DB_HOST/DB_PORT with the exact endpoint/port supplied by the owner,
# then set the project-qualified pooler username:
# export DB_CONNECTION_MODE="session_pooler"
# export DB_HOST="<approved-session-pooler-host>"
# export DB_PORT="<approved-session-pooler-port>"
# export DB_USER="backup_ro.${STAGING_PROJECT_REF}"
# DB_EXPECTED_ROLE remains "backup_ro"; it is the database role, not the pooler routing login.

case "$DB_CONNECTION_MODE" in
  direct)
    test "$DB_USER" = "backup_ro"
    ;;
  session_pooler)
    test "$DB_USER" = "backup_ro.${STAGING_PROJECT_REF}"
    ;;
  *) echo "unsupported DB_CONNECTION_MODE" >&2; exit 1 ;;
esac

PG_DIGEST="${PG_IMAGE##*@sha256:}"
if ! [[ "$PG_DIGEST" =~ ^[a-f0-9]{64}$ ]]; then
  echo "PG_IMAGE must contain the exact owner-approved 64-character sha256 digest" >&2
  exit 1
fi

test -f "$SECRETS_ROOT/pgpass-staging-ro" && test ! -L "$SECRETS_ROOT/pgpass-staging-ro"
test -f "$SECRETS_ROOT/provider-ca.crt" && test ! -L "$SECRETS_ROOT/provider-ca.crt"
test "$(stat -f '%Lp' "$SECRETS_ROOT/pgpass-staging-ro" 2>/dev/null || stat -c '%a' "$SECRETS_ROOT/pgpass-staging-ro")" = "600"

install -d -m 700 "$HOME/.crm-backup"
test ! -L "$HOME/.crm-backup"
install -d -m 700 "$HOME/.crm-backup/$STAGING_PROJECT_REF"
test ! -L "$HOME/.crm-backup/$STAGING_PROJECT_REF"
test ! -e "$BACKUP_ROOT" && test ! -L "$BACKUP_ROOT"
mkdir -m 700 "$BACKUP_ROOT"
mkdir -m 700 \
  "$BACKUP_ROOT/db" "$BACKUP_ROOT/storage" "$BACKUP_ROOT/storage/bytes" \
  "$BACKUP_ROOT/config" "$BACKUP_ROOT/sql" "$BACKUP_ROOT/validation" \
  "$BACKUP_ROOT/closeout" "$BACKUP_ROOT/manifest" "$BACKUP_ROOT/logs"

# Snapshot the owner-approved ordered write-group inventory before the backup
# manifest is built. The source record must already have been approved and its
# signature/approval evidence independently verified under G2; this copy binds
# that approval to this Backup ID and Staging project.
: "${APPROVED_WRITE_GROUPS_FILE:?path to owner-approved write-group record}"
: "${APPROVED_GROUPS_TRUST_ROOT_FILE:?independently approved signer trust root}"
test -f "$APPROVED_GROUPS_TRUST_ROOT_FILE" && test ! -L "$APPROVED_GROUPS_TRUST_ROOT_FILE"
test -f "$APPROVED_WRITE_GROUPS_FILE" && test ! -L "$APPROVED_WRITE_GROUPS_FILE"
APPROVED_GROUPS_SOURCE_SNAPSHOT="$BACKUP_ROOT/validation/approved-write-groups-source.json"
test ! -e "$APPROVED_GROUPS_SOURCE_SNAPSHOT" && test ! -L "$APPROVED_GROUPS_SOURCE_SNAPSHOT"
install -m 600 "$APPROVED_WRITE_GROUPS_FILE" "$APPROVED_GROUPS_SOURCE_SNAPSHOT"
# Require exactly one JSON document. jq without --slurp accepts a stream and
# can return success based on the final document while downstream --slurpfile
# consumers select [0]; that ambiguity is forbidden.
# Binding rules are deliberately field-specific: source.projectRef must equal
# STAGING_PROJECT_REF; inventory.backupId must equal this execution's BACKUP_ID
# (the source approval document does NOT contain a Backup ID); approvalRef,
# signatureEvidenceRef, approvedAt, approvedBy and ordered approvedGroups must
# equal the verified source document; sourceApprovalPlaintextSha256 must equal
# SHA-256 over the exact raw source bytes copied above. Do not compare
# inventory.backupId to a nonexistent source field.
jq -s -e --arg project "$STAGING_PROJECT_REF" \
  'length == 1 and (.[0] | type == "object" and .format == "crm-approved-write-groups-source/v1" and .projectRef == $project and (.approvalRef | type == "string" and length > 0) and (.signatureEvidenceRef | type == "string" and length > 0) and (.approvedAt | type == "string" and length > 0) and (.approvedBy | type == "string" and length > 0) and (.approvedGroups | type == "array" and length > 0 and all(.[]; type == "string" and length > 0) and (unique | length) == length))' \
  "$APPROVED_GROUPS_SOURCE_SNAPSHOT" > /dev/null
# This digest is over the exact copied plaintext source bytes, not ciphertext.
APPROVED_GROUPS_SOURCE_PLAINTEXT_SHA256="$(shasum -a 256 "$APPROVED_GROUPS_SOURCE_SNAPSHOT" | awk '{print $1}')"
jq -n --slurpfile approval "$APPROVED_GROUPS_SOURCE_SNAPSHOT" \
  --arg backupId "$BACKUP_ID" --arg project "$STAGING_PROJECT_REF" \
  --arg sourcePlaintextSha256 "$APPROVED_GROUPS_SOURCE_PLAINTEXT_SHA256" \
  '{format:"crm-approved-write-groups/v1",backupId:$backupId,projectRef:$project,approvalRef:$approval[0].approvalRef,signatureEvidenceRef:$approval[0].signatureEvidenceRef,approvedAt:$approval[0].approvedAt,approvedBy:$approval[0].approvedBy,sourceApprovalPlaintextSha256:$sourcePlaintextSha256,approvedGroups:$approval[0].approvedGroups}' \
  > "$BACKUP_ROOT/validation/approved-write-groups.json"
chmod 600 "$BACKUP_ROOT/validation/approved-write-groups.json"
# Shared helper validates the exact single source document, verifies the
# approval evidence against the owner-approved trust record, checks the raw
# plaintext-byte hash, and compares every derived field and ordered group.
node "$REPO_ROOT/scripts/backup/fence-transitions.mjs" validate-approval \
  --source "$APPROVED_GROUPS_SOURCE_SNAPSHOT" \
  --inventory "$BACKUP_ROOT/validation/approved-write-groups.json" \
  --source-plaintext-sha256 "$APPROVED_GROUPS_SOURCE_PLAINTEXT_SHA256" \
  --trust-root-file "$APPROVED_GROUPS_TRUST_ROOT_FILE" \
  --backup-id "$BACKUP_ID" --project-ref "$STAGING_PROJECT_REF" \
  --require-exactly-one-json-document --verify-approval-evidence

# Reusable source-side psql wrapper. It runs the PostgreSQL 17.11 client in
# the pinned container, mounts the password file and CA read-only, and never
# puts a password in argv or environment. Keep this function in the same
# shell for B0-B6; if opening a new shell, re-enter this exact function after
# re-exporting and re-validating all variables.
source_psql() {
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    --entrypoint /bin/sh \
    -e PGPASSFILE=/run/secrets/pgpass \
    -e PGSSLMODE=verify-full \
    -e PGSSLROOTCERT=/run/secrets/provider-ca.crt \
    -v "$SECRETS_ROOT/pgpass-staging-ro:/run/secrets/pgpass:ro" \
    -v "$SECRETS_ROOT/provider-ca.crt:/run/secrets/provider-ca.crt:ro" \
    -v "$BACKUP_ROOT/sql:/sql:ro" \
    "$PG_IMAGE" -ceu 'exec psql "$@"' sh \
      --host="$DB_HOST" \
      --port="$DB_PORT" \
      --username="$DB_USER" \
      --dbname=postgres \
      "$@"
}

# Validate tool versions and that the local image resolves to the approved
# immutable digest. This is local image inspection; it does not contact Staging.
docker image inspect "$PG_IMAGE" --format '{{json .RepoDigests}}' \
  > "$BACKUP_ROOT/validation/pg-image-digests.json"
chmod 600 "$BACKUP_ROOT/validation/pg-image-digests.json"
jq -e --arg image "$PG_IMAGE" 'index($image) != null' \
  "$BACKUP_ROOT/validation/pg-image-digests.json" > /dev/null
docker run --rm "$PG_IMAGE" pg_dump --version \
  > "$BACKUP_ROOT/validation/pg-dump-version.txt"
docker run --rm "$PG_IMAGE" pg_restore --version \
  > "$BACKUP_ROOT/validation/pg-restore-version.txt"
docker run --rm "$PG_IMAGE" psql --version \
  > "$BACKUP_ROOT/validation/psql-version.txt"
grep -q '17\.11' "$BACKUP_ROOT/validation/pg-dump-version.txt"
grep -q '17\.11' "$BACKUP_ROOT/validation/pg-restore-version.txt"
grep -q '17\.11' "$BACKUP_ROOT/validation/psql-version.txt"
```

The password file must contain an entry matching the **actual** host, port,
database, and `DB_USER`. Example shapes only (never put the real password in
this document):

```text
# Direct connection
db.qmhfmgkymjgoevwmkidm.supabase.co:5432:postgres:backup_ro:<redacted>
# Supavisor session pooler — replace host/port with the owner-approved values
<session-pooler-host>:<session-pooler-port>:postgres:backup_ro.qmhfmgkymjgoevwmkidm:<redacted>
```

Use only the one matching the selected connection mode. A pooler connection requires the
project-qualified username `backup_ro.<project-ref>`; changing only the host
and port is insufficient. `PGPASSFILE` must be `0600`, owned by the operator,
and mounted read-only. Do not put credentials in `PGPASSWORD`, command-line
arguments, shell history, logs or this runbook.

Run the non-secret connection identity check only after the exports and
`source_psql` function exist:

```bash
set -Eeuo pipefail
source_psql -X -v ON_ERROR_STOP=1 -c '\conninfo' \
  > "$BACKUP_ROOT/validation/conninfo.txt"
source_psql -X -qAt -v ON_ERROR_STOP=1 -c \
  "SELECT jsonb_build_object('database', current_database(), 'principal', current_user, 'server_version', current_setting('server_version'), 'server_version_num', current_setting('server_version_num'))::text" \
  > "$BACKUP_ROOT/validation/db-identity.json"
chmod 600 "$BACKUP_ROOT/validation/conninfo.txt" "$BACKUP_ROOT/validation/db-identity.json"
jq -s -e --arg role "$DB_EXPECTED_ROLE" \
  'length == 1 and (.[0].principal == $role) and (.[0].server_version | startswith("17."))' \
  "$BACKUP_ROOT/validation/db-identity.json" > /dev/null
```

`\conninfo` and `current_database()` are sanity checks, **not** proof of the
Supabase project reference. Independently verify `qmhfmgkymjgoevwmkidm` using
the approved Supabase Management API/project-metadata procedure. Preserve the
redacted response and the exact endpoint identity in the execution evidence;
do not print or store the Management API token. If project ref, hostname,
connection mode, PostgreSQL version, role or endpoint cannot be independently
confirmed, stop.

After §5.4 key generation, verify the key file exists, is exactly 32 bytes and
matches the fingerprint in the sealed custody record before B1:

```bash
set -Eeuo pipefail
test -f "$KEY_FILE" && test ! -L "$KEY_FILE"
test "$(wc -c < "$KEY_FILE" | tr -d ' ')" = 32
KEY_FINGERPRINT="$(shasum -a 256 "$KEY_FILE" | awk '{print $1}')"
test "$KEY_FINGERPRINT" = "$APPROVED_KEY_FINGERPRINT"
unset KEY_FINGERPRINT
```

Keep the B0 variables and `source_psql` function for B1-B6. If a new shell is
required, re-export the exact recorded values and re-run the identity and key
checks. Never reconstruct a different Backup ID or path. Effect: creates
local directories, inspects the pinned image and performs approved read-only
identity queries; it does not write to Staging.

### B1 — Fence writes and external effects

Under the approved change record:

- pause Render web/worker/cron processes that write to Staging;
- disable inbound webhooks or route them to a durable queue with an approved
  retention story;
- pause schedulers/workers, including AI analysis, outbox, media and
  transcription workers;
- pause Storage uploads and external provider sends;
- drain or record in-flight claims, outbox rows, uncertain deliveries and
  retryable jobs;
- record the fence start time in UTC and write the exact UTC timestamp to
  `$BACKUP_ROOT/validation/fence-start.txt` with mode `0600`; do not infer it
  later from a shell history or operator recollection.

Capture the timestamp as part of the controlled fence procedure:

```bash
set -Eeuo pipefail
umask 077
FENCE_START_UTC="$(node -e 'process.stdout.write(new Date().toISOString())')"
test ! -e "$BACKUP_ROOT/validation/fence-start.txt"
printf '%s\n' "$FENCE_START_UTC" > "$BACKUP_ROOT/validation/fence-start.txt"
chmod 600 "$BACKUP_ROOT/validation/fence-start.txt"
```

Do not acknowledge an inbound event unless it is durably retained. Do not
blindly resend after restore. Do not run this step as part of this draft.

### B2 — Record the checkpoint

Create the checkpoint SQL file and execute it through the B0 `source_psql`
wrapper. The wrapper uses the pinned container because host `psql` is missing.

```bash
set -Eeuo pipefail
cat > "$BACKUP_ROOT/sql/checkpoint.sql" <<'SQL'
SET TimeZone = 'UTC';
SET DateStyle = 'ISO, MDY';
SELECT jsonb_build_object(
  'checkpointAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'serverVersion', current_setting('server_version'),
  'serverVersionNum', current_setting('server_version_num'),
  'database', current_database(),
  'principal', current_user,
  'ledgerRows', (SELECT count(*) FROM supabase_migrations.schema_migrations),
  'authUsers', (SELECT count(*) FROM auth.users),
  'storageBuckets', (SELECT count(*) FROM storage.buckets),
  'storageObjects', (SELECT count(*) FROM storage.objects),
  'largeObjects', (SELECT count(*) FROM pg_largeobject_metadata)
)::text;
SQL
chmod 600 "$BACKUP_ROOT/sql/checkpoint.sql"
source_psql -X -qAt -v ON_ERROR_STOP=1 -f /sql/checkpoint.sql \
  > "$BACKUP_ROOT/validation/checkpoint.json" \
  2> "$BACKUP_ROOT/logs/checkpoint.stderr"
chmod 600 "$BACKUP_ROOT/validation/checkpoint.json"
jq -s -e 'length == 1 and (.[0] | type == "object" and (.serverVersion | startswith("17.")))' \
  "$BACKUP_ROOT/validation/checkpoint.json" > /dev/null

# WAL position is useful evidence but is not allowed to block or expand the
# backup role ad hoc. Record an explicit denial if the provider denies it.
if source_psql -X -qAt -v ON_ERROR_STOP=1 -c \
  "SELECT jsonb_build_object('capturedAt', now(), 'walLsn', pg_current_wal_lsn()::text, 'walInsertLsn', pg_current_wal_insert_lsn()::text)::text" \
  > "$BACKUP_ROOT/validation/wal-checkpoint.json" \
  2> "$BACKUP_ROOT/logs/wal-checkpoint.stderr"; then
  chmod 600 "$BACKUP_ROOT/validation/wal-checkpoint.json" \
    "$BACKUP_ROOT/logs/wal-checkpoint.stderr"
else
  if grep -Eiq 'permission denied|insufficient privilege' \
    "$BACKUP_ROOT/logs/wal-checkpoint.stderr"; then
    printf '%s\n' '{"status":"permission_denied","walLsn":null}' \
      > "$BACKUP_ROOT/validation/wal-checkpoint.json"
    chmod 600 "$BACKUP_ROOT/validation/wal-checkpoint.json" \
      "$BACKUP_ROOT/logs/wal-checkpoint.stderr"
  else
    echo "WAL checkpoint failed for a reason other than a recognized permission denial; stop" >&2
    exit 1
  fi
fi

supabase --version > "$BACKUP_ROOT/validation/supabase-cli-version.txt"
docker --version > "$BACKUP_ROOT/validation/docker-version.txt"
node --version > "$BACKUP_ROOT/validation/node-version.txt"
chmod 600 "$BACKUP_ROOT/validation/"*-version.txt
```

If the checkpoint query fails, stop. If WAL position is denied, record the
denial and continue only if the owner-approved RPO method does not require it;
do not grant privileges ad hoc. The checkpoint JSON is the source of truth for
ledger/user/bucket/object/large-object counts at this run, not the 2026-10-30
baseline snapshot. Effect: read-only source queries and local evidence writes.

### B3 — Enumerate the required inventory

Create `sql/inventory.sql` with the read-only queries below. Execute it through
the B0 `source_psql` wrapper and capture the complete, non-secret query output
as `validation/inventory.txt`. Separately write machine-readable checkpoint
artifacts (`ledger.json`, `counts.json`, `catalog-fingerprint.json`) using the
commands after the SQL block. Required inventory:

- schemas and owners;
- tables, columns, types, defaults, identities/generated columns;
- constraints and validation state;
- indexes and validity;
- functions/procedures, languages, `SECURITY DEFINER`, owners, config;
- triggers (non-internal) and enabled state;
- RLS enabled/forced flags and every policy;
- table/function/schema/default ACLs;
- sequences and current state;
- large-object count/metadata and whether any application data depends on OIDs;
- extensions, versions and schemas;
- database encoding, locale/collation provider, database-level ACL/settings
  and `pg_db_role_setting` (database/role `ALTER ... SET` values);
- cross-schema object dependencies, foreign servers/user mappings and extension
  dependencies; record unsupported or project-bound dependencies;
- role memberships including grantor, `admin_option`, `inherit_option` and
  `set_option` (PostgreSQL 16+);
- event triggers and their enabled state;
- publications and publication tables;
- replication slots;
- `cron.job` and related scheduler state, if present;
- `storage.buckets` and `storage.objects` metadata;
- `auth.users` count and stable ID hash only (no emails/passwords);
- `vault.secrets` count and names only (no decrypted values);
- migration ledger with stored SQL hashes;
- approximate and exact row counts for app tables.

The following is the complete contents of `sql/inventory.sql`:

```bash
cat > "$BACKUP_ROOT/sql/inventory.sql" <<'SQL'
-- Ledger identity and stored hash; compare with evidence.
SELECT version,
       name,
       cardinality(statements) AS statement_count,
       encode(sha256(convert_to(array_to_string(statements, E'\n'), 'UTF8')), 'hex') AS stored_sql_sha256
FROM supabase_migrations.schema_migrations
ORDER BY version;

-- Bucket configuration.
SELECT to_jsonb(b) AS bucket_config
FROM storage.buckets b
ORDER BY b.id;

-- Object metadata; use to_jsonb for forward-compatible column capture.
SELECT to_jsonb(o) AS object
FROM storage.objects o
ORDER BY o.bucket_id, o.name;

-- Roles and memberships, no passwords.
SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
       rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil
FROM pg_roles
WHERE rolname !~ '^pg_'
ORDER BY rolname;

SELECT r.rolname AS role_name,
       m.rolname AS member_name,
       g.rolname AS grantor_name,
       am.admin_option,
       am.inherit_option,
       am.set_option
FROM pg_auth_members am
JOIN pg_roles r ON r.oid = am.roleid
JOIN pg_roles m ON m.oid = am.member
JOIN pg_roles g ON g.oid = am.grantor
ORDER BY 1, 2, 3;

-- Large objects are outside ordinary schema selection. Record count and
-- include them in B4 when any exist (the dump command always uses --large-objects).
SELECT count(*) AS large_object_count FROM pg_largeobject_metadata;

-- If the count is non-zero, create an encrypted per-object manifest containing
-- OID, byte count and SHA-256 using a reviewed streaming LO reader. Do not use
-- a single lo_get() for large values because it materializes the whole object.
-- The manifest is mandatory for acceptance when any large object exists.
-- If count > 0, run the reviewed streaming helper and write
-- db/large-objects-manifest.json with OID, bytes and SHA-256 per object.
-- If count = 0, record the measured zero and omit the conditional artifact.

-- Database-level identity/locale/ACL/settings; redact any sensitive settings.
SELECT to_jsonb(d) - 'datacl' AS database_metadata,
       d.datacl::text AS database_acl
FROM pg_database d
WHERE d.datname = current_database();

SELECT r.setdatabase,
       r.setrole,
       coalesce(
         array_agg(split_part(v.setting, '=', 1)
                   ORDER BY split_part(v.setting, '=', 1))
           FILTER (WHERE v.setting IS NOT NULL),
         ARRAY[]::text[]
       ) AS setting_names_only
FROM pg_db_role_setting r
LEFT JOIN LATERAL unnest(r.setconfig) AS v(setting) ON true
WHERE r.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
   OR r.setdatabase = 0
GROUP BY r.setdatabase, r.setrole
ORDER BY r.setdatabase, r.setrole;
-- This query intentionally captures setting names only. If restore requires
-- values, capture only an explicitly approved safe-GUC allowlist; redact all
-- custom/credential-bearing values.

-- Foreign-server/user-mapping names only. Never export umoptions: they can
-- contain credentials. Capture approved non-secret connection attributes only.
SELECT s.srvname AS server_name,
       coalesce(r.rolname, 'PUBLIC') AS mapping_role
FROM pg_user_mapping m
JOIN pg_foreign_server s ON s.oid = m.umserver
LEFT JOIN pg_roles r ON r.oid = m.umuser
ORDER BY 1, 2;

-- Cross-schema dependencies. Replace the schema array with the exact app
-- schemas selected for B4; inspect references outside that set before dumping.
WITH object_dependencies AS (
  SELECT d.deptype,
         dep.type AS dependent_type,
         dep.schema::text AS dependent_schema,
         dep.identity AS dependent_identity,
         ref.type AS referenced_type,
         ref.schema::text AS referenced_schema,
         ref.identity AS referenced_identity
  FROM pg_depend d
  CROSS JOIN LATERAL pg_identify_object(
    d.classid, d.objid, d.objsubid
  ) AS dep(type, schema, name, identity)
  CROSS JOIN LATERAL pg_identify_object(
    d.refclassid, d.refobjid, d.refobjsubid
  ) AS ref(type, schema, name, identity)
)
SELECT *
FROM object_dependencies
WHERE dependent_schema IS DISTINCT FROM referenced_schema
  AND (dependent_schema = ANY (ARRAY['public', 'private', 'supabase_migrations']::text[])
       OR referenced_schema = ANY (ARRAY['public', 'private', 'supabase_migrations']::text[]))
ORDER BY dependent_schema, dependent_identity, referenced_schema, referenced_identity;


-- Schema ownership and relation inventory.
SELECT n.nspname AS schema_name, pg_get_userbyid(n.nspowner) AS owner,
       n.nspacl AS acl
FROM pg_namespace n
WHERE n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
ORDER BY n.nspname;

SELECT n.nspname AS schema_name, c.relname AS object_name,
       CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned_table'
         WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view'
         WHEN 'f' THEN 'foreign_table' ELSE c.relkind::text END AS object_type,
       c.relispartition, pg_get_userbyid(c.relowner) AS owner, c.relacl AS acl,
       c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p','S','v','m','f')
  AND n.nspname IN ('public','private','supabase_migrations')
ORDER BY 1,2;

SELECT table_schema, table_name, ordinal_position, column_name, data_type,
       udt_schema, udt_name, is_nullable, column_default, is_identity,
       identity_generation, is_generated, generation_expression
FROM information_schema.columns
WHERE table_schema IN ('public','private','supabase_migrations')
ORDER BY table_schema, table_name, ordinal_position;

SELECT n.nspname AS schema_name, c.relname AS table_name, con.conname,
       con.contype, con.convalidated, pg_get_constraintdef(con.oid, true) AS definition
FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname IN ('public','private','supabase_migrations')
ORDER BY 1,2,3;

SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes WHERE schemaname IN ('public','private','supabase_migrations')
ORDER BY 1,2,3;

SELECT n.nspname AS schema_name, p.proname,
       CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS routine_type,
       pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig, p.proacl
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname IN ('public','private','supabase_migrations')
ORDER BY 1,2,3,4;

SELECT n.nspname AS schema_name, c.relname AS table_name, t.tgname,
       t.tgenabled, pg_get_triggerdef(t.oid, true) AS definition
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE NOT t.tgisinternal AND n.nspname IN ('public','private','supabase_migrations')
ORDER BY 1,2,3;

SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname IN ('public','private','supabase_migrations')
ORDER BY 1,2,3;

SELECT n.nspname AS schema_name, c.relname AS sequence_name,
       pg_get_userbyid(c.relowner) AS owner, s.last_value, s.start_value,
       s.increment_by, s.max_value, s.min_value, s.cache_size, s.cycle
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_sequences s ON s.schemaname=n.nspname AND s.sequencename=c.relname
WHERE c.relkind='S' AND n.nspname IN ('public','private','supabase_migrations')
ORDER BY 1,2;

-- ACL inventories. Values may contain role names but no passwords/tokens.
SELECT n.nspname, c.relname, c.relacl
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname IN ('public','private','supabase_migrations')
ORDER BY 1,2;
SELECT n.nspname, p.proname, p.proacl
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname IN ('public','private','supabase_migrations')
ORDER BY 1,2;
SELECT defaclrole::regrole AS grantor, defaclnamespace::regnamespace AS schema_name,
       defaclobjtype, defaclacl
FROM pg_default_acl ORDER BY 1,2,3;

-- Auth metadata only: counts and a stable hash of user IDs; no emails/passwords.
SELECT jsonb_build_object(
  'users', (SELECT count(*) FROM auth.users),
  'userIdSha256', (SELECT encode(sha256(convert_to(coalesce(string_agg(id::text, ',' ORDER BY id), ''), 'UTF8')), 'hex') FROM auth.users),
  'identities', (SELECT count(*) FROM auth.identities),
  'mfaFactors', (SELECT count(*) FROM auth.mfa_factors)
)::text AS auth_inventory;

-- Optional managed-service relation presence. The shell wrapper separately
-- captures Vault names only if vault.secrets exists; never query decrypted_secrets.
SELECT to_regclass('vault.secrets') IS NOT NULL AS vault_secrets_present;
SELECT to_regclass('cron.job') IS NOT NULL AS cron_job_present;

SELECT pubname, puballtables, pubinsert, pubupdate, pubdelete, pubtruncate
FROM pg_publication ORDER BY pubname;
SELECT * FROM pg_publication_tables ORDER BY pubname, schemaname, tablename;
SELECT slot_name, plugin, slot_type, database, active, restart_lsn
FROM pg_replication_slots ORDER BY slot_name;

-- Event triggers.
SELECT evtname, evtevent, evtenabled, evttags
FROM pg_event_trigger
ORDER BY evtname;

-- Extensions.
SELECT e.extname, e.extversion, n.nspname AS schema_name
FROM pg_extension e
JOIN pg_namespace n ON n.oid = e.extnamespace
ORDER BY e.extname;
SQL
chmod 600 "$BACKUP_ROOT/sql/inventory.sql"
source_psql -X -v ON_ERROR_STOP=1 -P pager=off -f /sql/inventory.sql \
  > "$BACKUP_ROOT/validation/inventory.txt"
chmod 600 "$BACKUP_ROOT/validation/inventory.txt"

# Managed-schema customizations are captured as evidence only. This does NOT
# dump or replay all Supabase-managed Auth/Storage DDL. The reviewer must
# classify platform defaults vs project customizations before any apply step.
cat > "$BACKUP_ROOT/sql/managed-customizations.sql" <<'SQL'
WITH items AS (
  SELECT 'policy'::text AS kind,
         format('%I.%I:%s', schemaname, tablename, policyname) AS identity,
         jsonb_build_object(
           'schema', schemaname, 'table', tablename, 'policy', policyname,
           'permissive', permissive, 'roles', to_jsonb(roles), 'command', cmd,
           'using', qual, 'withCheck', with_check
         ) AS details
  FROM pg_policies
  WHERE schemaname IN ('auth', 'storage')
  UNION ALL
  SELECT 'trigger', format('%I.%I:%I', n.nspname, c.relname, t.tgname),
         jsonb_build_object(
           'definition', pg_get_triggerdef(t.oid, true),
           'enabled', t.tgenabled,
           'functionIdentity', p.oid::regprocedure::text,
           'functionDefinition', pg_get_functiondef(p.oid),
           'functionOwner', pg_get_userbyid(p.proowner),
           'securityDefiner', p.prosecdef,
           'functionConfig', p.proconfig,
           'functionAcl', p.proacl::text
         )
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE NOT t.tgisinternal AND n.nspname IN ('auth', 'storage')
  UNION ALL
  SELECT 'index', format('%I.%I:%I', n.nspname, c.relname, idx.relname),
         jsonb_build_object(
           'definition', pg_get_indexdef(i.indexrelid),
           'valid', i.indisvalid, 'ready', i.indisready, 'live', i.indislive,
           'unique', i.indisunique, 'primary', i.indisprimary
         )
  FROM pg_index i
  JOIN pg_class idx ON idx.oid = i.indexrelid
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('auth', 'storage')
  UNION ALL
  SELECT 'constraint', format('%I.%I:%I', n.nspname, c.relname, con.conname),
         jsonb_build_object(
           'definition', pg_get_constraintdef(con.oid, true),
           'validated', con.convalidated, 'deferrable', con.condeferrable,
           'initiallyDeferred', con.condeferred
         )
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('auth', 'storage')
  UNION ALL
  SELECT CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'routine' END,
         format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)),
         jsonb_build_object(
           'definition', pg_get_functiondef(p.oid),
           'owner', pg_get_userbyid(p.proowner), 'securityDefiner', p.prosecdef,
           'config', p.proconfig, 'acl', p.proacl::text,
           'language', l.lanname, 'comment', obj_description(p.oid, 'pg_proc')
         )
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname IN ('auth', 'storage') AND p.prokind IN ('f', 'p')
  UNION ALL
  SELECT 'relation-rls', format('%I.%I', n.nspname, c.relname),
         jsonb_build_object(
           'rlsEnabled', c.relrowsecurity,
           'rlsForced', c.relforcerowsecurity,
           'owner', pg_get_userbyid(c.relowner),
           'comment', obj_description(c.oid, 'pg_class')
         )
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('auth', 'storage') AND c.relkind IN ('r', 'p', 'v', 'm')
  UNION ALL
  SELECT 'relation-acl', format('%I.%I', n.nspname, c.relname),
         jsonb_build_object(
           'aclIsNull', c.relacl IS NULL,
           'aclRaw', c.relacl::text,
           'entries', coalesce((
             SELECT jsonb_agg(jsonb_build_object(
               'grantee', CASE x.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
               'grantor', pg_get_userbyid(x.grantor),
               'privilegeType', x.privilege_type,
               'isGrantable', x.is_grantable
             ) ORDER BY x.grantee, x.grantor, x.privilege_type, x.is_grantable)
             FROM aclexplode(c.relacl) AS x
           ), '[]'::jsonb)
         )
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('auth', 'storage') AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  UNION ALL
  SELECT 'column-acl', format('%I.%I.%I', n.nspname, c.relname, a.attname),
         jsonb_build_object(
           'aclIsNull', a.attacl IS NULL,
           'aclRaw', a.attacl::text,
           'entries', coalesce((
             SELECT jsonb_agg(jsonb_build_object(
               'grantee', CASE x.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
               'grantor', pg_get_userbyid(x.grantor),
               'privilegeType', x.privilege_type,
               'isGrantable', x.is_grantable
             ) ORDER BY x.grantee, x.grantor, x.privilege_type, x.is_grantable)
             FROM aclexplode(a.attacl) AS x
           ), '[]'::jsonb)
         )
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('auth', 'storage')
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND a.attnum > 0 AND NOT a.attisdropped
)
SELECT coalesce(
  jsonb_agg(jsonb_build_object('kind', kind, 'identity', identity, 'details', details)
            ORDER BY kind, identity),
  '[]'::jsonb
)::text
FROM items;
SQL
chmod 600 "$BACKUP_ROOT/sql/managed-customizations.sql"
source_psql -X -qAt -v ON_ERROR_STOP=1 -f /sql/managed-customizations.sql \
  > "$BACKUP_ROOT/validation/managed-customizations.json" \
  2> "$BACKUP_ROOT/logs/managed-customizations.stderr"
jq -s -e 'length == 1 and (.[0] | type == "array")' \
  "$BACKUP_ROOT/validation/managed-customizations.json" > /dev/null

# Detailed catalog evidence supplements count-only catalog-fingerprint.json.
# Sequence state includes both last_value and is_called; pg_sequences alone
# does not prove the latter.
cat > "$BACKUP_ROOT/sql/catalog-details.sql" <<'SQL'
SET TimeZone = 'UTC';
CREATE TEMP TABLE captured_sequence_state (
  schema_name text, sequence_name text, last_value bigint, is_called boolean
);
DO $$
DECLARE r record; v_last bigint; v_called boolean;
BEGIN
  FOR r IN
    SELECT n.nspname, c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'S' AND n.nspname IN ('public','private','supabase_migrations')
    ORDER BY n.nspname, c.relname
  LOOP
    EXECUTE format('SELECT last_value, is_called FROM %I.%I', r.nspname, r.relname)
      INTO v_last, v_called;
    INSERT INTO captured_sequence_state VALUES (r.nspname, r.relname, v_last, v_called);
  END LOOP;
END $$;
SELECT jsonb_build_object(
  'indexes', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'schema', n.nspname, 'table', tbl.relname, 'name', idx.relname,
      'definition', pg_get_indexdef(i.indexrelid), 'valid', i.indisvalid,
      'ready', i.indisready, 'live', i.indislive, 'unique', i.indisunique,
      'primary', i.indisprimary
    ) ORDER BY n.nspname, tbl.relname, idx.relname)
    FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
    JOIN pg_class tbl ON tbl.oid=i.indrelid
    JOIN pg_namespace n ON n.oid=tbl.relnamespace
    WHERE n.nspname IN ('public','private','supabase_migrations')
  ), '[]'::jsonb),
  'constraints', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'schema', n.nspname, 'table', tbl.relname, 'name', con.conname,
      'definition', pg_get_constraintdef(con.oid, true),
      'validated', con.convalidated, 'deferrable', con.condeferrable,
      'initiallyDeferred', con.condeferred
    ) ORDER BY n.nspname, tbl.relname, con.conname)
    FROM pg_constraint con JOIN pg_class tbl ON tbl.oid=con.conrelid
    JOIN pg_namespace n ON n.oid=tbl.relnamespace
    WHERE n.nspname IN ('public','private','supabase_migrations')
  ), '[]'::jsonb),
  'routines', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'schema', n.nspname, 'identity', format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)),
      'definition', pg_get_functiondef(p.oid), 'owner', pg_get_userbyid(p.proowner),
      'securityDefiner', p.prosecdef, 'config', p.proconfig, 'acl', p.proacl::text,
      'language', l.lanname, 'comment', obj_description(p.oid, 'pg_proc')
    ) ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname IN ('public','private','supabase_migrations') AND p.prokind IN ('f','p')
  ), '[]'::jsonb),
  'sequences', coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY schema_name, sequence_name)
                         FROM captured_sequence_state s), '[]'::jsonb),
  'relationComments', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'schema', n.nspname, 'relation', c.relname, 'comment', d.description
    ) ORDER BY n.nspname, c.relname)
    FROM pg_description d JOIN pg_class c ON c.oid=d.objoid AND d.classoid='pg_class'::regclass AND d.objsubid=0
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private','supabase_migrations')
  ), '[]'::jsonb),
  'columnComments', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'schema', n.nspname, 'relation', c.relname, 'column', a.attname,
      'comment', d.description
    ) ORDER BY n.nspname, c.relname, a.attnum)
    FROM pg_description d JOIN pg_class c ON c.oid=d.objoid AND d.classoid='pg_class'::regclass AND d.objsubid>0
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=d.objsubid
    WHERE n.nspname IN ('public','private','supabase_migrations')
  ), '[]'::jsonb)
)::text;
SQL
chmod 600 "$BACKUP_ROOT/sql/catalog-details.sql"
source_psql -X -qAt -v ON_ERROR_STOP=1 -f /sql/catalog-details.sql \
  > "$BACKUP_ROOT/validation/catalog-details.json" \
  2> "$BACKUP_ROOT/logs/catalog-details.stderr"
jq -s -e 'length == 1 and (.[0] | type == "object" and (.sequences | type == "array") and (.indexes | type == "array"))' \
  "$BACKUP_ROOT/validation/catalog-details.json" > /dev/null

# Machine-readable roles/memberships fallback. No password hashes are captured.
source_psql -X -qAt -v ON_ERROR_STOP=1 -c \
  "SELECT jsonb_build_object('roles',coalesce((SELECT jsonb_agg(jsonb_build_object('name',rolname,'superuser',rolsuper,'inherit',rolinherit,'createRole',rolcreaterole,'createDb',rolcreatedb,'canLogin',rolcanlogin,'replication',rolreplication,'bypassRls',rolbypassrls,'connectionLimit',rolconnlimit,'validUntil',rolvaliduntil) ORDER BY rolname) FROM pg_roles WHERE rolname !~ '^pg_'),'[]'::jsonb),'memberships',coalesce((SELECT jsonb_agg(jsonb_build_object('role',r.rolname,'member',m.rolname,'grantor',g.rolname,'adminOption',am.admin_option,'inheritOption',am.inherit_option,'setOption',am.set_option) ORDER BY r.rolname,m.rolname,g.rolname) FROM pg_auth_members am JOIN pg_roles r ON r.oid=am.roleid JOIN pg_roles m ON m.oid=am.member JOIN pg_roles g ON g.oid=am.grantor),'[]'::jsonb))::text" \
  > "$BACKUP_ROOT/validation/roles-inventory.json" \
  2> "$BACKUP_ROOT/logs/roles-inventory.stderr"
jq -s -e 'length == 1 and (.[0] | type == "object" and (.roles | type == "array") and (.memberships | type == "array"))' \
  "$BACKUP_ROOT/validation/roles-inventory.json" > /dev/null

# Create and run the same deterministic row-fingerprint script later used on
# the isolated target in R10. This source-side run is read-only except for a
# temporary table in the connection's temp schema.
cat > "$BACKUP_ROOT/sql/fingerprint.sql" <<'SQL'
SET TimeZone = 'UTC';
SET DateStyle = 'ISO, MDY';
SET extra_float_digits = 3;
CREATE TEMP TABLE restore_fingerprint (
  schema_name text, table_name text, row_count bigint, row_hash text
);
DO $$
DECLARE r record; n bigint; h text;
BEGIN
  FOR r IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname = ANY (ARRAY['public', 'private']::text[])
    ORDER BY schemaname, tablename
  LOOP
    EXECUTE format(
      'SELECT count(*), encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, chr(10) ORDER BY to_jsonb(x)::text), %L), %L)), %L) FROM %I.%I x',
      '', 'UTF8', 'hex', r.schemaname, r.tablename
    ) INTO n, h;
    INSERT INTO restore_fingerprint VALUES (r.schemaname, r.tablename, n, h);
  END LOOP;
END $$;
SELECT coalesce(
  jsonb_agg(to_jsonb(f) ORDER BY schema_name, table_name), '[]'::jsonb
)::text
FROM restore_fingerprint f;
SQL
chmod 600 "$BACKUP_ROOT/sql/fingerprint.sql"
source_psql -X -qAt -v ON_ERROR_STOP=1 -f /sql/fingerprint.sql \
  > "$BACKUP_ROOT/validation/source-fingerprint.json" \
  2> "$BACKUP_ROOT/logs/source-fingerprint.stderr"
chmod 600 "$BACKUP_ROOT/validation/source-fingerprint.json"
jq -s -e 'length == 1 and (.[0] | type == "array")' "$BACKUP_ROOT/validation/source-fingerprint.json" > /dev/null

# Machine-readable source evidence used later by R1/R10. These files are
# generated from the same fenced source snapshot and encrypted in B8.
source_psql -X -qAt -v ON_ERROR_STOP=1 -c \
  "SELECT coalesce(jsonb_agg(jsonb_build_object('version', version, 'name', name, 'statementCount', cardinality(statements), 'storedSqlSha256', encode(sha256(convert_to(array_to_string(statements, E'\\n'), 'UTF8')), 'hex')) ORDER BY version), '[]'::jsonb)::text FROM supabase_migrations.schema_migrations" \
  > "$BACKUP_ROOT/validation/ledger.json"
source_psql -X -qAt -v ON_ERROR_STOP=1 -c \
  "SELECT jsonb_build_object('ledgerRows',(SELECT count(*) FROM supabase_migrations.schema_migrations),'authUsers',(SELECT count(*) FROM auth.users),'authIdentities',(SELECT count(*) FROM auth.identities),'authMfaFactors',(SELECT count(*) FROM auth.mfa_factors),'storageBuckets',(SELECT count(*) FROM storage.buckets),'storageObjects',(SELECT count(*) FROM storage.objects),'largeObjects',(SELECT count(*) FROM pg_largeobject_metadata))::text" \
  > "$BACKUP_ROOT/validation/counts.json"
source_psql -X -qAt -v ON_ERROR_STOP=1 -c \
  "SELECT jsonb_build_object('schemas',(SELECT count(*) FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' ESCAPE '\\'),'tables',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','private')),'columns',(SELECT count(*) FROM information_schema.columns WHERE table_schema IN ('public','private')),'constraints',(SELECT count(*) FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname IN ('public','private')),'functions',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','private')),'indexes',(SELECT count(*) FROM pg_index i JOIN pg_class r ON r.oid=i.indrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname IN ('public','private')),'policies',(SELECT count(*) FROM pg_policies WHERE schemaname IN ('public','private')),'triggers',(SELECT count(*) FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN ('public','private')))::text" \
  > "$BACKUP_ROOT/validation/catalog-fingerprint.json"
source_psql -X -qAt -v ON_ERROR_STOP=1 -c \
  "WITH objects AS (SELECT 'schema'::text AS object_type, quote_ident(nspname) AS identity, pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname IN ('public','private','supabase_migrations') UNION ALL SELECT CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned_table' WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view' WHEN 'f' THEN 'foreign_table' ELSE c.relkind::text END, format('%I.%I',n.nspname,c.relname), pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','S','v','m','f') AND n.nspname IN ('public','private','supabase_migrations') UNION ALL SELECT CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END, format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)), pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','private','supabase_migrations') UNION ALL SELECT CASE t.typtype WHEN 'd' THEN 'domain' ELSE 'type' END, format('%I.%I',n.nspname,t.typname), pg_get_userbyid(t.typowner) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typrelid=0 AND t.typelem=0 AND t.typisdefined AND n.nspname IN ('public','private','supabase_migrations')) SELECT coalesce(jsonb_agg(jsonb_build_object('objectType',object_type,'identity',identity,'sourceOwner',owner) ORDER BY object_type,identity),'[]'::jsonb)::text FROM objects" \
  > "$BACKUP_ROOT/validation/owner-inventory.json"
VAULT_SECRETS_PRESENT="$(source_psql -X -qAt -v ON_ERROR_STOP=1 -c "SELECT to_regclass('vault.secrets') IS NOT NULL")"
if [ "$VAULT_SECRETS_PRESENT" = "t" ]; then
  source_psql -X -qAt -v ON_ERROR_STOP=1 -c \
    "SELECT jsonb_build_object('present',true,'count',count(*),'names',coalesce(jsonb_agg(name ORDER BY name),'[]'::jsonb))::text FROM vault.secrets" \
    > "$BACKUP_ROOT/validation/vault-inventory.json"
else
  printf '%s\n' '{"present":false,"count":0,"names":[]}' \
    > "$BACKUP_ROOT/validation/vault-inventory.json"
fi
CRON_JOB_PRESENT="$(source_psql -X -qAt -v ON_ERROR_STOP=1 -c \
  "SELECT to_regclass('cron.job') IS NOT NULL")"
if [ "$CRON_JOB_PRESENT" = "t" ]; then
  source_psql -X -qAt -v ON_ERROR_STOP=1 -c \
    "SELECT jsonb_build_object('present',true,'jobs',coalesce(jsonb_agg(jsonb_build_object('jobid',jobid,'schedule',schedule,'username',username,'database',database,'active',active,'commandSha256',encode(sha256(convert_to(command,'UTF8')),'hex')) ORDER BY jobid),'[]'::jsonb))::text FROM cron.job" \
    > "$BACKUP_ROOT/validation/cron-inventory.json"
else
  printf '%s\n' '{"present":false,"jobs":[]}' \
    > "$BACKUP_ROOT/validation/cron-inventory.json"
fi
# Keep this list limited to artifacts produced in B3. roles-status.json is
# created only by B6 and MUST NOT be referenced here.
B3_JSON_FILES=(
  "$BACKUP_ROOT/validation/ledger.json"
  "$BACKUP_ROOT/validation/counts.json"
  "$BACKUP_ROOT/validation/catalog-fingerprint.json"
  "$BACKUP_ROOT/validation/catalog-details.json"
  "$BACKUP_ROOT/validation/managed-customizations.json"
  "$BACKUP_ROOT/validation/roles-inventory.json"
  "$BACKUP_ROOT/validation/owner-inventory.json"
  "$BACKUP_ROOT/validation/vault-inventory.json"
  "$BACKUP_ROOT/validation/cron-inventory.json"
)
for artifact in "${B3_JSON_FILES[@]}"; do
  test -f "$artifact" && test ! -L "$artifact"
  chmod 600 "$artifact"
done
jq -s -e 'length == 1 and (.[0] | type == "array")' "$BACKUP_ROOT/validation/ledger.json" > /dev/null
jq -s -e 'length == 1 and (.[0] | type == "object")' "$BACKUP_ROOT/validation/counts.json" > /dev/null
jq -s -e 'length == 1 and (.[0] | type == "object")' "$BACKUP_ROOT/validation/catalog-fingerprint.json" > /dev/null
jq -s -e 'length == 1 and (.[0] | type == "array")' "$BACKUP_ROOT/validation/owner-inventory.json" > /dev/null
jq -s -e 'length == 1 and (.[0] | type == "object")' "$BACKUP_ROOT/validation/vault-inventory.json" > /dev/null
jq -s -e 'length == 1 and (.[0] | type == "object")' "$BACKUP_ROOT/validation/cron-inventory.json" > /dev/null
jq -s -e 'length == 1 and (.[0] | type == "array")' "$BACKUP_ROOT/validation/managed-customizations.json" > /dev/null
jq -s -e 'length == 1 and (.[0] | type == "object")' "$BACKUP_ROOT/validation/catalog-details.json" > /dev/null
jq -s -e 'length == 1 and (.[0] | type == "object")' "$BACKUP_ROOT/validation/roles-inventory.json" > /dev/null
```

Effect: read-only source inventory and checkpoint capture. Preserve the raw
inventory output as restricted evidence; do not include private row values.

### B4 — Dump the application database

Use PostgreSQL 17.11 tooling and the dedicated backup principal selected in B0
(`DB_USER=backup_ro` for direct DB, or `backup_ro.<project-ref>` for the
approved Supavisor session pooler). The principal must have SELECT/read access to every included table, sequence and large object,
plus the approved `BYPASSRLS` attribute so `pg_dump` cannot silently produce an
RLS-filtered backup. It must not be SUPERUSER and must not have write privileges.
`pg_read_all_data` alone does not bypass row-level security. Do not use
`--enable-row-security`: that option intentionally exports only rows visible to
the dump role. If the platform cannot provide the required privilege safely,
stop and use a provider-supported complete backup path; do not continue with a
partial dump.

The password is supplied through a `0600` libpq password file mounted
read-only; never via `PGPASSWORD` in the command line or history. Host-side
`umask` does not set the container process umask, so each container command that
creates an artifact explicitly sets `umask 077` inside the container.

The B0 password-file entry must match the selected connection mode. For the
direct endpoint the username field is `backup_ro`; for the Supavisor session
pooler it is `backup_ro.qmhfmgkymjgoevwmkidm`. Do not maintain a stale direct
entry while using the pooler.

Dump command:

```bash
set -Eeuo pipefail
test ! -e "$BACKUP_ROOT/db/app.dump"
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --entrypoint /bin/sh \
  -e PGPASSFILE=/run/secrets/pgpass \
  -e PGSSLMODE=verify-full \
  -e PGSSLROOTCERT=/run/secrets/provider-ca.crt \
  -v "$BACKUP_ROOT":/backup \
  -v "$SECRETS_ROOT/pgpass-staging-ro":/run/secrets/pgpass:ro \
  -v "$SECRETS_ROOT/provider-ca.crt":/run/secrets/provider-ca.crt:ro \
  "$PG_IMAGE" -ceu 'umask 077; exec pg_dump "$@"' sh \
    --host="$DB_HOST" \
    --port="$DB_PORT" \
    --username="$DB_USER" \
    --dbname=postgres \
    --format=custom \
    --compress=9 \
    --large-objects \
    --lock-wait-timeout=30s \
    --schema=public \
    --schema=private \
    --schema=supabase_migrations \
    --file=/backup/db/app.dump
chmod 600 "$BACKUP_ROOT/db/app.dump"
test -s "$BACKUP_ROOT/db/app.dump"
```

Effect: opens one repeatable-read snapshot, takes `ACCESS SHARE` locks, reads
schema/data/metadata for the selected schemas and writes a custom-format
archive. It does **not** include Storage bytes, Vault root keys, Auth service
configuration, Edge Functions or project settings.

Connection notes:

- The host has no `pg_dump`; this Docker substitution is allowed only if the
  access gate approves it. Do not install an unpinned client as a workaround.
- Use the direct database host if it resolves over the approved network. If
  IPv6/DNS is unavailable from Docker, use the approved **session** pooler; do
  not change project network restrictions to make the command work. If the
  pooler is used, set `DB_HOST`/`DB_PORT` to that exact endpoint before B4 and
  make the `pgpass` entry match it; do not reuse the direct-host entry.
- `PGSSLMODE=verify-full` with the provider CA verifies the server identity.
  If the provider-supported connection path cannot use this mode, stop for an
  explicit security exception; do not silently downgrade to `require`.
- Never put the password in `PGPASSWORD`, `argv`, a log or the shell history.

Rules:

- Do **not** use `--no-acl`; grants are part of the recovery contract.
- Do not rely on `pg_dump --no-owner` for a custom archive: PostgreSQL ignores
  that option for archive formats. Apply `pg_restore --no-owner` at R5, then
  execute the reviewed owner-mapping plan before accepting the restore. ACLs are
  still dumped and must be reviewed separately.
- `--large-objects` is mandatory with the schema-filtered dump because schema
  selection otherwise excludes non-schema large objects. Verify the large-object
  TOC and count; if large objects exist but cannot be read, stop.
- Include every application schema that exists; do not assume only `public`.
  If `graphql_public` or another app schema exists, add it explicitly.
- PostgreSQL does not automatically add dependencies that live outside the
  selected schemas. Review the B3 dependency inventory (including extension,
  type, function, foreign-server and cross-schema dependencies); include the
  required dependency objects/schema or stop and redesign the dump scope. Do not
  accept a partial archive merely because its TOC is non-empty.
- Verify the archive TOC before accepting:

```bash
set -Eeuo pipefail
test ! -e "$BACKUP_ROOT/validation/app.toc.txt"
docker run --rm -v "$BACKUP_ROOT":/backup "$PG_IMAGE" \
  pg_restore --list /backup/db/app.dump \
  > "$BACKUP_ROOT/validation/app.toc.txt"
chmod 600 "$BACKUP_ROOT/validation/app.toc.txt"
```

Check that every required table, function, policy, trigger, sequence and the
`supabase_migrations` rows are present. A missing schema/table is a stop.

### B5 — Capture managed-schema data as evidence

Managed Auth/Storage/Vault data may not be safe to restore by blindly replaying
DDL. Capture a **data-only** archive for evidence and for the approved
provider-supported path:

```bash
set -Eeuo pipefail
test ! -e "$BACKUP_ROOT/db/managed-data.dump"
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --entrypoint /bin/sh \
  -e PGPASSFILE=/run/secrets/pgpass \
  -e PGSSLMODE=verify-full \
  -e PGSSLROOTCERT=/run/secrets/provider-ca.crt \
  -v "$BACKUP_ROOT":/backup \
  -v "$SECRETS_ROOT/pgpass-staging-ro":/run/secrets/pgpass:ro \
  -v "$SECRETS_ROOT/provider-ca.crt":/run/secrets/provider-ca.crt:ro \
  "$PG_IMAGE" -ceu 'umask 077; exec pg_dump "$@"' sh \
    --host="$DB_HOST" \
    --port="$DB_PORT" \
    --username="$DB_USER" \
    --dbname=postgres \
    --format=custom \
    --compress=9 \
    --data-only \
    --schema=auth \
    --schema=storage \
    --schema=vault \
    --file=/backup/db/managed-data.dump
chmod 600 "$BACKUP_ROOT/db/managed-data.dump"
test -s "$BACKUP_ROOT/db/managed-data.dump"
```

Effect: reads managed-table rows, including password hashes, identities,
Storage metadata and encrypted Vault values. Treat the archive as highly
sensitive and encrypt immediately.

Limits to record:

- this is **not** a supported restore path by itself;
- Vault ciphertext needs the project's root key, which is not in the dump;
- Auth sessions/MFA may depend on service configuration and encryption keys;
- Storage metadata replay may conflict with the supported object-upload path;
- cron jobs, webhooks, Edge Functions, publications and replication slots are
  inventory-only here; re-provision them through their approved platform path,
  not by replaying managed DDL;
- do not restore managed DDL over an existing project.

If the approved procedure forbids dumping a managed schema, skip that schema,
record the decision and rely on the provider-supported export. Do not bypass a
denial.

### B6 — Capture roles and platform inventory

The B3 `validation/roles-inventory.json` is the mandatory machine-readable
fallback. `pg_dumpall --roles-only --no-role-passwords` is optional and must
never be allowed to leave a partial `roles.sql` artifact.

```bash
set -Eeuo pipefail
umask 077
test ! -e "$BACKUP_ROOT/db/roles.sql"
test ! -e "$BACKUP_ROOT/db/roles.sql.partial"
test ! -e "$BACKUP_ROOT/validation/roles-status.json"
if docker run --rm \
  --user "$(id -u):$(id -g)" \
  --entrypoint /bin/sh \
  -e PGPASSFILE=/run/secrets/pgpass \
  -e PGSSLMODE=verify-full \
  -e PGSSLROOTCERT=/run/secrets/provider-ca.crt \
  -v "$BACKUP_ROOT":/backup \
  -v "$SECRETS_ROOT/pgpass-staging-ro":/run/secrets/pgpass:ro \
  -v "$SECRETS_ROOT/provider-ca.crt":/run/secrets/provider-ca.crt:ro \
  "$PG_IMAGE" -ceu 'umask 077; exec pg_dumpall "$@"' sh \
    --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" \
    --roles-only --no-role-passwords --file=/backup/db/roles.sql.partial \
    2> "$BACKUP_ROOT/logs/roles-export.stderr"; then
  test -s "$BACKUP_ROOT/db/roles.sql.partial"
  mv "$BACKUP_ROOT/db/roles.sql.partial" "$BACKUP_ROOT/db/roles.sql"
  printf '%s\n' '{"status":"exported","source":"pg_dumpall_roles_only"}' \
    > "$BACKUP_ROOT/validation/roles-status.json"
else
  rc=$?
  rm -f -- "$BACKUP_ROOT/db/roles.sql.partial" "$BACKUP_ROOT/db/roles.sql"
  if grep -Eiq 'permission denied|insufficient privilege|must be superuser' \
    "$BACKUP_ROOT/logs/roles-export.stderr"; then
    printf '%s\n' '{"status":"permission_denied","fallback":"validation/roles-inventory.json"}' \
      > "$BACKUP_ROOT/validation/roles-status.json"
  else
    echo "pg_dumpall role export failed unexpectedly (exit $rc); stop" >&2
    exit "$rc"
  fi
fi
chmod 600 "$BACKUP_ROOT/validation/roles-status.json"
jq -e '(.status == "exported" or .status == "permission_denied")' \
  "$BACKUP_ROOT/validation/roles-status.json" > /dev/null
```

If the export is denied for a recognized privilege reason, use only the B3
`roles-inventory.json` as evidence and record that executable role DDL was not
captured. Do not generate or replay role DDL automatically. If failure is not a
recognized privilege denial, stop. Do not grant SUPERUSER to make the optional
export pass.

Also capture, through approved read-only APIs or SQL:

- Auth configuration: Site URL, redirect allow-list, providers, SMTP, MFA,
  session/JWT settings — **names and non-secret values only**;
- Storage configuration: record non-secret configuration names and whether
  any signing material is project-bound; never export raw signing keys or secrets;
- Edge Functions: names, versions, verify-JWT flags and secret **names**;
- Vault secret names/descriptions, never plaintext;
- cron jobs, webhooks, publications, replication slots;
- Render environment variable **names** and grouping, never values.

### B7 — Capture Storage bytes

A database dump contains Storage metadata, not file bytes. This step downloads
every object through the approved Storage API and records a byte hash.

Gate: a reviewed `scripts/backup/storage-export.mjs` **does not exist yet**. It
must be implemented, reviewed and tested in a separate change. Required
behavior:

- list buckets through `GET /storage/v1/bucket/`; list objects recursively via
  the documented `POST /storage/v1/object/list/{bucketName}` operation with
  pagination; download each object through its GET route. Use the approved
  API-key type over TLS and send the required
  `apikey` header and use an `Authorization` bearer header only when the chosen
  legacy JWT credential requires it;
- reject absolute paths and any `..` traversal; create directories `0700` and
  files `0600`; never follow symlinks;
- stream bytes; compute SHA-256, size and content type; record bucket, path,
  object ID, version/timestamps where available; do not claim a secret/service
  key is read-only (it bypasses RLS and is highly privileged);
- enforce an endpoint/method allowlist, not a blanket GET-only rule:
  `GET /bucket/`, the documented `POST /object/list/{bucketName}` list operation,
  and the documented `GET` object-download route appropriate to bucket visibility
  (public or authenticated) only; reject upload/update/delete/move/signing
  operations and redirects to unapproved hosts; redact API keys and signed URLs;
  fail on non-2xx responses or incomplete pagination;
- verify downloaded size against metadata and record ETag/version limits;
- write `storage/buckets.json` (JSON array) and
  `storage/storage-manifest.json` (JSON array of objects);
- never print the Storage API key, signed URL or object contents;
- support `--dry-run` inventory and `--bucket` filtering;
- record explicitly when versioning or historical versions are not supported.

Illustrative contract (not implemented, not executed):

```bash
set -Eeuo pipefail
node "$REPO_ROOT/scripts/backup/storage-export.mjs" \
  --url "https://${STAGING_PROJECT_REF}.supabase.co" \
  --key-file "$SECRETS_ROOT/staging-storage-api-key" \
  --out "$BACKUP_ROOT/storage/bytes" \
  --buckets "$BACKUP_ROOT/storage/buckets.json" \
  --manifest "$BACKUP_ROOT/storage/storage-manifest.json" \
  --concurrency 4
```

Effect: HTTPS list/download requests against Staging Storage and local file
writes only. Object listing uses the documented list operation (HTTP POST),
which is read-only in purpose. A secret/service-role key is not intrinsically
read-only; the reviewed exporter must enforce the endpoint/method allowlist and
must never call upload, delete, move, update or bucket-policy endpoints. The
credential remains a high-impact secret and must be separately approved,
short-lived where possible, and revoked/rotated only under the owner's plan.

Cross-check the script's bucket/object inventory against the read-only SQL
inventory from B3. For each object, verify path, size, content type and SHA-256.
A metadata row without bytes, an object not listed in SQL, or a hash mismatch is
a stop.

`supabase storage ls/cp` requires `--experimental`. It may be used only if G7
approves it; it is not the sole evidence path because versioning and metadata
preservation are unverified. Do not run it with `--experimental` merely to avoid
implementing the reviewed export.

### B8 — Encrypt every artifact

Gate: the streaming helper in §5.2 is merged and reviewed. Run from the
repository root but write only to the fresh `$BACKUP_ROOT`.

```bash
set -Eeuo pipefail
umask 077
export REPO_ROOT="$(git rev-parse --show-toplevel)"
test -d "$BACKUP_ROOT" && test ! -L "$BACKUP_ROOT"

# 1) Storage bytes: create a path-preserving archive first.
test ! -e "$BACKUP_ROOT/storage/objects.tar.zst"
tar -C "$BACKUP_ROOT/storage/bytes" -cf - . | \
  zstd -19 -T0 -o "$BACKUP_ROOT/storage/objects.tar.zst"
chmod 600 "$BACKUP_ROOT/storage/objects.tar.zst"
test -s "$BACKUP_ROOT/storage/objects.tar.zst"
# Keep storage/bytes until the archive is encrypted, verified and read back.

# 2) Enumerate first into a private temporary file. A find failure must stop
#    before encryption; process substitution would not reliably propagate it.
TMP_LIST="$(mktemp "${TMPDIR:-/tmp}/crm-backup-inputs.XXXXXX")"
chmod 600 "$TMP_LIST"
trap 'rm -f "$TMP_LIST"' EXIT
find "$BACKUP_ROOT" \
  -path "$BACKUP_ROOT/storage/bytes" -prune -o \
  -path "$BACKUP_ROOT/manifest" -prune -o \
  -type f ! -name '*.aesgcm' -print0 > "$TMP_LIST"

# 3) Encrypt each plaintext artifact. Fresh output paths are mandatory.
while IFS= read -r -d '' f; do
  test ! -e "$f.aesgcm" && test ! -L "$f.aesgcm"
  node "$REPO_ROOT/scripts/backup/aesgcm-stream.mjs" encrypt \
    --in "$f" \
    --out "$f.aesgcm" \
    --key-file "$KEY_FILE" \
    --backup-id "$BACKUP_ID" \
    --artifact "${f#"$BACKUP_ROOT"/}"
done < "$TMP_LIST"
rm -f "$TMP_LIST"
trap - EXIT

# 4) B9 builds the manifest and checksum set; B10/R1 then run the helper's
#    `verify-set` mode to authenticate all envelopes, compare AAD/hashes and
#    check nonce uniqueness. Do not transfer or delete plaintext before it passes.
```

Effect: compresses Storage bytes, encrypts local plaintext artifacts and
authenticates them. Plaintext must be deleted only after the ciphertext
checksum and an independent decrypt test succeed.

Do not encrypt the manifest into itself. Build the manifest after all other
artifact hashes are known, encrypt it as its own artifact, then write
`SHA256SUMS`. The manifest's authenticated envelope AAD supplies the bootstrap
plaintext hash/length needed to decrypt the manifest itself.

### B9 — Build the manifest and checksum set

`manifest/backup-manifest.json` must contain at least one entry per artifact,
including the Storage archive, storage manifest, bucket inventory, config
inventory and database archives. Replace every placeholder and `null` with the
measured value before the manifest is accepted. `null` is illustrative only and is not valid in a final
manifest. Example shape (one artifact shown):

```json
{
  "format": "crm-staging-backup-manifest/v1",
  "backupId": "<UTC timestamp>-<UUID>",
  "source": {
    "projectRef": "qmhfmgkymjgoevwmkidm",
    "environment": "staging",
    "branch": "meta_ads_integration",
    "auditBaselineCommit": "0d21bb89b97cdcd1b82f08a72149e68f87b8ae2f",
    "snapshotCommit": "e51a5989143582af0885ba5ee26644a68b388995",
    "historicalReviewCommit": "63710e6",
    "commitFullSha": "<full 40-character SHA captured at execution>",
    "serverVersion": "17.11",
    "dumpToolVersion": "17.11"
  },
  "window": {
    "fenceStart": "<captured UTC from B1>",
    "checkpointAt": "<captured UTC from B2>",
    "snapshotAt": "<measured dump snapshot UTC>",
    "fenceEndRecord": "closeout/backup-closeout.json.aesgcm",
    "rpoAssessment": "pending-measurement-at-B13"
  },
  "artifacts": [
    {
      "path": "db/app.dump.aesgcm",
      "kind": "pg_dump_custom",
      "encryption": "AES-256-GCM",
      "formatVersion": 1,
      "nonceHex": "<24 hex characters from the authenticated envelope header>",
      "plaintextBytes": null,
      "plaintextSha256": "<hex>",
      "ciphertextBytes": null,
      "ciphertextSha256": "<hex>",
      "aad": "v1|backup=...|artifact=db/app.dump|bytes=...|sha256=..."
    }
  ],
  "database": {
    "ledgerRows": null,
    "ledgerFirstVersion": "<measured>",
    "ledgerLastVersion": "<measured>",
    "appTableCount": null,
    "appRowCount": null,
    "sequenceCount": null,
    "largeObjectCount": null,
    "extensionCount": null
  },
  "storage": {
    "bucketCount": null,
    "objectCount": null,
    "totalBytes": null,
    "manifestPlaintextSha256": "<hex>"
  },
  "keys": {
    "algorithm": "AES-256-GCM",
    "fingerprint": "<sha256 of key file>",
    "custodians": ["<name A>", "<name B>"]
  },
  "approvals": { "backupOwner": "<name>", "operationsApprover": "<name>" }
}
```

Before encryption, replace every `null` and placeholder with measured values;
no baseline count is copied forward without a fresh checkpoint. The main backup
manifest is finalized before B12, so it MUST NOT claim a `fenceEnd` or measured
RPO that does not yet exist. B12 creates a separately encrypted supplemental
closeout record after the actual fence end; B13 adds measured RPO/RTO evidence. The manifest
lists every encrypted artifact except itself and includes each artifact's nonce,
plaintext/ciphertext byte counts, SHA-256, format version, relative path and AAD.
Verify that all listed nonce values are unique and that the manifest's own header nonce is also unique (the manifest cannot self-record its own nonce). `SHA256SUMS` includes every encrypted artifact, including the encrypted
manifest, but explicitly prunes `storage/bytes/` so a raw customer object whose
filename happens to end in `.aesgcm` is never mistaken for an encrypted backup
artifact. It does not include itself. Backup artifact filenames are restricted
  to the documented fixed relative paths and may not contain newline characters.

```bash
set -Eeuo pipefail
umask 077
test -f "$BACKUP_ROOT/manifest/backup-manifest.json"
test ! -e "$BACKUP_ROOT/manifest/backup-manifest.json.aesgcm"
test ! -e "$BACKUP_ROOT/manifest/SHA256SUMS"
node "$REPO_ROOT/scripts/backup/aesgcm-stream.mjs" encrypt \
  --in "$BACKUP_ROOT/manifest/backup-manifest.json" \
  --out "$BACKUP_ROOT/manifest/backup-manifest.json.aesgcm" \
  --key-file "$KEY_FILE" \
  --backup-id "$BACKUP_ID" \
  --artifact "manifest/backup-manifest.json"

# SHA-256 over every ciphertext artifact, including the encrypted manifest.
( cd "$BACKUP_ROOT" && \
  find . -path './storage/bytes' -prune -o -type f -name '*.aesgcm' -print | \
  LC_ALL=C sort | while IFS= read -r f; do shasum -a 256 "$f"; done \
  > manifest/SHA256SUMS )
( cd "$BACKUP_ROOT" && shasum -a 256 -c manifest/SHA256SUMS )
chmod 600 "$BACKUP_ROOT/manifest/SHA256SUMS"
```

Do not remove the plaintext manifest here. Keep it only in the protected
working area until B10/B11 verification completes; delete it with the guarded
plaintext cleanup in B11.

Keep an unencrypted, non-sensitive index with artifact names and ciphertext
hashes if needed for transfer validation. Do not put object paths, row data or
key material in the clear index.

### B10 — Verify before declaring success

Required checks:

- `SHA256SUMS` verifies every ciphertext;
- every artifact envelope has a distinct 12-byte nonce under the backup-set key;
  the decrypted manifest's `nonceHex` values match the envelope headers;
- independent recovery owner decrypts at least the database archive, the
  Storage byte archive and the storage manifest into a separate restricted
  verification directory, verifies plaintext SHA-256, then deletes only that
  independent verification copy; if large objects exist, independently decrypt
  and verify the OID/size/SHA-256 manifest too;
- extracting the Storage byte archive into an isolated temp directory and
  hashing every file reproduces `storage-manifest.json` exactly: same set of
  bucket/path entries, sizes and SHA-256 values, with no extra or missing file;
- `pg_restore --list` on the decrypted database archive shows all required
  objects;
- ledger JSON has the exact row count/versions/hashes from the fresh B3
  `validation/ledger.json`; the historical 21-row snapshot is not hard-coded;
- if any large objects exist, OID/byte-count/SHA-256 manifest matches after
  restore; otherwise the source count is explicitly zero;
- bucket/object inventory matches the checkpoint;
- no secret, token, password, signed URL or private row appears in logs,
  filenames, manifest or report;
- artifact permissions are `0600`/`0700` and the storage volume is encrypted;
- the local artifact set is complete and internally consistent; offsite
  transfer and read-back are B11.

If any check fails, do not delete the plaintext or source; stop and investigate.

Do not remove plaintext in B10. Plaintext cleanup occurs once, in B11, only
after the independent recovery-owner decrypt and offsite read-back both pass.
Do not delete the source project, key copies or encrypted artifacts before the
retention/rollback window closes.

### B11 — Transfer and retain

Copy ciphertext + `SHA256SUMS` + encrypted manifest to the approved offsite
location. Verify by reading back and checking checksums from the destination.
Keep the key separate. Apply retention/object-lock per G5.

Only after the destination read-back verifies, remove local plaintext working
copies with the guarded, explicit-path cleanup below. The two small checkpoint
files `validation/fence-start.txt` and `validation/checkpoint.json` are the sole
intentional plaintext exceptions; retain them until B12 creates and seals the
supplemental fence-end closeout, then remove them only after its read-back passes. If read-back fails,
preserve everything and stop. Never use an unrestricted `find ... -delete` or
`rm -rf` with an unchecked variable.

```bash
set -Eeuo pipefail
assert_backup_root() {
  test -n "$BACKUP_ID"
  test "$STAGING_PROJECT_REF" = "qmhfmgkymjgoevwmkidm"
  test "$BACKUP_ROOT" = "$HOME/.crm-backup/$STAGING_PROJECT_REF/$BACKUP_ID"
  test ! -L "$HOME/.crm-backup"
  test ! -L "$HOME/.crm-backup/$STAGING_PROJECT_REF"
  test -d "$BACKUP_ROOT" && test ! -L "$BACKUP_ROOT"
  test -f "$BACKUP_ROOT/manifest/SHA256SUMS"
  test -f "$BACKUP_ROOT/manifest/backup-manifest.json.aesgcm"
}
assert_backup_root

# Every existing plaintext file must have its encrypted counterpart first.
for f in \
  "$BACKUP_ROOT/db/app.dump" \
  "$BACKUP_ROOT/db/managed-data.dump" \
  "$BACKUP_ROOT/db/roles.sql" \
  "$BACKUP_ROOT/db/large-objects-manifest.json" \
  "$BACKUP_ROOT/storage/objects.tar.zst" \
  "$BACKUP_ROOT/storage/storage-manifest.json" \
  "$BACKUP_ROOT/storage/buckets.json" \
  "$BACKUP_ROOT/config/project-config.redacted.json" \
  "$BACKUP_ROOT/config/extensions.json" \
  "$BACKUP_ROOT/config/platform-inventory.json" \
  "$BACKUP_ROOT/sql/inventory.sql" \
  "$BACKUP_ROOT/sql/checkpoint.sql" \
  "$BACKUP_ROOT/sql/fingerprint.sql" \
  "$BACKUP_ROOT/sql/managed-customizations.sql" \
  "$BACKUP_ROOT/sql/catalog-details.sql" \
  "$BACKUP_ROOT/sql/validate.sql" \
  "$BACKUP_ROOT/validation/app.toc.txt" \
  "$BACKUP_ROOT/validation/inventory.txt" \
  "$BACKUP_ROOT/validation/source-fingerprint.json" \
  "$BACKUP_ROOT/validation/conninfo.txt" \
  "$BACKUP_ROOT/validation/db-identity.json" \
  "$BACKUP_ROOT/validation/pg-image-digests.json" \
  "$BACKUP_ROOT/validation/pg-dump-version.txt" \
  "$BACKUP_ROOT/validation/pg-restore-version.txt" \
  "$BACKUP_ROOT/validation/psql-version.txt" \
  "$BACKUP_ROOT/validation/wal-checkpoint.json" \
  "$BACKUP_ROOT/validation/supabase-cli-version.txt" \
  "$BACKUP_ROOT/validation/docker-version.txt" \
  "$BACKUP_ROOT/validation/node-version.txt" \
  "$BACKUP_ROOT/validation/fence-start.txt" \
  "$BACKUP_ROOT/validation/approved-write-groups-source.json" \
  "$BACKUP_ROOT/validation/approved-write-groups.json" \
  "$BACKUP_ROOT/validation/checkpoint.json" \
  "$BACKUP_ROOT/validation/ledger.json" \
  "$BACKUP_ROOT/validation/counts.json" \
  "$BACKUP_ROOT/validation/catalog-fingerprint.json" \
  "$BACKUP_ROOT/validation/owner-inventory.json" \
  "$BACKUP_ROOT/validation/vault-inventory.json" \
  "$BACKUP_ROOT/validation/cron-inventory.json" \
  "$BACKUP_ROOT/validation/catalog-details.json" \
  "$BACKUP_ROOT/validation/managed-customizations.json" \
  "$BACKUP_ROOT/validation/roles-inventory.json" \
  "$BACKUP_ROOT/validation/roles-status.json" \
  "$BACKUP_ROOT/logs/operator.log" \
  "$BACKUP_ROOT/logs/checkpoint.stderr" \
  "$BACKUP_ROOT/logs/wal-checkpoint.stderr" \
  "$BACKUP_ROOT/logs/managed-customizations.stderr" \
  "$BACKUP_ROOT/logs/catalog-details.stderr" \
  "$BACKUP_ROOT/logs/roles-inventory.stderr" \
  "$BACKUP_ROOT/logs/source-fingerprint.stderr" \
  "$BACKUP_ROOT/logs/roles-export.stderr" \
  "$BACKUP_ROOT/manifest/backup-manifest.json"; do
  if test -e "$f"; then
    test ! -L "$f" || { echo "refusing symlink plaintext: $f" >&2; exit 1; }
    test -f "$f.aesgcm" && test ! -L "$f.aesgcm" || { echo "missing/unsafe encrypted counterpart: $f" >&2; exit 1; }
  fi
done
test -f "$BACKUP_ROOT/storage/objects.tar.zst.aesgcm"
test -d "$BACKUP_ROOT/storage" && test ! -L "$BACKUP_ROOT/storage"
test -d "$BACKUP_ROOT/storage/bytes" && test ! -L "$BACKUP_ROOT/storage/bytes"

rm -f -- \
  "$BACKUP_ROOT/db/app.dump" \
  "$BACKUP_ROOT/db/managed-data.dump" \
  "$BACKUP_ROOT/db/roles.sql" \
  "$BACKUP_ROOT/db/large-objects-manifest.json" \
  "$BACKUP_ROOT/storage/objects.tar.zst" \
  "$BACKUP_ROOT/storage/storage-manifest.json" \
  "$BACKUP_ROOT/storage/buckets.json" \
  "$BACKUP_ROOT/config/project-config.redacted.json" \
  "$BACKUP_ROOT/config/extensions.json" \
  "$BACKUP_ROOT/config/platform-inventory.json" \
  "$BACKUP_ROOT/sql/inventory.sql" \
  "$BACKUP_ROOT/sql/checkpoint.sql" \
  "$BACKUP_ROOT/sql/fingerprint.sql" \
  "$BACKUP_ROOT/sql/catalog-details.sql" \
  "$BACKUP_ROOT/sql/managed-customizations.sql" \
  "$BACKUP_ROOT/sql/validate.sql" \
  "$BACKUP_ROOT/validation/app.toc.txt" \
  "$BACKUP_ROOT/validation/inventory.txt" \
  "$BACKUP_ROOT/validation/source-fingerprint.json" \
  "$BACKUP_ROOT/validation/conninfo.txt" \
  "$BACKUP_ROOT/validation/db-identity.json" \
  "$BACKUP_ROOT/validation/pg-image-digests.json" \
  "$BACKUP_ROOT/validation/pg-dump-version.txt" \
  "$BACKUP_ROOT/validation/pg-restore-version.txt" \
  "$BACKUP_ROOT/validation/psql-version.txt" \
  "$BACKUP_ROOT/validation/wal-checkpoint.json" \
  "$BACKUP_ROOT/validation/supabase-cli-version.txt" \
  "$BACKUP_ROOT/validation/docker-version.txt" \
  "$BACKUP_ROOT/validation/node-version.txt" \
  "$BACKUP_ROOT/validation/ledger.json" \
  "$BACKUP_ROOT/validation/counts.json" \
  "$BACKUP_ROOT/validation/catalog-fingerprint.json" \
  "$BACKUP_ROOT/validation/owner-inventory.json" \
  "$BACKUP_ROOT/validation/vault-inventory.json" \
  "$BACKUP_ROOT/validation/cron-inventory.json" \
  "$BACKUP_ROOT/validation/catalog-details.json" \
  "$BACKUP_ROOT/validation/managed-customizations.json" \
  "$BACKUP_ROOT/validation/roles-inventory.json" \
  "$BACKUP_ROOT/validation/roles-status.json" \
  "$BACKUP_ROOT/logs/operator.log" \
  "$BACKUP_ROOT/logs/checkpoint.stderr" \
  "$BACKUP_ROOT/logs/wal-checkpoint.stderr" \
  "$BACKUP_ROOT/logs/managed-customizations.stderr" \
  "$BACKUP_ROOT/logs/catalog-details.stderr" \
  "$BACKUP_ROOT/logs/roles-inventory.stderr" \
  "$BACKUP_ROOT/logs/source-fingerprint.stderr" \
  "$BACKUP_ROOT/logs/roles-export.stderr" \
  "$BACKUP_ROOT/manifest/backup-manifest.json"
rm -rf -- "$BACKUP_ROOT/storage/bytes"
```

Review the explicit path list against the actual artifact inventory before
running it. If an artifact is added to the layout, add its plaintext and
counterpart to this reviewed cleanup list before execution.

Record:

- source and destination artifact IDs;
- transfer time and operator;
- checksum verification result;
- retention expiry;
- deletion date for local working copies, after the retention/rollback
  window.

### B12 — Capture fence end, re-enable in groups, then seal closeout

Only after the backup owner and operations approver sign the checkpoint. This
phase has two distinct moments and MUST NOT collapse them into one timestamp:

1. Immediately before the first write-capable group is re-enabled, persist
   `FENCE_END_UTC`. This is the global fence-end timestamp. Do not capture it
   again later.
2. Re-enable each worker/webhook/scheduler/provider-send group in the exact
   owner-approved order. Record both `enableStartedAt` (captured immediately
   before the enable action) and `enableConfirmedAt` (captured only after the
   action succeeds), together with the operation evidence reference. The first
   group's `enableStartedAt` is the conservative global `FENCE_END_UTC`.
3. Only after all approved groups have been re-enabled, create the supplemental
   closeout record. `closeoutCreatedAt` is captured at that later time and is
   never substituted for `fenceEnd`.
4. Upload/read back the closeout and the complete encrypted artifact set through
   the owner-approved offsite adapter. A checksum of one object is not proof
   that the complete bundle was retained.

The first code block below is a checkpoint immediately before the first
write-capable group is enabled. The operator performs the approved enable action
outside this runbook, then appends the successful transition record. Do not
continue if the first enable action fails or if the timestamp file cannot be
persisted.

```bash
set -Eeuo pipefail
set -o noclobber
: "${BACKUP_ROOT:?}" "${BACKUP_ID:?}" "${FIRST_WRITE_GROUP:?}"
test -d "$BACKUP_ROOT" && test ! -L "$BACKUP_ROOT"
APPROVED_FIRST_GROUP="$(jq -er '.approvedGroups[0]' "$BACKUP_ROOT/validation/approved-write-groups.json")"
APPROVED_GROUPS_SOURCE_PLAINTEXT_SHA256="$(shasum -a 256 "$BACKUP_ROOT/validation/approved-write-groups-source.json" | awk '{print $1}')"
: "${APPROVED_GROUPS_TRUST_ROOT_FILE:?independently approved signer trust root}"
test -f "$APPROVED_GROUPS_TRUST_ROOT_FILE" && test ! -L "$APPROVED_GROUPS_TRUST_ROOT_FILE"
node "$REPO_ROOT/scripts/backup/fence-transitions.mjs" validate-approval \
  --source "$BACKUP_ROOT/validation/approved-write-groups-source.json" \
  --inventory "$BACKUP_ROOT/validation/approved-write-groups.json" \
  --source-plaintext-sha256 "$APPROVED_GROUPS_SOURCE_PLAINTEXT_SHA256" \
  --trust-root-file "$APPROVED_GROUPS_TRUST_ROOT_FILE" \
  --backup-id "$BACKUP_ID" --project-ref "$STAGING_PROJECT_REF" \
  --require-exactly-one-json-document --verify-approval-evidence
test "$FIRST_WRITE_GROUP" = "$APPROVED_FIRST_GROUP"
test -f "$BACKUP_ROOT/validation/fence-start.txt"
test -f "$BACKUP_ROOT/validation/checkpoint.json"
if test -e "$BACKUP_ROOT/closeout"; then
  test -d "$BACKUP_ROOT/closeout" && test ! -L "$BACKUP_ROOT/closeout"
else
  mkdir -m 700 "$BACKUP_ROOT/closeout"
fi
test ! -e "$BACKUP_ROOT/validation/fence-end.txt"
test ! -e "$BACKUP_ROOT/validation/fence-group-transitions.jsonl"
: > "$BACKUP_ROOT/validation/fence-group-transitions.jsonl"
chmod 600 "$BACKUP_ROOT/validation/fence-group-transitions.jsonl"
FENCE_END_UTC="$(node -e 'process.stdout.write(new Date().toISOString())')"
FENCE_END_TMP="$BACKUP_ROOT/validation/fence-end.txt.tmp"
test ! -e "$FENCE_END_TMP"
printf '%s\n' "$FENCE_END_UTC" > "$FENCE_END_TMP"
chmod 600 "$FENCE_END_TMP"
mv "$FENCE_END_TMP" "$BACKUP_ROOT/validation/fence-end.txt"
# The first group timestamp is already persisted as fence-end. Perform the
# separately approved first-group enable action now. Do not append a successful
# transition until the operation has actually succeeded.
```

After the first group has been re-enabled successfully, append a transition
record. The timestamp before enable and the time at which the operator confirms
success are separate fields. `enableEvidenceRef` must point to the approved
change record/event log proving the action succeeded; it is not a free-form
claim that an action happened:

```bash
set -Eeuo pipefail
: "${BACKUP_ROOT:?}" "${FIRST_WRITE_GROUP:?}" "${FIRST_ENABLE_EVIDENCE_REF:?}"
FENCE_END_UTC="$(cat "$BACKUP_ROOT/validation/fence-end.txt")"
APPROVED_FIRST_GROUP="$(jq -er '.approvedGroups[0]' "$BACKUP_ROOT/validation/approved-write-groups.json")"
test "$FIRST_WRITE_GROUP" = "$APPROVED_FIRST_GROUP"
ENABLE_CONFIRMED_AT="$(node -e 'process.stdout.write(new Date().toISOString())')"
jq -cn --arg backupId "$BACKUP_ID" --arg projectRef "$STAGING_PROJECT_REF" \
  --arg group "$FIRST_WRITE_GROUP" --arg started "$FENCE_END_UTC" \
  --arg confirmed "$ENABLE_CONFIRMED_AT" --arg evidence "$FIRST_ENABLE_EVIDENCE_REF" \
  '{backupId:$backupId,projectRef:$projectRef,group:$group,enableStartedAt:$started,enableConfirmedAt:$confirmed,enableEvidenceRef:$evidence,globalFenceEnd:true}' \
  >> "$BACKUP_ROOT/validation/fence-group-transitions.jsonl"
node "$REPO_ROOT/scripts/backup/fence-transitions.mjs" validate-prefix \
  --approved-groups "$BACKUP_ROOT/validation/approved-write-groups.json" \
  --approval-source "$BACKUP_ROOT/validation/approved-write-groups-source.json" \
  --transitions-jsonl "$BACKUP_ROOT/validation/fence-group-transitions.jsonl" \
  --backup-id "$BACKUP_ID" --project-ref "$STAGING_PROJECT_REF" \
  --fence-end "$FENCE_END_UTC" > /dev/null
```

For each subsequent group, persist a pending JSON record that binds the exact
approved group name to its start timestamp. Append a success transition only
after the owner-approved enable operation has succeeded and an evidence
reference is available. A pending record is a hard stop, never a successful
transition. After each successful append, run `validate-prefix`; do not begin
the next group's enable action unless the helper accepts the current prefix:

```bash
set -Eeuo pipefail
: "${BACKUP_ROOT:?}" "${GROUP_NAME:?}"
PENDING_TRANSITION="$BACKUP_ROOT/validation/next-group-transition.pending"
test ! -e "$PENDING_TRANSITION"
TRANSITION_COUNT="$(wc -l < "$BACKUP_ROOT/validation/fence-group-transitions.jsonl" | tr -d '[:space:]')"
test "$TRANSITION_COUNT" -ge 1
EXPECTED_GROUP="$(jq -er --argjson index "$TRANSITION_COUNT" '.approvedGroups[$index] // empty' "$BACKUP_ROOT/validation/approved-write-groups.json")"
test "$GROUP_NAME" = "$EXPECTED_GROUP"
GROUP_ENABLE_STARTED_AT="$(node -e 'process.stdout.write(new Date().toISOString())')"
jq -n --arg backupId "$BACKUP_ID" --arg projectRef "$STAGING_PROJECT_REF" \
  --arg group "$GROUP_NAME" --arg started "$GROUP_ENABLE_STARTED_AT" \
  '{backupId:$backupId,projectRef:$projectRef,group:$group,enableStartedAt:$started}' > "$PENDING_TRANSITION"
chmod 600 "$PENDING_TRANSITION"
node "$REPO_ROOT/scripts/backup/fence-transitions.mjs" validate-pending \
  --approved-groups "$BACKUP_ROOT/validation/approved-write-groups.json" \
  --approval-source "$BACKUP_ROOT/validation/approved-write-groups-source.json" \
  --transitions-jsonl "$BACKUP_ROOT/validation/fence-group-transitions.jsonl" \
  --pending "$PENDING_TRANSITION" \
  --backup-id "$BACKUP_ID" --project-ref "$STAGING_PROJECT_REF" \
  --fence-end "$(cat "$BACKUP_ROOT/validation/fence-end.txt")" > /dev/null
# Perform the separately approved enable action for GROUP_NAME now.
# Only after it succeeds, run the append block below.
```

```bash
set -Eeuo pipefail
: "${BACKUP_ROOT:?}" "${GROUP_NAME:?}" "${ENABLE_EVIDENCE_REF:?}"
PENDING_TRANSITION="$BACKUP_ROOT/validation/next-group-transition.pending"
test -f "$PENDING_TRANSITION" && test ! -L "$PENDING_TRANSITION"
PENDING_JSON="$(cat "$PENDING_TRANSITION")"
test "$(jq -er '.group' <<< "$PENDING_JSON")" = "$GROUP_NAME"
ENABLE_CONFIRMED_AT="$(node -e 'process.stdout.write(new Date().toISOString())')"
jq -e --arg backupId "$BACKUP_ID" --arg projectRef "$STAGING_PROJECT_REF" \
  --arg group "$GROUP_NAME" \
  '.backupId == $backupId and .projectRef == $projectRef and .group == $group' \
  <<< "$PENDING_JSON" > /dev/null
jq -cn --argjson pending "$PENDING_JSON" --arg confirmed "$ENABLE_CONFIRMED_AT" \
  --arg evidence "$ENABLE_EVIDENCE_REF" \
  '$pending + {enableConfirmedAt:$confirmed,enableEvidenceRef:$evidence,globalFenceEnd:false}' \
  >> "$BACKUP_ROOT/validation/fence-group-transitions.jsonl"
rm -f -- "$PENDING_TRANSITION"
node "$REPO_ROOT/scripts/backup/fence-transitions.mjs" validate-prefix \
  --approved-groups "$BACKUP_ROOT/validation/approved-write-groups.json" \
  --approval-source "$BACKUP_ROOT/validation/approved-write-groups-source.json" \
  --transitions-jsonl "$BACKUP_ROOT/validation/fence-group-transitions.jsonl" \
  --backup-id "$BACKUP_ID" --project-ref "$STAGING_PROJECT_REF" \
  --fence-end "$(cat "$BACKUP_ROOT/validation/fence-end.txt")" > /dev/null
```

After all approved groups have been re-enabled successfully, create and seal the
closeout. B12 must reject a leftover pending file and must use one canonical
transition snapshot for both validation and the closeout payload. The
`fence-transitions.mjs` helper reads the JSONL once, validates every record
against the owner-approved ordered inventory, and writes the canonical JSON
array to stdout. It is a required, currently unimplemented helper contract.
The offsite adapter must also persist/read back the read-back receipt itself
and publish the finalization receipt into an independent recovery-evidence
registry; a local receipt file alone is not durable recovery evidence.

```bash
set -Eeuo pipefail
set -o noclobber
: "${BACKUP_ROOT:?}" "${BACKUP_ID:?}" "${STAGING_PROJECT_REF:?}"
: "${KEY_FILE:?}" "${REPO_ROOT:?}"
: "${OFFSITE_APPROVED_DESTINATION_RECORD:?}"
FENCE_END_UTC="$(cat "$BACKUP_ROOT/validation/fence-end.txt")"
FENCE_START_UTC="$(cat "$BACKUP_ROOT/validation/fence-start.txt")"
CHECKPOINT_UTC="$(jq -er '.checkpointAt' "$BACKUP_ROOT/validation/checkpoint.json")"
PENDING_TRANSITION="$BACKUP_ROOT/validation/next-group-transition.pending"
if test -e "$PENDING_TRANSITION" || test -L "$PENDING_TRANSITION"; then
  echo "pending group transition exists; refusing closeout" >&2
  exit 1
fi
# The helper reads JSONL exactly once, rejects malformed/blank/duplicate rows,
# and emits the validated canonical array. The same bytes are embedded below.
GROUP_TRANSITIONS_JSON="$(node "$REPO_ROOT/scripts/backup/fence-transitions.mjs" validate-jsonl \
  --approved-groups "$BACKUP_ROOT/validation/approved-write-groups.json" \
  --approval-source "$BACKUP_ROOT/validation/approved-write-groups-source.json" \
  --transitions-jsonl "$BACKUP_ROOT/validation/fence-group-transitions.jsonl" \
  --pending-path "$PENDING_TRANSITION" \
  --backup-id "$BACKUP_ID" --project-ref "$STAGING_PROJECT_REF" \
  --fence-end "$FENCE_END_UTC")"
jq -e 'type == "array" and length > 0' <<< "$GROUP_TRANSITIONS_JSON" > /dev/null
CLOSEOUT_CREATED_AT="$(node -e 'process.stdout.write(new Date().toISOString())')"
test ! -e "$BACKUP_ROOT/closeout/backup-closeout.json"
test ! -e "$BACKUP_ROOT/closeout/backup-closeout.json.aesgcm"
jq -n \
  --arg backupId "$BACKUP_ID" \
  --arg projectRef "$STAGING_PROJECT_REF" \
  --arg fenceStart "$FENCE_START_UTC" \
  --arg checkpointAt "$CHECKPOINT_UTC" \
  --arg fenceEnd "$FENCE_END_UTC" \
  --arg closeoutCreatedAt "$CLOSEOUT_CREATED_AT" \
  --argjson groupTransitions "$GROUP_TRANSITIONS_JSON" \
  '{format:"crm-staging-backup-closeout/v3",backupId:$backupId,projectRef:$projectRef,window:{fenceStart:$fenceStart,checkpointAt:$checkpointAt,fenceEnd:$fenceEnd,closeoutCreatedAt:$closeoutCreatedAt,groupTransitions:$groupTransitions,pendingTransitionCount:0},rpoAssessment:"pending-independent-measurement-at-B13"}' \
  > "$BACKUP_ROOT/closeout/backup-closeout.json"
node "$REPO_ROOT/scripts/backup/fence-transitions.mjs" validate-closeout \
  --approved-groups "$BACKUP_ROOT/validation/approved-write-groups.json" \
  --approval-source "$BACKUP_ROOT/validation/approved-write-groups-source.json" \
  --closeout "$BACKUP_ROOT/closeout/backup-closeout.json" \
  --backup-id "$BACKUP_ID" --project-ref "$STAGING_PROJECT_REF"
chmod 600 "$BACKUP_ROOT/closeout/backup-closeout.json"
node "$REPO_ROOT/scripts/backup/aesgcm-stream.mjs" encrypt \
  --in "$BACKUP_ROOT/closeout/backup-closeout.json" \
  --out "$BACKUP_ROOT/closeout/backup-closeout.json.aesgcm" \
  --key-file "$KEY_FILE" --backup-id "$BACKUP_ID" \
  --artifact "closeout/backup-closeout.json"
node "$REPO_ROOT/scripts/backup/aesgcm-stream.mjs" decrypt \
  --in "$BACKUP_ROOT/closeout/backup-closeout.json.aesgcm" \
  --out "$BACKUP_ROOT/closeout/backup-closeout.roundtrip.json" \
  --key-file "$KEY_FILE" --backup-id "$BACKUP_ID" \
  --artifact "closeout/backup-closeout.json"
cmp -s "$BACKUP_ROOT/closeout/backup-closeout.json" \
  "$BACKUP_ROOT/closeout/backup-closeout.roundtrip.json"
rm -f -- "$BACKUP_ROOT/closeout/backup-closeout.roundtrip.json"

# The owner-approved adapter uploads every main-manifest-listed ciphertext,
# the encrypted main manifest, manifest/SHA256SUMS and the closeout ciphertext
# to the approved immutable destination, reads each object back, and writes a
# provider-backed receipt. The receipt itself is then
# separately uploaded/read back at an immutable version below. It must not set
# a shell boolean as a substitute for an object/version/retention record.
: "${OFFSITE_APPROVED_DESTINATION_RECORD:?}"
OFFSITE_READBACK_RECEIPT_FILE="$BACKUP_ROOT/closeout/offsite-readback-receipt.json"
test ! -e "$OFFSITE_READBACK_RECEIPT_FILE"
node "$REPO_ROOT/scripts/backup/offsite-bundle.mjs" upload-readback \
  --root "$BACKUP_ROOT" \
  --main-manifest-ciphertext "$BACKUP_ROOT/manifest/backup-manifest.json.aesgcm" \
  --closeout-ciphertext "$BACKUP_ROOT/closeout/backup-closeout.json.aesgcm" \
  --key-file "$KEY_FILE" --backup-id "$BACKUP_ID" \
  --approved-destination-record "$OFFSITE_APPROVED_DESTINATION_RECORD" \
  --receipt-out "$OFFSITE_READBACK_RECEIPT_FILE"
test -f "$OFFSITE_READBACK_RECEIPT_FILE" && test ! -L "$OFFSITE_READBACK_RECEIPT_FILE"
jq -e --arg id "$BACKUP_ID" --arg project "$STAGING_PROJECT_REF" \
  '.format == "crm-offsite-readback-receipt/v1" and .backupId == $id and .projectRef == $project and .status == "verified" and (.destinationId | type == "string" and length > 0) and (.destinationPrefix | type == "string" and length > 0) and (.retentionUntil | type == "string" and length > 0) and (.verifiedAt | type == "string" and length > 0) and (.objects | type == "array" and length > 0)' \
  "$BACKUP_ROOT/closeout/offsite-readback-receipt.json" > /dev/null

# The first receipt proves read-back of the main ciphertext set and closeout
# ciphertext. It is itself sensitive integrity evidence and must also be stored
# and read back at an immutable version in the approved destination. The
# returned storage record binds the receipt object's remote key/version/hash.
node "$REPO_ROOT/scripts/backup/offsite-bundle.mjs" store-receipt-readback \
  --receipt "$BACKUP_ROOT/closeout/offsite-readback-receipt.json" \
  --approved-destination-record "$OFFSITE_APPROVED_DESTINATION_RECORD" \
  --storage-record-out "$BACKUP_ROOT/closeout/receipt-storage-record.json"
test -f "$BACKUP_ROOT/closeout/receipt-storage-record.json" \
  && test ! -L "$BACKUP_ROOT/closeout/receipt-storage-record.json"
chmod 600 "$BACKUP_ROOT/closeout/receipt-storage-record.json"

# Persist the receipt-storage record itself at an immutable remote version.
# The returned proof is deliberately separate: it describes the remote object
# version/hash without recursively embedding its own version in the record.
node "$REPO_ROOT/scripts/backup/offsite-bundle.mjs" store-storage-record-readback \
  --storage-record "$BACKUP_ROOT/closeout/receipt-storage-record.json" \
  --approved-destination-record "$OFFSITE_APPROVED_DESTINATION_RECORD" \
  --object-proof-out "$BACKUP_ROOT/closeout/receipt-storage-record-object-proof.json"
test -s "$BACKUP_ROOT/closeout/receipt-storage-record-object-proof.json" \
  && test ! -L "$BACKUP_ROOT/closeout/receipt-storage-record-object-proof.json"
chmod 600 "$BACKUP_ROOT/closeout/receipt-storage-record-object-proof.json"

# Freeze the exact proof bytes before indexing. The proof is serialized once
# by the helper using RFC 8785 JSON Canonicalization Scheme (JCS), UTF-8, with
# NO trailing newline. The helper writes those bytes atomically, then computes
# SHA-256 over that exact file. build-index embeds the exact bytes as base64 and
# separately records the raw-byte SHA-256; it must not parse/re-serialize the
# proof and then claim the reserialized bytes are identical.
node "$REPO_ROOT/scripts/backup/offsite-bundle.mjs" canonicalize-storage-record-proof \
  --proof "$BACKUP_ROOT/closeout/receipt-storage-record-object-proof.json" \
  --format rfc8785-jcs-utf8-no-newline \
  --in-place-atomic
node "$REPO_ROOT/scripts/backup/offsite-bundle.mjs" verify-canonical-storage-record-proof \
  --proof "$BACKUP_ROOT/closeout/receipt-storage-record-object-proof.json" \
  --format rfc8785-jcs-utf8-no-newline

# Build a deterministic index from the authenticated main manifest, every main
# ciphertext file (including sql/ and logs/), the closeout ciphertext, the
# receipt bytes and the provider's immutable storage record for that receipt.
# The index contains proofBytesBase64 = base64(exact proof file bytes) and
# proofSha256 = SHA-256(exact proof file bytes). Recovery decodes the base64
# bytes verbatim; it MUST NOT JSON-serialize the parsed proof object again.
# Normative byte contract:
# - canonicalization output is RFC 8785 JCS over the proof JSON value, UTF-8,
#   with no BOM and no trailing newline;
# - proofBytesBase64 is standard RFC 4648 base64 of those exact bytes (padding
#   required; no embedded whitespace or line wrapping);
# - proofSha256 is lowercase hex SHA-256 over the decoded bytes, not over the
#   base64 text and not over a reserialized JSON object;
# - recovery strictly base64-decodes, checks proofSha256, writes the decoded
#   bytes atomically to the proof path, and verifies the resulting file hash;
# - recovery MUST NOT parse and reserialize the proof before the checksum
#   check. Parsing/schema validation occurs only after byte identity passes.
node "$REPO_ROOT/scripts/backup/offsite-bundle.mjs" build-index \
  --root "$BACKUP_ROOT" \
  --key-file "$KEY_FILE" \
  --backup-id "$BACKUP_ID" \
  --main-manifest-ciphertext "$BACKUP_ROOT/manifest/backup-manifest.json.aesgcm" \
  --receipt "$BACKUP_ROOT/closeout/offsite-readback-receipt.json" \
  --receipt-storage-record "$BACKUP_ROOT/closeout/receipt-storage-record.json" \
  --receipt-storage-record-object-proof "$BACKUP_ROOT/closeout/receipt-storage-record-object-proof.json" \
  --approved-destination-record "$OFFSITE_APPROVED_DESTINATION_RECORD" \
  --out "$BACKUP_ROOT/closeout/offsite-bundle-index.json"
chmod 600 "$BACKUP_ROOT/closeout/offsite-bundle-index.json"

# Checksum entries are relative to BACKUP_ROOT. This exact working directory is
# required both when creating and when verifying the checksum list.
( cd "$BACKUP_ROOT" && shasum -a 256 \
  closeout/backup-closeout.json.aesgcm \
  closeout/offsite-readback-receipt.json \
  closeout/receipt-storage-record.json \
  closeout/receipt-storage-record-object-proof.json \
  closeout/offsite-bundle-index.json > closeout/SHA256SUMS )
chmod 600 "$BACKUP_ROOT/closeout/SHA256SUMS"
( cd "$BACKUP_ROOT" && shasum -a 256 -c closeout/SHA256SUMS )
# The exact closeout directory inventory contains SIX files: the five payload
# files listed in closeout/SHA256SUMS plus SHA256SUMS itself. The checksum file
# cannot checksum itself. The index MUST NOT contain the final checksum file's
# hash/version: that would create a cycle because SHA256SUMS already hashes the
# index. Only the provider-signed finalization receipt, stored outside the
# bundle in the independent recovery-evidence registry, binds both the final
# index and SHA256SUMS hashes, immutable versions and retention. R1 requires all
# six files and verifies the five payload entries in SHA256SUMS.
# Normative exact-set (relative paths under closeout/):
#   backup-closeout.json.aesgcm
#   offsite-readback-receipt.json
#   receipt-storage-record.json
#   receipt-storage-record-object-proof.json
#   offsite-bundle-index.json
#   SHA256SUMS
# SHA256SUMS contains exactly the five payload paths above, in normalized
# relative-path form. It does not contain itself. The index binds its own
# content and the other payload metadata but MUST NOT include SHA256SUMS hash,
# version, or bytes. After the index and checksum file are both uploaded and
# read back, the provider-signed finalization receipt OUTSIDE the bundle binds
# the final index hash/version and final SHA256SUMS hash/version/retention.
# R1 must reject missing, extra, duplicate, symlinked or non-regular entries
# and compare the exact six-name set.

# Upload and read back the index and checksum list. The provider-signed
# finalization receipt is then published to a separately administered recovery
# evidence registry. It is NOT left only on this backup host and is deliberately
# outside BACKUP_ROOT to avoid a recursive receipt-of-receipt dependency.
: "${OFFSITE_FINALIZATION_RECEIPT_FILE:?set external temporary receipt path}"
: "${OFFSITE_RECOVERY_CATALOG_ENTRY_FILE:?set external recovery-catalog entry output}"
: "${OFFSITE_RECOVERY_REGISTRY_APPROVED_RECORD:?set approved independent registry record}"
test -f "$OFFSITE_RECOVERY_REGISTRY_APPROVED_RECORD" && test ! -L "$OFFSITE_RECOVERY_REGISTRY_APPROVED_RECORD"
test "$OFFSITE_FINALIZATION_RECEIPT_FILE" != "$OFFSITE_RECOVERY_CATALOG_ENTRY_FILE"
for evidence_path in "$OFFSITE_FINALIZATION_RECEIPT_FILE" "$OFFSITE_RECOVERY_CATALOG_ENTRY_FILE"; do
  case "$evidence_path" in "$BACKUP_ROOT"/*) echo "recovery evidence must be outside BACKUP_ROOT" >&2; exit 1 ;; esac
  test -d "$(dirname "$evidence_path")" && test ! -L "$(dirname "$evidence_path")"
  test ! -e "$evidence_path" && test ! -L "$evidence_path"
done
node "$REPO_ROOT/scripts/backup/offsite-bundle.mjs" finalize-upload \
  --root "$BACKUP_ROOT" \
  --index "$BACKUP_ROOT/closeout/offsite-bundle-index.json" \
  --checksums "$BACKUP_ROOT/closeout/SHA256SUMS" \
  --approved-destination-record "$OFFSITE_APPROVED_DESTINATION_RECORD" \
  --receipt-out "$OFFSITE_FINALIZATION_RECEIPT_FILE"
test -s "$OFFSITE_FINALIZATION_RECEIPT_FILE" && test ! -L "$OFFSITE_FINALIZATION_RECEIPT_FILE"
node "$REPO_ROOT/scripts/backup/offsite-bundle.mjs" publish-finalization \
  --finalization-receipt "$OFFSITE_FINALIZATION_RECEIPT_FILE" \
  --approved-registry-record "$OFFSITE_RECOVERY_REGISTRY_APPROVED_RECORD" \
  --catalog-entry-out "$OFFSITE_RECOVERY_CATALOG_ENTRY_FILE"
test -s "$OFFSITE_RECOVERY_CATALOG_ENTRY_FILE" && test ! -L "$OFFSITE_RECOVERY_CATALOG_ENTRY_FILE"
node "$REPO_ROOT/scripts/backup/offsite-bundle.mjs" verify-published-finalization \
  --catalog-entry "$OFFSITE_RECOVERY_CATALOG_ENTRY_FILE" \
  --finalization-receipt "$OFFSITE_FINALIZATION_RECEIPT_FILE" \
  --approved-registry-record "$OFFSITE_RECOVERY_REGISTRY_APPROVED_RECORD" \
  --backup-id "$BACKUP_ID" --project-ref "$STAGING_PROJECT_REF"

# Remove plaintext only after the full artifact set, index, receipt and
# finalization record have passed independent read-back verification.
rm -f -- "$BACKUP_ROOT/closeout/backup-closeout.json" \
  "$BACKUP_ROOT/validation/fence-start.txt" \
  "$BACKUP_ROOT/validation/approved-write-groups-source.json" \
  "$BACKUP_ROOT/validation/approved-write-groups.json" \
  "$BACKUP_ROOT/validation/checkpoint.json" \
  "$BACKUP_ROOT/validation/fence-end.txt" \
  "$BACKUP_ROOT/validation/fence-group-transitions.jsonl"
```

The closeout index, receipt bytes, receipt-storage record, checksum and provider
finalization evidence form a single recovery gate. The index does not hash or
version-bind the final SHA256SUMS file; the separately stored provider-signed
finalization receipt binds the final index and checksum hashes/immutable
versions after both have been uploaded and read back. This one-way dependency
avoids a checksum/index cycle. The read-back receipt itself
must be uploaded/read back at the immutable version named in the index. The
provider-signed finalization receipt must be published/read back in the separate
recovery-evidence registry, and the recovery-catalog locator must be retained by
the designated custodians. If any object, locator, hash, version, signature or
retention proof is absent or mismatched, the backup set is incomplete.

A backup taken while writes continued has a non-zero RPO. State it explicitly;
do not claim zero data loss. The closeout record alone does not prove zero RPO;
B13 must reconcile the checkpoint/WAL or approved application write evidence.

### B13 — Record RPO/RTO

Record the actual fence duration from the encrypted B12 closeout, snapshot
time, last committed write before the snapshot, and measured restore duration
once R11 completes. Do not infer RPO from the existence of a write fence alone. Do not
publish a target RTO as measured until the isolated rehearsal finishes.

---

## 7. Restore design

### 7.1 Target requirements

- A **new, empty, disposable** local Supabase stack, project ID
  `crm-restore-rehearsal`, PostgreSQL major version **17**, Storage and Auth
  enabled.
- No `supabase link` to Staging/Production. No production credentials in the
  environment. No shared Docker network with another project.
- Isolated ports (example: API 56321, DB 56322, Studio 56323, Mailpit web UI
  56324, SMTP 56325, POP3 56326, shadow 56320, analytics 56327, pooler 56329,
  Edge Runtime inspector 18083). Verify every port is unused before
  `supabase start`; the prior validation stack used 55321/55322/55324.
- Confirm the Docker engine has sufficient RAM, CPU and free disk for the
  enabled local services and the decrypted archive; stop if resource headroom is
  inadequate. The local stack downloads and starts multiple service images.
- Migrations and seed disabled in the scratch config so the restore is the only
  source of application state.
- All external sends, webhooks and schedulers disabled for the entire restore.
- Teardown with `supabase stop --no-backup` and deletion of decrypted temporary
  files after evidence is captured.

The local stack is not identical to hosted Supabase. Differences in managed
schema versions, extensions, Auth/Storage services, Vault root key and
project-bound settings are recorded as residual risk, not hidden.

### 7.2 Restore order

1. Verify artifact checksums and decrypt all required artifacts.
2. Start the empty target and capture its baseline.
3. Prepare extensions and reviewed custom roles.
4. Restore application **pre-data only** (schemas, types, routines and table definitions); do not load app rows or post-data constraints yet.
5. Restore Storage buckets/objects through the isolated local Storage API, after proving no app row depends on non-preservable source object IDs.
6. Restore Auth through the exact provider-supported path, before app data and FK constraints; account for Auth trigger side effects.
7. Restore application data, then post-data indexes/constraints/triggers; verify FK dependencies and ledger.
8. Apply only classified project customizations in managed schemas; never replay platform-managed DDL.
9. Re-provision Vault/token-encryption dependencies through custody.
10. Validate database, ACL/RLS, ledger, managed customizations, Storage, Auth and app behavior.
11. Record measured RTO/RPO and discrepancies.
12. Tear down the target; retain only approved evidence.

Never restore directly over Staging, Production or an existing developer
database.

---

## 8. Restore procedure

### R0 — Prepare the isolated target

```bash
set -Eeuo pipefail
umask 077
export RESTORE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
export RESTORE_ROOT="$HOME/.crm-restore/$RESTORE_ID"
install -d -m 700 "$HOME/.crm-restore"
test ! -L "$HOME/.crm-restore"
test ! -e "$RESTORE_ROOT" && test ! -L "$RESTORE_ROOT"
mkdir -m 700 "$RESTORE_ROOT"
mkdir -m 700 "$RESTORE_ROOT/evidence"
cd "$RESTORE_ROOT"
supabase init
```

Edit `supabase/config.toml` so it cannot collide with the existing project and
does not apply repository migrations:

```toml
project_id = "crm-restore-rehearsal"

[api]
port = 56321

[db]
port = 56322
shadow_port = 56320
major_version = 17

[db.migrations]
enabled = false

[db.seed]
enabled = false

[studio]
port = 56323

[local_smtp]
port = 56324       # Mailpit web interface, not SMTP
smtp_port = 56325  # SMTP listener used by the local stack
pop3_port = 56326  # POP3 listener, if enabled

[analytics]
port = 56327

[edge_runtime]
inspector_port = 18083

[db.pooler]
enabled = false
port = 56329
```

Before starting, confirm the entire selected port set is free. The prior
`crm-meta-migration-validation` stack used 55321/55322/55324, so this runbook
uses a separate 563xx range. Do not stop another stack to free ports without
its owner's approval.

```bash
set -Eeuo pipefail
command -v lsof >/dev/null
for port in 56320 56321 56322 56323 56324 56325 56326 56327 56329 18083; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "restore port already in use: $port" >&2
    exit 1
  fi
done
```

Start and capture local credentials:

```bash
set -Eeuo pipefail
umask 077
supabase start
test ! -e "$RESTORE_ROOT/local.env"
supabase status -o env > "$RESTORE_ROOT/local.env"
chmod 600 "$RESTORE_ROOT/local.env"
export DB_CONTAINER="$(docker ps --filter 'name=^/supabase_db_crm-restore-rehearsal$' --format '{{.Names}}')"
test "$DB_CONTAINER" = "supabase_db_crm-restore-rehearsal"
```

Effect: creates a disposable local stack. It does not connect to Staging. Do
not print `local.env`; it contains local-only keys.

If `supabase start` applies unexpected migrations, stop and recreate the scratch
directory with an empty `supabase/migrations` and migrations disabled. Do not
proceed with a non-empty baseline.

### R1 — Verify, bootstrap the manifest, decrypt and extract artifacts

R1 restores **all** encrypted source artifacts needed by R5-R10. This includes
the database archive, Storage archive, Storage manifests/buckets, and source
validation evidence. The recovery bundle is bootstrapped from an independently held recovery-catalog
entry. The provider finalization receipt, closeout index/checksum, receipt object
and encrypted artifacts are retrieved by immutable version and verified before
manifest contents are trusted. The manifest is then bootstrapped from its own
authenticated envelope header; no manifest content is trusted before GCM verification.

```bash
set -Eeuo pipefail
umask 077
: "${RESTORE_ROOT:?}" "${BACKUP_ID:?}" "${STAGING_PROJECT_REF:?}"
 : "${OFFSITE_RECOVERY_ROOT:?set a brand-new, empty offsite retrieval directory}"
: "${REPO_ROOT:?}" "${KEY_FILE:?}"
: "${OFFSITE_RECOVERY_CATALOG_ENTRY_FILE:?recover locator from independent recovery custodians}"
: "${OFFSITE_APPROVED_DESTINATION_RECORD:?recover approved destination record}"
: "${OFFSITE_RECOVERY_REGISTRY_APPROVED_RECORD:?recover independent registry trust record}"
: "${OFFSITE_APPROVED_GROUPS_TRUST_ROOT_FILE:?recover owner-approval signer trust root from custodians}"
# Require an absolute retrieval path. Resolve the existing parent physically
# before creating the final component, so a later `cd "$BACKUP_ROOT"` cannot
# reinterpret a relative path and no path component is silently resolved from
# the changed working directory. The parent must already exist and be a real
# directory, not a symlink. The final component must be new and is created
# exclusively with mode 0700.
case "$OFFSITE_RECOVERY_ROOT" in
  /*) ;;
  *) echo "OFFSITE_RECOVERY_ROOT must be an absolute path" >&2; exit 1 ;;
esac
OFFSITE_RECOVERY_PARENT_INPUT="$(dirname "$OFFSITE_RECOVERY_ROOT")" || { echo "cannot derive recovery-root parent" >&2; exit 1; }
OFFSITE_RECOVERY_BASENAME="$(basename "$OFFSITE_RECOVERY_ROOT")" || { echo "cannot derive recovery-root basename" >&2; exit 1; }
test -n "$OFFSITE_RECOVERY_BASENAME" && test "$OFFSITE_RECOVERY_BASENAME" != "." && test "$OFFSITE_RECOVERY_BASENAME" != ".." || { echo "invalid recovery-root basename" >&2; exit 1; }
test -d "$OFFSITE_RECOVERY_PARENT_INPUT" && test ! -L "$OFFSITE_RECOVERY_PARENT_INPUT" || { echo "recovery-root parent must be an existing non-symlink directory" >&2; exit 1; }
OFFSITE_RECOVERY_PARENT="$(cd "$OFFSITE_RECOVERY_PARENT_INPUT" && pwd -P)" || { echo "cannot canonicalize recovery-root parent" >&2; exit 1; }
OFFSITE_RECOVERY_ROOT="${OFFSITE_RECOVERY_PARENT}/${OFFSITE_RECOVERY_BASENAME}"
# RESTORE_ROOT and every external input remain absolute after the later cd.
# No relative path is accepted for any value that will be referenced after a
# working-directory change. Canonicalization is performed before mkdir/cd; the
# canonical absolute values, not the caller's original strings, are retained.
case "$RESTORE_ROOT" in /*) ;; *) echo "RESTORE_ROOT must be absolute" >&2; exit 1 ;; esac
RESTORE_ROOT_PARENT_INPUT="$(dirname "$RESTORE_ROOT")" || { echo "cannot derive restore-root parent" >&2; exit 1; }
RESTORE_ROOT_BASENAME="$(basename "$RESTORE_ROOT")" || { echo "cannot derive restore-root basename" >&2; exit 1; }
RESTORE_ROOT_PARENT="$(cd "$RESTORE_ROOT_PARENT_INPUT" && pwd -P)" || { echo "cannot canonicalize restore-root parent" >&2; exit 1; }
test -n "$RESTORE_ROOT_BASENAME" && test "$RESTORE_ROOT_BASENAME" != "." && test "$RESTORE_ROOT_BASENAME" != ".." || { echo "invalid restore-root basename" >&2; exit 1; }
RESTORE_ROOT="${RESTORE_ROOT_PARENT}/${RESTORE_ROOT_BASENAME}"
REPO_ROOT="$(cd "$REPO_ROOT" && pwd -P)" || { echo "cannot canonicalize repository root" >&2; exit 1; }
canonical_existing_file() {
  # Return one canonical absolute path only after every prerequisite check has
  # succeeded. Do not rely on `set -e`: this function is invoked in command
  # substitutions, where an unchecked intermediate failure can be masked by
  # a later successful printf.
  local input="$1" parent_input parent base
  case "$input" in
    /*) ;;
    *) echo "prerequisite path must be absolute: $input" >&2; return 1 ;;
  esac
  if test -L "$input" || ! test -f "$input"; then
    echo "prerequisite must be an existing regular non-symlink file: $input" >&2
    return 1
  fi
  parent_input="$(dirname "$input")" || {
    echo "cannot derive prerequisite parent: $input" >&2
    return 1
  }
  if ! parent="$(cd "$parent_input" 2>/dev/null && pwd -P)"; then
    echo "cannot canonicalize prerequisite parent: $parent_input" >&2
    return 1
  fi
  if test -z "$parent" || test ! -d "$parent"; then
    echo "canonical prerequisite parent is invalid: $parent_input" >&2
    return 1
  fi
  base="$(basename "$input")" || {
    echo "cannot derive prerequisite basename: $input" >&2
    return 1
  }
  if test -z "$base" || test "$base" = "." || test "$base" = ".."; then
    echo "invalid prerequisite basename: $input" >&2
    return 1
  fi
  printf '%s/%s\n' "$parent" "$base"
}
KEY_FILE="$(canonical_existing_file "$KEY_FILE")" || { echo "invalid KEY_FILE" >&2; exit 1; }
OFFSITE_RECOVERY_CATALOG_ENTRY_FILE="$(canonical_existing_file "$OFFSITE_RECOVERY_CATALOG_ENTRY_FILE")" || { echo "invalid recovery catalog entry" >&2; exit 1; }
OFFSITE_APPROVED_DESTINATION_RECORD="$(canonical_existing_file "$OFFSITE_APPROVED_DESTINATION_RECORD")" || { echo "invalid approved destination record" >&2; exit 1; }
OFFSITE_RECOVERY_REGISTRY_APPROVED_RECORD="$(canonical_existing_file "$OFFSITE_RECOVERY_REGISTRY_APPROVED_RECORD")" || { echo "invalid recovery registry record" >&2; exit 1; }
OFFSITE_APPROVED_GROUPS_TRUST_ROOT_FILE="$(canonical_existing_file "$OFFSITE_APPROVED_GROUPS_TRUST_ROOT_FILE")" || { echo "invalid owner-approval trust root" >&2; exit 1; }
if test -e "$OFFSITE_RECOVERY_ROOT" || test -L "$OFFSITE_RECOVERY_ROOT"; then
  echo "offsite recovery root already exists; refusing to reuse local or stale data" >&2
  exit 1
fi
mkdir -m 700 "$OFFSITE_RECOVERY_ROOT"
BACKUP_ROOT="$OFFSITE_RECOVERY_ROOT"
: "${OFFSITE_RECOVERY_CATALOG_ENTRY_FILE:?recover locator from independent recovery custodians}"
: "${OFFSITE_APPROVED_DESTINATION_RECORD:?recover approved destination record}"
: "${OFFSITE_RECOVERY_REGISTRY_APPROVED_RECORD:?recover independent registry trust record}"
: "${OFFSITE_APPROVED_GROUPS_TRUST_ROOT_FILE:?recover owner-approval signer trust root from custodians}"
test -f "$OFFSITE_APPROVED_GROUPS_TRUST_ROOT_FILE" && test ! -L "$OFFSITE_APPROVED_GROUPS_TRUST_ROOT_FILE"
test -f "$OFFSITE_RECOVERY_REGISTRY_APPROVED_RECORD" && test ! -L "$OFFSITE_RECOVERY_REGISTRY_APPROVED_RECORD"
test -f "$OFFSITE_RECOVERY_CATALOG_ENTRY_FILE" && test ! -L "$OFFSITE_RECOVERY_CATALOG_ENTRY_FILE"
test -f "$OFFSITE_APPROVED_DESTINATION_RECORD" && test ! -L "$OFFSITE_APPROVED_DESTINATION_RECORD"
test -d "$BACKUP_ROOT" && test ! -L "$BACKUP_ROOT"
RECOVERY_ROOT_FIRST_ENTRY="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -print -quit)" || {
  echo "cannot inspect newly-created recovery root" >&2
  exit 1
}
test -z "$RECOVERY_ROOT_FIRST_ENTRY" || {
  echo "new recovery root is not empty" >&2
  exit 1
}
install -d -m 700 "$RESTORE_ROOT/evidence"
OFFSITE_FINALIZATION_RECEIPT_FILE="$RESTORE_ROOT/evidence/offsite-finalization-receipt.json"
test ! -e "$OFFSITE_FINALIZATION_RECEIPT_FILE"
# Bootstrap is performed from the independent recovery-catalog locator, not
# from an assumed local copy. It verifies the registry signature/version,
# fetches the provider finalization receipt, validates it, then retrieves the
# immutable index/checksum, receipt object by its indexed version, closeout
# ciphertext and all manifest-listed ciphertext into BACKUP_ROOT. The helper
# verifies provider versions, byte counts, retention and hashes before return.
node "$REPO_ROOT/scripts/backup/offsite-bundle.mjs" recover-bootstrap \
  --catalog-entry "$OFFSITE_RECOVERY_CATALOG_ENTRY_FILE" \
  --approved-destination-record "$OFFSITE_APPROVED_DESTINATION_RECORD" \
  --approved-registry-record "$OFFSITE_RECOVERY_REGISTRY_APPROVED_RECORD" \
  --backup-id "$BACKUP_ID" --project-ref "$STAGING_PROJECT_REF" \
  --root "$BACKUP_ROOT" \
  --finalization-receipt-out "$OFFSITE_FINALIZATION_RECEIPT_FILE"
test -s "$OFFSITE_FINALIZATION_RECEIPT_FILE" && test ! -L "$OFFSITE_FINALIZATION_RECEIPT_FILE"
cd "$BACKUP_ROOT"
shasum -a 256 -c manifest/SHA256SUMS
mkdir -m 700 "$RESTORE_ROOT/plaintext"

# First decrypt only the manifest. The helper must authenticate its envelope
# AAD/tag and its own byte count/hash before atomically publishing this file.
test ! -e "$RESTORE_ROOT/plaintext/backup-manifest.json"
node "$REPO_ROOT/scripts/backup/aesgcm-stream.mjs" decrypt \
  --in "$BACKUP_ROOT/manifest/backup-manifest.json.aesgcm" \
  --out "$RESTORE_ROOT/plaintext/backup-manifest.json" \
  --key-file "$KEY_FILE" \
  --backup-id "$BACKUP_ID" \
  --artifact "manifest/backup-manifest.json"
chmod 600 "$RESTORE_ROOT/plaintext/backup-manifest.json"
jq -e --arg id "$BACKUP_ID" \
  '.backupId == $id and .source.projectRef == "qmhfmgkymjgoevwmkidm"' \
  "$RESTORE_ROOT/plaintext/backup-manifest.json" > /dev/null

# Authenticate the exact encrypted set, every envelope AAD, all ciphertext
# checksums, and nonce uniqueness before decrypting any other artifact.
node "$REPO_ROOT/scripts/backup/aesgcm-stream.mjs" verify-set \
  --root "$BACKUP_ROOT" \
  --key-file "$KEY_FILE" \
  --manifest "$RESTORE_ROOT/plaintext/backup-manifest.json" \
  --checksums "$BACKUP_ROOT/manifest/SHA256SUMS" \
  --backup-id "$BACKUP_ID" \
  --exclude-prefix "closeout/"

# The supplemental closeout and receipt have their own checksum set and
# authenticated envelope; they are intentionally outside the main manifest's artifact set. The helper
# `verify-set --exclude-prefix closeout/` must reject every other extra path, and
# R1 separately verifies the closeout checksum and GCM authentication.
test -d "$BACKUP_ROOT/closeout" && test ! -L "$BACKUP_ROOT/closeout" || {
  echo "closeout must be an existing non-symlink directory" >&2
  exit 1
}
# Enumerate EVERY direct directory entry, not only regular files. This makes
# directories, FIFOs, sockets, devices and symlinks visible to the exact-set
# validator. Persist find output first so find's own exit status is checked.
CLOSEOUT_ENTRIES_NUL="$RESTORE_ROOT/evidence/closeout-entries.nul"
find "$BACKUP_ROOT/closeout" -mindepth 1 -maxdepth 1 -print0 > "$CLOSEOUT_ENTRIES_NUL" || {
  echo "cannot enumerate closeout directory" >&2
  exit 1
}
CLOSEOUT_ENTRY_COUNT=0
while IFS= read -r -d '' closeout_entry; do
  case "$closeout_entry" in
    "$BACKUP_ROOT/closeout/backup-closeout.json.aesgcm"|\
    "$BACKUP_ROOT/closeout/offsite-readback-receipt.json"|\
    "$BACKUP_ROOT/closeout/receipt-storage-record.json"|\
    "$BACKUP_ROOT/closeout/receipt-storage-record-object-proof.json"|\
    "$BACKUP_ROOT/closeout/offsite-bundle-index.json"|\
    "$BACKUP_ROOT/closeout/SHA256SUMS") ;;
    *) echo "unexpected closeout entry: $closeout_entry" >&2; exit 1 ;;
  esac
  if test -L "$closeout_entry" || ! test -f "$closeout_entry"; then
    echo "closeout entry must be a regular non-symlink file: $closeout_entry" >&2
    exit 1
  fi
  CLOSEOUT_ENTRY_COUNT=$((CLOSEOUT_ENTRY_COUNT + 1))
done < "$CLOSEOUT_ENTRIES_NUL"
test "$CLOSEOUT_ENTRY_COUNT" -eq 6 || {
  echo "closeout must contain exactly six entries" >&2
  exit 1
}
for closeout_required in \
  "$BACKUP_ROOT/closeout/backup-closeout.json.aesgcm" \
  "$BACKUP_ROOT/closeout/offsite-readback-receipt.json" \
  "$BACKUP_ROOT/closeout/receipt-storage-record.json" \
  "$BACKUP_ROOT/closeout/receipt-storage-record-object-proof.json" \
  "$BACKUP_ROOT/closeout/offsite-bundle-index.json" \
  "$BACKUP_ROOT/closeout/SHA256SUMS"; do
  test -f "$closeout_required" && test ! -L "$closeout_required" || {
    echo "required closeout file missing or unsafe: $closeout_required" >&2
    exit 1
  }
done
# shasum -c alone does not enforce an exact list: it accepts a subset and may
# accept duplicate entries. Parse the list, require exactly five unique
# approved relative paths and 64 lowercase hexadecimal digests, then compare
# its path set to the normative payload whitelist before checking the hashes.
ACTUAL_CHECKSUM_PATHS="$RESTORE_ROOT/evidence/closeout-checksum-paths.txt"
EXPECTED_CHECKSUM_PATHS="$RESTORE_ROOT/evidence/expected-closeout-checksum-paths.txt"
awk '
  {
    if (NF != 2 || length($1) != 64 || $1 ~ /[^0-9a-f]/) { bad = 1; next }
    path = $2
    if (path != "closeout/backup-closeout.json.aesgcm" &&
        path != "closeout/offsite-readback-receipt.json" &&
        path != "closeout/receipt-storage-record.json" &&
        path != "closeout/receipt-storage-record-object-proof.json" &&
        path != "closeout/offsite-bundle-index.json") { bad = 1; next }
    if (seen[path]++) { bad = 1; next }
    print path
  }
  END { if (bad || NR != 5) exit 1 }
' "$BACKUP_ROOT/closeout/SHA256SUMS" > "$ACTUAL_CHECKSUM_PATHS" || {
  echo "closeout SHA256SUMS must contain exactly five unique approved entries" >&2
  exit 1
}
printf '%s\n' \
  closeout/backup-closeout.json.aesgcm \
  closeout/offsite-readback-receipt.json \
  closeout/receipt-storage-record.json \
  closeout/receipt-storage-record-object-proof.json \
  closeout/offsite-bundle-index.json | LC_ALL=C sort > "$EXPECTED_CHECKSUM_PATHS" || exit 1
LC_ALL=C sort "$ACTUAL_CHECKSUM_PATHS" -o "$ACTUAL_CHECKSUM_PATHS" || exit 1
cmp -s "$ACTUAL_CHECKSUM_PATHS" "$EXPECTED_CHECKSUM_PATHS" || {
  echo "closeout SHA256SUMS path set differs from the five-payload whitelist" >&2
  exit 1
}
( cd "$BACKUP_ROOT" && shasum -a 256 -c closeout/SHA256SUMS ) || {
  echo "closeout checksum verification failed" >&2
  exit 1
}
: "${OFFSITE_FINALIZATION_RECEIPT_FILE:?recover provider-signed finalization receipt independently}"
: "${OFFSITE_APPROVED_DESTINATION_RECORD:?recover approved destination record}"
test -f "$OFFSITE_FINALIZATION_RECEIPT_FILE" && test ! -L "$OFFSITE_FINALIZATION_RECEIPT_FILE"
test -f "$OFFSITE_APPROVED_DESTINATION_RECORD" && test ! -L "$OFFSITE_APPROVED_DESTINATION_RECORD"
node "$REPO_ROOT/scripts/backup/offsite-bundle.mjs" verify-index \
  --root "$BACKUP_ROOT" \
  --main-manifest "$RESTORE_ROOT/plaintext/backup-manifest.json" \
  --receipt "$BACKUP_ROOT/closeout/offsite-readback-receipt.json" \
  --receipt-storage-record "$BACKUP_ROOT/closeout/receipt-storage-record.json" \
  --receipt-storage-record-object-proof "$BACKUP_ROOT/closeout/receipt-storage-record-object-proof.json" \
  --index "$BACKUP_ROOT/closeout/offsite-bundle-index.json" \
  --checksums "$BACKUP_ROOT/closeout/SHA256SUMS" \
  --finalization-receipt "$OFFSITE_FINALIZATION_RECEIPT_FILE" \
  --catalog-entry "$OFFSITE_RECOVERY_CATALOG_ENTRY_FILE" \
  --approved-destination-record "$OFFSITE_APPROVED_DESTINATION_RECORD" \
  --approved-registry-record "$OFFSITE_RECOVERY_REGISTRY_APPROVED_RECORD" \
  --backup-id "$BACKUP_ID" --project-ref "qmhfmgkymjgoevwmkidm"
# Derive the encrypted artifact set from the authenticated main manifest and
# supplemental closeout index. This includes sql/, logs/, manifest envelope,
# every other manifest-listed main artifact, and the supplemental closeout
# envelope; no manually maintained prefix allowlist is used.
node "$REPO_ROOT/scripts/backup/aesgcm-stream.mjs" verify-nonce-set \
  --root "$BACKUP_ROOT" --key-file "$KEY_FILE" --backup-id "$BACKUP_ID" \
  --manifest "$RESTORE_ROOT/plaintext/backup-manifest.json" \
  --supplemental-index "$BACKUP_ROOT/closeout/offsite-bundle-index.json" \
  --include-manifest-envelope --reject-unlisted
mkdir -m 700 "$RESTORE_ROOT/plaintext/closeout"
test ! -e "$RESTORE_ROOT/plaintext/closeout/backup-closeout.json"
node "$REPO_ROOT/scripts/backup/aesgcm-stream.mjs" decrypt \
  --in "$BACKUP_ROOT/closeout/backup-closeout.json.aesgcm" \
  --out "$RESTORE_ROOT/plaintext/closeout/backup-closeout.json" \
  --key-file "$KEY_FILE" --backup-id "$BACKUP_ID" \
  --artifact "closeout/backup-closeout.json"
chmod 600 "$RESTORE_ROOT/plaintext/closeout/backup-closeout.json"
jq -e --arg id "$BACKUP_ID" \
  --arg start "$(jq -er '.window.fenceStart' "$RESTORE_ROOT/plaintext/backup-manifest.json")" \
  --arg checkpoint "$(jq -er '.window.checkpointAt' "$RESTORE_ROOT/plaintext/backup-manifest.json")" \
  '.format == "crm-staging-backup-closeout/v3" and .backupId == $id and .window.fenceStart == $start and .window.checkpointAt == $checkpoint and (.window.fenceEnd | type == "string" and length > 0) and (.window.closeoutCreatedAt | type == "string" and length > 0) and (.window.groupTransitions | type == "array" and length > 0) and .window.pendingTransitionCount == 0' \
  "$RESTORE_ROOT/plaintext/closeout/backup-closeout.json" > /dev/null

# Decrypt one manifest-listed artifact. The helper validates the canonical
# artifact path in AAD, authenticated byte count/hash, and expected hash from
# the authenticated manifest. Each output path is new and remains under the
# private restore plaintext directory.
decrypt_artifact() {
  local relative_path="$1"
  local output_path="$2"
  local encrypted_path="${relative_path}.aesgcm"
  local expected_sha
  expected_sha="$(jq -er --arg p "$encrypted_path" \
    '[.artifacts[] | select(.path == $p)] | if length == 1 then .[0].plaintextSha256 else error("artifact missing or duplicated in manifest") end' \
    "$RESTORE_ROOT/plaintext/backup-manifest.json")"
  test -n "$expected_sha"
  mkdir -p "$(dirname "$output_path")"
  test ! -e "$output_path" && test ! -L "$output_path"
  node "$REPO_ROOT/scripts/backup/aesgcm-stream.mjs" decrypt \
    --in "$BACKUP_ROOT/$encrypted_path" \
    --out "$output_path" \
    --key-file "$KEY_FILE" \
    --backup-id "$BACKUP_ID" \
    --artifact "$relative_path" \
    --expect-sha256 "$expected_sha"
  chmod 600 "$output_path"
  test -s "$output_path"
}

# Required application and Storage artifacts. These exact paths are consumed
# by R5 and R7; no later step may assume a plaintext file that R1 did not make.
decrypt_artifact "db/app.dump" \
  "$RESTORE_ROOT/plaintext/db/app.dump"
decrypt_artifact "storage/objects.tar.zst" \
  "$RESTORE_ROOT/plaintext/storage/objects.tar.zst"
decrypt_artifact "storage/storage-manifest.json" \
  "$RESTORE_ROOT/plaintext/storage/storage-manifest.json"
decrypt_artifact "storage/buckets.json" \
  "$RESTORE_ROOT/plaintext/storage/buckets.json"

# Source evidence needed by R10 after B11 has removed the backup-host plaintext.
decrypt_artifact "validation/approved-write-groups-source.json" \
  "$RESTORE_ROOT/plaintext/validation/approved-write-groups-source.json"
decrypt_artifact "validation/approved-write-groups.json" \
  "$RESTORE_ROOT/plaintext/validation/approved-write-groups.json"
APPROVED_GROUPS_SOURCE_PLAINTEXT_SHA256="$(shasum -a 256 "$RESTORE_ROOT/plaintext/validation/approved-write-groups-source.json" | awk '{print $1}')"
jq -e --arg sha "$APPROVED_GROUPS_SOURCE_PLAINTEXT_SHA256" \
  '.sourceApprovalPlaintextSha256 == $sha and .format == "crm-approved-write-groups/v1"' \
  "$RESTORE_ROOT/plaintext/validation/approved-write-groups.json" > /dev/null
decrypt_artifact "validation/checkpoint.json" \
  "$RESTORE_ROOT/plaintext/validation/checkpoint.json"
decrypt_artifact "validation/wal-checkpoint.json" \
  "$RESTORE_ROOT/plaintext/validation/wal-checkpoint.json"
decrypt_artifact "validation/ledger.json" \
  "$RESTORE_ROOT/plaintext/validation/ledger.json"
decrypt_artifact "validation/counts.json" \
  "$RESTORE_ROOT/plaintext/validation/counts.json"
decrypt_artifact "validation/catalog-fingerprint.json" \
  "$RESTORE_ROOT/plaintext/validation/catalog-fingerprint.json"
decrypt_artifact "validation/catalog-details.json" \
  "$RESTORE_ROOT/plaintext/validation/catalog-details.json"
decrypt_artifact "validation/managed-customizations.json" \
  "$RESTORE_ROOT/plaintext/validation/managed-customizations.json"
decrypt_artifact "validation/roles-inventory.json" \
  "$RESTORE_ROOT/plaintext/validation/roles-inventory.json"
decrypt_artifact "validation/roles-status.json" \
  "$RESTORE_ROOT/plaintext/validation/roles-status.json"
decrypt_artifact "validation/inventory.txt" \
  "$RESTORE_ROOT/plaintext/validation/inventory.txt"
decrypt_artifact "validation/source-fingerprint.json" \
  "$RESTORE_ROOT/plaintext/validation/source-fingerprint.json"
decrypt_artifact "sql/fingerprint.sql" \
  "$RESTORE_ROOT/plaintext/sql/fingerprint.sql"
decrypt_artifact "sql/catalog-details.sql" \
  "$RESTORE_ROOT/plaintext/sql/catalog-details.sql"
decrypt_artifact "sql/managed-customizations.sql" \
  "$RESTORE_ROOT/plaintext/sql/managed-customizations.sql"
decrypt_artifact "validation/owner-inventory.json" \
  "$RESTORE_ROOT/plaintext/validation/owner-inventory.json"
decrypt_artifact "validation/vault-inventory.json" \
  "$RESTORE_ROOT/plaintext/validation/vault-inventory.json"
decrypt_artifact "validation/cron-inventory.json" \
  "$RESTORE_ROOT/plaintext/validation/cron-inventory.json"

# Validate that the derived ordered inventory is exactly the projection of
# the one authenticated plaintext approval source document; hash the raw
# plaintext bytes and verify every approval metadata field before trusting it.
node "$REPO_ROOT/scripts/backup/fence-transitions.mjs" validate-approval \
  --source "$RESTORE_ROOT/plaintext/validation/approved-write-groups-source.json" \
  --inventory "$RESTORE_ROOT/plaintext/validation/approved-write-groups.json" \
  --source-plaintext-sha256 "$APPROVED_GROUPS_SOURCE_PLAINTEXT_SHA256" \
  --trust-root-file "$OFFSITE_APPROVED_GROUPS_TRUST_ROOT_FILE" \
  --backup-id "$BACKUP_ID" --project-ref "$STAGING_PROJECT_REF" \
  --require-exactly-one-json-document --verify-approval-evidence

# Validate the authenticated closeout transitions against the same approved
# ordered group inventory used by B12. This checks exact group set/order, one
# global fence-end transition, strict UTC timestamps, chronology, successful
# enable evidence, closeout creation after all confirmations, and no pending
# action. The helper uses the same validator implementation as B12.
node "$REPO_ROOT/scripts/backup/fence-transitions.mjs" validate-closeout \
  --approved-groups "$RESTORE_ROOT/plaintext/validation/approved-write-groups.json" \
  --approval-source "$RESTORE_ROOT/plaintext/validation/approved-write-groups-source.json" \
  --closeout "$RESTORE_ROOT/plaintext/closeout/backup-closeout.json" \
  --backup-id "$BACKUP_ID" --project-ref "$STAGING_PROJECT_REF"

# The TOC is useful for R5 review. It is mandatory if B4 generated it.
decrypt_artifact "validation/app.toc.txt" \
  "$RESTORE_ROOT/plaintext/validation/app.toc.txt"

# Optional role DDL. It is never replayed blindly. Role status and the B3
# machine-readable role inventory were already decrypted above.
if jq -e '[.artifacts[].path] | index("db/roles.sql.aesgcm") != null' \
  "$RESTORE_ROOT/plaintext/backup-manifest.json" > /dev/null; then
  decrypt_artifact "db/roles.sql" "$RESTORE_ROOT/plaintext/db/roles.sql"
fi

# Large-object manifest is mandatory when the fresh checkpoint count is > 0.
LO_COUNT="$(jq -er '.database.largeObjectCount' "$RESTORE_ROOT/plaintext/backup-manifest.json")"
if [ "$LO_COUNT" -gt 0 ]; then
  decrypt_artifact "db/large-objects-manifest.json" \
    "$RESTORE_ROOT/plaintext/db/large-objects-manifest.json"
fi

# Managed Auth/Storage/Vault data is highly sensitive and is NOT decrypted by
# default. Only decrypt it if G7 names the exact approved provider procedure.
# The helper and procedure must be approved before adding that command here.

# Optional redacted project inventories are restored only if present in the
# manifest. The operator must list each optional artifact in this explicit set.
for optional in \
  "config/project-config.redacted.json" \
  "config/extensions.json" \
  "config/platform-inventory.json"; do
  if jq -e --arg p "${optional}.aesgcm" \
    '[.artifacts[].path] | index($p) != null' \
    "$RESTORE_ROOT/plaintext/backup-manifest.json" > /dev/null; then
    decrypt_artifact "$optional" "$RESTORE_ROOT/plaintext/$optional"
  fi
done

# Safely extract Storage bytes only after authenticated decrypt. The helper is
# not yet implemented and is a hard gate; never use tar -xf directly.
test -f "$RESTORE_ROOT/plaintext/storage/objects.tar.zst"
test -f "$RESTORE_ROOT/plaintext/storage/storage-manifest.json"
test -d "$RESTORE_ROOT/plaintext" && test ! -L "$RESTORE_ROOT/plaintext"
test ! -e "$RESTORE_ROOT/plaintext/objects" && test ! -L "$RESTORE_ROOT/plaintext/objects"
python3 "$REPO_ROOT/scripts/backup/safe-extract-storage.py" \
  --archive "$RESTORE_ROOT/plaintext/storage/objects.tar.zst" \
  --manifest "$RESTORE_ROOT/plaintext/storage/storage-manifest.json" \
  --destination "$RESTORE_ROOT/plaintext/objects"
```

`aesgcm-stream.mjs` and `safe-extract-storage.py` do not yet exist. R1 cannot be
run until both are implemented, reviewed and pass tamper/path-traversal tests.
If any mandatory artifact is absent from the manifest, checksum set, or
plaintext output, stop. The archive is created from a directory tree (`tar -C ... -cf - .`), so it
contains directory entries including the root marker `.`/`./`. The extractor
MUST accept only the root marker and validated directory entries that are
parents of manifest-listed object paths (or an explicitly listed empty bucket
directory); it must create those directories itself with `0700`. It must reject
absolute paths, drive/UNC paths, `..`, empty or ambiguous components, duplicate
paths, path collisions, symlinks, hard links, devices, FIFOs and every other
non-regular/non-directory member. It must stream-decompress zstd, create only
within a new empty `0700` directory, set files `0600`, and verify the exact
regular-file set, sizes and SHA-256 against the authenticated Storage manifest.
A directory entry is never extracted with a generic `tar -xf`; it is normalized
and validated before the helper creates it.

### R2 — Discover the local database container

```bash
set -Eeuo pipefail
export DB_CONTAINER="$(docker ps --filter 'name=^/supabase_db_crm-restore-rehearsal$' --format '{{.Names}}')"
test "$DB_CONTAINER" = "supabase_db_crm-restore-rehearsal"
```

Effect: read-only Docker discovery. Confirm the container belongs to the
scratch project, not the repository stack.

### R3 — Capture the empty baseline

```bash
set -Eeuo pipefail
docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
SET TimeZone = 'UTC';
SELECT current_setting('server_version') AS server_version;
SELECT count(*) AS app_tables FROM pg_tables WHERE schemaname IN ('public','private');
SELECT to_regclass('supabase_migrations.schema_migrations') AS ledger_table;
SELECT CASE
  WHEN to_regclass('supabase_migrations.schema_migrations') IS NULL THEN 'absent'
  ELSE 'present'
END AS ledger_state;
SELECT count(*) AS auth_users FROM auth.users;
SELECT count(*) AS storage_objects FROM storage.objects;
SQL
```

Expected: no application tables; record ledger state as either `absent` or
`present-empty` (verify zero rows only when present). Do not create a synthetic
ledger table to satisfy this check. Record the exact output.

### R4 — Prepare extensions and roles

Extensions are not application data. Pre-create the exact captured versions in
the captured schemas, if the local stack does not already provide them:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions VERSION '1.3';
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions VERSION '1.1';
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public VERSION '1.6';
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault VERSION '0.3.1';
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions VERSION '1.11';
```

Adjust versions only to the exact captured values. `IF NOT EXISTS` does not
prove the version, so immediately verify and stop on a mismatch:

```sql
SELECT extname, extversion, n.nspname AS schema_name
FROM pg_extension e
JOIN pg_namespace n ON n.oid = e.extnamespace
ORDER BY extname;
```

A version mismatch is a discrepancy to report, not a reason to silently
upgrade.

Apply captured role attributes/memberships only for non-reserved custom roles,
after review. Use the decrypted `roles.sql` file as an inventory when B6
produced it; otherwise use the B3 catalog inventory to generate and review the
custom-role mapping. Neither source is replayed blindly. **Never** drop or
replace Supabase reserved roles
(`postgres`, `anon`, `authenticated`, `service_role`, `supabase_admin`,
`supabase_auth_admin`, `supabase_storage_admin`, etc.) or run raw `pg_dumpall`
role DDL blindly. If only standard Supabase roles exist, record that and skip
role creation.

The local role/ACL model must be compared with the source inventory before
restore. The original object owners and membership options are not reproduced
merely by creating role names. On the **isolated local target only**, grant
`supabase_admin` membership to `postgres` only if the local version requires it
to apply captured default ACLs and the database reviewer explicitly approves
that local-only privilege change. The command below is not a Staging/Production
instruction:

```bash
set -Eeuo pipefail
docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 <<'SQL'
GRANT supabase_admin TO postgres;
SQL
```

This exact command is usable only if the local `supabase_admin` role is a
login-capable grantor with authority to grant the membership. If it is NOLOGIN
or the grant is denied, do not try to bypass the role model; use the documented
TOC-filter fallback and record the ACL/default-privilege discrepancy.

Record this local-only grant. Do not grant superuser or `supabase_admin` to any
Staging/Production role. If local `supabase_admin` login is unavailable, filter
the `DEFAULT ACL` TOC entries instead and record the resulting default-privilege
difference; do not silently ignore it.

### R5 — Restore application pre-data only

The local stack already has `public` and usually `supabase_migrations`. A raw
`pg_restore` fails with "schema public already exists" or "relation
supabase_migrations.schema_migrations already exists". This phase creates only
application definitions. It deliberately does **not** load application rows or
post-data constraints until Auth and Storage dependencies are ready.

1. Confirm the local baseline is empty and the ledger schema contains no rows.
2. Drop the local baseline `supabase_migrations` schema only if it is the empty
   disposable baseline and the approved local owner can drop it.
3. Generate the TOC and skip only the `SCHEMA - public` creation entry. Keep
   ACL/comment entries and all required table/function entries.
4. Restore only `pre-data` on the disposable local target.

```bash
set -Eeuo pipefail
umask 077
test -f "$RESTORE_ROOT/plaintext/db/app.dump"
test ! -L "$RESTORE_ROOT/plaintext/db/app.dump"
REMOTE_TMP_DIR="/tmp/crm-restore-${RESTORE_ID}"
REMOTE_DUMP="$REMOTE_TMP_DIR/app.dump"
REMOTE_TOC="$REMOTE_TMP_DIR/app.toc.list"
REMOTE_FILTERED_TOC="$REMOTE_TMP_DIR/app.toc.filtered.list"

docker exec "$DB_CONTAINER" mkdir -m 700 "$REMOTE_TMP_DIR"
cleanup_remote_plaintext() {
  local original_status=$?
  local cleanup_status=0
  trap - EXIT
  if ! docker exec "$DB_CONTAINER" rm -f -- "$REMOTE_DUMP" "$REMOTE_TOC" "$REMOTE_FILTERED_TOC" >/dev/null 2>&1; then
    echo "could not remove restore plaintext from DB container; stop and tear down the disposable stack before proceeding" >&2
    cleanup_status=1
  fi
  if ! docker exec "$DB_CONTAINER" rmdir "$REMOTE_TMP_DIR" >/dev/null 2>&1; then
    echo "could not remove restore temp directory; verify container state and tear down before proceeding" >&2
    cleanup_status=1
  fi
  if [ "$cleanup_status" -ne 0 ]; then exit 1; fi
  exit "$original_status"
}
# Install cleanup before copying any plaintext into the container.
trap cleanup_remote_plaintext EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker cp "$RESTORE_ROOT/plaintext/db/app.dump" "$DB_CONTAINER:$REMOTE_DUMP"
# Refuse to drop a non-empty or customized local migration schema.
LEDGER_PRESENT="$(docker exec "$DB_CONTAINER" psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL")"
if [ "$LEDGER_PRESENT" = "t" ]; then
  BASELINE_LEDGER_ROWS="$(docker exec "$DB_CONTAINER" psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c 'SELECT count(*) FROM supabase_migrations.schema_migrations')"
  test "$BASELINE_LEDGER_ROWS" = "0"
elif [ "$LEDGER_PRESENT" != "f" ]; then
  echo "could not establish migration-ledger state" >&2
  exit 1
fi
BASELINE_EXTRA_TABLES="$(docker exec "$DB_CONTAINER" psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "SELECT count(*) FROM pg_tables WHERE schemaname='supabase_migrations' AND tablename <> 'schema_migrations'")"
BASELINE_EXTRA_RELATIONS="$(docker exec "$DB_CONTAINER" psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='supabase_migrations' AND c.relkind IN ('v','m','S','f')")"
BASELINE_APP_TABLES="$(docker exec "$DB_CONTAINER" psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "SELECT count(*) FROM pg_tables WHERE schemaname IN ('public','private')")"
test "$BASELINE_EXTRA_TABLES" = "0"
test "$BASELINE_EXTRA_RELATIONS" = "0"
test "$BASELINE_APP_TABLES" = "0"
# Local disposable target only; now the empty baseline ledger schema can be dropped.
docker exec "$DB_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c 'DROP SCHEMA IF EXISTS supabase_migrations CASCADE;' 
docker exec "$DB_CONTAINER" pg_restore --list "$REMOTE_DUMP" > "$RESTORE_ROOT/app.toc.list"
if [ "${FILTER_DEFAULT_ACL:-0}" = "1" ]; then
  grep -v 'SCHEMA - public' "$RESTORE_ROOT/app.toc.list" | \
    grep -v 'DEFAULT ACL' > "$RESTORE_ROOT/app.toc.filtered.list"
else
  grep -v 'SCHEMA - public' "$RESTORE_ROOT/app.toc.list" \
    > "$RESTORE_ROOT/app.toc.filtered.list"
fi
test -s "$RESTORE_ROOT/app.toc.filtered.list"
( cd "$RESTORE_ROOT" && shasum -a 256 app.toc.filtered.list > app.toc.filtered.list.sha256 )
chmod 600 "$RESTORE_ROOT/app.toc.filtered.list.sha256"
docker cp "$RESTORE_ROOT/app.toc.filtered.list" "$DB_CONTAINER:$REMOTE_FILTERED_TOC"
docker exec "$DB_CONTAINER" pg_restore \
  -U postgres -d postgres --exit-on-error --single-transaction --no-owner \
  --section=pre-data -L "$REMOTE_FILTERED_TOC" "$REMOTE_DUMP" \
  2> "$RESTORE_ROOT/restore-app-predata.stderr.log"
# Explicit success cleanup; remove EXIT trap only after remote plaintext is gone.
docker exec "$DB_CONTAINER" rm -f -- "$REMOTE_DUMP" "$REMOTE_TOC" "$REMOTE_FILTERED_TOC"
docker exec "$DB_CONTAINER" rmdir "$REMOTE_TMP_DIR"
trap - EXIT INT TERM
chmod 600 "$RESTORE_ROOT/app.toc.list" "$RESTORE_ROOT/app.toc.filtered.list" \
  "$RESTORE_ROOT/restore-app-predata.stderr.log"
```

The cleanup trap is installed before `docker cp` and covers every subsequent
exit path, including TOC generation and `pg_restore` failure. If Docker becomes
unavailable and the trap cannot remove the temporary plaintext, do not proceed;
inspect the exact disposable container and complete teardown before another
attempt. Do not copy a failed dump into another container for convenience.

`pg_restore --no-owner` makes the restore user the initial owner. The approved
ownership plan is applied only after all application objects have been created
in R8. ACLs remain in the archive and require referenced roles or an approved
local mapping. Never apply any of these commands to Staging/Production.

### R6 — Restore Storage

Preconditions:

- R1 has authenticated/decrypted `storage/objects.tar.zst`,
  `storage/storage-manifest.json` and `storage/buckets.json`;
- the safe extractor has produced `$RESTORE_ROOT/plaintext/objects` and
  verified the exact byte set, sizes and SHA-256 hashes;
- the application pre-data schema has been restored and any references to Storage object IDs
  have been inventoried;
- this is the isolated local stack only.

The current illustrative single-bucket `curl` command is removed. It restored
only one named bucket and omitted some captured configuration fields. A reviewed
`scripts/backup/storage-restore.mjs` does not yet exist and is a hard gate. It
must restore **every** bucket in `buckets.json`, not a hard-coded sample, and
must:

- parse `local.env` privately or read a separately protected local-key file;
  detect exactly one supported key format, never print it, and send `apikey`
  for both supported formats; add `Authorization: Bearer` only for a legacy
  JWT `service_role` key, never for a current `sb_secret_...` key;
- restore each bucket's captured `id`, `name`, `public`, `file_size_limit`,
  `allowed_mime_types`, `type`, and `versioning_status` where the local Storage
  API supports those fields; fail if a non-default source setting cannot be
  represented rather than silently dropping it;
- upload every object from the authenticated manifest with upsert disabled,
  URL-encode each path segment, set content type, enforce an endpoint/method
  allowlist for the local target, and fail on redirects, non-2xx status,
  pagination gaps or duplicate paths;
- verify returned bucket/object metadata and independently download each
  restored object to hash the bytes; no success based only on HTTP 2xx;
- report source object UUID/version/timestamps and target differences. If the
  source has versioning/history that cannot be preserved, mark restore
  incomplete; do not claim point-in-time recovery.

Illustrative helper contract only; it is not implemented and must not be run:

```bash
set -Eeuo pipefail
node "$REPO_ROOT/scripts/backup/storage-restore.mjs" restore \
  --local-env "$RESTORE_ROOT/local.env" \
  --buckets "$RESTORE_ROOT/plaintext/storage/buckets.json" \
  --manifest "$RESTORE_ROOT/plaintext/storage/storage-manifest.json" \
  --objects-root "$RESTORE_ROOT/plaintext/objects" \
  --no-upsert \
  --verify-uploaded-bytes \
  --report "$RESTORE_ROOT/evidence/storage-restore-report.json"
```

The helper must not accept a remote source URL or any project ref other than
the local `crm-restore-rehearsal` target. If the source inventory contains
versioned objects and the local API cannot preserve versions/metadata, restore
acceptance is blocked. If any application row references `storage.objects.id`
directly, API upload will generally allocate a new ID; this is a blocker unless
a separately reviewed provider-supported ID-preserving procedure is proven.

After restore, reconcile bucket ID/name/public/limits/MIME/type/versioning and
object path/size/MIME/SHA-256, then check orphaned metadata, missing bytes and
app references. `supabase storage` requires `--experimental`; its versioning
and metadata-preservation behavior remains unverified and it is not the sole
evidence path.

### R7 — Restore Auth before application data and FK constraints

There is no generic SQL or Admin API command in this runbook that is approved
to restore managed Auth. An Admin API user listing is not a backup/restore
contract: it may omit identities, MFA factors, sessions, password state or
project-bound encryption material. Never replay `auth` DDL or restore password
hashes by hand.

Use the authenticated R1-decrypted B3 `validation/counts.json`, not the old
2026-10-30 snapshot, to choose one of these paths. It records `authUsers`,
`authIdentities` and `authMfaFactors` separately:

**Path A — zero managed Auth state at checkpoint.** If `auth.users`, identities
and MFA factors are all measured as zero, record the zero counts in the
recovery report, do not run an Auth import, and verify those same counts remain
zero on the local target. This is a valid limited-scope result for this
checkpoint only; it does not prove that non-empty Auth can be restored later.

**Path B — one or more Auth users/identities/MFA factors exist.** Stop. G7 must
name the exact currently supported Supabase/provider export and restore
procedure, its API/CLI version, supported fields, limitations, identity/MFA
preservation behavior, required credentials, redaction rules and a tested
isolated rehearsal. The platform/Auth owner must supply that procedure and
approve its evidence. Do not invent a Management API endpoint, use the Admin
API as a substitute, or mark Auth as restored until the procedure is tested.

Auth restoration MUST occur before application data and before post-data FK constraints are created. Before importing users, review `managed-customizations.json` for Auth triggers that write into application schemas. Do not apply project custom triggers until R9; if the provider import itself invokes an unreviewed trigger or cannot suppress/sequence its side effects safely on the disposable target, stop.

If a supported procedure cannot preserve stable user IDs, identities, MFA
state or required tenant memberships, the recovery is incomplete and remains
BLOCKED. Sessions are non-portable unless the provider explicitly proves
otherwise. Any login test must use an owner-approved synthetic account, never
a real customer credential. Verify AAL1/AAL2, inactive actors and tenant
isolation through Auth/PostgREST APIs on the local target.

### R8 — Restore application data and post-data objects; verify ledger and ownership

Run this section only after R6 Storage and R7 Auth have completed, or have been
explicitly skipped under their measured zero-state rules. This ordering allows
application rows that reference `auth.users` to load only after their users
exist, and delays foreign-key constraints until after both dependency sets are
ready.

**Hard preconditions:**

- R5 pre-data completed successfully;
- R6 Storage is complete, or the measured Storage source state is empty;
- no application row has an unpreservable direct reference to a Storage object ID;
- R7 Auth is complete, or the measured Auth state is zero and no app data row
  references a missing Auth user;
- the reviewed TOC list from R5 is available and unchanged (verify its SHA-256).

The helper scripts remain unimplemented. The following commands are an
illustrative, local-only restore plan and must be tested on synthetic data
before any real backup artifact is used. The same container cleanup trap
pattern is mandatory for both phases; the archive is copied only for the
current phase and removed on every exit path.

```bash
set -Eeuo pipefail
umask 077
test -f "$RESTORE_ROOT/plaintext/db/app.dump"
test -f "$RESTORE_ROOT/app.toc.filtered.list"
( cd "$RESTORE_ROOT" && shasum -a 256 -c app.toc.filtered.list.sha256 )
REMOTE_TMP_DIR="/tmp/crm-restore-${RESTORE_ID}-data"
REMOTE_DUMP="$REMOTE_TMP_DIR/app.dump"
REMOTE_TOC="$REMOTE_TMP_DIR/app.toc.filtered.list"
docker exec "$DB_CONTAINER" mkdir -m 700 "$REMOTE_TMP_DIR"
cleanup_remote_data() {
  local original_status=$?
  local cleanup_status=0
  trap - EXIT INT TERM
  if ! docker exec "$DB_CONTAINER" rm -f -- "$REMOTE_DUMP" "$REMOTE_TOC" >/dev/null 2>&1; then
    echo "could not remove app archive plaintext from DB container" >&2
    cleanup_status=1
  fi
  if ! docker exec "$DB_CONTAINER" rmdir "$REMOTE_TMP_DIR" >/dev/null 2>&1; then
    echo "could not remove app restore temp directory" >&2
    cleanup_status=1
  fi
  if [ "$cleanup_status" -ne 0 ]; then exit 1; fi
  exit "$original_status"
}
trap cleanup_remote_data EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker cp "$RESTORE_ROOT/plaintext/db/app.dump" "$DB_CONTAINER:$REMOTE_DUMP"
docker cp "$RESTORE_ROOT/app.toc.filtered.list" "$DB_CONTAINER:$REMOTE_TOC"
# Load application rows only after Auth and Storage dependency preparation.
docker exec "$DB_CONTAINER" pg_restore \
  -U postgres -d postgres --exit-on-error --single-transaction --no-owner \
  --section=data -L "$REMOTE_TOC" "$REMOTE_DUMP" \
  2> "$RESTORE_ROOT/restore-app-data.stderr.log"
set -Eeuo pipefail
LEDGER_SQL="SELECT coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name,'statementCount',cardinality(statements),'storedSqlSha256',encode(sha256(convert_to(array_to_string(statements,E'\\n'),'UTF8')),'hex')) ORDER BY version),'[]'::jsonb)::text FROM supabase_migrations.schema_migrations"
test ! -e "$RESTORE_ROOT/evidence/target-ledger.json"
docker exec "$DB_CONTAINER" psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "$LEDGER_SQL" > "$RESTORE_ROOT/evidence/target-ledger.json" \
  2> "$RESTORE_ROOT/evidence/target-ledger.stderr"
chmod 600 "$RESTORE_ROOT/evidence/target-ledger.json" "$RESTORE_ROOT/evidence/target-ledger.stderr"
jq -s -e 'length == 1 and (.[0] | type == "array")' \
  "$RESTORE_ROOT/evidence/target-ledger.json" > /dev/null
cmp -s "$RESTORE_ROOT/plaintext/validation/ledger.json" \
  "$RESTORE_ROOT/evidence/target-ledger.json"

# Add indexes, constraints, triggers and other post-data entries only after data.
docker exec "$DB_CONTAINER" pg_restore \
  -U postgres -d postgres --exit-on-error --single-transaction --no-owner \
  --section=post-data -L "$REMOTE_TOC" "$REMOTE_DUMP" \
  2> "$RESTORE_ROOT/restore-app-postdata.stderr.log"
# Explicit success cleanup; remove EXIT trap only after remote plaintext is gone.
docker exec "$DB_CONTAINER" rm -f -- "$REMOTE_DUMP" "$REMOTE_TOC"
docker exec "$DB_CONTAINER" rmdir "$REMOTE_TMP_DIR"
trap - EXIT INT TERM
chmod 600 "$RESTORE_ROOT/restore-app-data.stderr.log" \
  "$RESTORE_ROOT/restore-app-postdata.stderr.log"
```

If either phase fails, the trap must remove container-side plaintext. If cleanup
fails, the restore remains BLOCKED and the disposable stack must be torn down
before further investigation. Do not continue to owner mapping or validation.

Ledger verification is executed in the same guarded R8 shell block after
`--section=data` and before `--section=post-data`. A mismatch exits before
foreign-key constraints or ownership mapping are applied.

**Apply the owner map only after all pre/data/post-data objects exist.** The
mapping is a reviewed input artifact; every source owner must have exactly one
approved target role. The `owner-map.mjs` helper remains missing and is a hard
gate. Required shape:

```json
{
  "format": "crm-owner-map/v1",
  "sourceProjectRef": "qmhfmgkymjgoevwmkidm",
  "target": "crm-restore-rehearsal",
  "mappings": [
    {"sourceOwner":"<exact-source-role>","targetOwner":"<existing-local-role>","reason":"<security-equivalence>","approvedBy":"<database-reviewer>"}
  ]
}
```

The helper must quote identifiers safely; support schemas, tables,
partitioned/foreign tables, sequences, views/materialized views, types/domains,
functions and procedures with exact identity arguments; reject missing,
duplicate or ambiguous mappings; and emit deterministic SQL without DROP,
role creation or privilege escalation. Require reviewer approval of the plan
SHA-256 before apply. Post-apply verification must compare every owner and each
routine's `proowner`, `prosecdef`, `proconfig` and EXECUTE ACL. A `SECURITY
DEFINER` mismatch is a security failure, not a cosmetic difference.

### R9A — Re-apply only approved managed-schema customizations

B3 captured `validation/managed-customizations.json` as evidence. This artifact
contains platform defaults as well as possible project customizations; it is
not a replay script. Compare it with the exact local Supabase managed-schema
version and the repository migration history. Classify every policy, trigger,
index, constraint, routine and RLS setting as platform-default, project-owned,
or unexplained. Any unexplained object is a stop.

A reviewed `scripts/backup/managed-customizations.mjs` helper does not exist
yet. It must produce a deterministic allowlisted plan, include dependencies
(such as trigger functions), require a database-reviewer-approved plan hash,
and verify the resulting definitions, enabled state, ownership, `SECURITY
DEFINER`, `proconfig`, ACL and RLS flags. It must never replay the full `auth`
or `storage` schema dump or alter Supabase platform-managed objects.

Apply project-owned Auth triggers only after Auth import and app data restore,
so import-time side effects do not create duplicate application rows. Apply
Storage policies only after Storage buckets/objects have been restored. If the
helper cannot prove an object is project-owned and safe to recreate, leave it
unapplied and keep the recovery BLOCKED.

Illustrative contract only; not implemented or executable:

```bash
set -Eeuo pipefail
node "$REPO_ROOT/scripts/backup/managed-customizations.mjs" plan \
  --source "$RESTORE_ROOT/plaintext/validation/managed-customizations.json" \
  --target-label "crm-restore-rehearsal" \
  --out "$RESTORE_ROOT/managed-customizations-plan.sql" \
  --report "$RESTORE_ROOT/evidence/managed-customizations-plan.json"
shasum -a 256 "$RESTORE_ROOT/managed-customizations-plan.sql" \
  > "$RESTORE_ROOT/managed-customizations-plan.sha256"
# Apply only after independent database-reviewer approval of the exact hash.
node "$REPO_ROOT/scripts/backup/managed-customizations.mjs" apply \
  --plan "$RESTORE_ROOT/managed-customizations-plan.sql" \
  --approved-sha256 "<reviewer-approved-sha256>" \
  --target "$DB_CONTAINER"
node "$REPO_ROOT/scripts/backup/managed-customizations.mjs" verify \
  --source "$RESTORE_ROOT/plaintext/validation/managed-customizations.json" \
  --target "$DB_CONTAINER" \
  --report "$RESTORE_ROOT/evidence/managed-customizations-verification.json"
```

### R9B — Re-provision Vault and token-encryption keys

Treat Vault secrets and application-level Meta token encryption as two
separate recovery dependencies. A database dump containing Vault ciphertext
does not prove that the corresponding root/encryption key is portable.

**Vault path:** use the fresh B3 inventory to determine whether Vault secrets
exist. If `vault-inventory.json` reports `present=false` or `count=0`, record the
measured state and do not run a Vault restore. If one or more secrets exist, stop until the platform owner supplies
an exact provider-supported Vault root-key backup/re-provision procedure and
proves it on an isolated target. This runbook does not assume that a SQL dump
or `vault.secrets` rows can recreate the root key. Do not read/decrypt secret
values into logs or reports.

**`META_TOKEN_ENCRYPTION_KEY` path:** the key must be recovered from its
approved KMS/HSM or dual-custodian source, not from the database dump. Record
only key identifier/version, fingerprint and custodian approvals. A reviewed
private verifier must:

1. perform a synthetic encrypt/decrypt round trip using the recovered key;
2. verify at least one retained Staging ciphertext, if any exists, without
   displaying or persisting the plaintext token;
3. prove a wrong key fails closed;
4. record only pass/fail, ciphertext identifier and key version.

If there are no retained Meta token ciphertexts, record the measured zero and
state that real-token decryptability was not exercised. If ciphertext exists
and no independent custodian can verify it, recovery is incomplete. Never
re-encrypt, discard or replace ciphertext to make the test pass. Do not print,
log or include tokens or key material in evidence.

No generic Vault or token-key restore command is provided because the exact
provider/KMS procedures are not yet supplied and approved. This is an explicit
execution and acceptance gate, not an operator discretion item.

### R10 — Validate

Run the validation matrix in §9. Capture raw outputs in
`$RESTORE_ROOT/evidence/` with permissions `0600`, redact private values, and
compare the detailed catalog and managed-customization evidence as well as the
count summaries against the authenticated source evidence decrypted by R1 under
`$RESTORE_ROOT/plaintext/validation/`. B11 removes local backup-host plaintext,
so R10 must never depend on `$BACKUP_ROOT/validation/` still existing.

### R11 — Measure and report

Record:

- restore start/end and elapsed time (measured RTO);
- snapshot time, fence start/end and unbacked writes (RPO);
- artifact IDs/checksums and decryption verification;
- every discrepancy, including expected ownership/UUID changes;
- whether the restore is accepted, conditionally accepted or rejected.

Complete §10. Any unresolved mismatch keeps deployment blocked.

### R12 — Teardown

After the report is approved, stop the exact isolated stack first. The shell
must fail closed: if `supabase stop` fails, do not delete plaintext.

```bash
set -Eeuo pipefail
export EXPECTED_RESTORE_ROOT="$HOME/.crm-restore/$RESTORE_ID"
test -n "$RESTORE_ID"
test "$RESTORE_ROOT" = "$EXPECTED_RESTORE_ROOT"
test ! -L "$HOME/.crm-restore"
test -d "$RESTORE_ROOT" && test ! -L "$RESTORE_ROOT"
test -d "$RESTORE_ROOT/plaintext" && test ! -L "$RESTORE_ROOT/plaintext"
test "$(grep -c '^project_id = \"crm-restore-rehearsal\"$' "$RESTORE_ROOT/supabase/config.toml")" -eq 1
supabase --workdir "$RESTORE_ROOT" stop --no-backup
# Only after a successful stop:
rm -rf -- "$RESTORE_ROOT/plaintext"
rm -f -- "$RESTORE_ROOT/local.env"
unset LOCAL_SECRET_KEY SERVICE_ROLE_KEY SUPABASE_SECRET_KEY API_URL 2>/dev/null || true
```

Remove decrypted temporary files, local container volumes and local keys used
only for the rehearsal. Do not delete the backup decryption key if it is also the
retained key for the encrypted backup set. Retain approved evidence and
ciphertext per retention. Confirm no local service or container still exposes
the restored data.

---

## 9. Validation matrix

Zero tolerance for ledger, schema, ACL/RLS, Storage-byte and secret-handling
mismatches. Count/row-hash mismatches require a written explanation and owner
acceptance; unexplained mismatches block.

### 9.1 Record counts and deterministic row fingerprints

B3 creates and runs this script against the source before encryption, writing
`validation/source-fingerprint.json`. R10 runs the same encrypted script against
the restored target and compares the resulting JSON exactly. The source run is
read-only apart from a temporary table in the session temp schema.

```sql
-- fingerprint.sql
SET TimeZone = 'UTC';
SET DateStyle = 'ISO, MDY';
SET extra_float_digits = 3;

CREATE TEMP TABLE restore_fingerprint (
  schema_name text,
  table_name text,
  row_count bigint,
  row_hash text
);

DO $$
DECLARE
  r record;
  n bigint;
  h text;
BEGIN
  FOR r IN
    SELECT schemaname, tablename
    FROM pg_tables
    -- Replace this baseline list with every application schema selected in B4.
    WHERE schemaname = ANY (ARRAY['public', 'private']::text[])
    ORDER BY schemaname, tablename
  LOOP
    EXECUTE format(
      'SELECT count(*), encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, chr(10) ORDER BY to_jsonb(x)::text), %L), %L)), %L) FROM %I.%I x',
      '', 'UTF8', 'hex', r.schemaname, r.tablename
    ) INTO n, h;
    INSERT INTO restore_fingerprint VALUES (r.schemaname, r.tablename, n, h);
  END LOOP;
END $$;

SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY schema_name, table_name), '[]'::jsonb)::text FROM restore_fingerprint f;
```

For R10, run the same script against the isolated target only. The SQL file is
decrypted by R1 and copied into the disposable database container; capture the
JSON result on the host and compare it with the authenticated source fingerprint:

```bash
set -Eeuo pipefail
test -f "$RESTORE_ROOT/plaintext/sql/fingerprint.sql"
test ! -e "$RESTORE_ROOT/evidence/target-fingerprint.json"
docker cp "$RESTORE_ROOT/plaintext/sql/fingerprint.sql" "$DB_CONTAINER":/tmp/fingerprint.sql
docker exec "$DB_CONTAINER" psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -f /tmp/fingerprint.sql > "$RESTORE_ROOT/evidence/target-fingerprint.json"
docker exec "$DB_CONTAINER" rm -f /tmp/fingerprint.sql
chmod 600 "$RESTORE_ROOT/evidence/target-fingerprint.json"
jq -s -e 'length == 1 and (.[0] | type == "array")' "$RESTORE_ROOT/evidence/target-fingerprint.json" > /dev/null
cmp -s "$RESTORE_ROOT/plaintext/validation/source-fingerprint.json" \
  "$RESTORE_ROOT/evidence/target-fingerprint.json"
```

This reference implementation is only for tables small enough to fit the
aggregate in memory. For larger tables, use
a reviewed deterministic chunked SHA-256 implementation ordered by a stable
primary key (or an explicitly reviewed stable row representation); do not
silently skip a table. The query uses PostgreSQL 17's built-in `sha256(bytea)`;
keep the source and restore server versions aligned. MD5 is not used as the
integrity fingerprint.

Also compare:

```sql
-- Exact counts for the legacy/audited tables.
SELECT 'customers' AS table_name, count(*) FROM public.customers
UNION ALL SELECT 'conversations', count(*) FROM public.conversations
UNION ALL SELECT 'auth_users', count(*) FROM auth.users
UNION ALL SELECT 'storage_buckets', count(*) FROM storage.buckets
UNION ALL SELECT 'storage_objects', count(*) FROM storage.objects;
```

### 9.2 Schema and catalog

Compare the full B3 catalog detail artifact, not only count summaries, with
the restored catalog. The `catalog-details.json` source artifact includes index
definitions/validity, constraint definitions/validation, routine definitions
and security attributes, exact sequence `last_value`/`is_called`, and relation/
column comments. Compare it with equivalent target queries; apply the approved
owner mapping when evaluating owner fields. Do not accept counts alone.

Capture the detailed target catalog from the same SQL used at B3, then compare
it with the source artifact using the approved owner mapping. The comparison
helper is a missing prerequisite; do not use `cmp` on raw JSON because owner
names are intentionally remapped.

```bash
set -Eeuo pipefail
test -f "$RESTORE_ROOT/plaintext/sql/catalog-details.sql"
test ! -e "$RESTORE_ROOT/evidence/target-catalog-details.json"
docker cp "$RESTORE_ROOT/plaintext/sql/catalog-details.sql" "$DB_CONTAINER":/tmp/catalog-details.sql
docker exec "$DB_CONTAINER" psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -f /tmp/catalog-details.sql \
  > "$RESTORE_ROOT/evidence/target-catalog-details.json" \
  2> "$RESTORE_ROOT/evidence/target-catalog-details.stderr"
docker exec "$DB_CONTAINER" rm -f /tmp/catalog-details.sql
chmod 600 "$RESTORE_ROOT/evidence/target-catalog-details.json" \
  "$RESTORE_ROOT/evidence/target-catalog-details.stderr"
jq -s -e 'length == 1 and (.[0] | type == "object")' \
  "$RESTORE_ROOT/evidence/target-catalog-details.json" > /dev/null
node "$REPO_ROOT/scripts/backup/catalog-compare.mjs" compare \
  --source "$RESTORE_ROOT/plaintext/validation/catalog-details.json" \
  --target "$RESTORE_ROOT/evidence/target-catalog-details.json" \
  --owner-map "$RESTORE_ROOT/owner-map.json" \
  --report "$RESTORE_ROOT/evidence/catalog-comparison.json"
```

`catalog-compare.mjs` does not exist yet. It must normalize only the approved
owner mapping, compare definitions/flags/sequence state/comments exactly, and
fail on missing or extra objects. It must not normalize away ACL, `SECURITY
DEFINER`, `proconfig`, index validity or sequence `is_called` differences.

Also compare:

- relations, columns, types, defaults, identities/generated columns;
- constraints and `convalidated`;
- indexes and `indisvalid`/`indisready`;
- functions/procedures, `SECURITY DEFINER`, owner, `proconfig`;
- non-internal triggers and `tgenabled`;
- RLS flags/policies;
- all source customizations on `auth`/`storage` against the reviewed
  `managed-customizations.json` and the R9A verification report;
- schema/table/function/default ACLs;
- sequences and current values;
- extension names/versions/schemas;
- publications and slots;
- comments.

Starter queries:

```sql
SELECT n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','private')
ORDER BY 1,2;

SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname IN ('public','private')
ORDER BY 1,2,3;

SELECT n.nspname, c.relname, i.indexrelid::regclass AS index_name, i.indisvalid, i.indisready
FROM pg_index i
JOIN pg_class c ON c.oid = i.indrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public','private')
ORDER BY 1,2,3;

SELECT n.nspname, c.relname, t.tgname, t.tgenabled
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal AND n.nspname IN ('public','private')
ORDER BY 1,2,3;

SELECT schemaname, sequencename, last_value, start_value, increment_by, max_value, cycle
FROM pg_sequences
WHERE schemaname IN ('public','private')
ORDER BY 1,2;
```

Hash the sorted ACL rows and compare. Ownership differences from `--no-owner`
are expected; record the owner mapping. A `SECURITY DEFINER` function owned by
the wrong role is a security finding, not a cosmetic difference.

### 9.3 Ledger

- The row count, exact versions, names and stored SQL hashes must match the
  fresh encrypted B3 `validation/ledger.json`; do not hard-code 21 rows.
- The historical 2026-10-30 snapshot showed 21 rows, but that is context only
  and is not the acceptance target for a later execution.
- no fabricated canonical rows, no deleted/updated history;
- no `supabase db push`/`migration repair` was used to force a match.

### 9.4 ACL and RLS behavior

Test behavior, not just catalog presence. Use transactions that roll back and
synthetic local test actors; never use real customer credentials.

```sql
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated","aal":"aal1"}', true);
-- Expect only the actor's tenant rows, or zero rows if no fixture is inserted.
SELECT count(*) FROM public.customers;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated","aal":"aal1"}', true);
-- Expect denial or zero rows for private schema / other tenant.
SELECT count(*) FROM private.meta_leadgen_events;
ROLLBACK;

BEGIN;
SET LOCAL ROLE anon;
-- Expect denial for private tables and non-public Storage objects.
SELECT count(*) FROM public.customers;
ROLLBACK;
```

An expected `permission denied` aborts the transaction, so run positive and
negative checks in separate sessions or use `has_table_privilege` /
`has_schema_privilege` for catalog assertions. Do not wrap an expected denial
in a script with `ON_ERROR_STOP=1` and then treat the abort as a pass. These SQL
claim-setting checks are supplemental only: they do not prove the complete
Auth/PostgREST request path.

Before accepting RLS, create owner-approved synthetic local Auth users and test
through the local Auth/PostgREST/Storage APIs using real issued access tokens:

- tenant A can read and mutate only tenant A fixtures;
- tenant A cannot read, insert, update or delete tenant B fixtures;
- anon and inactive/forbidden actors are denied as specified;
- AAL1 is denied on endpoints requiring AAL2, while an enrolled synthetic MFA
  actor with an AAL2 token succeeds;
- service-only paths work only with the intended server credential;
- private Storage download is denied to anon and allowed only to the intended
  actor; newly generated signed URLs expire as configured.

Use no real customer credentials. Keep all fixtures local and remove them with
the disposable stack. If the baseline has no users/tenants, report that fact and
do not claim that real-user or real-tenant behavior was proven.

Also verify:

- `anon` cannot read private schema or service-only RPCs;
- inactive/forbidden actors are denied;
- cross-tenant reads/writes are denied;
- `service_role` can perform service-only paths;
- AAL2 is required where the contract requires it;
- Storage private-object download is denied to `anon` and allowed only under
  the policy for the intended actor;
- signed URLs are regenerated on the target; old project-bound URLs are not
  assumed valid.

If the restored dataset has no users/tenants, insert synthetic fixtures **inside
a rolled-back transaction** and state that real-data RLS was not exercised.
Do not claim tenant isolation was proven against real users.

### 9.5 Storage bytes

For every manifest entry:

- bucket/path exists;
- size matches;
- MIME type matches;
- SHA-256 of downloaded bytes matches;
- no extra/orphan object is unaccounted for;
- object metadata differences are listed;
- authorized download succeeds and unauthorized download fails;
- signed URL works for the intended actor and expires as configured.

A metadata-only match is insufficient. A missing byte or hash mismatch is a
hard stop.

### 9.6 Auth, Vault and secrets

- Auth user count and stable ID hash match; no email/password printed;
- identity/provider links match;
- login works for an approved synthetic/test account only;
- MFA/AAL2 behavior matches if enabled;
- Vault secret count/names match; root-key restore is proven by decrypting a
  retained value privately;
- `META_TOKEN_ENCRYPTION_KEY` decrypts retained ciphertext;
- wrong key fails closed;
- no secret appears in logs, report, filenames or Git.

### 9.7 Application smoke test

With provider sends, webhooks and schedulers fenced:

- run read-only API/RPC smoke tests against the local stack;
- verify tenant access and denial paths;
- verify a synthetic intake/idempotency path without sending externally;
- verify outbox/queue recovery does not double-send;
- verify Storage signed-URL retrieval for an authorized actor;
- run the relevant local test suites that do not require real credentials.

Do not set `META_ADS_BACKUP_RESTORE_VERIFIED=1` or `META_ADS_OWNER_APPROVED=1`
based on a smoke test. Those flags require the approved report in §10 and
explicit owner sign-off.

---

## 10. Recovery confirmation report template

Create `$RESTORE_ROOT/evidence/recovery-confirmation.md` and attach the
redacted evidence files. Do not include tokens, passwords, private rows or
decrypted values.

```markdown
# Recovery confirmation — <BACKUP_ID>

## 1. Identity
- Source project: qmhfmgkymjgoevwmkidm (staging)
- Source branch/commit: meta_ads_integration / audit baseline 0d21bb89b97cdcd1b82f08a72149e68f87b8ae2f / snapshot e51a5989143582af0885ba5ee26644a68b388995 / current execution SHA:
- Backup ID / checkpoint UTC:
- Backup owner / operator:
- Recovery owner:
- Key custodians:
- Operations approver:

## 2. Artifacts
| Artifact | Plaintext SHA-256 | Ciphertext SHA-256 | Bytes | Verified |
| --- | --- | --- | ---: | --- |
| db/app.dump | | | | |
| db/managed-data.dump | | | | |
| db/large-objects-manifest.json (if any) | | | | |
| storage/objects.tar.zst | | | | |
| storage/storage-manifest.json | | | | |
| config/* | | | | |

- AES-256-GCM format version:
- Key fingerprint:
- Independent decrypt by recovery owner: pass/fail
- Offsite read-back checksum: pass/fail

## 3. Restore target
- Local project ID: crm-restore-rehearsal
- PostgreSQL / CLI / Storage / Auth versions:
- Start UTC / end UTC / measured RTO:
- Fence start/end / measured RPO:
- Target was isolated and never linked to Staging/Production: yes/no

## 4. Validation
| Check | Expected | Actual | Result |
| --- | --- | --- | --- |
| Ledger rows/versions/hashes | B3 checkpoint / exact / exact | | |
| App table counts | match | | |
| Deterministic row fingerprints | match | | |
| Schema/function/trigger/index/FK | match | | |
| Managed auth/storage customizations | classified and reviewed | | |
| Detailed catalog (index validity, sequence is_called, routine definitions/comments) | match | | |
| ACL/default ACL | match or reviewed mapping | | |
| RLS flags/policies | match | | |
| RLS behavioral tests | pass | | |
| Sequences | match or reviewed | | |
| Extensions | exact versions | | |
| Storage buckets/objects | match | | |
| Storage byte SHA-256 | match | | |
| Large-object OID/count/byte SHA-256 (if any) | match or N/A only when source count is zero | | |
| Storage authorized/denied access | pass | | |
| Auth users/identities/MFA | match | | |
| Vault/root-key decrypt | pass | | |
| Meta token decrypt | pass | | |
| App smoke (sends fenced) | pass | | |

## 5. Discrepancies
- Expected ownership/UUID/timestamp differences:
- Unexplained differences:
- Accepted risks and approver:

## 6. Decision
- Restore accepted: yes/no
- Conditions:
- Rollback/retention window:
- Evidence locations and hashes:
- Sign-offs (name/date):
```

The report is not approval to deploy. It is an input to the owner decision
packet and the deployment gate.

---

## 11. Risks and stop conditions

| Risk | Impact | Mitigation / stop condition |
| --- | --- | --- |
| No write fence during dump | Inconsistent cross-artifact checkpoint; unbacked writes; false RPO | Fence per B1; record RPO; stop if fence cannot be proven |
| Schema-filtered dump omits large objects | Binary data loss | Inventory `pg_largeobject_metadata`; use `pg_dump --large-objects`; verify TOC and restored count |
| Backup role cannot bypass RLS | Dump fails or is incomplete if row security is enabled | Require approved non-SUPERUSER `BYPASSRLS` backup role; never use `--enable-row-security` for a complete backup |
| Service/secret API key treated as read-only | Full project data exposure or destructive API misuse | Treat as highly privileged; allowlist only bucket-list, object-list and object-download endpoint/method pairs in reviewed exporter; short-lived custody and separate approval |
| Docker tag changes after review | Toolchain drift | Pin and invoke exact approved `image@sha256` digest |
| Shell continues after a failed step | Plaintext deletion or false-success restore | `set -Eeuo pipefail`; explicit non-zero exits; cleanup only after verification |
| GCM decrypt writes unauthenticated plaintext | Untrusted partial plaintext exposed | Decrypt to private temp file; publish only after tag/hash/length checks and atomic rename |
| Encrypted manifest bootstrap circularity | Restore cannot establish expected hashes | Authenticated AAD in each envelope bootstraps manifest decrypt; compare all entries afterward |
| Storage archive not decrypted/extracted safely | Metadata-only restore or path traversal | Decrypt archive and use reviewed safe extractor; verify complete object set and hashes |
| Backup ID collision/output overwrite | Old artifact/key overwritten or mixed backup set | UUID-backed ID; exclusive directory creation; refuse every existing output |
| Project identity inferred from database name only | Backup taken from wrong project | Verify DB host/connection info and independent Management API project ref |
| Role membership options omitted | Privilege inheritance/SET ROLE semantics change | Capture `grantor`, `admin_option`, `inherit_option`, `set_option`; review target mapping |
| Managed Auth/Storage/Vault restore unsupported | Restored app may be unusable even with a valid DB dump | G7 provider procedure; record unverified portability as blocker |
| Project customizations in managed auth/storage schemas omitted | Policies/triggers or dependent routines disappear after recovery | Capture exact catalog definitions; classify and selectively reapply only project-owned objects; never replay full managed DDL |
| App data restored before Auth dependency | FK creation or data integrity fails | Restore pre-data first, then Auth/Storage, then app data and post-data constraints |
| psql command tags contaminate JSON evidence | `jq`/comparison fails or evidence is ambiguous | Use quiet tuples-only mode, stderr separation and exactly-one-JSON validation |
| Vault root key not in dump | Vault/column-encrypted data unreadable | Custody procedure; prove decrypt before accepting |
| `META_TOKEN_ENCRYPTION_KEY` unavailable | Meta tokens cannot be decrypted | Key custody; wrong-key test; never rotate the only key |
| Storage object IDs/versions change on API upload | FK/reference breakage | Inventory references; require ID-preserving path or block |
| Storage bytes omitted or only metadata copied | Silent data loss | Byte download + SHA-256 manifest; hard stop on mismatch |
| Synthetic in-memory helper used for real data | Memory exhaustion; weak custody | Require reviewed streaming helper; do not substitute |
| AES-GCM nonce reuse | Catastrophic confidentiality/integrity failure | Fresh random 12-byte nonce per artifact; helper tests; one key per backup set |
| `openssl enc` used on this host | No AEAD; unauthenticated ciphertext | Prohibited; LibreSSL 3.3.6 lacks GCM |
| Key stored with artifacts | Encryption provides no protection | Separate custody; dual control; access review |
| Key lost or both custodians unavailable | Backup is permanently unreadable | Dual sealed copies; KMS/HSM preferred; periodic independent decrypt test; never rotate the only key |
| Encrypted manifest lost or unreadable | AAD/plaintext-hash verification and recovery indexing are lost | Replicate manifest with every artifact copy; verify read-back; keep it in both custody domains |
| Offsite transfer unavailable | Single-copy loss | G5 approved storage; read-back checksum |
| `--no-acl` or `--no-owner` misuse | Lost grants or wrong ownership | Keep ACLs; `--no-owner` only; review owner mapping |
| `pg_dump`/server version mismatch | Restore/DDL incompatibility | Pin 17.11 client; record versions; stop on mismatch |
| `--single-transaction` on a large archive | Long lock/rollback; memory/disk pressure | Measure size; use reviewed staged restore if needed; never against live |
| Local stack differs from hosted | False confidence | Record version/config differences; validate managed paths separately |
| `supabase storage --experimental` behavior | Version/metadata loss | Do not rely solely on CLI; verify manifest and bytes |
| Hash ordering/timezone/float drift | False mismatch | UTC, ISO date style, fixed float digits, explicit ordering |
| PII/secrets in logs or filenames | Data breach | Redaction; no row dumps; no tokens in argv; access-controlled evidence |
| Real staging is empty at baseline | False exemption | Recheck counts at execution; controls still apply |
| Restore target accidentally linked | Destructive operation on Staging | Scratch project, no `link`, isolated ports, verify container names |
| Owner approval mistaken for technical readiness | Premature deployment | §12 checklist must be complete; `BLOCKED` remains until then |

Immediate stop conditions:

1. checksum, GCM tag, AAD or plaintext hash failure;
2. decrypt works only for the operator, not the independent recovery owner;
3. any ledger row/version/hash mismatch;
4. unexplained table count/row fingerprint mismatch;
5. ACL/RLS/`SECURITY DEFINER` ownership mismatch that changes access;
6. missing Storage byte or byte-hash mismatch;
7. Vault/Meta token decrypt failure;
8. secret/token/password appears in a log, report, filename or Git diff;
9. target is not isolated or is linked to Staging/Production;
10. a required gate in §4 is unchecked.

On a stop: keep the source and artifacts, do not delete evidence, do not
"repair" history, do not re-encrypt around a failed decrypt, and escalate to
the owner.

---

## 12. Authorization and acceptance checklists

This section has two different decision points. **§12A is a pre-execution GO
checklist** and must be signed before B0. **§12B is a post-execution acceptance
checklist** and can only be completed after B13/R11. Do not require §12B to
authorize B0; do not treat §12A as proof that backup/restore succeeded.

### 12A. Pre-execution authorization — sign before B0

- [ ] Staging project `qmhfmgkymjgoevwmkidm`, source branch/commit and full
  40-character SHA, artifact scope and Production exclusion independently confirmed.
- [ ] Backup/recovery owners, key custodians, approvers, security reviewer and
  database reviewer named.
- [ ] Maintenance window, write fence, queue drain and external-send fence approved.
- [ ] Retention, target RPO/RTO and validation tolerances approved.
- [ ] No Production credential/endpoint is reachable by the backup or restore process.
- [ ] Dedicated DB backup role has required table/sequence/large-object read
  grants and approved `BYPASSRLS`; no SUPERUSER and no write grants; `PGPASSFILE`
  is `0600` and injected through the approved mechanism.
- [ ] Storage API key type and elevated privilege impact approved; reviewed
  exporter restricts exact bucket-list/object-list/object-download methods;
  redirects and writes are denied.
- [ ] Management API access for Auth/Storage/Vault inventory approved.
- [ ] PostgreSQL image invoked by immutable approved `image@sha256:<digest>`;
  client/server versions and provider CA validated.
- [ ] Streaming AES-256-GCM helper is implemented, independently reviewed and
  tested for authenticated decrypt, manifest bootstrap, nonce uniqueness,
  tamper/truncation, byte/hash verification and atomic publication.
- [ ] Storage exporter and safe extractor are implemented/reviewed; archive
  directory-entry contract matches extractor behavior; traversal/link/collision
  tests pass.
- [ ] Storage restore helper and owner-map helper are implemented/reviewed and
  tested on synthetic local data.
- [ ] Managed-schema customization inventory and selective-apply procedure are
  implemented/reviewed; no managed platform DDL replay is permitted.
- [ ] Detailed catalog comparator is implemented/reviewed; owner normalization
  is limited to the approved map and security-sensitive fields remain exact.
- [ ] Provider-supported Auth/Vault recovery procedure is supplied if measured
  non-empty state is to be restored; otherwise non-empty state is a hard stop.
- [ ] Offsite/WORM storage, retention, immutable path, read-back adapter and
  checksum verification approved.
- [ ] Disposable local restore target approved; migrations/seed disabled;
  ports and Docker resources verified free/sufficient.
- [ ] Evidence redaction, log destinations, closeout procedure and recovery
  confirmation template approved.
- [ ] Backup owner and operations approver sign explicit GO for this backup
  window. This runbook itself is not approval.

If any applicable pre-execution item is unchecked, stop before B0. The owner
must explicitly decide whether a limited-scope zero-state rehearsal is in scope;
that does not waive any other gate.

### 12B. Post-execution acceptance — complete only after backup and restore

- [ ] Backup checkpoint includes application schema/data, all selected
  dependencies, migration ledger, managed-schema customization inventory,
  detailed catalog evidence and platform inventory.
- [ ] Storage bucket metadata and every object byte are encrypted and checksummed.
- [ ] Artifact TOC, roles fallback, ledger hashes and large-object OID/size/hash
  manifest (when non-zero) verified.
- [ ] Independent recovery owner decrypt and offsite read-back verified.
- [ ] Restore ran only on the disposable local stack; target identity and
  teardown evidence retained.
- [ ] Auth was restored before application data/FK post-data, or measured zero
  state and dependency checks were recorded.
- [ ] Storage was restored before application data where required; object ID/
  version limitations and direct references were resolved or accepted as a hard stop.
- [ ] Application pre-data, data and post-data completed in the approved order.
- [ ] Ownership mapping and every `SECURITY DEFINER`/ACL check passed.
- [ ] Managed `auth`/`storage` customizations were classified and only approved
  project-owned objects were reapplied; verification report passed.
- [ ] Counts, SHA-256 row fingerprints, detailed catalog, ledger, ACL/RLS
  (including API-level tenant and AAL2 tests), Storage bytes, Auth/Vault and app
  smoke tests passed or have explicit owner-accepted explanations.
- [ ] Supplemental B12 fence-end closeout was encrypted, transferred and read
  back; B13 measured RPO/RTO are recorded without inferred zero values.
- [ ] Recovery confirmation report completed and independently reviewed.
- [ ] No secret, token or private row appears in logs/evidence/Git.
- [ ] Rollback/retention window and teardown evidence recorded.
- [ ] Owner separately authorizes any next deployment step; no flag is enabled
  by this runbook.

### Sign-off — pre-execution authorization

| Role | Name | Decision | Date | Reference |
| --- | --- | --- | --- | --- |
| Backup owner | | | | |
| Recovery owner | | | | |
| Key custodian A | | | | |
| Key custodian B | | | | |
| Operations approver | | | | |
| Security reviewer | | | | |
| Database reviewer | | | | |
| Product/Auth owner | | | | |

### Sign-off — post-execution acceptance

| Role | Name | Decision | Date | Evidence reference |
| --- | --- | --- | --- | --- |
| Recovery owner | | | | |
| Independent reviewer | | | | |
| Database reviewer | | | | |
| Security reviewer | | | | |
| Backup owner | | | | |

---

## 13. Relationship to deployment gates

The selective runtime requires `META_ADS_BACKUP_RESTORE_VERIFIED=1`,
`META_ADS_OWNER_APPROVED=1` and an approval reference. This runbook does not set
them. They remain unset until:

1. a real encrypted staging backup exists;
2. an isolated restore passes §9;
3. the §10 report is reviewed;
4. §12A pre-execution authorization and §12B post-execution acceptance are signed;
5. the owner issues a separate deployment authorization.

Until then, PR #139 stays open/unmerged and hosted execution stays blocked.

---

## 13A. Revision 3 static-review traceability

| Finding from 2026-10-31 review | Revision 3 treatment | Status after document edit |
| --- | --- | --- |
| P1-01 missing app/Storage decrypt commands | R1 now decrypts `db/app.dump`, Storage archive/manifest/buckets, and source validation evidence using manifest-derived SHA-256 | Documentation corrected; helper still missing |
| P1-02 host `psql` missing and B0 order wrong | B0 exports variables first and defines a pinned Docker `source_psql` wrapper before identity checks | Documentation corrected; not executed |
| P1-03 B2/B3 SQL not written/executed | B2/B3 now create SQL files, capture inventory/checkpoint output through `source_psql`, and run the source row fingerprint | Documentation corrected; not executed |
| P1-04 pooler username hard-coded | B0 defines `DB_USER` for direct vs session pooler and requires matching `.pgpass` entry; B4-B6 use it | Documentation corrected; owner must supply exact pooler endpoint |
| P1-05 ownership mapping only prose | R5 defines owner-map JSON, deterministic plan/helper contract, approval hash and post-apply verification requirements | **Not closed for execution**; `owner-map.mjs` still missing |
| P1-06 Auth/Vault restore placeholders | R8/R9 define zero-state skip vs non-empty hard stop and require exact provider/KMS proof; no unsupported API is invented | **Not closed for non-empty state**; provider procedure and isolated proof still missing |
| P2-01 local port collisions | R0 uses separate 563xx ports, adds analytics/edge inspector and checks port availability | Documentation corrected; local check required |
| P2-02 checksum includes raw `*.aesgcm` object | B9 prunes `storage/bytes/` | Documentation corrected |
| P2-03 only one bucket/example config | R7 requires all buckets and full supported configuration via reviewed helper | Design specified; helper missing |
| P2-04 hard-coded 21 ledger rows | §9.3 now compares to fresh B3 evidence | Documentation corrected |
| P2-05 Bash code labelled `sh` | All shell fences are labelled `bash` | Documentation corrected |
| P2-06 container plaintext after failed restore | R5 removes container-side dump/TOC on both success and failure | Documentation corrected |
| P2-07 R10 reads deleted B11 plaintext | R1 decrypts source validation evidence; R10 compares to restore-local evidence | Documentation corrected |
| P2-08 review traceability | Header identifies the supplied review report as session evidence, not a committed artifact | Documentation corrected |

This table records document changes only. It is not evidence that the helper
implementations, credentials, key custody, offsite storage, Auth/Vault
procedures or local restore rehearsal exist.

## 13B. Revision 4 static-review traceability

| Finding from second 2026-10-31 review | Revision 4 treatment | Status after document edit |
| --- | --- | --- |
| V3-P1-01 — psql command tags contaminate JSON | B2/B3/R10 use quiet, tuples-only capture, stderr separation and single-JSON validation | Documentation corrected; must be tested against pinned psql 17.11 |
| V3-P1-02 — pooler login compared to current_user | B0 separates `DB_USER` routing login from `DB_EXPECTED_ROLE=backup_ro` | Documentation corrected; live pooler identity remains unverified |
| V3-P1-03 — managed-schema customizations omitted | B3 captures auth/storage policies, triggers, dependent routine definitions, indexes, constraints and RLS; R9A selective-apply gate | Capture SQL and helper remain unexecuted; helper missing |
| V3-P1-04 — Auth FK restore ordering | Restore staged pre-data → Storage/Auth → app data → post-data constraints | Design corrected; provider Auth path and synthetic dependency rehearsal required |
| V3-P1-05 — archive directory entries rejected | Extractor contract explicitly permits only validated directory entries/root marker emitted by B8 | Contract corrected; safe extractor missing and tests required |
| V3-P2-01 — container dump cleanup incomplete | R5/R8 install cleanup traps before copying plaintext and use unique remote paths | Documentation corrected; trap behavior not exercised |
| V3-P2-02 — authorization/acceptance checklist circularity | Split §12A pre-execution GO from §12B post-execution acceptance | Documentation corrected |
| V3-P2-03 — fenceEnd unavailable at B9 | Main manifest records only known checkpoint fields; B12 emits encrypted supplemental closeout | Design corrected; offsite transfer adapter still missing |
| V3-P2-04 — B6 fallback unreachable | `pg_dumpall` is guarded by `if`, partial output removed, recognized privilege failure selects B3 JSON fallback | Documentation corrected; not executed |
| V3-P2-05 — catalog evidence incomplete | B3 adds detailed index/routine/constraint/sequence/comments evidence; §9.2 compares details, not only counts | SQL capture remains unexecuted; target comparison needs tests |
| V4-P1-01 — JSON includes psql command tags | Use `-qAt`, stderr separation and single-document JSON validation | Static correction only; pinned-client execution still required |
| V4-P1-02 — pooler routing username differs from database principal | Separate `DB_USER` and `DB_EXPECTED_ROLE` | Static correction in v4 separates routing login from expected PostgreSQL role; still requires an approved live pooler identity test |
| V4-P1-03 — managed Auth/Storage customizations omitted | Capture policies, triggers, dependent routines, indexes, constraints and RLS | Capture SQL unexecuted; helper and classification still missing |
| V4-P1-04 — Auth FK dependency order | Restore pre-data, then Storage/Auth, then app data and post-data | Design correction only; provider import and trigger side effects unverified |
| V4-P1-05 — archive directory member mismatch | Permit only validated root/parent directory entries | Contract correction only; extractor missing |
| V4-P2-01 — container cleanup misses pre-if failures | Cleanup traps installed before copy in R5/R8 | Still must test signal, Docker daemon and container-unavailable paths |
| V4-P2-02 — checklist circularity | Split §12A authorization and §12B acceptance | Document corrected |
| V4-P2-03 — fenceEnd unknown at manifest time | Supplemental B12 closeout | Still requires actual read-back receipt gate and offsite adapter |
| V4-P2-04 — roles fallback unreachable | Guard optional `pg_dumpall`; B3 JSON fallback | SQL role inventory requires pinned-client test |
| V4-P2-05 — catalog evidence too shallow | Detailed catalog JSON | Source/target comparator still missing |

No finding is marked implementation-closed. Revision 4 is still a document-only
change and does not create any helper, credential, backup artifact or restore
proof.

## 14. References

- [Supabase backup and restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
- [Supabase API keys and secret-key handling](https://supabase.com/docs/guides/getting-started/api-keys)
- [Supabase CLI local configuration (`local_smtp` ports)](https://supabase.com/docs/guides/local-development/cli/config)
- [Supabase local development](https://supabase.com/docs/guides/local-development)
- [PostgreSQL 17 `pg_dump`](https://www.postgresql.org/docs/17/app-pgdump.html)
- [PostgreSQL 17 `pg_restore`](https://www.postgresql.org/docs/17/app-pgrestore.html)
- [PostgreSQL 17 `pg_dumpall`](https://www.postgresql.org/docs/17/app-pg_dumpall.html)
- [PostgreSQL 17 `pg_auth_members` catalog](https://www.postgresql.org/docs/17/catalog-pg-auth-members.html)
- [Supabase Storage REST API](https://supabase.com/docs/reference/self-hosting-storage)
- [Supabase Storage OpenAPI specification](https://supabase.github.io/storage/)
- [PostgreSQL 17 binary-string SHA-256 function](https://www.postgresql.org/docs/17/functions-binarystring.html)
- [Supabase Storage API](https://supabase.com/docs/reference/javascript/storage-from-download)
- [Supabase Vault](https://supabase.com/docs/guides/database/vault)
- [`META_ADS_STAGING_SAFE_DEPLOYMENT_PLAN.md`](META_ADS_STAGING_SAFE_DEPLOYMENT_PLAN.md) §8
- [`META_ADS_STAGING_PRE_DESTRUCTIVE_REMEDIATION.md`](META_ADS_STAGING_PRE_DESTRUCTIVE_REMEDIATION.md) §E
- [`META_ADS_SELECTIVE_RUNTIME_REMEDIATION.md`](META_ADS_SELECTIVE_RUNTIME_REMEDIATION.md)
- [`META_ADS_SELECTIVE_LEDGER_IMPLEMENTATION.md`](META_ADS_SELECTIVE_LEDGER_IMPLEMENTATION.md)

---

## 15. Historical conclusion — revision 4 (superseded by revision 6)

Revision 4 incorporates the second 2026-10-31 static-review report at the
design/documentation level. It corrects psql JSON capture, separates pooler
routing login from the database principal, captures managed-schema
customizations without replaying full managed DDL, stages restore around Auth
foreign-key dependencies, aligns archive directory entries with safe extraction,
adds broader container plaintext cleanup, separates authorization from
post-execution acceptance, records fence end in a supplemental closeout, makes
the optional roles export fail safely, and adds detailed catalog evidence.

This is **not** an implementation-complete backup/restore system. The
`aesgcm-stream.mjs`, `safe-extract-storage.py`, `storage-export.mjs`,
`storage-restore.mjs`, `owner-map.mjs`, `managed-customizations.mjs` and `catalog-compare.mjs` helpers
remain missing and must be implemented, independently reviewed and tested. Auth and Vault recovery for
any non-empty state remains blocked until exact provider/KMS procedures and an
isolated proof are supplied. Credentials, KMS/HSM custody, offsite/WORM storage,
retention/RPO/RTO, restore target and owner approvals also remain outstanding.

The v3 review report and this revision are documentation artifacts, not evidence
that a real backup or restore occurred. No Hosted Staging or Production
connection, backup, restore, migration, deployment, PR merge, secret change or
flag change was performed while preparing v4. The v4 file is a documentation
revision only; all helper contracts remain unimplemented. Keep PR #139 open and unmerged.
Until every prerequisite in §2.3, every gate in §4 and §12A/§12B, every helper test, provider procedure, managed-customization comparison, dependency-order rehearsal and an independent full restore rehearsal are complete, the status remains
**BLOCKED**.

BLOCKED


## 16. Revision 5 — independent review remediation (2026-10-31)

> **STATUS: DOCUMENTATION REVISION ONLY — EXECUTION REMAINS BLOCKED.**
> This revision incorporates the third independent static-review report supplied
> on 2026-10-31. The report identified no P0 in its static-review scope, but
> found three P1 and five P2 issues. This revision does not establish that any
> helper exists or that any backup/restore operation has been executed.

### 16.1 P1-01 — B3 must not chmod a B6-produced artifact

`validation/roles-status.json` is created only by B6. It MUST NOT appear in
B3's chmod or validation list. B3 captures `roles-inventory.json`; B6 alone
creates, validates and chmods `roles-status.json` after the optional roles
export/fallback decision. Do not create a placeholder in B3.

### 16.2 P1-02 — restore cleanup lifecycle

R5 and R8 MUST run as separate scripts or explicitly scoped subshells. A
Markdown code-fence boundary does not terminate a shell and does not fire an
EXIT trap. The operator must not paste both phases into one long-lived shell
with traps that overwrite one another.

Each phase must:
- establish its unique remote temp directory and cleanup function locally;
- install EXIT, INT and TERM handling before copying plaintext into the
  container;
- remove remote plaintext and the temp directory explicitly on successful
  completion, then remove its own traps;
- on failure, attempt cleanup and preserve the original nonzero status;
- if Docker is unavailable or cleanup cannot be confirmed, mark the disposable
  target compromised, stop all further phases and tear down that isolated stack
  before retrying.

The inline R5/R8 snippets have explicit success cleanup and signal handlers.
They still require helper-level tests for Docker daemon loss, container exit,
SIGINT, SIGTERM and failure before/after each `docker cp`. A single shared EXIT
trap across phases is prohibited.

### 16.3 P1-03 — managed Auth/Storage relation and column ACL

The managed-customization inventory MUST capture relation-level `pg_class.relacl`
and column-level `pg_attribute.attacl` for relevant `auth` and `storage`
relations, in addition to owners, RLS, policies, triggers, indexes, constraints
and dependent routine definitions.

ACL comparison must preserve the semantic distinction between:
- NULL ACL (default privileges apply),
- explicit empty ACL,
- explicit grants/revokes,
- grantee and grantor,
- privilege type,
- grant option.

Do not replay all managed-schema DDL. Classify platform baseline separately from
project-owned customization. `managed-customizations.mjs` must produce a
deterministic plan, require approval of its hash, apply only approved project
customizations to the isolated target, and compare effective privileges after
application. No implementation or rehearsal is implied by this text.

### 16.4 P2-01 — qualify relation comments by catalog

Relation and column comment queries MUST join `pg_description` with
`d.classoid = 'pg_class'::regclass`, as well as the correct `objsubid` predicate.
This prevents an OID collision with another catalog from being interpreted as
a relation comment. This correction is applied in the catalog SQL above.

### 16.5 P2-02 — complete offsite closeout bundle and receipt validation

The offsite bundle index MUST bind:
- Backup ID and project ref;
- every main ciphertext relative path, byte count and SHA-256;
- main manifest ciphertext hash;
- supplemental closeout ciphertext hash;
- receipt path and receipt SHA-256;
- destination identifier, immutable object version, retention-until timestamp;
- independent read-back timestamp and read-back SHA-256.

The receipt is required recovery evidence, not a local boolean assertion. R1
must validate the receipt schema and its bindings against the actual downloaded
ciphertext and the approved destination record. A missing or mismatched receipt
blocks recovery. The receipt and its checksum must themselves be stored in the
offsite bundle and recovered before R1 validation. The storage provider's
retention evidence must be independently reviewable.

The current illustrative B12/R1 snippets remain a contract, not an implemented
offsite adapter. The adapter and bundle-index verifier are still required.

### 16.6 P2-03 — nonce uniqueness across the entire backup set

Nonce uniqueness MUST be checked across the main artifacts, encrypted main
manifest, and every supplemental encrypted artifact (including
`closeout/backup-closeout.json.aesgcm`) whenever the same AES-GCM key is reused.
Decrypt success and independent checksum validation do not establish nonce
uniqueness.

The helper contract now includes `verify-nonce-set`, which must parse every
authenticated envelope header, reject duplicate `(key-id, nonce)` pairs and
verify the exact expected encrypted artifact set. If separate per-artifact keys
are adopted, their derivation/rotation and nonce domains require a separate
cryptographic review. The helper remains unimplemented.

### 16.7 P2-04 — migration ledger may be absent or present-empty

R3 records ledger state using `to_regclass`. R5 checks `to_regclass` before
querying row count. Both absent and present-empty are valid empty-target
baselines; a non-empty ledger or an unexpected relation blocks restore. Never
create a synthetic migration ledger to satisfy validation. The R5 SQL guard
above is the required behavior.

### 16.8 P2-05 — fence-end timestamp semantics

`fenceEnd` is the UTC instant immediately before the first write-capable group
is re-enabled, not a timestamp captured after all groups have been re-enabled.
Record subsequent group transitions separately. `closeoutCreatedAt` is a
different timestamp and must never be substituted for `fenceEnd`. If write
access is re-enabled in phases, the earliest transition that permits writes is
the global fence end for RPO calculation.

### 16.9 Traceability — third independent review

| Finding from third 2026-10-31 review | Revision 5 treatment | Status |
|---|---|---|
| V4-P1-01 — B3 chmods roles-status before B6 creates it | Removed roles-status from B3 artifact chmod list; B6 remains sole producer | Document correction; static verification required |
| V4-P1-02 — R5/R8 EXIT traps overlap in a shared shell | Explicit phase-local success cleanup and INT/TERM handling; require separate process/subshell per phase | Document correction; failure-path tests required |
| V4-P1-03 — managed Auth/Storage ACL evidence incomplete | Added relation and column ACL capture; define NULL/default ACL semantics and selective apply | Capture/helper implementation still missing |
| V4-P2-01 — pg_description join lacks classoid | Added `d.classoid='pg_class'::regclass` | SQL correction; pinned PostgreSQL execution required |
| V4-P2-02 — offsite receipt not recoverable/fully bound | Define complete offsite bundle index and strict receipt validation | Adapter/verifier missing |
| V4-P2-03 — closeout nonce excluded from global uniqueness | Add whole-set `verify-nonce-set` contract | Helper implementation and tamper tests missing |
| V4-P2-04 — R3 permits absent ledger but R5 assumes present | R5 branches using `to_regclass`; absent/present-empty explicit | Document correction; rehearsal required |
| V4-P2-05 — fenceEnd captured after writes re-enabled | Define fenceEnd as pre-first-write-enable timestamp; per-group transitions recorded | Document correction; operations evidence required |

### 16.10 Remaining implementation gates

The eight previously listed helpers remain mandatory:
`aesgcm-stream.mjs`, `storage-export.mjs`, `safe-extract-storage.py`,
`storage-restore.mjs`, `owner-map.mjs`, `managed-customizations.mjs`,
`catalog-compare.mjs`.

The offsite bundle-index/receipt verifier is an additional required capability
unless implemented as a reviewed mode of an existing helper. Auth/Vault
non-empty-state recovery, Meta-token recovery verification, Large Object
handling where present, chunked fingerprints for large tables, KMS/HSM custody,
credentials, pinned image digest, retention, write fence, RPO/RTO and owner
approval remain separate hard gates.

No finding is implementation-closed by a document edit. Bash syntax checks,
JSON parsing, SQL execution, helper tests, local isolated restore and independent
recovery rehearsal are distinct evidence classes and must be reported separately.

## 17. Historical conclusion — revision 5 (superseded by revision 6)

Revision 5 addresses the third review's identified documentation defects:
B3/B6 artifact ordering, restore trap lifecycle, managed relation/column ACL
inventory, catalog comment qualification, offsite receipt binding, whole-set
nonce uniqueness, absent migration-ledger handling and fence-end semantics.

This revision does NOT implement the helpers, does NOT prove Auth/Vault
recovery for non-empty state, does NOT establish offsite retention, and does NOT
constitute a successful backup or restore. No Hosted Staging or Production
connection, backup, restore, migration, deployment, PR merge, secret change or
flag change was performed while preparing v5.

Keep PR #139 open and unmerged. The status remains **BLOCKED** until all
pre-execution gates, helper tests, provider procedures, isolated restore
validation, offsite read-back and independent owner approvals are complete.

BLOCKED

## 18. Revision 6 — fourth independent review remediation (2026-10-31)

> **STATUS: DOCUMENTATION REVISION ONLY — EXECUTION REMAINS BLOCKED.**
> The fourth independent static review of v5 reported no P0, three P1 and five
> P2 findings. This revision updates the document and executable examples only;
> it does not create helpers, establish provider evidence or prove a backup or
> restore. No finding is implementation-closed by editing this Markdown file.

### 18.1 V5-P1-01 — B3 artifact chmod list

B3 now uses a Bash array and iterates over files produced by B3 itself. It
checks each path exists and is not a symlink before applying mode `0600`.
`roles-status.json` is deliberately excluded because B6 is its sole producer.
The array removes fragile continuation backslashes and duplicate paths. Static
review must inspect the resulting argument vector; `bash -n` alone cannot
prove shell argument semantics.

### 18.2 V5-P2-01 — R8 cleanup and signal lifecycle (v6 heading ID corrected in v7)

R8 now installs `EXIT`, `INT` and `TERM` traps before copying plaintext into the
container. `INT` exits with status 130 and `TERM` with status 143, allowing the
phase-local `EXIT` cleanup to run. The cleanup function removes its own three
traps, attempts removal of both remote files and the unique temporary
 directory, and returns failure if cleanup cannot be confirmed. R5 already uses
the same signal-exit convention. Each phase remains a separate script or
explicitly scoped subshell; do not paste both phases into one long-lived shell.

A helper-level test matrix is still required for SIGINT, SIGTERM, Docker daemon
loss, container exit, failure before/after each `docker cp`, remote `rm` failure,
and `rmdir` failure. If remote cleanup cannot be confirmed, the disposable
stack is compromised and no later restore phase may run.

### 18.3 V5-P1-02 — actual managed relation and column ACL capture (v6 heading ID corrected in v7)

The `managed-customizations.sql` CTE now emits `relation-acl` rows from
`pg_class.relacl` and `column-acl` rows from `pg_attribute.attacl` for relevant
`auth` and `storage` objects. Each row preserves:

- `aclIsNull` and the raw ACL text, so NULL/default ACL and explicit-empty ACL
  remain distinguishable;
- grantee (`PUBLIC` is represented explicitly) and grantor;
- privilege type and grant-option state;
- stable schema/relation/column identity.

The source SQL is evidence capture only. It does not replay managed-schema DDL
or automatically apply every captured ACL. The reviewed managed-customization
helper must classify platform baseline versus project-owned changes, produce a
deterministic plan/hash, require approval, apply only approved customizations
on the isolated target and compare effective privileges. Default ACL inventory
remains a separate required comparison; do not infer default privileges from
relation/column ACL rows.

### 18.4 V5-P1-03 — closeout checksum working directory (v6 heading ID corrected in v7)

B12 creates and verifies `closeout/SHA256SUMS` from a subshell whose current
working directory is exactly `$BACKUP_ROOT`. The checksum entries are relative
paths (`closeout/...`), so verification from an arbitrary repository-root
working directory is prohibited. R1 uses the same `(cd "$BACKUP_ROOT" && ... )`
contract.

### 18.5 Historical only — V5-P2-02 offsite bundle contract (superseded; non-normative)

This subsection preserves the original four-file design only for review
traceability. It is NOT an executable or acceptance contract. Its four-file
inventory is obsolete and must not be used by implementers or recovery
operators. The current normative closeout inventory is the six-file exact set
in §23.1 and §25.5: five payloads plus `SHA256SUMS`.

The historical four-file list was:

- `backup-closeout.json.aesgcm`;
- `offsite-readback-receipt.json`;
- `offsite-bundle-index.json`;
- `SHA256SUMS`.

The historical description of index/checksum binding is also superseded. Under
the current contract, `SHA256SUMS` covers the five payloads including the
index, while the index MUST NOT bind the checksum's final hash/version. The
provider-signed finalization receipt, stored outside the bundle in the
independent recovery-evidence registry, binds the final index and checksum
hashes, immutable versions and retention after both have been uploaded and
read back. Only §23.1, §25.5 and the current B12/R1 steps are normative.

`offsite-bundle.mjs` is a new required helper capability with `upload-readback`,
`build-index`, `finalize-upload`, `verify-index` and `verify-finalization` modes. It does not exist yet. The B12
and R1 invocations define a proposed interface only; they are not executable
until the helper and provider adapter are implemented and tested.

### 18.6 V5-P2-03 — nonce uniqueness from authenticated artifact inventories

The AES-GCM helper's `verify-nonce-set` mode no longer accepts a list of
manually maintained directory prefixes as its source of truth. It must derive
the main encrypted set from the authenticated main manifest, include the
encrypted main-manifest envelope itself, and derive supplemental encrypted
artifacts from the validated closeout bundle index. This necessarily includes
`sql/`, `logs/`, `db/`, `storage/`, `validation/`, `config/` and any other
manifest-listed path, plus the supplemental closeout envelope. It must reject
unlisted encrypted artifacts and duplicate `(key-id, nonce)` pairs across the
entire backup set when a key is reused.

This is a helper contract only. Nonce uniqueness is not proven by a successful
decrypt or checksum operation.

### 18.7 V5-P2-04 — fence-end timestamp and closeout creation are separate

B12 is split into a pre-first-enable checkpoint and a post-enable closeout:

- `fenceEnd` is captured and durably persisted immediately before the first
  write-capable group is enabled;
- successful group transitions are recorded individually, using the persisted
  global timestamp for the first transition;
- `closeoutCreatedAt` is captured only after all groups have been re-enabled;
- closeout creation reads the persisted `fenceEnd` and never replaces it with a
  later `date` call.

The first group-enable action is an owner-approved operation outside the
illustrative shell block. A failed/attempted enable must not be recorded as a
successful transition. Operations evidence must retain each group transition.

### 18.8 V5-P2-05 — revision identity and traceability

The document title, header and current conclusion now identify revision 6.
The former revision 4 and revision 5 conclusions are retained as explicitly
historical and superseded; they are not current execution instructions. The
revision 6 conclusion below is the sole current status statement.

### 18.9 Traceability — fourth independent review

| Finding from v5 review | Revision 6 treatment | Evidence still required |
|---|---|---|
| V5-P1-01 — B3 malformed `\` continuations | Replaced with B3-owned Bash array and existence/symlink checks | `bash -n` plus argument-vector test |
| V5-P2-01 — R8 missing INT/TERM handling | Added signal-to-exit traps and phase-local cleanup | Stub-Docker failure/signal tests |
| V5-P1-02 — managed ACL capture absent | Added `relacl` and `attacl` JSON evidence with NULL/empty semantics | PostgreSQL 17.11 SQL execution and source-target comparison |
| V5-P1-03 — B12 checksum cwd wrong | Create/verify checksum from `$BACKUP_ROOT` | Run in disposable fixture with relative paths |
| V5-P2-02 — receipt/index not bound | Added bundle index, receipt schema and provider finalization verification contract | Implement adapter/helper; test missing, altered and wrong-version objects |
| V5-P2-03 — nonce set omitted `sql/` and `logs/` | Derive exact set from authenticated manifest + supplemental index | Tamper/duplicate nonce tests across all artifact classes |
| V5-P2-04 — fenceEnd ordering ambiguous | Persist fenceEnd before first enable; closeoutCreatedAt after re-enable | Simulated group transition and timestamp audit |
| V5-P2-05 — revision identity stale | Header and current conclusion identify v6; prior conclusions marked historical | Review exact artifact SHA and owner sign-off against v6 |

### 18.10 Remaining implementation gates

The following capabilities remain mandatory and unimplemented unless separately
verified in the project checkout:

- `aesgcm-stream.mjs`;
- `storage-export.mjs`;
- `safe-extract-storage.py`;
- `storage-restore.mjs`;
- `owner-map.mjs`;
- `managed-customizations.mjs`;
- `catalog-compare.mjs`;
- `offsite-bundle.mjs` and the owner-approved offsite adapter;
- `fence-transitions.mjs` for the shared B12/R1 transition validator.

Also outstanding: provider-supported Auth/Vault non-empty-state recovery; Meta
token recovery proof; Large Object handling where present; chunked fingerprints
for large tables; KMS/HSM and dual-custodian key custody; read-only credentials;
immutable offsite retention; pinned image digest; maintenance/write fence;
RPO/RTO approval; disposable restore target; independent full restore rehearsal;
and owner/security/database/platform approvals.

No backup or restore may begin because of this revision. Static syntax, SQL
execution, helper unit tests, provider integration, local isolated restore and
independent recovery acceptance are separate evidence classes.

## 19. Revision 7 — fifth independent review remediation (2026-11-01)

> **STATUS: DOCUMENTATION REVISION ONLY — EXECUTION REMAINS BLOCKED.**
> The fifth independent static review of v6 reported no P0, one P1 and three
> P2 findings. This revision addresses the JSONL parsing defect, strengthens
> transition evidence and validation, makes the read-back receipt itself
> durably recoverable, and corrects the v5 finding-ID traceability. These are
> specification changes only; the referenced helpers and provider integrations
> remain unimplemented.

### 19.1 V6-P1-01 — validate JSONL as one canonical transition snapshot

The v6 defect came from slurping the JSONL file into
`GROUP_TRANSITIONS_JSON` but then passing the original JSONL path to a jq filter
that expected an array. Revision 7 removes that split source of truth. B12 calls
`fence-transitions.mjs validate-jsonl`; the helper reads the JSONL once,
validates it and emits the canonical array to stdout. That exact captured array
is the value passed to `jq --argjson` when creating the encrypted closeout. No
subsequent validation reads the mutable JSONL file again.

The validator requires:

- `inventory.backupId` to equal the execution `--backup-id`; the source approval
  document is not required to contain a Backup ID. `inventory.projectRef` and
  `source.projectRef` must both equal the execution project ref;
- `inventory.approvalRef`, `signatureEvidenceRef`, `approvedAt`, `approvedBy`
  and the ordered `approvedGroups` array to equal the corresponding fields in
  the single verified source document;
- `inventory.sourceApprovalPlaintextSha256` to equal SHA-256 over the exact raw
  plaintext bytes of the source approval document (not ciphertext);
- every transition row's Backup ID and project ref to match the execution;
- a Backup-ID/project-bound, owner-approved ordered group inventory with an
  approval reference and signature-evidence reference;
- exactly one transition for every approved group, in the exact approved order;
- exactly one `globalFenceEnd: true`, on the first approved group only; all
  transition records bind the Backup ID and project ref;
- strict UTC RFC 3339 timestamps with exactly millisecond precision (`YYYY-MM-DDTHH:MM:SS.sssZ`) that parse;
- `enableStartedAt <= enableConfirmedAt` for every group;
- each later group's `enableStartedAt` greater than or equal to the previous group's
  `enableConfirmedAt` (`>=`); transition array order is the authoritative
  operation order when two captures share the same millisecond;
- a non-empty `enableEvidenceRef` for every successful transition;
- the first `enableStartedAt` equal to the persisted `fenceEnd`;
- `closeoutCreatedAt` greater than or equal to the final confirmation (`>=`);
  the closeout is constructed only after the final enable operation has been
  confirmed, and array/operation evidence preserves ordering if timestamps tie;
- no remaining `next-group-transition.pending` file and
  `pendingTransitionCount: 0` in the closeout.

All producers use one timestamp representation: UTC RFC 3339 with exactly
three fractional digits and a `Z` suffix (`YYYY-MM-DDTHH:MM:SS.sssZ`). B2
formats PostgreSQL `clock_timestamp()` explicitly with `to_char(..., 'MS')`;
Bash checkpoints use Node `Date.toISOString()`, which emits millisecond UTC
precision. The shared validator parses timestamps as instants rather than
normalizing by string replacement. Comparisons use `enableStartedAt <= enableConfirmedAt`, subsequent
`enableStartedAt >= previous enableConfirmedAt`, and
`closeoutCreatedAt >= final enableConfirmedAt`.
Equality is permitted only at the stated millisecond precision; ordered records
and operation evidence establish sequence when timestamps tie.

`fenceEnd` is explicitly the conservative pre-enable start bound for the first
write-capable group, not the later operator confirmation timestamp and not a
claim that the database accepted a write at that exact instant. Each transition
preserves both `enableStartedAt` and `enableConfirmedAt`; B13 must report the
fence-end bound and confirmation interval separately, and must not present the
first value as an exact database write-resumption instant.

### 19.2 V6-P2-01 — durable storage and recovery of the read-back receipt

The data-object read-back receipt is now uploaded as its own immutable object
and read back after it is created. The initial upload/read-back set also
includes `manifest/SHA256SUMS`; R1 requires this file before it can validate the
main encrypted artifact set, so it must be present in the offsite index and
receipt just like the ciphertext objects. `receipt-storage-record.json` records the
remote object key, immutable version ID, byte count, ciphertext/plaintext hash
as applicable, read-back hash, destination and retention. The record and the
receipt bytes are included in the closeout checksum and bundle index. The
index binds the receipt's remote version and the exact receipt hash. The helper
must compare the receipt's object list against the complete authenticated main
manifest plus the closeout ciphertext, reject missing/extra/duplicate objects,
and verify every object version, byte count, local hash, read-back hash and
retention value before producing the storage record.

The provider finalization receipt is not left only on the backup host. After
index/checksum upload and read-back, B12 publishes the signed finalization
receipt to a separately administered recovery-evidence registry, verifies its
immutable version/read-back and emits a recovery-catalog entry. Recovery
custodians must hold the catalog locator outside the backup host and outside
`BACKUP_ROOT`. This avoids a recursive requirement to store a receipt inside
the bundle whose existence it attests. R1 begins with `recover-bootstrap`,
which validates the independent registry entry and retrieves the finalization
receipt, index, checksum, receipt object and encrypted artifact set by immutable
version. A local copy alone is not sufficient.

The recovery-evidence registry must have independent administration, separate
credentials, immutable versioning/retention and a documented availability path.
Its signed catalog entry is a bootstrap locator; the registry's provider object
version, signature and retention are verified when fetched. Two designated
recovery custodians must retain the locator through the approved retention
period. The registry and its access path require a separate failure-domain and
access-control review.

### 19.3 V6-P2-02 — strict group transition invariants in B12 and R1

B12 and R1 use the same `fence-transitions.mjs` validation contract. B12
validates the source JSONL against `approved-write-groups.json` and emits one
canonical array for the closeout. R1 decrypts the approved group inventory and
validates the authenticated closeout array again. Both paths reject missing,
extra, duplicated, reordered or unapproved groups; invalid timestamps;
non-monotonic transitions; zero or multiple global fence-end markers; missing
enable evidence; a nonzero pending-action count; or a closeout created before
all enable confirmations. R1 does not accept merely non-empty strings.

### 19.4 V6-P2-03 — preserve source finding IDs and severities

The v6 remediation headings and traceability table misassigned three v5 finding
IDs. Revision 7 corrects them without changing the source report's identity or
severity:

| Finding in the v5 review report | Correct source severity/ID | v6 section previously mislabeled | v7 canonical mapping |
|---|---|---|---|
| B3 continuation/argument parsing | V5-P1-01 | §18.1 | §18.1 |
| Managed relation/column ACL capture | V5-P1-02 | §18.3 was labeled V5-P1-03 | §18.3 |
| B12 checksum working directory | V5-P1-03 | §18.4 was labeled V5-P2-01 | §18.4 |
| R8 INT/TERM cleanup handlers | V5-P2-01 | §18.2 was labeled V5-P1-02 | §18.2 |
| Offsite receipt/bundle binding | V5-P2-02 | §18.5 | §18.5 |
| Whole-set nonce uniqueness | V5-P2-03 | §18.6 | §18.6 |
| Fence-end timestamp ordering | V5-P2-04 | §18.7 | §18.7 |
| Revision identity | V5-P2-05 | §18.8 | §18.8 |

The source review's P1/P2 severity is preserved. Any future severity change
requires a separate documented risk decision; it must not silently rename the
source finding.

### 19.5 Required helper contracts added or expanded

`fence-transitions.mjs` is a new required helper. Its `validate-approval` mode
must require exactly one JSON object in the source file, validate the document
schema and project identity, hash the exact raw plaintext bytes, verify the
owner-approval evidence against the independently supplied signer trust-root
file and approved evidence resolver, and compare fields with their correct authorities: inventory Backup ID to the
execution `--backup-id`; source and inventory project refs to the execution
project ref; approvalRef, signatureEvidenceRef, approvedAt, approvedBy and the
complete ordered approvedGroups array between inventory and the verified source
object; and sourceApprovalPlaintextSha256 to the exact raw plaintext source-byte
hash. The source object is not required to contain a Backup ID. It must reject multiple
JSON documents even when one is valid. B0 invokes it before deriving/accepting
the inventory, the first-enable gate invokes it again immediately before the
first write-capable action, and R1 invokes the same validator after decrypting
the source and inventory. The hash field is named
`sourceApprovalPlaintextSha256`; it is not a ciphertext hash. The trust-root
file is a separate custodian-supplied prerequisite at B0/first-enable and R1;
it is never reconstructed from the untrusted backup bundle.

`fence-transitions.mjs` is a new required helper. Its `validate-pending` mode
must prove the pending record binds the next exact approved group and that its
start timestamp is not earlier than the previous group's confirmation; it runs
before the operator enables that group. Its `validate-prefix` mode must read
the source JSONL once and prove that the records are a valid, exact prefix of
the approved ordered group inventory before the operator is allowed to start
the next group. Its `validate-jsonl` mode must read the final JSONL once,
reject blank/malformed/duplicate records, validate the complete approved ordered
group set and chronology, require the supplied `--pending-path` to be absent
(including symlinks), and emit exactly one canonical JSON array. It must reject
if a pending path exists even when the calling shell guard is bypassed. Its
`validate-closeout` mode must apply the same internal validator to the
authenticated `window.groupTransitions` array and verify Backup ID, project ref,
fence start/checkpoint/fence-end ordering, closeout creation time after the last
confirmation and `pendingTransitionCount == 0`. It must parse only UTC RFC 3339 timestamps with exactly three fractional
second digits and a `Z` suffix, reject unknown fields where the schema is
closed, and return nonzero on every mismatch. It must compare instants, use the
explicit `<=`/`>=` rules in §19.1, and preserve transition-array order as the
sequence authority when two timestamps are equal at millisecond precision. Prefix mode must also require the first record to be the sole
`globalFenceEnd` record and all later records to have that flag false.

`offsite-bundle.mjs` must additionally implement:

- `upload-readback`: upload all ciphertext artifacts listed in the authenticated
  main manifest, including the encrypted main manifest, the plaintext integrity
  file `manifest/SHA256SUMS`, and the supplemental closeout ciphertext; read
  every object back by immutable version and create a receipt with exact object
  inventory. The index and receipt must explicitly include `manifest/SHA256SUMS`;
- `store-receipt-readback`: upload the read-back receipt itself to the approved
  immutable destination, read it back by exact version, compare byte count and
  SHA-256, and emit `receipt-storage-record.json`. The record must include
  destination ID/prefix, object key, immutable version ID, object byte count,
  local SHA-256, read-back SHA-256 and retention-until; all fields must be
  verified against the approved destination record;
- `store-storage-record-readback`: upload `receipt-storage-record.json` itself
  to an immutable version, read it back by exact version, compare byte count and
  SHA-256, and emit `receipt-storage-record-object-proof.json`. The proof binds
  destination ID/prefix, object key, immutable version ID, byte count, local and
  read-back SHA-256, and retention. Immediately serialize the proof exactly
  once as RFC 8785 JCS UTF-8 bytes with no trailing newline, atomically replace
  the proof file with those canonical bytes, and calculate `proofSha256` over
  those exact bytes. No consumer may parse and reserialize the proof when
  byte-for-byte recovery is required;
- `build-index`: include the receipt bytes and receipt storage record, the
  storage-record object proof's exact bytes encoded as base64 in
  `proofBytesBase64`, and their raw-byte digest in `proofSha256`, the
  `manifest/SHA256SUMS` object/version and every encrypted artifact, and bind
  the exact object version/retention. The base64 value must be generated from
  the exact proof file bytes, not from a JSON object serialization;
- `finalize-upload`: upload and read back the completed index and closeout
  checksum file at immutable versions, then return a provider-signed record
  binding their hashes/versions, the receipt object version and retention;
- `publish-finalization`: publish the provider-signed finalization receipt to
  the independent recovery-evidence registry, read it back by immutable
  version, verify its signature/hash/retention, and return a durable
  recovery-catalog entry. The finalization receipt must bind the index and
  checksum hashes and immutable versions, plus the receipt object version;
- `verify-published-finalization`: fetch the registry object by immutable
  version and verify signature, hash, retention, Backup ID and project ref;
- `recover-bootstrap`: from the recovery-catalog entry, fetch and verify the
  finalization receipt from the independent registry, then fetch the index and
  closeout checksum by immutable version, retrieve the read-back receipt and
  `manifest/SHA256SUMS` by the versions in the index, retrieve the exact
  `receipt-storage-record.json` object by the immutable version bound in the
  index's storage-record object proof, verify its byte count/hash/retention and
  compare it to the proof, materialize the verified bytes as the local closeout
  file, materialize the proof as `receipt-storage-record-object-proof.json`, and
  fetch all manifest-listed ciphertexts into a new
  recovery directory without relying on a local source copy. Reject expired retention, mutable/unversioned objects,
  signature failure or any hash/version mismatch;
- `verify-index`: compare the local receipt to its storage record and index,
  then verify the remote object version/read-back/retention bindings;
- `verify-published-finalization` and `recover-bootstrap`: use an independently
  administered registry and immutable catalog entry as the only bootstrap for
  an offsite-only recovery; a file path on the original backup workstation is
  never a recovery source of record.

The recovery-catalog entry, approved destination record and approved registry
trust record are independent prerequisites supplied by custodians; they must
not be invented or reconstructed from untrusted backup contents. R1 uses the
registry trust record as the trust anchor for signature and immutable-version
verification of the catalog entry/finalization receipt.

### 19.6 Traceability — fifth independent review of v6

| Finding from v6 review | Revision 7 treatment | Evidence still required |
|---|---|---|
| V6-P1-01 — JSONL was read as a JSON array | Single-read canonical validation via `fence-transitions.mjs`; same array embedded in closeout | Unit/property tests for JSONL parsing, duplicate/missing/reordered rows and malformed timestamps |
| V6-P2-01 — receipt itself not durably stored | Added immutable receipt upload/read-back, storage record, index binding and independent recovery registry | Provider integration, object-version retention test and recovery from offsite only |
| V6-P2-02 — group transitions not fully validated | Added approved ordered inventory, group-bound pending record, chronology/evidence checks and same B12/R1 validator | Helper tests with missing/extra/reordered groups, invalid dates, duplicate global marker and pending action |
| V6-P2-03 — v5 finding IDs/severities misattributed | Corrected canonical mapping in §18.1–§18.9 and documented the v6 labeling error | Reviewer confirms each ID against the original v5 report |

### 19.7 Remaining implementation gates

The following helpers remain mandatory and unimplemented unless independently
verified in the project checkout: `aesgcm-stream.mjs`, `storage-export.mjs`,
`safe-extract-storage.py`, `storage-restore.mjs`, `owner-map.mjs`,
`managed-customizations.mjs`, `catalog-compare.mjs`, `offsite-bundle.mjs`, and
`fence-transitions.mjs`. Provider-supported Auth/Vault non-empty-state recovery,
Meta-token recovery proof, Large Object handling where present, chunked
fingerprints, KMS/HSM and dual-custodian custody, read-only credentials, pinned
image digest, maintenance/write fence, immutable offsite retention, independent
recovery-evidence registry, RPO/RTO approval, disposable restore target, full
restore rehearsal and owner/security/database/platform approvals remain hard
gates.

No finding is implementation-closed by editing this Markdown file. Static
syntax, JSON parsing, SQL execution, helper unit tests, provider integration,
local isolated restore and independent recovery acceptance are distinct
evidence classes and must be reported separately.

## 20. Historical conclusion — revision 6 (superseded by revision 7)

Revision 6 attempted to correct the eight findings reported against v5 at the document and
command-contract level; the fifth independent review subsequently identified
one P1 and three P2 findings. Revision 7 supersedes the v6 implementation contract. It fixes B3's malformed continuation by using a Bash
array; captures actual managed relation and column ACLs; adds R8 INT/TERM cleanup
handling; corrects B12 checksum verification working directory; defines
receipt/index/finalization verification; derives nonce verification from the
complete authenticated artifact inventory; separates fence-end from closeout
creation; and updates revision identity.

These changes do not implement the helpers, prove Auth/Vault recovery for
non-empty state, establish offsite retention, or constitute a successful backup
or restore. No Hosted Staging or Production connection, backup, restore,
migration, deployment, PR merge, secret change or flag change was performed
while preparing this document.

Keep PR #139 open and unmerged. The status at revision 6 was **BLOCKED**. Revision 7 supersedes this conclusion; see §21 for the current status.

**HISTORICAL — BLOCKED**

## 21. Historical conclusion — revision 7 (superseded by revision 8)

Revision 7 addressed the fifth review's one P1 and three P2 findings at the
document/contract level: B12 now validates JSONL as one canonical snapshot;
transitions are bound to an owner-approved ordered group inventory and its
preserved source approval snapshot, and include start, confirmation and
evidence-reference fields; R1 repeats the same strict
validation against the authenticated closeout; the read-back receipt itself is
stored/read back at an immutable version and bound into the index; the provider
finalization receipt is retained in an independent recovery-evidence registry;
and the v5 finding-ID/severity mapping is corrected.

These changes do not implement `fence-transitions.mjs` or `offsite-bundle.mjs`,
do not prove provider signature/retention behavior, do not establish Auth/Vault
recovery for non-empty state, and do not constitute a successful backup or
restore. No Hosted Staging or Production connection, backup, restore, migration,
deployment, PR merge, secret change or flag change was performed while preparing
this document.

Keep PR #139 open and unmerged. Revision 7 was **BLOCKED** pending helper
implementation and independent recovery evidence.

**HISTORICAL — BLOCKED**

## 23. Revision 9 — sixth independent review remediation (2026-11-01)

> **STATUS: DOCUMENTATION REVISION ONLY — EXECUTION REMAINS BLOCKED.**
> The sixth independent static review of v8 reported no P0/P1 and four P2
> findings. This revision specifies byte-exact proof recovery, field-specific
> approval binding, consistent plaintext-source hashing, and absolute-path
> recovery-root handling. These are specification changes only; no helper or
> provider implementation is implied.

### 23.1 V8-P2-01 — byte-exact storage-record proof recovery

The proof file is serialized exactly once using RFC 8785 JCS as UTF-8 with no
trailing newline. Its SHA-256 is computed over those exact bytes. The offsite
index stores the exact proof bytes in `proofBytesBase64` and the corresponding
raw-byte digest in `proofSha256`. Recovery decodes the base64 directly to the
proof file, verifies the raw-byte digest, and never parses/re-serializes the
proof to recreate a checksummed artifact. This avoids whitespace, key-order,
escaping and newline differences. The provider object-version proof remains a
separate non-recursive record.

The closeout directory has exactly six files: five payload files
(`backup-closeout.json.aesgcm`, `offsite-readback-receipt.json`,
`receipt-storage-record.json`, `receipt-storage-record-object-proof.json`, and
`offsite-bundle-index.json`) plus `SHA256SUMS`. `SHA256SUMS` contains hashes for
the five payload files; it cannot hash itself. The index MUST NOT contain the
final checksum hash/version. Only the separately stored provider-signed
finalization receipt binds the final index and checksum bytes/hash/immutable
version/retention after both are uploaded and read back.

### 23.2 V8-P2-02 — field-specific approval binding

`BACKUP_ID` is generated by the backup execution and is not expected to exist
inside the owner-approved source document. The shared validator compares:

- `inventory.backupId` to the execution `--backup-id`;
- `inventory.projectRef` and `source.projectRef` to the execution project ref;
- `approvalRef`, `signatureEvidenceRef`, `approvedAt`, `approvedBy`, and the
  ordered `approvedGroups` array field-by-field between inventory and the
  single signature-verified source document;
- `sourceApprovalPlaintextSha256` to SHA-256 of the exact raw plaintext source
  document bytes.

No comparison is made against a nonexistent `source.backupId`. Signature
verification uses the independently supplied approved trust root. Validation
must pass in B0 before the first write-group enable, at each relevant action
gate, and again in R1.

The field-authority matrix is normative and overrides any older shorthand in
this document:

| Field | Authoritative value | Comparison rule |
|---|---|---|
| `backupId` | Execution argument `BACKUP_ID`, created for this backup | Must equal the inventory and every transition/closeout record; it is not read from the source approval document |
| `projectRef` | Verified source approval document plus independently verified target identity | Source, execution target and inventory must all match the approved Staging project |
| `approvalRef`, `signatureEvidenceRef`, `approvedAt`, `approvedBy` | Signature-verified source approval document | Inventory values must equal the corresponding verified source values exactly |
| `approvedGroups` | Signature-verified source approval document | Inventory must preserve the exact ordered array; no sorting or set-only comparison |
| `sourceApprovalPlaintextSha256` | SHA-256 of the exact raw bytes copied to `approved-write-groups-source.json` | Lowercase 64-character hex; compare to raw source bytes, never to parsed/re-serialized JSON or ciphertext |
| `sourceApprovalCiphertextSha256` (optional) | Exact encrypted artifact bytes, if an encrypted copy is separately inventoried | Independent optional integrity field; never substitute for `sourceApprovalPlaintextSha256` |

The source approval document is not expected to contain `backupId`. The
execution Backup ID is a locally generated run identifier and is bound to the
source approval only by the derived inventory and subsequent signed/audited
execution records.

### 23.3 V8-P2-03 — one digest meaning across approval validation

The canonical approval digest is `sourceApprovalPlaintextSha256`, calculated
over the exact raw plaintext bytes of
`approved-write-groups-source.json`. The same value is carried in the derived
inventory, passed to `validate-approval`, and rechecked during R1. The phrase
"encrypted source approval snapshot hash" is not valid for this field. If a
ciphertext digest is needed for artifact integrity, it must be a separately
named field such as `sourceApprovalCiphertextSha256`, computed over the exact
`.aesgcm` bytes and never substituted for the plaintext-source digest.

### 23.4 V8-P2-04 — absolute, canonical offsite recovery root

R1 requires `OFFSITE_RECOVERY_ROOT` to be an absolute path. Its existing parent
is resolved with `pwd -P`; the final component must not exist or be a symlink
and is created exclusively with mode 0700. `BACKUP_ROOT` is assigned that
canonical absolute path. Before the first `cd "$BACKUP_ROOT"`, all custodian-
provided prerequisite file paths (key, catalog entry, approved destination,
registry trust record and approval trust root) are validated as absolute,
regular, non-symlink files and canonicalized to absolute paths. Helper
invocations after `cd` therefore cannot accidentally resolve a relative path
under the retrieval root. A relative recovery root is rejected before any
filesystem side effect.

These corrections close the four v8 findings at the specification level only.
The shared validators, canonical proof serializer, offsite adapter, recovery
bootstrap and all other helpers still require implementation and independent
tests. No provider/offsite or PostgreSQL execution evidence is created by this
revision.


### 23.5 Traceability — sixth independent review of v8

| Finding from v8 review | Revision 9 treatment | Evidence still required |
|---|---|---|
| V8-P2-01 — proof bytes not preserved by JSON reserialization | Index embeds exact proof bytes as base64 plus raw-byte SHA-256; R1 decodes verbatim | Helper tests proving byte-for-byte round trip and tamper rejection |
| V8-P2-02 — Backup ID compared to source field that does not exist | Field-specific binding: execution ID, source project/approval metadata/groups, raw-source digest | Validator tests for wrong execution ID, wrong project, altered metadata/groups and invalid signature |
| V8-P2-03 — encrypted snapshot hash conflicts with plaintext digest | Contract consistently names raw plaintext digest; ciphertext digest, if needed, is separate | Search/contract tests ensuring no ambiguous encrypted-source-hash requirement remains |
| V8-P2-04 — relative R1 recovery root breaks after `cd` | Absolute path required; parent canonicalized; prerequisite files canonicalized before `cd` | Shell fixtures for relative path rejection, absolute path success, symlink parent rejection and helper path resolution after `cd` |

The closeout exact-set acceptance inventory is six files: five payloads plus
`SHA256SUMS`. The checksum list covers the five payloads. The index does not
bind the checksum file; only the external provider-signed finalization receipt
binds the final index and checksum hashes, immutable versions and retention.

## 24. Historical conclusion — revision 9 (superseded by revision 11)

Revision 9 addressed the sixth independent review's four P2 findings at the documentation/contract level:

- B2 emits `checkpointAt` as canonical UTC RFC 3339 with millisecond precision;
  all shell-generated transition timestamps use the same `Date.toISOString()`
  representation, and the shared validator uses explicit instant comparisons
  with documented equality semantics;
- B12's pending-action guard is an explicit fail-closed branch and the pending
  path is passed to the shared validator;
- R1 requires an absolute `OFFSITE_RECOVERY_ROOT`, canonicalizes its existing
  parent and all external prerequisite paths before changing directory, rejects
  an existing path, and uses the resulting absolute path as `BACKUP_ROOT`;
- B0 requires exactly one approval-source JSON object, hashes the raw
  plaintext source bytes, derives the inventory from that same single parsed
  document, and invokes a shared approval/inventory binding validator before
  any write group is enabled; R1 repeats that validation;
- the source digest field is explicitly named
  `sourceApprovalPlaintextSha256`;
- `receipt-storage-record.json` is itself uploaded/read back at an immutable
  version. The proof's exact canonical bytes are embedded as base64 with a raw-
  byte SHA-256 in the bundle index and recovered verbatim by R1;
- approval validation binds execution Backup ID separately from source fields,
  compares all approval metadata/groups to the signed source, and consistently
  hashes the exact raw plaintext source bytes;
- the closeout exact-set inventory contains six files: five payloads plus
  `SHA256SUMS`; the index does not bind the checksum file, and the external
  provider-signed finalization receipt binds the final index and checksum
  hashes/immutable versions after read-back. This supersedes the earlier
  revision-9 wording that referred generally to index/finalization evidence.

These are specification changes only. The approval and transition validators,
AES-GCM helper, Storage exporter/restore helper, offsite adapter, ownership and
managed-customization helpers, catalog comparator, and provider procedures are
not implemented or proven by this revision. No SQL was run on PostgreSQL,
no Docker daemon was invoked, no Hosted Staging or Production connection was
made, and no backup, restore, migration, deployment, PR merge, secret change or
flag change was performed while preparing this document.

Keep PR #139 open and unmerged. Execution remains **BLOCKED** until all helpers
are implemented and independently tested; approval-source authenticity and
ordered-group binding pass before the first enable; offsite-only recovery can
recover and verify every closeout byte and immutable object version; Auth/Vault
non-empty-state recovery is proven; isolated full restore validation passes;
and owner, security, database and platform approvals are complete.

**BLOCKED**


### 22.1 Traceability — sixth independent review of v7

| Finding from v7 review | Revision 8 treatment | Evidence still required |
|---|---|---|
| V7-P1-01 — B2 timestamp format incompatible with strict validator | B2 emits UTC RFC 3339 milliseconds using `to_char(clock_timestamp() AT TIME ZONE 'UTC', ...)`; all Bash timestamps use Node ISO milliseconds | PostgreSQL 17.11 SQL execution and shared-validator timestamp fixtures |
| V7-P2-01 — B12 pending guard and R1 existing-root guard fail open | Replaced compound `test && test` assertions with explicit `if ... exit 1`; R1 uses a new `OFFSITE_RECOVERY_ROOT` | Shell fixtures proving pending/root-present cases exit nonzero before side effects |
| V7-P2-02 — approval inventory not proven equal to approved source before first enable | Exactly-one-document parsing, plaintext-byte hash, signer trust-root verification, full field/order equality, shared `validate-approval` at B0/first-enable/R1 | Helper tests for altered groups/metadata, wrong project, invalid signature and multiple documents |
| V7-P2-03 — B0 accepts multiple JSON documents | `jq -s` requires exactly one object before `--slurpfile` derivation | Fixtures with first-invalid/last-valid, two-valid and malformed/trailing documents |
| V7-P2-04 — receipt-storage-record bytes not recoverable offsite | Added immutable upload/read-back and a non-recursive object proof embedded in the signed/read-back index; R1 retrieves exact bytes | Offsite-only recovery fixture proving the exact six closeout files (five payloads plus SHA256SUMS) and object version/hash/retention |
| V7-P2-05 — chronology ambiguous at same-second precision | All timestamps use millisecond UTC; comparisons explicitly allow equality at that precision while preserving ordered operation evidence | Same-millisecond, boundary, monotonicity and malformed timestamp fixtures |

No finding is implementation-closed by editing this Markdown file. Static shell
syntax checks, jq fixtures, PostgreSQL execution, helper unit tests, provider
integration, offsite-only recovery and isolated full restore acceptance are
separate evidence classes.


## 25. Revision 11 — seventh independent review remediation (2026-11-01)

> **STATUS: DOCUMENTATION REVISION ONLY — EXECUTION REMAINS BLOCKED.**
> The seventh independent static review of v9 reported no P0/P1 and four P2
> findings. This revision closes the four findings at the specification level:
> byte-exact proof recovery, field-specific approval authority, one plaintext
> digest meaning, and absolute/canonical offsite recovery paths. No helper, SQL,
> Docker, provider, Hosted Staging or Production operation was executed.

### 25.1 V9-P2-01 — byte-exact proof serialization and recovery

The proof file `closeout/receipt-storage-record-object-proof.json` is created
once and canonicalized exactly once using RFC 8785 JSON Canonicalization Scheme
(JCS), UTF-8, no BOM and no trailing newline. The helper must atomically write
those canonical bytes before calculating `proofSha256`. The index stores
`proofBytesBase64`, standard RFC 4648 base64 with padding and no line wrapping,
plus `proofSha256`, lowercase hexadecimal SHA-256 of the decoded proof bytes.

R1 must decode the base64 to a temporary file, verify the byte count and
`proofSha256`, atomically rename the verified bytes to the proof path, and then
perform JSON/schema validation. It must not parse and reserialize the proof
object before checking the hash. Equivalent JSON values with different
whitespace, key order or newline are not byte-equivalent and must not be used
to recreate the proof file. The same exact byte contract applies to any helper
that materializes this proof from the index.

Acceptance fixtures must cover: exact round trip; changed base64; invalid base64;
wrong digest; added newline; alternate key ordering; truncated bytes; and a
valid JSON object whose bytes do not match the recorded digest. Every negative
case must fail before the proof is trusted.

### 25.2 V9-P2-02 — field-specific approval authority

`validate-approval` must implement the field-authority matrix in §23.2 and the B0
contract. In particular:

- execution `BACKUP_ID` is the authority for `inventory.backupId`; the source
  approval document is not expected to contain this field;
- the independently verified Staging target and signed source approval
  `projectRef` must agree;
- approval reference, signature evidence reference, approval timestamp,
  approver and ordered group list are taken from the signature-verified source
  and compared exactly with the derived inventory;
- the digest is computed over the exact raw bytes of the source snapshot;
- the signer trust root and signature/evidence validation are independent
  prerequisites, not inferred from matching JSON fields.

The validator must reject wrong execution Backup ID, wrong project, altered
approval metadata, reordered/added/removed groups, duplicate groups, invalid
signature, wrong raw-byte digest and multiple JSON documents. It must not
compare the execution Backup ID with a nonexistent source field.

### 25.3 V9-P2-03 — canonical approval digest meaning

The sole canonical approval-source digest is
`sourceApprovalPlaintextSha256`: SHA-256 over the exact raw plaintext bytes of
`approved-write-groups-source.json`. B0 computes it after copying the approved
source bytes; the derived inventory stores it; `validate-approval` checks it
before first enable; transition validation binds the same value; R1 recomputes
it from the recovered plaintext source and checks the inventory again.

Any encrypted copy may have a separately named
`sourceApprovalCiphertextSha256`, computed over the exact ciphertext bytes.
That optional field is for encrypted-artifact integrity only. No prose, schema,
helper argument, manifest field or acceptance test may describe the plaintext
digest as a hash of an encrypted snapshot. Search/contract tests must assert
that the two names are never used interchangeably.

### 25.4 V9-P2-04 — absolute paths before recovery working-directory changes

R1 must reject a relative `OFFSITE_RECOVERY_ROOT` before any filesystem side
effect. It resolves the existing parent physically (`pwd -P`), rejects a
symlink parent and existing final component, and constructs one canonical
absolute root. `BACKUP_ROOT` is assigned only that canonical path.

Before the first `cd`, R1 must canonicalize every prerequisite file path to an
absolute path: key file, recovery-catalog entry, approved destination record,
registry trust record, approval trust root and any externally supplied
finalization evidence. `REPO_ROOT` and `RESTORE_ROOT` must likewise be
canonical absolute paths. Any helper invoked after `cd` must receive these
canonical values. No later command may reconstruct a path by prefixing a
relative original input with `BACKUP_ROOT`.

Acceptance fixtures must prove: relative root rejected before mkdir; absolute
root accepted only when the final path is new; symlink parent rejected;
existing root rejected; prerequisite relative path rejected; and all helper
arguments remain correct after changing to `BACKUP_ROOT`.

### 25.5 Closeout exact-set acceptance

The closeout directory contains exactly six regular, non-symlink files:

1. `backup-closeout.json.aesgcm`
2. `offsite-readback-receipt.json`
3. `receipt-storage-record.json`
4. `receipt-storage-record-object-proof.json`
5. `offsite-bundle-index.json`
6. `SHA256SUMS`

`SHA256SUMS` contains exactly five entries, one for each payload above excluding
itself. The bundle index MUST NOT contain the final checksum file's hash or
version. After the index and checksum are finalized and independently read
back, the external provider-signed finalization receipt binds both exact hashes,
immutable versions and retention. R1 must compare the sorted exact filename set,
verify all five checksum entries from the closeout directory's defined working
directory, and verify the external finalization receipt. Any missing or
additional file is a hard failure.

### 25.6 Traceability — seventh independent review of v9

| Finding from v9 review | Revision 11 treatment | Evidence still required |
|---|---|---|
| V9-P2-01 — proof embedded in index not byte-stable on recovery | JCS UTF-8/no-newline creation; base64 exact bytes; decoded-byte SHA-256; atomic byte-exact recovery | Helper round-trip, tamper, newline, key-order and digest-negative tests |
| V9-P2-02 — Backup ID compared to a source field that does not exist | Field-specific authority matrix; execution ID bound separately from signed source fields | Validator tests for wrong ID/project/metadata/groups/signature |
| V9-P2-03 — plaintext digest conflicts with encrypted-snapshot wording | `sourceApprovalPlaintextSha256` is the only approval-source digest; ciphertext digest separately named if used | Contract/search tests and B0-to-R1 helper tests |
| V9-P2-04 — relative recovery root breaks after `cd` | Require absolute root and canonicalize root/prerequisites before changing directory | Shell path fixtures and helper argv tests after `cd` |

### 25.7 Remaining implementation and evidence gates

This revision does not implement or prove any helper. The required helpers and
provider procedures listed in §12B remain outstanding. In particular, the
following evidence is still required before execution: byte-exact proof helper
tests; approval validator tests; PostgreSQL 17.11 SQL execution; AES-GCM
streaming/tamper tests; Storage export/restore tests; offsite immutable-version
and read-back tests; Auth/Vault non-empty-state recovery; isolated full restore;
and owner, security, database and platform approvals.

### 25.8 Document stop rule — no automatic revision loop

Revision 11 is the current documentation candidate. Do not create another
revision merely to add explanatory prose, duplicate checklists or stylistic
refinements. A further revision is justified only by (a) a reproducible P0/P1
correctness or safety finding, (b) a P2 finding that blocks a named acceptance
criterion, or (c) an explicitly approved change in scope/provider/architecture.
Every new revision must identify the exact source finding, changed contract,
acceptance test and evidence still outstanding. A review that reports only
non-blocking editorial suggestions does not trigger another revision.

## 26. Current conclusion — revision 12

Revision 12 addresses two P2 findings reported by the independent static
review of revision 11 at the documentation/contract level. This is not
implementation acceptance. The byte serializer, approval validator, path-safe recovery logic,
AES-GCM helper, Storage helpers, ownership/managed-customization helpers,
catalog comparator, fence-transition validator and offsite adapter remain
unimplemented or unverified unless independently found and tested in the
project checkout.

No PostgreSQL SQL was executed, no Docker daemon was invoked, no provider or
offsite storage was contacted, and no Hosted Staging or Production connection
was made while preparing this revision. No backup, restore, migration, deploy,
PR merge, secret change or deployment-flag change was performed.

Keep PR #139 open and unmerged. Execution remains **BLOCKED** until the
implementation tests, offsite-only recovery, Auth/Vault recovery, isolated
full restore, and required owner/security/database/platform approvals all
pass.

**BLOCKED**

## 27. Revision 11 — historical seventh independent review findings and normative corrections

Revision 11 incorporates the independent review report that examined revision
9. The report's findings were checked against the current revision-10 candidate
before editing; the following corrections are normative in this revision.

### 26.1 V9-P1-01 — remove index/checksum dependency cycle

The dependency order is strictly one-way:

1. Build `offsite-bundle-index.json` from the authenticated main manifest and
   payload metadata. The index may bind its own payload entries and the
   `SHA256SUMS` object locator only if that locator does not include the final
   checksum bytes/hash/version. It MUST NOT contain the final checksum hash,
   final checksum version, or a digest derived from `SHA256SUMS`.
2. Generate `closeout/SHA256SUMS` after the index is final. It contains exactly
   five entries and therefore hashes the index plus the other four payloads.
3. Upload and independently read back the final index and final checksum file.
4. The provider creates a signed finalization receipt OUTSIDE `BACKUP_ROOT` and
   OUTSIDE the closeout bundle. That receipt binds Backup ID, project, approved
   destination, exact index SHA-256 and immutable version, exact checksum
   SHA-256 and immutable version, retention-until, read-back timestamps, and
   provider signature/trust chain.
5. Publish/read back that finalization receipt in the separately administered
   recovery-evidence registry. R1 retrieves and verifies it independently.

There is no edge from the index back to the checksum. The finalization receipt
is the terminal external attestation; it is not included in `SHA256SUMS` and
must not be inserted into the index after checksum creation. If a provider
requires a receipt to be stored in the bundle, the adapter must use a separate
post-finalization immutable object and the recovery registry must attest its
locator; it must not mutate the already checksummed index.

### 26.2 V9-P2-01 — fail-closed prerequisite canonicalization

`canonical_existing_file` is normative only in the explicit form in R1:

- reject relative input;
- reject symlink and dangling symlink before testing regular-file status;
- reject missing files and directories;
- resolve the parent directory in a checked subshell and explicitly return
  nonzero if `cd`/`pwd -P` fails;
- validate the basename;
- print the canonical path only after all checks succeed;
- every command-substitution assignment MUST be followed by `|| exit 1` (or an
  equivalent explicit failure branch). Do not rely on `set -e` to propagate a
  failure from inside command substitution.

The function MUST NOT leave a partially canonicalized value or allow R1 to
create the recovery root or cross the bootstrap boundary after a failed
prerequisite check. Tests must cover missing file, directory, symlink,
dangling symlink, missing parent, inaccessible parent, relative path and valid
absolute path containing spaces.

### 26.3 V9-P2-02 — six-file closeout exact-set is the only current contract

The historical four-file inventory in §18.5 is explicitly non-normative. The
only current exact-set is the six regular, non-symlink files in §23.1 and §25.5:
five payloads plus `SHA256SUMS`. R1 must reject missing, extra, duplicate,
symlinked, directory or non-regular entries. `SHA256SUMS` has exactly five
entries and does not hash itself. The external provider-signed finalization
receipt, not the index, binds the final checksum hash/version/retention.

### 26.4 Acceptance status

These are documentation and contract corrections. They do not establish that
`offsite-bundle.mjs`, the prerequisite validator, or provider adapters exist or
work. Required evidence remains: helper unit/integration tests, provider
signature verification, immutable-version retention, offsite-only retrieval,
PostgreSQL 17.11 execution where applicable, and an isolated end-to-end restore.
No Hosted Staging or Production action is authorized by this revision.



## 28. Revision 12 — eighth independent review findings and current normative corrections

Revision 12 addresses the two P2 findings reproduced by the independent static
review of revision 11. These corrections are normative and supersede any earlier
R1 snippet that only enumerated regular files or relied on `set -e` to propagate
command-substitution failures.

### 28.1 V11-P2-01 — command substitutions and `find` must fail closed

Every command substitution used to canonicalize a prerequisite or inspect the
new recovery root MUST have an explicit status check at the assignment site.
Inside `canonical_existing_file`, `dirname`, `basename` and parent
canonicalization failures return nonzero before `printf`; callers MUST use
`|| exit 1`. Root and repository canonicalization assignments likewise MUST
fail explicitly. Do not use `test -z "$(find ...)"`: capture `find` output into
a variable with `|| exit 1`, then inspect the captured value. `set -e` alone is
not an acceptable error-propagation contract.

### 28.2 V11-P2-02 — complete closeout directory and checksum exact-set

R1 MUST enumerate every direct entry in `closeout/`, including directories,
FIFOs, sockets, devices and symlinks. It MUST reject every entry that is not
one of the six approved names and a regular non-symlink file. The directory
MUST contain exactly these six entries: five payloads and `SHA256SUMS`.

Before invoking `shasum -c`, R1 MUST parse `SHA256SUMS` and prove it contains
exactly five lines, each with a 64-character lowercase hexadecimal SHA-256
digest and one unique approved relative payload path. Missing, duplicate, extra,
malformed, absolute, traversal or non-whitelisted paths are hard failures. The
validated path set MUST equal the five-payload whitelist exactly. Only then may
R1 run `shasum -a 256 -c` from the defined `BACKUP_ROOT` working directory.

The six-file directory set and five-entry checksum set are separate invariants:
`SHA256SUMS` is the sixth directory entry but is not permitted to hash itself.
The provider-signed finalization receipt remains external and binds the final
index and checksum hashes/immutable versions; it is not added to the closeout
directory or its checksum list.

### 28.3 Acceptance status

Revision 12 closes the two static contract findings at the documentation and
shell-stanza level only. Required evidence still includes fault-injection tests
for `dirname`, `basename`, `pwd`, `cd` and `find`; exact-set fixtures for extra
directory, FIFO, socket, device, symlink and non-regular entries; checksum-list
fixtures for missing, duplicate, extra and malformed entries; and implementation
tests for all helpers. No SQL/provider/offsite/Hosted Staging/Production action
is authorized by this revision.
