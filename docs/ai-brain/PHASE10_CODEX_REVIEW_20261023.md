# Phase 10 production acceptance: Codex working review

Status: **IN PROGRESS; Phase 10 is not PASS. Phase 11 has not started.**

## Baseline and isolation

- `origin/main`: `79282c18c3fc552ad53a7ba779ba332dce469ee8`.
- Branch: `fix/ai-messenger-live-production`.
- Worktree: `/Users/hoangthuy/ai-crm-worktrees/ai-messenger-live-production`.
- Original workspace has pre-existing uncommitted changes; they were preserved.
- Baseline exact-SHA Verify run: https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/actions/runs/39895206150 (success). This does not validate the new uncommitted changes.
- Production CRM deploy `dep-dbdd90lg1s2s73b3g4j0` and Javis Brain deploy `dep-dbdd947b9u1s7399sd3g` were LIVE on the baseline SHA.

## Production evidence collected

- Supabase project: `yrauljxzyklhisxijeim`.
- Messenger scheduler was absent: cron jobs contained only transcription and AI live Zalo.
- Messenger was OFF. Codex saved OFF through `/admin/ai` and verified the persisted setting: company `de6a7bf3-b5bc-418d-92d6-f9b241472598`, `MESSENGER`, `enabled=false`, `min_confidence=0.850`, updated at `2026-10-23T04:08:01.670Z`.
- The active server-owned `META_PAGE_BINDINGS` binds Page `1026991374010112` to that company. This takes precedence over the legacy Page variable.
- Graph subscribed-apps read confirmed app `1780871206505449` and the `messages`, `messaging_postbacks`, `message_deliveries`, `message_reads` fields. Graph Page metadata reads returned code 100 / insufficient metadata permissions; this is not proof of send failure.
- Existing Chrome identity was HoàngAnh Ngô, without changing accounts. Its visible chat history matched the CRM conversation and historical message text.
- Controlled conversation: `d4a598d6-e6de-4537-a864-0bf9267b8af1`; customer: `9ea82bb0-50ca-41ab-8799-37a4d34631f8`; exact external conversation ID: `1026991374010112:28295165726821983`.
- One real `Xin chào` was sent through Facebook UI at approximately 11:08 ICT. Meta webhook logs recorded `signature=valid` and `processed=true` at `2026-10-23T04:08:18–19Z`.
- Inbound interaction: `d158750c-1806-4c24-a75d-6c2f8c5e1312`; sanitization SUCCEEDED; direction INBOUND; actor CUSTOMER.
- Meta external ref: `1026991374010112:m_UXagt0cRw1KlY6kR1DrBUoXkhmnO1q-o5wsmGGDqkEm1K-63s5fcUb3Zyy1URM7XUspDdyGNQGloBDTWGnR-VQ`.
- At `2026-10-23T04:10:00Z`: exactly one such inbound, zero Messenger deliveries, zero new AI outbound in the controlled conversation. This verifies inbound and OFF behavior, not live E2E.
- Javis Brain production has `JAVIS_RUNTIME_BASE_URL=https://javis-runtime-probe.onrender.com` and a configured runtime credential; no credential value was exposed.
- Zalo job 2 remained active every minute; the observed 04:11 UTC tick succeeded, correlated request 645 returned HTTP 200 with no timeout/error.
- Production company knowledge and customer memory tables were empty; grounding quality must not be claimed from fabricated production data.
- No production migration, live enablement, manual Messenger cron invocation, new deployment, commit, push, merge, or PR has been performed in this task so far.

## Review findings awaiting correction / final verification

The following findings concern the current implementation draft and must be rechecked after the owners finish:

1. The scheduler migration and scheduler-health migration currently share version `20261023170000`. Assign unique chronological versions before clean migration validation.
2. PostgreSQL transaction validation of the scheduler-enabled branch failed with `syntax error at or near IF`: the dynamic SQL contains bare PL/pgSQL `IF`/`PERFORM` outside a DO/function block. Fix and test the actual extension-enabled branch, not only the skipped PGlite branch.
3. Scheduler helper still has a hard-coded production URL fallback despite the requested server-owned Vault endpoint. Remove it and fail closed on missing secure endpoint; keep endpoint derivation from existing Vault entries.
4. Messenger transport draft fails open when delivery lookup errors/misses and does not require a valid active, unexpired claim token/status. A read/check followed by network send is insufficient crash/reclaim protection.
5. Add an atomic, durable Messenger dispatch-start fence before the provider call, binding company, customer, conversation, source, active lease, Page/canary, current settings/confidence, ownership and 24-hour window. Once dispatch may have started, stale reclaim/uncertain outcome must never automatically send again. Preserve Zalo behavior and real attempt counts.
6. Provider success plus outbound persistence error must remain explicit and non-retryable with provider ID preserved; the draft currently reports SENT with an error while the timeline record may be absent.
7. `record_ai_messenger_live_outbound` needs trusted scope/lease/delivery binding and idempotence per delivery/source, including concurrent calls and retries. Do not permit an unrelated external ref to create a second outbound for the same delivery.
8. Sanitize handover/persistence failure logging to constant error codes; do not log arbitrary raw exceptions/provider details.
9. Scheduler health RPC currently grants authenticated global access and adds an unnecessary alias. Prefer the single service-role-only server API; no direct private schema access.
10. Scheduler health must inspect job presence/active/cadence and completed HTTP status, not treat a pending/null response or missing timestamps as healthy. Count consecutive failures per channel, with unknown distinct from a numeric failure count.
11. Monitoring still estimates Brain latency from delivery creation/completion, which includes queue wait. Persist actual Brain latency or label the metric accurately; required Brain latency must be available independently.
12. Delivery/pending/inbound query errors must not silently display zero; Control Center fallback errors also need explicit unknown/error state.
13. Main Phase 6/8/9 SECURITY DEFINER mutations granted to authenticated need real tenant authorization or service-role-only ACLs. Examples: emergency disable, handover create/claim/resolve/resume, monitoring record/ack/resolve. New independent security task owns the additive fix and real JWT regression tests.
14. Strict canary row should bind `(company_id, conversation_id)` through the existing composite conversation key, validate the Page identifier, and keep privileged configuration appropriately restricted. No hard-coded tenant/identity data in code/migrations.
15. The correction draft adds a defaulted ninth latency argument to `finish_ai_brain_live_delivery` while retaining its original eight-argument overload. Native PostgreSQL transaction validation reproduced `function ... is not unique` for the existing eight-argument caller (log: `messenger-migration-backward-compatibility.log`). Preserve the old signature without an ambiguous overload, e.g. a separately named fenced latency recorder or a new differently named extended finish RPC plus original compatibility wrapper. Existing deployed Zalo callers must continue working before/after migration and deployment.
16. Dispatch-start guard currently permits null turn confidence and reads settings/conversation/canary without row locks. Require finite confidence in [0,1], validate the bound source interaction and strict numeric `Page:PSID` shape, reject future/out-of-window inbound timestamps, and serialize the authorization point with settings/conversation/canary mutations. Never use an optional confidence value to bypass the current threshold.
17. Persist one consistent provider-message-ID representation. The record RPC currently stores a full `meta:Page:MID` ref while finish overwrites it with raw MID; a retry/reconciliation can then reject its own existing record as a different ref. Store the timeline external ref separately or derive/validate it consistently, bind the outbound interaction ID, and assert idempotent re-recording after finish as well as before finish.
18. The completed monitoring correction still permits HEALTHY when `job_exists` / `job_active` are null (and even when a legacy array result has no job metadata), provided a recent dispatch is present. Require positive verified job presence, active state, expected cadence and available view; unknown metadata must remain DEGRADED. Also fix the trailing blank-line `git diff --check` failure in `monitoring-db.test.ts`.
19. The partially delivered `live-messenger-supabase.test.ts` lacks a fail-closed local-URL guard before creating mutation-capable clients, and its scheduler test duplicates hundreds of lines of helper SQL instead of executing the actual migration file. Do not run it with arbitrary environment credentials. Add the localhost/127.0.0.1 guard first; replace the duplicated setup SQL with the actual migration file read inside a rolled-back native PostgreSQL transaction; cover legacy eight-argument calls and integrate this file into CI. The first test's claim to cover the actual migration branch is not yet supported by its implementation.
20. Monitoring metrics independently reimplement scheduler status and currently accept recent pending/null HTTP responses, stale runs, unknown job metadata, missing views/extensions and wrong cadence as HEALTHY. Use one verified interpretation in health and metrics. Preserve per-channel evidence so an ALL aggregate cannot attribute Messenger's failure streak to Zalo. Pending/unknown responses must not bridge two failures into a fabricated consecutive streak. Per-channel alert queries must check returned errors instead of treating failed reads as empty success. Control Center must visibly show settings-query errors; per-channel counts drawn from the global last-100 sample must retain that sample limitation even when a particular channel has fewer than 100 rows.
21. Recheck the completed dispatch-start correction for authorization-time freshness after blocking row locks. A `clock_timestamp()` captured at function entry becomes stale while waiting on settings/conversation/canary locks. Revalidate lease age and source 24h/future bounds against the actual authorization point immediately before setting the marker. The source query must also validate `type=MESSAGE` and `sanitization_status=SUCCEEDED`, not only text/direction/channel. A native lock-wait test can use a lease just below expiry and a brief competing lock; it must deny after expiry.
22. Recheck the completed outbound recorder correction for strict canonical Page/ref binding, dispatch authorization, and existing-interaction scope. An in-progress draft accepts raw refs and can reuse any same-company FACEBOOK interaction with a matching ref, including another conversation/customer/direction/actor. It also treats the same raw MID under a different Page prefix as equivalent. Require the exact conversation Page and canonical timeline ref, validate bound/existing outbound interaction scope and AI actor, require an authorized durable dispatch, and reject conflicting refs/IDs. Add negative tests alongside before/after-finish idempotence. Keep lock ordering consistent with dispatch (delivery before conversation): two recorder calls that both take conversation FOR SHARE and then contend on delivery can deadlock when the winner later updates that conversation. Verify deterministic concurrent behavior, not only a lucky Promise.all run. Do not infer final status from this in-progress observation.
23. Remove production Page/PSID literals from Messenger test fixtures; use clearly synthetic numeric identities and generic message content. The new native test currently copies the real acceptance identity and a business-specific product/brand into local fixtures. Also remove its committed `/tmp/messenger-local-supabase-status.json` auto-reader: local credentials must be injected by the orchestrator's process environment, not implicitly selected by test source. Native PostgreSQL independently confirmed that `has_function_privilege('public', ...)` supports the PUBLIC pseudo-grantee; the initial concern about that expression was withdrawn.
24. Recheck the shared scheduler interpreter's completed correction for unknown HTTP flags and wrong-channel metadata. Independent runtime probing of the in-progress version returned HEALTHY for `status_code=200, has_error=null, timed_out=null`, and for a `channel=ZALO` metadata object interpreted as MESSENGER. Require verified false error/timeout flags and the requested channel before declaring HEALTHY; add tests. These are supplemental observations while the owner is still editing.
25. Independent resumed typecheck failed: `ai-control.ts:289` assigns a no-customer-join response to the inferred joined-response type; `metrics.ts` mutates readonly `MetricQueryErrors` properties; tenant RPC tests at lines 257/680 pass a result-array type into Supabase RPC's function-name generic. Correct the types without `any`/suppression or weakened assertions. Log: `/tmp/messenger-phase10-evidence/typecheck-resumed.log`. Resumed lint had 0 errors / 17 warnings; four newly unused monitoring imports should be removed (`SchedulerHealthRpcResult` in health, and `SchedulerDispatchRun`, `SchedulerHealthRpcResult`, `calculateSchedulerFailureStats` in metrics).
26. Alert evaluation degradation is not wired into the real dashboard: `getAiMonitoringDashboardDataInternal` discards `alertsResult.status/queryErrors`, while the evaluator invents `candidate-*` alert IDs if persisted alerts cannot be read. Propagate explicit alert-read/evaluation error state to UI, preserve only genuinely known persisted prior alerts, and do not show an empty clean state or actionable invented records on failure. Also surface alert-persistence RPC and handover-count errors as degraded evaluation. Existing tests that only provide `existingAlerts` to the evaluator do not exercise the real dashboard path.

## Resource recovery at 2026-10-23 12:12 ICT

- User freed storage again: 5.4 GiB initially available; Docker API and existing local stack are healthy. No Docker data or volumes were deleted.
- Antigravity IDE was reopened and its MCP connection recovered. Bounded correction job `agy-8b25b067` (Gemini 3.8 Flash High) owns findings 15, 16, 17 and 19. Heavy tests remain sequential on this 8 GiB machine. A second isolated monitoring-only correction runs without DB tests or full builds.
- Independent strengthened tenant RPC suite passed all 17 tests on local Supabase (real JWTs and native ACL checks); log `/tmp/messenger-phase10-evidence/tenant-security-17-independent.log`.
- Independent resumed checks passed: Javis Brain tests, Javis Brain build, Meta Messenger unit tests and Omnichannel unit tests. Logs: `/tmp/messenger-phase10-evidence/*-resumed.log`.
- Monitoring correction: Sonnet `agy-e4bcb3d4` failed immediately; application log confirms individual quota exhausted (HTTP 429), without changing billing. Fallback Gemini Flash High job `agy-bde8bc7e` owns findings 18 and 20.
- Origin main remains `79282c18c3fc552ad53a7ba779ba332dce469ee8` after fetch.
- Production read-only check at `2026-10-23T05:12:06Z`: Messenger jobs 0, intended Messenger setting OFF, controlled AI outbound 0, Zalo job 2 active every minute. Zalo dispatches 704 and 705 at 05:10/05:11 UTC returned HTTP 200 without timeout/error.
- Chrome page control and handoff retention recovered: new Control Center tab 1821097851 shows Messenger OFF / min confidence 0.850 and Zalo LIVE / 0.800; exact Page tab 1821097854 exposes Page ID 1026991374010112 in its visible links. Both tabs initially retained successfully and then deliberately closed to reduce memory pressure; reopen on the same Chrome profile for acceptance. No fresh test message sent; recipient-receipt acceptance remains pending.
- Independent runtime reproduction confirmed finding 20: unknown cron metadata returned HEALTHY; a pending/null HTTP response returned HEALTHY / AVAILABLE in metrics; `[failure, unknown, failure]` returned consecutiveFailures=2. These are rejected acceptance results, not passing checks.

## Resource checkpoint at 2026-10-23 11:46 ICT

The user freed some storage and Docker was successfully recovered without deleting volumes. Subsequent system storage fell again to about 289–318 MiB free; swap usage was approximately 13 GiB on an 8 GiB machine. Antigravity began repeated trajectory timeouts. Heavy work was stopped and pending/active jobs were cancelled to preserve the worktree while additional free space was requested. Do not restart heavy tests until adequate space is available.

A subsequent CUA attempt to retain the Control Center/Messenger tabs failed with: `Please update the ChatGPT extension in Google Chrome to the latest version to continue.` Browser handoff retention was therefore not verified. The saved screenshots remain available under `/tmp/messenger-phase10-evidence/`; future recipient-receipt acceptance requires restoring Chrome extension access.

Agent state:

- `agy-318f28d0`: completed Brain contract correction; independent final checks still required.
- `agy-6ed51ea9`: completed initial scheduler/canary draft; Codex rejected safety/compatibility gaps.
- `agy-bd166bd8`: correction partially written, cancelled during resource failure; owns migration 17, engine/transport and Messenger tests. Resume from real diff and findings 15–17, not from a claimed completed report.
- `agy-2a11f1ce` and `agy-8eaf4eda`: monitoring drafts/corrections completed; finding 18 remains and final gates are pending.
- `agy-2d98beef` and `agy-a937c1d3`: tenant RPC ACL fix and strengthening completed. Reported 17 real JWT/native ACL tests pass; parent independently verified the earlier 15-test version and the local `authenticated=false` / `service_role=true` privilege result.
- `agy-f0e99176`: independent persistent native scheduler/legacy-compatibility test task cancelled during resource failure. The partially delivered `tests/ai-brain/live-messenger-supabase.test.ts` now exists from the delivery owner; repair and integrate that coverage per finding 19 rather than duplicating another suite. Do not replace native coverage with PGlite-only tests.
- Early Claude Opus/Sonnet jobs failed immediately; Gemini Flash was the available fallback.

Latest production recheck at `2026-10-23T04:46:03Z`:

- Messenger cron jobs: **0**.
- Messenger setting: **OFF**, min confidence 0.85 for the intended company.
- Controlled test conversation: **0 AI outbound** since the initial real inbound.
- Zalo scheduler: active; correlated 04:46 UTC dispatch request 680 returned **HTTP 200**, no timeout/error.

Required checkpoint fields:

```text
CURRENT MAIN SHA: 79282c18c3fc552ad53a7ba779ba332dce469ee8
CURRENT PHASE: 10, production acceptance incomplete
BRANCH: fix/ai-messenger-live-production
PR: none
CI: baseline exact-SHA success only; new code uncommitted/unverified
PRODUCTION MIGRATION: none applied in this task
MESSENGER CRON: absent
MESSENGER CANARY: OFF
REAL INBOUND: PASS via Meta while OFF; interaction d158750c-1806-4c24-a75d-6c2f8c5e1312
JAVIS DECISION: not executed for a live Messenger turn
REAL OUTBOUND: not executed
RECIPIENT RECEIVED: not demonstrated
HANDOVER: local DB tests passed; real acceptance pending
HUMAN OWNERSHIP: local tests only; real acceptance pending
KILL SWITCH: OFF persisted and zero reply observed; live/pre-send acceptance pending
IDEMPOTENCY: live send / next natural tick pending
MONITORING: correction draft exists; remaining review finding and final verification pending
CONTROL CENTER: production OFF persistence verified; new UI not deployed
ZALO REGRESSION: production scheduler active and HTTP200 at latest recheck
PHASE 10 RESULT: BLOCKED by local resources; implementation and acceptance remain incomplete
PHASE 11 STATUS: not started
BLOCKER: critically low local storage and Antigravity timeouts; Chrome ChatGPT extension also requires update; code corrections remain required
NEXT EXACT ACTION: recover adequate disk space; resume only bounded correction tasks for findings15–19 and native tests; then clean local migration/full gates, exact-head CI, dependency-safe rollout and real natural-cron acceptance
```

## Validation evidence (interim)

Logs and screenshots: `/tmp/messenger-phase10-evidence/`.

- Baseline AI Brain: 262 tests passed; Javis Brain: 72 passed; Javis build passed.
- Meta Messenger: 11 passed; Omnichannel unit: 6 passed; Zalo PGlite: 32 passed; Operations unit: 9 passed; Survey unit: 23 passed; Voice business PGlite passed.
- After recovering Docker, baseline local Supabase suites passed: auth, security, handover, grounding, Control Center, monitoring, shadow, memory, Operations, Survey, Voice, Zalo integration, Omnichannel integration, recording/native concurrency, Meta deletion, inbox idempotency.
- Zalo live DB first default-off test failed against reused fixtures (a previous enabled settings row persisted). Re-run on a clean local test DB before final acceptance; do not dismiss a remaining failure.
- A transient contract-test TypeScript error was corrected by its implementation owner; independently rerun final typecheck.
- Parent's first application build failed because local Supabase build environment variables were absent; rerun with local test environment, never production credentials.
- Lint at the earlier draft had zero errors and 13 existing warnings; rerun after all corrections.
- New code, migrations, final DB suites, build, and exact-head CI are not yet accepted.

## Remaining production acceptance

After code review and all gates: apply additive migrations with Messenger OFF, verify private ACLs and one secure scheduler, merge only green exact-head CI, verify required service deployments, configure only the verified conversation canary, then perform fresh real inbound → natural cron → Javis → Meta reply and recipient receipt. Follow with natural-tick idempotency/echo checks, real handover and human-ownership zero-send, kill switch, Control Center, monitoring, and read-only Zalo regression. Do not call the Messenger cron manually or synthesize DB inbound to replace acceptance.


## Independent validation checkpoint at 2026-10-23 13:35 ICT

- Exact current additive SQL 17/18/19 was reapplied atomically to LOCAL Supabase only. No local database or volume reset occurred. Prior test-owned queue fixtures were marked SKIPPED with LOCAL_FIXTURE_RESET, preserving rows; production and non-test data were not targeted.
- Native Messenger: all 3 tests independently pass after isolating owned fixtures, including real extension-enabled migration, legacy eight-argument compatibility, canonical Page/ref guards, authorized dispatch, concurrent outbound idempotence and expiry during a two-second competing lock. Non-local URL guard was independently verified before clients/mutations.
- All 18 sequential DB/business suites in `/tmp/messenger-phase10-evidence/db-final-results.json` passed: memory, shadow, live Zalo, Messenger PGlite, handover, grounding, Control Center, monitoring, tenant RPC security, Zalo, recordings/concurrency, inbox idempotency, Meta deletion, omnichannel, Operations, Survey, Voice and Voice business.
- Actual migration17 was independently applied TWICE inside a native pg_cron/pg_net-enabled transaction: exactly one active every-minute Messenger job with the secret-free helper command; all other cron rows unchanged; complete ROLLBACK. Log: `scheduler-final-double-apply.log`.
- Typecheck independently passes after the partial monitoring correction. One new dashboard contract test still fails due its incomplete query-chain mock. Full AI Brain/integration/build gates and exact-head CI remain pending.
- Local security advisors: one existing ERROR (public.safe_staff_directory SECURITY DEFINER view) and 20 existing WARN items; no new Phase10-related advisor item. This is not a clean-advisor claim or authorization to alter frozen/unrelated schema.
- Monitoring jobs agy-815a7713 and agy-34536f02 failed during local Google DNS/routing outages. Fresh DNS and HTTPS read checks now succeed. Bounded resume job agy-51dd7024 owns only final mock, server-input alert-cache boundary, local stale-alert rendering and unused-import cleanup. Earlier native correction agy-5f018f34 completed and its critical guards were independently verified.
- No commit, push, PR, production migration, merge or deploy has occurred. Phase10 remains IN_PROGRESS; Phase11 not started. Production Messenger remains OFF at the latest verified production check; fresh production verification is still required before rollout.
