# TARGETED RUNBOOK AMENDMENT — HELPER #4 SAFE STORAGE EXTRACTION

**Document:** `docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12_AMENDMENT_HELPER4.md`  
**Date:** 2026-11-01  
**Project:** AI CRM — Meta Ads Integration / Staging Backup & Restore  
**Target Helper:** Helper #4 (`scripts/backup/safe-extract-storage.py`)  
**Baseline Document:** `docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12.md`  
**Baseline SHA-256:** `9055dfb82934413d2bbe730b2d94d74ed6741fa5f44e1edb1081e3a0f958b737`  
**Review Authority:** Independent Code Review (`safe_extract_storage_review/INDEPENDENT_CODE_REVIEW_SAFE_EXTRACT_STORAGE.md`)  

---

## 1. Executive Summary & Amendment Scope

This document defines the **Targeted Runbook Amendment** for Helper #4 operational acceptance.

Per the Independent Code Review (`INDEPENDENT_CODE_REVIEW_SAFE_EXTRACT_STORAGE.md`):
- Helper #4 source code (`scripts/backup/safe-extract-storage.py`) is **ACCEPTED with 0 code defects and 0 security vulnerabilities**.
- Helper #4 source code and its test suite **MUST NOT be modified**.
- The Runbook v12 baseline document **MUST BE PRESERVED UNTOUCHED** (retaining SHA-256 `9055dfb82934413d2bbe730b2d94d74ed6741fa5f44e1edb1081e3a0f958b737`).
- Exactly **two operational integration gaps** identified by independent review are resolved by this amendment:
  1. **Finding B8 (GAP-01):** Prepend `COPYFILE_DISABLE=1` to the `tar` command in §B8 to prevent macOS `bsdtar` from emitting AppleDouble (`._*`) sidecars.
  2. **Finding R1 (GAP-02):** Pre-check `$RESTORE_ROOT/plaintext/storage/buckets.json` and pass `--buckets "$RESTORE_ROOT/plaintext/storage/buckets.json"` to `safe-extract-storage.py` in §R1 to authorize and restore empty buckets.

No other runbook sections, helper contracts, or architectural constraints are altered. Helper #5 is NOT implemented.

---

## 2. B7 Cross-Reference & Inventory Verification

Before amending B8 and R1, we verify the end-to-end lifecycle of `storage/buckets.json` across Runbook v12:

| Runbook Phase | Section & Lines | Specified Behavior | Verification Status |
| --- | --- | --- | --- |
| **Capture (B7)** | §B7 (lines 1599, 1618) | `storage-export.mjs` is executed with `--buckets "$BACKUP_ROOT/storage/buckets.json"` and `--manifest "$BACKUP_ROOT/storage/storage-manifest.json"`. It writes a JSON array of all project buckets (both populated and empty). | **CONFIRMED** (`storage/buckets.json` generated) |
| **Encryption (B8)** | §B8 (lines 1668–1673) | `find "$BACKUP_ROOT" -path "$BACKUP_ROOT/storage/bytes" -prune -o -path "$BACKUP_ROOT/manifest" -prune -o -type f ! -name '*.aesgcm' -print0` explicitly discovers `$BACKUP_ROOT/storage/buckets.json` and encrypts it to `$BACKUP_ROOT/storage/buckets.json.aesgcm`. | **CONFIRMED** (`buckets.json.aesgcm` generated) |
| **Manifest (B9)** | §B9 (lines 1735–1745) | `storage/buckets.json.aesgcm` is hashed into `manifest/SHA256SUMS` and listed in `backup-manifest.json` under `.artifacts[]`. | **CONFIRMED** (Tracked in root manifest) |
| **Packaging (B10)** | §B10 (lines 1820–1835) | `offsite-bundle.mjs` packages all encrypted artifacts into the verified bundle. | **CONFIRMED** (Part of offsite bundle) |
| **Decryption (R1)** | §R1 (lines 2864–2865) | `decrypt_artifact "storage/buckets.json" "$RESTORE_ROOT/plaintext/storage/buckets.json"` decrypts and validates `buckets.json` prior to storage extraction. | **CONFIRMED** (Plaintext available at `$RESTORE_ROOT/plaintext/storage/buckets.json`) |

**Conclusion:** `storage/buckets.json` is guaranteed to be generated during B7, encrypted in B8, verified in B9/B10, and decrypted into plaintext in R1 prior to Helper #4 invocation. Passing it to Helper #4 satisfies the dependency without requiring any new artifacts.

---

## 3. Amendment Item 1: §B8 AppleDouble Prevention (Finding B8 / GAP-01)

### 3.1 Problem Description
On macOS, the default archive utility (`bsdtar`) automatically serializes extended file attributes, access control lists, and Finder metadata into AppleDouble companion files (`._filename` and `._directory`). When archiving `$BACKUP_ROOT/storage/bytes` via `tar -C "$BACKUP_ROOT/storage/bytes" -cf - .`, macOS `tar` injects these `._*` members into the tar stream.

Because Helper #4 enforces strict exact-inventory verification against `storage-manifest.json`, the presence of any unlisted `._*` member in the archive triggers immediate fail-closed abort (`UNEXPECTED_OBJECT` or `UNEXPECTED_DIRECTORY`).

### 3.2 Target Location in Runbook v12
Section: **`### B8 — Encrypt every artifact`**  
Lines: 1658–1662

### 3.3 Exact Unified Diff
```diff
--- a/docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12.md (§B8)
+++ b/docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12.md (§B8)
@@ -1658,3 +1658,3 @@
 test ! -e "$BACKUP_ROOT/storage/objects.tar.zst"
-tar -C "$BACKUP_ROOT/storage/bytes" -cf - . | \
+COPYFILE_DISABLE=1 tar -C "$BACKUP_ROOT/storage/bytes" -cf - . | \
   zstd -19 -T0 -o "$BACKUP_ROOT/storage/objects.tar.zst"
```

### 3.4 Amended Operational Procedure for §B8
```bash
# 1) Storage bytes: create a path-preserving archive first.
# COPYFILE_DISABLE=1 prevents macOS bsdtar from generating AppleDouble (._*) sidecars.
test ! -e "$BACKUP_ROOT/storage/objects.tar.zst"
COPYFILE_DISABLE=1 tar -C "$BACKUP_ROOT/storage/bytes" -cf - . | \
  zstd -19 -T0 -o "$BACKUP_ROOT/storage/objects.tar.zst"
chmod 600 "$BACKUP_ROOT/storage/objects.tar.zst"
test -s "$BACKUP_ROOT/storage/objects.tar.zst"
# Keep storage/bytes until the archive is encrypted, verified and read back.
```

### 3.5 Cross-Platform Behavioral Analysis
- **macOS (Darwin / bsdtar):** `COPYFILE_DISABLE=1` is an official system environment variable recognized by macOS `archive_read_disk` / `copyfile`. It instructs `tar` to skip synthesizing AppleDouble files. The generated tar archive contains only true POSIX filesystem entries.
- **Linux (GNU tar / bsdtar):** `COPYFILE_DISABLE=1` is treated as a standard environment variable and has no adverse effects on GNU tar.

---

## 4. Amendment Item 2: §R1 Empty Bucket Restoration (Finding R1 / GAP-02)

### 4.1 Problem Description
In Supabase Storage, buckets can exist with zero objects. During backup:
- B7 creates the bucket directory in `$BACKUP_ROOT/storage/bytes/<empty-bucket>/`.
- B8 captures this empty directory into `objects.tar.zst`.
- However, `storage-manifest.json` only tracks object records; it does not represent empty buckets.

When Helper #4 extracts the archive without knowledge of `buckets.json`, it validates directories only as parents of manifest objects. Encountering an empty bucket directory without `--buckets` triggers `UNEXPECTED_DIRECTORY`, causing restoration failure.

Passing `--buckets "$RESTORE_ROOT/plaintext/storage/buckets.json"` allows Helper #4 to cross-reference authorized buckets, accept empty bucket directories in the archive, and establish them in `$RESTORE_ROOT/plaintext/objects/` with secure `0700` permissions.

### 4.2 Target Location in Runbook v12
Section: **`### R1 — Verify, bootstrap the manifest, decrypt and extract artifacts`**  
Lines: 2970–2978

### 4.3 Exact Unified Diff
```diff
--- a/docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12.md (§R1)
+++ b/docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12.md (§R1)
@@ -2970,7 +2970,9 @@
 test -f "$RESTORE_ROOT/plaintext/storage/objects.tar.zst"
 test -f "$RESTORE_ROOT/plaintext/storage/storage-manifest.json"
+test -f "$RESTORE_ROOT/plaintext/storage/buckets.json"
 test -d "$RESTORE_ROOT/plaintext" && test ! -L "$RESTORE_ROOT/plaintext"
 test ! -e "$RESTORE_ROOT/plaintext/objects" && test ! -L "$RESTORE_ROOT/plaintext/objects"
 python3 "$REPO_ROOT/scripts/backup/safe-extract-storage.py" \
   --archive "$RESTORE_ROOT/plaintext/storage/objects.tar.zst" \
   --manifest "$RESTORE_ROOT/plaintext/storage/storage-manifest.json" \
+  --buckets "$RESTORE_ROOT/plaintext/storage/buckets.json" \
   --destination "$RESTORE_ROOT/plaintext/objects"
```

### 4.4 Amended Operational Procedure for §R1
```bash
# Safely extract Storage bytes only after authenticated decrypt. The helper is
# reviewed and accepted; never use tar -xf directly.
test -f "$RESTORE_ROOT/plaintext/storage/objects.tar.zst"
test -f "$RESTORE_ROOT/plaintext/storage/storage-manifest.json"
test -f "$RESTORE_ROOT/plaintext/storage/buckets.json"
test -d "$RESTORE_ROOT/plaintext" && test ! -L "$RESTORE_ROOT/plaintext"
test ! -e "$RESTORE_ROOT/plaintext/objects" && test ! -L "$RESTORE_ROOT/plaintext/objects"
python3 "$REPO_ROOT/scripts/backup/safe-extract-storage.py" \
  --archive "$RESTORE_ROOT/plaintext/storage/objects.tar.zst" \
  --manifest "$RESTORE_ROOT/plaintext/storage/storage-manifest.json" \
  --buckets "$RESTORE_ROOT/plaintext/storage/buckets.json" \
  --destination "$RESTORE_ROOT/plaintext/objects"
```

### 4.5 Security & Defense-in-Depth Guarantees
- Passing `--buckets` activates `bucketInventoryVerified: true` in Helper #4 output.
- Helper #4 validates every bucket against strict identifier regex `^[a-z0-9][a-z0-9_.-]{1,61}[a-z0-9]$`.
- Any unlisted directory in the archive (even an empty directory) that is neither in `buckets.json` nor a parent of a manifest object is STILL rejected with `UNEXPECTED_DIRECTORY`.
- File/directory name collisions and case collisions are strictly rejected.
- Atomic directory publication guarantees that partial extracts or rejected staging directories are never published to `--destination`.

---

## 5. Verification & Testing Evidence Summary

The amendments have been validated via targeted synthetic integration tests (`tests/backup/helper4-runbook-amendment.integration.test.py`):

1. **macOS Host (Darwin arm64):**
   - B8 AppleDouble rejection without `COPYFILE_DISABLE=1`: **REPRODUCED** (`UNEXPECTED_OBJECT`).
   - B8 Clean tar with `COPYFILE_DISABLE=1`: **VERIFIED** (0 AppleDouble members, extraction passes).
   - R1 Rejection of empty bucket without `--buckets`: **VERIFIED** (`UNEXPECTED_DIRECTORY`).
   - R1 Clean restoration of empty buckets with `--buckets`: **VERIFIED** (`0700` empty directories created).
   - Result: **4/4 PASS (0.982s)**.

2. **Linux Container (Docker Ubuntu 24.04 / Linux 7.0 aarch64):**
   - End-to-end B7 export -> amended B8 tar -> amended R1 extraction: **VERIFIED**.
   - Result: **4/4 PASS (0.594s)**.

---

## 6. Strict Boundary Compliance

| Policy Rule | Status | Note |
| --- | --- | --- |
| Runbook v12 baseline preservation | **COMPLIANT** | File `docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12.md` untouched (`9055dfb8...`) |
| No helper source modification | **COMPLIANT** | Helper #1, #2, #3, #4 source files byte-identical |
| No hosted / staging network connection | **COMPLIANT** | 100% synthetic local fixtures |
| No real backup/restore executed | **COMPLIANT** | Only synthetic test runs |
| No database migrations or deploys | **COMPLIANT** | Zero schema operations |
| No secret / token modifications | **COMPLIANT** | No credentials accessed or changed |
| No commit or push | **COMPLIANT** | Working tree uncommitted per instructions |
| No PR #139 merge | **COMPLIANT** | PR #139 untouched |
| No Helper #5 implementation | **COMPLIANT** | Helper #5 completely out of scope |
