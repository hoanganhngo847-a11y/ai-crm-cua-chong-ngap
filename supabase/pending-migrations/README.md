# Pending Messenger activation — not an executable migration

`20261028130000_remove_messenger_pending_sale_gate_and_enable_pages.sql` is preserved **byte for byte** from main (SHA-256 `8cdfd92019a15f4e3ca22a5f1906a40625332db83dd89712a248f19f851a55d1`). Supabase scans `supabase/migrations`, not this directory. No workflow copies or executes pending SQL. Do not move it back or run it manually as a CI repair.

## Why this is held

Two independent changes used version `20261028130000`. The Production ledger reported in [PR #148](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/pull/148) records `customer_funnel_six_stages`, whose applied SQL remains unchanged (SHA-256 `44a5da682bd501210347b870731fc2260e82e881ef94b9481787ad15dec3c2b0`). No Production query, ledger repair or migration was performed for this fix.

[PR #120](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/pull/120), merged 2026-10-28 at 04:44 UTC, explicitly describes enabling Messenger and claims a successful Production migration. Its GitHub reviews/comments contain no explicit rollout approval. [PR #125](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/pull/125), merged later that day, also claims Production application under the same version. The later ledger evidence and these historic claims cannot establish which Messenger definitions/configuration are currently deployed. A historic merge is insufficient authorization to replay activation today. Preserve the SQL pending a product-owner decision.

## Behavior requiring a rollout decision

The complete SQL removes the Messenger PENDING_SALE dispatch/enqueue gate, updates delivery claim/dispatch RPCs, seeds/enables canary entries and live settings for Pages `1343097708890171` and `1026991374010112`, creates automatic allowlisting/settings triggers for future conversations, and installs a recurring five-second Messenger pg_cron worker. This is not a filename-only change. Holding it does not alter any deployed Messenger/Zalo setting or subscription. Fresh local databases retain the earlier migration definitions until an explicitly approved follow-up is implemented.

## Dependencies and order

The pending SQL depends on live-delivery foundations (`20261022180000`), Messenger RPCs (`20261023160000`), scheduler/canary support (`20261023170000`), and the idempotent canary foundation backfill (`20261028120000`). Those remain active in their existing order. The colliding funnel migration is independent and retains its version and bytes. Later active migrations retain their names, order and content; clean local replay must validate them without the held migration. Existing workflow database commands operate only on local synthetic stacks; no deployment workflow is introduced.

Before release, the owner must decide whether Messenger activation is intended now, specify Pages/tenants and scheduler/live settings, and reconcile the currently deployed RPC definitions and newer Messenger/Zalo safeguards. A new migration must be generated and reviewed against the **current** schema; appending this older SQL verbatim at a later timestamp could overwrite newer functions. Do not change the applied funnel, insert migration-ledger entries, or infer approval from this CI fix. Update the pending guard only in that separately approved rollout PR.

## Regression gate

`npm run test:migration-integrity` validates unique active versions, frozen foundations, the complete pending SQL checksum, and prevents returning the Messenger activation filename under any timestamp. Its immutable-history guard permits only this exact, checksum-verified relocation while preserving the ledger-owning funnel. Other modifications, renames and deletions remain rejected. Verify, Voice and Zalo run the gate before starting Supabase.
