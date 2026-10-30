# Meta Ads staging: pre-destructive remediation and migration readiness

Date: 2026-10-30. Branch: `meta_ads_integration`. Audit source:
`48aab3388f69ecd9dd0f8da5546dfb8e25752e22`. [PR #139](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/pull/139) remains unmerged.
Target for read-only observations: Supabase `qmhfmgkymjgoevwmkidm`,
`ai-crm-meta-staging`. This report does not authorize a migration, backup,
deployment, retirement, scheduler change or cutover.

## A. Executive summary

**Overall readiness: READY AFTER OWNER DECISIONS.** This means the preparation
is ready for specific owner decisions; migration execution remains blocked.

Resolved in application code: SURVEY signing now reads the canonical
`{slot, objectPath, ...}` photo metadata emitted by the survey RPC, while retaining
historical string references. All four accepted categories remain supported.
Invalid selectors, inherited category names, malformed object keys and references
outside the resource's database-derived tenant are rejected before signing.
Existing role, assignment, AAL2, bucket and TTL requirements remain in force.

Proven locally: the original QC RPC works while its original dependencies exist;
native PostgreSQL ledger concurrency/rollback/retry guards work on synthetic
migrations; an authenticated encrypted dump restores 17 synthetic tables with
matching counts/hashes and working authorization, QC and four-category retrieval.
No production or staging data entered these fixtures.

Remaining decisions: QC domain preservation versus retirement, historical file
access/retention, outside-consumer attestations, backup custody and recovery
objectives, and a separately reviewed live ledger/execution strategy. No new
migration SQL was added and none of the 158 pending destructive items was approved.
The prior dependency audit and all its evidence were preserved byte-for-byte.

Staging still has 21 application-time history entries and 95 pending canonical
files. All 21 stored SQL hashes match the current corresponding source bytes;
this supports reconciliation but does not certify current data or execution of
later files. The final public/private catalog fingerprint matches the captured
21-file prefix. All staging calls in this task were read-only.

Evidence: [ledger plan](evidence/meta-ads-pre-destructive/ledger-readiness-plan.json),
[stored hashes](evidence/meta-ads-pre-destructive/staging-history-hashes.json),
[final catalog](evidence/meta-ads-pre-destructive/staging-catalog-final.json),
[synthetic rehearsal](evidence/meta-ads-pre-destructive/synthetic-rehearsal.json),
[local validation](evidence/meta-ads-pre-destructive/validation-results.json).

Local checks passed: TypeScript, build, Meta Ads 34/34, Omnichannel 34/34,
Meta Ads native DB 1/1, migration ledger/security 4/4, new readiness 13/13,
Omnichannel native SQL assertions, CRM scripts (final suite 94/94), and RPC-only
ACL tests. Lint passed with 18 existing warnings after excluding only the prior
untracked audit scanner, whose four pre-existing CommonJS style errors were left
untouched. The scanner is outside this commit; CI runs normal lint without an
exclusion. Verify now runs `npm run test:staging-readiness` after its disposable
database reset. Current-head CI is available in [PR checks](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/pull/139/checks).

## B. QC RPC

Dependency graph, from `20260928000001_operations_p0_hardening.sql`:

```text
service_role → record_quality_check_atomic(company, production_order, result, actor, notes)
  → operations_actor → active user profile + active company membership + BOSS_ADMIN
  → production_orders (tenant-scoped lock; QC_IN_PROGRESS required)
  → orders (tenant-scoped production/install state transition)
  → operations_audit → audit_logs (RECORD_QUALITY_CHECK)
```

The pending legacy cleanup removes both tables and both helpers but omits this
RPC from its 33-name function removal list. PL/pgSQL body references do not supply
a safe dependency barrier: the full canonical local replay retains a callable
service-role function whose body cannot resolve those dependencies. A successful
migration replay therefore does not resolve this API inconsistency.

Repository investigation covered literal references, generic/dynamic `.rpc(...)`
wrappers, server actions, API routes, workers, scripts and UI workflows. No current
runtime TS/JS caller of this QC name or QC UI was found. Source references remain
in historical SQL and documentation; new tests deliberately call it. Generic RPC
wrappers exist and cannot prove absence of outside consumers. Previous staging
counts show orders/production_orders empty in that observation only. Audit
retention outside these tables, backups and third-party records is unknown.
No historical customer/audit payload was retrieved.

| Consumer | Evidence | Owner | Status |
| --- | --- | --- | --- |
| Trusted service-role QC client | RPC is present and executable; original contract tested | Operations owner + integration owner, named person required | REQUIRES OWNER ATTESTATION |
| Current CRM QC UI | No call site in current tracked runtime sources | CRM application owner | UNKNOWN (negative source search alone is insufficient) |
| Outside RPC callers and retained QC reports | Limited logs, no full function-call tracking | Staging/integration owner | UNKNOWN |

Selected implementation scope: preserve the existing contract and test it; do
not modify QC business semantics or issue a retirement migration. QC cleanup is
held pending the following individually reviewable choice:

| Alternative | Concrete design | Required decision/evidence |
| --- | --- | --- |
| A — preserve functionality | Keep orders, production orders, actor/audit helpers, audit evidence and their FK/trigger/RLS dependencies through cleanup; design replacement QC entities and state transitions before moving to the surviving domain | Operations owner confirms QC remains a workflow, defines which surviving entities represent production and dispatch/install, retention and reporting obligations; DB owner reviews dependency closure |
| B — retire API | Future migration replaces this exact signature with a deterministic explicit `FEATURE_RETIRED` error (proposed SQLSTATE `P0001`, stable message `QUALITY_CHECK_RETIRED`), retaining service-role-only ACL; no body reference to removed objects; retain historical audit archive | Operations and integration owners attest no active caller, approve retention and error contract; test old callers receive that error and no success/empty response |
| C — versioned transition | Add `record_quality_check_v2_atomic` only after replacement-domain semantics are approved; keep v1 and required data/helpers during a defined deprecation window; adapt v1 only where semantics are equivalent | Owner supplies field/state mapping, migration/backfill validation, consumer rollout list, dates and rollback criteria; test parity, tenant isolation and both signatures |

There is no unambiguous mapping from legacy production QC to the surviving CRM
domain. Merely forwarding to another CRM RPC would invent business behavior.
None of A/B/C is authorized for live execution by this report.

Regression proof executes the original CREATE FUNCTION source bytes for QC and
its two helpers against synthetic native PG tables. PASSED produces
READY_FOR_DISPATCH / READY_FOR_INSTALL; REWORK_REQUIRED and REJECTED produce
QC_FAILED while the order remains IN_PRODUCTION. All three audit once.
Anon/authenticated EXECUTE, SALE actor, cross-tenant actor/order, invalid result
and repeat after state transition fail. These are contract tests on a retained
dependency fixture, not proof that the post-cleanup orphan is fixed. Full-chain
replay is tested separately and remains subject to this compatibility hold.

## C. Signed URL compatibility

The browser-facing `app/actions/sensitive.ts` delegates through
`lib/sensitive/action-handlers.ts` to `createAuthorizedSignedUrl`. The accepted
request contract is in `shared/contracts/sensitive.ts`; only a resource ID and
constrained selectors are accepted, never a caller-supplied path, tenant or TTL.
Current UI `CallHistoryTable.tsx` uses RECORDING; other accepted categories remain
part of the server action contract regardless of current UI usage.

| Category / selector | Canonical reference and bucket | Authorization | TTL seconds |
| --- | --- | --- | ---: |
| SURVEY; photoIndex defaults to 0 | surveys.photos strings or metadata.objectPath → survey-photos | BOSS_ADMIN, SALE, or currently assigned TECHNICIAN | 3600 |
| CONTRACT; generated default / signed | contracts.generated_file_ref / signed_file_ref → contracts | BOSS_ADMIN or SALE | 1800 |
| INSTALLATION; photo + index / handover | installations.photos / handover_ref → installation-docs | BOSS_ADMIN, SALE, or currently assigned TECHNICIAN | 3600 |
| RECORDING | calls.recording_ref → call-recordings | BOSS_ADMIN, production AAL2 | 900 |

All paths derive company from the resource row and verify active profile and
membership. Production BOSS_ADMIN requests across the categories require AAL2.
Technicians must match the parent appointment assignee and its active status
(ASSIGNED, ACCEPTED or IN_PROGRESS). The existing helpers perform minimal
metadata lookup before fetching protected references. No role or RLS was widened.

Compatibility choice for this patch: **preserve all four categories**. Survey
metadata and old strings both work. Tenant-prefixed historical object keys remain
accepted; RECORDING additionally retains `call-recordings/<company>/...` and
`voice/<company>/...` forms allowed by the attachment RPC. Absolute URLs, leading
slashes, control characters, backslashes, empty/dot segments and foreign tenant
prefixes fail with `SIGNED_URL_UNAVAILABLE`. Missing rows/files fail explicitly;
they never produce a successful empty response. TTL remains server-controlled.

Preserving these categories after table cleanup requires approved retention of
their resource/authorization dependencies, or a replacement file-access index
with the same company, roles and assignment lifecycle. That index needs an
owner-approved history/backfill model; this patch does not invent one.
Controlled retirement is a separate option: an explicit documented
`CATEGORY_RETIRED` action error for each approved category, compatibility window,
retention/download path and caller migration tests. No category is retired here;
RECORDING must continue independently.

Tests cover authorized bytes for four categories, contract variants, installation
handover, metadata/string survey references, all-category unauthenticated,
cross-tenant, missing resource and BOSS/AAL1 rejection; forbidden roles, inactive
profile/assignment and wrong assignee; invalid selectors/category/path, tampered
URL and expiry. Authorization runs the actual application code and native PG
roles/RLS. The REST transport and HMAC Storage HTTP signer are synthetic test
adapters; expiry is checked with a fixture clock. This is not live Supabase
Storage/JWT/provider acceptance. That isolated staging acceptance remains a later
owner-authorized gate, including existing reference sampling and file retention.

## D. External consumers and evidence gaps

User confirmed Render workspace My Workspace (`tea-db27ttjtqb8s73cdhrj0`).
Read-only workspace metadata showed six services; only ai-crm-meta-staging tracks
this branch. No dedicated staging background worker or cron service was listed.
Other services track main or another repository; their individual configuration,
logs and environment were not accessed. No secret values were requested.

| Consumer | API/table/function | Evidence | Owner | Status |
| --- | --- | --- | --- | --- |
| Internal CRM staging web | Shared server actions / RPCs / calls | Render web service live, branch metadata and source entry points | CRM staging owner | VERIFIED ACTIVE (service/capability; per-category traffic unknown) |
| Internal recording UI | Signed URL RECORDING | Current UI invokes shared action | CRM application owner | VERIFIED ACTIVE (code path; no claim of observed real download) |
| Legacy signed URL callers | SURVEY / CONTRACT / INSTALLATION | Accepted shared contract; current UI search does not find callers | Operations/document owner | REQUIRES OWNER ATTESTATION |
| QC service-role client | record_quality_check_atomic | Present RPC, no source runtime call; limited telemetry | Operations/integration owner | REQUIRES OWNER ATTESTATION |
| Supabase deployed Edge Functions | Any QC/file/legacy reference | Deployment list empty for this staging project | Staging platform owner | VERIFIED UNUSED within this deployed-function inventory only |
| Supabase pg_cron/pg_net | Scheduler jobs / HTTP dispatch | cron.job absent; both extensions not installed | Staging platform owner | VERIFIED UNUSED within current DB extension/job inventory only |
| Render staging worker/cron | Legacy APIs and scheduled endpoints | No dedicated service in the confirmed workspace list; web apps may schedule internally | Staging platform owner | UNKNOWN |
| HTTP cron callers | app/api/cron/* incl. Meta Ads, voice, campaigns, Messenger/Zalo AI | Routes exist; no externally configured schedule inventory available | Integrations owner | UNKNOWN |
| Webhook senders | Meta, Botcake, Zalo, voice, OpenAI realtime | Source routes exist; no provider dashboard bindings inspected | Channel owners | UNKNOWN |
| Outside PostgREST/scripts/automation | QC RPC, legacy tables, shared actions | Generic RPC mechanisms and operational scripts; no organization-wide client registry | Integration owner | UNKNOWN |

The VERIFIED UNUSED entries describe narrowly inspected platform inventories,
not business retirement evidence. No external organization-wide consumer is
declared unused. [Telemetry summary](evidence/meta-ads-pre-destructive/telemetry-summary.json):
2026-10-29 10:42Z through 2026-10-30 10:42Z has 6 edge, 98 Postgres and 154
PostgREST log events; aggregate QC/resolver matches were zero. PostgREST records
lack individual RPC request paths, function statistics are unavailable because
`track_functions=none`, and log retention/traffic coverage is incomplete. Render
request query for `/api/*` and `/` in 00:00–10:45Z returned zero entries. These
observations cannot establish inactivity or account for infrequent clients.

Owner checks required before retiring a dependency:

1. Platform owner inventories Render web/worker/cron/one-off jobs, linked env
   groups by variable name only, external schedulers and staging project bindings;
   record service/job owner, endpoint/function and last run, with values redacted.
2. Channel owners inspect Meta/Botcake/Zalo/voice webhook destinations and
   third-party automation workflows, including paused/error/retry/dead-letter
   queues. Record staging-only destination and code revision, without credentials.
3. Integration owner searches deployed bundles/scripts and registered external
   clients for QC/legacy tables/categories and dynamic RPC names. Obtain a named
   written attestation per dependency; source absence alone is insufficient.
4. Agree an observation window spanning the longest job/client cadence, acquire
   redacted request-path/RPC telemetry through an approved configuration change,
   verify coverage with synthetic calls and inspect errors/retries. No telemetry
   setting was changed in this task. Record unavailable evidence as UNKNOWN.

## E. Backup and restore runbook

**Actual staging backup/restore is not authorized and was not performed.** The
following is a procedure for a separately approved maintenance window. Do not run
it against production or import production data into the rehearsal.

Scope must include schema/data (including private token stores and historical
audit), `supabase_migrations` history, companion mappings, sequences, function
bodies, triggers, RLS, grants/default grants, indexes/constraints, role attributes
and memberships, extension versions, project settings, and all Storage
bucket/object/reference manifests plus actual object bytes. DB backup alone does
not include Storage file bytes; see [Supabase backup scope](https://supabase.com/docs/guides/platform/backups).
Auth/project secrets need controlled re-provisioning, never a committed dump or
report. A single-database dump does not contain global role definitions; see
[PostgreSQL pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html).

Approved-window procedure:

1. Identify target by project ID, reviewed source commit/hash list and endpoint;
   name the DB operator, operations approver, key custodian and cutover operator.
   Authorize staging backup separately. Keep production endpoints inaccessible
   to the recovery process. Agree retention, RPO/RTO and storage/object scope.
2. Through an approved control plane, fence staging writes and provider sends,
   pause relevant schedulers/workers and drain or record in-flight/outbox jobs.
   Capture a maintenance checkpoint and consistent snapshot boundary. No such
   controls were changed here. Without a write fence, record snapshot-time RPO
   and unbacked subsequent writes; do not claim zero loss.
3. Create an encrypted database archive and encrypted object archive under a
   restricted operator account. Use matching PG tools; include every required
   application/private/history schema and a reviewed managed-schema/Auth strategy.
   Capture role definitions/memberships/grants without role passwords, and
   re-provision managed platform roles rather than blindly replacing them.
   Review extension/platform ownership conflicts before a managed Supabase restore.
4. Encryption must authenticate ciphertext and metadata, with a random data key,
   approved KMS wrapping/custody and separate access controls. Store ciphertext
   digest, format/version, snapshot ID, schema/source hashes, tool versions,
   object counts and encrypted manifest location. Raw tokens, signing URLs,
   passwords, private payloads and decrypted archives must not appear in logs or
   public metadata. Reference manifests themselves may be sensitive: encrypt them.
5. Restore first to an empty disposable isolated target. Verify key recovery and
   ciphertext digest/authentication before SQL restore. Inspect archive contents
   and use fail-fast, transactional restore where supported. Avoid destructive
   restore flags against an existing project. Roles/extensions must be prepared
   compatibly before grants. See [pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html).
6. Restore object bytes and compare encrypted manifest content digests/lengths
   against every canonical resource reference. Reconcile orphan/missing objects;
   restoring only storage.objects metadata is insufficient. Re-provision token
   encryption keys and platform secrets through custody, without exposing them.
7. Compare per-table counts and deterministic row hashes, catalog/function/ACL
   fingerprints, migration statements/mapping hashes, sequences, validated FKs,
   valid indexes, triggers and RLS. Exercise both tenants, inactive actors,
   forbidden roles, AAL2 and assignment lifecycle. Verify authorized file bytes,
   expiry and QC contract with sends/providers fenced. Test Messenger/Zalo
   inbox/idempotency/outbox recovery before permitting any external side effect.
8. Approvers review discrepancies. Only then authorize endpoint cutover or
   continuation. Retain the original staging project and encrypted recovery
   checkpoint through the rollback window. Regenerate signed URLs on the target;
   previous project-bound URLs/signing keys are not assumed portable. Unpause
   workers/providers separately with queue deduplication and observation.

Synthetic rehearsal executed `pg_dump -Fc --no-owner` (grants retained), AES-256-GCM
with a random 32-byte RAM-only key, 12-byte nonce and authenticated format header,
then `pg_restore --exit-on-error --single-transaction --no-owner` into a new empty
namespaced local DB. Ciphertext file permissions were 0600. Wrong-key and altered
ciphertext tests fail before returning plaintext. Test keys/temp archive/targets
were discarded after verification; this was a backup/restore rehearsal, not a
durable recovery artifact. Real KMS key recovery is not proven by a RAM-only key.

Measured result: 53,324 archive bytes; restore plus verification/recovery phase
6,443 ms on this local run; 17 table counts/hashes matched, including 26 genuinely
executed synthetic ledger entries and mappings, audit and a synthetic encrypted
token placeholder. Sequence state, FK/index validity, tenant mutation trigger,
RLS, private access rejection and service-only QC ACL were checked. Authorized
four-category byte retrieval and original QC succeeded after restore. Existing
cluster roles were reused; cross-cluster role creation/managed-platform restore,
real object storage, Vault decryptability and provider sends were not rehearsed.
This small-fixture timing is not a staging RTO commitment.

Partial migration failure procedure: keep staging fenced; capture error and
source hash without payloads. If a single transaction aborted, verify original
catalog/data/history and retry only the exact reviewed bytes after the cause is
resolved. If connection acknowledgement was lost, inspect committed history,
mapping/hash and expected effects under the same lock before retry. If history
and effects disagree, stop and investigate; never repair it to appear applied.
If earlier migration files committed, they remain committed: choose an approved
forward fix or restore the full pre-change checkpoint into a parallel target.
For intermediate commits or nontransactional/external effects, assume partial
execution until proven otherwise; reconcile jobs/objects/provider effects and
use the approved recovery plan. Do not guess inverse destructive SQL or replay
already sent messages. RPO includes every post-snapshot DB/object/external write;
RTO includes download, key access, role/storage restore, validation and cutover.

## F. Append-only migration ledger strategy

The [21-entry evidence](evidence/meta-ads-pre-destructive/staging-history-hashes.json)
maps uniquely by name/order to canonical files 1–21, from initial_schema to
operations_p0_hardening. Recorded versions span 20261030063323–20261030064113;
canonical prefix spans 20260914000001–20260928000001. Existing rows must stay
unchanged. The [plan](evidence/meta-ads-pre-destructive/ledger-readiness-plan.json)
contains every exact pair/current source SHA-256 and all 95 pending files with
hash, predecessor, statement count and transaction envelope. All 21 stored raw
SQL hashes match the reviewed current files. A name/hash match is not permission
to skip live schema/data verification or fabricate canonical applied entries.

| Option | Advantages / preserves history | Risks and atomicity | Recovery / operations |
| --- | --- | --- | --- |
| A — companion canonical-to-ledger mapping | Existing 21 rows unchanged; makes canonical identity and original stored version explicit | A mapping alone does not execute SQL or make CLI understand the drift. Historical mappings are observations, not newly applied migrations. Concurrent writers must be fenced; companion DDL/backfill needs separate review | Append attestations only after source/stored SQL/catalog review; unique canonical/version/hash constraints; use a locked reviewed executor for future files. Stop on mismatch; restore mapping from verified evidence, never repair application history to conceal failure |
| B — separately reviewed complete-file executor plus A | Can bind exact SQL bytes, predecessor and result to a transactional history append; retains existing history | Live executor not delivered/approved here. Must preserve every statement, privileges and conditional/destructive effects. DB transaction cannot undo HTTP/provider effects; explicit mid-file commits/nontransactional commands require rejection and separate design | Exclusive maintenance gate + advisory lock, source hash/identity/predecessor checks, bounded transactional execution and ledger+mapping commit; inspect uncertain commit before retry; full backup/parallel recovery for committed earlier files |
| C — parallel staging rebuild/cutover | Leaves original project/history/recovery checkpoint intact; a fresh target can obtain canonical history by actually executing each complete file | New cost/config/secrets/Auth/storage/URLs/webhook destinations and dual-write/divergence risk; rebuild success does not approve legacy removal | Create isolated approved target, execute reviewed chain with sends off, restore/transform approved staging data and object bytes, prove parity and rollback, separately approve cutover/unpause; original history remains in original project and archived evidence, not falsely copied into rebuilt target |

Recommended next technical candidate: A+B for separate executor review, or C if
the owner prefers a parallel cutover. No live strategy is selected for execution.
The supplied driver is deliberately a **local synthetic-fixture test helper**,
not a reusable remote executor. It rejects remote connection targets, destructive
fixture payloads and unsupported transaction envelopes. Full canonical migration
replay runs in the existing dedicated local DB tests, including destructive SQL;
no destructive statement was omitted or rewritten to make that replay pass.

Inspection covers all 116 files / 2,277 top-level statements: 24 have exactly one
outer BEGIN/COMMIT, 92 have no outer transaction, and none has an intermediate
transaction boundary under the lexical inspection. Bodies, strings, dollar
quotes and nested comments are preserved. The synthetic driver inserts guards
after original BEGIN and records before original COMMIT, or adds an outer
transaction. Every original statement remains byte-for-byte intact. A future
executor must independently validate the PG grammar and procedural/external
effects; the lexical analyzer is not a general SQL safety classifier.

Proven fixture behavior:

- Actually execute 21 synthetic prefix INSERT files, each atomically recording
  its application-time version and canonical/hash mapping. No staging history
  rows are copied into these DBs. Append file 22 without changing those 21 rows.
- Advisory transaction lock plus unique identities: 8 concurrent identical
  submissions produce 1 APPLIED and 7 ALREADY_APPLIED, one data effect only.
- Reject hash mismatch, changed bytes for an existing canonical version,
  conflicting ledger identity, ledger collision, predecessor gap and deliberate
  synthetic history corruption before further execution. Unknown source/history
  names make the read-only plan report errors and never authorize execution.
- Failed SQL rolls back data plus both ledger records with and without original
  BEGIN/COMMIT. Resolve the synthetic missing dependency and retry the identical
  source hash successfully. Terminate a locally identified backend mid-file:
  effects/history roll back; identical retry succeeds. Mid-file COMMIT is rejected.
- History/mapping/data and original SQL hashes survive encrypted dump/restore.

Installed CLI 2.119.0 was tested against a dedicated loopback disposable database
with genuinely executed application-time synthetic history and canonical local
filenames. `migration up` refused the mismatch before applying SQL; no repair was
run. The CLI-specific check is conditional on that dedicated localhost:55322
stack; CI still runs all native fixture assertions and records the CLI check as
not tested there. Do not interpret CLI rejection as a suggested repair workflow.
[Supabase CLI history documentation](https://supabase.com/docs/reference/cli/supabase-migration-repair)
describes repair as editing migration history; it does not execute missing SQL.

Before any live executor approval: verify current source commit/hashes and all
21 stored entries/catalog; decide legacy compatibility; restore an authorized
checkpoint; approve each destructive group; recapture dependencies at the actual
cleanup boundary after predecessors; fence schedulers/clients; test exact tool
versions. Record per-file SQL hash, canonical and ledger identities, predecessor,
operator, observed start/commit/verification outcome and recovery checkpoint.
Never append applied status before commit or use repair/renumbering to hide gaps.

## G. Updated risk register and separate decisions

The prior 158-item pending destructive checklist remains unchanged and unapproved.
Its full risk matrix and exact statements remain in the preserved prior audit.
The following groups narrow owner review; approval of one never approves another.

| Group / remaining risk | Required evidence | Approval owner | Recommended action |
| --- | --- | --- | --- |
| QC orphan and production/order removal | Named workflow owner, historical audit retention, consumer attestations, selected A/B/C tests | Operations + integration + DB owners | Hold QC dependency removal; review one contract decision first |
| SURVEY and appointment/file dependencies | Survey retention, existing key sampling, technician lifecycle, replacement/retirement design | Operations + document owner | Keep category/data/auth path until approved replacement |
| CONTRACT/commercial/finance history | Signed/generated contract retention, audit/export requirements and retrieval parity | Finance/legal document owner + DB owner | Review separately from installation or QC |
| INSTALLATION files/workflow | Handover/photo retention, assigned-technician historical access | Operations owner | Keep or explicitly retire under separate contract |
| Each legacy table and 33-name dynamic function removal | Exact future catalog closure, overloads, row counts and outside dependents at removal boundary | DB owner + affected module owner | Review per table/signature from prior checklist; reject unknown collateral loss |
| TV9 RPC identity/default/behavior change | Old/new call payload parity, actual dispatch-time semantics, external callers | Messenger/channel owner | Separate compatibility review; avoid ambiguous defaulted overload wrapper |
| Triggers/RLS/constraints/privileges/columns | Before/after tenant, immutability, ACL, FK, payload and historical validation | Security + DB owners | Keep each approval scoped to concrete operation/evidence |
| Schedulers, webhook/worker/outbox effects | Full job/client inventory, fencing/drain/retry and no-send proof | Platform + channel owners | No provisioning/unpause implied by migration approval |
| Outside consumers UNKNOWN | Named attestations and cadence-complete redacted telemetry | Integration owner | Keep dependencies while unknown |
| Backup and ledger/cutover | KMS recovery, approved RPO/RTO, managed restore and exact executor review | Staging DB/platform owner | Separate backup authorization, execution authorization and cutover approval |

## H. Final recommendation

**READY AFTER OWNER DECISIONS.**

The reviewable application fix, synthetic recovery proof and append-only design
are complete within this scope. QC and post-cleanup historical file compatibility
remain business decisions. Outside consumers remain UNKNOWN where evidence is
incomplete. Live migration execution stays blocked until those decisions and the
separate backup/executor/destructive approvals are satisfied.

Render staging auto-deploy was observed `no` / trigger `off`, with previews off;
the live deploy remains `dep-dbi3jbc9v7es738jnl0g` at source
`f7d99b19daa704e1ff3ca9ea1e1fe707b738ffca`. Repository GitHub workflows have no
Render deploy hook. Push is permitted only after rechecking those conditions.
No staging environment, schema or application data was changed; no deployment,
provider send, actual staging backup, production-specific operation or PR merge
was performed. Local destructive replay/cleanup was explicitly authorized by the
user for disposable databases only.
