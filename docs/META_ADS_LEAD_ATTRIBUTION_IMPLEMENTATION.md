# Meta Ads Lead Attribution & Duplicate-Phone History — Implementation

Branch: `meta_ads_integration` · PR #139 (kept in Draft, not merged)

Business outcome: when a customer submits a Facebook Lead Ads form, the CRM knows **who**
(the customer), **which phone**, **which page**, **which campaign**, **when** — and when the
SAME phone submits from DIFFERENT campaigns, the CRM reuses ONE customer profile and keeps
EVERY submission with its own attribution event.

**Final principle: ONE customer profile, many attribution events, zero lost campaign history.**

---

## 1. Existing architecture reused

The feature is an extension of the already-present Meta omnichannel stack; no parallel
system was introduced.

| Reused component | Role |
|---|---|
| `app/api/webhooks/meta/route.ts` | Signature validation, verify-token handshake, Messenger + Lead Ads batch funnel (unchanged externally) |
| `features/omnichannel/facebook/core.ts` | HMAC verification, `parseLeadgenChanges`, `normalizePhone` (canonical VN phone) |
| `features/omnichannel/facebook/lead-ads.ts` | Lead fetch → ingest → attribute → mark → finalize funnel |
| `han_ingest` + `private.han_intake_events` | DB-level immutable intake ledger, phone/contact book (`private.customer_private_contacts`) |
| `private.meta_leadgen_events` | Claim/lease/finalize state machine = durable webhook idempotency for Meta Lead IDs |
| `lead_attribution_touchpoints` | Per-submission attribution ledger (first/latest touch + snapshots) |
| `syncCompanyMetaAds` (`marketing-sync.ts`) | Read-only Marketing API sync of campaigns/ad sets/ads into tenant tables — the ONLY campaign evidence source |
| `features/omnichannel/facebook/{binding,server,token-vault,graph-api}.ts` | Page binding, service-role RPC client, AES-GCM token vault, Graph version pinning |
| Messenger / Website / Zalo modules | Untouched behavior; pinned by their suites (see §9) |

## 2. Customer deduplication strategy (Rule C)

Matching is **exact, canonical, tenant-scoped** — never partial, never cross-company.
The decision is made inside the DB (`han_ingest`) while holding a per-company advisory
lock, so concurrent same-phone submissions can never race into duplicate customers.

| CASE | Situation | DB behavior | Verdict recorded |
|---|---|---|---|
| 1 | Phone unknown in tenant | Create customer + bind canonical phone | `NEW_PHONE`, `is_duplicate_phone=false` |
| 2 | Phone owned by exactly one profile | **Reuse** that customer; new touchpoint; first-touch attribution untouched | `MATCHED_EXISTING`, `is_duplicate_phone=true` |
| 3 | Phone owned by multiple profiles | No auto-merge, no arbitrary pick; submission preserved as its own profile flagged for manual duplicate resolution | `AMBIGUOUS_MULTIPLE`, `is_duplicate_phone=true`, intake `IDENTITY_REVIEW` + audit row |
| 4 | Phone missing/invalid | Lead preserved with its own profile, no invented identity, no phone binding | `NO_PHONE` |

Scope guard: phone-based reuse applies ONLY to Lead Ads intake identities
(`page_id:leadgen:<leadgen_id>`, unique per submission). Messenger and Website keep their
established semantics (identity-vs-phone-owner conflicts still land in
`IDENTITY_REVIEW` with `CONFLICT` — no destructive merge, no binding moves).

The verdict is persisted twice so it survives webhook retries exactly:
`private.meta_leadgen_events.phone_match_status/is_duplicate_phone` (durable event) and
`lead_attribution_touchpoints.normalized_phone_match_status/is_duplicate_phone`
(auditable attribution event). A retried delivery of the same lead replays the persisted
verdict; it can never diverge.

Duplicate-phone ≠ duplicate-delivery: same Lead ID twice → one intake, one touchpoint
(idempotency, §7); same phone + new Lead ID → new touchpoint on the same customer.

## 3. Phone normalization strategy

- `normalizePhone` (existing, in `core.ts`) is the single entry point:
  `03xxxxxxxx → +84…`, `843xxxxxxxx → +84…`, `+84…` passthrough; 00-prefixed to `+`.
- The funnel only ever handles canonical `+E.164` (validation `^\+[1-9][0-9]{7,14}$`)
  or NULL; a non-canonical value fails closed (`INVALID_REQUEST`) — invalid numbers are
  never silently matched or dropped, and no new normalization library was introduced
  (the existing guardrail is permissive-safe and already regression-pinned).
- Canonical values only are used for matching; the raw submitted value never persists
  beyond the raw interaction record, is masked in safe content
  (`SĐT: [số liên hệ đã ẩn]`), and never appears in logs or the attribution payload
  (`crm_phone_detection: { status }` only).

## 4. Attribution event schema

`lead_attribution_touchpoints` (existing table reused — no new tables):

- New: `normalized_phone_match_status text` (NEW_PHONE / MATCHED_EXISTING /
  AMBIGUOUS_MULTIPLE / CONFLICT / NO_PHONE; NULL = channel never does phone matching),
  `is_duplicate_phone boolean`.
- Preserved per event: `company_id`, `customer_id`, `interaction_id`, `channel`,
  `page_id/name`, `meta_campaign_id`, `campaign_name_snapshot`, ad/adset ids + snapshots,
  form id/name, `meta_leadgen_id` (provider Lead ID), `touchpoint_type`
  (FIRST_TOUCH/LATEST_TOUCH), `attribution_status` (ATTRIBUTED/INFERRED/PENDING_SYNC/
  UNATTRIBUTED), `occurred_at`, `created_at`, plus `ads_context_data.raw_meta` holding
  every webhook-asserted identifier for audit/reconciliation.
- Minimum mandatory business facts (customer, Lead ID, phone verdict, campaign when
  known, submission timestamp) are always present for every submission.
- Campaign names are snapshotted from server-synced records only; `raw_meta` retains
  unverified webhook assertions separately from snapshots.

`private.meta_leadgen_events` gains `phone_match_status/is_duplicate_phone` so the
durable event carries the decision history as well.

## 5. Campaign resolution approach

- `fetchMetaLeadDetails` now requests the extended lead fields
  (`form_name, ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name`) in the
  SAME single Graph call used for field data — no extra round trip. If the page token
  is not entitled to those fields, ONE automatic 400-fallback degrades to the minimal
  field set, so a permission gap never destroys a valid lead; other failures (403/429/…)
  fail closed without pretending the minimal set must work.
- At intake, `record_lead_attribution_touchpoint` resolves identifiers ONLY from
  server-synced tenant records (`meta_ads → meta_campaigns (→ meta_ad_sets)`), never
  from webhook names:
  - ad identifier mapped → `ATTRIBUTED` with snapshots;
  - leadgen row with unresolved campaign → `PENDING_SYNC` (resolvable later, never a
    final verdict; identifiers preserved in `raw_meta`);
  - non-leadgen channels (Website UTM / Messenger referral) keep the explicit
    caller-declared `ATTRIBUTED`/`INFERRED` status.
- `retry_pending_lead_attribution(p_company, p_max)` (new, service_role-only,
  advisory-locked, bounded ≤1000/pass): resolves pending leadgen rows from the same
  tenant-synced evidence — `meta_ad_id` mapping → `ATTRIBUTED`, else asserted
  `campaign_id` corroborated by a synced campaign row → `INFERRED`. Campaign names are
  never invented; unresolvable rows stay pending for the next safe retry; customer
  first/latest projections are recomputed chronologically (oldest keeps first-touch).
- The cron route (`app/api/cron/meta-ads-sync`) calls the retry once per connected
  company after each asset sync (including when a sync partially fails — a previous
  partial sync may already have made campaigns resolvable) and reports
  `attribution_retries` in the response.
- What is deliberately NOT implemented: budgets, spend/insights-driven decisions,
  ad creation/editing, any Ads-Manager-like UI.

## 6. CRM UI changes

Customer profile page (`app/(dashboard)/customers/[id]/page.tsx`) gained the required
section **`Nguồn khách hàng & Lịch sử đăng ký`** using the existing design system:

- Status chip in the customer info card: `Đã có hồ sơ - Lead trùng số điện thoại`
  (warning) when any submission is duplicate-phone, else `Đã có hồ sơ - Lead mới`.
- Summary: total Meta lead submissions, distinct campaigns, first submission
  (date + campaign), latest submission (date + campaign).
- Chronological attribution history table (Date · Source · Campaign · Status) with row
  statuses `Lead đầu tiên` (first touch), `Lead trùng SĐT` (duplicate phone),
  `Lead mới - Chờ chiến dịch` (pending campaign), `Tương tác gần nhất` (non-leadgen
  latest touch), and ad/form/page details.
- History is ordered oldest→newest; tenant-scoped queries unchanged; no new dashboard.

## 7. Webhook and idempotency behavior

Lead Ads funnel per delivery (state machine in SQL, HTTP delivery idempotent):

1. Signature + verify-token validation (unchanged).
2. `claim_meta_leadgen_event` — per-lead row leased (`claim_token`, `lease_until`);
   duplicate delivery → `ALREADY_PROCESSED`; 8 concurrent claims → exactly 1 CLAIMED.
3. Lead detail fetch (§5) with permission-safe fallback.
4. `ingest_meta_leadgen_event` — inside the lease: creates the immutable
   `han_intake_events` checkpoint (payload-changes → `IDEMPOTENCY_CONFLICT`), runs
   `han_ingest` (Rule C dedup + interaction), persists interaction/customer AND the
   phone verdict; a retry after partial failure replays the persisted response without
   refetching Meta.
5. `record_lead_attribution_touchpoint` — idempotent per `meta_leadgen_id` (and per
   interaction for non-leadgen channels); the FIRST-touch vs LATEST-touch decision and
   customer projections update atomically in the same call; concurrent duplicate-phone
   submissions serialize on the per-customer row lock.
6. `mark_lead_attribution_phone_match` — persists the phone verdict on the attribution
   event (idempotent; forged status or another tenant's leadgen → fail closed).
7. `finalize_meta_leadgen_event('PROCESSED')` — only successful when genuinely
   complete; failures acknowledge FAILED and re-enter via lease expiry.

Database-level idempotency for Meta Lead IDs is therefore enforced by unique
`(company_id, leadgen_id)` + the checkpoint replay, not by application memory.

## 8. Tenant isolation and security

- Every SQL lookup (identity, contacts, campaigns, ads, retry loop) is scoped by
  `company_id`; the retry's tenant fence rejects foreign-tenant evidence (tested).
- New RPCs (`mark_lead_attribution_phone_match`, `retry_pending_lead_attribution`)
  and the redefined ones are `SECURITY DEFINER` with `EXECUTE` for `service_role`
  only (revoked from PUBLIC/anon/authenticated), matching the hardening posture of
  migrations 20261030110000/20261030120000.
- RLS/policies untouched; Messenger/Zalo/Website authorization rules untouched.
- Advisory locks: per-company intake lock (dedup), per-lead + per-customer attribution
  lock (idempotent inserts + projection updates), per-company retry lock (one bounded
  retry pass at a time).
- No phone digits, tokens, or campaign-report keys derived from webhook names appear in
  logs or attribution snapshots; review trail (`OMNICHANNEL_IDENTITY_REVIEW` audit) is
  written without exposing contact data.

## 9. Test scenarios and actual results

All executed locally against real SQL state machines (PGlite for the scenario matrix,
native PostgreSQL + the real webhook route for integration). Running suite:
`npm run test:meta-ads` → **43 pass, 0 fail** (21 attribution + remediation scenarios,
13 remediation, 8 duplicate-phone scenarios) and `npm run test:meta-ads:db` (native
Postgres: ownership/ACL/concurrency/retry) → 1 test block, all assertions pass.

| # | Scenario (spec §9) | Where | Result |
|---|---|---|---|
| 1 | New customer: 1 profile, 1 contact, 1 event, NEW_PHONE | `meta_ads_duplicate_phone_history.test.ts` TEST 1 + native route test | PASS |
| 2 | Same customer, different campaign: 1 profile, 2 events, both campaigns visible, 2nd marked duplicate (+ verdict replay keeps history exact) | TEST 2 + native Rule C block | PASS |
| 3 | Three campaigns: 1 profile, 3 events, 3 preserved campaign associations | TEST 3 | PASS |
| 4 | Duplicate webhook retry (same Lead ID): one event, no duplicate profile/history | native idempotency scenarios (claim concurrency, intake replay, ingest 409) | PASS |
| 5 | Same phone, different tenants: no cross-tenant matching | TEST 5 + native multi-tenant retry | PASS |
| 6 | Multiple owners with same phone: no auto-merge, manual resolution, submission preserved | TEST 6 (multi-owner state staged in disposable DB) | PASS |
| 7 | Invalid phone: no false match, fail-closed; missing phone: lead preserved | TEST 7 | PASS |
| 8 | Campaign lookup failure: lead created/linked, campaign pending, safe later retry (ATTRIBUTED via ad evidence / INFERRED via corroborated campaign) | TEST 8 + native two-phase retry (checked=13, resolved=1 pre-sync; resolved=4 post-sync) | PASS |
| 9 | Concurrent submissions: no duplicate customer, no lost events | native Postgres: parallel same-phone webhook deliveries + 8-way claim race | PASS |
| 10 | Existing channels regression: Messenger, Website, CRM authorization/RLS (+ Zalo suites) | TEST 10 Messenger/Website semantics upheld; Messenger ingestion shared-path `test:meta-messenger` 12/12; `test:omnichannel` 34/34; Zalo `test:zalo` 29/29 + hardening gate 11/11 | PASS |

Additional regression evidence run in this task: `test:omnichannel:db` ✔, 
`test:crm` 94/94 ✔, `test:customer-360` 39 ✔, `test:campaigns` 14 ✔,
`test:meta-deletion:db` 9 ✔, `test:idempotency:db` ✔ (DB1–DB3),
`test:zalo-recordings(+db)` ✔, staging readiness 13 ✔, migration-ledger/integrity ✔
(17/17, append-only honored), `npm run typecheck` ✔, `npm run lint` ✔ (tracked files),
`npm run build` ✔ (CI-equivalent env), `git diff --check` ✔.

## 10. Migration changes

One new forward-only migration, appended (append-only chain preserved):

`supabase/migrations/20261030130000_meta_ads_phone_duplicate_history.sql`

1. `lead_attribution_touchpoints` += `normalized_phone_match_status`, `is_duplicate_phone`
   + CHECK + partial index `idx_lead_attribution_pending` for the retry scanner.
2. `private.meta_leadgen_events` += `phone_match_status`, `is_duplicate_phone`.
3. `han_ingest` redefined: identical validation and Messenger/Website semantics; adds
   Rule C phone verdict computation for Lead Ads intake (reuses single-owner phone
   customer; ambiguous ownership → review; no arbitrary binding).
4. `ingest_meta_leadgen_event` redefined: persists/replays the phone verdict with the
   intake checkpoint; fail-closed when verdict missing.
5. `record_lead_attribution_touchpoint` redefined (same 29-param signature):
   leadgen unresolved campaign → `PENDING_SYNC`; evidence-based snapshots; restores
   explicit caller status for non-leadgen channels; ACL preserved (service_role only).
6. New `mark_lead_attribution_phone_match`, new `retry_pending_lead_attribution`
   (both service_role-only).
7. No DROP TABLE/FUNCTION, no CASCADE, no policy changes, none of the 95-migration
   pending chain executed, no migration repair, no fabricated history. Evidence
   catalogs under `docs/evidence/meta-ads-staging/` untouched (appended files become
   `pending` in the ledger by design).

## 11. Remaining Meta permission blockers

- **Extended lead fields entitlement:** the single-call extended field fetch is expected
  to work with a page token that already reads leads (`leads_retrieval`); if a specific
  app review does not grant `ads_read`, the Graph call can still 400 on those fields —
  handled by the one-step fallback: attribution lands `PENDING_SYNC` until asset sync
  fills it. No work is lost either way, but full instant attribution requires the
  extended fields (or a later asset sync).
- **Marketing API asset sync** (`ads_read`) drives the retry evidence; without it,
  campaigns stay pending rather than fabricated. The webhook path continues to work for
  customer/interaction creation.
- No assumption is made about `ads_management`, `business_management`, or
  `pages_manage_ads`; none are requested anywhere in the flow.

## 12. Deployment and validation instructions

- **This change has NOT been applied to any remote environment.** Applying remains a
  deliberate, separate operator action (staging first), using the standard forward-only
  chain: staging reproduces the pinned prefix `…s operations_p0_hardening` and then the
  appended `2026103013xxxx` file; `supabase/migrations` order is validated by the
  migration-ledger/integrity suites.
- Validate in staging (no destructive ops): `supabase db reset` is NOT to be run against
  staging; use the approved staged apply. After apply, verify:
  1. `SELECT normalized_phone_match_status, is_duplicate_phone FROM
     lead_attribution_touchpoints LIMIT 1;` (columns exist, NULL-safe for old rows);
  2. connect a Lead Ads page and submit a test lead: one profile per new phone,
     duplicate phone reuses profile; a repeated webhook delivery creates exactly one
     event per Lead ID;
  3. cron `GET/POST /api/cron/meta-ads-sync` returns `attribution_retries` and pending
     campaigns resolve after an asset sync with `ads_read`.
- Rollback posture: columns are additive and NULL-tolerant; the legacy behavior
  corresponds to treating `PENDING_SYNC` as unresolved — no destructive reversal
  required; however the standard rule is forward-only.
- Ops configuration: cron secret (`CRON_SECRET`), page bindings, and token vault are
  unchanged; the retry RPC is callable only by `service_role`.
