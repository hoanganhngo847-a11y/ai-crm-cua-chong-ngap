# Meta Ads Lead Attribution — production candidate

Status of the Production gate on 2026-11-07 **BLOCKED**. This manifest is an inventory for review. The target is Supabase project yrauljxzyklhisxijeim, tenant de6a7bf3-b5bc-418d-92d6-f9b241472598, and Meta account act_996324396811261.

## Migration manifest

| Migration | SHA-256 | Dependency | Production compatibility |
| --- | --- | --- | --- |
| 20261030090000_meta_ads_lead_attribution.sql | 0a9b97c2757cdae4cea30367f59d67bae8d61d7bea7b1dece6bef8b8d59205f0 | Base CRM tables, private schema, auth.uid(), active company membership; no existing Meta objects | Audit confirms base customers and absent Meta tables. Confirm column types, FK targets and RLS dependencies. |
| 20261030100000_meta_ads_hardening.sql | b9684428f2d83c742f15419a1c3afff5f290b05f88f5573dd7c41dde1aa67fe4 | 90000; roles and private schema; old token column, ciphertext and account links if present | Audit reports no Meta schema. Confirm absent/present state and lossless ciphertext/expiry handling if any legacy rows exist. |
| 20261030110000_meta_ads_final_remediation.sql | ce2673d449c5e474a35f86d2469da572288e9120962108dc183f5e572b874e38 | 90000/100000; managed roles, native UUID support, private event table and original RPC signatures | New Meta functions/tables only. Replay on the reconciled Production catalog still required. |
| 20261030120000_meta_ads_attribution_rpc_security.sql | a06d05072823d0a057cc48d8c15230ee57da6c6f4b388a5ccce8fb51c12aa9e1 | 110000; exact record_lead_attribution_touchpoint signature | Service role only. Verify effective grants and defaults in Production catalog. |
| 20261030130000_meta_ads_phone_duplicate_history.sql | 68fbbfb1bc261a07520b79632c9e41907d508e4f4d3d045475371276ba0af183 | 120000; LEAD_NEW funnel, CRM intake/contact/stage history, interactions and audit primitives | Audit confirms tenant phone index. Confirm every referenced CRM column, enum, trigger and constraint. |
| 20261104150000_meta_lead_page_binding_guard.sql | 2ef2bf17b58c974b014aafccf8d031fe4f52755ef794039b30d0b9cc7be890b6 | 130000; synced tenant Ad/Campaign/Form tables and existing touchpoint/retry functions | Meta functions only. Verify signature and same-tenant Page/form/creative evidence. |
| 20261104171905_meta_lead_evidence_conflict_guard.sql | a1ffbe20748ce2de1d09d85e1ecfd97c8d5b0c9f4ded865ff9b814d591931c66 | 150000; tenant/Page evidence, first/latest projections and durable signed/creative evidence | Meta functions only. Verify chronological first/last projections, retry and ACL. |

The seven files are ordered above. Verify the SHA-256 values against the exact release commit. The previously recorded read-only Production audit reported PostgreSQL 17.11.0.002, 102 ledger rows and no complete Meta schema. The supplied inventory reports 79 public tables. The audit found 72 exact versions, 30 equivalent names with different timestamps, 13 repo-only names and one Production-only ledger row. The counts are historical evidence. A fresh, owner-supplied, redacted schema and migration inventory are required to establish the current state. [Read-only audit at the PR #156 head](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/blob/4ca7f91644447e234177176842417e758683b212/docs/META_ADS_PRODUCTION_READINESS_AUDIT_20261105.md)

The active runner reads supabase/migrations. The original Messenger activation SQL is held in supabase/pending-migrations as in PR #150, with SHA-256 8cdfd92019a15f4e3ca22a5f1906a40625332db83dd89712a248f19f851a55d1. The existing funnel migration has SHA-256 44a5da682bd501210347b870731fc2260e82e881ef94b9481787ad15dec3c2b0. Existing active SQL files other than the audited relocation retain the same bytes. Staging function hardening, browser reconciliation, and the 21-prefix Staging runner are outside this manifest.

### Catalog and CRM checks

- Five public tables to add. meta_ad_accounts, meta_campaigns, meta_ads, meta_lead_forms, lead_attribution_touchpoints. Confirm company-scoped UNIQUE keys on account/campaign/ad/form identities and the partial unique (company_id, meta_leadgen_id) key. Confirm account, Page, customer, interaction and timestamp indexes, channel/status/type checks, and the company/customer/interaction/conversation FK targets. Verify RLS on each table with an active company_members row for auth.uid(), authenticated SELECT only and explicit service_role read/write grants.
- Two private tables to add. meta_ad_account_tokens stores ciphertext and expiry per company and account or Page namespace. meta_leadgen_events stores the company/lead key, original Page and Form, a lease and immutable intake checkpoint. Confirm no anon/authenticated/PUBLIC table privileges and RLS enabled.
- Existing public.customers gains first_campaign_name, first_ad_name, first_touch_at, latest_campaign_name, latest_ad_name, latest_touch_at, attribution_status. Verify seven absent columns on the snapshot. The new guard_customer_meta_attribution trigger restricts writes to these projections without changing existing CRM columns or their grants. Verify existing customer records and normal CRM writes survive the replay with the new default UNATTRIBUTED.
- The final public RPCs are store_meta_ad_account_token, get_meta_ad_account_token, claim_meta_leadgen_event, finalize_meta_leadgen_event, acquire_meta_ad_account_sync_lease, release_meta_ad_account_sync_lease, ingest_meta_leadgen_event, record_lead_attribution_touchpoint, mark_lead_attribution_phone_match, retry_pending_lead_attribution. Confirm proconfig includes the empty search_path and effective EXECUTE only for service_role and the owner. Check inherited grants via has_function_privilege, including roles that inherit PUBLIC. The migration removes only superseded Meta RPC signatures created by earlier files in this bundle.
- Verify base relations and exact columns for companies, company_members, customers, customer_stage_histories, conversations, interactions, audit_logs, private.customer_private_contacts, private.interaction_raw_contents and private.han_intake_events. In particular, confirm LEAD_NEW/FACEBOOK values, stage/history constraints, normalized phone tenant uniqueness, customer code defaults, existing customer/interaction triggers and any downstream effects of inserting a CRM intake interaction with conversation_id NULL.
- Run selective replay on an isolated PostgreSQL 17.11 clone of the redacted catalog and synthetic CRM data. Compare the before/after catalog definitions and CRM row fingerprints. Exercise PostgREST explicit grants, tenant reads, cross-tenant denial, first/last chronology, duplicate phone and retry, and assert no conversations, recipients, deliveries, SLA windows or outbox records. CI on a fresh repo-derived stack covers code/DDL, while this target-catalog replay is a separate gate.
- Keep Production ledger untouched. The seven-file bundle requires a reviewed application plan with a fail-closed target/version/fingerprint preflight and protection against partial application. An application deployment on main would auto-deploy on Render, so release approval must cover the exact Git SHA, ordered SQL, verified backup and the release sequence.

## Meta assets

| Page | ID | Form evidence available offline |
| --- | --- | --- |
| Poland | 1418087751743574 | Owner-approved inventory pending |
| Germany | 1026991374010112 | Owner-approved inventory pending |
| Austria | 654520554683416 | Prior discovery confirmed Page/Form pairing 1698659958359492. Inclusion in the six approved forms is pending. |
| German Language Center | 1014780055265237 | Owner-approved inventory pending |

The release tenant has four allowed Page IDs and one allowed Ad Account. META_ADS_APPROVED_FORMS takes a JSON map of Page IDs to unique Form IDs. Supply it only from the owner-reviewed inventory of exactly six forms. Intake rejects an incomplete allowlist or wrong Page/Form pair before claiming an event. The candidate checks Graph lead identity and rejects a conflicting Form ID. Europe is outside the release tenant's allowlist.

The Lead Ads OAuth flow binds state and selection to the actor and company, requires BOSS_ADMIN with AAL2, and uses separate state/session cookies and callback. It reads existing Page subscriptions and stores an encrypted Page token after verified leadgen read-back. The permission request and offline tests establish the code path. Live ads_read/leads_retrieval grants, granular lead/Page/ad-account access, valid callback/App association and end-to-end retrieval remain to be evidenced on approved assets in a separate authorized validation. [Prior asset evidence](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/blob/4ca7f91644447e234177176842417e758683b212/docs/META_ADS_STAGING_VALIDATION_PLAN.md)

## Backup manifest and restore checklist

Use the separate [backup workflow and runbook in PR #148](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/pull/148). Synthetic CI runs against fixture data and proves the test workflow. An actual export and restore require Owner authorization and secure provision of separate backup/restore credentials.

| Required manifest evidence | Acceptance condition |
| --- | --- |
| Source and provenance | Project, database/server/client/image versions, UTC time, workflow run and attempt, Git SHA, Owner approval, read-only snapshot boundary |
| Database export | Schema/data and extension data, role attributes and membership, ACLs, sequences, migration ledger, large object counts and digests, table and tenant counts and CRM/identity row digests |
| Storage binaries | Bucket/ownership metadata plus complete binary objects, total bytes and SHA-256 for each object, reconciliation of SQL inventory with paginated Storage listing |
| Encrypted artifact | age ciphertext, detached run receipt and SHA-256, complete internal manifest, offsite custody and owner key kept separately |
| Independent restore | Restore report linked to the exact ciphertext, owner-key decryption, fresh isolated PostgreSQL 17.11 target with no network, restored schema/ACL/RLS/trigger/constraint/role/sequence and CRM fingerprint comparisons, Storage size/hash verification |
| Platform recovery | Explicit disposition for Auth/OAuth/JWT/SMTP, Edge Function source/secrets, Vault/external key custody and service-level Storage/Auth/Realtime recovery |

- [ ] Owner approves a specific backup run and confirms the source target.
- [ ] Read-only DB export, Storage binary export, manifest and ciphertext all verify. Partial/incomplete artifacts are excluded.
- [ ] An independent operator verifies the checksum and decrypts with the Owner identity in an isolated rehearsal.
- [ ] The isolated database restore preserves the inventoried counts, definitions, policies, grants and row digests. The Storage manifest matches every extracted binary.
- [ ] Review residual platform gaps, recovery time, recovery point and the exact release sequence before release approval.

Evidence from this task does not populate the Production export, ciphertext or restore fields.
