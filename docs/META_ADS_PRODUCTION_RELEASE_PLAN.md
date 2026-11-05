# Meta Lead Ads — Production release plan

**Status:** implementation preparation; Production writes are gated  
**Owner-approved target:** `yrauljxzyklhisxijeim`  
**Owner-approved tenant:** `de6a7bf3-b5bc-418d-92d6-f9b241472598`

This document supersedes the Staging-only destination language for the owner-approved Meta Lead Ads rollout. It does not treat approval of the target as evidence that a backup, restore rehearsal, deployment, or Page subscription change has happened.

## 1. Approved scope

Only these four Pages may be connected to the approved tenant:

| Page | Page ID |
|---|---:|
| Poland | `1418087751743574` |
| Germany | `1026991374010112` |
| Austria | `654520554683416` |
| German Language Center | `1014780055265237` |

The Europe Page is excluded. Do not create a separate Supabase Staging project as the delivery target. The release destination in GitHub is `main`.

## 2. Read-only Production baseline observed 2026-11-05

The Supabase project metadata identifies:

- Project ref: `yrauljxzyklhisxijeim`.
- Project name: `ai-crm-cua-chong-ngap-demo`.
- Region: `ap-southeast-1`.
- Status: `ACTIVE_HEALTHY`.
- PostgreSQL: `17.11.0.002`.
- Organization plan: `free`.

Read-only inspection of `supabase_migrations.schema_migrations` returned **102 migration records**. The current application database already contains live CRM data and is not an empty baseline. The inspection also confirmed the presence of the existing customer/contact, interaction, private intake, and audit structures used by the CRM.

The Production catalog did not contain the Meta Ads tables inspected for this feature at the time of the baseline check. No Meta Ads DDL was applied as part of this inspection.

### Baseline invariants

The release must not:

- Rewrite, fabricate, renumber, or delete existing migration history.
- Apply the Staging executor that is pinned to project ref `qmhfmgkymjgoevwmkidm` and expects a 21-record migration prefix.
- Run an unreviewed full-chain `supabase db push` against Production.
- Re-run any historical CRM, Messenger, Zalo, Auth, or Storage migration.
- Mutate existing customer IDs, tenant IDs, phone identity rows, interaction rows, customer stage history, or audit history.
- Change Messenger subscription fields or the existing Messenger/Zalo intake paths.
- Enable or disable RLS on existing tables as a side effect of this feature.
- Subscribe any Page other than the four explicitly approved above.

The production release must be selective, additive, transactionally safe, and designed against the live Production catalog—not a synthetic 21-row prefix.

## 3. Backup and recovery gate

The organization is on the **Supabase Free plan**. Supabase's current backup documentation says daily managed backups are provided for Pro, Team, and Enterprise; Free projects should regularly export their data using the Supabase CLI and maintain off-site backups. Database backups do **not** contain Storage object binaries. Storage metadata in the database is not a substitute for the actual files.

Before any Production DDL or deploy:

1. Use the Supabase CLI backup procedure against the confirmed project, with the connection secret supplied only through a local secret manager or protected environment variable. Never paste database passwords, service-role keys, access tokens, or connection strings into GitHub, this document, or chat.
2. Export roles, schema, and data as separate backup artifacts using the supported `supabase db dump` workflow and the exact CLI version recorded in the evidence.
3. Export Storage bucket metadata and object binaries separately. Record per-bucket object counts and verify every exported object has a matching checksum.
4. Encrypt every backup artifact client-side (AES-256-GCM or an approved equivalent), store it off-site, and record SHA-256 hashes, byte sizes, UTC timestamps, and the encryption-key custody reference. Do not commit backup files or hashes containing secrets to Git.
5. Restore the database artifacts into an isolated PostgreSQL 17.11 environment. Validate that restore completes with errors treated as fatal.
6. Verify schema objects, migration ledger, key row counts, constraints, triggers, policies, grants, and representative customer/contact/interaction data against the captured source baseline. Verify Storage objects separately.
7. Save a signed evidence manifest with artifact hashes, restore logs, validation query results, and the operator/time. Do not include secrets or raw customer data in the manifest.

A local PostgreSQL restore is useful verification of the logical database dump, but it is not a Supabase-managed physical backup and does not by itself prove Auth/Storage service configuration or Storage object restoration. If an exact isolated Supabase-project restore is required, provision it only after reviewing the plan/cost and explicitly approving it.

**Gate state at this revision: NOT SATISFIED.** No physical or logical Production backup artifact, isolated restore evidence, or Storage object verification was provided to the release process. Therefore Production DDL, PR merge, Render deploy, OAuth Page connection, Page subscription mutation, and live lead ingestion remain blocked.

Reference: [Supabase Database Backups](https://supabase.com/docs/guides/platform/backups).

## 4. Feature-specific release review

Before release, review every migration in the Meta Lead Ads feature set against the current Production schema and grants. The reviewed set includes lead attribution, database hardening, attribution RPC ACLs, duplicate-phone history, Page-binding enforcement, and evidence-conflict enforcement. Verify the exact migration filenames and hashes from the release commit; do not infer the set from a stale branch or old PR description.

The application path must be verified end-to-end:

1. OAuth session is bound to the authenticated actor and approved tenant.
2. The four Page IDs are server-side allowlisted; user-supplied Page IDs cannot broaden the allowlist.
3. The Page token returned by Meta is persisted through the encrypted token vault. It must not depend on undeclared plaintext `META_*_PAGE_TOKEN` environment variables.
4. The webhook verifies Meta signatures and accepts only `leadgen` events for approved Page bindings.
5. Intake is idempotent on Meta Lead ID.
6. Phone matching is tenant-scoped and reuses the existing private contact identity model. Do not put plaintext phone numbers into public lead-event payloads or logs.
7. Each distinct Meta lead submission is retained as an immutable event/touchpoint; same-phone submissions update latest-touch snapshots without overwriting first-touch history.
8. Pending campaign/ad attribution is retryable and cannot block durable lead intake.
9. Existing Messenger message subscriptions and Zalo workflows remain unchanged.

## 5. Pre-existing advisor findings

A read-only Supabase advisor snapshot was collected on 2026-11-05 before any Meta DDL. It reports existing findings, including an exposed SECURITY DEFINER view, mutable search paths, security-definer RPC execute grants, and RLS/no-policy informational findings on existing tables. These are baseline findings, not evidence that this Meta feature introduced them.

Do not opportunistically alter unrelated CRM policies, functions, or views in this release. Record the pre-release advisor output, rerun advisors after the feature migration in an isolated environment, and require that the feature introduces no new finding or privilege expansion. Any remediation of pre-existing high-severity findings must be a separately scoped security change.

## 6. Release sequence

1. Capture and verify the backup and restore evidence described above.
2. Freeze the release commit and calculate SHA-256 for every selected migration and release artifact.
3. Run Production-specific preflight: project ref, database version, complete migration ledger, required objects/columns/constraints/triggers/policies/grants, and expected absence/presence checks.
4. Apply only the reviewed additive Meta migrations in one controlled release transaction with explicit lock, timeout, rollback, and uncertain-commit verification.
5. Verify post-migration catalog, migration history invariance, advisor delta, and all CRM invariants.
6. Run automated tests for Meta attribution, Page binding, encrypted token vault, duplicate phone history, RPC-only ACLs, and existing Messenger/Zalo regressions.
7. Merge to `main` only after the review and CI gates pass. Confirm the Render service's repository, branch, auto-deploy setting, and production environment before a deploy is allowed.
8. Connect the four Pages via OAuth one at a time; verify token encryption and read-back before subscribing only to `leadgen`. Preserve `messages` and all other existing subscriptions.
9. Submit a controlled test lead (with owner-approved test data), verify CRM customer/touchpoint attribution, idempotency, tenant isolation, and no duplicate customer creation.
10. Monitor webhook errors and intake health before declaring completion.

## 7. Rollback

Do not use destructive down-migrations to erase customer attribution events. If a release fails before commit, confirm rollback and catalog equality before any retry. If commit acknowledgement is uncertain, probe the database and stop on any inconsistent state; never blindly replay DDL.

After commit, prefer a forward corrective migration. If application rollback is needed, disable only the Meta Lead Ads intake path and preserve all existing Messenger/Zalo functions. Never delete customer rows or private contact identities as a rollback shortcut.

## 8. Evidence status

| Evidence | State |
|---|---|
| Owner-approved Production project and tenant | Confirmed |
| Four Page IDs and exclusion of Europe Page | Confirmed |
| Read-only PostgreSQL and migration-ledger baseline | Captured |
| Production-specific migration compatibility review | In progress |
| Logical database export | Not supplied |
| Storage object export and checksum verification | Not supplied |
| Isolated restore rehearsal | Not supplied |
| Production release bundle and hash manifest | Not supplied |
| Production DDL | Not run |
| PR merge to `main` | Not done |
| Render Production deploy | Not done |
| Page OAuth/subscription changes | Not done |
| Live lead ingestion | Not started |
