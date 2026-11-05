# Supabase Production backup and restore rehearsal

Target: `yrauljxzyklhisxijeim`, tenant `de6a7bf3-b5bc-418d-92d6-f9b241472598`, PostgreSQL **17.11**. Only `.github/workflows/supabase-production-backup.yml` can touch Production; it is manual-only and runs from `main`. The separate `Supabase Backup CI (synthetic only)` workflow never receives Production secrets.

## Current readiness

Creating/merging this workflow does **not** prove that a backup exists. Initial operational status is **BLOCKED** until the owner provisions secrets and a real backup and restore rehearsal finish. Do not enable a schedule before review of those first two runs. This change contains no scheduler, migrations, app deployment, Production restore, OAuth/Page/Messenger/Zalo mutation or tenant configuration change.

The PR stays draft until reviewed. Do not merge it solely to make the Run workflow button appear. GitHub registers `workflow_dispatch` workflows on the default branch; the Production modes deliberately reject non-main refs. After approval/merge and secret provisioning, run it on `main` using the steps below. The PR CI exercises the same dump, encryption and restore code against synthetic data.

## Owner secret configuration (never paste values into chat)

Open repository **Settings → Environments**. Create environments without purchasing a plan; if GitHub offers a paid-only protection, stop instead of upgrading. Restrict both environments to `main`; enable required reviewers where your plan supports them. Do not allow unreviewed code to receive backup secrets.

Create **environment secrets**, with these exact names:

| Environment | Secret | Value / scope |
| --- | --- | --- |
| `production-backup` | `SUPABASE_DB_URL` | Existing Session Pooler URI for this project: host shown by Dashboard Connect → Session Pooler, port 5432, database postgres, user postgres.PROJECT_REF. Use the existing password from your password manager. Percent-encode special characters. Do not reset it for this task. |
| `production-backup` | `SUPABASE_SERVICE_ROLE_KEY` | Existing server-side service-role key for this project. Its use here is limited to Storage list/download calls. The key itself has broader rights; protect the environment accordingly. |
| `production-backup` | `BACKUP_AGE_RECIPIENT` | Public native age X25519 recipient beginning `age1…`, generated and held by the owner. |
| `backup-rehearsal` | `BACKUP_AGE_IDENTITY` | Matching private age identity supplied by the owner for an explicitly requested restore rehearsal. Never put it in a backup artifact or repository. Remove the environment secret after rehearsal if you do not want GitHub retaining it. |

Direct link to environment settings: https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/settings/environments . GitHub also has **Settings → Secrets and variables → Actions → New repository secret** at https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/settings/secrets/actions . Repository secrets with the three backup names work, but environment-scoped secrets give clearer separation. Keep the owner identity in `backup-rehearsal` only; never reuse it in the backup environment.

If you need a recipient, run `age-keygen -o owner-backup-identity.txt` on your trusted local computer, then `age-keygen -y owner-backup-identity.txt` to obtain only the public recipient. Store the private file independently in your own password manager/offline custody. The agent does not create or change Production credentials. The owner explicitly decides whether to temporarily copy an identity into a GitHub environment secret for rehearsal; doing so gives that job access to the key, while no private identity is ever uploaded as an artifact.

Use a **native X25519 age recipient**, not an SSH recipient or multiple newline-separated recipients. The code checks that age accepts it before export. Missing required secrets produce `BLOCKED: MISSING_SECRET_...`; the secret name is logged, its value is not. Database credentials are parsed into libpq environment variables, never passed as a URL in process arguments. URL query options are ignored; TLS certificate verification is always `verify-full` and the DB hostname/user/project/port/database are checked. No credential is obtained/reset automatically.

## What gets exported

Inside `production-backup/`:

- `database/roles.sql`: `pg_dumpall --roles-only --no-role-passwords` (valid role attributes/configuration/memberships, with password recovery explicitly excluded).
- `database/schema.dump`: PostgreSQL custom schema dump, including user/managed schemas, functions, triggers, constraints, indexes, grants and RLS definitions that the role can read.
- `database/data.dump`: custom data dump with explicit tables and sequences, including `public`, `private`, `auth`, `storage` and `supabase_migrations`. PostgreSQL suppresses extension-member data even with explicit `--table`, so those tables are excluded from this file and exported separately below. No deliberate schema exclusion. A permission/export failure stops the run.
- `database/extension-data.sql` and `sequence-values.sql`: native PostgreSQL COPY protocol exports every physical extension-owned table, without extension configuration row filters, from the same source snapshot. Sequence states are recorded separately, including extension-owned sequences. This preserves queued net requests, historical responses, cron and Vault rows rather than assuming `pg_dump` covers them. The files are restored only on the isolated target with user triggers disabled.
- `storage/buckets.json`, `database-objects.json`, `objects-manifest.json` and `storage/files/<bucket>/<original-path>`: bucket configuration/ownership, object metadata and actual private/public binaries.
- `configuration/`: baseline counts, all non-system table counts, role attributes/memberships, extension versions, catalog definitions/ACLs and multiset fingerprints of selected CRM/identity/migration rows. Sensitive metadata stays encrypted.
- `configuration/database-settings.json`: current database catalog metadata (including locale/provider/ACL) and applicable per-database/per-role settings. These can contain operational secrets and stay encrypted. They are captured for recovery review, not automatically reapplied on the rehearsal target.
- `backup-report.json`, `restore-report.json`, `checksums.sha256`: initial status and exact file integrity manifest. The initial restore report is BLOCKED/NOT_RUN. The completed encryption receipt is detached to avoid hashing an archive inside itself.

Database schema/data and baseline use one exported **REPEATABLE READ READ ONLY snapshot**. `default_transaction_read_only=on` applies to every source libpq/pg_dump connection. Roles and sequences are checked again for change. Sequence values are not MVCC snapshots; a detected change makes this attempt PARTIAL instead of accepting inconsistent sequence recovery. Storage API folder listings are paginated with bounded concurrency 4, five retry attempts for transient failures and strict path checks. SQL object metadata is keyset-paginated inside the database snapshot. The API listing must match that metadata before and after all downloads, and live bucket/object metadata is checked again. Object count, declared byte count, downloaded sizes and SHA-256 must agree. **An active upload/update/delete can make an attempt fail/PARTIAL; do not pause Production or weaken the checks to force success.** A quiet interval or a future versioned-storage design may be needed.

The PostgreSQL image is pinned to Supabase `17.11.0.002` and its immutable image digest. Exact source/client/restore PostgreSQL 17.11 versions are checked. A later Production version upgrade requires a reviewed code/image update. Never use `latest` silently. Extension versions unavailable on the rehearsal image block restore. Foreign tables/materialized views currently require explicit review rather than silently excluding or running refreshes.

## Encryption, files and retention

The publish directory contains only:

1. `production-backup.tar.gz.age` — encrypted payload.
2. `backup-report.json` — sanitized aggregate counts/status, missing-component notices and ciphertext SHA-256; no customer rows, SQL, object paths or raw error messages.
3. `checksums.sha256` — hashes the ciphertext and detached report, excluding itself.

The backup job adds a temporary, job-only X25519 recipient alongside the owner recipient. It actually decrypts the ciphertext with that temporary identity and compares the tar bytes/hash. The temporary identity is destroyed and never uploaded. This proves the encryption roundtrip, **not** that the owner's key was configured correctly; the separate owner-key restore proves that. All encrypted payload/report file hashes are validated before upload. Every temporary plaintext and key file is removed by an `always()` cleanup step, and the hosted runner is discarded afterward. If the runner is forcibly terminated, runner disposal is the final boundary; software cleanup cannot be guaranteed after host loss.

Artifacts are retained **14 days**, subject to the repository's shorter retention limits. This is not a permanent backup vault. The owner must download and keep the encrypted artifact, checksum and decryption identity in independently controlled storage before expiry. No paid storage account is created. Artifact storage/runner usage follows the repository's existing GitHub quota; this workflow provisions no paid resources, but GitHub usage can count against the existing plan/billing policy.

Hash manifests use exact file sets and never hash themselves. Archive extraction rejects duplicate paths, traversal, symlinks/devices, excessive sizes and unlisted files. Age authentication, local SHA-256 and GitHub's immutable artifact/provenance checks have different roles; none of them make an incomplete export complete.

## First Production backup (only after secrets are configured and PR approved/merged)

1. Open **Actions → Supabase Production Backup → Run workflow**. Choose branch `main`, mode `backup`; leave restore source inputs unused. Link: https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/actions/workflows/supabase-production-backup.yml .
2. Review environment approval if configured. Wait for the export, age self-test and artifact upload steps. Do not treat the green job alone as full Supabase recovery.
3. Download `supabase-production-backup-<run-id>-<attempt>` from that run. Record run URL, head SHA, UTC timestamps, the detached `backup-report.json`, file counts and checksums. A partial/failed export may have an encrypted artifact for diagnosis; it is ineligible for restore acceptance. A missing recipient may prevent any artifact upload.
4. Verify `sha256sum -c checksums.sha256` after extracting the GitHub artifact ZIP. Retain the encrypted file and its manifest outside GitHub. Keep the private key separate.

No Production backup run is dispatched automatically by the agent or PR CI. Owner secret provisioning is the required next operational step.

## Separate restore rehearsal

1. Supply the matching owner key only as `BACKUP_AGE_IDENTITY` in environment `backup-rehearsal`.
2. Manually dispatch the same workflow on `main`, mode `restore-rehearsal`, source backup run ID and attempt number. The run must be a successful manual run of this exact workflow in this repository from `main`; arbitrary PR/fork/artifact sources are refused.
3. The job downloads the encrypted artifact, validates its exact file set/SHA-256, decrypts it and checks every internal file. It receives **no Production DB URL or service-role key**. Code also refuses to proceed if either is present in its process environment.
4. Restore runs on a fresh PostgreSQL 17.11 container with **`--network none`**, no exposed ports, no mounted owner key and no Supabase bootstrap migrations. The empty cluster uses the source bootstrap role name for OID 10 so PostgreSQL 17 `GRANTED BY` semantics survive. A rehearsal-only role script omits exactly one CREATE for that already initialized role, retaining all ALTER/grant statements; the original dump stays unchanged. Unsupported bootstrap roles block rehearsal. Database roles, schema and data are restored with stop-on-error/transaction flags; user triggers are disabled for data import only on this target. Cron launch is disabled. pg_net must be preloaded to install its extension, but its worker connects only to empty `template1`, which has no pg_net extension or restored queues. The settings and container network mode are checked before restoring. The container cannot call Production, Messenger, Zalo or webhooks. Synthetic CI preserves an old response and an unprocessed queue entry to catch accidental worker activity. No source SQL errors or customer payload are printed.
5. Compare all inventoried table counts, routines/triggers/constraints/indexes/policies/ACL definitions, sequence states, role attributes/memberships, migration content, tenant counts and selected CRM/identity row multiset fingerprints. Verify every local Storage binary against its size/hash manifest. Check the sanitized `restore-report.json` artifact; `verification` lists the checked scope and restore exit codes. Delete the GitHub identity secret when finished if desired.

This is a database restore and local Storage-binary integrity test. It does not import files into a live Storage service or prove Auth login/OAuth/Realtime/webhook/application behavior. Never point this code at Production to restore it. A real incident recovery needs a separately authorized runbook and destination review.

The rehearsal cluster is initialized with UTF8 encoding and C locale. Source database locale/provider and role settings are recorded separately; this version does not clone or apply them. Row/catalog comparisons therefore do not prove locale-sensitive sorting, case conversion, collation or application behavior. Review these settings before any incident recovery, and keep this limitation in the reports.

## Status interpretation and missing components

| Field / result | Meaning |
| --- | --- |
| `status=BLOCKED` | Missing secrets, wrong project/version, absent runtime/access or untrusted source. |
| `status=FAIL` | Execution, integrity or restore mismatch. No recovery claim. |
| `status=PARTIAL` | Export incomplete, moving Storage/sequence snapshot, or remaining platform recovery gaps. |
| `restore_status=PASS` | Actual owner-key decryption, isolated DB restore, inventory/CRM comparison and local Storage checks all succeeded. |
| Overall `status=PASS` | Reserved for full requested backup/recovery scope with no unresolved components; **not emitted by this version** because platform/service gaps remain. |

This version always reports platform recovery gaps separately: Auth provider/SMTP/JWT/API settings, Edge Function source/deployment secrets, original role passwords, Vault/column-encryption external keys, and service-level Auth/Storage/Realtime/application recovery. Database Auth rows can be in the dump and pass row counts while Auth service recovery remains untested. Database webhook/cron definitions stored in the database travel with the dump; external endpoints, credentials, platform settings and scheduling behavior are not proved. No claim that these unavailable secrets/settings have been backed up.

The full archive includes row data from all readable non-system tables, including Messenger/Zalo identity tables; reports contain only aggregate counts and fixed error codes. Tenant filters are used for verification, not to narrow the backup and silently discard other tenants. The system's policies/configuration are not modified.

## Validation and review

Run `ruff check --select E4,E7,E9,F scripts/production_backup tests/production_backup`, `python -m compileall -q scripts/production_backup tests/production_backup`, and `python -m unittest discover -s tests/production_backup -p 'test_*.py' -v`. `tests/production_backup/fixture_roundtrip.py` needs Docker, age and the hashed Python requirements; it creates synthetic private bucket objects, CRM/Auth/private data, RLS, roles, grants, triggers, indexes, sequences and supported extensions. It performs real dumps, age encryption/owner-key decryption and an isolated restore without any real Production credential. CI does not upload synthetic plaintext or private keys. CI success must be distinguished from a Production backup/rehearsal success.

Dependencies/action revisions/image digest are pinned. DB credentials are never put in arguments/debug logs; errors are fixed codes. The service-role key is sent only to the fixed project's HTTPS Storage endpoint; redirects are refused. Updating dependency pins, role/grant normalization, extension handling, archive validation or scope requires re-running the synthetic roundtrip/security tests.

Official references: [Supabase backups](https://supabase.com/docs/guides/platform/backups), [Supabase platform restore](https://supabase.com/docs/guides/self-hosting/restore-from-platform), [Storage downloads](https://supabase.com/docs/guides/storage/management/download-objects), [PostgreSQL pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html), [PostgreSQL pg_dumpall](https://www.postgresql.org/docs/17/app-pg-dumpall.html), [age](https://github.com/FiloSottile/age), [GitHub manual workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).
