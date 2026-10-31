# Meta Ads: compatibility with the 21-migration staging prefix

Reference: PR #139, branch `meta_ads_integration`, previously verified head `3bc50257883957f05cd1fedbd8f57358e058dcee`. Date: 31 October 2026, Asia/Ho_Chi_Minh. Keep the PR **Open + Draft**.

**The corrected five-file SQL bundle passes the exact-prefix isolation tests. Hosted execution remains blocked by selective-release ledger integration and operational acceptance.** No hosted Supabase write, backup, reset, migration, Render/Meta change, real lead, customer message, merge or deployment was performed.

## 1. Root cause

The unreleased `20261030110000_meta_ads_final_remediation.sql` carried a copy of `seed_messenger_pages_canary` and replaced `han_ingest` with a later version containing Messenger SLA wiring. `20261030130000_meta_ads_phone_duplicate_history.sql` replaced shared ingestion again to add Lead Ads phone matching and Meta verdict fields to the shared return payload.

The 21-prefix owns an earlier `han_ingest` without that SLA call. Replacing it imported later Messenger behavior, changing the probe's SLA count from 0 to 1. Creating the canary trigger function also introduced references to helpers/settings/allowlist tables absent from the prefix. It was not enough for the Meta lead happy path to succeed.

## 2. Exact removal/separation

Only **two unreleased Meta SQL sources** change in this task. The other three, including token hardening, remain byte-identical to `3bc5025`.

| Source | Removed or replaced statements |
| --- | --- |
| `20261030110000_meta_ads_final_remediation.sql` | Entire `CREATE OR REPLACE FUNCTION public.seed_messenger_pages_canary()`; entire shared `CREATE OR REPLACE FUNCTION public.han_ingest(...)`; its COMMENT and three REVOKEs/one GRANT; the unnecessary service-role USAGE grant on the entire private schema; the preliminary `ingest_meta_leadgen_event` definition and its ACL statements. The final dedicated intake now exists only in the phone-history source. |
| `20261030130000_meta_ads_phone_duplicate_history.sql` | Entire shared `han_ingest` replacement and COMMENT; replace the old Meta wrapper's call into `han_ingest` with a dedicated service-role-only intake state machine. |

There is **no** CREATE/ALTER/DROP/COMMENT/GRANT/REVOKE targeting shared `han_ingest`, Messenger SLA/canary, AI, Zalo, QC, contracts, Storage policies or legacy business rules in the corrected bundle. No applied historical migration was edited.

Future separate task, without inclusion in this release: review the existing Messenger canary function's handling of a NULL Page result. Its original behavior is preserved in full-chain fixtures; Lead Ads no longer creates a Messenger conversation and therefore does not need to modify that trigger.

## 3. Shared-ingest compatibility proof

The shared function does **not** need to change. Its definition, comment, configuration, owner ACL and effective EXECUTE grants are unchanged on both the prefix and the existing full-chain schema.

The explicit Lead Ads boundary is `public.ingest_meta_leadgen_event(company, lead_id, claim_token, ingest)`, callable only by `service_role`. It requires a matching live, non-NULL fenced lease and an active tenant, validates bounded name/content and canonical phone, persists the `crm_lead_ads` marker itself, and uses the same per-company transaction lock as ordinary intake.

Lead forms produce a customer/contact when needed, a customer interaction with `conversation_id = NULL`, a private raw-content/intake record, and the Meta checkpoint. They do not create a Messenger identity/conversation or update care responses, SLA, outbox, AI settings or canary objects. All rows and the phone verdict checkpoint commit atomically. An orphan/shared idempotency collision fails closed.

`tests/staging/meta-21-compatibility.ts` runs the same 12 operations before/after: new Messenger input, replay, identity/phone conflict, new/known-phone Website input, replay, idempotency conflict, malformed identity, invalid phone, Zalo rejection on this unrelated shared API, and anon/authenticated denials. It compares **actual returned payloads and all 44 pre-existing public/private table row sets**, including customers, contacts, identities, interactions, private raw content, intake records, audit, histories, conversations, SLA, care and outbound tables.

Only generated UUIDs and the exact transaction timestamp are normalized; event timestamps, association structure, codes, statuses, content, counts, return keys and errors remain comparable. A disposable sequence is reset to the same starting value in each rolled-back probe so generated customer codes are also compared. The seven explicitly approved customer attribution columns are excluded from legacy row projections. No application data is modified by these rolled-back probes.

Messenger/Website keep the original `{status, interaction_id}` contract; Meta-only phone verdict fields are no longer added to these returns. Existing unit expectations were corrected to pin that original contract, while preserving conflict/review and ownership checks.

## 4. Before/after catalog diff

The exact prefix is executed from the 21 stored SQL sources and checked against all ten captured schema/catalog/RLS/effective-grant fingerprint categories. The second prefix fixture is verified the same way before the five Meta sources are applied.

The allowlist compares definitions, comments, function/table/schema/default grants, column defaults/ACLs, RLS/policies, indexes, validated constraints, enabled triggers, sequence configuration and enum/domain types across public/private plus Auth, Storage and the migration-ledger schema. **Existing objects cannot be changed or removed**, including existing schema grants. Only seven named Meta tables, ten named Meta RPCs, their owned indexes/constraints/policies/ACLs, and seven customer attribution columns may be added.

Observed diff: **365 permitted entries** — 7 relations, 109 columns (102 on new Meta tables plus 7 attribution columns), 32 constraints, 25 indexes, 5 policies, 10 functions, 30 function-grant checks, 147 table-grant checks; no schema-grant changes. **Zero forbidden changes.** Messenger SLA remains 0 → 0; canary functions/triggers remain absent on the prefix. The original functions/triggers remain unchanged on the full chain.

Negative checks inject Messenger SLA/canary, AI, Zalo, QC, customer-stage, contract, Storage-policy and type changes into the observed catalog and require the allowlist to reject each one. Full changed-object identities and definition hashes, both legacy payload/row observations, prefix/after fingerprints and lead acceptance are in [compatibility.json](evidence/meta-ads-21-prefix/compatibility.json).

## 5. Tests

All databases are disposable local Docker databases; all credentials, phones and content are synthetic. The existing 121-file regression is run **only locally/CI**, never proposed for hosted staging.

| Check | Result |
| --- | --- |
| `npm run test:meta-ads` | 43/43 PASS. |
| `npm run test:meta-ads:db` | 2/2 PASS, including native overlapping connections, signed webhook route, retries, token migration and enabled-Shadow/no-AI-side-effect checks. |
| `npm run test:meta-staging-preflight` | PASS: exact prefix, full-chain regression, allowlisted catalog, actual legacy row/payload comparison, A/B acceptance and assembled single-transaction package. |
| `npm run test:migration-integrity` | 17 checks PASS; historical hashes/order and guards retained. |
| `npm run test:staging-readiness` | 13/13 PASS; no hosted readiness or backup inferred. |
| Messenger regression | `test:meta-messenger`: 12/12 PASS. |
| Website/omnichannel regression | `test:omnichannel`: 34/34 PASS. |
| Zalo regression | `test:zalo` PASS, including PGlite/groups/account/switch and worker suites. |
| Typecheck, lint, build | PASS; lint has 0 errors / 14 existing warnings. Build uses the loopback fixture values already committed in Verify. |

Detailed test output: [local-validation.txt](evidence/meta-ads-21-prefix/local-validation.txt). GitHub must pass on the exact final pushed commit; the handoff provides those run links. No workflow, lint rule, security gate or unrelated module source was changed to achieve a pass.

The first [Verify run on `3692bf0`](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/actions/runs/41158361309) passed the new prefix/package checks, then exposed a test-data dependency at `shadow-db.test.ts:108`: its noncanonical Facebook IDs made the unchanged historical seeder attempt a NULL `page_id` (SQLSTATE 23502). The removed Meta canary patch had previously hidden this setup failure. Static inspection found the same invalid-ID setup in other required gate fixtures.

The narrowly required CI follow-up changes **fixture values only** in `tests/ai-brain/{shadow-db,live-db}.test.ts`, `tests/ai-analysis/{ai-analysis,analysis-worker}.test.ts`, `tests/sales-style/{sales-style,sales-style-activation}.test.ts`, `tests/response-sla/response-sla-db.test.ts`, `tests/e2e/current-system.integration.test.ts`, `tests/inbox/{database,test_outbound_customer_metadata}.test.ts` and `tests/omnichannel/meta_data_deletion_db.integration.test.ts`: canonical synthetic numeric Page:PSID keys or numeric Page metadata outside the live canary Pages. Expected metadata values follow those fixture values; assertions and tested authorization/tenant behavior remain intact.

`tests/ai-brain/live-messenger-supabase.test.ts` intentionally tests an invalid recipient. Its local-only setup now constructs that malformed persisted row while suspending only the canary **seed** trigger inside a transaction, restores the trigger, verifies it is enabled, and then runs the unchanged negative dispatch assertion. No authorization/fence/RLS trigger is disabled, and no assertion runs with seeding disabled. This avoids importing a Messenger fix back into the Meta bundle or weakening the negative test.

These fixture dependencies were reported before expansion. A fresh third local Supabase project on separate ports, initialized without resetting any existing database, validates the full canonical chain and affected HTTP/native suites. The existing canary NULL-handling issue remains a separate future task; no Messenger/AI runtime function was changed.

## 6. Token safety

The entire token-hardening source from `3bc5025` is unchanged (hash below). Token access remains through the service-only public RPCs running as their definer; it does not require granting the caller USAGE over the entire private schema. Conflicting vault ciphertext or expiry stops and rolls back; both source columns must be present together; invalid/empty source and incomplete copies stop. Two tables remain locked until exact per-account ciphertext/expiry comparison and source-column removal commit. The test deliberately suppresses a copy and checks rollback/source preservation. Account metadata and customer rows remain unchanged, and migrated synthetic ciphertext decrypts to the original token.

Browser roles cannot SELECT the private token table or EXECUTE token/claim/finalize/sync/intake RPCs. Server-only AES-256-GCM code and key rotation behavior are unchanged. Real keys/tokens were not read, exported, hardcoded or logged. The package expects **zero** existing Meta objects/rows on the exact prefix; any partial deployment stops before DDL. For a future populated-source transfer, run the existing offline key verifier over every ciphertext before and after, using secrets through env and ciphertext through stdin, with counts/status only. SQL format checks do not prove real-key decryptability.

## 7. Duplicate-phone acceptance

On prefix 21 + only Meta:

- Lead `88001`, phone `+843000000011`, Campaign A (`Synthetic campaign`) creates a customer and first event, duplicate=false.
- Lead `88002`, same phone, Campaign B reuses the same customer and creates a second event, duplicate=true.
- Both campaign snapshots and separate lead identities/submission times are preserved. Counts: **1 customer, 2 interactions, 2 attribution events, 0 conversations, 0 outbound records**.
- Replaying lead `88002` returns `ALREADY_PROCESSED` without adding rows.

Existing tests also preserve Campaign A/B/C history, cross-tenant isolation, ambiguous ownership/manual review without arbitrary merging, missing-phone leads, pending-campaign retries, immutable first-touch and current latest-touch.

## 8. Execution package (prepared, not executed hosted)

Generate offline from the pinned repository sources:

```sh
node --import tsx scripts/meta-ads/prepare-21-prefix-package.ts /absolute/path/to/review-package
```

It emits `package.json`, `sources/` with the exact five SQL files, `00-preconditions.sql`, `90-postconditions.sql` and `ordered-bundle.sql`. It has no network/database client or remote executor. The assembled SQL strips only verified outer transaction controls from each source and wraps everything in **one transaction**, so no intermediate ACL/function state becomes public.

| Order / source | SHA-256 |
| --- | --- |
| `20261030090000_meta_ads_lead_attribution.sql` | `f29e10fc5655bf9e2b736b87e49589a0be5ca55cb7c0cd185422f0af9a7fd95a` |
| `20261030100000_meta_ads_hardening.sql` | `e83f9ffb4a0eb4914ac8b1b6cca35674720dde8809bb30c66218eecbd2001657` |
| `20261030110000_meta_ads_final_remediation.sql` | `79311ef986d9d9a22be77bfafb4b602854aebab6f8a864ea726d9ac7a7cc9814` |
| `20261030120000_meta_ads_attribution_rpc_security.sql` | `a06d05072823d0a057cc48d8c15230ee57da6c6f4b388a5ccce8fb51c12aa9e1` |
| `20261030130000_meta_ads_phone_duplicate_history.sql` | `54b36ff61749c0881f38ce257976bcacf9f679f89e6b151297220d04232c0770` |

The checked-in [package manifest](evidence/meta-ads-21-prefix/package.json) and [package validation](evidence/meta-ads-21-prefix/package-validation.json) pin the assembled bundle hash, pre/postcondition hashes and expected object identities; CI checks that they remain current.

Preconditions enforce all 21 **actual recorded versions, names and stored-SQL hashes**, exact prefix fingerprints, absence of partial Meta schema, and a five-second lock timeout. In a maintenance window, all existing application tables and the canonical ledger are locked against concurrent writes. Counts and internal row hashes are checkpointed for every existing application table, excluding only the approved new customer columns.

Postconditions enforce the exact expected schema/grant fingerprint, identical existing row counts/hashes and unchanged canonical ledger, with zero seeded Meta account/token/lead rows. Output contains status/counts only. Fresh-schema ACLs, role denial and tenant RLS are tested separately; no plaintext/token values or internal row digests are printed by the package.

Local tests execute the complete assembled bundle, then deliberately test ledger drift, schema drift and a forbidden DDL injected before postflight. All stop/rollback paths leave no committed Meta table; injected DDL also disappears. See `tests/staging/safe-deployment.test.ts`.

Stop on any hash/schema/history mismatch, unexpected Meta rows/objects, key/decryption failure, lock timeout, count mismatch, forbidden catalog diff or permission mismatch. Before COMMIT, rollback the whole transaction. After COMMIT, do not drop new tables/columns to undo real leads: pause the Meta intake/sync paths and use the approved backup/restore plan on an isolated restore target, preserving any submissions received since the checkpoint.

## 9. Ledger strategy and why deployment is still blocked

The package executes **only the five real Meta sources** and performs **zero canonical-ledger writes**. The local ledger contains the 21 sources genuinely executed in that fixture, with their captured recorded versions; it remains unchanged byte-for-byte after the package. There are no invented records for the missing 95 canonical files, no repair/reset, and no `supabase db push`.

This proves the SQL can be composed without pretending the 95 files ran. It does **not** resolve deployment bookkeeping: `reconcileMigrationLedger` / `buildLedgerReadinessPlan` still require a canonical prefix and do not understand a separate selective release. Their fail-closed behavior is preserved.

A future narrowly reviewed deployment change must establish a private Meta release registry recording the genuinely executed source/bundle hashes and checkpoint in the same transaction, keep existing canonical rows intact, prevent blind CLI migration pushes, and define/test later canonical reconciliation. No such hosted executor/registry lifecycle is introduced or claimed proven here. Therefore the emitted SQL is a **review/rehearsal package**, not an approved hosted migration command. Do not execute it on staging until that specific strategy is reviewed and validated. This does not require approving/executing the unrelated 160 destructive items.

## 10. Required checkpoint before staging execution

No hosted backup is performed by this task. The future execution record must reference:

1. A recoverable full database backup at a stated timestamp, stored encrypted with restricted access, plus dump checksum, PostgreSQL/extension versions, retention and restore-owner details. Include public/private data, Auth/Storage metadata and the real migration ledger; separately account for any external Storage blobs needed by the full restore.
2. The exact canonical migration ledger capture: all versions/names, stored-statement counts/hashes and its immutable archive hash. Keep the original 21 entries; do not rewrite them to canonical filenames.
3. Schema-only dump and the ten catalog fingerprints, plus detailed RLS/policies and effective table/function/schema/default grants for anon/authenticated/service_role. Archive the current `han_ingest`, SLA, canary/AI/Zalo/QC/legacy/Storage/contract definitions and flags.
4. Meta object/account/token counts **without secret values** (expected absent/zero on this exact prefix), source/vault non-NULL token and expiry counts if any are found, and offline decryption-verification status. Any nonzero/partial Meta state stops this package for separate review. Record server-secret manager references/version IDs, never keys or tokens in the package.
5. A demonstrated restore to a new isolated PostgreSQL/Supabase-compatible target using the captured platform/extension/role prerequisites and a fresh database (no destructive restore into the active staging project). Validate schema fingerprints, ledger, RLS/EXECUTE, row counts, relationships, application auth and protected-file retrieval. A synthetic restore test is not proof of this real restore.
6. A maintenance/rollback decision point: pause inbound/sync changes, verify the checkpoint and source hashes, rehearse against the isolated restore, inspect preflight, then obtain deployment approval. On postflight failure before commit, rollback. After commit, capture new arrivals before any approved recovery/cutover; never erase new leads with an unreviewed downgrade.

## 11. Remaining hosted Meta blockers

Selective-release ledger integration/approval, real staging backup/restore proof, hosted application/schema/Auth compatibility, server key verification, staging callback/webhook/cron settings, Meta App mode/permissions/App Review, Page subscription/read-back, asset relationships and approved isolated test assets remain unverified. No real Graph/OAuth request, lead or delivery acceptance was performed. Do not test using production-connected Page/Form assets.

The current CRM application's unrelated modern routes are not certified against the older prefix by SQL compatibility alone; hosted smoke/acceptance must verify the intended Meta/admin/customer paths without blanket application of the 95 gaps. Historical QC and other legacy migration issues are outside this bundle and were not changed.

## 12. Final status

**BLOCKED**

The Messenger/canary coupling is removed and the corrected bundle is compatible with the exact 21-prefix in local/CI fixtures. Hosted execution awaits the explicit ledger/backup/acceptance gates above. Keep PR #139 Open + Draft; do not merge or deploy.
