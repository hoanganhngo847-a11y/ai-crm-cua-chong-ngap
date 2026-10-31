# Meta Ads: final lead attribution scope

Date: 2026-10-30 (Asia/Ho_Chi_Minh). Branch: `meta_ads_integration`.
PR: [#139](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/pull/139), Open + Draft.
Business baseline: `0d21bb89b97cdcd1b82f08a72149e68f87b8ae2f`.

The CRM records which advertising campaigns produced each customer's lead
submissions. A phone submitted through Campaign A on 15 October, Campaign B on
30 October and Campaign C later on 30 October belongs to one customer, with three
submission events, three campaign associations and explicit duplicate-phone
indicators. This document supersedes advertising-reporting instructions in the
earlier integration/remediation documents. Historical evidence stays unchanged.

## Removed reporting features

- `/admin/analytics/meta-ads`, its sidebar item and links from admin/Facebook.
- `/api/admin/meta-ads/report` and `/api/admin/meta-ads/sync`.
- `get_meta_ads_performance_report`, `meta_insights_daily`, Insights DTOs,
  aggregation helpers and account/campaign daily Insights requests.
- The ad-set catalog and its sync, campaign objectives/budgets/schedules,
  ad creative content, and unused form-question storage/sync.
- Spend, impressions, clicks, CTR, CPM, CPC, CPL and performance-report tests.

The removed routes have no replacement reporting surface. No campaign/ad creation
or editing is implemented. No performance metrics are requested or persisted.

## Preserved customer attribution

`/admin/facebook` still connects OAuth, selects Pages and advertising accounts,
checks subscriptions and manages bindings. Token encryption, private token storage,
signature verification, durable Lead ID claim/lease/finalization, bounded pagination,
account sync leases, tenant checks and server-only evidence writes remain in place.

The intake and phone-resolution logic from the business baseline is preserved.
Exact normalized-phone matching is limited to the same tenant. Ambiguous identities
are preserved for manual review without automatic merging. Duplicate Lead ID
deliveries create one submission; distinct leads from the same phone retain each
submission's date, campaign, raw evidence and duplicate-phone verdict. First-touch
and latest-touch rules are preserved, including delayed campaign resolution.

The existing customer section **Nguồn khách hàng & Lịch sử đăng ký** retains:

- First/latest campaign, total Meta submissions and distinct campaign count.
- Chronological submission history, dates, Page/campaign names and form identity.
- **Lead đầu tiên**, **Lead trùng SĐT** and pending campaign indicators.

Messenger referrals, Website UTM attribution, Zalo intake and their customer identity
rules are unchanged by this scope reduction. The main merge includes the existing
Zalo onboarding/group fixes; no additional Zalo or Messenger runtime changes were
made for this task.

## Minimal Graph API contract

`META_GRAPH_VERSION` and `META_MARKETING_VERSION` retain their separate supported
version checks. Attribution resolves **Lead → Ad ID → Campaign ID → Campaign name**.
Names asserted by a webhook are not trusted campaign evidence.

| Read | Requested fields/purpose |
| --- | --- |
| `/me/accounts`, Page subscription read-back | Existing Page discovery/binding and subscription verification |
| `/me/adaccounts` | `id,account_id,name,account_status,currency`; asset selection/connection identity |
| `/{ad-account}` | `id,account_status`; validate account access |
| `/{ad-account}/campaigns` | `id,name,status`; tenant/account-scoped campaign identity |
| `/{ad-account}/ads` | `id,name,campaign_id,status`; minimal ad-to-campaign mapping |
| `/{page}/leadgen_forms` | `id,name,status`; form identity helper, with no questions/metrics |
| `/{lead-id}` | Existing single lead read: lead time, form/ad/campaign identifiers and field data; one minimal-field fallback on HTTP 400 |

The lead read keeps the baseline's optional ad/form/ad-set name fields as raw
submission evidence for compatibility. It never requests performance metrics.
An optional ad-set identifier and snapshot fields remain compatible in attribution
RPCs/history; there is no ad-set catalog, ad-set request or ad-set enrichment.
Only server-synced campaign/ad records in the same tenant and advertising account
can provide verified campaign snapshots.

All advertising reads use GET with Bearer headers, bounded pagination and existing
redaction/backoff. Existing Page webhook subscription POSTs remain solely for
connection configuration; there are no campaign/ad writes.

## Metadata synchronization and retry

`syncCompanyMetaAttribution` synchronizes only campaign/ad metadata. Initial OAuth
connection still starts that sync. On `/admin/facebook`, **Đồng bộ nguồn khách hàng**
posts to `/api/admin/facebook/attribution-sync`: current-tenant BOSS_ADMIN is
required, with existing production AAL2 enforcement. Credentials come from the
server vault/config, not the form. It retries pending campaign attribution even
after a partial metadata sync and reports an incomplete result if either step fails.

`GET/POST /api/cron/meta-ads-sync` keeps its scheduler URL and CRON_SECRET protection.
It now runs metadata-only sync and the existing per-tenant
`retry_pending_lead_attribution` RPC. A cron tick also retries pending submissions
after the OAuth-triggered initial sync. Unresolved campaigns remain pending;
no names are invented and no submission/history row is discarded.

## Migration decision and integrity evidence

Before editing migration SQL, read-only Supabase checks inspected both connected
hosted projects and their database branch lists:

| Project | Recorded migrations | Meta Ads migrations/objects | Branches |
| --- | ---: | --- | ---: |
| `ai-crm-meta-staging` (`qmhfmgkymjgoevwmkidm`) | 21 | None | 0 |
| `ai-crm-cua-chong-ngap-demo` (`yrauljxzyklhisxijeim`) | 102 | None | 0 |

Catalog checks confirmed that Meta account/insights tables and the report RPC were
absent, independently of migration timestamp/name matching. See the timestamped
[deployment history evidence](evidence/meta-ads-final-scope/deployment-history-check.json).
These are all hosted projects visible to the connected account; an undisclosed
external environment must be checked again before release. Disposable local test
schemas had earlier source copies and are rebuilt in newly created test databases;
they are not deployed migration history.

Consequently only the five **unreleased** Meta migration files were eligible for
simplification. Four changed; `20261030120000_meta_ads_attribution_rpc_security.sql`
is unchanged. The removed table/RPC definitions and unused metadata columns are
omitted from their original pending definitions, rather than created and dropped.
The definitive phone intake, concurrency, snapshot and retry functions keep their
behavior; their metadata lookups now join campaigns/ads without the ad-set catalog.

The [new integrity manifest](evidence/meta-ads-final-scope/migration-manifest.json)
records original hashes from the business baseline, the four old/new hash pairs,
and SHA-256/statement count/transaction mode for all 121 current migration files.
The historical 116-file audit, its hashes, the 21-entry staging ledger and captured
catalog evidence remain unchanged. Readiness tests verify that historical sources
still match unless listed as an explicitly reviewed, unreleased Meta replacement.
The main merge adds four existing Zalo migrations, and the prior phone-history
migration accounts for the other file beyond that historical 116-file audit.

No already-applied migration was rewritten. No new DROP of a legacy CRM table was
introduced or executed against a hosted environment. All schema replay and
concurrency checks for this change use disposable local PostgreSQL/PGlite fixtures.

## Regression evidence

The Meta suite covers new customer intake; A/B and A/B/C submissions on one phone;
duplicate Lead ID; ambiguous/missing/invalid phone; tenant boundaries; pending
campaign resolution/retry; and Messenger/Website compatibility. The A/B/C acceptance
test uses real synced campaign/ad records and the owner's 15/10 + 30/10 + 30/10
example, asserting one profile, three campaign names, ordered dates, Page names,
first/latest snapshots, distinct campaign count and duplicate verdicts.

Native PostgreSQL tests exercise independent concurrent claim/webhook connections,
stale owners, partial intake/attribution/finalization recovery, credential/RPC ACLs
and cross-tenant evidence. They also verify that reporting tables/RPCs/columns do
not exist in the resulting schema. Runtime tests verify only minimal metadata is
written even when upstream supplies extra metrics, and that scheduled sync retries
each tenant once without Insights/ad-set requests.

Validation results and limitations are recorded in
[validation-results.json](evidence/meta-ads-final-scope/validation-results.json).
No real Meta lead, token exchange, customer message or permission acceptance was
used to obtain these results. Local tests do not establish live Meta acceptance.

## Remaining Meta permissions

Default OAuth scopes remain:

| Scope | Retained use |
| --- | --- |
| `pages_show_list` | Page selection |
| `pages_manage_metadata` | Webhook subscription configuration/read-back |
| `pages_read_engagement` | Existing Page/lead access requirements |
| `pages_messaging` | Existing Messenger integration |
| `ads_read` | Read campaign/ad identity for attribution |
| `leads_retrieval` | Retrieve submitted lead/form data |

No reporting-only scope or campaign-write scope was added. A configured Facebook
Login for Business `config_id` can define scopes outside the repository default;
its configuration still requires review. Actual granted permissions, App Review
access levels, Page/ad-account/lead-access assignments and Meta's endpoint-specific
dependencies are not proven by tests or the configured scope list.

Official references: [lead retrieval](https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving/),
[Marketing authorization](https://developers.facebook.com/docs/marketing-api/overview/authorization/),
[permission reference](https://developers.facebook.com/docs/permissions/).
Live documentation retrieval was rate-limited/unavailable during this task;
the earlier permission-dependency uncertainty is not considered resolved. If the
read-only flow requires additional scope/access, record a sanitized failure and
review the minimum requirement separately. Do not silently add `ads_management`,
`pages_manage_ads` or `business_management` to obtain a passing result.

## Staging deployment instructions — not executed

1. Keep PR #139 Open + Draft. Review this final scope and require the applicable CI
   checks against the exact pushed head. No Render deployment or merge is authorized
   by this task.
2. Recheck migration ledgers and catalog on every intended target immediately before
   release. If any Meta migration has since been applied, stop: retain that deployed
   source and prepare a separately reviewed forward-only migration. Never repair a
   ledger to conceal source drift.
3. Staging is still at the 21-file prefix, with 100 files pending in this checkout.
   The pre-existing chain contains legacy schema removals and RPC/ledger compatibility
   issues documented in [the staging migration plan](META_ADS_STAGING_MIGRATION_REMEDIATION.md)
   and [pre-destructive remediation](META_ADS_STAGING_PRE_DESTRUCTIVE_REMEDIATION.md).
   This scope reduction does **not** approve that chain. Do not run a blanket
   `supabase db push`, reset, DROP/CASCADE or migration-history repair on staging.
   Resolve that separate review, backup/restore, dependency and ledger plan first.
4. Once separately authorized, deploy the exact approved schema/application pair to
   staging only, with background sends/AI delivery fenced and encryption/cron
   secrets supplied privately. Existing OAuth bindings and runtime credentials must
   remain tenant-scoped and encrypted; never include tokens in evidence.
5. Verify `/admin/facebook`, metadata-only manual/cron sync, and the customer history
   with synthetic local fixtures first. Any real Meta Testing Tool lead, live OAuth
   validation or hosted test submission needs separate authorization. Check that
   retired report URLs return 404 and that no Insights/ad-set request is emitted.
6. Re-run A/B/C, duplicate-ID/phone, tenant, concurrency and other-channel checks before
   changing Draft status or seeking merge/release approval. Retain sanitized results.

No staging migration, production modification, Render deployment, PR merge or real
test lead was performed for this task.
