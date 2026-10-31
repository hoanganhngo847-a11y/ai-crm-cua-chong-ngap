# Meta Ads staging migration remediation

**Status: BLOCKED — staging is not ready for Meta Ads live validation.**

Audit date: 2026-10-30, Asia/Ho_Chi_Minh. Target: Supabase
`qmhfmgkymjgoevwmkidm` (`ai-crm-meta-staging`, PostgreSQL 17), branch
`meta_ads_integration`, [PR #139](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/pull/139).
Requested starting commit: `f7d99b19daa704e1ff3ca9ea1e1fe707b738ffca`.
Latest implementation commit: `71e1bb68d17349d48e8537985a9653873cafe3dd`.
Documentation/evidence follow-up commits are listed in the PR; this report records
the implementation SHA rather than attempting to embed its own Git hash.

## Migration inventory and current staging

| Measurement | Verified result |
| --- | --- |
| SQL migration files at requested commit | 115 |
| SQL migration files after remediation | 116 |
| Unique versions after remediation | 116; no collisions |
| Recorded staging migrations, before and after this work | 21; unchanged |
| Pending canonical files | 95, including the new security migration |
| First pending file | `20260928000002_tv9_post_merge_hardening.sql` |
| Staging status | `ACTIVE_HEALTHY` |
| Staging application tables | 44; all have RLS |
| Invalid indexes / unvalidated constraints on staging | 0 / 0 |
| Clean local replay | All 116 migrations, no skipped files |

Every SQL file was read for the inventory. Two evidence files cover all files:
[SHA-256/line inventory](evidence/meta-ads-staging/migration-inventory.json) and
[statement execution review](evidence/meta-ads-staging/execution-risk-inventory.json).
The latter identifies 2,277 top-level statements and 141 review candidates,
including policy/constraint replacement, signature changes, data updates, and
executing DO blocks. Candidate counts are lexical review aids, not a safety
allowlist; CREATE FUNCTION bodies do not execute their DML at migration time.
No top-level TRUNCATE was found. TRUNCATE in REVOKE is a permission name.

The duplicate `20261028130000` version had already been resolved on the supplied
branch: the funnel retains `20261028130000`, and the Messenger file is
`20261028130001`. This work did not rename or change any existing migration.
The existing migration-integrity gate still validates that narrow, hash-pinned
rename exception. Full sequential replay passed without duplicate-table,
duplicate-column, duplicate-constraint, or unresolved-dependency errors.

### History versions are not filename versions

The staging ledger uses MCP application-time versions `20261030063323` through
`20261030064113`, while the corresponding files use their original September
versions. All 21 unique names, in order, match the first canonical prefix ending
at `operations_p0_hardening`. See [the captured ledger](evidence/meta-ads-staging/staging-history.json).

Name matching alone is insufficient. A fresh disposable PostgreSQL database was
built from exactly those first 21 files, then compared with the live staging
catalog using [the read-only fingerprint query](../scripts/meta-ads/staging-catalog.sql).
All seven category counts and fingerprints match:

| Category | Matching objects |
| --- | ---: |
| Columns | 460 |
| Constraints | 298 |
| Application functions, excluding extension-owned functions | 92 |
| Indexes | 154 |
| Policies in public/private | 86 |
| Tables and views | 45 |
| Non-internal triggers in public/private | 63 |

[Staging fingerprints](evidence/meta-ads-staging/staging-prefix-catalog.json) and
[local prefix fingerprints](evidence/meta-ads-staging/local-prefix-catalog.json)
are committed. The regression test recomputes the canonical prefix catalog.
These fingerprints cover definitions and RLS state, not table data, owners,
every ACL, storage policies, or a byte-for-byte migration statement attestation.
Targeted privilege checks supplement them.

Live privilege checks also confirm anon/authenticated have no USAGE on private,
no private table grants (including PUBLIC), and no CREATE on public.

`sales_style_activation` is recorded at `20261030063640`. All four activation
columns exist with the expected schema: `activated_at`, `activated_by_user_id`,
`superseded_at`, and `superseded_by_profile_id`. Its indexes and constraints match
the canonical prefix. The original migration uses unguarded ADD COLUMN and is
not intended to be replayed. The earlier duplicate-column message is consistent
with replay, but its original execution payload is unavailable, so its exact
historical cause is not claimed. No replay or history repair was performed.

## Blocked TV9 migration and destructive operations

The complete 1,954-line TV9 file was inspected. Its sole DROP statement is line
664:

```sql
DROP FUNCTION IF EXISTS public.resolve_response_sla_on_sale_reply(uuid, uuid, uuid);
```

The replacement at line 666 has a fourth `timestamptz DEFAULT NULL` argument.
This changes the function identity; it is not CREATE OR REPLACE of the old
three-argument function. It provides provider-confirmed delivery timestamps for
SLA resolution. The rest defines/redefines seven RPCs, adds nullable
`private.han_outbox.sent_at` with IF NOT EXISTS, and changes comments/EXECUTE ACLs.
The RPC DML is inside function bodies, not a migration-time bulk data rewrite.

The old function exists on staging. It is executable by service_role, denied to
authenticated, and has zero catalog dependents. Dropping it deletes executable
schema, not customer rows; code/PostgREST callers can still depend on it without
a pg_depend entry. Signature replacement and ACL transitions therefore need
review. Later migrations temporarily grant authenticated EXECUTE on some
Facebook primitives before the subsequent P0 ACL migration removes it again;
staging should not serve partially migrated application traffic.

The explicit DROP is the concrete destructive approval boundary in this file
and the likely safety-filter trigger. The original rejection payload/filter
implementation was not supplied. The tool rejection was not reproduced by
resubmitting destructive SQL without approval, so no stronger attribution to a
specific filter rule is claimed.

An additive API design could retain a compatibility wrapper and introduce an
explicitly versioned implementation. Merely retaining the old three-argument
function beside a four-argument defaulted overload can preserve old behavior
or create ambiguous resolution. Removing/reformatting DROP just to get through
the filter is not a remediation. Splitting this existing migration or applying
only selected statements would also require an approved migration plan; it
would not justify recording the original as fully applied. A later forward-only
file cannot make the earlier immutable DROP disappear from a sequential replay.

### Additional, higher-impact blocker

`20261029160000_remove_legacy_flood_barrier_schema.sql` executes dynamic
`DROP FUNCTION ... CASCADE` at line 529 and `DROP TABLE ... CASCADE` at lines
534–549. The 14 target tables are:

`survey_photo_operations`, `surveys`, `installations`, `warranty_tickets`,
`production_orders`, `contracts`, `payment_transactions`, `operations_outbox`,
`finance_summaries`, `orders`, `price_calculations`, `pricing_policies`,
`company_bank_accounts`, and `appointments`.

The file comment calls them empty; that comment is not proof of current data
emptiness. CASCADE can remove dependent objects and existing rows. This file was
not executed on staging. Other pending migrations replace RPC signatures,
drop policies/constraints, migrate stages/metadata, and change AI/canary
configuration; their candidates are retained in the execution inventory.
Approval for the first function DROP alone would not authorize these later
operations. No protection was disabled, no SQL was disguised, and no pending
migration was recorded as applied.

## Forward-only remediation prepared and tested

Added `20261030120001_staging_function_security_hardening.sql`:

1. Pins search_path for the 19 reported helpers to `pg_catalog, public, pg_temp`.
   public is trusted because browser CREATE is already revoked. A fixed
   signature allowlist skips functions genuinely removed by the legacy-module
   migration; ten survive in the final schema. No arbitrary function is altered.
2. Revokes direct EXECUTE on trigger-only `handle_new_user()` from PUBLIC, anon,
   and authenticated. Trigger/owner privileges remain intact.
3. Enables RLS on three tables missed by the historical chain:
   `private.zalo_oa_secrets`, `private.zalo_outbound_payloads`, and
   `public.customer_stage_migration_audit`. They already denied browser ACLs,
   so this closes a defense-in-depth gap without opening new client access.

The CLI generated the new file; its version was positioned after this branch's
already-existing future `20261030120000` file to preserve forward order.
The migration changes security metadata only, with no data deletion, new
business policies, or blanket domain ACL revocation. It was tested both against
the 21-file prefix in a rolled-back local transaction and at the end of the full
chain, including idempotent reapplication. It has **not** been applied to staging
out of order while its 94 predecessors remain pending.

## Security Advisor classification and before/after

Live staging Advisor was run before and after this read-only audit; its results
are unchanged, as expected. Captures:
[before](evidence/meta-ads-staging/security-advisor-before.json),
[after](evidence/meta-ads-staging/security-advisor-after-unchanged-staging.json).

| Finding | Staging before / after | Assessment and action |
| --- | --- | --- |
| RLS enabled, no policy | 16 / 16 | Intentional deny-by-default backend tables, not a reason to invent permissive client policies. Seven private raw/credential/intake stores and nine public worker/outbox/media tables are RPC/server-only. Keep ACL and RPC boundaries. |
| safe_staff_directory definer view | 1 / 1 | Intentional restricted projection: id, display_name, role, null avatar; active same-company membership predicate. An invoker conversion would hide coworkers under self-only profile RLS. Retained, with cross-tenant regression. Advisor ERROR remains visible and requires an explicit accepted design exception. |
| Mutable function search_path | 19 / 19 | Hardening gap; prepared forward-only pinning. All 19 are invoker helpers, not proof of an existing definer escalation. |
| anon can execute handle_new_user | 1 / 1 | Unnecessary trigger-function RPC privilege; revoke in prepared fix. PostgreSQL disallows directly executing trigger functions as ordinary functions, so this is not evidence of a demonstrated anonymous signup bypass. |
| authenticated can execute definer functions | 8 / 8 | Seven intentional authorization/aggregate/activation RPCs; one unnecessary trigger entry point. Details below. |
| pg_trgm in public | 1 / 1 | Existing extension-placement warning, acceptable for isolated staging with CREATE denied. Moving it requires operator/index/search-path dependency review; no extension relocation performed. |

The eight authenticated-callable definer functions are individually classified:

| Function | Assessment |
| --- | --- |
| `has_company_role(uuid,text)` | Intentional RLS helper; binds membership to auth.uid(), target company, required role and active user/member. Fixed empty search_path. |
| `is_active_member(uuid)` | Intentional RLS helper; auth.uid(), company and active profile/member checks. Fixed empty search_path. |
| `is_assigned_technician(uuid)` | Intentional on the prefix: appointment assignee must be auth.uid(), with matching active company membership, technician role and actionable appointment. Removed later with the legacy module. |
| `is_self_membership(uuid)` | Intentional self-only membership lookup tied to auth.uid(). Fixed empty search_path. |
| `get_company_analytics_overview(...)` | Intentional bounded aggregate RPC; derives actor from auth.uid(), requires active BOSS_ADMIN in the requested company, and scopes every aggregate. |
| `get_company_analytics_daily_series(...)` | Same company/actor/role checks and bounded time interval as overview. |
| `activate_sales_style_profile(uuid)` | Intentional human BOSS_ADMIN operation in the resource's company. The pending TV9 definition adds mandatory AAL2 and provenance checks; those checks must not be claimed deployed on the current prefix. |
| `handle_new_user()` | Trigger-only entry point; direct authenticated/PUBLIC privileges removed by the prepared fix. |

After the final local reset, CLI Security Advisor reports 50 deny-by-default
no-policy tables, one intentional definer view, and one extension-in-public
warning. Mutable search_path findings are zero. This is the larger 116-file
schema, not a before/after comparison against staging's 21-file schema. The local
CLI linter did not emit the newer 0028/0029 EXECUTE categories; explicit catalog
and role tests verify the trigger revoke rather than claiming those categories
were cleared by Advisor. [Local Advisor output](evidence/meta-ads-staging/local-security-advisor-after.json).

Performance Advisor additionally found 47 unindexed foreign keys, six auth/RLS
initplan opportunities, 53 unused indexes on this new database, 34 multiple
permissive-policy findings, and one duplicate-index group. The duplicate is
`public.calls`: `idx_calls_provider_call` and `uq_calls_tenant_provider_call`.
It is redundant indexing, not an apply-time name collision. No index was dropped
without approval. Fresh-database unused-index statistics do not justify deletion.
These optimizations remain open and do not establish a tenant-isolation failure.
See [the performance summary](evidence/meta-ads-staging/performance-advisor-summary.json).

## Tests and application compatibility

| Verification | Result |
| --- | --- |
| New ledger/schema/security regressions | PASS, 4 tests; version drift, ambiguity/gaps/conflicts, live-capture prefix equivalence, all-file replay, fixed search_path, trigger ACLs, signup trigger, two-tenant staff projection, RLS, valid indexes/constraints, repeat metadata migration |
| `npm run test:migration-integrity` | PASS, 17 assertions |
| `npm run test:meta-ads` | PASS, 34 tests |
| `npm run test:meta-ads:db` | PASS, native PostgreSQL with eight overlapping claim connections, stale owners, cross-tenant/forged attribution, token ACLs, signed webhook concurrency, partial intake/finalization recovery |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS, 0 errors; 18 existing warnings |
| `npm run build` | PASS, local placeholder Supabase environment; existing build tracing warnings |
| Isolated `supabase start` | PASS |
| Isolated `supabase db reset --local --no-seed` | PASS, all 116 history entries, 85 public/private application tables |
| `git diff --check` | PASS |

The new regressions run in the Verify workflow immediately after Supabase reset.
Local tests create disposable databases, apply original SQL, and clean only
their own databases. The isolated full-stack project is
`crm-meta-migration-validation` under `/tmp/crm-meta-migration-validation`, using
ports 55320–55329, PostgreSQL 17 and CLI 2.119.0. Existing local databases were
not reset. The final reset succeeded with the final migration bytes. Seed was
explicitly excluded; no seed data or production data was copied.

The complete schema supports the Meta public account/campaign/adset/ad/form/
insights tables and `lead_attribution_touchpoints`, private encrypted token and
durable lead-event stores, intake claim/finalize RPCs, token RPCs, sync leases,
attribution RPC and performance report. Native tests cover their ACLs, company
ownership, actual webhook-to-SQL flow and retry/concurrency behavior. Graph HTTP
is mocked in those tests; this does not prove real Meta permissions or assets.

Live staging currently has none of those new Meta tables and lacks
`claim_meta_leadgen_event`. The application's successful login-page HTTP 200
therefore does not demonstrate Ads/database compatibility. The database is a
verified historical prefix, not the schema required by the current application.
The PR database review found no further chain apply error; this is not a claim
of independent live acceptance of every UI/provider behavior in the full PR.

## GitHub Actions

CI for implementation SHA `71e1bb68d17349d48e8537985a9653873cafe3dd` was triggered
by pushing the existing branch. **All six jobs in five workflows PASS.**
Verify completed in 9m32s, including the new regressions and all its existing
database, concurrency, integration, typecheck, lint and build gates.
See [the captured check results](evidence/meta-ads-staging/ci-implementation.json).

| Workflow | Result | Run |
| --- | --- | --- |
| Verify | PASS | [41031452730](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/actions/runs/41031452730) |
| Personal Zalo campaign gate | PASS | [41031452804](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/actions/runs/41031452804) |
| Zalo OA & care gate | PASS | [41031452858](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/actions/runs/41031452858) |
| Voice security gate | PASS | [41031452999](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/actions/runs/41031452999) |
| ZCAJS Integration CI, two jobs | PASS / PASS | [41031452998](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/actions/runs/41031452998) |

These are all workflows selected by the PR's configured triggers. Unrelated
manual patch/deployment workflows were not invoked to manufacture an all-green
result. No check was disabled or bypassed.

## Remaining gates and decision

1. Obtain owner approval for the concrete destructive operations, starting with
   the TV9 function signature removal and separately the later 14-table/RPC
   removal; review the full execution-risk inventory and actual target data.
2. Agree on deployment tooling for the application-time ledger versions. A
   blind CLI push sees filename versions as unapplied; no history repair or
   skipping by name is authorized by this audit. Preserve all 21 entries.
3. Apply every approved pending migration in order to the designated staging
   project, then repeat catalog/privilege/Advisor and real staging RPC checks.
   The prepared security migration must not be treated as already deployed.
4. CI on the implementation source is complete; obtain final PR review. Separately
   resolve the dedicated staging Meta asset/permission/key gates in
   [the validation plan](META_ADS_STAGING_VALIDATION_PLAN.md) before provider calls.

**Decision: BLOCKED.** A reproducible clean local chain and passing tests do not
make the current staging schema synchronized. No production Supabase connection
or SQL, production Render action, environment-variable mutation, customer-data
copy, PR merge, or production deployment was performed. Staging schema/history
remain unchanged, and no real Meta call, lead creation, or outbound message was
performed by this remediation.
