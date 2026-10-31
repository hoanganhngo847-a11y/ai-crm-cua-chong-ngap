# Meta Ads staging safe deployment plan

> **SUPERSEDED & RECONCILIATION NOTICE (Updated 31 October 2026)**:
> 1. **Isolation Completed**: The earlier observation in this report that the unreleased Meta bundle changed Messenger SLA behavior was an artifact of commit `3692bf0`. This was cleanly remediated in commit `3bcc163` / `25e8f21`: all modifications to `han_ingest` and canary functions were completely removed. Messenger SLA windows remain at count 0.
> 2. **Selective-Release Ledger Engine Implemented**: Strategy (A+B) has now been fully implemented and locally validated via [`scripts/meta-ads/selective-executor.ts`](../scripts/meta-ads/selective-executor.ts) and [`tests/staging/selective-ledger.test.ts`](../tests/staging/selective-ledger.test.ts). See [`docs/META_ADS_SELECTIVE_LEDGER_IMPLEMENTATION.md`](./META_ADS_SELECTIVE_LEDGER_IMPLEMENTATION.md) for full architecture and test evidence.
> 3. **Preservation Invariant**: Exactly 21 canonical ledger records are preserved with 0 writes/deletes. Zero records are fabricated for the 95 canonical gap migrations.
> 4. **Current Status**: **BLOCKED FOR HOSTED EXECUTION**. The local engine and failure tests pass 100%, but hosted staging execution remains strictly blocked pending physical backup/restore verification and owner sign-off.

Date: 2026-10-30, Asia/Ho_Chi_Minh. Application/migration snapshot:
`bdb4ee6b4a42d6e875e96926a6f53c1938f4ccc8`.
Branch: `meta_ads_integration`. [PR #139](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/pull/139)
must remain **Open + Draft**. This is a remote read-only preflight and local
reproduction report, not permission to execute its future deployment steps.

## 1. Executive recommendation

**BLOCKED for deployment.** Existing staging is technically reusable: its application
schema matches a replay of the exact 21 recorded source files, including effective
role privileges after modeling the observed Supabase default grants. Reuse does not
require discarding that history. The preferred conditional path is **A+B**: an
append-only canonical-to-ledger mapping plus a separately reviewed complete-file
executor. No remote executor is implemented or run in this task.

Execution is blocked by unresolved legacy/API compatibility, 160 unapproved pending
destructive target/subcommand items, lack of a verified real staging backup/restore,
the absent reviewed executor, and missing staging Meta/Auth configuration and test
asset acceptance. Owner approval alone does not repair the QC defect or prove a
restore. Parallel rebuild/cutover **C** remains an alternative requiring its own
approved baseline, recovery/configuration work and resource/cutover approval.

The five Meta migrations **do apply and complete a synthetic lead pipeline on the
21-file prefix**. They do not fail merely because the canary helper/tables are absent:
the prefix has no canary trigger. However, that shortcut changes Messenger SLA
behavior, leaves dormant incompatible code and 95 other canonical prerequisites
unapplied, and is not a supported deployment/history state for the full application.
Do not skip or falsely mark those 95 files applied.

The product scope remains customer name/phone, Page, campaign identity, repeated
submissions and duplicate-phone detection. No advertising dashboard, Insights,
spend/impression/click reporting or campaign/ad creation is introduced by this plan.

## 2. Exact staging baseline

Read-only checks identify Supabase `qmhfmgkymjgoevwmkidm`,
`ai-crm-meta-staging`, ACTIVE_HEALTHY, PostgreSQL **17.11**, no database branches.
There are 21 application-time migration ledger entries, 121 canonical source files
and **100 pending** files. The ledger versions differ from canonical filename
versions. Unique name/order **and all 21 stored SQL hashes** match the canonical
prefix. The original ledger must stay unchanged.

| # | Actual staging ledger version | Canonical source | SHA-256 |
| ---: | --- | --- | --- |
| 1 | 20261030063323 | `20260914000001_initial_schema.sql` | `a877e0e3fdf3b127c093b498fcc866b3df5ef37c4972dc778650e6a2d248c920` |
| 2 | 20261030063347 | `20260915000001_rls_foundation.sql` | `447cee608bdcad83c3deac07f967ae2116c2ae39cba9dd557c00ea1119632794` |
| 3 | 20261030063408 | `20260915000002_trusted_server_private_rpc.sql` | `e432723499a195d8e552826782e702799739ad0f60b64c94b3ddce9a6f752712` |
| 4 | 20261030063429 | `20260916000001_private_call_transcripts.sql` | `1a04b0988362e3ad04ddd6fdd775bb1331a7d6ec0065c159bde7574661d075b1` |
| 5 | 20261030063437 | `20260916000002_crm_atomic_transactions.sql` | `064d30a05af075e1dbd44d140f54fbb8382926ec06bce0c57717068096844709` |
| 6 | 20261030063445 | `20260916000003_inbox_atomic_persistence.sql` | `5e3b6a36625641670372e2eb2d148af920e5949a4d48bbf455246d98fa5392c3` |
| 7 | 20261030063500 | `20260917000001_0005_survey_atomic_completion.sql` | `86109760fe7073b6965e1e3f7f4a4d0450209db36b111c9b22c2d449d324367d` |
| 8 | 20261030063510 | `20260920000002_operations_atomic_rpcs.sql` | `ae698b8da10c116fdc7907bb709d2921cd5917c5480e09a629c2296c514180f7` |
| 9 | 20261030063519 | `20260920000005_han_facebook_website.sql` | `f085ffb0b87f10a27401dafac30603339db2f47888acc113dacde1bdff068841` |
| 10 | 20261030063526 | `20260921000001_voice_media_pipeline.sql` | `1931ef7d8c695ee3c9a6baa9bf37acd0476409e72883fbd1425661a91830be3c` |
| 11 | 20261030063534 | `20260921000002_openai_realtime.sql` | `b2c52102111284f96200dbf229ddcb50ae159fd0dabec55e985cd8a6c88d78c9` |
| 12 | 20261030063542 | `20260922000001_response_sla_windows.sql` | `a7c28bbe0f7dec02af5ee2e55c75d936fafc42ed7d5201ef1ba2e36a6aef975f` |
| 13 | 20261030063551 | `20260922000002_ai_analysis_worker.sql` | `07574fc776948c4c9c4bfaa4d43e7e722c93ee764e9d1ad5470445587c07ac16` |
| 14 | 20261030063559 | `20260922000003_voice_security_hardening.sql` | `2accd05b59e7b6724646cca20085be49982e1215e952fb7a6a48202e5350ae7a` |
| 15 | 20261030063608 | `20260923000001_sales_style_learning.sql` | `00f1cfaba26f53b7bc2e0c4fd54f8044fc7703ef6524b5621368ee6b34d20fca` |
| 16 | 20261030063640 | `20260923000002_sales_style_activation.sql` | `3b31a8860d1e23a6619300dae95657977d38ef8845cc53b11d9f4c75df4e045c` |
| 17 | 20261030063647 | `20260923000003_analytics_dashboard.sql` | `4b53ad99e047c74addd9b29607fb5bbf6876c9f5ac5ea01bf3b43e96bce0ea76` |
| 18 | 20261030063654 | `20260924000001_survey_integrity_hardening.sql` | `95d43784ebe31b59035513208f7ebbbbcd24561e465610c8742d41b98865efb6` |
| 19 | 20261030063702 | `20260925000001_voice_p0_hardening.sql` | `19faacd37a58ce59445e356c36036220726e45160150bbf67ee24cac3968125f` |
| 20 | 20261030064055 | `20260927000001_inbox_outbox_and_inbound_atomic.sql` | `331c98824fe60db077d680ffc28a10dce4b1bcfe5d152ff00abb8362579acf00` |
| 21 | 20261030064113 | `20260928000001_operations_p0_hardening.sql` | `edab37eda7f26ce4a398348232014a113a90a2075579e22cfbf750f053cdfa70` |

The complete stored hashes and counts are in
[staging-metadata.json](evidence/meta-ads-safe-deployment/staging-metadata.json).
The [catalog capture](evidence/meta-ads-safe-deployment/staging-catalog.json) covers
460 columns, 298 constraints, 92 application functions, 154 indexes, 86 policies,
45 relations and 63 non-internal triggers, plus schema/table/function effective
grants for anon, authenticated and service_role. All ten fingerprint groups match
the final local reproduction. This is application public/private catalog parity;
the local Auth/Storage service internals are platform stubs, not a hosted-platform
clone or a proof of JWT, MFA, Storage signing or external consumer equivalence.

At observation time staging has zero customers, conversations, Auth users and
Storage objects, with two Storage buckets. All 13 existing legacy target tables
have exact count zero; `company_bank_accounts` is absent and is introduced by a
pending predecessor. See [current counts](evidence/meta-ads-safe-deployment/staging-legacy-counts.json).
Empty current tables do not approve future DROP statements or certify their state
at a later execution boundary.

## 3. All 100 pending migrations

The [complete 100-row inventory](evidence/meta-ads-safe-deployment/PENDING_MIGRATION_INVENTORY.md)
is part of this plan. Its [machine-readable register](evidence/meta-ads-safe-deployment/migration-inventory.json)
records every canonical filename, full SHA-256, canonical predecessor, source-owner
dependencies, referenced/affected tables and function signatures, transaction envelope,
data-loss review, external/scheduler dependencies and rollback/recovery requirements.
The [statement matrix](evidence/meta-ads-safe-deployment/FULL_MIGRATION_RISK_MATRIX.md)
and [exact SQL/AST inventory](evidence/meta-ads-safe-deployment/migration-risk-statements.json)
retain every one of **2,330 top-level statements**, including **1,610 pending**.
ALTER subcommands and immediate DO/dynamic SQL are retained inside their parent;
function-body mutations are distinguished from migration-time execution.

Categories overlap: A additive schema; B data backfill/transformation; C function/RPC;
D privileges/RLS/triggers; E destructive operations; F external/scheduled/runtime
service dependencies. F distinguishes deferred runtime dependencies from immediate
scheduler/network statements; defining a function does not invoke it.

| Category | Pending files containing this category |
| --- | ---: |
| A — Additive schema | 50 |
| B — Migration-time data backfill/transformation | 19 |
| C — Function/RPC definition or replacement | 82 |
| D — Permissions, RLS or triggers | 95 |
| E — Explicit destructive operation | 35 |
| F — External service/scheduler dependency | 58 |

Across all 121 files, 25 have one outer transaction and 96 have no outer transaction;
none has a rejected intermediate transaction boundary under the existing lexical
inspection. This is not a general SQL safety certification. A future executor must
preserve exact source bytes and supply one atomic transaction for a complete file
where needed. Static source-owner dependencies are conservative references, not an
exact pg_depend closure or permission to reorder the tested canonical chain.

## 4. Destructive dependency register

The [destructive register](evidence/meta-ads-safe-deployment/DESTRUCTIVE_REGISTER.md)
contains 133 statement/subcommand entries, 115 pending. The separately expanded
[individual approval list](evidence/meta-ads-safe-deployment/DESTRUCTIVE_APPROVAL_ITEMS.md)
has 178 target/subcommand items, **160 pending**, all **NOT APPROVED**. Different
counts reflect top-level statements versus ALTER/DO and multi-object expansion.
Each item retains its exact source location and recovery requirement. Dynamic
targets still require expansion against the actual catalog at that migration's
execution boundary. Nothing in a local pass approves an item.

| Hotspot | Verified effect / remaining dependency |
| --- | --- |
| `20260928000002_tv9_post_merge_hardening.sql:664` | Drops the three-argument `resolve_response_sla_on_sale_reply` identity; the later four-argument/defaulted form preserves three named inputs but changes function identity and delivery-time semantics. External/direct-SQL callers and dependencies still need review. Do not add an overlapping defaulted wrapper without separate RPC resolution testing. |
| `20261029160000_remove_legacy_flood_barrier_schema.sql:529` | Dynamic CASCADE removes 33 named function signatures; name-only selection could include an unexpected live overload. Freeze and compare the actual expanded signature/dependency set at the boundary, not only today's 21-prefix catalog. |
| Same migration, line 534 | Removes 14 legacy tables with CASCADE. In the full local schema, 393 tracked application catalog identities disappear and three definitions change. This count excludes PostgreSQL internal/TOAST objects and is not the complete physical CASCADE count. |
| Non-empty local cleanup | A synthetic pricing-policy row exists immediately before cleanup and its table is removed; a synthetic customer survives. This proves committed row loss is real even though staging's current legacy tables are empty. It is not an exhaustive non-empty fixture for every destructive target. |
| Retained QC API | `record_quality_check_atomic(uuid,uuid,text,uuid,text)` survives the full chain, but invocation fails with SQLSTATE **42704**, `type public.production_orders does not exist`. Its `orders`, `production_orders` and operations-helper dependencies are removed. A successful DDL replay is not application compatibility. |
| Signed URLs / historical access | Existing application code still accepts SURVEY, CONTRACT and INSTALLATION categories while the full chain removes their tables. RECORDING survives. Preservation versus explicit retirement and historical file access require a separate decision and implementation. |
| Analytics / timeline contracts | The cleanup replaces `get_company_analytics_overview`, `get_company_analytics_daily_series` and `c360_timeline`, retires legacy metrics and removes survey appointments from the timeline. Consumers must accept the retirement semantics; returning zero is not evidence that historical activity never existed. |
| Other drops and data changes | Token-column removal/vault relocation, constraint/index/policy/trigger replacements, activation/backfill statements and source-stage transformations all remain individually registered; rollback must preserve data and credentials, not merely recreate an empty object. |

No legacy module, table, migration source or existing evidence was removed or edited
by this preflight. The report identifies the compatibility repairs needed for a
later, separately reviewed forward-only change; it does not implement retirement.

## 5. Local reproduction results

Run `npm run test:meta-staging-preflight`. It accepts no remote URL or connection
string, uses only the configured local Docker Supabase PostgreSQL container,
creates randomly named `crm_safe_<uuid>_*` databases and removes only those fixtures.
`CRM_SAFE_PREFLIGHT_EVIDENCE=1` writes the evidence capture; CI does not overwrite it.
It never writes copied/fabricated migration ledger rows.

| Test | Result |
| --- | --- |
| A — exact 21-file prefix | PASS on PostgreSQL 17.11. All source hashes match stored staging SQL; all ten application catalog/grant fingerprints match. Messenger and Website probes accept one local interaction. |
| B — complete 121-file chain | PASS for DDL execution, zero migration failures. Every complete file executes in canonical order; destructive-boundary before/after object changes are captured for 43 files including the historical prefix. Synthetic Messenger, Website and the complete Meta claim → intake → touchpoint → phone verdict → finalize pipeline pass. Retained QC invocation fails as documented above. |
| C — prefix plus only the five final Meta files | PASS for all five DDL files and complete synthetic Meta pipeline; a verified synthetic campaign is retained and the durable event reaches PROCESSED. This does not establish a supported application/ledger deployment. |

The first local attempt omitted Supabase's platform default grants and therefore
matched structure but differed in table/function grants. That capture is preserved
as [the initial result](evidence/meta-ads-safe-deployment/local-reproduction-unmodeled-default-acls.json).
Read-only inspection of [actual defaults](evidence/meta-ads-safe-deployment/staging-default-acls.json)
allowed the final fixture to model them before replay, without changing any of the
21 source files. The [final result](evidence/meta-ads-safe-deployment/local-reproduction.json)
has no application catalog/ACL differences.

Local pg_cron/pg_net branches are absent and guarded scheduler provisioning is not
exercised; neither network dispatch nor managed Vault/cron behavior is proven.
Staging also currently lacks pg_cron/pg_net. Do not add extensions and assume skipped
historical provisioning has run. Scheduler creation/activation and its configuration
require separate review and consumer fencing. Existing full-schema Meta, Messenger,
Website/omnichannel and Zalo regression suites are also run; no actual provider call,
Meta lead, customer message or real backup is part of these fixtures.

## 6. Meta-only compatibility and dependencies

| Object / behavior | Prefix | After five Meta files | Full chain |
| --- | --- | --- | --- |
| `han_ingest` | Exists, original prefix implementation | Replaced by the latest shared implementation | Latest shared implementation |
| `open_response_sla_window(uuid,uuid,uuid)` | Exists | Exists; Messenger now calls it | Exists, with intervening full-chain safeguards |
| Ordinary synthetic Messenger intake | Accepted, **0** SLA windows | Accepted, **1** SLA window | Accepted, **1** SLA window |
| Website intake | Accepted | Accepted | Accepted |
| `seed_messenger_pages_canary` function | Absent | Present | Present |
| Trigger using that function | **0** | **0** | **1**, introduced by `20261028130001_remove_messenger_pending_sale_gate_and_enable_pages.sql` |
| `conversations.metadata`, `ai_messenger_page_id`, AI Brain canary/settings tables | Missing relevant prerequisites | Still missing | Present |
| `private.meta_leadgen_events`, `lead_attribution_touchpoints` | Absent | Present | Present |
| Zalo OA schema | Absent | Remains absent | Present and covered by the Zalo regression suites |

**Actual trigger dependency:** there is none in the 21-prefix schema. Defining the
trigger function in a Meta migration does not create its trigger. For a local-only
diagnostic, attaching such a trigger inside a rolled-back transaction causes
SQLSTATE **42703**, `record new has no field metadata`; the absent helper/canary
tables would remain prerequisites after that first missing field is resolved.
The diagnostic trigger is not retained and no staging trigger was created.

Consequently do not claim that five-file DDL must fail on absent canary tables, nor
that successful DDL proves independence. The shortcut changes a shared Messenger
path, omits the separate staging security-hardening migration and other application
modules, and leaves a non-prefix canonical state with 95 gaps. Those gaps cannot
be papered over by repair or invented applied rows. The full application's shared
Messenger/Website/Zalo behavior must be evaluated against its complete reviewed
schema, not certified from this five-file probe.

## 7. A+B versus C and migration ledger strategy

| Strategy | History and execution | Conditions / recovery |
| --- | --- | --- |
| A+B — reuse existing staging | Keep the original 21 application-time rows byte-for-byte. Add separate, reviewed canonical filename/version ↔ actual ledger version ↔ source hash attestations. Execute each remaining complete approved file and append its **actual** application-time ledger identity plus mapping in the same transaction. A historical mapping is an observed attestation, not execution of missing SQL. | A live executor is neither delivered nor approved here. It must validate exact source hash, target, predecessor, original ledger hashes, schema checkpoint and transaction envelope under an advisory lock; reject collisions/intermediate commits/nontransactional effects; atomically commit SQL+ledger+mapping; and define uncertain-commit and partial-chain recovery. Direct/legacy CLI writers must be fenced. |
| C — parallel rebuild/cutover | Keep the existing project and its ledger untouched. Execute an explicitly approved baseline/chain on a separately authorized target; its ledger records only files actually executed there. Keep the original history as original-project evidence, not falsely copied applied rows. | Requires separate project/cost/baseline approval, current compatibility fixes, Auth/Storage/config/key restoration, parity/restore validation and a cutover/rollback plan. Replaying the current 121 files alone reproduces the QC defect; C does not waive destructive approval. |

Recommendation honors reuse of staging: pursue A+B only after the gates below are
closed. If its executor/recovery risk is unacceptable, choose C before making any
change. No strategy has execution authorization now. Both need a reviewed forward
compatibility repair before business acceptance; existing applied sources remain
immutable.

The mapping must handle unique application-time ledger versions explicitly; on a
collision stop/wait according to its reviewed protocol. Never rename canonical
files, rewrite the 21 original timestamps, mark the 100 pending files applied,
or use blind `db push`/`migration repair`. The current standard CLI does not understand
the companion mapping. Only a separately approved executor/operating policy can
resolve this; this report intentionally supplies no runnable remote executor.

## 8. Real staging backup and restore runbook — not executed

The prior synthetic encrypted dump/restore is useful local testing and **is not a
real staging backup**. No staging dump, snapshot, object download or restore was
created here. Before any execution authorization:

1. **Agree custody and objectives.** Name backup/recovery owners and approvers;
   set RPO/RTO, retention and allowed recovery target. Approve a real backup and a
   separately isolated restore rehearsal. Verify the actual plan's snapshot/PITR
   availability rather than assuming a free project has it. Use a staging-only
   least-privilege read credential through a protected libpq service/password file;
   production credentials/endpoints are excluded.
2. **Quiesce and account for writes.** Establish an approved maintenance boundary
   covering app clients, webhook intake/its durable backlog, Auth changes, workers,
   schedulers, Storage uploads and external consumers. Do not acknowledge an inbound
   event without durable retention. Record outstanding claims/outbox/uncertain
   deliveries so recovery cannot blindly resend. Record checkpoint time and WAL
   position where supported; preserve any writes after that checkpoint separately.
3. **Capture schema/data and ledger coherently.** Use PostgreSQL 17 tooling and one
   transactionally consistent full archive covering public, private, migration
   ledger/mapping and the approved Auth/Storage managed-schema data strategy. Include
   function bodies, policies, grants, triggers, indexes, FK validation, sequences
   and ownership mapping. Capture extension names/versions/schemas, publication
   membership, roles/default privileges and the dump tool/server versions. A normal
   Supabase CLI dump's default exclusions are not proof that all managed Auth/Storage
   data is present. Verify the archive TOC and permissions before accepting it.
4. **Encrypt and hash.** An illustrative operator-only capture, after those gates,
   uses a private recipient file and protected connection configuration; it has
   **not** been run:

   ```sh
   set -o pipefail
   umask 077
   pg_dump --format=custom --no-owner --dbname='service=crm_meta_staging_ro' |
     age --recipients-file /secure/approved-backup-recipients.txt > /secure/checkpoint/database.dump.age
   shasum -a 256 /secure/checkpoint/database.dump.age > /secure/checkpoint/SHA256SUMS
   ```

   Preserve grants; do not use `--no-acl` as a shortcut. The backup owner must
   verify pg_dump includes each required schema/role-readable table, including
   `supabase_migrations`; a privilege/managed-schema gap is a stop. Persist an
   encrypted plaintext-manifest digest and archive TOC/row-count hashes under the
   same custody, without printing private rows or tokens. Do not log connection
   strings/passwords or put keys into the archive/repository.
5. **Capture actual Storage bytes.** A database dump contains Storage metadata, not
   file bytes. Under the same fenced boundary inventory every bucket/object/version,
   path, size, content type and a SHA-256 of downloaded bytes using approved staging
   Storage access. Encrypt the byte archive and its manifest. Account for private
   and historical survey/contract/installation/recording objects, including orphaned
   references. Current zero objects must be rechecked at the checkpoint; it is not
   a standing exemption. Listing/RLS metadata, ETags or bucket rows alone are not
   byte verification.
6. **Preserve Auth and configuration dependencies.** Include the managed Auth data
   required to retain user IDs, credentials, identities, MFA and sessions under the
   provider-supported procedure. Separately inventory Site URL/allowed redirects,
   OAuth providers, SMTP, API/JWT/signing configuration, service keys, Storage signing
   configuration, Vault key/secret portability and project-specific settings.
   A SQL archive does not restore those service configurations. Verify project-tied
   encryption/MFA/Vault portability with the platform owner; unresolved portability
   is a blocker, not a reason to copy production keys.
7. **Key custody.** Recover `META_TOKEN_ENCRYPTION_KEY`, any applicable previous
   decryption key, OAuth/session `META_APP_SECRET`, other private-data encryption
   dependencies and the independent backup decryption key through authorized
   custody. Demonstrate access by a recovery owner independent of the operator.
   Never rotate/delete the only key before proving a restore can decrypt retained
   ciphertext. An in-memory synthetic key round trip does not prove this.
8. **Restore to an approved isolated target first.** Prepare compatible managed
   Auth/Storage services, extensions and roles; restore application definitions/data,
   private schemas and the original ledger/mapping with approved ownership remaps.
   Do not blindly recreate or overwrite reserved Supabase roles/managed DDL on an
   existing project. Re-upload Storage bytes by the approved API path and verify
   metadata/reference parity. Keep all provider sends and schedulers fenced.
9. **Validate before declaring recoverable.** Compare archive hashes; per-table
   counts and stable ordered row hashes; schema/function/ACL/RLS/trigger/index/FK
   fingerprints; sequence definitions and safe next values; extension versions;
   complete ledger SQL/mapping hashes; Auth login/MFA and tenant access; and object
   byte hashes plus authorized/denied file retrieval. Test token decryption privately,
   then synthetic intake/idempotency/recovery and read-only app acceptance. Record
   measured RTO/RPO and the exact artifact/target. Any mismatch keeps execution blocked.

Primary references: [Supabase backup/restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
separates database and Storage transfer; [PostgreSQL pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)
documents snapshot/archive behavior. Target-specific managed-service restore and
crypto portability still need validation; this runbook does not claim it occurred.

## 9. Meta and Auth readiness

Only variable **names** were retained from Render's read-only API. No secret value
was printed or written. The three existing keys are
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`; their correctness, role and target project were not
inferred from names. Values need a private staging-only target check before release.

| Requirement | Current readiness / future staging input |
| --- | --- |
| `META_APP_ID` | Missing; approved staging app/test asset required |
| `META_APP_SECRET` | Missing; required for webhook HMAC and encrypted OAuth-session cookie |
| `META_GRAPH_VERSION`, `META_MARKETING_VERSION` | Unset; repository defaults both to `v26.0`, with separate version validation. Choose/review explicitly before live acceptance. |
| `META_TOKEN_ENCRYPTION_KEY` | Missing; independent 32-byte key in the vault's accepted hex/base64 format; protect custody. Previous key only if actual retained ciphertext requires it. |
| `META_VERIFY_TOKEN` | Missing; staging-only webhook verification secret |
| `WEBSITE_ORIGIN` | Missing; required OAuth origin, proposed `https://ai-crm-meta-staging.onrender.com` |
| OAuth callback | Must be approved for `https://ai-crm-meta-staging.onrender.com/api/facebook/connect/callback`; app/allowed-domain configuration unverified and unchanged |
| Page binding | Missing `META_PAGE_BINDINGS` plus its referenced staging-only `META_*_TOKEN`, or the existing single-Page fallback `META_PAGE_ID`, `META_PAGE_ACCESS_TOKEN`, `OMNICHANNEL_COMPANY_ID` (optional display name). Page selection does not grant tenant authority; bind only an approved staging tenant/test Page. |
| Ad-account credentials | Obtain only through an approved test-account OAuth flow into the encrypted vault; optional `META_SYSTEM_USER_TOKEN` is a separate staging-only fallback, not a production token to copy. |
| Webhook | `/api/webhooks/meta`; HMAC, GET verify-token check and read-back of Page `leadgen` subscription must be proven using the approved staging app/asset. Existing Messenger subscription fields must be preserved. |
| Retry scheduler | `CRON_SECRET` missing; production-mode cron route currently fails closed. Metadata-only `/api/cron/meta-ads-sync` needs a separately approved scheduler, or controlled manual sync/retry for acceptance. The five Meta files do not themselves provision this service schedule. |
| Auth / authorization | Staging currently has **zero Auth users**. Staging-only BOSS_ADMIN membership and AAL2 setup must be separately provisioned and verified before connecting Meta or running manual sync. Auth Site URL/allowed redirects and provider settings are unverified. |

Required/default scopes remain `ads_read`, `leads_retrieval`, `pages_show_list`,
`pages_manage_metadata`, `pages_read_engagement`, plus `pages_messaging` for existing
Messenger behavior. Requested scope names do not prove granted permissions,
Advanced Access/App Review, lead access assignments or access to the intended
Page/ad account. `META_LOGIN_CONFIG_ID`, if chosen, can set a remotely controlled
scope set and needs independent review.

No Meta App Dashboard, permissions or asset assignments were changed or live-tested.
Official lead-field/permission dependency requirements remain an acceptance blocker;
the previous documentation fetch was rate-limited and is not resolved by this
preflight. Do not silently add `ads_management`, `pages_manage_ads` or
`business_management`. An approved test Page/account, App roles/access assignments,
review/access-level evidence and explicit authorization for a real Testing Tool lead
are still needed. No production token, Page credential, OAuth submission, real lead
or customer message was used here.

## 10. Render readiness

[Service](https://dashboard.render.com/web/srv-dbi2f3etlv9c738lkum0):
`srv-dbi2f3etlv9c738lkum0`, `ai-crm-meta-staging`.
Read-only [service/deploy capture](evidence/meta-ads-safe-deployment/render-readiness.json)
and [environment-name capture](evidence/meta-ads-safe-deployment/render-env-names.json)
show:

| Check | Observed |
| --- | --- |
| Repository / branch | Correct repository, `meta_ads_integration` |
| Auto deploy / previews | `autoDeploy=no`, trigger `off`; PR previews off |
| Live deploy | `dep-dbi3jbc9v7es738jnl0g`, commit `f7d99b19daa704e1ff3ca9ea1e1fe707b738ffca`, status live; latest attribution application commit is not deployed |
| Build / start | `npm ci && npm run build` / `npm run start`; package start is `next start`; no migration command is configured in these commands |
| Runtime / plan | Native Node web service, free plan, Singapore; no `NODE_VERSION`, `.node-version`, `.nvmrc` or package engines pin observed |
| Compatibility | Installed Next 16.3.5 requires Node `>=20.9.0`; local Node 24.15.0 and the existing Node 22 CI baseline support it. Render's [current default](https://render.com/docs/node-version) for this service creation date is 24.22.1; that is a documented expectation, not a measurement of the live process. Verify the candidate build/runtime version before activation. |
| Health configuration | Empty `healthCheckPath`: default TCP probing, no dedicated HTTP readiness path verified. An unauthenticated root GET returned 307 to `/login`; `/login` returned 200. These show the shell responds, not database/Meta readiness. Initial root wakeup took about 24 seconds; it is not a latency guarantee. |

Required Meta/Auth configuration is incomplete. Keep auto deploy off. Any future
environment/health/scheduler change needs its own approved staging change; do not
mix it into a push or save-and-deploy operation. No Render configuration or deploy
was changed here. [Render deployment](https://render.com/docs/deploys) and
[health-check](https://render.com/docs/health-checks) references were fetched directly.

## 11. Exact staging execution sequence — conditional future work

This is the ordered procedure after separate authorization, not a command to run
now. No runnable remote executor is supplied; step 6 cannot proceed until its
implementation and complete-file protocol have been separately reviewed.

1. Pin the reviewed application commit and all 121 source hashes in this plan's
   manifest, the source SQL bytes, tool versions and the passing exact-head CI.
   Re-read both target IDs, ledger/source hashes, catalog/default grants and counts.
   Any new migration, changed hash/schema, non-prefix history or target mismatch
   stops the release and requires a new preflight.
2. Close the QC/signed-URL/legacy compatibility decisions with an actual reviewed
   forward-only repair and tests. Freeze the exact destructive target/signature
   list, data-retention/consumer attestations and per-item approvals. A blanket
   decision to retire flood-barrier functionality is insufficient.
3. Select A+B or C explicitly. For A+B approve mapping schema/uniqueness, exact
   historical observations, executor identity/target restrictions and ownership.
   For C approve the new target, baseline, data/config migration and cutover. This
   task does not create a project/branch or select a live execution strategy.
4. Approve and implement the maintenance/write/consumer fence; keep customer sends,
   AI canaries, cron/worker dispatch and unapproved external effects disabled.
   Do not add pg_cron/pg_net merely to pass a guard. Verify durable inbound backlog
   and safe handling of uncertain outbound deliveries before opening maintenance.
5. Execute the separately approved real backup and isolated restore validation in
   section 8. Sign off the checkpoint, hashes, decryption custody and RPO/RTO.
   Failure or missing proof stops the release before any pending migration.
6. On A+B, retain the original 21 ledger rows and append the approved companion
   observations. Under the reviewed advisory lock, execute pending complete files
   **22 through 121 in the exact inventory order**, including separately approved
   forward compatibility repairs. Before each file verify source hash, canonical
   predecessor/mapping, transaction support and approved external/destructive
   boundary. At the legacy cleanup boundary recapture actual overloads/dependencies
   after all predecessors and compare to approvals; any extra target stops. Commit
   each complete SQL file plus its real ledger entry and mapping atomically. Never
   write applied status before commit. No ordinary CLI/history writer may race it.
7. After every commit verify catalog/row/privilege invariants and store sanitized
   per-file evidence: source hash, canonical/ledger identities, predecessor,
   checkpoint, start/commit/verification outcome and operator. Stop immediately on
   a mismatch; do not continue a partially verified chain or rerun activation files.
8. With schema and recovery verified, separately configure staging Auth/AAL2,
   Meta app/test assets, encrypted secrets, Page bindings and callback/webhook
   settings. Verify names/targets privately and enforce the scope in section 9.
   Do not copy production credentials or enable write/AI channels as a side effect.
9. Separately approve a manual Render deployment of the exact reviewed application
   commit; auto deploy remains off. Confirm build/runtime/start/health success and
   use read-only application checks first. A failed build/readiness check is not
   permission to migrate again or change credentials blindly.
10. Under a separate live-test authorization, use approved test assets to prove
    signed ingestion, one profile with Campaign A/B/C submissions, duplicate-phone
    flags, duplicate Lead ID idempotency, pending-resolution retry and tenant checks;
    prove Messenger/Website/Zalo regressions and no Insights/report surface. Keep
    provider sends/AI dispatch fenced throughout. No such live test is authorized
    by the current task.
11. Independently approve each scheduler/worker unpause and removal of maintenance
    only after business acceptance, recovery checks and retention reconciliation.
    Keep PR #139 Open + Draft until a later review explicitly changes that state;
    staging acceptance does not authorize production or merging.

## 12. Explicit approval gates

| Gate | Required evidence before a later action | Current status |
| --- | --- | --- |
| Compatibility | Working QC dependency/API decision; signed-URL and legacy-history retention contract; TV9/external caller review | BLOCKED |
| Destructive scope | Each of 160 pending target/subcommand items approved, plus actual boundary closure and non-empty data/lock/retention review | NOT APPROVED |
| Ledger/executor | A+B complete-file atomicity/locking/source/predecessor/uncertain-commit protocol reviewed, or an approved C target/baseline/cutover | NOT DELIVERED/APPROVED |
| Backup/recovery | Real staging archive and object bytes, independent key access, verified isolated restore, agreed/measured RPO/RTO | NOT PERFORMED |
| Meta/Auth | Staging-only secrets/tenant/admin AAL2, app review/access evidence, test Page/account/bindings and callback/subscription acceptance | INCOMPLETE |
| Render/application | Exact commit/manual deployment approval, private env-target validation, build/runtime/health and schema compatibility | NOT DEPLOYED |
| Acceptance/unpause | Separate real test-lead authorization, passing business/channel checks, explicit scheduler/worker/send decisions | NOT AUTHORIZED |

Local or CI success closes test-execution checks only. It does not close a gate
requiring real environment evidence, a technical repair or explicit authorization.

## 13. Rollback and recovery decisions

- **Before any SQL commit:** a validation failure stops with no applied entry.
  Inspect/rollback the uncommitted file and verify data, ledger and mapping are
  unchanged. Retry the same approved hash only after diagnosing the failure.
- **Uncertain commit/disconnection:** reacquire the execution lock and inspect the
  exact source identity, ledger/mapping and business effects. If committed, verify
  instead of replaying. If definitely absent and rolled back, retry the same source
  under the reviewed protocol. Ambiguity keeps the fence in place.
- **Earlier files committed, later file failed:** do not fabricate history or
  automatically rerun the chain. Choose a separately reviewed forward repair or
  restore the verified checkpoint, original ledger/mapping, file bytes and keys.
  Reconcile checkpoint-to-failure writes and provider receipts before resuming.
- **After legacy contraction:** an old app deploy cannot recreate lost rows,
  constraints, functions or object references. Use the verified full recovery path
  or an approved retained parallel target, and repeat schema/data/Auth/Storage and
  tenant checks. Never infer an inverse migration from a DROP list.
- **Application-only failure:** a [Render rollback](https://render.com/docs/rollbacks)
  is a new deploy of a retained artifact, not database/Storage/configuration recovery.
  First prove the chosen app version works with the current schema and keys. Verify
  resulting auto-deploy settings and keep sends fenced; do not assume `f7d99b19` is
  compatible with every migrated state merely because it currently serves login.
- **C cutover:** preserve the old project and its original ledger, define the
  exact write-divergence boundary, and switch back only after reconciling any new
  writes, sessions, object uploads and external effects. Do not permit dual writers.

This task performs only staging metadata/API GETs, offline source inspection,
disposable local SQL tests and GitHub documentation/test publication. It does not
apply remote migrations, push/repair/reset a remote database, create resources or
real backups, change Render/Meta settings, deploy, send messages, create real leads,
remove legacy modules or merge PR #139. Existing evidence and every migration file
are preserved. Detailed validation is in the
[evidence README](evidence/meta-ads-safe-deployment/README.md).
