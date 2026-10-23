# Customer 360 — AI Customer Dossier

Customer list: `/customers/dossier`. Dossier: `/customers/[id]/dossier`.
The existing `/customers` screen links to Customer 360; existing business/customer/call workflows remain available.

## Architecture and authority

Existing channel ingress → existing customers/identities/interactions → dirty trigger → one refresh row per customer → bounded context → existing `JavisBrainProvider` → existing Javis Brain service `/v1/brain/dossier` → CRM validation → atomic snapshot finish.

This is a task extension to the existing Brain and its runtime/Gemini backends. There is no new AI Brain, model-controlled SQL, transport, or automatic task execution. The companion service retains authentication, body/deadline limits, disconnect cancellation and shared concurrency slots. Runtime dossier calls use a fresh read-only session; natural-language fallback is forbidden for this contract.

## Schema

Additive migration: `20261023200000_customer_360_ai_dossier.sql`. Created with the CLI, then ordered after the inspected latest `20261023190000` migration. Historical migrations are unchanged.

- Reuses `customers`, `identities`, `conversations`, `interactions`, appointments, stage/handover history, calls and the entire existing Zalo recording/transcript/summary pipeline.
- Extends `identities` with EMAIL and optional display name. Phone identities retain existing HMAC keys and private contacts. Email identities use a domain-separated HMAC; raw normalized email lives in `private.customer_identity_values`, with composite identity/customer/tenant FK. Never infer a provider ID from a display name. Existing Page/account-scoped external IDs remain opaque exact keys.
- `customer_dossier_profiles`: human-entered address, birth year, special notes, explicit owner. Existing conversation assignment supplies the fallback owner. AI cannot update this table through its contract.
- `customer_identity_conflicts`: retains both customers and the conflicting canonical identity; no automatic merge/rebind. `resolveCustomerIdentities` provides exact resolution for trusted callers; verified phone/email are strong, unverified matches are suggestions. Existing channel ingress remains on its existing resolver; this phase does not relink historical customers.
- `customer_dossier_settings`: explicit tenant opt-in; absent means OFF.
- `customer_dossier_refresh`: dedupe, one-minute manual cooldown, 30-second event coalescing, five attempts with exponential backoff, two-minute lease, token/version fencing, expired-lease recovery.
- `customer_ai_snapshots`: append-only version rows, source watermark, evidence, conclusions, confidence, provider/adapter metadata and CRM-derived score. No reasoning or chain-of-thought.

RPCs: `c360_bind_identity`, `c360_request_refresh`, `c360_claim_refresh`, `c360_finish_refresh`, `c360_list`, `c360_emails`, `c360_contacts`, `c360_timeline`; trigger helper `c360_mark_dirty`.

## Grounding and freshness

Context contains the customer name/stage, a previous snapshot as compressed AI-derived memory, special notes, 20 recent sanitized interactions and up to three recent linked completed transcripts. Individual sources and the full request are bounded (30 KiB); previous memory points to an immutable snapshot whose evidence retains raw provenance.

`dossier-v1` intentionally uses extractive factual conclusions: each factual string must occur verbatim in the cited source. Unsupported facts, unknown fields, invented references, arbitrary actions/dates/owners/scores and malformed output fail closed. Missing facts are null/empty. Quoted customer statements remain assertions, not verified personal facts. Recommendations are four allowlisted action codes requiring human review.

The CRM validates again before persistence. A changed watermark invalidates the in-flight result. An expired/wrong token cannot finish. AI errors never delete the previous snapshot; the UI shows stale/processing/error status. No provider errors, raw source text, credentials or model reasoning are logged.

Score rubric v1 is deterministic and an estimate: inbound within seven days +20; at least three recent inbound messages +10; an explicit purchase expression +30; canonical CRM survey/offer/order stage +20/+30/+40; inactivity over 30 days -10; LOST = 0. Clamp 0–100. Without inbound evidence, score is null. Model classifications and names never add points. Bounded context means this is a recent-context score, not a complete historical assessment.

## Security and access

Every loader/mutation derives company from the authenticated active membership via existing trusted authorization, with Boss MFA enforcement in production. Browser company/role/verified fields are never accepted. New tables use RLS and no anon/authenticated grants; all new RPCs revoke PUBLIC/anon/authenticated, use `search_path=''`, and are service-role only after server authorization. Composite FKs protect tenant/customer/identity scope. New customer dependents cascade with authorized customer deletion so existing fixture cleanup/deletion workflows remain compatible.

Boss sees the dossier, conflict notices and transcript-derived snapshots. Sale retains existing company customer access and own-recording access, and can append sanitized manual notes. Snapshots remain Boss-only in this phase to avoid disclosing other staff's restricted transcripts. Technician is denied. Raw phone remains private; list/detail show masked phone and link to the existing audited contact workflow. Private recording playback, transcript and summary actions/components are reused without public buckets or new recording infrastructure.

The list uses one relational RPC for server search/filter/sort/paging (25 rows), with no timeline payload or browser filtering of a full database. Timeline pages contain 30 events, deterministic timestamp/ID ordering and canonical recording rows instead of duplicate call events. Query failures render explicit errors, never a false zero.

## Local validation and acceptance

Run `npm run test:customer-360` and `npm run test:customer-360:db`. DB tests accept only a native local Docker socket and localhost Supabase URLs; synthetic fixtures roll back. CI Verify includes both suites. Run the requested regression matrix sequentially on an 8 GB machine.

Synthetic acceptance uses local data, a private synthetic audio object, fixture transcript/summary, and a deterministic backend behind the actual Javis service/adapter. It proves integration and UI behavior; it is not real-provider inference or production transcription/recording acceptance.

`tests/customer-360/seed-local.ts` provisions this explicit local-only fixture; it never runs as application code or a scheduled job. Browser acceptance observed list → dossier, identities/profile/snapshot/timeline, and private audio playback reaching 2/2 seconds with no media error, plus transcript and call summary. Screenshots: [list](customer-360/list.jpg), [dossier](customer-360/dossier.jpg), [call/transcript](customer-360/call-transcript.jpg).

The production Next.js build also required moving existing cron dependency-injection handlers to sibling `handler.ts` files; route files export only supported Next.js handlers/config. Existing assertions are retained with imports redirected to the same handlers. This refactor does not alter cron authorization, query validation or dispatch.

## Deployment and rollback

1. Review/merge only after CI acceptance. This branch does not authorize production rollout.
2. Back up/review migration, apply it through the normal approved process. No channel settings or schedulers are changed. Existing customers remain usable; no bulk identity fabrication or historical AI backfill is required.
3. Deploy the compatible Javis service supporting `/v1/brain/dossier`, then CRM. Prove a controlled synthetic request through the intended provider before any tenant enablement.
4. Configure existing Javis credentials on the server, then explicitly opt in with `CUSTOMER_DOSSIER_ENABLED=true` and the intended company's settings row. Verify one controlled customer refresh.
5. Only with separate rollout approval, schedule authenticated POST `/api/cron/customer-dossier` (one job/request, no query parameters). No scheduler is installed by this implementation. Without a scheduler, events queue and Boss can refresh manually.
6. Roll back operationally by disabling the dossier flag and tenant setting/scheduler. Preserve snapshots and additive schema. Prefer a reviewed forward fix over destructive schema rollback.

## Current limits

- No automatic historical customer merge or bulk identity backfill. Conflicts require future admin resolution; the UI only surfaces them.
- Follow-up recommendations have no invented due dates. `follow_up_at` remains null until a trusted task/follow-up integration is approved; overdue filtering consequently has no matches for those rows.
- Snapshot history UI shows the latest ten versions; older rows remain stored.
- Transcript context is bounded and sanitized; a long transcript may require a later targeted analysis to cover omitted portions.
- Source evidence references are retained; the current UI links to the timeline/call section rather than implementing a dedicated citation inspector.
- List search is database-side with tenant/time/identity indexes; large-tenant query plans still need workload-specific measurement.
- Provider metadata identifies the existing CRM adapter (`javis-router-v1`); the companion service's configured backend model remains in its audit logs.
- No production migration, deployment, real customer contact, Meta/Zalo setting change or billing change is part of implementation acceptance.
