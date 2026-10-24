# Human-authorized messaging campaigns

Entry: Customer 360 `/customers/dossier` → select current page / individual customers → `/campaigns/new`. Selection is page scoped; it never retrieves private contacts. The workflow stores a draft, validates all recipients, displays all personalized previews and exclusions, then requires an explicit count-labelled confirmation modal. `/campaigns`, `/campaigns/[id]` and `/campaigns/templates` share the CRM design system.

## Release state

This release implements the campaign domain, UI, trusted queue protocol and disabled adapter boundary. **No live campaign provider is certified or connected to dispatch in this release.** Both production adapters in `features/campaigns/adapters.ts` have `verified: false`; setting environment flags alone cannot send. They return an explicit unavailable result, never synthetic provider success. Real Messenger/OA/ZBS HTTP sending, approved-provider template synchronization and authenticated delivery webhook wiring are subsequent certification work. No scheduler is installed by the migration.

All switches default OFF:

- `BULK_MESSAGING_ENABLED=false`
- `FACEBOOK_CAMPAIGNS_ENABLED=false`
- `ZALO_OA_CAMPAIGNS_ENABLED=false`
- `messaging_campaign_settings.enabled=false` for each tenant; absent settings also mean OFF.
- `sale_execute=false`; SALE can create/validate its own drafts but cannot execute without this explicit tenant permission. BOSS_ADMIN manages templates, all campaigns, pause/resume/cancel and suppressions. TECHNICIAN is denied server-side.

Sender discovery synchronizes only the current company's server-owned `META_PAGE_BINDINGS` and official `zalo_oa_configs`. Credentials never enter the sender registry or browser DTO. OA IDs must be numeric; `app_id='ZCAJS'` is expressly excluded. Sender `verified` defaults false and requires operational certification. Do not route campaigns through the personal Zalo dispatcher, which can provision ZCAJS routes for legitimate existing 1:1 use.

## Authority and persistence

Migration: `20261024041037_bulk_messaging_campaigns.sql`. Apply through normal Supabase release review; development validation uses local PostgreSQL only. No existing Foundation migration is changed.

All eight public campaign tables and the private rate bucket table have RLS and no direct anon/authenticated/service-role table privileges. Public RPC execution is revoked; only six domain/worker RPCs plus sender sync are service-role callable. Internal helpers are inaccessible to these roles. SECURITY DEFINER functions fix `search_path=''`. The application authenticates the real user with the existing trusted authorization primitive, including production BOSS MFA, and the command/read RPCs additionally verify active profile, membership, company and intended actor. Composite foreign keys enforce tenant/customer/sender/template/identity/conversation linkage.

Templates accept only `customer_name`, `customer_code`, `assigned_sale_name`, `company_name`. SQL and TypeScript reject expressions/unknown variables. Missing values block the recipient. Provider parameters use an explicit JSON map, e.g. `{"name":"customer_name"}`. A human CRM `ACTIVE` status does not grant ZBS provider approval; provider-approved status must come from a separately verified provider synchronization. Editing a provider template through this UI removes its provider-approved state.

Campaign template snapshots are immutable by trigger, including content, variables and provider parameter mapping. Personalized message payloads freeze at initial successful validation. Phone-like content in personalized values/payloads is redacted before storage; browser DTOs also retain existing phone masking. No private contact fetch or phone route is introduced. Subsequent template/name changes never silently rewrite a reviewed message.

Confirmation requires the reviewed `validation_version`, eligible count and unchanged exact recipient/identity/payload verdict set. Equal-count swaps are rejected. Creating, editing, reading and validating never enqueue or send. A unique actor/request ID serializes duplicate draft creation; campaign row locks make confirmation idempotent.

## Eligibility and delivery

Messenger supports only standard response-window architecture: verified sender-scoped Page:PSID identity, exact existing conversation, and an inbound CUSTOMER MESSAGE within the last 24 hours, excluding future timestamps. This stored-window check is insufficient evidence of production Meta approval: the adapter certification gate remains closed. No promotional send outside the window, HUMAN_AGENT tag or alternative mechanism is implemented.

OA/ZBS requires an active official OA, verified OA:UID identity and existing conversation, matching template type/provider ID, and time-bounded consent/eligibility evidence in `messaging_channel_evidence` from the official provider integration. ZBS additionally requires `PROVIDER_APPROVED` and the approved parameter mapping. No evidence means blocked. Phone-based ZBS dispatch is not enabled.

Tenant/customer/channel suppressions always win. Existing disabled `care_schedules` are honored. Additive inbound opt-out detection mirrors the existing care phrases, captures new requests in `messaging_suppressions`, and leaves the Inbox ingestion path and conversation identity unchanged. Operators can add DO_NOT_MESSAGE / UNSUBSCRIBED / BLOCKED from campaign detail. There is no checkbox bypass or automatic suppression removal.

Protocol:

1. `campaign_claim(company,channel)` uses `FOR UPDATE SKIP LOCKED`, claims one recipient with a fresh 60-second token, and respects UTC due times.
2. `campaign_begin` locks the same campaign, rechecks tenant/confirming actor authorization, campaign state, identity, template approval, suppression, platform evidence and schedule, then consumes atomic company/channel/sender rate buckets. It commits SENDING before any provider call.
3. A certified server-only adapter performs one bounded official request. It must time out below the lease and return SENT only with a genuine provider message ID.
4. `campaign_finish` fences by token, stores the external ID or safe code, updates counters/audit and creates a STATUS_EVENT on the exact existing Inbox conversation. Customer 360's existing timeline picks this up. No new campaign conversation/thread is created.

Batches are bounded to 10 in the internal worker, 3 through the targeted authenticated POST cron route. Default fixed-minute caps are company 60, channel 30, sender 10; certification must lower caps/add provider-specific pacing when needed. The route requires a separate >=32-character `CAMPAIGN_CRON_SECRET`, rejects duplicate/unknown query keys and requires one `companyId` and `channel`. No scanning across unspecified tenants.

Only proven pre-acceptance TRANSIENT outcomes retry, with 30-second exponential backoff and a maximum of five attempts. Permanent rejection never retries. Network/adapter exceptions, missing provider IDs, or expired SENDING leases become UNCERTAIN and require reconciliation; they are never automatically resent. Expired pre-dispatch CLAIMED leases can be reclaimed with a new token. Paused/cancelled campaigns can recover ambiguous inflight outcomes without dispatching new work. A transport must never mark an ambiguous 5xx or timeout transient.

Pause/cancel serialize against begin. Work already committed SENDING may finish; pause/cancel cannot retract it. Cancel affects only unsent PENDING/QUEUED/CLAIMED rows. Receipts are monotonic through the service-only `campaign_receipt` entry point; official authenticated webhook integration remains gated. Provider IDs are unique per company. No provider response text, credentials or raw exceptions enter audits.

## Local verification

Commands:

```sh
npm run test:campaigns
npm run test:campaigns:db
npm run typecheck
npm run lint
npm run build
npm test
npm run test:crm
npm run test:inbox
npm run test:omnichannel
npm run test:customer-360
npm run test:migration-integrity
```

The campaign DB gate uses the native local Docker socket, copies schema only into a disposable database, removes campaign objects there, then applies the actual new migration. Every ordinary fixture rolls back; concurrent fixtures remain solely inside the disposable DB, which is dropped afterward. It verifies the real ACLs/transactions, simultaneous duplicate creation/confirmation/claim/finish, lease fencing/recovery, suppression and scheduling. It never loads `.env.local`, calls a provider or reaches production. Runtime tests inject synthetic adapters only to exercise result handling; these are not provider acceptance evidence.

Coverage includes the requested tenant/sender isolation, duplicates, identity gaps, expired Messenger window, transport unavailable, disconnected OA, disabled/rejected templates, unknown/missing variables, suppression, schedule revalidation, pause/resume/cancel, retry classification, lease recovery, SALE/BOSS/TECH permissions, Zero-Phone DTOs, replies through `han_ingest`, and Customer 360 timeline events. Additional checks cover stale previews, same-count eligibility swaps, frozen payloads, provider parameter mapping, sender discovery and Vietnamese opt-out phrases.

## Subsequent production rollout

1. Review/apply the DB migration with all flags and tenant settings OFF.
2. Deploy the application separately; verify tenant-scoped reads, template/draft writes and preflight without dispatch.
3. Implement and certify one official adapter, including exact tenant binding, current platform policies/approvals, provider template synchronization, definite-vs-ambiguous outcome semantics, provider-specific pacing and authenticated receipt callbacks.
4. Enable only that channel for one expressly authorized tenant and perform a separately approved small canary.
5. Verify genuine provider message IDs, no duplicates, opt-out/policy blocks, reply continuity and receipt/timeline results before broadening.

This feature PR does not merge, deploy, apply a production migration, activate a scheduler or authorize any real customer send.
