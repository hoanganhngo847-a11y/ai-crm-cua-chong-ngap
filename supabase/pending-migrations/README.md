# Legacy Messenger activation SQL — archived, not executable

`20261028130000_remove_messenger_pending_sale_gate_and_enable_pages.sql` remains preserved **byte for byte** from the original history (SHA-256 `8cdfd92019a15f4e3ca22a5f1906a40625332db83dd89712a248f19f851a55d1`). Supabase scans `supabase/migrations`, not this directory. No workflow copies or executes pending SQL.

## Historical collision

The Production ledger reported in [PR #148](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/pull/148) records `customer_funnel_six_stages` under version `20261028130000`, whose SQL remains unchanged (SHA-256 `44a5da682bd501210347b870731fc2260e82e881ef94b9481787ad15dec3c2b0`). The old Messenger file cannot be reactivated or renamed to another timestamp: it contains broad, stale function replacements and broader settings/cron changes that predate later Messenger/SLA safeguards.

## Product decision and replacement

On 2026-11-06, the product owner confirmed the Messenger policy: `PENDING_SALE` is permitted for Messenger, while Zalo continues to block `PENDING_SALE`. The approved rollout scope is limited to tenant `de6a7bf3-b5bc-418d-92d6-f9b241472598` and Facebook Pages `1343097708890171` and `1026991374010112`.

The replacement is the additive migration `supabase/migrations/20261106004117_scoped_messenger_pending_sale_policy.sql` in the integrated Draft PR. It:
- Updates only the current Messenger enqueue trigger and atomic dispatch-start fence to allow `PENDING_SALE` within the approved tenant/Page scope; the current lock, confidence, source, tenant, Page, canary and once-only checks remain.
- Bases the enqueue replacement on the latest active definition from `20261029154410_zcajs_history_ingest.sql`, preserving the Zalo group-conversation block and `app.zcajs_history_ingest` suppression guard.
- Seeds existing canary rows only for the approved tenant and two Pages.
- Removes either historical canary-trigger name and installs one tenant/Page-scoped future-conversation trigger, preventing the stale broad trigger from re-enabling other tenants or settings.
- Leaves existing non-target tenant settings and canary rows untouched; it does not grant those tenants the `PENDING_SALE` exception.
- Uses `ON CONFLICT DO NOTHING` so disabled canary rows and an existing disabled tenant setting are not re-enabled.
- Creates the Messenger live setting only if the approved tenant exists and has no Messenger setting, using the current 0.700 confidence threshold.
- Does not replace the current outbound/SLA RPC, handover RPC, claim/finish RPCs, cron helper, or scheduler cadence.

The policy approval is **not Production deployment approval**. The migration remains in a Draft PR for review and local/CI replay only. Do not run `supabase db push --remote`, `apply_migration`, migration repair, or any Production write as part of this work.

## Dependencies and order

The new migration follows the existing active foundations: live-delivery schema/RPCs (`20261022180000` and `20261023160000`), canary/scheduler support (`20261023170000`), Page identity repair (`20261027140000`), canary backfill (`20261028120000`), confidence/SLA resolution (`20261028140000`), and Messenger handover behavior (`20261028150000`). The ledger-owning funnel migration retains its version and bytes. The old Messenger SQL remains archived and is never replayed.

## Verification

The integrated CI runs migration integrity before Supabase startup, then resets a fresh local Supabase stack and executes the Messenger DB tests. The DB tests cover Messenger enqueue/dispatch for `PENDING_SALE`, continued Zalo blocking, tenant/Page canary scope, preservation of explicit off switches, ACL isolation and existing dispatch-fence safeguards. No Production environment, data, settings, credentials, subscriptions, backup or deployment is accessed or changed.
