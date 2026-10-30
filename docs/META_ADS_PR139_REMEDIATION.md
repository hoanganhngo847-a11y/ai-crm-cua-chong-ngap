# PR #139 final remediation — release remains blocked

> Scope update, 2026-10-30: [Meta Ads Lead Attribution Final Scope](META_ADS_LEAD_ATTRIBUTION_FINAL_SCOPE.md) supersedes reporting/dashboard, Insights, ad-set sync and deployment instructions below. This document is retained as historical implementation/review context; use the final-scope metadata fields, route names and migration manifest for release.

No merge, Render deployment, production migration, or production secret mutation is authorized. An independent final review is required. Local and mocked endpoint checks are not live Meta acceptance.

## Migration history

Read-only production inspection on 2026-10-30, project `yrauljxzyklhisxijeim`, confirmed ledger entry `20261028130000 / customer_funnel_six_stages`. That SQL file/version is unchanged. The colliding, **unapplied** `remove_messenger_pending_sale_gate_and_enable_pages` migration is now `20261028130001`. Its SQL body is unchanged. Supabase CLI generated the replacement, then its version was positioned immediately after the applied funnel migration to preserve dependency order (a later timestamp would overwrite newer Messenger/Zalo safety definitions); the final remediation was generated with the CLI and moved to `20261030110000` to follow this branch's pre-existing `09:00`/`10:00` foundation migrations.

`20261030110000_meta_ads_final_remediation` is additive. It restricts credential RPCs, fences webhook and sync ownership, adds atomic intake checkpoints, and validates attribution against server-synced campaign records. No production ledger entry was repaired, deleted, or rewritten.

The complete local sequence must have unique versions and pass `supabase start`, `supabase db reset --local` and the database suite before review. The production ledger has pre-existing timestamp/name differences from repository history outside this PR. A successful local reset does not authorize `db push --include-all` against production. Reconcile that existing drift independently before any release; do not re-run already-applied historical SQL by guessing from filenames.

## Encryption migration: verify the effective key before any release

The original `df679ea` implementation used `SHA256(firstNonempty(trim(META_TOKEN_ENCRYPTION_KEY), trim(META_APP_SECRET)))` as the **effective AES key**. The later implementation parses 32 key bytes directly. These are different even if the env string is already 64 hex characters. Copying the old passphrase into the new parser will strand tokens.

Read-only production inspection found **neither** `public.meta_ad_accounts` **nor** `private.meta_ad_account_tokens`. Neither Ads migration is in its ledger. There are no deployed Ads token rows in those stores to migrate at that inspection time. This does not establish the production environment's key value or format. Production secrets were not read or changed; old production key verification is pending and remains a release gate if any legacy ciphertext exists at release time.

Use a secret-capable operator session with shell tracing disabled:

1. Inventory the release target again, read-only. Export any old encrypted token rows securely, without terminal output or committing them. Account for both the old public `access_token` column and the private vault. Do not execute migration SQL to perform this inventory.
2. Obtain the **exact old configured secret**, including whether the old code fell back to `META_APP_SECRET`, using the secret manager. Never paste it into chat, logs, shell arguments, PR text or source code. Supply it only as `META_LEGACY_TOKEN_ENCRYPTION_SECRET` in a secure process environment.
3. Compute SHA-256 of that trimmed secret inside the secure process. Store its hex digest securely as `META_PREVIOUS_TOKEN_ENCRYPTION_KEY`, without printing it. That variable must hold the effective 32-byte key, not the old passphrase. Provision a dedicated primary `META_TOKEN_ENCRYPTION_KEY` containing 32 bytes (64 hex or canonical base64), without changing production yet. There is no implicit app-secret fallback in the new code.
4. Pipe a JSON array of encrypted fixture/export rows into `scripts/meta-ads/verify-token-key.ts`, using `node --conditions=react-server --import tsx`. It makes no network calls or writes and prints only status and counts. It verifies the old derivation, matches it to the previous key, decrypts every row with both the legacy and new paths, and tests a new-key round trip. An empty array reports `NO_CIPHERTEXT_ROWS`, not legacy compatibility verification.
5. Require `VERIFIED` for all existing rows, plus a rollback-safe secret-manager version and backup. Then obtain independent review and explicit release authorization. This PR does not run any key rotation or deploy.
6. On an authorized future release, retain the previous key while gradually rewriting ciphertext with `rotateToken`. Verify every rewritten row using **only** the primary key, including background jobs and rollback behavior, before considering removal of the previous key. Do not delete the old key while old ciphertext or a rollback requires it.

`.env.example` contains no usable key and documents both variables. Regression coverage creates ciphertext using the original SHA-256 algorithm, decrypts it through the explicit previous key and proves rotated ciphertext no longer needs that key. This is algorithm compatibility proof, not verification of a secret from production.

## Supported versions and OAuth review

Official Meta documentation checked 2026-10-30 (the web fetcher returned 429; the official HTML was fetched directly and its rendered documentation text inspected):

- [Graph API changelog and version tables](https://developers.facebook.com/docs/graph-api/changelog/): v26.0 released July 29, 2026; Graph v21.0 remains supported until January 21, 2027. Marketing v24.0 expired October 6, 2026; Marketing v25.0/v26.0 are listed as available.
- [Marketing authorization](https://developers.facebook.com/docs/marketing-api/overview/authorization/): account reporting may use `ads_read`.
- [Lead retrieval](https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving/): ad-specific lead fields require additional ad-management privileges. This integration now requests only basic lead fields, using signed webhook ad IDs and synced campaign mapping for attribution.

`META_GRAPH_VERSION` configures Graph/Messenger, Page discovery, forms and basic lead reads. `META_MARKETING_VERSION` independently configures ad account discovery/access, campaigns, ad sets, ads and both insight levels. Both default to v26.0. Default OAuth scopes are `pages_show_list,pages_manage_metadata,pages_messaging,pages_read_engagement,ads_read,leads_retrieval`. The application makes no campaign/ad writes. A configured Facebook Login for Business `config_id` can define its own scopes and must separately be reviewed in the App Dashboard; repository scopes cannot override that remote configuration.

Endpoint contract tests cover `me/accounts`, `me/adaccounts`, account access, campaigns, adsets, ads, account and campaign insights, Page leadgen forms, and basic lead details. They assert the selected API version, fields, Bearer header and full pagination/error behavior. No live provider acceptance is claimed: an approved test account/Page/lead and scoped credentials are still required before release. If basic lead/form access is refused with these scopes, keep release blocked and validate the exact documented requirement; do not silently restore write permissions.

## Webhook and attribution invariants

- Atomic conditional upsert returns one `CLAIMED` owner, `BUSY` for concurrent deliveries, and `ALREADY_PROCESSED` only after successful durable completion. Claims have fresh UUID tokens and five-minute leases; stale owners cannot finalize.
- Claim errors/unknown results fail closed. `BUSY` returns retryable HTTP 503, so a failed active owner cannot cause a duplicate request to acknowledge a lost event.
- `ingest_meta_leadgen_event` fences ownership and checkpoints the immutable Meta response/input and `han_ingest` result in one transaction. `han_ingest` retains its existing advisory lock, stable intake key and idempotency conflict behavior. The synthetic `page:leadgen:id` namespace is allowed only for an active registered claim, keeping it separate from Messenger PSIDs.
- Attribution failures and false/error finalizations return HTTP 503. Retries reuse saved input and the intake checkpoint; they complete attribution without duplicate customers/interactions/touchpoints. A process crash is recoverable after lease expiry.
- Incoming campaign names/IDs/status are assertions. Canonical campaign/account keys and all names come from company-scoped synced records. Unknown ads, foreign campaigns, or name-only assertions remain `UNATTRIBUTED`; raw Meta IDs/names remain in `ads_context_data.raw_meta` for later reconciliation.
- First-touch snapshots are immutable, including an unattributed first touch. Latest snapshots follow the latest event time; older events delivered later cannot overwrite them. An unattributed latest event has no invented campaign carry-over. Customer row locks serialize first-touch decisions; lead IDs deduplicate retries.

## Validation record

Local validation on 2026-10-30 (no skipped tests):

| Command | Result |
| --- | --- |
| `npm run test:meta-ads` | PASS — 30 tests, including original 21 scenarios, remediation/key-verifier regressions and mocked discovered-asset/OAuth error checks |
| `npm run test:meta-ads:db` | PASS — native PostgreSQL integration: eight concurrent claims, stale ownership, role ACLs, forged/foreign mapping, timestamp ordering, simultaneous signed webhooks and partial retry/finalization faults |
| `npm run test:omnichannel` | PASS — 34 tests |
| `npm run test:crm` | PASS — all 10 scripts; final funnel suite 94 assertions passed |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS — 0 errors, 18 existing warnings |
| `npm run build` | PASS — Next.js 16.3.5; existing audio-splitter filesystem-tracing warnings |
| `supabase start` | PASS — local Docker stack |
| `supabase db reset --local` | PASS — 114 migrations, 114 unique versions |
| `npm run test:omnichannel:db` | PASS — real local Supabase/PostgreSQL integration |
| `git diff --check` | PASS |

The first local build hit an external `node_modules` symlink; `npm ci` installed worktree-local dependencies. A subsequent build lacked Supabase variables, so the final build used only the **local** stack's URL/keys. Type generation and build were rerun sequentially because both write `.next` types. No checks were disabled. The reset warns about the pre-existing missing optional seed file; it exits successfully and applies every migration.

The applied funnel SQL remains byte-identical (SHA-256 `44a5da682bd501210347b870731fc2260e82e881ef94b9481787ad15dec3c2b0`). The renamed Messenger migration differs only in its filename/version header.

CI follow-up repairs keep every gate enabled: the surviving analytics suite now reconciles its own local auth fixtures (128 assertions); the repeated-fixture runner invokes that existing suite instead of the deleted legacy file; the cross-module suite checks the current canonical stage (101 assertions). Facebook polling now fails closed when the atomic outbound RPC is missing, instead of attempting manual protected/raw-table writes; its regression also proves checkpoints do not advance. The migration Git guard accepts only the reviewed Messenger rename with both SQL bodies pinned to SHA-256 values; four negative/positive regression cases keep deletion, body mutation and applied-funnel mutation rejected (17 integrity tests total).

The Verify workflow now explicitly runs Meta Ads unit/database tests, CRM, typecheck and lint in addition to its existing gates. GitHub Actions must finish on the pushed head before handoff; current status is recorded in the PR body.

Pending release evidence: re-inventory production migration drift and token stores, verify the effective old key for any existing legacy ciphertext, complete live Meta endpoint/scope acceptance with an approved test account/Page/lead, and obtain independent final review. These remain release gates regardless of local or GitHub CI results.


### Discovered assets and staging proposal

The 2026-10-30 browser-discovered production assets do not supply staging isolation or proven permissions. See [META_ADS_STAGING_VALIDATION_PLAN.md](META_ADS_STAGING_VALIDATION_PLAN.md) for the corrected Render service ID, independent asset relationships, v26 configuration, conditional permission requirements, and the exact future approval procedure. No provider token values were inspected or copied and no live test was executed. In particular, current official form-read documentation and lead-permission dependencies remain unresolved API acceptance blockers.

CI reached and passed the full integration and repeated-fixture gates on `e1d48ea`; the subsequent native Meta database test exposed a Linux process-output race in the test harness (`exit` can occur before stdout drains). The harness now awaits `close` and bounds child processes; it retains all concurrent/RLS/retry assertions. Its final CI status is recorded in the PR body. The local Docker VM became unavailable after host disk exhaustion; worktree-generated `.next` output was removed to recover space. Earlier complete local DB resets/native runs passed; an interrupted later rerun is not recorded as passing.
